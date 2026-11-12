'use strict';

/**
 * FCA Local Runtime 进程控制（真实子进程 + 真实 HTTP）。
 *
 * 用法：
 *   const runtime = await startRuntime({ name: 'scenario-a', port: 17861 });
 *   await runtime.http.get('/api/v1/state');
 *   await runtime.stop();
 *
 * 隔离：FCA_HOME 指向 .cache/qa-home/<runId>/<name>，绝不触碰用户真实数据目录。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const c = require('./common.cjs');

const DEFAULT_PORT = 17860;

class RuntimeError extends Error {}

function fcaPaths(fcaHome) {
  return {
    home: fcaHome,
    config: path.join(fcaHome, 'config'),
    tokenFile: path.join(fcaHome, 'config', 'runtime-token'),
    dbDir: path.join(fcaHome, 'db'),
    db: path.join(fcaHome, 'db', 'fca.db'),
    eventsDir: path.join(fcaHome, 'events'),
    logsDir: path.join(fcaHome, 'logs'),
    backupsDir: path.join(fcaHome, 'backups'),
    exportsDir: path.join(fcaHome, 'exports'),
    qaLog: path.join(fcaHome, 'qa-logs'),
  };
}

function readToken(fcaHome) {
  try {
    const raw = fs.readFileSync(fcaPaths(fcaHome).tokenFile, 'utf8').trim();
    if (!raw) return null;
    // token 文件可能是纯 token，也可能是 {token} JSON
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        return String(parsed.token || parsed.value || '').trim() || null;
      } catch {
        return null;
      }
    }
    return raw;
  } catch {
    return null;
  }
}

function runtimeEntryAvailable() {
  return c.fileExists(c.PATHS.RUNTIME_ENTRY);
}

/**
 * 启动一个隔离的 Runtime 实例。
 * @param {{name:string, port?:number|null, fcaHome?:string, runId?:string, fresh?:boolean, timeoutMs?:number, env?:object, seedDemo?:boolean}} options
 */
/**
 * 探测端口上是否已有真实 Runtime 在监听（Windows 下 SO_REUSEADDR 语义会让"绑定测试"漏判 Node 服务，
 * 因此必须叠加 /health 探测，避免并发测试文件互相抢端口）。
 */
async function runtimeHealthyOnPort(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * 在指定区间内找一个空闲端口（默认 17880..17895，避开 17860 插件 / 17861 桌面 owner）。
 * 以 pid 取偏移打散并发测试进程的探测顺序，并叠加 /health 探测降低端口竞争。
 */
async function freeQaPort() {
  const start = Number(process.env.FCA_QA_PORT_START || 17880);
  const end = Number(process.env.FCA_QA_PORT_END || 17895);
  const span = end - start + 1;
  const offset = process.pid % span;
  for (let i = 0; i < span; i += 1) {
    const port = start + ((offset + i) % span);
    if (await runtimeHealthyOnPort(port)) continue;
    if (await c.freePort(port)) return port;
  }
  for (let i = 0; i < 20; i += 1) {
    const port = 20000 + Math.floor(Math.random() * 30000);
    if (await runtimeHealthyOnPort(port)) continue;
    if (await c.freePort(port)) return port;
  }
  throw new Error('无法获取空闲端口（17880-17895 与随机高位端口均被占用）');
}

async function startRuntime(options = {}) {
  const name = options.name || `runtime-${Date.now()}`;
  const runId = options.runId || 'default';
  const fcaHome = path.resolve(options.fcaHome || path.join(c.PATHS.QA_HOME_ROOT, runId, name));
  const port = options.port || (await freeQaPort());
  const fresh = options.fresh !== false;
  if (fresh) c.removeDirStrict(fcaHome);
  c.ensureDir(fcaHome);
  const logs = fcaPaths(fcaHome);
  c.ensureDir(logs.qaLog);

  if (!runtimeEntryAvailable()) {
    throw new RuntimeError(`Runtime CLI 未就绪：${path.relative(c.ROOT, c.PATHS.RUNTIME_ENTRY)} 不存在（等待 runtime-core 交付）`);
  }
  const nodeBin = c.resolveNodeBin();
  const entryRel = path.relative(c.ROOT, c.PATHS.RUNTIME_ENTRY);
  const stdout = [];
  const stderr = [];
  const record = (bucket, chunk) => {
    const text = String(chunk);
    bucket.push(text);
    if (bucket.length > 400) bucket.splice(0, bucket.length - 400);
    try {
      fs.appendFileSync(path.join(logs.qaLog, 'runtime.out.log'), text);
    } catch {
      /* ignore */
    }
  };

  // 1) init（空库初始化；recover 模式跳过——用于"数据库损坏后启动"故障注入场景）
  let init = null;
  if (!options.recover) {
    try {
      init = c.runProcess(nodeBin, [entryRel, 'init', '--fca-home', fcaHome, '--port', String(port)], {
        cwd: c.ROOT,
        env: { ...process.env, ...(options.env || {}), FCA_HOME: fcaHome },
        timeoutMs: options.initTimeoutMs || 90_000,
      });
    } catch (error) {
      init = { code: -1, error: String(error.message) };
    }
  }

  // 2) serve（前台子进程，输出落盘）。
  //    并发测试文件可能同时抢到同一空闲端口：此时本进程的 serve 会 EADDRINUSE 退出，
  //    而 health 探测会命中"别人"的 Runtime。这里用 pid 一致性校验识别冲突并自动换端口重试，
  //    绝不把请求发往非本次启动的 Runtime（防止误读/误关其它实例）。
  const attempts = [];
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const attemptPort = attempt === 0 ? port : await freeQaPort();
    const args = [entryRel, 'serve', '--fca-home', fcaHome, '--port', String(attemptPort)];
    const child = spawn(nodeBin, args, {
      cwd: c.ROOT,
      env: { ...process.env, ...(options.env || {}), FCA_HOME: fcaHome, FCA_PORT: String(attemptPort) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => record(stdout, chunk));
    child.stderr.on('data', (chunk) => record(stderr, chunk));
    let exitInfo = null;
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal, at: c.nowIso() };
    });

    const handle = {
      name,
      fcaHome,
      port: attemptPort,
      nodeBin,
      child,
      paths: logs,
      init,
      startedAt: c.nowIso(),
      exitInfo: () => exitInfo,
      stdout: () => stdout.join(''),
      stderr: () => stderr.join(''),
      baseUrl: `http://127.0.0.1:${attemptPort}`,
      http: null,
      token: null,
      sse: null,
    };

    try {
      await c.waitPortOpen(attemptPort, { timeoutMs: options.timeoutMs || 30_000 });
      const probe = c.createHttpClient({ baseUrl: handle.baseUrl, clientKind: 'test', timeoutMs: 4000 });
      const health = await c.waitFor(
        async () => {
          const res = await probe.get('/health', { token: null });
          return res.status === 200 ? res : null;
        },
        { timeoutMs: options.healthTimeoutMs || 30_000, intervalMs: 150, label: 'Runtime /health 就绪' },
      );
      if (health.json && health.json.pid && Number(health.json.pid) !== child.pid) {
        throw new RuntimeError(
          `端口 ${attemptPort} 已被其它 Runtime 占用（/health.pid=${health.json.pid}，期望子进程 pid=${child.pid}），自动换端口重试`,
        );
      }
      handle.health = health.json;
      handle.token = readToken(fcaHome);
      if (!handle.token) {
        await c.waitFor(() => readToken(fcaHome), { timeoutMs: 10_000, label: 'runtime-token 文件生成' });
        handle.token = readToken(fcaHome);
      }
      const http = c.createHttpClient({ baseUrl: handle.baseUrl, token: handle.token, clientKind: 'test' });
      handle.http = http;

      // 3) 空库初始化兜底（幂等）：health.initialized=false 时调用 /api/v1/db/init
      //    recover 模式（数据库损坏故障注入）不做兜底：保持 degraded 状态供测试验证 503 + /restore
      if (!options.recover && health.json && health.json.initialized === false) {
        const initRes = await http.post('/api/v1/db/init', {});
        handle.initResponse = { status: initRes.status, body: initRes.json };
        if (!initRes.ok) throw new RuntimeError(`Runtime 已启动但空库初始化失败：HTTP ${initRes.status} ${initRes.text.slice(0, 500)}`);
        await c.waitFor(async () => {
          const h = await probe.get('/health', { token: null });
          return h.json && h.json.initialized === true;
        }, { timeoutMs: 20_000, label: '数据库初始化完成' });
      }
      const health2 = await probe.get('/health', { token: null });
      handle.health = health2.json;
      handle.apiVersion = health2.json && health2.json.api_version;
      handle.version = health2.json && health2.json.version;
      return handle;
    } catch (error) {
      lastError = error;
      attempts.push({ port: attemptPort, error: String(error.message || error) });
      await stopRuntime(handle, { force: true }).catch(() => {});
    }
  }
  throw new RuntimeError(
    `Runtime 启动失败（${name}，已尝试端口 ${attempts.map((a) => `${a.port}: ${a.error}`).join(' | ')}）\n` +
      `--- stdout ---\n${stdout.join('').slice(-3000)}\n--- stderr ---\n${stderr.join('').slice(-4000)}`,
  );
}

async function stopRuntime(handle, options = {}) {
  if (!handle || !handle.child) return { already: true };
  const child = handle.child;
  if (handle.exitInfo()) {
    return { already: true, exit: handle.exitInfo() };
  }
  const waitExit = (timeoutMs) =>
    c
      .waitFor(() => (handle.exitInfo() ? handle.exitInfo() : null), { timeoutMs, intervalMs: 100, label: 'Runtime 退出' })
      .catch(() => null);

  // 优雅关闭：POST /api/v1/shutdown（优先），再 kill
  try {
    if (handle.http && !options.force) {
      await handle.http.post('/api/v1/shutdown', {}, { timeoutMs: 4000 });
    }
  } catch {
    /* ignore */
  }
  let exit = await waitExit(options.graceMs || 6000);
  if (!exit) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    exit = await waitExit(4000);
  }
  if (!exit) {
    try {
      c.runProcess('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeoutMs: 10_000 });
    } catch {
      /* ignore */
    }
    exit = await waitExit(5000);
  }
  return { exit: handle.exitInfo(), forced: !exit ? false : true };
}

/**
 * 便捷：临时起一个 Runtime 执行 fn 后关闭。
 */
async function withRuntime(options, fn) {
  const runtime = await startRuntime(options);
  try {
    return await fn(runtime);
  } finally {
    await stopRuntime(runtime).catch(() => {});
  }
}

/** 读取 Runtime 事件 JSONL 文件（按月份） */
function readEventJsonl(fcaHome) {
  const dir = fcaPaths(fcaHome).eventsDir;
  const events = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    return events;
  }
  for (const file of files) {
    const full = path.join(dir, file);
    let lines = [];
    try {
      lines = fs.readFileSync(full, 'utf8').split(/\r?\n/).filter(Boolean);
    } catch {
      continue;
    }
    for (const line of lines) {
      try {
        events.push({ ...JSON.parse(line), __file: file });
      } catch {
        /* ignore */
      }
    }
  }
  return events;
}

function readLogs(fcaHome) {
  const dir = fcaPaths(fcaHome).logsDir;
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort();
  } catch {
    return out;
  }
  for (const file of files) {
    try {
      out.push({ file, text: fs.readFileSync(path.join(dir, file), 'utf8') });
    } catch {
      /* ignore */
    }
  }
  return out;
}

module.exports = {
  DEFAULT_PORT,
  RuntimeError,
  fcaPaths,
  readToken,
  runtimeEntryAvailable,
  startRuntime,
  stopRuntime,
  withRuntime,
  readEventJsonl,
  readLogs,
};
