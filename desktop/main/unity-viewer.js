'use strict';

/**
 * FCA Desktop — Unity 星云渲染器集成（主进程模块）
 *
 * 职责：
 *  1. 解析 Unity standalone 可执行文件路径：
 *       打包版：<InstallDir>\unity\FCANebula\FCANebula.exe
 *       开发版：<repo>\artifacts\unity\FCANebula\FCANebula.exe
 *     可用环境变量 FCA_UNITY_EXE 覆盖（联调/自定义安装位置用）。
 *  2. 用 child_process.spawn 拉起 Unity 进程（独立窗口），传入与 unity-renderer 约定的参数：
 *       --runtime-url=<url> --token-file=<path> --fca-home=<dir> --quality=<quality>
 *     另外用 Unity Player 自带的 -screen-width/-screen-height/-screen-fullscreen 0 让窗口
 *     尺寸匹配主窗口内容区（窗口位置由 Windows 决定，Electron 侧在 atlas 状态卡中明确提示
 *     “星云在独立窗口显示”）。
 *  3. 捕获 stdout/stderr（含 `-logFile -` 的 Player 日志）写入 desktop 日志（scope=unity），
 *     维护最近日志环形缓冲；解析 `[FCA] 图更新: nodes=… edges=… arms=…` 得到运行统计。
 *  4. 生命周期：Electron 退出时关闭 Unity 进程；Unity 正常关闭 / 崩溃（非零退出）都广播状态，
 *     renderer 据此回退 WebGL 星云，不阻塞其它功能。
 *  5. 状态机：idle → starting → running → ready → (closed | crashed)。
 *
 * 安全：不把 token 内容写日志/状态；只传 token 文件路径（引擎自己读取）。
 * 依赖：仅 node 内置模块 + electron（通过传入的 getWindow 回调，避免直接依赖 electron 实例）。
 */

const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const paths = require('./paths');

const UNITY_LOG_MAX_LINES = 400;
const CLOSE_TIMEOUT_MS = 4000;
const START_TIMEOUT_MS = 20000;

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function nowIso() {
  return new Date().toISOString();
}

/** Unity Player 默认日志文件（诊断兜底；company/product 来自 ProjectSettings.asset） */
function defaultPlayerLogPath() {
  const home = process.env.USERPROFILE || '';
  if (!home) return null;
  return path.join(home, 'AppData', 'LocalLow', 'FCA', 'FCA Nebula', 'Player.log');
}

function readTailLines(filePath, maxLines) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return [];
    // 只读末尾最多 128KB，避免 Player.log 很大时阻塞主进程
    const maxBytes = Math.min(stat.size, 128 * 1024);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      fs.readSync(fd, buffer, 0, maxBytes, Math.max(0, stat.size - maxBytes));
      const text = buffer.toString('utf8');
      const lines = text.split(/\r?\n/);
      return lines.slice(-maxLines).filter((line) => line.length > 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

/**
 * 解析 Unity exe 路径（按优先级返回所有候选，便于状态卡展示搜索过程）。
 * @param {object} settings desktop settings（含 dataDir/quality/nebulaEngine 等）
 * @returns {{exePath:string|null, source:string|null, packaged:boolean, searched:Array<{path:string,source:string,exists:boolean}>}}
 */
function resolveUnityExecutable(settings = {}) {
  const candidates = [];
  const push = (exePath, source) => {
    if (!exePath) return;
    const resolved = path.resolve(String(exePath));
    if (candidates.some((c) => c.path === resolved)) return;
    candidates.push({ path: resolved, source });
  };

  // 0) 测试/验收用：显式禁用 Unity（模拟“exe 缺失→WebGL 回退”，无需移动构建产物）
  //    仅用于自动化验证回退路径；正常用户环境不会设置该变量。
  if (process.env.FCA_UNITY_DISABLE === '1') {
    return {
      exePath: null,
      source: null,
      packaged: Boolean(paths.installDir()),
      disabledByEnv: true,
      searched: [{ path: '(FCA_UNITY_DISABLE=1：已禁用 Unity 渲染器)', source: 'env:FCA_UNITY_DISABLE', exists: false }],
    };
  }

  // 1) 显式覆盖（联调 / 自定义安装位置）
  if (process.env.FCA_UNITY_EXE) push(process.env.FCA_UNITY_EXE, 'env:FCA_UNITY_EXE');
  if (settings.unityExePath) push(settings.unityExePath, 'settings.unityExePath');

  // 2) 打包版：<InstallDir>\unity\FCANebula\FCANebula.exe
  const install = paths.installDir();
  if (install) {
    push(path.join(install, 'unity', 'FCANebula', 'FCANebula.exe'), 'install-dir:unity/FCANebula');
    push(path.join(install, 'FCANebula', 'FCANebula.exe'), 'install-dir:FCANebula');
  }

  // 3) 开发版：<repo>\artifacts\unity\FCANebula\FCANebula.exe（与 unity-renderer 的固定输出契约）
  push(path.join(paths.PROJECT_ROOT, 'artifacts', 'unity', 'FCANebula', 'FCANebula.exe'), 'dev:artifacts/unity/FCANebula');
  // 容忍 Unity 常规 Build 输出目录（手工构建时），仍以 artifacts 为准
  push(path.join(paths.PROJECT_ROOT, 'unity', 'FCANebula', 'Build', 'FCANebula.exe'), 'dev:unity/FCANebula/Build');
  push(path.join(paths.PROJECT_ROOT, 'unity', 'FCANebula', 'Builds', 'Windows', 'FCANebula.exe'), 'dev:unity/FCANebula/Builds/Windows');

  const searched = candidates.map((candidate) => ({ ...candidate, exists: isFile(candidate.path) }));
  const found = searched.find((item) => item.exists) || null;
  return {
    exePath: found ? found.path : null,
    source: found ? found.source : null,
    packaged: Boolean(install),
    searched,
  };
}

/** 快速探活 Runtime /health（免认证）；超时/失败不算致命错误（Unity 自己会重试）。 */
function probeRuntime(runtimeUrl, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let target;
    try {
      target = new URL('/health', runtimeUrl);
    } catch (error) {
      finish({ ok: false, error: `Runtime 地址无效：${error.message}` });
      return;
    }
    const req = http.get(target, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => {
        if (chunks.length < 8) chunks.push(chunk);
      });
      res.on('end', () => {
        finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, error: 'Runtime 健康检查超时' });
    });
    req.on('error', (error) => finish({ ok: false, error: error.message }));
  });
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 创建 Unity 星云进程管理器。
 * @param {object} options
 * @param {object} options.logger  createLogger 实例
 * @param {object} options.settings settingsStore 实例
 * @param {() => (BrowserWindow|null)} [options.getWindow] 主窗口（用于推导伴随窗口尺寸）
 */
function createUnityViewer(options = {}) {
  const logger = options.logger || console;
  const settingsStore = options.settings;
  const getWindow = options.getWindow || (() => null);
  const emitter = new EventEmitter();
  const unityLog = logger.child ? logger.child('unity') : logger;

  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;
  let state = 'idle'; // idle | starting | running | ready | closed | crashed
  let startedAt = null;
  let lastExit = null;
  let lastError = null;
  let expectedClose = false;
  let openPromise = null;
  let closePromise = null;
  let stats = null;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let logRing = [];
  let readySeen = false;
  let screenshotDir = path.join(paths.PROJECT_ROOT, 'artifacts', 'unity');

  function settings() {
    return settingsStore ? settingsStore.get() : {};
  }

  function currentRuntimeUrl() {
    if (settingsStore && typeof settingsStore.effectiveRuntimeUrl === 'function') return settingsStore.effectiveRuntimeUrl();
    return paths.runtimeUrl(paths.DEFAULT_PORT);
  }

  function currentDataDir() {
    const s = settings();
    return s.dataDir || paths.defaultDataDir();
  }

  function currentTokenPath() {
    return paths.tokenPath(currentDataDir());
  }

  function pushLogLine(stream, line) {
    const trimmed = String(line || '').replace(/\0/g, '').trimEnd();
    if (!trimmed) return;
    const entry = { at: nowIso(), stream, line: trimmed.slice(0, 4000) };
    logRing.push(entry);
    if (logRing.length > UNITY_LOG_MAX_LINES) logRing.splice(0, logRing.length - UNITY_LOG_MAX_LINES);
    if (stream === 'stderr') unityLog.warn('player:stderr', entry.line);
    else unityLog.info('player', entry.line);
    // 解析真实数据连接的运行期证据（不伪造：来自 Unity 自己打出的运行时日志）
    const graphMatch = /图更新: nodes=(\d+) edges=(\d+) arms=(\d+)/.exec(trimmed);
    if (graphMatch) {
      stats = {
        nodes: Number(graphMatch[1]),
        edges: Number(graphMatch[2]),
        arms: Number(graphMatch[3]),
        updatedAt: nowIso(),
      };
      if (state === 'running') setState('ready', { message: 'Unity 已连接 Runtime 并渲染真实数据' });
      else emitStatus();
    }
    if (!readySeen && /NebulaApp ready|已连接 Runtime/.test(trimmed)) {
      readySeen = true;
      if (state === 'running' || state === 'starting') setState('ready', { message: 'Unity 星云渲染器已就绪' });
    }
    if (/^\[FCA\].*(失败|错误|Exception|Error)/i.test(trimmed)) {
      lastError = { code: 'UNITY_RUNTIME_WARNING', message: trimmed.slice(0, 500) };
      emitStatus();
    }
  }

  function consumeStream(stream, chunk) {
    const isStdout = stream === 'stdout';
    let buffer = (isStdout ? stdoutBuffer : stderrBuffer) + chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    if (isStdout) stdoutBuffer = buffer;
    else stderrBuffer = buffer;
    for (const line of lines) pushLogLine(stream, line);
  }

  function flushBuffers() {
    if (stdoutBuffer.trim()) {
      pushLogLine('stdout', stdoutBuffer);
      stdoutBuffer = '';
    }
    if (stderrBuffer.trim()) {
      pushLogLine('stderr', stderrBuffer);
      stderrBuffer = '';
    }
  }

  function makeStatus(extra = {}) {
    const resolved = resolveUnityExecutable(settings());
    const s = settings();
    const requestedEngine = s.nebulaEngine || 'unity';
    const running = Boolean(child && child.pid && !child.killed && state !== 'closed' && state !== 'crashed');
    const effectiveEngine = requestedEngine === 'unity' && resolved.exePath ? 'unity' : 'webgl';
    const playerLog = defaultPlayerLogPath();
    return {
      available: Boolean(resolved.exePath),
      state,
      running,
      engine: effectiveEngine,
      requestedEngine,
      exePath: resolved.exePath,
      exeSource: resolved.source,
      packaged: resolved.packaged,
      searched: resolved.searched,
      pid: running && child && child.pid ? child.pid : null,
      startedAt,
      quality: s.quality || 'high',
      runtimeUrl: currentRuntimeUrl(),
      dataDir: currentDataDir(),
      tokenFile: currentTokenPath(),
      tokenAvailable: isFile(currentTokenPath()),
      stats,
      lastExit,
      lastError: extra.lastError !== undefined ? extra.lastError : lastError,
      message: extra.message || statusMessage(),
      playerLogPath: playerLog,
      logTail: logRing.slice(-80),
      screenshotDir: fs.existsSync(screenshotDir) ? screenshotDir : null,
      checkedAt: nowIso(),
    };
  }

  function statusMessage() {
    switch (state) {
      case 'starting':
        return 'Unity 星云正在启动…';
      case 'running':
        return 'Unity 星云窗口已打开，正在连接本地 Runtime…';
      case 'ready':
        return 'Unity 星云运行中（独立窗口）';
      case 'crashed':
        return lastExit && lastExit.code !== null ? `Unity 星云异常退出（code=${lastExit.code}）` : 'Unity 星云异常退出';
      case 'closed':
        return 'Unity 星云已关闭，已回退 WebGL 星云';
      default:
        return 'Unity 星云未启动';
    }
  }

  function emitStatus() {
    try {
      emitter.emit('status', makeStatus());
    } catch (error) {
      unityLog.warn('广播状态失败', { message: error.message });
    }
  }

  function setState(next, extra = {}) {
    const prev = state;
    state = next;
    if (next === 'crashed' || next === 'closed') {
      startedAt = null;
      stats = null;
    }
    if (prev !== next) {
      unityLog.info(`状态 ${prev} → ${next}`, {
        pid: child && child.pid ? child.pid : null,
        lastExit,
        message: extra.message || null,
      });
    }
    if (extra.lastError !== undefined) lastError = extra.lastError;
    emitStatus();
  }

  function buildArgs(bounds, openOptions = {}) {
    const s = settings();
    const args = [
      `--runtime-url=${currentRuntimeUrl()}`,
      `--token-file=${currentTokenPath()}`,
      `--fca-home=${currentDataDir()}`,
      `--quality=${s.quality || 'high'}`,
      `--poll=${Number(openOptions.pollSeconds) > 0 ? Number(openOptions.pollSeconds) : 2}`,
      // Unity Player 内置参数：固定窗口化 + 匹配主窗口内容区尺寸（独立窗口，位置由系统决定）
      '-screen-width',
      String(bounds.width),
      '-screen-height',
      String(bounds.height),
      '-screen-fullscreen',
      '0',
      // Player 日志输出到 stdout，便于主进程落盘（Unity 官方支持 -logFile -）
      '-logFile',
      '-',
    ];
    // 自动化验收/联调用：透传截图模式参数（Unity 截图完成后会自行退出）
    if (openOptions.screenshotCount) {
      const dir = path.resolve(openOptions.screenshotDir || screenshotDir);
      args.push(`--screenshot-dir=${dir}`, `--screenshot-count=${clampInt(openOptions.screenshotCount, 1, 3, 1)}`);
      if (Number(openOptions.screenshotDelay) > 0) args.push(`--screenshot-delay=${Number(openOptions.screenshotDelay)}`);
      if (openOptions.labels !== undefined) args.push(`--labels=${openOptions.labels ? '1' : '0'}`);
    }
    return args;
  }

  function companionBounds() {
    let width = 1600;
    let height = 1000;
    try {
      const win = getWindow();
      if (win && typeof win.getContentBounds === 'function') {
        const bounds = win.getContentBounds();
        width = clampInt(bounds.width, 1024, 2560, 1600);
        height = clampInt(bounds.height, 640, 1440, 1000);
      }
    } catch {
      /* 使用默认尺寸 */
    }
    return { width, height };
  }

  function attachChild(nextChild) {
    child = nextChild;
    child.stdout.on('data', (chunk) => consumeStream('stdout', chunk));
    child.stderr.on('data', (chunk) => consumeStream('stderr', chunk));

    child.on('spawn', () => {
      startedAt = nowIso();
      lastError = null;
      lastExit = null;
      readySeen = false;
      stats = null;
      setState('starting');
      setState('running', { message: 'Unity 星云窗口已打开，正在连接本地 Runtime…' });
    });

    child.on('error', (error) => {
      flushBuffers();
      lastError = { code: 'UNITY_SPAWN_FAILED', message: error && error.message ? error.message : String(error) };
      unityLog.error('Unity 进程启动失败', { message: lastError.message });
      setState('crashed');
    });

    child.on('exit', (code, signal) => {
      flushBuffers();
      const wasExpected = expectedClose;
      const pid = child && child.pid ? child.pid : null;
      const previous = state;
      child = null;
      expectedClose = false;
      startedAt = null;
      lastExit = { code: Number.isInteger(code) ? code : null, signal: signal || null, at: nowIso(), expected: wasExpected, pid };
      if (wasExpected) {
        unityLog.info('Unity 星云已关闭（用户/应用请求）', lastExit);
        lastError = null;
        setState('closed');
        return;
      }
      if (code === 0) {
        unityLog.info('Unity 星云正常退出（窗口关闭）', lastExit);
        lastError = null;
        setState('closed');
        return;
      }
      lastError = { code: 'UNITY_EXITED', message: `Unity 星云异常退出（code=${code === null ? signal || 'unknown' : code}）` };
      unityLog.error('Unity 星云异常退出', lastExit);
      setState('crashed');
      try {
        emitter.emit('crash', makeStatus());
      } catch {
        /* ignore */
      }
      void previous;
    });
  }

  /** 打开 Unity 星云窗口（幂等：已运行时直接返回当前状态）。 */
  async function open(openOptions = {}) {
    if (child && state !== 'closed' && state !== 'crashed') {
      return { ok: true, status: makeStatus(), alreadyRunning: true };
    }
    if (openPromise) return openPromise;
    const resolved = resolveUnityExecutable(settings());
    if (!resolved.exePath) {
      lastError = {
        code: 'UNITY_NOT_FOUND',
        message: '未找到 Unity 渲染器（FCANebula.exe），已使用 WebGL 星云回退；打包版应位于 <InstallDir>\\unity\\FCANebula\\FCANebula.exe，开发版位于 <repo>\\artifacts\\unity\\FCANebula\\FCANebula.exe。',
      };
      unityLog.warn('未找到 Unity 渲染器，保持 WebGL 回退', { searched: resolved.searched });
      state = 'idle';
      lastExit = null;
      return { ok: false, status: makeStatus({ lastError }), error: lastError };
    }

    openPromise = (async () => {
      // 预检：token 文件与 Runtime 健康状态只用于日志/状态提示，不阻塞 Unity 启动
      const tokenPath = currentTokenPath();
      if (!isFile(tokenPath)) {
        unityLog.warn('token 文件尚不存在，Unity 会自行重试读取', { tokenFile: tokenPath });
      }
      const health = await probeRuntime(currentRuntimeUrl());
      if (!health.ok) {
        unityLog.warn('Runtime 健康检查未通过，Unity 将按离线/重试策略处理', { runtimeUrl: currentRuntimeUrl(), error: health.error || `HTTP ${health.status}` });
      }
      if (openOptions.screenshotDir) screenshotDir = path.resolve(openOptions.screenshotDir);

      const bounds = companionBounds();
      const args = buildArgs(bounds, openOptions);
      unityLog.info('启动 Unity 星云渲染器', {
        exe: resolved.exePath,
        source: resolved.source,
        runtimeUrl: currentRuntimeUrl(),
        dataDir: currentDataDir(),
        tokenFile: tokenPath,
        quality: settings().quality || 'high',
        window: `${bounds.width}x${bounds.height}`,
        args: args.filter((arg, index) => {
          // 不记录 token 文件路径？路径本身不敏感（token 内容不在参数里），保留便于排障
          return !(index > 0 && args[index - 1] === '-logFile');
        }),
      });

      let nextChild;
      try {
        nextChild = spawn(resolved.exePath, args, {
          cwd: path.dirname(resolved.exePath),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: false,
          detached: false,
        });
      } catch (error) {
        lastError = { code: 'UNITY_SPAWN_FAILED', message: error.message };
        unityLog.error('Unity 进程创建失败', { message: error.message });
        state = 'crashed';
        emitStatus();
        return { ok: false, status: makeStatus(), error: lastError };
      }
      attachChild(nextChild);

      // 等待 spawn 完成 / 立即失败（默认只等 2.5s，不阻塞 IPC；ready 状态通过事件异步广播）
      const deadline = Date.now() + Math.max(1000, Math.min(START_TIMEOUT_MS, Number(openOptions.startTimeoutMs) || 2500));
      while (Date.now() < deadline) {
        if (state === 'ready' || state === 'crashed' || state === 'closed') break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (state === 'starting' || state === 'running') {
        unityLog.info('Unity 进程已启动（未在超时内确认 ready，将继续后台重试）', { state, hasStats: Boolean(stats) });
      }
      return { ok: state !== 'crashed', status: makeStatus(), error: state === 'crashed' ? lastError : null };
    })();

    try {
      return await openPromise;
    } finally {
      openPromise = null;
    }
  }

  /** 关闭 Unity 星云窗口（幂等）。 */
  async function close(closeOptions = {}) {
    if (!child) {
      if (state !== 'closed' && state !== 'crashed' && state !== 'idle') {
        setState('closed');
      }
      return { ok: true, status: makeStatus(), wasRunning: false };
    }
    if (closePromise) return closePromise;
    closePromise = (async () => {
      expectedClose = true;
      const target = child;
      const pid = target.pid;
      unityLog.info('关闭 Unity 星云进程', { pid, reason: (closeOptions && closeOptions.reason) || 'user' });
      try {
        target.kill();
      } catch (error) {
        unityLog.warn('发送关闭信号失败', { message: error.message });
      }
      const deadline = Date.now() + CLOSE_TIMEOUT_MS;
      while (child && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      if (child && child.pid) {
        unityLog.warn('Unity 未在超时内退出，强制结束进程树', { pid: child.pid });
        try {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        } catch (error) {
          unityLog.warn('taskkill 失败', { message: error.message });
        }
        const forceDeadline = Date.now() + 2000;
        while (child && Date.now() < forceDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      return { ok: true, status: makeStatus(), wasRunning: Boolean(pid) };
    })();
    try {
      return await closePromise;
    } finally {
      closePromise = null;
    }
  }

  /** Electron 退出时调用；不抛错、不阻塞退出流程。 */
  async function dispose() {
    try {
      await close({ reason: 'app-quit' });
    } catch (error) {
      unityLog.warn('退出时关闭 Unity 失败', { message: error.message });
    }
  }

  function getStatus() {
    return makeStatus();
  }

  function getLogTail(limit = 80) {
    const n = clampInt(limit, 1, UNITY_LOG_MAX_LINES, 80);
    const playerLog = defaultPlayerLogPath();
    const playerLines = playerLog ? readTailLines(playerLog, Math.min(40, n)) : [];
    return {
      entries: logRing.slice(-n),
      playerLogPath: playerLog,
      playerLogLines: playerLines,
    };
  }

  function onStatus(handler) {
    if (typeof handler !== 'function') return () => {};
    emitter.on('status', handler);
    return () => emitter.off('status', handler);
  }

  function onCrash(handler) {
    if (typeof handler !== 'function') return () => {};
    emitter.on('crash', handler);
    return () => emitter.off('crash', handler);
  }

  return {
    open,
    close,
    dispose,
    getStatus,
    getLogTail,
    onStatus,
    onCrash,
    resolveExecutable: () => resolveUnityExecutable(settings()),
    // 测试/诊断用
    _internals: { probeRuntime, defaultPlayerLogPath, resolveUnityExecutable },
  };
}

module.exports = {
  createUnityViewer,
  resolveUnityExecutable,
  probeRuntime,
  defaultPlayerLogPath,
  UNITY_LOG_MAX_LINES,
};
