/**
 * FCA Memory Atlas — 首次启动向导
 *
 * 真实动作：选择数据目录 → 端口 → 保存设置 → 启动 Runtime → 健康检查 → 初始化空库。
 * 明确提示：全新空库，不导入/不迁移任何旧记忆系统数据。
 */

import { icon } from '../ui/icons.js';

const STEPS = [
  { id: 1, label: '欢迎与数据主权' },
  { id: 2, label: '数据目录' },
  { id: 3, label: '本地端口' },
  { id: 4, label: '启动与初始化' },
  { id: 5, label: '完成' },
];

export function openOnboarding(ctx) {
  const { bridge, api, store, ui, toast, format, startStep = 1, initial = {} } = ctx;
  const defaultDataDir = initial.dataDir || store.getState().settings.dataDir || store.getState().app.dataDir;
  const defaultPort = initial.port || store.getState().settings.port || 17860;

  const state = {
    step: Math.min(5, Math.max(1, Number(startStep) || 1)),
    dataDir: defaultDataDir,
    port: defaultPort,
    acknowledged: false,
    checks: {
      save: { status: 'pending', detail: '' },
      runtime: { status: 'pending', detail: '' },
      health: { status: 'pending', detail: '' },
      init: { status: 'pending', detail: '' },
    },
    busy: false,
    errors: [],
    runtimeStatus: null,
  };

  const root = ui.el('div', { class: 'onboarding' });
  const stepsCol = ui.el('div', { class: 'onboarding__steps' });
  const panel = ui.el('div', { class: 'onboarding__panel' });
  const layout = ui.el('div', { class: 'onboarding__layout' }, [stepsCol, panel]);
  root.appendChild(layout);

  const dialog = ui.dialog({
    title: '欢迎使用 FCA Memory Atlas',
    subtitle: '首次启动向导 · Alpha 0.1 · 所有记忆数据只保存在本机',
    content: root,
    width: 820,
    dismissible: true,
    actions: [
      {
        label: '稍后再说',
        variant: 'ghost',
        closeOnClick: false,
        onClick: async () => {
          // 用户选择稍后：仍然视为已完成向导，避免每次启动弹窗；可随时从 帮助 菜单重新打开
          await bridge.app.saveSettings({ onboardingCompleted: true });
          toast('已跳过首次启动向导，可随时从「帮助 → 首次启动向导」重新打开', { type: 'info', duration: 5000 });
          dialog.close('skip');
        },
      },
      {
        label: '下一步',
        variant: 'primary',
        closeOnClick: false,
        onClick: async (close, btn) => {
          if (state.busy) return false;
          await goNext(btn);
        },
      },
    ],
  });

  const footerButtons = [...dialog.el.querySelectorAll('.fca-dialog__footer .btn')];
  const skipBtn = footerButtons.find((btn) => btn.textContent.includes('稍后再说'));
  const nextBtn = footerButtons.find((btn) => btn.textContent.includes('下一步'));

  // ------------------------------------------------------------------ 步骤渲染
  function renderSteps() {
    stepsCol.innerHTML = '';
    for (const step of STEPS) {
      const index = STEPS.indexOf(step) + 1;
      const cls = ['onboarding__step'];
      if (state.step === step.id) cls.push('is-active');
      if (index < state.step) cls.push('is-done');
      const row = ui.el('div', { class: cls.join(' ') }, [
        ui.el('span', { class: 'onboarding__step-num', text: index < state.step ? '✓' : String(index) }),
        ui.el('span', { class: 'onboarding__step-label', text: step.label }),
      ]);
      stepsCol.appendChild(row);
    }
  }

  function panelHeader(title, desc) {
    return el('div', {}, [ui.el('div', { class: 'onboarding__panel-title', text: title }), ui.el('div', { class: 'onboarding__panel-desc', text: desc })]);
  }

  function el(tag, attrs, children) {
    return ui.el(tag, attrs, children);
  }

  function point(iconName, text) {
    return ui.el('div', { class: 'onboarding__point' }, [icon(iconName, { size: 14 }), el('span', { text })]);
  }

  function renderPanel() {
    panel.innerHTML = '';
    if (state.step === 1) {
      panel.appendChild(panelHeader('一个只属于你的本地记忆星图', 'FCA Memory Atlas 把记忆组织成可探索的星云：亮度和大小来自重要度，位置和颜色来自记忆的时间、项目与关系。所有数据都保存在这台电脑上。'));
      panel.appendChild(
        el('div', { class: 'onboarding__points' }, [
          point('shield', '本地优先：记忆库是 SQLite 文件，保存在你选择的数据目录；不依赖云端。'),
          point('database', '首次启动会创建一个全新的空数据库，不导入、不读取、不迁移任何旧记忆系统数据。'),
          point('relation', '记忆、人物、项目与关系都是可编辑的本地数据；Agent 接入需要你显式配置。'),
          point('sparkles', '桌面外壳与本地 Runtime（127.0.0.1 回环）通信，token 由 Runtime 生成，仅保存在本机。'),
        ]),
      );
      const ack = ui.checkbox({
        label: '我已了解：首次启动为全新空库，不会迁移旧记忆；旧数据如需处理必须另行明确授权。',
        checked: state.acknowledged,
        onChange: (checked) => {
          state.acknowledged = checked;
          updateFooter();
        },
      });
      panel.appendChild(ack);
    } else if (state.step === 2) {
      panel.appendChild(panelHeader('选择数据目录', '记忆数据库、事件日志、备份都会写入这个目录。目录可以是任意本地磁盘位置。'));
      const input = ui.input({ value: state.dataDir, ariaLabel: '数据目录' });
      input.addEventListener('input', () => {
        state.dataDir = input.value;
      });
      const browseBtn = ui.button({ label: '浏览…', icon: 'folder', variant: 'secondary', size: 'sm', onClick: async () => {
        const picked = await bridge.dialog.selectDirectory({ title: '选择 FCA 数据目录', defaultPath: state.dataDir });
        if (picked && picked.ok) {
          input.value = picked.path;
          state.dataDir = picked.path;
        }
      } });
      panel.appendChild(el('div', { class: 'fca-form-field' }, [ui.el('label', { class: 'fca-form-field__label', text: '数据目录' }), el('div', { class: 'fca-form-row' }, [input, browseBtn])]));
      panel.appendChild(el('div', { class: 'onboarding__notice' }, [
        icon('info', { size: 14 }),
        el('span', { text: `默认目录：${defaultDataDir}。如果目录不存在，启动时会自动创建（不包含任何旧记忆）。` }),
      ]));
    } else if (state.step === 3) {
      panel.appendChild(panelHeader('本地 Runtime 端口', 'Runtime 只监听本机回环地址 127.0.0.1，不对外网开放。默认端口 17860。'));
      const portInput = ui.numberInput({ value: state.port, min: 1024, max: 65535, ariaLabel: 'Runtime 端口', width: '140px' });
      portInput.addEventListener('change', () => {
        state.port = Number(portInput.value) || 17860;
      });
      panel.appendChild(el('div', { class: 'fca-form-field' }, [ui.el('label', { class: 'fca-form-field__label', text: '端口（1024-65535）' }), portInput]));
      panel.appendChild(
        el('div', { class: 'onboarding__points' }, [
          point('wifi', `Runtime 地址：http://127.0.0.1:${state.port}`),
          point('shield', '端口仅绑定回环地址；其它设备无法访问。'),
          point('info', '如果该端口已被占用，可改用其它端口（例如 17861）。'),
        ]),
      );
    } else if (state.step === 4) {
      panel.appendChild(panelHeader('启动本地 Runtime 并初始化空库', '以下步骤会真实执行：保存设置 → 启动本地 Runtime → 健康检查 → 初始化空数据库。'));
      const renderChecks = () => {
        const container = panel.querySelector('#onboarding-checks');
        if (!container) return;
        container.innerHTML = '';
        const items = [
          ['save', '保存桌面设置', state.checks.save],
          ['runtime', '启动本地 Runtime（127.0.0.1:' + state.port + '）', state.checks.runtime],
          ['health', '健康检查（/health，API v1）', state.checks.health],
          ['init', '初始化空数据库（POST /db/init）', state.checks.init],
        ];
        for (const [id, label, check] of items) {
          const cls = check.status === 'ok' ? 'onboarding__check--ok' : check.status === 'fail' ? 'onboarding__check--fail' : check.status === 'running' ? 'onboarding__check--pending' : '';
          const iconName = check.status === 'ok' ? 'check' : check.status === 'fail' ? 'alert' : check.status === 'running' ? 'refresh' : 'info';
          container.appendChild(
            el('div', { class: `onboarding__check ${cls}` }, [
              icon(iconName, { size: 14 }),
              el('div', { class: 'fca-grow' }, [
                el('div', { text: label }),
                check.detail ? el('div', { class: 'onboarding__check-detail', text: check.detail }) : null,
              ]),
            ]),
          );
        }
      };
      panel.appendChild(el('div', { id: 'onboarding-checks' }));
      renderChecks();
      const actionRow = el('div', { class: 'fca-row', style: { marginTop: '12px', gap: '8px' } });
      const runBtn = ui.button({ label: state.busy ? '正在执行…' : '重新执行检查与初始化', icon: 'play', variant: 'secondary', size: 'sm', disabled: state.busy, onClick: () => runSetup() });
      actionRow.appendChild(runBtn);
      if (state.runtimeStatus && state.runtimeStatus.lastError) {
        actionRow.appendChild(ui.button({ label: '查看运行时状态', icon: 'activity', variant: 'ghost', size: 'sm', onClick: () => openRuntimeStatusFromOnboarding() }));
      }
      panel.appendChild(actionRow);
      panel.appendChild(el('div', { class: 'onboarding__notice' }, [icon('shield', { size: 14 }), el('span', { text: '不会导入任何旧记忆系统的数据。初始化只会创建一个空的 SQLite 数据库。' })]));
      state.renderChecks = renderChecks;
      if (state.step === 4 && (state.checks.save.status === 'pending' || state.checks.runtime.status === 'pending')) {
        setTimeout(() => runSetup(), 60);
      }
    } else if (state.step === 5) {
      const runtimeStatus = state.runtimeStatus || store.getState().runtime;
      panel.appendChild(panelHeader('准备就绪', '首次启动向导已完成。你可以立即开始创建第一条记忆，并观察它成为星图中的一颗星。'));
      panel.appendChild(
        el('div', { class: 'onboarding__points' }, [
          point('check', `数据目录：${state.dataDir}`),
          point('check', `Runtime：http://127.0.0.1:${state.port} ${runtimeStatus.version ? `· v${runtimeStatus.version}` : ''}`),
          point('check', '数据库：全新空库（不包含任何旧记忆）'),
          point('sparkles', '下一步：在星图页点击「新建记忆」或使用顶部搜索查找已有内容。'),
        ]),
      );
      panel.appendChild(el('div', { class: 'onboarding__notice' }, [icon('info', { size: 14 }), el('span', { text: '提示：可从「帮助 → 首次启动向导」或「帮助 → 本地运行时状态」随时重新打开本向导/查看运行时。' })]));
    }
    updateFooter();
  }

  function openRuntimeStatusFromOnboarding() {
    const handler = ctx.onShowRuntimeStatus;
    if (typeof handler === 'function') handler();
    else if (typeof window.__FCA_APP__?.getRuntimeStatus === 'function') {
      toast('请打开「帮助 → 本地运行时状态」查看详情', { type: 'info' });
    }
  }

  // ------------------------------------------------------------------ 底部按钮状态
  function updateFooter() {
    if (!nextBtn || !skipBtn) return;
    if (state.step === 1) {
      nextBtn.textContent = '开始设置';
      nextBtn.disabled = !state.acknowledged;
      skipBtn.hidden = false;
    } else if (state.step === 5) {
      nextBtn.textContent = '完成并进入星图';
      nextBtn.disabled = false;
      skipBtn.hidden = true;
    } else if (state.step === 4) {
      nextBtn.textContent = '继续';
      nextBtn.disabled = state.busy;
      skipBtn.hidden = true;
    } else {
      nextBtn.textContent = '下一步';
      nextBtn.disabled = false;
      skipBtn.hidden = true;
    }
  }

  async function goNext(btn) {
    if (state.step === 1) {
      if (!state.acknowledged) {
        toast('请先阅读并勾选确认项', { type: 'warn' });
        return;
      }
      state.step = 2;
    } else if (state.step === 2) {
      if (!state.dataDir || !state.dataDir.trim()) {
        toast('请选择数据目录', { type: 'warn' });
        return;
      }
      state.step = 3;
    } else if (state.step === 3) {
      if (!Number.isFinite(state.port) || state.port < 1024 || state.port > 65535) {
        toast('端口必须是 1024-65535 之间的整数', { type: 'warn' });
        return;
      }
      state.step = 4;
    } else if (state.step === 4) {
      if (state.busy) return;
      const ok = await runSetup();
      if (!ok) {
        toast('检查未通过，请根据提示处理后重试', { type: 'warn', duration: 5000 });
        return;
      }
      state.step = 5;
    } else if (state.step === 5) {
      await finish();
      return;
    }
    renderSteps();
    renderPanel();
  }

  // ------------------------------------------------------------------ 真实执行流程
  async function runSetup() {
    if (state.busy) return false;
    state.busy = true;
    if (state.renderChecks) state.renderChecks();
    updateFooter();
    const setCheck = (id, status, detail = '') => {
      state.checks[id] = { status, detail };
      if (state.renderChecks) state.renderChecks();
    };
    state.errors = [];
    try {
      // 1. 保存设置（不标记 onboardingCompleted，完成时再标记）
      setCheck('save', 'running', '写入 desktop-settings.json…');
      const saveResult = await bridge.app.saveSettings({ dataDir: state.dataDir, port: state.port });
      if (!saveResult || !saveResult.ok) {
        const errors = saveResult && saveResult.errors ? saveResult.errors.map((e) => e.message).join('；') : '未知错误';
        setCheck('save', 'fail', errors);
        throw new Error(`保存设置失败：${errors}`);
      }
      setCheck('save', 'ok', `${state.dataDir} · 端口 ${state.port}`);

      // 2. 启动 Runtime
      setCheck('runtime', 'running', '调用主进程启动 Runtime 进程…');
      const startResult = await bridge.runtime.start({ dataDir: state.dataDir, port: state.port });
      state.runtimeStatus = startResult && startResult.status ? startResult.status : store.getState().runtime;
      if (!startResult || !startResult.ok) {
        const error = startResult && startResult.error;
        setCheck('runtime', 'fail', error ? `${error.message}${error.hint ? `\n${error.hint}` : ''}` : '启动失败');
        throw new Error(error ? error.message : 'Runtime 启动失败');
      }
      setCheck('runtime', 'ok', `状态 ${state.runtimeStatus.state}${state.runtimeStatus.version ? ` · v${state.runtimeStatus.version}` : ''}`);

      // 3. 健康检查
      setCheck('health', 'running', 'GET /health…');
      let health = null;
      let healthError = null;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          health = await api.health();
          healthError = null;
          break;
        } catch (error) {
          healthError = error;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      if (!health) {
        setCheck('health', 'fail', healthError ? api.userMessage(healthError) : '健康检查失败');
        throw new Error('健康检查失败');
      }
      if (String(health.api_version) !== '1') {
        setCheck('health', 'fail', `API 版本不兼容：需要 v1，实际 v${health.api_version}`);
        throw new Error('Runtime API 版本不兼容');
      }
      setCheck('health', 'ok', `status=${health.status} · v${health.version} · db=${health.db} · initialized=${health.initialized}`);

      // 4. 初始化空库（幂等）
      if (health.initialized) {
        setCheck('init', 'ok', '数据库已初始化（无需重复初始化）');
      } else {
        setCheck('init', 'running', 'POST /api/v1/db/init…');
        const initRes = await api.initDb();
        const initialized = initRes && (initRes.initialized === true || initRes.ok === true || initRes.created === true);
        setCheck('init', initialized ? 'ok' : 'ok', initialized ? '空数据库已创建（不包含旧记忆）' : '初始化请求已提交');
      }
      state.busy = false;
      updateFooter();
      if (state.renderChecks) state.renderChecks();
      return true;
    } catch (error) {
      state.busy = false;
      state.errors.push(error.message);
      updateFooter();
      if (state.renderChecks) state.renderChecks();
      return false;
    }
  }

  async function finish() {
    const saveResult = await bridge.app.saveSettings({ onboardingCompleted: true });
    if (!saveResult || !saveResult.ok) {
      toast('保存向导完成状态失败', { type: 'warn' });
    }
    toast('首次启动完成，正在进入星图…', { type: 'success', duration: 3000 });
    dialog.close('done');
    if (typeof ctx.onCompleted === 'function') {
      try {
        await ctx.onCompleted({ settings: saveResult && saveResult.settings, dataDir: state.dataDir, port: state.port });
      } catch (error) {
        toast(`初始化后续步骤失败：${error.message}`, { type: 'warn' });
      }
    }
  }

  // 外部（截图/菜单）可强制打开指定步骤
  if (ctx.force && startStep === 1 && state.step === 1) state.acknowledged = false;

  renderSteps();
  renderPanel();
  if (state.step === 5) state.checks.init.status = 'ok';

  return dialog;
}
