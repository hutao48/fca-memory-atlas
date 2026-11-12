'use strict';

/**
 * FCA Desktop — preload（contextBridge 白名单）
 * 安全约束：contextIsolation=true / nodeIntegration=false / sandbox=true。
 * renderer 只能访问这里暴露的 API；不暴露 ipcRenderer、fs、process 或任何 token 内容。
 */

const { contextBridge, ipcRenderer } = require('electron');

const BRIDGE_VERSION = '1.0';

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

function subscribe(channel) {
  return (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => {
      try {
        handler(payload);
      } catch (error) {
        // 不向 renderer 抛错，避免单个监听器破坏其它监听
        console.error(`[fca-bridge] listener error on ${channel}:`, error && error.message);
      }
    };
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

const bridge = {
  isElectron: true,
  bridgeVersion: BRIDGE_VERSION,
  platform: process.platform,

  app: {
    getInfo: () => invoke('fca:app:info'),
    getSettings: () => invoke('fca:app:settings:get'),
    saveSettings: (patch) => invoke('fca:app:settings:save', patch),
    onSettingsChanged: (handler) => subscribe('fca:settings:changed')(handler),
    relaunch: () => invoke('fca:app:relaunch'),
    quit: () => invoke('fca:app:quit'),
    log: (level, scope, message, meta) => invoke('fca:app:log', { level, scope, message, meta }),
    openPath: (kind) => invoke('fca:app:open-path', kind),
    showItemInFolder: (targetPath) => invoke('fca:app:show-item', targetPath),
  },

  runtime: {
    getStatus: () => invoke('fca:runtime:status'),
    start: (options) => invoke('fca:runtime:start', options || {}),
    stop: (options) => invoke('fca:runtime:stop', options || {}),
    restart: () => invoke('fca:runtime:restart'),
    checkHealth: () => invoke('fca:runtime:health'),
    getLogTail: (limit) => invoke('fca:runtime:log-tail', { limit }),
    onStatus: (handler) => subscribe('fca:runtime:status')(handler),
    onLog: (handler) => subscribe('fca:runtime:log')(handler),
  },

  // Unity 星云（默认内嵌 WebGL：本地静态服务 + atlas 视图 iframe；token 只通过 iframe URL 传递，不进 renderer 日志）
  unity: {
    getStatus: () => invoke('fca:unity:status'),
    start: (options) => invoke('fca:unity:start', options || {}),
    stop: (options) => invoke('fca:unity:stop', options || {}),
    getLogTail: (limit) => invoke('fca:unity:log-tail', { limit }),
    onStatus: (handler) => subscribe('fca:unity:status')(handler),
    onCrash: (handler) => subscribe('fca:unity:crash')(handler),
    // 兼容旧 standalone 开发开关
    open: (options) => invoke('fca:unity:open', options || {}),
    close: (options) => invoke('fca:unity:close', options || {}),
  },

  net: {
    request: (payload) => invoke('fca:net:request', payload),
    streamStart: (options) => invoke('fca:net:stream:start', options || {}),
    streamStop: () => invoke('fca:net:stream:stop'),
    onStreamEvent: (handler) => subscribe('fca:net:stream:event')(handler),
  },

  dialog: {
    selectDirectory: (options) => invoke('fca:dialog:select-directory', options || {}),
    openFile: (options) => invoke('fca:dialog:open-file', options || {}),
    saveFile: (options) => invoke('fca:dialog:save-file', options || {}),
    messageBox: (options) => invoke('fca:dialog:message-box', options || {}),
    confirm: (options) => invoke('fca:dialog:confirm', options || {}),
  },

  window: {
    minimize: () => invoke('fca:window:minimize'),
    toggleMaximize: () => invoke('fca:window:toggle-maximize'),
    close: () => invoke('fca:window:close'),
    isMaximized: () => invoke('fca:window:is-maximized'),
    onMaximizeChange: (handler) => subscribe('fca:window:maximized')(handler),
  },

  menu: {
    onCommand: (handler) => subscribe('fca:menu:command')(handler),
  },

  appEvents: {
    onCrash: (handler) => subscribe('fca:app:crash')(handler),
  },
};

contextBridge.exposeInMainWorld('fca', Object.freeze(bridge));
