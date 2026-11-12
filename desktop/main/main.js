'use strict';

/**
 * FCA Memory Atlas — Electron 主进程入口
 *
 * 职责：单实例锁、窗口与窗口状态持久化、原生菜单、IPC、Runtime 生命周期管理、
 *       应用日志（脱敏）、崩溃与未捕获异常处理、安全配置（contextIsolation/nodeIntegration/sandbox）。
 *
 * 命令行参数（capture/e2e 用）：
 *   --fca-home=<dir>   覆盖数据目录（仅本次运行，不写盘）
 *   --port=<port>      覆盖 Runtime 端口（仅本次运行，不写盘）
 *   --screenshot=<path>  就绪后截图并退出（E2E/验收用；相对项目根或绝对路径）
 *   --screenshot-wait=<ms> 截图前等待（默认 12000，等待星云/Unity 内嵌加载）
 *
 * 安装版布局假设（Lead 契约）：
 *   <InstallDir>\FCA Memory Atlas.exe
 *   <InstallDir>\resources\app\{main,renderer,package.json}
 *   <InstallDir>\runtime\bin\fca-runtime.js
 *   <InstallDir>\node\node.exe
 * 开发版：process.execPath = electron.exe，项目根 = desktop/main 的上两级。
 */

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, dialog, shell } = require('electron');
const paths = require('./paths');
const { createLogger } = require('./logger');
const { createSettingsStore } = require('./settings');
const { createRuntimeManager } = require('./runtime-manager');
const { createUnityEmbed } = require('./unity-embed');
const { registerIpc } = require('./ipc');
const { createMenu } = require('./menu');
const windowState = require('./window-state');

app.setName(paths.PRODUCT_NAME);

// e2e/测试用参数解析（早于 userData 设置，便于 --user-data-dir 隔离 Chromium profile）
function parseCliArgs(argv) {
  const out = { _: [] };
  for (const raw of argv) {
    if (typeof raw !== 'string') continue;
    const match = /^--([^=]+)(?:=(.*))?$/.exec(raw);
    if (!match) {
      out._.push(raw);
      continue;
    }
    out[match[1]] = match[2] === undefined ? true : match[2];
  }
  return out;
}

const CLI = parseCliArgs(process.argv.slice(1));

// 所有桌面缓存/会话数据都收在 FCA 数据根下，避免污染用户 %APPDATA% 其它位置。
// --user-data-dir=<dir> 可显式覆盖（端到端测试/并行运行用，隔离 localStorage、单实例锁）。
try {
  const userDataDir = CLI['user-data-dir']
    ? path.resolve(String(CLI['user-data-dir']))
    : path.join(paths.productDataDir(), 'desktop');
  fs.mkdirSync(userDataDir, { recursive: true });
  app.setPath('userData', userDataDir);
} catch {
  /* userData 设置失败时使用 Electron 默认值 */
}

// 统一色彩配置，保证截图与 UI 一致
app.commandLine.appendSwitch('force-color-profile', 'srgb');

// --------------------------------------------------------------------------- 初始日志/设置
const bootstrapLogger = createLogger({
  logDir: path.join(paths.productDataDir(), 'logs'),
  appVersion: paths.PRODUCT_VERSION,
  mirrorToConsole: true,
});
// --settings-file 允许 e2e/隔离测试使用独立设置文件（不写用户真实配置）
const settingsStore = createSettingsStore({
  logger: bootstrapLogger,
  filePath: CLI['settings-file'] ? path.resolve(String(CLI['settings-file'])) : undefined,
});
settingsStore.load();

if (CLI['fca-home']) settingsStore.override({ dataDir: String(CLI['fca-home']) });
if (CLI.port) settingsStore.override({ port: Number(CLI.port) });

const bootSettings = settingsStore.get();
bootstrapLogger.setLogDir(paths.logsDir(bootSettings.dataDir));
try {
  paths.ensureDataDirs(bootSettings.dataDir);
} catch (error) {
  bootstrapLogger.error('app', '数据目录创建失败', { message: error.message, dataDir: bootSettings.dataDir });
}

// --------------------------------------------------------------------------- 单实例
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  bootstrapLogger.warn('app', '已有实例在运行，本次启动退出');
  app.quit();
} else {
  bootstrap();
}

function bootstrap() {
  /** @type {BrowserWindow|null} */
  let mainWindow = null;
  let windowTracker = null;
  let ipc = null;
  let runtimeManager = null;
  let unityEmbed = null;
  let unityViewer = null; // 旧版 standalone（仅 FCA_UNITY_STANDALONE=1 开发开关）
  let quitting = false;
  let shutdownDone = false;

  const logger = bootstrapLogger;
  const getWindow = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);

  function focusedWindow() {
    return BrowserWindow.getFocusedWindow() || getWindow();
  }

  function sendMenuCommand(command, payload) {
    const win = focusedWindow();
    if (!win) return;
    try {
      win.webContents.send('fca:menu:command', { command, payload: payload || null });
    } catch (error) {
      logger.error('menu', '菜单命令转发失败', { command, message: error.message });
    }
  }

  function broadcastCrash(payload) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send('fca:app:crash', payload);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // E2E/验收：--screenshot=<path> 在窗口就绪并等待星云（含 Unity WebGL 内嵌）加载后截图并退出
  let screenshotDone = false;
  function maybeCaptureAndExit(win) {
    const target = CLI.screenshot;
    if (!target || screenshotDone) return;
    screenshotDone = true;
    const waitMs = Math.max(0, Number(CLI['screenshot-wait']) || 12000);
    const outPath = path.isAbsolute(String(target)) ? String(target) : path.resolve(paths.PROJECT_ROOT, String(target));
    const timer = setTimeout(async () => {
      try {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        const image = await win.webContents.capturePage();
        const png = image.toPNG();
        fs.writeFileSync(outPath, png);
        logger.info('capture', '窗口截图已保存（E2E）', { path: outPath, bytes: png.length, size: image.getSize() });
      } catch (error) {
        logger.error('capture', '窗口截图失败（E2E）', { message: error.message, path: outPath });
      } finally {
        app.quit();
      }
    }, waitMs);
    if (timer.unref) timer.unref();
  }

  function createMainWindow() {
    const saved = windowState.ensureVisible(windowState.readState());
    const win = new BrowserWindow({
      title: `${paths.PRODUCT_NAME} — Alpha ${paths.PRODUCT_VERSION}`,
      width: saved.width,
      height: saved.height,
      x: Number.isFinite(saved.x) ? saved.x : undefined,
      y: Number.isFinite(saved.y) ? saved.y : undefined,
      minWidth: windowState.MIN_WIDTH,
      minHeight: windowState.MIN_HEIGHT,
      show: false,
      backgroundColor: '#070b12',
      autoHideMenuBar: false,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#0a1019',
        symbolColor: '#93a9bf',
        height: 46,
      },
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false,
        backgroundThrottling: true,
        devTools: true,
      },
    });

    if (saved.maximized) win.maximize();

    const rendererIndex = path.join(paths.appRoot(), 'renderer', 'index.html');
    win.loadFile(rendererIndex).catch((error) => {
      logger.error('window', 'renderer 加载失败', { message: error.message, rendererIndex });
      dialog
        .showMessageBox(win, {
          type: 'error',
          title: '界面加载失败',
          message: '无法加载 FCA Memory Atlas 界面',
          detail: `${error.message}\n\n文件：${rendererIndex}`,
          buttons: ['退出'],
        })
        .catch(() => {});
    });

    // 安全：禁止页面导航到外部、禁止新窗口；外部链接交给系统浏览器（仅 https）
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
      const allowed = url.startsWith('file://');
      if (!allowed) {
        event.preventDefault();
        if (/^https:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
        logger.warn('window', '已阻止页面导航', { url });
      }
    });

    win.once('ready-to-show', () => {
      win.show();
      logger.info('window', '窗口已显示', { bounds: win.getBounds(), maximized: win.isMaximized() });
      maybeCaptureAndExit(win);
    });

    const notifyMaximized = () => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send('fca:window:maximized', { maximized: win.isMaximized() });
      } catch {
        /* ignore */
      }
    };
    win.on('maximize', notifyMaximized);
    win.on('unmaximize', notifyMaximized);

    windowTracker = windowState.createWindowStateTracker(win);

    win.on('close', () => {
      if (windowTracker) windowTracker.saveNow();
    });

    win.webContents.on('render-process-gone', (_event, details) => {
      logger.error('crash', '渲染进程崩溃', details);
      broadcastCrash({ type: 'render-process-gone', message: `界面渲染进程已退出（${details.reason || 'unknown'}）`, details });
      dialog
        .showMessageBox(win, {
          type: 'error',
          title: '界面进程异常退出',
          message: 'FCA Memory Atlas 界面进程已退出',
          detail: `原因：${details.reason || 'unknown'}\n退出码：${details.exitCode ?? '—'}\n\n可重新打开应用；数据保存在本地 Runtime 中，不受影响。`,
          buttons: ['关闭'],
        })
        .catch(() => {});
    });

    win.webContents.on('unresponsive', () => {
      logger.warn('crash', '窗口无响应');
    });

    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      const levelName = typeof level === 'number' ? ['debug', 'info', 'warn', 'error'][level] || 'info' : String(level);
      if (levelName === 'error' || levelName === 'warn') {
        logger[levelName === 'error' ? 'error' : 'warn']('renderer:console', String(message).slice(0, 4000), {
          line,
          source: String(sourceId || '').split(/[\\/]/).pop(),
        });
      }
    });

    win.on('closed', () => {
      if (windowTracker) {
        windowTracker.dispose();
        windowTracker = null;
      }
      mainWindow = null;
      logger.info('window', '窗口已关闭');
      // 主窗口关闭：内嵌 Unity WebGL 静态服务一并关闭（不残留端口/进程）
      if (unityEmbed) {
        unityEmbed.stop({ reason: 'main-window-closed' }).catch((error) => logger.warn('unity-embed', '关闭 Unity WebGL 服务失败', { message: error.message }));
      }
    });

    return win;
  }

  function installCrashHandlers() {
    process.on('uncaughtException', (error) => {
      logger.error('crash', '主进程未捕获异常', { message: error.message, stack: error.stack });
      try {
        const win = focusedWindow();
        if (win) {
          dialog
            .showMessageBox(win, {
              type: 'error',
              title: '应用发生异常',
              message: 'FCA Memory Atlas 遇到未处理的错误',
              detail: `${error.message}\n\n详细信息已写入日志：${logger.filePath || paths.logsDir(bootSettings.dataDir)}`,
              buttons: ['继续运行', '退出应用'],
              defaultId: 0,
              cancelId: 0,
            })
            .then(({ response }) => {
              if (response === 1) app.quit();
            })
            .catch(() => {});
        }
      } catch {
        /* ignore */
      }
    });

    process.on('unhandledRejection', (reason) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      logger.error('crash', '主进程未处理 Promise 拒绝', { message });
    });

    app.on('child-process-gone', (_event, details) => {
      logger.warn('crash', '子进程退出', details);
    });
  }

  function installAppLifecycle() {
    app.on('second-instance', () => {
      const win = getWindow();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        logger.info('app', '第二实例启动：已聚焦现有窗口');
      }
    });

    app.on('activate', () => {
      if (!getWindow()) {
        mainWindow = createMainWindow();
      }
    });

    app.on('window-all-closed', () => {
      logger.info('app', '所有窗口已关闭，准备退出');
      app.quit();
    });

    app.on('before-quit', (event) => {
      if (shutdownDone) return;
      event.preventDefault();
      if (quitting) return;
      quitting = true;
      logger.info('app', '开始退出流程');
      Promise.resolve()
        .then(() => (windowTracker ? windowTracker.saveNow() : undefined))
        .then(() => (unityEmbed ? unityEmbed.dispose() : undefined))
        .then(() => (unityViewer ? unityViewer.dispose() : undefined))
        .then(() => (runtimeManager ? runtimeManager.shutdownForQuit() : undefined))
        .then(() => (ipc ? ipc.dispose() : undefined))
        .then(() => logger.flush())
        .catch((error) => logger.error('app', '退出清理异常', { message: error.message }))
        .finally(() => {
          shutdownDone = true;
          logger.info('app', '退出完成');
          app.exit(0);
        });
    });
  }

  function installMenu() {
    createMenu({
      sendCommand: sendMenuCommand,
      getVersions: () => {
        const settings = settingsStore.get();
        const runtimeStatus = runtimeManager ? runtimeManager.getStatus() : {};
        return {
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node,
          apiVersion: paths.FCA_API_VERSION,
          runtimeVersion: runtimeStatus.version || '未连接',
          dataDir: settings.dataDir,
        };
      },
      onOpenDocs: () => {
        const docsDir = path.join(paths.PROJECT_ROOT, 'docs');
        shell.openPath(fs.existsSync(docsDir) ? docsDir : paths.PROJECT_ROOT).catch(() => {});
      },
      onShowOnboarding: () => sendMenuCommand('app:show-onboarding'),
      onShowRuntimeStatus: () => sendMenuCommand('app:show-runtime-status'),
    });
  }

  app.whenReady().then(async () => {
    installCrashHandlers();
    installAppLifecycle();

    runtimeManager = createRuntimeManager({
      logger,
      settings: settingsStore,
      getWindow,
    });

    // Unity 星云（默认内嵌 WebGL）：本地静态服务 + atlas 视图 iframe；产物缺失/启动失败时 renderer 回退 WebGL
    unityEmbed = createUnityEmbed({
      logger,
      settings: settingsStore,
    });
    // 旧版独立窗口 Unity standalone：仅开发开关启用（Lead 新要求默认内嵌，不再默认启动独立进程）
    if (process.env.FCA_UNITY_STANDALONE === '1') {
      try {
        const { createUnityViewer } = require('./unity-viewer');
        unityViewer = createUnityViewer({ logger, settings: settingsStore, getWindow });
        logger.info('unity', '旧版 standalone Unity 渲染器已启用（FCA_UNITY_STANDALONE=1，仅开发调试）');
      } catch (error) {
        logger.warn('unity', '旧版 standalone Unity 渲染器加载失败（忽略）', { message: error.message });
      }
    }

    ipc = registerIpc({
      settingsStore,
      runtimeManager,
      unityEmbed,
      unityViewer,
      logger,
      getWindow,
    });

    installMenu();
    mainWindow = createMainWindow();

    const unityStatus = unityEmbed ? unityEmbed.getStatus() : unityViewer ? unityViewer.getStatus() : null;
    logger.info('app', '应用已启动', {
      version: paths.PRODUCT_VERSION,
      electron: process.versions.electron,
      node: process.versions.node,
      dataDir: settingsStore.get().dataDir,
      runtimeUrl: settingsStore.effectiveRuntimeUrl(),
      runtimeEntry: (paths.resolveRuntimeEntry(settingsStore.get()) || {}).entry || null,
      nodeBin: (paths.resolveNodeBin(settingsStore.get()) || {}).path || null,
      packaged: paths.isPackagedApp(),
      nebulaEngine: settingsStore.get().nebulaEngine,
      // 注意：不记录含 token 的 frameUrl
      unity: unityStatus
        ? {
            mode: unityStatus.mode || 'standalone',
            available: unityStatus.available,
            dir: unityStatus.dir || null,
            source: unityStatus.source || unityStatus.exeSource || null,
            requestedEngine: unityStatus.requestedEngine,
          }
        : null,
    });

    if (unityStatus && !unityStatus.available) {
      logger.warn('unity', '未找到 Unity WebGL 构建：星云默认回退 WebGL（可设置 FCA_UNITY_WEBGL_DIR 或打包 unity/FCANebulaWebGL；开发路径 artifacts/unity/FCANebulaWebGL）', {
        searched: unityStatus.searched,
      });
    }

    if (settingsStore.get().autoStartRuntime) {
      runtimeManager
        .start({ reason: 'app-start' })
        .then((result) => {
          if (result && result.error) logger.warn('app', '自动启动 Runtime 未成功', result.error);
          else logger.info('app', '自动启动 Runtime 完成');
        })
        .catch((error) => logger.error('app', '自动启动 Runtime 异常', { message: error.message }));
    }

    // 设置变化时同步日志目录 / Runtime 参数
    settingsStore.onChange((settings) => {
      logger.setLogDir(paths.logsDir(settings.dataDir));
      if (runtimeManager) runtimeManager.refreshSettings();
    });
  }).catch((error) => {
    logger.error('app', '应用初始化失败', { message: error.message, stack: error.stack });
    app.exit(1);
  });
}
