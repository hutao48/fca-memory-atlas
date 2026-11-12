'use strict';

/**
 * FCA Desktop — IPC 注册
 * renderer ⇄ 主进程的全部通道。所有输入都做基本校验，不返回 token 内容。
 */

const fs = require('node:fs');
const path = require('node:path');
const { ipcMain, dialog, shell, BrowserWindow, app } = require('electron');
const paths = require('./paths');
const { createNetClient } = require('./net-client');

const CLIENT_VERSION = paths.PRODUCT_VERSION;
const ALLOWED_OPEN_KINDS = new Set(['data', 'logs', 'backups', 'db', 'runtime', 'config']);
const EXTERNAL_URL_RE = /^https:\/\/[^\s]+$/i;
const MAX_LOG_MESSAGE = 8000;

function isSafePathInside(target, base) {
  try {
    const resolved = path.resolve(target);
    const resolvedBase = path.resolve(base);
    return resolved === resolvedBase || resolved.startsWith(`${resolvedBase}${path.sep}`);
  } catch {
    return false;
  }
}

function registerIpc(options) {
  const { settingsStore, runtimeManager, logger, getWindow } = options;
  let streamHandle = null;
  let streamWindowId = null;

  const net = createNetClient({
    logger,
    getBaseUrl: () => {
      const settings = settingsStore.get();
      return settings.runtimeUrl || paths.runtimeUrl(settings.port);
    },
    getToken: () => {
      const settings = settingsStore.get();
      return net.readTokenFile(paths.tokenPath(settings.dataDir));
    },
    clientKind: 'desktop',
    clientVersion: CLIENT_VERSION,
  });

  function focusedWindow() {
    return BrowserWindow.getFocusedWindow() || getWindow() || null;
  }

  function broadcast(channel, payload) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send(channel, payload);
        } catch {
          /* ignore */
        }
      }
    }
  }

  function wireRuntimeEvents() {
    runtimeManager.onStatus((status) => broadcast('fca:runtime:status', status));
    runtimeManager.onStatus((status) => {
      // 数据目录/端口变化后同步设置视图
      if (logger && status.state === 'error' && status.lastError) {
        logger.warn('runtime', 'Runtime 错误状态', status.lastError);
      }
    });
  }
  wireRuntimeEvents();

  // ------------------------------------------------------------------ app
  ipcMain.handle('fca:app:info', () => {
    const settings = settingsStore.get();
    const runtimeStatus = runtimeManager.getStatus();
    const entry = paths.resolveRuntimeEntry(settings);
    const nodeBin = paths.resolveNodeBin(settings);
    const info = {
      productName: paths.PRODUCT_NAME,
      productVersion: paths.PRODUCT_VERSION,
      apiVersion: paths.FCA_API_VERSION,
      bridgeVersion: '1.0',
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      projectRoot: paths.PROJECT_ROOT,
      dataDir: settings.dataDir,
      settingsFile: settingsStore.filePath(),
      logDir: paths.logsDir(settings.dataDir),
      dbPath: paths.dbPath(settings.dataDir),
      tokenPath: paths.tokenPath(settings.dataDir),
      tokenAvailable: fs.existsSync(paths.tokenPath(settings.dataDir)),
      runtimeUrl: settingsStore.effectiveRuntimeUrl(),
      runtimeEntry: entry ? { entry: entry.entry, source: entry.source } : null,
      nodeBin: nodeBin ? { path: nodeBin.path, source: nodeBin.source } : null,
      runtime: runtimeStatus,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        v8: process.versions.v8,
      },
      paths: {
        data: settings.dataDir,
        logs: paths.logsDir(settings.dataDir),
        backups: paths.backupsDir(settings.dataDir),
        db: paths.dbPath(settings.dataDir),
        runtime: entry ? entry.root : null,
        config: path.join(settings.dataDir, 'config'),
      },
    };
    return info;
  });

  ipcMain.handle('fca:app:settings:get', () => settingsStore.get());

  ipcMain.handle('fca:app:settings:save', async (_event, patch) => {
    const result = await settingsStore.update(patch || {});
    if (!result.ok) return result;
    const settings = result.settings;
    logger.setLogDir(paths.logsDir(settings.dataDir));
    runtimeManager.refreshSettings();
    broadcast('fca:settings:changed', { settings, patch: patch || {} });
    return { ok: true, settings };
  });

  ipcMain.handle('fca:app:log', (_event, payload) => {
    const { level = 'info', scope = 'renderer', message = '', meta } = payload || {};
    const safeMessage = String(message).slice(0, MAX_LOG_MESSAGE);
    const fn = level === 'error' ? logger.error : level === 'warn' ? logger.warn : level === 'debug' ? logger.debug : logger.info;
    fn(`renderer:${scope}`, safeMessage, meta);
    return { ok: true };
  });

  ipcMain.handle('fca:app:relaunch', () => {
    app.relaunch();
    app.quit();
    return { ok: true };
  });

  ipcMain.handle('fca:app:quit', () => {
    app.quit();
    return { ok: true };
  });

  ipcMain.handle('fca:app:open-path', async (_event, kind) => {
    const settings = settingsStore.get();
    let target = null;
    if (!ALLOWED_OPEN_KINDS.has(kind)) return { ok: false, error: `不支持的目录类型：${kind}` };
    if (kind === 'data') target = settings.dataDir;
    else if (kind === 'logs') target = paths.logsDir(settings.dataDir);
    else if (kind === 'backups') target = paths.backupsDir(settings.dataDir);
    else if (kind === 'db') target = path.dirname(paths.dbPath(settings.dataDir));
    else if (kind === 'config') target = path.join(settings.dataDir, 'config');
    else if (kind === 'runtime') {
      const entry = paths.resolveRuntimeEntry(settings);
      target = entry ? entry.root : null;
    }
    if (!target) return { ok: false, error: '目录不存在或未找到' };
    try {
      fs.mkdirSync(target, { recursive: true });
    } catch {
      /* ignore */
    }
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true, path: target };
  });

  ipcMain.handle('fca:app:show-item', (_event, targetPath) => {
    if (typeof targetPath !== 'string' || !targetPath) return { ok: false, error: '路径无效' };
    const settings = settingsStore.get();
    const allowed = [settings.dataDir, paths.PROJECT_ROOT];
    if (!allowed.some((base) => isSafePathInside(targetPath, base))) return { ok: false, error: '路径不在允许范围内' };
    shell.showItemInFolder(targetPath);
    return { ok: true };
  });

  ipcMain.handle('fca:app:open-external', async (_event, url) => {
    if (typeof url !== 'string' || !EXTERNAL_URL_RE.test(url)) return { ok: false, error: '仅允许打开 https 链接' };
    await shell.openExternal(url);
    return { ok: true };
  });

  // -------------------------------------------------------------- runtime
  ipcMain.handle('fca:runtime:status', () => runtimeManager.getStatus());

  ipcMain.handle('fca:runtime:start', async (_event, startOptions) => {
    try {
      const result = await runtimeManager.start(startOptions || {});
      return { ok: !result.error, status: result.status, error: result.error || null };
    } catch (error) {
      logger.error('ipc', 'Runtime 启动异常', { message: error.message });
      return { ok: false, status: runtimeManager.getStatus(), error: { code: 'START_FAILED', message: error.message } };
    }
  });

  ipcMain.handle('fca:runtime:stop', async (_event, stopOptions) => {
    try {
      const status = await runtimeManager.stop({ reason: 'user', ...(stopOptions || {}) });
      return { ok: true, status };
    } catch (error) {
      return { ok: false, status: runtimeManager.getStatus(), error: { code: 'STOP_FAILED', message: error.message } };
    }
  });

  ipcMain.handle('fca:runtime:restart', async () => {
    try {
      const result = await runtimeManager.restart();
      return { ok: !result.error, status: result.status, error: result.error || null };
    } catch (error) {
      return { ok: false, status: runtimeManager.getStatus(), error: { code: 'RESTART_FAILED', message: error.message } };
    }
  });

  ipcMain.handle('fca:runtime:health', async () => {
    const result = await runtimeManager.checkHealth();
    return { ok: result.ok, health: result.health || null, error: result.error || null, status: runtimeManager.getStatus() };
  });

  ipcMain.handle('fca:runtime:log-tail', (_event, payload) => {
    const limit = Math.min(500, Math.max(1, Number(payload && payload.limit) || 100));
    return { entries: runtimeManager.getLogTail(limit) };
  });

  // ------------------------------------------------------------------ net
  ipcMain.handle('fca:net:request', async (_event, payload = {}) => {
    const req = payload || {};
    const allowedMethods = new Set(['GET', 'POST', 'PATCH', 'DELETE', 'PUT']);
    const method = String(req.method || 'GET').toUpperCase();
    if (!allowedMethods.has(method)) return { ok: false, status: 0, error: { code: 'BAD_REQUEST', message: `不支持的 HTTP 方法：${method}` } };
    if (typeof req.path !== 'string' || !req.path.startsWith('/')) {
      return { ok: false, status: 0, error: { code: 'BAD_REQUEST', message: '请求路径必须以 / 开头' } };
    }
    // 只允许访问 Runtime 自身路径，防止 renderer 利用该通道访问任意站点
    if (req.path.startsWith('http://') || req.path.startsWith('https://') || req.path.includes('..')) {
      return { ok: false, status: 0, error: { code: 'BAD_REQUEST', message: '非法请求路径' } };
    }
    const startedAt = Date.now();
    const res = await net.request({
      method,
      path: req.path,
      query: req.query,
      body: req.body,
      headers: req.headers,
      timeoutMs: req.timeoutMs,
      noAuth: Boolean(req.noAuth),
    });
    try {
      logger.debug('ipc:net', `${method} ${req.path} → ${res.status || res.error?.code}`, {
        traceId: res.traceId,
        durationMs: Date.now() - startedAt,
        ok: res.ok,
      });
    } catch {
      /* ignore */
    }
    // headers 里不返回 set-cookie 等敏感项
    const headers = {};
    for (const [key, value] of Object.entries(res.headers || {})) {
      const lower = key.toLowerCase();
      if (lower === 'set-cookie' || lower === 'authorization') continue;
      headers[lower] = value;
    }
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers,
      body: res.body,
      traceId: res.traceId,
      durationMs: res.durationMs,
      error: res.error || null,
    };
  });

  async function stopStream() {
    if (streamHandle) {
      try {
        streamHandle.close();
      } catch {
        /* ignore */
      }
      streamHandle = null;
      streamWindowId = null;
    }
    return { ok: true };
  }

  ipcMain.handle('fca:net:stream:start', async (event, streamOptions = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false, error: { code: 'NO_WINDOW', message: '窗口不存在' } };
    await stopStream();
    streamWindowId = win.id;
    const options = streamOptions || {};
    const streamPath = typeof options.path === 'string' && options.path.startsWith('/api/v1/') ? options.path : '/api/v1/events/stream';
    const send = (payload) => {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send('fca:net:stream:event', payload);
        } catch {
          /* ignore */
        }
      }
    };
    streamHandle = net.openStream({
      path: streamPath,
      lastEventId: options.lastEventId || null,
      onStatus: (status) => {
        send({ kind: 'status', ...status });
        if (status.state === 'error' && logger) logger.warn('sse', 'SSE 连接错误', { error: status.error && status.error.message });
      },
      onEvent: (frame) => send({ kind: 'event', ...frame }),
      onHeartbeat: (beat) => send({ kind: 'heartbeat', ...beat }),
    });
    return { ok: true, url: streamHandle.url };
  });

  ipcMain.handle('fca:net:stream:stop', async () => stopStream());

  // --------------------------------------------------------------- dialogs
  ipcMain.handle('fca:dialog:select-directory', async (_event, dlgOptions = {}) => {
    const win = focusedWindow();
    const result = await dialog.showOpenDialog(win, {
      title: dlgOptions.title || '选择目录',
      defaultPath: dlgOptions.defaultPath || settingsStore.get().dataDir,
      properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'],
      buttonLabel: dlgOptions.buttonLabel || '选择',
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true, path: null };
    return { ok: true, canceled: false, path: result.filePaths[0] };
  });

  ipcMain.handle('fca:dialog:open-file', async (_event, dlgOptions = {}) => {
    const win = focusedWindow();
    const result = await dialog.showOpenDialog(win, {
      title: dlgOptions.title || '打开文件',
      defaultPath: dlgOptions.defaultPath || settingsStore.get().dataDir,
      filters: Array.isArray(dlgOptions.filters) ? dlgOptions.filters : undefined,
      properties: dlgOptions.multi ? ['openFile', 'multiSelections'] : ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true, paths: [] };
    return { ok: true, canceled: false, paths: result.filePaths };
  });

  ipcMain.handle('fca:dialog:save-file', async (_event, dlgOptions = {}) => {
    const win = focusedWindow();
    const result = await dialog.showSaveDialog(win, {
      title: dlgOptions.title || '保存文件',
      defaultPath: dlgOptions.defaultPath || path.join(settingsStore.get().dataDir, 'fca-export.json'),
      filters: Array.isArray(dlgOptions.filters) ? dlgOptions.filters : undefined,
      buttonLabel: dlgOptions.buttonLabel || '保存',
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true, path: null };
    return { ok: true, canceled: false, path: result.filePath };
  });

  ipcMain.handle('fca:dialog:message-box', async (_event, dlgOptions = {}) => {
    const win = focusedWindow();
    const result = await dialog.showMessageBox(win, {
      type: dlgOptions.type || 'info',
      title: dlgOptions.title || paths.PRODUCT_NAME,
      message: String(dlgOptions.message || ''),
      detail: dlgOptions.detail ? String(dlgOptions.detail) : undefined,
      buttons: Array.isArray(dlgOptions.buttons) && dlgOptions.buttons.length ? dlgOptions.buttons.map(String) : ['确定'],
      defaultId: Number.isInteger(dlgOptions.defaultId) ? dlgOptions.defaultId : 0,
      cancelId: Number.isInteger(dlgOptions.cancelId) ? dlgOptions.cancelId : 0,
      noLink: true,
    });
    return { ok: true, response: result.response, checkboxChecked: result.checkboxChecked };
  });

  ipcMain.handle('fca:dialog:confirm', async (_event, dlgOptions = {}) => {
    const win = focusedWindow();
    const result = await dialog.showMessageBox(win, {
      type: dlgOptions.danger ? 'warning' : 'question',
      title: dlgOptions.title || '请确认',
      message: String(dlgOptions.message || '确认执行该操作？'),
      detail: dlgOptions.detail ? String(dlgOptions.detail) : undefined,
      buttons: [String(dlgOptions.cancelLabel || '取消'), String(dlgOptions.confirmLabel || '确认')],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    return { ok: true, confirmed: result.response === 1 };
  });

  // ---------------------------------------------------------------- window
  ipcMain.handle('fca:window:minimize', () => {
    const win = focusedWindow();
    if (win) win.minimize();
    return { ok: true };
  });

  ipcMain.handle('fca:window:toggle-maximize', () => {
    const win = focusedWindow();
    if (!win) return { ok: false };
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return { ok: true, maximized: win.isMaximized() };
  });

  ipcMain.handle('fca:window:close', () => {
    const win = focusedWindow();
    if (win) win.close();
    return { ok: true };
  });

  ipcMain.handle('fca:window:is-maximized', () => {
    const win = focusedWindow();
    return { ok: true, maximized: Boolean(win && win.isMaximized()) };
  });

  function dispose() {
    if (streamHandle) {
      try {
        streamHandle.close();
      } catch {
        /* ignore */
      }
      streamHandle = null;
    }
    const channels = [
      'fca:app:info', 'fca:app:settings:get', 'fca:app:settings:save', 'fca:app:log', 'fca:app:relaunch',
      'fca:app:quit', 'fca:app:open-path', 'fca:app:show-item', 'fca:app:open-external',
      'fca:runtime:status', 'fca:runtime:start', 'fca:runtime:stop', 'fca:runtime:restart',
      'fca:runtime:health', 'fca:runtime:log-tail',
      'fca:net:request', 'fca:net:stream:start', 'fca:net:stream:stop',
      'fca:dialog:select-directory', 'fca:dialog:open-file', 'fca:dialog:save-file',
      'fca:dialog:message-box', 'fca:dialog:confirm',
      'fca:window:minimize', 'fca:window:toggle-maximize', 'fca:window:close', 'fca:window:is-maximized',
    ];
    for (const channel of channels) ipcMain.removeHandler(channel);
  }

  return { dispose, net, stopStream, broadcast };
}

module.exports = { registerIpc };
