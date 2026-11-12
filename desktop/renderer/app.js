/**
 * FCA Memory Atlas — Renderer 壳层编排（应用入口）
 *
 * 职责（契约 renderer/lib/contracts.md）：
 *  - 引导：读取主进程 AppInfo/Settings、绑定 Runtime 状态、初始化 API/Store/事件总线/命令栈
 *  - 三栏布局：左导航/筛选、中视图宿主、右详情面板；面板拖拽 + localStorage + 布局预设
 *  - 顶栏：全局搜索、时间筛选、视图切换、撤销重做、导入导出、设置、运行时状态
 *  - 底栏：运行时/DB/节点统计/SSE 同步/画质/版本
 *  - 视图路由（含 Editor 占位骨架）、快捷键、菜单命令、首次启动向导、核心设置
 *  - 验收钩子 window.__FCA_APP__（Lead/QA/capture 依赖）
 */

import { createEmitter } from './lib/events.js';
import { createStore } from './lib/state.js';
import { createApi } from './lib/api.js';
import { createCommandStack } from './lib/commands.js';
import { createRouter, getRouteDefs, parseHash, buildHash } from './lib/router.js';
import { createPlaceholder } from './lib/placeholder-view.js';
import { createDetailPanel } from './lib/detail-panel.js';
import { openSettingsDialog, openRuntimeStatusDialog } from './lib/settings-dialog.js';
import { openOnboarding } from './lib/onboarding.js';
import { format } from './lib/format.js';
import { ui } from './lib/ui.js';
import { icon } from './ui/icons.js';

// ---------------------------------------------------------------------------
// 环境与常量
// ---------------------------------------------------------------------------
const bridge = window.fca && window.fca.isElectron ? window.fca : null;
const SEARCH_PARAMS = new URLSearchParams(window.location.search);
const CAPTURE_MODE = SEARCH_PARAMS.get('capture') === '1';
const SCENARIO = SEARCH_PARAMS.get('scenario') || null;
const QUERY_VIEW = SEARCH_PARAMS.get('view') || null;
const DEV_MODE = SEARCH_PARAMS.get('dev') === '1';

const STORAGE = {
  layout: 'fca.ui.layout.v1',
  lastView: 'fca.ui.lastView',
  quality: 'fca.ui.quality',
  favorites: 'fca.ui.favorites',
  filters: 'fca.ui.filters',
  sidebar: 'fca.ui.sidebarSections',
};

const RUNTIME_STATE_LABEL = {
  stopped: '本地运行时：未连接',
  starting: '本地运行时：正在启动…',
  running: '本地运行时：已连接',
  unhealthy: '本地运行时：异常',
  incompatible: '本地运行时：版本不兼容',
  stopping: '本地运行时：正在关闭…',
  error: '本地运行时：启动失败',
};

const SYNC_STATE_LABEL = {
  idle: '实时同步：未连接',
  connecting: '实时同步：连接中…',
  connected: '实时同步：已连接',
  reconnecting: '实时同步：重新连接…',
  offline: '实时同步：已断开',
};

const MAIN_TABS = ['atlas', 'timeline', 'list', 'relations'];

const CAPTURE_SCENARIO_VIEW = {
  onboarding: 'atlas',
  settings: 'atlas',
  detail: 'atlas',
  clusters: 'atlas',
};

if (CAPTURE_MODE) document.documentElement.classList.add('capture-mode');

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
function defaultUiState() {
  return {
    theme: 'dark',
    quality: 'high',
    left: { width: 264, collapsed: false, section: 'all' },
    right: { width: 340, collapsed: false, tab: 'detail' },
    legendOpen: true,
    overlays: { labels: true, nebula: true, edges: true },
    toasts: [],
    dialog: null,
    paletteOpen: false,
    statusbarSegments: {},
  };
}

function buildInitialState() {
  return {
    app: {
      ready: false,
      view: 'atlas',
      previousView: null,
      title: 'FCA Memory Atlas',
      version: { app: '0.2.0', electron: '—', node: '—', chrome: '—' },
      dataDir: '',
      logDir: '',
      isFirstRun: true,
      captureMode: CAPTURE_MODE,
      fatalError: null,
    },
    settings: {
      dataDir: '',
      port: 17860,
      runtimeUrl: '',
      autoStartRuntime: true,
      closeRuntimeOnExit: false,
      quality: 'high',
      nebulaEngine: 'unity',
      onboardingCompleted: false,
      devFixtures: false,
    },
    runtime: {
      state: 'stopped',
      url: '',
      dataDir: '',
      port: 17860,
      version: null,
      apiVersion: null,
      uptimeMs: 0,
      initialized: null,
      ownedByDesktop: false,
      clients: null,
      lastError: null,
      checkedAt: null,
      healthStatus: null,
      dbStatus: null,
      logTail: [],
      runtimeEntry: null,
      nodeBin: null,
    },
    connection: {
      sse: 'idle',
      sseAttempts: 0,
      lastEventSeq: 0,
      lastEventAt: null,
      lastSyncAt: null,
      syncState: 'idle',
      syncError: null,
      lagEvents: 0,
    },
    graph: {
      status: 'idle',
      data: null,
      stats: { nodes: 0, edges: 0, clusters: 0, generated_at: null },
      layoutVersion: 0,
      loadedAt: null,
      error: null,
      source: 'runtime',
    },
    selection: { ids: [], primaryId: null, hoverId: null, focusNodeId: null, focusDepth: 1, lastSelectedId: null },
    filters: {
      types: [],
      tags: [],
      projects: [],
      timeRange: { preset: 'all', from: null, to: null },
      query: '',
      includeDeleted: false,
      onlyFavorites: false,
      favorites: new Set(),
    },
    ui: defaultUiState(),
    runtimeDetails: { health: null, dbHealth: null, systemStatus: null, lastPolledAt: null, pollError: null, state: null },
    onboarding: { open: false, step: 1, dataDir: '', port: 17860, busy: false, error: null, runtimeStartError: null },
    detail: { status: 'idle', memory: null, relations: [], versionsCount: 0, layout: null, related: null, error: null, targetId: null },
    search: { status: 'idle', query: '', results: [], tookMs: 0, error: null, open: false },
    notifications: [],
  };
}

const store = createStore(buildInitialState());
const events = createEmitter({
  onError(error, eventName) {
    console.error(`[fca-events] handler error on "${eventName}"`, error);
  },
});

// ---------------------------------------------------------------------------
// 日志 / Toast
// ---------------------------------------------------------------------------
function log(level, scope, message, meta) {
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
  console[method](`[fca:${scope}]`, message, meta || '');
  if (bridge && bridge.app && typeof bridge.app.log === 'function') {
    bridge.app.log(level, scope, String(message), meta || null).catch(() => {});
  }
}

let lastToast = { message: '', at: 0 };
function toast(message, options = {}) {
  const now = Date.now();
  if (message === lastToast.message && now - lastToast.at < 1500) return null;
  lastToast = { message, at: now };
  return ui.toast(message, options);
}

// ---------------------------------------------------------------------------
// 命令栈
// ---------------------------------------------------------------------------
let commandStack = createCommandStack({
  logger: { error: (msg, err) => log('error', 'commands', msg, err ? { message: err.message } : undefined), warn: (msg) => log('warn', 'commands', msg) },
  onChange: (snapshot) => updateUndoRedoButtons(snapshot),
});

function updateUndoRedoButtons(snapshot) {
  const state = snapshot || commandStack.getSnapshot();
  const undoBtn = document.getElementById('btn-undo');
  const redoBtn = document.getElementById('btn-redo');
  if (undoBtn) {
    undoBtn.disabled = !state.canUndo;
    undoBtn.title = state.canUndo ? `撤销：${state.undoLabel || ''} (Ctrl+Z)` : '撤销 (Ctrl+Z)';
  }
  if (redoBtn) {
    redoBtn.disabled = !state.canRedo;
    redoBtn.title = state.canRedo ? `重做：${state.redoLabel || ''} (Ctrl+Shift+Z)` : '重做 (Ctrl+Shift+Z)';
  }
}

// ---------------------------------------------------------------------------
// API / 视图上下文
// ---------------------------------------------------------------------------
const api = createApi({ bridge, events, logger: console });
let routerRef = null;
let detailPanel = null;
let readyDone = false;
let info = null;
let settings = null;
let devFixtureEnabled = DEV_MODE;
let sseStarted = false;
let pollTimer = null;
let detailPollTimer = null;
let graphRefreshTimer = null;
let searchTimer = null;
const tagNames = new Map();
const entityLabels = new Map();

const actions = {
  openMemory(id, options = {}) {
    if (!id) return;
    const graph = store.getState().graph.data;
    const node = graph && graph.nodes ? graph.nodes.find((n) => n.id === id) : null;
    store.patch({ selection: { ids: [id], primaryId: id, lastSelectedId: id } });
    if (options.focus !== false) events.emit('memory:focus', { id });
    if (node && node.kind === 'entity') {
      if (detailPanel) detailPanel.showEntity(id);
      if (routerRef && routerRef.current !== 'atlas') routerRef.navigate('atlas', { focus: id });
      return;
    }
    if (detailPanel) detailPanel.show(id);
    if (routerRef && routerRef.current !== 'atlas') {
      routerRef.navigate('atlas', { focus: id });
    }
  },
  openEditor(id) {
    if (!routerRef) return false;
    routerRef.navigate('editor', id ? { id } : {});
    return true;
  },
  selectNodes(ids) {
    const list = Array.isArray(ids) ? ids : [];
    store.patch({ selection: { ids: list, primaryId: list[0] || null } });
    events.emit('selection:change', { ids: list, primaryId: list[0] || null });
    if (list.length === 1 && detailPanel) detailPanel.show(list[0]);
    if (!list.length && detailPanel) detailPanel.clear();
  },
  clearSelection() {
    store.patch({ selection: { ids: [], primaryId: null, hoverId: null, focusNodeId: null } });
    events.emit('selection:change', { ids: [], primaryId: null });
    if (detailPanel) detailPanel.clear();
  },
  async deleteMemory(id) {
    if (!id) return false;
    const memoryId = id;
    const graph = store.getState().graph.data;
    const node = graph && graph.nodes ? graph.nodes.find((n) => n.id === memoryId) : null;
    const label = node ? node.label : memoryId;
    const ok = await ui.confirm({
      title: '删除记忆',
      message: `确定删除「${label}」？`,
      detail: '软删除会保留版本历史，可在回收站恢复；不会删除与它关联的其它记忆。',
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return false;
    try {
      await commandStack.execute({
        id: `delete:${memoryId}`,
        label: `删除「${label}」`,
        do: () => api.deleteMemory(memoryId),
        undo: () => api.restoreMemory(memoryId),
      });
      toast('已删除（可撤销）', { type: 'success', duration: 2600, action: { label: '撤销', onClick: () => commandStack.undo() } });
      if (detailPanel) detailPanel.clear();
      actions.clearSelection();
      scheduleGraphRefresh('delete');
      return true;
    } catch (error) {
      toast(`删除失败：${api.userMessage(error)}`, { type: 'error' });
      return false;
    }
  },
  startRuntime() {
    return startRuntime();
  },
  openRuntimeStatus() {
    return openRuntimeStatus();
  },
  persistUiLayout() {
    persistUiLayout();
  },
  cacheMemoryTags: (memory) => cacheTagNames(memory),
  setFilters(patch, options = {}) {
    const current = store.getState().filters;
    const next = { ...current, ...(patch || {}) };
    store.patch({ filters: next });
    persistFilters();
    events.emit('filters:change', { filters: next });
    renderLeftSections();
    renderStatusbar();
    if (options.refresh) loadGraph({ reason: 'filter' });
  },
  toggleFavorite(id) {
    const favorites = new Set(store.getState().filters.favorites);
    const isFav = favorites.has(id);
    if (isFav) favorites.delete(id);
    else favorites.add(id);
    store.patch({ filters: { favorites } });
    persistFavorites(favorites);
    renderLeftSections();
    if (detailPanel) detailPanel.updateFavorite(id, !isFav);
    toast(isFav ? '已取消收藏' : '已加入收藏', { type: 'info', duration: 1800 });
    return !isFav;
  },
  isFavorite(id) {
    return store.getState().filters.favorites.has(id);
  },
  openOnboarding(options) {
    return openOnboardingDialog(options);
  },
  openSettings() {
    return openSettings();
  },
  refreshGraph() {
    return loadGraph({ reason: 'manual' });
  },
  focusNode(id, depth = 1) {
    events.emit('node:focus', { id, depth });
  },
  setQuality(level) {
    setQuality(level);
  },
  /** 切换星云渲染引擎并持久化到 desktop settings（unity|webgl） */
  async setNebulaEngine(next) {
    if (next !== 'unity' && next !== 'webgl') return false;
    const current = store.getState().settings && store.getState().settings.nebulaEngine;
    if (bridge && bridge.app && typeof bridge.app.saveSettings === 'function') {
      try {
        const result = await bridge.app.saveSettings({ nebulaEngine: next });
        if (!result || !result.ok) {
          const errors = result && Array.isArray(result.errors) ? result.errors : [];
          toast(errors.length ? `保存星云引擎设置失败：${errors.map((e) => e.message).join('；')}` : '保存星云引擎设置失败', { type: 'error', duration: 6000 });
          return false;
        }
        applySettingsToState(result.settings);
      } catch (error) {
        toast(`保存星云引擎设置失败：${error.message}`, { type: 'error' });
        return false;
      }
    } else {
      store.patch({ settings: { ...(store.getState().settings || {}), nebulaEngine: next } });
    }
    log('info', 'nebula', '星云渲染引擎设置已更新', { from: current || null, to: next });
    events.emit('nebula:engine-changed', { engine: next });
    toast(next === 'unity' ? '已切换为 Unity 星云（独立窗口）' : '已切换为 WebGL 星云（内置渲染）', { type: 'info', duration: 2400 });
    return true;
  },
  toast,
  log,
};

// 视图日志门面：统一走 "view" scope，写入主进程日志文件（并镜像到 DevTools console）。
// 约定：log.info(message, meta) / log.warn(message, meta) / log.error(message, meta)
const viewLog = {
  info: (message, meta) => log('info', 'view', message, meta),
  warn: (message, meta) => log('warn', 'view', message, meta),
  error: (message, meta) => log('error', 'view', message, meta),
};

const ctx = {
  api,
  store,
  events,
  ui,
  format,
  log: viewLog,
  logger: viewLog,
  toast,
  dialogs: {
    confirm: (options) => ui.confirm(options),
    alert: (options) => ui.alert(options),
  },
  router: null,
  detail: null,
  status: {
    set(id, payload) {
      const segments = { ...store.getState().ui.statusbarSegments, [id]: payload };
      store.patch({ ui: { statusbarSegments: segments } });
      renderStatusbar();
    },
    remove(id) {
      const segments = { ...store.getState().ui.statusbarSegments };
      delete segments[id];
      store.patch({ ui: { statusbarSegments: segments } });
      renderStatusbar();
    },
  },
  commands: commandStack,
  actions,
  shell: {
    setTitle: (text) => store.patch({ app: { title: text || 'FCA Memory Atlas' } }),
    focusSearch,
    openView: (id, options) => (routerRef ? routerRef.navigate(id, options) : false),
    openMemory: (id) => actions.openMemory(id),
    openEditor: (id) => actions.openEditor(id),
    showOnboarding: (options) => openOnboardingDialog(options),
    openSettingsDialog: () => openSettings(),
  },
};
ctx.router = {
  get current() {
    return routerRef ? routerRef.current : null;
  },
  get params() {
    return routerRef ? routerRef.params : new URLSearchParams();
  },
  navigate: (id, params) => (routerRef ? routerRef.navigate(id, params) : false),
  onRouteChange: (cb) => {
    if (!routerRef) return () => {};
    return routerRef.router.onRouteChange(cb);
  },
  getRouteDefs,
};
ctx.detail = {
  show: (payload) => detailPanel && detailPanel.showCustom(payload),
  showCustom: (payload) => detailPanel && detailPanel.showCustom(payload),
  clear: () => detailPanel && detailPanel.clear(),
  isOpen: () => store.getState().ui.right.collapsed === false,
  setOpen: (open) => setPanelCollapsed('right', !open),
};

// ---------------------------------------------------------------------------
// UI 引用与静态图标注入
// ---------------------------------------------------------------------------
const dom = {};

function hydrateStaticIcons() {
  for (const node of document.querySelectorAll('[data-icon]')) {
    if (node.querySelector('.icon')) continue;
    const name = node.dataset.icon;
    const size = node.classList.contains('icon-btn--xs') ? 13 : node.classList.contains('icon-btn--sm') ? 15 : node.classList.contains('search-icon') ? 15 : 17;
    node.appendChild(icon(name, { size }));
  }
}

function cacheDom() {
  dom.app = document.getElementById('app');
  dom.titlebar = document.getElementById('titlebar');
  dom.searchInput = document.getElementById('search-input');
  dom.searchResults = document.getElementById('search-results');
  dom.timeFilter = document.getElementById('time-filter');
  dom.viewTabs = document.getElementById('view-tabs');
  dom.runtimePill = document.getElementById('runtime-pill');
  dom.runtimePillLabel = dom.runtimePill.querySelector('.runtime-pill__label');
  dom.btnUndo = document.getElementById('btn-undo');
  dom.btnRedo = document.getElementById('btn-redo');
  dom.btnRefresh = document.getElementById('btn-refresh');
  dom.btnImport = document.getElementById('btn-import');
  dom.btnExport = document.getElementById('btn-export');
  dom.btnSettings = document.getElementById('btn-settings');
  dom.leftPanel = document.getElementById('left-panel');
  dom.rightPanel = document.getElementById('right-panel');
  dom.leftScroll = document.getElementById('left-scroll');
  dom.detailScroll = document.getElementById('detail-scroll');
  dom.detailEmpty = document.getElementById('detail-empty');
  dom.rightTitle = document.getElementById('right-title');
  dom.btnCollapseLeft = document.getElementById('btn-collapse-left');
  dom.btnCollapseRight = document.getElementById('btn-collapse-right');
  dom.btnDetailMore = document.getElementById('btn-detail-more');
  dom.navPrimary = document.getElementById('nav-primary');
  dom.navTypesBody = document.getElementById('nav-types-body');
  dom.navProjectsBody = document.getElementById('nav-projects-body');
  dom.navTagsBody = document.getElementById('nav-tags-body');
  dom.navTagsCount = document.getElementById('nav-tags-count');
  dom.navFavoritesBody = document.getElementById('nav-favorites-body');
  dom.navFavoritesCount = document.getElementById('nav-favorites-count');
  dom.navDatasetBody = document.getElementById('nav-dataset-body');
  dom.layoutPreset = document.getElementById('layout-preset');
  dom.qualitySelect = document.getElementById('quality-select');
  dom.statusRuntimeDot = document.getElementById('status-runtime-dot');
  dom.statusRuntimeLabel = document.getElementById('status-runtime-label');
  dom.statusRuntimeVersion = document.getElementById('status-runtime-version');
  dom.statusRuntimeAction = document.getElementById('status-runtime-action');
  dom.statusCounts = document.getElementById('status-counts');
  dom.statusDb = document.getElementById('status-db');
  dom.statusSync = document.getElementById('status-sync');
  dom.statusSyncLabel = document.getElementById('status-sync-label');
  dom.statusFps = document.getElementById('status-fps');
  dom.statusAppVersion = document.getElementById('status-app-version');
  dom.statusCenter = document.querySelector('.statusbar__center');
  dom.viewHost = document.getElementById('view-host');
  dom.overlayRoot = document.getElementById('overlay-root');
  dom.appBody = document.getElementById('app-body');
  dom.resizerLeft = document.getElementById('resizer-left');
  dom.resizerRight = document.getElementById('resizer-right');
}

// ---------------------------------------------------------------------------
// localStorage 持久化
// ---------------------------------------------------------------------------
function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function restoreUiState() {
  const savedLayout = readJson(STORAGE.layout, null);
  if (savedLayout && typeof savedLayout === 'object') {
    const uiState = store.getState().ui;
    store.patch({
      ui: {
        left: { ...uiState.left, ...(savedLayout.left || {}) },
        right: { ...uiState.right, ...(savedLayout.right || {}) },
        legendOpen: savedLayout.legendOpen !== undefined ? Boolean(savedLayout.legendOpen) : uiState.legendOpen,
        overlays: { ...uiState.overlays, ...(savedLayout.overlays || {}) },
      },
    });
  }
  const quality = localStorage.getItem(STORAGE.quality);
  if (quality && ['ultra', 'high', 'medium', 'low', 'off'].includes(quality)) {
    store.patch({ ui: { quality } });
  }
  const favorites = readJson(STORAGE.favorites, []);
  if (Array.isArray(favorites)) store.patch({ filters: { favorites: new Set(favorites) } });
  const savedFilters = readJson(STORAGE.filters, null);
  if (savedFilters && typeof savedFilters === 'object') {
    store.patch({
      filters: {
        types: Array.isArray(savedFilters.types) ? savedFilters.types : [],
        tags: Array.isArray(savedFilters.tags) ? savedFilters.tags : [],
        projects: Array.isArray(savedFilters.projects) ? savedFilters.projects : [],
        timeRange: savedFilters.timeRange && typeof savedFilters.timeRange === 'object'
          ? { preset: savedFilters.timeRange.preset || 'all', from: savedFilters.timeRange.from || null, to: savedFilters.timeRange.to || null }
          : { preset: 'all', from: null, to: null },
        includeDeleted: Boolean(savedFilters.includeDeleted),
        onlyFavorites: Boolean(savedFilters.onlyFavorites),
      },
    });
  }
}

let persistTimer = null;
function persistUiLayout() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const state = store.getState();
    writeJson(STORAGE.layout, {
      left: { width: state.ui.left.width, collapsed: state.ui.left.collapsed },
      right: { width: state.ui.right.width, collapsed: state.ui.right.collapsed },
      legendOpen: state.ui.legendOpen,
      overlays: state.ui.overlays,
    });
  }, 240);
}

function persistFilters() {
  const filters = store.getState().filters;
  writeJson(STORAGE.filters, {
    types: filters.types,
    tags: filters.tags,
    projects: filters.projects,
    timeRange: filters.timeRange,
    includeDeleted: filters.includeDeleted,
    onlyFavorites: filters.onlyFavorites,
  });
}

function persistFavorites(favorites) {
  writeJson(STORAGE.favorites, Array.from(favorites));
}

// ---------------------------------------------------------------------------
// 布局
// ---------------------------------------------------------------------------
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function applyLayout() {
  const state = store.getState();
  const left = state.ui.left;
  const right = state.ui.right;
  dom.leftPanel.classList.toggle('is-collapsed', Boolean(left.collapsed));
  dom.rightPanel.classList.toggle('is-collapsed', Boolean(right.collapsed));
  dom.appBody.style.setProperty('--fca-left-width', `${clamp(left.width, 200, 460)}px`);
  dom.appBody.style.setProperty('--fca-right-width', `${clamp(right.width, 280, 600)}px`);
  dom.btnCollapseLeft.title = left.collapsed ? '展开左栏' : '收起左栏';
  dom.btnCollapseRight.title = right.collapsed ? '展开右栏' : '收起右栏';
  dom.layoutPreset.value = detectLayoutPreset(left, right);
}

function detectLayoutPreset(left, right) {
  if (left.collapsed && right.collapsed) return 'wide';
  if (left.collapsed && !right.collapsed) return 'focus';
  return 'default';
}

function setPanelCollapsed(side, collapsed) {
  const state = store.getState();
  const patch = side === 'left' ? { ui: { left: { ...state.ui.left, collapsed } } } : { ui: { right: { ...state.ui.right, collapsed } } };
  store.patch(patch);
  applyLayout();
  persistUiLayout();
  events.emit('layout:change', { side, collapsed });
}

function applyLayoutPreset(preset) {
  const state = store.getState();
  if (preset === 'wide') {
    // 宽画布：左右栏都收起，最大化星云画布
    store.patch({ ui: { left: { ...state.ui.left, collapsed: true, width: 264 }, right: { ...state.ui.right, collapsed: true, width: 340 } } });
  } else if (preset === 'focus') {
    // 专注阅读：收起左栏，保留右侧详情
    store.patch({ ui: { left: { ...state.ui.left, collapsed: true, width: 264 }, right: { ...state.ui.right, collapsed: false, width: 380 } } });
  } else {
    store.patch({ ui: { left: { ...state.ui.left, collapsed: false, width: 264 }, right: { ...state.ui.right, collapsed: false, width: 340 } } });
  }
  applyLayout();
  persistUiLayout();
  dom.layoutPreset.value = preset;
  toast(`已应用布局预设：${{ default: '默认三栏', wide: '宽画布', focus: '专注阅读' }[preset] || preset}`, { type: 'info', duration: 1600 });
}

function setupResizers() {
  const startDrag = (side, event) => {
    event.preventDefault();
    const state = store.getState();
    const startX = event.clientX;
    const startWidth = side === 'left' ? state.ui.left.width : state.ui.right.width;
    const resizer = side === 'left' ? dom.resizerLeft : dom.resizerRight;
    resizer.classList.add('is-dragging');
    document.body.style.cursor = 'col-resize';
    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const next = clamp(startWidth + (side === 'left' ? dx : -dx), side === 'left' ? 200 : 280, side === 'left' ? 460 : 600);
      if (side === 'left') {
        store.patch({ ui: { left: { ...store.getState().ui.left, width: next, collapsed: false } } });
      } else {
        store.patch({ ui: { right: { ...store.getState().ui.right, width: next, collapsed: false } } });
      }
      applyLayout();
    };
    const onUp = () => {
      resizer.classList.remove('is-dragging');
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      persistUiLayout();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  dom.resizerLeft.addEventListener('pointerdown', (event) => startDrag('left', event));
  dom.resizerRight.addEventListener('pointerdown', (event) => startDrag('right', event));
  dom.resizerLeft.addEventListener('dblclick', () => {
    store.patch({ ui: { left: { ...store.getState().ui.left, width: 264, collapsed: false } } });
    applyLayout();
    persistUiLayout();
  });
  dom.resizerRight.addEventListener('dblclick', () => {
    store.patch({ ui: { right: { ...store.getState().ui.right, width: 340, collapsed: false } } });
    applyLayout();
    persistUiLayout();
  });
}

// ---------------------------------------------------------------------------
// 左侧导航 / 筛选
// ---------------------------------------------------------------------------
function currentBaseGraph() {
  const graph = store.getState().graph.data;
  if (!graph) return null;
  return graph;
}

function graphMemoryTypeCounts(graph) {
  const counts = new Map();
  if (!graph || !graph.nodes) return counts;
  for (const node of graph.nodes) {
    if (node.kind !== 'memory') continue;
    counts.set(node.type, (counts.get(node.type) || 0) + 1);
  }
  return counts;
}

function graphProjectCounts(graph) {
  const counts = new Map();
  if (!graph || !graph.nodes) return counts;
  const projectNodes = graph.nodes.filter((n) => n.kind === 'entity' && n.type === 'project');
  const projectIds = new Set(projectNodes.map((n) => n.id));
  const adjacency = new Map();
  for (const edge of graph.edges || []) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.from).push(edge.to);
    adjacency.get(edge.to).push(edge.from);
  }
  for (const project of projectNodes) {
    const neighbors = adjacency.get(project.id) || [];
    counts.set(project.id, { label: project.label, count: neighbors.filter((id) => !projectIds.has(id)).length });
  }
  return counts;
}

function collectTags(graph) {
  const counts = new Map();
  if (!graph || !graph.nodes) return counts;
  for (const node of graph.nodes) {
    if (node.kind !== 'memory') continue;
    const tagIds = Array.isArray(node.tags) ? node.tags : [];
    const names = Array.isArray(node.tag_names) ? node.tag_names : [];
    tagIds.forEach((tagId, index) => {
      if (!tagNames.has(tagId) && names[index]) tagNames.set(tagId, names[index]);
      counts.set(tagId, (counts.get(tagId) || 0) + 1);
    });
  }
  return counts;
}

function renderPrimaryNav() {
  const state = store.getState();
  if (!dom.navPrimary) return;
  dom.navPrimary.innerHTML = '';
  const defs = getRouteDefs().filter((def) => def.nav !== false);
  for (const def of defs) {
    const item = ui.el('button', {
      class: `nav-item${state.app.view === def.id ? ' is-active' : ''}`,
      type: 'button',
      'data-view': def.id,
      title: def.title,
    }, [icon(def.icon || 'compass', { size: 16 }), ui.el('span', { class: 'nav-item__label', text: def.title })]);
    item.addEventListener('click', () => routerRef && routerRef.navigate(def.id));
    dom.navPrimary.appendChild(item);
    if (def.id === 'atlas') {
      const clusterItem = ui.el('button', {
        class: `nav-item nav-item--sub${state.app.view === 'atlas' && routerRef && routerRef.params.get('mode') === 'clusters' ? ' is-active' : ''}`,
        type: 'button',
        title: '聚类星域',
      }, [icon('sparkles', { size: 16 }), ui.el('span', { class: 'nav-item__label', text: '聚类星域' })]);
      clusterItem.addEventListener('click', () => routerRef && routerRef.navigate('atlas', { mode: 'clusters' }));
      dom.navPrimary.appendChild(clusterItem);
    }
  }
  // 收藏入口（导航内）
  const favCount = state.filters.favorites.size;
  const favItem = ui.el('button', {
    class: 'nav-item',
    type: 'button',
    title: '只显示收藏',
  }, [icon('star', { size: 16 }), ui.el('span', { class: 'nav-item__label', text: '只看收藏' }), favCount ? ui.el('span', { class: 'nav-item__count', text: String(favCount) }) : null]);
  favItem.classList.toggle('is-active', Boolean(state.filters.onlyFavorites));
  favItem.addEventListener('click', () => actions.setFilters({ onlyFavorites: !store.getState().filters.onlyFavorites }));
  dom.navPrimary.appendChild(favItem);
}

function renderTypeFilters() {
  const baseGraph = currentBaseGraph();
  const filters = store.getState().filters;
  const counts = graphMemoryTypeCounts(baseGraph);
  dom.navTypesBody.innerHTML = '';
  const ordered = Object.keys(format.labels.memoryTypes);
  let rendered = 0;
  for (const type of ordered) {
    const count = counts.get(type) || 0;
    if (baseGraph && count === 0) continue;
    const active = filters.types.includes(type);
    const row = ui.el('button', { class: `filter-row${active ? ' is-active' : ''}`, type: 'button', 'data-type': type, title: format.memoryTypeLabel(type) }, [
      ui.el('span', { class: 'filter-row__dot', style: { background: `var(--fca-${format.memoryTypeColor(type) === 'neutral' ? 'text-muted' : format.memoryTypeColor(type)})` } }),
      ui.el('span', { class: 'filter-row__label', text: format.memoryTypeLabel(type) }),
      ui.el('span', { class: 'filter-row__count', text: String(count) }),
    ]);
    row.addEventListener('click', () => {
      const next = new Set(store.getState().filters.types);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      actions.setFilters({ types: [...next] });
    });
    dom.navTypesBody.appendChild(row);
    rendered += 1;
  }
  if (!rendered) {
    dom.navTypesBody.appendChild(ui.el('div', { class: 'nav-section__empty', text: baseGraph ? '暂无记忆分类数据' : '等待图谱加载…' }));
  }
}

function renderProjectFilters() {
  const baseGraph = currentBaseGraph();
  const filters = store.getState().filters;
  const projects = graphProjectCounts(baseGraph);
  dom.navProjectsBody.innerHTML = '';
  if (!projects.size) {
    dom.navProjectsBody.appendChild(ui.el('div', { class: 'nav-section__empty', text: baseGraph ? '图谱中暂无项目实体' : '等待图谱加载…' }));
    return;
  }
  let index = 0;
  for (const [id, { label, count }] of projects) {
    if (index > 6) break;
    const active = filters.projects.includes(id);
    const row = ui.el('button', { class: `filter-row${active ? ' is-active' : ''}`, type: 'button', title: label }, [
      icon('folder', { size: 13 }),
      ui.el('span', { class: 'filter-row__label', text: label || id }),
      ui.el('span', { class: 'filter-row__count', text: String(count) }),
    ]);
    row.addEventListener('click', () => {
      const next = new Set(store.getState().filters.projects);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      actions.setFilters({ projects: [...next] });
    });
    dom.navProjectsBody.appendChild(row);
    index += 1;
  }
}

function renderTagFilters() {
  const baseGraph = currentBaseGraph();
  const filters = store.getState().filters;
  const counts = collectTags(baseGraph);
  dom.navTagsBody.innerHTML = '';
  dom.navTagsCount.textContent = counts.size ? `${counts.size} 个` : '';
  if (!counts.size) {
    dom.navTagsBody.appendChild(ui.el('div', { class: 'nav-section__empty', text: baseGraph ? '暂无标签' : '等待图谱加载…' }));
    return;
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
  for (const [tagId, count] of entries) {
    const label = tagNames.get(tagId) || tagId.replace(/^tag_/, '#');
    const active = filters.tags.includes(tagId);
    const node = ui.tag({ label: `${label} ${count}`, tone: active ? 'cyan' : 'neutral', active, onClick: () => {
      const next = new Set(store.getState().filters.tags);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      actions.setFilters({ tags: [...next] });
    } });
    dom.navTagsBody.appendChild(node);
  }
}

function renderFavorites() {
  const baseGraph = currentBaseGraph();
  const favorites = store.getState().filters.favorites;
  dom.navFavoritesBody.innerHTML = '';
  dom.navFavoritesCount.textContent = favorites.size ? `${favorites.size} 个` : '';
  if (!favorites.size) {
    dom.navFavoritesBody.appendChild(ui.el('div', { class: 'nav-section__empty', text: '在详情面板点击星标收藏记忆' }));
    return;
  }
  const nodes = baseGraph && baseGraph.nodes ? baseGraph.nodes : [];
  let rendered = 0;
  for (const id of favorites) {
    const node = nodes.find((n) => n.id === id);
    const row = ui.el('button', { class: 'filter-row', type: 'button', title: node ? node.label : id }, [
      icon('star-filled', { size: 12 }),
      ui.el('span', { class: 'filter-row__label', text: node ? node.label : id }),
    ]);
    row.style.color = 'var(--fca-gold)';
    row.addEventListener('click', () => actions.openMemory(id));
    dom.navFavoritesBody.appendChild(row);
    rendered += 1;
    if (rendered >= 8) break;
  }
}

function renderDatasetInfo() {
  const state = store.getState();
  dom.navDatasetBody.innerHTML = '';
  const source = state.graph.source === 'dev-fixture' ? '开发夹具（DEV-ONLY）' : '本地 Runtime';
  const lines = [
    ['数据源', source],
    ['数据目录', shortenPath(state.app.dataDir || state.settings.dataDir)],
    ['Runtime', state.runtime.state === 'running' ? `v${state.runtime.version || '?'} · API v${state.runtime.apiVersion || '?'}` : RUNTIME_STATE_LABEL[state.runtime.state] || '未连接'],
    ['布局版本', state.graph.layoutVersion ? `#${state.graph.layoutVersion}` : '—'],
  ];
  for (const [label, value] of lines) {
    dom.navDatasetBody.appendChild(ui.el('div', { class: 'filter-row', style: { cursor: 'default' } }, [
      ui.el('span', { class: 'filter-row__label', text: label }),
      ui.el('span', { class: 'filter-row__count', text: value }),
    ]));
  }
  const openBtn = ui.el('button', { class: 'filter-row', type: 'button', title: '打开数据目录' }, [icon('folder', { size: 13 }), ui.el('span', { class: 'filter-row__label', text: '打开数据目录' })]);
  openBtn.addEventListener('click', () => bridge.app.openPath('data').then((res) => {
    if (!res || !res.ok) toast(res && res.error ? res.error : '无法打开数据目录', { type: 'warn' });
  }));
  dom.navDatasetBody.appendChild(openBtn);
}

function shortenPath(p) {
  if (!p) return '—';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return p;
  return `…\\${parts.slice(-2).join('\\')}`;
}

function renderLeftSections() {
  renderPrimaryNav();
  renderTypeFilters();
  renderProjectFilters();
  renderTagFilters();
  renderFavorites();
  renderDatasetInfo();
}

// ---------------------------------------------------------------------------
// 顶栏
// ---------------------------------------------------------------------------
function setupTopbar() {
  // 视图切换 tabs
  dom.viewTabs.innerHTML = '';
  for (const def of getRouteDefs().filter((d) => MAIN_TABS.includes(d.id))) {
    const btn = ui.el('button', {
      class: `segmented__item${def.id === 'atlas' ? ' is-active' : ''}`,
      type: 'button',
      role: 'tab',
      'data-view': def.id,
      title: def.title,
    }, [icon(def.icon, { size: 14 }), ui.el('span', { text: def.title })]);
    btn.addEventListener('click', () => routerRef && routerRef.navigate(def.id));
    dom.viewTabs.appendChild(btn);
  }

  dom.btnUndo.addEventListener('click', () => commandStack.undo());
  dom.btnRedo.addEventListener('click', () => commandStack.redo());
  dom.btnRefresh.addEventListener('click', () => loadGraph({ reason: 'manual' }));
  dom.btnImport.addEventListener('click', doImport);
  dom.btnExport.addEventListener('click', doExport);
  dom.btnSettings.addEventListener('click', () => openSettings());
  dom.runtimePill.addEventListener('click', () => openRuntimeStatus());
  dom.btnCollapseLeft.addEventListener('click', () => setPanelCollapsed('left', !store.getState().ui.left.collapsed));
  dom.btnCollapseRight.addEventListener('click', () => setPanelCollapsed('right', !store.getState().ui.right.collapsed));
  dom.layoutPreset.addEventListener('change', () => applyLayoutPreset(dom.layoutPreset.value));
  dom.btnDetailMore.addEventListener('click', () => openDetailMoreMenu());

  // 搜索
  dom.searchInput.addEventListener('input', () => scheduleSearch(dom.searchInput.value));
  dom.searchInput.addEventListener('keydown', onSearchKeyDown);
  dom.searchInput.addEventListener('focus', () => {
    if (dom.searchInput.value.trim()) scheduleSearch(dom.searchInput.value);
  });
  document.addEventListener('pointerdown', (event) => {
    if (!dom.searchResults.hidden && event.target instanceof Node && !dom.searchResults.contains(event.target) && event.target !== dom.searchInput) {
      hideSearchResults();
    }
  });

  // 时间筛选
  dom.timeFilter.addEventListener('change', () => {
    const preset = dom.timeFilter.value;
    const range = format.presetRange(preset);
    actions.setFilters({ timeRange: { preset, from: range.from, to: range.to } });
  });

  // 画质
  dom.qualitySelect.value = store.getState().ui.quality;
  dom.qualitySelect.addEventListener('change', () => setQuality(dom.qualitySelect.value));

  // 状态栏启动按钮
  dom.statusRuntimeAction.addEventListener('click', () => startRuntime());

  updateUndoRedoButtons();
  syncFilterControls();
}

function syncFilterControls() {
  const filters = store.getState().filters;
  if (dom.timeFilter) dom.timeFilter.value = filters.timeRange.preset || 'all';
}

function focusSearch() {
  dom.searchInput.focus();
  dom.searchInput.select();
}

// ---------------------------------------------------------- 全局搜索
function scheduleSearch(rawQuery) {
  const query = String(rawQuery || '').trim();
  if (searchTimer) clearTimeout(searchTimer);
  if (!query) {
    hideSearchResults();
    return;
  }
  searchTimer = setTimeout(() => performSearch(query), 280);
}

async function performSearch(query) {
  const runtimeState = store.getState().runtime.state;
  store.patch({ search: { status: 'loading', query } });
  if (runtimeState !== 'running') {
    store.patch({ search: { status: 'error', error: 'Runtime 未连接，无法搜索', results: [] } });
    renderSearchResults();
    return;
  }
  try {
    const result = await api.searchMemory({
      query,
      mode: 'fulltext',
      filters: api.buildFilters(store.getState().filters),
      limit: 20,
    });
    const items = Array.isArray(result && result.items) ? result.items : [];
    for (const item of items) if (item && item.memory) cacheTagNames(item.memory);
    store.patch({ search: { status: 'ready', results: items, tookMs: result && result.took_ms ? result.took_ms : 0, error: null, open: true } });
    renderSearchResults();
  } catch (error) {
    store.patch({ search: { status: 'error', error: api.userMessage(error), results: [], open: true } });
    renderSearchResults();
  }
}

let searchActiveIndex = -1;

function renderSearchResults() {
  const search = store.getState().search;
  dom.searchResults.hidden = false;
  dom.searchResults.innerHTML = '';
  searchActiveIndex = -1;
  if (search.status === 'loading') {
    dom.searchResults.appendChild(ui.el('div', { class: 'search-empty' }, [ui.spinner({ label: '正在检索…' })]));
    return;
  }
  if (search.status === 'error') {
    dom.searchResults.appendChild(ui.el('div', { class: 'search-empty', text: search.error || '搜索失败' }));
    return;
  }
  if (!search.results.length) {
    dom.searchResults.appendChild(ui.el('div', { class: 'search-empty', text: `未找到与「${search.query}」相关的记忆` }));
    return;
  }
  const header = ui.el('div', { class: 'search-empty', style: { textAlign: 'left', padding: '4px 8px', color: 'var(--fca-text-faint)' }, text: `${search.results.length} 条结果 · ${search.tookMs || 0} ms` });
  dom.searchResults.appendChild(header);
  search.results.forEach((item, index) => {
    const memory = item.memory || {};
    const title = memory.title || '(无标题)';
    const excerpt = (item.highlights && (item.highlights.body || item.highlights.title)) || memory.body || '';
    const row = ui.el('button', { class: 'search-result', type: 'button', 'data-index': String(index) }, [
      ui.el('div', { class: 'search-result__title', text: title }),
      excerpt ? ui.el('div', { class: 'search-result__meta fca-truncate', text: stripHtml(excerpt).slice(0, 110) }) : null,
      ui.el('div', { class: 'search-result__meta' }, [
        ui.el('span', { text: format.memoryTypeLabel(memory.memory_type) }),
        ui.el('span', { text: format.date(memory.occurred_at) }),
        ui.el('span', { text: `相关度 ${item.score !== undefined ? Number(item.score).toFixed(2) : '—'}` }),
      ]),
    ]);
    row.addEventListener('click', () => {
      hideSearchResults();
      dom.searchInput.value = '';
      actions.openMemory(memory.id);
    });
    dom.searchResults.appendChild(row);
  });
}

function stripHtml(text) {
  return String(text || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function hideSearchResults() {
  dom.searchResults.hidden = true;
  dom.searchResults.innerHTML = '';
  searchActiveIndex = -1;
}

function onSearchKeyDown(event) {
  const rows = [...dom.searchResults.querySelectorAll('.search-result')];
  if (event.key === 'Escape') {
    hideSearchResults();
    dom.searchInput.blur();
    return;
  }
  if (!rows.length) {
    if (event.key === 'Enter') {
      event.preventDefault();
      performSearch(dom.searchInput.value.trim());
    }
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    searchActiveIndex = event.key === 'ArrowDown' ? Math.min(rows.length - 1, searchActiveIndex + 1) : Math.max(0, searchActiveIndex - 1);
    rows.forEach((row, index) => row.classList.toggle('is-active', index === searchActiveIndex));
    rows[searchActiveIndex].scrollIntoView({ block: 'nearest' });
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    const target = rows[Math.max(0, searchActiveIndex)];
    if (target) target.click();
  }
}

function cacheTagNames(memory) {
  if (!memory) return;
  const ids = Array.isArray(memory.tags) ? memory.tags : [];
  const names = Array.isArray(memory.tag_names) ? memory.tag_names : [];
  ids.forEach((id, index) => {
    if (names[index]) tagNames.set(id, names[index]);
  });
  if (memory.project && memory.project.entity_id) entityLabels.set(memory.project.entity_id, memory.project.name);
  for (const participant of memory.participants || []) {
    if (participant.entity_id) entityLabels.set(participant.entity_id, participant.name);
  }
}

// ---------------------------------------------------------------------------
// 状态栏
// ---------------------------------------------------------------------------
let lastFps = null;
events.on('nebula:perf', (stats) => {
  lastFps = stats;
  renderStatusbar();
});

function renderStatusbar() {
  if (!dom.statusRuntimeDot) return;
  const state = store.getState();
  const runtime = state.runtime;
  const label = RUNTIME_STATE_LABEL[runtime.state] || '本地运行时：未知';
  dom.statusRuntimeDot.dataset.state = runtime.state;
  dom.statusRuntimeLabel.textContent = label;
  if (runtime.state === 'running') {
    dom.statusRuntimeVersion.textContent = `${runtime.version ? `v${runtime.version}` : ''}${runtime.apiVersion ? ` · API v${runtime.apiVersion}` : ''}`;
  } else if (runtime.state === 'error' && runtime.lastError) {
    dom.statusRuntimeVersion.textContent = runtime.lastError.code || '';
  } else {
    dom.statusRuntimeVersion.textContent = '';
  }
  dom.statusRuntimeAction.hidden = !(runtime.state === 'stopped' || runtime.state === 'error');
  dom.statusRuntimeAction.textContent = runtime.state === 'error' ? '重试' : '启动';

  const stats = state.graph.stats || {};
  const totalNodes = Number(stats.total_nodes !== undefined ? stats.total_nodes : stats.nodes) || 0;
  const totalEdges = Number(stats.total_edges !== undefined ? stats.total_edges : stats.edges) || 0;
  const shownNodes = Number(stats.nodes) || 0;
  const shownEdges = Number(stats.edges) || 0;
  const filtered = Boolean(stats.filtered);
  const countsParts = [];
  if (state.graph.status === 'loading') countsParts.push('正在加载图谱…');
  else if (state.graph.status === 'error') countsParts.push('图谱不可用');
  else {
    countsParts.push(`记忆/实体 ${format.number(filtered ? shownNodes : totalNodes)}${filtered ? ` / ${format.number(totalNodes)}` : ''}`);
    countsParts.push(`关系 ${format.number(filtered ? shownEdges : totalEdges)}${filtered ? ` / ${format.number(totalEdges)}` : ''}`);
    countsParts.push(`星团 ${format.number(stats.clusters || 0)}`);
  }
  dom.statusCounts.textContent = countsParts.join(' · ');

  const dbHealth = state.runtimeDetails.dbHealth;
  if (dbHealth) {
    const size = dbHealth.size_bytes || dbHealth.size || dbHealth.db_size_bytes;
    const integrity = dbHealth.integrity || dbHealth.integrity_check || (dbHealth.ok === false ? 'error' : 'ok');
    dom.statusDb.textContent = `DB ${integrity === 'ok' ? '正常' : integrity}${size ? ` · ${format.bytes(size)}` : ''}`;
  } else {
    dom.statusDb.textContent = runtime.state === 'running' ? 'DB —' : '';
  }

  const sseState = state.connection.sse;
  dom.statusSync.dataset.state = sseState;
  dom.statusSyncLabel.textContent = SYNC_STATE_LABEL[sseState] || SYNC_STATE_LABEL.idle;

  if (lastFps && typeof lastFps.fps === 'number') {
    dom.statusFps.textContent = `${lastFps.fps} fps · ${lastFps.frame_ms || Math.round(1000 / Math.max(1, lastFps.fps))} ms`;
  } else {
    dom.statusFps.textContent = '';
  }

  dom.statusAppVersion.textContent = `Alpha ${state.app.version.app || '0.2.0'}`;
  dom.runtimePill.dataset.state = runtime.state;
  dom.runtimePillLabel.textContent = runtime.state === 'running' ? `已连接 · v${runtime.version || '?'}` : {
    stopped: '未连接',
    starting: '启动中',
    unhealthy: '异常',
    incompatible: '不兼容',
    stopping: '关闭中',
    error: '失败',
  }[runtime.state] || '运行时';
  dom.qualitySelect.value = state.ui.quality;

  // 自定义状态栏片段（Editor 组可用）
  const segments = state.ui.statusbarSegments || {};
  const center = dom.statusCenter || document.querySelector('.statusbar__center');
  if (center) {
    for (const [id, segment] of Object.entries(segments)) {
      let node = document.getElementById(`status-extra-${id}`);
      if (!node) {
        node = ui.el('span', { class: 'status-seg status-seg--muted', id: `status-extra-${id}` });
        center.appendChild(node);
      }
      node.textContent = segment && segment.label ? segment.label : '';
      if (segment && segment.tone === 'gold') node.style.color = 'var(--fca-gold)';
    }
    for (const existing of center.querySelectorAll('[id^="status-extra-"]')) {
      const id = existing.id.replace('status-extra-', '');
      if (!segments[id]) existing.remove();
    }
  }
}

// ---------------------------------------------------------------------------
// 运行时 / 数据加载
// ---------------------------------------------------------------------------
function applySettingsToState(nextSettings) {
  if (!nextSettings) return;
  settings = nextSettings;
  store.patch({ settings: nextSettings });
  store.patch({ app: { dataDir: nextSettings.dataDir } });
  devFixtureEnabled = devFixtureEnabled || Boolean(nextSettings.devFixtures);
}

async function bindRuntime() {
  if (!bridge || !bridge.runtime) return;
  try {
    const status = await bridge.runtime.getStatus();
    applyRuntimeStatus(status);
  } catch (error) {
    log('error', 'runtime', '读取 Runtime 状态失败', { message: error.message });
  }
  bridge.runtime.onStatus((status) => applyRuntimeStatus(status));
  bridge.app.onSettingsChanged((payload) => {
    applySettingsToState(payload && payload.settings);
    renderDatasetInfo();
  });
}

let lastRuntimeState = null;
let runtimeErrorToastAt = 0;

function applyRuntimeStatus(status) {
  if (!status) return;
  const prev = lastRuntimeState;
  lastRuntimeState = status.state;
  store.patch({ runtime: status });
  events.emit('runtime:status', status);
  renderStatusbar();
  renderDatasetInfo();
  if (status.state === 'running') {
    if (prev !== 'running') {
      connectAndLoad('runtime-running');
    }
  } else if (status.state === 'stopped' || status.state === 'error' || status.state === 'incompatible') {
    if (prev === 'running' && status.state !== 'running') {
      store.patch({ connection: { sse: 'offline' } });
      renderStatusbar();
    }
    if ((status.state === 'error' || status.state === 'incompatible') && status.lastError && Date.now() - runtimeErrorToastAt > 8000) {
      runtimeErrorToastAt = Date.now();
      toast(status.lastError.message || 'Runtime 异常', {
        type: 'error',
        title: '本地运行时',
        duration: 7000,
        action: { label: '查看状态', onClick: () => openRuntimeStatus() },
      });
    }
  }
}

async function startRuntime() {
  if (!bridge) return;
  dom.statusRuntimeAction.disabled = true;
  toast('正在启动本地 Runtime…', { type: 'info', duration: 2500 });
  try {
    const result = await bridge.runtime.start();
    if (result && result.status) applyRuntimeStatus(result.status);
    if (!result || !result.ok) {
      const error = result && result.error;
      toast(error ? error.message : 'Runtime 启动失败', { type: 'error', title: '启动失败', duration: 8000, action: { label: '查看详情', onClick: () => openRuntimeStatus() } });
    }
  } catch (error) {
    toast(`Runtime 启动失败：${error.message}`, { type: 'error' });
  } finally {
    dom.statusRuntimeAction.disabled = false;
  }
}

let connecting = false;
let lastConnectAttempt = 0;

async function connectAndLoad(reason) {
  if (connecting) return;
  if (Date.now() - lastConnectAttempt < 800 && reason === 'runtime-running') return;
  connecting = true;
  lastConnectAttempt = Date.now();
  try {
    const health = await api.health();
    store.patch({
      runtime: {
        version: health.version || null,
        apiVersion: health.api_version || null,
        initialized: health.initialized !== undefined ? health.initialized : null,
        uptimeMs: health.uptime_ms || 0,
        healthStatus: health.status || null,
        dbStatus: health.db || null,
      },
      runtimeDetails: { health },
    });
    if (String(health.api_version) !== '1') {
      store.patch({ runtime: { state: 'incompatible' } });
      toast(`Runtime API 版本不兼容：需要 v1，实际 v${health.api_version}`, { type: 'error', duration: 10000 });
      return;
    }
    await Promise.all([refreshRuntimeState(), loadGraph({ reason: 'connect' })]);
    startEventStream();
    startPolling();
    if (health.initialized === false) {
      store.patch({ graph: { status: 'ready', data: { api_version: '1', layout_version: 0, view: { center: [0, 0, 0], zoom: 1, view_id: null }, nodes: [], edges: [], clusters: [], stats: { nodes: 0, edges: 0, clusters: 0, generated_at: new Date().toISOString() } }, source: 'runtime' } });
      renderLeftSections();
      renderStatusbar();
      if (!CAPTURE_MODE) openOnboardingDialog({ startStep: 4, reason: 'uninitialized' });
    } else if (!settings || !settings.onboardingCompleted) {
      if (!CAPTURE_MODE) openOnboardingDialog({ reason: 'first-run' });
    }
    log('info', 'runtime', '已连接真实 Runtime', { version: health.version, initialized: health.initialized, url: store.getState().runtime.url || api.baseUrl });
  } catch (error) {
    log('warn', 'runtime', '连接 Runtime 失败', { message: error.message });
    if (devFixtureEnabled) {
      await loadDevFixtures('runtime-unavailable');
    } else {
      store.patch({ graph: { status: 'error', error: { code: error.code || 'NETWORK_ERROR', message: error.userMessage || error.message, traceId: error.traceId || null } } });
      renderLeftSections();
      renderStatusbar();
    }
  } finally {
    connecting = false;
    updateReadyFlags();
  }
}

async function refreshRuntimeState() {
  try {
    const stateData = await api.getState();
    store.patch({ runtimeDetails: { state: stateData } });
    // 防御式提取 tags/entities（Runtime 若在 /state 中提供）
    if (stateData && Array.isArray(stateData.tags)) {
      for (const tag of stateData.tags) {
        if (tag && tag.id && (tag.name || tag.label)) tagNames.set(tag.id, tag.name || tag.label);
      }
    }
    if (stateData && Array.isArray(stateData.entities)) {
      for (const entity of stateData.entities) if (entity && entity.id && entity.name) entityLabels.set(entity.id, entity.name);
    }
    renderLeftSections();
  } catch (error) {
    log('warn', 'state', '读取 /state 失败', { message: error.message });
  }
}

let graphLoadToken = 0;

async function loadGraph(options = {}) {
  const token = ++graphLoadToken;
  store.patch({ graph: { status: 'loading', error: null } });
  events.emit('graph:loading', {});
  renderStatusbar();
  try {
    const data = await api.getGraph();
    if (token !== graphLoadToken) return;
    if (!data || !Array.isArray(data.nodes)) throw new Error('GET /graph 响应格式无效（缺少 nodes）');
    for (const node of data.nodes) {
      if (node && node.id && node.label && node.kind === 'entity') entityLabels.set(node.id, node.label);
      if (Array.isArray(node.tag_ids) && Array.isArray(node.tag_names)) node.tag_ids.forEach((id, i) => node.tag_names[i] && tagNames.set(id, node.tag_names[i]));
    }
    store.patch({
      graph: {
        status: 'ready',
        data,
        stats: data.stats || { nodes: data.nodes.length, edges: (data.edges || []).length, clusters: (data.clusters || []).length, generated_at: new Date().toISOString() },
        layoutVersion: data.layout_version || 0,
        loadedAt: Date.now(),
        error: null,
        source: 'runtime',
      },
    });
    renderLeftSections();
    renderStatusbar();
    events.emit('graph:loaded', { graph: data, reason: options.reason || 'manual' });
    updateReadyFlags();
  } catch (error) {
    if (token !== graphLoadToken) return;
    log('warn', 'graph', '加载图谱失败', { message: error.message, code: error.code });
    if (devFixtureEnabled) {
      await loadDevFixtures('graph-error');
      return;
    }
    store.patch({
      graph: {
        status: 'error',
        error: { code: error.code || 'UNKNOWN', message: error.userMessage || error.message, traceId: error.traceId || null },
        data: null,
      },
    });
    renderLeftSections();
    renderStatusbar();
    events.emit('graph:error', { error });
    updateReadyFlags();
    if (options.reason !== 'sse') toast(`加载图谱失败：${api.userMessage(error)}`, { type: 'error', duration: 5000 });
  }
}

function scheduleGraphRefresh(reason = 'sse') {
  if (graphRefreshTimer) clearTimeout(graphRefreshTimer);
  graphRefreshTimer = setTimeout(() => {
    graphRefreshTimer = null;
    if (store.getState().runtime.state === 'running') loadGraph({ reason });
  }, 650);
}

function startEventStream() {
  if (sseStarted) return;
  sseStarted = true;
  api.events.subscribe({
    onEvent(payload) {
      const { event, seq, type } = payload || {};
      const eventType = type || (event && event.type);
      store.patch({
        connection: {
          lastEventSeq: seq || (event && event.seq) || store.getState().connection.lastEventSeq,
          lastEventAt: Date.now(),
          lagEvents: store.getState().connection.lagEvents + 1,
        },
      });
      events.emit('sse:event', payload);
      if (eventType === 'memory.updated' || eventType === 'memory.deleted' || eventType === 'memory.restored') {
        const subjectId = event && event.subject ? event.subject.id : null;
        if (subjectId && detailPanel && detailPanel.getCurrentId() === subjectId) detailPanel.refresh();
      }
      if (eventType && /^(memory|relation|entity|layout)\.|^restore\.|^import\.|^db\./.test(eventType)) {
        scheduleGraphRefresh('sse');
      }
    },
    onStatus(status) {
      store.patch({ connection: { sse: status.state, sseAttempts: status.attempts || 0, syncError: status.error || null } });
      if (status.state === 'connected') {
        store.patch({ connection: { lastSyncAt: Date.now(), syncState: 'idle', syncError: null, lagEvents: 0 } });
      }
      renderStatusbar();
      events.emit('sse:status', status);
    },
    onResync(payload) {
      if (payload && payload.graph) {
        const data = payload.graph;
        store.patch({
          graph: {
            status: 'ready',
            data,
            stats: data.stats || { nodes: (data.nodes || []).length, edges: (data.edges || []).length, clusters: (data.clusters || []).length, generated_at: new Date().toISOString() },
            layoutVersion: data.layout_version || 0,
            loadedAt: Date.now(),
            error: null,
            source: 'runtime',
          },
          connection: { lastSyncAt: Date.now(), syncState: 'idle', syncError: null, sse: 'connected' },
        });
        renderLeftSections();
        renderStatusbar();
      }
      events.emit('api:resync', payload);
      if (payload && payload.reason !== 'manual') toast('连接已恢复，图谱已重新同步', { type: 'info', duration: 2600 });
    },
  });
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (store.getState().runtime.state === 'running') {
      try {
        const [systemStatus, dbHealth] = await Promise.all([
          api.getSystemStatus().catch(() => null),
          api.getDbHealth().catch(() => null),
        ]);
        store.patch({ runtimeDetails: { systemStatus, dbHealth, lastPolledAt: Date.now(), pollError: null } });
        renderStatusbar();
      } catch (error) {
        store.patch({ runtimeDetails: { pollError: error.message } });
      }
    }
  }, 20000);
  // 立即拉一次 DB 信息
  setTimeout(async () => {
    if (store.getState().runtime.state === 'running') {
      try {
        const [systemStatus, dbHealth] = await Promise.all([api.getSystemStatus().catch(() => null), api.getDbHealth().catch(() => null)]);
        store.patch({ runtimeDetails: { systemStatus, dbHealth, lastPolledAt: Date.now() } });
        renderStatusbar();
      } catch {
        /* ignore */
      }
    }
  }, 1200);
}

async function loadDevFixtures(reason) {
  try {
    const fixtures = await import('./lib/dev/fixtures.js');
    const graph = fixtures.createDevFixtureGraph();
    store.patch({
      graph: {
        status: 'ready',
        data: graph,
        stats: graph.stats,
        layoutVersion: graph.layout_version || 0,
        loadedAt: Date.now(),
        error: null,
        source: 'dev-fixture',
      },
    });
    renderLeftSections();
    renderStatusbar();
    events.emit('graph:loaded', { graph, reason: `dev-fixture:${reason}` });
    toast('Runtime 未就绪：已加载开发夹具数据（DEV-ONLY，仅开发期）', { type: 'warn', duration: 6000 });
    updateReadyFlags();
  } catch (error) {
    log('error', 'dev-fixture', '开发夹具加载失败', { message: error.message });
    store.patch({ graph: { status: 'error', error: { code: 'DEV_FIXTURE_MISSING', message: error.message } } });
    renderStatusbar();
    updateReadyFlags();
  }
}

// ---------------------------------------------------------------------------
// 设置 / 运行时状态 / 数据导入导出
// ---------------------------------------------------------------------------
function openSettings() {
  return openSettingsDialog({
    bridge,
    api,
    store,
    ui,
    toast,
    format,
    info: info || {},
    onSaved: async (payload) => {
      if (payload && payload.settings) applySettingsToState(payload.settings);
      if (payload && payload.requiresRuntimeRestart) {
        const restarted = await ui.confirm({
          title: '需要重启 Runtime',
          message: '数据目录或端口已更改，本地 Runtime 需要重启后生效。',
          detail: '重启期间界面会短暂显示未连接；数据不会丢失。',
          confirmLabel: '立即重启',
          cancelLabel: '稍后手动重启',
        });
        if (restarted) {
          const result = await bridge.runtime.restart();
          if (result && result.status) applyRuntimeStatus(result.status);
          if (!result || !result.ok) toast('Runtime 重启失败，请查看运行时状态', { type: 'error' });
        }
      }
      renderDatasetInfo();
    },
    onShowOnboarding: () => openOnboardingDialog({ force: true }),
  });
}

function openRuntimeStatus() {
  return openRuntimeStatusDialog({
    bridge,
    api,
    store,
    ui,
    format,
    toast,
    onRestart: async () => {
      const result = await bridge.runtime.restart();
      if (result && result.status) applyRuntimeStatus(result.status);
      return result;
    },
    onStart: async () => {
      const result = await bridge.runtime.start();
      if (result && result.status) applyRuntimeStatus(result.status);
      return result;
    },
    onStop: async () => {
      const result = await bridge.runtime.stop({ reason: 'user' });
      if (result && result.status) applyRuntimeStatus(result.status);
      return result;
    },
  });
}

function openDetailMoreMenu() {
  const currentId = detailPanel ? detailPanel.getCurrentId() : null;
  ui.dropdown({
    anchor: dom.btnDetailMore,
    align: 'right',
    items: [
      { label: '刷新详情', icon: 'refresh', onClick: () => (currentId ? detailPanel.show(currentId) : toast('未选中记忆', { type: 'info' })) },
      { label: '在编辑器中打开', icon: 'edit', disabled: !currentId, onClick: () => currentId && actions.openEditor(currentId) },
      { label: '复制记忆 ID', icon: 'copy', disabled: !currentId, onClick: () => currentId && copyText(currentId) },
      { separator: true },
      { label: '收起详情面板', icon: 'panel-right', onClick: () => setPanelCollapsed('right', true) },
    ],
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(String(text));
    toast('已复制到剪贴板', { type: 'success', duration: 1600 });
  } catch {
    toast('复制失败（剪贴板不可用）', { type: 'warn' });
  }
}

async function doExport() {
  if (!bridge) return;
  const state = store.getState();
  const defaultName = `fca-export-${new Date().toISOString().slice(0, 10)}.json`;
  const picked = await bridge.dialog.saveFile({
    title: '导出 FCA 数据',
    defaultPath: joinPath(state.settings.dataDir || state.app.dataDir, defaultName),
    filters: [{ name: 'FCA JSON', extensions: ['json'] }],
  });
  if (!picked || !picked.ok) return;
  toast('正在导出数据…', { type: 'info', duration: 2400 });
  try {
    const result = await api.exportData({ format: 'json', path: picked.path });
    toast(`已导出：${(result && (result.path || result.file || result.file_path)) || picked.path}`, { type: 'success', duration: 5000 });
    log('info', 'data', '导出完成', { path: picked.path });
  } catch (error) {
    toast(`导出失败：${api.userMessage(error)}`, { type: 'error', duration: 6000 });
  }
}

async function doImport() {
  if (!bridge) return;
  const picked = await bridge.dialog.openFile({
    title: '导入 FCA 数据',
    defaultPath: store.getState().settings.dataDir,
    filters: [{ name: 'FCA 导出文件', extensions: ['json', 'jsonl', 'zip'] }],
  });
  if (!picked || !picked.ok || !picked.paths || !picked.paths.length) return;
  const filePath = picked.paths[0];
  const ok = await ui.confirm({
    title: '导入 FCA 数据',
    message: '仅支持导入 FCA 自身导出的 JSON / JSONL / ZIP 文件。',
    detail: '本操作不会迁移或读取任何旧记忆系统数据；导入内容会作为新记忆写入当前数据库。',
    confirmLabel: '开始导入',
    cancelLabel: '取消',
  });
  if (!ok) return;
  toast('正在导入…', { type: 'info', duration: 2400 });
  try {
    const result = await api.importData({ path: filePath });
    toast(`导入完成${result && result.imported !== undefined ? `：${result.imported} 条` : ''}`, { type: 'success', duration: 4000 });
    scheduleGraphRefresh('import');
  } catch (error) {
    toast(`导入失败：${api.userMessage(error)}`, { type: 'error', duration: 6000 });
  }
}

function joinPath(base, name) {
  if (!base) return name;
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`;
}

// ---------------------------------------------------------------------------
// 首次启动向导
// ---------------------------------------------------------------------------
function openOnboardingDialog(options = {}) {
  const state = store.getState();
  return openOnboarding({
    bridge,
    api,
    ui,
    toast,
    format,
    startStep: options.startStep || 1,
    force: Boolean(options.force || options.reason === 'first-run' || SCENARIO === 'onboarding'),
    initial: {
      dataDir: state.onboarding.dataDir || state.settings.dataDir || state.app.dataDir,
      port: state.onboarding.port || state.settings.port || 17860,
    },
    getRuntimeStatus: () => store.getState().runtime,
    onCompleted: async (result) => {
      if (result && result.settings) applySettingsToState(result.settings);
      await connectAndLoad('onboarding-complete');
      renderDatasetInfo();
    },
    onRuntimeStarting: () => {
      dom.statusRuntimeDot.dataset.state = 'starting';
    },
  });
}

// ---------------------------------------------------------------------------
// 读取状态 / 视图 / 就绪
// ---------------------------------------------------------------------------
function updateReadyFlags() {
  if (readyDone) return;
  const state = store.getState();
  const graphStatus = state.graph.status;
  const runtimeState = state.runtime.state;
  if (graphStatus === 'loading') return;
  if (runtimeState === 'starting' || runtimeState === 'stopping') return;
  // Runtime 已连接但图谱还没加载：等 connectAndLoad 完成
  if (runtimeState === 'running' && graphStatus === 'idle') return;
  // 配置为自动启动且尚未启动：等待主进程启动 Runtime 后再就绪
  if ((runtimeState === 'stopped' || runtimeState === 'starting') && settings && settings.autoStartRuntime && !devFixtureEnabled && !CAPTURE_MODE) return;
  readyDone = true;
  store.patch({ app: { ready: true } });
  document.body.dataset.ready = 'true';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.__FCA_READY__ = true;
      document.documentElement.classList.add('is-ready');
      applyCaptureScenario();
    });
  });
}

function setQuality(level) {
  if (!['ultra', 'high', 'medium', 'low', 'off'].includes(level)) return;
  store.patch({ ui: { quality: level } });
  localStorage.setItem(STORAGE.quality, level);
  dom.qualitySelect.value = level;
  events.emit('quality:change', { level });
  log('info', 'render', '画质档位切换', { level });
  if (level === 'off') toast('已关闭星云特效（保留全部交互与可读性）', { type: 'info', duration: 2200 });
}

// ---------------------------------------------------------------------------
// 场景（截图 / e2e）：仅在 capture 模式或显式 scenario 参数下生效
// ---------------------------------------------------------------------------
function applyCaptureScenario() {
  if (!SCENARIO) return;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  setTimeout(async () => {
    try {
      if (SCENARIO === 'onboarding') {
        openOnboardingDialog({ force: true });
      } else if (SCENARIO === 'settings') {
        openSettings();
      } else if (SCENARIO === 'detail') {
        await delay(600);
        const params = new URLSearchParams(location.search);
        const graph = store.getState().graph.data;
        const explicitId = params.get('id') || (routerRef && routerRef.params.get('id'));
        const node = explicitId && graph ? graph.nodes.find((n) => n.id === explicitId) : graph ? graph.nodes.find((n) => n.kind === 'memory') : null;
        if (node) actions.openMemory(node.id);
      } else if (SCENARIO === 'clusters') {
        const graph = store.getState().graph.data;
        if (graph && graph.clusters && graph.clusters.length) {
          bus_emit_cluster_focus(graph.clusters[0]);
        }
      } else if (SCENARIO === 'runtime-error') {
        openRuntimeStatus();
      } else if (SCENARIO === 'search') {
        dom.searchInput.value = '项目';
        performSearch('项目');
      } else if (SCENARIO === 'dev') {
        if (!devFixtureEnabled) {
          devFixtureEnabled = true;
          await loadDevFixtures('scenario');
        }
      }
    } catch (error) {
      log('error', 'capture-scenario', '场景应用失败', { message: error.message });
    }
  }, 320);
}

function bus_emit_cluster_focus(cluster) {
  events.emit('cluster:focus', { cluster });
}

// ---------------------------------------------------------------------------
// 快捷键 / 菜单命令
// ---------------------------------------------------------------------------
function isTypingTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

function forwardToView(command, payload) {
  const instance = routerRef ? routerRef.instance : null;
  if (instance && typeof instance.handleCommand === 'function') {
    try {
      return Boolean(instance.handleCommand(command, payload));
    } catch (error) {
      log('error', 'view-command', '视图命令处理异常', { command, message: error.message });
    }
  }
  return false;
}

function runCommand(command, payload) {
  switch (command) {
    case 'edit:undo':
      commandStack.undo();
      return true;
    case 'edit:redo':
      commandStack.redo();
      return true;
    case 'edit:delete-selection':
      return forwardToView('edit:delete-selection', payload) || (store.getState().selection.primaryId ? deleteSelectedMemory() : toast('未选中记忆', { type: 'info', duration: 1600 }));
    case 'app:focus-search':
      focusSearch();
      return true;
    case 'app:show-onboarding':
      openOnboardingDialog({ force: true });
      return true;
    case 'app:show-runtime-status':
      openRuntimeStatus();
      return true;
    case 'memory:new':
      routerRef && routerRef.navigate('editor', { mode: 'new' });
      return true;
    case 'data:import':
      doImport();
      return true;
    case 'data:export':
      doExport();
      return true;
    case 'data:backup':
      doBackup();
      return true;
    case 'data:restore':
      doRestore();
      return true;
    case 'view:switch':
      if (payload && payload.view) routerRef.navigate(payload.view, payload.params);
      return true;
    case 'view:refresh':
      loadGraph({ reason: 'manual' });
      return true;
    case 'view:fit':
    case 'view:toggle-legend':
    case 'view:cycle-quality':
    case 'esc':
      return forwardToView(command, payload);
    case 'layout:toggle-left':
      setPanelCollapsed('left', !store.getState().ui.left.collapsed);
      return true;
    case 'layout:toggle-right':
      setPanelCollapsed('right', !store.getState().ui.right.collapsed);
      return true;
    case 'layout:preset':
      applyLayoutPreset((payload && payload.preset) || 'default');
      return true;
    default:
      return forwardToView(command, payload);
  }
}

async function deleteSelectedMemory() {
  const id = store.getState().selection.primaryId;
  if (!id) {
    toast('未选中记忆', { type: 'info', duration: 1600 });
    return false;
  }
  return actions.deleteMemory(id);
}

async function doBackup() {
  try {
    toast('正在创建备份…', { type: 'info', duration: 2400 });
    const result = await api.createBackup();
    const path = (result && (result.path || result.backup_path)) || '';
    toast(`备份已创建${path ? `：${path}` : ''}`, { type: 'success', duration: 5000 });
  } catch (error) {
    toast(`备份失败：${api.userMessage(error)}`, { type: 'error', duration: 6000 });
  }
}

async function doRestore() {
  try {
    const result = await api.listBackups();
    const backups = Array.isArray(result && result.items) ? result.items : Array.isArray(result) ? result : [];
    if (!backups.length) {
      toast('暂无可用备份', { type: 'info' });
      return;
    }
    const content = ui.el('div', {});
    const list = ui.el('div', { class: 'detail__list' });
    let selectedId = null;
    backups.forEach((backup) => {
      const row = ui.el('button', { class: 'detail__list-item', type: 'button' }, [
        icon('database', { size: 14 }),
        ui.el('span', { class: 'fca-grow fca-truncate', text: backup.backup_id || backup.id || backup.path || '备份' }),
        ui.el('span', { class: 'fca-muted', text: backup.created_at ? format.datetime(backup.created_at) : '' }),
      ]);
      row.addEventListener('click', () => {
        selectedId = backup.backup_id || backup.id;
        for (const child of list.children) child.classList.remove('is-selected');
        row.classList.add('is-selected');
        row.style.background = 'var(--fca-accent-soft)';
      });
      list.appendChild(row);
    });
    content.appendChild(list);
    const picked = await new Promise((resolve) => {
      const d = ui.dialog({
        title: '恢复备份',
        subtitle: '恢复操作可能需要重启 Runtime；当前数据库会在恢复前自动备份。',
        content,
        width: 560,
        onClose: () => resolve(false),
        actions: [
          { label: '取消', variant: 'ghost', onClick: () => resolve(false) },
          { label: '恢复选中备份', variant: 'primary', onClick: () => resolve(Boolean(selectedId)) },
        ],
      });
      void d;
    });
    if (!picked || !selectedId) return;
    const confirmed = await ui.confirm({ title: '确认恢复', message: '确定用该备份覆盖当前数据库？', detail: '恢复期间请勿写入新数据；如失败数据库将保持不变。', danger: true, confirmLabel: '恢复' });
    if (!confirmed) return;
    const restoreResult = await api.restoreBackup(selectedId);
    if (restoreResult && restoreResult.requires_restart) {
      toast('恢复完成，正在重启 Runtime…', { type: 'info', duration: 3000 });
      const restarted = await bridge.runtime.restart();
      if (restarted && restarted.status) applyRuntimeStatus(restarted.status);
    } else {
      scheduleGraphRefresh('restore');
    }
    toast('备份恢复完成', { type: 'success' });
  } catch (error) {
    toast(`恢复失败：${api.userMessage(error)}`, { type: 'error', duration: 6000 });
  }
}

function setupKeyboard() {
  document.addEventListener('keydown', (event) => {
    const typing = isTypingTarget(event.target);
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 'k' || key === 'f') {
        event.preventDefault();
        focusSearch();
        return;
      }
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        runCommand('edit:undo');
        return;
      }
      if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        runCommand('edit:redo');
        return;
      }
      const num = Number.parseInt(event.key, 10);
      if (num >= 1 && num <= 7 && !typing) {
        const map = { 1: 'atlas', 2: 'atlas', 3: 'timeline', 4: 'relations', 5: 'list', 6: 'data', 7: 'settings' };
        event.preventDefault();
        if (num === 2) routerRef.navigate('atlas', { mode: 'clusters' });
        else routerRef.navigate(map[num]);
        return;
      }
      return;
    }
    if (typing) {
      if (event.key === 'Escape') runCommand('esc');
      return;
    }
    if (event.key === 'F5') {
      event.preventDefault();
      runCommand('view:refresh');
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (store.getState().selection.primaryId) {
        event.preventDefault();
        runCommand('edit:delete-selection');
      }
      return;
    }
    if (event.key === 'Escape') {
      runCommand('esc');
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'f') {
      runCommand('view:fit');
      return;
    }
    if (key === 'l') {
      runCommand('view:toggle-legend');
      return;
    }
    if (key === 'q') {
      const levels = ['ultra', 'high', 'medium', 'low', 'off'];
      const current = store.getState().ui.quality;
      const next = levels[(levels.indexOf(current) + 1) % levels.length];
      setQuality(next);
      return;
    }
    if (key === 'f1') {
      event.preventDefault();
      openOnboardingDialog({ force: true });
    }
  });
}

function setupMenu() {
  if (bridge && bridge.menu) {
    bridge.menu.onCommand((payload) => {
      if (!payload) return;
      log('info', 'menu', '菜单命令', { command: payload.command });
      runCommand(payload.command, payload.payload);
    });
  }
  // 视图内通过事件总线触发的命令（例如空状态里的“导入数据”）
  events.on('menu:command', (payload) => {
    if (payload && payload.command) runCommand(payload.command, payload.payload);
  });
}

// ---------------------------------------------------------------------------
// 视图路由与详情面板
// ---------------------------------------------------------------------------
function setupRouter() {
  const created = createRouter({
    host: dom.viewHost,
    ctx,
    createPlaceholder,
    logger: console,
    onRouteChange: ({ to, params }) => {
      const state = store.getState();
      store.patch({ app: { view: to, previousView: state.app.view === to ? state.app.previousView : state.app.view } });
      localStorage.setItem(STORAGE.lastView, to);
      for (const btn of dom.viewTabs.querySelectorAll('.segmented__item')) {
        btn.classList.toggle('is-active', btn.dataset.view === to);
      }
      renderPrimaryNav();
      renderDatasetInfo();
      events.emit('view:changed', { from: state.app.view, to, params });
      const focusId = params && params.get ? params.get('focus') : null;
      if (focusId && to === 'atlas') {
        setTimeout(() => events.emit('node:focus', { id: focusId }), 60);
        setTimeout(() => {
          if (detailPanel && detailPanel.getCurrentId() !== focusId) detailPanel.show(focusId);
        }, 120);
      }
      updateReadyFlags();
    },
  });
  routerRef = created.router;
  ctx.actions.router = created.router;
  const initial = created.initialRoute();
  const lastView = localStorage.getItem(STORAGE.lastView);
  const queryParams = new URLSearchParams();
  if (QUERY_VIEW) initial.id = QUERY_VIEW;
  else if (initial.id === 'atlas' && lastView && getRouteDefs().some((d) => d.id === lastView)) initial.id = lastView;
  // 保留 hash 参数（如 mode=clusters / id=…）
  if (parseHash()) {
    const parsed = parseHash();
    for (const [key, value] of parsed.params.entries()) queryParams.set(key, value);
    if (!QUERY_VIEW) initial.id = parsed.id;
  }
  if (!parseHash() && initial.id) {
    window.history.replaceState(null, '', buildHash(initial.id, queryParams));
  }
  created.router.mount(initial.id, queryParams).catch((error) => {
    log('error', 'router', '初始视图加载失败', { message: error.message });
  });
}

function setupDetailPanel() {
  detailPanel = createDetailPanel({
    api,
    store,
    ui,
    format,
    events,
    bridge,
    toast,
    log,
    cacheTagNames,
    actions: {
      ...actions,
      cacheEntityLabel: (id, label) => entityLabels.set(id, label),
      getEntityLabel: (id) => entityLabels.get(id),
      getNodeLabel: (id) => {
        const graph = store.getState().graph.data;
        const node = graph && graph.nodes.find((n) => n.id === id);
        return node ? node.label : entityLabels.get(id) || id;
      },
      copyText,
    },
  });
  ctx.detailPanelRef = detailPanel;
}

// ---------------------------------------------------------------------------
// 错误处理
// ---------------------------------------------------------------------------
let lastErrorToastAt = 0;
function setupErrorHandlers() {
  window.addEventListener('error', (event) => {
    const message = event.message || '未知脚本错误';
    log('error', 'renderer', message, { file: event.filename, line: event.lineno, col: event.colno });
    if (Date.now() - lastErrorToastAt > 5000) {
      lastErrorToastAt = Date.now();
      toast(`界面脚本错误：${message}`, { type: 'error', duration: 5000 });
    }
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason && reason.message ? reason.message : String(reason);
    log('error', 'renderer', `未处理的 Promise 拒绝：${message}`, { stack: reason && reason.stack ? String(reason.stack).slice(0, 2000) : null });
  });
}

function renderFatal(message) {
  store.patch({ app: { fatalError: { message } } });
  const root = document.getElementById('view-host');
  if (!root) return;
  root.innerHTML = '';
  const card = ui.el('div', { style: { display: 'flex', flex: '1', alignItems: 'center', justifyContent: 'center', padding: '40px' } }, [
    ui.el('div', { class: 'atlas-status__card' }, [
      ui.el('div', { class: 'atlas-status__orb atlas-status__orb--error' }),
      ui.el('div', { class: 'atlas-status__title', text: '应用初始化失败' }),
      ui.el('div', { class: 'atlas-status__desc', text: message }),
    ]),
  ]);
  root.appendChild(card);
  window.__FCA_FATAL__ = { message };
}

// ---------------------------------------------------------------------------
// 验收钩子
// ---------------------------------------------------------------------------
function installHooks() {
  window.__FCA_APP__ = {
    getState: () => store.getState(),
    navigate: (view, params) => (routerRef ? routerRef.navigate(view, params) : false),
    openMemory: (id) => actions.openMemory(id),
    setQuality: (level) => setQuality(level),
    setFilters: (filters) => actions.setFilters(filters),
    refreshGraph: () => loadGraph({ reason: 'manual' }),
    getGraph: () => store.getState().graph.data,
    getNebulaStats: () => window.__FCA_NEBULA__ && typeof window.__FCA_NEBULA__.getStats === 'function' ? window.__FCA_NEBULA__.getStats() : null,
    getNebulaEngine: () => (store.getState().settings && store.getState().settings.nebulaEngine) || 'unity',
    setNebulaEngine: (engine) => actions.setNebulaEngine(engine),
    getUnityStatus: () => (window.fca && window.fca.unity ? window.fca.unity.getStatus() : null),
    startUnity: () => (window.fca && window.fca.unity ? window.fca.unity.start({}) : null),
    stopUnity: () => (window.fca && window.fca.unity ? window.fca.unity.stop({ reason: 'hook' }) : null),
    getUnityLogTail: (limit) => (window.fca && window.fca.unity ? window.fca.unity.getLogTail(limit) : null),
    openOnboarding: () => openOnboardingDialog({ force: true }),
    openSettings: () => openSettings(),
    getRuntimeStatus: () => store.getState().runtime,
    toast: (message, options) => toast(message, options),
    version: () => store.getState().app.version,
    ready: null,
  };
  window.fcaApp = {
    store,
    api,
    events,
    get router() {
      return routerRef;
    },
    ui,
    format,
    actions,
    version: store.getState().app.version,
  };
  window.__FCA_APP__.ready = new Promise((resolve) => {
    if (window.__FCA_READY__) resolve(window.__FCA_APP__);
    else {
      const timer = setInterval(() => {
        if (window.__FCA_READY__ || window.__FCA_FATAL__) {
          clearInterval(timer);
          resolve(window.__FCA_APP__);
        }
      }, 120);
    }
  });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
async function boot() {
  cacheDom();
  hydrateStaticIcons();
  restoreUiState();
  // capture/QA：URL 显式覆盖 UI 状态，保证批量截图与验收结果可复现（不影响正常启动）
  if (CAPTURE_MODE) {
    const qQuality = SEARCH_PARAMS.get('quality');
    if (qQuality && ['ultra', 'high', 'medium', 'low', 'off'].includes(qQuality)) {
      store.patch({ ui: { quality: qQuality } });
    }
    const qLegend = SEARCH_PARAMS.get('legend');
    if (qLegend === '0' || qLegend === '1') {
      store.patch({ ui: { legendOpen: qLegend === '1' } });
    }
  }
  setupTopbar();
  setupResizers();
  setupKeyboard();
  setupErrorHandlers();
  installHooks();

  if (!bridge) {
    renderFatal('必须以 Electron 桌面应用方式启动（未检测到 window.fca 桥）。\n请在项目根目录运行：Remove-Item Env:ELECTRON_RUN_AS_NODE; & .cache\\electron-dist\\electron.exe desktop');
    updateReadyFlags();
    return;
  }

  try {
    info = await bridge.app.getInfo();
    settings = await bridge.app.getSettings();
  } catch (error) {
    renderFatal(`无法读取应用信息：${error.message}`);
    updateReadyFlags();
    return;
  }

  const uiState = store.getState().ui;
  store.patch({
    app: {
      version: {
        app: info.productVersion || '0.2.0',
        electron: info.versions ? info.versions.electron : '—',
        node: info.versions ? info.versions.node : '—',
        chrome: info.versions ? info.versions.chrome : '—',
      },
      dataDir: info.dataDir || '',
      logDir: info.logDir || '',
      isFirstRun: !(settings && settings.onboardingCompleted),
      captureMode: CAPTURE_MODE,
    },
    runtime: {
      url: info.runtimeUrl || (info.runtime ? info.runtime.url : ''),
      dataDir: info.dataDir || '',
      port: settings.port || 17860,
      runtimeEntry: info.runtimeEntry || null,
      nodeBin: info.nodeBin || null,
      state: info.runtime ? info.runtime.state : 'stopped',
    },
    ui: {
      left: uiState.left,
      right: uiState.right,
    },
  });
  applySettingsToState(settings);
  store.patch({ onboarding: { dataDir: settings.dataDir, port: settings.port } });
  dom.qualitySelect.value = store.getState().ui.quality;
  applyLayout();
  renderLeftSections();
  renderDatasetInfo();
  renderStatusbar();

  setupDetailPanel();
  setupRouter();
  setupMenu();  await bindRuntime();
  updateReadyFlags();

  // 兜底：若 Runtime 一直未就绪，8 秒后仍标记 ready（截图/QA 可呈现离线态），并提示
  setTimeout(() => {
    if (!window.__FCA_READY__) {
      updateReadyFlags();
      window.__FCA_READY__ = true;
      document.documentElement.classList.add('is-ready');
      applyCaptureScenario();
    }
  }, 12000);

  // Runtime 就绪但状态事件早于监听：主动补一次
  setTimeout(async () => {
    if (store.getState().runtime.state === 'running' && store.getState().graph.status === 'idle') {
      connectAndLoad('late-check');
    }
  }, 1500);

  log('info', 'app', 'Renderer 壳层已启动', {
    version: info.productVersion,
    electron: info.versions && info.versions.electron,
    dataDir: info.dataDir,
    runtimeUrl: info.runtimeUrl,
    captureMode: CAPTURE_MODE,
    scenario: SCENARIO,
  });
}

window.addEventListener('beforeunload', () => {
  try {
    api.close();
  } catch {
    /* ignore */
  }
});

boot().catch((error) => {
  console.error('[fca] boot failed', error);
  renderFatal(`启动失败：${error.message}\n${error.stack || ''}`);
  updateReadyFlags();
});
