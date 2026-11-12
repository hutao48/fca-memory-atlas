'use strict';

/**
 * FCA Memory Atlas — 真实运行录屏（Electron 入口，Lead 验收材料用）
 *
 * 用途：加载真实桌面 renderer（真实 Runtime 数据），在页面内用 MediaRecorder 录制
 * WebGL 星云画布的动画，并在录制期间注入真实的缩放/平移输入事件，产出可播放的 WebM。
 * 不使用合成画面/设计稿：录的是真实 renderer 的实际渲染输出。
 *
 * 用法（项目根目录）：
 *   electron.exe scripts\electron-capture\record.js --fca-home=.cache\record-home --port=17862 --out=artifacts\recordings\fca-atlas-nebula.webm --seconds=8
 *
 * 参数：
 *   --fca-home=<dir>   隔离数据目录（默认 .cache/record-home）
 *   --port=<port>      Runtime 端口（默认 17862）
 *   --out=<path>       输出 webm（相对项目根）
 *   --seconds=<n>      录制时长，默认 8
 *   --view=<id>        视图（默认 atlas）
 *   --scenario=<name>  capture 场景（默认 demo）
 *   --width/--height   窗口尺寸（默认 1600x1000）
 *   --no-runtime       不启动 Runtime（复用现有实例）
 *   --interact         录制时注入缩放/平移（默认开启）
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
const paths = require('../../desktop/main/paths');
const { createLogger } = require('../../desktop/main/logger');
const { createSettingsStore } = require('../../desktop/main/settings');
const { createRuntimeManager } = require('../../desktop/main/runtime-manager');
const { createNetClient } = require('../../desktop/main/net-client');
const { registerIpc } = require('../../desktop/main/ipc');

const ROOT = paths.PROJECT_ROOT;

function parseArgs(argv) {
  const out = {};
  for (const raw of argv) {
    if (typeof raw !== 'string') continue;
    const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
    if (!m) continue;
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

const CLI = parseArgs(process.argv.slice(1));
const args = {
  fcaHome: CLI['fca-home'] ? path.resolve(ROOT, String(CLI['fca-home'])) : path.join(ROOT, '.cache', 'record-home'),
  port: CLI.port ? Number(CLI.port) : 17862,
  out: path.resolve(ROOT, CLI.out ? String(CLI.out) : path.join('artifacts', 'recordings', 'fca-atlas-nebula.webm')),
  seconds: CLI.seconds ? Math.max(2, Math.min(60, Number(CLI.seconds))) : 8,
  view: CLI.view ? String(CLI.view) : 'atlas',
  scenario: CLI.scenario ? String(CLI.scenario) : 'demo',
  width: CLI.width ? Number(CLI.width) : 1600,
  height: CLI.height ? Number(CLI.height) : 1000,
  noRuntime: Boolean(CLI['no-runtime']),
  noInteract: Boolean(CLI['no-interact']),
};

app.setPath('userData', path.join(ROOT, '.cache', 'record-userdata'));
app.setName(`${paths.PRODUCT_NAME} Record`);
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.on('window-all-closed', () => {
  /* keep process alive during recording sequence */
});

const logger = createLogger({
  logDir: path.join(ROOT, '.cache', 'record-logs'),
  appVersion: paths.PRODUCT_VERSION,
  mirrorToConsole: false,
});

const settingsStore = createSettingsStore({ logger, filePath: path.join(args.fcaHome, 'desktop-settings.json') });
settingsStore.load();
settingsStore.override({
  dataDir: args.fcaHome,
  port: args.port,
  autoStartRuntime: false,
  closeRuntimeOnExit: true,
});
fs.mkdirSync(args.fcaHome, { recursive: true });
try {
  paths.ensureDataDirs(settingsStore.get().dataDir);
} catch (error) {
  logger.warn('record', '数据目录创建失败', { message: error.message });
}

const net = createNetClient({
  logger,
  getBaseUrl: () => settingsStore.effectiveRuntimeUrl(),
  getToken: () => net.readTokenFile(paths.tokenPath(settingsStore.get().dataDir)),
  clientKind: 'test',
  clientVersion: paths.PRODUCT_VERSION,
});

const runtimeManager = createRuntimeManager({
  logger,
  settings: settingsStore,
  getWindow: () => BrowserWindow.getAllWindows()[0] || null,
});
let ipc = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureRuntime() {
  if (args.noRuntime) {
    const probe = await net.request({ method: 'GET', path: '/health', noAuth: true, timeoutMs: 1500 });
    return probe.ok;
  }
  try {
    const result = await runtimeManager.start({ reason: 'record' });
    if (result && result.error) {
      console.error('[record] Runtime 启动失败', result.error);
      return false;
    }
    global.__FCA_RECORD_RUNTIME__ = runtimeManager;
    return true;
  } catch (error) {
    console.error('[record] Runtime 异常', error.message);
    return false;
  }
}

async function waitForToken(tokenPath) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (fs.existsSync(tokenPath) && net.readTokenFile(tokenPath)) return true;
    await sleep(120);
  }
  return false;
}

async function waitFor(win, expression, timeoutMs, label, interval = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await win.webContents.executeJavaScript(expression, true);
      if (value) return true;
    } catch {
      /* not ready */
    }
    await sleep(interval);
  }
  console.error(`[record] 等待超时：${label}`);
  return false;
}

function buildUrl() {
  const rendererIndex = path.join(paths.appRoot(), 'renderer', 'index.html');
  const fileUrl = pathToFileURL(rendererIndex).href;
  const query = new URLSearchParams({ capture: '1', scenario: args.scenario, view: args.view });
  return `${fileUrl}?${query.toString()}#view=${encodeURIComponent(args.view)}`;
}

async function collectRecording(win) {
  const base64Chunks = await win.webContents.executeJavaScript(
    `(async () => {
      const rec = window.__FCA_REC__;
      if (!rec) return null;
      const chunks = rec.chunks.slice();
      const out = [];
      for (const blob of chunks) {
        const buf = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        const comma = buf.indexOf(',');
        out.push(comma >= 0 ? buf.slice(comma + 1) : '');
      }
      return out;
    })()`,
    true,
  );
  if (!Array.isArray(base64Chunks)) return null;
  const parts = base64Chunks.map((b64) => Buffer.from(b64, 'base64'));
  return Buffer.concat(parts);
}

async function main() {
  await app.whenReady();
  ipc = registerIpc({ settingsStore, runtimeManager, logger, getWindow: () => BrowserWindow.getAllWindows()[0] || null });
  const runtimeReady = await ensureRuntime();
  console.log(`[record] runtimeReady=${runtimeReady}`);
  await waitForToken(paths.tokenPath(settingsStore.get().dataDir));

  const win = new BrowserWindow({
    width: args.width,
    height: args.height,
    show: false,
    backgroundColor: '#070b12',
    webPreferences: {
      preload: path.join(ROOT, 'desktop', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  const url = buildUrl();
  console.log(`[record] 打开 ${url}`);
  await win.loadURL(url);
  const ready = await waitFor(win, 'Boolean(window.__FCA_READY__) || Boolean(window.__FCA_FATAL__)', 30000, 'renderer ready');
  await waitFor(win, "(() => { const a = window.__FCA_APP__; if (!a) return true; const s = a.getState(); return !s || s.graph.status !== 'loading'; })()", 20000, 'graph settled');
  await sleep(1500);

  const summary = await win.webContents.executeJavaScript(
    `(() => { try { const s = window.__FCA_APP__.getState(); return { view: s.app.view, nodes: s.graph.stats.nodes, edges: s.graph.stats.edges, clusters: s.graph.stats.clusters, source: s.graph.source, quality: s.ui.quality }; } catch (e) { return { error: String(e) }; } })()`,
    true,
  );
  console.log('[record] state =', JSON.stringify(summary));
  if (!ready || !summary || !summary.nodes) {
    console.error('[record] 没有真实数据或 renderer 未就绪，拒绝录制空白画面');
    await shutdown(2);
    return;
  }

  const started = await win.webContents.executeJavaScript(
    `(() => {
      const canvas = document.querySelector('#nebula, canvas');
      if (!canvas) return 'no-canvas';
      try {
        const stream = canvas.captureStream(30);
        const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm;codecs=vp8';
        const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
        const state = { chunks: [], done: false, mime };
        rec.ondataavailable = (e) => { if (e.data && e.data.size) state.chunks.push(e.data); };
        rec.onstop = () => { state.done = true; };
        window.__FCA_REC__ = state;
        rec.start(1000);
        setTimeout(() => { try { rec.stop(); } catch {} }, ${args.seconds * 1000});
        return mime;
      } catch (error) { return 'error:' + error.message; }
    })()`,
    true,
  );
  console.log('[record] MediaRecorder =', started);
  if (typeof started !== 'string' || started.startsWith('error:') || started === 'no-canvas') {
    await shutdown(2);
    return;
  }

  // 录制期间注入真实输入事件：滚轮缩放 + 拖拽平移（表现真实交互）
  if (!args.noInteract) {
    const cx = Math.floor(args.width / 2);
    const cy = Math.floor(args.height / 2);
    const steps = 8;
    for (let i = 0; i < steps; i += 1) {
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: cx, y: cy, deltaY: i < steps / 2 ? 120 : -120, canScroll: true });
      await sleep(Math.floor((args.seconds * 1000) / steps));
    }
  } else {
    await sleep(args.seconds * 1000 + 1200);
  }
  await waitFor(win, 'Boolean(window.__FCA_REC__ && window.__FCA_REC__.done)', 10000, 'recorder stop');

  const buffer = await collectRecording(win);
  if (!buffer || buffer.length === 0) {
    console.error('[record] 录制结果为空');
    await shutdown(2);
    return;
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, buffer);
  const meta = {
    recorded_at: new Date().toISOString(),
    out: path.relative(ROOT, args.out),
    bytes: buffer.length,
    mime: started,
    seconds: args.seconds,
    window: `${args.width}x${args.height}`,
    runtime_ready: runtimeReady,
    state: summary,
    note: '真实 Electron renderer + 真实 Runtime 数据，页面内 MediaRecorder 录制；录制期间注入滚轮缩放输入事件。',
  };
  fs.writeFileSync(path.join(ROOT, '.cache', 'record-report.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(ROOT, 'artifacts', 'recordings', 'fca-atlas-nebula.record.json'), JSON.stringify(meta, null, 2));
  console.log('RECORDED', args.out, 'bytes=' + buffer.length, 'mime=' + started);
  await shutdown(0);
}

async function shutdown(code) {
  try {
    if (ipc && typeof ipc.dispose === 'function') ipc.dispose();
  } catch {
    /* ignore */
  }
  try {
    if (global.__FCA_RECORD_RUNTIME__) await global.__FCA_RECORD_RUNTIME__.shutdownForQuit();
  } catch (error) {
    console.error('[record] shutdown error', error && error.message);
  }
  try {
    await logger.flush();
  } catch {
    /* ignore */
  }
  app.exit(code);
}

process.on('uncaughtException', (error) => {
  console.error('[record] uncaught', error);
  shutdown(2);
});
process.on('unhandledRejection', (reason) => {
  console.error('[record] unhandled rejection', reason);
  shutdown(2);
});
const hardTimer = setTimeout(() => {
  console.error('[record] 超时退出');
  shutdown(3);
}, (args.seconds + 120) * 1000);
if (hardTimer.unref) hardTimer.unref();

main().catch((error) => {
  console.error('[record] fatal', error && error.stack ? error.stack : error);
  shutdown(2);
});
