'use strict';

/**
 * FCA Desktop — Runtime 生命周期管理（主进程）
 *
 * 状态机：stopped → starting → running → (unhealthy | incompatible | error) → stopping → stopped
 * 职责：
 *  - 健康检查 http://127.0.0.1:<port>/health（免认证）
 *  - 未运行时定位 runtime/bin/fca-runtime.js + Node 24，spawn `serve`，等待健康就绪
 *  - 本桌面启动的 Runtime 在退出时按设置优雅关闭；用户其它客户端在用时不得杀死
 *  - 对外广播状态快照（IPC → renderer）
 */

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const paths = require('./paths');
const { createNetClient } = require('./net-client');

const HEALTH_TIMEOUT_MS = 1800;
const START_TIMEOUT_MS = 30000;
const STOP_TIMEOUT_MS = 6000;
const MONITOR_INTERVAL_MS = 8000;

function nowIso() {
  return new Date().toISOString();
}

function createRuntimeManager(options) {
  const logger = options.logger;
  const settingsStore = options.settings;
  const getWindow = options.getWindow || (() => null);
  const emitter = new EventEmitter();

  let state = 'stopped';
  let status = null;
  let monitorTimer = null;
  let child = null;
  let ownedByUs = false;
  let startPromise = null;
  let lastHealth = null;
  let lastError = null;
  let logRing = [];
  let consecutiveFailures = 0;
  let restartAttempts = 0;
  let disposed = false;
  status = makeStatus({ state });

  const net = createNetClient({
    logger,
    getBaseUrl: () => settingsStore.effectiveRuntimeUrl(),
    getToken: readToken,
    clientKind: 'desktop',
    clientVersion: paths.PRODUCT_VERSION,
  });

  function currentSettings() {
    return settingsStore.get();
  }

  function currentDataDir() {
    return currentSettings().dataDir || paths.defaultDataDir();
  }

  function tokenPath() {
    return paths.tokenPath(currentDataDir());
  }

  let tokenCache = { mtimeMs: -1, token: null };
  function readToken() {
    const p = tokenPath();
    try {
      const stat = fs.statSync(p);
      if (stat.mtimeMs !== tokenCache.mtimeMs) {
        tokenCache = { mtimeMs: stat.mtimeMs, token: net.readTokenFile(p) };
      }
      return tokenCache.token;
    } catch {
      tokenCache = { mtimeMs: -1, token: null };
      return null;
    }
  }

  function makeStatus(extra = {}) {
    const settings = currentSettings();
    return {
      state: extra.state || state,
      url: settingsStore.effectiveRuntimeUrl(),
      dataDir: settings.dataDir,
      port: settings.port,
      ownedByDesktop: ownedByUs,
      pid: child && child.pid ? child.pid : null,
      version: (lastHealth && lastHealth.version) || extra.version || null,
      apiVersion: (lastHealth && lastHealth.api_version) || extra.apiVersion || null,
      uptimeMs: (lastHealth && lastHealth.uptime_ms) || extra.uptimeMs || 0,
      initialized: lastHealth ? Boolean(lastHealth.initialized) : extra.initialized ?? null,
      dbStatus: (lastHealth && lastHealth.db) || extra.dbStatus || null,
      healthStatus: (lastHealth && lastHealth.status) || extra.healthStatus || null,
      clients: extra.clients ?? status?.clients ?? null,
      lastError,
      checkedAt: nowIso(),
      since: extra.since || (status && status.since) || null,
      logTail: logRing.slice(-12),
      runtimeEntry: resolveEntryInfo(),
      nodeBin: null,
    };
  }

  function resolveEntryInfo() {
    const found = paths.resolveRuntimeEntry(currentSettings());
    return found ? { entry: found.entry, root: found.root, source: found.source } : null;
  }

  function setState(next, extra = {}) {
    const prev = state;
    state = next;
    status = makeStatus({ state: next, ...extra });
    if (prev !== next && logger) logger.info('runtime', `状态 ${prev} → ${next}`, { url: status.url, ownedByDesktop: ownedByUs, error: lastError });
    try {
      emitter.emit('status', status);
    } catch (error) {
      if (logger) logger.error('runtime', '状态广播异常', { message: error.message });
    }
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send('fca:runtime:status', status);
      } catch {
        /* ignore */
      }
    }
    return status;
  }

  function pushLog(source, line) {
    const entry = { at: nowIso(), source, line: String(line).slice(0, 4000) };
    logRing.push(entry);
    if (logRing.length > 300) logRing.shift();
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send('fca:runtime:log', { entries: [entry] });
      } catch {
        /* ignore */
      }
    }
  }

  function httpGet(path, timeoutMs = HEALTH_TIMEOUT_MS) {
    return net.request({ method: 'GET', path, timeoutMs, noAuth: true });
  }

  function httpAuth(path, opts = {}) {
    return net.request({ method: opts.method || 'GET', path, body: opts.body, timeoutMs: opts.timeoutMs || 5000, query: opts.query });
  }

  /** 健康检查；成功返回 {ok, health}，失败返回 {ok:false, reason, health?} */
  async function probeHealth() {
    const res = await httpGet('/health', HEALTH_TIMEOUT_MS);
    if (!res.ok) {
      return { ok: false, reason: res.error ? res.error.code : `HTTP ${res.status}`, detail: res.error ? res.error.message : null };
    }
    const health = res.body && typeof res.body === 'object' ? res.body : null;
    if (!health) return { ok: false, reason: 'BAD_HEALTH_RESPONSE' };
    if (String(health.api_version) !== paths.FCA_API_VERSION) {
      return { ok: false, reason: 'INCOMPATIBLE', health, apiVersion: health.api_version };
    }
    return { ok: true, health };
  }

  /** 检测是否有其它客户端正在使用 Runtime（防误杀）；返回 {clients, others, known} */
  async function probeClients() {
    const res = await httpAuth('/api/v1/system/status', { timeoutMs: 3000 });
    if (!res.ok || !res.body || typeof res.body !== 'object') return { clients: null, others: null, known: false };
    const body = res.body;
    const candidates = [body.clients, body.client_count, body.storage && body.storage.clients, body.clients_count];
    for (const value of candidates) {
      if (Array.isArray(value)) {
        const others = value.filter((c) => c && String(c.kind || c.client || c.name || '').toLowerCase() !== 'desktop');
        return { clients: value, others: others.length, known: true };
      }
      if (typeof value === 'number') return { clients: value, others: Math.max(0, value - 1), known: true };
    }
    return { clients: null, others: null, known: false };
  }

  async function refreshFromHealth(health) {
    lastHealth = health;
    consecutiveFailures = 0;
    status = makeStatus({ state: 'running' });
    const newStatus = { ...status };
    try {
      emitter.emit('status', newStatus);
    } catch {
      /* ignore */
    }
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send('fca:runtime:status', newStatus);
      } catch {
        /* ignore */
      }
    }
    status = newStatus;
    return newStatus;
  }

  async function checkHealth(options = {}) {
    const probe = await probeHealth();
    if (probe.ok) {
      const wasStopped = state !== 'running';
      ownedByUs = ownedByUs && Boolean(child);
      lastError = null;
      await refreshFromHealth(probe.health);
      ensureMonitor();
      if (wasStopped && logger) logger.info('runtime', '已连接 Runtime', { url: settingsStore.effectiveRuntimeUrl(), version: probe.health.version });
      return { ok: true, health: probe.health };
    }
    if (probe.reason === 'INCOMPATIBLE') {
      lastHealth = probe.health || null;
      lastError = {
        code: 'INCOMPATIBLE',
        message: `Runtime API 版本不兼容：需要 API v${paths.FCA_API_VERSION}，实际 v${probe.apiVersion}。请升级或重新安装 FCA。`,
        hint: '不允许降级冒充成功；请安装与桌面端匹配的 Runtime。',
      };
      setState('incompatible');
      return { ok: false, error: lastError };
    }
    consecutiveFailures += 1;
    if (state === 'running' || state === 'starting') {
      if (consecutiveFailures >= 2) {
        lastError = {
          code: probe.reason || 'UNHEALTHY',
          message: '本地 Runtime 健康检查失败',
          detail: probe.detail || null,
          hint: '可能正在重启/退出；可点击“重启 Runtime”。',
        };
        setState('unhealthy');
      }
    } else if (state !== 'error') {
      setState('stopped');
    }
    if (options.silent !== true && logger) logger.debug('runtime', '健康检查失败', { reason: probe.reason, detail: probe.detail });
    return { ok: false, error: probe };
  }

  function ensureMonitor() {
    if (monitorTimer || disposed) return;
    monitorTimer = setInterval(() => {
      if (disposed) return;
      if (state === 'running' || state === 'unhealthy' || state === 'incompatible') {
        checkHealth({ silent: true }).catch(() => {});
      }
    }, MONITOR_INTERVAL_MS);
    if (monitorTimer.unref) monitorTimer.unref();
  }

  function stopMonitor() {
    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
  }

  function spawnRuntime(entryInfo, nodeInfo) {
    const settings = currentSettings();
    // 与 Lead 的安装版/开发版契约一致：node.exe fca-runtime.js serve --fca-home=<dataDir> --port=<port>
    const args = [entryInfo.entry, 'serve', `--fca-home=${currentDataDir()}`, `--port=${settings.port}`];
    const env = { ...process.env, FCA_HOME: currentDataDir(), FCA_PORT: String(settings.port), NODE_ENV: 'production' };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    // 若回退到 Electron 自身充当 Node，则需要 ELECTRON_RUN_AS_NODE=1
    if (nodeInfo.path === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';

    const cwd = entryInfo.root || paths.PROJECT_ROOT;
    if (logger) {
      logger.info('runtime', '启动 Runtime 进程', {
        node: nodeInfo.path,
        nodeSource: nodeInfo.source,
        entry: entryInfo.entry,
        cwd,
        port: settings.port,
        dataDir: currentDataDir(),
        warning: nodeInfo.warning,
      });
    }
    const proc = spawn(nodeInfo.path, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    const lineHandler = (source) => (buffer) => {
      const text = buffer.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        pushLog(source, line);
        if (logger) logger.info(`runtime:${source}`, line.replace(/\b(?:Bearer\s+)?[A-Za-z0-9._~+/=-]{40,}\b/g, '[REDACTED]'));
      }
    };
    if (proc.stdout) proc.stdout.on('data', lineHandler('stdout'));
    if (proc.stderr) proc.stderr.on('data', lineHandler('stderr'));

    proc.on('error', (error) => {
      lastError = {
        code: 'SPAWN_FAILED',
        message: `无法启动 Runtime 进程：${error.message}`,
        hint: `请检查 Node 可执行文件（${nodeInfo.path}）与 Runtime 入口（${entryInfo.entry}）是否存在、可执行。`,
      };
      if (logger) logger.error('runtime', 'Runtime 进程启动失败', { message: error.message });
      setState('error');
    });

    proc.on('exit', (code, signal) => {
      const wasOwned = ownedByUs;
      child = null;
      if (disposed) return;
      if (wasOwned) {
        if (state === 'stopping' || state === 'stopped') {
          pushLog('lifecycle', `Runtime 已退出（code=${code}, signal=${signal}）`);
          lastError = null;
          setState('stopped');
          return;
        }
        lastError = {
          code: 'RUNTIME_EXITED',
          message: `Runtime 进程意外退出（code=${code}${signal ? `, signal=${signal}` : ''}）`,
          hint: logRing.slice(-6).map((l) => l.line).join('\n') || '请在日志目录查看 runtime 日志。',
        };
        if (logger) logger.error('runtime', 'Runtime 进程意外退出', { code, signal });
        if (restartAttempts < 2 && currentSettings().autoStartRuntime && !disposed) {
          restartAttempts += 1;
          setState('starting', { since: nowIso() });
          setTimeout(() => {
            if (disposed) return;
            start({ reason: 'auto-restart' }).catch(() => {});
          }, 800 * restartAttempts);
        } else {
          setState('error');
        }
      }
    });

    child = proc;
    ownedByUs = true;
    return proc;
  }

  async function waitForHealthy(timeoutMs = START_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (disposed) throw new Error('disposed');
      const probe = await probeHealth();
      if (probe.ok) return probe.health;
      if (probe.reason === 'INCOMPATIBLE') {
        const error = new Error(`Runtime API 版本不兼容（api_version=${probe.apiVersion}）`);
        error.code = 'INCOMPATIBLE';
        throw error;
      }
      // 子进程已退出且进入 error/restart 状态时立即失败，不再空等 30s 超时
      // （典型场景：端口被无响应的旧 Runtime 占用 → 子进程打印 PORT_IN_USE 后退出）。
      if (!child && state === 'error' && lastError) {
        const error = new Error(lastError.message);
        error.code = lastError.code || 'RUNTIME_EXITED';
        error.hint = lastError.hint;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    const error = new Error(`Runtime 启动超时（${Math.round(timeoutMs / 1000)}s）`);
    error.code = 'START_TIMEOUT';
    throw error;
  }

  /**
   * 启动 Runtime（若已在运行则采用外部实例，不重复 spawn）。
   * @returns {Promise<{status:object}>}
   */
  async function start(options = {}) {
    if (disposed) throw new Error('Runtime manager disposed');
    if (startPromise) return startPromise;
    startPromise = (async () => {
      restartAttempts = 0;
      const probe = await probeHealth();
      if (probe.ok) {
        ownedByUs = false;
        lastError = null;
        await refreshFromHealth(probe.health);
        ensureMonitor();
        return { status, adopted: true };
      }
      if (probe.reason === 'INCOMPATIBLE') {
        lastHealth = probe.health || null;
        lastError = {
          code: 'INCOMPATIBLE',
          message: `Runtime API 版本不兼容：需要 API v${paths.FCA_API_VERSION}，实际 v${probe.apiVersion}`,
          hint: '请安装与桌面端匹配的 Runtime 版本。',
        };
        setState('incompatible');
        return { status, error: lastError };
      }

      const settings = currentSettings();
      if (!settings.allowExternalRuntime && !options.force) {
        // 允许策略关闭时仍可启动本地托管实例
      }
      const entryInfo = paths.resolveRuntimeEntry(settings);
      if (!entryInfo) {
        lastError = {
          code: 'RUNTIME_NOT_FOUND',
          message: '未找到本地 Runtime（runtime/bin/fca-runtime.js）',
          hint: [
            '开发环境：请确认项目根目录 D:\\FCA\\FCA-Memory-Atlas 下存在 runtime/bin/fca-runtime.js。',
            '安装环境：请重新安装 FCA Memory Atlas（安装包应包含 runtime 目录）。',
            '也可在设置中使用“Runtime 入口”高级选项手动指定。',
          ].join(' '),
        };
        setState('error');
        return { status, error: lastError };
      }
      const nodeInfo = paths.resolveNodeBin(settings);
      if (!nodeInfo) {
        lastError = {
          code: 'NODE_NOT_FOUND',
          message: '未找到可用的 Node 运行时（Runtime 需要 Node 24）',
          hint: [
            '开发环境：tools/node.cmd 应指向本机 Node 24。',
            '安装环境：安装包应随包分发独立 node.exe（或设置中手动指定 Node 路径）。',
          ].join(' '),
        };
        setState('error');
        return { status, error: lastError };
      }

      lastError = null;
      restartAttempts = 0;
      setState('starting', { since: nowIso(), nodeBin: nodeInfo.path });
      try {
        spawnRuntime(entryInfo, nodeInfo);
        const health = await waitForHealthy(options.timeoutMs || START_TIMEOUT_MS);
        lastHealth = health;
        lastError = null;
        consecutiveFailures = 0;
        await refreshFromHealth(health);
        ensureMonitor();
        if (logger) logger.info('runtime', 'Runtime 已就绪', { version: health.version, apiVersion: health.api_version, initialized: health.initialized });
        return { status };
      } catch (error) {
        lastError = {
          code: error.code || 'START_FAILED',
          message: error.message,
          hint: logRing.slice(-8).map((l) => `${l.source}: ${l.line}`).join('\n') || '请查看日志目录中的 runtime 日志。',
        };
        if (logger) logger.error('runtime', 'Runtime 启动失败', { message: error.message, tail: logRing.slice(-8) });
        // 结束僵尸进程
        try {
          if (child && !child.killed) child.kill();
        } catch {
          /* ignore */
        }
        child = null;
        ownedByUs = false;
        setState('error');
        return { status, error: lastError };
      }
    })();
    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  async function stop(options = {}) {
    if (disposed) return status;
    const reason = options.reason || 'user';
    const probe = await probeHealth();
    const wasOwned = ownedByUs && Boolean(child);
    if (!probe.ok) {
      // 未运行
      try {
        if (child && !child.killed) child.kill();
      } catch {
        /* ignore */
      }
      child = null;
      ownedByUs = false;
      lastHealth = null;
      lastError = null;
      setState('stopped');
      stopMonitor();
      return status;
    }
    if (!wasOwned && !options.force) {
      // 外部实例：不在用户明确要求时杀掉
      if (logger) logger.info('runtime', '检测到外部启动的 Runtime，不执行关闭', { url: status.url, reason });
      setState('running');
      return status;
    }

    // 客户端占用检查（退出策略：不杀死用户其它客户端正在使用的 Runtime）
    if (options.checkClients !== false) {
      const clients = await probeClients();
      if (clients.known && clients.others > 0) {
        if (logger) logger.info('runtime', '其它客户端正在使用 Runtime，跳过关闭', { others: clients.others, reason });
        setState('running', { clients: clients.clients });
        return status;
      }
    }

    setState('stopping');
    try {
      const res = await httpAuth('/api/v1/shutdown', { method: 'POST', timeoutMs: 3000 });
      if (!res.ok && logger) logger.warn('runtime', '优雅关闭请求失败，回退进程终止', { code: res.error && res.error.code });
    } catch (error) {
      if (logger) logger.warn('runtime', '优雅关闭异常', { message: error.message });
    }

    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const p = await probeHealth();
      if (!p.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const stillUp = await probeHealth();
    if (stillUp.ok && child) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      try {
        if (child && child.exitCode === null) child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    child = null;
    ownedByUs = false;
    lastHealth = null;
    lastError = null;
    stopMonitor();
    setState('stopped');
    if (logger) logger.info('runtime', 'Runtime 已关闭', { reason });
    return status;
  }

  async function restart() {
    await stop({ reason: 'restart', force: true, checkClients: false });
    return start({ reason: 'restart' });
  }

  /** 应用退出时的处理：满足策略才优雅关闭；否则保持运行（不打扰其它客户端） */
  async function shutdownForQuit() {
    if (disposed) return;
    disposed = true;
    stopMonitor();
    if (!ownedByUs || !child) return;
    const settings = currentSettings();
    if (settings.closeRuntimeOnExit) {
      try {
        await stop({ reason: 'app-quit', checkClients: true });
      } catch {
        /* ignore */
      }
    } else {
      // 保持 Runtime 运行：解除父进程引用，避免被回收
      try {
        child.unref();
      } catch {
        /* ignore */
      }
      if (logger) logger.info('runtime', '应用退出：保留 Runtime 运行（closeRuntimeOnExit=false）');
    }
  }

  function getStatus() {
    return { ...status, checkedAt: nowIso() };
  }

  function getLogTail(limit = 100) {
    return logRing.slice(-limit);
  }

  return {
    start,
    stop,
    restart,
    checkHealth,
    getStatus,
    getLogTail,
    probeHealth,
    probeClients,
    shutdownForQuit,
    refreshSettings: () => {
      tokenCache = { mtimeMs: -1, token: null };
      status = makeStatus();
      return status;
    },
    onStatus(handler) {
      emitter.on('status', handler);
      return () => emitter.off('status', handler);
    },
    get tokenPath() {
      return tokenPath();
    },
    dispose() {
      disposed = true;
      stopMonitor();
    },
  };
}

module.exports = { createRuntimeManager, HEALTH_TIMEOUT_MS, START_TIMEOUT_MS };
