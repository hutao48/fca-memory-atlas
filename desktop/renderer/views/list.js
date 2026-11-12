/**
 * FCA Memory Atlas — 记忆列表视图（Desktop Editor 组，Alpha 0.1）
 *
 * 契约：desktop/renderer/lib/contracts.md v1.0 §2/§3/§4/§6
 * 职责：
 *  - 全量记忆表格（虚拟滚动），多选、排序、类型/时间/关键字筛选
 *  - 批量修改：类型 / 添加标签 / 重要性 / 所属项目 / 软删除（逐条真实 PATCH，带乐观并发）
 *  - 回收站：恢复 / 永久删除（二次确认）
 *  - 数据来源：真实 Runtime。优先空查询全文检索（可拿到完整 Memory），
 *    若 Runtime 不支持空查询则回退 GET /graph（只含图节点字段），并在 UI 明确标注数据来源。
 *  - 不造假数据：空库显示真实空态；失败显示错误与 trace id。
 */

export const meta = {
  id: 'list',
  title: '记忆列表',
  icon: 'list',
  order: 25,
  nav: true,
  shortcut: 'g l',
};

export const LIST_MEMORY_TYPES = [
  { value: 'working', label: '工作' },
  { value: 'episodic', label: '情景' },
  { value: 'semantic', label: '语义' },
  { value: 'procedural', label: '程序' },
  { value: 'autobiographical', label: '自传' },
  { value: 'project', label: '项目' },
  { value: 'relational', label: '关系' },
  { value: 'emotional', label: '情绪' },
];

export const LIST_COLUMNS = [
  { key: 'title', label: '标题', width: 'minmax(220px,2.2fr)' },
  { key: 'memory_type', label: '类型', width: '84px' },
  { key: 'occurred_at', label: '发生时间', width: '170px' },
  { key: 'importance', label: '重要性', width: '96px' },
  { key: 'display_weight', label: '权重', width: '64px' },
  { key: 'version', label: '版本', width: '62px' },
  { key: 'updated_at', label: '更新时间', width: '152px' },
];

const TYPE_LABEL = LIST_MEMORY_TYPES.reduce((acc, t) => {
  acc[t.value] = t.label;
  return acc;
}, {});

const PRECISION_META = {
  exact: { label: '精确', tone: 'green' },
  day: { label: '日', tone: 'green' },
  month: { label: '月', tone: 'cyan' },
  year: { label: '年', tone: 'cyan' },
  approximate: { label: '估计', tone: 'gold' },
  unknown: { label: '未知', tone: 'rose' },
};

const TIME_PRESETS = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: 'week', label: '近 7 天' },
  { value: 'month', label: '近 30 天' },
  { value: 'year', label: '近一年' },
  { value: 'custom', label: '自定义' },
];

/* ============================================================================
 * 纯函数（单测覆盖）
 * ========================================================================== */

export function typeShortLabel(value) {
  return TYPE_LABEL[value] || value || '未分类';
}

export function precisionMarker(precision) {
  return PRECISION_META[precision] || { label: '未知', tone: 'rose' };
}

/** Graph 节点 → 表格行（字段缺失时明确为 null，不虚构） */
export function graphNodeToRow(node) {
  if (!node || !node.id) return null;
  return {
    id: node.id,
    title: node.label || node.title || '(无标题)',
    memory_type: node.type || node.memory_type || null,
    occurred_at: node.occurred_at || null,
    occurred_precision: node.occurred_precision || (node.occurred_at ? 'exact' : 'unknown'),
    importance: Number.isFinite(node.importance) ? node.importance : null,
    display_weight: Number.isFinite(node.display_weight) ? node.display_weight : null,
    credibility: Number.isFinite(node.credibility) ? node.credibility : null,
    version: Number.isFinite(node.version) ? node.version : null,
    updated_at: node.updated_at || null,
    tags: Array.isArray(node.tags) ? node.tags : [],
    tag_names: Array.isArray(node.tag_names) ? node.tag_names : [],
    agent_generated: Boolean(node.agent_generated),
    deleted_at: node.deleted_at || (node.deleted ? 'deleted' : null),
    degree: Number.isFinite(node.degree) ? node.degree : null,
    source: 'graph',
  };
}

/** 完整 Memory 对象 → 表格行 */
export function memoryToRow(memory) {
  if (!memory || !memory.id) return null;
  return {
    id: memory.id,
    title: memory.title || '(无标题)',
    memory_type: memory.memory_type || null,
    occurred_at: memory.occurred_at || null,
    occurred_precision: memory.occurred_precision || (memory.occurred_at ? 'exact' : 'unknown'),
    importance: Number.isFinite(memory.importance) ? memory.importance : null,
    display_weight: Number.isFinite(memory.display_weight) ? memory.display_weight : null,
    credibility: Number.isFinite(memory.credibility) ? memory.credibility : null,
    version: Number.isFinite(memory.version) ? memory.version : null,
    updated_at: memory.updated_at || null,
    tags: Array.isArray(memory.tags) ? memory.tags : [],
    tag_names: Array.isArray(memory.tag_names) ? memory.tag_names : [],
    participants: Array.isArray(memory.participants) ? memory.participants : [],
    project: memory.project || null,
    agent_generated: Boolean(memory.agent_generated),
    deleted_at: memory.deleted_at || null,
    degree: null,
    source: 'memory',
    raw: memory,
  };
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** 时间预设 → {from,to}（ISO；null 表示不限） */
export function timeRangeFromPreset(preset, now = new Date()) {
  if (!preset || preset === 'all') return { from: null, to: null };
  if (preset === 'custom') return { from: null, to: null };
  const to = new Date(now);
  const from = new Date(now);
  if (preset === 'today') {
    return { from: startOfDay(now).toISOString(), to: to.toISOString() };
  }
  if (preset === 'week') from.setDate(from.getDate() - 7);
  else if (preset === 'month') from.setDate(from.getDate() - 30);
  else if (preset === 'year') from.setDate(from.getDate() - 365);
  else return { from: null, to: null };
  return { from: from.toISOString(), to: to.toISOString() };
}

/** 过滤行（纯函数）：query/类型/时间范围/精度/回收站 */
export function filterListRows(rows, filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  const types = Array.isArray(filters.types) ? filters.types : [];
  const range = filters.range || { from: null, to: null };
  const precisions = Array.isArray(filters.precisions) ? filters.precisions : [];
  const from = range.from ? new Date(range.from).getTime() : null;
  const to = range.to ? new Date(range.to).getTime() : null;
  return rows.filter((row) => {
    if (!row) return false;
    if (types.length && !types.includes(row.memory_type)) return false;
    if (precisions.length && !precisions.includes(row.occurred_precision)) return false;
    if (query) {
      const haystack = `${row.title || ''} ${row.tag_names ? row.tag_names.join(' ') : ''}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (from !== null || to !== null) {
      if (!row.occurred_at) return false;
      const ts = new Date(row.occurred_at).getTime();
      if (Number.isNaN(ts)) return false;
      if (from !== null && ts < from) return false;
      if (to !== null && ts > to) return false;
    }
    return true;
  });
}

/** 排序行（纯函数）；null 值恒排最后 */
export function sortListRows(rows, key = 'occurred_at', dir = 'desc') {
  const factor = dir === 'asc' ? 1 : -1;
  const valueOf = (row) => {
    const value = row ? row[key] : null;
    if (value === null || value === undefined) return null;
    if (key === 'title' || key === 'memory_type') return String(value).toLowerCase();
    if (key === 'occurred_at' || key === 'updated_at') {
      const ts = new Date(value).getTime();
      return Number.isNaN(ts) ? null : ts;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  return rows.slice().sort((a, b) => {
    const va = valueOf(a);
    const vb = valueOf(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (va < vb) return -1 * factor;
    if (va > vb) return 1 * factor;
    return 0;
  });
}

/** 计算批量操作所需 payload（纯函数，便于测试） */
export function buildBulkPayload(kind, value, memory) {
  switch (kind) {
    case 'memory_type':
      return { memory_type: value };
    case 'importance':
      return { importance: value };
    case 'tags': {
      const existing = Array.isArray(memory && memory.tags) ? memory.tags.slice() : [];
      const next = Array.isArray(value) ? value : [value];
      return { tags: [...existing, ...next.filter(Boolean)] };
    }
    case 'project':
      return { project: value ? { name: value } : null };
    default:
      return {};
  }
}

/** ISO → 本地日期时间文本（纯函数） */
export function formatListTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatListDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
  let scrollEl = null;
  let rowsHost = null;
  let resizeObserver = null;
  let reloadTimer = null;

  const state = {
    loading: false,
    loadError: null,
    sourceMode: null, // 'search' | 'graph' | null
    allRows: [],
    rows: [],
    selected: new Set(),
    trash: false,
    filters: { query: '', types: [], precisions: [], preset: 'all', from: '', to: '', range: { from: null, to: null } },
    sort: { key: 'occurred_at', dir: 'desc' },
    viewportHeight: 420,
    scrollTop: 0,
    rowHeight: 42,
    busy: null, // {label, done, total}
    bulkErrors: [],
    nextCursor: null,
    truncated: false,
    loadedCount: 0,
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
      class: `view-list__btn view-list__btn--${opts.variant || 'secondary'}${opts.size === 'sm' ? ' view-list__btn--sm' : ''}`,
      disabled: Boolean(opts.disabled || opts.loading),
      title: opts.title || '',
      'data-testid': opts.testid || null,
      on: { click: (event) => opts.onClick && opts.onClick(event) },
    }, [opts.icon ? icon(opts.icon) : null, opts.label ? el('span', { text: opts.label }) : null, opts.loading ? el('span', { class: 'view-list__spinner-sm' }) : null]);
  }

  function formatTime(iso, dateOnly) {
    try {
      if (ctx.format && typeof ctx.format.datetime === 'function' && !dateOnly) return ctx.format.datetime(iso);
    } catch {
      /* noop */
    }
    return dateOnly ? formatListDate(iso) : formatListTime(iso);
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

  async function loadData(opts = {}) {
    state.loading = true;
    state.loadError = null;
    if (opts.resetScroll !== false) state.scrollTop = 0;
    state.selected = new Set();
    render();
    try {
      const rows = await loadAllRows();
      state.allRows = rows;
      state.loading = false;
      applyFilters();
    } catch (err) {
      state.loading = false;
      state.loadError = errInfo(err);
      render();
    }
  }

  /**
   * 真实数据加载：先尝试「空查询全文搜索」（可得到完整 Memory 字段），
   * 失败则回退 /graph（Runtime 契约中唯一保证的全量列举能力）。
   * 两条路径都是真实 API；失败不伪造数据。
   */
  async function loadAllRows() {
    // 回收站视图：search 带 include_deleted，graph 带 include_deleted
    if (state.sourceMode === null) {
      try {
        const rows = await fetchViaSearch(1);
        if (rows !== null) {
          state.sourceMode = 'search';
          state.truncated = rows.truncated;
          return rows.items;
        }
      } catch {
        /* 探测失败：回退 graph */
      }
      state.sourceMode = 'graph';
    }
    if (state.sourceMode === 'search') {
      try {
        const rows = await fetchViaSearch(1);
        if (rows !== null) {
          state.truncated = rows.truncated;
          return rows.items;
        }
      } catch {
        /* fallthrough graph */
      }
      state.sourceMode = 'graph';
    }
    return fetchViaGraph();
  }

  async function fetchViaSearch() {
    if (typeof api.searchMemory !== 'function') return null;
    const items = [];
    let cursor = null;
    let pages = 0;
    const maxPages = 4;
    let truncated = false;
    do {
      const payload = {
        query: '',
        mode: 'fulltext',
        limit: 500,
        include_deleted: Boolean(state.trash),
        filters: state.trash ? { deleted_only: true } : {},
      };
      if (cursor) payload.cursor = cursor;
      const res = await api.searchMemory(payload);
      const pageItems = normalizeItems(res);
      for (const item of pageItems) {
        const memory = (item && item.memory) || item;
        const row = memoryToRow(memory);
        if (!row) continue;
        if (state.trash ? !row.deleted_at : row.deleted_at) continue;
        items.push(row);
      }
      cursor = res && (res.next_cursor || res.nextCursor) ? res.next_cursor || res.nextCursor : null;
      pages += 1;
      if (pages >= maxPages && cursor) {
        truncated = true;
        break;
      }
    } while (cursor);
    return { items, truncated };
  }

  async function fetchViaGraph() {
    if (typeof api.getGraph !== 'function') throw new Error('Runtime API 客户端缺少 getGraph');
    const graph = await api.getGraph({ include_deleted: true });
    const data = graph && graph.nodes ? graph : graph && graph.graph ? graph.graph : null;
    const nodes = data && Array.isArray(data.nodes) ? data.nodes : [];
    const rows = [];
    for (const node of nodes) {
      if (!node || node.kind !== 'memory') continue;
      const row = graphNodeToRow(node);
      if (!row) continue;
      if (state.trash ? !row.deleted_at : row.deleted_at) continue;
      rows.push(row);
    }
    if (rows.length > 5000) {
      state.truncated = true;
      return rows.slice(0, 5000);
    }
    return rows;
  }

  function normalizeItems(response) {
    if (Array.isArray(response)) return response;
    if (!response || typeof response !== 'object') return [];
    for (const key of ['items', 'results', 'data', 'memories']) if (Array.isArray(response[key])) return response[key];
    return [];
  }

  function applyFilters() {
    const range = state.filters.preset === 'custom'
      ? { from: state.filters.from || null, to: state.filters.to || null }
      : timeRangeFromPreset(state.filters.preset || 'all');
    state.filters.range = {
      from: range.from ? new Date(range.from).toISOString() : null,
      to: range.to ? new Date(range.to).toISOString() : null,
    };
    let rows = filterListRows(state.allRows, {
      query: state.filters.query,
      types: state.filters.types,
      precisions: state.filters.precisions,
      range: state.filters.range,
    });
    rows = sortListRows(rows, state.sort.key, state.sort.dir);
    state.rows = rows;
    // 选中项里已不可见的剔除
    const visibleIds = new Set(rows.map((r) => r.id));
    for (const id of Array.from(state.selected)) if (!visibleIds.has(id)) state.selected.delete(id);
    renderRows();
    renderToolbarState();
    renderFooter();
    updateStatus();
  }

  /* -------------------------------- 渲染 -------------------------------- */

  function mount(container) {
    styleEl = doc.createElement('style');
    styleEl.id = 'view-list-style';
    styleEl.textContent = LIST_CSS;
    doc.head.append(styleEl);

    root = el('div', { class: 'view-list', 'data-testid': 'view-list' });
    container.append(root);
    render();
    loadData();

    subscribeMany(
      ['sse:memory.created', 'sse:memory.updated', 'sse:memory.deleted', 'sse:memory.restored', 'sse:memory.merged', 'sse:memory.split', 'sse:memory.imported', 'api:resync'],
      () => scheduleReload(),
    );
    disposers.push(() => clearTimeout(reloadTimer));
  }

  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (state.busy) return;
      loadData({ resetScroll: false });
    }, 350);
  }

  function render() {
    if (!root) return;
    root.textContent = '';
    root.append(renderHeader());
    if (state.loadError) {
      root.append(renderErrorBox());
      return;
    }
    root.append(renderToolbar());
    root.append(renderSourceHint());
    root.append(renderBulkBar());
    const body = el('div', { class: 'view-list__body' });
    if (state.loading) {
      body.append(el('div', { class: 'view-list__loading' }, [el('div', { class: 'view-list__spinner' }), el('div', { text: '正在读取记忆列表…' })]));
      root.append(body);
      return;
    }
    body.append(renderTable());
    root.append(body);
    root.append(renderFooterHost());
    // 滚动容器引用
    requestAnimationFrame(() => attachScroll());
  }

  function renderHeader() {
    const title = el('div', { class: 'view-list__title' }, [
      el('h2', { text: state.trash ? '回收站' : '记忆列表' }),
      el('span', { class: 'view-list__count', 'data-testid': 'list-count', text: state.loading ? '读取中…' : `${state.rows.length} / ${state.allRows.length} 条` }),
      state.truncated ? el('span', { class: 'view-list__tag view-list__tag--gold', text: '结果已截断' }) : null,
    ]);
    const actions = el('div', { class: 'view-list__header-actions' }, [
      button({ label: '新建记忆', icon: 'plus', variant: 'primary', testid: 'list-new', onClick: () => navigate('editor', {}) }),
      button({ label: '刷新', icon: 'refresh', variant: 'ghost', testid: 'list-refresh', loading: state.loading, onClick: () => loadData() }),
    ]);
    const tabs = el('div', { class: 'view-list__tabs', role: 'tablist' });
    for (const tab of [{ id: 'all', label: '全部记忆' }, { id: 'trash', label: '回收站' }]) {
      const active = (tab.id === 'trash') === state.trash;
      tabs.append(el('button', {
        type: 'button',
        role: 'tab',
        class: `view-list__tab${active ? ' is-active' : ''}`,
        'aria-selected': String(active),
        'data-testid': `list-tab-${tab.id}`,
        text: tab.label,
        on: {
          click: () => {
            if (active) return;
            state.trash = tab.id === 'trash';
            state.allRows = [];
            state.sourceMode = null;
            loadData();
          },
        },
      }));
    }
    return el('div', { class: 'view-list__bar' }, [title, tabs, actions]);
  }

  function renderErrorBox() {
    return el('div', { class: 'view-list__errorbox', role: 'alert', 'data-testid': 'list-error' }, [
      el('div', { class: 'view-list__errorbox-title', text: '无法读取记忆列表' }),
      el('div', { class: 'view-list__errorbox-detail', text: `${state.loadError.message}${state.loadError.traceId ? ` · trace ${state.loadError.traceId}` : ''}` }),
      el('div', { class: 'view-list__row-actions' }, [
        button({ label: '重试', icon: 'refresh', variant: 'primary', onClick: () => loadData() }),
        button({ label: '数据管理 / 健康检查', icon: 'database', onClick: () => navigate('data', {}) }),
      ]),
    ]);
  }

  function renderToolbar() {
    dom.searchInput = el('input', {
      class: 'view-list__input view-list__input--search',
      type: 'search',
      placeholder: '在已加载列表中筛选标题 / 标签…',
      value: state.filters.query,
      'data-testid': 'list-search',
      on: {
        input: (event) => {
          state.filters.query = event.target.value;
          applyFilters();
        },
      },
    });
    const typeChips = el('div', { class: 'view-list__chips', 'data-testid': 'list-type-filters' });
    for (const type of LIST_MEMORY_TYPES) {
      const active = state.filters.types.includes(type.value);
      typeChips.append(el('button', {
        type: 'button',
        class: `view-list__chip${active ? ' is-active' : ''}`,
        text: type.label,
        'aria-pressed': String(active),
        on: {
          click: () => {
            state.filters.types = active ? state.filters.types.filter((t) => t !== type.value) : [...state.filters.types, type.value];
            applyFilters();
            render();
          },
        },
      }));
    }
    const presetSelect = el('select', {
      class: 'view-list__select',
      'data-testid': 'list-time-preset',
      'aria-label': '时间范围',
      on: {
        change: (event) => {
          state.filters.preset = event.target.value;
          applyFilters();
          render();
        },
      },
    });
    for (const preset of TIME_PRESETS) {
      const option = el('option', { value: preset.value, text: preset.label });
      if (preset.value === state.filters.preset) option.selected = true;
      presetSelect.append(option);
    }
    const precisionSelect = el('select', {
      class: 'view-list__select',
      'data-testid': 'list-precision-filter',
      'aria-label': '时间精度',
      on: {
        change: (event) => {
          const value = event.target.value;
          state.filters.precisions = value ? [value] : [];
          applyFilters();
          render();
        },
      },
    });
    precisionSelect.append(el('option', { value: '', text: '全部时间精度' }));
    for (const [key, meta] of Object.entries(PRECISION_META)) {
      const option = el('option', { value: key, text: `${meta.label}时间` });
      if (state.filters.precisions.length === 1 && state.filters.precisions[0] === key) option.selected = true;
      precisionSelect.append(option);
    }
    let customRow = null;
    if (state.filters.preset === 'custom') {
      const fromInput = el('input', { class: 'view-list__input view-list__input--date', type: 'date', value: state.filters.from, 'data-testid': 'list-from', on: { change: (e) => { state.filters.from = e.target.value; applyFilters(); } } });
      const toInput = el('input', { class: 'view-list__input view-list__input--date', type: 'date', value: state.filters.to, 'data-testid': 'list-to', on: { change: (e) => { state.filters.to = e.target.value; applyFilters(); } } });
      customRow = el('div', { class: 'view-list__custom-range' }, [el('span', { class: 'view-list__muted', text: '从' }), fromInput, el('span', { class: 'view-list__muted', text: '至' }), toInput]);
    }
    dom.sortSelect = el('select', {
      class: 'view-list__select',
      'data-testid': 'list-sort',
      'aria-label': '排序',
      on: {
        change: (event) => {
          const [key, dir] = event.target.value.split(':');
          state.sort = { key, dir };
          applyFilters();
        },
      },
    });
    const sortOptions = [
      ['occurred_at:desc', '发生时间 ↓'],
      ['occurred_at:asc', '发生时间 ↑'],
      ['updated_at:desc', '更新时间 ↓'],
      ['importance:desc', '重要性 ↓'],
      ['title:asc', '标题 A→Z'],
      ['memory_type:asc', '类型'],
      ['version:desc', '版本 ↓'],
    ];
    for (const [value, label] of sortOptions) {
      const option = el('option', { value, text: label });
      if (`${state.sort.key}:${state.sort.dir}` === value) option.selected = true;
      dom.sortSelect.append(option);
    }
    const bar = el('div', { class: 'view-list__toolbar' }, [
      dom.searchInput,
      customRow,
      el('div', { class: 'view-list__toolbar-group' }, [el('span', { class: 'view-list__label', text: '类型' }), typeChips]),
      el('div', { class: 'view-list__toolbar-group' }, [el('span', { class: 'view-list__label', text: '时间' }), presetSelect, precisionSelect]),
      el('div', { class: 'view-list__toolbar-group' }, [el('span', { class: 'view-list__label', text: '排序' }), dom.sortSelect]),
    ]);
    return bar;
  }

  function renderSourceHint() {
    const parts = [];
    if (state.sourceMode === 'graph') {
      parts.push('数据来源：GET /graph（Runtime 未支持空查询列表接口，表格中的版本/标签名/更新时间可能缺失；批量操作时会逐条读取最新版本）');
    } else if (state.sourceMode === 'search') {
      parts.push('数据来源：POST /memory/search（真实 Runtime 数据）');
    }
    if (state.trash) parts.push('回收站包含已软删除记忆：可恢复，或二次确认后永久删除。');
    if (state.truncated) parts.push('数据量较大，列表已截断显示；请使用搜索视图定位具体记忆。');
    if (!parts.length) return el('div', { class: 'view-list__hint view-list__hint--empty' });
    return el('div', { class: 'view-list__hint', 'data-testid': 'list-source-hint', text: parts.join(' · ') });
  }

  function renderBulkBar() {
    const host = el('div', { class: 'view-list__bulkbar', 'data-testid': 'list-bulkbar' });
    if (state.busy) {
      const ratio = state.busy.total ? state.busy.done / state.busy.total : 0;
      host.append(el('div', { class: 'view-list__bulkbar-busy' }, [
        el('span', { class: 'view-list__spinner-sm' }),
        el('span', { text: `${state.busy.label} ${state.busy.done}/${state.busy.total}` }),
        el('div', { class: 'view-list__progress' }, [el('div', { class: 'view-list__progress-fill', style: { width: `${Math.round(ratio * 100)}%` } })]),
      ]));
      return host;
    }
    const count = state.selected.size;
    if (!count) {
      host.classList.add('view-list__bulkbar--idle');
      host.append(el('span', { class: 'view-list__muted', text: state.trash ? '勾选记忆后可批量恢复或永久删除' : '勾选记忆后可批量修改类型 / 标签 / 重要性 / 项目，或软删除' }));
      return host;
    }
    host.append(el('span', { class: 'view-list__bulkbar-count', 'data-testid': 'list-selected-count', text: `已选 ${count} 条` }));
    if (state.trash) {
      host.append(
        button({ label: '批量恢复', icon: 'history', variant: 'primary', size: 'sm', testid: 'list-restore-selected', onClick: () => batchRestore() }),
        button({ label: '永久删除', icon: 'trash', variant: 'danger', size: 'sm', testid: 'list-purge-selected', onClick: () => purgeSelected() }),
      );
      return host;
    }
    const typeSelect = el('select', { class: 'view-list__select', 'data-testid': 'list-bulk-type' });
    typeSelect.append(el('option', { value: '', text: '修改类型…' }));
    for (const type of LIST_MEMORY_TYPES) typeSelect.append(el('option', { value: type.value, text: type.label }));
    typeSelect.addEventListener('change', () => {
      if (!typeSelect.value) return;
      bulkPatch('memory_type', typeSelect.value);
      typeSelect.value = '';
    });
    const importanceInput = el('input', { class: 'view-list__input view-list__input--num', type: 'number', min: '0', max: '1', step: '0.05', placeholder: '重要性', 'data-testid': 'list-bulk-importance' });
    const projectInput = el('input', { class: 'view-list__input view-list__input--text', placeholder: '所属项目名', 'data-testid': 'list-bulk-project' });
    const tagsInput = el('input', { class: 'view-list__input view-list__input--text', placeholder: '添加标签（逗号分隔）', 'data-testid': 'list-bulk-tags' });
    host.append(
      typeSelect,
      el('div', { class: 'view-list__inline' }, [tagsInput, button({ label: '加标签', size: 'sm', onClick: () => bulkPatch('tags', splitTags(tagsInput.value)) })]),
      el('div', { class: 'view-list__inline' }, [importanceInput, button({ label: '设重要性', size: 'sm', onClick: () => bulkPatch('importance', Number(importanceInput.value)) })]),
      el('div', { class: 'view-list__inline' }, [projectInput, button({ label: '设项目', size: 'sm', onClick: () => bulkPatch('project', projectInput.value.trim()) })]),
      button({ label: '软删除', icon: 'trash', variant: 'danger', size: 'sm', testid: 'list-delete-selected', onClick: () => softDeleteSelected() }),
      button({ label: '清除选择', variant: 'ghost', size: 'sm', onClick: () => { state.selected.clear(); applyFilters(); } }),
    );
    return host;
  }

  function splitTags(text) {
    return String(text || '')
      .split(/[,，;；\s]+/)
      .map((t) => t.trim().replace(/^#/, ''))
      .filter(Boolean);
  }

  function renderTable() {
    const table = el('div', { class: 'view-list__table', role: 'table' });
    // 表头
    const header = el('div', { class: 'view-list__thead', role: 'row' });
    const selectAll = el('input', {
      type: 'checkbox',
      class: 'view-list__checkbox',
      'aria-label': '全选当前可见行',
      'data-testid': 'list-select-all',
      checked: state.rows.length > 0 && state.selected.size === state.rows.length,
      on: {
        change: (event) => {
          if (event.target.checked) state.rows.forEach((row) => state.selected.add(row.id));
          else state.selected.clear();
          renderBulkBarHost();
          renderRows();
          updateStatus();
        },
      },
    });
    header.append(el('div', { class: 'view-list__th view-list__th--check' }, [selectAll]));
    for (const column of LIST_COLUMNS) {
      const sorted = state.sort.key === column.key;
      header.append(el('div', {
        class: `view-list__th${sorted ? ' is-sorted' : ''}`,
        role: 'columnheader',
        style: { width: column.width },
        on: {
          click: () => {
            state.sort = { key: column.key, dir: sorted && state.sort.dir === 'desc' ? 'asc' : 'desc' };
            applyFilters();
            render();
          },
        },
      }, [el('span', { text: column.label }), sorted ? el('span', { class: 'view-list__sort-arrow', text: state.sort.dir === 'desc' ? '↓' : '↑' }) : null]));
    }
    table.append(header);

    scrollEl = el('div', { class: 'view-list__scroll', role: 'rowgroup', 'data-testid': 'list-scroll', on: { scroll: (event) => { state.scrollTop = event.target.scrollTop; scheduleRowRender(); } } });
    rowsHost = el('div', { class: 'view-list__rows', style: { height: `${state.rows.length * state.rowHeight}px` } });
    scrollEl.append(rowsHost);
    table.append(scrollEl);
    renderRows();
    return table;
  }

  let rowRenderFrame = null;
  function scheduleRowRender() {
    if (rowRenderFrame) return;
    rowRenderFrame = requestAnimationFrame(() => {
      rowRenderFrame = null;
      renderRows();
    });
  }

  function renderRows() {
    if (!rowsHost) return;
    const total = state.rows.length;
    const scrollTop = scrollEl ? scrollEl.scrollTop : state.scrollTop;
    const viewport = Math.max(160, state.viewportHeight || 420);
    const start = Math.max(0, Math.floor(scrollTop / state.rowHeight) - 6);
    const end = Math.min(total, Math.floor((scrollTop + viewport) / state.rowHeight) + 8);
    rowsHost.textContent = '';
    rowsHost.style.height = `${total * state.rowHeight}px`;
    if (!total) {
      rowsHost.style.height = 'auto';
      rowsHost.append(el('div', { class: 'view-list__empty', 'data-testid': 'list-empty' }, [
        el('div', { class: 'view-list__empty-title', text: state.trash ? '回收站为空' : '当前筛选下没有记忆' }),
        el('div', { class: 'view-list__empty-desc', text: state.allRows.length ? '尝试清除筛选条件或切换时间范围。' : state.trash ? '软删除的记忆会出现在这里。' : '创建第一条记忆后，它会出现在列表与星图中。' }),
        el('div', { class: 'view-list__empty-actions' }, [
          state.filters.query || state.filters.types.length || state.filters.preset !== 'all'
            ? button({ label: '清除筛选', icon: 'close', onClick: () => { state.filters = { query: '', types: [], precisions: [], preset: 'all', from: '', to: '', range: { from: null, to: null } }; applyFilters(); render(); } })
            : button({ label: '新建记忆', icon: 'plus', variant: 'primary', onClick: () => navigate('editor', {}) }),
        ]),
      ]));
      rowsHost.style.height = '100%';
      return;
    }
    for (let index = start; index < end; index += 1) {
      const row = state.rows[index];
      if (!row) continue;
      rowsHost.append(renderRow(row, index));
    }
  }

  function renderRow(row, index) {
    const selected = state.selected.has(row.id);
    const marker = precisionMarker(row.occurred_precision);
    const rowEl = el('div', {
      class: `view-list__tr${selected ? ' is-selected' : ''}${row.deleted_at ? ' is-deleted' : ''}`,
      role: 'row',
      style: { top: `${index * state.rowHeight}px`, height: `${state.rowHeight}px` },
      'data-testid': `list-row-${row.id}`,
      'data-row-id': row.id,
      on: {
        click: (event) => {
          if (event.target && event.target.type === 'checkbox') return;
          if (event.ctrlKey || event.metaKey || event.shiftKey) {
            if (state.selected.has(row.id)) state.selected.delete(row.id);
            else state.selected.add(row.id);
            renderRows();
            renderBulkBarHost();
            updateStatus();
            return;
          }
          navigate('editor', { id: row.id });
        },
      },
    });
    const checkbox = el('input', {
      type: 'checkbox',
      class: 'view-list__checkbox',
      checked: selected,
      'aria-label': `选择 ${row.title}`,
      on: {
        change: (event) => {
          event.stopPropagation();
          if (event.target.checked) state.selected.add(row.id);
          else state.selected.delete(row.id);
          renderRows();
          renderBulkBarHost();
          updateStatus();
        },
      },
    });
    const titleCell = el('div', { class: 'view-list__td view-list__td--title' }, [
      el('span', { class: 'view-list__row-title', text: row.title }),
      el('span', { class: 'view-list__row-badges' }, [
        row.agent_generated ? el('span', { class: 'view-list__tag view-list__tag--violet', text: 'Agent' }) : null,
        row.deleted_at ? el('span', { class: 'view-list__tag view-list__tag--rose', text: '已删除' }) : null,
        (row.tag_names && row.tag_names.length ? row.tag_names : row.tags || []).slice(0, 3).map((tag) => el('span', { class: 'view-list__tag', text: `#${String(tag).slice(0, 14)}` })),
        (row.tags && row.tags.length > 3) ? el('span', { class: 'view-list__tag', text: `+${row.tags.length - 3}` }) : null,
      ]),
    ]);
    const typeCell = el('div', { class: 'view-list__td' }, [row.memory_type ? el('span', { class: `view-list__tag view-list__tag--${typeTone(row.memory_type)}`, text: typeShortLabel(row.memory_type) }) : el('span', { class: 'view-list__muted', text: '—' })]);
    const timeCell = el('div', { class: 'view-list__td view-list__td--time' }, [
      el('span', { text: row.occurred_at ? formatTime(row.occurred_at, row.occurred_precision !== 'exact' && row.occurred_precision !== 'approximate') : '—' }),
      el('span', { class: `view-list__prec view-list__prec--${marker.tone}`, text: marker.label, title: '发生时间精度' }),
    ]);
    const importanceCell = el('div', { class: 'view-list__td' }, [
      el('div', { class: 'view-list__bar', title: row.importance == null ? '重要性未知' : `重要性 ${Math.round(row.importance * 100)}%` }, [
        el('div', { class: 'view-list__bar-fill', style: { width: `${Math.round((row.importance == null ? 0 : row.importance) * 100)}%` } }),
      ]),
    ]);
    const weightCell = el('div', { class: 'view-list__td view-list__td--num' }, [el('span', { text: row.display_weight == null ? '—' : Number(row.display_weight).toFixed(2) })]);
    const versionCell = el('div', { class: 'view-list__td view-list__td--num' }, [el('span', { class: 'view-list__mono', text: row.version == null ? '—' : `v${row.version}` })]);
    const updatedCell = el('div', { class: 'view-list__td view-list__td--time' }, [el('span', { class: 'view-list__muted', text: formatTime(row.updated_at) })]);
    rowEl.append(
      el('div', { class: 'view-list__td view-list__td--check' }, [checkbox]),
      titleCell,
      typeCell,
      timeCell,
      importanceCell,
      weightCell,
      versionCell,
      updatedCell,
    );
    return rowEl;
  }

  function typeTone(type) {
    return {
      working: 'cyan',
      episodic: 'green',
      semantic: 'blue',
      procedural: 'gold',
      autobiographical: 'violet',
      project: 'cyan',
      relational: 'rose',
      emotional: 'rose',
    }[type] || 'neutral';
  }

  function renderFooterHost() {
    dom.footer = el('div', { class: 'view-list__footer', 'data-testid': 'list-footer' });
    renderFooter();
    return dom.footer;
  }

  function renderFooter() {
    if (!dom.footer) return;
    dom.footer.textContent = '';
    const source = state.sourceMode === 'graph' ? 'GET /graph' : state.sourceMode === 'search' ? 'memory/search' : '—';
    dom.footer.append(
      el('span', { class: 'view-list__footer-item', text: `来源 ${source}` }),
      el('span', { class: 'view-list__footer-item', text: `总记忆 ${state.allRows.length}` }),
      el('span', { class: 'view-list__footer-item', text: `当前筛选 ${state.rows.length}` }),
      state.truncated ? el('span', { class: 'view-list__footer-item view-list__footer-item--warn', text: '已截断' }) : null,
      state.loading ? el('span', { class: 'view-list__footer-item', text: '同步中…' }) : null,
    );
  }

  function renderBulkBarHost() {
    const host = root && root.querySelector('[data-testid="list-bulkbar"]');
    if (!host) return;
    const next = renderBulkBar();
    host.replaceWith(next);
  }

  function renderToolbarState() {
    const count = root && root.querySelector('[data-testid="list-count"]');
    if (count) count.textContent = `${state.rows.length} / ${state.allRows.length} 条`;
  }

  function attachScroll() {
    if (!scrollEl || !root) return;
    state.viewportHeight = scrollEl.clientHeight || 420;
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = new ResizeObserver(() => {
      if (!scrollEl) return;
      state.viewportHeight = scrollEl.clientHeight || 420;
      renderRows();
    });
    resizeObserver.observe(scrollEl);
    renderRows();
  }

  function updateStatus() {
    try {
      if (!ctx.status) return;
      const trash = state.trash ? '回收站' : '记忆列表';
      ctx.status.set('list.count', {
        label: `${trash} ${state.rows.length}/${state.allRows.length}${state.selected.size ? ` · 已选 ${state.selected.size}` : ''}`,
        tone: state.trash ? 'warn' : 'ok',
      });
    } catch {
      /* noop */
    }
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

  /* ------------------------------ 批量操作 ------------------------------ */

  async function forEachSelected(label, handler) {
    const ids = Array.from(state.selected);
    if (!ids.length) return;
    state.busy = { label, done: 0, total: ids.length };
    state.bulkErrors = [];
    render();
    let ok = 0;
    for (const id of ids) {
      try {
        await handler(id);
        ok += 1;
      } catch (err) {
        const info = errInfo(err);
        state.bulkErrors.push({ id, ...info });
      }
      state.busy.done += 1;
      const bar = root && root.querySelector('.view-list__bulkbar');
      if (bar) bar.replaceWith(renderBulkBar());
    }
    state.busy = null;
    state.selected = new Set();
    if (state.bulkErrors.length) {
      const first = state.bulkErrors[0];
      notify('error', `${label}：${ok} 条成功，${state.bulkErrors.length} 条失败（${first.message}${first.traceId ? ` · ${first.traceId}` : ''}）`);
      if (ctx.log) {
        try {
          ctx.log.warn(`${label} 部分失败`, { scope: 'list.bulk', errors: state.bulkErrors.slice(0, 10) });
        } catch {
          /* noop */
        }
      }
    } else {
      notify('success', `${label}：${ok} 条已完成`);
    }
    loadData({ resetScroll: false });
  }

  async function fetchCurrentMemory(id) {
    const res = await api.getMemory(id);
    const memory = (res && res.memory) || res;
    if (!memory || !memory.id) throw new Error('Runtime 未返回有效记忆对象');
    return memory;
  }

  async function bulkPatch(kind, value) {
    if (kind === 'importance' && (!Number.isFinite(value) || value < 0 || value > 1)) {
      notify('warn', '重要性必须是 0 到 1 之间的数字');
      return;
    }
    if (kind === 'tags' && (!Array.isArray(value) || !value.length)) {
      notify('warn', '请输入至少一个标签');
      return;
    }
    if (kind === 'project' && !String(value || '').trim()) {
      notify('warn', '请输入项目名');
      return;
    }
    const count = state.selected.size;
    let ok = false;
    try {
      if (ctx.dialogs && typeof ctx.dialogs.confirm === 'function') {
        ok = await ctx.dialogs.confirm({
          title: '批量修改',
          message: `将修改 ${count} 条记忆（逐条调用 Runtime PATCH，保留版本历史）。`,
          confirmLabel: '开始修改',
        });
      } else ok = window.confirm(`将修改 ${count} 条记忆，继续？`);
    } catch {
      ok = false;
    }
    if (!ok) return;
    await forEachSelected('批量修改', async (id) => {
      const memory = await fetchCurrentMemory(id);
      if (memory.deleted_at) throw new Error('该记忆已在回收站');
      const payload = buildBulkPayload(kind, value, memory);
      await api.patchMemory(id, { ...payload, expected_version: memory.version });
    });
  }

  async function softDeleteSelected() {
    const count = state.selected.size;
    let ok = false;
    try {
      if (ctx.dialogs && typeof ctx.dialogs.confirm === 'function') {
        ok = await ctx.dialogs.confirm({ title: '软删除所选记忆？', message: `将 ${count} 条记忆移入回收站。历史与关系保留，可在回收站恢复。`, confirmLabel: '移入回收站', danger: true });
      } else ok = window.confirm(`将 ${count} 条记忆移入回收站？`);
    } catch {
      ok = false;
    }
    if (!ok) return;
    await forEachSelected('移入回收站', async (id) => {
      await api.deleteMemory(id, {});
    });
  }

  async function batchRestore() {
    const count = state.selected.size;
    await forEachSelected('恢复记忆', async (id) => {
      await api.restoreMemory(id);
    });
    notify('info', `已提交恢复 ${count} 条记忆`);
  }

  async function purgeSelected() {
    const count = state.selected.size;
    if (!count) return;
    try {
      if (ctx.dialogs && typeof ctx.dialogs.confirm === 'function') {
        const first = await ctx.dialogs.confirm({
          title: '永久删除（第一步确认）',
          message: `即将永久删除 ${count} 条记忆及其历史。该操作不可恢复。`,
          confirmLabel: '继续',
          danger: true,
        });
        if (!first) return;
        const second = await ctx.dialogs.confirm({
          title: '永久删除（第二步确认）',
          message: `请再次确认：${count} 条记忆将被硬删除，无法通过回收站恢复。`,
          confirmLabel: '永久删除',
          danger: true,
        });
        if (!second) return;
      } else {
        if (!window.confirm(`永久删除 ${count} 条记忆？不可恢复，是否继续？`)) return;
        if (!window.confirm(`再次确认：永久删除 ${count} 条记忆及其历史。`)) return;
      }
    } catch {
      return;
    }
    await forEachSelected('永久删除', async (id) => {
      await api.deleteMemory(id, { hard: true, confirm: true });
    });
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  function unmount() {
    try {
      if (ctx.status) ctx.status.remove('list.count');
    } catch {
      /* noop */
    }
    clearTimeout(reloadTimer);
    if (rowRenderFrame) cancelAnimationFrame(rowRenderFrame);
    if (resizeObserver) resizeObserver.disconnect();
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
    scrollEl = null;
    rowsHost = null;
    dom.footer = null;
  }

  function activate() {
    if (!state.allRows.length && !state.loading && !state.loadError) loadData();
  }

  function handleCommand(command) {
    if (command === 'view:refresh') {
      loadData({ resetScroll: false });
      return true;
    }
    return false;
  }

  function getSnapshot() {
    return { trash: state.trash, filters: state.filters, sort: state.sort };
  }

  return { mount, unmount, activate, handleCommand, getSnapshot };
}

/* ============================================================================
 * 样式（CSS 变量，命名空间 view-list-*）
 * ========================================================================== */

const LIST_CSS = `
.view-list { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--fca-bg-1); color:var(--fca-text); font-family:var(--fca-font-ui); font-size:var(--fca-text-md); }
.view-list__bar { display:flex; align-items:center; justify-content:space-between; gap:var(--fca-space-3); padding:var(--fca-space-2) var(--fca-space-4); border-bottom:1px solid var(--fca-border); background:var(--fca-bg-2); flex-wrap:wrap; }
.view-list__title { display:flex; align-items:baseline; gap:var(--fca-space-2); }
.view-list__title h2 { margin:0; font-size:var(--fca-text-lg); font-weight:600; }
.view-list__count { font-size:var(--fca-text-sm); color:var(--fca-text-muted); font-family:var(--fca-font-mono); }
.view-list__tabs { display:flex; gap:2px; background:var(--fca-bg-3); border:1px solid var(--fca-border); border-radius:var(--fca-radius); padding:2px; }
.view-list__tab { border:none; background:transparent; color:var(--fca-text-dim); font:inherit; font-size:var(--fca-text-sm); padding:3px var(--fca-space-3); border-radius:var(--fca-radius-sm); cursor:pointer; }
.view-list__tab:hover { color:var(--fca-text); }
.view-list__tab.is-active { background:var(--fca-bg-1); color:var(--fca-accent-strong); box-shadow:inset 0 0 0 1px var(--fca-border-strong); }
.view-list__header-actions { display:flex; gap:var(--fca-space-2); }
.view-list__btn { display:inline-flex; align-items:center; gap:5px; height:28px; padding:0 var(--fca-space-3); border-radius:var(--fca-radius-sm); border:1px solid var(--fca-border); background:var(--fca-bg-3); color:var(--fca-text); font:inherit; font-size:var(--fca-text-sm); cursor:pointer; white-space:nowrap; }
.view-list__btn:hover { background:var(--fca-bg-4); border-color:var(--fca-border-strong); }
.view-list__btn:disabled { opacity:.45; cursor:not-allowed; }
.view-list__btn--primary { background:var(--fca-accent-soft); border-color:var(--fca-accent); color:var(--fca-accent-strong); }
.view-list__btn--ghost { background:transparent; border-color:transparent; color:var(--fca-text-dim); }
.view-list__btn--ghost:hover { background:var(--fca-bg-3); color:var(--fca-text); }
.view-list__btn--danger { background:transparent; border-color:var(--fca-danger); color:var(--fca-danger); }
.view-list__btn--danger:hover { background:color-mix(in srgb, var(--fca-danger) 14%, transparent); }
.view-list__btn--sm { height:24px; padding:0 var(--fca-space-2); font-size:var(--fca-text-xs); }
.view-list__spinner-sm { width:11px;height:11px;border-radius:50%;border:2px solid var(--fca-border-strong);border-top-color:var(--fca-accent);animation:view-list-spin .8s linear infinite;display:inline-block; }
@keyframes view-list-spin { to { transform:rotate(360deg); } }
.view-list__loading { display:flex; flex-direction:column; align-items:center; gap:var(--fca-space-3); padding:var(--fca-space-6); color:var(--fca-text-dim); }
.view-list__spinner { width:22px;height:22px;border-radius:50%;border:2px solid var(--fca-border-strong);border-top-color:var(--fca-accent);animation:view-list-spin .8s linear infinite; }
.view-list__toolbar { display:flex; align-items:center; gap:var(--fca-space-3); padding:var(--fca-space-2) var(--fca-space-4); border-bottom:1px solid var(--fca-border); background:var(--fca-bg-1); flex-wrap:wrap; }
.view-list__toolbar-group { display:flex; align-items:center; gap:var(--fca-space-2); }
.view-list__label { font-size:var(--fca-text-xs); color:var(--fca-text-muted); }
.view-list__input { background:var(--fca-bg-3); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); color:var(--fca-text); font:inherit; font-size:var(--fca-text-sm); padding:4px var(--fca-space-2); height:28px; outline:none; }
.view-list__input:focus { border-color:var(--fca-accent); }
.view-list__input--search { flex:1; min-width:180px; max-width:340px; }
.view-list__input--num { width:86px; }
.view-list__input--text { width:140px; }
.view-list__input--date { width:140px; }
.view-list__select { background:var(--fca-bg-3); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); color:var(--fca-text); font:inherit; font-size:var(--fca-text-sm); height:28px; padding:0 var(--fca-space-1); outline:none; }
.view-list__chips { display:flex; gap:3px; flex-wrap:wrap; }
.view-list__chip { border:1px solid var(--fca-border); background:var(--fca-bg-2); color:var(--fca-text-muted); font:inherit; font-size:var(--fca-text-xs); border-radius:999px; padding:2px var(--fca-space-2); cursor:pointer; }
.view-list__chip:hover { color:var(--fca-text); border-color:var(--fca-border-strong); }
.view-list__chip.is-active { background:var(--fca-accent-soft); border-color:var(--fca-accent); color:var(--fca-accent-strong); }
.view-list__custom-range { display:flex; align-items:center; gap:var(--fca-space-1); }
.view-list__hint { padding:3px var(--fca-space-4); font-size:var(--fca-text-xs); color:var(--fca-text-muted); border-bottom:1px solid var(--fca-border); background:var(--fca-bg-0); }
.view-list__hint--empty { display:none; }
.view-list__bulkbar { display:flex; align-items:center; gap:var(--fca-space-2); padding:var(--fca-space-1) var(--fca-space-4); border-bottom:1px solid var(--fca-border); background:var(--fca-bg-2); min-height:38px; flex-wrap:wrap; }
.view-list__bulkbar--idle { color:var(--fca-text-muted); }
.view-list__bulkbar-count { font-size:var(--fca-text-sm); color:var(--fca-accent-strong); font-family:var(--fca-font-mono); }
.view-list__bulkbar-busy { display:flex; align-items:center; gap:var(--fca-space-2); font-size:var(--fca-text-sm); color:var(--fca-text-dim); width:100%; }
.view-list__progress { flex:1; height:5px; background:var(--fca-bg-3); border-radius:999px; overflow:hidden; min-width:120px; }
.view-list__progress-fill { height:100%; background:var(--fca-accent); transition:width var(--fca-dur) var(--fca-ease); }
.view-list__inline { display:flex; align-items:center; gap:3px; }
.view-list__muted { color:var(--fca-text-muted); font-size:var(--fca-text-sm); }
.view-list__body { flex:1; min-height:0; display:flex; flex-direction:column; }
.view-list__table { flex:1; min-height:0; display:flex; flex-direction:column; }
.view-list__thead { display:flex; align-items:center; border-bottom:1px solid var(--fca-border-strong); background:var(--fca-bg-2); padding:0 var(--fca-space-3); flex-shrink:0; height:30px; }
.view-list__th { display:flex; align-items:center; gap:4px; font-size:var(--fca-text-xs); color:var(--fca-text-muted); cursor:pointer; user-select:none; overflow:hidden; white-space:nowrap; }
.view-list__th:hover { color:var(--fca-text); }
.view-list__th.is-sorted { color:var(--fca-accent-strong); }
.view-list__th--check { flex:0 0 30px; }
.view-list__sort-arrow { color:var(--fca-accent); }
.view-list__scroll { flex:1; overflow-y:auto; position:relative; scrollbar-width:thin; }
.view-list__rows { position:relative; }
.view-list__tr { position:absolute; left:0; right:0; display:flex; align-items:center; padding:0 var(--fca-space-3); border-bottom:1px solid var(--fca-border); cursor:pointer; font-size:var(--fca-text-sm); box-sizing:border-box; }
.view-list__tr:hover { background:var(--fca-bg-3); }
.view-list__tr.is-selected { background:var(--fca-accent-soft); }
.view-list__tr.is-deleted { opacity:.68; }
.view-list__td { display:flex; align-items:center; gap:var(--fca-space-1); min-width:0; overflow:hidden; color:var(--fca-text); }
.view-list__td--check { flex:0 0 30px; }
.view-list__td--title { flex:1 1 auto; flex-direction:column; align-items:flex-start; gap:1px; min-width:180px; }
.view-list__td--time { flex:0 0 170px; }
.view-list__td--num { flex:0 0 62px; justify-content:flex-end; font-family:var(--fca-font-mono); color:var(--fca-text-dim); }
.view-list__row-title { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; color:var(--fca-text); }
.view-list__row-badges { display:flex; gap:3px; flex-wrap:nowrap; overflow:hidden; }
.view-list__tag { display:inline-flex; align-items:center; font-size:10px; line-height:15px; padding:0 5px; border-radius:999px; border:1px solid var(--fca-border-strong); color:var(--fca-text-muted); white-space:nowrap; }
.view-list__tag--cyan { color:var(--fca-accent); border-color:color-mix(in srgb, var(--fca-accent) 40%, transparent); }
.view-list__tag--green { color:var(--fca-green); border-color:color-mix(in srgb, var(--fca-green) 40%, transparent); }
.view-list__tag--violet { color:var(--fca-violet); border-color:color-mix(in srgb, var(--fca-violet) 40%, transparent); }
.view-list__tag--rose { color:var(--fca-rose); border-color:color-mix(in srgb, var(--fca-rose) 40%, transparent); }
.view-list__tag--gold { color:var(--fca-gold); border-color:color-mix(in srgb, var(--fca-gold) 40%, transparent); }
.view-list__tag--blue { color:var(--fca-accent-strong); border-color:var(--fca-border-strong); }
.view-list__tag--neutral { color:var(--fca-text-muted); }
.view-list__prec { font-size:10px; padding:0 4px; border-radius:3px; border:1px solid var(--fca-border); color:var(--fca-text-muted); flex-shrink:0; }
.view-list__prec--green { color:var(--fca-green); }
.view-list__prec--cyan { color:var(--fca-accent); }
.view-list__prec--gold { color:var(--fca-gold); }
.view-list__prec--rose { color:var(--fca-rose); }
.view-list__bar-fill { height:100%; background:linear-gradient(90deg, var(--fca-accent), var(--fca-accent-strong)); border-radius:999px; }
.view-list__bar { width:64px; height:5px; background:var(--fca-bg-4); border-radius:999px; overflow:hidden; }
.view-list__checkbox { accent-color:var(--fca-accent); width:13px; height:13px; cursor:pointer; }
.view-list__mono { font-family:var(--fca-font-mono); font-size:var(--fca-text-xs); color:var(--fca-text-muted); }
.view-list__empty { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:var(--fca-space-2); padding:var(--fca-space-6); height:100%; text-align:center; }
.view-list__empty-title { font-size:var(--fca-text-lg); color:var(--fca-text); }
.view-list__empty-desc { color:var(--fca-text-muted); font-size:var(--fca-text-sm); max-width:420px; line-height:1.7; }
.view-list__empty-actions { margin-top:var(--fca-space-2); }
.view-list__footer { display:flex; align-items:center; gap:var(--fca-space-4); padding:3px var(--fca-space-4); border-top:1px solid var(--fca-border); background:var(--fca-bg-2); font-size:var(--fca-text-xs); color:var(--fca-text-muted); font-family:var(--fca-font-mono); flex-shrink:0; }
.view-list__footer-item--warn { color:var(--fca-gold); }
.view-list__errorbox { margin:var(--fca-space-5); padding:var(--fca-space-4); border:1px solid color-mix(in srgb, var(--fca-danger) 50%, var(--fca-border)); background:color-mix(in srgb, var(--fca-danger) 8%, var(--fca-bg-2)); border-radius:var(--fca-radius); display:flex; flex-direction:column; gap:var(--fca-space-2); max-width:620px; }
.view-list__errorbox-title { color:var(--fca-danger); font-weight:600; }
.view-list__errorbox-detail { color:var(--fca-text-dim); font-size:var(--fca-text-sm); }
.view-list__row-actions { display:flex; gap:var(--fca-space-2); }
@media (max-width: 900px) { .view-list__td--time { flex-basis:128px; } .view-list__custom-range { display:none; } }
`;
