/**
 * FCA Memory Atlas — Runtime HTTP API 客户端
 *
 * 契约：docs/PUBLIC_INTERFACE_FREEZE.md §4 / §6 / §7，renderer/lib/contracts.md §4
 * - 通过 preload 桥（window.fca.net，主进程 IPC）访问 Runtime，renderer 不直接 fetch、不接触 token
 * - 请求追踪 ID、超时、重试、错误码 → 中文提示
 * - SSE 订阅：自动断线重连（Last-Event-ID）+ 序号缺口/重连成功后全量重同步
 * - 另提供客户端筛选纯函数（buildFilters / applyGraphFilters）
 */

const DEFAULT_TIMEOUT = 15000;
const TIMEOUTS = {
  health: 8000,
  state: 8000,
  graph: 30000,
  search: 20000,
  timeline: 20000,
  backup: 120000,
  export: 120000,
  import: 120000,
};
const CLIENT_VERSION = '0.1.0';

export const ERROR_MESSAGES = {
  BAD_REQUEST: '请求格式错误（客户端缺陷，请反馈 trace id）',
  VALIDATION_FAILED: '字段校验失败，请检查输入内容',
  UNAUTHORIZED: '认证失败：Runtime token 缺失或不匹配，请检查数据目录 config/runtime-token',
  FORBIDDEN: '已拒绝：Runtime 仅允许本机回环访问',
  NOT_FOUND: '对象不存在或已被删除',
  METHOD_NOT_ALLOWED: '接口方法不支持（Runtime 版本可能不匹配）',
  CONFLICT: '操作冲突，请刷新后重试',
  VERSION_CONFLICT: '该记忆已被其他客户端修改，请刷新后重试',
  DUPLICATE: '幂等键重复',
  GONE: '对象已永久删除',
  PAYLOAD_TOO_LARGE: '内容超过大小限制',
  UNSUPPORTED_MEDIA_TYPE: '内容类型不支持',
  RATE_LIMITED: '请求过于频繁，请稍后重试',
  INTERNAL: 'Runtime 内部错误',
  NOT_INITIALIZED: '数据库尚未初始化，请先完成初始化向导',
  DATABASE_ERROR: '数据库错误，请尝试备份并重启 Runtime',
  BACKUP_FAILED: '备份失败',
  RESTORE_FAILED: '恢复失败，数据库未被修改',
  IMPORT_FAILED: '导入失败',
  LLM_NOT_CONFIGURED: '未配置 LLM Provider（本地功能不受影响）',
  LLM_UNAVAILABLE: 'LLM 服务不可达（本地功能不受影响）',
  SHUTTING_DOWN: 'Runtime 正在关闭',
  NETWORK_ERROR: '无法连接本地 Runtime，请确认运行时已启动',
  TIMEOUT: 'Runtime 响应超时',
  INCOMPATIBLE: 'Runtime API 版本不兼容（需要 API v1）',
  CANCELLED: '请求已取消',
  UNKNOWN: '未知错误',
};

export class FcaApiError extends Error {
  constructor(payload = {}) {
    const code = payload.code || 'UNKNOWN';
    const baseMessage = payload.message || ERROR_MESSAGES[code] || '请求失败';
    super(baseMessage);
    this.name = 'FcaApiError';
    this.code = code;
    this.httpStatus = payload.httpStatus ?? null;
    this.details = payload.details || {};
    this.traceId = payload.traceId || null;
    this.retryable = Boolean(payload.retryable);
    const base = ERROR_MESSAGES[code] || '请求失败';
    let userMessage = base;
    if (code === 'VALIDATION_FAILED' && this.details && this.details.fields) {
      const fields = Array.isArray(this.details.fields)
        ? this.details.fields.map((f) => (typeof f === 'string' ? f : f.field || '')).filter(Boolean).join('、')
        : String(this.details.fields);
      if (fields) userMessage = `字段校验失败：${fields}`;
    }
    if (code === 'VERSION_CONFLICT' && this.details && this.details.current_version !== undefined) {
      userMessage = `该记忆已被其他客户端修改（当前版本 ${this.details.current_version}），请刷新后重试`;
    }
    if (code === 'DUPLICATE' && this.details && this.details.existing_id) {
      userMessage = `幂等键重复（已存在：${this.details.existing_id}）`;
    }
    if (code === 'INTERNAL' && this.traceId) userMessage = `Runtime 内部错误（trace id：${this.traceId}）`;
    if (code === 'IMPORT_FAILED' && payload.message) userMessage = `导入失败：${payload.message}`;
    this.userMessage = userMessage;
    this.rawMessage = baseMessage;
  }
}

function makeTraceId() {
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return `trc_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return `trc_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 18)}`;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status, code) {
  if (status === 429) return true;
  if (status >= 500 && status !== 501) return true;
  return ['NETWORK_ERROR', 'TIMEOUT', 'DATABASE_ERROR', 'SHUTTING_DOWN'].includes(code);
}

const RETRYABLE_METHODS = new Set(['GET', 'HEAD']);

function normalizeQuery(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      params.set(key, value.join(','));
    } else if (typeof value === 'object') {
      params.set(key, JSON.stringify(value));
    } else {
      params.set(key, String(value));
    }
  }
  const str = params.toString();
  return str ? `?${str}` : '';
}

function detectBridge() {
  if (typeof window !== 'undefined' && window.fca && window.fca.isElectron) return window.fca;
  return null;
}

/**
 * 创建 API 客户端
 * @param {object} [options]
 * @param {object} [options.bridge] preload 桥（默认 window.fca）
 * @param {string} [options.baseUrl] 直接 fetch 模式下的 Runtime 地址
 * @param {() => string|null} [options.tokenProvider] 直接 fetch 模式下的 token 提供者
 * @param {object} [options.events] 事件总线（可选：广播 sse 事件 / api:resync）
 * @param {object} [options.logger]
 */
export function createApi(options = {}) {
  const bridge = options.bridge !== undefined ? options.bridge : detectBridge();
  const bus = options.events || null;
  const logger = options.logger || console;
  const baseUrl = (options.baseUrl || 'http://127.0.0.1:17860').replace(/\/+$/, '');
  const tokenProvider = options.tokenProvider || null;
  let requestCount = 0;

  // ------------------------------------------------------------ 传输层
  async function bridgeRequest(req) {
    const result = await bridge.net.request(req);
    return result;
  }

  async function fetchRequest(req) {
    const url = `${baseUrl}${req.path}${normalizeQuery(req.query)}`;
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs || DEFAULT_TIMEOUT;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = { Accept: 'application/json', 'X-FCA-Client': 'desktop', 'X-FCA-Client-Version': CLIENT_VERSION, ...(req.headers || {}) };
    try {
      if (!req.noAuth && tokenProvider) {
        const token = tokenProvider();
        if (token) headers.Authorization = `Bearer ${token}`;
      }
      const init = { method: req.method || 'GET', headers, signal: controller.signal };
      if (req.body !== undefined) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
        init.body = JSON.stringify(req.body);
      }
      const res = await fetch(url, init);
      const text = await res.text();
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { _raw: text };
        }
      }
      const ok = res.status >= 200 && res.status < 300;
      const traceId = res.headers.get('x-fca-trace-id') || makeTraceId();
      let error = null;
      if (!ok) {
        const errObj = body && body.error ? body.error : {};
        error = { code: errObj.code || (res.status === 401 ? 'UNAUTHORIZED' : 'HTTP_ERROR'), message: errObj.message || res.statusText, details: errObj.details, trace_id: errObj.trace_id || traceId };
      }
      return { ok, status: res.status, statusText: res.statusText, headers: {}, body, traceId, durationMs: 0, url, error };
    } catch (error) {
      const isAbort = error && error.name === 'AbortError';
      return {
        ok: false,
        status: 0,
        statusText: isAbort ? 'TIMEOUT' : 'NETWORK_ERROR',
        headers: {},
        body: null,
        traceId: makeTraceId(),
        durationMs: timeoutMs,
        url,
        error: { code: isAbort ? 'TIMEOUT' : 'NETWORK_ERROR', message: isAbort ? `Runtime 响应超时（${timeoutMs}ms）` : `无法连接本地 Runtime（${baseUrl}）：${error.message}` },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  const usingBridge = Boolean(bridge && bridge.net && typeof bridge.net.request === 'function');
  const transportRequest = usingBridge ? bridgeRequest : fetchRequest;

  function responseToError(res) {
    const bodyError = res && res.body && res.body.error ? res.body.error : null;
    const error = (res && res.error) || bodyError || {};
    const code = error.code || bodyError?.code || (res && res.status === 401 ? 'UNAUTHORIZED' : 'UNKNOWN');
    return new FcaApiError({
      code,
      message: error.message || bodyError?.message || `HTTP ${res ? res.status : '?'}`,
      httpStatus: res ? res.status : null,
      details: error.details || bodyError?.details || {},
      traceId: (error.trace_id || (res && res.traceId) || bodyError?.trace_id) || null,
      retryable: isRetryableStatus(res ? res.status : 0, code),
    });
  }

  /**
   * 发起请求；HTTP 非 2xx 抛 FcaApiError。
   * @returns {Promise<any>} 解析后的 body
   */
  async function request(method, path, opts = {}) {
    const upper = String(method || 'GET').toUpperCase();
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT;
    const maxRetries = opts.retries !== undefined ? opts.retries : RETRYABLE_METHODS.has(upper) ? 2 : 0;
    const traceId = opts.traceId || makeTraceId();
    const headers = { ...(opts.headers || {}), 'X-FCA-Trace-Id': traceId };
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      requestCount += 1;
      const startedAt = performance.now();
      let res;
      try {
        res = await transportRequest({
          method: upper,
          path,
          query: opts.query,
          body: opts.body,
          headers,
          timeoutMs,
          noAuth: Boolean(opts.noAuth),
        });
      } catch (error) {
        res = { ok: false, status: 0, body: null, error: { code: 'NETWORK_ERROR', message: error.message }, traceId };
      }
      const duration = Math.round(performance.now() - startedAt);
      if (res.ok) {
        if (logger && duration > 3000) logger.warn?.(`[fca-api] 慢请求 ${upper} ${path} (${duration}ms)`);
        return res.body;
      }
      lastError = responseToError(res);
      const canRetry = attempt < maxRetries && (RETRYABLE_METHODS.has(upper) ? lastError.retryable : false);
      if (!canRetry) {
        if (logger) logger.warn?.(`[fca-api] ${upper} ${path} 失败`, { code: lastError.code, status: lastError.httpStatus, traceId: lastError.traceId });
        throw lastError;
      }
      const backoff = Math.min(4000, 250 * 2 ** attempt) + Math.floor(Math.random() * 120);
      await sleep(backoff);
    }
    throw lastError || new FcaApiError({ code: 'UNKNOWN' });
  }

  const get = (path, opts = {}) => request('GET', path, opts);
  const post = (path, body, opts = {}) => request('POST', path, { ...opts, body: body === undefined ? {} : body });
  const patch = (path, body, opts = {}) => request('PATCH', path, { ...opts, body: body === undefined ? {} : body });
  const del = (path, opts = {}) => request('DELETE', path, opts);

  // ------------------------------------------------------------ 健康/状态
  const api = {
    baseUrl,
    clientVersion: CLIENT_VERSION,
    isBridgeMode: usingBridge,
    get requestCount() {
      return requestCount;
    },
    userMessage(error) {
      if (!error) return ERROR_MESSAGES.UNKNOWN;
      if (error instanceof FcaApiError) return error.userMessage;
      return error.message || ERROR_MESSAGES.UNKNOWN;
    },

    health() {
      return get('/health', { noAuth: true, timeoutMs: TIMEOUTS.health, retries: 1 });
    },

    getState() {
      return get('/api/v1/state', { timeoutMs: TIMEOUTS.state });
    },

    getSystemStatus() {
      return get('/api/v1/system/status');
    },

    getGraph(params = {}) {
      return get('/api/v1/graph', { query: params, timeoutMs: TIMEOUTS.graph });
    },

    getTimeline(params = {}) {
      return get('/api/v1/timeline', { query: params, timeoutMs: TIMEOUTS.timeline });
    },

    getDbHealth() {
      return get('/api/v1/db/health');
    },
    getMigrations() {
      return get('/api/v1/db/migrations');
    },
    vacuumDb() {
      return post('/api/v1/db/vacuum', {}, { timeoutMs: 120000, retries: 0 });
    },
    initDb() {
      return post('/api/v1/db/init', {}, { retries: 0 });
    },
    getLogs(params = {}) {
      return get('/api/v1/logs', { query: params });
    },
    shutdown() {
      return post('/api/v1/shutdown', {}, { retries: 0 });
    },
    submitEvent(event) {
      return post('/api/v1/event', event, { retries: 0 });
    },

    // ---------------------------------------------------------- memory
    storeMemory(payload) {
      return post('/api/v1/memory/store', payload, { retries: 0 });
    },
    getMemory(id, params = {}) {
      return get(`/api/v1/memory/${encodeURIComponent(id)}`, { query: params });
    },
    patchMemory(id, payload) {
      return patch(`/api/v1/memory/${encodeURIComponent(id)}`, payload, { retries: 0 });
    },
    deleteMemory(id, params = {}) {
      return del(`/api/v1/memory/${encodeURIComponent(id)}`, { query: params, retries: 0 });
    },
    restoreMemory(id) {
      return post(`/api/v1/memory/${encodeURIComponent(id)}/restore`, {}, { retries: 0 });
    },
    mergeMemories(id, payload) {
      return post(`/api/v1/memory/${encodeURIComponent(id)}/merge`, payload, { retries: 0 });
    },
    splitMemory(id, payload) {
      return post(`/api/v1/memory/${encodeURIComponent(id)}/split`, payload, { retries: 0 });
    },
    getVersions(id, params = {}) {
      return get(`/api/v1/memory/${encodeURIComponent(id)}/versions`, { query: params });
    },
    getDiff(id, params = {}) {
      return get(`/api/v1/memory/${encodeURIComponent(id)}/diff`, { query: params });
    },
    searchMemory(payload) {
      return post('/api/v1/memory/search', payload, { timeoutMs: TIMEOUTS.search, retries: 0 });
    },

    // ---------------------------------------------------------- relations
    listRelations(params = {}) {
      return get('/api/v1/relations', { query: params });
    },
    createRelation(payload) {
      return post('/api/v1/relations', payload, { retries: 0 });
    },
    patchRelation(id, payload) {
      return patch(`/api/v1/relations/${encodeURIComponent(id)}`, payload, { retries: 0 });
    },
    deleteRelation(id) {
      return del(`/api/v1/relations/${encodeURIComponent(id)}`, { retries: 0 });
    },

    // ---------------------------------------------------------- entities
    listEntities(params = {}) {
      return get('/api/v1/entities', { query: params });
    },
    createEntity(payload) {
      return post('/api/v1/entities', payload, { retries: 0 });
    },
    getEntity(id) {
      return get(`/api/v1/entities/${encodeURIComponent(id)}`);
    },
    patchEntity(id, payload) {
      return patch(`/api/v1/entities/${encodeURIComponent(id)}`, payload, { retries: 0 });
    },
    deleteEntity(id) {
      return del(`/api/v1/entities/${encodeURIComponent(id)}`, { retries: 0 });
    },

    // ------------------------------------------------------ identity/cognition
    getIdentity() {
      return get('/api/v1/identity');
    },
    updateIdentity(payload) {
      return post('/api/v1/identity', payload, { retries: 0 });
    },
    getCognition() {
      return get('/api/v1/cognition');
    },
    updateCognition(payload) {
      return post('/api/v1/cognition', payload, { retries: 0 });
    },

    // ---------------------------------------------------------- layout
    getLayoutNodes(params = {}) {
      return get('/api/v1/layout/nodes', { query: params });
    },
    saveLayoutNodes(updates) {
      return post('/api/v1/layout/nodes', { updates }, { retries: 0 });
    },
    recomputeLayout(payload = { algorithm: 'force_v1', cluster_separation: 0.8 }) {
      return post('/api/v1/layout/recompute', payload, { retries: 0, timeoutMs: 60000 });
    },
    resetLayout() {
      return post('/api/v1/layout/reset', {}, { retries: 0, timeoutMs: 60000 });
    },
    listLayoutViews() {
      return get('/api/v1/layout/views');
    },
    saveLayoutView(payload) {
      return post('/api/v1/layout/views', payload, { retries: 0 });
    },
    deleteLayoutView(id) {
      return del(`/api/v1/layout/views/${encodeURIComponent(id)}`, { retries: 0 });
    },

    // ---------------------------------------------------------- backup/export
    createBackup() {
      return post('/api/v1/backup', {}, { timeoutMs: TIMEOUTS.backup, retries: 0 });
    },
    listBackups() {
      return get('/api/v1/backups');
    },
    restoreBackup(backupId) {
      return post('/api/v1/restore', { backup_id: backupId }, { timeoutMs: TIMEOUTS.backup, retries: 0 });
    },
    deleteBackup(id) {
      return del(`/api/v1/backups/${encodeURIComponent(id)}`, { retries: 0 });
    },
    exportData(payload = {}) {
      return post('/api/v1/export', payload, { timeoutMs: TIMEOUTS.export, retries: 0 });
    },
    importData(payload) {
      return post('/api/v1/import', payload, { timeoutMs: TIMEOUTS.import, retries: 0 });
    },

    // ---------------------------------------------------------- llm
    listLlmProviders() {
      return get('/api/v1/llm/providers');
    },
    createLlmProvider(payload) {
      return post('/api/v1/llm/providers', payload, { retries: 0 });
    },
    updateLlmProvider(id, payload) {
      return patch(`/api/v1/llm/providers/${encodeURIComponent(id)}`, payload, { retries: 0 });
    },
    deleteLlmProvider(id) {
      return del(`/api/v1/llm/providers/${encodeURIComponent(id)}`, { retries: 0 });
    },
    llmComplete(payload) {
      return post('/api/v1/llm/complete', payload, { timeoutMs: 60000, retries: 0 });
    },
    getLlmQueue() {
      return get('/api/v1/llm/queue');
    },
    retryLlmQueue(id) {
      return post(`/api/v1/llm/queue/${encodeURIComponent(id)}/retry`, {}, { retries: 0 });
    },

    // ------------------------------------------------------ 筛选辅助
    buildFilters(filtersState = {}) {
      const filters = filtersState || {};
      const out = {};
      if (Array.isArray(filters.types) && filters.types.length) out.types = filters.types;
      if (Array.isArray(filters.tags) && filters.tags.length) out.tags = filters.tags;
      if (Array.isArray(filters.projects) && filters.projects.length) out.projects = filters.projects;
      if (filters.timeRange && (filters.timeRange.from || filters.timeRange.to)) {
        out.time_range = { from: filters.timeRange.from || null, to: filters.timeRange.to || null };
      }
      if (filters.includeDeleted) out.include_deleted = true;
      return out;
    },

    /** 客户端图谱筛选（星云图层用），返回新 graph，不修改入参 */
    applyGraphFilters(graph, filtersState = {}, favorites = null) {
      if (!graph || !Array.isArray(graph.nodes)) return graph;
      const filters = filtersState || {};
      const types = new Set(filters.types || []);
      const tags = new Set(filters.tags || []);
      const projects = new Set(filters.projects || []);
      const range = filters.timeRange || {};
      const from = range.from ? new Date(range.from).getTime() : null;
      const to = range.to ? new Date(range.to).getTime() : null;
      const onlyFavorites = Boolean(filters.onlyFavorites);
      const favSet = favorites instanceof Set ? favorites : new Set(favorites || []);
      const anyFilter = types.size > 0 || tags.size > 0 || projects.size > 0 || from !== null || to !== null || onlyFavorites;
      if (!anyFilter) return graph;

      const edges = Array.isArray(graph.edges) ? graph.edges : [];
      const projectIds = new Set();
      if (projects.size) {
        for (const node of graph.nodes) {
          if (node.kind === 'entity' && (node.type === 'project' || node.type === 'entity') && (projects.has(node.id) || projects.has(node.label))) {
            projectIds.add(node.id);
          }
        }
      }

      const adjacency = new Map();
      for (const edge of edges) {
        if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
        if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set());
        adjacency.get(edge.from).add(edge.to);
        adjacency.get(edge.to).add(edge.from);
      }

      const kept = new Map();
      for (const node of graph.nodes) {
        if (!filters.includeDeleted && node.deleted) continue;
        const time = node.occurred_at ? new Date(node.occurred_at).getTime() : null;
        if (from !== null && (time === null || time < from)) continue;
        if (to !== null && (time === null || time > to)) continue;
        if (onlyFavorites && !favSet.has(node.id)) continue;
        if (node.kind === 'memory') {
          if (types.size && !types.has(node.type)) continue;
          if (tags.size) {
            const nodeTags = Array.isArray(node.tags) ? node.tags : [];
            const tagNames = node.tag_names || [];
            const match = [...tags].some((tag) => nodeTags.includes(tag) || tagNames.includes(tag));
            if (!match) continue;
          }
          if (projects.size) {
            const neighbors = adjacency.get(node.id) || new Set();
            const match = [...neighbors].some((nid) => projectIds.has(nid) || projects.has(nid));
            if (!match) continue;
          }
        }
        kept.set(node.id, node);
      }

      // 过滤边
      let keptEdges = edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to));

      // 清理悬空实体节点（有筛选时）
      let keptNodes = Array.from(kept.values());
      if (anyFilter) {
        const degree = new Map();
        for (const edge of keptEdges) {
          degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
          degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
        }
        keptNodes = keptNodes.filter((node) => node.kind !== 'entity' || !projectIds.has(node.id) || (degree.get(node.id) || 0) > 0);
        const keptNodeIds = new Set(keptNodes.map((node) => node.id));
        keptEdges = keptEdges.filter((edge) => keptNodeIds.has(edge.from) && keptNodeIds.has(edge.to));
      }

      const keptIds = new Set(keptNodes.map((node) => node.id));
      const clusters = (Array.isArray(graph.clusters) ? graph.clusters : [])
        .map((cluster) => ({
          ...cluster,
          node_ids: (cluster.node_ids || []).filter((id) => keptIds.has(id)),
        }))
        .filter((cluster) => cluster.node_ids.length > 0);

      const degreeMap = new Map();
      for (const edge of keptEdges) {
        degreeMap.set(edge.from, (degreeMap.get(edge.from) || 0) + 1);
        degreeMap.set(edge.to, (degreeMap.get(edge.to) || 0) + 1);
      }

      return {
        ...graph,
        nodes: keptNodes.map((node) => ({ ...node, degree: degreeMap.get(node.id) || 0 })),
        edges: keptEdges,
        clusters,
        stats: {
          ...(graph.stats || {}),
          nodes: keptNodes.length,
          edges: keptEdges.length,
          clusters: clusters.length,
          filtered: true,
          total_nodes: graph.stats ? graph.stats.nodes : graph.nodes.length,
          total_edges: graph.stats ? graph.stats.edges : edges.length,
        },
      };
    },
  };

  // ------------------------------------------------------------ SSE
  const stream = createEventStream({ api, bridge, bus, logger });
  api.events = stream.publicApi;
  api.close = () => {
    stream.close();
  };

  return api;
}

/**
 * SSE 事件流管理（断线重连 + 全量重同步）
 */
function createEventStream({ api, bridge, bus, logger }) {
  const eventHandlers = new Map(); // type -> Set<handler>
  const listenerHandlers = new Set();
  const resyncHandlers = new Set();
  const statusHandlers = new Set();

  let state = 'idle'; // idle|connecting|connected|reconnecting|offline
  let attempts = 0;
  let lastEventId = null;
  let lastSeq = 0;
  let lastFrameAt = 0;
  let reconnectTimer = null;
  let watchdogTimer = null;
  let started = false;
  let bridgeWired = false;
  let detachBridge = null;
  let resyncInFlight = false;
  let lastError = null;

  function statusPayload(extra = {}) {
    return { state, attempts, lastEventId, lastEventSeq: lastSeq, lastEventAt: lastFrameAt || null, error: lastError, ...extra };
  }

  function setState(next) {
    if (state === next) return;
    state = next;
    const payload = statusPayload();
    for (const handler of Array.from(statusHandlers)) {
      try {
        handler(payload);
      } catch (error) {
        console.error('[fca-api] sse status handler error', error);
      }
    }
    if (bus) bus.emit('sse:status', payload);
  }

  function dispatchEvent(payload) {
    const data = payload.data;
    const type = (data && data.type) || payload.event || 'message';
    const seq = Number.isFinite(payload.seq) ? payload.seq : data && Number.isFinite(data.seq) ? data.seq : null;
    lastSeq = Math.max(lastSeq, seq || 0);
    lastFrameAt = Date.now();
    const wrapped = { event: data, type, seq, id: payload.id };
    for (const handler of Array.from(listenerHandlers)) {
      try {
        handler(wrapped);
      } catch (error) {
        console.error('[fca-api] sse listener error', error);
      }
    }
    const typeHandlers = eventHandlers.get(type);
    if (typeHandlers) {
      for (const handler of Array.from(typeHandlers)) {
        try {
          handler(wrapped);
        } catch (error) {
          console.error(`[fca-api] sse ${type} handler error`, error);
        }
      }
    }
    if (bus) bus.emit('sse:event', wrapped);
    if (bus) bus.emit(`sse:${type}`, wrapped);
  }

  async function fullResync(reason) {
    if (resyncInFlight) return;
    resyncInFlight = true;
    const startedAt = Date.now();
    try {
      const [stateData, graph] = await Promise.all([api.getState(), api.getGraph()]);
      const payload = { reason, state: stateData, graph, tookMs: Date.now() - startedAt };
      for (const handler of Array.from(resyncHandlers)) {
        try {
          handler(payload);
        } catch (error) {
          console.error('[fca-api] resync handler error', error);
        }
      }
      if (bus) bus.emit('api:resync', { reason, graph, state: stateData });
    } catch (error) {
      lastError = error;
      if (logger && logger.warn) logger.warn('[fca-api] 全量重同步失败', { reason, message: error.message });
    } finally {
      resyncInFlight = false;
    }
  }

  function scheduleReconnect() {
    if (!started || reconnectTimer) return;
    attempts += 1;
    if (attempts >= 3) setState('offline');
    else setState('reconnecting');
    const delay = Math.min(15000, 1000 * 2 ** Math.min(attempts - 1, 4)) + Math.floor(Math.random() * 250);
    if (logger) logger.info?.(`[fca-api] SSE 将在 ${delay}ms 后重连（第 ${attempts} 次）`);
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (!started) return;
      await connect();
    }, delay);
  }

  function handleStreamPayload(payload) {
    if (!payload) return;
    if (payload.kind === 'status') {
      if (payload.state === 'connected') {
        const wasReconnect = attempts > 0;
        attempts = 0;
        lastError = null;
        lastFrameAt = Date.now();
        setState('connected');
        if (wasReconnect) fullResync('reconnected');
      } else if (payload.state === 'error' || payload.state === 'disconnected') {
        lastError = payload.error || { code: 'SSE_DISCONNECTED', message: 'SSE 连接已断开' };
        scheduleReconnect();
      }
      return;
    }
    if (payload.kind === 'heartbeat') {
      lastFrameAt = Date.now();
      return;
    }
    if (payload.kind === 'event') {
      const seq = Number.isFinite(payload.seq) ? payload.seq : null;
      if (seq !== null && lastSeq > 0 && seq > lastSeq + 1) {
        // 序号缺口：本地可能漏事件 → 全量重同步
        fullResync('seq-gap');
      }
      if (payload.id) lastEventId = payload.id;
      dispatchEvent(payload);
    }
  }

  async function connect() {
    if (!started) return;
    if (!bridge || !bridge.net || typeof bridge.net.streamStart !== 'function') {
      setState('offline');
      lastError = { code: 'BRIDGE_UNAVAILABLE', message: 'SSE 需要 Electron 主进程桥' };
      return;
    }
    setState(attempts > 0 ? 'reconnecting' : 'connecting');
    try {
      const result = await bridge.net.streamStart({ path: '/api/v1/events/stream', lastEventId });
      if (!result || !result.ok) {
        lastError = (result && result.error) || { code: 'SSE_START_FAILED', message: 'SSE 连接启动失败' };
        scheduleReconnect();
      }
    } catch (error) {
      lastError = { code: 'SSE_START_FAILED', message: error.message };
      scheduleReconnect();
    }
  }

  function wireBridge() {
    if (bridgeWired || !bridge || !bridge.net || typeof bridge.net.onStreamEvent !== 'function') return;
    bridgeWired = true;
    detachBridge = bridge.net.onStreamEvent((payload) => handleStreamPayload(payload));
  }

  function ensureWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      if (!started) return;
      if (state === 'connected' && lastFrameAt && Date.now() - lastFrameAt > 40000) {
        if (logger) logger.warn?.('[fca-api] SSE 心跳超时，主动重连');
        lastError = { code: 'SSE_STALE', message: 'SSE 连接假死（心跳超时）' };
        attempts = Math.max(1, attempts);
        if (bridge && bridge.net) bridge.net.streamStop();
        scheduleReconnect();
      }
    }, 10000);
  }

  const publicApi = {
    get state() {
      return state;
    },
    get lastEventSeq() {
      return lastSeq;
    },
    /**
     * 订阅事件流
     * @param {{onEvent?:Function,onStatus?:Function,onResync?:Function}} handlers
     */
    subscribe(handlers = {}) {
      if (typeof handlers.onEvent === 'function') listenerHandlers.add(handlers.onEvent);
      if (typeof handlers.onStatus === 'function') statusHandlers.add(handlers.onStatus);
      if (typeof handlers.onResync === 'function') resyncHandlers.add(handlers.onResync);
      publicApi.start();
      return {
        close() {
          if (typeof handlers.onEvent === 'function') listenerHandlers.delete(handlers.onEvent);
          if (typeof handlers.onStatus === 'function') statusHandlers.delete(handlers.onStatus);
          if (typeof handlers.onResync === 'function') resyncHandlers.delete(handlers.onResync);
        },
      };
    },
    addEventListener(type, handler) {
      if (typeof handler !== 'function') return () => {};
      if (!eventHandlers.has(type)) eventHandlers.set(type, new Set());
      eventHandlers.get(type).add(handler);
      return () => {
        const set = eventHandlers.get(type);
        if (set) set.delete(handler);
      };
    },
    start() {
      if (started) return;
      started = true;
      wireBridge();
      ensureWatchdog();
      connect();
    },
    stop() {
      started = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (bridge && bridge.net && typeof bridge.net.streamStop === 'function') bridge.net.streamStop().catch?.(() => {});
      setState('idle');
    },
    forceResync(reason = 'manual') {
      return fullResync(reason);
    },
  };

  function close() {
    publicApi.stop();
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    if (detachBridge) {
      detachBridge();
      detachBridge = null;
      bridgeWired = false;
    }
    eventHandlers.clear();
    listenerHandlers.clear();
    resyncHandlers.clear();
    statusHandlers.clear();
  }

  return { publicApi, close };
}

export { makeTraceId, sleep as apiSleep };
