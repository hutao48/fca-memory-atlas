'use strict';

/**
 * FCA Memory Atlas — 截图入口（Electron 入口，非生产窗口逻辑）
 *
 * 用法：
 *   electron.exe desktop/main/capture.js --view=atlas --out=artifacts/screenshots/desktop-atlas.png
 *   electron.exe desktop/main/capture.js --preset=full --fca-home=.cache/capture-home-demo
 *
 * 参数：
 *   --view=<id>         视图 id（atlas/timeline/…），写入 URL hash #view=<id>
 *   --scenario=<name>   UI 场景（demo/empty/clusters/detail/onboarding/settings/error…）
 *   --out=<path>        输出 PNG（相对项目根；默认 artifacts/screenshots/desktop-<scenario|view>.png）
 *   --size=1600x1000 或 --width= --height=
 *   --wait=<ms>         页面就绪后额外等待（默认 1200）
 *   --preset=full|empty|views  一次进程拍摄一组截图
 *   --fca-home=<dir>    隔离数据目录（默认 <root>/.cache/capture-home）——会在此目录写 desktop-settings.json
 *   --port=<port>       Runtime 端口（默认 17860）
 *   --no-runtime        不启动 Runtime（用现有健康状态）
 *   --no-init           不自动初始化空库
 *
 * 说明：真实启动 Electron 窗口（show），通过 webContents.capturePage() 截取真实渲染结果，不使用设计稿/合成图。
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, session } = require('electron');
const paths = require('./paths');
const { createLogger } = require('./logger');
const { createSettingsStore } = require('./settings');
const { createRuntimeManager } = require('./runtime-manager');
const { createNetClient } = require('./net-client');
const { registerIpc } = require('./ipc');

// --------------------------------------------------------------------------- 参数
function parseArgs(argv) {
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

const CLI = parseArgs(process.argv.slice(1));
const ROOT = paths.PROJECT_ROOT;
const SHOTS_DIR = path.join(ROOT, 'artifacts', 'screenshots');

const args = {
  view: CLI.view ? String(CLI.view) : 'atlas',
  scenario: CLI.scenario ? String(CLI.scenario) : null,
  out: CLI.out ? path.resolve(ROOT, String(CLI.out)) : null,
  size: CLI.size ? String(CLI.size) : null,
  width: CLI.width ? Number(CLI.width) : null,
  height: CLI.height ? Number(CLI.height) : null,
  wait: CLI.wait ? Math.max(0, Number(CLI.wait)) : 1200,
  preset: CLI.preset ? String(CLI.preset) : null,
  fcaHome: CLI['fca-home'] ? path.resolve(ROOT, String(CLI['fca-home'])) : path.join(ROOT, '.cache', 'capture-home'),
  port: CLI.port ? Number(CLI.port) : paths.DEFAULT_PORT,
  noRuntime: Boolean(CLI['no-runtime']),
  noInit: Boolean(CLI['no-init']),
  noShow: Boolean(CLI['no-show']),
  // 视觉调试：--map=nebulaIntensity:0.5,dustStrength:1.4（透传给 renderer atlas 视图）
  map: CLI.map ? String(CLI.map) : null,
  // 视觉调试：--cam=<yaw>,<pitch>,<fitPadding>
  cam: CLI.cam ? String(CLI.cam) : null,
  // 图例面板：--legend=0|1（默认不干预 localStorage 恢复值）
  legend: CLI.legend !== undefined ? String(CLI.legend) === '1' : null,
  // 截图前在页面上下文中执行的 JS（用于选中节点/打开弹窗/切换画质等交互证据）
  eval: CLI.eval ? String(CLI.eval) : null,
  // 同上，但从文件读取（避免命令行引号/空格问题；批量脚本推荐）
  evalFile: CLI['eval-file'] ? path.resolve(ROOT, String(CLI['eval-file'])) : null,
  // 强制画质档位（与 localStorage 无关，保证批量截图可复现）
  quality: CLI.quality ? String(CLI.quality) : null,
  // 是否在本次截图前清空隔离 userData 的 localStorage（默认 true，保证起始 UI 状态一致）
  freshUi: CLI['keep-ui'] ? false : true,
  // 截图专用 userData 目录（并行截图时每个进程用独立目录，避免 Chromium profile 锁冲突）
  userData: CLI.userdata ? path.resolve(ROOT, String(CLI.userdata)) : path.join(ROOT, '.cache', 'capture-userdata'),
};

let winWidth = 1600;
let winHeight = 1000;
if (args.size) {
  const m = /^(\d+)x(\d+)$/.exec(args.size);
  if (m) {
    winWidth = Number(m[1]);
    winHeight = Number(m[2]);
  }
}
if (args.width) winWidth = args.width;
if (args.height) winHeight = args.height;

const PRESETS = {
  full: [
    { name: 'atlas-demo', view: 'atlas', scenario: 'demo', wait: 2500 },
    { name: 'atlas-clusters', view: 'atlas', scenario: 'clusters', wait: 2000 },
    { name: 'atlas-detail', view: 'atlas', scenario: 'detail', wait: 2200 },
    { name: 'onboarding', view: 'atlas', scenario: 'onboarding', wait: 1400 },
    { name: 'settings', view: 'atlas', scenario: 'settings', wait: 1400 },
  ],
  // 验收截图矩阵：全部使用真实 Runtime 数据 + 产品实际渲染（capturePage）。
  // 交互场景通过 eval 在产品自身验收钩子（window.__FCA_APP__ / window.fcaApp）上操作。
  final: [
    { name: 'final-atlas-overview', view: 'atlas', scenario: 'demo', wait: 2800, quality: 'high', legend: false },    {
      name: 'final-atlas-legend',
      view: 'atlas',
      scenario: 'demo',
      wait: 2400,
      quality: 'high',
      legend: true,
    },
    { name: 'final-atlas-clusters', view: 'atlas', scenario: 'clusters', wait: 2600, quality: 'high', legend: false },
    {
      name: 'final-atlas-detail',
      view: 'atlas',
      scenario: 'detail',
      wait: 2800,
      quality: 'high',
      legend: false,
      eval: "(() => { const n = window.__FCA_NEBULA__; if (n && n.fitToContent) n.fitToContent({ padding: 0.04 }); return 'detail-fit'; })()",
      evalWait: 1100,
    },
    {
      name: 'final-atlas-focus',
      view: 'atlas',
      scenario: 'demo',
      wait: 2800,
      quality: 'high',
      legend: false,
      eval:
        "(() => { const a = window.__FCA_APP__; const g = a.getGraph(); const nodes = g.nodes.filter(n => n.kind === 'memory'); nodes.sort((x, y) => (y.importance || 0) - (x.importance || 0)); const n = nodes[0]; a.openMemory(n.id); window.fcaApp.events.emit('node:focus', { id: n.id, depth: 2 }); return n.label; })()",
      evalWait: 1400,
    },
    {
      name: 'final-atlas-quality-off',
      view: 'atlas',
      scenario: 'demo',
      wait: 2400,
      quality: 'off',
      legend: false,
    },
    { name: 'final-timeline', view: 'timeline', wait: 2600, quality: 'high', legend: false },
    { name: 'final-relations', view: 'relations', wait: 2600, quality: 'high', legend: false },
    { name: 'final-search', view: 'search', scenario: 'search', wait: 2600, quality: 'high', legend: false },
    { name: 'final-list', view: 'list', wait: 2600, quality: 'high', legend: false },
    { name: 'final-data', view: 'data', wait: 2600, quality: 'high', legend: false },
    { name: 'final-settings', view: 'atlas', scenario: 'settings', wait: 2000, quality: 'high', legend: false },
    { name: 'final-onboarding', view: 'atlas', scenario: 'onboarding', wait: 2000, quality: 'high', legend: false },
  ],
  empty: [{ name: 'atlas-empty', view: 'atlas', scenario: 'empty', wait: 2200 }],
  // 同一窗口内的连续交互序列截图（用于"关键交互"证据 / 合成录屏 GIF）
  seq: [
    {
      name: 'final-seq',
      view: 'atlas',
      scenario: 'demo',
      wait: 3000,
      quality: 'high',
      legend: false,
      steps: [
        { label: '01-overview', wait: 600, desc: '星云总览（实时 Runtime 数据）' },
        {
          label: '02-detail',
          desc: '选中一条记忆 → 右侧详情面板读取真实记忆',
          eval: "(() => { const g = window.__FCA_APP__.getGraph(); const ns = g.nodes.filter(n => n.kind === 'memory').sort((a, b) => (b.importance || 0) - (a.importance || 0)); window.__FCA_APP__.openMemory(ns[0].id); const n = window.__FCA_NEBULA__; if (n) n.fitToContent({ padding: 0.04 }); return ns[0].label; })()",
          wait: 1500,
        },
        {
          label: '03-focus',
          desc: '聚焦一阶/二阶邻居（focusNode depth=2）',
          eval: "(() => { const g = window.__FCA_APP__.getGraph(); const ns = g.nodes.filter(n => n.kind === 'memory').sort((a, b) => (b.importance || 0) - (a.importance || 0)); window.fcaApp.events.emit('node:focus', { id: ns[0].id, depth: 2 }); return ns[0].label; })()",
          wait: 1200,
        },
        {
          label: '04-clusters',
          desc: '切换到聚类模式并聚焦星团',
          eval: "(() => { const g = window.__FCA_APP__.getGraph(); window.fcaApp.events.emit('cluster:focus', { cluster: g.clusters[0] }); return g.clusters[0].label; })()",
          wait: 1600,
        },
        {
          label: '05-layers',
          desc: '图层面板：关闭关系光丝与标签（保留星云与交互）',
          eval: "(() => { window.fcaApp.store.patch({ ui: { overlays: { edges: false, labels: false } } }); return 'layers'; })()",
          wait: 1200,
        },
        {
          label: '06-quality-off',
          desc: '关闭特效：保留全部交互与可读性（纯 CPU 路径）',
          eval: "(() => { window.__FCA_APP__.setQuality('off'); return 'off'; })()",
          wait: 1300,
        },
        {
          label: '07-quality-high',
          desc: '切回 high 画质（体积星云 + HDR bloom 恢复）',
          eval: "(() => { window.__FCA_APP__.setQuality('high'); window.fcaApp.store.patch({ ui: { overlays: { edges: true, labels: true } } }); window.__FCA_APP__.navigate('atlas'); return 'high'; })()",
          wait: 1500,
        },
      ],
    },
  ],
  views: [
    { name: 'timeline', view: 'timeline', wait: 1200 },
    { name: 'list', view: 'list', wait: 1200 },
    { name: 'relations', view: 'relations', wait: 1200 },
    { name: 'search', view: 'search', wait: 1200 },
    { name: 'data', view: 'data', wait: 1200 },
  ],
};

// 截图进程使用独立 userData，避免与正常运行的桌面实例抢锁
app.setPath('userData', args.userData);
app.setName(`${paths.PRODUCT_NAME} Capture`);
app.commandLine.appendSwitch('force-color-profile', 'srgb');

const logger = createLogger({
  logDir: path.join(ROOT, '.cache', 'capture-logs'),
  appVersion: paths.PRODUCT_VERSION,
  mirrorToConsole: true,
});
const settingsStore = createSettingsStore({
  logger,
  filePath: path.join(args.fcaHome, 'desktop-settings.json'),
});
settingsStore.load();
settingsStore.override({
  dataDir: args.fcaHome,
  port: args.port,
  autoStartRuntime: false,
  closeRuntimeOnExit: true,
});
try {
  fs.mkdirSync(args.fcaHome, { recursive: true });
  paths.ensureDataDirs(settingsStore.get().dataDir);
} catch (error) {
  logger.warn('capture', '数据目录创建失败', { message: error.message });
}

const net = createNetClient({
  logger,
  getBaseUrl: () => settingsStore.effectiveRuntimeUrl(),
  getToken: () => net.readTokenFile(paths.tokenPath(settingsStore.get().dataDir)),
  clientKind: 'test',
  clientVersion: paths.PRODUCT_VERSION,
});

// 截图进程同样注册完整 IPC 处理器（与生产 main.js 一致），否则 renderer 初始化会失败。
// Runtime 管理器在 ensureRuntimeReady 中启动，这里先建立实例供 IPC 使用。
const runtimeManager = createRuntimeManager({
  logger,
  settings: settingsStore,
  getWindow: () => BrowserWindow.getAllWindows()[0] || null,
});
let ipc = null;

// 截图需要连续创建/销毁多个窗口；阻止 Electron 在最后一个窗口关闭时自动退出。
app.on('window-all-closed', () => {
  /* keep capture process alive */
});

// --------------------------------------------------------------------------- 工具
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shotList() {
  if (args.preset) {
    const preset = PRESETS[args.preset];
    if (!preset) {
      throw new Error(`未知 preset：${args.preset}（可选：${Object.keys(PRESETS).join('/')}）`);
    }
    return preset;
  }
  const name = args.scenario || args.view || 'atlas';
  return [{ name: `atlas-${name}`, view: args.view, scenario: args.scenario, wait: args.wait }];
}

function buildUrl(shot) {
  const rendererIndex = path.join(paths.appRoot(), 'renderer', 'index.html');
  const query = new URLSearchParams();
  query.set('capture', '1');
  if (shot.scenario) query.set('scenario', shot.scenario);
  query.set('view', shot.view || 'atlas');
  const quality = shot.quality || args.quality;
  if (quality) query.set('quality', quality);
  if (args.map) query.set('map', args.map);
  if (args.cam) query.set('cam', args.cam);
  const legend = shot.legend !== undefined ? shot.legend : args.legend;
  if (legend !== null && legend !== undefined) query.set('legend', legend ? '1' : '0');
  const fileUrl = pathToFileURL(rendererIndex).href;
  const hash = new URLSearchParams();
  hash.set('view', shot.view || 'atlas');
  if (shot.scenario === 'clusters') hash.set('mode', 'clusters');
  return `${fileUrl}?${query.toString()}#${hash.toString()}`;
}

function outputPathFor(shot) {
  if (args.out) return args.out;
  // final-* 验收截图按 task 约定直接存 artifacts/screenshots/final-*.png，其余保留 desktop- 前缀
  const fileName = String(shot.name).startsWith('final-') ? `${shot.name}.png` : `desktop-${shot.name}.png`;
  return path.join(SHOTS_DIR, fileName);
}

async function evaluate(win, expression) {
  try {
    return await win.webContents.executeJavaScript(expression, true);
  } catch {
    return null;
  }
}

function readEvalFile() {
  if (!args.evalFile) return null;
  try {
    return fs.readFileSync(args.evalFile, 'utf8');
  } catch (error) {
    logger.warn('capture', '读取 --eval-file 失败', { file: args.evalFile, message: error.message });
    return null;
  }
}

async function waitFor(win, expression, timeoutMs, label, interval = 160) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(win, expression);
    if (value) return true;
    await sleep(interval);
  }
  logger.warn('capture', `等待超时：${label}（${timeoutMs}ms）`);
  return false;
}

async function ensureRuntimeReady() {
  if (args.noRuntime) {
    const probe = await net.request({ method: 'GET', path: '/health', noAuth: true, timeoutMs: 1500 });
    if (probe.ok) {
      // 复用外部已启动的 Runtime：让 runtimeManager 进入 running 状态（renderer 才能连上并加载图谱）
      try {
        await runtimeManager.checkHealth();
        logger.info('capture', '复用外部 Runtime（--no-runtime）', { url: settingsStore.effectiveRuntimeUrl() });
      } catch (error) {
        logger.warn('capture', '外部 Runtime 状态同步失败', { message: error.message });
      }
    }
    return probe.ok;
  }
  try {
    const result = await runtimeManager.start({ reason: 'capture' });
    if (result && result.error) {
      logger.error('capture', 'Runtime 不可用，截图可能为离线状态', result.error);
      return false;
    }
    const health = result && result.status ? result.status : null;
    if (health && health.initialized === false && !args.noInit) {
      const tokenPath = paths.tokenPath(settingsStore.get().dataDir);
      await waitForToken(tokenPath);
      const initRes = await net.request({ method: 'POST', path: '/api/v1/db/init', body: {}, timeoutMs: 20000 });
      if (!initRes.ok) logger.warn('capture', '空库初始化失败', initRes.error || initRes.status);
      else logger.info('capture', '已初始化空库');
      await sleep(300);
    }
    // 保存 manager 供退出时关闭
    global.__FCA_CAPTURE_RUNTIME__ = runtimeManager;
    return true;
  } catch (error) {
    logger.error('capture', 'Runtime 启动异常', { message: error.message });
    return false;
  }
}

async function waitForToken(tokenPath) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (fs.existsSync(tokenPath)) {
      const token = net.readTokenFile(tokenPath);
      if (token) return token;
    }
    await sleep(120);
  }
  return null;
}

async function runShot(shot) {
  const outPath = outputPathFor(shot);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    show: !args.noShow,
    backgroundColor: '#070b12',
    title: `${paths.PRODUCT_NAME} capture`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  const consoleLines = [];
  win.webContents.on('console-message', (_event, level, message) => {
    const levelName = typeof level === 'number' ? ['debug', 'info', 'warn', 'error'][level] || 'info' : String(level);
    const line = `[renderer:${levelName}] ${message}`;
    consoleLines.push(line);
    if (levelName === 'error' || levelName === 'warn') console.log(line);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[capture] renderer crashed', details);
  });

  const url = buildUrl(shot);
  console.log(`[capture] 打开 ${url}`);
  await win.loadURL(url);
  const ready = await waitFor(win, 'Boolean(window.__FCA_READY__) || Boolean(window.__FCA_FATAL__)', 30000, 'renderer ready');
  if (!ready) console.log('[capture] 警告：renderer 未进入 ready 状态');
  // 等待图谱数据落定（加载中/初始同步）
  await waitFor(
    win,
    "(() => { const a = window.__FCA_APP__; if (!a) return true; const s = a.getState(); return !s || s.graph.status !== 'loading'; })()",
    20000,
    'graph settled',
  );
  // 强制画质（优先 shot 级，其次 CLI）——在页面里直接调用产品钩子，保证确定性
  const forcedQuality = shot.quality || args.quality;
  if (forcedQuality) {
    await evaluate(win, `(() => { window.__FCA_APP__ && window.__FCA_APP__.setQuality(${JSON.stringify(forcedQuality)}); return true; })()`);
  }
  await sleep(Number(shot.wait) || args.wait);
  // 交互证据：先等待首帧，再在页面上下文执行指定表达式，然后留出动画/数据落定时间
  const evalExpr = shot.eval || args.eval || readEvalFile();
  if (evalExpr) {
    const evalResult = await evaluate(win, evalExpr);
    console.log('[capture] eval =', JSON.stringify(evalResult));
    await sleep(Number(shot.evalWait) || 900);
  }
  // 交互序列：同一窗口内逐步执行动作并连续截图（真实交互证据，可合成录屏 GIF）
  if (Array.isArray(shot.steps) && shot.steps.length) {
    const seqShots = [];
    for (let i = 0; i < shot.steps.length; i += 1) {
      const step = shot.steps[i];
      if (step.eval) {
        const stepResult = await evaluate(win, step.eval);
        console.log(`[capture] seq ${step.label} eval =`, JSON.stringify(stepResult));
      }
      await sleep(Number(step.wait) || 1000);
      const frame = await win.webContents.capturePage();
      const framePng = frame.toPNG();
      const framePath = path.join(SHOTS_DIR, `${shot.name}-${step.label}.png`);
      fs.writeFileSync(framePath, framePng);
      seqShots.push({ label: step.label, desc: step.desc || null, path: path.relative(ROOT, framePath), bytes: framePng.length });
      console.log(`SEQ_CAPTURED ${framePath} bytes=${framePng.length}`);
    }
    win.destroy();
    return { outPath: path.join(SHOTS_DIR, shot.name), bytes: 0, summary: null, seqShots };
  }
  const summary = await evaluate(
    win,
    `(() => {
      try {
        const a = window.__FCA_APP__; if (!a) return { fatal: window.__FCA_FATAL__ || 'no-hooks' };
        const s = a.getState();
        return {
          view: s.app.view,
          runtime: s.runtime && s.runtime.state,
          apiVersion: s.runtime && s.runtime.apiVersion,
          graphStatus: s.graph && s.graph.status,
          source: s.graph && s.graph.source,
          nodes: s.graph && s.graph.stats && s.graph.stats.nodes,
          edges: s.graph && s.graph.stats && s.graph.stats.edges,
          clusters: s.graph && s.graph.stats && s.graph.stats.clusters,
          quality: s.ui && s.ui.quality,
          legendOpen: s.ui && s.ui.legendOpen,
          overlays: s.ui && s.ui.overlays,
          selected: s.selection && s.selection.ids,
          detailTarget: s.detail && s.detail.targetId,
          nebula: (() => { try { return a.getNebulaStats ? a.getNebulaStats() : null; } catch (e) { return null; } })(),
          onboardingOpen: s.onboarding && s.onboarding.open,
          dialog: s.ui && s.ui.dialog,
          fatal: s.app && s.app.fatalError,
        };
      } catch (error) { return { error: String(error) }; }
    })()`,
  );
  console.log('[capture] state =', JSON.stringify(summary));
  if (consoleLines.length) {
    const errors = consoleLines.filter((line) => line.includes('[renderer:error]'));
    if (errors.length) console.log('[capture] renderer errors:', errors.slice(0, 10).join('\n'));
  }

  const image = await win.webContents.capturePage();
  const png = image.toPNG();
  fs.writeFileSync(outPath, png);
  console.log(`CAPTURED ${outPath} bytes=${png.length} size=${image.getSize().width}x${image.getSize().height}`);
  win.destroy();
  return { outPath, bytes: png.length, summary };
}

// --------------------------------------------------------------------------- 主流程
// 截图进程生命周期：任何异常/超时都走 shutdown(code)，并保证只退出一次、状态码可预测。
let shuttingDown = false;
const shutdownStartedAt = Date.now();

async function main() {
  await app.whenReady();
  // 隔离 userData 的 localStorage 每次截图从一致状态开始（面板宽度/图例/画质不会互相污染）
  if (args.freshUi) {
    try {
      await session.defaultSession.clearStorageData({ storages: ['localstorage'] });
      logger.info('capture', '已清空截图 userData 的 localStorage（保证 UI 起始状态一致）');
    } catch (error) {
      logger.warn('capture', '清空 localStorage 失败（忽略）', { message: error.message });
    }
  }
  ipc = registerIpc({ settingsStore, runtimeManager, logger, getWindow: () => BrowserWindow.getAllWindows()[0] || null });
  const runtimeReady = await ensureRuntimeReady();
  if (!runtimeReady) logger.warn('capture', 'Runtime 未就绪：按离线/空态截图');
  // 等待 token 出现（Runtime 启动时生成）
  await waitForToken(paths.tokenPath(settingsStore.get().dataDir));

  const shots = shotList();
  const results = [];
  for (const shot of shots) {
    logger.info('capture', `开始截图：${shot.name}`);
    const result = await runShot(shot);
    results.push({ name: shot.name, ...result });
  }
  const report = {
    capturedAt: new Date().toISOString(),
    runtimeReady,
    fcaHome: args.fcaHome,
    runtimeUrl: settingsStore.effectiveRuntimeUrl(),
    size: `${winWidth}x${winHeight}`,
    map: args.map,
    quality: args.quality,
    shots: results.map((r) => ({
      name: r.name,
      path: r.seqShots ? null : path.relative(ROOT, r.outPath),
      bytes: r.bytes,
      summary: r.summary,
      seqShots: r.seqShots || null,
    })),
  };
  const reportPath = path.join(ROOT, '.cache', `capture-report-${args.preset || 'single'}.json`);
  try {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`[capture] 报告：${reportPath}`);
  } catch {
    /* ignore */
  }
  console.log('CAPTURE_DONE', JSON.stringify(report.shots.map((s) => s.path)));
  await shutdown(0);
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[capture] shutdown 开始 code=${code} elapsed=${Date.now() - shutdownStartedAt}ms`);
  try {
    if (ipc && typeof ipc.dispose === 'function') ipc.dispose();
  } catch {
    /* ignore */
  }
  try {
    if (global.__FCA_CAPTURE_RUNTIME__) {
      await Promise.race([
        Promise.resolve(global.__FCA_CAPTURE_RUNTIME__.shutdownForQuit()),
        new Promise((resolve) => setTimeout(resolve, 15000)),
      ]);
    }
  } catch (error) {
    console.error('[capture] shutdown error', error && error.message);
  }
  try {
    await logger.flush();
  } catch {
    /* ignore */
  }
  console.log(`[capture] shutdown 完成 code=${code}`);
  app.exit(code);
}

process.on('uncaughtException', (error) => {
  console.error('[capture] uncaught error', error);
  shutdown(2);
});
process.on('unhandledRejection', (reason) => {
  console.error('[capture] unhandled rejection', reason);
  shutdown(2);
});

const overallTimer = setTimeout(() => {
  console.error('[capture] 超时（180s），退出');
  shutdown(3);
}, 180000);
if (overallTimer.unref) overallTimer.unref();

main().catch((error) => {
  console.error('[capture] 失败', error);
  shutdown(2);
});
