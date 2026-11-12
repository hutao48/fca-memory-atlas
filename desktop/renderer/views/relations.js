/**
 * FCA Memory Atlas — 关系编辑器视图（Desktop Editor 组，Alpha 0.1）
 *
 * 契约：desktop/renderer/lib/contracts.md v1.0 §2/§3/§4/§6
 * 职责：
 *  - 关系列表 / 筛选（节点、关系类型、回收站）
 *  - 创建 / 编辑 / 删除关系（from/to 支持 memory 与 entity 节点；relation_type 全枚举 + custom label；
 *    evidence 必填提示（causal 强制）；confidence / source / directed / weight）
 *  - 从某节点出发浏览关系（支持星图/详情页传入的 selection）
 *  - 删除关系不删除两端对象（UI 明确提示）
 *  - 关系类型图例（颜色与星云层映射一致）
 *  - 真实 Runtime API；错误/空态显式展示；无假数据
 */

export const meta = {
  id: 'relations',
  title: '关系探索',
  icon: 'relation',
  order: 30,
  nav: true,
  shortcut: 'g r',
};

export const RELATION_TYPES = [
  { value: 'temporal_before', label: '先于', hint: 'A 发生在 B 之前', color: 'gold', dash: 'solid' },
  { value: 'temporal_after', label: '后于', hint: 'A 发生在 B 之后', color: 'gold', dash: 'dashed' },
  { value: 'participates_in', label: '参与', hint: '人物/实体参与记忆或项目', color: 'cyan', dash: 'solid' },
  { value: 'shared_experience', label: '共同经历', hint: '共享同一段经历', color: 'violet', dash: 'solid' },
  { value: 'knowledge_link', label: '知识关联', hint: '概念/知识之间', color: 'accent', dash: 'solid' },
  { value: 'causal', label: '因果', hint: 'A 导致 B（需 evidence）', color: 'rose', dash: 'solid' },
  { value: 'derived_from', label: '派生自', hint: '由另一条记忆/概念派生', color: 'magenta', dash: 'dashed' },
  { value: 'belongs_to_project', label: '属于项目', hint: '记忆/实体归属项目', color: 'green', dash: 'solid' },
  { value: 'emotional_link', label: '情绪关联', hint: '情绪上相关', color: 'rose', dash: 'dashed' },
  { value: 'custom', label: '自定义', hint: '需填写 label 与说明', color: 'neutral', dash: 'dashed' },
];

export const RELATION_SOURCE_TYPES = [
  { value: 'user', label: '用户建立' },
  { value: 'agent', label: 'Agent 建立' },
  { value: 'system', label: '系统生成' },
  { value: 'external', label: '外部来源' },
  { value: 'inference', label: '模型推断' },
  { value: 'import', label: '导入' },
];

const RELATION_TYPE_MAP = RELATION_TYPES.reduce((acc, item) => {
  acc[item.value] = item;
  return acc;
}, {});

const SOURCE_LABEL = RELATION_SOURCE_TYPES.reduce((acc, item) => {
  acc[item.value] = item.label;
  return acc;
}, {});

/* ============================================================================
 * 纯函数（单测覆盖）
 * ========================================================================== */

export function relationTypeMeta(value) {
  return RELATION_TYPE_MAP[value] || { value: value || 'custom', label: value || '未知类型', color: 'neutral', dash: 'dashed' };
}

export function relationTypeLabel(value) {
  return relationTypeMeta(value).label;
}

export function normalizeRelationList(response) {
  if (Array.isArray(response)) return response;
  if (!response || typeof response !== 'object') return [];
  for (const key of ['items', 'relations', 'results', 'data']) {
    if (Array.isArray(response[key])) return response[key];
  }
  return [];
}

/** 过滤关系（纯函数） */
export function filterRelations(relations, filters = {}) {
  const list = Array.isArray(relations) ? relations : [];
  const nodeId = filters.nodeId || null;
  const nodeKind = filters.nodeKind || null;
  const type = filters.relationType || null;
  const includeDeleted = Boolean(filters.includeDeleted);
  return list.filter((rel) => {
    if (!rel) return false;
    if (!includeDeleted && rel.deleted_at) return false;
    if (type && rel.relation_type !== type) return false;
    if (nodeId) {
      const fromHit = rel.from && rel.from.id === nodeId && (!nodeKind || rel.from.kind === nodeKind);
      const toHit = rel.to && rel.to.id === nodeId && (!nodeKind || rel.to.kind === nodeKind);
      if (!fromHit && !toHit) return false;
    }
    return true;
  });
}

/** 关系的另一侧节点 */
export function otherNode(relation, nodeId) {
  if (!relation) return null;
  if (relation.from && relation.from.id === nodeId) return relation.to || null;
  if (relation.to && relation.to.id === nodeId) return relation.from || null;
  return null;
}

/** 节点完整名称（无法解析时返回 id，绝不虚构名称） */
export function nodeDisplay(node, index) {
  if (!node || !node.id) return { id: null, kind: null, label: '—', resolved: false };
  const kindLabel = node.kind === 'entity' ? '实体' : node.kind === 'memory' ? '记忆' : node.kind || '节点';
  const looked = index && typeof index.get === 'function' ? index.get(node.id) : null;
  const label = looked || node.label || node.name || null;
  return {
    id: node.id,
    kind: node.kind || null,
    label: label || `${kindLabel} ${shortId(node.id)}`,
    resolved: Boolean(label),
  };
}

export function shortId(id) {
  if (!id) return '—';
  const text = String(id);
  const parts = text.split('_');
  if (parts.length > 1) return `${parts[0]}_…${parts[1].slice(-6)}`;
  return text.length > 12 ? `${text.slice(0, 12)}…` : text;
}

/** 表单校验（纯函数）：返回 { ok, errors, order } */
export function validateRelationDraft(draft) {
  const errors = {};
  const order = [];
  const fail = (field, message) => {
    if (!errors[field]) {
      errors[field] = message;
      order.push(field);
    }
  };
  if (!draft || !draft.from || !draft.from.id) fail('from', '请选择起点节点');
  if (!draft || !draft.to || !draft.to.id) fail('to', '请选择终点节点');
  if (draft && draft.from && draft.to && draft.from.id === draft.to.id && draft.from.kind === draft.to.kind) {
    fail('to', '起点与终点不能是同一个节点');
  }
  if (!RELATION_TYPES.some((t) => t.value === draft?.relation_type)) fail('relation_type', '关系类型不可识别');
  if (draft?.relation_type === 'custom' && !String(draft?.label || '').trim()) fail('label', '自定义关系必须填写 label');
  if (draft?.relation_type === 'causal' && !String(draft?.evidence || '').trim()) {
    fail('evidence', '因果关系必须填写 evidence（因果依据）');
  }
  const confidence = Number(draft?.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) fail('confidence', '置信度必须在 0 至 1 之间');
  const weight = Number(draft?.weight);
  if (!Number.isFinite(weight) || weight < 0 || weight > 2) fail('weight', '权重必须在 0 至 2 之间');
  if (String(draft?.label || '').length > 120) fail('label', 'label 不能超过 120 字符');
  if (String(draft?.evidence || '').length > 2000) fail('evidence', 'evidence 不能超过 2000 字符');
  if (!RELATION_SOURCE_TYPES.some((t) => t.value === draft?.source_type)) fail('source_type', '来源类型不可识别');
  return { ok: order.length === 0, errors, order };
}

/** 表单草稿 → API payload（纯函数） */
export function buildRelationPayload(draft) {
  return {
    from: { kind: draft.from.kind, id: draft.from.id },
    to: { kind: draft.to.kind, id: draft.to.id },
    relation_type: draft.relation_type,
    directed: draft.directed !== false,
    label: String(draft.label || '').trim() || null,
    evidence: String(draft.evidence || '').trim() || null,
    confidence: Number(draft.confidence),
    source: {
      type: draft.source_type || 'user',
      ref: String(draft.source_ref || '').trim() || null,
      note: String(draft.source_note || '').trim() || null,
    },
    weight: Number(draft.weight),
  };
}

export function createEmptyRelationDraft() {
  return {
    from: null,
    to: null,
    relation_type: 'participates_in',
    directed: true,
    label: '',
    evidence: '',
    confidence: 0.8,
    weight: 1,
    source_type: 'user',
    source_ref: '',
    source_note: '',
  };
}

export function relationDraftFromRelation(relation) {
  const draft = createEmptyRelationDraft();
  if (!relation) return draft;
  draft.from = relation.from ? { kind: relation.from.kind, id: relation.from.id } : null;
  draft.to = relation.to ? { kind: relation.to.kind, id: relation.to.id } : null;
  draft.relation_type = relation.relation_type || 'custom';
  draft.directed = relation.directed !== false;
  draft.label = relation.label || '';
  draft.evidence = relation.evidence || '';
  draft.confidence = Number.isFinite(relation.confidence) ? relation.confidence : 0.8;
  draft.weight = Number.isFinite(relation.weight) ? relation.weight : 1;
  draft.source_type = (relation.source && relation.source.type) || 'user';
  draft.source_ref = (relation.source && relation.source.ref) || '';
  draft.source_note = (relation.source && relation.source.note) || '';
  return draft;
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
  let reloadTimer = null;

  const state = {
    loading: false,
    loadError: null,
    relations: [],
    filtered: [],
    filters: { nodeId: null, nodeKind: null, nodeLabel: null, relationType: '', includeDeleted: false },
    nodeIndex: new Map(),
    nodeIndexLoading: false,
    nodeIndexError: null,
    total: 0,
    nodePicker: { kind: 'memory', query: '', results: [], loading: false, error: null },
    dialog: null,
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
      class: `view-rel__btn view-rel__btn--${opts.variant || 'secondary'}${opts.size === 'sm' ? ' view-rel__btn--sm' : ''}`,
      disabled: Boolean(opts.disabled || opts.loading),
      title: opts.title || '',
      'data-testid': opts.testid || null,
      on: { click: (event) => opts.onClick && opts.onClick(event) },
    }, [opts.icon ? icon(opts.icon) : null, opts.label ? el('span', { text: opts.label }) : null]);
  }

  function formatTime(iso) {
    if (!iso) return '—';
    try {
      if (ctx.format && typeof ctx.format.datetime === 'function') return ctx.format.datetime(iso);
    } catch {
      /* noop */
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
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

  /* ------------------------------ 数据加载 ------------------------------ */

  async function loadRelations() {
    state.loading = true;
    state.loadError = null;
    render();
    try {
      const params = { include_deleted: Boolean(state.filters.includeDeleted) };
      if (state.filters.nodeId) {
        params.node_kind = state.filters.nodeKind || undefined;
        params.node_id = state.filters.nodeId;
      }
      const res = await api.listRelations(params);
      state.relations = normalizeRelationList(res);
      state.total = Number.isFinite(res && res.total) ? res.total : state.relations.length;
      state.loading = false;
      applyFilters();
      ensureNodeIndex();
    } catch (err) {
      state.loading = false;
      state.loadError = errInfo(err);
      render();
    }
  }

  function applyFilters() {
    state.filtered = filterRelations(state.relations, state.filters);
    renderList();
    updateHeaderCount();
    updateStatus();
  }

  function updateHeaderCount() {
    if (!root) return;
    const node = root.querySelector('[data-testid="relations-count"]');
    if (node) node.textContent = state.loading ? '读取中…' : `${state.filtered.length} / ${state.relations.length} 条`;
  }

  async function ensureNodeIndex() {
    if (state.nodeIndex.size || state.nodeIndexLoading) return;
    state.nodeIndexLoading = true;
    const index = new Map();
    try {
      if (typeof api.getGraph === 'function') {
        try {
          const graph = await api.getGraph();
          const data = graph && graph.nodes ? graph : null;
          if (data) {
            for (const node of data.nodes) {
              if (node && node.id) index.set(node.id, node.label || node.title || null);
            }
          }
        } catch {
          /* graph 不可用时仅显示 id */
        }
      }
      try {
        const res = await api.listEntities({ limit: 500 });
        const items = Array.isArray(res) ? res : (res && (res.items || res.entities || res.data)) || [];
        for (const entity of items) {
          if (entity && entity.id) index.set(entity.id, entity.name || null);
        }
      } catch {
        /* entities 不可用时仅显示 id */
      }
      state.nodeIndex = index;
      state.nodeIndexLoading = false;
      renderList();
    } catch (err) {
      state.nodeIndexLoading = false;
      state.nodeIndexError = errInfo(err);
      renderList();
    }
  }

  function labelFor(node) {
    const display = nodeDisplay(node, state.nodeIndex);
    return display.label;
  }

  /* -------------------------------- 渲染 -------------------------------- */

  function mount(container) {
    styleEl = doc.createElement('style');
    styleEl.id = 'view-rel-style';
    styleEl.textContent = REL_CSS;
    doc.head.append(styleEl);
    root = el('div', { class: 'view-rel', 'data-testid': 'view-relations' });
    container.append(root);

    const params = getParams();
    const nodeId = params.get ? params.get('node_id') : null;
    const nodeKind = params.get ? params.get('node_kind') : null;
    if (nodeId) {
      state.filters.nodeId = nodeId;
      state.filters.nodeKind = nodeKind || null;
    } else {
      // 星图/详情面板当前选择（若存在）
      try {
        const storeState = ctx.store && typeof ctx.store.getState === 'function' ? ctx.store.getState() : null;
        const selected = storeState && storeState.selection && storeState.selection.primaryId;
        if (selected) {
          state.filters.nodeId = selected;
          const graphNode = storeState.graph && storeState.graph.data && Array.isArray(storeState.graph.data.nodes)
            ? storeState.graph.data.nodes.find((n) => n.id === selected) : null;
          state.filters.nodeKind = graphNode && graphNode.kind === 'entity' ? 'entity' : 'memory';
          state.filters.nodeLabel = graphNode ? graphNode.label : null;
        }
      } catch {
        /* noop */
      }
    }
    render();
    loadRelations();
    subscribeMany(
      ['sse:relation.created', 'sse:relation.updated', 'sse:relation.deleted', 'sse:entity.created', 'sse:memory.created', 'sse:memory.updated', 'api:resync'],
      () => scheduleReload(),
    );
    disposers.push(() => clearTimeout(reloadTimer));
  }

  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (state.dialog) return;
      loadRelations();
    }, 400);
  }

  function render() {
    if (!root) return;
    root.textContent = '';
    root.append(renderHeader());
    if (state.loadError) {
      root.append(el('div', { class: 'view-rel__errorbox', role: 'alert' }, [
        el('div', { class: 'view-rel__errorbox-title', text: '无法读取关系' }),
        el('div', { class: 'view-rel__errorbox-detail', text: `${state.loadError.message}${state.loadError.traceId ? ` · trace ${state.loadError.traceId}` : ''}` }),
        el('div', { class: 'view-rel__inline' }, [
          button({ label: '重试', icon: 'refresh', variant: 'primary', onClick: () => loadRelations() }),
          button({ label: '新建关系', icon: 'plus', onClick: () => openCreateDialog() }),
        ]),
      ]));
      return;
    }
    root.append(renderFilterBar());
    root.append(renderNodeContext());
    const body = el('div', { class: 'view-rel__body' });
    dom.bodyHost = body;
    root.append(body);
    root.append(renderLegend());
    renderList();
  }

  function renderHeader() {
    return el('div', { class: 'view-rel__bar' }, [
      el('div', { class: 'view-rel__title' }, [
        el('h2', { text: '关系探索' }),
        el('span', { class: 'view-rel__count', 'data-testid': 'relations-count', text: state.loading ? '读取中…' : `${state.filtered.length} / ${state.relations.length} 条` }),
      ]),
      el('div', { class: 'view-rel__actions' }, [
        button({ label: '刷新', icon: 'refresh', variant: 'ghost', testid: 'relations-refresh', loading: state.loading, onClick: () => loadRelations() }),
        button({ label: '新建关系', icon: 'plus', variant: 'primary', testid: 'relations-new', onClick: () => openCreateDialog() }),
      ]),
    ]);
  }

  function renderFilterBar() {
    const typeSelect = el('select', {
      class: 'view-rel__select',
      'data-testid': 'relations-type-filter',
      'aria-label': '关系类型筛选',
      on: {
        change: (event) => {
          state.filters.relationType = event.target.value;
          applyFilters();
        },
      },
    });
    typeSelect.append(el('option', { value: '', text: '全部关系类型' }));
    for (const type of RELATION_TYPES) {
      const option = el('option', { value: type.value, text: `${type.label} · ${type.value}` });
      if (type.value === state.filters.relationType) option.selected = true;
      typeSelect.append(option);
    }
    const includeDeleted = el('label', { class: 'view-rel__check' }, [
      el('input', {
        type: 'checkbox',
        checked: state.filters.includeDeleted,
        'data-testid': 'relations-include-deleted',
        on: {
          change: (event) => {
            state.filters.includeDeleted = event.target.checked;
            loadRelations();
          },
        },
      }),
      el('span', { text: '包含已删除关系' }),
    ]);
    const nodePick = el('div', { class: 'view-rel__inline' }, [
      button({ label: '选择节点浏览', icon: 'filter', size: 'sm', testid: 'relations-pick-node', onClick: () => openNodePicker() }),
      el('span', { class: 'view-rel__muted', text: '或在星图/详情面板选中记忆后进入本视图' }),
    ]);
    return el('div', { class: 'view-rel__filters' }, [
      typeSelect,
      includeDeleted,
      nodePick,
      el('span', { class: 'view-rel__muted', text: '删除关系只删除关系本身，不删除两端记忆或实体。' }),
    ]);
  }

  function renderNodeContext() {
    if (!state.filters.nodeId) return el('div', { class: 'view-rel__hint view-rel__hint--empty' });
    const label = state.filters.nodeLabel || (state.nodeIndex.get(state.filters.nodeId) || state.filters.nodeId);
    return el('div', { class: 'view-rel__context', 'data-testid': 'relations-node-context' }, [
      el('span', { class: 'view-rel__label', text: '当前节点：' }),
      el('span', { class: 'view-rel__context-label', text: label }),
      el('span', { class: 'view-rel__muted view-rel__mono', text: `${state.filters.nodeKind || 'memory'} · ${state.filters.nodeId}` }),
      button({
        label: '清除节点筛选',
        variant: 'ghost',
        size: 'sm',
        onClick: () => {
          state.filters.nodeId = null;
          state.filters.nodeKind = null;
          state.filters.nodeLabel = null;
          loadRelations();
        },
      }),
      state.filters.nodeId && state.filters.nodeKind === 'memory'
        ? button({ label: '打开记忆编辑器', icon: 'edit', size: 'sm', onClick: () => navigate('editor', { id: state.filters.nodeId }) })
        : null,
    ]);
  }

  function renderList() {
    const host = dom.bodyHost;
    if (!host) return;
    host.textContent = '';
    if (state.loading) {
      host.append(el('div', { class: 'view-rel__loading' }, [el('div', { class: 'view-rel__spinner' }), el('div', { text: '正在读取关系…' })]));
      return;
    }
    if (!state.filtered.length) {
      host.append(el('div', { class: 'view-rel__empty', 'data-testid': 'relations-empty' }, [
        el('div', { class: 'view-rel__empty-title', text: state.relations.length ? '当前筛选下没有关系' : '还没有关系' }),
        el('div', { class: 'view-rel__empty-desc', text: state.relations.length ? '尝试切换关系类型或清除节点筛选。' : '可以从某个记忆/实体出发创建关系；关系与记忆分离存储，互不覆盖。' }),
        el('div', { class: 'view-rel__empty-actions' }, [
          button({ label: '新建关系', icon: 'plus', variant: 'primary', onClick: () => openCreateDialog() }),
          state.filters.nodeId ? button({ label: '清除筛选', icon: 'close', onClick: () => { state.filters.nodeId = null; state.filters.nodeKind = null; state.filters.nodeLabel = null; loadRelations(); } }) : null,
        ]),
      ]));
      return;
    }
    const list = el('div', { class: 'view-rel__list', 'data-testid': 'relations-list', role: 'list' });
    for (const relation of state.filtered) list.append(renderRelationRow(relation));
    host.append(list);
    host.append(el('div', { class: 'view-rel__footer', text: `${state.filtered.length} 条关系 · 来源 GET /api/v1/relations${state.total && state.total !== state.relations.length ? `（Runtime 报告总数 ${state.total}）` : ''}` }));
  }

  function renderRelationRow(relation) {
    const meta = relationTypeMeta(relation.relation_type);
    const row = el('div', { class: `view-rel__row view-rel__row--${meta.color}${relation.deleted_at ? ' is-deleted' : ''}`, role: 'listitem', 'data-testid': `relation-row-${relation.id}` });
    const left = el('div', { class: 'view-rel__row-main' }, [
      el('div', { class: 'view-rel__row-head' }, [
        el('span', { class: `view-rel__type view-rel__type--${meta.color}`, text: meta.label }),
        el('span', { class: 'view-rel__mono view-rel__muted', text: relation.id }),
        relation.deleted_at ? el('span', { class: 'view-rel__tag view-rel__tag--rose', text: '已删除' }) : null,
        el('span', { class: 'view-rel__tag', text: relation.directed === false ? '无向' : '有向' }),
        el('span', { class: 'view-rel__tag', text: `置信 ${relation.confidence ?? '—'}` }),
        el('span', { class: 'view-rel__tag', text: `权重 ${relation.weight ?? '—'}` }),
        el('span', { class: 'view-rel__muted', text: `来源 ${SOURCE_LABEL[(relation.source && relation.source.type) || 'user'] || '—'}` }),
      ]),
      el('div', { class: 'view-rel__nodes' }, [
        renderNodeChip(relation.from, relation.relation_type),
        el('span', { class: 'view-rel__arrow', text: relation.directed === false ? '↔' : '→' }),
        renderNodeChip(relation.to, relation.relation_type),
        relation.label ? el('span', { class: 'view-rel__label-chip', text: relation.label }) : null,
      ]),
      relation.evidence ? el('div', { class: 'view-rel__evidence' }, [el('span', { class: 'view-rel__muted', text: 'evidence：' }), el('span', { text: relation.evidence })]) : null,
    ]);
    const actions = el('div', { class: 'view-rel__row-actions' }, [
      button({ label: '查看', icon: 'eye', size: 'sm', variant: 'ghost', onClick: () => showRelationDetail(relation) }),
      relation.deleted_at
        ? null
        : button({ label: '编辑', icon: 'edit', size: 'sm', onClick: () => openEditDialog(relation) }),
      relation.deleted_at
        ? null
        : button({ label: '删除', icon: 'trash', size: 'sm', variant: 'danger', testid: `relation-delete-${relation.id}`, onClick: () => deleteRelation(relation) }),
    ]);
    row.append(left, actions);
    row.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      showRelationDetail(relation);
    });
    return row;
  }

  function renderNodeChip(node, relationType) {
    const display = nodeDisplay(node, state.nodeIndex);
    const kind = node && node.kind === 'entity' ? '实体' : node && node.kind === 'memory' ? '记忆' : '节点';
    const chip = el('button', {
      type: 'button',
      class: 'view-rel__nodechip',
      title: `${kind} · ${node && node.id}`,
      on: {
        click: (event) => {
          event.stopPropagation();
          if (!node || !node.id) return;
          if (node.kind === 'memory') navigate('editor', { id: node.id });
          else if (node.kind === 'entity') openNodePickerWith({ kind: 'entity', id: node.id });
        },
      },
    }, [
      el('span', { class: 'view-rel__nodekind', text: kind }),
      el('span', { class: 'view-rel__nodename', text: display.label }),
    ]);
    return chip;
  }

  function renderLegend() {
    const legend = el('div', { class: 'view-rel__legend', 'data-testid': 'relations-legend' });
    legend.append(el('span', { class: 'view-rel__label', text: '关系类型图例：' }));
    for (const type of RELATION_TYPES) {
      legend.append(el('span', { class: 'view-rel__legend-item', title: type.hint }, [
        el('span', { class: `view-rel__legend-swatch view-rel__legend-swatch--${type.color}` }),
        el('span', { text: type.label }),
        el('span', { class: 'view-rel__muted view-rel__mono', text: type.value }),
      ]));
    }
    return legend;
  }

  /* ------------------------------ 节点选择器 ------------------------------ */

  function openNodePicker() {
    const draft = { kind: state.filters.nodeKind || 'memory', query: '', results: [], loading: false, error: null };
    const body = el('div', { class: 'view-rel__dialog' });
    const resultHost = el('div', { class: 'view-rel__dialog-results', 'data-testid': 'relations-node-results' });
    const input = el('input', {
      class: 'view-rel__input',
      type: 'search',
      placeholder: draft.kind === 'memory' ? '搜索记忆标题…' : '搜索实体名称…',
      'data-testid': 'relations-node-search',
      on: {
        input: (event) => {
          draft.query = event.target.value;
          clearTimeout(draft.timer);
          draft.timer = setTimeout(() => runNodeSearch(draft, resultHost, input), 240);
        },
        keydown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            runNodeSearch(draft, resultHost, input);
          }
        },
      },
    });
    const kindRow = el('div', { class: 'view-rel__inline' });
    for (const kind of [{ value: 'memory', label: '记忆' }, { value: 'entity', label: '实体' }]) {
      kindRow.append(el('button', {
        type: 'button',
        class: `view-rel__chip${draft.kind === kind.value ? ' is-active' : ''}`,
        text: kind.label,
        on: {
          click: () => {
            draft.kind = kind.value;
            input.placeholder = kind.value === 'memory' ? '搜索记忆标题…' : '搜索实体名称…';
            for (const child of kindRow.children) child.classList.remove('is-active');
            kindRow.querySelector('button:nth-child(' + (kind.value === 'memory' ? 1 : 2) + ')').classList.add('is-active');
            runNodeSearch(draft, resultHost, input);
          },
        },
      }));
    }
    body.append(el('p', { class: 'view-rel__muted', text: '从真实 Runtime 数据中选择一个节点，然后浏览它出发/进入的全部关系。' }), kindRow, el('div', { class: 'view-rel__inline' }, [input, button({ label: '搜索', icon: 'search', size: 'sm', onClick: () => runNodeSearch(draft, resultHost, input) })]), resultHost);
    const dlg = openDialog({
      title: '选择节点',
      subtitle: '浏览与该节点相关的关系',
      content: body,
      width: 560,
      actions: [{ label: '取消', variant: 'ghost', closeOnClick: true }],
    });
    function pick(node) {
      state.filters.nodeId = node.id;
      state.filters.nodeKind = node.kind || draft.kind;
      state.filters.nodeLabel = node.label || node.name || null;
      dlg.close();
      loadRelations();
    }
    runNodeSearch(draft, resultHost, input, pick);
    return { pick };
  }

  function openNodePickerWith(node) {
    state.filters.nodeId = node.id;
    state.filters.nodeKind = node.kind;
    state.filters.nodeLabel = node.label || state.nodeIndex.get(node.id) || null;
    loadRelations();
  }

  async function runNodeSearch(draft, host, input, onPick) {
    const query = String(input.value || draft.query || '').trim();
    host.textContent = '';
    if (!query && draft.kind === 'memory') {
      host.append(el('div', { class: 'view-rel__muted', text: '输入关键词搜索记忆' }));
      return;
    }
    host.append(el('div', { class: 'view-rel__muted', text: '搜索中…' }));
    try {
      let items = [];
      if (draft.kind === 'memory') {
        const res = await api.searchMemory({ query, mode: 'fulltext', limit: 10 });
        items = (Array.isArray(res) ? res : (res && res.items) || [])
          .map((item) => (item && item.memory) || item)
          .filter((memory) => memory && memory.id)
          .map((memory) => ({ kind: 'memory', id: memory.id, label: memory.title, hint: memory.memory_type }));
      } else {
        const res = await api.listEntities({ q: query || undefined, limit: 10 });
        const list = Array.isArray(res) ? res : (res && (res.items || res.entities || res.data)) || [];
        items = list.map((entity) => ({ kind: 'entity', id: entity.id, label: entity.name, hint: entity.kind }));
      }
      host.textContent = '';
      if (!items.length) {
        host.append(el('div', { class: 'view-rel__muted', text: '没有匹配节点' }));
        return;
      }
      for (const node of items) {
        host.append(el('button', {
          type: 'button',
          class: 'view-rel__dialog-row',
          on: { click: () => (onPick ? onPick(node) : openNodePickerWith(node)) },
        }, [
          el('span', { class: 'view-rel__nodekind', text: node.kind === 'memory' ? '记忆' : '实体' }),
          el('span', { text: node.label || node.id }),
          el('span', { class: 'view-rel__muted view-rel__mono', text: node.id }),
        ]));
      }
    } catch (err) {
      host.textContent = '';
      host.append(el('div', { class: 'view-rel__error', text: `搜索失败：${errInfo(err).message}` }));
    }
  }

  /* ------------------------------ 创建/编辑 ------------------------------ */

  function openCreateDialog() {
    const draft = createEmptyRelationDraft();
    if (state.filters.nodeId) {
      draft.from = { kind: state.filters.nodeKind || 'memory', id: state.filters.nodeId };
    }
    openRelationFormDialog(draft, null);
  }

  function openEditDialog(relation) {
    openRelationFormDialog(relationDraftFromRelation(relation), relation);
  }

  function openRelationFormDialog(draft, existing) {
    const errors = { from: null, to: null, relation_type: null, label: null, evidence: null, confidence: null, weight: null, source_type: null };
    const body = el('div', { class: 'view-rel__dialog' });

    const renderNodePicker = (side) => {
      const host = el('div', { class: 'view-rel__node-picker' });
      const current = draft[side];
      if (current) {
        const display = nodeDisplay(current, state.nodeIndex);
        host.append(el('span', { class: 'view-rel__chip is-active' }, [
          el('span', { text: `${current.kind === 'entity' ? '实体' : '记忆'} · ${display.label}` }),
          el('button', { type: 'button', class: 'view-rel__chip-x', text: '×', 'aria-label': '移除节点', on: { click: () => { draft[side] = null; renderAll(); } } }),
        ]));
      } else {
        host.append(el('span', { class: 'view-rel__muted', text: '未选择' }));
      }
      const queryInput = el('input', { class: 'view-rel__input view-rel__input--sm', type: 'search', placeholder: side === 'from' ? '搜索起点（记忆/实体）' : '搜索终点（记忆/实体）', 'data-testid': `relation-${side}-search` });
      const kindSelect = el('select', { class: 'view-rel__select' }, [
        el('option', { value: 'memory', text: '记忆' }),
        el('option', { value: 'entity', text: '实体' }),
      ]);
      const results = el('div', { class: 'view-rel__dialog-results view-rel__dialog-results--inline' });
      const search = async () => {
        const query = queryInput.value.trim();
        if (!query) {
          results.textContent = '';
          return;
        }
        results.textContent = '';
        results.append(el('div', { class: 'view-rel__muted', text: '搜索中…' }));
        try {
          let items = [];
          if (kindSelect.value === 'memory') {
            const res = await api.searchMemory({ query, mode: 'fulltext', limit: 8 });
            items = (Array.isArray(res) ? res : (res && res.items) || [])
              .map((item) => (item && item.memory) || item)
              .filter((m) => m && m.id)
              .map((m) => ({ kind: 'memory', id: m.id, label: m.title }));
          } else {
            const res = await api.listEntities({ q: query, limit: 8 });
            const list = Array.isArray(res) ? res : (res && (res.items || res.entities || res.data)) || [];
            items = list.map((e) => ({ kind: 'entity', id: e.id, label: e.name }));
          }
          results.textContent = '';
          if (!items.length) results.append(el('div', { class: 'view-rel__muted', text: '没有匹配节点' }));
          for (const node of items) {
            results.append(el('button', {
              type: 'button',
              class: 'view-rel__dialog-row',
              on: {
                click: () => {
                  draft[side] = { kind: node.kind, id: node.id, label: node.label };
                  renderAll();
                },
              },
            }, [el('span', { class: 'view-rel__nodekind', text: node.kind === 'memory' ? '记忆' : '实体' }), el('span', { text: node.label || node.id })]));
          }
        } catch (err) {
          results.textContent = '';
          results.append(el('div', { class: 'view-rel__error', text: `搜索失败：${errInfo(err).message}` }));
        }
      };
      queryInput.addEventListener('input', () => {
        clearTimeout(queryInput._timer);
        queryInput._timer = setTimeout(search, 260);
      });
      queryInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          search();
        }
      });
      host.append(el('div', { class: 'view-rel__inline' }, [kindSelect, queryInput]), results);
      return host;
    };

    const typeSelect = el('select', { class: 'view-rel__select', 'data-testid': 'relation-form-type' });
    for (const type of RELATION_TYPES) {
      const option = el('option', { value: type.value, text: `${type.label}（${type.value}）` });
      if (type.value === draft.relation_type) option.selected = true;
      typeSelect.append(option);
    }
    typeSelect.addEventListener('change', () => {
      draft.relation_type = typeSelect.value;
      renderAll();
    });
    const labelInput = el('input', { class: 'view-rel__input', type: 'text', value: draft.label, placeholder: draft.relation_type === 'custom' ? '自定义关系名称（必填）' : '可选：关系标签', 'data-testid': 'relation-form-label', on: { input: (event) => { draft.label = event.target.value; } } });
    const evidenceInput = el('textarea', { class: 'view-rel__input view-rel__textarea', rows: '3', placeholder: draft.relation_type === 'causal' ? '因果依据（causal 必填）' : 'evidence：来源引用 / 用户说明', 'data-testid': 'relation-form-evidence' });
    evidenceInput.value = draft.evidence;
    evidenceInput.addEventListener('input', () => {
      draft.evidence = evidenceInput.value;
    });
    const confidenceInput = el('input', { class: 'view-rel__input view-rel__input--num', type: 'number', min: '0', max: '1', step: '0.05', value: String(draft.confidence), 'data-testid': 'relation-form-confidence', on: { input: (event) => { draft.confidence = Number(event.target.value); } } });
    const weightInput = el('input', { class: 'view-rel__input view-rel__input--num', type: 'number', min: '0', max: '2', step: '0.1', value: String(draft.weight), on: { input: (event) => { draft.weight = Number(event.target.value); } } });
    const sourceSelect = el('select', { class: 'view-rel__select' });
    for (const source of RELATION_SOURCE_TYPES) {
      const option = el('option', { value: source.value, text: source.label });
      if (source.value === draft.source_type) option.selected = true;
      sourceSelect.append(option);
    }
    sourceSelect.addEventListener('change', () => {
      draft.source_type = sourceSelect.value;
    });
    const sourceRef = el('input', { class: 'view-rel__input view-rel__input--sm', type: 'text', value: draft.source_ref, placeholder: '来源引用（URL / 会话 ID）', on: { input: (event) => { draft.source_ref = event.target.value; } } });
    const directed = el('label', { class: 'view-rel__check' }, [
      el('input', { type: 'checkbox', checked: draft.directed !== false, on: { change: (event) => { draft.directed = event.target.checked; } } }),
      el('span', { text: '有向关系' }),
    ]);

    function renderAll() {
      body.textContent = '';
      const nodeGrid = el('div', { class: 'view-rel__node-grid' }, [
        el('div', {}, [el('div', { class: 'view-rel__label', text: '起点 from' }), renderNodePicker('from'), errors.from ? el('div', { class: 'view-rel__error', text: errors.from, 'data-testid': 'relation-error-from' }) : null]),
        el('div', {}, [el('div', { class: 'view-rel__label', text: '终点 to' }), renderNodePicker('to'), errors.to ? el('div', { class: 'view-rel__error', text: errors.to }) : null]),
      ]);
      body.append(
        nodeGrid,
        el('div', { class: 'view-rel__form-grid' }, [
          el('label', { class: 'view-rel__field' }, [el('span', { class: 'view-rel__label', text: '关系类型' }), typeSelect, errors.relation_type ? el('div', { class: 'view-rel__error', text: errors.relation_type }) : null]),
          el('label', { class: 'view-rel__field' }, [el('span', { class: 'view-rel__label', text: draft.relation_type === 'custom' ? 'label（必填）' : 'label（可选）' }), labelInput, errors.label ? el('div', { class: 'view-rel__error', text: errors.label }) : null]),
          el('label', { class: 'view-rel__field view-rel__field--wide' }, [el('span', { class: 'view-rel__label', text: draft.relation_type === 'causal' ? 'evidence（因果必填）' : 'evidence' }), evidenceInput, errors.evidence ? el('div', { class: 'view-rel__error', text: errors.evidence }) : null]),
          el('label', { class: 'view-rel__field' }, [el('span', { class: 'view-rel__label', text: '置信度 confidence（0-1）' }), confidenceInput, errors.confidence ? el('div', { class: 'view-rel__error', text: errors.confidence }) : null]),
          el('label', { class: 'view-rel__field' }, [el('span', { class: 'view-rel__label', text: '权重 weight（0-2）' }), weightInput, errors.weight ? el('div', { class: 'view-rel__error', text: errors.weight }) : null]),
          el('label', { class: 'view-rel__field' }, [el('span', { class: 'view-rel__label', text: '来源 source' }), sourceSelect, sourceRef]),
          directed,
        ]),
      );
    }
    renderAll();

    const dlg = openDialog({
      title: existing ? '编辑关系' : '新建关系',
      subtitle: existing ? `关系 ${existing.id} · v${existing.version ?? '?'}` : '关系独立于记忆存储；删除关系不影响两端对象',
      content: body,
      width: 680,
      actions: [
        { label: '取消', variant: 'ghost', closeOnClick: true },
        {
          label: existing ? '保存修改' : '创建关系',
          variant: 'primary',
          testid: 'relation-form-submit',
          onClick: async (close) => {
            const validation = validateRelationDraft(draft);
            for (const key of Object.keys(errors)) errors[key] = validation.errors[key] || null;
            renderAll();
            if (!validation.ok) {
              notify('error', `请修正表单：${validation.errors[validation.order[0]]}`);
              return false;
            }
            try {
              if (existing) {
                await api.patchRelation(existing.id, { ...buildRelationPayload(draft), expected_version: existing.version });
                notify('success', '关系已保存');
              } else {
                await api.createRelation(buildRelationPayload(draft));
                notify('success', '关系已创建');
              }
              close();
              loadRelations();
            } catch (err) {
              const info = errInfo(err);
              notify('error', `${existing ? '保存' : '创建'}关系失败：${info.message}`);
              if (info.code === 'VERSION_CONFLICT') {
                errors.evidence = '版本冲突：关系已被其他客户端修改，请关闭后刷新重试';
                renderAll();
              }
              return false;
            }
            return true;
          },
        },
      ],
    });
    return dlg;
  }

  async function deleteRelation(relation) {
    let ok = false;
    try {
      if (ctx.dialogs && typeof ctx.dialogs.confirm === 'function') {
        ok = await ctx.dialogs.confirm({
          title: '删除关系？',
          message: `将删除关系「${relationTypeLabel(relation.relation_type)}」。只会删除关系本身，不会删除两端的记忆或实体。`,
          detail: '删除关系不会影响记忆正文、版本历史与实体数据。',
          confirmLabel: '删除关系',
          danger: true,
        });
      } else ok = window.confirm('删除关系？只会删除关系本身，不删除两端记忆或实体。');
    } catch {
      ok = false;
    }
    if (!ok) return;
    try {
      await api.deleteRelation(relation.id);
      notify('success', '关系已删除（两端对象未受影响）');
      loadRelations();
    } catch (err) {
      notify('error', `删除关系失败：${errInfo(err).message}`);
    }
  }

  function showRelationDetail(relation) {
    try {
      if (ctx.detail && typeof ctx.detail.show === 'function') {
        const meta = relationTypeMeta(relation.relation_type);
        ctx.detail.show({
          title: `${meta.label}${relation.label ? ` · ${relation.label}` : ''}`,
          subtitle: `关系 ${relation.id} · v${relation.version ?? '?'}`,
          content: (host) => {
            const wrap = el('div', { class: 'view-rel__detail' });
            wrap.append(
              el('div', { class: 'view-rel__detail-row' }, [el('span', { class: 'view-rel__label', text: '起点' }), renderNodeChip(relation.from, relation.relation_type)]),
              el('div', { class: 'view-rel__detail-row' }, [el('span', { class: 'view-rel__label', text: '终点' }), renderNodeChip(relation.to, relation.relation_type)]),
              el('div', { class: 'view-rel__detail-row' }, [el('span', { class: 'view-rel__label', text: '类型' }), el('span', { text: `${meta.label}（${relation.relation_type}）` })]),
              el('div', { class: 'view-rel__detail-row' }, [el('span', { class: 'view-rel__label', text: '置信度' }), el('span', { text: String(relation.confidence ?? '—') })]),
              el('div', { class: 'view-rel__detail-row' }, [el('span', { class: 'view-rel__label', text: '权重' }), el('span', { text: String(relation.weight ?? '—') })]),
              el('div', { class: 'view-rel__detail-row' }, [el('span', { class: 'view-rel__label', text: '来源' }), el('span', { text: SOURCE_LABEL[(relation.source && relation.source.type) || 'user'] || '—' })]),
              relation.evidence ? el('div', { class: 'view-rel__detail-row' }, [el('span', { class: 'view-rel__label', text: 'evidence' }), el('span', { text: relation.evidence })]) : null,
              el('div', { class: 'view-rel__detail-row' }, [el('span', { class: 'view-rel__label', text: '创建时间' }), el('span', { text: formatTime(relation.created_at) })]),
            );
            host.append(wrap);
            return wrap;
          },
          actions: [{ label: '关闭', variant: 'secondary', onClick: () => ctx.detail.clear && ctx.detail.clear() }],
        });
      } else {
        notify('info', `关系 ${relation.id}：${relationTypeLabel(relation.relation_type)}`);
      }
    } catch (err) {
      notify('error', `打开关系详情失败：${errInfo(err).message}`);
    }
  }

  function openDialog(opts) {
    try {
      if (typeof U.dialog === 'function') {
        const actions = (opts.actions || []).map((action) => ({
          label: action.label,
          variant: action.variant,
          closeOnClick: action.closeOnClick,
          onClick: (close) => {
            if (!action.onClick) {
              close && close();
              return undefined;
            }
            const result = action.onClick(close);
            if (result && typeof result.then === 'function') return result;
            return result;
          },
        }));
        return U.dialog({ title: opts.title, subtitle: opts.subtitle, content: opts.content, actions, width: opts.width || 560 });
      }
    } catch (err) {
      console.warn('[relations] ui.dialog 不可用', err);
    }
    const primary = (opts.actions || []).find((a) => a.onClick);
    const ok = window.confirm(`${opts.title}\n\n${opts.subtitle || ''}\n\n继续？`);
    if (ok && primary) Promise.resolve(primary.onClick(() => {})).catch((err) => notify('error', errInfo(err).message));
    return { close: () => {}, setBusy: () => {} };
  }

  function updateStatus() {
    try {
      if (!ctx.status) return;
      ctx.status.set('relations.count', {
        label: `关系 ${state.filtered.length}/${state.relations.length}${state.filters.nodeId ? ` · 节点 ${shortId(state.filters.nodeId)}` : ''}`,
        tone: 'ok',
      });
    } catch {
      /* noop */
    }
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  function unmount() {
    clearTimeout(reloadTimer);
    try {
      if (ctx.status) ctx.status.remove('relations.count');
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
    dom.bodyHost = null;
  }

  function activate() {
    if (!state.relations.length && !state.loading && !state.loadError) loadRelations();
    // 从星图切换过来时，读取最新 primary selection 作为节点上下文
    try {
      const storeState = ctx.store && typeof ctx.store.getState === 'function' ? ctx.store.getState() : null;
      const selected = storeState && storeState.selection && storeState.selection.primaryId;
      if (selected && selected !== state.filters.nodeId) {
        state.filters.nodeId = selected;
        state.filters.nodeKind = null;
        state.filters.nodeLabel = null;
        loadRelations();
      }
    } catch {
      /* noop */
    }
  }

  function handleCommand(command) {
    if (command === 'view:refresh') {
      state.nodeIndex = new Map();
      loadRelations();
      return true;
    }
    return false;
  }

  function getSnapshot() {
    return { filters: state.filters };
  }

  return { mount, unmount, activate, handleCommand, getSnapshot };
}

/* ============================================================================
 * 样式
 * ========================================================================== */

const REL_CSS = `
.view-rel { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--fca-bg-1); color:var(--fca-text); font-family:var(--fca-font-ui); font-size:var(--fca-text-md); }
.view-rel__bar { display:flex; align-items:center; justify-content:space-between; gap:var(--fca-space-3); padding:var(--fca-space-2) var(--fca-space-4); border-bottom:1px solid var(--fca-border); background:var(--fca-bg-2); flex-wrap:wrap; }
.view-rel__title { display:flex; align-items:baseline; gap:var(--fca-space-2); }
.view-rel__title h2 { margin:0; font-size:var(--fca-text-lg); font-weight:600; }
.view-rel__count { font-size:var(--fca-text-sm); color:var(--fca-text-muted); font-family:var(--fca-font-mono); }
.view-rel__actions { display:flex; gap:var(--fca-space-2); }
.view-rel__btn { display:inline-flex; align-items:center; gap:5px; height:28px; padding:0 var(--fca-space-3); border-radius:var(--fca-radius-sm); border:1px solid var(--fca-border); background:var(--fca-bg-3); color:var(--fca-text); font:inherit; font-size:var(--fca-text-sm); cursor:pointer; white-space:nowrap; }
.view-rel__btn:hover { background:var(--fca-bg-4); }
.view-rel__btn:disabled { opacity:.45; cursor:not-allowed; }
.view-rel__btn--primary { background:var(--fca-accent-soft); border-color:var(--fca-accent); color:var(--fca-accent-strong); }
.view-rel__btn--ghost { background:transparent; border-color:transparent; color:var(--fca-text-dim); }
.view-rel__btn--ghost:hover { background:var(--fca-bg-3); color:var(--fca-text); }
.view-rel__btn--danger { background:transparent; border-color:var(--fca-danger); color:var(--fca-danger); }
.view-rel__btn--sm { height:24px; padding:0 var(--fca-space-2); font-size:var(--fca-text-xs); }
.view-rel__filters { display:flex; align-items:center; gap:var(--fca-space-3); padding:var(--fca-space-2) var(--fca-space-4); border-bottom:1px solid var(--fca-border); background:var(--fca-bg-1); flex-wrap:wrap; }
.view-rel__select { background:var(--fca-bg-3); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); color:var(--fca-text); font:inherit; font-size:var(--fca-text-sm); height:28px; padding:0 var(--fca-space-1); outline:none; }
.view-rel__input { background:var(--fca-bg-3); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); color:var(--fca-text); font:inherit; font-size:var(--fca-text-md); padding:4px var(--fca-space-2); height:30px; box-sizing:border-box; outline:none; width:100%; }
.view-rel__input:focus { border-color:var(--fca-accent); }
.view-rel__input--sm { height:28px; font-size:var(--fca-text-sm); }
.view-rel__input--num { width:92px; }
.view-rel__input--sm.view-rel__input--num { width:88px; }
.view-rel__textarea { width:100%; height:auto; min-height:64px; resize:vertical; line-height:1.6; }
.view-rel__check { display:inline-flex; align-items:center; gap:5px; font-size:var(--fca-text-xs); color:var(--fca-text-dim); cursor:pointer; }
.view-rel__check input { accent-color:var(--fca-accent); }
.view-rel__chip { display:inline-flex; align-items:center; gap:4px; border:1px solid var(--fca-border); background:var(--fca-bg-2); color:var(--fca-text-muted); font:inherit; font-size:var(--fca-text-xs); border-radius:999px; padding:2px var(--fca-space-2); cursor:pointer; }
.view-rel__chip.is-active { background:var(--fca-accent-soft); border-color:var(--fca-accent); color:var(--fca-accent-strong); }
.view-rel__chip-x { border:none; background:transparent; color:var(--fca-text-muted); cursor:pointer; padding:0 2px; font-size:var(--fca-text-sm); }
.view-rel__chip-x:hover { color:var(--fca-danger); }
.view-rel__muted { color:var(--fca-text-muted); font-size:var(--fca-text-sm); }
.view-rel__mono { font-family:var(--fca-font-mono); font-size:var(--fca-text-xs); }
.view-rel__label { color:var(--fca-text-muted); font-size:var(--fca-text-xs); }
.view-rel__inline { display:flex; align-items:center; gap:var(--fca-space-2); flex-wrap:wrap; }
.view-rel__hint { padding:3px var(--fca-space-4); border-bottom:1px solid var(--fca-border); background:var(--fca-bg-0); font-size:var(--fca-text-xs); color:var(--fca-text-muted); }
.view-rel__hint--empty { display:none; }
.view-rel__context { display:flex; align-items:center; gap:var(--fca-space-2); padding:var(--fca-space-1) var(--fca-space-4); border-bottom:1px solid var(--fca-border); background:var(--fca-bg-2); flex-wrap:wrap; }
.view-rel__context-label { color:var(--fca-accent-strong); font-size:var(--fca-text-sm); }
.view-rel__body { flex:1; min-height:0; overflow-y:auto; padding:var(--fca-space-3) var(--fca-space-4); }
.view-rel__list { display:flex; flex-direction:column; gap:var(--fca-space-1); }
.view-rel__row { display:flex; gap:var(--fca-space-3); padding:var(--fca-space-2) var(--fca-space-3); border:1px solid var(--fca-border); border-left-width:3px; border-radius:var(--fca-radius); background:var(--fca-bg-2); cursor:pointer; }
.view-rel__row:hover { background:var(--fca-bg-3); border-color:var(--fca-border-strong); }
.view-rel__row.is-deleted { opacity:.6; }
.view-rel__row--gold { border-left-color:var(--fca-gold); }
.view-rel__row--cyan { border-left-color:var(--fca-accent); }
.view-rel__row--violet { border-left-color:var(--fca-violet); }
.view-rel__row--accent { border-left-color:var(--fca-accent-strong); }
.view-rel__row--rose { border-left-color:var(--fca-rose); }
.view-rel__row--magenta { border-left-color:color-mix(in srgb, var(--fca-violet) 55%, var(--fca-rose)); }
.view-rel__row--green { border-left-color:var(--fca-green); }
.view-rel__row--neutral { border-left-color:var(--fca-border-strong); }
.view-rel__row-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:4px; }
.view-rel__row-head { display:flex; align-items:center; gap:var(--fca-space-2); flex-wrap:wrap; }
.view-rel__type { font-size:var(--fca-text-xs); padding:1px 7px; border-radius:999px; border:1px solid var(--fca-border-strong); }
.view-rel__type--gold { color:var(--fca-gold); border-color:color-mix(in srgb, var(--fca-gold) 40%, transparent); background:color-mix(in srgb, var(--fca-gold) 10%, transparent); }
.view-rel__type--cyan { color:var(--fca-accent); border-color:color-mix(in srgb, var(--fca-accent) 40%, transparent); background:var(--fca-accent-soft); }
.view-rel__type--violet { color:var(--fca-violet); border-color:color-mix(in srgb, var(--fca-violet) 40%, transparent); background:color-mix(in srgb, var(--fca-violet) 10%, transparent); }
.view-rel__type--accent { color:var(--fca-accent-strong); border-color:var(--fca-border-strong); background:var(--fca-bg-3); }
.view-rel__type--rose { color:var(--fca-rose); border-color:color-mix(in srgb, var(--fca-rose) 40%, transparent); background:color-mix(in srgb, var(--fca-rose) 10%, transparent); }
.view-rel__type--magenta { color:color-mix(in srgb, var(--fca-violet) 55%, var(--fca-rose)); border-color:var(--fca-border-strong); }
.view-rel__type--green { color:var(--fca-green); border-color:color-mix(in srgb, var(--fca-green) 40%, transparent); background:color-mix(in srgb, var(--fca-green) 10%, transparent); }
.view-rel__type--neutral { color:var(--fca-text-dim); background:var(--fca-bg-3); }
.view-rel__tag { font-size:10px; line-height:16px; padding:0 5px; border-radius:999px; border:1px solid var(--fca-border); color:var(--fca-text-muted); }
.view-rel__tag--rose { color:var(--fca-rose); }
.view-rel__nodes { display:flex; align-items:center; gap:var(--fca-space-2); flex-wrap:wrap; }
.view-rel__nodechip { display:inline-flex; align-items:center; gap:5px; background:var(--fca-bg-3); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); color:var(--fca-text); font:inherit; font-size:var(--fca-text-sm); padding:2px var(--fca-space-2); cursor:pointer; }
.view-rel__nodechip:hover { border-color:var(--fca-accent); }
.view-rel__nodekind { font-size:10px; color:var(--fca-text-muted); border:1px solid var(--fca-border); border-radius:3px; padding:0 3px; }
.view-rel__nodename { max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.view-rel__arrow { color:var(--fca-text-muted); }
.view-rel__label-chip { font-size:var(--fca-text-xs); color:var(--fca-gold); border:1px dashed color-mix(in srgb, var(--fca-gold) 40%, transparent); border-radius:999px; padding:0 6px; }
.view-rel__evidence { font-size:var(--fca-text-xs); color:var(--fca-text-dim); line-height:1.5; }
.view-rel__row-actions { display:flex; gap:4px; align-items:flex-start; flex-shrink:0; }
.view-rel__legend { display:flex; align-items:center; gap:var(--fca-space-3); flex-wrap:wrap; padding:var(--fca-space-1) var(--fca-space-4); border-top:1px solid var(--fca-border); background:var(--fca-bg-2); }
.view-rel__legend-item { display:inline-flex; align-items:center; gap:4px; font-size:var(--fca-text-xs); color:var(--fca-text-dim); }
.view-rel__legend-swatch { width:12px; height:3px; border-radius:2px; background:var(--fca-text-dim); }
.view-rel__legend-swatch--gold { background:var(--fca-gold); }
.view-rel__legend-swatch--cyan { background:var(--fca-accent); }
.view-rel__legend-swatch--violet { background:var(--fca-violet); }
.view-rel__legend-swatch--accent { background:var(--fca-accent-strong); }
.view-rel__legend-swatch--rose { background:var(--fca-rose); }
.view-rel__legend-swatch--magenta { background:linear-gradient(90deg, var(--fca-violet), var(--fca-rose)); }
.view-rel__legend-swatch--green { background:var(--fca-green); }
.view-rel__legend-swatch--neutral { background:var(--fca-border-strong); }
.view-rel__loading { display:flex; flex-direction:column; align-items:center; gap:var(--fca-space-3); padding:var(--fca-space-6); color:var(--fca-text-dim); }
.view-rel__spinner { width:22px;height:22px;border-radius:50%;border:2px solid var(--fca-border-strong);border-top-color:var(--fca-accent);animation:view-rel-spin .8s linear infinite; }
@keyframes view-rel-spin { to { transform:rotate(360deg); } }
.view-rel__empty { display:flex; flex-direction:column; align-items:center; gap:var(--fca-space-2); padding:var(--fca-space-6); text-align:center; }
.view-rel__empty-title { font-size:var(--fca-text-lg); }
.view-rel__empty-desc { color:var(--fca-text-muted); font-size:var(--fca-text-sm); max-width:520px; line-height:1.7; }
.view-rel__empty-actions { display:flex; gap:var(--fca-space-2); margin-top:var(--fca-space-2); }
.view-rel__footer { padding-top:var(--fca-space-2); font-size:var(--fca-text-xs); color:var(--fca-text-muted); font-family:var(--fca-font-mono); }
.view-rel__errorbox { margin:var(--fca-space-5); padding:var(--fca-space-4); border:1px solid color-mix(in srgb, var(--fca-danger) 50%, var(--fca-border)); background:color-mix(in srgb, var(--fca-danger) 8%, var(--fca-bg-2)); border-radius:var(--fca-radius); display:flex; flex-direction:column; gap:var(--fca-space-2); max-width:620px; }
.view-rel__errorbox-title { color:var(--fca-danger); font-weight:600; }
.view-rel__errorbox-detail { color:var(--fca-text-dim); font-size:var(--fca-text-sm); }
.view-rel__error { color:var(--fca-danger); font-size:var(--fca-text-xs); }
.view-rel__dialog { display:flex; flex-direction:column; gap:var(--fca-space-3); max-height:64vh; overflow:auto; }
.view-rel__dialog p { margin:0; }
.view-rel__dialog-results { display:flex; flex-direction:column; gap:2px; max-height:200px; overflow:auto; border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); padding:2px; }
.view-rel__dialog-results--inline { max-height:150px; }
.view-rel__dialog-row { display:flex; align-items:center; gap:var(--fca-space-2); padding:4px var(--fca-space-2); border:1px solid transparent; border-radius:var(--fca-radius-sm); background:transparent; color:var(--fca-text); font:inherit; font-size:var(--fca-text-sm); text-align:left; cursor:pointer; }
.view-rel__dialog-row:hover { background:var(--fca-bg-3); border-color:var(--fca-border); }
.view-rel__node-grid { display:grid; grid-template-columns:1fr 1fr; gap:var(--fca-space-3); }
.view-rel__node-picker { display:flex; flex-direction:column; gap:var(--fca-space-2); padding:var(--fca-space-2); border:1px dashed var(--fca-border-strong); border-radius:var(--fca-radius-sm); min-height:96px; }
.view-rel__form-grid { display:grid; grid-template-columns:1fr 1fr; gap:var(--fca-space-2) var(--fca-space-3); }
.view-rel__field { display:flex; flex-direction:column; gap:3px; }
.view-rel__field--wide { grid-column:1/-1; }
.view-rel__detail { display:flex; flex-direction:column; gap:var(--fca-space-2); font-size:var(--fca-text-sm); }
.view-rel__detail-row { display:flex; flex-direction:column; gap:2px; }
@media (max-width: 900px) { .view-rel__node-grid, .view-rel__form-grid { grid-template-columns:1fr; } }
`;
