'use strict';

/**
 * FCA Alpha 0.1 — QA 公共工具（Node 24，零第三方依赖）
 *
 * 提供：路径常量、文件/进程/端口工具、断言与检查结果记录、Markdown/JSON 报告输出。
 * 由 tests/e2e、tests/security、tests/performance、tests/install 复用。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

const PATHS = {
  ROOT,
  RUNTIME_ENTRY: path.join(ROOT, 'runtime', 'bin', 'fca-runtime.js'),
  RUNTIME_DIR: path.join(ROOT, 'runtime'),
  DESKTOP_DIR: path.join(ROOT, 'desktop'),
  DESKTOP_MAIN: path.join(ROOT, 'desktop', 'main', 'main.js'),
  DESKTOP_RENDERER_INDEX: path.join(ROOT, 'desktop', 'renderer', 'index.html'),
  ELECTRON: path.join(ROOT, '.cache', 'electron-dist', 'electron.exe'),
  VENDOR_NODE: path.join(ROOT, 'vendor', 'node', 'node.exe'),
  NSIS: path.join(ROOT, '.cache', 'nsis', 'Bin', 'makensis.exe'),
  INSTALLER_DIR: path.join(ROOT, 'artifacts', 'installer'),
  ARTIFACTS: path.join(ROOT, 'artifacts'),
  REPORTS: path.join(ROOT, 'artifacts', 'reports'),
  SCREENSHOTS: path.join(ROOT, 'artifacts', 'screenshots'),
  RECORDINGS: path.join(ROOT, 'artifacts', 'recordings'),
  QA_HOME_ROOT: path.join(ROOT, '.cache', 'qa-home'),
  QA_LOG_ROOT: path.join(ROOT, '.cache', 'qa-logs'),
  DOCS: path.join(ROOT, 'docs'),
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureAllDirs() {
  for (const dir of [PATHS.REPORTS, PATHS.SCREENSHOTS, PATHS.RECORDINGS, PATHS.QA_HOME_ROOT, PATHS.QA_LOG_ROOT]) {
    ensureDir(dir);
  }
}

/** 安全删除（仅允许删除 .cache/qa-* 与 artifacts 下 QA 自己创建的路径） */
function removeDirStrict(target) {
  const resolved = path.resolve(target);
  const allowed = resolved.startsWith(path.resolve(PATHS.QA_HOME_ROOT)) || resolved.startsWith(path.join(path.resolve(PATHS.ARTIFACTS), 'reports', 'e2e'));
  if (!allowed) throw new Error(`拒绝删除非 QA 隔离目录：${resolved}`);
  if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return filePath;
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text, 'utf8');
  return filePath;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function nowIso() {
  return new Date().toISOString();
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function sha256File(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function dirExists(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function dirSize(dirPath) {
  let total = 0;
  let files = 0;
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
          files += 1;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dirPath);
  return { bytes: total, files };
}

function parseToolsNodeCmd() {
  const cmdPath = path.join(ROOT, 'tools', 'node.cmd');
  try {
    const text = fs.readFileSync(cmdPath, 'utf8');
    const matches = text.match(/"([^"]*node\.exe)"/gi) || [];
    for (const raw of matches) {
      const p = raw.replace(/^"|"$/g, '').trim();
      if (fileExists(p)) return p;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 本机可用 Node 24 可执行文件（Runtime 与脚本统一使用）：
 * process.execPath（当脚本本身由 Node 启动时）→ vendor\node\node.exe → tools/node.cmd 解析。
 */
function resolveNodeBin() {
  const candidates = [];
  if (process.versions && process.versions.node && !process.versions.electron) candidates.push(process.execPath);
  candidates.push(PATHS.VENDOR_NODE, parseToolsNodeCmd());
  for (const p of candidates) {
    if (p && fileExists(p)) return p;
  }
  throw new Error('未找到 Node 可执行文件（process.execPath / vendor\\node\\node.exe / tools\\node.cmd）');
}

function isElectronRuntime() {
  return Boolean(process.versions && process.versions.electron);
}

function runProcess(command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs || 60_000,
    windowsHide: true,
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    input: options.input,
  });
  return {
    code: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? result.error.message : null,
    ms: Date.now() - started,
  };
}

/** 取一个空闲端口（Windows 下绑定后释放；有极小竞争窗口，可接受） */
async function freePort(preferred = null) {
  const tryBind = (port) =>
    new Promise((resolve) => {
      const srv = net.createServer();
      srv.unref();
      srv.on('error', () => resolve(false));
      srv.listen(port, '127.0.0.1', () => {
        srv.close(() => resolve(true));
      });
    });
  if (preferred) {
    if (await tryBind(preferred)) return preferred;
  }
  for (let i = 0; i < 40; i += 1) {
    const port = 20000 + Math.floor(Math.random() * 30000);
    if (await tryBind(port)) return port;
  }
  throw new Error('无法获取空闲端口');
}

async function waitPortOpen(port, { timeoutMs = 15_000, host = '127.0.0.1', intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect({ port, host });
      const done = (v) => {
        sock.destroy();
        resolve(v);
      };
      sock.setTimeout(600, () => done(false));
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    });
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 120, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const suffix = lastError ? `（最后错误：${lastError.message}）` : '';
  throw new Error(`等待超时 ${timeoutMs}ms：${label}${suffix}`);
}

// ---------------------------------------------------------------------------
// HTTP 客户端（Bearer token + 追踪 ID）
// ---------------------------------------------------------------------------
/**
 * @param {{baseUrl:string, token?:string|null, clientKind?:string, timeoutMs?:number}} options
 */
function createHttpClient(options) {
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
  let token = options.token || null;
  const clientKind = options.clientKind || 'test';
  const defaultTimeout = options.timeoutMs || 30_000;
  const stats = { requests: 0, errors: 0, totalMs: 0 };

  async function request(method, endpoint, opts = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `${baseUrl}${endpoint}`;
    const headers = { 'X-FCA-Client': clientKind, ...(opts.headers || {}) };
    const useToken = opts.token !== undefined ? opts.token : token;
    if (useToken) headers.Authorization = `Bearer ${useToken}`;
    let body;
    if (opts.body !== undefined) {
      if (opts.rawBody) body = opts.rawBody;
      else {
        body = JSON.stringify(opts.body);
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      }
    }
    const timeout = opts.timeoutMs ?? defaultTimeout;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const started = Date.now();
    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'manual' });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      const ms = Date.now() - started;
      stats.requests += 1;
      stats.totalMs += ms;
      return {
        ok: res.ok,
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        text,
        json,
        traceId: res.headers.get('x-fca-trace-id'),
        ms,
        url,
      };
    } catch (error) {
      stats.errors += 1;
      return { ok: false, status: 0, headers: {}, text: '', json: null, error: String(error && error.message ? error.message : error), ms: Date.now() - started, url };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    request,
    get: (endpoint, opts) => request('GET', endpoint, opts),
    post: (endpoint, body, opts) => request('POST', endpoint, { ...(opts || {}), body: body === undefined ? {} : body }),
    patch: (endpoint, body, opts) => request('PATCH', endpoint, { ...(opts || {}), body: body === undefined ? {} : body }),
    del: (endpoint, opts) => request('DELETE', endpoint, opts),
    getToken: () => token,
    setToken: (value) => {
      token = value;
    },
    getBaseUrl: () => baseUrl,
    stats,
  };
}

// ---------------------------------------------------------------------------
// SSE 客户端（真实 HTTP 长连接，解析 event/id/data，支持 Last-Event-ID）
// ---------------------------------------------------------------------------
function createSseClient(options) {
  const http = require('node:http');
  const url = new URL(options.url);
  const events = [];
  const rawFrames = [];
  const errors = [];
  let request = null;
  let response = null;
  let closed = false;
  let buffer = '';

  function parseFrame(frame) {
    const lines = frame.split(/\r?\n/);
    let eventName = 'message';
    let id = null;
    const dataLines = [];
    for (const line of lines) {
      if (!line || line.startsWith(':')) continue;
      const idx = line.indexOf(':');
      const field = idx === -1 ? line : line.slice(0, idx);
      let value = idx === -1 ? '' : line.slice(idx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') eventName = value;
      else if (field === 'id') id = value;
      else if (field === 'data') dataLines.push(value);
    }
    const dataText = dataLines.join('\n');
    let data = dataText;
    try {
      data = JSON.parse(dataText);
    } catch {
      /* 保持字符串 */
    }
    return { event: eventName, id, data, at: nowIso() };
  }

  function connect({ lastEventId = null } = {}) {
    return new Promise((resolve, reject) => {
      const headers = { Accept: 'text/event-stream', 'X-FCA-Client': options.clientKind || 'test' };
      if (options.token) headers.Authorization = `Bearer ${options.token}`;
      if (lastEventId) headers['Last-Event-ID'] = String(lastEventId);
      request = http.get(
        { hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: 'GET', headers },
        (res) => {
          response = res;
          if (res.statusCode !== 200) {
            reject(new Error(`SSE 连接失败：HTTP ${res.statusCode}`));
            return;
          }
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            buffer += chunk;
            let idx;
            while ((idx = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              if (!frame.trim()) continue;
              rawFrames.push(frame);
              events.push(parseFrame(frame));
            }
          });
          res.on('end', () => {
            closed = true;
          });
          resolve({ status: res.statusCode, headers: res.headers });
        },
      );
      request.on('error', (error) => {
        errors.push(String(error.message));
        if (!response) reject(error);
      });
      request.setTimeout(options.timeoutMs || 60_000, () => {
        errors.push('SSE 读取超时');
        request.destroy();
      });
    });
  }

  async function waitForEvent(predicate, timeoutMs = 15_000, label = 'SSE 事件') {
    return waitFor(() => {
      const hit = events.find((ev) => {
        try {
          return predicate(ev);
        } catch {
          return false;
        }
      });
      if (hit) return hit;
      if (closed && !events.length) throw new Error(`SSE 连接已关闭（错误：${errors.join('; ') || '无'}）`);
      return null;
    }, { timeoutMs, label });
  }

  function close() {
    try {
      request?.destroy();
    } catch {
      /* ignore */
    }
    request = null;
    response = null;
    closed = true;
  }

  return { connect, close, waitForEvent, events, rawFrames, errors, isClosed: () => closed };
}

// ---------------------------------------------------------------------------
// 检查结果记录
// ---------------------------------------------------------------------------
class Checks {
  constructor(prefix = '') {
    this.prefix = prefix;
    this.items = [];
    this.startedAt = nowIso();
    this.startedMs = Date.now();
  }

  /**
   * 记录一条检查。
   * @param {string} name
   * @param {boolean} ok
   * @param {{detail?:string, evidence?:any, severity?:'blocker'|'high'|'medium'|'low'}} [meta]
   */
  add(name, ok, meta = {}) {
    const item = {
      id: `${this.prefix}${this.items.length + 1}`,
      name,
      status: ok ? 'PASS' : meta.skip ? 'SKIP' : 'FAIL',
      detail: meta.detail || '',
      evidence: meta.evidence || null,
      severity: meta.severity || (ok ? null : 'medium'),
      at: nowIso(),
    };
    this.items.push(item);
    const mark = item.status === 'PASS' ? 'PASS' : item.status === 'SKIP' ? 'SKIP' : 'FAIL';
    const suffix = item.detail ? ` — ${String(item.detail).slice(0, 400)}` : '';
    console.log(`[${mark}] ${name}${suffix}`);
    return item;
  }

  pass(name, meta = {}) {
    return this.add(name, true, meta);
  }

  fail(name, detail, meta = {}) {
    return this.add(name, false, { ...meta, detail });
  }

  skip(name, detail, meta = {}) {
    return this.add(name, false, { ...meta, skip: true, detail });
  }

  async check(name, fn, meta = {}) {
    try {
      const result = await fn();
      if (result === false) this.fail(name, '返回 false', meta);
      else if (result && result.ok === false) this.fail(name, result.detail || '未通过', meta);
      else this.pass(name, { ...meta, evidence: (result && result.evidence) || meta.evidence, detail: (result && result.detail) || meta.detail });
      return result;
    } catch (error) {
      this.fail(name, String(error && error.stack ? error.message : error), meta);
      return null;
    }
  }

  summary() {
    const passed = this.items.filter((i) => i.status === 'PASS').length;
    const failed = this.items.filter((i) => i.status === 'FAIL').length;
    const skipped = this.items.filter((i) => i.status === 'SKIP').length;
    return {
      total: this.items.length,
      passed,
      failed,
      skipped,
      duration_ms: Date.now() - this.startedMs,
      started_at: this.startedAt,
      finished_at: nowIso(),
    };
  }
}

function toMarkdownTable(rows, headers) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map((cell) => String(cell ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

module.exports = {
  PATHS,
  ROOT,
  ensureDir,
  ensureAllDirs,
  removeDirStrict,
  readJson,
  writeJson,
  writeText,
  sleep,
  nowIso,
  stamp,
  fileSize,
  fileExists,
  dirExists,
  dirSize,
  sha256File,
  resolveNodeBin,
  isElectronRuntime,
  runProcess,
  freePort,
  waitPortOpen,
  waitFor,
  createHttpClient,
  createSseClient,
  Checks,
  toMarkdownTable,
  os,
};
