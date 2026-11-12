'use strict';

/**
 * FCA Desktop — 原生菜单（文件/编辑/视图/帮助）
 * 所有业务动作以 command 形式转发给 renderer；主进程只处理系统级动作。
 */

const { Menu, app, shell, dialog } = require('electron');
const path = require('node:path');
const paths = require('./paths');

function createMenu(options) {
  const sendCommand = options.sendCommand;
  const getVersions = options.getVersions || (() => ({}));
  const onOpenDocs = options.onOpenDocs || (() => {});
  const onShowOnboarding = options.onShowOnboarding || (() => {});
  const onShowRuntimeStatus = options.onShowRuntimeStatus || (() => {});

  const command = (name, payload) => () => sendCommand(name, payload);

  const template = [
    {
      label: '文件',
      submenu: [
        { label: '新建记忆', click: command('memory:new') },
        { type: 'separator' },
        { label: '导入记忆…（FCA 格式）', click: command('data:import') },
        { label: '导出数据…', click: command('data:export') },
        { type: 'separator' },
        { label: '创建备份…', click: command('data:backup') },
        { label: '恢复备份…', click: command('data:restore') },
        { type: 'separator' },
        {
          label: '打开数据目录',
          click: () => {
            shell.openPath(paths.defaultDataDir()).catch(() => {});
          },
        },
        {
          label: '打开日志目录',
          click: () => {
            shell.openPath(path.join(paths.defaultDataDir(), 'logs')).catch(() => {});
          },
        },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: 'Alt+F4',
          click: () => app.quit(),
        },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: command('edit:undo') },
        { label: '重做', accelerator: 'CmdOrCtrl+Shift+Z', click: command('edit:redo') },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        { label: '删除选中的记忆', click: command('edit:delete-selection') },
        { label: '搜索', accelerator: 'CmdOrCtrl+K', click: command('app:focus-search') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '星云总览', accelerator: 'CmdOrCtrl+1', click: command('view:switch', { view: 'atlas' }) },
        { label: '聚类星域', accelerator: 'CmdOrCtrl+2', click: command('view:switch', { view: 'atlas', params: { mode: 'clusters' } }) },
        { label: '时间线', accelerator: 'CmdOrCtrl+3', click: command('view:switch', { view: 'timeline' }) },
        { label: '关系探索', accelerator: 'CmdOrCtrl+4', click: command('view:switch', { view: 'relations' }) },
        { label: '记忆列表', accelerator: 'CmdOrCtrl+5', click: command('view:switch', { view: 'list' }) },
        { label: '数据管理', accelerator: 'CmdOrCtrl+6', click: command('view:switch', { view: 'data' }) },
        { label: '设置', accelerator: 'CmdOrCtrl+7', click: command('view:switch', { view: 'settings' }) },
        { type: 'separator' },
        { label: '适应屏幕（F）', click: command('view:fit') },
        { label: '图例（L）', click: command('view:toggle-legend') },
        { label: '刷新图谱', accelerator: 'F5', click: command('view:refresh') },
        { type: 'separator' },
        { label: '显示/隐藏左栏', accelerator: 'CmdOrCtrl+B', click: command('layout:toggle-left') },
        { label: '显示/隐藏右栏', accelerator: 'CmdOrCtrl+J', click: command('layout:toggle-right') },
        {
          label: '布局预设',
          submenu: [
            { label: '默认布局', click: command('layout:preset', { preset: 'default' }) },
            { label: '宽画布', click: command('layout:preset', { preset: 'wide' }) },
            { label: '专注阅读', click: command('layout:preset', { preset: 'focus' }) },
          ],
        },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具', accelerator: 'CmdOrCtrl+Shift+I' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '首次启动向导', click: () => onShowOnboarding() },
        { label: '本地运行时状态', click: () => onShowRuntimeStatus() },
        { label: '打开文档目录', click: () => onOpenDocs() },
        { type: 'separator' },
        {
          label: `关于 ${paths.PRODUCT_NAME}`,
          click: () => {
            const v = getVersions();
            dialog.showMessageBox({
              type: 'info',
              title: `关于 ${paths.PRODUCT_NAME}`,
              message: `${paths.PRODUCT_NAME} Alpha ${paths.PRODUCT_VERSION}`,
              detail:
                `本地优先的认知记忆地图（Windows 桌面版）。\n\n` +
                `Electron ${v.electron || '—'} · Chromium ${v.chrome || '—'} · Node ${v.node || '—'}\n` +
                `API v${v.apiVersion || paths.FCA_API_VERSION} · Runtime ${v.runtimeVersion || '未连接'}\n` +
                `数据目录：${v.dataDir || paths.defaultDataDir()}\n\n` +
                `所有记忆数据只保存在本机；首次启动为全新空库，不导入任何旧记忆。`,
              buttons: ['关闭'],
              noLink: true,
            }).catch(() => {});
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}

module.exports = { createMenu };
