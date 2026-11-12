// FCA Memory Atlas — Nebula Renderer capture harness (Electron main process)
// Real GPU rendering via Electron 38 (ANGLE/D3D11) + webContents.capturePage() -> PNG.
// Part of the Nebula task scope: tests/performance/nebula/**
//
// Usage (PowerShell):
//   Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
//   .cache\electron-dist\electron.exe tests\performance\nebula\capture.cjs --mode shot --scenario 1000 --quality high --ui 1 --out artifacts\screenshots\nebula-1000.png
//   .cache\electron-dist\electron.exe tests\performance\nebula\capture.cjs --mode batch
//   .cache\electron-dist\electron.exe tests\performance\nebula\capture.cjs --mode bench
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DEMO = path.join(ROOT, 'desktop', 'renderer', 'nebula', 'demo.html');
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.findIndex((a) => a === '--' + name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const eq = args.find((a) => a.startsWith('--' + name + '='));
  return eq ? eq.slice(name.length + 3) : def;
}
const MODE = arg('mode', 'shot');
const OUTDIR = path.resolve(ROOT, arg('outdir', 'artifacts/screenshots'));
const REPORTDIR = path.resolve(ROOT, 'artifacts/reports');
fs.mkdirSync(OUTDIR, { recursive: true });
fs.mkdirSync(REPORTDIR, { recursive: true });

app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.disableHardwareAcceleration; // keep reference; not called

const consoleLog = [];
function parseSize(s) {
  const m = String(s || '1600x1000').toLowerCase().match(/^(\d+)x(\d+)$/);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [1600, 1000];
}

function makeWindow(w, h) {
  const win = new BrowserWindow({
    width: w, height: h, show: false,
    backgroundColor: '#04060d',
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webgl: true,
    },
  });
  win.setContentSize(w, h);
  win.webContents.on('console-message', (e) => {
    const msg = e && e.message !== undefined ? e.message : '';
    const level = e && e.level !== undefined ? e.level : 'info';
    consoleLog.push(`[${level}] ${msg}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => { consoleLog.push('RENDER_PROCESS_GONE ' + JSON.stringify(details)); });
  return win;
}

function urlFor(query) {
  const u = new URL('file://' + DEMO.replace(/\\/g, '/'));
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  return u.toString();
}

async function waitReady(win, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let ready = false, err = null;
    try {
      ready = await win.webContents.executeJavaScript('window.__FCA_NEBULA_READY__ === true');
      err = await win.webContents.executeJavaScript('window.__FCA_NEBULA_ERROR__ || (window.__FCA_PAGE_ERRORS__ && window.__FCA_PAGE_ERRORS__[0]) || null');
    } catch (e) { /* page still loading */ }
    if (ready) return true;
    if (err) throw new Error('page error: ' + err);
    await sleep(150);
  }
  return false;
}

async function pageStats(win) {
  try {
    return await win.webContents.executeJavaScript(
      'JSON.stringify(window.__FCA_NEBULA_STATS__ ? window.__FCA_NEBULA_STATS__() : null)'
    );
  } catch (e) { return null; }
}

async function shoot(win, outPath, waitMs) {
  await sleep(waitMs || 900);
  // a couple of animation frames so perf counters + labels are populated
  const img = await win.webContents.capturePage();
  const png = img.toPNG();
  fs.writeFileSync(outPath, png);
  return { bytes: png.length, width: img.getSize().width, height: img.getSize().height };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runShot() {
  const size = parseSize(arg('size', '1600x1000'));
  const scenario = arg('scenario', '1000');
  const quality = arg('quality', 'high');
  const pipeline = arg('pipeline', 'volume');
  const ui = arg('ui', '1');
  const out = path.resolve(ROOT, arg('out', `artifacts/screenshots/nebula-${scenario}-${quality}.png`));
  const query = {
    scenario, quality, pipeline, ui,
    yaw: arg('yaw', undefined), pitch: arg('pitch', undefined),
    nebula: arg('nebula', undefined), dust: arg('dust', undefined),
    edges: arg('edges', undefined), stars: arg('stars', undefined),
    exposure: arg('exposure', undefined), band: arg('band', undefined),
    seed: arg('seed', undefined), labels: arg('labels', undefined),
  };
  const win = makeWindow(size[0], size[1]);
  await win.loadURL(urlFor(query));
  const ready = await waitReady(win, 45000);
  if (!ready) {
    const txt = await win.webContents.executeJavaScript('document.body ? document.body.innerText.slice(0,400) : "no body"').catch(() => '');
    console.log('READY_TIMEOUT body=' + txt);
    console.log(consoleLog.slice(-40).join('\n'));
    app.exit(2);
    return;
  }
  const stats = await pageStats(win);
  // demo.html 有一个 2.5s 的 file:// 兜底提示；模块加载偶发超过 2.5s 时它会显示并盖住画面。
  // 既然 __FCA_NEBULA_READY__ 已为 true，就显式移除该兜底层，保证截图为真实 WebGL 输出。
  await win.webContents.executeJavaScript("(() => { const e = document.getElementById('errbox'); if (e) e.classList.remove('show'); return true; })()").catch(() => {});
  const pre = arg('pre', '');
  if (pre) {
    const out = await win.webContents.executeJavaScript('(function(){ try { ' + pre + '; return "PRE_OK"; } catch (e) { return "PRE_ERR " + e.message; } })()').catch((e) => 'PRE_ERR ' + e.message);
    console.log('PRE ' + out);
    await sleep(900);
  }
  await sleep(900);
  const meta = await shoot(win, out, Number(arg('wait', '900')));
  console.log('SHOT ' + out + ' bytes=' + meta.bytes + ' size=' + meta.width + 'x' + meta.height);
  console.log('STATS ' + (stats || 'null'));
  if (arg('check', '0') === '1') {
    const dataUrlLen = await win.webContents.executeJavaScript(
      'window.__NEBULA_DEMO__ ? (window.__NEBULA_DEMO__.instance.screenshotDataUrl() || "").length : -1'
    ).catch((e) => 'ERR ' + e.message);
    console.log('SCREENSHOT_DATAURL_LEN ' + dataUrlLen);
  }
  const errs = consoleLog.filter((l) => l.startsWith('[3]') || /error|Error|failed|INVALID/i.test(l));
  if (errs.length) console.log('PAGE_ERRORS:\n' + errs.slice(-20).join('\n'));
  const evalExpr = arg('eval', '');
  if (evalExpr) {
    const out = await win.webContents.executeJavaScript('(function(){ try { return JSON.stringify(' + evalExpr + '); } catch (e) { return "EVAL_ERR " + e.message; } })()').catch((e) => 'EVAL_ERR ' + e.message);
    console.log('EVAL ' + out);
  }
  app.exit(0);
}

async function runBatch() {
  const manifestPath = path.resolve(ROOT, arg('manifest', 'tests/performance/nebula/shots.json'));
  const shots = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const size = parseSize(arg('size', '1600x1000'));
  const results = [];
  const win = makeWindow(size[0], size[1]);
  for (const shot of shots) {
    const out = path.resolve(ROOT, 'artifacts/screenshots', shot.name.endsWith('.png') ? shot.name : shot.name + '.png');
    const query = { ui: '1', ...(shot.query || {}) };
    const t0 = Date.now();
    await win.loadURL(urlFor(query));
    const ready = await waitReady(win, 45000);
    if (!ready) {
      results.push({ name: shot.name, ok: false, error: 'ready timeout', console: consoleLog.slice(-20) });
      console.log('BATCH FAIL ' + shot.name + ' (ready timeout)');
      continue;
    }
    const stats = await pageStats(win);
    const meta = await shoot(win, out, shot.wait || 1100);
    results.push({ name: shot.name, out, ok: true, meta, stats: stats ? JSON.parse(stats) : null, ms: Date.now() - t0 });
    console.log('BATCH OK ' + shot.name + ' -> ' + out + ' bytes=' + meta.bytes);
  }
  fs.writeFileSync(path.join(REPORTDIR, 'nebula-capture-results.json'), JSON.stringify({ at: new Date().toISOString(), mode: 'batch', size, results, console: consoleLog.slice(-80) }, null, 2));
  console.log('BATCH_DONE ' + results.filter((r) => r.ok).length + '/' + results.length);
  app.exit(0);
}

async function runBench() {
  const benchHtml = path.join(__dirname, 'bench.html');
  const size = parseSize(arg('size', '1600x1000'));
  const win = makeWindow(size[0], size[1]);
  await win.loadURL('file://' + benchHtml.replace(/\\/g, '/') + '?autorun=1&size=' + size[0] + 'x' + size[1]);
  const t0 = Date.now();
  let result = null;
  while (Date.now() - t0 < 600000) {
    try {
      const r = await win.webContents.executeJavaScript('window.__BENCH_RESULT__ || null');
      if (r) { result = r; break; }
    } catch (e) { /* ignore */ }
    await sleep(500);
  }
  if (!result) { console.log('BENCH_TIMEOUT'); console.log(consoleLog.slice(-30).join('\n')); app.exit(3); return; }
  fs.writeFileSync(path.join(REPORTDIR, 'nebula-bench-raw.json'), JSON.stringify(result, null, 2));
  console.log('BENCH_DONE ' + (result.rows ? result.rows.length : 0) + ' rows -> artifacts/reports/nebula-bench-raw.json');
  app.exit(0);
}

app.whenReady().then(async () => {
  try {
    if (MODE === 'batch') await runBatch();
    else if (MODE === 'bench') await runBench();
    else await runShot();
  } catch (e) {
    console.error('CAPTURE_ERROR ' + (e && e.stack || e));
    consoleLog.slice(-30).forEach((l) => console.log(l));
    app.exit(1);
  }
});

