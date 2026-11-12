// FCA Local Runtime — HTTP server（node:http 路由 + 鉴权 + CORS + 追踪 ID + 脱敏访问日志）
import http from 'node:http';
import { newTraceId } from '../core/ids.js';
import {
  ApiError,
  badRequest,
  databaseError,
  forbidden,
  internal,
  isSqliteError,
  notFound,
  notInitialized,
  payloadTooLarge,
  shuttingDown,
  unauthorized,
  unsupportedMediaType,
} from '../core/errors.js';
import { authenticateRequest, isLoopbackAddress } from '../security/auth.js';
import { CLIENT_KINDS } from '../events/index.js';
import { registerApiRoutes } from '../api/index.js';
import { Router } from './router.js';
import { sendError, sendJson } from './respond.js';

const TRACE_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const CLIENT_KIND_SET = new Set(CLIENT_KINDS);
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-FCA-Trace-Id,X-FCA-Client,Last-Event-ID',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Expose-Headers': 'X-FCA-Trace-Id',
};

function decodePathname(rawPathname) {
  const parts = String(rawPathname ?? '/').split('/').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  return parts.join('/');
}

function pickTraceId(req) {
  const header = req.headers['x-fca-trace-id'];
  if (typeof header === 'string' && TRACE_RE.test(header)) return header;
  return newTraceId();
}

function normalizeClientKind(raw) {
  if (raw === undefined || raw === null || raw === '') return 'cli';
  const value = String(raw);
  if (!CLIENT_KIND_SET.has(value)) {
    throw badRequest(`非法的 X-FCA-Client：${value}（允许 ${CLIENT_KINDS.join('|')}）`);
  }
  return value;
}

async function readJsonBody(req, maxBytes) {
  const contentType = String(req.headers['content-type'] ?? '');
  const contentLength = Number(req.headers['content-length'] ?? 0);
  const hasBody = Boolean(req.headers['transfer-encoding']) || (Number.isFinite(contentLength) && contentLength > 0);
  if (hasBody && !/^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType.split(';')[0].trim())) {
    throw unsupportedMediaType(`Content-Type 必须为 application/json（收到：${contentType || '空'}）`);
  }
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    req.resume();
    throw payloadTooLarge(maxBytes);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        req.resume();
        reject(payloadTooLarge(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (size === 0) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        return resolve(JSON.parse(raw));
      } catch (err) {
        return reject(badRequest(`JSON 解析失败：${err.message}`));
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * 创建 HTTP Server（不自动 listen）。
 * @returns {Promise<{server: import('node:http').Server, router: Router, start: Function, stop: Function}>}
 */
export async function createHttpServer({ config, logger, token, holder, events, hub, services, state }) {
  const router = new Router();
  await registerApiRoutes({ router, config, logger, token, holder, events, hub, services, state });

  function recordAccess(req, res, traceId, startedMs, clientKind, pathname) {
    const status = res.statusCode;
    logger.access({
      method: req.method,
      path: pathname,
      status,
      ms: Math.max(0, Date.now() - startedMs),
      trace_id: traceId,
      client: clientKind ?? null,
      ip: req.socket?.remoteAddress ?? null,
      content_length: res.getHeader('Content-Length') ?? null,
      user_agent: req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 160) : null,
    });
  }

  async function handle(req, res) {
    const startedMs = Date.now();
    const traceId = pickTraceId(req);
    res.setHeader('X-FCA-Trace-Id', traceId);
    for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);

    let url = null;
    let pathname = '/';
    let clientKind = null;
    try {
      url = new URL(req.url ?? '/', `http://${config.host}`);
      pathname = decodePathname(url.pathname);
    } catch {
      sendError(res, badRequest('非法 URL'), traceId);
      recordAccess(req, res, traceId, startedMs, null, pathname);
      return;
    }
    const rawClientKind = req.headers['x-fca-client'];
    if (typeof rawClientKind === 'string' && CLIENT_KIND_SET.has(rawClientKind)) clientKind = rawClientKind;

    res.once('finish', () => recordAccess(req, res, traceId, startedMs, clientKind, pathname));

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...CORS_HEADERS, 'Access-Control-Max-Age': '600', 'Access-Control-Allow-Private-Network': 'true' });
        res.end();
        return;
      }
      if (!config.allowRemote && !isLoopbackAddress(req.socket?.remoteAddress)) {
        throw forbidden('FCA Local Runtime 仅接受本机回环地址请求');
      }
      // 契约 §0：X-FCA-Client 只允许 desktop|dsh-plugin|cli|test；非法值如实 400（不再静默按 cli 处理）。
      if (rawClientKind !== undefined && rawClientKind !== '') {
        clientKind = normalizeClientKind(rawClientKind);
      }
      const matched = router.match(req.method, pathname);
      if (!matched) throw notFound(`未知端点：${req.method} ${pathname}`);
      if (matched.methodNotAllowed) {
        res.setHeader('Allow', matched.allowed.join(', '));
        throw new ApiError('METHOD_NOT_ALLOWED', `${req.method} 不支持该端点（允许：${matched.allowed.join(', ')}）`);
      }
      const { route, params } = matched;
      if (state.shuttingDown && route.pattern !== '/health') throw shuttingDown();
      const effectiveClientKind = clientKind ?? 'cli';
      if (route.auth) {
        const authResult = authenticateRequest(req, token, { allowQueryToken: route.allowQueryToken });
        if (!authResult.ok) throw unauthorized('缺少或错误的 Bearer token（token 见 <FCA_HOME>/config/runtime-token）');
      }
      if (route.requiresDb && !holder.isInitialized) {
        if (holder.state === 'error') {
          throw databaseError(`数据库不可用：${holder.error?.message ?? 'unknown'}（可尝试 POST /api/v1/restore 恢复备份）`);
        }
        throw notInitialized();
      }
      let body = {};
      if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
        body = await readJsonBody(req, config.maxBodyBytes);
      }
      const ctx = {
        req,
        res,
        url,
        pathname,
        params,
        query: Object.fromEntries(url.searchParams.entries()),
        searchParams: url.searchParams,
        body,
        traceId,
        clientKind: effectiveClientKind,
        remoteAddress: req.socket?.remoteAddress ?? null,
        method: req.method,
        config,
        logger,
        token,
        holder,
        events,
        hub,
        services,
        state,
        requestStartedAt: startedMs,
      };
      const result = await route.handler(ctx);
      if (route.raw) return;
      if (result === undefined || result === null) {
        sendJson(res, 204, undefined);
        return;
      }
      sendJson(res, result.status ?? 200, result.body, result.headers ?? {});
    } catch (err) {
      handleError(err, { req, res, traceId, state, logger, pathname });
    }
  }

  function handleError(err, { req, res, traceId, state, logger, pathname }) {
    let apiErr = err;
    if (!(err instanceof ApiError)) {
      if (isSqliteError(err)) {
        apiErr = databaseError(`SQLite 错误：${err.message}`);
        logger.warn?.('数据库错误', { error: err.message, path: pathname, trace_id: traceId });
      } else {
        apiErr = internal(err?.message ? `内部错误：${err.message}` : '内部错误');
        logger.error?.('未处理异常', {
          error: err?.message ?? String(err),
          stack: String(err?.stack ?? '').slice(0, 4000),
          path: pathname,
          trace_id: traceId,
        });
      }
    } else if (apiErr.code !== 'NOT_FOUND' && apiErr.code !== 'VERSION_CONFLICT' && apiErr.code !== 'VALIDATION_FAILED') {
      logger.warn?.('请求错误', { code: apiErr.code, message: apiErr.message, path: pathname, trace_id: traceId });
    }
    state.errorStats.count += 1;
    state.errorStats.last = {
      code: apiErr.code,
      message: apiErr.message,
      ts: new Date().toISOString(),
      trace_id: traceId,
      path: pathname,
    };
    if (!res.headersSent) sendError(res, apiErr, traceId);
    else {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      try {
        handleError(err, { req, res, traceId: newTraceId(), state, logger, pathname: req.url ?? '/' });
      } catch {
        /* ignore */
      }
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = Math.max(config.requestTimeoutMs, 30_000);

  function start() {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        const address = server.address();
        resolve({ host: config.host, port: address && typeof address === 'object' ? address.port : config.port });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      try {
        server.listen(config.port, config.host);
      } catch (err) {
        server.removeListener('error', onError);
        reject(err);
      }
    });
  }

  function stop() {
    hub?.stopHeartbeat?.();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      try {
        server.close(() => finish());
        server.closeIdleConnections?.();
        setTimeout(finish, 3000).unref?.();
      } catch {
        finish();
      }
    });
  }

  return { server, router, start, stop };
}
