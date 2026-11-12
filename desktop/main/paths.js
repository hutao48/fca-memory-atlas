'use strict';

/**
 * FCA Desktop — 路径解析
 * 统一管理：默认数据目录、配置文件位置、桌面日志目录、Runtime 入口、Node 可执行文件。
 * 主进程 / capture 入口共用。CommonJS。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PRODUCT_NAME = 'FCA Memory Atlas';
const PRODUCT_VERSION = '0.1.0';
const FCA_API_VERSION = '1';
const DEFAULT_PORT = 17860;
const DESKTOP_DIR = path.resolve(__dirname, '..'); // <root>/desktop
const PROJECT_ROOT = path.resolve(DESKTOP_DIR, '..'); // <root>

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

/** 产品固定数据根（引导配置/默认数据目录都放这里），不受 FCA_HOME / 用户自选数据目录影响 */
function productDataDir() {
  return path.join(localAppData(), 'FCA-Memory-Atlas');
}

/**
 * 默认数据目录：
 *  - 环境变量 FCA_HOME 覆盖（QA/capture/e2e 用隔离数据目录）
 *  - 否则 %LOCALAPPDATA%\FCA-Memory-Atlas（契约 §0）
 */
function defaultDataDir() {
  if (process.env.FCA_HOME && String(process.env.FCA_HOME).trim()) {
    return path.resolve(String(process.env.FCA_HOME).trim());
  }
  return productDataDir();
}

/** 引导配置固定存放：%LOCALAPPDATA%\FCA-Memory-Atlas\desktop-settings.json */
function settingsFilePath() {
  return path.join(productDataDir(), 'desktop-settings.json');
}

function windowStateFilePath() {
  return path.join(productDataDir(), 'desktop-window-state.json');
}

/**
 * 安装版判断与安装目录。
 * 安装版布局（Lead 契约）：
 *   <InstallDir>\FCA Memory Atlas.exe
 *   <InstallDir>\resources\app\{main,renderer,package.json}
 *   <InstallDir>\runtime\bin\fca-runtime.js
 *   <InstallDir>\node\node.exe
 * 开发版：process.execPath 是 electron.exe（缓存或 node_modules），项目根 = main/ 的上两级。
 */
function isPackagedApp() {
  try {
    const { app } = require('electron');
    return Boolean(app && app.isPackaged);
  } catch {
    return false;
  }
}

function installDir() {
  return isPackagedApp() ? path.dirname(process.execPath) : null;
}

/** 应用根（含 main/、renderer/ 的那一层）：安装版 = <InstallDir>\resources\app，开发版 = <root>\desktop */
function appRoot() {
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) return app.getAppPath();
  } catch {
    /* ignore */
  }
  return DESKTOP_DIR;
}

function tokenPath(dataDir) {
  return path.join(dataDir || defaultDataDir(), 'config', 'runtime-token');
}

function dbPath(dataDir) {
  return path.join(dataDir || defaultDataDir(), 'db', 'fca.db');
}

function logsDir(dataDir) {
  return path.join(dataDir || defaultDataDir(), 'logs');
}

function backupsDir(dataDir) {
  return path.join(dataDir || defaultDataDir(), 'backups');
}

function runtimeUrl(port) {
  return `http://127.0.0.1:${Number(port) || DEFAULT_PORT}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureDataDirs(dataDir) {
  const dirs = {
    root: dataDir,
    config: path.join(dataDir, 'config'),
    db: path.join(dataDir, 'db'),
    logs: path.join(dataDir, 'logs'),
    backups: path.join(dataDir, 'backups'),
    events: path.join(dataDir, 'events'),
  };
  for (const dir of Object.values(dirs)) ensureDir(dir);
  return dirs;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 向上查找项目根（含 runtime/bin/fca-runtime.js 的那一层）。
 * 开发态：D:\FCA\FCA-Memory-Atlas；打包态可放在 resources 下（由 env FCA_ROOT 或 settings 覆盖）。
 */
function findProjectRoot() {
  const candidates = [];
  if (process.env.FCA_ROOT) candidates.push(path.resolve(process.env.FCA_ROOT));
  candidates.push(PROJECT_ROOT);

  for (const start of candidates) {
    let dir = start;
    for (let i = 0; i < 6; i += 1) {
      if (isFile(path.join(dir, 'runtime', 'bin', 'fca-runtime.js'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/**
 * 定位 Runtime 入口（runtime\bin\fca-runtime.js）。
 * 顺序：settings.runtimeEntry → env FCA_RUNTIME_ENTRY → 安装版 <InstallDir>\runtime → 开发项目根 → resources 兜底。
 * @returns {{ entry: string, root: string, source: string }|null}
 */
function resolveRuntimeEntry(settings) {
  const candidates = [];
  if (settings && settings.runtimeEntry) candidates.push({ p: settings.runtimeEntry, source: 'settings.runtimeEntry' });
  if (process.env.FCA_RUNTIME_ENTRY) candidates.push({ p: process.env.FCA_RUNTIME_ENTRY, source: 'env:FCA_RUNTIME_ENTRY' });

  const install = installDir();
  if (install) candidates.push({ p: path.join(install, 'runtime', 'bin', 'fca-runtime.js'), source: 'install-dir' });
  const app = appRoot();
  candidates.push({ p: path.join(app, 'runtime', 'bin', 'fca-runtime.js'), source: 'app-root' });
  if (process.resourcesPath) {
    candidates.push({ p: path.join(process.resourcesPath, 'runtime', 'bin', 'fca-runtime.js'), source: 'resources' });
    candidates.push({ p: path.join(process.resourcesPath, '..', 'runtime', 'bin', 'fca-runtime.js'), source: 'resources-parent' });
  }
  const found = findProjectRoot();
  if (found) candidates.push({ p: path.join(found, 'runtime', 'bin', 'fca-runtime.js'), source: 'project' });
  candidates.push({ p: path.join(PROJECT_ROOT, 'runtime', 'bin', 'fca-runtime.js'), source: 'desktop-parent' });

  const seen = new Set();
  for (const { p, source } of candidates) {
    const resolved = path.resolve(p);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (isFile(resolved)) {
      const root = path.resolve(path.dirname(resolved), '..', '..');
      return { entry: resolved, root, source };
    }
  }
  return null;
}

/** 从 tools/node.cmd 解析随项目封装的 node.exe 路径（本机 PATH 无 node） */
function parseToolsNodeCmd() {
  const candidates = [
    path.join(PROJECT_ROOT, 'tools', 'node.cmd'),
    path.join(DESKTOP_DIR, '..', 'tools', 'node.cmd'),
  ];
  for (const cmdPath of candidates) {
    let text = '';
    try {
      text = fs.readFileSync(cmdPath, 'utf8');
    } catch {
      continue;
    }
    const matches = text.match(/"([^"]*node\.exe)"/gi) || [];
    for (const raw of matches) {
      const p = raw.replace(/^"|"$/g, '').trim();
      if (isFile(p)) return { path: p, source: `tools/node.cmd` };
    }
    const bare = text.match(/([A-Za-z]:\\[^\r\n"]*node\.exe)/i);
    if (bare && isFile(bare[1])) return { path: bare[1], source: 'tools/node.cmd' };
  }
  return null;
}

/** 在 PATH 中查找 node.exe */
function findNodeOnPath() {
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir.replace(/^"|"$/g, ''), 'node.exe');
    if (isFile(p)) return { path: p, source: 'PATH' };
  }
  return null;
}

/**
 * 定位 Node 24 可执行文件（Runtime 需要 node:sqlite / 稳定内置模块）。
 * 顺序：env FCA_NODE / FCA_NODE_BIN → settings.nodePath → 安装版 <InstallDir>\node\node.exe
 *      → 项目 vendor\node → runtime\node → tools/node.cmd（DSH 随附 node）→ PATH → Electron 自身（末选，记录警告）。
 */
function resolveNodeBin(settings) {
  const list = [];
  if (process.env.FCA_NODE) list.push({ path: process.env.FCA_NODE, source: 'env:FCA_NODE' });
  if (process.env.FCA_NODE_BIN) list.push({ path: process.env.FCA_NODE_BIN, source: 'env:FCA_NODE_BIN' });
  if (settings && settings.nodePath) list.push({ path: settings.nodePath, source: 'settings.nodePath' });
  const install = installDir();
  if (install) list.push({ path: path.join(install, 'node', 'node.exe'), source: 'install-dir:node' });
  for (const rel of ['vendor/node/node.exe', 'runtime/node/node.exe', 'node/node.exe']) {
    list.push({ path: path.join(PROJECT_ROOT, rel), source: `project:${rel}` });
  }
  // 本机 DSH 随附 node（开发态兜底；由 tools/node.cmd 解析得到）
  const fromTools = parseToolsNodeCmd();
  if (fromTools) list.push(fromTools);
  const fromPath = findNodeOnPath();
  if (fromPath) list.push(fromPath);

  for (const item of list) {
    if (isFile(item.path)) return item;
  }

  // 最后手段：Electron 以 ELECTRON_RUN_AS_NODE=1 充当 Node（版本可能不满足 Runtime 要求，记录警告）
  if (isFile(process.execPath)) {
    return { path: process.execPath, source: 'electron-run-as-node', warning: '未找到独立 Node 24，回退 Electron 内置 Node（可能不满足 Runtime 要求）' };
  }
  return null;
}

module.exports = {
  PRODUCT_NAME,
  PRODUCT_VERSION,
  FCA_API_VERSION,
  DEFAULT_PORT,
  DESKTOP_DIR,
  PROJECT_ROOT,
  localAppData,
  productDataDir,
  defaultDataDir,
  settingsFilePath,
  windowStateFilePath,
  tokenPath,
  dbPath,
  logsDir,
  backupsDir,
  runtimeUrl,
  ensureDir,
  ensureDataDirs,
  isFile,
  findProjectRoot,
  isPackagedApp,
  installDir,
  appRoot,
  resolveRuntimeEntry,
  resolveNodeBin,
};
