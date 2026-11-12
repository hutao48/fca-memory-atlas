/**
 * FCA Memory Atlas — 星云画布视图（views/atlas.js）
 *
 * 数据：GET /api/v1/graph（真实 Runtime 数据；dev fixture 仅开发期兜底并明确标注）
 * 渲染：
 *  - 默认 nebulaEngine=unity：星云由 Unity standalone 独立窗口渲染（desktop/main/unity-viewer.js 拉起），
 *    本视图显示 “Unity 星云” 状态卡（打开/关闭/运行状态/失败信息）+ 图例/图层/映射说明；
 *  - Unity exe 缺失、启动失败或被关闭时自动回退 WebGL 星云（renderer/nebula/index.js），
 *    回退路径使用同一份真实 Runtime 数据，不阻塞其它功能；
 *  - 设置项 nebulaEngine（unity|webgl）持久化在 desktop settings，默认 unity。
 * 交互：节点选择 → 详情面板；拖拽 → POST /layout/nodes；自动布局/恢复布局；筛选/图例/图层/画质；
 *       聚类星域模式；映射说明；缩放控制（Unity 模式下由 Unity 窗口自身交互）。
 */

import { icon } from '../ui/icons.js';
import {
  UNITY_SELECT_MESSAGE,
  UNITY_COMMAND_ACK_MESSAGE,
  buildUnityCommandMessage,
  buildUnitySelectCommand,
  parseUnitySelectMessage,
  shouldAcceptUnitySelection,
} from '../lib/unity-selection.js';

export const meta = { id: 'atlas', title: '星云总览', icon: 'compass', order: 10, nav: true };

const CLUSTER_COLORS = {
  cyan: '#7fd8e8',
  blue: '#6f9fe8',
  violet: '#a08cf0',
  magenta: '#d47fd0',
  rose: '#e08f9f',
  gold: '#d8b978',
  white: '#dfe8f2',
};

const QUALITY_LEVELS = ['ultra', 'high', 'medium', 'low', 'off'];

const UNITY_USER_CLOSED_KEY = 'fca.unity.userClosed';
const UNITY_FALLBACK_KEY = 'fca.unity.fallbackReason';
const UNITY_AUTO_OPENED_KEY = 'fca.unity.autoOpened';

export function createView(ctx) {
  const { api, store, events, ui: kit, format, toast, commands, actions, log } = ctx;

  let root = null;
  let canvasHost = null;
  let instance = null;
  let usingDevStub = false;
  let mode = 'overview';
  let clusterFocusId = null;
  let camera = { center: [0, 0, 0], zoom: 1 };
  let statsTimer = null;
  let lastGraph = null;
  let filteredGraph = null;
  let hoverLabelEl = null;
  let disposed = false;
  const unsubs = [];
  const dom = {};

  // 星云引擎（unity = Unity WebGL 内嵌 iframe；webgl = 内置 WebGL2 回退）
  let engine = 'webgl'; // 当前实际渲染引擎
  let unityStatus = null; // 主进程 unity-embed 状态快照
  let unityFrameUrl = null; // 含 token，仅保存在闭包，不写日志/全局状态
  let unityBusy = false;
  let unitySubscribed = false;
  let unityFallbackActive = false;
  let unityFrameLoaded = false;
  let unityAssetsSeen = false;
  let unityMessageSeen = false;
  let unityStartAt = 0;
  let unityPollTimer = null;
  let toastShownSample = false;
  // Unity ↔ Electron 选中同步状态（防回声/去重/节流；用于右栏详情联动）
  let unitySelectionSync = {
    lastSentCommand: null,
    lastSentAt: 0,
    lastAcceptedId: null,
    lastAcceptedAt: 0,
    lastAck: null,
    lastIncomingId: null,
    pendingReplay: false,
    ignoredCount: 0,
    acceptedCount: 0,
  };

  // ------------------------------------------------------------- lifecycle
  async function mount(container) {
    root = kit.el('div', { class: 'view-atlas' });
    canvasHost = kit.el('div', { class: 'atlas-canvas', 'data-nebula-host': '1' });
    root.appendChild(canvasHost);
    buildOverlays();
    container.appendChild(root);

    const params = ctx.router.params;
    mode = params.get('mode') === 'clusters' ? 'clusters' : 'overview';
    renderModeSwitch();

    subscribeStore();
    subscribeEvents();
    subscribeUnityEvents();
    // 初始化 Unity↔Electron 选中同步调试钩子（CDP 验收用）
    updateUnitySelectionGlobal();
    // 先向主进程查询 Unity 渲染器状态（exe 是否存在/是否在运行），再决定默认引擎：
    // 设置 nebulaEngine=unity 且 exe 可用 → Unity；否则 WebGL 回退（并在视图中明确提示）。
    await refreshUnityStatus();
    // 本次窗口会话内曾经回退过（Unity 被关闭/崩溃）且当前没有运行中的 Unity → 保持 WebGL
    unityFallbackActive = Boolean(storedReason(UNITY_FALLBACK_KEY)) && !(unityStatus && unityStatus.running);
    await applyEngine({ force: true, reason: 'mount' });
    applyGraphFromStore();
    // 初始数据可能在 mount 前已加载
    if (store.getState().graph.data) applyGraph();
    updatePill();
    renderLayoutPreset();
  }

  function unmount() {
    disposed = true;
    for (const off of unsubs.splice(0)) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    destroyNebula();
    stopUnityPolling();
    window.__FCA_NEBULA__ = null;
    window.__FCA_NEBULA_STATS__ = null;
    if (hoverLabelEl) {
      hoverLabelEl.remove();
      hoverLabelEl = null;
    }
    root.remove();
    root = null;
  }

  function activate() {
    updateHud();
    updateEngineUi();
    // 视图重新激活时同步一次 Unity 运行状态（窗口可能在其它视图期间被关闭/崩溃）
    refreshUnityStatus()
      .then(() => applyEngine({ reason: 'activate' }))
      .catch(() => {});
  }

  function deactivate() {
    /* 保留实例；切回时无需重建 */
  }

  function handleCommand(command, payload) {
    if (command === 'route:params') {
      const params = payload;
      const nextMode = params && params.get && params.get('mode') === 'clusters' ? 'clusters' : 'overview';
      if (nextMode !== mode) {
        mode = nextMode;
        renderModeSwitch();
        renderClusterBar();
        renderLegend();
        applyMapping();
      }
      return true;
    }
    if (command === 'view:fit') {
      fitToContent();
      return true;
    }
    if (command === 'view:toggle-legend') {
      toggleLegend();
      return true;
    }
    if (command === 'view:cycle-quality') {
      const current = store.getState().ui.quality;
      const next = QUALITY_LEVELS[(QUALITY_LEVELS.indexOf(current) + 1) % QUALITY_LEVELS.length];
      actions.setQuality(next);
      return true;
    }
    if (command === 'esc') {
      actions.clearSelection();
      if (instance) instance.select([]);
      clusterFocusId = null;
      renderClusterBar();
      renderLegend();
      return true;
    }
    if (command === 'view:refresh') {
      actions.refreshGraph();
      return true;
    }
    if (command === 'memory:focus') {
      // 由 app actions.openMemory 的 focus 行为触发
      return true;
    }
    if (command === 'focus-node' && payload && payload.id) {
      focusNode(payload.id, payload.depth || 1);
      return true;
    }
    if (command === 'view:open-unity' || command === 'view:reload-unity') {
      if (command === 'view:reload-unity') reloadUnity();
      else startUnity();
      return true;
    }
    if (command === 'view:close-unity') {
      stopUnity({ reason: 'menu' });
      return true;
    }
    if (command === 'view:toggle-unity') {
      switchEngine(engine === 'unity' ? 'webgl' : 'unity');
      return true;
    }
    if (command === 'view:unity-logs') {
      showUnityLogs();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------- DOM
  function buildOverlays() {
    // 左上：模式切换
    dom.modeSwitch = kit.el('div', { class: 'atlas-mode-switch' });
    const topLeft = kit.el('div', { class: 'atlas-overlay atlas-overlay--top-left' }, [dom.modeSwitch]);
    root.appendChild(topLeft);

    // 右上：缩放/布局/图层工具条
    dom.engineBtn = kit.button({ label: 'WebGL', icon: 'grid', variant: 'ghost', size: 'sm', title: '星云渲染引擎（Unity / WebGL）', onClick: (event) => openEngineMenu(event.currentTarget) });
    dom.engineBtn.classList.add('atlas-engine-btn');
    dom.zoomIn = kit.iconButton({ icon: 'zoom-in', label: '放大', size: 'sm', onClick: () => zoomBy(1.22) });
    dom.zoomOut = kit.iconButton({ icon: 'zoom-out', label: '缩小', size: 'sm', onClick: () => zoomBy(1 / 1.22) });
    dom.fitBtn = kit.iconButton({ icon: 'fit', label: '适应屏幕 (F)', size: 'sm', onClick: () => fitToContent() });
    dom.autoLayoutBtn = kit.button({ label: '自动布局', icon: 'activity', variant: 'ghost', size: 'sm', onClick: () => autoLayout() });
    dom.resetLayoutBtn = kit.button({ label: '恢复布局', icon: 'restore', variant: 'ghost', size: 'sm', onClick: () => resetLayout() });
    dom.layersBtn = kit.iconButton({ icon: 'layers', label: '图层控制', size: 'sm', onClick: (event) => openLayersMenu(event.currentTarget) });
    dom.legendBtn = kit.iconButton({ icon: 'legend', label: '图例与映射 (L)', size: 'sm', onClick: () => toggleLegend() });
    const toolbar = kit.el('div', { class: 'atlas-toolbar' }, [
      dom.engineBtn,
      kit.el('span', { class: 'atlas-toolbar__divider' }),
      dom.zoomIn,
      dom.zoomOut,
      dom.fitBtn,
      kit.el('span', { class: 'atlas-toolbar__divider' }),
      dom.autoLayoutBtn,
      dom.resetLayoutBtn,
      kit.el('span', { class: 'atlas-toolbar__divider' }),
      dom.layersBtn,
      dom.legendBtn,
    ]);
    dom.statePill = kit.el('span', { class: 'atlas-state-pill' }, [kit.statusDot('stopped'), kit.el('span', { text: '未连接' })]);
    dom.enginePill = kit.el('span', { class: 'atlas-state-pill atlas-engine-pill', title: '当前星云渲染引擎' }, [kit.statusDot('stopped'), kit.el('span', { text: 'WebGL' })]);
    root.appendChild(kit.el('div', { class: 'atlas-overlay atlas-overlay--top-right' }, [toolbar, dom.statePill, dom.enginePill]));

    // 底部中间：聚类选择条（聚类模式）
    dom.clusterBar = kit.el('div', { class: 'atlas-cluster-bar', hidden: true });
    root.appendChild(kit.el('div', { class: 'atlas-overlay atlas-overlay--bottom-center' }, [dom.clusterBar]));

    // 左下：图例
    dom.legend = kit.el('div', { class: 'atlas-legend', hidden: !store.getState().ui.legendOpen });
    root.appendChild(kit.el('div', { class: 'atlas-overlay atlas-overlay--bottom-left' }, [dom.legend]));

    // 右下：性能 HUD
    dom.hud = kit.el('div', { class: 'atlas-hud' });
    root.appendChild(kit.el('div', { class: 'atlas-overlay atlas-overlay--bottom-right' }, [dom.hud]));

    // dev fixture 标注
    dom.devBanner = kit.el('div', { class: 'atlas-dev-banner', hidden: true }, [icon('alert', { size: 12 }), kit.el('span', { text: '开发夹具数据（DEV-ONLY，非真实 Runtime 数据）' })]);
    root.appendChild(dom.devBanner);

    // Unity 回退提示条（Unity 不可用/被关闭/崩溃时显示，明确告知已回退 WebGL）
    dom.unityBanner = kit.el('div', { class: 'atlas-unity-banner', hidden: true });
    root.appendChild(dom.unityBanner);

    // Unity 星云（WebGL 内嵌）：iframe 容器（由主进程本地静态服务提供）
    dom.unityLayer = kit.el('div', { class: 'atlas-unity-layer', hidden: true });
    dom.unityFrame = kit.el('iframe', { class: 'atlas-unity-frame', title: 'Unity 星云（WebGL 内嵌）' });
    dom.unityFrame.setAttribute('allowfullscreen', 'true');
    // 说明：Unity 2022 WebGL 在 Chromium sandboxed iframe 下无法可靠初始化（wasm/索引缓存受阻），
    // 因此不设置 sandbox 属性；iframe 为**跨源**（http://127.0.0.1:<随机端口> vs file:// shell），
    // 无法访问 Electron shell 的 DOM/localStorage，只能通过 postMessage 通信；静态服务只读且仅本机回环。
    // 另见：父页面 CSP 仅额外放行 frame-src http://127.0.0.1:*，脚本仍来自受信本地静态服务。
    dom.unityOverlay = kit.el('div', { class: 'atlas-unity-overlay', hidden: true });
    dom.unityLayer.append(dom.unityFrame, dom.unityOverlay);
    root.appendChild(dom.unityLayer);

    // 状态卡（加载/空/错误/离线）
    dom.statusLayer = kit.el('div', { class: 'atlas-status', hidden: true });
    root.appendChild(dom.statusLayer);

    // 悬停标签（辅助，不干扰渲染器）
    hoverLabelEl = kit.el('div', { class: 'atlas-toolbar__label', style: { position: 'absolute', left: '12px', bottom: '12px', pointerEvents: 'none', display: 'none' } });
    root.appendChild(hoverLabelEl);
  }

  function renderModeSwitch() {
    if (!dom.modeSwitch) return;
    dom.modeSwitch.innerHTML = '';
    const items = [
      { id: 'overview', label: '总览', icon: 'compass' },
      { id: 'clusters', label: '聚类', icon: 'sparkles' },
    ];
    for (const item of items) {
      const btn = kit.el('button', { class: `atlas-mode-switch__item${mode === item.id ? ' is-active' : ''}`, type: 'button', title: item.label }, [
        icon(item.icon, { size: 13 }),
        kit.el('span', { text: item.label }),
      ]);
      btn.addEventListener('click', () => switchMode(item.id));
      dom.modeSwitch.appendChild(btn);
    }
    renderClusterBar();
  }

  function switchMode(nextMode) {
    if (mode === nextMode) return;
    mode = nextMode;
    renderModeSwitch();
    renderClusterBar();
    renderLegend();
    applyMapping();
    ctx.router.navigate('atlas', nextMode === 'clusters' ? { mode: 'clusters' } : {});
    if (nextMode === 'overview') {
      clusterFocusId = null;
      if (instance) instance.select(store.getState().selection.ids);
      actions.clearSelection();
    }
  }

  // ------------------------------------------------------------- 状态卡
  function setStatusLayer(kind, payload = {}) {
    const layer = dom.statusLayer;
    if (!layer) return;
    // Unity 模式下星云由独立窗口渲染：只保留“图谱加载错误”这类关键信息，
    // 避免与 Unity 状态卡叠加；空库/离线/加载中等提示由 Unity 窗口自身 HUD 呈现。
    if (engine === 'unity' && kind && kind !== 'error') {
      layer.hidden = true;
      layer.innerHTML = '';
      return;
    }
    if (!kind) {
      layer.hidden = true;
      layer.innerHTML = '';
      return;
    }
    layer.hidden = false;
    layer.innerHTML = '';
    const card = kit.el('div', { class: 'atlas-status__card' });
    if (kind === 'loading') {
      card.append(
        kit.el('div', { class: 'atlas-status__orb' }),
        kit.el('div', { class: 'atlas-status__title', text: '正在构建星图…' }),
        kit.el('div', { class: 'atlas-status__desc', text: '读取本地 Runtime 的图谱与布局数据（GET /api/v1/graph）。' }),
        kit.spinner({ label: '加载中' }),
      );
    } else if (kind === 'empty') {
      card.append(
        kit.el('div', { class: 'atlas-status__orb' }),
        kit.el('div', { class: 'atlas-status__title', text: '空白星图' }),
        kit.el('div', { class: 'atlas-status__desc', text: '当前记忆库是空的——这是真实的深空背景，没有显示任何伪造数据。创建第一条记忆，它会在这里成为一颗星。' }),
        kit.el('div', { class: 'atlas-status__actions' }, [
          kit.button({ label: '创建第一条记忆', icon: 'plus', variant: 'primary', onClick: () => actions.openEditor() }),
          kit.button({ label: '导入 FCA 数据', icon: 'import', variant: 'secondary', onClick: () => events.emit('menu:command', { command: 'data:import' }) }),
          kit.button({ label: '刷新', icon: 'refresh', variant: 'ghost', onClick: () => actions.refreshGraph() }),
        ]),
        kit.el('div', { class: 'atlas-status__hint', text: `数据目录：${store.getState().app.dataDir || '—'}` }),
      );
    } else if (kind === 'filtered') {
      card.append(
        kit.el('div', { class: 'atlas-status__orb' }),
        kit.el('div', { class: 'atlas-status__title', text: '筛选后没有星体' }),
        kit.el('div', { class: 'atlas-status__desc', text: '当前分类/标签/项目/时间筛选条件下没有匹配的节点。清除筛选即可恢复完整星图。' }),
        kit.el('div', { class: 'atlas-status__actions' }, [
          kit.button({
            label: '清除筛选',
            icon: 'close',
            variant: 'primary',
            onClick: () => actions.setFilters({ types: [], tags: [], projects: [], timeRange: { preset: 'all', from: null, to: null }, onlyFavorites: false }),
          }),
          kit.button({ label: '刷新图谱', icon: 'refresh', variant: 'ghost', onClick: () => actions.refreshGraph() }),
        ]),
      );
    } else if (kind === 'error') {
      const error = payload.error || {};
      card.append(
        kit.el('div', { class: 'atlas-status__orb atlas-status__orb--error' }),
        kit.el('div', { class: 'atlas-status__title', text: '无法加载图谱' }),
        kit.el('div', { class: 'atlas-status__desc', text: error.message || 'Runtime 未连接或返回错误。' }),
        error.traceId ? kit.el('div', { class: 'atlas-status__hint', text: `trace id：${error.traceId}` }) : null,
        kit.el('div', { class: 'atlas-status__actions' }, [
          kit.button({ label: '重试', icon: 'refresh', variant: 'primary', onClick: () => actions.refreshGraph() }),
          kit.button({ label: '查看运行时状态', icon: 'activity', variant: 'secondary', onClick: () => actions.openRuntimeStatus && actions.openRuntimeStatus() }),
        ]),
      );
    } else if (kind === 'offline') {
      card.append(
        kit.el('div', { class: 'atlas-status__orb' }),
        kit.el('div', { class: 'atlas-status__title', text: '本地 Runtime 未运行' }),
        kit.el('div', { class: 'atlas-status__desc', text: '星图数据来自本机 Runtime（127.0.0.1:17860）。启动后即可看到真实记忆星图。' }),
        payload.error ? kit.el('div', { class: 'atlas-status__hint', text: payload.error }) : null,
        kit.el('div', { class: 'atlas-status__actions' }, [
          kit.button({ label: '启动本地 Runtime', icon: 'play', variant: 'primary', onClick: () => actions.startRuntime && actions.startRuntime() }),
          kit.button({ label: '打开首次启动向导', icon: 'sparkles', variant: 'secondary', onClick: () => ctx.shell.showOnboarding() }),
          kit.button({ label: '刷新', icon: 'refresh', variant: 'ghost', onClick: () => actions.refreshGraph() }),
        ]),
      );
    }
    layer.appendChild(card);
  }

  // ------------------------------------------------- Unity WebGL 内嵌引擎
  // 设计（Lead 2026-11-12 新要求）：
  //  - 默认 nebulaEngine=unity：Unity WebGL 构建（artifacts/unity/FCANebulaWebGL）由主进程本地静态服务
  //    （127.0.0.1 随机端口）提供，atlas 视图用 iframe 内嵌渲染；不再启动独立 Unity 窗口。
  //  - iframe URL 由主进程生成：?runtime-url=<runtime>&token=<bearer>&quality=<q>&poll=2
  //    token 只在本地 URL 中（随机端口、不落日志、不写入 window 全局状态）。
  //  - Unity 侧通过 postMessage({type:'fca-unity-ready'}) 通知“已连上真实数据”；未提供时用
  //    “静态资源加载完成 + 等待”启发式判定并撤掉加载覆盖层。
  //  - WebGL 构建缺失/服务失败/加载超时 → 自动回退内置 WebGL2 星云（同一份真实数据），顶部提示条说明。

  const UNITY_READY_MESSAGE = 'fca-unity-ready';
  const UNITY_STATUS_MESSAGE = 'fca-unity-status';
  const UNITY_LOAD_TIMEOUT_MS = 60000;
  const UNITY_READY_GRACE_MS = 4000;

  function unityBridge() {
    return window.fca && window.fca.isElectron && window.fca.unity ? window.fca.unity : null;
  }

  function requestedEngine() {
    const settings = store.getState().settings || {};
    return settings.nebulaEngine === 'webgl' ? 'webgl' : 'unity';
  }

  function unityUsable() {
    return Boolean(unityStatus && unityStatus.available);
  }

  function storedReason(key) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function setStored(key, value) {
    try {
      if (value === null || value === undefined) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, String(value));
    } catch {
      /* ignore */
    }
  }

  /** 去掉 URL 中的 token，仅用于日志/全局状态/截图，不用于 iframe src */
  function sanitizeFrameUrl(url) {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      if (parsed.searchParams.has('token')) parsed.searchParams.set('token', '[redacted]');
      return parsed.toString();
    } catch {
      return null;
    }
  }

  function updateUnityGlobals() {
    window.__FCA_NEBULA_ENGINE__ = engine;
    window.__FCA_UNITY_STATUS__ = unityStatus
      ? {
          available: Boolean(unityStatus.available),
          mode: unityStatus.mode || 'embedded-webgl',
          state: unityStatus.state,
          running: Boolean(unityStatus.running),
          dir: unityStatus.dir || null,
          source: unityStatus.source || null,
          port: unityStatus.port || null,
          quality: unityStatus.quality || null,
          stats: unityStatus.stats || null,
          frameUrl: sanitizeFrameUrl(unityStatus.frameUrl),
          iframeReady: unityMessageSeen || (unityFrameLoaded && unityAssetsSeen),
          lastError: unityStatus.lastError || null,
        }
      : null;
  }

  async function refreshUnityStatus() {
    const bridge = unityBridge();
    if (!bridge) {
      unityStatus = {
        available: false,
        mode: 'embedded-webgl',
        state: 'unavailable',
        running: false,
        searched: [],
        message: '当前环境未提供 Unity 集成（需要 Electron 桌面版）',
        logTail: [],
      };
      updateUnityGlobals();
      return unityStatus;
    }
    try {
      unityStatus = await bridge.getStatus();
    } catch (error) {
      unityStatus = {
        available: false,
        mode: 'embedded-webgl',
        state: 'error',
        running: false,
        searched: [],
        message: `读取 Unity 状态失败：${error.message}`,
        logTail: [],
      };
    }
    updateUnityGlobals();
    return unityStatus;
  }

  function subscribeUnityEvents() {
    if (unitySubscribed) return;
    const bridge = unityBridge();
    if (!bridge) return;
    unitySubscribed = true;
    unsubs.push(bridge.onStatus((status) => onUnityStatus(status, 'status')));
    if (typeof bridge.onCrash === 'function') unsubs.push(bridge.onCrash((status) => onUnityStatus(status, 'crash')));
    window.addEventListener('message', onUnityMessage);
    unsubs.push(() => window.removeEventListener('message', onUnityMessage));
  }

  function onUnityMessage(event) {
    if (disposed || !dom.unityFrame) return;
    if (event.source !== dom.unityFrame.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    const payload = data.payload && typeof data.payload === 'object' ? data.payload : data;
    if (data.type === UNITY_SELECT_MESSAGE) {
      handleUnitySelection(data);
      return;
    }
    if (data.type === UNITY_COMMAND_ACK_MESSAGE) {
      unitySelectionSync.lastAck = { command: data.command || (payload && payload.command) || null, ok: payload.ok !== false, at: Date.now() };
      updateUnitySelectionGlobal();
      return;
    }
    if (data.type === UNITY_READY_MESSAGE) {
      unityMessageSeen = true;
      unityFrameLoaded = true;
      const stats = {
        ...(unityStatus && unityStatus.stats ? unityStatus.stats : {}),
        assetsLoaded: true,
      };
      if (Number.isFinite(Number(payload.nodes))) stats.nodes = Number(payload.nodes);
      if (Number.isFinite(Number(payload.edges))) stats.edges = Number(payload.edges);
      if (Number.isFinite(Number(payload.arms))) stats.arms = Number(payload.arms);
      if (payload.armSummary) stats.armSummary = String(payload.armSummary);
      if (payload.layout) stats.layoutSignature = String(payload.layout);
      if (payload.quality) stats.quality = String(payload.quality);
      unityStatus = {
        ...(unityStatus || {}),
        stats,
        connected: payload.connected !== false,
        sample: Boolean(payload.sample),
        runtimeUrl: payload.runtimeUrl || (unityStatus && unityStatus.runtimeUrl),
      };
      updateUnityGlobals();
      renderUnityOverlay();
      updateEngineUi();
      updateHud();
      log.info('Unity WebGL 已连接真实数据（postMessage fca-unity-ready）', {
        connected: payload.connected !== false,
        nodes: stats.nodes,
        edges: stats.edges,
        arms: stats.arms,
        armSummary: stats.armSummary || null,
        sample: Boolean(payload.sample),
        runtimeUrl: payload.runtimeUrl || null,
      });
      if (payload.sample && !toastShownSample) {
        toastShownSample = true;
        toast('Unity 星云使用样例数据（非实时 Runtime）', { type: 'warn', duration: 5000 });
      }
      // iframe/引擎切换后重放当前 Electron 选中，保证 Unity 端高亮与右栏一致
      unitySelectionSync.lastSentCommand = null;
      syncSelectionToUnity('unity-ready');
    } else if (data.type === UNITY_STATUS_MESSAGE) {
      // fca-unity-state：运行期状态/统计持续推送（connected/nodes/edges/arms/armSummary/quality/view）
      const stats = { ...(unityStatus && unityStatus.stats ? unityStatus.stats : {}) };
      if (Number.isFinite(Number(payload.nodes))) stats.nodes = Number(payload.nodes);
      if (Number.isFinite(Number(payload.edges))) stats.edges = Number(payload.edges);
      if (Number.isFinite(Number(payload.arms))) stats.arms = Number(payload.arms);
      if (payload.armSummary) stats.armSummary = String(payload.armSummary);
      if (payload.quality) stats.quality = String(payload.quality);
      if (payload.layout) stats.layoutSignature = String(payload.layout);
      unityStatus = {
        ...(unityStatus || {}),
        stats,
        connected: payload.connected === true,
        sample: Boolean(payload.sample),
      };
      updateUnityGlobals();
      renderUnityOverlay();
      updateEngineUi();
      updateHud();
    }
  }

  /* ---------------------------- Unity ↔ Electron 选中同步 ---------------------------- */

  function updateUnitySelectionGlobal() {
    window.__FCA_UNITY_SELECT__ = () => ({
      engine,
      primaryId: (store.getState().selection && store.getState().selection.primaryId) || null,
      lastSentCommand: unitySelectionSync.lastSentCommand,
      lastSentAt: unitySelectionSync.lastSentAt,
      lastIncomingId: unitySelectionSync.lastIncomingId,
      lastAcceptedId: unitySelectionSync.lastAcceptedId,
      lastAck: unitySelectionSync.lastAck,
      iframeReady: unityMessageSeen || (unityFrameLoaded && unityAssetsSeen),
      pendingReplay: unitySelectionSync.pendingReplay,
      ignoredCount: unitySelectionSync.ignoredCount,
      acceptedCount: unitySelectionSync.acceptedCount,
    });
  }

  /** 页面 → Unity：跨源 iframe 无法直接调用 FCA_NEBULA，按约定 postMessage 命令；同源时优先直接调用 */
  function sendUnitySelectionCommand(command, reason) {
    if (engine !== 'unity') return false;
    const frame = dom.unityFrame;
    if (!frame) return false;
    const win = frame.contentWindow;
    if (!win) return false;
    let sent = false;
    try {
      if (win.FCA_NEBULA && typeof win.FCA_NEBULA.postCommand === 'function') {
        sent = win.FCA_NEBULA.postCommand(command) !== false;
      }
    } catch {
      // 跨源访问 contentWindow.FCA_NEBULA 会抛 SecurityError：回退到 postMessage 契约
      sent = false;
    }
    if (!sent) {
      try {
        win.postMessage(buildUnityCommandMessage(command), '*');
        sent = true;
      } catch {
        sent = false;
      }
    }
    if (sent) {
      unitySelectionSync.lastSentCommand = command;
      unitySelectionSync.lastSentAt = Date.now();
      log.info('Electron 选中 → Unity', { command, reason: reason || 'sync' });
    } else {
      log.warn('向 Unity 发送选中命令失败', { command, reason: reason || 'sync' });
    }
    updateUnitySelectionGlobal();
    return sent;
  }

  /** Electron 侧 selection 变化 → 同步到 Unity（Unity 引擎且 iframe ready）；未 ready 时标记待重放 */
  function syncSelectionToUnity(reason) {
    if (disposed || engine !== 'unity') return;
    const primaryId = (store.getState().selection && store.getState().selection.primaryId) || null;
    const command = buildUnitySelectCommand(primaryId);
    if (command === unitySelectionSync.lastSentCommand) return;
    const ready = unityMessageSeen || (unityFrameLoaded && unityAssetsSeen);
    if (!ready) {
      unitySelectionSync.pendingReplay = true;
      updateUnitySelectionGlobal();
      return;
    }
    unitySelectionSync.pendingReplay = false;
    sendUnitySelectionCommand(command, reason);
  }

  /** Unity 选中节点（或 cancel）→ 右侧详情面板同步 */
  function handleUnitySelection(data) {
    if (engine !== 'unity') return;
    const incoming = parseUnitySelectMessage(data);
    if (!incoming) return;
    if (incoming.clear) {
      // 保留右栏详情避免闪烁：仅记录清空（不 patch store，防止反向 select:clear 抖动）
      unitySelectionSync.lastIncomingId = null;
      updateUnitySelectionGlobal();
      return;
    }
    const state = store.getState();
    const currentPrimaryId = (state.selection && state.selection.primaryId) || null;
    const verdict = shouldAcceptUnitySelection({
      incoming,
      currentPrimaryId,
      lastSentId: (() => {
        const command = unitySelectionSync.lastSentCommand;
        return command && command.startsWith('select:') ? command.slice('select:'.length) : null;
      })(),
      lastSentAt: unitySelectionSync.lastSentAt,
      lastAcceptedId: unitySelectionSync.lastAcceptedId,
      lastAcceptedAt: unitySelectionSync.lastAcceptedAt,
    });
    unitySelectionSync.lastIncomingId = incoming.id;
    if (!verdict.accept) {
      unitySelectionSync.ignoredCount += 1;
      log.info('Unity 选中事件已忽略', { id: incoming.id, kind: incoming.kind, reason: verdict.reason });
      updateUnitySelectionGlobal();
      return;
    }
    unitySelectionSync.acceptedCount += 1;
    unitySelectionSync.lastAcceptedId = incoming.id;
    unitySelectionSync.lastAcceptedAt = Date.now();
    // 右侧面板收起时自动打开，保证“右方侧边栏同步显示已打开节点详情”
    if (state.ui && state.ui.right && state.ui.right.collapsed && ctx.detail && typeof ctx.detail.setOpen === 'function') {
      ctx.detail.setOpen(true);
    }
    log.info('Unity 选中节点 → 同步右侧详情', { id: incoming.id, kind: incoming.kind, title: incoming.title || null, arm: incoming.arm || null });
    actions.openMemory(incoming.id, { focus: false });
    if (dom.enginePill) {
      dom.enginePill.title = `Unity 已选中 ${incoming.title || incoming.id}`;
    }
    updateUnitySelectionGlobal();
  }

  function onUnityStatus(status, source) {
    if (!status || disposed) return;
    unityStatus = status;
    updateUnityGlobals();
    updateEngineUi();
    updateHud();
    renderUnityOverlay();
    renderUnityBanner();
    if (engine !== 'unity') return;
    if (!status.available) {
      unityFallbackActive = true;
      fallbackToWebgl('未找到 Unity WebGL 构建（index.html），已使用 WebGL 星云回退');
      return;
    }
    if (status.state === 'error' && status.lastError) {
      unityFallbackActive = true;
      fallbackToWebgl(`Unity WebGL 启动失败：${status.lastError.message}（已回退 WebGL 星云）`);
    }
    void source;
  }

  function desiredEngine() {
    if (requestedEngine() !== 'unity') return 'webgl';
    if (!unityUsable()) return 'webgl';
    if (unityFallbackActive) return 'webgl';
    return 'unity';
  }

  function destroyNebula() {
    if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
    if (instance) {
      try {
        instance.destroy();
      } catch {
        /* ignore */
      }
      instance = null;
    }
    window.__FCA_NEBULA__ = null;
    window.__FCA_NEBULA_STATS__ = null;
  }

  async function applyEngine(options = {}) {
    if (disposed || !root) return;
    const force = Boolean(options && options.force);
    const next = desiredEngine();
    if (next === engine && !force) {
      updateEngineUi();
      renderUnityOverlay();
      renderUnityBanner();
      return;
    }
    const previous = engine;
    engine = next;
    updateUnityGlobals();
    if (engine === 'unity') {
      destroyNebula();
      if (canvasHost) canvasHost.hidden = true;
      if (dom.unityLayer) dom.unityLayer.hidden = false;
      if (dom.unityBanner) dom.unityBanner.hidden = true;
      setUnityOverlay('loading', '正在启动内嵌 Unity WebGL 服务…');
      await ensureUnityEmbed();
      // 引擎切换/iframe 重建后重放当前 Electron 选中（Unity HUD 高亮与右栏保持一致）
      syncSelectionToUnity('engine-unity');
    } else {
      if (dom.unityLayer) dom.unityLayer.hidden = true;
      if (dom.unityFrame) {
        dom.unityFrame.removeAttribute('src');
        dom.unityFrame.removeAttribute('data-frame-src');
      }
      // 回到 WebGL 后清空 iframe 地址：下次切回 Unity 会重新启动静态服务并重建 iframe（on ready 重放选中）
      unityFrameUrl = null;
      unityFrameLoaded = false;
      unityAssetsSeen = false;
      unityMessageSeen = false;
      unitySelectionSync.lastSentCommand = null;
      unitySelectionSync.pendingReplay = true;
      updateUnitySelectionGlobal();
      if (canvasHost) canvasHost.hidden = false;
      renderUnityBanner();
      stopUnityPolling();
      if (!instance) {
        await initNebula();
        if (disposed) return;
      }
      if (store.getState().graph.data) applyGraph();
    }
    updateEngineUi();
    updatePill();
    updateHud();
    renderLegend();
    if (previous !== engine) {
      log.info('星云渲染引擎切换', {
        from: previous,
        to: engine,
        requested: requestedEngine(),
        unityAvailable: unityUsable(),
        unityState: unityStatus ? unityStatus.state : null,
      });
    }
  }

  async function ensureUnityEmbed() {
    if (disposed) return;
    if (!unityUsable()) {
      unityFallbackActive = true;
      await fallbackToWebgl(unityStatus && unityStatus.lastError ? unityStatus.lastError.message : '未找到 Unity WebGL 构建（index.html），已使用 WebGL 星云回退');
      return;
    }
    const bridge = unityBridge();
    if (!bridge) {
      unityFallbackActive = true;
      await fallbackToWebgl('当前环境不支持 Unity WebGL 内嵌（需要 Electron 桌面版），已使用 WebGL 星云回退');
      return;
    }
    if (!unityFrameUrl) {
      setUnityOverlay('loading', unityStatus.state === 'starting' ? '正在启动 Unity WebGL 服务…' : '正在启动内嵌 Unity WebGL 服务…');
      try {
        const result = await bridge.start();
        if (!result || !result.ok) {
          const message = result && result.error && result.error.message ? result.error.message : 'Unity WebGL 内嵌服务启动失败';
          unityFallbackActive = true;
          await fallbackToWebgl(`${message}（已回退 WebGL 星云）`);
          return;
        }
        unityStatus = result.status || unityStatus;
        unityFrameUrl = result.frameUrl || (result.status && result.status.frameUrl) || null;
        updateUnityGlobals();
      } catch (error) {
        unityFallbackActive = true;
        await fallbackToWebgl(`Unity WebGL 内嵌服务启动失败：${error.message}（已回退 WebGL 星云）`);
        return;
      }
    }
    if (!unityFrameUrl) {
      unityFallbackActive = true;
      await fallbackToWebgl('Unity WebGL iframe 地址不可用，已回退 WebGL 星云');
      return;
    }
    if (!dom.unityFrame) return;
    if (dom.unityFrame.getAttribute('data-frame-src') !== unityFrameUrl) {
      dom.unityFrame.setAttribute('data-frame-src', unityFrameUrl);
      unityFrameLoaded = false;
      unityAssetsSeen = false;
      unityMessageSeen = false;
      unityStartAt = Date.now();
      // 新 iframe 重新加载：清空已发送记录并标记待重放，ready 后自动 select:<当前选中>
      unitySelectionSync.lastSentCommand = null;
      unitySelectionSync.pendingReplay = true;
      updateUnitySelectionGlobal();
      setUnityOverlay('loading', 'Unity WebGL 加载中…（首次加载需要初始化运行时）');
      try {
        dom.unityFrame.src = unityFrameUrl;
      } catch (error) {
        unityFallbackActive = true;
        await fallbackToWebgl(`Unity WebGL iframe 加载失败：${error.message}（已回退 WebGL 星云）`);
        return;
      }
      startUnityPolling();
    }
    renderUnityOverlay();
  }

  function startUnityPolling() {
    stopUnityPolling();
    unityPollTimer = setInterval(() => {
      if (disposed || !dom.unityFrame) {
        stopUnityPolling();
        return;
      }
      const stats = (unityStatus && unityStatus.stats) || {};
      if (stats.assetsLoaded) {
        unityAssetsSeen = true;
        if (!unityMessageSeen) {
          setUnityOverlay('loading', 'Unity 资源已加载，正在连接本地 Runtime…');
        }
      }
      const elapsed = Date.now() - (unityStartAt || Date.now());
      if (unityMessageSeen) {
        stopUnityPolling();
        setUnityOverlay(null);
        return;
      }
      // 启发式：资源已加载且已过宽限期 → 认为画面可用（部分构建未实现 postMessage）
      if (unityAssetsSeen && elapsed > UNITY_READY_GRACE_MS) {
        stopUnityPolling();
        setUnityOverlay(null);
        renderUnityOverlay();
        syncSelectionToUnity('heuristic-ready');
        return;
      }
      if (elapsed > UNITY_LOAD_TIMEOUT_MS) {
        stopUnityPolling();
        unityFallbackActive = true;
        fallbackToWebgl('Unity WebGL 加载超时，已回退 WebGL 星云（可点击“重新加载 Unity”重试）');
      }
    }, 700);
  }

  function stopUnityPolling() {
    if (unityPollTimer) {
      clearInterval(unityPollTimer);
      unityPollTimer = null;
    }
  }

  async function fallbackToWebgl(reason) {
    if (disposed) return;
    unityFallbackActive = true;
    if (reason) setStored(UNITY_FALLBACK_KEY, reason);
    if (engine === 'webgl') {
      renderUnityBanner();
      updateEngineUi();
      renderUnityOverlay();
      return;
    }
    log.warn('Unity WebGL 内嵌不可用，回退 WebGL 星云', { reason: reason || '(unspecified)' });
    await applyEngine({ force: true, reason: 'fallback' });
    if (reason) toast(reason, { type: 'warn', duration: 7000 });
  }

  /** 用户显式关闭内嵌 Unity（停止服务 + 回退 WebGL，同时记住本次会话不再自动启动） */
  async function stopUnity(options = {}) {
    const bridge = unityBridge();
    if (unityBusy) return { ok: false };
    unityBusy = true;
    renderUnityOverlay();
    try {
      if (bridge) await bridge.stop({ reason: (options && options.reason) || 'user' });
      if (dom.unityFrame) dom.unityFrame.removeAttribute('src');
      unityFrameUrl = null;
      unityFrameLoaded = false;
      unityAssetsSeen = false;
      unityMessageSeen = false;
      unitySelectionSync.lastSentCommand = null;
      updateUnitySelectionGlobal();
      stopUnityPolling();
      setStored(UNITY_USER_CLOSED_KEY, '1');
      setStored(UNITY_FALLBACK_KEY, 'Unity WebGL 已关闭，已回退 WebGL 星云');
      await fallbackToWebgl('Unity WebGL 已关闭，已回退 WebGL 星云');
      return { ok: true };
    } catch (error) {
      toast(`关闭 Unity WebGL 失败：${error.message}`, { type: 'error', duration: 5000 });
      return { ok: false, error };
    } finally {
      unityBusy = false;
      updateEngineUi();
      renderUnityOverlay();
      updateHud();
    }
  }

  /** 显式启动/重试 Unity WebGL 内嵌 */
  async function startUnity(options = {}) {
    const bridge = unityBridge();
    if (!bridge) {
      toast('当前环境不支持 Unity WebGL 内嵌（需要 Electron 桌面版）', { type: 'warn', duration: 5000 });
      return { ok: false };
    }
    if (unityBusy) return { ok: false, busy: true };
    unityBusy = true;
    try {
      setStored(UNITY_USER_CLOSED_KEY, null);
      setStored(UNITY_FALLBACK_KEY, null);
      unityFallbackActive = false;
      await refreshUnityStatus();
      if (!unityUsable()) {
        toast('未找到 Unity WebGL 构建（index.html），已使用 WebGL 星云回退', { type: 'warn', duration: 7000 });
        renderUnityBanner();
        return { ok: false, error: { code: 'UNITY_WEBGL_NOT_FOUND' } };
      }
      await applyEngine({ force: true, reason: 'start' });
      if (engine === 'unity' && !unityFrameUrl) await ensureUnityEmbed();
      if (!options || !options.silent) toast('Unity WebGL 已内嵌到星云视图', { type: 'info', duration: 2500 });
      return { ok: engine === 'unity', frameUrl: unityFrameUrl ? sanitizeFrameUrl(unityFrameUrl) : null };
    } catch (error) {
      toast(`启动 Unity WebGL 失败：${error.message}`, { type: 'error', duration: 6000 });
      return { ok: false, error };
    } finally {
      unityBusy = false;
      updateEngineUi();
      renderUnityOverlay();
      updateHud();
    }
  }

  /** 重新加载 iframe（重试） */
  async function reloadUnity() {
    const bridge = unityBridge();
    if (bridge) {
      try {
        await bridge.stop({ reason: 'reload' });
      } catch {
        /* ignore */
      }
    }
    unityFrameUrl = null;
    if (dom.unityFrame) dom.unityFrame.removeAttribute('src');
    unityFrameLoaded = false;
    unityAssetsSeen = false;
    unityMessageSeen = false;
    unitySelectionSync.lastSentCommand = null;
    unitySelectionSync.pendingReplay = true;
    setStored(UNITY_FALLBACK_KEY, null);
    unityFallbackActive = false;
    await refreshUnityStatus();
    await applyEngine({ force: true, reason: 'reload' });
    if (engine === 'unity') await ensureUnityEmbed();
  }

  async function switchEngine(next) {
    if (next !== 'unity' && next !== 'webgl') return;
    if (next === 'unity') {
      await refreshUnityStatus();
      if (!unityUsable()) {
        toast('未找到 Unity WebGL 构建（index.html），已使用 WebGL 星云回退', { type: 'warn', duration: 7000 });
        renderUnityBanner();
        return;
      }
      setStored(UNITY_USER_CLOSED_KEY, null);
      setStored(UNITY_FALLBACK_KEY, null);
      unityFallbackActive = false;
    }
    const save = actions && typeof actions.setNebulaEngine === 'function' ? actions.setNebulaEngine : null;
    if (save) {
      try {
        const saved = await save(next);
        if (saved === false) return;
      } catch (error) {
        toast(`切换渲染引擎失败：${error.message}`, { type: 'error' });
        return;
      }
    }
    if (next === 'webgl') {
      await stopUnity({ reason: 'switch-webgl' });
    } else {
      await applyEngine({ force: true, reason: 'switch-unity' });
    }
  }

  function setUnityOverlay(kind, text) {
    if (!dom.unityOverlay) return;
    if (!kind) {
      dom.unityOverlay.hidden = true;
      dom.unityOverlay.innerHTML = '';
      return;
    }
    dom.unityOverlay.hidden = false;
    dom.unityOverlay.innerHTML = '';
    const card = kit.el('div', { class: 'atlas-unity-overlay__card' }, [
      kind === 'loading' ? kit.spinner({ label: '加载中' }) : null,
      kit.el('div', { class: 'atlas-unity-overlay__title', text: kind === 'error' ? 'Unity WebGL 加载失败' : 'Unity 星云' }),
      kit.el('div', { class: 'atlas-unity-overlay__desc', text: text || (kind === 'error' ? '请查看日志或切换回 WebGL 星云。' : '正在加载 Unity WebGL…') }),
    ].filter(Boolean));
    dom.unityOverlay.appendChild(card);
  }

  function renderUnityOverlay() {
    if (!dom.unityLayer || !dom.unityOverlay) return;
    if (engine !== 'unity') {
      dom.unityLayer.hidden = true;
      dom.unityOverlay.hidden = true;
      return;
    }
    dom.unityLayer.hidden = false;
    const lastError = unityStatus && unityStatus.lastError;
    if (lastError) {
      dom.unityOverlay.hidden = false;
      dom.unityOverlay.innerHTML = '';
      const card = kit.el('div', { class: 'atlas-unity-overlay__card atlas-unity-overlay__card--error' }, [
        kit.el('div', { class: 'atlas-unity-overlay__title', text: 'Unity WebGL 出错' }),
        kit.el('div', { class: 'atlas-unity-overlay__desc', text: lastError.message }),
        kit.el('div', { class: 'atlas-unity-overlay__actions' }, [
          kit.button({ label: '重新加载 Unity', icon: 'refresh', variant: 'primary', onClick: () => reloadUnity() }),
          kit.button({ label: '使用 WebGL 星云', icon: 'grid', variant: 'secondary', onClick: () => switchEngine('webgl') }),
          kit.button({ label: '日志', icon: 'file', variant: 'ghost', onClick: () => showUnityLogs() }),
        ]),
      ]);
      dom.unityOverlay.appendChild(card);
      return;
    }
    if (unityMessageSeen || (unityFrameLoaded && unityAssetsSeen && Date.now() - (unityStartAt || 0) > UNITY_READY_GRACE_MS)) {
      dom.unityOverlay.hidden = true;
      dom.unityOverlay.innerHTML = '';
      return;
    }
    if (dom.unityOverlay.hidden) setUnityOverlay('loading', 'Unity WebGL 加载中…');
  }

  async function showUnityLogs() {
    const bridge = unityBridge();
    const contentEl = kit.el('pre', { class: 'atlas-unity-card__paths', text: '读取中…' });
    kit.dialog({
      title: 'Unity WebGL 内嵌服务日志',
      subtitle: '本地静态文件服务 / Unity 资源请求记录 / 错误（token 已脱敏）',
      content: contentEl,
      width: 760,
      actions: [{ label: '关闭', variant: 'secondary' }],
    });
    try {
      const tail = bridge ? await bridge.getLogTail(120) : { entries: [] };
      const lines = [];
      for (const entry of tail.entries || []) lines.push(`[${entry.at}] ${entry.line}`);
      if (unityStatus && unityStatus.searched) {
        lines.push('', '--- exe/构建目录搜索 ---', ...unityStatus.searched.map((item) => `${item.exists ? '✓' : '✗'} ${item.path}（${item.source}）`));
      }
      contentEl.textContent = lines.join('\n') || '（暂无日志）';
    } catch (error) {
      contentEl.textContent = `读取 Unity 日志失败：${error.message}`;
    }
  }

  function statusDotState(tone) {
    return tone === 'error' ? 'error' : tone === 'running' ? 'running' : tone === 'starting' ? 'starting' : 'stopped';
  }

  function renderUnityBanner() {
    if (!dom.unityBanner) return;
    const requested = requestedEngine();
    if (requested !== 'unity' || engine === 'unity') {
      dom.unityBanner.hidden = true;
      dom.unityBanner.innerHTML = '';
      return;
    }
    let message = null;
    if (unityStatus && !unityStatus.available) {
      message = '未找到 Unity WebGL 构建（index.html），已使用 WebGL 回退';
    } else {
      message = storedReason(UNITY_FALLBACK_KEY);
    }
    if (!message) {
      dom.unityBanner.hidden = true;
      dom.unityBanner.innerHTML = '';
      return;
    }
    dom.unityBanner.hidden = false;
    dom.unityBanner.innerHTML = '';
    dom.unityBanner.appendChild(icon('alert', { size: 13 }));
    dom.unityBanner.appendChild(kit.el('span', { class: 'atlas-unity-banner__text', text: message }));
    dom.unityBanner.append(
      kit.button({ label: '重试 Unity', icon: 'play', variant: 'ghost', size: 'sm', onClick: () => startUnity() }),
      kit.button({ label: '日志', icon: 'file', variant: 'ghost', size: 'sm', onClick: () => showUnityLogs() }),
      kit.iconButton({
        icon: 'close',
        label: '关闭提示',
        size: 'xs',
        onClick: () => {
          setStored(UNITY_FALLBACK_KEY, null);
          renderUnityBanner();
        },
      }),
    );
  }

  function updateEngineUi() {
    const label = engine === 'unity' ? 'Unity' : 'WebGL';
    if (dom.engineBtn) {
      const labelEl = dom.engineBtn.querySelector('.btn__label');
      if (labelEl) labelEl.textContent = label;
      dom.engineBtn.title = engine === 'unity'
        ? '当前：Unity WebGL 内嵌渲染 · 点击切换 / 查看状态'
        : `当前：WebGL 星云${requestedEngine() === 'unity' && !unityUsable() ? '（UnWebGL 构建不可用，自动回退）' : ''} · 点击切换`;
      dom.engineBtn.classList.toggle('is-unity', engine === 'unity');
    }
    if (dom.enginePill) {
      dom.enginePill.innerHTML = '';
      const ready = engine === 'unity' && (unityMessageSeen || (unityFrameLoaded && unityAssetsSeen));
      const tone = engine === 'unity' ? (ready ? 'running' : 'starting') : 'stopped';
      dom.enginePill.append(
        kit.statusDot(statusDotState(tone)),
        kit.el('span', { text: engine === 'unity' ? `Unity 内嵌${ready ? ' · 实时' : ' · 加载中'}` : 'WebGL 星云' }),
      );
    }
    const webglOnly = [dom.zoomIn, dom.zoomOut, dom.fitBtn, dom.autoLayoutBtn, dom.resetLayoutBtn];
    for (const btn of webglOnly) {
      if (!btn) continue;
      btn.disabled = engine === 'unity';
      btn.title = engine === 'unity' ? 'Unity 星云内直接交互（拖拽/滚轮/点选由 Unity 处理）' : btn.title || '';
    }
    updateUnityGlobals();
  }

  function openEngineMenu(anchor) {
    kit.dropdown({
      anchor,
      align: 'right',
      items: [
        { header: '星云渲染引擎' },
        {
          label: `${requestedEngine() === 'unity' ? '✓ ' : ''}Unity 星云（内嵌 WebGL）${unityUsable() ? '' : ' · 未找到构建'}`,
          icon: 'sparkles',
          onClick: () => switchEngine('unity'),
        },
        { label: `${requestedEngine() === 'webgl' ? '✓ ' : ''}WebGL 星云（内置回退）`, icon: 'grid', onClick: () => switchEngine('webgl') },
        { separator: true },
        { label: '重新加载 Unity WebGL', icon: 'refresh', onClick: () => reloadUnity() },
        { label: '停止 Unity（回退 WebGL）', icon: 'stop', onClick: () => stopUnity({ reason: 'menu' }) },
        { label: '查看 Unity 内嵌日志…', icon: 'file', onClick: () => showUnityLogs() },
        { label: `服务端口：${unityStatus && unityStatus.port ? unityStatus.port : '未启动'}（127.0.0.1）`, icon: 'info', disabled: true },
      ],
    });
  }


  // ------------------------------------------------------------- nebula
  /**
   * 开发/视觉迭代用映射覆盖：?map=nebulaIntensity:0.5,dustStrength:1.4,exposure:0.9
   * 仅接受 palette.js defaultMapping() 里的数值字段，生产环境无参数时无任何影响。
   */
  function mappingOverrideFromUrl() {
    const raw = new URLSearchParams(location.search).get('map');
    if (!raw) return null;
    const numericKeys = new Set([
      'nodeBrightness', 'nodeMinPixel', 'nebulaIntensity', 'nebulaSaturation', 'dustStrength', 'gasScale',
      'relationOpacity', 'relationFlow', 'relationWidth', 'starDensity', 'bandIntensity',
      'exposure', 'bloom', 'grain', 'vignette', 'chromaticAberration',
    ]);
    const out = {};
    for (const pair of raw.split(',')) {
      const [key, value] = pair.split(':');
      if (!numericKeys.has(key)) continue;
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = n;
    }
    return Object.keys(out).length ? out : null;
  }

  async function initNebula() {
    const quality = store.getState().ui.quality;
    const options = { quality, labels: true, background: 'deep-space', clusterLabels: mode === 'clusters', emptyOverlay: false };
    const devMapping = mappingOverrideFromUrl();
    if (devMapping) {
      options.mapping = devMapping;
      log.info('nebula 映射覆盖（视觉调试）', devMapping);
    }
    // 开发/视觉迭代用相机角度覆盖：?cam=<yaw>,<pitch>,<fitPadding>
    const camRaw = new URLSearchParams(location.search).get('cam');
    if (camRaw) {
      const parts = camRaw.split(',').map((v) => Number(v));
      if (Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
        options.angles = { yaw: parts[0], pitch: parts[1] };
      }
      if (Number.isFinite(parts[2])) options.fitPadding = parts[2];
      log.info('nebula 相机覆盖（视觉调试）', { cam: camRaw });
    }
    try {
      const module = await import('../nebula/index.js');
      if (disposed) return;
      if (typeof module.createNebula !== 'function') throw new Error('nebula/index.js 未导出 createNebula');
      instance = module.createNebula(canvasHost, options);
      usingDevStub = false;
      log.info('nebula 渲染器已加载（真实模块）');
    } catch (error) {
      log.warn(`真实 nebula 模块不可用（${error.message}），回退开发期 stub（DEV-ONLY）`);
      try {
        const stub = await import('../lib/dev/nebula-stub.js');
        if (disposed) return;
        instance = stub.createNebula(canvasHost, options);
        usingDevStub = true;
      } catch (stubError) {
        setStatusLayer('error', { error: { message: `渲染器不可用：${stubError.message}` } });
        return;
      }
    }
    window.__FCA_NEBULA__ = instance;
    wireInstance();
    applyMapping();
    if (instance.setQuality) instance.setQuality(quality);
    if (instance.setView) instance.setView(camera);
    if (store.getState().graph.data) applyGraph();
    startStatsLoop();
    renderLegend();
  }

  function wireInstance() {
    if (!instance || typeof instance.on !== 'function') return;
    instance.on('node:click', ({ id }) => {
      const graph = filteredGraph || store.getState().graph.data;
      const node = graph && graph.nodes ? graph.nodes.find((n) => n.id === id) : null;
      if (!node) return;
      if (instance) instance.select([id]);
      if (node.kind === 'entity') {
        ctx.detailPanelRef && ctx.detailPanelRef.showEntity(id);
        store.patch({ selection: { ids: [id], primaryId: id } });
      } else {
        actions.openMemory(id, { focus: false });
      }
      events.emit('atlas:node-selected', { id });
    });
    instance.on('node:dblclick', ({ id }) => {
      focusNode(id, 2);
      actions.openMemory(id, { focus: true });
    });
    instance.on('node:hover', ({ id }) => {
      store.patch({ selection: { hoverId: id } });
      if (id) {
        const graph = filteredGraph || store.getState().graph.data;
        const node = graph && graph.nodes ? graph.nodes.find((n) => n.id === id) : null;
        if (node && hoverLabelEl) {
          hoverLabelEl.textContent = `${node.kind === 'entity' ? format.entityKindLabel(node.type) : format.memoryTypeLabel(node.type)} · ${node.label}`;
          hoverLabelEl.style.display = '';
        }
        ctx.status.set('atlas.hover', { label: node ? node.label : id });
      } else {
        if (hoverLabelEl) hoverLabelEl.style.display = 'none';
        ctx.status.remove('atlas.hover');
      }
    });
    instance.on('node:dragend', ({ id, position }) => {
      persistNodePosition(id, position).catch((error) => {
        toast(`保存布局失败：${api.userMessage(error)}`, { type: 'error' });
      });
    });
    instance.on('background:click', () => {
      clusterFocusId = null;
      actions.clearSelection();
      if (instance) instance.select([]);
      renderClusterBar();
      renderLegend();
    });
    instance.on('selection:change', ({ ids }) => {
      if (Array.isArray(ids) && ids.length) {
        store.patch({ selection: { ids: [...ids], primaryId: ids[0] } });
        if (ids.length === 1) {
          const graph = filteredGraph || store.getState().graph.data;
          const node = graph && graph.nodes ? graph.nodes.find((n) => n.id === ids[0]) : null;
          if (!node) return;
          if (node.kind === 'entity') ctx.detailPanelRef && ctx.detailPanelRef.showEntity(node.id);
          else actions.openMemory(node.id, { focus: false });
        }
      }
    });
    instance.on('perf', (stats) => {
      window.__FCA_NEBULA_STATS__ = stats;
      events.emit('nebula:perf', stats);
    });
    if (typeof instance.getStats === 'function') {
      window.__FCA_NEBULA_STATS__ = instance.getStats();
    }
  }

  function applyMapping() {
    if (!instance) return;
    const uiState = store.getState().ui;
    const overlays = uiState.overlays || {};
    const layers = {
      nebula: overlays.nebula !== false,
      edges: overlays.edges !== false,
      labels: overlays.labels !== false,
    };
    // 渲染器接口（冻结接口 + additive）：setLayers/setLabels 是 Desktop 图层控制的真实落点；
    // setMapping 仍调用一次以兼容旧渲染器（未知键会被安全忽略）。
    if (typeof instance.setLayers === 'function') instance.setLayers(layers);
    if (typeof instance.setLabels === 'function') instance.setLabels(layers.labels);
    if (typeof instance.setClusterLabels === 'function') instance.setClusterLabels(mode === 'clusters' && layers.labels);
    try {
      instance.setMapping({
        node: { sizeFromImportance: true, sizeFromDegree: true, brightnessFromDisplayWeight: true },
        cluster: { colorHints: CLUSTER_COLORS },
        relation: { visual: 'filament', enabled: layers.edges },
        labels: { enabled: layers.labels, minZoom: 0.55 },
        background: { starDensity: 1, galaxyBand: true },
        layers,
        quality: store.getState().ui.quality,
      });
    } catch (error) {
      log.warn('映射应用失败', { message: error.message });
    }
  }

  function applyGraph() {
    const state = store.getState();
    const graph = state.graph.data;
    lastGraph = graph;
    if (state.graph.status === 'loading' && !graph) {
      setStatusLayer('loading');
    }
    if (!graph) {
      if (state.graph.status === 'error') setStatusLayer('error', { error: state.graph.error });
      else if (state.runtime.state === 'running') setStatusLayer('loading');
      else setStatusLayer('offline', { error: state.runtime.lastError ? state.runtime.lastError.message : '' });
      renderLegend();
      updateHud();
      return;
    }
    applyFilters();
  }

  function applyFilters() {
    const state = store.getState();
    const graph = state.graph.data;
    lastGraph = graph;
    if (!graph) return applyGraph();
    const filtered = api.applyGraphFilters(graph, state.filters, state.filters.favorites);
    filteredGraph = filtered;
    const totalNodes = graph.stats ? graph.stats.nodes : (graph.nodes || []).length;
    const filteredNodes = filtered ? (filtered.nodes || []).length : 0;
    if (instance && typeof instance.setData === 'function') {
      instance.setData(filtered);
      if (typeof instance.setFilters === 'function') {
        try {
          instance.setFilters({
            types: state.filters.types,
            tags: state.filters.tags,
            projects: state.filters.projects,
            timeRange: state.filters.timeRange,
          });
        } catch {
          /* 渲染器可以忽略 */
        }
      }
    }
    if (usingDevStub && dom.devBanner) dom.devBanner.hidden = false;
    else if (dom.devBanner) dom.devBanner.hidden = true;

    if (totalNodes === 0) setStatusLayer('empty');
    else if (filteredNodes === 0) setStatusLayer('filtered');
    else if (state.graph.status === 'error') {
      setStatusLayer('error', { error: state.graph.error });
    } else {
      setStatusLayer(null);
    }
    renderLegend();
    renderClusterBar();
    updateHud();
  }

  function applyQuality(level) {
    if (!instance || typeof instance.setQuality !== 'function') return;
    try {
      instance.setQuality(level);
    } catch (error) {
      log.warn('画质切换失败', { message: error.message });
    }
    applyMapping();
    updateHud();
  }

  function startStatsLoop() {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = setInterval(() => {
      if (disposed || !instance || typeof instance.getStats !== 'function') return;
      try {
        const stats = instance.getStats();
        window.__FCA_NEBULA_STATS__ = stats;
        updateHud(stats);
        events.emit('nebula:perf', stats);
      } catch {
        /* ignore */
      }
    }, 1000);
  }

  function getCamera() {
    if (instance && typeof instance.getView === 'function') {
      try {
        const view = instance.getView();
        if (view && Array.isArray(view.center) && Number.isFinite(view.zoom)) return view;
      } catch {
        /* ignore */
      }
    }
    return camera;
  }

  function setCamera(next) {
    camera = { center: Array.isArray(next.center) ? next.center : camera.center, zoom: Number.isFinite(next.zoom) ? next.zoom : camera.zoom };
    if (instance && typeof instance.setView === 'function') {
      try {
        instance.setView(camera);
      } catch {
        /* ignore */
      }
    }
    updateHud();
  }

  function zoomBy(factor) {
    const current = getCamera();
    const zoom = Math.max(0.08, Math.min(6, (current.zoom || 1) * factor));
    setCamera({ center: current.center, zoom });
    toast(`缩放 ${Math.round(zoom * 100)}%`, { type: 'info', duration: 900 });
  }

  function fitToContent() {
    const graph = filteredGraph || lastGraph;
    const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : [];
    if (!nodes.length) {
      toast('当前没有可适应的星体', { type: 'info' });
      return;
    }
    if (instance && typeof instance.fitToContent === 'function') {
      try {
        instance.fitToContent({ padding: 0.18 });
        toast('已适应屏幕', { type: 'info', duration: 1200 });
        return;
      } catch {
        /* fallback */
      }
    }
    // 兜底：将相机中心移到节点包围盒中心，缩放回 1.0
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      const p = node.position || { x: 0, y: 0 };
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const center = [(minX + maxX) / 2, (minY + maxY) / 2, 0];
    setCamera({ center, zoom: 1 });
    toast('已居中到星图（当前渲染器未提供 fitToContent，缩放回 1.0）', { type: 'info', duration: 2600 });
  }

  function focusNode(id, depth = 1) {
    if (!instance) return;
    const graph = filteredGraph || lastGraph;
    const node = graph && graph.nodes ? graph.nodes.find((n) => n.id === id) : null;
    try {
      if (typeof instance.focusNode === 'function') instance.focusNode(id, { depth });
      if (typeof instance.select === 'function') instance.select([id]);
    } catch (error) {
      log.warn('聚焦节点失败', { message: error.message });
    }
    store.patch({ selection: { focusNodeId: id, focusDepth: depth, ids: [id], primaryId: id } });
    if (node) {
      const view = getCamera();
      setCamera({ center: [node.position.x, node.position.y, 0], zoom: Math.max(1, view.zoom || 1) });
    }
  }

  async function persistNodePosition(id, position) {
    const graph = filteredGraph || lastGraph;
    const node = graph && graph.nodes ? graph.nodes.find((n) => n.id === id) : null;
    if (!node) return;
    const original = { x: node.position.x, y: node.position.y, z: node.position.z || 0 };
    const next = { x: Number(position.x), y: Number(position.y), z: Number(position.z || 0) };
    const nodeKind = node.kind;
    const apply = async (pos) => {
      await api.saveLayoutNodes([{ node_kind: nodeKind, node_id: id, x: pos.x, y: pos.y, z: pos.z, pinned: true }]);
    };
    await commands.execute({
      id: `layout:${id}`,
      label: `移动星体「${node.label || id}」`,
      do: () => apply(next),
      undo: () => apply(original),
    });
    log.info('布局已持久化', { nodeId: id, x: next.x, y: next.y });
  }

  async function autoLayout() {
    const ok = await kit.confirm({
      title: '自动布局星图',
      message: '将按力导向算法重新计算所有星体位置（force_v1）。',
      detail: '手动拖动过的星体位置会被覆盖；布局由 Runtime 持久化。',
      confirmLabel: '重新布局',
    });
    if (!ok) return;
    try {
      toast('正在计算自动布局…', { type: 'info', duration: 2400 });
      await api.recomputeLayout({ algorithm: 'force_v1', cluster_separation: 0.8 });
      await actions.refreshGraph();
      toast('自动布局完成', { type: 'success' });
    } catch (error) {
      toast(`自动布局失败：${api.userMessage(error)}`, { type: 'error', duration: 5000 });
    }
  }

  async function resetLayout() {
    const ok = await kit.confirm({
      title: '恢复默认布局',
      message: '将清除所有手动拖动坐标并重新计算布局。',
      confirmLabel: '恢复布局',
      danger: true,
    });
    if (!ok) return;
    try {
      toast('正在恢复布局…', { type: 'info', duration: 2000 });
      await api.resetLayout();
      await actions.refreshGraph();
      toast('布局已恢复', { type: 'success' });
    } catch (error) {
      toast(`恢复布局失败：${api.userMessage(error)}`, { type: 'error', duration: 5000 });
    }
  }

  // ------------------------------------------------------------- 图例 / 图层 / 映射说明
  function renderLegend() {
    if (!dom.legend) return;
    const state = store.getState();
    dom.legend.hidden = !state.ui.legendOpen;
    if (!state.ui.legendOpen) return;
    dom.legend.innerHTML = '';
    const clusters = (lastGraph && lastGraph.clusters) || [];
    const header = kit.el('div', { class: 'atlas-legend__header' }, [
      kit.el('span', { class: 'atlas-legend__title', text: '图例与映射' }),
      kit.iconButton({ icon: 'close', label: '收起图例', size: 'xs', onClick: () => toggleLegend() }),
    ]);
    const body = kit.el('div', { class: 'atlas-legend__body' });

    // 星团
    if (clusters.length) {
      const section = kit.el('div', { class: 'atlas-legend__section' }, [kit.el('div', { class: 'atlas-legend__section-title', text: '星团（Runtime 聚类：项目 / 首个标签 / 类型）' })]);
      for (const cluster of clusters.slice(0, 12)) {
        const color = CLUSTER_COLORS[cluster.color_hint] || CLUSTER_COLORS.white;
        const active = clusterFocusId === cluster.id;
        const row = kit.el('button', { class: `atlas-legend__cluster${active ? ' is-active' : ''}`, type: 'button', title: cluster.label }, [
          kit.el('span', { class: 'atlas-legend__swatch', style: { background: color, color } }),
          kit.el('span', { class: 'atlas-legend__cluster-label', text: cluster.label || cluster.id }),
          kit.el('span', { class: 'atlas-legend__cluster-count', text: String((cluster.node_ids || []).length) }),
        ]);
        row.addEventListener('click', () => focusCluster(cluster));
        section.appendChild(row);
      }
      body.appendChild(section);
    }

    // 映射说明
    const mappingRows = [
      ['star', '亮度 = importance^1.75 × display_weight（重要记忆才亮，普通记忆保持暗弱）'],
      ['maximize', '大小 = importance + degree（重要度与连接数）'],
      ['sparkles', '星体颜色 = 记忆/实体类型；星云发射色 = cluster.color_hint'],
      ['relation', '光丝 = 关系（粗细/亮度来自 weight、confidence）'],
      ['compass', '位置 = Runtime 持久化布局（拖拽会写回 /layout/nodes）'],
    ];
    const mappingSection = kit.el('div', { class: 'atlas-legend__section' }, [kit.el('div', { class: 'atlas-legend__section-title', text: '视觉映射' })]);
    for (const [iconName, text] of mappingRows) {
      mappingSection.appendChild(kit.el('div', { class: 'atlas-legend__row' }, [icon(iconName, { size: 13 }), kit.el('span', { text })]));
    }
    body.appendChild(mappingSection);

    // 图层控制
    const layersSection = kit.el('div', { class: 'atlas-legend__section' }, [kit.el('div', { class: 'atlas-legend__section-title', text: '图层' })]);
    const overlays = state.ui.overlays;
    const layerToggles = [
      ['nebula', '星云与尘埃'],
      ['edges', '关系光丝'],
      ['labels', '标签'],
    ];
    for (const [key, label] of layerToggles) {
      const isOn = Boolean(overlays[key]);
      const row = kit.el('button', { class: `atlas-legend__row atlas-legend__row--interactive${isOn ? '' : ' is-off'}`, type: 'button' }, [
        icon(isOn ? 'eye' : 'eye-off', { size: 13 }),
        kit.el('span', { class: 'fca-grow', text: label }),
        kit.el('span', { class: 'fca-muted', text: isOn ? '开' : '关' }),
      ]);
      row.addEventListener('click', () => toggleOverlay(key));
      layersSection.appendChild(row);
    }
    body.appendChild(layersSection);

    const mappingBtn = kit.el('button', { class: 'atlas-legend__mapping-btn', type: 'button' }, [icon('info', { size: 13 }), kit.el('span', { text: '为什么亮 / 为什么聚在一起？（映射说明）' })]);
    mappingBtn.addEventListener('click', openMappingDialog);
    body.appendChild(mappingBtn);

    dom.legend.append(header, body);
  }

  function toggleOverlay(key) {
    const state = store.getState();
    const overlays = { ...state.ui.overlays, [key]: !state.ui.overlays[key] };
    store.patch({ ui: { overlays } });
    applyMapping();
    renderLegend();
    if (key === 'labels' && !overlays.labels) toast('标签已隐藏', { type: 'info', duration: 1200 });
    if (typeof actions.persistUiLayout === 'function') actions.persistUiLayout();
  }

  function toggleLegend() {
    const open = !store.getState().ui.legendOpen;
    store.patch({ ui: { legendOpen: open } });
    renderLegend();
    if (typeof actions.persistUiLayout === 'function') actions.persistUiLayout();
  }

  function openLayersMenu(anchor) {
    const state = store.getState();
    const overlays = state.ui.overlays;
    kit.dropdown({
      anchor,
      align: 'right',
      items: [
        { header: '图层控制' },
        { label: `${overlays.nebula ? '✓ ' : ''}星云与尘埃`, icon: 'sparkles', onClick: () => toggleOverlay('nebula') },
        { label: `${overlays.edges ? '✓ ' : ''}关系光丝`, icon: 'relation', onClick: () => toggleOverlay('edges') },
        { label: `${overlays.labels ? '✓ ' : ''}标签`, icon: 'tag', onClick: () => toggleOverlay('labels') },
        { separator: true },
        { label: `${state.ui.legendOpen ? '✓ ' : ''}图例面板`, icon: 'legend', onClick: () => toggleLegend() },
        { label: '映射说明…', icon: 'info', onClick: () => openMappingDialog() },
        { separator: true },
        ...QUALITY_LEVELS.map((level) => ({
          label: `${state.ui.quality === level ? '✓ ' : ''}画质：${format.qualityLabel(level)}`,
          icon: 'activity',
          onClick: () => actions.setQuality(level),
        })),
      ],
    });
  }

  function openMappingDialog() {
    const graph = lastGraph || {};
    const clusters = Array.isArray(graph.clusters) ? graph.clusters : [];
    const stats = graph.stats || {};
    const content = kit.el('div', {});
    content.appendChild(
      kit.el('div', {
        class: 'mapping-intro',
        text: `这张星图完全由本地 Runtime 的真实图谱数据生成（GET /api/v1/graph，layout_version ${graph.layout_version || 0}，${format.number(stats.nodes || 0)} 个节点 / ${format.number(stats.edges || 0)} 条关系）。它不是一个装饰性背景：每个光点都是一条真实记忆或实体。`,
      }),
    );
    const mappingItems = [
      ['为什么亮？', '亮度 = (0.10 + 0.90 × importance^1.75) × (0.52 + 0.48 × display_weight) × (1 + 0.04 × √degree)。importance 高的记忆才点亮，绝大多数普通记忆保持暗弱——这与真实星空中“少数亮星 + 大量暗星”的分布一致。'],
      ['为什么聚在一起？', '星团（cluster）由 Runtime 聚类算法按项目归属 → 首个标签 → 记忆类型聚合，并给出 dominant_types 与 color_hint；星云气体发射核的质心与分布直接来自这些聚类成员的真实坐标。'],
      ['颜色代表什么？', '星体颜色 = 记忆类型 / 实体类型（图例可查）；星云与尘埃的发射主色 = 所属星团的 color_hint（由主导类型决定，不是随机着色）。'],
      ['光丝是什么？', '关系光丝来自 edges：relation_type 不同样式不同，亮度/粗细由 weight、confidence 决定；关系是独立数据实体，删除关系不会删除两端记忆。'],
      ['位置可信吗？', '位置以 Runtime 持久化布局为准；拖拽星体会 POST /layout/nodes 写回布局表，不会修改记忆正文。点「恢复布局」可清除手动坐标。'],
      ['空库时呢？', '空库显示真实深空背景与「空白星图」提示，不显示任何假节点或合成数据。'],
    ];
    const grid = kit.el('div', { class: 'mapping-grid' });
    for (const [key, desc] of mappingItems) {
      grid.appendChild(kit.el('div', { class: 'mapping-item' }, [kit.el('div', { class: 'mapping-item__key', text: key }), kit.el('div', { class: 'mapping-item__desc', text: desc })]));
    }
    content.appendChild(grid);
    if (clusters.length) {
      const legend = kit.el('div', { class: 'mapping-cluster-legend' });
      for (const cluster of clusters) {
        const color = CLUSTER_COLORS[cluster.color_hint] || CLUSTER_COLORS.white;
        legend.appendChild(kit.tag({ label: `${cluster.label || cluster.id} · ${(cluster.node_ids || []).length}`, tone: cluster.color_hint === 'white' ? 'neutral' : cluster.color_hint }));
        void color;
      }
      content.appendChild(kit.el('div', { class: 'mapping-item' }, [
        kit.el('div', { class: 'mapping-item__key', text: '当前星团' }),
        kit.el('div', { class: 'mapping-item__desc' }, [
          kit.el('div', { text: `${clusters.length} 个星团（颜色来自 color_hint，标签为 Runtime 聚类结果）` }),
          legend,
        ]),
      ]));
    }
    content.appendChild(
      kit.el('div', { class: 'mapping-note', text: '视觉由 desktop/renderer/nebula 渲染器实现：WebGL2 体积星云（每个 star cluster = 各向异性发射核 + 域扭曲 FBM 气体 + 高频尘埃吸收）、实例化星体、关系光丝与 HDR bloom / ACES tonemap。图层开关（星云/光丝/标签）通过渲染器 setLayers 接口实时生效。' }),
    );
    kit.dialog({ title: '星图映射说明', subtitle: '为什么亮 / 为什么聚在一起 / 颜色与光丝的含义', content, width: 680, actions: [{ label: '知道了', variant: 'secondary' }] });
  }

  // ------------------------------------------------------------- 聚类模式
  function renderClusterBar() {
    if (!dom.clusterBar) return;
    const graph = lastGraph;
    const clusters = graph && Array.isArray(graph.clusters) ? graph.clusters : [];
    dom.clusterBar.hidden = mode !== 'clusters' || !clusters.length;
    if (dom.clusterBar.hidden) return;
    dom.clusterBar.innerHTML = '';
    dom.clusterBar.appendChild(kit.el('span', { class: 'atlas-toolbar__label', text: '星团' }));
    for (const cluster of clusters) {
      const color = CLUSTER_COLORS[cluster.color_hint] || CLUSTER_COLORS.white;
      const active = clusterFocusId === cluster.id;
      const chip = kit.el('button', { class: `atlas-cluster-chip${active ? ' is-active' : ''}`, type: 'button', title: cluster.label }, [
        kit.el('span', { class: 'atlas-cluster-chip__dot', style: { background: color, color } }),
        kit.el('span', { text: `${cluster.label || cluster.id} · ${(cluster.node_ids || []).length}` }),
      ]);
      chip.addEventListener('click', () => focusCluster(cluster));
      dom.clusterBar.appendChild(chip);
    }
    const clearChip = kit.el('button', { class: 'atlas-cluster-chip', type: 'button', title: '清除星团聚焦' }, [icon('close', { size: 11 }), kit.el('span', { text: '清除' })]);
    clearChip.addEventListener('click', () => {
      clusterFocusId = null;
      if (instance) instance.select([]);
      actions.clearSelection();
      renderClusterBar();
      renderLegend();
    });
    dom.clusterBar.appendChild(clearChip);
  }

  function focusCluster(cluster) {
    if (!cluster) return;
    clusterFocusId = cluster.id;
    const ids = Array.isArray(cluster.node_ids) ? cluster.node_ids : [];
    if (instance && typeof instance.select === 'function') instance.select(ids);
    if (instance && cluster.centroid) {
      const zoom = cluster.density ? Math.max(1.1, Math.min(2.2, 0.9 + cluster.density * 1.4)) : 1.4;
      setCamera({ center: [cluster.centroid.x, cluster.centroid.y, 0], zoom });
    }
    const dominant = (cluster.dominant_types || []).map((type) => format.memoryTypeLabel(type)).join('、') || '—';
    ctx.detail.showCustom({
      title: cluster.label || cluster.id,
      subtitle: `星团 · ${ids.length} 个节点 · 密度 ${Number(cluster.density || 0).toFixed(2)}`,
      content: kit.el('div', { class: 'detail__body' }, [
        kit.el('div', { class: 'detail__section' }, [
          kit.el('div', { class: 'detail__section-title' }, [kit.el('span', { text: '星团组成' })]),
          kit.el('div', { class: 'fca-row', style: { flexWrap: 'wrap', gap: '4px' } }, [
            kit.tag({ label: `主导类型：${dominant}`, tone: cluster.color_hint === 'white' ? 'neutral' : cluster.color_hint }),
            kit.tag({ label: `颜色：${cluster.color_hint || 'white'}`, tone: 'neutral' }),
            kit.tag({ label: `质心 (${Math.round(cluster.centroid ? cluster.centroid.x : 0)}, ${Math.round(cluster.centroid ? cluster.centroid.y : 0)})`, tone: 'neutral' }),
          ]),
        ]),
        kit.el('div', { class: 'detail__section' }, [
          kit.el('div', { class: 'detail__section-title' }, [kit.el('span', { text: `包含节点 · ${ids.length}` })]),
          kit.el('div', { class: 'detail__list' }, ids.slice(0, 40).map((id) => {
            const graph = lastGraph;
            const node = graph && graph.nodes ? graph.nodes.find((n) => n.id === id) : null;
            const row = kit.el('button', { class: 'detail__list-item', type: 'button' }, [
              icon(node && node.kind === 'entity' ? 'users' : 'file', { size: 13 }),
              kit.el('span', { class: 'fca-grow fca-truncate', text: node ? node.label : id }),
              kit.el('span', { class: 'fca-muted', text: node ? (node.kind === 'entity' ? format.entityKindLabel(node.type) : format.memoryTypeLabel(node.type)) : '' }),
            ]);
            row.addEventListener('click', () => (node && node.kind === 'entity' ? ctx.detailPanelRef && ctx.detailPanelRef.showEntity(id) : actions.openMemory(id, { focus: true })));
            return row;
          })),
        ]),
        kit.el('div', { class: 'fca-row', style: { marginTop: '8px', gap: '8px' } }, [
          kit.button({ label: '聚焦该星团', icon: 'compass', variant: 'secondary', size: 'sm', onClick: () => focusCluster(cluster) }),
          kit.button({ label: '复制节点 ID', icon: 'copy', variant: 'ghost', size: 'sm', onClick: () => actions.copyText(ids.join('\n')) }),
        ]),
      ]),
    });
    if (mode !== 'clusters') {
      mode = 'clusters';
      renderModeSwitch();
      applyMapping();
    }
    renderClusterBar();
    renderLegend();
    toast(`已聚焦星团：${cluster.label || cluster.id}`, { type: 'info', duration: 1600 });
  }

  // ------------------------------------------------------------- HUD / 状态
  function updateHud(stats) {
    if (!dom.hud) return;
    const state = store.getState();
    const s = stats || (instance && typeof instance.getStats === 'function' ? instance.getStats() : null);
    const graph = filteredGraph || lastGraph;
    const nodeCount = graph ? (graph.nodes || []).length : 0;
    const edgeCount = graph ? (graph.edges || []).length : 0;
    const clusterCount = graph ? (graph.clusters || []).length : 0;
    dom.hud.innerHTML = '';
    if (s) {
      const fpsValue = Number(s.fps) || 0;
      const fpsClass = fpsValue >= 50 ? 'atlas-hud__value--good' : fpsValue >= 30 ? 'atlas-hud__value--warn' : '';
      dom.hud.appendChild(kit.el('span', { class: 'atlas-hud__item' }, [kit.el('span', { text: 'FPS' }), kit.el('span', { class: `atlas-hud__value ${fpsClass}`, text: String(Math.round(fpsValue)) })]));
      dom.hud.appendChild(kit.el('span', { class: 'atlas-hud__item' }, [kit.el('span', { text: 'FRAME' }), kit.el('span', { class: 'atlas-hud__value', text: `${Math.round(Number(s.frame_ms) || 0)} ms` })]));
      if (s.draw_calls) dom.hud.appendChild(kit.el('span', { class: 'atlas-hud__item' }, [kit.el('span', { text: 'DRAW' }), kit.el('span', { class: 'atlas-hud__value', text: String(s.draw_calls) })]));
    }
    dom.hud.appendChild(kit.el('span', { class: 'atlas-hud__item' }, [kit.el('span', { text: 'NODES' }), kit.el('span', { class: 'atlas-hud__value', text: `${nodeCount}` })]));
    dom.hud.appendChild(kit.el('span', { class: 'atlas-hud__item' }, [kit.el('span', { text: 'EDGES' }), kit.el('span', { class: 'atlas-hud__value', text: `${edgeCount}` })]));
    dom.hud.appendChild(kit.el('span', { class: 'atlas-hud__item' }, [kit.el('span', { text: 'CLUSTERS' }), kit.el('span', { class: 'atlas-hud__value', text: `${clusterCount}` })]));
    dom.hud.appendChild(kit.el('span', { class: 'atlas-hud__item' }, [kit.el('span', { text: 'LAYOUT' }), kit.el('span', { class: 'atlas-hud__value', text: `#${state.graph.layoutVersion || 0}` })]));
    dom.hud.appendChild(kit.el('span', { class: 'atlas-hud__item' }, [kit.el('span', { text: 'QUALITY' }), kit.el('span', { class: 'atlas-hud__value', text: state.ui.quality })]));
    dom.hud.appendChild(kit.el('span', { class: 'atlas-hud__item' }, [kit.el('span', { text: 'RENDERER' }), kit.el('span', { class: 'atlas-hud__value', text: engine === 'unity' ? 'Unity' : (usingDevStub ? 'dev-stub' : 'WebGL2') })]));
    if (engine === 'unity') {
      const us = (unityStatus && unityStatus.stats) || {};
      const ready = unityMessageSeen || (unityFrameLoaded && unityAssetsSeen);
      dom.hud.appendChild(kit.el('span', { class: 'atlas-hud__item' }, [
        kit.el('span', { text: 'UNITY' }),
        kit.el('span', { class: 'atlas-hud__value', text: ready ? `${us.nodes != null ? us.nodes : '—'}N/${us.arms != null ? us.arms : '—'}A` : '加载中' }),
      ]));
    }
  }

  function updatePill() {
    if (!dom.statePill) return;
    const state = store.getState();
    dom.statePill.innerHTML = '';
    const runtimeState = state.runtime.state;
    const dotState = runtimeState === 'running' ? 'running' : runtimeState === 'starting' ? 'starting' : runtimeState === 'unhealthy' ? 'unhealthy' : runtimeState === 'incompatible' || runtimeState === 'error' ? 'error' : 'stopped';
    const label = state.graph.source === 'dev-fixture'
      ? 'DEV-ONLY 夹具'
      : runtimeState === 'running'
        ? `实时 · v${state.runtime.version || '?'}`
        : runtimeState === 'starting'
          ? 'Runtime 启动中…'
          : runtimeState === 'error'
            ? 'Runtime 启动失败'
            : 'Runtime 未连接';
    dom.statePill.append(kit.statusDot(dotState), kit.el('span', { text: label }));
  }

  // ------------------------------------------------------------- 订阅
  function subscribeStore() {
    unsubs.push(store.select((s) => s.graph, () => {
      applyGraphFromStore();
    }));
    unsubs.push(store.select((s) => s.filters, () => {
      if (instance) applyFilters();
    }));
    unsubs.push(store.select((s) => s.ui.quality, (level) => applyQuality(level)));
    unsubs.push(store.select((s) => s.ui.legendOpen, () => renderLegend()));
    unsubs.push(store.select((s) => s.ui.overlays, () => applyMapping()));
    unsubs.push(store.select((s) => s.runtime, () => {
      updatePill();
      applyGraphFromStore();
    }));
    unsubs.push(store.select((s) => s.app.view, (view) => {
      if (view === 'atlas') updateHud();
    }));
    // Electron 选中（列表/搜索/星云/右栏打开记忆）→ 同步 Unity 高亮（Unity 引擎且 iframe ready 时）
    unsubs.push(store.select((s) => (s.selection ? s.selection.primaryId : undefined), () => {
      syncSelectionToUnity('selection-store');
    }));
    // 设置项 nebulaEngine 变化（设置弹窗/引擎菜单/其他窗口）→ 重新解析实际引擎
    unsubs.push(store.select((s) => (s.settings ? s.settings.nebulaEngine : undefined), () => {
      if (disposed) return;
      refreshUnityStatus()
        .then(() => applyEngine({ reason: 'settings' }))
        .catch((error) => log.warn('应用星云引擎设置失败', { message: error.message }));
    }));
  }

  function applyGraphFromStore() {
    if (disposed) return;
    const state = store.getState();
    if (!state.graph.data) {
      applyGraph();
      return;
    }
    applyFilters();
    updatePill();
  }

  function subscribeEvents() {
    unsubs.push(events.on('memory:focus', ({ id, depth }) => {
      if (id) focusNode(id, depth || 1);
    }));
    unsubs.push(events.on('node:focus', ({ id, depth }) => {
      if (id) focusNode(id, depth || 1);
    }));
    unsubs.push(events.on('cluster:focus', ({ cluster }) => {
      if (cluster) focusCluster(cluster);
    }));
    unsubs.push(events.on('graph:loaded', () => {
      applyGraphFromStore();
    }));
    unsubs.push(events.on('api:resync', () => {
      applyGraphFromStore();
    }));
    unsubs.push(events.on('quality:change', ({ level }) => applyQuality(level)));
    unsubs.push(events.on('selection:change', ({ ids }) => {
      if (instance && Array.isArray(ids)) {
        try {
          instance.select(ids);
        } catch {
          /* ignore */
        }
      }
      // Unity 引擎：WebGL 实例不存在，改由 iframe 命令通道高亮
      syncSelectionToUnity('selection-event');
    }));
  }

  function renderLayoutPreset() {
    // 由 app.js 管理布局预设，这里无需处理
  }

  return {
    mount,
    unmount,
    activate,
    deactivate,
    handleCommand,
    resize() {
      updateHud();
    },
    getSnapshot() {
      return {
        mode,
        clusterFocusId,
        camera: getCamera(),
        quality: store.getState().ui.quality,
        engine,
        requestedEngine: requestedEngine(),
        selectionSync: {
          lastSentCommand: unitySelectionSync.lastSentCommand,
          lastIncomingId: unitySelectionSync.lastIncomingId,
          lastAcceptedId: unitySelectionSync.lastAcceptedId,
          lastAck: unitySelectionSync.lastAck,
          pendingReplay: unitySelectionSync.pendingReplay,
        },
        unity: unityStatus
          ? { available: unityStatus.available, mode: unityStatus.mode || 'embedded-webgl', state: unityStatus.state, running: Boolean(unityStatus.running), dir: unityStatus.dir || null, port: unityStatus.port || null, iframeReady: unityMessageSeen || (unityFrameLoaded && unityAssetsSeen), stats: unityStatus.stats || null }
          : null,
      };
    },
  };
}

export default { meta, createView };
