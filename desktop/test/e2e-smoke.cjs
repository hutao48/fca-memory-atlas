'use strict';

/**
 * FCA Memory Atlas — Desktop E2E 冒烟（真实 main.js + 真实 Runtime + WebGL 渲染进程）
 *
 * 覆盖 task-2 第 6 项：
 *   启动真实桌面应用（desktop/main/main.js，非 capture）→ 连接真实本地 Runtime →
 *   通过真实编辑器 UI 新建一条记忆 → 修改 UI 布局/画质 → 优雅退出 →
 *   重新启动 → 验证记忆数据、Runtime 布局坐标、UI 布局/画质从持久化状态恢复。
 *
 * 驱动方式：Electron `--remote-debugging-port` + Chrome DevTools Protocol（Runtime.evaluate），
 * 对页面执行真实的 DOM 点击 / 表单输入事件，不伪造数据、不直接写数据库。
 *
 * 用法（项目根）：
 *   Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
 *   & vendor\node\node.exe desktop\test\e2e-smoke.cjs
 *
 * 输出：
 *   artifacts/reports/desktop-e2e.md   （步骤 + 断言结果，供验收）
 *   .cache/desktop-e2e/e2e-result.json （原始结果）
 *   .cache/desktop-e2e/app-N-*.log     （应用 stdout/stderr）
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(ROOT, '.cache', 'electron-dist', 'electron.exe');
const NODE_BIN = path.join(ROOT, 'vendor', 'node', 'node.exe');
const RUNTIME_BIN = path.join(ROOT, 'runtime', 'bin', 'fca-runtime.js');
const E2E_DIR = path.join(ROOT, '.cache', 'desktop-e2e');
const HOME = path.join(ROOT, '.cache', 'desktop-e2e-home');
const USERDATA = path.join(E2E_DIR, 'userdata');
const LOGDIR = path.join(E2E_DIR, 'logs');
const SETTINGS_FILE = path.join(E2E_DIR, 'desktop-settings.json');
const REPORT_DIR = path.join(ROOT, 'artifacts', 'reports');
const REPORT_MD = path.join(REPORT_DIR, 'desktop-e2e.md');
const RESULT_JSON = path.join(E2E_DIR, 'e2e-result.json');
const PORT = 17862;
const CDP_PORT = 9333;

const steps = [];
const failures = [];
let appSeq = 0;
let currentChild = null;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function nowIso() { return new Date().toISOString(); }

function record(name, ok, detail) {
  const entry = { name, ok, detail: detail === undefined ? null : detail, at: nowIso() };
  steps.push(entry);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) failures.push(entry);
  return entry;
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function rmrf(target) {
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(ROOT) + path.sep)) throw new Error(`refuse to delete outside project: ${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true });
}

function runCli(args, label) {
  const res = spawnSync(NODE_BIN, [RUNTIME_BIN, ...args], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
  record(`runtime CLI ${label}`, res.status === 0, { status: res.status, args });
  return res.status;
}

/* ---------------------------------------------------------------- CDP ---- */
async function fetchJson(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForPageTarget(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    if (Array.isArray(list)) {
      const page = list.find((t) => t && t.type === 'page' && /renderer[\\/]index\.html/.test(String(t.url)));
      if (page && page.webSocketDebuggerUrl) return page;
    }
    await sleep(350);
  }
  throw new Error('等待渲染页面 CDP target 超时');
}

async function waitForCdpGone(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/list`, 800);
    if (!Array.isArray(list) || list.length === 0) return true;
    await sleep(300);
  }
  return false;
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;
    let closed = false;
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (!msg || !msg.id || !pending.has(msg.id)) return;
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(`CDP ${JSON.stringify(msg.error)}`));
      else res(msg.result);
    });
    ws.addEventListener('close', () => { closed = true; for (const { rej } of pending.values()) rej(new Error('CDP closed')); pending.clear(); });
    ws.addEventListener('error', (event) => { if (!closed) reject(new Error(`CDP websocket error: ${event.message || 'unknown'}`)); });
    ws.addEventListener('open', () => {
      resolve({
        async send(method, params) {
          const id = nextId++;
          const p = new Promise((res, rej) => pending.set(id, { res, rej }));
          ws.send(JSON.stringify({ id, method, params }));
          return p;
        },
        async evaluate(expression, opts = {}) {
          const result = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise: opts.awaitPromise !== false,
            returnByValue: true,
            userGesture: true,
          });
          if (result && result.exceptionDetails) {
            const desc = result.exceptionDetails.exception
              ? result.exceptionDetails.exception.description || result.exceptionDetails.exception.value
              : result.exceptionDetails.text;
            throw new Error(`页面脚本异常：${String(desc).slice(0, 800)}`);
          }
          return result && result.result ? result.result.value : undefined;
        },
        close() { try { ws.close(); } catch { /* ignore */ } },
      });
    });
  });
}

async function pollEval(cdp, expression, predicate, timeoutMs, label, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await cdp.evaluate(expression);
    } catch (error) {
      last = { error: String(error.message || error) };
    }
    if (predicate(last)) return last;
    await sleep(intervalMs);
  }
  throw new Error(`等待状态超时（${label}）：${JSON.stringify(last)}`);
}

const READY_EXPR = `(() => {
  if (!window.__FCA_APP__) return { hook: false, fatal: window.__FCA_FATAL__ || null };
  const a = window.__FCA_APP__;
  const s = a.getState();
  const graph = s.graph && s.graph.data;
  return {
    hook: true,
    ready: !!window.__FCA_READY__,
    fatal: s.app && s.app.fatalError ? s.app.fatalError.message : null,
    runtime: s.runtime && s.runtime.state,
    runtimeVersion: s.runtime && s.runtime.version,
    graphStatus: s.graph && s.graph.status,
    source: s.graph && s.graph.source,
    nodes: graph ? graph.nodes.length : 0,
    edges: graph ? graph.edges.length : 0,
    layoutVersion: s.graph && s.graph.layoutVersion,
    view: s.app.view,
    quality: s.ui && s.ui.quality,
    leftCollapsed: s.ui && s.ui.left && s.ui.left.collapsed,
    rightCollapsed: s.ui && s.ui.right && s.ui.right.collapsed,
    legendOpen: s.ui && s.ui.legendOpen,
    onboardingOpen: !!(s.onboarding && s.onboarding.open),
    dataDir: s.app && s.app.dataDir,
  };
})()`;

/* ------------------------------------------------------------ app launch ---- */
function launchApp(tag) {
  appSeq += 1;
  ensureDir(E2E_DIR);
  ensureDir(LOGDIR);
  const outPath = path.join(LOGDIR, `app-${appSeq}-${tag}-out.log`);
  const errPath = path.join(LOGDIR, `app-${appSeq}-${tag}-err.log`);
  const outFd = fs.openSync(outPath, 'a');
  const errFd = fs.openSync(errPath, 'a');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [
    '--remote-debugging-port=' + CDP_PORT,
    '--no-sandbox',
    '--disable-gpu-sandbox',
    'desktop/main/main.js',
    `--settings-file=${SETTINGS_FILE}`,
    `--user-data-dir=${USERDATA}`,
    `--fca-home=${HOME}`,
    `--port=${PORT}`,
  ];
  const child = spawn(ELECTRON, args, { cwd: ROOT, env, stdio: ['ignore', outFd, errFd], windowsHide: false });
  currentChild = child;
  child.stdout = null;
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return { child, tag, pid: child.pid, outPath, errPath };
}

function waitExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ exited: false, code: null }); } }, timeoutMs);
    child.once('exit', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exited: true, code, signal });
    });
  });
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null) return;
  try { child.kill(); } catch { /* ignore */ }
  await waitExit(child, 8000);
}

/* ---------------------------------------------------------------- report ---- */
function writeReport(result) {
  ensureDir(REPORT_DIR);
  ensureDir(E2E_DIR);
  fs.writeFileSync(RESULT_JSON, JSON.stringify(result, null, 2), 'utf8');
  const pass = steps.filter((s) => s.ok).length;
  const fail = steps.filter((s) => !s.ok).length;
  const lines = [];
  lines.push('# FCA Memory Atlas — Desktop 端到端冒烟报告');
  lines.push('');
  lines.push(`- 生成时间：${nowIso()}`);
  lines.push(`- 结论：**${fail === 0 ? 'PASS（全部断言通过）' : `FAIL（${fail} 项失败）`}** — ${pass} 通过 / ${fail} 失败`);
  lines.push(`- 应用入口：\`desktop/main/main.js\`（真实主进程，非 capture 脚本）`);
  lines.push(`- Electron：\`.cache/electron-dist/electron.exe\`（38.2.1）`);
  lines.push(`- 真实 Runtime：Node 24 + SQLite，127.0.0.1:${PORT}，FCA_HOME=\`.cache/desktop-e2e-home\``);
  lines.push(`- 隔离：Chromium userData=\`.cache/desktop-e2e/userdata\`，设置文件=\`.cache/desktop-e2e/desktop-settings.json\`（不污染真实用户配置）`);
  lines.push(`- 驱动：CDP \`--remote-debugging-port=${CDP_PORT}\` + Runtime.evaluate（真实 DOM 点击/表单 input 事件）`);
  lines.push('');
  lines.push('## 步骤与断言');
  lines.push('');
  lines.push('| # | 步骤 | 结果 | 证据 |');
  lines.push('|---|------|------|------|');
  steps.forEach((s, i) => {
    const detail = s.detail == null ? '' : (typeof s.detail === 'string' ? s.detail : JSON.stringify(s.detail));
    lines.push(`| ${i + 1} | ${s.name} | ${s.ok ? 'PASS' : 'FAIL'} | ${String(detail).replace(/\|/g, '\\|').slice(0, 300)} |`);
  });
  lines.push('');
  if (result.observations) {
    lines.push('## 关键观测');
    lines.push('');
    for (const [key, value] of Object.entries(result.observations)) {
      lines.push(`- **${key}**：${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
    lines.push('');
  }
  lines.push('## 复现方法');
  lines.push('');
  lines.push('```powershell');
  lines.push('cd D:\\FCA\\FCA-Memory-Atlas');
  lines.push('Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue');
  lines.push('& vendor\\node\\node.exe desktop\\test\\e2e-smoke.cjs');
  lines.push('```');
  lines.push('');
  lines.push('> 说明：本报告由真实桌面应用运行时输出；记忆通过编辑器表单 + 保存按钮写入真实 Runtime，');
  lines.push('> 重启后从 Runtime / SQLite 与桌面 localStorage 恢复，不存在任何伪造 DOM 或合成数据。');
  fs.writeFileSync(REPORT_MD, lines.join('\n') + '\n', 'utf8');
  console.log(`\n[e2e] 报告：${REPORT_MD}`);
}

/* ---------------------------------------------------------------- main ---- */
async function main() {
  console.log('[e2e] FCA Desktop 端到端冒烟开始');
  if (!fs.existsSync(ELECTRON)) throw new Error(`未找到 Electron：${ELECTRON}`);
  if (!fs.existsSync(NODE_BIN)) throw new Error(`未找到 Node：${NODE_BIN}`);

  // 清理隔离环境
  rmrf(E2E_DIR);
  rmrf(HOME);
  ensureDir(E2E_DIR);
  ensureDir(HOME);
  ensureDir(LOGDIR);

  // 1) 初始化真实 Runtime 数据目录（空库）
  runCli([`--fca-home=${HOME}`, `--port=${PORT}`, 'init'], 'init');
  const emptyDb = path.join(HOME, 'db', 'fca.db');
  record('真实 Runtime 空库已初始化', fs.existsSync(emptyDb), { db: path.relative(ROOT, emptyDb) });

  // 2) 写入隔离的桌面设置（不触碰真实用户配置）
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
    schemaVersion: 1,
    dataDir: HOME,
    port: PORT,
    runtimeUrl: null,
    autoStartRuntime: true,
    closeRuntimeOnExit: true,
    allowExternalRuntime: true,
    onboardingCompleted: true,
    quality: 'high',
    devFixtures: false,
  }, null, 2), 'utf8');

  // 3) 第一次启动
  const app1 = launchApp('first');
  record('第一次启动真实桌面应用', Boolean(app1.pid), { pid: app1.pid, log: path.relative(ROOT, app1.outPath) });
  const page1 = await waitForPageTarget();
  const cdp1 = await connectCdp(page1.webSocketDebuggerUrl);
  const ready1 = await pollEval(cdp1, READY_EXPR, (s) => s && s.hook && s.ready && s.graphStatus === 'ready', 60000, '应用首次就绪');
  record('渲染进程就绪且窗口已加载（window.__FCA_READY__）', true, { view: ready1.view, runtime: ready1.runtime });
  record('桌面已连接真实 Runtime（API v1 / running）', ready1.runtime === 'running' && Boolean(ready1.runtimeVersion), { runtime: ready1.runtime, version: ready1.runtimeVersion });
  record('空库初始状态无伪造节点（nodes=0, source=runtime）', ready1.nodes === 0 && ready1.source === 'runtime', { nodes: ready1.nodes, edges: ready1.edges, source: ready1.source });

  // 4) 通过真实编辑器 UI 新建记忆
  await cdp1.evaluate("window.fcaApp.actions.openEditor(); 'open-editor'");
  await pollEval(cdp1, "(() => (window.__FCA_APP__.getState().app.view))()", (v) => v === 'editor', 15000, '进入编辑器视图');
  record('从应用内动作打开编辑器视图', true, { view: 'editor' });

  const fillResult = await cdp1.evaluate(`(() => {
    const setNativeValue = (el, value) => {
      if (!el) return false;
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value); else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const title = document.querySelector('[data-testid="editor-title"]');
    const body = document.querySelector('[data-testid="editor-body"]');
    if (!title || !body) return { ok: false, reason: 'form-not-found' };
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    setNativeValue(title, 'E2E 冒烟：真实桌面新建记忆 ' + stamp);
    setNativeValue(body, '这条记忆由 desktop/test/e2e-smoke.cjs 通过真实编辑器表单 + 保存按钮写入本地 Runtime。\\n用途：验证启动 → 连接真实 Runtime → 新建记忆 → 关闭 → 重开后的数据与布局恢复。');
    // 发生时间精度设为「时间未知」，让表单在没有具体时间时也能通过校验（真实用户操作路径）
    const precisionSelect = document.querySelector('[data-testid="editor-precision"]');
    if (precisionSelect) {
      const proto = Object.getPrototypeOf(precisionSelect);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(precisionSelect, 'unknown'); else precisionSelect.value = 'unknown';
      precisionSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const pick = (sel) => document.querySelector(sel);
    return {
      ok: true,
      title: title.value,
      bodyLen: body.value.length,
      precision: precisionSelect ? precisionSelect.value : null,
      hasErrorHint: Boolean(pick('[data-testid="editor-error-date"]')),
    };
  })()`);
  record('在编辑器表单中填写标题与正文（真实 input 事件）', Boolean(fillResult && fillResult.ok), fillResult);

  await cdp1.evaluate(
    "(() => { const b = document.querySelector('[data-testid=\"editor-save\"]'); window.__E2E_SAVE_BTN__ = Boolean(b); b.addEventListener('click', () => { window.__E2E_CLICKED__ = (window.__E2E_CLICKED__ || 0) + 1; }); b.click(); return 'save-clicked'; })()",
  );
  await sleep(2500);
  const saveDiag = await cdp1.evaluate(`(async () => {
    const s = window.fcaApp.store.getState();
    let bridgeOk = null;
    try {
      const res = await window.fca.net.request({ method: 'GET', path: '/api/v1/state', timeoutMs: 4000 });
      bridgeOk = { ok: Boolean(res && res.ok), status: res && res.status, code: res && res.error && res.error.code };
    } catch (e) { bridgeOk = { error: String(e && e.message) }; }
    const notifications = (s.notifications || []).slice(-6).map((n) => ({ type: n.type, message: n.message }));
    const toasts = (s.ui && s.ui.toasts ? s.ui.toasts : []).slice(-6).map((t) => ({ type: t.type, message: t.message }));
    return {
      clicked: window.__E2E_CLICKED__ || 0,
      saveBtnExists: window.__E2E_SAVE_BTN__,
      view: s.app.view,
      nodes: s.graph && s.graph.data ? s.graph.data.nodes.length : null,
      notifications,
      toasts,
      bridgeOk,
      bodyTail: String(document.body.innerText || '').slice(-1200),
    };
  })()`);
  console.log('[e2e] save 诊断：' + JSON.stringify(saveDiag));
  record('点击编辑器「保存」按钮（触发 POST /api/v1/memories）', Boolean(saveDiag && saveDiag.clicked > 0), saveDiag);
  const createdProbe = await pollEval(
    cdp1,
    `(() => {
      const g = window.__FCA_APP__.getGraph();
      const node = g && g.nodes.find((n) => n.kind === 'memory' && typeof n.label === 'string' && n.label.indexOf('E2E 冒烟') === 0);
      const s = window.fcaApp.store.getState();
      const saveBtn = document.querySelector('[data-testid="editor-save"]');
      const toasts = [...document.querySelectorAll('[class*="toast"], .fca-toast')].map((t) => String(t.textContent || '').trim()).filter(Boolean).slice(-4);
      const errBox = document.querySelector('[data-testid="editor-error"]');
      return {
        node: node ? { id: node.id, label: node.label, importance: node.importance, position: node.position, occurredAt: node.occurred_at } : null,
        diag: {
          view: s.app.view,
          nodes: g ? g.nodes.length : null,
          graphStatus: s.graph && s.graph.status,
          titleValue: (document.querySelector('[data-testid="editor-title"]') || {}).value || null,
          saveBtnExists: Boolean(saveBtn),
          saveDisabled: saveBtn ? Boolean(saveBtn.disabled) : null,
          toasts,
          errorText: errBox ? String(errBox.textContent || '').trim() : null,
        },
      };
    })()`,
    (v) => Boolean(v && v.node && v.node.id),
    25000,
    '新建记忆写入图谱',
  );
  const created = createdProbe.node;
  if (!created) throw new Error(`新建记忆未出现在图谱：${JSON.stringify(createdProbe && createdProbe.diag)}`);
  record('新建记忆已写入真实 Runtime 并出现在图谱（GET /api/v1/graph）', true, { id: created.id, label: created.label, position: created.position, diag: createdProbe.diag });

  // 5) 修改 UI 布局/画质（验证重启恢复）
  const beforeUi = await cdp1.evaluate(`(() => {
    window.__FCA_APP__.navigate('atlas');
    window.__FCA_APP__.setQuality('medium');
    document.getElementById('btn-collapse-left').click();
    window.fcaApp.actions.persistUiLayout();
    return new Promise((resolve) => setTimeout(() => {
      const s = window.fcaApp.store.getState();
      resolve({
        quality: s.ui.quality,
        leftCollapsed: s.ui.left.collapsed,
        layoutRaw: localStorage.getItem('fca.ui.layout.v1'),
        qualityRaw: localStorage.getItem('fca.ui.quality'),
      });
    }, 700));
  })()`);
  record('关闭前修改 UI 状态：画质=medium、左栏收起', beforeUi.quality === 'medium' && beforeUi.leftCollapsed === true, beforeUi);

  // 6) 优雅退出
  try {
    await cdp1.evaluate("window.fca.app.quit(); 'quitting'");
  } catch (error) {
    record('调用应用退出（IPC fca:app:quit）', false, String(error.message || error));
  }
  const exit1 = await waitExit(app1.child, 30000);
  const clean1 = exit1.exited && (exit1.code === 0 || exit1.code === null);
  record('第一次退出完成（优雅退出，进程结束）', clean1, exit1);
  cdp1.close();
  await waitForCdpGone(15000);

  // 7) 第二次启动（同一隔离 userData / 设置 / Runtime 数据目录）
  const app2 = launchApp('second');
  record('第二次启动真实桌面应用', Boolean(app2.pid), { pid: app2.pid, log: path.relative(ROOT, app2.outPath) });
  const page2 = await waitForPageTarget();
  const cdp2 = await connectCdp(page2.webSocketDebuggerUrl);
  const ready2 = await pollEval(cdp2, READY_EXPR, (s) => s && s.hook && s.ready && s.graphStatus === 'ready', 60000, '应用二次就绪');
  record('重开后渲染进程就绪且连接真实 Runtime', ready2.runtime === 'running' && ready2.graphStatus === 'ready', { runtime: ready2.runtime, view: ready2.view });

  const reopened = await pollEval(
    cdp2,
    `(() => {
      const g = window.__FCA_APP__.getGraph();
      const node = g && g.nodes.find((n) => n.id === ${JSON.stringify(created.id)});
      const s = window.fcaApp.store.getState();
      return {
        node: node ? { id: node.id, label: node.label, position: node.position, layoutVersion: window.__FCA_APP__.getState().graph.layoutVersion } : null,
        nodes: g ? g.nodes.length : 0,
        edges: g ? g.edges.length : 0,
        quality: s.ui.quality,
        leftCollapsed: s.ui.left.collapsed,
        localStorageLayout: localStorage.getItem('fca.ui.layout.v1'),
        onboardingOpen: !!(s.onboarding && s.onboarding.open),
      };
    })()`,
    (v) => Boolean(v && v.node),
    25000,
    '重开后的记忆节点',
  );
  record('重开后记忆数据仍在（同一 id/label 来自真实 Runtime）', reopened.node.id === created.id && reopened.node.label === created.label, { id: reopened.node.id, label: reopened.node.label });
  record('重开后布局坐标从 Runtime 恢复且与关闭前一致', JSON.stringify(reopened.node.position) === JSON.stringify(created.position), { before: created.position, after: reopened.node.position });
  record('重开后 UI 画质设置从 localStorage 恢复（medium）', reopened.quality === 'medium', { quality: reopened.quality });
  record('重开后左栏收起状态从 localStorage 恢复', reopened.leftCollapsed === true, { leftCollapsed: reopened.leftCollapsed, layoutRaw: reopened.localStorageLayout });
  record('重开后未出现首次启动向导（onboardingCompleted 持久化生效）', reopened.onboardingOpen === false, { onboardingOpen: reopened.onboardingOpen });

  // 8) 关闭第二次实例并清理 Runtime
  try { await cdp2.evaluate("window.fca.app.quit(); 'quitting'"); } catch { /* ignore */ }
  const exit2 = await waitExit(app2.child, 30000);
  record('第二次退出完成', exit2.exited, exit2);
  cdp2.close();
  await waitForCdpGone(8000);
  // Runtime 若因设置未随退出关闭，这里兜底停止（记录真实状态，不掩盖问题）
  runCli([`--fca-home=${HOME}`, `--port=${PORT}`, 'stop'], 'stop');
  runCli([`--fca-home=${HOME}`, `--port=${PORT}`, 'status'], 'status');

  const result = {
    ok: failures.length === 0,
    finishedAt: nowIso(),
    port: PORT,
    steps,
    observations: {
      '隔离数据目录': path.relative(ROOT, HOME),
      '隔离 userData': path.relative(ROOT, USERDATA),
      '新建记忆 id': created.id,
      '新建记忆标题': created.label,
      '关闭前印象': { quality: beforeUi.quality, leftCollapsed: beforeUi.leftCollapsed },
      '重开后状态': { nodes: reopened.nodes, edges: reopened.edges, layoutVersion: reopened.node.layoutVersion },
      'UI 持久化原始值': { quality: beforeUi.qualityRaw, layout: beforeUi.layoutRaw },
      '应用日志': path.relative(ROOT, LOGDIR),
    },
  };
  writeReport(result);
  if (!result.ok) {
    console.error(`[e2e] FAIL：${failures.length} 项断言失败`);
    process.exitCode = 1;
  } else {
    console.log('[e2e] PASS：全部断言通过');
  }
}

main().catch(async (error) => {
  console.error('[e2e] 异常终止：', error && error.stack ? error.stack : error);
  record('E2E 执行异常终止', false, String(error && error.message ? error.message : error));
  await terminateChild(currentChild);
  try {
    runCli([`--fca-home=${HOME}`, `--port=${PORT}`, 'stop'], 'stop-after-failure');
  } catch { /* ignore */ }
  writeReport({ ok: false, finishedAt: nowIso(), steps, error: String(error && error.message ? error.message : error) });
  process.exitCode = 1;
});
