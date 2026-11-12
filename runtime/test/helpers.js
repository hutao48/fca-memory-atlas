// FCA Local Runtime — 测试辅助（真实子进程 + 真实 HTTP + 真实 SQLite；不使用 Mock 冒充成功）
// 注意：本文件不以 .test.js 结尾，不会被 node:test 当作测试文件执行。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(TEST_DIR, '..', '..');
export const RUNTIME_BIN = path.join(PROJECT_ROOT, 'runtime', 'bin', 'fca-runtime.js');
export const CACHE_ROOT = path.join(PROJECT_ROOT, '.cache', 'rt-tests');
let homeCounter = 0;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(predicate, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (err) {
      lastError = err;
      if (err && err.fatal) throw err;
    }
    await sleep(intervalMs);
  }
  throw lastError ?? new Error(`waitUntil 超时（${timeoutMs}ms）`);
}

/** 在项目 .cache/rt-tests 下创建隔离数据目录（测试失败时保留日志可排查）。 */
export function makeHome(name = 'rt') {
  const unique = `${name}-${process.pid}-${Date.now().toString(36)}-${(homeCounter++).toString(36)}`;
  const home = path.join(CACHE_ROOT, unique);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

export function cleanupHome(home) {
  if (!home) return;
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Windows 上偶发文件占用；保留供排查 */
  }
}

export function readToken(home) {
  return fs.readFileSync(path.join(home, 'config', 'runtime-token'), 'utf8').trim();
}

/** 运行 CLI 子进程，返回 {code, stdout, stderr}。 */
export function runCli(args, { env = {}, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNTIME_BIN, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, FCA_LOG_LEVEL: 'error', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\nspawn error: ${err.message}` });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code === null ? -1 : code, signal, stdout, stderr });
    });
  });
}

/** 从 CLI JSON 输出中解析最后一个 JSON 对象（容忍日志混入 stderr 的情况，stdout 应为纯 JSON）。 */
export function parseCliJson(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    return null;
  }
}

export async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

/** 取一个当前未监听端口（用于“不可达 Provider”场景）。 */
export async function getUnusedPort() {
  return getFreePort();
}

export async function initHome(home) {
  const result = await runCli(['init', `--fca-home=${home}`]);
  if (result.code !== 0) {
    throw new Error(`fca-runtime init 失败 code=${result.code}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return result;
}

function makeApiClient(rt) {
  return async function api(pathname, { method = 'GET', body, raw = false, headers = {}, token = rt.token, timeoutMs = 20_000 } = {}) {
    const init = {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'x-fca-client': 'test',
        ...headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    const response = typeof fetch === 'function' ? await fetch(`${rt.url}${pathname}`, init) : null;
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (raw) return { status: response.status, headers: response.headers, text, json };
    return { status: response.status, headers: response.headers, json, text };
  };
}

/**
 * 启动真实 Runtime 子进程（真实 CLI serve + 真实端口 + 真实 SQLite）。
 * @returns {Promise<object>}
 */
export async function startRuntime({ home = makeHome('rt'), env = {}, init = true, port = null, startupTimeoutMs = 25_000 } = {}) {
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  if (init) await initHome(home);
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const selectedPort = port ?? (await getFreePort());
    const childState = { stdout: '', stderr: '', exited: false, exitCode: null, exitSignal: null };
    const child = spawn(process.execPath, [RUNTIME_BIN, 'serve', `--fca-home=${home}`, `--port=${selectedPort}`], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, FCA_LOG_LEVEL: 'error', FCA_ENV: 'test', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (d) => {
      childState.stdout += d;
    });
    child.stderr.on('data', (d) => {
      childState.stderr += d;
    });
    child.on('exit', (code, signal) => {
      childState.exited = true;
      childState.exitCode = code;
      childState.exitSignal = signal;
    });
    const url = `http://127.0.0.1:${selectedPort}`;
    const rt = {
      home,
      port: selectedPort,
      url,
      child,
      childState,
      get token() {
        return readToken(home);
      },
      logs() {
        return `--- runtime stdout ---\n${childState.stdout}\n--- runtime stderr ---\n${childState.stderr}`;
      },
    };
    rt.api = makeApiClient(rt);
    rt.stop = async function stop() {
      if (childState.exited) return childState.exitCode;
      try {
        await rt.api('/api/v1/shutdown', { method: 'POST', body: {} });
      } catch {
        /* 进程可能在响应前退出 */
      }
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        if (childState.exited) return childState.exitCode;
        await sleep(50);
      }
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      await sleep(100);
      return childState.exitCode;
    };
    try {
      await waitUntil(
        async () => {
          if (childState.exited) {
            const err = new Error(`Runtime 提前退出（code=${childState.exitCode}）\n${rt.logs()}`);
            err.fatal = true;
            throw err;
          }
          if (childState.stdout.includes('FCA_RUNTIME_READY')) return true;
          try {
            const response = await fetch(`${url}/health`);
            if (response.ok) return true;
          } catch {
            /* not ready */
          }
          return false;
        },
        { timeoutMs: startupTimeoutMs, intervalMs: 100 },
      );
      return rt;
    } catch (err) {
      lastError = err;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      const combined = childState.stdout + childState.stderr;
      if (!/EADDRINUSE|PORT_IN_USE|端口 .* 已被占用/.test(combined)) {
        throw err;
      }
      await sleep(200);
    }
  }
  throw lastError ?? new Error('无法启动 Runtime 子进程');
}

/** 便捷：创建 home + 启动 runtime；调用方负责 stop/cleanup。 */
export async function createRuntime(name, options = {}) {
  const home = makeHome(name);
  return startRuntime({ home, ...options });
}

/** 结清一个 runtime：优雅关闭 + 清理数据目录。 */
export async function disposeRuntime(rt, { keepHome = false } = {}) {
  if (!rt) return;
  try {
    await rt.stop();
  } finally {
    if (!keepHome) cleanupHome(rt.home);
  }
}

/** 启动一个本地 fake OpenAI-compatible Provider HTTP 服务（确定性测试用；不是真实 API）。 */
export async function startFakeProvider({ mode = 'ok', replyPrefix = 'fake-reply', delayMs = 0 } = {}) {
  const requests = [];
  let overrideMode = mode;
  let overrideText = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body, raw });
      const send = () => {
        const currentMode = overrideMode;
        if (currentMode === 'auth') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid api key (fake provider)' } }));
          return;
        }
        if (currentMode === 'error500') {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'fake provider unavailable' } }));
          return;
        }
        const lastUser = Array.isArray(body?.messages) ? [...body.messages].reverse().find((m) => m.role === 'user') : null;
        const text = overrideText ?? `${replyPrefix}:${String(lastUser?.content ?? '').slice(0, 120)}`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-fake',
            object: 'chat.completion',
            model: body?.model ?? 'fake-model',
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
          }),
        );
      };
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    setMode(nextMode) {
      overrideMode = nextMode;
    },
    setReply(text) {
      overrideText = text;
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** SSE 订阅：返回 { events, frames, close() }，后台持续读取。 */
export async function subscribeSse(rt, { lastEventId = null, types = null, closeAfterMs = 10_000 } = {}) {
  const controller = new AbortController();
  const headers = { authorization: `Bearer ${rt.token}`, 'x-fca-client': 'test', accept: 'text/event-stream' };
  if (lastEventId !== null) headers['last-event-id'] = String(lastEventId);
  const url = new URL(`${rt.url}/api/v1/events/stream`);
  if (types) url.searchParams.set('types', types.join(','));
  const response = await fetch(url, { headers, signal: controller.signal });
  if (!response.ok) throw new Error(`SSE 连接失败：HTTP ${response.status}`);
  const frames = [];
  const events = [];
  let closed = false;
  const decoder = new TextDecoder();
  let buffer = '';
  (async () => {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n\n');
        while (index !== -1) {
          const frameText = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          index = buffer.indexOf('\n\n');
          if (!frameText.trim()) continue;
          const frame = { raw: frameText, event: null, id: null, data: null };
          for (const line of frameText.split('\n')) {
            if (line.startsWith('event: ')) frame.event = line.slice(7).trim();
            else if (line.startsWith('id: ')) frame.id = Number(line.slice(4).trim());
            else if (line.startsWith('data: ')) {
              try {
                frame.data = JSON.parse(line.slice(6));
              } catch {
                frame.data = line.slice(6);
              }
            }
          }
          frames.push(frame);
          if (frame.event === 'fca.event' && frame.data) events.push(frame.data);
        }
      }
    } catch {
      /* aborted */
    } finally {
      closed = true;
    }
  })();
  const timer = setTimeout(() => controller.abort(), closeAfterMs);
  timer.unref?.();
  return {
    frames,
    events,
    get closed() {
      return closed;
    },
    async waitForEvent(predicate, { timeoutMs = 5000 } = {}) {
      return waitUntil(() => events.find(predicate), { timeoutMs, intervalMs: 25 });
    },
    async close() {
      clearTimeout(timer);
      controller.abort();
      await sleep(20);
    },
  };
}

/** 字节大小（用于断言“不整库上传”等）。 */
export function byteLength(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}
