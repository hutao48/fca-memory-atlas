'use strict';

/**
 * FCA Desktop — 窗口状态持久化（位置/大小/最大化）
 * 文件：%LOCALAPPDATA%\FCA-Memory-Atlas\desktop-window-state.json
 */

const fs = require('node:fs');
const path = require('node:path');
const { screen } = require('electron');
const paths = require('./paths');

const MIN_WIDTH = 1180;
const MIN_HEIGHT = 720;

function defaultState() {
  return { width: 1600, height: 1000, x: null, y: null, maximized: false, schemaVersion: 1 };
}

function readState(filePath = paths.windowStateFilePath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const state = { ...defaultState() };
    for (const key of ['width', 'height', 'x', 'y']) {
      if (Number.isFinite(parsed[key])) state[key] = Math.round(parsed[key]);
    }
    state.width = Math.max(MIN_WIDTH, state.width);
    state.height = Math.max(MIN_HEIGHT, state.height);
    state.maximized = Boolean(parsed.maximized);
    return state;
  } catch {
    return defaultState();
  }
}

/** 确保窗口落在某个显示器可视区域内（显示器拔插/分辨率变化后兜底） */
function ensureVisible(state) {
  try {
    const displays = screen.getAllDisplays();
    if (!displays.length) return state;
    const intersects = displays.some((display) => {
      const b = display.workArea;
      const right = state.x + state.width;
      const bottom = state.y + state.height;
      return state.x < b.x + b.width && right > b.x && state.y < b.y + b.height && bottom > b.y;
    });
    if (intersects) return state;
    const primary = screen.getPrimaryDisplay().workArea;
    return {
      ...state,
      x: Math.round(primary.x + (primary.width - state.width) / 2),
      y: Math.round(primary.y + (primary.height - state.height) / 2),
    };
  } catch {
    return state;
  }
}

function saveState(win, filePath = paths.windowStateFilePath()) {
  if (!win || win.isDestroyed()) return;
  try {
    const maximized = win.isMaximized();
    const bounds = maximized ? readState(filePath) : win.getBounds();
    const payload = {
      schemaVersion: 1,
      width: Math.max(MIN_WIDTH, Math.round(bounds.width || 1600)),
      height: Math.max(MIN_HEIGHT, Math.round(bounds.height || 1000)),
      x: Number.isFinite(bounds.x) ? Math.round(bounds.x) : null,
      y: Number.isFinite(bounds.y) ? Math.round(bounds.y) : null,
      maximized,
      savedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch {
    /* 窗口状态保存失败不应影响退出 */
  }
}

function createWindowStateTracker(win, options = {}) {
  const filePath = options.filePath || paths.windowStateFilePath();
  let timer = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      saveState(win, filePath);
    }, 400);
  };
  const onResize = () => schedule();
  const onMove = () => schedule();
  win.on('resize', onResize);
  win.on('move', onMove);
  return {
    saveNow() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      saveState(win, filePath);
    },
    dispose() {
      win.off('resize', onResize);
      win.off('move', onMove);
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

module.exports = { readState, saveState, ensureVisible, createWindowStateTracker, defaultState, MIN_WIDTH, MIN_HEIGHT };
