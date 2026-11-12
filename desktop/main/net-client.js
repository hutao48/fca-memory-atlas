'use strict';

/**
 * FCA Desktop — 主进程 HTTP / SSE 客户端
 * Renderer 经 IPC 调用本模块访问本地 Runtime（避免 CORS；Bearer token 只在主进程读取，不进入 renderer）。
 * 契约：docs/PUBLIC_INTERFACE_FREEZE.md §0/§4/§6。
 */

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const DEFAULT_TIMEOUT_MS = 15000;
const MIN_TIMEOUT_MS = 200;
const MAX_TIMEOUT_MS = 300000;

function makeTraceId() {
  return `trc_${crypto.randomBytes(16).toString('hex')}`;
}

function clampTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(n)));
}

function buildQueryString(query) {
  if (!query) return '';
  if (typeof query === 'string') return query.startsWith('?') ? query : `?${query}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item !== undefined && item !== null && item !== '') params.append(key, String(item));
    } else if (typeof value === 'object') params.append(key, JSON.stringify(value));
    else params.append(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/**
 * 创建主进程网络客户端。
 * @param {object} options
 * @param {() => string} options.getBaseUrl 返回 http://127.0.0.1:17860
 * @param {() => string|null} options.getToken 读取 token（自带缓存）
 * @param {object} options.logger
 */
function createNetClient(options) {
  const logger = options.logger;
  const getBaseUrl = options.getBaseUrl;
  const getToken = options.getToken;
  const clientKind = options.clientKind || 'desktop';
  const clientVersion = options.clientVersion || '0.1.0';

  // ---------------------------------------------------------------- 普通请求
  /**
   * @returns {Promise<{ok:boolean,status:number,statusText:string,headers:object,body:any,
   *   traceId:string,durationMs:number,error?:{code:string,message:string},url:string}>}
   */
  function request(req = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const pathPart = req.path || '/';
    const urlString = `${getBaseUrl()}${pathPart.startsWith('/') ? '' : '/'}${pathPart}${buildQueryString(req.query)}`;
    const traceId = (req.headers && (req.headers['X-FCA-Trace-Id'] || req.headers['x-fca-trace-id'])) || makeTraceId();
    const timeoutMs = clampTimeout(req.timeoutMs);
    const startedAt = Date.now();
    const noAuth = Boolean(req.noAuth);
    const body = req.body === undefined ? null : req.body;
    let bodyText = null;
    if (body !== null) {
      if (typeof body === 'string' || Buffer.isBuffer(body)) bodyText = body;
      else bodyText = JSON.stringify(body);
    }

    const headers = {
      Accept: 'application/json',
      'X-FCA-Client': clientKind,
      'X-FCA-Client-Version': clientVersion,
      'X-FCA-Trace-Id': traceId,
    };
    if (bodyText !== null) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = Buffer.byteLength(bodyText);
    }
    if (!noAuth) {
      let token = null;
      try {
        token = getToken();
      } catch (error) {
        token = null;
      }
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    if (req.headers) {
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined || value === null) continue;
        if (key.toLowerCase() === 'host' || key.toLowerCase() === 'content-length') continue;
        headers[key] = String(value);
      }
      headers['X-FCA-Trace-Id'] = traceId; // 强制统一 trace id
    }

    return new Promise((resolve) => {
      let url;
      try {
        url = new URL(urlString);
      } catch (error) {
        resolve({
          ok: false,
          status: 0,
          statusText: 'Bad URL',
          headers: {},
          body: null,
          traceId,
          durationMs: 0,
          url: urlString,
          error: { code: 'BAD_REQUEST', message: `无效的 Runtime 地址：${urlString}` },
        });
        return;
      }
      const transport = url.protocol === 'https:' ? https : http;
      let settled = false;
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        resolve(payload);
      };
      const reqOptions = {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        timeout: timeoutMs,
      };

      let requestHandle;
      try {
        requestHandle = transport.request(reqOptions, (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > 64 * 1024 * 1024) {
              res.destroy(new Error('response too large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const raw = Buffer.concat(chunks);
            const text = raw.toString('utf8');
            let parsed = null;
            const contentType = String(res.headers['content-type'] || '');
            if (text) {
              if (contentType.includes('json')) {
                try {
                  parsed = JSON.parse(text);
                } catch {
                  parsed = { _raw: text };
                }
              } else {
                try {
                  parsed = JSON.parse(text);
                } catch {
                  parsed = { _raw: text };
                }
              }
            }
            const ok = res.statusCode >= 200 && res.statusCode < 300;
            let error;
            if (!ok) {
              const errObj = parsed && parsed.error && typeof parsed.error === 'object' ? parsed.error : null;
              error = {
                code: (errObj && errObj.code) || (res.statusCode === 401 ? 'UNAUTHORIZED' : res.statusCode === 404 ? 'NOT_FOUND' : 'HTTP_ERROR'),
                message: (errObj && errObj.message) || `HTTP ${res.statusCode} ${res.statusMessage || ''}`.trim(),
                details: errObj ? errObj.details : undefined,
                trace_id: (errObj && errObj.trace_id) || res.headers['x-fca-trace-id'] || traceId,
              };
            }
            finish({
              ok,
              status: res.statusCode || 0,
              statusText: res.statusMessage || '',
              headers: res.headers,
              body: parsed !== null ? parsed : text,
              rawText: text,
              traceId: String(res.headers['x-fca-trace-id'] || traceId),
              durationMs: Date.now() - startedAt,
              url: urlString,
              error,
            });
          });
          res.on('error', (error) => {
            finish({
              ok: false,
              status: 0,
              statusText: 'Response Error',
              headers: {},
              body: null,
              traceId,
              durationMs: Date.now() - startedAt,
              url: urlString,
              error: { code: 'NETWORK_ERROR', message: `Runtime 响应异常：${error.message}` },
            });
          });
        });
      } catch (error) {
        finish({
          ok: false,
          status: 0,
          statusText: 'Request Error',
          headers: {},
          body: null,
          traceId,
          durationMs: Date.now() - startedAt,
          url: urlString,
          error: { code: 'NETWORK_ERROR', message: error.message },
        });
        return;
      }

      requestHandle.on('timeout', () => {
        requestHandle.destroy(new Error(`timeout after ${timeoutMs}ms`));
      });
      requestHandle.on('error', (error) => {
        const code = error && /timeout/i.test(error.message || '') ? 'TIMEOUT' : 'NETWORK_ERROR';
        const message =
          code === 'TIMEOUT'
            ? `Runtime 响应超时（${timeoutMs}ms）`
            : `无法连接本地 Runtime（${getBaseUrl()}）：${error.message}`;
        finish({
          ok: false,
          status: 0,
          statusText: code,
          headers: {},
          body: null,
          traceId,
          durationMs: Date.now() - startedAt,
          url: urlString,
          error: { code, message },
        });
      });

      if (bodyText !== null) {
        try {
          requestHandle.write(bodyText);
        } catch (error) {
          // 已经通过 error 事件处理
        }
      }
      requestHandle.end();

      if (logger) {
        const done = (res) => {
          if (res.status >= 400) {
            logger.warn('net', `${method} ${pathPart} → ${res.status}`, {
              traceId: res.traceId,
              code: res.error && res.error.code,
              durationMs: res.durationMs,
            });
          } else {
            logger.debug('net', `${method} ${pathPart} → ${res.status}`, { traceId: res.traceId, durationMs: res.durationMs });
          }
        };
        // 只记录结果日志：用微任务挂到 promise 上（不阻塞）
        Promise.resolve().then(() => {
          // 通过闭包无法拿到后续结果；此处简化为 request 结果在调用方记录。保留占位。
          void done;
        });
      }
    });
  }

  const trackedRequest = request;

  // ---------------------------------------------------------------- SSE 流
  /**
   * 打开 SSE 连接（单条，由调用方管理重连）。
   * @param {object} streamOptions {path, lastEventId, onStatus, onEvent, onError, timeoutMs}
   * @returns {{close:Function, url:string, active:boolean}}
   */
  function openStream(streamOptions = {}) {
    const pathPart = streamOptions.path || '/api/v1/events/stream';
    const urlString = `${getBaseUrl()}${pathPart.startsWith('/') ? '' : '/'}${pathPart}`;
    const traceId = makeTraceId();
    const headers = {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-FCA-Client': clientKind,
      'X-FCA-Client-Version': clientVersion,
      'X-FCA-Trace-Id': traceId,
    };
    const token = getToken && getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (streamOptions.lastEventId) headers['Last-Event-ID'] = String(streamOptions.lastEventId);

    let closed = false;
    let requestHandle = null;
    const state = { active: false, url: urlString };
    let frameEvent = null;
    let frameId = null;
    let frameData = [];
    let gotAnyFrame = false;
    let connected = false;

    const emitStatus = (stateName, extra = {}) => {
      if (closed) return;
      state.active = stateName === 'connected';
      if (streamOptions.onStatus) {
        try {
          streamOptions.onStatus({ state: stateName, url: urlString, ...extra });
        } catch (error) {
          if (logger) logger.error('net', 'SSE onStatus 回调异常', { message: error.message });
        }
      }
    };

    const dispatchFrame = () => {
      const event = frameEvent || 'message';
      const dataLines = frameData;
      if (!dataLines.length && !frameEvent) {
        frameEvent = null;
        frameId = null;
        return;
      }
      const id = frameId;
      const raw = dataLines.join('\n');
      frameEvent = null;
      frameId = null;
      frameData = [];
      if (event === 'heartbeat') {
        if (streamOptions.onHeartbeat) streamOptions.onHeartbeat({ at: Date.now() });
        return;
      }
      let data = raw;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        data = { _raw: raw };
      }
      if (streamOptions.onEvent) {
        try {
          streamOptions.onEvent({ id: id || (data && data.id) || null, event, data, seq: data && Number.isFinite(data.seq) ? data.seq : null });
        } catch (error) {
          if (logger) logger.error('net', 'SSE onEvent 回调异常', { message: error.message });
        }
      }
    };

    const handleLine = (line) => {
      if (line === '') {
        dispatchFrame();
        return;
      }
      if (line.startsWith(':')) return; // 注释/心跳
      const idx = line.indexOf(':');
      const field = idx === -1 ? line : line.slice(0, idx);
      let value = idx === -1 ? '' : line.slice(idx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') frameEvent = value;
      else if (field === 'id') frameId = value;
      else if (field === 'data') frameData.push(value);
      else if (field === 'retry') {
        const n = Number(value);
        if (streamOptions.onRetry && Number.isFinite(n)) streamOptions.onRetry(n);
      }
    };

    const start = () => {
      let url;
      try {
        url = new URL(urlString);
      } catch (error) {
        emitStatus('error', { error: { code: 'BAD_REQUEST', message: `无效的 SSE 地址：${urlString}` } });
        return;
      }
      const transport = url.protocol === 'https:' ? https : http;
      requestHandle = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers,
        },
        (res) => {
          if (res.statusCode !== 200) {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8').slice(0, 2000);
              let parsed = null;
              try {
                parsed = JSON.parse(text);
              } catch {
                parsed = null;
              }
              const errObj = parsed && parsed.error;
              emitStatus('error', {
                httpStatus: res.statusCode,
                error: {
                  code: (errObj && errObj.code) || (res.statusCode === 401 ? 'UNAUTHORIZED' : 'SSE_ERROR'),
                  message: (errObj && errObj.message) || `SSE 连接失败：HTTP ${res.statusCode}`,
                },
              });
            });
            return;
          }
          connected = true;
          emitStatus('connected', { lastEventId: streamOptions.lastEventId || null });
          res.setEncoding('utf8');
          let buffer = '';
          res.on('data', (chunk) => {
            buffer += chunk;
            let newlineIndex = buffer.indexOf('\n');
            while (newlineIndex !== -1) {
              let line = buffer.slice(0, newlineIndex);
              buffer = buffer.slice(newlineIndex + 1);
              if (line.endsWith('\r')) line = line.slice(0, -1);
              handleLine(line);
              gotAnyFrame = true;
              newlineIndex = buffer.indexOf('\n');
            }
          });
          res.on('end', () => {
            if (closed) return;
            emitStatus('disconnected', { reason: 'server-closed', eventsReceived: gotAnyFrame });
          });
          res.on('error', (error) => {
            if (closed) return;
            emitStatus('error', { error: { code: 'NETWORK_ERROR', message: error.message } });
          });
        },
      );
      requestHandle.on('error', (error) => {
        if (closed) return;
        emitStatus('error', { error: { code: 'NETWORK_ERROR', message: error.message || 'SSE 连接错误' } });
      });
      requestHandle.end();
    };

    start();

    return {
      url: urlString,
      get active() {
        return state.active;
      },
      close() {
        if (closed) return;
        closed = true;
        state.active = false;
        try {
          if (requestHandle) requestHandle.destroy();
        } catch {
          /* ignore */
        }
        emitStatus('closed', { intentional: true });
      },
    };
  }

  /** 读取 token 文件内容（去空白）；不存在返回 null */
  function readTokenFile(tokenPath) {
    try {
      const token = fs.readFileSync(tokenPath, 'utf8').trim();
      return token || null;
    } catch {
      return null;
    }
  }

  return {
    request: trackedRequest,
    openStream,
    readTokenFile,
    makeTraceId,
    clampTimeout,
    getBaseUrl,
  };
}

module.exports = { createNetClient, makeTraceId, clampTimeout, buildQueryString, DEFAULT_TIMEOUT_MS };
