/**
 * FCA Memory Atlas — 设置视图（Desktop Editor 组，Alpha 0.1）
 *
 * 契约：desktop/renderer/lib/contracts.md v1.0 §2/§3/§4/§6/§4.6（window.fca 桥）
 * 职责：
 *  - 数据目录 / 日志目录 / 端口展示与修改（经主进程 IPC；如实提示需要重启）
 *  - Runtime 状态与控制（启动/停止/重启/健康检查，桥存在才可用）
 *  - LLM Provider 配置（DeepSeek / OpenAI 兼容 / 自定义；API Key 掩码写入、测试连接、离线队列）
 *  - 深色主题说明、性能档位（作用于星图）、关于/版本/许可
 *  - 无法通过契约实现的能力明确显示“不可用”，不伪造成功
 */

export const meta = {
  id: 'settings',
  title: '设置',
  icon: 'settings',
  order: 90,
  nav: true,
  shortcut: 'g ,',
};

export const QUALITY_LEVELS = [
  { value: 'ultra', label: '极致（体积雾全分辨率）' },
  { value: 'high', label: '高（默认）' },
  { value: 'medium', label: '中' },
  { value: 'low', label: '低' },
  { value: 'off', label: '关闭特效（保留交互与可读性）' },
];

export const THEME_INFO = { value: 'dark', label: '深空暗色（Alpha 0.1 唯一主题）' };

export const PROVIDER_TYPES = [
  { value: 'deepseek', label: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat' },
  { value: 'openai_compatible', label: 'OpenAI 兼容', defaultBaseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  { value: 'custom', label: '自定义', defaultBaseUrl: '', defaultModel: '' },
];

const PROVIDER_TYPE_MAP = PROVIDER_TYPES.reduce((acc, item) => {
  acc[item.value] = item;
  return acc;
}, {});

/** LLM 能力是否被 Runtime 声明（/state 或 /system/status 的 capabilities） */
export const LLM_CAPABILITY_KEYS = ['llm', 'llm_providers', 'llm_complete', 'llmQueue'];

/* ============================================================================
 * 纯函数（单测覆盖）
 * ========================================================================== */

export function maskKey(key) {
  if (!key) return '（未设置）';
  const text = String(key);
  if (text.length <= 8) return '••••••••';
  return `${text.slice(0, 3)}••••••${text.slice(-4)}`;
}

export function portIsValid(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1024 && n <= 65535;
}

/** 设置表单初始化（纯函数） */
export function normalizeSettingsForm(settings) {
  const s = settings || {};
  return {
    dataDir: s.dataDir || '',
    port: Number.isFinite(s.port) ? s.port : 17860,
    runtimeUrl: s.runtimeUrl || '',
    autoStartRuntime: s.autoStartRuntime !== false,
    closeRuntimeOnExit: Boolean(s.closeRuntimeOnExit),
    allowExternalRuntime: s.allowExternalRuntime !== false,
    quality: s.quality || 'high',
    onboardingCompleted: Boolean(s.onboardingCompleted),
  };
}

/** 设置表单校验（纯函数）：返回 {ok, errors:{field:message}} */
export function validateSettingsForm(form) {
  const errors = {};
  if (!form) return { ok: false, errors: { dataDir: '设置无效' } };
  const dataDir = String(form.dataDir || '').trim();
  if (!dataDir) errors.dataDir = '数据目录不能为空';
  else if (!/^[A-Za-z]:\\|^\\\\|^\//.test(dataDir)) errors.dataDir = '请输入绝对路径（例如 D:\\FCA\\data）';
  if (!portIsValid(form.port)) errors.port = '端口必须是 1024-65535 之间的整数';
  if (form.runtimeUrl) {
    const url = String(form.runtimeUrl).trim();
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) {
      errors.runtimeUrl = 'Runtime 地址必须是本机回环地址（http://127.0.0.1:<port>）';
    }
  }
  if (!QUALITY_LEVELS.some((level) => level.value === form.quality)) errors.quality = '性能档位不可识别';
  return { ok: Object.keys(errors).length === 0, errors };
}

/** 计算需要提交的设置补丁（纯函数）：与原始值不同的字段 */
export function buildSettingsPatch(form, original) {
  const base = original || {};
  const patch = {};
  const dataDir = String(form.dataDir || '').trim();
  if (dataDir && dataDir !== (base.dataDir || '')) patch.dataDir = dataDir;
  if (Number(form.port) !== Number(base.port)) patch.port = Number(form.port);
  if (String(form.runtimeUrl || '').trim() !== String(base.runtimeUrl || '')) patch.runtimeUrl = String(form.runtimeUrl || '').trim() || null;
  if (Boolean(form.autoStartRuntime) !== Boolean(base.autoStartRuntime)) patch.autoStartRuntime = Boolean(form.autoStartRuntime);
  if (Boolean(form.closeRuntimeOnExit) !== Boolean(base.closeRuntimeOnExit)) patch.closeRuntimeOnExit = Boolean(form.closeRuntimeOnExit);
  if (Boolean(form.allowExternalRuntime) !== Boolean(base.allowExternalRuntime)) patch.allowExternalRuntime = Boolean(form.allowExternalRuntime);
  if (form.quality && form.quality !== (base.quality || 'high')) patch.quality = form.quality;
  return patch;
}

/** 判断改动是否要求重启 Runtime / 应用 */
export function restartRequirements(patch, runtime) {
  const needsRuntimeRestart = Boolean(patch && (patch.port !== undefined || patch.runtimeUrl !== undefined || patch.dataDir !== undefined));
  const needsAppRestart = Boolean(patch && (patch.dataDir !== undefined || patch.runtimeUrl !== undefined));
  const runtimeRunning = Boolean(runtime && (runtime.state === 'running' || runtime.state === 'unhealthy'));
  return {
    needsRuntimeRestart,
    needsAppRestart,
    runtimeRunning,
    hint: needsAppRestart
      ? '修改数据目录/运行时地址后需要重启应用生效。'
      : needsRuntimeRestart && runtimeRunning
        ? '修改端口后需要重启 Runtime 生效。'
        : null,
  };
}

/** LLM Provider 列表归一化 */
export function normalizeLlmProviders(response) {
  const items = Array.isArray(response)
    ? response
    : (response && (response.items || response.providers || response.data)) || [];
  return items.map((provider) => ({
    id: provider.id || provider.provider_id || null,
    name: provider.name || provider.label || '未命名 Provider',
    type: provider.type || provider.provider_type || provider.kind || 'custom',
    baseUrl: provider.base_url || provider.baseUrl || '',
    model: provider.model || provider.default_model || '',
    keyMasked: provider.api_key_masked || provider.key_masked || (provider.api_key ? maskKey(provider.api_key) : ''),
    enabled: provider.enabled !== false,
    raw: provider,
  })).filter((provider) => provider.id);
}

/** Provider 表单 → API payload（纯函数；空 api_key 不提交，避免覆盖已有密钥） */
export function buildLlmProviderPayload(form) {
  const payload = {
    name: String(form.name || '').trim(),
    type: form.type || 'custom',
    base_url: String(form.baseUrl || '').trim() || null,
    model: String(form.model || '').trim() || null,
    enabled: form.enabled !== false,
  };
  const key = String(form.apiKey || '').trim();
  if (key) payload.api_key = key;
  return payload;
}

export function providerTypeLabel(type) {
  return (PROVIDER_TYPE_MAP[type] || {}).label || type || '自定义';
}

export function qualityLabel(value) {
  return (QUALITY_LEVELS.find((level) => level.value === value) || {}).label || value || '未知';
}

export function isLlmCapabilityAvailable(capabilities) {
  if (!capabilities) return null; // 未知
  if (Array.isArray(capabilities)) {
    return LLM_CAPABILITY_KEYS.some((key) => capabilities.includes(key));
  }
  if (typeof capabilities === 'object') {
    for (const key of LLM_CAPABILITY_KEYS) {
      if (capabilities[key]) return true;
    }
    if (Array.isArray(capabilities.available)) return isLlmCapabilityAvailable(capabilities.available);
    return false;
  }
  return null;
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
    original: null,
    form: normalizeSettingsForm(null),
    saving: false,
    saveErrors: {},
    saveResult: null,
    bridgeInfo: null,
    bridgeError: null,
    runtime: null,
    health: null,
    systemStatus: null,
    providers: [],
    providersLoading: false,
    providersError: null,
    providerForm: null,
    providerBusy: false,
    providerTest: null,
    llmQueue: null,
    llmQueueError: null,
    llmCapability: null,
    llmError: null,
    qualitySaving: false,
    versions: {},
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
      class: `view-settings__btn view-settings__btn--${opts.variant || 'secondary'}${opts.size === 'sm' ? ' view-settings__btn--sm' : ''}`,
      disabled: Boolean(opts.disabled || opts.loading),
      title: opts.title || '',
      'data-testid': opts.testid || null,
      on: { click: (event) => opts.onClick && opts.onClick(event) },
    }, [opts.icon ? icon(opts.icon) : null, opts.label ? el('span', { text: opts.label }) : null, opts.loading ? el('span', { class: 'view-settings__spinner-sm' }) : null]);
  }

  function field(label, control, opts = {}) {
    return el('label', { class: 'view-settings__field' }, [
      el('span', { class: 'view-settings__label' }, [label, opts.required ? el('span', { class: 'view-settings__req', text: '*' }) : null]),
      control,
      opts.hint ? el('span', { class: 'view-settings__hint', text: opts.hint }) : null,
      opts.error ? el('span', { class: 'view-settings__error', text: opts.error }) : null,
    ]);
  }

  function textInput(opts = {}) {
    const node = el('input', {
      class: 'view-settings__input',
      type: opts.type || 'text',
      value: opts.value ?? '',
      placeholder: opts.placeholder || '',
      disabled: Boolean(opts.disabled),
      autocomplete: 'off',
      spellcheck: 'false',
      'data-testid': opts.testid || null,
    });
    if (opts.onInput) node.addEventListener('input', (event) => opts.onInput(event.target.value));
    return node;
  }

  function selectInput(options, value, onChange, opts = {}) {
    const node = el('select', { class: 'view-settings__select', disabled: Boolean(opts.disabled), 'data-testid': opts.testid || null });
    for (const option of options) {
      const optionEl = el('option', { value: option.value, text: option.label });
      if (option.value === value) optionEl.selected = true;
      node.append(optionEl);
    }
    node.value = value;
    node.addEventListener('change', (event) => onChange(event.target.value));
    return node;
  }

  function switchControl(label, checked, onChange) {
    const input = el('input', { type: 'checkbox', checked: Boolean(checked), on: { change: (event) => onChange(event.target.checked) } });
    return el('label', { class: 'view-settings__switch' }, [input, el('span', { text: label })]);
  }

  function card(title, body, opts = {}) {
    return el('section', { class: 'view-settings__card' }, [
      el('div', { class: 'view-settings__card-head' }, [
        el('div', {}, [
          el('h3', { class: 'view-settings__card-title', text: title }),
          opts.subtitle ? el('div', { class: 'view-settings__muted', text: opts.subtitle }) : null,
        ]),
        opts.actions ? el('div', { class: 'view-settings__inline' }, Array.isArray(opts.actions) ? opts.actions : [opts.actions]) : null,
      ]),
      body,
    ]);
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

  function storeState() {
    try {
      return ctx.store && typeof ctx.store.getState === 'function' ? ctx.store.getState() : null;
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

  async function loadSettings() {
    const b = bridge();
    try {
      if (b && b.app && typeof b.app.getSettings === 'function') {
        const res = await b.app.getSettings();
        const settings = (res && res.settings) || res;
        if (settings && typeof settings === 'object') {
          state.original = settings;
          state.form = normalizeSettingsForm(settings);
        }
      }
    } catch (err) {
      state.bridgeError = errInfo(err);
    }
    if (!state.original) {
      const store = storeState();
      if (store && store.settings) {
        state.original = store.settings;
        state.form = normalizeSettingsForm(store.settings);
      }
    }
    try {
      if (b && b.app && typeof b.app.getInfo === 'function') state.bridgeInfo = await b.app.getInfo();
    } catch (err) {
      state.bridgeError = errInfo(err);
    }
    render();
  }

  async function loadRuntimeInfo() {
    const store = storeState();
    state.runtime = store && store.runtime ? store.runtime : null;
    if (state.runtime) state.form.quality = state.form.quality || (store.settings && store.settings.quality) || 'high';
    try {
      state.health = await api.health();
    } catch (err) {
      state.health = null;
      state.healthError = errInfo(err);
    }
    try {
      state.systemStatus = await api.getSystemStatus();
    } catch (err) {
      state.systemStatusError = errInfo(err);
    }
    try {
      const stateData = await api.getState();
      state.llmCapability = isLlmCapabilityAvailable(stateData && (stateData.capabilities || stateData.capability || (stateData.state && stateData.state.capabilities)));
      state.versions = {
        runtime: (stateData && stateData.version) || (state.health && state.health.version) || (state.runtime && state.runtime.version) || null,
        api: (state.health && state.health.api_version) || (state.runtime && state.runtime.apiVersion) || null,
      };
    } catch (err) {
      state.llmCapability = null;
    }
    render();
  }

  async function loadProviders() {
    state.providersLoading = true;
    state.providersError = null;
    state.llmError = null;
    renderLlmSection();
    try {
      const res = await api.listLlmProviders();
      state.providers = normalizeLlmProviders(res);
      state.providersLoading = false;
      renderLlmSection();
    } catch (err) {
      state.providersLoading = false;
      state.providersError = errInfo(err);
      state.llmError = errInfo(err);
      renderLlmSection();
    }
    try {
      const queue = await api.getLlmQueue();
      state.llmQueue = queue;
      state.llmQueueError = null;
    } catch (err) {
      state.llmQueue = null;
      state.llmQueueError = errInfo(err);
    }
    renderLlmSection();
  }

  /* -------------------------------- 渲染 -------------------------------- */

  function mount(container) {
    styleEl = doc.createElement('style');
    styleEl.id = 'view-settings-style';
    styleEl.textContent = SETTINGS_CSS;
    doc.head.append(styleEl);
    root = el('div', { class: 'view-settings', 'data-testid': 'view-settings' });
    container.append(root);
    render();
    loadSettings();
    loadRuntimeInfo();
    loadProviders();
    const store = storeState();
    if (store && store.settings) {
      state.original = store.settings;
      state.form = normalizeSettingsForm(store.settings);
    }
    subscribeMany(['runtime:status'], () => {
      state.runtime = storeState() && storeState().runtime;
      renderRuntimeCard();
    });
  }

  function render() {
    if (!root) return;
    const scrollTop = root.querySelector('.view-settings__content') ? root.querySelector('.view-settings__content').scrollTop : 0;
    root.textContent = '';
    root.append(renderHeader());
    const content = el('div', { class: 'view-settings__content fca-scroll', 'data-testid': 'settings-content' });
    dom.content = content;
    content.append(
      renderRuntimeCard(),
      renderStorageCard(),
      renderLlmSectionHost(),
      renderAppearanceCard(),
      renderAboutCard(),
    );
    root.append(content);
    content.scrollTop = scrollTop;
  }

  function renderHeader() {
    const settings = state.original || {};
    return el('div', { class: 'view-settings__bar' }, [
      el('div', { class: 'view-settings__title' }, [
        el('h2', { text: '设置' }),
        el('span', { class: 'view-settings__sub', text: `数据目录：${settings.dataDir || '（未加载）'}` }),
      ]),
      el('div', { class: 'view-settings__actions' }, [
        button({ label: '保存设置', icon: 'save', variant: 'primary', testid: 'settings-save', loading: state.saving, disabled: !state.original, onClick: () => saveSettings() }),
        button({ label: '打开设置文件目录', icon: 'folder', variant: 'ghost', onClick: () => openSettingsDir() }),
      ]),
    ]);
  }

  function renderRuntimeCard() {
    const settings = state.original || {};
    const runtime = state.runtime || {};
    const bridgeInfo = state.bridgeInfo;
    const body = el('div', { class: 'view-settings__form' });
    if (state.bridgeError) {
      body.append(el('div', { class: 'view-settings__notice view-settings__notice--gold', text: `主进程桥异常：${state.bridgeError.message}` }));
    }
    const dataDirInput = textInput({
      value: state.form.dataDir,
      placeholder: '例如 D:\\FCA\\data',
      testid: 'settings-datadir',
      onInput: (value) => { state.form.dataDir = value; },
    });
    const chooseDirBtn = bridge() && bridge().dialog && bridge().dialog.selectDirectory
      ? button({ label: '选择…', icon: 'folder', size: 'sm', onClick: () => chooseDataDir() })
      : null;
    const portInput = textInput({
      type: 'number',
      value: String(state.form.port),
      testid: 'settings-port',
      onInput: (value) => { state.form.port = Number(value); },
    });
    const runtimeUrlInput = textInput({
      value: state.form.runtimeUrl,
      placeholder: `留空则由端口推导：http://127.0.0.1:${state.form.port || 17860}`,
      testid: 'settings-runtime-url',
      onInput: (value) => { state.form.runtimeUrl = value; },
    });
    const autoStart = switchControl('应用启动时自动启动 Runtime', state.form.autoStartRuntime, (checked) => { state.form.autoStartRuntime = checked; });
    const closeOnExit = switchControl('退出应用时关闭由本应用启动的 Runtime', state.form.closeRuntimeOnExit, (checked) => { state.form.closeRuntimeOnExit = checked; });
    const allowExternal = switchControl('允许桌面使用已在运行的外部 Runtime', state.form.allowExternalRuntime, (checked) => { state.form.allowExternalRuntime = checked; });
    body.append(
      el('div', { class: 'view-settings__grid-fields' }, [
        field('数据目录', el('div', { class: 'view-settings__inline' }, [dataDirInput, chooseDirBtn]), {
          required: true,
          error: state.saveErrors.dataDir,
          hint: 'Runtime 数据库/日志/备份/事件文件所在目录；修改后需要重启应用生效。',
        }),
        field('Runtime 端口（仅回环监听）', portInput, {
          required: true,
          error: state.saveErrors.port,
          hint: `当前 Runtime 地址：${runtime.url || `http://127.0.0.1:${state.form.port}`}；修改端口后需要重启 Runtime。`,
        }),
        field('自定义 Runtime 地址（可选）', runtimeUrlInput, {
          error: state.saveErrors.runtimeUrl,
          hint: '仅允许 http(s)://127.0.0.1 或 localhost；留空表示由端口推导。',
        }),
      ]),
      el('div', { class: 'view-settings__inline view-settings__switch-row' }, [autoStart, closeOnExit, allowExternal]),
      renderRestartHint(),
      el('div', { class: 'view-settings__kv' }, [
        row('Runtime 状态', runtime.state || '未知'),
        row('归属', runtime.ownedByDesktop ? '由本桌面启动' : runtime.state === 'running' ? '外部 Runtime' : '—'),
        row('版本 / API', `${runtime.version || (state.versions.runtime || '—')} / API v${runtime.apiVersion || state.versions.api || '?'}`),
        row('健康检查', state.health ? `${state.health.status} · initialized=${String(state.health.initialized)}` : state.healthError ? `不可用：${state.healthError.message}` : '检查中…'),
        row('日志目录', settings.logDir || (settings.dataDir ? `${settings.dataDir}\\logs` : '—'), true),
        row('桌面日志', bridgeInfo && bridgeInfo.logDir ? bridgeInfo.logDir : '—', true),
      ]),
      el('div', { class: 'view-settings__inline' }, [
        button({ label: '重新检查健康', icon: 'activity', size: 'sm', onClick: () => loadRuntimeInfo() }),
        bridge() ? button({ label: '重启 Runtime', icon: 'refresh', size: 'sm', onClick: () => runtimeAction('restart') }) : null,
        bridge() ? button({ label: '停止 Runtime', icon: 'stop', size: 'sm', variant: 'danger', onClick: () => runtimeAction('stop') }) : null,
        bridge() ? button({ label: '启动 Runtime', icon: 'play', size: 'sm', onClick: () => runtimeAction('start') }) : null,
        !bridge() ? el('span', { class: 'view-settings__muted', text: '（非桌面环境：无 window.fca 桥，Runtime 控制与目录修改不可用）' }) : null,
      ]),
    );
    return card('数据目录与 Runtime', body, { subtitle: '经主进程 IPC（settings.js）读写 desktop-settings.json；渲染进程不直接访问文件系统。' });
  }

  function renderRestartHint() {
    const requirements = restartRequirements(buildSettingsPatch(state.form, state.original || {}), state.runtime);
    if (!requirements.hint) return el('div', { class: 'view-settings__hint view-settings__hint--empty' });
    return el('div', { class: 'view-settings__notice view-settings__notice--gold' }, [
      el('span', { text: requirements.hint }),
      requirements.needsAppRestart && bridge() && bridge().app && bridge().app.relaunch
        ? button({ label: '重启应用', icon: 'refresh', size: 'sm', onClick: () => relaunchApp() })
        : null,
      requirements.needsRuntimeRestart && requirements.runtimeRunning && bridge()
        ? button({ label: '重启 Runtime', icon: 'refresh', size: 'sm', onClick: () => runtimeAction('restart') })
        : null,
    ]);
  }

  function renderStorageCard() {
    const settings = state.original || {};
    const body = el('div', { class: 'view-settings__kv' }, [
      row('数据目录', settings.dataDir || '—', true),
      row('配置文件', settings.settingsFilePath || `${settings.dataDir || ''}\\desktop-settings.json`, true),
      row('Runtime 地址', settings.runtimeUrl || (settings.port ? `http://127.0.0.1:${settings.port}` : '—'), true),
      row('日志文件', settings.logFile || '—', true),
      row('引导完成标记', settings.onboardingCompleted ? '已完成' : '未完成'),
    ]);
    return card('路径与文件', body, {
      subtitle: '展示主进程解析后的实际路径。修改目录请在上方表单保存后重启应用。',
      actions: bridge()
        ? [
          button({ label: '打开数据目录', icon: 'folder', size: 'sm', variant: 'ghost', onClick: () => openPath('data') }),
          button({ label: '打开日志目录', icon: 'folder', size: 'sm', variant: 'ghost', onClick: () => openPath('logs') }),
          button({ label: '打开配置目录', icon: 'folder', size: 'sm', variant: 'ghost', onClick: () => openPath('config') }),
        ]
        : null,
    });
  }

  function row(label, value, mono) {
    return el('div', { class: 'view-settings__kv-row' }, [
      el('span', { class: 'view-settings__kv-label', text: label }),
      el('span', { class: `view-settings__kv-value${mono ? ' view-settings__mono' : ''}`, text: value == null ? '—' : String(value) }),
    ]);
  }

  function renderLlmSectionHost() {
    dom.llmHost = el('div', { class: 'view-settings__llm' });
    renderLlmSection();
    return dom.llmHost;
  }

  function renderLlmSection() {
    const host = dom.llmHost;
    if (!host) return;
    host.textContent = '';
    const capabilityText = state.llmCapability === false
      ? 'Runtime 未声明 LLM 能力（本地记忆功能不受影响）'
      : state.llmCapability === true
        ? 'Runtime 已声明 LLM 能力'
        : 'LLM 能力未确认（/state 未返回 capabilities）';
    const body = el('div', { class: 'view-settings__form' });
    body.append(el('div', { class: 'view-settings__notice ' + (state.llmCapability === false ? 'view-settings__notice--gold' : 'view-settings__notice--ok') }, [
      el('span', { text: capabilityText }),
      state.llmError ? el('span', { class: 'view-settings__muted', text: `最近错误：${state.llmError.message}` }) : null,
    ]));
    if (state.providersLoading) {
      body.append(el('div', { class: 'view-settings__muted', text: '正在读取 LLM Provider 配置…' }));
    } else if (state.providersError) {
      body.append(el('div', { class: 'view-settings__errorbox', role: 'alert' }, [
        el('div', { class: 'view-settings__errorbox-title', text: `LLM Provider 不可用（${state.providersError.code}）` }),
        el('div', { class: 'view-settings__errorbox-detail', text: `${state.providersError.message}${state.providersError.traceId ? ` · trace ${state.providersError.traceId}` : ''}` }),
        el('div', { class: 'view-settings__muted', text: 'Alpha 0.1 的 LLM 网关由 Runtime 可选实现；不可用时本地记忆读写、搜索、关系、时间线均不受影响。本页不会伪造连接成功。' }),
        button({ label: '重试', icon: 'refresh', size: 'sm', onClick: () => loadProviders() }),
      ]));
    } else {
      if (!state.providers.length) {
        body.append(el('div', { class: 'view-settings__muted', text: '尚未配置 Provider。添加后 Agent 功能可使用云端 LLM；离线时请求会进入队列（若 Runtime 支持）。' }));
      } else {
        const list = el('div', { class: 'view-settings__list' });
        for (const provider of state.providers) {
          list.append(el('div', { class: 'view-settings__row', 'data-testid': `settings-provider-${provider.id}` }, [
            el('div', { class: 'view-settings__row-main' }, [
              el('div', { text: `${provider.name}（${providerTypeLabel(provider.type)}）` }),
              el('div', { class: 'view-settings__muted view-settings__mono', text: `${provider.baseUrl || '默认地址'} · ${provider.model || '默认模型'} · Key ${provider.keyMasked || maskKey('')}` }),
            ]),
            el('div', { class: 'view-settings__inline' }, [
              button({ label: '编辑', icon: 'edit', size: 'sm', onClick: () => openProviderForm(provider) }),
              button({ label: '测试连接', icon: 'activity', size: 'sm', variant: 'ghost', onClick: () => testProvider(provider) }),
              button({ label: '删除', icon: 'trash', size: 'sm', variant: 'danger', onClick: () => deleteProvider(provider) }),
            ]),
          ]));
        }
        body.append(list);
      }
      body.append(el('div', { class: 'view-settings__inline' }, [
        button({ label: '添加 Provider', icon: 'plus', variant: 'primary', testid: 'settings-add-provider', onClick: () => openProviderForm(null) }),
        button({ label: '刷新', icon: 'refresh', size: 'sm', variant: 'ghost', onClick: () => loadProviders() }),
      ]));
      if (state.providerBusy) body.append(el('div', { class: 'view-settings__muted', text: '正在提交 Provider 配置…' }));
      if (state.providerTest) {
        body.append(el('div', { class: `view-settings__notice view-settings__notice--${state.providerTest.ok ? 'ok' : 'gold'}` }, [
          el('span', { text: state.providerTest.message }),
          state.providerTest.detail ? el('span', { class: 'view-settings__muted view-settings__mono', text: state.providerTest.detail }) : null,
        ]));
      }
      // 离线队列
      if (state.llmQueueError && state.llmCapability !== false) {
        body.append(el('div', { class: 'view-settings__muted', text: `离线队列不可用：${state.llmQueueError.message}` }));
      } else if (state.llmQueue) {
        const items = Array.isArray(state.llmQueue) ? state.llmQueue : (state.llmQueue.items || state.llmQueue.queue || []);
        body.append(el('div', { class: 'view-settings__subtitle', text: `离线队列（${items.length} 条待处理）` }));
        for (const item of items.slice(0, 20)) {
          body.append(el('div', { class: 'view-settings__row' }, [
            el('div', { class: 'view-settings__row-main' }, [
              el('div', { class: 'view-settings__mono', text: String(item.queue_id || item.id || '—') }),
              el('div', { class: 'view-settings__muted', text: `${item.status || item.state || 'pending'} · ${formatTime(item.created_at)}` }),
            ]),
            button({ label: '重试', icon: 'refresh', size: 'sm', onClick: () => retryQueueItem(item) }),
          ]));
        }
      }
    }
    host.append(card('LLM Provider（可选）', body, {
      subtitle: 'API Key 由 Runtime 加密/掩码保管；桌面端只提交一次明文，之后始终显示掩码。',
    }));
  }

  function renderAppearanceCard() {
    const currentQuality = (storeState() && storeState().ui && storeState().ui.quality) || state.form.quality;
    const qualitySelect = selectInput(QUALITY_LEVELS, currentQuality, (value) => applyQuality(value), { testid: 'settings-quality' });
    const body = el('div', { class: 'view-settings__form' }, [
      el('div', { class: 'view-settings__grid-fields' }, [
        field('主题', el('div', { class: 'view-settings__theme' }, [
          el('span', { class: 'view-settings__theme-swatch' }),
          el('span', { text: THEME_INFO.label }),
        ]), { hint: 'Alpha 0.1 仅提供深空暗色主题（专业天文软件基调）；后续版本再扩展。' }),
        field('星图性能档位', qualitySelect, { hint: `当前：${qualityLabel(currentQuality)}。修改后立即作用于星云画布；关闭特效档保留全部交互与标签可读性。` }),
      ]),
      el('div', { class: 'view-settings__inline' }, [
        el('span', { class: 'view-settings__muted', text: '快捷键：Ctrl+Z 撤销 / Ctrl+Shift+Z 重做 / Delete 删除选中 / F5 刷新 / Esc 关闭浮层。' }),
        button({ label: '打开星图', icon: 'compass', size: 'sm', onClick: () => navigate('atlas', {}) }),
      ]),
    ]);
    return card('外观与性能', body, { subtitle: '使用 styles/tokens.css 的设计令牌；视图不硬编码颜色。' });
  }

  function renderAboutCard() {
    const store = storeState();
    const version = (store && store.app && store.app.version) || {};
    const health = state.health || {};
    const info = state.bridgeInfo || {};
    const body = el('div', { class: 'view-settings__kv' }, [
      row('产品', 'FCA Memory Atlas（Fish Cognitive Architecture）'),
      row('版本', `Alpha ${version.app || info.version || '0.1.0'}`),
      row('Electron', version.electron || info.electron || '—'),
      row('Chromium', version.chrome || info.chrome || '—'),
      row('Node（Runtime 版本）', version.node || state.versions.runtime || '—'),
      row('API 版本', `v${health.api_version || state.versions.api || '1'}`),
      row('许可', 'UNLICENSED（内部 Alpha 版本）· 第三方组件保留各自许可（Electron/Chromium/SQLite）'),
      row('数据目录', (store && store.app && store.app.dataDir) || (state.original && state.original.dataDir) || '—', true),
      row('运行模式', store && store.app && store.app.captureMode ? '截图/验收模式' : '正常'),
    ]);
    return card('关于', el('div', {}, [
      body,
      el('div', { class: 'view-settings__muted', text: 'FCA Alpha 0.1 为开发版本：接口冻结、数据本地优先、不做旧记忆迁移。真实性问题请附 trace id 反馈。' }),
      el('div', { class: 'view-settings__inline' }, [
        button({ label: '重新运行首次启动向导', icon: 'sparkles', size: 'sm', onClick: () => ctx.shell && typeof ctx.shell.showOnboarding === 'function' ? ctx.shell.showOnboarding() : navigate('onboarding', {}) }),
        button({ label: '查看数据管理', icon: 'database', size: 'sm', onClick: () => navigate('data', {}) }),
      ]),
    ]));
  }

  /* ------------------------------- 操作 ------------------------------- */

  async function saveSettings() {
    const validation = validateSettingsForm(state.form);
    state.saveErrors = validation.errors;
    if (!validation.ok) {
      state.saveResult = { ok: false, message: '设置校验未通过，请检查标红字段' };
      render();
      notify('error', `设置校验失败：${validation.errors[Object.keys(validation.errors)[0]]}`);
      return;
    }
    const patch = buildSettingsPatch(state.form, state.original || {});
    if (!Object.keys(patch).length) {
      notify('info', '设置未修改');
      return;
    }
    const b = bridge();
    if (!b || !b.app || typeof b.app.saveSettings !== 'function') {
      state.saveResult = { ok: false, message: '当前外壳未提供设置写入桥（window.fca.app.saveSettings 不可用），无法保存' };
      render();
      notify('warn', '无法保存：设置写入桥不可用');
      return;
    }
    state.saving = true;
    render();
    try {
      const res = await b.app.saveSettings(patch);
      state.saving = false;
      if (res && res.ok) {
        state.original = res.settings || { ...(state.original || {}), ...patch };
        state.form = normalizeSettingsForm(state.original);
        state.saveResult = { ok: true, message: '设置已保存到 desktop-settings.json' };
        if (patch.quality) applyQuality(patch.quality);
        notify('success', '设置已保存');
        render();
      } else {
        const errors = {};
        for (const item of (res && res.errors) || []) errors[item.field] = item.message;
        state.saveErrors = errors;
        state.saveResult = { ok: false, message: `设置保存失败：${(res && res.errors && res.errors[0] && res.errors[0].message) || '主进程拒绝写入'}` };
        render();
        notify('error', state.saveResult.message);
      }
    } catch (err) {
      state.saving = false;
      const info = errInfo(err);
      state.saveResult = { ok: false, message: `设置保存失败：${info.message}` };
      render();
      notify('error', state.saveResult.message);
    }
  }

  async function chooseDataDir() {
    const b = bridge();
    if (!b || !b.dialog || typeof b.dialog.selectDirectory !== 'function') {
      notify('warn', '当前外壳未提供目录选择桥');
      return;
    }
    try {
      const res = await b.dialog.selectDirectory({ title: '选择 FCA 数据目录（不导入旧记忆）' });
      if (res && res.ok && res.path) {
        state.form.dataDir = res.path;
        render();
        notify('info', '已选择数据目录，保存后需重启应用生效');
      }
    } catch (err) {
      notify('error', `选择目录失败：${errInfo(err).message}`);
    }
  }

  async function relaunchApp() {
    const b = bridge();
    if (!b || !b.app || typeof b.app.relaunch !== 'function') {
      notify('warn', '当前外壳未提供重启接口');
      return;
    }
    const ok = await confirmAction({
      title: '重启应用？',
      message: '重启后新的数据目录/运行时地址才会生效。当前未保存的编辑内容会丢失。',
      confirmLabel: '重启应用',
    });
    if (!ok) return;
    try {
      await b.app.relaunch();
    } catch (err) {
      notify('error', `重启失败：${errInfo(err).message}`);
    }
  }

  async function runtimeAction(action) {
    const b = bridge();
    if (!b || !b.runtime) {
      notify('warn', '当前外壳未提供 Runtime 控制桥');
      return;
    }
    try {
      let res;
      if (action === 'start') res = await b.runtime.start();
      else if (action === 'stop') res = await b.runtime.stop();
      else res = await b.runtime.restart();
      const ok = res && (res.ok === undefined ? !res.error : res.ok);
      if (ok) notify('success', `Runtime ${action === 'start' ? '已启动' : action === 'stop' ? '已停止' : '已重启'}`);
      else notify('error', `Runtime 操作失败：${(res && res.error && (res.error.message || res.error.code)) || '未知原因'}`);
      await loadRuntimeInfo();
    } catch (err) {
      notify('error', `Runtime 操作失败：${errInfo(err).message}`);
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

  async function openSettingsDir() {
    await openPath('data');
  }

  function applyQuality(value) {
    state.form.quality = value;
    try {
      if (ctx.store && typeof ctx.store.patch === 'function') ctx.store.patch({ ui: { quality: value } });
      if (ctx.events && typeof ctx.events.emit === 'function') ctx.events.emit('quality:change', { level: value });
      try {
        window.localStorage.setItem('fca.ui.quality', value);
      } catch {
        /* noop */
      }
      notify('success', `性能档位已切换为：${qualityLabel(value)}`);
      render();
    } catch (err) {
      notify('error', `切换性能档位失败：${errInfo(err).message}`);
    }
  }

  async function confirmAction(opts) {
    try {
      if (ctx.dialogs && typeof ctx.dialogs.confirm === 'function') return await ctx.dialogs.confirm(opts);
      return window.confirm(`${opts.title}\n\n${opts.message || ''}`);
    } catch {
      return false;
    }
  }

  /* ------------------------------ LLM Provider ------------------------------ */

  function openProviderForm(provider) {
    const form = provider
      ? { id: provider.id, name: provider.name, type: provider.type, baseUrl: provider.baseUrl, model: provider.model, apiKey: '', enabled: provider.enabled }
      : { id: null, name: '', type: 'deepseek', baseUrl: PROVIDER_TYPE_MAP.deepseek.defaultBaseUrl, model: PROVIDER_TYPE_MAP.deepseek.defaultModel, apiKey: '', enabled: true };
    const errors = {};
    const body = el('div', { class: 'view-settings__dialog' });
    const nameInput = textInput({ value: form.name, placeholder: '例如 DeepSeek 主账号', testid: 'provider-name', onInput: (v) => { form.name = v; } });
    const typeSelect = selectInput(PROVIDER_TYPES, form.type, (value) => {
      form.type = value;
      const preset = PROVIDER_TYPE_MAP[value];
      if (preset) {
        if (!form.baseUrl || Object.values(PROVIDER_TYPE_MAP).some((p) => p.defaultBaseUrl === form.baseUrl)) form.baseUrl = preset.defaultBaseUrl;
        if (!form.model || Object.values(PROVIDER_TYPE_MAP).some((p) => p.defaultModel === form.model)) form.model = preset.defaultModel;
      }
      renderDialog();
    }, { testid: 'provider-type' });
    const baseUrlInput = textInput({ value: form.baseUrl, placeholder: 'https://api.example.com/v1', testid: 'provider-base-url', onInput: (v) => { form.baseUrl = v; } });
    const modelInput = textInput({ value: form.model, placeholder: '模型名，例如 deepseek-chat', testid: 'provider-model', onInput: (v) => { form.model = v; } });
    const keyInput = textInput({ type: 'password', value: '', placeholder: provider ? '留空表示不修改已保存的 Key' : 'API Key（仅提交一次，之后仅显示掩码）', testid: 'provider-api-key', onInput: (v) => { form.apiKey = v; } });
    const enabledSwitch = switchControl('启用该 Provider', form.enabled, (checked) => { form.enabled = checked; });
    const errorHost = el('div', { class: 'view-settings__errors' });
    function renderDialog() {
      body.textContent = '';
      errorHost.textContent = '';
      for (const message of Object.values(errors)) errorHost.append(el('div', { class: 'view-settings__error', text: message }));
      body.append(
        field('名称', nameInput, { required: true }),
        field('Provider 类型', typeSelect),
        field('Base URL', baseUrlInput, { hint: 'OpenAI 兼容接口请填写到 /v1 层级；自定义类型可留空由 Runtime 默认。' }),
        field('模型', modelInput),
        field('API Key', keyInput, { hint: '只写不读：保存后 Runtime 返回掩码；桌面端不会回显明文。' }),
        enabledSwitch,
        errorHost,
      );
    }
    renderDialog();
    const dlg = openDialog({
      title: provider ? '编辑 LLM Provider' : '添加 LLM Provider',
      subtitle: '配置保存在 Runtime 侧；桌面端不落盘明文密钥',
      content: body,
      width: 560,
      actions: [
        { label: '取消', variant: 'ghost', closeOnClick: true },
        {
          label: provider ? '保存' : '添加',
          variant: 'primary',
          testid: 'provider-submit',
          onClick: async (close) => {
            for (const key of Object.keys(errors)) delete errors[key];
            if (!form.name.trim()) errors.name = '名称不能为空';
            if (!form.baseUrl.trim() && form.type !== 'custom') errors.baseUrl = '该类型需要 Base URL';
            if (!form.model.trim() && form.type !== 'custom') errors.model = '该类型需要模型名';
            if (Object.keys(errors).length) {
              renderDialog();
              return false;
            }
            state.providerBusy = true;
            renderLlmSection();
            try {
              const payload = buildLlmProviderPayload(form);
              if (provider) await api.updateLlmProvider(provider.id, payload);
              else await api.createLlmProvider(payload);
              state.providerBusy = false;
              notify('success', provider ? 'Provider 已保存' : 'Provider 已添加');
              close();
              loadProviders();
            } catch (err) {
              state.providerBusy = false;
              const info = errInfo(err);
              errors.submit = `${info.message}${info.traceId ? ` · trace ${info.traceId}` : ''}`;
              renderDialog();
              renderLlmSection();
              return false;
            }
            return true;
          },
        },
      ],
    });
    return dlg;
  }

  async function testProvider(provider) {
    state.providerTest = { ok: false, message: `正在测试 ${provider.name}…` };
    renderLlmSection();
    try {
      const res = await api.llmComplete({
        provider_id: provider.id,
        messages: [{ role: 'user', content: 'ping（FCA 设置页连接测试，请只回复 pong）' }],
        max_tokens: 8,
      });
      if (res && (res.queued || res.status === 'queued')) {
        state.providerTest = { ok: false, message: 'LLM 当前离线：请求已进入 Runtime 队列', detail: JSON.stringify(res) };
      } else {
        const text = res && (res.content || res.text || (res.message && res.message.content) || res.output);
        state.providerTest = { ok: true, message: `连接成功${text ? `：${String(text).slice(0, 80)}` : ''}`, detail: res && res.usage ? JSON.stringify(res.usage) : null };
      }
    } catch (err) {
      const info = errInfo(err);
      state.providerTest = {
        ok: false,
        message: `连接测试失败：${info.message}（code=${info.code}）`,
        detail: info.code === 'LLM_NOT_CONFIGURED' || info.code === 'NOT_FOUND' || info.code === 'LLM_UNAVAILABLE' ? '本地记忆功能不受影响' : null,
      };
    }
    renderLlmSection();
  }

  async function deleteProvider(provider) {
    const ok = await confirmAction({ title: '删除 LLM Provider？', message: `将删除「${provider.name}」。此操作只影响云端模型调用，不影响本地记忆。`, confirmLabel: '删除', danger: true });
    if (!ok) return;
    try {
      await api.deleteLlmProvider(provider.id);
      notify('success', 'Provider 已删除');
      loadProviders();
    } catch (err) {
      notify('error', `删除失败：${errInfo(err).message}`);
    }
  }

  async function retryQueueItem(item) {
    const id = item.queue_id || item.id;
    if (!id) return;
    try {
      const res = await api.retryLlmQueue(id);
      notify('success', res && res.queued ? '已重新入队' : '已重试');
      loadProviders();
    } catch (err) {
      notify('error', `重试失败：${errInfo(err).message}`);
    }
  }

  function openDialog(opts) {
    try {
      if (typeof U.dialog === 'function') {
        const actions = (opts.actions || []).map((action) => ({
          label: action.label,
          variant: action.variant,
          closeOnClick: action.closeOnClick,
          onClick: (close) => (action.onClick ? action.onClick(close) : close()),
        }));
        return U.dialog({ title: opts.title, subtitle: opts.subtitle, content: opts.content, actions, width: opts.width || 560 });
      }
    } catch (err) {
      console.warn('[settings] ui.dialog 不可用', err);
    }
    const primary = (opts.actions || []).find((a) => a.onClick);
    if (primary && window.confirm(`${opts.title}\n\n${opts.subtitle || ''}\n\n继续？`)) {
      Promise.resolve(primary.onClick(() => {})).catch((err) => notify('error', errInfo(err).message));
    }
    return { close: () => {}, setBusy: () => {} };
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  function unmount() {
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
    dom.llmHost = null;
  }

  function activate() {
    if (!state.original) loadSettings();
    loadRuntimeInfo();
  }

  function handleCommand(command) {
    if (command === 'view:refresh') {
      loadSettings();
      loadRuntimeInfo();
      loadProviders();
      return true;
    }
    return false;
  }

  function getSnapshot() {
    return { tab: 'settings' };
  }

  return { mount, unmount, activate, handleCommand, getSnapshot };
}

/* ============================================================================
 * 样式
 * ========================================================================== */

const SETTINGS_CSS = `
.view-settings { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--fca-bg-1); color:var(--fca-text); font-family:var(--fca-font-ui); font-size:var(--fca-text-md); }
.view-settings__bar { display:flex; align-items:center; justify-content:space-between; gap:var(--fca-space-3); padding:var(--fca-space-2) var(--fca-space-4); border-bottom:1px solid var(--fca-border); background:var(--fca-bg-2); flex-wrap:wrap; }
.view-settings__title { display:flex; align-items:baseline; gap:var(--fca-space-2); }
.view-settings__title h2 { margin:0; font-size:var(--fca-text-lg); font-weight:600; }
.view-settings__sub { color:var(--fca-text-muted); font-size:var(--fca-text-sm); font-family:var(--fca-font-mono); max-width:44vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.view-settings__actions { display:flex; gap:var(--fca-space-2); }
.view-settings__content { flex:1; min-height:0; overflow-y:auto; padding:var(--fca-space-3) var(--fca-space-4) var(--fca-space-5); }
.view-settings__card { border:1px solid var(--fca-border); border-radius:var(--fca-radius); background:var(--fca-bg-2); padding:var(--fca-space-3); margin-bottom:var(--fca-space-3); }
.view-settings__card-head { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--fca-space-2); margin-bottom:var(--fca-space-2); flex-wrap:wrap; }
.view-settings__card-title { margin:0; font-size:var(--fca-text-sm); color:var(--fca-text-dim); font-weight:600; letter-spacing:.02em; }
.view-settings__muted { color:var(--fca-text-muted); font-size:var(--fca-text-sm); line-height:1.6; }
.view-settings__subtitle { color:var(--fca-text-dim); font-size:var(--fca-text-sm); margin:var(--fca-space-2) 0 var(--fca-space-1); }
.view-settings__mono { font-family:var(--fca-font-mono); font-size:var(--fca-text-xs); word-break:break-all; }
.view-settings__form { display:flex; flex-direction:column; gap:var(--fca-space-2); }
.view-settings__field { display:flex; flex-direction:column; gap:3px; min-width:0; }
.view-settings__label { display:flex; align-items:center; gap:var(--fca-space-2); font-size:var(--fca-text-sm); color:var(--fca-text-dim); }
.view-settings__req { color:var(--fca-danger); }
.view-settings__hint { font-size:var(--fca-text-xs); color:var(--fca-text-muted); line-height:1.5; }
.view-settings__hint--empty { display:none; }
.view-settings__error { color:var(--fca-danger); font-size:var(--fca-text-xs); }
.view-settings__input { width:100%; box-sizing:border-box; background:var(--fca-bg-3); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); color:var(--fca-text); font:inherit; font-size:var(--fca-text-sm); padding:5px var(--fca-space-2); height:30px; outline:none; }
.view-settings__input:focus { border-color:var(--fca-accent); box-shadow:0 0 0 2px var(--fca-accent-soft); }
.view-settings__select { background:var(--fca-bg-3); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); color:var(--fca-text); font:inherit; font-size:var(--fca-text-sm); height:30px; padding:0 var(--fca-space-1); outline:none; }
.view-settings__grid-fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:var(--fca-space-2) var(--fca-space-3); }
.view-settings__inline { display:flex; align-items:center; gap:var(--fca-space-2); flex-wrap:wrap; }
.view-settings__switch-row { gap:var(--fca-space-4); }
.view-settings__switch { display:inline-flex; align-items:center; gap:5px; font-size:var(--fca-text-xs); color:var(--fca-text-dim); cursor:pointer; }
.view-settings__switch input { accent-color:var(--fca-accent); }
.view-settings__kv { display:flex; flex-direction:column; gap:2px; }
.view-settings__kv-row { display:flex; justify-content:space-between; gap:var(--fca-space-3); font-size:var(--fca-text-sm); padding:2px 0; border-bottom:1px dashed var(--fca-border); }
.view-settings__kv-label { color:var(--fca-text-muted); flex:0 0 160px; }
.view-settings__kv-value { color:var(--fca-text-dim); text-align:right; word-break:break-all; }
.view-settings__btn { display:inline-flex; align-items:center; gap:5px; height:28px; padding:0 var(--fca-space-3); border-radius:var(--fca-radius-sm); border:1px solid var(--fca-border); background:var(--fca-bg-3); color:var(--fca-text); font:inherit; font-size:var(--fca-text-sm); cursor:pointer; white-space:nowrap; }
.view-settings__btn:hover { background:var(--fca-bg-4); }
.view-settings__btn:disabled { opacity:.45; cursor:not-allowed; }
.view-settings__btn--primary { background:var(--fca-accent-soft); border-color:var(--fca-accent); color:var(--fca-accent-strong); }
.view-settings__btn--ghost { background:transparent; border-color:transparent; color:var(--fca-text-dim); }
.view-settings__btn--ghost:hover { background:var(--fca-bg-3); color:var(--fca-text); }
.view-settings__btn--danger { background:transparent; border-color:var(--fca-danger); color:var(--fca-danger); }
.view-settings__btn--sm { height:24px; padding:0 var(--fca-space-2); font-size:var(--fca-text-xs); }
.view-settings__spinner-sm { width:11px;height:11px;border-radius:50%;border:2px solid var(--fca-border-strong);border-top-color:var(--fca-accent);animation:view-settings-spin .8s linear infinite; display:inline-block; }
@keyframes view-settings-spin { to { transform:rotate(360deg); } }
.view-settings__notice { display:flex; align-items:center; gap:var(--fca-space-2); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); padding:var(--fca-space-1) var(--fca-space-2); font-size:var(--fca-text-sm); flex-wrap:wrap; }
.view-settings__notice--ok { border-color:color-mix(in srgb, var(--fca-green) 40%, transparent); background:color-mix(in srgb, var(--fca-green) 8%, transparent); }
.view-settings__notice--gold { border-color:color-mix(in srgb, var(--fca-gold) 40%, transparent); background:color-mix(in srgb, var(--fca-gold) 8%, transparent); }
.view-settings__notice--rose { border-color:color-mix(in srgb, var(--fca-danger) 40%, transparent); background:color-mix(in srgb, var(--fca-danger) 8%, transparent); }
.view-settings__errorbox { display:flex; flex-direction:column; gap:var(--fca-space-1); border:1px solid color-mix(in srgb, var(--fca-danger) 45%, var(--fca-border)); background:color-mix(in srgb, var(--fca-danger) 8%, transparent); border-radius:var(--fca-radius-sm); padding:var(--fca-space-2); }
.view-settings__errorbox-title { color:var(--fca-danger); font-weight:600; font-size:var(--fca-text-sm); }
.view-settings__errorbox-detail { color:var(--fca-text-dim); font-size:var(--fca-text-xs); word-break:break-word; }
.view-settings__list { display:flex; flex-direction:column; gap:var(--fca-space-1); }
.view-settings__row { display:flex; align-items:center; justify-content:space-between; gap:var(--fca-space-2); padding:var(--fca-space-2); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); background:var(--fca-bg-1); flex-wrap:wrap; }
.view-settings__row-main { flex:1; min-width:200px; }
.view-settings__theme { display:inline-flex; align-items:center; gap:var(--fca-space-2); font-size:var(--fca-text-sm); color:var(--fca-text); }
.view-settings__theme-swatch { width:26px; height:16px; border-radius:3px; border:1px solid var(--fca-border-strong); background:linear-gradient(135deg, var(--fca-bg-0), var(--fca-bg-3), var(--fca-accent-soft)); }
.view-settings__dialog { display:flex; flex-direction:column; gap:var(--fca-space-2); max-height:62vh; overflow:auto; }
.view-settings__errors { display:flex; flex-direction:column; gap:2px; }
@media (max-width: 900px) { .view-settings__kv-label { flex-basis:120px; } }
`;
