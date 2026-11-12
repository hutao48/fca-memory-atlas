/**
 * FCA Memory Atlas — 星云画布视图（views/atlas.js）
 *
 * 数据：GET /api/v1/graph（真实 Runtime 数据；dev fixture 仅开发期兜底并明确标注）
 * 渲染：desktop/renderer/nebula/index.js 的 createNebula（冻结接口，见 PUBLIC_INTERFACE_FREEZE §5）
 * 交互：节点选择 → 详情面板；拖拽 → POST /layout/nodes；自动布局/恢复布局；筛选/图例/图层/画质；
 *       聚类星域模式；映射说明；缩放控制。
 */

import { icon } from '../ui/icons.js';

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

  // ------------------------------------------------------------- lifecycle
  function mount(container) {
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
    initNebula();
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
      if (window.__FCA_NEBULA__ === instance) window.__FCA_NEBULA__ = null;
    }
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
    return false;
  }

  // ------------------------------------------------------------- DOM
  function buildOverlays() {
    // 左上：模式切换
    dom.modeSwitch = kit.el('div', { class: 'atlas-mode-switch' });
    const topLeft = kit.el('div', { class: 'atlas-overlay atlas-overlay--top-left' }, [dom.modeSwitch]);
    root.appendChild(topLeft);

    // 右上：缩放/布局/图层工具条
    dom.zoomIn = kit.iconButton({ icon: 'zoom-in', label: '放大', size: 'sm', onClick: () => zoomBy(1.22) });
    dom.zoomOut = kit.iconButton({ icon: 'zoom-out', label: '缩小', size: 'sm', onClick: () => zoomBy(1 / 1.22) });
    dom.fitBtn = kit.iconButton({ icon: 'fit', label: '适应屏幕 (F)', size: 'sm', onClick: () => fitToContent() });
    dom.autoLayoutBtn = kit.button({ label: '自动布局', icon: 'activity', variant: 'ghost', size: 'sm', onClick: () => autoLayout() });
    dom.resetLayoutBtn = kit.button({ label: '恢复布局', icon: 'restore', variant: 'ghost', size: 'sm', onClick: () => resetLayout() });
    dom.layersBtn = kit.iconButton({ icon: 'layers', label: '图层控制', size: 'sm', onClick: (event) => openLayersMenu(event.currentTarget) });
    dom.legendBtn = kit.iconButton({ icon: 'legend', label: '图例与映射 (L)', size: 'sm', onClick: () => toggleLegend() });
    const toolbar = kit.el('div', { class: 'atlas-toolbar' }, [
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
    root.appendChild(kit.el('div', { class: 'atlas-overlay atlas-overlay--top-right' }, [toolbar, dom.statePill]));

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
    if (usingDevStub) dom.hud.appendChild(kit.el('span', { class: 'atlas-hud__item' }, [kit.el('span', { text: 'RENDERER' }), kit.el('span', { class: 'atlas-hud__value', text: 'dev-stub' })]));
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
      return { mode, clusterFocusId, camera: getCamera(), quality: store.getState().ui.quality };
    },
  };
}

export default { meta, createView };
