'use strict';

/**
 * FCA Desktop — Unity WebGL 内嵌服务（主进程）
 *
 * 目标：把 Unity 星云渲染（WebGL 构建）内嵌到 Electron 的 atlas 视图里（iframe），不再启动独立窗口进程。
 *
 * 职责：
 *  1. 解析 Unity WebGL 构建目录：
 *       打包版：<InstallDir>\unity\FCANebulaWebGL\index.html
 *       开发版：<repo>\artifacts\unity\FCANebulaWebGL\index.html
 *       环境变量 FCA_UNITY_WEBGL_DIR 可覆盖；FCA_UNITY_WEBGL_DISABLE=1 可模拟“产物缺失→WebGL 回退”（自动化验收用）。
 *  2. 在 127.0.0.1 上随机端口起一个**只读静态文件服务**（node:http）：
 *       - 正确 MIME（.wasm → application/wasm、.js、.data、.png…；支持 .gz/.br 压缩产物）
 *       - 防目录穿越；仅 GET/HEAD；无目录列表
 *       - 不记录/不输出 token（token 只出现在返回给 renderer 的 iframe URL 查询串里）
 *  3. 生成 iframe URL：`/index.html?runtime-url=…&token=…&quality=…&poll=2`
 *     与 unity-renderer 约定：Unity WebGL 从 Application.absoluteURL 读取这些参数（WebGL 无法读本地 token 文件）。
 *  4. 状态机：idle → starting → running → stopped | error；track 静态资源请求（index/js/wasm/data）用于渲染层
 *     判断“Unity 资源是否已加载完成”（另有 Unity 侧 postMessage({type:'fca-unity-ready'}) 时优先采用）。
 *  5. Electron 退出 / 主窗口关闭时关闭服务（stop/dispose）。
 *
 * 安全：
 *  - 仅监听 127.0.0.1（不对外），随机端口，每次启动不同；
 *  - 服务只读，拒绝 `..`/绝对路径/编码绕过；不提供目录列表；
 *  - token 不写入日志，仅通过 IPC 交给 renderer 设置 iframe src；status 中的 URL 字段含 token，调用方不得打印。
 */

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const paths = require('./paths');

const LOG_MAX = 200;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.mem': 'application/octet-stream',
  '.unityweb': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.gz': 'application/gzip',
  '.br': 'application/brotli',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

function nowIso() {
  return new Date().toISOString();
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readToken(tokenPath) {
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim();
  } catch {
    return null;
  }
}

/** 解析 Unity WebGL 构建目录（返回候选与命中项） */
function resolveUnityWebglDir(settings = {}) {
  const candidates = [];
  const push = (dir, source) => {
    if (!dir) return;
    const resolved = path.resolve(String(dir));
    if (candidates.some((c) => c.path === resolved)) return;
    candidates.push({ path: resolved, source });
  };

  if (process.env.FCA_UNITY_WEBGL_DISABLE === '1') {
    return {
      dir: null,
      source: null,
      packaged: Boolean(paths.installDir()),
      disabledByEnv: true,
      searched: [{ path: '(FCA_UNITY_WEBGL_DISABLE=1：已禁用 Unity WebGL 内嵌)', source: 'env:FCA_UNITY_WEBGL_DISABLE', exists: false }],
    };
  }

  if (process.env.FCA_UNITY_WEBGL_DIR) push(process.env.FCA_UNITY_WEBGL_DIR, 'env:FCA_UNITY_WEBGL_DIR');
  if (settings.unityWebglDir) push(settings.unityWebglDir, 'settings.unityWebglDir');

  const install = paths.installDir();
  if (install) {
    push(path.join(install, 'unity', 'FCANebulaWebGL'), 'install-dir:unity/FCANebulaWebGL');
    push(path.join(install, 'unity', 'FCANebulaWebGL', 'Build'), 'install-dir:unity/FCANebulaWebGL/Build');
  }
  push(path.join(paths.PROJECT_ROOT, 'artifacts', 'unity', 'FCANebulaWebGL'), 'dev:artifacts/unity/FCANebulaWebGL');
  push(path.join(paths.PROJECT_ROOT, 'unity', 'FCANebula', 'Builds', 'WebGL'), 'dev:unity/FCANebula/Builds/WebGL');

  const searched = candidates.map((candidate) => ({ ...candidate, exists: isFile(path.join(candidate.path, 'index.html')) }));
  const found = searched.find((item) => item.exists) || null;
  return { dir: found ? found.path : null, source: found ? found.source : null, packaged: Boolean(install), searched };
}

function contentTypeFor(filePath) {
  const lower = filePath.toLowerCase();
  // 双扩展名（.data.gz / .wasm.gz / .js.gz / .framework.js.gz）优先按真实内容类型
  if (lower.endsWith('.data.gz') || lower.endsWith('.data.br')) return 'application/octet-stream';
  if (lower.endsWith('.wasm.gz') || lower.endsWith('.wasm.br')) return 'application/wasm';
  if (lower.endsWith('.js.gz') || lower.endsWith('.js.br')) return 'text/javascript; charset=utf-8';
  return MIME_TYPES[path.extname(lower)] || 'application/octet-stream';
}

/** 把 URL path 安全解析为 root 下的文件路径；非法返回 null */
function safeResolve(root, requestPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(String(requestPath || '/').split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (!pathname.startsWith('/')) return null;
  if (pathname === '/') pathname = '/index.html';
  // 统一分隔符、去掉 Windows 盘符/UNC 可能性
  pathname = pathname.replace(/\\/g, '/');
  if (pathname.includes('\0')) return null;
  const parts = pathname.split('/').filter(Boolean);
  if (parts.some((part) => part === '..' || part === '.')) return null;
  const resolved = path.resolve(root, ...parts);
  const rootResolved = path.resolve(root);
  const normalizedRoot = rootResolved.endsWith(path.sep) ? rootResolved : `${rootResolved}${path.sep}`;
  const normalizedFile = resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved;
  if (normalizedFile !== rootResolved && !normalizedFile.toLowerCase().startsWith(normalizedRoot.toLowerCase())) return null;
  return normalizedFile;
}

/**
 * @param {object} options
 * @param {object} options.logger createLogger 实例
 * @param {object} options.settings settingsStore 实例
 */
function createUnityEmbed(options = {}) {
  const logger = options.logger || console;
  const settingsStore = options.settings;
  const emitter = new EventEmitter();
  const scope = logger.child ? logger.child('unity-embed') : logger;

  let state = 'idle';
  let server = null;
  let port = null;
  let webglDir = null;
  let webglSource = null;
  let lastError = null;
  let tokenMissing = false;
  let startedAt = null;
  let stats = newStats();
  let embedUrl = null; // 含 token，仅通过 IPC 返回给 renderer；不得写入日志
  let logRing = [];
  let stopping = null;

  function newStats() {
    return {
      requests: 0,
      index: 0,
      js: 0,
      wasm: 0,
      data: 0,
      bytes: 0,
      assetsLoaded: false,
      assetsLoadedAt: null,
      lastRequestAt: null,
      lastPath: null,
    };
  }

  function settings() {
    return settingsStore ? settingsStore.get() : {};
  }

  function runtimeUrl() {
    if (settingsStore && typeof settingsStore.effectiveRuntimeUrl === 'function') return settingsStore.effectiveRuntimeUrl();
    return paths.runtimeUrl(paths.DEFAULT_PORT);
  }

  function dataDir() {
    const s = settings();
    return s.dataDir || paths.defaultDataDir();
  }

  function tokenPath() {
    return paths.tokenPath(dataDir());
  }

  function pushLog(line) {
    const entry = { at: nowIso(), line: String(line).slice(0, 500) };
    logRing.push(entry);
    if (logRing.length > LOG_MAX) logRing.splice(0, logRing.length - LOG_MAX);
    scope.info(entry.line);
  }

  function makeStatus(extra = {}) {
    const resolved = resolveUnityWebglDir(settings());
    const available = Boolean(resolved.dir);
    return {
      available,
      mode: 'embedded-webgl',
      state,
      running: Boolean(server),
      dir: resolved.dir,
      source: resolved.source,
      packaged: resolved.packaged,
      searched: resolved.searched,
      port: server && server.listening ? port : null,
      // 含 token 的 iframe URL：只通过 IPC 给 renderer，不在日志/全局状态中输出
      frameUrl: anchorReady() ? embedUrl : null,
      runtimeUrl: runtimeUrl(),
      dataDir: dataDir(),
      tokenAvailable: isFile(tokenPath()),
      tokenMissing,
      quality: settings().quality || 'high',
      stats,
      lastError: extra.lastError !== undefined ? extra.lastError : lastError,
      startedAt,
      message: messageFor(extra),
      logTail: logRing.slice(-60),
      checkedAt: nowIso(),
    };
  }

  function anchorReady() {
    return state === 'running' && Boolean(embedUrl);
  }

  function messageFor(extra = {}) {
    if (extra.message) return extra.message;
    switch (state) {
      case 'starting':
        return '正在启动 Unity WebGL 内嵌服务…';
      case 'running':
        return tokenMissing ? 'Unity WebGL 已加载，但 runtime token 尚不存在（Unity 会显示鉴权错误并重试）' : 'Unity WebGL 已内嵌到星云视图';
      case 'stopped':
        return 'Unity WebGL 内嵌服务已关闭';
      case 'error':
        return lastError ? lastError.message : 'Unity WebGL 内嵌失败';
      default:
        return 'Unity WebGL 未启动';
    }
  }

  function emitStatus(extra) {
    try {
      emitter.emit('status', makeStatus(extra));
    } catch (error) {
      scope.warn('广播状态失败', { message: error.message });
    }
  }

  function setState(next, extra = {}) {
    const prev = state;
    state = next;
    if (extra.lastError !== undefined) lastError = extra.lastError;
    if (prev !== next) scope.info(`状态 ${prev} → ${next}`, { port: port || null, dir: webglDir || null });
    emitStatus(extra);
  }

  function ensureToken() {
    const token = readToken(tokenPath());
    tokenMissing = !token;
    if (!token) scope.warn('runtime token 文件不存在或为空，Unity WebGL 将以无 token 启动（会显示鉴权错误）', { tokenFile: tokenPath() });
    return token || '';
  }

  function buildEmbedUrl() {
    const s = settings();
    const search = new URLSearchParams({
      'runtime-url': runtimeUrl(),
      token: ensureToken(),
      quality: s.quality || 'high',
      poll: '2',
    });
    return `http://127.0.0.1:${port}/index.html?${search.toString()}`;
  }

  const ASSET_READY_FILES = (requestPath) => {
    const lower = requestPath.toLowerCase();
    return {
      isIndex: lower === '/index.html' || lower === '/' || lower.endsWith('/index.html'),
      isJs: /\.(js|mjs)(\.gz|\.br)?$/.test(lower) || lower.includes('.framework.js'),
      isWasm: /\.wasm(\.gz|\.br)?$/.test(lower),
      isData: /\.(data|mem|unityweb)(\.gz|\.br)?$/.test(lower),
    };
  };

  function trackRequest(filePath) {
    stats.requests += 1;
    stats.lastRequestAt = nowIso();
    stats.lastPath = path.relative(webglDir || '', filePath) || null;
    const kinds = ASSET_READY_FILES(`/${(stats.lastPath || '').replace(/\\/g, '/')}`);
    if (kinds.isIndex) stats.index += 1;
    if (kinds.isJs) stats.js += 1;
    if (kinds.isWasm) stats.wasm += 1;
    if (kinds.isData) stats.data += 1;
    // 资源加载判定：index + js + (wasm|data) 至少各见一次（Unity 2022 默认 + 压缩产物均适用）
    if (!stats.assetsLoaded && stats.index > 0 && stats.js > 0 && (stats.wasm > 0 || stats.data > 0)) {
      stats.assetsLoaded = true;
      stats.assetsLoadedAt = nowIso();
      scope.info('Unity WebGL 静态资源已加载完成', { index: stats.index, js: stats.js, wasm: stats.wasm, data: stats.data, bytes: stats.bytes });
      emitStatus({ message: 'Unity WebGL 资源加载完成，等待连上 Runtime…' });
    }
  }

  function handleRequest(req, res) {
    const started = Date.now();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }
    if (!webglDir) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Unity WebGL not available');
      return;
    }
    const filePath = safeResolve(webglDir, req.url);
    if (!filePath) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    if (!stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    trackRequest(filePath);
    const headers = {
      'Content-Type': contentTypeFor(filePath),
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.on('error', (error) => {
      scope.warn('静态文件读取失败', { path: stats.lastPath, message: error.message });
      try {
        res.destroy(error);
      } catch {
        /* ignore */
      }
    });
    stream.on('data', (chunk) => {
      stats.bytes += chunk.length;
    });
    stream.pipe(res);
    res.on('finish', () => {
      if (Date.now() - started > 3000) scope.debug('慢请求', { path: stats.lastPath, ms: Date.now() - started });
    });
  }

  async function start() {
    if (server && server.listening) {
      return { ok: true, status: makeStatus(), frameUrl: embedUrl, alreadyRunning: true };
    }
    const resolved = resolveUnityWebglDir(settings());
    if (!resolved.dir) {
      lastError = {
        code: 'UNITY_WEBGL_NOT_FOUND',
        message: '未找到 Unity WebGL 构建（index.html），已使用 WebGL 星云回退（打包版应为 <InstallDir>\\unity\\FCANebulaWebGL，开发版应为 <repo>\\artifacts\\unity\\FCANebulaWebGL）。',
      };
      scope.warn('未找到 Unity WebGL 构建目录，保持 WebGL 回退', { searched: resolved.searched });
      state = 'idle';
      emitStatus();
      return { ok: false, status: makeStatus(), error: lastError };
    }
    if (state === 'starting') return { ok: false, status: makeStatus(), error: { code: 'UNITY_STARTING', message: 'Unity WebGL 正在启动' } };

    state = 'starting';
    webglDir = resolved.dir;
    webglSource = resolved.source;
    lastError = null;
    stats = newStats();
    startedAt = nowIso();
    emitStatus();

    try {
      server = http.createServer((req, res) => {
        try {
          handleRequest(req, res);
        } catch (error) {
          scope.error('静态服务异常', { message: error.message });
          try {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Internal Server Error');
          } catch {
            /* ignore */
          }
        }
      });
      server.keepAliveTimeout = 5000;
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(0, '127.0.0.1');
      });
      const address = server.address();
      port = address && typeof address === 'object' ? address.port : null;
      embedUrl = buildEmbedUrl();
      pushLog(`Unity WebGL 内嵌服务已启动 · dir=${path.basename(path.dirname(webglDir))}/${path.basename(webglDir)} · port=${port} · source=${webglSource} · quality=${settings().quality || 'high'} · token=${tokenMissing ? 'MISSING' : 'ready'}`);
      setState('running');
      scope.info('Unity WebGL 内嵌服务已启动', { port, dir: webglDir, source: webglSource, tokenAvailable: !tokenMissing });
      return { ok: true, status: makeStatus(), frameUrl: embedUrl };
    } catch (error) {
      lastError = { code: 'UNITY_SERVER_FAILED', message: `Unity WebGL 静态服务启动失败：${error.message}` };
      scope.error('Unity WebGL 静态服务启动失败', { message: error.message });
      await destroyServer();
      setState('error');
      return { ok: false, status: makeStatus(), error: lastError };
    }
  }

  async function destroyServer() {
    const target = server;
    server = null;
    port = null;
    embedUrl = null;
    if (!target) return;
    await new Promise((resolve) => {
      try {
        target.close(() => resolve());
      } catch {
        resolve();
      }
      // Unity/浏览器 keep-alive 连接可能让 close() 一直等待：主动断开所有连接
      try {
        target.closeAllConnections?.();
      } catch {
        /* ignore */
      }
      const timer = setTimeout(resolve, 3000);
      if (timer.unref) timer.unref();
    });
  }

  async function stop(options_ = {}) {
    if (stopping) return stopping;
    stopping = (async () => {
      const wasRunning = Boolean(server);
      await destroyServer();
      stats = newStats();
      startedAt = null;
      if (wasRunning) {
        pushLog('Unity WebGL 内嵌服务已关闭');
        setState('stopped');
        scope.info('Unity WebGL 内嵌服务已关闭', { reason: (options_ && options_.reason) || 'user' });
      } else if (state !== 'stopped') {
        setState('stopped');
      }
      return { ok: true, status: makeStatus(), wasRunning };
    })();
    try {
      return await stopping;
    } finally {
      stopping = null;
    }
  }

  async function dispose() {
    try {
      await stop({ reason: 'app-quit' });
    } catch (error) {
      scope.warn('退出时关闭 Unity WebGL 服务失败', { message: error.message });
    }
  }

  function getStatus() {
    return makeStatus();
  }

  function getLogTail(limit = 100) {
    const n = Math.max(1, Math.min(LOG_MAX, Number(limit) || 100));
    return { entries: logRing.slice(-n), dir: webglDir, source: webglSource };
  }

  function onStatus(handler) {
    if (typeof handler !== 'function') return () => {};
    emitter.on('status', handler);
    return () => emitter.off('status', handler);
  }

  return { start, stop, dispose, getStatus, getLogTail, onStatus, resolveWebglDir: () => resolveUnityWebglDir(settings()) };
}

module.exports = { createUnityEmbed, resolveUnityWebglDir, MIME_TYPES, safeResolve, contentTypeFor };
