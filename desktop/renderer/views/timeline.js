/**
 * FCA Memory Atlas — 时间线视图（Desktop Editor 组，Alpha 0.1）
 *
 * 契约：desktop/renderer/lib/contracts.md v1.0 §2/§3/§4/§6
 * 职责：
 *  - 加载真实 GET /api/v1/timeline（buckets + items + range），日/周/月/年粒度
 *  - 按人物/项目/类型/时间范围筛选（服务端 filters + 实体关系集客户端精筛，均为真实数据）
 *  - 区分精确 / 估计 / 缺失时间（视觉标记 + 图例；未知时间不伪造到桶中）
 *  - 点击时间桶触发全局选择（星图联动），点击记忆打开编辑器
 *  - 时间段回放：按桶顺序推进并淡入真实记忆，不虚构历史
 *  - 错误/空态显式展示；无假数据
 */

export const meta = {
  id: 'timeline',
  title: '时间线',
  icon: 'clock',
  order: 20,
  nav: true,
  shortcut: 'g t',
};

export const GRANULARITIES = [
  { value: 'day', label: '日' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
  { value: 'year', label: '年' },
];

export const TIMELINE_MEMORY_TYPES = [
  { value: 'working', label: '工作', tone: 'cyan' },
  { value: 'episodic', label: '情景', tone: 'green' },
  { value: 'semantic', label: '语义', tone: 'blue' },
  { value: 'procedural', label: '程序', tone: 'gold' },
  { value: 'autobiographical', label: '自传', tone: 'violet' },
  { value: 'project', label: '项目', tone: 'cyan' },
  { value: 'relational', label: '关系', tone: 'rose' },
  { value: 'emotional', label: '情绪', tone: 'rose' },
];

const TYPE_META = TIMELINE_MEMORY_TYPES.reduce((acc, item) => {
  acc[item.value] = item;
  return acc;
}, {});

export const RANGE_PRESETS = [
  { value: 'all', label: '全部时间' },
  { value: 'month', label: '近 30 天' },
  { value: 'quarter', label: '近 90 天' },
  { value: 'year', label: '近一年' },
  { value: 'custom', label: '自定义' },
];

export const PRECISION_LEGEND = [
  { key: 'exact', label: '精确时间', tone: 'green', hint: 'occurred_precision=exact/day/month/year' },
  { key: 'approximate', label: '估计时间', tone: 'gold', hint: 'occurred_precision=approximate' },
  { key: 'unknown', label: '时间未知', tone: 'rose', hint: 'occurred_precision=unknown 或 occurred_at=null（不进入分桶）' },
];

/* ============================================================================
 * 纯函数（单测覆盖）
 * ========================================================================== */

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 归一化 GET /timeline 响应 */
export function normalizeTimelineResponse(response) {
  const res = response && typeof response === 'object' ? response : {};
  const bucketsRaw = Array.isArray(res.buckets) ? res.buckets : Array.isArray(response) ? [] : [];
  const itemsRaw = Array.isArray(res.items)
    ? res.items
    : Array.isArray(res.memories)
      ? res.memories
      : Array.isArray(res.nodes)
        ? res.nodes
        : [];
  const buckets = bucketsRaw
    .map((bucket) => {
      if (!bucket || !bucket.key) return null;
      const nodeIds = Array.isArray(bucket.node_ids) ? bucket.node_ids : Array.isArray(bucket.nodeIds) ? bucket.nodeIds : [];
      return {
        key: String(bucket.key),
        label: bucket.label || fallbackBucketLabel(String(bucket.key), bucket.granularity),
        count: Number.isFinite(bucket.count) ? bucket.count : nodeIds.length,
        nodeIds,
        presentTypes: Array.isArray(bucket.present_types) ? bucket.present_types : Array.isArray(bucket.presentTypes) ? bucket.presentTypes : [],
      };
    })
    .filter(Boolean);
  const items = itemsRaw
    .map((item) => {
      const memory = (item && item.memory) || item;
      if (!memory || !memory.id) return null;
      return {
        id: memory.id,
        title: memory.title || memory.label || null,
        memory_type: memory.memory_type || memory.type || null,
        occurred_at: memory.occurred_at || null,
        occurred_precision: memory.occurred_precision || (memory.occurred_at ? 'exact' : 'unknown'),
        importance: Number.isFinite(memory.importance) ? memory.importance : null,
      };
    })
    .filter(Boolean);
  return {
    buckets,
    items,
    range: res.range && typeof res.range === 'object' ? res.range : null,
  };
}

/** 桶标签兜底（Runtime 未给 label 时） */
export function fallbackBucketLabel(key, granularity) {
  if (!key) return '—';
  const text = String(key);
  if (granularity === 'year' || /^\d{4}$/.test(text)) return `${text} 年`;
  if (granularity === 'month' || /^\d{4}-\d{2}$/.test(text)) {
    const [y, m] = text.split('-');
    return `${y} 年 ${Number(m)} 月`;
  }
  if (granularity === 'week' || /^\d{4}-W\d{1,2}$/.test(text)) {
    const [y] = text.split('-W');
    const week = text.split('-W')[1];
    return `${y} 第 ${Number(week)} 周`;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  return text;
}

/** 时间范围预设 → {from,to}（ISO 或 null） */
export function timelineRangeFromPreset(preset, now = new Date()) {
  if (!preset || preset === 'all' || preset === 'custom') return { from: null, to: null };
  const from = new Date(now);
  if (preset === 'month') from.setDate(from.getDate() - 30);
  else if (preset === 'quarter') from.setDate(from.getDate() - 90);
  else if (preset === 'year') from.setDate(from.getDate() - 365);
  else return { from: null, to: null };
  return { from: from.toISOString(), to: now.toISOString() };
}

/** 构建 GET /timeline 请求参数（纯函数；filters 与 Runtime buildMemoryFilterSql 对齐） */
export function buildTimelineParams(state) {
  const params = { granularity: state.granularity || 'month', limit: state.limit || 1000 };
  const range = state.range || { from: null, to: null };
  if (range.from) params.from = range.from;
  if (range.to) params.to = range.to;
  const filters = {};
  if (Array.isArray(state.types) && state.types.length) filters.types = state.types.slice();
  if (Array.isArray(state.projects) && state.projects.length) filters.projects = state.projects.slice();
  if (state.entityId) filters.entity_ids = [state.entityId];
  if (Object.keys(filters).length) params.filters = filters;
  return params;
}

/** 精度统计（纯函数）：items=Memory 引用，graphNodes 为可选的图节点（补齐缺失时间统计） */
export function computePrecisionStats(items, graphNodes) {
  const stats = { exact: 0, approximate: 0, unknown: 0, missing: 0, total: 0 };
  const list = Array.isArray(items) ? items : [];
  for (const item of list) {
    stats.total += 1;
    const precision = item && (item.occurred_precision || (item.occurred_at ? 'exact' : 'unknown'));
    if (precision === 'approximate') stats.approximate += 1;
    else if (precision === 'unknown' || !item || !item.occurred_at) {
      stats.unknown += 1;
      stats.missing += 1;
    } else stats.exact += 1;
  }
  if (Array.isArray(graphNodes) && graphNodes.length) {
    let missing = 0;
    for (const node of graphNodes) {
      if (!node || node.kind !== 'memory' || node.deleted) continue;
      if (!node.occurred_at) missing += 1;
    }
    if (missing > stats.missing) {
      stats.missing = missing;
      stats.unknown = Math.max(stats.unknown, missing);
    }
  }
  return stats;
}

/** 用节点 id 集合筛选桶（客户端精筛：人物/项目关系集），并重算计数 */
export function filterBucketsByIds(buckets, allowedIds) {
  const allowed = allowedIds instanceof Set ? allowedIds : new Set(allowedIds || []);
  if (!allowed.size) return [];
  return (Array.isArray(buckets) ? buckets : [])
    .map((bucket) => {
      const nodeIds = (bucket.nodeIds || bucket.node_ids || []).filter((id) => allowed.has(id));
      if (!nodeIds.length) return null;
      return { ...bucket, nodeIds, node_ids: nodeIds, count: nodeIds.length };
    })
    .filter(Boolean);
}

/** 精度统计（基于 memory/search recent 索引；/timeline 响应不含 occurred_precision） */
export function computePrecisionStatsFromIndex(index, total, graphData) {
  const stats = { exact: 0, approximate: 0, unknown: 0, missing: 0, total: 0 };
  if (index && typeof index.forEach === 'function') {
    index.forEach((info) => {
      if (!info) return;
      stats.total += 1;
      const precision = info.occurred_precision || (info.occurred_at ? 'exact' : 'unknown');
      if (!info.occurred_at) {
        stats.unknown += 1;
        stats.missing += 1;
      } else if (precision === 'approximate') stats.approximate += 1;
      else if (precision === 'unknown') {
        stats.unknown += 1;
        stats.missing += 1;
      } else stats.exact += 1;
    });
  }
  const reportedTotal = Number(total);
  if (Number.isFinite(reportedTotal) && reportedTotal > stats.total) {
    // 索引只取最近 N 条，剩余按“未统计”处理，但保留 Runtime 总数
    stats.total = reportedTotal;
  }
  return stats;
}

/** 桶高度百分比（纯函数） */
export function bucketHeightPercent(count, maxCount) {
  const n = Number(count) || 0;
  const max = Number(maxCount) || 0;
  if (max <= 0) return 0;
  return Math.max(4, Math.round((n / max) * 100));
}

/** 桶主要类型（用于颜色条，纯函数） */
export function dominantBucketTypes(bucket, limit = 3) {
  const types = Array.isArray(bucket && (bucket.presentTypes || bucket.present_types))
    ? bucket.presentTypes || bucket.present_types
    : [];
  return types.slice(0, limit);
}

/** 时间范围文本 */
export function rangeText(range) {
  if (!range || (!range.from && !range.to)) return '全部时间';
  const format = (iso) => {
    if (!iso) return '…';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };
  return `${format(range.from)} → ${format(range.to)}`;
}

/* ============================================================================
 * 视图
 * ========================================================================== */

export function createView(ctx) {
  const U = ctx.ui || {};
  const doc = document;
  const api = ctx.api;
  const disposers = [];
  let root = null;
  let styleEl = null;
  let graphCache = null;
  let playTimer = null;
  let entityTimer = null;

  const state = {
    loading: false,
    loadError: null,
    source: 'runtime',
    granularity: 'month',
    preset: 'all',
    from: '',
    to: '',
    range: { from: null, to: null },
    types: [],
    entityKind: 'person',
    entityId: null,
    entityLabel: null,
    entityResults: [],
    entityMemoryIds: null, // Set|null（人物/项目关系解析结果）
    entityResolving: false,
    entityError: null,
    buckets: [],
    items: [],
    responseRange: null,
    selectedKey: null,
    selectedBucketIds: [],
    playing: false,
    playIndex: 0,
    speed: 900,
    showEmpty: false,
    precision: { exact: 0, approximate: 0, unknown: 0, missing: 0, total: 0 },
    precisionIndex: new Map(), // memory id → { occurred_precision, occurred_at }
    precisionTotal: 0,
    precisionTruncated: false,
    precisionLoading: false,
    nodeIndex: new Map(),
    graphError: null,
    lastLoadedAt: null,
  };

  const dom = {};

  /* ------------------------------ 基础工具 ------------------------------ */

  function notify(type, message) {
    try {
      if (typeof ctx.toast === 'function') ctx.toast(message, { type });
      else if (U.toast) U.toast(message, { type });
    } catch {
      /* noop */
    }
  }

  function errInfo(err) {
    return {
      message: (err && (err.userMessage || err.message)) || '未知错误',
      code: (err && err.code) || 'UNKNOWN',
      traceId: (err && (err.traceId || (err.details && err.details.trace_id))) || null,
    };
  }

  function icon(name, opts) {
    try {
      if (typeof U.icon === 'function') return U.icon(name, opts || { size: 15 });
    } catch {
      /* noop */
    }
    return null;
  }

  function el(tag, attrs, children) {
    const node = doc.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
        else if (key === 'on' && typeof value === 'object') {
          for (const [eventName, handler] of Object.entries(value)) if (typeof handler === 'function') node.addEventListener(eventName, handler);
        } else if (key in node) {
          try {
            node[key] = value;
          } catch {
            node.setAttribute(key, String(value));
          }
        } else node.setAttribute(key, String(value));
      }
    }
    if (children !== null && children !== undefined && children !== false) {
      for (const child of Array.isArray(children) ? children : [children]) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child instanceof Node ? child : doc.createTextNode(String(child)));
      }
    }
    return node;
  }

  function button(opts = {}) {
    return el('button', {
      type: 'button',
      class: `view-timeline__btn view-timeline__btn--${opts.variant || 'secondary'}${opts.size === 'sm' ? ' view-timeline__btn--sm' : ''}`,
      disabled: Boolean(opts.disabled || opts.loading),
      title: opts.title || '',
      'data-testid': opts.testid || null,
      on: { click: (event) => opts.onClick && opts.onClick(event) },
    }, [opts.icon ? icon(opts.icon) : null, opts.label ? el('span', { text: opts.label }) : null]);
  }

  function formatTime(iso) {
    if (!iso) return '时间未知';
    try {
      if (ctx.format && typeof ctx.format.datetime === 'function') return ctx.format.datetime(iso);
    } catch {
      /* noop */
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '时间未知';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function navigate(view, params) {
    try {
      if (ctx.router && typeof ctx.router.navigate === 'function') ctx.router.navigate(view, params || {});
      else {
        const query = params && Object.keys(params).length
          ? `&${Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
          : '';
        window.location.hash = `view=${view}${query}`;
      }
    } catch {
      /* noop */
    }
  }

  function subscribeMany(names, handler) {
    for (const name of names) {
      try {
        if (ctx.events && typeof ctx.events.on === 'function') {
          const off = ctx.events.on(name, handler);
          if (typeof off === 'function') disposers.push(off);
        }
      } catch {
        /* noop */
      }
    }
  }

  /* ------------------------------ 数据加载 ------------------------------ */

  async function ensureGraph() {
    if (graphCache) return graphCache;
    try {
      const graph = await api.getGraph();
      const data = graph && graph.nodes ? graph : graph && graph.graph ? graph.graph : null;
      if (data) {
        graphCache = data;
        const index = new Map();
        for (const node of data.nodes || []) {
          if (node && node.id) index.set(node.id, node);
        }
        state.nodeIndex = index;
        state.graphError = null;
      }
    } catch (err) {
      state.graphError = errInfo(err);
    }
    return graphCache;
  }

  async function loadTimeline() {
    state.loading = true;
    state.loadError = null;
    state.selectedKey = null;
    state.selectedBucketIds = [];
    render();
    try {
      const params = buildTimelineParams(state);
      if (typeof api.getTimeline !== 'function') {
        throw Object.assign(new Error('当前 API 客户端缺少 getTimeline 方法'), { code: 'UNSUPPORTED' });
      }
      // /timeline 的 items 是分页的（limit 上限 1000），buckets 是全量；循环取前 3 页以补齐明细标题
      const collected = [];
      let cursor = null;
      let pages = 0;
      let normalized;
      do {
        const pageParams = cursor ? { ...params, cursor } : params;
        const res = await api.getTimeline(pageParams);
        normalized = normalizeTimelineResponse(res);
        collected.push(...normalized.items);
        cursor = res && res.next_cursor ? res.next_cursor : null;
        pages += 1;
      } while (cursor && pages < 3);
      state.buckets = normalized.buckets;
      state.items = collected;
      state.responseRange = normalized.range;
      state.source = 'runtime';
      state.lastLoadedAt = new Date().toISOString();
      state.itemsTruncated = Boolean(cursor);
      state.loading = false;
      render();
      renderBuckets();
      renderPrecisionBar();
      renderDetail();
      updateStatus();
      // 精度信息不在 /timeline 响应中：从 memory/search（recent，含完整 Memory）补充读取
      ensurePrecisionIndex();
      ensureGraph().then(() => {
        renderDetail();
        renderPrecisionBar();
      });
    } catch (err) {
      state.loading = false;
      state.loadError = errInfo(err);
      render();
    }
  }

  /** 读取 memory/search 空查询（recent）以补齐 occurred_precision 与“时间未知”统计 */
  async function ensurePrecisionIndex() {
    if (state.precisionLoading || state.precisionIndex.size) return;
    state.precisionLoading = true;
    try {
      const index = new Map();
      let cursor = null;
      let total = null;
      let pages = 0;
      let truncated = false;
      do {
        const payload = { query: '', mode: 'fulltext', limit: 500 };
        if (cursor) payload.cursor = cursor;
        const res = await api.searchMemory(payload);
        const items = Array.isArray(res) ? res : (res && res.items) || [];
        total = Number.isFinite(res && res.total) ? res.total : total;
        for (const item of items) {
          const memory = (item && item.memory) || item;
          if (!memory || !memory.id) continue;
          index.set(memory.id, {
            occurred_precision: memory.occurred_precision || (memory.occurred_at ? 'exact' : 'unknown'),
            occurred_at: memory.occurred_at || null,
          });
        }
        cursor = res && (res.next_cursor || res.nextCursor) ? res.next_cursor || res.nextCursor : null;
        pages += 1;
        if (pages >= 3 && cursor) {
          truncated = true;
          break;
        }
      } while (cursor);
      state.precisionIndex = index;
      state.precisionTotal = total === null ? index.size : total;
      state.precisionTruncated = truncated;
      state.precisionLoading = false;
      state.precision = computePrecisionStatsFromIndex(index, state.precisionTotal, graphCache);
      renderPrecisionBar();
      renderDetail();
    } catch (err) {
      state.precisionLoading = false;
      state.precisionError = errInfo(err);
      renderPrecisionBar();
    }
  }

  async function resolveEntityFilter(entityId, kind) {
    state.entityResolving = true;
    state.entityError = null;
    state.entityMemoryIds = null;
    renderEntityContext();
    try {
      if (!entityId) {
        state.entityResolving = false;
        await loadTimeline();
        return;
      }
      const res = await api.listRelations({ node_kind: 'entity', node_id: entityId });
      const relations = Array.isArray(res) ? res : (res && (res.items || res.relations || res.data)) || [];
      const ids = new Set();
      for (const relation of relations) {
        if (!relation || relation.deleted_at) continue;
        const from = relation.from || {};
        const to = relation.to || {};
        if (from.id === entityId && to.kind === 'memory') ids.add(to.id);
        if (to.id === entityId && from.kind === 'memory') ids.add(from.id);
      }
      state.entityMemoryIds = ids;
      state.entityResolving = false;
      renderEntityContext();
      // 实体筛选通过 filters.entity_ids 下发给 Runtime（覆盖参与者与所属项目），关系集仅用于界面提示
      await loadTimeline();
    } catch (err) {
      state.entityResolving = false;
      state.entityError = errInfo(err);
      renderEntityContext();
      notify('error', `人物/项目关系解析失败：${state.entityError.message}（时间线仍可浏览，但实体筛选未生效）`);
    }
  }

  async function searchEntities(query) {
    if (!String(query || '').trim()) {
      state.entityResults = [];
      renderEntitySuggestions();
      return;
    }
    try {
      const res = await api.listEntities({ q: String(query).trim(), kind: state.entityKind, limit: 8 });
      const list = Array.isArray(res) ? res : (res && (res.items || res.entities || res.data)) || [];
      state.entityResults = list;
      state.entityError = null;
    } catch (err) {
      state.entityResults = [];
      state.entityError = errInfo(err).message;
    }
    renderEntitySuggestions();
  }

  /* -------------------------------- 渲染 -------------------------------- */

  function mount(container) {
    styleEl = doc.createElement('style');
    styleEl.id = 'view-timeline-style';
    styleEl.textContent = TIMELINE_CSS;
    doc.head.append(styleEl);
    root = el('div', { class: 'view-timeline', 'data-testid': 'view-timeline' });
    container.append(root);
    render();
    loadTimeline();
    subscribeMany(['sse:memory.created', 'sse:memory.updated', 'sse:memory.deleted', 'sse:memory.restored', 'api:resync'], () => loadTimeline());
    disposers.push(() => stopPlayback());
  }

  function render() {
    if (!root) return;
    root.textContent = '';
    root.append(renderHeader());
    if (state.loadError) {
      root.append(el('div', { class: 'view-timeline__errorbox', role: 'alert', 'data-testid': 'timeline-error' }, [
        el('div', { class: 'view-timeline__errorbox-title', text: '无法加载时间线' }),
        el('div', { class: 'view-timeline__errorbox-detail', text: `${state.loadError.message}${state.loadError.traceId ? ` · trace ${state.loadError.traceId}` : ''}` }),
        el('div', { class: 'view-timeline__inline' }, [
          button({ label: '重试', icon: 'refresh', variant: 'primary', onClick: () => loadTimeline() }),
          /桶|范围/.test(state.loadError.message || '')
            ? button({ label: '改用月粒度', icon: 'clock', onClick: () => { state.granularity = 'month'; loadTimeline(); } })
            : null,
          /桶|范围/.test(state.loadError.message || '')
            ? button({ label: '近 30 天', icon: 'filter', onClick: () => { state.preset = 'month'; state.range = timelineRangeFromPreset('month'); loadTimeline(); } })
            : null,
          button({ label: '打开数据管理', icon: 'database', onClick: () => navigate('data', {}) }),
        ]),
      ]));
      return;
    }
    root.append(renderControls());
    dom.entityHost = el('div', { class: 'view-timeline__entity-context' });
    root.append(dom.entityHost);
    renderEntityContext();
    root.append(renderPrecisionBarHost());
    const axis = el('div', { class: 'view-timeline__axis-wrap' });
    dom.axisHost = axis;
    root.append(axis);
    dom.bucketDetail = el('div', { class: 'view-timeline__detail' });
    root.append(dom.bucketDetail);
    dom.legend = el('div', { class: 'view-timeline__footer' });
    root.append(dom.legend);
    renderBuckets();
    renderDetail();
    renderLegend();
  }

  function renderHeader() {
    return el('div', { class: 'view-timeline__bar' }, [
      el('div', { class: 'view-timeline__title' }, [
        el('h2', { text: '时间线' }),
        el('span', { class: 'view-timeline__sub', text: rangeText(state.range) }),
        state.loading ? el('span', { class: 'view-timeline__badge', text: '加载中…' }) : null,
      ]),
      el('div', { class: 'view-timeline__actions' }, [
        button({ label: '刷新', icon: 'refresh', variant: 'ghost', testid: 'timeline-refresh', loading: state.loading, onClick: () => loadTimeline() }),
        button({ label: '打开列表', icon: 'list', variant: 'ghost', onClick: () => navigate('list', {}) }),
        button({ label: '新建记忆', icon: 'plus', variant: 'primary', onClick: () => navigate('editor', {}) }),
      ]),
    ]);
  }

  function renderControls() {
    const granularityRow = el('div', { class: 'view-timeline__segmented', role: 'tablist', 'aria-label': '时间粒度' });
    for (const granularity of GRANULARITIES) {
      granularityRow.append(el('button', {
        type: 'button',
        role: 'tab',
        class: `view-timeline__seg${state.granularity === granularity.value ? ' is-active' : ''}`,
        'aria-selected': String(state.granularity === granularity.value),
        'data-testid': `timeline-granularity-${granularity.value}`,
        text: granularity.label,
        on: {
          click: () => {
            if (state.granularity === granularity.value) return;
            state.granularity = granularity.value;
            loadTimeline();
          },
        },
      }));
    }
    const presetSelect = el('select', {
      class: 'view-timeline__select',
      'data-testid': 'timeline-range-preset',
      'aria-label': '时间范围',
      on: {
        change: (event) => {
          state.preset = event.target.value;
          state.range = timelineRangeFromPreset(state.preset);
          if (state.preset !== 'custom') loadTimeline();
          else render();
        },
      },
    });
    for (const preset of RANGE_PRESETS) {
      const option = el('option', { value: preset.value, text: preset.label });
      if (preset.value === state.preset) option.selected = true;
      presetSelect.append(option);
    }
    let customRow = null;
    if (state.preset === 'custom') {
      customRow = el('div', { class: 'view-timeline__inline' }, [
        el('input', {
          class: 'view-timeline__input view-timeline__input--date', type: 'date', value: state.from, 'data-testid': 'timeline-from',
          on: { change: (e) => { state.from = e.target.value; state.range = { from: e.target.value ? new Date(`${e.target.value}T00:00:00`).toISOString() : null, to: state.range.to }; } },
        }),
        el('span', { class: 'view-timeline__muted', text: '至' }),
        el('input', {
          class: 'view-timeline__input view-timeline__input--date', type: 'date', value: state.to, 'data-testid': 'timeline-to',
          on: { change: (e) => { state.to = e.target.value; state.range = { from: state.range.from, to: e.target.value ? new Date(`${e.target.value}T23:59:59.999`).toISOString() : null }; } },
        }),
        button({ label: '应用', size: 'sm', variant: 'primary', onClick: () => loadTimeline() }),
      ]);
    }
    const showEmptyToggle = el('label', { class: 'view-timeline__check' }, [
      el('input', {
        type: 'checkbox',
        checked: state.showEmpty,
        'data-testid': 'timeline-show-empty',
        on: { change: (event) => { state.showEmpty = event.target.checked; renderBuckets(); } },
      }),
      el('span', { text: '显示空桶' }),
    ]);
    const typeChips = el('div', { class: 'view-timeline__chips', 'data-testid': 'timeline-type-filters' });
    for (const type of TIMELINE_MEMORY_TYPES) {
      const active = state.types.includes(type.value);
      typeChips.append(el('button', {
        type: 'button',
        class: `view-timeline__chip${active ? ' is-active' : ''}`,
        text: type.label,
        'aria-pressed': String(active),
        on: {
          click: () => {
            state.types = active ? state.types.filter((t) => t !== type.value) : [...state.types, type.value];
            render();
            loadTimeline();
          },
        },
      }));
    }
    // 实体（人物/项目）筛选
    const kindSelect = el('select', {
      class: 'view-timeline__select',
      'aria-label': '实体类型',
      on: {
        change: (event) => {
          state.entityKind = event.target.value;
          state.entityResults = [];
          render();
        },
      },
    });
    kindSelect.append(el('option', { value: 'person', text: '人物' }), el('option', { value: 'project', text: '项目' }));
    kindSelect.value = state.entityKind;
    const entityInput = el('input', {
      class: 'view-timeline__input view-timeline__input--entity',
      type: 'search',
      placeholder: state.entityKind === 'person' ? '按人物筛选…' : '按项目筛选…',
      'data-testid': 'timeline-entity-input',
      on: {
        input: (event) => {
          clearTimeout(entityTimer);
          entityTimer = setTimeout(() => searchEntities(event.target.value), 250);
        },
      },
    });
    dom.entitySuggestions = el('div', { class: 'view-timeline__suggestions' });
    const playControls = el('div', { class: 'view-timeline__inline view-timeline__play' }, [
      button({
        label: state.playing ? '暂停回放' : '回放时间段',
        icon: state.playing ? 'stop' : 'play',
        size: 'sm',
        variant: state.playing ? 'danger' : 'secondary',
        testid: 'timeline-play',
        disabled: !state.buckets.length,
        onClick: () => (state.playing ? stopPlayback() : startPlayback()),
      }),
      el('select', {
        class: 'view-timeline__select view-timeline__select--sm',
        'aria-label': '回放速度',
        on: {
          change: (event) => {
            state.speed = Number(event.target.value) || 900;
          },
        },
      }, [
        el('option', { value: '1400', text: '慢速' }),
        el('option', { value: '900', text: '标准' }),
        el('option', { value: '450', text: '快速' }),
      ]),
      state.playing ? el('span', { class: 'view-timeline__muted', text: `回放 ${Math.min(state.playIndex, state.buckets.length)}/${state.buckets.length} 桶` }) : null,
    ]);
    const controls = el('div', { class: 'view-timeline__controls' }, [
      el('div', { class: 'view-timeline__control-group' }, [el('span', { class: 'view-timeline__label', text: '粒度' }), granularityRow]),
      el('div', { class: 'view-timeline__control-group' }, [el('span', { class: 'view-timeline__label', text: '范围' }), presetSelect, customRow, showEmptyToggle]),
      el('div', { class: 'view-timeline__control-group view-timeline__control-group--grow' }, [el('span', { class: 'view-timeline__label', text: '类型' }), typeChips]),
      el('div', { class: 'view-timeline__control-group' }, [el('span', { class: 'view-timeline__label', text: '实体' }), kindSelect, entityInput, state.entityId ? button({ label: '×', variant: 'ghost', size: 'sm', title: '清除实体筛选', onClick: () => { state.entityId = null; state.entityLabel = null; state.entityMemoryIds = null; state.projects = []; loadTimeline(); } }) : null]),
      el('div', { class: 'view-timeline__control-group' }, [playControls]),
      dom.entitySuggestions,
    ]);
    return controls;
  }

  function renderEntitySuggestions() {
    const host = dom.entitySuggestions;
    if (!host) return;
    host.textContent = '';
    if (state.entityError) {
      host.append(el('span', { class: 'view-timeline__unavailable', text: `实体查询失败：${state.entityError}` }));
      return;
    }
    for (const entity of state.entityResults.slice(0, 8)) {
      host.append(el('button', {
        type: 'button',
        class: 'view-timeline__suggestion',
        on: {
          click: () => {
            state.entityId = entity.id;
            state.entityKind = entity.kind || state.entityKind;
            state.entityLabel = entity.name || entity.id;
            state.entityResults = [];
            resolveEntityFilter(entity.id, state.entityKind);
          },
        },
      }, [
        el('span', { text: entity.name || entity.id }),
        el('span', { class: 'view-timeline__muted', text: entity.kind || '' }),
      ]));
    }
  }

  function renderEntityContext() {
    const host = dom.entityHost;
    if (!host) return;
    host.textContent = '';
    if (!state.entityId) return;
    host.append(el('span', { class: 'view-timeline__label', text: '实体筛选：' }));
    host.append(el('span', { class: 'view-timeline__entity-name', text: `${state.entityLabel || state.entityId}（${state.entityKind === 'person' ? '人物' : '项目'}）` }));
    if (state.entityResolving) host.append(el('span', { class: 'view-timeline__muted', text: '正在解析该实体的关系记忆集…' }));
    else if (state.entityMemoryIds) host.append(el('span', { class: 'view-timeline__muted', text: `关联记忆 ${state.entityMemoryIds.size} 条（来自 GET /relations）` }));
    if (state.entityError) host.append(el('span', { class: 'view-timeline__unavailable', text: `关系解析失败：${state.entityError.message}` }));
    host.append(button({
      label: '清除',
      variant: 'ghost',
      size: 'sm',
      onClick: () => {
        state.entityId = null;
        state.entityLabel = null;
        state.entityMemoryIds = null;
        state.projects = [];
        loadTimeline();
      },
    }));
  }

  function visibleBuckets() {
    const list = state.buckets;
    if (state.showEmpty) return list;
    return list.filter((bucket) => bucket.count > 0);
  }

  function renderBuckets() {
    const host = dom.axisHost;
    if (!host) return;
    host.textContent = '';
    if (state.loading) {
      host.append(el('div', { class: 'view-timeline__loading' }, [el('div', { class: 'view-timeline__spinner' }), el('div', { text: '正在读取时间线数据…' })]));
      return;
    }
    const buckets = visibleBuckets();
    if (!buckets.length) {
      const empty = el('div', { class: 'view-timeline__empty', 'data-testid': 'timeline-empty' });
      const allEmpty = state.buckets.length > 0;
      empty.append(
        el('div', { class: 'view-timeline__empty-title', text: allEmpty ? '当前时间范围内没有带发生时间的记忆' : '时间线为空' }),
        el('div', { class: 'view-timeline__empty-desc', text: allEmpty ? 'Runtime 生成了时间桶但没有记忆落在桶内。可切换时间范围/粒度或清除筛选。时间未知的记忆不会伪造到时间线上。' : '当前时间范围内还没有带发生时间的记忆。可在编辑器中为记忆补充发生时间；时间未知的记忆不会伪造到时间线上。' }),
        el('div', { class: 'view-timeline__empty-actions' }, [
          state.entityId ? button({ label: '清除实体筛选', onClick: () => { state.entityId = null; state.entityLabel = null; state.entityMemoryIds = null; loadTimeline(); } }) : button({ label: '新建记忆', icon: 'plus', variant: 'primary', onClick: () => navigate('editor', {}) }),
          button({ label: '打开列表', icon: 'list', onClick: () => navigate('list', {}) }),
          allEmpty ? button({ label: '显示空桶', onClick: () => { state.showEmpty = true; renderBuckets(); } }) : null,
        ]),
      );
      host.append(empty);
      return;
    }
    const maxCount = buckets.reduce((max, bucket) => Math.max(max, bucket.count || 0), 0);
    const chart = el('div', { class: 'view-timeline__chart', 'data-testid': 'timeline-chart' });
    for (const bucket of buckets) {
      const selected = state.selectedKey === bucket.key;
      const height = bucketHeightPercent(bucket.count, maxCount);
      const column = el('button', {
        type: 'button',
        class: `view-timeline__bucket${selected ? ' is-selected' : ''}`,
        'data-testid': `timeline-bucket-${bucket.key}`,
        title: `${bucket.label} · ${bucket.count} 条记忆${bucket.presentTypes.length ? ` · ${bucket.presentTypes.map((t) => (TYPE_META[t] ? TYPE_META[t].label : t)).join('/')}` : ''}`,
        on: { click: () => selectBucket(bucket) },
      }, [
        el('div', { class: 'view-timeline__bucket-count', text: String(bucket.count) }),
        el('div', { class: 'view-timeline__bucket-bar-wrap' }, [
          el('div', { class: 'view-timeline__bucket-bar', style: { height: `${height}%` } }, dominantBucketTypes(bucket, 3).map((type, index) => el('span', { class: `view-timeline__bucket-seg view-timeline__bucket-seg--${TYPE_META[type] ? TYPE_META[type].tone : 'neutral'}`, style: { flexGrow: String(1 + (index === 0 ? 1 : 0)) } }))),
        ]),
        el('div', { class: 'view-timeline__bucket-label', text: bucket.label }),
      ]);
      chart.append(column);
    }
    host.append(chart);
    const hiddenEmpty = state.buckets.length - buckets.length;
    const range = el('div', { class: 'view-timeline__axis-range' }, [
      el('span', { text: buckets.length ? buckets[0].label : '' }),
      el('span', { class: 'view-timeline__muted', text: `${buckets.length} 个有数据时间桶 · 粒度 ${state.granularity}${hiddenEmpty > 0 ? ` · 隐藏 ${hiddenEmpty} 个空桶` : ''}` }),
      el('span', { text: buckets.length ? buckets[buckets.length - 1].label : '' }),
    ]);
    host.append(range);
  }

  function selectBucket(bucket, opts = {}) {
    state.selectedKey = bucket.key;
    state.selectedBucketIds = (bucket.nodeIds || []).slice();
    renderBuckets();
    renderDetail();
    if (!opts.silent) applySelectionToShell(bucket);
  }

  function applySelectionToShell(bucket) {
    const ids = (bucket.nodeIds || []).slice(0, 2000);
    const primaryId = ids[0] || null;
    if (!ids.length) return;
    try {
      if (ctx.store && typeof ctx.store.patch === 'function') {
        ctx.store.patch({ selection: { ids, primaryId, lastSelectedId: primaryId } });
      }
      if (ctx.events && typeof ctx.events.emit === 'function') {
        ctx.events.emit('selection:change', { ids, primaryId });
        ctx.events.emit('timeline:selectBucket', { key: bucket.key, nodeIds: ids, count: bucket.count });
      }
    } catch (err) {
      notify('warn', `联动选择失败：${errInfo(err).message}`);
    }
  }

  function renderDetail() {
    const host = dom.bucketDetail;
    if (!host) return;
    host.textContent = '';
    if (!state.selectedKey) {
      host.append(el('div', { class: 'view-timeline__detail-empty', text: '点击上方任一时间桶查看该时段的记忆；选中会同步到星图选择。' }));
      return;
    }
    const buckets = visibleBuckets();
    const bucket = buckets.find((b) => b.key === state.selectedKey);
    if (!bucket) {
      host.append(el('div', { class: 'view-timeline__detail-empty', text: '所选时间桶在当前筛选下已不可见。' }));
      return;
    }
    const itemsById = new Map(state.items.filter((item) => bucket.nodeIds.includes(item.id)).map((item) => [item.id, item]));
    const unresolved = bucket.nodeIds.filter((id) => !itemsById.has(id));
    host.append(el('div', { class: 'view-timeline__detail-head' }, [
      el('div', {}, [
        el('strong', { text: bucket.label }),
        el('span', { class: 'view-timeline__muted', text: ` · ${bucket.count} 条记忆` }),
        bucket.presentTypes.length ? el('span', { class: 'view-timeline__muted', text: ` · 类型：${bucket.presentTypes.map((t) => (TYPE_META[t] ? TYPE_META[t].label : t)).join('、')}` }) : null,
      ]),
      el('div', { class: 'view-timeline__inline' }, [
        button({ label: '在星图中选中该时段', icon: 'compass', size: 'sm', testid: 'timeline-locate', onClick: () => { applySelectionToShell(bucket); navigate('atlas', { select: bucket.nodeIds[0] || null }); } }),
        button({ label: '关闭', size: 'sm', variant: 'ghost', onClick: () => { state.selectedKey = null; state.selectedBucketIds = []; renderBuckets(); renderDetail(); } }),
      ]),
    ]));
    const list = el('div', { class: 'view-timeline__items', 'data-testid': 'timeline-items' });
    for (const item of bucket.nodeIds) {
      const memory = itemsById.get(item);
      const title = memory ? memory.title : (state.nodeIndex.get(item) ? state.nodeIndex.get(item).label : null);
      const type = memory ? memory.memory_type : (state.nodeIndex.get(item) ? state.nodeIndex.get(item).type : null);
      const when = memory ? memory.occurred_at : (state.nodeIndex.get(item) ? state.nodeIndex.get(item).occurred_at : null);
      const precisionInfo = state.precisionIndex.get(item);
      const precision = precisionInfo ? precisionInfo.occurred_precision : null;
      const row = el('button', {
        type: 'button',
        class: 'view-timeline__item',
        'data-testid': `timeline-item-${item}`,
        on: {
          click: () => {
            if (state.nodeIndex.get(item) && state.nodeIndex.get(item).kind === 'entity') navigate('relations', { node_id: item, node_kind: 'entity' });
            else navigate('editor', { id: item });
          },
        },
      }, [
        el('span', { class: 'view-timeline__item-title', text: title || `${String(item).slice(0, 14)}…` }),
        type ? el('span', { class: `view-timeline__tag view-timeline__tag--${TYPE_META[type] ? TYPE_META[type].tone : 'neutral'}`, text: TYPE_META[type] ? TYPE_META[type].label : type }) : null,
        precision ? el('span', { class: `view-timeline__prec view-timeline__prec--${precision === 'approximate' ? 'gold' : 'green'}`, text: precision === 'approximate' ? '估计' : '精确' }) : null,
        el('span', { class: 'view-timeline__item-time', text: formatTime(when) }),
      ]);
      list.append(row);
    }
    if (unresolved.length) {
      list.append(el('div', { class: 'view-timeline__muted', text: `另有 ${unresolved.length} 个节点未包含在 /timeline items 中（可在星图中查看）。` }));
    }
    host.append(list);
  }

  function renderPrecisionBarHost() {
    dom.precisionHost = el('div', { class: 'view-timeline__precision' });
    renderPrecisionBar();
    return dom.precisionHost;
  }

  function renderPrecisionBar() {
    const host = dom.precisionHost;
    if (!host) return;
    host.textContent = '';
    const stats = state.precision;
    host.append(el('span', { class: 'view-timeline__label', text: '时间质量：' }));
    if (state.precisionLoading && !stats.total) {
      host.append(el('span', { class: 'view-timeline__muted', text: '正在从 memory/search 补充时间精度统计…' }));
    } else {
      host.append(
        el('span', { class: 'view-timeline__prec view-timeline__prec--green', text: `精确 ${stats.exact}` }),
        el('span', { class: 'view-timeline__prec view-timeline__prec--gold', text: `估计 ${stats.approximate}` }),
        el('span', { class: 'view-timeline__prec view-timeline__prec--rose', text: `时间未知 ${stats.missing}` }),
        el('span', { class: 'view-timeline__muted', text: '（未知时间不参与分桶；统计来自 memory/search，/timeline 响应不含精度字段）' }),
      );
    }
    if (state.precisionError) host.append(el('span', { class: 'view-timeline__unavailable', text: `精度统计不可用：${state.precisionError.message}` }));
    if (state.precisionTruncated) host.append(el('span', { class: 'view-timeline__muted', text: ' · 精度统计仅覆盖最近 1500 条' }));
    if (state.entityId) host.append(el('span', { class: 'view-timeline__muted', text: ` · 实体筛选已下发给 Runtime（entity_ids=${state.entityId}）` }));
    if (state.responseRange) host.append(el('span', { class: 'view-timeline__muted', text: ` · Runtime range ${rangeText(state.responseRange)}` }));
    if (state.itemsTruncated) host.append(el('span', { class: 'view-timeline__muted', text: ' · 明细仅加载前 3 页' }));
  }

  function renderLegend() {
    const host = dom.legend;
    if (!host) return;
    host.textContent = '';
    host.append(el('span', { class: 'view-timeline__label', text: '图例：' }));
    for (const entry of PRECISION_LEGEND) {
      host.append(el('span', { class: 'view-timeline__legend-item', title: entry.hint }, [
        el('span', { class: `view-timeline__prec view-timeline__prec--${entry.tone}`, text: entry.label }),
        el('span', { class: 'view-timeline__muted', text: entry.hint }),
      ]));
    }
    host.append(el('span', { class: 'view-timeline__muted', text: '颜色条 = 桶内存在的主要记忆类型；点击桶可联动星图选择。' }));
  }

  /* -------------------------------- 回放 -------------------------------- */

  function startPlayback() {
    const buckets = visibleBuckets();
    if (!buckets.length) {
      notify('warn', '没有可回放的时间桶');
      return;
    }
    stopPlayback();
    state.playing = true;
    state.playIndex = 0;
    render();
    const tick = () => {
      if (!state.playing) return;
      const list = visibleBuckets();
      if (state.playIndex >= list.length) {
        stopPlayback();
        notify('info', '回放结束（仅回放真实存在的时间桶）');
        return;
      }
      const bucket = list[state.playIndex];
      state.playIndex += 1;
      selectBucket(bucket, { silent: true });
      renderHeaderPlayState();
      playTimer = setTimeout(tick, state.speed);
    };
    playTimer = setTimeout(tick, 120);
  }

  function stopPlayback() {
    if (playTimer) clearTimeout(playTimer);
    playTimer = null;
    if (!state.playing) return;
    state.playing = false;
    render();
  }

  function renderHeaderPlayState() {
    const playBtn = root && root.querySelector('[data-testid="timeline-play"]');
    if (playBtn) {
      playBtn.classList.remove('view-timeline__btn--danger');
      playBtn.classList.add('view-timeline__btn--secondary');
    }
    const host = dom.bucketDetail;
    if (host) renderDetail();
  }

  function updateStatus() {
    try {
      if (!ctx.status) return;
      ctx.status.set('timeline.state', {
        label: `时间线 · ${state.buckets.length} 桶 / ${state.items.length} 条${state.playing ? ' · 回放中' : ''}`,
        tone: state.playing ? 'warn' : 'ok',
      });
    } catch {
      /* noop */
    }
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  function unmount() {
    stopPlayback();
    clearTimeout(entityTimer);
    try {
      if (ctx.status) ctx.status.remove('timeline.state');
    } catch {
      /* noop */
    }
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        /* noop */
      }
    }
    disposers.length = 0;
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    styleEl = null;
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    dom.axisHost = null;
    dom.bucketDetail = null;
    dom.legend = null;
    dom.precisionHost = null;
    dom.entityHost = null;
    dom.entitySuggestions = null;
  }

  function activate() {
    if (!state.buckets.length && !state.loading && !state.loadError) loadTimeline();
  }

  function handleCommand(command) {
    if (command === 'view:refresh') {
      graphCache = null;
      loadTimeline();
      return true;
    }
    return false;
  }

  function getSnapshot() {
    return { granularity: state.granularity, preset: state.preset, types: state.types, entityId: state.entityId };
  }

  return { mount, unmount, activate, handleCommand, getSnapshot };
}

/* ============================================================================
 * 样式
 * ========================================================================== */

const TIMELINE_CSS = `
.view-timeline { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--fca-bg-1); color:var(--fca-text); font-family:var(--fca-font-ui); font-size:var(--fca-text-md); }
.view-timeline__bar { display:flex; align-items:center; justify-content:space-between; gap:var(--fca-space-3); padding:var(--fca-space-2) var(--fca-space-4); border-bottom:1px solid var(--fca-border); background:var(--fca-bg-2); flex-wrap:wrap; }
.view-timeline__title { display:flex; align-items:baseline; gap:var(--fca-space-2); }
.view-timeline__title h2 { margin:0; font-size:var(--fca-text-lg); font-weight:600; }
.view-timeline__sub { color:var(--fca-text-muted); font-size:var(--fca-text-sm); font-family:var(--fca-font-mono); }
.view-timeline__badge { font-size:var(--fca-text-xs); color:var(--fca-accent); }
.view-timeline__actions { display:flex; gap:var(--fca-space-2); }
.view-timeline__btn { display:inline-flex; align-items:center; gap:5px; height:28px; padding:0 var(--fca-space-3); border-radius:var(--fca-radius-sm); border:1px solid var(--fca-border); background:var(--fca-bg-3); color:var(--fca-text); font:inherit; font-size:var(--fca-text-sm); cursor:pointer; white-space:nowrap; }
.view-timeline__btn:hover { background:var(--fca-bg-4); }
.view-timeline__btn:disabled { opacity:.45; cursor:not-allowed; }
.view-timeline__btn--primary { background:var(--fca-accent-soft); border-color:var(--fca-accent); color:var(--fca-accent-strong); }
.view-timeline__btn--ghost { background:transparent; border-color:transparent; color:var(--fca-text-dim); }
.view-timeline__btn--ghost:hover { background:var(--fca-bg-3); color:var(--fca-text); }
.view-timeline__btn--danger { background:transparent; border-color:var(--fca-danger); color:var(--fca-danger); }
.view-timeline__btn--sm { height:24px; padding:0 var(--fca-space-2); font-size:var(--fca-text-xs); }
.view-timeline__controls { display:flex; flex-direction:column; gap:var(--fca-space-1); padding:var(--fca-space-2) var(--fca-space-4); border-bottom:1px solid var(--fca-border); background:var(--fca-bg-1); }
.view-timeline__control-group { display:flex; align-items:center; gap:var(--fca-space-2); flex-wrap:wrap; min-height:28px; }
.view-timeline__label { color:var(--fca-text-muted); font-size:var(--fca-text-xs); flex:0 0 auto; }
.view-timeline__inline { display:flex; align-items:center; gap:var(--fca-space-1); flex-wrap:wrap; }
.view-timeline__muted { color:var(--fca-text-muted); font-size:var(--fca-text-xs); }
.view-timeline__select { background:var(--fca-bg-3); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); color:var(--fca-text); font:inherit; font-size:var(--fca-text-sm); height:28px; padding:0 var(--fca-space-1); outline:none; }
.view-timeline__select--sm { height:24px; font-size:var(--fca-text-xs); }
.view-timeline__input { background:var(--fca-bg-3); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); color:var(--fca-text); font:inherit; font-size:var(--fca-text-sm); height:28px; padding:0 var(--fca-space-2); outline:none; box-sizing:border-box; }
.view-timeline__input--date { width:140px; }
.view-timeline__input--entity { width:180px; }
.view-timeline__segmented { display:flex; gap:2px; background:var(--fca-bg-3); border:1px solid var(--fca-border); border-radius:var(--fca-radius); padding:2px; }
.view-timeline__seg { border:none; background:transparent; color:var(--fca-text-dim); font:inherit; font-size:var(--fca-text-sm); padding:2px var(--fca-space-3); border-radius:var(--fca-radius-sm); cursor:pointer; }
.view-timeline__seg:hover { color:var(--fca-text); }
.view-timeline__seg.is-active { background:var(--fca-bg-1); color:var(--fca-accent-strong); box-shadow:inset 0 0 0 1px var(--fca-border-strong); }
.view-timeline__chips { display:flex; gap:3px; flex-wrap:wrap; }
.view-timeline__chip { border:1px solid var(--fca-border); background:var(--fca-bg-2); color:var(--fca-text-muted); font:inherit; font-size:var(--fca-text-xs); border-radius:999px; padding:1px var(--fca-space-2); cursor:pointer; }
.view-timeline__chip:hover { color:var(--fca-text); }
.view-timeline__chip.is-active { background:var(--fca-accent-soft); border-color:var(--fca-accent); color:var(--fca-accent-strong); }
.view-timeline__check { display:inline-flex; align-items:center; gap:4px; font-size:var(--fca-text-xs); color:var(--fca-text-dim); cursor:pointer; }
.view-timeline__check input { accent-color:var(--fca-accent); }
.view-timeline__entity-context { display:flex; align-items:center; gap:var(--fca-space-2); padding:var(--fca-space-1) var(--fca-space-4); border-bottom:1px solid var(--fca-border); background:var(--fca-bg-2); flex-wrap:wrap; }
.view-timeline__entity-name { color:var(--fca-accent-strong); font-size:var(--fca-text-sm); }
.view-timeline__unavailable { color:var(--fca-gold); font-size:var(--fca-text-xs); border:1px dashed color-mix(in srgb, var(--fca-gold) 45%, transparent); border-radius:3px; padding:0 var(--fca-space-1); }
.view-timeline__suggestions { display:flex; gap:3px; flex-wrap:wrap; }
.view-timeline__suggestion { border:1px solid var(--fca-border); background:var(--fca-bg-3); color:var(--fca-text-dim); border-radius:var(--fca-radius-sm); padding:2px var(--fca-space-2); font:inherit; font-size:var(--fca-text-xs); cursor:pointer; display:inline-flex; gap:5px; }
.view-timeline__suggestion:hover { border-color:var(--fca-accent); color:var(--fca-text); }
.view-timeline__play { gap:var(--fca-space-2); }
.view-timeline__precision { display:flex; align-items:center; gap:var(--fca-space-2); padding:2px var(--fca-space-4); border-bottom:1px solid var(--fca-border); background:var(--fca-bg-0); flex-wrap:wrap; }
.view-timeline__prec { font-size:var(--fca-text-xs); padding:0 5px; border-radius:3px; border:1px solid var(--fca-border); color:var(--fca-text-muted); }
.view-timeline__prec--green { color:var(--fca-green); border-color:color-mix(in srgb, var(--fca-green) 40%, transparent); }
.view-timeline__prec--gold { color:var(--fca-gold); border-color:color-mix(in srgb, var(--fca-gold) 40%, transparent); }
.view-timeline__prec--rose { color:var(--fca-rose); border-color:color-mix(in srgb, var(--fca-rose) 40%, transparent); }
.view-timeline__axis-wrap { flex:1; min-height:0; overflow:auto; padding:var(--fca-space-3) var(--fca-space-4); }
.view-timeline__chart { display:flex; align-items:flex-end; gap:var(--fca-space-1); min-height:240px; min-width:max-content; }
.view-timeline__bucket { display:flex; flex-direction:column; align-items:center; justify-content:flex-end; gap:3px; width:56px; min-height:220px; background:transparent; border:1px solid transparent; border-radius:var(--fca-radius-sm); cursor:pointer; padding:var(--fca-space-1) 2px; color:var(--fca-text-dim); font:inherit; }
.view-timeline__bucket:hover { background:var(--fca-bg-2); border-color:var(--fca-border); }
.view-timeline__bucket.is-selected { background:var(--fca-accent-soft); border-color:var(--fca-accent); color:var(--fca-text); }
.view-timeline__bucket-count { font-size:var(--fca-text-xs); font-family:var(--fca-font-mono); color:var(--fca-text-dim); }
.view-timeline__bucket-bar-wrap { width:100%; flex:1; display:flex; align-items:flex-end; justify-content:center; min-height:120px; }
.view-timeline__bucket-bar { width:70%; display:flex; flex-direction:column-reverse; gap:1px; border-radius:2px 2px 0 0; overflow:hidden; background:var(--fca-bg-3); transition:height var(--fca-dur) var(--fca-ease); }
.view-timeline__bucket-seg { display:block; flex:1; min-height:3px; background:var(--fca-border-strong); }
.view-timeline__bucket-seg--cyan { background:var(--fca-accent); }
.view-timeline__bucket-seg--green { background:var(--fca-green); }
.view-timeline__bucket-seg--blue { background:var(--fca-accent-strong); }
.view-timeline__bucket-seg--gold { background:var(--fca-gold); }
.view-timeline__bucket-seg--violet { background:var(--fca-violet); }
.view-timeline__bucket-seg--rose { background:var(--fca-rose); }
.view-timeline__bucket-seg--neutral { background:var(--fca-border-strong); }
.view-timeline__bucket-label { font-size:10px; writing-mode:vertical-rl; text-orientation:mixed; height:78px; overflow:hidden; white-space:nowrap; color:var(--fca-text-muted); }
.view-timeline__bucket.is-selected .view-timeline__bucket-label { color:var(--fca-accent-strong); }
.view-timeline__axis-range { display:flex; justify-content:space-between; gap:var(--fca-space-2); margin-top:var(--fca-space-2); font-size:var(--fca-text-xs); color:var(--fca-text-muted); border-top:1px solid var(--fca-border); padding-top:var(--fca-space-1); }
.view-timeline__detail { border-top:1px solid var(--fca-border); background:var(--fca-bg-2); max-height:280px; overflow:auto; padding:var(--fca-space-2) var(--fca-space-4); flex-shrink:0; }
.view-timeline__detail-empty { color:var(--fca-text-muted); font-size:var(--fca-text-sm); padding:var(--fca-space-2) 0; }
.view-timeline__detail-head { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--fca-space-2); flex-wrap:wrap; margin-bottom:var(--fca-space-1); font-size:var(--fca-text-sm); }
.view-timeline__items { display:flex; flex-direction:column; gap:2px; }
.view-timeline__item { display:flex; align-items:center; gap:var(--fca-space-2); padding:3px var(--fca-space-2); border:1px solid transparent; border-radius:var(--fca-radius-sm); background:transparent; color:var(--fca-text); font:inherit; font-size:var(--fca-text-sm); text-align:left; cursor:pointer; }
.view-timeline__item:hover { background:var(--fca-bg-3); border-color:var(--fca-border); }
.view-timeline__item-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.view-timeline__item-time { color:var(--fca-text-muted); font-size:var(--fca-text-xs); font-family:var(--fca-font-mono); }
.view-timeline__tag { font-size:10px; line-height:15px; padding:0 5px; border-radius:999px; border:1px solid var(--fca-border); color:var(--fca-text-muted); }
.view-timeline__tag--cyan { color:var(--fca-accent); }
.view-timeline__tag--green { color:var(--fca-green); }
.view-timeline__tag--blue { color:var(--fca-accent-strong); }
.view-timeline__tag--gold { color:var(--fca-gold); }
.view-timeline__tag--violet { color:var(--fca-violet); }
.view-timeline__tag--rose { color:var(--fca-rose); }
.view-timeline__tag--neutral { color:var(--fca-text-muted); }
.view-timeline__footer { display:flex; align-items:center; gap:var(--fca-space-3); padding:3px var(--fca-space-4); border-top:1px solid var(--fca-border); background:var(--fca-bg-2); flex-wrap:wrap; flex-shrink:0; }
.view-timeline__legend-item { display:inline-flex; align-items:center; gap:3px; }
.view-timeline__loading { display:flex; flex-direction:column; align-items:center; gap:var(--fca-space-3); padding:var(--fca-space-6); color:var(--fca-text-dim); }
.view-timeline__spinner { width:22px;height:22px;border-radius:50%;border:2px solid var(--fca-border-strong);border-top-color:var(--fca-accent);animation:view-timeline-spin .8s linear infinite; }
@keyframes view-timeline-spin { to { transform:rotate(360deg); } }
.view-timeline__empty { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:var(--fca-space-2); padding:var(--fca-space-6); text-align:center; min-height:260px; }
.view-timeline__empty-title { font-size:var(--fca-text-lg); }
.view-timeline__empty-desc { color:var(--fca-text-muted); font-size:var(--fca-text-sm); max-width:560px; line-height:1.7; }
.view-timeline__empty-actions { display:flex; gap:var(--fca-space-2); margin-top:var(--fca-space-2); }
.view-timeline__errorbox { margin:var(--fca-space-5); padding:var(--fca-space-4); border:1px solid color-mix(in srgb, var(--fca-danger) 50%, var(--fca-border)); background:color-mix(in srgb, var(--fca-danger) 8%, var(--fca-bg-2)); border-radius:var(--fca-radius); display:flex; flex-direction:column; gap:var(--fca-space-2); max-width:620px; }
.view-timeline__errorbox-title { color:var(--fca-danger); font-weight:600; }
.view-timeline__errorbox-detail { color:var(--fca-text-dim); font-size:var(--fca-text-sm); }
`;
