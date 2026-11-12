/**
 * FCA Memory Atlas — 搜索视图（Desktop Editor 组，Alpha 0.1）
 *
 * 契约：desktop/renderer/lib/contracts.md v1.0 §2/§3/§4/§6
 * 职责：
 *  - 全文 / 语义 / 混合三种模式（真实 POST /memory/search，mode 原样下发）
 *  - 筛选：时间范围、记忆类型、人物/项目实体、标签；结果高亮、分页、打开编辑器、定位星图
 *  - 关系检索：GET /relations 全量列表 + 客户端匹配（Runtime 未提供全局关系搜索时的诚实降级）
 *  - 历史版本搜索：Runtime Alpha 0.1 无该端点 → 明确标注不可用，不伪造结果
 *  - 深链：#view=search&q=…；无假数据，错误/空态显式展示
 */

export const meta = {
  id: 'search',
  title: '搜索',
  icon: 'search',
  order: 35,
  nav: true,
  shortcut: 'g s',
};

export const SEARCH_MODES = [
  { value: 'fulltext', label: '全文', hint: 'FTS / 关键词匹配（中文 bigram）' },
  { value: 'semantic', label: '语义', hint: '本地确定性向量（local-hash-v1）' },
  { value: 'hybrid', label: '混合', hint: '全文 + 语义融合排序' },
];

export const SEARCH_MEMORY_TYPES = [
  { value: 'working', label: '工作' },
  { value: 'episodic', label: '情景' },
  { value: 'semantic', label: '语义' },
  { value: 'procedural', label: '程序' },
  { value: 'autobiographical', label: '自传' },
  { value: 'project', label: '项目' },
  { value: 'relational', label: '关系' },
  { value: 'emotional', label: '情绪' },
];

const TYPE_LABEL = SEARCH_MEMORY_TYPES.reduce((acc, t) => {
  acc[t.value] = t.label;
  return acc;
}, {});

const PRECISION_LABEL = {
  exact: '精确',
  day: '日',
  month: '月',
  year: '年',
  approximate: '估计',
  unknown: '未知',
};

export const SEARCH_PRESETS = [
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

/** 搜索结果响应归一化 */
export function normalizeSearchResponse(response) {
  const items = Array.isArray(response)
    ? response
    : (response && (response.items || response.results)) || [];
  return {
    items: items
      .map((item) => {
        const memory = (item && item.memory) || item;
        if (!memory || !memory.id) return null;
        return {
          memory,
          score: Number.isFinite(item && item.score) ? item.score : (Number.isFinite(item && item.relevance) ? item.relevance : null),
          highlights: item && item.highlights,
        };
      })
      .filter(Boolean),
    nextCursor: (response && (response.next_cursor || response.nextCursor)) || null,
    total: Number.isFinite(response && response.total) ? response.total : null,
    tookMs: Number.isFinite(response && (response.took_ms || response.tookMs)) ? response.took_ms || response.tookMs : null,
    error: null,
  };
}

/** 把文本按查询词切分为高亮片段：[{text, hit:boolean}] */
export function splitHighlight(text, query) {
  const source = String(text ?? '');
  const terms = String(query ?? '')
    .split(/[\s,，;；]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0 && term.length <= 64)
    .slice(0, 8);
  if (!terms.length || !source) return [{ text: source, hit: false }];
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  let regex;
  try {
    regex = new RegExp(`(${escaped.join('|')})`, 'gi');
  } catch {
    return [{ text: source, hit: false }];
  }
  const segments = [];
  let lastIndex = 0;
  let match;
  let guard = 0;
  while ((match = regex.exec(source)) !== null && guard < 500) {
    guard += 1;
    if (match.index > lastIndex) segments.push({ text: source.slice(lastIndex, match.index), hit: false });
    segments.push({ text: match[0], hit: true });
    lastIndex = match.index + match[0].length;
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  if (lastIndex < source.length) segments.push({ text: source.slice(lastIndex), hit: false });
  return segments.length ? segments : [{ text: source, hit: false }];
}

/** 服务端 highlights（可能是 HTML 片段或字符串）→ 纯文本（防 XSS） */
export function sanitizeHighlightText(value) {
  if (value === null || value === undefined) return '';
  const raw = Array.isArray(value) ? value.join(' … ') : String(value);
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 根据当前筛选状态构建 API filters（对齐 Runtime memory/search filters：扁平字段） */
export function buildSearchFilters(filters) {
  const f = filters || {};
  const out = {};
  if (Array.isArray(f.types) && f.types.length) out.types = f.types.slice();
  const tags = [...(Array.isArray(f.tagIds) ? f.tagIds : []), ...(Array.isArray(f.tagNames) ? f.tagNames : [])].filter(Boolean);
  if (tags.length) out.tags = tags;
  if (Array.isArray(f.entityIds) && f.entityIds.length) out.entity_ids = f.entityIds.slice();
  if (f.timeRange && (f.timeRange.from || f.timeRange.to)) {
    if (f.timeRange.from) out.occurred_from = f.timeRange.from;
    if (f.timeRange.to) out.occurred_to = f.timeRange.to;
  }
  if (f.includeDeleted) out.include_deleted = true;
  return out;
}

/** 客户端补充筛选（实体/标签名/精度）：Runtime 过滤能力之外的兜底，全部基于真实返回的 memory 对象 */
export function matchMemoryFilters(memory, filters) {
  const f = filters || {};
  if (!memory) return false;
  if (Array.isArray(f.entityIds) && f.entityIds.length) {
    const participants = Array.isArray(memory.participants) ? memory.participants : [];
    const participantIds = participants.map((p) => p.entity_id).filter(Boolean);
    const projectId = memory.project && memory.project.entity_id;
    const hit = f.entityIds.some((id) => participantIds.includes(id) || projectId === id);
    if (!hit) return false;
  }
  if (Array.isArray(f.tagNames) && f.tagNames.length) {
    const tagNames = (Array.isArray(memory.tag_names) ? memory.tag_names : []).map((t) => String(t).toLowerCase());
    const wanted = f.tagNames.map((t) => String(t).toLowerCase());
    if (!wanted.every((name) => tagNames.includes(name))) return false;
  }
  if (Array.isArray(f.precisions) && f.precisions.length) {
    const precision = memory.occurred_precision || (memory.occurred_at ? 'exact' : 'unknown');
    if (!f.precisions.includes(precision)) return false;
  }
  return true;
}

/** 从正文生成摘要片段（优先命中位置附近） */
export function makeSnippet(body, query, maxLength = 220) {
  const text = String(body ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  const terms = String(query ?? '')
    .split(/[\s,，;；]+/)
    .filter(Boolean);
  let index = -1;
  for (const term of terms) {
    const found = text.toLowerCase().indexOf(term.toLowerCase());
    if (found >= 0) {
      index = found;
      break;
    }
  }
  if (index < 0) return `${text.slice(0, maxLength)}…`;
  const start = Math.max(0, index - Math.floor(maxLength / 3));
  const end = Math.min(text.length, start + maxLength);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export function scoreText(score) {
  if (!Number.isFinite(score)) return '—';
  return score.toFixed(3);
}

export function typeLabelOf(value) {
  return TYPE_LABEL[value] || value || '未分类';
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
  let searchTimer = null;
  let entityTimer = null;

  const state = {
    tab: 'memories', // memories | relations | versions
    mode: 'fulltext',
    query: '',
    filters: {
      types: [],
      tagIds: [],
      tagNames: [],
      presets: [],
      preset: 'all',
      from: '',
      to: '',
      timeRange: { from: null, to: null },
      entityIds: [],
      entityLabels: [],
      includeDeleted: false,
      precisions: [],
    },
    results: [],
    nextCursor: null,
    total: null,
    tookMs: null,
    searched: false,
    loading: false,
    loadingMore: false,
    error: null,
    tagsDirectory: null, // null=未探测/不可用，数组=Runtime 提供
    tagDirectoryError: null,
    relations: { items: [], loading: false, error: null, searched: false, query: '' },
    versionSearchUnavailable: true,
    entities: { loading: false, error: null, results: [] },
    detailMemoryId: null,
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
      class: `view-search__btn view-search__btn--${opts.variant || 'secondary'}${opts.size === 'sm' ? ' view-search__btn--sm' : ''}`,
      disabled: Boolean(opts.disabled || opts.loading),
      title: opts.title || '',
      'data-testid': opts.testid || null,
      on: { click: (event) => opts.onClick && opts.onClick(event) },
    }, [opts.icon ? icon(opts.icon) : null, opts.label ? el('span', { text: opts.label }) : null]);
  }

  function highlightNode(text, query) {
    const frag = doc.createDocumentFragment();
    for (const seg of splitHighlight(text, query)) {
      if (seg.hit) frag.append(el('mark', { class: 'view-search__mark', text: seg.text }));
      else frag.append(doc.createTextNode(seg.text));
    }
    return frag;
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
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

  function getParams() {
    try {
      if (ctx.router && ctx.router.params && typeof ctx.router.params.get === 'function') return ctx.router.params;
    } catch {
      /* noop */
    }
    try {
      const hash = window.location.hash.replace(/^#/, '');
      const index = hash.indexOf('&');
      return new URLSearchParams(index >= 0 ? hash.slice(index + 1) : '');
    } catch {
      return new URLSearchParams('');
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

  /* ------------------------------ 标签目录探测 ------------------------------ */

  async function probeTagDirectory() {
    try {
      const res = await api.getState();
      const arr = findTagArray(res);
      if (arr) {
        state.tagsDirectory = arr
          .map((t) => (typeof t === 'string' ? { id: t, name: t } : { id: t.id, name: t.name || t.label || t.id }))
          .filter((t) => t.id || t.name);
      } else {
        state.tagsDirectory = null;
      }
    } catch (err) {
      state.tagsDirectory = null;
      state.tagDirectoryError = errInfo(err).message;
    }
    renderFilterBar();
  }

  function findTagArray(res) {
    if (!res || typeof res !== 'object') return null;
    for (const candidate of [res.tags, res.tag_list, res.state && res.state.tags, res.data && res.data.tags]) {
      if (Array.isArray(candidate)) return candidate;
    }
    return null;
  }

  /* -------------------------------- 搜索 -------------------------------- */

  async function runSearch(opts = {}) {
    if (state.tab !== 'memories') state.tab = 'memories';
    const query = String(state.query || '').trim();
    if (!query) {
      state.searched = false;
      state.results = [];
      state.error = null;
      state.nextCursor = null;
      renderResults();
      return;
    }
    state.loading = true;
    state.error = null;
    state.results = [];
    state.nextCursor = null;
    state.searched = true;
    renderResults();
    try {
      const res = await api.searchMemory({
        query,
        mode: state.mode,
        filters: buildSearchFilters(state.filters),
        limit: opts.limit || 30,
        include_deleted: Boolean(state.filters.includeDeleted),
      });
      const normalized = normalizeSearchResponse(res);
      state.results = normalized.items.filter((item) => matchMemoryFilters(item.memory, state.filters));
      state.nextCursor = normalized.nextCursor;
      state.total = normalized.total;
      state.tookMs = normalized.tookMs;
      state.loading = false;
      renderResults();
      updateStatus();
    } catch (err) {
      state.loading = false;
      state.error = errInfo(err);
      renderResults();
    }
  }

  async function loadMore() {
    if (!state.nextCursor || state.loadingMore) return;
    state.loadingMore = true;
    renderResults();
    try {
      const res = await api.searchMemory({
        query: state.query,
        mode: state.mode,
        filters: buildSearchFilters(state.filters),
        limit: 30,
        cursor: state.nextCursor,
        include_deleted: Boolean(state.filters.includeDeleted),
      });
      const normalized = normalizeSearchResponse(res);
      state.results = state.results.concat(normalized.items.filter((item) => matchMemoryFilters(item.memory, state.filters)));
      state.nextCursor = normalized.nextCursor;
      state.loadingMore = false;
      renderResults();
    } catch (err) {
      state.loadingMore = false;
      notify('error', `加载更多失败：${errInfo(err).message}`);
      renderResults();
    }
  }

  async function runRelationSearch() {
    state.relations.loading = true;
    state.relations.error = null;
    renderResults();
    try {
      const res = await api.listRelations({ limit: 500 });
      const items = normalizeItems(res);
      const query = String(state.relations.query || '').trim().toLowerCase();
      state.relations.items = query
        ? items.filter((rel) => {
            const haystack = [rel.relation_type, rel.label, rel.evidence, rel.id, rel.from && rel.from.id, rel.to && rel.to.id]
              .filter(Boolean)
              .join(' ')
              .toLowerCase();
            return haystack.includes(query);
          })
        : items;
      state.relations.searched = true;
      state.relations.loading = false;
      renderResults();
    } catch (err) {
      state.relations.loading = false;
      state.relations.error = errInfo(err);
      renderResults();
    }
  }

  function normalizeItems(response) {
    if (Array.isArray(response)) return response;
    if (!response || typeof response !== 'object') return [];
    for (const key of ['items', 'relations', 'results', 'data']) if (Array.isArray(response[key])) return response[key];
    return [];
  }

  /* -------------------------------- 实体选择 -------------------------------- */

  async function searchEntities(query) {
    if (!String(query || '').trim()) {
      state.entities.results = [];
      renderEntitySuggestions();
      return;
    }
    state.entities.loading = true;
    renderEntitySuggestions();
    try {
      const res = await api.listEntities({ q: String(query).trim(), limit: 8 });
      state.entities.results = normalizeItems(res);
      state.entities.error = null;
    } catch (err) {
      state.entities.results = [];
      state.entities.error = errInfo(err).message;
    } finally {
      state.entities.loading = false;
      renderEntitySuggestions();
    }
  }

  /* -------------------------------- 渲染 -------------------------------- */

  function mount(container) {
    styleEl = doc.createElement('style');
    styleEl.id = 'view-search-style';
    styleEl.textContent = SEARCH_CSS;
    doc.head.append(styleEl);
    root = el('div', { class: 'view-search', 'data-testid': 'view-search' });
    container.append(root);
    const params = getParams();
    const initialQuery = params.get ? params.get('q') : null;
    if (initialQuery) state.query = initialQuery;
    render();
    probeTagDirectory();
    if (initialQuery) runSearch();
    subscribeMany(['sse:memory.updated', 'sse:memory.deleted', 'sse:memory.created'], () => {
      if (state.searched && !state.loading && state.tab === 'memories') {
        // 结果不自动重跑（避免打断阅读），仅在结果记录列表上标记提示
        renderStatusHint();
      }
    });
    setStatus();
  }

  function setStatus() {
    try {
      if (!ctx.status) return;
      ctx.status.set('search.state', {
        label: state.searched ? `搜索「${state.query}」· ${state.results.length}${state.total != null ? `/${state.total}` : ''}` : '搜索',
        tone: state.error ? 'error' : 'info',
      });
    } catch {
      /* noop */
    }
  }

  function render() {
    if (!root) return;
    root.textContent = '';
    root.append(renderSearchBar());
    root.append(renderTabs());
    root.append(renderFilterBar());
    const results = el('div', { class: 'view-search__results fca-scroll', 'data-testid': 'search-results' });
    dom.resultsHost = results;
    root.append(results);
    if (state.tab === 'memories') renderResults();
    else if (state.tab === 'relations') renderRelationsResults();
    else renderVersionsNotice();
  }

  function renderSearchBar() {
    dom.queryInput = el('input', {
      class: 'view-search__input',
      type: 'search',
      placeholder: '搜索记忆（全文 / 语义 / 混合）…',
      value: state.query,
      'data-testid': 'search-input',
      autocomplete: 'off',
      on: {
        input: (event) => {
          state.query = event.target.value;
          clearTimeout(searchTimer);
          if (!state.query.trim()) {
            state.searched = false;
            state.results = [];
            state.nextCursor = null;
            state.error = null;
            renderResults();
            return;
          }
          searchTimer = setTimeout(() => {
            if (state.query.trim()) runSearch();
          }, 380);
        },
        keydown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            clearTimeout(searchTimer);
            runSearch();
          }
        },
      },
    });
    const modeRow = el('div', { class: 'view-search__modes', role: 'tablist' });
    for (const mode of SEARCH_MODES) {
      modeRow.append(el('button', {
        type: 'button',
        role: 'tab',
        class: `view-search__mode${state.mode === mode.value ? ' is-active' : ''}`,
        'aria-selected': String(state.mode === mode.value),
        title: mode.hint,
        'data-testid': `search-mode-${mode.value}`,
        text: mode.label,
        on: {
          click: () => {
            if (state.mode === mode.value) return;
            state.mode = mode.value;
            render();
            if (state.query.trim()) runSearch();
          },
        },
      }));
    }
    const searchBtn = button({ label: '搜索', icon: 'search', variant: 'primary', testid: 'search-submit', loading: state.loading, onClick: () => runSearch() });
    const clearBtn = button({
      label: '重置',
      variant: 'ghost',
      onClick: () => {
        state.query = '';
        state.results = [];
        state.searched = false;
        state.error = null;
        state.filters = {
          types: [], tagIds: [], tagNames: [], preset: 'all', from: '', to: '', timeRange: { from: null, to: null },
          entityIds: [], entityLabels: [], includeDeleted: false, precisions: [],
        };
        render();
      },
    });
    return el('div', { class: 'view-search__bar' }, [
      el('div', { class: 'view-search__bar-main' }, [icon('search', { size: 18 }), dom.queryInput, searchBtn, clearBtn]),
      modeRow,
    ]);
  }

  function renderTabs() {
    const tabs = el('div', { class: 'view-search__tabs', role: 'tablist' });
    const items = [
      { id: 'memories', label: '记忆' },
      { id: 'relations', label: '关系' },
      { id: 'versions', label: '历史版本' },
    ];
    for (const tab of items) {
      tabs.append(el('button', {
        type: 'button',
        role: 'tab',
        class: `view-search__tab${state.tab === tab.id ? ' is-active' : ''}`,
        'aria-selected': String(state.tab === tab.id),
        'data-testid': `search-tab-${tab.id}`,
        text: tab.label,
        on: {
          click: () => {
            state.tab = tab.id;
            render();
          },
        },
      }));
    }
    const hint = el('span', { class: 'view-search__hint' });
    if (state.searched && state.tookMs != null) hint.textContent = `耗时 ${state.tookMs} ms · 模式 ${state.mode}`;
    tabs.append(hint);
    return tabs;
  }

  function renderFilterBar() {
    const host = dom.filterHost || el('div', { class: 'view-search__filters' });
    dom.filterHost = host;
    host.textContent = '';
    // 类型
    const typeChips = el('div', { class: 'view-search__chips' });
    for (const type of SEARCH_MEMORY_TYPES) {
      const active = state.filters.types.includes(type.value);
      typeChips.append(el('button', {
        type: 'button',
        class: `view-search__chip${active ? ' is-active' : ''}`,
        text: type.label,
        'data-testid': `search-type-${type.value}`,
        'aria-pressed': String(active),
        on: {
          click: () => {
            state.filters.types = active ? state.filters.types.filter((t) => t !== type.value) : [...state.filters.types, type.value];
            rerunFilters();
          },
        },
      }));
    }
    // 时间
    const presetSelect = el('select', {
      class: 'view-search__select',
      'data-testid': 'search-time-preset',
      'aria-label': '时间范围',
      on: {
        change: (event) => {
          state.filters.preset = event.target.value;
          state.filters.timeRange = presetToRange(event.target.value);
          rerunFilters();
        },
      },
    });
    for (const preset of SEARCH_PRESETS) {
      const option = el('option', { value: preset.value, text: preset.label });
      if (preset.value === state.filters.preset) option.selected = true;
      presetSelect.append(option);
    }
    let customRow = null;
    if (state.filters.preset === 'custom') {
      customRow = el('div', { class: 'view-search__inline' }, [
        el('input', {
          class: 'view-search__input view-search__input--date', type: 'date', value: state.filters.from, 'data-testid': 'search-from',
          on: { change: (e) => { state.filters.from = e.target.value; state.filters.timeRange = customRange(state.filters); rerunFilters(); } },
        }),
        el('span', { class: 'view-search__muted', text: '至' }),
        el('input', {
          class: 'view-search__input view-search__input--date', type: 'date', value: state.filters.to, 'data-testid': 'search-to',
          on: { change: (e) => { state.filters.to = e.target.value; state.filters.timeRange = customRange(state.filters); rerunFilters(); } },
        }),
      ]);
    }
    // 标签筛选：Runtime filters 支持 tag id 或标签名，因此始终可按名称筛选；
    // GET /state 若返回标签目录，则额外提供下拉建议（仅增强，不是必需）。
    const tagHost = el('div', { class: 'view-search__inline', 'data-testid': 'search-tag-filter' });
    const tagInput = el('input', {
      class: 'view-search__input view-search__input--tag',
      type: 'text',
      placeholder: '标签名，Enter 添加',
      'data-testid': 'search-tag-input',
      on: {
        keydown: (event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            addTagName(tagInput);
          }
        },
      },
    });
    tagHost.append(tagInput, button({ label: '加标签', size: 'sm', onClick: () => addTagName(tagInput) }));
    if (Array.isArray(state.tagsDirectory) && state.tagsDirectory.length) {
      const tagSelect = el('select', {
        class: 'view-search__select',
        'aria-label': '标签目录',
        on: {
          change: (event) => {
            const value = event.target.value;
            if (!value) return;
            const found = state.tagsDirectory.find((t) => t.id === value || t.name === value);
            const name = found ? found.name : value;
            if (name && !state.filters.tagNames.includes(name)) state.filters.tagNames.push(name);
            if (found && found.id && !state.filters.tagIds.includes(found.id)) state.filters.tagIds.push(found.id);
            rerunFilters();
          },
        },
      });
      tagSelect.append(el('option', { value: '', text: '从标签目录选择…' }));
      for (const tag of state.tagsDirectory.slice(0, 100)) tagSelect.append(el('option', { value: tag.id || tag.name, text: tag.name }));
      tagHost.append(tagSelect);
    } else {
      tagHost.append(el('span', {
        class: 'view-search__muted',
        title: 'Runtime GET /state 未返回标签目录，但搜索 filters 支持按标签名筛选',
        text: '（自由输入标签名；标签目录不可用）',
      }));
    }
    for (const name of state.filters.tagNames.slice()) {
      tagHost.append(el('span', { class: 'view-search__chip is-active' }, [
        el('span', { text: `#${name}` }),
        el('button', {
          type: 'button',
          class: 'view-search__chip-x',
          'aria-label': '移除标签筛选',
          text: '×',
          on: {
            click: () => {
              state.filters.tagNames = state.filters.tagNames.filter((n) => n !== name);
              state.filters.tagIds = state.filters.tagIds.filter((id) => {
                const found = (state.tagsDirectory || []).find((t) => t.id === id);
                return found ? found.name !== name : true;
              });
              rerunFilters();
            },
          },
        }),
      ]));
    }
    for (const id of state.filters.tagIds.slice()) {
      const found = (state.tagsDirectory || []).find((t) => t.id === id);
      if (found && state.filters.tagNames.includes(found.name)) continue;
      tagHost.append(el('span', { class: 'view-search__chip is-active' }, [
        el('span', { text: found ? found.name : id }),
        el('button', {
          type: 'button',
          class: 'view-search__chip-x',
          'aria-label': '移除标签筛选',
          text: '×',
          on: {
            click: () => {
              state.filters.tagIds = state.filters.tagIds.filter((t) => t !== id);
              rerunFilters();
            },
          },
        }),
      ]));
    }
    // 实体（人物/项目）筛选
    dom.entityInput = el('input', {
      class: 'view-search__input view-search__input--entity',
      type: 'text',
      placeholder: '按人物/项目实体筛选…',
      value: '',
      'data-testid': 'search-entity-input',
      on: {
        input: (event) => {
          clearTimeout(entityTimer);
          entityTimer = setTimeout(() => searchEntities(event.target.value), 250);
        },
      },
    });
    const entityChips = el('div', { class: 'view-search__chips' });
    for (let i = 0; i < state.filters.entityIds.length; i += 1) {
      const id = state.filters.entityIds[i];
      const label = state.filters.entityLabels[i] || id;
      entityChips.append(el('span', { class: 'view-search__chip is-active' }, [
        el('span', { text: label }),
        el('button', {
          type: 'button',
          class: 'view-search__chip-x',
          'aria-label': '移除实体筛选',
          text: '×',
          on: {
            click: () => {
              state.filters.entityIds = state.filters.entityIds.filter((e) => e !== id);
              state.filters.entityLabels = state.filters.entityLabels.filter((e) => e !== label);
              rerunFilters();
            },
          },
        }),
      ]));
    }
    dom.entitySuggestHost = el('div', { class: 'view-search__suggestions' });
    // 回收站 + 精度
    const includeDeletedWrap = el('label', { class: 'view-search__check' }, [
      el('input', {
        type: 'checkbox',
        checked: state.filters.includeDeleted,
        'data-testid': 'search-include-deleted',
        on: {
          change: (event) => {
            state.filters.includeDeleted = event.target.checked;
            rerunFilters();
          },
        },
      }),
      el('span', { text: '包含回收站' }),
    ]);
    const precisionSelect = el('select', {
      class: 'view-search__select',
      'aria-label': '时间精度',
      on: {
        change: (event) => {
          state.filters.precisions = event.target.value ? [event.target.value] : [];
          rerunFilters();
        },
      },
    });
    precisionSelect.append(el('option', { value: '', text: '全部时间精度' }));
    for (const [key, label] of Object.entries(PRECISION_LABEL)) {
      const option = el('option', { value: key, text: `${label}时间` });
      if (state.filters.precisions.length === 1 && state.filters.precisions[0] === key) option.selected = true;
      precisionSelect.append(option);
    }
    host.append(
      el('div', { class: 'view-search__filter-group' }, [el('span', { class: 'view-search__label', text: '类型' }), typeChips]),
      el('div', { class: 'view-search__filter-group' }, [el('span', { class: 'view-search__label', text: '时间' }), presetSelect, customRow]),
      el('div', { class: 'view-search__filter-group' }, [el('span', { class: 'view-search__label', text: '标签' }), tagHost]),
      el('div', { class: 'view-search__filter-group' }, [el('span', { class: 'view-search__label', text: '实体' }), dom.entityInput, entityChips, dom.entitySuggestHost]),
      el('div', { class: 'view-search__filter-group' }, [precisionSelect, includeDeletedWrap]),
    );
    return host;
  }

  function presetToRange(preset) {
    if (!preset || preset === 'all' || preset === 'custom') return { from: null, to: null };
    const now = new Date();
    const to = now.toISOString();
    const from = new Date(now);
    if (preset === 'today') {
      from.setHours(0, 0, 0, 0);
    } else if (preset === 'week') from.setDate(from.getDate() - 7);
    else if (preset === 'month') from.setDate(from.getDate() - 30);
    else if (preset === 'year') from.setDate(from.getDate() - 365);
    return { from: from.toISOString(), to };
  }

  function customRange(filters) {
    return {
      from: filters.from ? new Date(`${filters.from}T00:00:00`).toISOString() : null,
      to: filters.to ? new Date(`${filters.to}T23:59:59.999`).toISOString() : null,
    };
  }

  function addTagName(input) {
    const name = String((input && input.value) || '').trim().replace(/^#/, '');
    if (!name) return;
    if (!state.filters.tagNames.includes(name)) state.filters.tagNames.push(name);
    if (input) input.value = '';
    rerunFilters();
  }

  function rerunFilters() {
    render();
    if (state.searched && state.query.trim()) runSearch();
    else updateStatus();
  }

  function renderEntitySuggestions() {
    const host = dom.entitySuggestHost;
    if (!host) return;
    host.textContent = '';
    if (state.entities.loading) {
      host.append(el('span', { class: 'view-search__muted', text: '查询实体…' }));
      return;
    }
    if (state.entities.error) {
      host.append(el('span', { class: 'view-search__unavailable', text: `实体查询失败：${state.entities.error}` }));
      return;
    }
    for (const entity of state.entities.results.slice(0, 8)) {
      host.append(el('button', {
        type: 'button',
        class: 'view-search__suggestion',
        on: {
          click: () => {
            if (!state.filters.entityIds.includes(entity.id)) {
              state.filters.entityIds.push(entity.id);
              state.filters.entityLabels.push(`${entity.name || entity.id}（${entity.kind || '实体'}）`);
            }
            state.entities.results = [];
            if (dom.entityInput) dom.entityInput.value = '';
            rerunFilters();
          },
        },
      }, [
        el('span', { text: entity.name || entity.id }),
        el('span', { class: 'view-search__muted', text: entity.kind || '' }),
      ]));
    }
  }

  function updateStatus() {
    setStatus();
  }

  function renderResults() {
    const host = dom.resultsHost;
    if (!host) return;
    host.textContent = '';
    if (state.loading) {
      host.append(el('div', { class: 'view-search__loading' }, [el('div', { class: 'view-search__spinner' }), el('div', { text: `正在执行${SEARCH_MODES.find((m) => m.value === state.mode)?.label || ''}搜索…` })]));
      return;
    }
    if (state.error) {
      host.append(el('div', { class: 'view-search__errorbox', role: 'alert', 'data-testid': 'search-error' }, [
        el('div', { class: 'view-search__errorbox-title', text: `搜索失败（${state.error.code}）` }),
        el('div', { class: 'view-search__errorbox-detail', text: `${state.error.message}${state.error.traceId ? ` · trace ${state.error.traceId}` : ''}` }),
        el('div', { class: 'view-search__row-actions' }, [
          button({ label: '重试', icon: 'refresh', variant: 'primary', onClick: () => runSearch() }),
          state.mode !== 'fulltext' ? button({ label: '改用全文检索', icon: 'search', onClick: () => { state.mode = 'fulltext'; render(); runSearch(); } }) : null,
        ]),
        state.mode === 'semantic' || state.mode === 'hybrid'
          ? el('div', { class: 'view-search__muted', text: '语义检索依赖 Runtime 本地向量实现（local-hash-v1）。若 Runtime 版本未实现该能力，会返回明确错误，而不是伪造结果。' })
          : null,
      ]));
      return;
    }
    if (!state.searched) {
      host.append(el('div', { class: 'view-search__empty' }, [
        el('div', { class: 'view-search__empty-title', text: '输入关键词开始检索' }),
        el('div', { class: 'view-search__empty-desc', text: '支持全文、语义与混合模式；结果可一键在星图中定位或打开编辑器。所有结果来自本机 Runtime，无假数据。' }),
        el('div', { class: 'view-search__examples' }, [
          el('span', { class: 'view-search__muted', text: '筛选能力：类型 / 时间 / 人物与项目实体 / 标签 / 时间精度 / 回收站' }),
        ]),
      ]));
      return;
    }
    if (!state.results.length) {
      host.append(el('div', { class: 'view-search__empty', 'data-testid': 'search-empty' }, [
        el('div', { class: 'view-search__empty-title', text: '没有匹配的记忆' }),
        el('div', { class: 'view-search__empty-desc', text: `查询「${state.query}」在${SEARCH_MODES.find((m) => m.value === state.mode)?.label}模式下没有结果。可以尝试切换模式、放宽筛选条件，或确认 Runtime 中已有数据。` }),
        el('div', { class: 'view-search__empty-actions' }, [
          button({ label: '清除筛选', icon: 'close', onClick: () => {
            state.filters = { types: [], tagIds: [], tagNames: [], preset: 'all', from: '', to: '', timeRange: { from: null, to: null }, entityIds: [], entityLabels: [], includeDeleted: false, precisions: [] };
            rerunFilters();
          } }),
          button({ label: '新建记忆', icon: 'plus', variant: 'primary', onClick: () => navigate('editor', {}) }),
        ]),
      ]));
      return;
    }
    host.append(renderStatusHint());
    const list = el('div', { class: 'view-search__list', 'data-testid': 'search-list' });
    for (const item of state.results) {
      list.append(renderResultRow(item));
    }
    host.append(list);
    if (state.nextCursor) {
      host.append(el('div', { class: 'view-search__more' }, [
        button({ label: state.loadingMore ? '加载中…' : '加载更多结果', icon: 'chevron-down', loading: state.loadingMore, testid: 'search-more', onClick: () => loadMore() }),
      ]));
    }
    host.append(el('div', { class: 'view-search__footer', text: `${state.results.length} 条结果${state.total != null ? `（共 ${state.total}）` : ''} · 来源 POST /api/v1/memory/search` }));
  }

  function renderStatusHint() {
    return el('div', { class: 'view-search__status', id: 'search-status-hint' });
  }

  function renderResultRow(item) {
    const memory = item.memory;
    const score = item.score;
    const tagNames = Array.isArray(memory.tag_names) ? memory.tag_names : [];
    const snippet = makeSnippet(memory.body, state.query);
    const serverHighlight = sanitizeHighlightText(item.highlights);
    const row = el('div', {
      class: 'view-search__result',
      'data-testid': `search-result-${memory.id}`,
      role: 'button',
      tabindex: '0',
      on: {
        click: () => showDetail(memory),
        keydown: (event) => {
          if (event.key === 'Enter') showDetail(memory);
        },
      },
    });
    const title = el('div', { class: 'view-search__result-title' });
    title.append(highlightNode(memory.title || '(无标题)', state.query));
    const meta = el('div', { class: 'view-search__result-meta' }, [
      el('span', { class: `view-search__tag view-search__tag--${typeTone(memory.memory_type)}`, text: typeLabelOf(memory.memory_type) }),
      el('span', { class: 'view-search__muted', text: formatTime(memory.occurred_at) }),
      el('span', { class: 'view-search__muted', text: PRECISION_LABEL[memory.occurred_precision] || '未知' }),
      score != null ? el('span', { class: 'view-search__score', text: `得分 ${scoreText(score)}`, title: 'Runtime 返回的相关性得分' }) : null,
      memory.agent_generated ? el('span', { class: 'view-search__tag view-search__tag--violet', text: 'Agent' }) : null,
      memory.deleted_at ? el('span', { class: 'view-search__tag view-search__tag--rose', text: '已删除' }) : null,
    ]);
    const snippetEl = el('div', { class: 'view-search__result-snippet' });
    if (serverHighlight) snippetEl.append(el('span', { class: 'view-search__server-hl', text: serverHighlight }));
    else if (snippet) snippetEl.append(highlightNode(snippet, state.query));
    else snippetEl.append(el('span', { class: 'view-search__muted', text: '（无正文）' }));
    const tagsEl = el('div', { class: 'view-search__result-tags' }, tagNames.slice(0, 6).map((tag) => el('span', { class: 'view-search__tag', text: `#${tag}` })));
    row.append(title, meta, snippetEl, tagsEl);
    const actions = el('div', { class: 'view-search__result-actions' });
    const openBtn = button({ label: '打开编辑器', icon: 'edit', size: 'sm', testid: `search-open-${memory.id}`, onClick: (event) => { event.stopPropagation(); navigate('editor', { id: memory.id }); } });
    const atlasBtn = button({ label: '星图定位', icon: 'compass', size: 'sm', variant: 'ghost', testid: `search-locate-${memory.id}`, onClick: (event) => { event.stopPropagation(); locateInAtlas(memory.id); } });
    actions.append(openBtn, atlasBtn);
    row.append(actions);
    return row;
  }

  function typeTone(type) {
    return {
      working: 'cyan', episodic: 'green', semantic: 'blue', procedural: 'gold',
      autobiographical: 'violet', project: 'cyan', relational: 'rose', emotional: 'rose',
    }[type] || 'neutral';
  }

  function locateInAtlas(memoryId) {
    try {
      // 设置全局选择，再跳转星图（Shell 在 atlas 中读取 selection）
      if (ctx.store && typeof ctx.store.patch === 'function') {
        ctx.store.patch({ selection: { ids: [memoryId], primaryId: memoryId, lastSelectedId: memoryId } });
      }
      if (ctx.events && typeof ctx.events.emit === 'function') {
        ctx.events.emit('selection:change', { ids: [memoryId], primaryId: memoryId });
      }
      navigate('atlas', { select: memoryId });
    } catch (err) {
      notify('error', `定位星图失败：${errInfo(err).message}`);
    }
  }

  async function showDetail(memory) {
    state.detailMemoryId = memory.id;
    try {
      if (ctx.detail && typeof ctx.detail.show === 'function') {
        ctx.detail.show({
          title: memory.title || '(无标题)',
          subtitle: `${typeLabelOf(memory.memory_type)} · ${formatTime(memory.occurred_at)}`,
          content: (host) => {
            const wrap = el('div', { class: 'view-search__detail' });
            const meta = el('div', { class: 'view-search__detail-meta' }, [
              el('div', { text: `ID：${memory.id}` }),
              el('div', { text: `版本：v${memory.version ?? '?'}` }),
              el('div', { text: `可信度：${memory.credibility ?? '—'} · 重要性：${memory.importance ?? '—'} · 权重：${memory.display_weight ?? '—'}` }),
              el('div', { text: `来源：${(memory.source && memory.source.type) || '—'}` }),
              el('div', { text: `标签：${(memory.tag_names || []).join('、') || '—'}` }),
              el('div', { text: `参与人物：${(memory.participants || []).map((p) => p.name || p.entity_id).join('、') || '—'}` }),
              el('div', { text: `项目：${(memory.project && memory.project.name) || '—'}` }),
            ]);
            const body = el('div', { class: 'view-search__detail-body' });
            body.append(highlightNode(String(memory.body || '').slice(0, 4000), state.query));
            wrap.append(meta, el('div', { class: 'view-search__detail-label', text: '正文预览（前 4000 字符）' }), body);
            host.append(wrap);
            return wrap;
          },
          actions: [
            { label: '打开编辑器', variant: 'primary', onClick: () => navigate('editor', { id: memory.id }) },
          ],
        });
      } else {
        navigate('editor', { id: memory.id });
      }
    } catch (err) {
      notify('error', `打开详情失败：${errInfo(err).message}`);
    }
  }

  function renderRelationsResults() {
    const host = dom.resultsHost;
    host.textContent = '';
    const input = el('input', {
      class: 'view-search__input',
      type: 'search',
      placeholder: '按关系类型 / label / evidence / 节点 id 过滤关系（客户端匹配）',
      value: state.relations.query,
      'data-testid': 'search-relation-input',
      on: {
        input: (event) => {
          state.relations.query = event.target.value;
        },
        keydown: (event) => {
          if (event.key === 'Enter') runRelationSearch();
        },
      },
    });
    host.append(el('div', { class: 'view-search__relation-bar' }, [
      input,
      button({ label: '加载关系', icon: 'relation', variant: 'primary', loading: state.relations.loading, testid: 'search-relations-load', onClick: () => runRelationSearch() }),
      el('span', { class: 'view-search__muted', text: 'Runtime 未提供全局关系搜索端点，此处通过 GET /relations 拉取真实关系后在本地匹配。' }),
    ]));
    if (state.relations.loading) {
      host.append(el('div', { class: 'view-search__loading' }, [el('div', { class: 'view-search__spinner' }), el('div', { text: '正在读取关系…' })]));
      return;
    }
    if (state.relations.error) {
      host.append(el('div', { class: 'view-search__errorbox', role: 'alert' }, [
        el('div', { class: 'view-search__errorbox-title', text: '关系检索失败' }),
        el('div', { class: 'view-search__errorbox-detail', text: `${state.relations.error.message}${state.relations.error.traceId ? ` · ${state.relations.error.traceId}` : ''}` }),
        button({ label: '重试', icon: 'refresh', onClick: () => runRelationSearch() }),
      ]));
      return;
    }
    if (!state.relations.searched) {
      host.append(el('div', { class: 'view-search__empty' }, [el('div', { class: 'view-search__empty-title', text: '关系检索' }), el('div', { class: 'view-search__empty-desc', text: '点击「加载关系」从 Runtime 读取关系并匹配。' })]));
      return;
    }
    const list = el('div', { class: 'view-search__list', 'data-testid': 'search-relation-list' });
    if (!state.relations.items.length) {
      host.append(el('div', { class: 'view-search__empty' }, [el('div', { class: 'view-search__empty-title', text: '没有匹配的关系' }), el('div', { class: 'view-search__empty-desc', text: '可清空过滤词后重试。' })]));
      return;
    }
    for (const rel of state.relations.items.slice(0, 200)) {
      list.append(el('div', { class: 'view-search__result' }, [
        el('div', { class: 'view-search__result-title', text: `${rel.relation_type || '关系'}${rel.label ? ` · ${rel.label}` : ''}` }),
        el('div', { class: 'view-search__result-meta' }, [
          el('span', { class: 'view-search__muted', text: `${nodeText(rel.from)} → ${nodeText(rel.to)}` }),
          el('span', { class: 'view-search__muted', text: `置信度 ${rel.confidence ?? '—'}` }),
        ]),
        rel.evidence ? el('div', { class: 'view-search__result-snippet', text: `evidence：${rel.evidence}` }) : null,
        el('div', { class: 'view-search__result-actions' }, [
          button({ label: '在关系中打开', icon: 'relation', size: 'sm', onClick: () => navigate('relations', { relation_id: rel.id, node_id: (rel.from && rel.from.id) || '', node_kind: (rel.from && rel.from.kind) || '' }) }),
        ]),
      ]));
    }
    host.append(list);
    host.append(el('div', { class: 'view-search__footer', text: `${state.relations.items.length} 条关系 · 来源 GET /api/v1/relations` }));
  }

  function nodeText(node) {
    if (!node) return '?';
    const kind = node.kind === 'entity' ? '实体' : '记忆';
    return `${kind} ${String(node.id || '').split('_')[0]}_${String(node.id || '').slice(-6)}`;
  }

  function renderVersionsNotice() {
    const host = dom.resultsHost;
    host.textContent = '';
    host.append(el('div', { class: 'view-search__empty', 'data-testid': 'search-versions-notice' }, [
      el('div', { class: 'view-search__empty-title', text: '历史版本搜索暂不可用' }),
      el('div', { class: 'view-search__empty-desc', text: 'Runtime Alpha 0.1 的冻结 API 只提供 GET /memory/{id}/versions 与 /diff（按记忆读取），没有跨记忆的历史版本搜索端点。本视图不会伪造版本搜索结果。' }),
      el('div', { class: 'view-search__empty-actions' }, [
        button({ label: '打开记忆「' + (state.query ? state.query.slice(0, 12) : '…') + '」的版本历史', icon: 'history', onClick: () => {
          if (!state.results.length) {
            notify('info', '先搜索并打开一条记忆，再在编辑器右侧查看版本历史');
            return;
          }
          navigate('editor', { id: state.results[0].memory.id });
        } }),
      ]),
      el('div', { class: 'view-search__muted', text: '可替代路径：在编辑器 → 版本历史中查看单个记忆的全部版本与 diff。' }),
    ]));
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  function unmount() {
    clearTimeout(searchTimer);
    clearTimeout(entityTimer);
    try {
      if (ctx.status) ctx.status.remove('search.state');
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
    dom.resultsHost = null;
    dom.filterHost = null;
  }

  function activate() {
    const params = getParams();
    const q = params.get ? params.get('q') : null;
    if (q && q !== state.query) {
      state.query = q;
      render();
      runSearch();
    }
  }

  function handleCommand(command) {
    if (command === 'view:refresh') {
      if (state.tab === 'relations') runRelationSearch();
      else if (state.query.trim()) runSearch();
      return true;
    }
    return false;
  }

  function getSnapshot() {
    return { query: state.query, mode: state.mode, tab: state.tab, filters: state.filters };
  }

  return { mount, unmount, activate, handleCommand, getSnapshot };
}

/* ============================================================================
 * 样式
 * ========================================================================== */

const SEARCH_CSS = `
.view-search { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--fca-bg-1); color:var(--fca-text); font-family:var(--fca-font-ui); font-size:var(--fca-text-md); }
.view-search__bar { display:flex; flex-direction:column; gap:var(--fca-space-2); padding:var(--fca-space-3) var(--fca-space-4); border-bottom:1px solid var(--fca-border); background:var(--fca-bg-2); }
.view-search__bar-main { display:flex; align-items:center; gap:var(--fca-space-2); }
.view-search__input { flex:1; background:var(--fca-bg-3); border:1px solid var(--fca-border); border-radius:var(--fca-radius); color:var(--fca-text); font:inherit; font-size:var(--fca-text-lg); height:36px; padding:0 var(--fca-space-3); outline:none; box-sizing:border-box; }
.view-search__input:focus { border-color:var(--fca-accent); box-shadow:0 0 0 2px var(--fca-accent-soft); }
.view-search__input--date { flex:0 0 140px; height:28px; font-size:var(--fca-text-sm); }
.view-search__input--entity { flex:0 0 220px; height:28px; font-size:var(--fca-text-sm); }
.view-search__input--tag { flex:0 0 150px; height:28px; font-size:var(--fca-text-sm); }
.view-search__modes { display:flex; gap:2px; background:var(--fca-bg-3); border:1px solid var(--fca-border); border-radius:var(--fca-radius); padding:2px; align-self:flex-start; }
.view-search__mode { border:none; background:transparent; color:var(--fca-text-dim); font:inherit; font-size:var(--fca-text-sm); padding:3px var(--fca-space-3); border-radius:var(--fca-radius-sm); cursor:pointer; }
.view-search__mode:hover { color:var(--fca-text); }
.view-search__mode.is-active { background:var(--fca-bg-1); color:var(--fca-accent-strong); box-shadow:inset 0 0 0 1px var(--fca-border-strong); }
.view-search__btn { display:inline-flex; align-items:center; gap:5px; height:30px; padding:0 var(--fca-space-3); border-radius:var(--fca-radius-sm); border:1px solid var(--fca-border); background:var(--fca-bg-3); color:var(--fca-text); font:inherit; font-size:var(--fca-text-sm); cursor:pointer; white-space:nowrap; }
.view-search__btn:hover { background:var(--fca-bg-4); }
.view-search__btn:disabled { opacity:.45; cursor:not-allowed; }
.view-search__btn--primary { background:var(--fca-accent-soft); border-color:var(--fca-accent); color:var(--fca-accent-strong); }
.view-search__btn--ghost { background:transparent; border-color:transparent; color:var(--fca-text-dim); }
.view-search__btn--ghost:hover { background:var(--fca-bg-3); color:var(--fca-text); }
.view-search__btn--sm { height:24px; padding:0 var(--fca-space-2); font-size:var(--fca-text-xs); }
.view-search__tabs { display:flex; align-items:center; gap:2px; padding:0 var(--fca-space-4); border-bottom:1px solid var(--fca-border); background:var(--fca-bg-1); }
.view-search__tab { border:none; background:transparent; color:var(--fca-text-muted); font:inherit; font-size:var(--fca-text-sm); padding:var(--fca-space-2) var(--fca-space-3); border-bottom:2px solid transparent; cursor:pointer; }
.view-search__tab:hover { color:var(--fca-text); }
.view-search__tab.is-active { color:var(--fca-accent-strong); border-bottom-color:var(--fca-accent); }
.view-search__hint { margin-left:auto; font-size:var(--fca-text-xs); color:var(--fca-text-muted); font-family:var(--fca-font-mono); }
.view-search__filters { display:flex; flex-direction:column; gap:var(--fca-space-1); padding:var(--fca-space-2) var(--fca-space-4); border-bottom:1px solid var(--fca-border); background:var(--fca-bg-1); }
.view-search__filter-group { display:flex; align-items:center; gap:var(--fca-space-2); flex-wrap:wrap; min-height:28px; }
.view-search__label { font-size:var(--fca-text-xs); color:var(--fca-text-muted); flex:0 0 28px; }
.view-search__chips { display:flex; gap:3px; flex-wrap:wrap; align-items:center; }
.view-search__chip { display:inline-flex; align-items:center; gap:2px; border:1px solid var(--fca-border); background:var(--fca-bg-2); color:var(--fca-text-muted); font:inherit; font-size:var(--fca-text-xs); border-radius:999px; padding:2px var(--fca-space-2); cursor:pointer; }
.view-search__chip:hover { color:var(--fca-text); border-color:var(--fca-border-strong); }
.view-search__chip.is-active { background:var(--fca-accent-soft); border-color:var(--fca-accent); color:var(--fca-accent-strong); }
.view-search__chip-x { border:none; background:transparent; color:var(--fca-text-muted); cursor:pointer; padding:0 2px; font-size:var(--fca-text-sm); }
.view-search__chip-x:hover { color:var(--fca-danger); }
.view-search__select { background:var(--fca-bg-3); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); color:var(--fca-text); font:inherit; font-size:var(--fca-text-sm); height:28px; padding:0 var(--fca-space-1); outline:none; }
.view-search__inline { display:flex; align-items:center; gap:var(--fca-space-1); flex-wrap:wrap; }
.view-search__unavailable { font-size:var(--fca-text-xs); color:var(--fca-gold); border:1px dashed color-mix(in srgb, var(--fca-gold) 45%, transparent); border-radius:var(--fca-radius-sm); padding:1px var(--fca-space-2); }
.view-search__check { display:inline-flex; align-items:center; gap:var(--fca-space-1); font-size:var(--fca-text-xs); color:var(--fca-text-dim); cursor:pointer; }
.view-search__check input { accent-color:var(--fca-accent); }
.view-search__suggestions { display:flex; gap:3px; flex-wrap:wrap; }
.view-search__suggestion { border:1px solid var(--fca-border); background:var(--fca-bg-3); color:var(--fca-text-dim); border-radius:var(--fca-radius-sm); padding:2px var(--fca-space-2); font:inherit; font-size:var(--fca-text-xs); cursor:pointer; display:inline-flex; gap:5px; }
.view-search__suggestion:hover { border-color:var(--fca-accent); color:var(--fca-text); }
.view-search__results { flex:1; overflow-y:auto; min-height:0; padding:var(--fca-space-2) var(--fca-space-4) var(--fca-space-5); }
.view-search__loading { display:flex; flex-direction:column; align-items:center; gap:var(--fca-space-3); padding:var(--fca-space-6); color:var(--fca-text-dim); }
.view-search__spinner { width:22px;height:22px;border-radius:50%;border:2px solid var(--fca-border-strong);border-top-color:var(--fca-accent);animation:view-search-spin .8s linear infinite; }
@keyframes view-search-spin { to { transform:rotate(360deg); } }
.view-search__empty { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:var(--fca-space-2); padding:var(--fca-space-6); text-align:center; min-height:300px; }
.view-search__empty-title { font-size:var(--fca-text-lg); }
.view-search__empty-desc { color:var(--fca-text-muted); font-size:var(--fca-text-sm); max-width:560px; line-height:1.7; }
.view-search__empty-actions { display:flex; gap:var(--fca-space-2); margin-top:var(--fca-space-2); }
.view-search__examples { margin-top:var(--fca-space-2); }
.view-search__muted { color:var(--fca-text-muted); font-size:var(--fca-text-xs); }
.view-search__list { display:flex; flex-direction:column; gap:var(--fca-space-1); }
.view-search__result { position:relative; padding:var(--fca-space-2) var(--fca-space-3); border:1px solid var(--fca-border); border-radius:var(--fca-radius); background:var(--fca-bg-2); cursor:pointer; display:flex; flex-direction:column; gap:3px; }
.view-search__result:hover { border-color:var(--fca-border-strong); background:var(--fca-bg-3); }
.view-search__result-title { font-size:var(--fca-text-md); font-weight:600; color:var(--fca-text); padding-right:150px; }
.view-search__result-meta { display:flex; align-items:center; gap:var(--fca-space-2); flex-wrap:wrap; }
.view-search__result-snippet { font-size:var(--fca-text-sm); color:var(--fca-text-dim); line-height:1.6; }
.view-search__result-tags { display:flex; gap:3px; flex-wrap:wrap; }
.view-search__result-actions { position:absolute; top:var(--fca-space-2); right:var(--fca-space-2); display:flex; gap:4px; }
.view-search__mark { background:color-mix(in srgb, var(--fca-gold) 30%, transparent); color:var(--fca-gold); border-radius:2px; padding:0 1px; }
.view-search__server-hl { color:var(--fca-text-dim); }
.view-search__tag { display:inline-flex; font-size:10px; line-height:16px; padding:0 5px; border-radius:999px; border:1px solid var(--fca-border-strong); color:var(--fca-text-muted); }
.view-search__tag--cyan { color:var(--fca-accent); }
.view-search__tag--green { color:var(--fca-green); }
.view-search__tag--blue { color:var(--fca-accent-strong); }
.view-search__tag--violet { color:var(--fca-violet); }
.view-search__tag--rose { color:var(--fca-rose); }
.view-search__tag--gold { color:var(--fca-gold); }
.view-search__tag--neutral { color:var(--fca-text-muted); }
.view-search__score { font-size:var(--fca-text-xs); color:var(--fca-accent); font-family:var(--fca-font-mono); }
.view-search__status { height:0; }
.view-search__more { display:flex; justify-content:center; padding:var(--fca-space-3); }
.view-search__footer { padding-top:var(--fca-space-2); font-size:var(--fca-text-xs); color:var(--fca-text-muted); font-family:var(--fca-font-mono); }
.view-search__errorbox { margin:var(--fca-space-4) auto; padding:var(--fca-space-4); border:1px solid color-mix(in srgb, var(--fca-danger) 50%, var(--fca-border)); background:color-mix(in srgb, var(--fca-danger) 8%, var(--fca-bg-2)); border-radius:var(--fca-radius); display:flex; flex-direction:column; gap:var(--fca-space-2); max-width:640px; }
.view-search__errorbox-title { color:var(--fca-danger); font-weight:600; }
.view-search__errorbox-detail { color:var(--fca-text-dim); font-size:var(--fca-text-sm); }
.view-search__row-actions { display:flex; gap:var(--fca-space-2); flex-wrap:wrap; }
.view-search__relation-bar { display:flex; align-items:center; gap:var(--fca-space-2); flex-wrap:wrap; padding:var(--fca-space-2) 0; }
.view-search__relation-bar .view-search__input { height:28px; font-size:var(--fca-text-sm); flex:0 1 360px; }
.view-search__detail { display:flex; flex-direction:column; gap:var(--fca-space-2); font-size:var(--fca-text-sm); }
.view-search__detail-meta { display:flex; flex-direction:column; gap:2px; color:var(--fca-text-muted); font-size:var(--fca-text-xs); }
.view-search__detail-label { color:var(--fca-text-dim); font-size:var(--fca-text-xs); margin-top:var(--fca-space-2); }
.view-search__detail-body { line-height:1.7; color:var(--fca-text); white-space:pre-wrap; word-break:break-word; max-height:320px; overflow:auto; background:var(--fca-bg-1); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); padding:var(--fca-space-2); }
`;
