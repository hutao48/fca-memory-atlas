/**
 * 通用截图 harness（Electron 入口，由 scripts/capture.js 启动）。
 * 支持两种目标：
 *  - URL（file:// 或 http://，例如 nebula demo.html）
 *  - 桌面应用（加载 desktop 目录，可指定 view 路由，通过 preload 注入的 window.__FCA_CAPTURE__ 或 URL hash）
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const configArg = process.argv.find((a) => a.startsWith('--capture-config='));
if (!configArg) {
  console.error('missing --capture-config');
  app.exit(2);
  return;
}
const configPath = configArg.split('=')[1];
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DESKTOP_DIR = path.join(PROJECT_ROOT, 'desktop');

app.disableHardwareAcceleration = false;
app.commandLine.appendSwitch('force-device-scale-factor', String(config.deviceScaleFactor ?? 1));

async function run() {
  const win = new BrowserWindow({
    width: config.width,
    height: config.height,
    show: Boolean(config.show),
    backgroundColor: '#03040a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: false,
    },
  });

  win.webContents.on('console-message', (_e, level, message) => {
    console.log(`[renderer:${level}] ${message}`);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  let target;
  if (config.url) {
    target = config.url;
  } else {
    target = `file:///${path.join(DESKTOP_DIR, 'renderer', 'index.html').replace(/\\/g, '/')}`;
    if (config.view) target += `#view=${encodeURIComponent(config.view)}`;
  }

  if (config.fcaHome) {
    app.setPath('userData', path.join(config.fcaHome, 'electron-user-data'));
  }

  await win.loadURL(target);
  await new Promise((r) => setTimeout(r, config.wait ?? 2500));

  if (config.eval) {
    const result = await win.webContents.executeJavaScript(config.eval);
    console.log('[capture] eval result:', JSON.stringify(result));
  }

  const image = await win.webContents.capturePage();
  const png = image.toPNG();
  fs.mkdirSync(path.dirname(config.out), { recursive: true });
  fs.writeFileSync(config.out, png);
  console.log(`[capture] saved ${config.out} (${png.length} bytes, ${image.getSize().width}x${image.getSize().height})`);

  const stats = await win.webContents
    .executeJavaScript(`(() => { const n = window.__FCA_NEBULA_STATS__; return n ? n() : null; })()`)
    .catch(() => null);
  if (stats) console.log('[capture] nebula stats:', JSON.stringify(stats));

  win.destroy();
}

app.whenReady().then(async () => {
  try {
    await run();
    app.exit(0);
  } catch (err) {
    console.error('[capture] failed:', err && err.stack ? err.stack : err);
    app.exit(1);
  }
});
