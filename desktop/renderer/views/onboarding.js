/**
 * FCA Memory Atlas — 首次启动向导（整页版，Desktop Editor 组，Alpha 0.1）
 *
 * 契约：desktop/renderer/lib/contracts.md v1.0 §2/§3/§4/§4.6/§6
 * 职责：
 *  - 欢迎 → 数据目录 → 端口 → 初始化空库 → 健康检查 → 完成
 *  - 明确「不导入旧记忆」：初始化只创建全新空库
 *  - 所有配置写入经主进程 window.fca.app.saveSettings；初始化/健康检查经真实 Runtime API
 *  - 幂等：可重复运行；initDb 幂等；已完成的引导会显示标记，可再次进入
 *  - 桥/ Runtime 不可用时明确说明失败原因与手动步骤，不伪造成功
 */

export const meta = {
  id: 'onboarding',
  title: '首次启动向导',
  icon: 'sparkles',
  order: 95,
  nav: false,
  shortcut: '',
};

export const ONBOARDING_STEPS = [
  { id: 'welcome', title: '欢迎', description: '了解 FCA Memory Atlas 与本地优先原则' },
  { id: 'datadir', title: '数据目录', description: '选择本机数据库与备份的存放位置' },
  { id: 'port', title: 'Runtime 端口', description: '本地服务监听端口（仅回环）' },
  { id: 'init', title: '初始化空库', description: '创建全新空白数据库（不导入旧记忆）' },
  { id: 'health', title: '健康检查', description: '验证 Runtime 与数据库可用' },
  { id: 'done', title: '完成', description: '确认配置并进入应用' },
];

export const ONBOARDING_DEFAULT_PORT = 17860;

/* ============================================================================
 * 纯函数（单测覆盖）
 * ========================================================================== */

export function stepIndexById(id) {
  const index = ONBOARDING_STEPS.findIndex((step) => step.id === id);
  return index < 0 ? 0 : index;
}

export function validateOnboardingDataDir(value) {
  const dataDir = String(value || '').trim();
  if (!dataDir) return { ok: false, error: '请选择数据目录（必填）' };
  if (!/^[A-Za-z]:\\|^\\\\|^\//.test(dataDir)) return { ok: false, error: '请输入绝对路径，例如 D:\\FCA\\data' };
  return { ok: true, error: null };
}

export function validateOnboardingPort(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) return { ok: false, error: '端口必须是整数' };
  if (n < 1024 || n > 65535) return { ok: false, error: '端口必须在 1024-65535 之间' };
  return { ok: true, error: null };
}

/** 向导配置 → 主进程设置补丁（纯函数） */
export function buildOnboardingPatch(form) {
  const patch = {};
  const dataDir = String((form && form.dataDir) || '').trim();
  if (dataDir) patch.dataDir = dataDir;
  const port = Number(form && form.port);
  if (Number.isInteger(port)) patch.port = port;
  patch.autoStartRuntime = form && form.autoStartRuntime !== false;
  patch.closeRuntimeOnExit = Boolean(form && form.closeRuntimeOnExit);
  patch.onboardingCompleted = Boolean(form && form.onboardingCompleted);
  return patch;
}

/** 完成页摘要（纯函数） */
export function onboardingSummary(form, health) {
  const rows = [
    { label: '数据目录', value: (form && form.dataDir) || '—', mono: true },
    { label: 'Runtime 端口', value: String((form && form.port) || ONBOARDING_DEFAULT_PORT) },
    { label: '启动时自动启动 Runtime', value: form && form.autoStartRuntime !== false ? '是' : '否' },
    { label: '退出时关闭 Runtime', value: form && form.closeRuntimeOnExit ? '是' : '否' },
    { label: 'Runtime 健康', value: health ? `${health.status || 'unknown'}${health.version ? ` · v${health.version}` : ''}` : '未检查' },
    { label: 'API 版本', value: health && health.api_version ? `v${health.api_version}` : '—' },
    { label: '数据库已初始化', value: health && health.initialized !== undefined ? (health.initialized ? '是' : '否') : '—' },
  ];
  return rows;
}

export function canProceedFromStep(stepId, form) {
  if (stepId === 'datadir') return validateOnboardingDataDir(form && form.dataDir).ok;
  if (stepId === 'port') return validateOnboardingPort(form && form.port).ok;
  return true;
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
  let pollTimer = null;

  const state = {
    step: 0,
    form: {
      dataDir: '',
      port: ONBOARDING_DEFAULT_PORT,
      autoStartRuntime: true,
      closeRuntimeOnExit: false,
      onboardingCompleted: false,
    },
    settingsLoaded: false,
    settingsError: null,
    bridgeAvailable: false,
    runtime: null,
    health: null,
    dbInitialized: null,
    busy: null,
    errors: {},
    log: [],
    checkedAt: null,
    healthError: null,
  };

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
      if (typeof U.icon === 'function') return U.icon(name, opts || { size: 16 });
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
      class: `view-onboarding__btn view-onboarding__btn--${opts.variant || 'secondary'}${opts.size === 'sm' ? ' view-onboarding__btn--sm' : ''}`,
      disabled: Boolean(opts.disabled || opts.loading),
      title: opts.title || '',
      'data-testid': opts.testid || null,
      on: { click: (event) => opts.onClick && opts.onClick(event) },
    }, [opts.icon ? icon(opts.icon) : null, opts.label ? el('span', { text: opts.label }) : null, opts.loading ? el('span', { class: 'view-onboarding__spinner-sm' }) : null]);
  }

  function textInput(opts = {}) {
    const node = el('input', {
      class: 'view-onboarding__input',
      type: opts.type || 'text',
      value: opts.value ?? '',
      placeholder: opts.placeholder || '',
      'data-testid': opts.testid || null,
      autocomplete: 'off',
      spellcheck: 'false',
      disabled: Boolean(opts.disabled),
    });
    if (opts.onInput) node.addEventListener('input', (event) => opts.onInput(event.target.value));
    return node;
  }

  function switchControl(label, checked, onChange) {
    return el('label', { class: 'view-onboarding__switch' }, [
      el('input', { type: 'checkbox', checked: Boolean(checked), on: { change: (event) => onChange(event.target.checked) } }),
      el('span', { text: label }),
    ]);
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
      else window.location.hash = `view=${view}`;
    } catch {
      /* noop */
    }
  }

  function pushLog(text, tone) {
    state.log.push({ at: new Date().toISOString(), text, tone: tone || 'info' });
    if (state.log.length > 80) state.log.shift();
    renderLog();
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
    state.bridgeAvailable = Boolean(b && b.app && typeof b.app.saveSettings === 'function');
    const store = storeState();
    if (store && store.settings) {
      state.form = {
        ...state.form,
        dataDir: store.settings.dataDir || state.form.dataDir,
        port: Number.isFinite(store.settings.port) ? store.settings.port : state.form.port,
        autoStartRuntime: store.settings.autoStartRuntime !== false,
        closeRuntimeOnExit: Boolean(store.settings.closeRuntimeOnExit),
        onboardingCompleted: Boolean(store.settings.onboardingCompleted),
      };
    }
    if (b && b.app && typeof b.app.getSettings === 'function') {
      try {
        const res = await b.app.getSettings();
        const settings = (res && res.settings) || res;
        if (settings && typeof settings === 'object') {
          state.form = {
            dataDir: settings.dataDir || state.form.dataDir,
            port: Number.isFinite(settings.port) ? settings.port : state.form.port,
            autoStartRuntime: settings.autoStartRuntime !== false,
            closeRuntimeOnExit: Boolean(settings.closeRuntimeOnExit),
            onboardingCompleted: Boolean(settings.onboardingCompleted),
          };
        }
        state.settingsLoaded = true;
        state.settingsError = null;
      } catch (err) {
        state.settingsError = errInfo(err);
      }
    } else {
      state.settingsLoaded = Boolean(store && store.settings);
      if (!state.settingsLoaded) state.settingsError = { message: '当前外壳未提供设置桥（window.fca 不可用），无法读取/保存配置', code: 'NO_BRIDGE', traceId: null };
    }
    state.runtime = store && store.runtime ? store.runtime : null;
    render();
  }

  async function checkHealth() {
    state.healthError = null;
    state.busy = 'health';
    render();
    try {
      const health = await api.health();
      state.health = health;
      state.dbInitialized = health && health.initialized !== undefined ? Boolean(health.initialized) : null;
      state.checkedAt = new Date().toISOString();
      pushLog(`健康检查通过：status=${health && health.status} version=${health && health.version} api=v${health && health.api_version} initialized=${String(state.dbInitialized)}`, 'ok');
      render();
      return health;
    } catch (err) {
      state.health = null;
      state.healthError = errInfo(err);
      pushLog(`健康检查失败：${state.healthError.message}`, 'error');
      render();
      return null;
    } finally {
      state.busy = null;
    }
  }

  /* -------------------------------- 渲染 -------------------------------- */

  function mount(container) {
    styleEl = doc.createElement('style');
    styleEl.id = 'view-onboarding-style';
    styleEl.textContent = ONBOARDING_CSS;
    doc.head.append(styleEl);
    root = el('div', { class: 'view-onboarding', 'data-testid': 'view-onboarding' });
    container.append(root);
    render();
    loadSettings();
    subscribeMany(['runtime:status'], () => {
      const store = storeState();
      state.runtime = store && store.runtime ? store.runtime : null;
      renderStatusStrip();
    });
  }

  function render() {
    if (!root) return;
    root.textContent = '';
    root.append(renderShell());
    const stepsHost = el('div', { class: 'view-onboarding__steps' });
    for (let i = 0; i < ONBOARDING_STEPS.length; i += 1) {
      stepsHost.append(el('div', {
        class: `view-onboarding__step${i === state.step ? ' is-active' : ''}${i < state.step ? ' is-done' : ''}`,
        'data-testid': `onboarding-step-${ONBOARDING_STEPS[i].id}`,
      }, [
        el('span', { class: 'view-onboarding__step-index', text: i < state.step ? '✓' : String(i + 1) }),
        el('span', { class: 'view-onboarding__step-title', text: ONBOARDING_STEPS[i].title }),
      ]));
    }
    const card = el('div', { class: 'view-onboarding__card' });
    card.append(stepsHost, renderStepBody());
    root.append(card, renderFooter());
  }

  function renderShell() {
    const bridgeOk = state.bridgeAvailable;
    return el('div', { class: 'view-onboarding__hero' }, [
      el('div', { class: 'view-onboarding__orb' }),
      el('div', { class: 'view-onboarding__hero-text' }, [
        el('h1', { text: '欢迎使用 FCA Memory Atlas' }),
        el('p', { text: '本地优先的认知记忆系统：数据留在本机 SQLite，星云可视化呈现记忆与关系。下面是首次启动配置。' }),
        el('div', { class: 'view-onboarding__badges' }, [
          el('span', { class: 'view-onboarding__badge', text: 'Alpha 0.1' }),
          el('span', { class: 'view-onboarding__badge', text: '仅回环 127.0.0.1' }),
          el('span', { class: 'view-onboarding__badge', text: '不迁移旧记忆' }),
          el('span', { class: `view-onboarding__badge view-onboarding__badge--${bridgeOk ? 'ok' : 'warn'}`, text: bridgeOk ? '桌面桥可用' : '桌面桥不可用' }),
        ]),
      ]),
    ]);
  }

  function renderStatusStrip() {
    const host = root && root.querySelector('[data-testid="onboarding-status"]');
    if (!host) return;
    host.textContent = '';
    host.append(el('span', { class: `view-onboarding__dot view-onboarding__dot--${state.health ? 'ok' : state.runtime && state.runtime.state === 'running' ? 'warn' : 'error'}` }));
    const runtime = state.runtime;
    host.append(el('span', { text: runtime ? `Runtime：${runtime.state}${runtime.url ? ` · ${runtime.url}` : ''}` : 'Runtime：状态未知' }));
    if (state.health) host.append(el('span', { class: 'view-onboarding__muted', text: `健康 ${state.health.status} · API v${state.health.api_version || '?'} · 数据库${state.health.initialized ? '已初始化' : '未初始化'}` }));
    if (state.healthError) host.append(el('span', { class: 'view-onboarding__unavailable', text: `健康检查失败：${state.healthError.message}` }));
    if (state.checkedAt) host.append(el('span', { class: 'view-onboarding__muted view-onboarding__mono', text: `检查于 ${new Date(state.checkedAt).toLocaleTimeString()}` }));
  }

  function renderStepBody() {
    const bodies = {
      welcome: renderWelcome,
      datadir: renderDataDir,
      port: renderPort,
      init: renderInit,
      health: renderHealth,
      done: renderDone,
    };
    const fn = bodies[ONBOARDING_STEPS[state.step].id] || renderWelcome;
    return fn();
  }

  function renderWelcome() {
    const body = el('div', { class: 'view-onboarding__body' });
    body.append(
      el('p', { class: 'view-onboarding__lead', text: '本次向导将完成：选择数据目录（不会导入任何旧记忆）、配置本地 Runtime 端口、初始化一个全新的空数据库，并验证它能正常工作。' }),
      el('div', { class: 'view-onboarding__points' }, [
        point('shield', '数据只在本机', 'Runtime 仅监听 127.0.0.1，数据库为本地 SQLite；不上传云服务。'),
        point('database', '全新空库', '初始化只创建空结构；本产品不会读取或迁移旧记忆系统数据。'),
        point('activity', '可验证', '最后一步会真实调用 /health 与 /db/init，失败会明确显示原因。'),
        point('settings', '可重复配置', '向导可以重复运行；配置写入 desktop-settings.json。'),
      ]),
      state.settingsError
        ? el('div', { class: 'view-onboarding__errorbox', role: 'alert' }, [
          el('div', { class: 'view-onboarding__errorbox-title', text: '配置环境不可用' }),
          el('div', { class: 'view-onboarding__errorbox-detail', text: `${state.settingsError.message}（${state.settingsError.code}）` }),
          el('div', { class: 'view-onboarding__muted', text: '在真实桌面应用（Electron）中打开时，可经 main/preload 设置桥读写配置。当前环境可能缺少窗口外壳。' }),
          button({ label: '重试加载配置', icon: 'refresh', size: 'sm', onClick: () => loadSettings() }),
        ])
        : el('div', { class: 'view-onboarding__muted', text: state.settingsLoaded ? `当前数据目录：${state.form.dataDir}` : '正在读取桌面配置…' }),
      state.form.onboardingCompleted
        ? el('div', { class: 'view-onboarding__notice view-onboarding__notice--gold' }, [el('span', { text: '引导曾已完成；本次运行将重新校验配置，不会清空已有数据。' })])
        : null,
      el('div', { class: 'view-onboarding__actions' }, [
        button({ label: '开始配置', icon: 'chevron-right', variant: 'primary', testid: 'onboarding-start', disabled: !state.settingsLoaded, onClick: () => goStep(1) }),
        state.settingsLoaded
          ? button({ label: '跳过：直接检查 Runtime', variant: 'ghost', onClick: () => goStep(4) })
          : null,
      ]),
    );
    return body;
  }

  function point(iconName, title, text) {
    return el('div', { class: 'view-onboarding__point' }, [
      el('span', { class: 'view-onboarding__point-icon' }, [icon(iconName, { size: 18 })]),
      el('div', {}, [
        el('div', { class: 'view-onboarding__point-title', text: title }),
        el('div', { class: 'view-onboarding__muted', text }),
      ]),
    ]);
  }

  function renderDataDir() {
    const error = state.errors.dataDir;
    const input = textInput({
      value: state.form.dataDir,
      placeholder: '例如 D:\\FCA\\data 或 C:\\Users\\<你>\\AppData\\Local\\FCA-Memory-Atlas',
      testid: 'onboarding-datadir',
      onInput: (value) => {
        state.form.dataDir = value;
        state.errors.dataDir = null;
        renderFooterState();
      },
    });
    const body = el('div', { class: 'view-onboarding__body' }, [
      el('h2', { text: '选择数据目录' }),
      el('p', { class: 'view-onboarding__muted', text: 'Runtime 的数据库、事件、备份、日志都会放在该目录。目录为空或不存在时会被创建；如果目录中已有 FCA 数据，将直接使用（不会导入旧记忆系统数据）。' }),
      el('label', { class: 'view-onboarding__field' }, [
        el('span', { class: 'view-onboarding__label', text: '数据目录' }),
        el('div', { class: 'view-onboarding__inline' }, [
          input,
          bridge() && bridge().dialog && bridge().dialog.selectDirectory
            ? button({ label: '选择…', icon: 'folder', size: 'sm', onClick: () => chooseDataDir() })
            : el('span', { class: 'view-onboarding__muted', text: '（非桌面环境不可选择目录）' }),
        ]),
        error ? el('span', { class: 'view-onboarding__error', text: error, 'data-testid': 'onboarding-error-datadir' }) : null,
      ]),
      el('div', { class: 'view-onboarding__notice view-onboarding__notice--gold' }, [
        el('span', { text: '重要：本产品不导入、不迁移任何旧记忆库数据。' }),
        el('span', { class: 'view-onboarding__muted', text: '如需迁移旧数据，请在 Alpha 版本之后使用官方导入工具并单独授权。' }),
      ]),
    ]);
    return body;
  }

  function renderPort() {
    const error = state.errors.port;
    const input = textInput({
      type: 'number',
      value: String(state.form.port),
      testid: 'onboarding-port',
      onInput: (value) => {
        state.form.port = Number(value);
        state.errors.port = null;
        renderFooterState();
      },
    });
    const body = el('div', { class: 'view-onboarding__body' }, [
      el('h2', { text: '配置 Runtime 端口' }),
      el('p', { class: 'view-onboarding__muted', text: 'FCA Local Runtime 是本地认知服务。端口将写入 desktop-settings.json，并用于本机回环地址 http://127.0.0.1:<端口>。仅允许本机访问。' }),
      el('label', { class: 'view-onboarding__field' }, [
        el('span', { class: 'view-onboarding__label', text: '端口（1024-65535）' }),
        el('div', { class: 'view-onboarding__inline' }, [input, el('span', { class: 'view-onboarding__muted', text: `推导地址：http://127.0.0.1:${state.form.port || ONBOARDING_DEFAULT_PORT}` })]),
        error ? el('span', { class: 'view-onboarding__error', text: error, 'data-testid': 'onboarding-error-port' }) : null,
      ]),
      el('div', { class: 'view-onboarding__inline view-onboarding__switches' }, [
        switchControl('应用启动时自动启动 Runtime', state.form.autoStartRuntime, (checked) => { state.form.autoStartRuntime = checked; }),
        switchControl('退出应用时关闭由本应用启动的 Runtime', state.form.closeRuntimeOnExit, (checked) => { state.form.closeRuntimeOnExit = checked; }),
      ]),
      el('div', { class: 'view-onboarding__muted', text: `默认端口为 ${ONBOARDING_DEFAULT_PORT}。若端口被占用，Runtime 启动会失败并显示明确错误；可修改端口后重试。` }),
    ]);
    return body;
  }

  function renderInit() {
    const summary = onboardingSummary(state.form, null);
    const body = el('div', { class: 'view-onboarding__body' }, [
      el('h2', { text: '初始化空白数据库' }),
      el('p', { class: 'view-onboarding__muted', text: '此步骤会：1) 将配置写入 desktop-settings.json；2) 启动本地 Runtime；3) 调用 POST /api/v1/db/init 创建全新空库（幂等）。不会导入任何旧记忆。' }),
      el('div', { class: 'view-onboarding__summary' }, summary.map((row) => el('div', { class: 'view-onboarding__summary-row' }, [
        el('span', { class: 'view-onboarding__muted', text: row.label }),
        el('span', { class: `view-onboarding__summary-value${row.mono ? ' view-onboarding__mono' : ''}`, text: row.value }),
      ]))),
      state.settingsError
        ? el('div', { class: 'view-onboarding__errorbox', role: 'alert' }, [
          el('div', { class: 'view-onboarding__errorbox-title', text: '无法保存配置：桌面桥不可用' }),
          el('div', { class: 'view-onboarding__errorbox-detail', text: state.settingsError.message }),
          el('div', { class: 'view-onboarding__muted', text: '手动步骤：在桌面应用中打开本向导，或在数据目录创建 desktop-settings.json（字段 dataDir/port/autoStartRuntime）。Runtime 运行时执行 POST /api/v1/db/init。' }),
        ])
        : null,
      el('div', { class: 'view-onboarding__actions' }, [
        button({
          label: state.busy === 'init' ? '正在初始化…' : '保存配置并初始化空库',
          icon: 'database',
          variant: 'primary',
          loading: state.busy === 'init',
          testid: 'onboarding-init',
          onClick: () => initialize(),
        }),
        state.health ? button({ label: '检查当前 Runtime 状态', variant: 'ghost', onClick: () => goStep(4) }) : null,
      ]),
      renderLogHost(),
    ]);
    return body;
  }

  function renderHealth() {
    const body = el('div', { class: 'view-onboarding__body' }, [
      el('h2', { text: '健康检查' }),
      el('p', { class: 'view-onboarding__muted', text: '真实调用 GET /health（免认证）验证 Runtime 与数据库；若数据库未初始化，可在此直接初始化空库。' }),
      el('div', { class: 'view-onboarding__inline' }, [
        button({ label: state.busy === 'health' ? '检查中…' : '重新检查', icon: 'activity', loading: state.busy === 'health', testid: 'onboarding-health', onClick: () => checkHealth() }),
        state.health && state.health.initialized === false
          ? button({ label: '初始化空库', icon: 'database', variant: 'primary', loading: state.busy === 'init', onClick: () => initialize({ skipSettings: true }) })
          : null,
        button({ label: '打开数据管理', icon: 'database', variant: 'ghost', onClick: () => navigate('data', {}) }),
      ]),
      state.health
        ? el('div', { class: 'view-onboarding__summary' }, [
          summaryRow('Runtime 状态', String(state.health.status || 'unknown')),
          summaryRow('版本', String(state.health.version || '—')),
          summaryRow('API 版本', String(state.health.api_version || '—')),
          summaryRow('运行时长', Number.isFinite(state.health.uptime_ms) ? `${Math.round(state.health.uptime_ms / 1000)} 秒` : '—'),
          summaryRow('数据库已初始化', state.health.initialized === true ? '是' : state.health.initialized === false ? '否' : '未知'),
          summaryRow('数据库状态', String(state.health.db || '—')),
        ])
        : state.healthError
          ? el('div', { class: 'view-onboarding__errorbox', role: 'alert' }, [
            el('div', { class: 'view-onboarding__errorbox-title', text: '健康检查失败' }),
            el('div', { class: 'view-onboarding__errorbox-detail', text: `${state.healthError.message}${state.healthError.traceId ? ` · trace ${state.healthError.traceId}` : ''}` }),
            el('div', { class: 'view-onboarding__muted', text: `常见原因：Runtime 未启动、端口 ${state.form.port} 被占用、或数据目录不可写。可在状态栏点击“启动”或在设置页重试。` }),
          ])
          : el('div', { class: 'view-onboarding__muted', text: '尚未执行健康检查。点击上方按钮开始。' }),
      renderLogHost(),
    ]);
    return body;
  }

  function summaryRow(label, value) {
    return el('div', { class: 'view-onboarding__summary-row' }, [
      el('span', { class: 'view-onboarding__muted', text: label }),
      el('span', { class: 'view-onboarding__summary-value', text: value }),
    ]);
  }

  function renderDone() {
    const rows = onboardingSummary(state.form, state.health);
    const body = el('div', { class: 'view-onboarding__body' }, [
      el('h2', { text: '配置完成' }),
      el('p', { class: 'view-onboarding__muted', text: '以下为本次向导确认的真实配置与检查结果。点击“进入星图”开始使用；之后可随时在设置页修改。' }),
      el('div', { class: 'view-onboarding__summary' }, rows.map((row) => el('div', { class: 'view-onboarding__summary-row' }, [
        el('span', { class: 'view-onboarding__muted', text: row.label }),
        el('span', { class: `view-onboarding__summary-value${row.mono ? ' view-onboarding__mono' : ''}`, text: row.value }),
      ]))),
      el('div', { class: 'view-onboarding__notice ' + (state.health && state.health.status ? 'view-onboarding__notice--ok' : 'view-onboarding__notice--gold') }, [
        el('span', { text: state.health && state.health.initialized ? 'Runtime 与数据库已就绪。' : '尚未确认数据库就绪；可先进入应用后在“数据管理”中初始化/检查。' }),
      ]),
      el('div', { class: 'view-onboarding__actions' }, [
        button({ label: '标记完成并进入星图', icon: 'compass', variant: 'primary', testid: 'onboarding-finish', loading: state.busy === 'finish', onClick: () => finish() }),
        button({ label: '打开数据管理', icon: 'database', variant: 'ghost', onClick: () => navigate('data', {}) }),
        state.health ? null : button({ label: '返回检查', variant: 'ghost', onClick: () => goStep(4) }),
      ]),
      renderLogHost(),
    ]);
    return body;
  }

  function renderLog() {
    const host = root && root.querySelector('[data-testid="onboarding-log"]');
    if (!host) return;
    host.textContent = '';
    if (!state.log.length) {
      host.append(el('div', { class: 'view-onboarding__muted', text: '（操作日志将显示在这里，便于排查真实问题）' }));
      return;
    }
    for (const entry of state.log.slice(-40)) {
      host.append(el('div', { class: `view-onboarding__log-line view-onboarding__log-line--${entry.tone}`, text: `[${new Date(entry.at).toLocaleTimeString()}] ${entry.text}` }));
    }
    host.scrollTop = host.scrollHeight;
  }

  function renderLogHost() {
    const host = el('div', { class: 'view-onboarding__log', 'data-testid': 'onboarding-log' });
    requestAnimationFrame(() => renderLog());
    return host;
  }

  function renderFooter() {
    const last = state.step >= ONBOARDING_STEPS.length - 1;
    const host = el('div', { class: 'view-onboarding__footer', 'data-testid': 'onboarding-footer' }, [
      el('div', { class: 'view-onboarding__status', 'data-testid': 'onboarding-status' }),
      el('div', { class: 'view-onboarding__footer-actions' }, [
        state.step > 0 ? button({ label: '上一步', variant: 'ghost', onClick: () => goStep(state.step - 1) }) : null,
        !last
          ? button({
            label: '下一步',
            icon: 'chevron-right',
            variant: 'primary',
            testid: 'onboarding-next',
            disabled: !canProceedFromStep(ONBOARDING_STEPS[state.step].id, state.form),
            onClick: () => goStep(state.step + 1),
          })
          : null,
      ]),
    ]);
    requestAnimationFrame(() => renderStatusStrip());
    return host;
  }

  function renderFooterState() {
    render();
  }

  function goStep(index) {
    const step = Math.max(0, Math.min(ONBOARDING_STEPS.length - 1, index));
    const currentId = ONBOARDING_STEPS[state.step].id;
    if (currentId === 'datadir') {
      const check = validateOnboardingDataDir(state.form.dataDir);
      if (!check.ok) {
        state.errors.dataDir = check.error;
        render();
        return;
      }
    }
    if (currentId === 'port') {
      const check = validateOnboardingPort(state.form.port);
      if (!check.ok) {
        state.errors.port = check.error;
        render();
        return;
      }
    }
    state.step = step;
    render();
    if (ONBOARDING_STEPS[step].id === 'health' && !state.health) checkHealth();
    if (ONBOARDING_STEPS[step].id === 'init' && state.health && state.health.initialized === true) {
      // 已初始化也允许继续，但提示幂等
      pushLog('数据库已初始化：initDb 为幂等调用，重复执行不会清空数据', 'warn');
      renderLog();
    }
  }

  async function chooseDataDir() {
    const b = bridge();
    if (!b || !b.dialog || typeof b.dialog.selectDirectory !== 'function') {
      notify('warn', '当前外壳未提供目录选择桥');
      return;
    }
    try {
      const res = await b.dialog.selectDirectory({ title: '选择 FCA 数据目录（不会导入旧记忆）' });
      if (res && res.ok && res.path) {
        state.form.dataDir = res.path;
        state.errors.dataDir = null;
        render();
      }
    } catch (err) {
      notify('error', `选择目录失败：${errInfo(err).message}`);
    }
  }

  /* ------------------------------- 操作 ------------------------------- */

  async function initialize(opts = {}) {
    if (state.busy) return;
    const dataDirCheck = validateOnboardingDataDir(state.form.dataDir);
    const portCheck = validateOnboardingPort(state.form.port);
    state.errors = {};
    if (!dataDirCheck.ok) state.errors.dataDir = dataDirCheck.error;
    if (!portCheck.ok) state.errors.port = portCheck.error;
    if (Object.keys(state.errors).length) {
      render();
      notify('error', Object.values(state.errors)[0]);
      return;
    }
    state.busy = 'init';
    render();
    const b = bridge();
    try {
      if (!opts.skipSettings) {
        if (!b || !b.app || typeof b.app.saveSettings !== 'function') {
          throw Object.assign(new Error('桌面设置桥不可用（window.fca.app.saveSettings），无法保存数据目录/端口'), { code: 'NO_BRIDGE' });
        }
        const patch = buildOnboardingPatch({ ...state.form, onboardingCompleted: state.form.onboardingCompleted });
        pushLog(`保存配置：dataDir=${state.form.dataDir} port=${state.form.port}`);
        const saved = await b.app.saveSettings(patch);
        if (saved && saved.ok === false) {
          const message = (saved.errors && saved.errors[0] && saved.errors[0].message) || '主进程拒绝保存配置';
          throw Object.assign(new Error(message), { code: 'SETTINGS_REJECTED' });
        }
        pushLog('配置已保存到 desktop-settings.json', 'ok');
      }
      // 启动 Runtime（若桥可用）
      if (b && b.runtime && typeof b.runtime.start === 'function') {
        pushLog('请求启动本地 Runtime…');
        renderLog();
        const startRes = await b.runtime.start({ reason: 'onboarding' });
        const started = startRes && (startRes.ok === undefined ? !startRes.error : startRes.ok);
        if (!started) {
          const message = (startRes && startRes.error && (startRes.error.message || startRes.error.code)) || 'Runtime 启动失败';
          throw Object.assign(new Error(message), { code: 'RUNTIME_START_FAILED' });
        }
        pushLog('Runtime 已启动', 'ok');
      } else {
        pushLog('无 Runtime 控制桥：假设 Runtime 已由外部启动', 'warn');
      }
      // 健康检查（等待启动）
      let health = null;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        try {
          health = await api.health();
          if (health) break;
        } catch {
          /* 继续等待 */
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      if (!health) throw Object.assign(new Error('无法连接 Runtime /health，请检查端口与日志'), { code: 'NETWORK_ERROR' });
      state.health = health;
      state.dbInitialized = health.initialized === true;
      pushLog(`Runtime 健康：status=${health.status} v${health.version} api=v${health.api_version}`, 'ok');
      // 初始化空库（幂等）
      if (health.initialized === false) {
        pushLog('调用 POST /api/v1/db/init 初始化空库…');
        renderLog();
        const initRes = await api.initDb();
        pushLog(`空库初始化完成${initRes && initRes.initialized !== undefined ? `（initialized=${String(initRes.initialized)}）` : ''}`, 'ok');
        const refreshed = await api.health();
        state.health = refreshed;
        state.dbInitialized = refreshed && refreshed.initialized === true;
      } else {
        pushLog('数据库已初始化：跳过初始化（幂等）', 'info');
      }
      state.busy = null;
      state.checkedAt = new Date().toISOString();
      state.step = stepIndexById('health');
      render();
      notify('success', '初始化完成，数据库已就绪');
    } catch (err) {
      state.busy = null;
      const info = errInfo(err);
      state.errors.init = `${info.message}${info.traceId ? ` · trace ${info.traceId}` : ''}`;
      pushLog(`初始化失败：${info.message}（${info.code}）`, 'error');
      render();
      notify('error', `初始化失败：${info.message}`);
    }
  }

  async function finish() {
    if (state.busy) return;
    state.busy = 'finish';
    render();
    const b = bridge();
    try {
      if (b && b.app && typeof b.app.saveSettings === 'function') {
        const saved = await b.app.saveSettings({ onboardingCompleted: true });
        if (saved && saved.ok === false) {
          const message = (saved.errors && saved.errors[0] && saved.errors[0].message) || '主进程拒绝保存';
          throw Object.assign(new Error(message), { code: 'SETTINGS_REJECTED' });
        }
        state.form.onboardingCompleted = true;
        pushLog('已标记引导完成（onboardingCompleted=true）', 'ok');
      } else {
        pushLog('无设置桥：无法持久化完成标记；本次配置未保存', 'warn');
      }
      state.busy = null;
      notify('success', '配置完成，正在进入星图');
      navigate('atlas', {});
    } catch (err) {
      state.busy = null;
      state.errors.finish = errInfo(err).message;
      render();
      notify('error', `保存完成标记失败：${errInfo(err).message}`);
    }
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  function unmount() {
    if (pollTimer) clearTimeout(pollTimer);
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
  }

  function activate() {
    if (!state.settingsLoaded) loadSettings();
  }

  function handleCommand(command) {
    if (command === 'view:refresh') {
      loadSettings();
      return true;
    }
    return false;
  }

  function getSnapshot() {
    return { step: ONBOARDING_STEPS[state.step].id };
  }

  return { mount, unmount, activate, handleCommand, getSnapshot };
}

/* ============================================================================
 * 样式
 * ========================================================================== */

const ONBOARDING_CSS = `
.view-onboarding { display:flex; flex-direction:column; height:100%; min-height:0; background:radial-gradient(circle at 20% 0%, var(--fca-bg-2), var(--fca-bg-1) 60%, var(--fca-bg-0)); color:var(--fca-text); font-family:var(--fca-font-ui); font-size:var(--fca-text-md); overflow-y:auto; padding:var(--fca-space-5); }
.view-onboarding__hero { display:flex; align-items:center; gap:var(--fca-space-5); margin:0 auto var(--fca-space-4); max-width:980px; width:100%; }
.view-onboarding__orb { width:84px; height:84px; border-radius:50%; flex-shrink:0; background:radial-gradient(circle at 35% 30%, var(--fca-accent-soft), transparent 60%), radial-gradient(circle at 60% 65%, color-mix(in srgb, var(--fca-violet) 28%, transparent), transparent 70%), var(--fca-bg-3); border:1px solid var(--fca-border-strong); box-shadow:0 0 34px rgba(127,184,217,.16); }
.view-onboarding__hero-text h1 { margin:0 0 var(--fca-space-1); font-size:var(--fca-text-xl); font-weight:600; letter-spacing:.01em; }
.view-onboarding__hero-text p { margin:0 0 var(--fca-space-2); color:var(--fca-text-dim); font-size:var(--fca-text-md); line-height:1.7; max-width:720px; }
.view-onboarding__badges { display:flex; gap:var(--fca-space-1); flex-wrap:wrap; }
.view-onboarding__badge { font-size:var(--fca-text-xs); padding:1px 7px; border-radius:999px; border:1px solid var(--fca-border-strong); color:var(--fca-text-muted); }
.view-onboarding__badge--ok { color:var(--fca-green); border-color:color-mix(in srgb, var(--fca-green) 45%, transparent); }
.view-onboarding__badge--warn { color:var(--fca-gold); border-color:color-mix(in srgb, var(--fca-gold) 45%, transparent); }
.view-onboarding__card { max-width:980px; width:100%; margin:0 auto; border:1px solid var(--fca-border); border-radius:var(--fca-radius-lg); background:var(--fca-bg-2); box-shadow:var(--fca-shadow-panel); overflow:hidden; flex-shrink:0; }
.view-onboarding__steps { display:flex; flex-wrap:wrap; gap:2px; padding:var(--fca-space-2) var(--fca-space-3); border-bottom:1px solid var(--fca-border); background:var(--fca-bg-3); }
.view-onboarding__step { display:inline-flex; align-items:center; gap:5px; padding:3px var(--fca-space-2); border-radius:999px; border:1px solid transparent; font-size:var(--fca-text-xs); color:var(--fca-text-muted); }
.view-onboarding__step.is-active { border-color:var(--fca-accent); background:var(--fca-accent-soft); color:var(--fca-accent-strong); }
.view-onboarding__step.is-done { color:var(--fca-green); }
.view-onboarding__step-index { width:16px; height:16px; border-radius:50%; border:1px solid currentColor; display:inline-flex; align-items:center; justify-content:center; font-size:10px; }
.view-onboarding__body { padding:var(--fca-space-4) var(--fca-space-5); display:flex; flex-direction:column; gap:var(--fca-space-3); }
.view-onboarding__body h2 { margin:0; font-size:var(--fca-text-lg); font-weight:600; }
.view-onboarding__lead { margin:0; line-height:1.75; color:var(--fca-text); }
.view-onboarding__muted { color:var(--fca-text-muted); font-size:var(--fca-text-sm); line-height:1.7; }
.view-onboarding__mono { font-family:var(--fca-font-mono); font-size:var(--fca-text-xs); word-break:break-all; }
.view-onboarding__points { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:var(--fca-space-2); }
.view-onboarding__point { display:flex; gap:var(--fca-space-2); padding:var(--fca-space-2); border:1px solid var(--fca-border); border-radius:var(--fca-radius); background:var(--fca-bg-1); }
.view-onboarding__point-icon { color:var(--fca-accent); flex-shrink:0; }
.view-onboarding__point-title { font-size:var(--fca-text-sm); color:var(--fca-text); margin-bottom:2px; }
.view-onboarding__field { display:flex; flex-direction:column; gap:4px; }
.view-onboarding__label { font-size:var(--fca-text-sm); color:var(--fca-text-dim); }
.view-onboarding__input { flex:1; min-width:260px; background:var(--fca-bg-3); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); color:var(--fca-text); font:inherit; font-size:var(--fca-text-md); height:32px; padding:0 var(--fca-space-2); outline:none; box-sizing:border-box; }
.view-onboarding__input:focus { border-color:var(--fca-accent); box-shadow:0 0 0 2px var(--fca-accent-soft); }
.view-onboarding__inline { display:flex; align-items:center; gap:var(--fca-space-2); flex-wrap:wrap; }
.view-onboarding__switches { gap:var(--fca-space-4); }
.view-onboarding__switch { display:inline-flex; align-items:center; gap:5px; font-size:var(--fca-text-xs); color:var(--fca-text-dim); cursor:pointer; }
.view-onboarding__switch input { accent-color:var(--fca-accent); }
.view-onboarding__notice { display:flex; align-items:center; gap:var(--fca-space-2); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); padding:var(--fca-space-1) var(--fca-space-2); font-size:var(--fca-text-sm); flex-wrap:wrap; }
.view-onboarding__notice--ok { border-color:color-mix(in srgb, var(--fca-green) 40%, transparent); background:color-mix(in srgb, var(--fca-green) 8%, transparent); }
.view-onboarding__notice--gold { border-color:color-mix(in srgb, var(--fca-gold) 40%, transparent); background:color-mix(in srgb, var(--fca-gold) 8%, transparent); }
.view-onboarding__summary { display:flex; flex-direction:column; gap:2px; border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); padding:var(--fca-space-2); background:var(--fca-bg-1); }
.view-onboarding__summary-row { display:flex; justify-content:space-between; gap:var(--fca-space-3); font-size:var(--fca-text-sm); padding:2px 0; border-bottom:1px dashed var(--fca-border); }
.view-onboarding__summary-row:last-child { border-bottom:none; }
.view-onboarding__summary-value { color:var(--fca-text); text-align:right; word-break:break-all; }
.view-onboarding__actions { display:flex; gap:var(--fca-space-2); flex-wrap:wrap; }
.view-onboarding__btn { display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 var(--fca-space-4); border-radius:var(--fca-radius-sm); border:1px solid var(--fca-border); background:var(--fca-bg-3); color:var(--fca-text); font:inherit; font-size:var(--fca-text-sm); cursor:pointer; white-space:nowrap; }
.view-onboarding__btn:hover { background:var(--fca-bg-4); }
.view-onboarding__btn:disabled { opacity:.45; cursor:not-allowed; }
.view-onboarding__btn--primary { background:var(--fca-accent-soft); border-color:var(--fca-accent); color:var(--fca-accent-strong); }
.view-onboarding__btn--ghost { background:transparent; border-color:transparent; color:var(--fca-text-dim); }
.view-onboarding__btn--ghost:hover { background:var(--fca-bg-3); color:var(--fca-text); }
.view-onboarding__btn--danger { background:transparent; border-color:var(--fca-danger); color:var(--fca-danger); }
.view-onboarding__btn--sm { height:26px; padding:0 var(--fca-space-2); font-size:var(--fca-text-xs); }
.view-onboarding__spinner-sm { width:12px;height:12px;border-radius:50%;border:2px solid var(--fca-border-strong);border-top-color:var(--fca-accent);animation:view-onboarding-spin .8s linear infinite; display:inline-block; }
@keyframes view-onboarding-spin { to { transform:rotate(360deg); } }
.view-onboarding__errorbox { display:flex; flex-direction:column; gap:var(--fca-space-1); border:1px solid color-mix(in srgb, var(--fca-danger) 45%, var(--fca-border)); background:color-mix(in srgb, var(--fca-danger) 8%, transparent); border-radius:var(--fca-radius-sm); padding:var(--fca-space-2); }
.view-onboarding__errorbox-title { color:var(--fca-danger); font-weight:600; }
.view-onboarding__errorbox-detail { color:var(--fca-text-dim); font-size:var(--fca-text-sm); word-break:break-word; }
.view-onboarding__error { color:var(--fca-danger); font-size:var(--fca-text-xs); }
.view-onboarding__unavailable { color:var(--fca-gold); font-size:var(--fca-text-xs); }
.view-onboarding__log { max-height:180px; overflow:auto; background:var(--fca-bg-0); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); padding:var(--fca-space-2); font-family:var(--fca-font-mono); font-size:var(--fca-text-xs); }
.view-onboarding__log-line { white-space:pre-wrap; word-break:break-word; line-height:1.55; color:var(--fca-text-dim); }
.view-onboarding__log-line--ok { color:var(--fca-green); }
.view-onboarding__log-line--warn { color:var(--fca-gold); }
.view-onboarding__log-line--error { color:var(--fca-danger); }
.view-onboarding__footer { max-width:980px; width:100%; margin:var(--fca-space-3) auto 0; display:flex; align-items:center; justify-content:space-between; gap:var(--fca-space-2); flex-wrap:wrap; }
.view-onboarding__status { display:flex; align-items:center; gap:var(--fca-space-2); font-size:var(--fca-text-xs); color:var(--fca-text-dim); flex-wrap:wrap; }
.view-onboarding__dot { width:7px; height:7px; border-radius:50%; background:var(--fca-text-muted); }
.view-onboarding__dot--ok { background:var(--fca-green); }
.view-onboarding__dot--warn { background:var(--fca-gold); }
.view-onboarding__dot--error { background:var(--fca-danger); }
.view-onboarding__footer-actions { display:flex; gap:var(--fca-space-2); }
`;
