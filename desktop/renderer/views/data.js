/**
 * FCA Memory Atlas — 数据管理视图（Desktop Editor 组，Alpha 0.1）
 *
 * 契约：desktop/renderer/lib/contracts.md v1.0 §2/§3/§4/§6；PUBLIC_INTERFACE_FREEZE §4
 * 职责：
 *  - 数据库健康检查（/db/health、/health、/system/status、/state、/db/migrations）
 *  - 备份：列表 / 创建 / 恢复（二次确认）/ 删除
 *  - 导出：全部或按条件（JSON / JSONL / ZIP），文件路径经主进程原生对话框
 *  - 导入：仅支持 FCA 自身导出格式（明确禁止旧记忆系统格式）
 *  - 维护：VACUUM、新建空白库（无重建 API 时如实说明，不伪造成功）
 *  - 运行日志（Runtime 已脱敏）、存储空间统计、打开数据/日志目录
 *  - 所有操作真实调用 Runtime API；错误带 trace id；不做假成功
 */

export const meta = {
  id: 'data',
  title: '数据管理',
  icon: 'database',
  order: 60,
  nav: true,
  shortcut: 'g d',
};

export const DATA_TABS = [
  { id: 'overview', label: '概览与健康' },
  { id: 'backup', label: '备份 / 恢复' },
  { id: 'transfer', label: '导出 / 导入' },
  { id: 'logs', label: '运行日志' },
];

export const EXPORT_FORMATS = [
  { value: 'json', label: 'JSON（单文件）' },
  { value: 'jsonl', label: 'JSONL（逐行）' },
  { value: 'zip', label: 'ZIP（打包）' },
];

export const LOG_LEVELS = [
  { value: '', label: '全部级别' },
  { value: 'error', label: 'error' },
  { value: 'warn', label: 'warn' },
  { value: 'info', label: 'info' },
  { value: 'debug', label: 'debug' },
];

/* ============================================================================
 * 纯函数（单测覆盖）
 * ========================================================================== */

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function asArray(response, keys) {
  if (Array.isArray(response)) return response;
  if (!response || typeof response !== 'object') return [];
  for (const key of keys) if (Array.isArray(response[key])) return response[key];
  return [];
}

/** 备份列表归一化 */
export function normalizeBackups(response) {
  return asArray(response, ['items', 'backups', 'data']).map((item) => ({
    id: item.backup_id || item.id || item.name || null,
    path: item.path || item.file || null,
    size: Number.isFinite(item.size) ? item.size : (Number.isFinite(item.size_bytes) ? item.size_bytes : null),
    createdAt: item.created_at || item.createdAt || null,
    label: item.label || item.name || null,
    raw: item,
  })).filter((item) => item.id);
}

/** 日志响应归一化：数组/字符串/对象行 → [{text, level, raw}] */
export function normalizeLogs(response) {
  const items = asArray(response, ['items', 'logs', 'lines', 'data']);
  if (!items.length && typeof response === 'string') {
    return response.split('\n').filter(Boolean).map((line) => ({ text: line, level: null, raw: line }));
  }
  return items.map((entry) => {
    if (typeof entry === 'string') return { text: entry, level: null, raw: entry };
    const text = logEntryText(entry);
    return { text, level: entry && (entry.level || entry.severity) || null, raw: entry };
  });
}

export function logEntryText(entry) {
  if (!entry || typeof entry !== 'object') return String(entry ?? '');
  const parts = [];
  if (entry.ts || entry.time || entry.timestamp) parts.push(String(entry.ts || entry.time || entry.timestamp));
  if (entry.level) parts.push(`[${entry.level}]`);
  if (entry.scope || entry.module) parts.push(String(entry.scope || entry.module));
  if (entry.message || entry.msg) parts.push(String(entry.message || entry.msg));
  if (!parts.length) {
    try {
      return JSON.stringify(entry);
    } catch {
      return '[不可序列化日志]';
    }
  }
  const trailer = entry.trace_id ? ` trace=${entry.trace_id}` : '';
  return `${parts.join(' ')}${trailer}`;
}

/** 迁移列表归一化 */
export function normalizeMigrations(response) {
  const items = asArray(response, ['items', 'migrations', 'data']);
  if (Array.isArray(response)) return response;
  return items;
}

/** 数据库健康摘要（纯函数） */
export function describeDbHealth(health) {
  if (!health || typeof health !== 'object') return { ok: null, integrity: null, message: '未获取数据库健康信息', counts: null };
  const integrity = health.integrity_check || health.integrity || health.integrityCheck || (health.db === 'ok' ? 'ok' : null);
  const ok = health.ok === undefined ? (integrity === 'ok' || integrity === 'success' || integrity === true) : Boolean(health.ok);
  const counts = health.counts || null;
  let message;
  if (ok) message = '数据库完整性检查通过';
  else if (integrity) message = `数据库检查异常：${String(integrity)}`;
  else message = '数据库健康信息不完整（Runtime 未返回完整性字段）';
  return { ok, integrity, message, counts };
}

/** 导出 payload（纯函数） */
export function buildExportPayload(form, storeFilters) {
  const payload = { format: form.format || 'json' };
  if (form.scope === 'filtered') {
    payload.filters = buildExportFilters(storeFilters || {}, form);
  }
  if (form.path) payload.path = form.path;
  return payload;
}

/** 桌面筛选状态 → Runtime export filters（纯函数） */
export function buildExportFilters(storeFilters, form) {
  const out = {};
  const filters = storeFilters || {};
  if (Array.isArray(filters.types) && filters.types.length) out.types = filters.types.slice();
  if (Array.isArray(filters.tags) && filters.tags.length) out.tags = filters.tags.slice();
  if (Array.isArray(filters.projects) && filters.projects.length) out.projects = filters.projects.slice();
  const range = filters.timeRange || {};
  let from = range.from || null;
  let to = range.to || null;
  if (form && form.from) from = new Date(`${form.from}T00:00:00`).toISOString();
  if (form && form.to) to = new Date(`${form.to}T23:59:59.999`).toISOString();
  if (from) out.occurred_from = from;
  if (to) out.occurred_to = to;
  if (filters.includeDeleted || (form && form.includeDeleted)) out.include_deleted = true;
  return out;
}

/** 从文件路径猜测格式 */
export function guessFormatFromPath(filePath) {
  const text = String(filePath || '').toLowerCase();
  if (text.endsWith('.jsonl') || text.endsWith('.ndjson')) return 'jsonl';
  if (text.endsWith('.zip')) return 'zip';
  if (text.endsWith('.json')) return 'json';
  return null;
}

/** 存储统计摘要（纯函数）：从 /system/status 与 /db/health 中提取可展示字段，不虚构字段 */
export function storageSummary(systemStatus, dbHealth) {
  const rows = [];
  const sys = systemStatus && typeof systemStatus === 'object' ? systemStatus : {};
  const storage = sys.storage && typeof sys.storage === 'object' ? sys.storage : null;
  if (storage) {
    const mapping = {
      db_bytes: '数据库文件',
      database_bytes: '数据库文件',
      backups_bytes: '备份目录',
      events_bytes: '事件日志',
      logs_bytes: '运行日志',
      total_bytes: '总计',
      free_bytes: '磁盘可用',
    };
    for (const [key, label] of Object.entries(mapping)) {
      if (storage[key] !== undefined && storage[key] !== null) rows.push({ label, value: formatBytes(storage[key]), raw: storage[key] });
    }
  }
  if (dbHealth && typeof dbHealth === 'object') {
    const size = dbHealth.size_bytes ?? dbHealth.file_size ?? dbHealth.db_size;
    if (size !== undefined && size !== null && !rows.some((r) => r.label === '数据库文件')) rows.push({ label: '数据库文件', value: formatBytes(size), raw: size });
  }
  if (sys.disk && typeof sys.disk === 'object' && sys.disk.free_bytes !== undefined) {
    rows.push({ label: '磁盘可用', value: formatBytes(sys.disk.free_bytes), raw: sys.disk.free_bytes });
  }
  return rows;
}

/** 计数摘要（/state.counts） */
export function countsSummary(stateData) {
  const counts = stateData && (stateData.counts || stateData.stats);
  if (!counts || typeof counts !== 'object') return [];
  const labels = {
    memories: '记忆',
    entities: '实体',
    relations: '关系',
    tags: '标签',
    events: '事件',
    versions: '版本记录',
    memories_deleted: '回收站记忆',
  };
  const rows = [];
  for (const [key, label] of Object.entries(labels)) {
    if (counts[key] !== undefined && counts[key] !== null) rows.push({ label, value: String(counts[key]) });
  }
  return rows;
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

  const state = {
    tab: 'overview',
    loading: {},
    errors: {},
    health: null,
    dbHealth: null,
    systemStatus: null,
    stateData: null,
    migrations: null,
    backups: [],
    backupsLoading: false,
    backupsError: null,
    logState: { items: [], loading: false, error: null, level: '', limit: 300 },
    exportForm: { format: 'json', scope: 'all', from: '', to: '', path: null, includeDeleted: false },
    importState: { path: null, busy: false, error: null, result: null },
    busy: null,
    lastRefreshAt: null,
    devFixture: false,
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
      class: `view-data__btn view-data__btn--${opts.variant || 'secondary'}${opts.size === 'sm' ? ' view-data__btn--sm' : ''}`,
      disabled: Boolean(opts.disabled || opts.loading),
      title: opts.title || '',
      'data-testid': opts.testid || null,
      on: { click: (event) => opts.onClick && opts.onClick(event) },
    }, [opts.icon ? icon(opts.icon) : null, opts.label ? el('span', { text: opts.label }) : null, opts.loading ? el('span', { class: 'view-data__spinner-sm' }) : null]);
  }

  function formatTime(iso) {
    if (!iso) return '—';
    try {
      if (ctx.format && typeof ctx.format.datetime === 'function') return ctx.format.datetime(iso);
    } catch {
      /* noop */
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function bridge() {
    return typeof window !== 'undefined' && window.fca ? window.fca : null;
  }

  function runtimeState() {
    try {
      const storeState = ctx.store && typeof ctx.store.getState === 'function' ? ctx.store.getState() : null;
      return (storeState && storeState.runtime) || null;
    } catch {
      return null;
    }
  }

  function appSettings() {
    try {
      const storeState = ctx.store && typeof ctx.store.getState === 'function' ? ctx.store.getState() : null;
      return (storeState && storeState.settings) || null;
    } catch {
      return null;
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

  async function loadOverview() {
    state.loading.overview = true;
    state.errors.overview = null;
    renderContent();
    const tasks = [
      ['health', () => api.health()],
      ['stateData', () => api.getState()],
      ['dbHealth', () => api.getDbHealth()],
      ['systemStatus', () => api.getSystemStatus()],
      ['migrations', () => api.getMigrations()],
    ];
    const errors = {};
    await Promise.all(tasks.map(async ([key, run]) => {
      try {
        state[key] = await run();
      } catch (err) {
        errors[key] = errInfo(err);
      }
    }));
    state.loading.overview = false;
    state.errors.overview = Object.keys(errors).length ? errors : null;
    state.lastRefreshAt = new Date().toISOString();
    renderContent();
    updateStatus();
  }

  async function loadBackups() {
    state.backupsLoading = true;
    state.backupsError = null;
    renderContent();
    try {
      const res = await api.listBackups();
      state.backups = normalizeBackups(res);
      state.backupsLoading = false;
      renderContent();
    } catch (err) {
      state.backupsLoading = false;
      state.backupsError = errInfo(err);
      renderContent();
    }
  }

  async function loadLogs() {
    state.logState.loading = true;
    state.logState.error = null;
    renderContent();
    try {
      const params = { limit: state.logState.limit };
      if (state.logState.level) params.level = state.logState.level;
      const res = await api.getLogs(params);
      state.logState.items = normalizeLogs(res);
      state.logState.loading = false;
      renderContent();
    } catch (err) {
      state.logState.loading = false;
      state.logState.error = errInfo(err);
      renderContent();
    }
  }

  /* -------------------------------- 渲染 -------------------------------- */

  function mount(container) {
    styleEl = doc.createElement('style');
    styleEl.id = 'view-data-style';
    styleEl.textContent = DATA_CSS;
    doc.head.append(styleEl);
    root = el('div', { class: 'view-data', 'data-testid': 'view-data' });
    container.append(root);
    render();
    loadOverview();
    subscribeMany(['sse:backup.created', 'sse:backup.deleted', 'sse:restore.completed', 'sse:db.initialized', 'sse:db.migrated', 'sse:db.vacuumed', 'api:resync'], () => {
      if (state.tab === 'backup') loadBackups();
      else loadOverview();
    });
  }

  function render() {
    if (!root) return;
    root.textContent = '';
    root.append(renderHeader());
    const tabs = el('div', { class: 'view-data__tabs', role: 'tablist' });
    for (const tab of DATA_TABS) {
      tabs.append(el('button', {
        type: 'button',
        role: 'tab',
        class: `view-data__tab${state.tab === tab.id ? ' is-active' : ''}`,
        'aria-selected': String(state.tab === tab.id),
        'data-testid': `data-tab-${tab.id}`,
        text: tab.label,
        on: {
          click: () => {
            state.tab = tab.id;
            render();
            if (tab.id === 'backup' && !state.backups.length) loadBackups();
            if (tab.id === 'logs' && !state.logState.items.length) loadLogs();
          },
        },
      }));
    }
    root.append(tabs);
    root.append(renderRuntimeHint());
    dom.content = el('div', { class: 'view-data__content fca-scroll', 'data-testid': 'data-content' });
    root.append(dom.content);
    renderContent();
  }

  function renderHeader() {
    return el('div', { class: 'view-data__bar' }, [
      el('div', { class: 'view-data__title' }, [
        el('h2', { text: '数据管理' }),
        el('span', { class: 'view-data__sub', text: state.lastRefreshAt ? `最近检查 ${formatTime(state.lastRefreshAt)}` : '本机 Runtime 数据' }),
      ]),
      el('div', { class: 'view-data__actions' }, [
        bridge() ? button({ label: '打开数据目录', icon: 'folder', variant: 'ghost', onClick: () => openPath('data') }) : null,
        bridge() ? button({ label: '打开日志目录', icon: 'folder', variant: 'ghost', onClick: () => openPath('logs') }) : null,
        button({ label: '刷新', icon: 'refresh', variant: 'ghost', loading: state.loading.overview, onClick: () => { if (state.tab === 'backup') loadBackups(); else if (state.tab === 'logs') loadLogs(); else loadOverview(); } }),
      ]),
    ]);
  }

  function renderRuntimeHint() {
    const runtime = runtimeState();
    const settings = appSettings();
    const host = el('div', { class: 'view-data__runtime' });
    if (!runtime) {
      host.append(el('span', { class: 'view-data__unavailable', text: '未获取到外壳 Runtime 状态（非桌面环境或外壳未就绪）' }));
      return host;
    }
    const tone = runtime.state === 'running' ? 'ok' : runtime.state === 'unhealthy' ? 'warn' : 'error';
    host.append(
      el('span', { class: `view-data__dot view-data__dot--${tone}` }),
      el('span', { text: `Runtime：${runtime.state}` }),
      runtime.version ? el('span', { class: 'view-data__muted', text: `v${runtime.version} · API v${runtime.apiVersion || '?'}` }) : null,
      el('span', { class: 'view-data__muted view-data__mono', text: runtime.url || '' }),
      settings && settings.dataDir ? el('span', { class: 'view-data__muted', text: `数据目录：${settings.dataDir}` }) : null,
      runtime.lastError ? el('span', { class: 'view-data__unavailable', text: `最近错误：${runtime.lastError.message || runtime.lastError.code}` }) : null,
    );
    return host;
  }

  function renderContent() {
    if (!dom.content) return;
    dom.content.textContent = '';
    if (state.tab === 'overview') renderOverview(dom.content);
    else if (state.tab === 'backup') renderBackup(dom.content);
    else if (state.tab === 'transfer') renderTransfer(dom.content);
    else renderLogs(dom.content);
  }

  function card(title, body, opts = {}) {
    return el('section', { class: 'view-data__card' }, [
      el('div', { class: 'view-data__card-head' }, [
        el('h3', { class: 'view-data__card-title', text: title }),
        opts.actions ? el('div', { class: 'view-data__inline' }, Array.isArray(opts.actions) ? opts.actions : [opts.actions]) : null,
      ]),
      body,
    ]);
  }

  function errorBlock(title, error, onRetry) {
    return el('div', { class: 'view-data__errorbox', role: 'alert' }, [
      el('div', { class: 'view-data__errorbox-title', text: title }),
      el('div', { class: 'view-data__errorbox-detail', text: `${error.message}${error.traceId ? ` · trace ${error.traceId}` : ''}` }),
      onRetry ? button({ label: '重试', icon: 'refresh', size: 'sm', onClick: onRetry }) : null,
    ]);
  }

  function kvRows(rows) {
    if (!rows || !rows.length) return el('div', { class: 'view-data__muted', text: 'Runtime 未返回该组字段' });
    const host = el('div', { class: 'view-data__kv' });
    for (const row of rows) {
      host.append(el('div', { class: 'view-data__kv-row' }, [
        el('span', { class: 'view-data__kv-label', text: row.label }),
        el('span', { class: `view-data__kv-value${row.mono ? ' view-data__mono' : ''}`, text: row.value }),
      ]));
    }
    return host;
  }

  function renderOverview(host) {
    if (state.loading.overview && !state.health && !state.dbHealth) {
      host.append(el('div', { class: 'view-data__loading' }, [el('div', { class: 'view-data__spinner' }), el('div', { text: '正在检查数据库与 Runtime 状态…' })]));
      return;
    }
    const health = state.health;
    const dbHealth = state.dbHealth;
    const described = describeDbHealth(dbHealth);
    const runtime = runtimeState();

    // 健康卡
    const healthRows = [
      { label: 'Runtime 状态', value: health && health.status ? String(health.status) : (runtime ? runtime.state : '未知') },
      { label: 'API 版本', value: health && health.api_version ? String(health.api_version) : (runtime && runtime.apiVersion ? String(runtime.apiVersion) : '—') },
      { label: '版本', value: health && health.version ? String(health.version) : (runtime && runtime.version ? String(runtime.version) : '—') },
      { label: '运行时长', value: health && Number.isFinite(health.uptime_ms) ? `${Math.round(health.uptime_ms / 1000)} 秒` : '—' },
      { label: '数据库已初始化', value: health && health.initialized !== undefined ? (health.initialized ? '是' : '否') : '—' },
      { label: '数据库状态', value: health && health.db ? String(health.db) : '—' },
    ];
    const healthCard = card('数据库健康', el('div', {}, [
      state.errors.overview
        ? el('div', { class: 'view-data__warn' }, [errorBlock('部分接口读取失败', Object.values(state.errors.overview)[0], () => loadOverview())])
        : el('div', { class: `view-data__notice view-data__notice--${described.ok ? 'ok' : described.ok === false ? 'rose' : 'gold'}` }, [
          el('span', { class: `view-data__dot view-data__dot--${described.ok ? 'ok' : described.ok === false ? 'error' : 'warn'}` }),
          el('span', { text: described.message }),
          described.integrity ? el('span', { class: 'view-data__muted view-data__mono', text: `integrity_check=${String(described.integrity)}` }) : null,
        ]),
      kvRows(healthRows),
      el('div', { class: 'view-data__inline view-data__card-actions' }, [
        button({ label: '刷新检查', icon: 'refresh', size: 'sm', loading: state.loading.overview, onClick: () => loadOverview() }),
        button({ label: '完整性检查 / VACUUM', icon: 'database', size: 'sm', onClick: () => vacuum() }),
        bridge() ? button({ label: '重启 Runtime', icon: 'refresh', size: 'sm', variant: 'ghost', onClick: () => restartRuntime() }) : null,
      ]),
    ]));

    // 计数卡
    const counts = countsSummary(state.stateData);
    const countsCard = card('数据规模', counts.length ? kvRows(counts) : el('div', { class: 'view-data__muted', text: 'Runtime /state 未返回计数信息' }));

    // 存储卡
    const storage = storageSummary(state.systemStatus, state.dbHealth);
    const storageCard = card('存储空间', el('div', {}, [
      storage.length ? kvRows(storage) : el('div', { class: 'view-data__muted', text: 'Runtime /system/status 未返回 storage 字段（Alpha 0.1 不做伪造估算）' }),
      state.systemStatus && state.systemStatus.gpu
        ? el('div', { class: 'view-data__muted', text: `GPU：${state.systemStatus.gpu.name || state.systemStatus.gpu.model || '已探测'}${state.systemStatus.gpu.memory_mb ? ` · ${state.systemStatus.gpu.memory_mb} MiB` : ''}` })
        : el('div', { class: 'view-data__muted', text: 'GPU 信息：Runtime 未返回（nvidia-smi 不可用或已降级）' }),
    ]));

    // 维护卡
    const initialized = health ? health.initialized !== false : null;
    const maintenance = card('维护操作', el('div', { class: 'view-data__list' }, [
      el('div', { class: 'view-data__row' }, [
        el('div', { class: 'view-data__row-main' }, [
          el('div', { text: '新建空白库' }),
          el('div', { class: 'view-data__muted', text: initialized === false ? '当前数据库尚未初始化，可直接初始化空库（不导入任何旧记忆）。' : '已初始化。Alpha 0.1 的冻结 API 没有 drop/recreate 端点；如需全新库，请在设置中更换数据目录后重启应用。' }),
        ]),
        button({
          label: initialized === false ? '初始化空库' : '不可用',
          icon: 'database',
          size: 'sm',
          variant: initialized === false ? 'primary' : 'ghost',
          disabled: initialized !== false,
          testid: 'data-init-db',
          onClick: () => initEmptyDb(),
        }),
      ]),
      el('div', { class: 'view-data__row' }, [
        el('div', { class: 'view-data__row-main' }, [
          el('div', { text: '数据库迁移版本' }),
          el('div', { class: 'view-data__muted', text: '展示 Runtime 已应用的 schema 迁移；迁移由 Runtime 启动时自动执行，桌面端不直接修改数据库。' }),
        ]),
        el('span', { class: 'view-data__muted', text: Array.isArray(state.migrations) ? `${state.migrations.length} 条` : '—' }),
      ]),
      migrationTable(state.migrations),
    ]));

    host.append(el('div', { class: 'view-data__grid' }, [healthCard, countsCard, storageCard, maintenance]));
    if (state.devFixture) host.append(el('div', { class: 'view-data__unavailable', text: '开发夹具模式：当前为 dev-only 数据，非生产数据。' }));
  }

  function migrationTable(migrations) {
    if (!Array.isArray(migrations) || !migrations.length) {
      return state.errors.overview && state.errors.overview.migrations
        ? el('div', { class: 'view-data__muted', text: `迁移信息不可用：${state.errors.overview.migrations.message}` })
        : el('div', { class: 'view-data__muted', text: 'Runtime 未返回迁移列表' });
    }
    const table = el('div', { class: 'view-data__table' });
    table.append(el('div', { class: 'view-data__table-head' }, [
      el('span', { text: '版本' }),
      el('span', { text: '名称' }),
      el('span', { text: '应用时间' }),
    ]));
    for (const row of migrations.slice(0, 30)) {
      table.append(el('div', { class: 'view-data__table-row' }, [
        el('span', { class: 'view-data__mono', text: String(row.version ?? row.id ?? '—') }),
        el('span', { text: String(row.name || row.description || '—') }),
        el('span', { class: 'view-data__muted', text: formatTime(row.applied_at || row.created_at) }),
      ]));
    }
    return table;
  }

  function renderBackup(host) {
    const head = el('div', { class: 'view-data__card-head' }, [
      el('div', {}, [
        el('h3', { class: 'view-data__card-title', text: '数据库备份' }),
        el('div', { class: 'view-data__muted', text: '备份由 Runtime 通过 VACUUM INTO / 文件复制创建并校验；恢复前会校验备份完整性。' }),
      ]),
      el('div', { class: 'view-data__inline' }, [
        button({ label: '创建备份', icon: 'save', variant: 'primary', testid: 'data-create-backup', loading: state.busy === 'create-backup', onClick: () => createBackup() }),
        button({ label: '刷新', icon: 'refresh', variant: 'ghost', size: 'sm', loading: state.backupsLoading, onClick: () => loadBackups() }),
      ]),
    ]);
    const body = el('div', { class: 'view-data__list' });
    if (state.backupsLoading) body.append(el('div', { class: 'view-data__muted', text: '正在读取备份列表…' }));
    else if (state.backupsError) body.append(errorBlock('备份列表读取失败', state.backupsError, () => loadBackups()));
    else if (!state.backups.length) {
      body.append(el('div', { class: 'view-data__empty', 'data-testid': 'data-backup-empty' }, [
        el('div', { class: 'view-data__empty-title', text: '还没有备份' }),
        el('div', { class: 'view-data__empty-desc', text: '建议在导入、批量修改或升级前创建一次备份。' }),
      ]));
    } else {
      for (const backup of state.backups) {
        body.append(el('div', { class: 'view-data__row', 'data-testid': `data-backup-${backup.id}` }, [
          el('div', { class: 'view-data__row-main' }, [
            el('div', { class: 'view-data__mono', text: backup.id }),
            el('div', { class: 'view-data__muted', text: `${formatTime(backup.createdAt)} · ${backup.size == null ? '大小未知' : formatBytes(backup.size)}${backup.path ? ` · ${backup.path}` : ''}` }),
          ]),
          el('div', { class: 'view-data__inline' }, [
            button({ label: '恢复', icon: 'history', size: 'sm', testid: `data-restore-${backup.id}`, onClick: () => restoreBackup(backup) }),
            button({ label: '删除', icon: 'trash', size: 'sm', variant: 'danger', onClick: () => deleteBackup(backup) }),
          ]),
        ]));
      }
    }
    host.append(card('备份 / 恢复', el('div', {}, [head, body])));
  }

  function renderTransfer(host) {
    const form = state.exportForm;
    const formatSelect = el('select', {
      class: 'view-data__select',
      'data-testid': 'data-export-format',
      'aria-label': '导出格式',
      on: { change: (event) => { form.format = event.target.value; renderContent(); } },
    });
    for (const format of EXPORT_FORMATS) {
      const option = el('option', { value: format.value, text: format.label });
      if (format.value === form.format) option.selected = true;
      formatSelect.append(option);
    }
    const scopeSelect = el('select', {
      class: 'view-data__select',
      'aria-label': '导出范围',
      on: { change: (event) => { form.scope = event.target.value; renderContent(); } },
    });
    scopeSelect.append(el('option', { value: 'all', text: '全部记忆与关系' }));
    scopeSelect.append(el('option', { value: 'filtered', text: '按条件导出（当前桌面筛选 + 时间范围）' }));
    scopeSelect.value = form.scope;
    const fromInput = el('input', { class: 'view-data__input view-data__input--date', type: 'date', value: form.from, 'data-testid': 'data-export-from', on: { change: (e) => { form.from = e.target.value; } } });
    const toInput = el('input', { class: 'view-data__input view-data__input--date', type: 'date', value: form.to, 'data-testid': 'data-export-to', on: { change: (e) => { form.to = e.target.value; } } });
    const includeDeleted = el('label', { class: 'view-data__check' }, [
      el('input', { type: 'checkbox', checked: form.includeDeleted, on: { change: (e) => { form.includeDeleted = e.target.checked; } } }),
      el('span', { text: '包含回收站记忆' }),
    ]);
    const pathRow = el('div', { class: 'view-data__inline' }, [
      el('span', { class: 'view-data__muted', text: form.path || '路径：由 Runtime 默认导出目录决定' }),
      bridge() ? button({ label: '选择保存位置…', icon: 'export', size: 'sm', onClick: () => chooseExportPath() }) : el('span', { class: 'view-data__muted', text: '（非桌面环境不可选择路径）' }),
    ]);
    const storeFilters = (() => {
      try {
        const s = ctx.store && typeof ctx.store.getState === 'function' ? ctx.store.getState() : null;
        return (s && s.filters) || {};
      } catch {
        return {};
      }
    })();
    const exportCard = card('导出', el('div', { class: 'view-data__form' }, [
      el('div', { class: 'view-data__form-row' }, [el('span', { class: 'view-data__label', text: '格式' }), formatSelect]),
      el('div', { class: 'view-data__form-row' }, [el('span', { class: 'view-data__label', text: '范围' }), scopeSelect]),
      form.scope === 'filtered'
        ? el('div', { class: 'view-data__form-row' }, [
          el('span', { class: 'view-data__label', text: '时间' }),
          fromInput, el('span', { class: 'view-data__muted', text: '至' }), toInput, includeDeleted,
        ])
        : null,
      form.scope === 'filtered'
        ? el('div', { class: 'view-data__muted', text: `将应用桌面当前筛选：类型 ${(storeFilters.types || []).join('/') || '全部'} · 标签 ${(storeFilters.tags || []).length} 个 · 项目 ${(storeFilters.projects || []).length} 个` })
        : null,
      pathRow,
      el('div', { class: 'view-data__inline' }, [
        button({ label: '开始导出', icon: 'export', variant: 'primary', testid: 'data-export-run', loading: state.busy === 'export', onClick: () => runExport() }),
      ]),
    ]));

    const importCard = card('导入', el('div', { class: 'view-data__form' }, [
      el('div', { class: 'view-data__notice view-data__notice--gold' }, [
        el('span', { text: '仅支持 FCA Memory Atlas 自身导出的 JSON / JSONL / ZIP 格式。' }),
        el('span', { class: 'view-data__muted', text: '出于数据安全与合规要求，Alpha 0.1 明确禁止导入旧记忆系统格式，也不做旧库迁移。' }),
      ]),
      el('div', { class: 'view-data__inline' }, [
        el('span', { class: 'view-data__muted', text: state.importState.path || '尚未选择导入文件' }),
        bridge() ? button({ label: '选择 FCA 导出文件…', icon: 'import', size: 'sm', onClick: () => chooseImportFile() }) : el('span', { class: 'view-data__muted', text: '（非桌面环境无法选择文件）' }),
        button({
          label: '开始导入',
          icon: 'import',
          variant: 'primary',
          testid: 'data-import-run',
          loading: state.importState.busy,
          disabled: !state.importState.path,
          onClick: () => runImport(),
        }),
      ]),
      state.importState.error ? errorBlock('导入失败', state.importState.error) : null,
      state.importState.result
        ? el('div', { class: 'view-data__notice view-data__notice--ok' }, [
          el('span', { text: '导入完成' }),
          el('span', { class: 'view-data__muted view-data__mono', text: JSON.stringify(state.importState.result) }),
        ])
        : null,
      el('div', { class: 'view-data__muted', text: '导入为幂等写操作：Runtime 按 FCA 导出格式校验并写入，重复导入不会产生重复记忆（以 Runtime 实现为准）。' }),
    ]));
    host.append(el('div', { class: 'view-data__grid' }, [exportCard, importCard]));
  }

  function renderLogs(host) {
    const levelSelect = el('select', {
      class: 'view-data__select',
      'data-testid': 'data-logs-level',
      'aria-label': '日志级别',
      on: {
        change: (event) => {
          state.logState.level = event.target.value;
          loadLogs();
        },
      },
    });
    for (const level of LOG_LEVELS) {
      const option = el('option', { value: level.value, text: level.label });
      if (level.value === state.logState.level) option.selected = true;
      levelSelect.append(option);
    }
    const actions = el('div', { class: 'view-data__inline' }, [
      levelSelect,
      button({ label: '刷新日志', icon: 'refresh', size: 'sm', loading: state.logState.loading, testid: 'data-logs-refresh', onClick: () => loadLogs() }),
      bridge() ? button({ label: '打开日志目录', icon: 'folder', size: 'sm', variant: 'ghost', onClick: () => openPath('logs') }) : null,
    ]);
    const body = el('div', { class: 'view-data__logs', 'data-testid': 'data-logs' });
    if (state.logState.loading) body.append(el('div', { class: 'view-data__muted', text: '正在读取运行日志…' }));
    else if (state.logState.error) body.append(errorBlock('日志读取失败', state.logState.error, () => loadLogs()));
    else if (!state.logState.items.length) body.append(el('div', { class: 'view-data__muted', text: '暂无日志（或 Runtime 未返回日志条目）。' }));
    else {
      for (const item of state.logState.items.slice(-state.logState.limit)) {
        const level = String(item.level || '').toLowerCase();
        body.append(el('div', { class: `view-data__log-line${level ? ` view-data__log-line--${level}` : ''}`, text: item.text }));
      }
    }
    host.append(card('运行日志（已脱敏）', el('div', {}, [
      el('div', { class: 'view-data__muted', text: '日志来自 GET /api/v1/logs，Runtime 已对 token / 密钥等敏感字段脱敏。最多展示 300 行。' }),
      actions,
      body,
    ])));
  }

  /* ------------------------------- 操作 ------------------------------- */

  async function confirmAction(opts) {
    try {
      if (ctx.dialogs && typeof ctx.dialogs.confirm === 'function') return await ctx.dialogs.confirm(opts);
      return window.confirm(`${opts.title}\n\n${opts.message || ''}`);
    } catch {
      return false;
    }
  }

  async function createBackup() {
    if (state.busy) return;
    const ok = await confirmAction({ title: '创建数据库备份？', message: 'Runtime 将创建一份完整备份并校验。备份会占用磁盘空间。', confirmLabel: '创建备份' });
    if (!ok) return;
    state.busy = 'create-backup';
    renderContent();
    try {
      const res = await api.createBackup();
      notify('success', `备份已创建：${(res && (res.backup_id || res.id)) || '完成'}`);
      state.busy = null;
      await loadBackups();
    } catch (err) {
      state.busy = null;
      const info = errInfo(err);
      notify('error', `创建备份失败：${info.message}`);
      renderContent();
    }
  }

  async function restoreBackup(backup) {
    const first = await confirmAction({
      title: '恢复备份（第一步确认）',
      message: `将把数据库恢复为备份 ${backup.id}（${formatTime(backup.createdAt)}）。当前数据可能被覆盖，请先创建新备份。`,
      confirmLabel: '继续',
      danger: true,
    });
    if (!first) return;
    const second = await confirmAction({
      title: '恢复备份（第二步确认）',
      message: '请再次确认：恢复操作会替换当前数据库内容。恢复前 Runtime 会校验备份完整性；失败时数据库不会被修改。',
      confirmLabel: '确认恢复',
      danger: true,
    });
    if (!second) return;
    state.busy = 'restore';
    renderContent();
    try {
      const res = await api.restoreBackup(backup.id);
      state.busy = null;
      const requiresRestart = Boolean(res && (res.requires_restart || res.requiresRestart));
      notify('success', requiresRestart ? '备份已恢复；需要重启 Runtime 生效' : '备份已恢复');
      renderContent();
      if (requiresRestart) {
        const restart = await confirmAction({ title: '需要重启 Runtime', message: '恢复已完成，但 Runtime 需要重启以加载恢复后的数据库。现在重启？', confirmLabel: '重启 Runtime' });
        if (restart) await restartRuntime();
      }
      await loadOverview();
    } catch (err) {
      state.busy = null;
      const info = errInfo(err);
      notify('error', `恢复失败：${info.message}（数据库未被修改）`);
      renderContent();
    }
  }

  async function deleteBackup(backup) {
    const ok = await confirmAction({ title: '删除备份？', message: `将删除备份 ${backup.id}。该操作不可恢复。`, confirmLabel: '删除备份', danger: true });
    if (!ok) return;
    try {
      await api.deleteBackup(backup.id);
      notify('success', '备份已删除');
      loadBackups();
    } catch (err) {
      notify('error', `删除备份失败：${errInfo(err).message}`);
    }
  }

  async function vacuum() {
    const ok = await confirmAction({
      title: '执行数据库完整性检查与 VACUUM？',
      message: 'Runtime 将执行 PRAGMA integrity_check 并压缩数据库文件（期间可能有短暂写锁）。',
      confirmLabel: '执行',
    });
    if (!ok) return;
    state.busy = 'vacuum';
    renderContent();
    try {
      const res = await api.vacuumDb();
      state.busy = null;
      notify('success', `数据库维护完成${res && res.after_bytes ? `（${formatBytes(res.before_bytes)} → ${formatBytes(res.after_bytes)}）` : ''}`);
      await loadOverview();
    } catch (err) {
      state.busy = null;
      notify('error', `维护失败：${errInfo(err).message}`);
      renderContent();
    }
  }

  async function initEmptyDb() {
    const ok = await confirmAction({
      title: '初始化空白数据库？',
      message: '将创建一个全新的空库，不导入、不迁移任何旧记忆。此操作幂等；若数据库已初始化不会清空数据。',
      confirmLabel: '初始化空库',
    });
    if (!ok) return;
    try {
      await api.initDb();
      notify('success', '空库已初始化');
      loadOverview();
    } catch (err) {
      notify('error', `初始化失败：${errInfo(err).message}`);
    }
  }

  async function restartRuntime() {
    const b = bridge();
    if (!b || !b.runtime || typeof b.runtime.restart !== 'function') {
      notify('warn', '当前外壳未提供 Runtime 控制桥（window.fca.runtime.restart），请在状态栏或对话框操作');
      return;
    }
    try {
      const res = await b.runtime.restart();
      if (res && res.ok) notify('success', 'Runtime 已重启');
      else notify('error', `Runtime 重启失败：${(res && res.error && (res.error.message || res.error.code)) || '未知原因'}`);
      loadOverview();
    } catch (err) {
      notify('error', `Runtime 重启失败：${errInfo(err).message}`);
    }
  }

  async function chooseExportPath() {
    const b = bridge();
    if (!b || !b.dialog || typeof b.dialog.saveFile !== 'function') {
      notify('warn', '当前外壳未提供原生文件对话框；将使用 Runtime 默认导出目录');
      return;
    }
    try {
      const ext = state.exportForm.format;
      const res = await b.dialog.saveFile({
        title: '选择导出文件保存位置',
        defaultPath: `fca-export.${ext}`,
        filters: [{ name: 'FCA 导出文件', extensions: [ext] }],
      });
      if (res && res.ok && res.path) {
        state.exportForm.path = res.path;
        renderContent();
      }
    } catch (err) {
      notify('error', `选择路径失败：${errInfo(err).message}`);
    }
  }

  async function chooseImportFile() {
    const b = bridge();
    if (!b || !b.dialog || typeof b.dialog.openFile !== 'function') {
      notify('warn', '当前外壳未提供原生文件对话框，无法选择导入文件');
      return;
    }
    try {
      const res = await b.dialog.openFile({
        title: '选择 FCA 导出文件（json/jsonl/zip）',
        filters: [
          { name: 'FCA 导出文件', extensions: ['json', 'jsonl', 'ndjson', 'zip'] },
          { name: '全部文件', extensions: ['*'] },
        ],
      });
      if (res && res.ok && Array.isArray(res.paths) && res.paths[0]) {
        state.importState.path = res.paths[0];
        state.importState.error = null;
        renderContent();
      }
    } catch (err) {
      notify('error', `选择文件失败：${errInfo(err).message}`);
    }
  }

  async function runExport() {
    if (state.busy) return;
    state.busy = 'export';
    renderContent();
    try {
      const storeFilters = (() => {
        try {
          const s = ctx.store && typeof ctx.store.getState === 'function' ? ctx.store.getState() : null;
          return (s && s.filters) || {};
        } catch {
          return {};
        }
      })();
      const payload = buildExportPayload(state.exportForm, storeFilters);
      const res = await api.exportData(payload);
      state.busy = null;
      const pathText = res && (res.path || res.file || res.output);
      notify('success', `导出完成${pathText ? `：${pathText}` : ''}`);
      renderContent();
      if (pathText) {
        const host = dom.content && dom.content.querySelector('.view-data__grid');
        if (host) {
          host.append(el('div', { class: 'view-data__notice view-data__notice--ok' }, [
            el('span', { text: `导出文件：${pathText}` }),
            bridge() && window.fca.app.showItemInFolder
              ? button({ label: '打开所在目录', icon: 'folder', size: 'sm', onClick: () => window.fca.app.showItemInFolder(pathText) })
              : null,
          ]));
        }
      }
    } catch (err) {
      state.busy = null;
      const info = errInfo(err);
      notify('error', `导出失败：${info.message}`);
      renderContent();
      const grid = dom.content && dom.content.querySelector('.view-data__grid');
      if (grid) grid.append(errorBlock('导出失败', info, () => runExport()));
    }
  }

  async function runImport() {
    const importPath = state.importState.path;
    if (!importPath) {
      notify('warn', '请先选择导入文件');
      return;
    }
    const format = guessFormatFromPath(importPath);
    const ok = await confirmAction({
      title: '导入 FCA 导出数据？',
      message: `将从 ${importPath} 导入。仅支持 FCA 自身导出格式；导入前建议先创建备份。`,
      confirmLabel: '开始导入',
    });
    if (!ok) return;
    state.importState.busy = true;
    state.importState.error = null;
    renderContent();
    try {
      let res;
      try {
        res = await api.importData({ path: importPath, format });
      } catch (err) {
        // 兼容 Runtime 以内容形式接收的实现：带 path 的校验失败时给出明确提示，不伪造成功
        if (err && (err.code === 'VALIDATION_FAILED' || err.code === 'BAD_REQUEST')) {
          state.importState.busy = false;
          state.importState.error = {
            ...errInfo(err),
            message: `${errInfo(err).message}（Runtime 导入端点可能要求直接上传文件内容；桌面端当前以文件路径导入，请反馈该 trace id）`,
          };
          renderContent();
          return;
        }
        throw err;
      }
      state.importState.busy = false;
      state.importState.result = res || { ok: true };
      notify('success', '导入完成');
      renderContent();
      await loadOverview();
    } catch (err) {
      state.importState.busy = false;
      state.importState.error = errInfo(err);
      renderContent();
      notify('error', `导入失败：${state.importState.error.message}`);
    }
  }

  async function openPath(kind) {
    const b = bridge();
    if (!b || !b.app || typeof b.app.openPath !== 'function') {
      notify('warn', '当前外壳未提供目录打开桥');
      return;
    }
    try {
      const res = await b.app.openPath(kind);
      if (res && res.ok === false) notify('warn', res.error || '目录不可用');
    } catch (err) {
      notify('error', `打开目录失败：${errInfo(err).message}`);
    }
  }

  function updateStatus() {
    try {
      if (!ctx.status) return;
      const db = describeDbHealth(state.dbHealth);
      ctx.status.set('data.state', {
        label: `数据管理 · ${db.ok === true ? '数据库正常' : db.ok === false ? '数据库异常' : '状态未知'}${state.backups.length ? ` · 备份 ${state.backups.length}` : ''}`,
        tone: db.ok === false ? 'error' : 'ok',
      });
    } catch {
      /* noop */
    }
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  function unmount() {
    try {
      if (ctx.status) ctx.status.remove('data.state');
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
    dom.content = null;
  }

  function activate() {
    if (!state.health && !state.loading.overview) loadOverview();
  }

  function handleCommand(command) {
    if (command === 'view:refresh') {
      loadOverview();
      if (state.tab === 'backup') loadBackups();
      if (state.tab === 'logs') loadLogs();
      return true;
    }
    return false;
  }

  function getSnapshot() {
    return { tab: state.tab };
  }

  return { mount, unmount, activate, handleCommand, getSnapshot };
}

/* ============================================================================
 * 样式
 * ========================================================================== */

const DATA_CSS = `
.view-data { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--fca-bg-1); color:var(--fca-text); font-family:var(--fca-font-ui); font-size:var(--fca-text-md); }
.view-data__bar { display:flex; align-items:center; justify-content:space-between; gap:var(--fca-space-3); padding:var(--fca-space-2) var(--fca-space-4); border-bottom:1px solid var(--fca-border); background:var(--fca-bg-2); flex-wrap:wrap; }
.view-data__title { display:flex; align-items:baseline; gap:var(--fca-space-2); }
.view-data__title h2 { margin:0; font-size:var(--fca-text-lg); font-weight:600; }
.view-data__sub { color:var(--fca-text-muted); font-size:var(--fca-text-sm); font-family:var(--fca-font-mono); }
.view-data__actions { display:flex; gap:var(--fca-space-2); }
.view-data__tabs { display:flex; gap:2px; padding:0 var(--fca-space-4); border-bottom:1px solid var(--fca-border); background:var(--fca-bg-1); }
.view-data__tab { border:none; background:transparent; color:var(--fca-text-muted); font:inherit; font-size:var(--fca-text-sm); padding:var(--fca-space-2) var(--fca-space-3); border-bottom:2px solid transparent; cursor:pointer; }
.view-data__tab:hover { color:var(--fca-text); }
.view-data__tab.is-active { color:var(--fca-accent-strong); border-bottom-color:var(--fca-accent); }
.view-data__runtime { display:flex; align-items:center; gap:var(--fca-space-2); padding:3px var(--fca-space-4); border-bottom:1px solid var(--fca-border); background:var(--fca-bg-0); font-size:var(--fca-text-xs); color:var(--fca-text-dim); flex-wrap:wrap; }
.view-data__dot { width:7px; height:7px; border-radius:50%; background:var(--fca-text-muted); display:inline-block; }
.view-data__dot--ok { background:var(--fca-green); }
.view-data__dot--warn { background:var(--fca-gold); }
.view-data__dot--error { background:var(--fca-danger); }
.view-data__content { flex:1; min-height:0; overflow-y:auto; padding:var(--fca-space-3) var(--fca-space-4) var(--fca-space-5); }
.view-data__grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:var(--fca-space-3); align-items:start; }
.view-data__card { border:1px solid var(--fca-border); border-radius:var(--fca-radius); background:var(--fca-bg-2); padding:var(--fca-space-3); }
.view-data__card-head { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--fca-space-2); margin-bottom:var(--fca-space-2); flex-wrap:wrap; }
.view-data__card-title { margin:0; font-size:var(--fca-text-sm); color:var(--fca-text-dim); font-weight:600; letter-spacing:.02em; }
.view-data__card-actions { margin-top:var(--fca-space-2); padding-top:var(--fca-space-2); border-top:1px solid var(--fca-border); }
.view-data__kv { display:flex; flex-direction:column; gap:2px; }
.view-data__kv-row { display:flex; justify-content:space-between; gap:var(--fca-space-2); font-size:var(--fca-text-sm); padding:2px 0; border-bottom:1px dashed var(--fca-border); }
.view-data__kv-label { color:var(--fca-text-muted); }
.view-data__kv-value { color:var(--fca-text); text-align:right; word-break:break-all; }
.view-data__mono { font-family:var(--fca-font-mono); font-size:var(--fca-text-xs); }
.view-data__muted { color:var(--fca-text-muted); font-size:var(--fca-text-sm); line-height:1.6; }
.view-data__label { color:var(--fca-text-muted); font-size:var(--fca-text-xs); flex:0 0 44px; }
.view-data__notice { display:flex; align-items:center; gap:var(--fca-space-2); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); padding:var(--fca-space-1) var(--fca-space-2); margin-bottom:var(--fca-space-2); font-size:var(--fca-text-sm); flex-wrap:wrap; }
.view-data__notice--ok { border-color:color-mix(in srgb, var(--fca-green) 40%, transparent); background:color-mix(in srgb, var(--fca-green) 8%, transparent); }
.view-data__notice--gold { border-color:color-mix(in srgb, var(--fca-gold) 40%, transparent); background:color-mix(in srgb, var(--fca-gold) 8%, transparent); }
.view-data__notice--rose { border-color:color-mix(in srgb, var(--fca-danger) 40%, transparent); background:color-mix(in srgb, var(--fca-danger) 8%, transparent); }
.view-data__inline { display:flex; align-items:center; gap:var(--fca-space-2); flex-wrap:wrap; }
.view-data__btn { display:inline-flex; align-items:center; gap:5px; height:28px; padding:0 var(--fca-space-3); border-radius:var(--fca-radius-sm); border:1px solid var(--fca-border); background:var(--fca-bg-3); color:var(--fca-text); font:inherit; font-size:var(--fca-text-sm); cursor:pointer; white-space:nowrap; }
.view-data__btn:hover { background:var(--fca-bg-4); }
.view-data__btn:disabled { opacity:.45; cursor:not-allowed; }
.view-data__btn--primary { background:var(--fca-accent-soft); border-color:var(--fca-accent); color:var(--fca-accent-strong); }
.view-data__btn--ghost { background:transparent; border-color:transparent; color:var(--fca-text-dim); }
.view-data__btn--ghost:hover { background:var(--fca-bg-3); color:var(--fca-text); }
.view-data__btn--danger { background:transparent; border-color:var(--fca-danger); color:var(--fca-danger); }
.view-data__btn--sm { height:24px; padding:0 var(--fca-space-2); font-size:var(--fca-text-xs); }
.view-data__spinner { width:22px;height:22px;border-radius:50%;border:2px solid var(--fca-border-strong);border-top-color:var(--fca-accent);animation:view-data-spin .8s linear infinite; }
.view-data__spinner-sm { width:11px;height:11px;border-radius:50%;border:2px solid var(--fca-border-strong);border-top-color:var(--fca-accent);animation:view-data-spin .8s linear infinite; display:inline-block; }
@keyframes view-data-spin { to { transform:rotate(360deg); } }
.view-data__loading { display:flex; flex-direction:column; align-items:center; gap:var(--fca-space-3); padding:var(--fca-space-6); color:var(--fca-text-dim); }
.view-data__list { display:flex; flex-direction:column; gap:var(--fca-space-1); }
.view-data__row { display:flex; align-items:center; justify-content:space-between; gap:var(--fca-space-2); padding:var(--fca-space-2); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); background:var(--fca-bg-1); flex-wrap:wrap; }
.view-data__row-main { flex:1; min-width:200px; }
.view-data__unavailable { color:var(--fca-gold); font-size:var(--fca-text-xs); border:1px dashed color-mix(in srgb, var(--fca-gold) 40%, transparent); border-radius:3px; padding:0 var(--fca-space-1); }
.view-data__errorbox { display:flex; flex-direction:column; gap:var(--fca-space-1); border:1px solid color-mix(in srgb, var(--fca-danger) 45%, var(--fca-border)); background:color-mix(in srgb, var(--fca-danger) 8%, transparent); border-radius:var(--fca-radius-sm); padding:var(--fca-space-2); margin:var(--fca-space-1) 0; }
.view-data__errorbox-title { color:var(--fca-danger); font-weight:600; font-size:var(--fca-text-sm); }
.view-data__errorbox-detail { color:var(--fca-text-dim); font-size:var(--fca-text-xs); word-break:break-word; }
.view-data__warn { margin-bottom:var(--fca-space-1); }
.view-data__table { display:flex; flex-direction:column; border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); overflow:hidden; }
.view-data__table-head, .view-data__table-row { display:grid; grid-template-columns:70px 1fr 150px; gap:var(--fca-space-2); padding:3px var(--fca-space-2); font-size:var(--fca-text-xs); }
.view-data__table-head { background:var(--fca-bg-3); color:var(--fca-text-muted); }
.view-data__table-row { border-top:1px solid var(--fca-border); }
.view-data__form { display:flex; flex-direction:column; gap:var(--fca-space-2); }
.view-data__form-row { display:flex; align-items:center; gap:var(--fca-space-2); flex-wrap:wrap; }
.view-data__input { background:var(--fca-bg-3); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); color:var(--fca-text); font:inherit; font-size:var(--fca-text-sm); height:28px; padding:0 var(--fca-space-2); outline:none; }
.view-data__input--date { width:140px; }
.view-data__select { background:var(--fca-bg-3); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); color:var(--fca-text); font:inherit; font-size:var(--fca-text-sm); height:28px; padding:0 var(--fca-space-1); outline:none; }
.view-data__check { display:inline-flex; align-items:center; gap:4px; font-size:var(--fca-text-xs); color:var(--fca-text-dim); cursor:pointer; }
.view-data__check input { accent-color:var(--fca-accent); }
.view-data__logs { font-family:var(--fca-font-mono); font-size:var(--fca-text-xs); background:var(--fca-bg-0); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); max-height:420px; overflow:auto; padding:var(--fca-space-2); }
.view-data__log-line { white-space:pre-wrap; word-break:break-word; padding:1px 0; color:var(--fca-text-dim); line-height:1.55; }
.view-data__log-line--error { color:var(--fca-danger); }
.view-data__log-line--warn { color:var(--fca-gold); }
.view-data__log-line--info { color:var(--fca-text-dim); }
.view-data__log-line--debug { color:var(--fca-text-muted); }
.view-data__empty { padding:var(--fca-space-4); text-align:center; }
.view-data__empty-title { font-size:var(--fca-text-md); margin-bottom:var(--fca-space-1); }
.view-data__empty-desc { color:var(--fca-text-muted); font-size:var(--fca-text-sm); }
`;
