/**
 * FCA Memory Atlas — 核心设置弹窗 + 运行时状态弹窗
 */

import { icon } from '../ui/icons.js';

function buildSettingsContent({ info, settings, ui, onPickDir, bridge, onShowOnboarding }) {
  const content = ui.el('div', { class: 'settings-dialog' });

  function row(label, hint, control) {
    return ui.el('div', { class: 'settings-row' }, [
      ui.el('div', { class: 'settings-row__label' }, [ui.el('div', { text: label }), hint ? ui.el('div', { class: 'settings-row__hint', text: hint }) : null]),
      ui.el('div', { class: 'settings-row__control' }, [control]),
    ]);
  }

  // 数据与运行时
  const groupData = ui.el('div', { class: 'settings-group' }, [
    ui.el('div', { class: 'settings-group__title' }, [icon('database', { size: 13 }), '数据与运行时']),
  ]);
  const dataDirInput = ui.input({ value: settings.dataDir, ariaLabel: '数据目录' });
  dataDirInput.dataset.field = 'dataDir';
  const browseBtn = ui.button({ label: '浏览…', variant: 'secondary', size: 'sm', onClick: async () => {
    const picked = await onPickDir(settings.dataDir);
    if (picked) dataDirInput.value = picked;
  } });
  groupData.appendChild(row('数据目录', '记忆数据库、日志、备份均保存在此目录（默认 %LOCALAPPDATA%\\FCA-Memory-Atlas）。修改后需重启 Runtime。', ui.el('div', { class: 'fca-form-row', style: { flex: '1 1 auto', minWidth: '280px' } }, [dataDirInput, browseBtn])));

  const portInput = ui.numberInput({ value: settings.port, min: 1024, max: 65535, ariaLabel: 'Runtime 端口', width: '110px' });
  portInput.dataset.field = 'port';
  portInput.id = 'settings-port';
  groupData.appendChild(row('Runtime 端口', '仅本机回环监听（127.0.0.1）；修改后需重启 Runtime。', portInput));

  const urlDisplay = ui.el('span', { class: 'settings-path', text: settings.runtimeUrl || `http://127.0.0.1:${settings.port}` });
  groupData.appendChild(row('Runtime 地址', '渲染进程经主进程 IPC 访问，token 不出主进程。', urlDisplay));

  const autoStart = ui.switch({ label: '启动应用时自动启动 Runtime', checked: settings.autoStartRuntime, onChange: () => {} });
  autoStart.input.dataset.field = 'autoStartRuntime';
  groupData.appendChild(ui.el('div', { class: 'settings-row' }, [ui.el('div', { class: 'settings-row__label' }, [autoStart])]));

  const closeOnExit = ui.switch({ label: '退出应用时关闭由本应用启动的 Runtime', hint: '若检测到其它客户端正在使用，则不会关闭。', checked: settings.closeRuntimeOnExit, onChange: () => {} });
  closeOnExit.input.dataset.field = 'closeRuntimeOnExit';
  groupData.appendChild(ui.el('div', { class: 'settings-row' }, [ui.el('div', { class: 'settings-row__label' }, [closeOnExit])]));

  // 外观与渲染
  const groupUi = ui.el('div', { class: 'settings-group' }, [
    ui.el('div', { class: 'settings-group__title' }, [icon('sparkles', { size: 13 }), '外观与渲染']),
  ]);
  const qualitySelect = ui.select({
    options: ['ultra', 'high', 'medium', 'low', 'off'].map((level) => ({ value: level, label: `${{ ultra: '极致', high: '高', medium: '中', low: '低', off: '关闭特效' }[level]}（${level}）` })),
    value: settings.quality || 'high',
    ariaLabel: '渲染画质',
  });
  qualitySelect.id = 'settings-quality';
  groupUi.appendChild(row('渲染画质', '星云渲染性能档位；关闭特效后仍保留全部交互与可读性。', qualitySelect));

  // 星云渲染引擎：Unity WebGL（默认，内嵌到星云视图）/ WebGL 内置回退
  const unityInfo = info.unity || null;
  const unityAvailable = Boolean(unityInfo && unityInfo.available);
  const engineSelect = ui.select({
    options: [
      { value: 'unity', label: `Unity 星云（内嵌 WebGL）${unityAvailable ? '' : ' · 当前未找到 WebGL 构建'}` },
      { value: 'webgl', label: 'WebGL 星云（内置回退）' },
    ],
    value: settings.nebulaEngine === 'webgl' ? 'webgl' : 'unity',
    ariaLabel: '星云渲染引擎',
  });
  engineSelect.id = 'settings-nebula-engine';
  groupUi.appendChild(row(
    '星云渲染引擎',
    unityAvailable
      ? `Unity WebGL 构建：${unityInfo.dir}（${unityInfo.source}），内嵌显示在星云视图；加载失败/构建缺失时自动回退 WebGL。`
      : '未找到 Unity WebGL 构建（index.html）时自动使用 WebGL 回退；打包版位于 <InstallDir>\\unity\\FCANebulaWebGL，开发版位于 <repo>\\artifacts\\unity\\FCANebulaWebGL。',
    engineSelect,
  ));

  // 路径信息
  const groupPaths = ui.el('div', { class: 'settings-group' }, [
    ui.el('div', { class: 'settings-group__title' }, [icon('folder', { size: 13 }), '位置信息']),
  ]);
  const infoRows = [
    ['数据目录', info.dataDir],
    ['日志目录', info.logDir],
    ['Runtime 入口', info.runtimeEntry ? info.runtimeEntry.entry : '未找到 runtime/bin/fca-runtime.js'],
    ['Node 可执行文件', info.nodeBin ? `${info.nodeBin.path}（${info.nodeBin.source}）` : '未找到 Node 24'],
    ['Token 文件', `${info.tokenPath}${info.tokenAvailable ? '（存在）' : '（尚未生成）'}`],
  ];
  for (const [label, value] of infoRows) {
    groupPaths.appendChild(ui.el('div', { class: 'settings-row', style: { alignItems: 'flex-start' } }, [
      ui.el('div', { class: 'settings-row__label', text: label }),
      ui.el('div', { class: 'settings-row__control', style: { flex: '1 1 auto', textAlign: 'right', maxWidth: '62%' } }, [ui.el('span', { class: 'settings-path', text: value || '—' })]),
    ]));
  }
  const openDataBtn = ui.button({ label: '打开数据目录', icon: 'folder', variant: 'secondary', size: 'sm', onClick: async () => {
    const result = await bridge.app.openPath('data');
    if (result && result.ok === false) ui.toast(`无法打开目录：${result.error || '未知原因'}`, { type: 'warn' });
  } });
  const openLogsBtn = ui.button({ label: '打开日志目录', icon: 'file', variant: 'secondary', size: 'sm', onClick: async () => {
    const result = await bridge.app.openPath('logs');
    if (result && result.ok === false) ui.toast(`无法打开日志目录：${result.error || '未知原因'}`, { type: 'warn' });
  } });
  const onboardingBtn = ui.button({
    label: '重新运行首次启动向导',
    icon: 'sparkles',
    variant: 'ghost',
    size: 'sm',
    onClick: () => {
      if (typeof onShowOnboarding === 'function') onShowOnboarding();
    },
  });
  groupPaths.appendChild(ui.el('div', { class: 'settings-row' }, [ui.el('div', { class: 'settings-row__control', style: { marginLeft: 'auto' } }, [openDataBtn, openLogsBtn, onboardingBtn])]));

  content.append(groupData, groupUi, groupPaths);
  return {
    content,
    collect() {
      return {
        dataDir: String(dataDirInput.value || dataDirInput.querySelector('input')?.value || '').trim(),
        port: Number(portInput.value),
        autoStartRuntime: autoStart.input.checked,
        closeRuntimeOnExit: closeOnExit.input.checked,
        quality: qualitySelect.value,
        nebulaEngine: engineSelect.value === 'webgl' ? 'webgl' : 'unity',
      };
    },
  };
}

/**
 * 打开设置弹窗
 * @returns {object} ui.dialog handle
 */
export function openSettingsDialog(ctx) {
  const { bridge, store, ui, toast, onSaved, onShowOnboarding } = ctx;
  const info = ctx.info || (window.__FCA_LAST_INFO__ || {});
  const settings = store.getState().settings;

  const originalDataDir = settings.dataDir;
  const originalPort = settings.port;
  let dialogHandle = null;

  const builtRef = { built: null };
  const built = buildSettingsContent({
    info: {
      dataDir: info.dataDir || settings.dataDir,
      logDir: info.logDir || '',
      runtimeEntry: info.runtimeEntry || null,
      nodeBin: info.nodeBin || null,
      tokenPath: info.tokenPath || '',
      tokenAvailable: Boolean(info.tokenAvailable),
      unity: info.unity || (typeof window !== 'undefined' ? window.__FCA_UNITY_STATUS__ : null) || null,
    },
    settings,
    ui,
    bridge,
    onPickDir: async (current) => {
      const picked = await bridge.dialog.selectDirectory({ title: '选择 FCA 数据目录', defaultPath: current });
      return picked && picked.ok ? picked.path : null;
    },
    onShowOnboarding: () => {
      if (dialogHandle) dialogHandle.close('onboarding');
      if (typeof onShowOnboarding === 'function') onShowOnboarding();
    },
  });
  builtRef.built = built;
  built.content.style.minHeight = '320px';
  built.content.style.maxHeight = '62vh';
  built.content.style.overflowY = 'auto';
  built.content.style.paddingRight = '4px';

  const dialog = ui.dialog({
    title: '设置',
    subtitle: '核心设置（数据目录 / 端口 / Runtime 生命周期 / 渲染画质）',
    content: built.content,
    width: 680,
    bodyClassName: 'settings-dialog-body',
    actions: [
      {
        label: '取消',
        variant: 'ghost',
      },
      {
        label: '保存设置',
        variant: 'primary',
        closeOnClick: false,
        onClick: async (close, btn) => {
          const patch = builtRef.built.collect();
          if (!patch.dataDir) {
            toast('数据目录不能为空', { type: 'warn' });
            return false;
          }
          if (!Number.isFinite(patch.port) || patch.port < 1024 || patch.port > 65535) {
            toast('端口必须是 1024-65535 之间的整数', { type: 'warn' });
            return false;
          }
          btn.disabled = true;
          try {
            const result = await bridge.app.saveSettings(patch);
            if (!result || !result.ok) {
              const errors = result && Array.isArray(result.errors) ? result.errors : [];
              toast(errors.length ? `保存失败：${errors.map((e) => e.message).join('；')}` : '保存设置失败', { type: 'error', duration: 6000 });
              return false;
            }
            toast('设置已保存', { type: 'success', duration: 2200 });
            const requiresRuntimeRestart = patch.dataDir !== originalDataDir || patch.port !== originalPort;
            close('save');
            if (typeof onSaved === 'function') await onSaved({ settings: result.settings, requiresRuntimeRestart });
          } finally {
            btn.disabled = false;
          }
        },
      },
    ],
  });
  dialogHandle = dialog;
  return dialog;
}

/**
 * 运行时状态弹窗
 */
export function openRuntimeStatusDialog(ctx) {
  const { bridge, store, ui, toast, onStart, onStop, onRestart } = ctx;
  let disposed = false;
  const body = ui.el('div', { class: 'runtime-status' });
  const logBox = ui.el('div', { class: 'runtime-status__log' });
  let logTimer = null;
  let refreshing = false;

  async function refresh() {
    if (disposed || refreshing) return;
    refreshing = true;
    try {
      const status = (await bridge.runtime.getStatus()) || store.getState().runtime;
      body.innerHTML = '';
      const rows = [
        ['状态', `${status.state}${status.lastError ? `（${status.lastError.code || '错误'}）` : ''}`],
        ['Runtime 地址', status.url || '—'],
        ['Runtime 版本', status.version || '—'],
        ['API 版本', status.apiVersion || '—'],
        ['运行时长', status.uptimeMs ? ctx.format.duration(status.uptimeMs) : '—'],
        ['数据库初始化', status.initialized === null || status.initialized === undefined ? '—' : status.initialized ? '是' : '否（需初始化）'],
        ['进程所有权', status.ownedByDesktop ? '由本应用启动' : '外部实例 / 未运行'],
        ['进程 PID', status.pid ? String(status.pid) : '—'],
        ['数据目录', status.dataDir || '—'],
        ['入口文件', status.runtimeEntry ? status.runtimeEntry.entry : '未找到 runtime/bin/fca-runtime.js'],
        ['Node 可执行文件', status.nodeBin || '未找到 Node 24'],
        ['最近检查', status.checkedAt ? ctx.format.datetime(status.checkedAt) : '—'],
      ];
      for (const [key, value] of rows) {
        body.appendChild(ui.el('div', { class: 'runtime-status__key', text: key }));
        body.appendChild(ui.el('div', { class: 'runtime-status__value', text: value || '—' }));
      }
      if (status.lastError) {
        body.appendChild(ui.el('div', { class: 'runtime-status__key', text: '最近错误' }));
        body.appendChild(
          ui.el('div', { class: 'runtime-status__value', style: { color: 'var(--fca-rose)' } }, [
            ui.el('div', { text: status.lastError.message || '' }),
            status.lastError.hint ? ui.el('div', { class: 'settings-row__hint', text: status.lastError.hint }) : null,
          ]),
        );
      }
      const actionsRow = ui.el('div', { class: 'runtime-status__actions' }, [
        ui.button({ label: '启动', icon: 'play', variant: 'secondary', size: 'sm', disabled: status.state === 'running' || status.state === 'starting', onClick: async () => {
          toast('正在启动 Runtime…', { type: 'info', duration: 2200 });
          const result = await (onStart ? onStart() : bridge.runtime.start());
          if (result && !result.ok) toast((result.error && result.error.message) || '启动失败', { type: 'error', duration: 6000 });
          await refresh();
        } }),
        ui.button({ label: '停止', icon: 'stop', variant: 'secondary', size: 'sm', disabled: status.state !== 'running', onClick: async () => {
          const result = await (onStop ? onStop() : bridge.runtime.stop({ reason: 'user' }));
          if (result && result.status) toast(`Runtime 状态：${result.status.state}`, { type: 'info' });
          await refresh();
        } }),
        ui.button({ label: '重启', icon: 'refresh', variant: 'secondary', size: 'sm', onClick: async () => {
          toast('正在重启 Runtime…', { type: 'info', duration: 2500 });
          const result = await (onRestart ? onRestart() : bridge.runtime.restart());
          if (result && result.error) toast(result.error.message || '重启失败', { type: 'error', duration: 6000 });
          await refresh();
        } }),
        ui.button({ label: '刷新', icon: 'refresh', variant: 'ghost', size: 'sm', onClick: refresh }),
        ui.button({ label: '打开日志目录', icon: 'folder', variant: 'ghost', size: 'sm', onClick: () => bridge.app.openPath('logs') }),
      ]);
      body.appendChild(ui.el('div', { style: { marginTop: '6px' } }, [actionsRow]));
      body.appendChild(ui.el('div', { class: 'settings-group__title', style: { marginTop: '10px' }, text: '最近 Runtime 输出' }));
      body.appendChild(logBox);
      const logResult = await bridge.runtime.getLogTail(120);
      const entries = logResult && Array.isArray(logResult.entries) ? logResult.entries : [];
      logBox.textContent = entries.length
        ? entries.map((entry) => `[${ctx.format.datetime(entry.at)}] ${entry.source}: ${entry.line}`).join('\n')
        : '（暂无输出）';
      logBox.scrollTop = logBox.scrollHeight;
    } catch (error) {
      body.textContent = `读取运行时状态失败：${error.message}`;
    } finally {
      refreshing = false;
    }
  }

  const dialog = ui.dialog({
    title: '本地运行时状态',
    subtitle: 'Runtime 生命周期管理 · 仅监听 127.0.0.1 · token 只保存在主进程',
    content: body,
    width: 640,
    actions: [{ label: '关闭', variant: 'secondary' }],
    onClose: () => {
      disposed = true;
      if (logTimer) clearInterval(logTimer);
    },
  });
  refresh();
  logTimer = setInterval(refresh, 2500);
  return dialog;
}
