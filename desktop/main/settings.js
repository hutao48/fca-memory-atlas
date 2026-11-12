'use strict';

/**
 * FCA Desktop — 桌面设置（desktop-settings.json）
 * 位置固定：%LOCALAPPDATA%\FCA-Memory-Atlas\desktop-settings.json（引导配置，不随自选数据目录移动）。
 * 内容：数据目录、Runtime 端口、自动启动策略、性能档位、向导完成标记等；不含敏感信息（token 由 Runtime 管理）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const paths = require('./paths');

const SETTINGS_SCHEMA_VERSION = 1;

function defaultSettings() {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    // 数据目录（优先 FCA_HOME 环境变量覆盖；否则默认 %LOCALAPPDATA%\FCA-Memory-Atlas；
    // 用户可在首次启动向导中修改）
    dataDir: paths.defaultDataDir(),
    // Runtime 端口（仅回环监听）
    port: paths.DEFAULT_PORT,
    // 自定义 Runtime 地址（null = 由 port 推导 http://127.0.0.1:<port>）
    runtimeUrl: null,
    // 高级：手动指定 runtime 入口 / node 可执行文件（打包或特殊部署时用）
    runtimeEntry: null,
    nodePath: null,
    // 生命周期策略
    autoStartRuntime: true,
    closeRuntimeOnExit: false,
    allowExternalRuntime: true,
    // 首次启动向导
    onboardingCompleted: false,
    // UI 偏好（其余 UI 状态由 renderer localStorage 管理）
    quality: 'high',
    // 星云渲染引擎：unity（默认，内嵌 Unity WebGL 到 atlas 视图）/ webgl（内置 WebGL2 回退）。
    // Unity WebGL 产物缺失或启动失败时由主进程/渲染层自动回退 WebGL，不阻塞其它功能。
    nebulaEngine: 'unity',
    // 高级：手动指定 Unity WebGL 构建目录（含 index.html）或旧版 standalone 可执行文件（仅开发/特殊部署）
    unityWebglDir: null,
    unityExePath: null,
    // 开发标记：使用 dev fixture（仅开发期有效，最终生产代码不包含假数据）
    devFixtures: false,
  };
}

const QUALITY_LEVELS = ['ultra', 'high', 'medium', 'low', 'off'];
const NEBULA_ENGINES = ['unity', 'webgl'];

function clampInt(value, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

/** 校验 + 归一化设置补丁；返回 { settings, errors } */
function normalizeSettings(input, base = defaultSettings()) {
  const errors = [];
  const next = { ...base };
  const raw = input && typeof input === 'object' ? input : {};

  if (raw.dataDir !== undefined) {
    if (typeof raw.dataDir !== 'string' || !raw.dataDir.trim()) errors.push({ field: 'dataDir', message: '数据目录不能为空' });
    else {
      const resolved = path.resolve(raw.dataDir.trim());
      if (!path.isAbsolute(resolved)) errors.push({ field: 'dataDir', message: '数据目录必须是绝对路径' });
      else next.dataDir = resolved;
    }
  }

  if (raw.port !== undefined) {
    const port = clampInt(raw.port, 1024, 65535);
    if (port === null) errors.push({ field: 'port', message: '端口必须是 1024-65535 之间的整数' });
    else next.port = port;
  }

  if (raw.runtimeUrl !== undefined) {
    if (raw.runtimeUrl === null || raw.runtimeUrl === '') next.runtimeUrl = null;
    else if (typeof raw.runtimeUrl !== 'string' || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(raw.runtimeUrl.trim())) {
      errors.push({ field: 'runtimeUrl', message: 'Runtime 地址必须是本机回环地址（http://127.0.0.1:<port>）' });
    } else next.runtimeUrl = raw.runtimeUrl.trim().replace(/\/+$/, '');
  }

  if (raw.runtimeEntry !== undefined) {
    if (raw.runtimeEntry === null || raw.runtimeEntry === '') next.runtimeEntry = null;
    else if (typeof raw.runtimeEntry !== 'string') errors.push({ field: 'runtimeEntry', message: 'runtimeEntry 必须是路径字符串' });
    else next.runtimeEntry = path.resolve(raw.runtimeEntry);
  }

  if (raw.nodePath !== undefined) {
    if (raw.nodePath === null || raw.nodePath === '') next.nodePath = null;
    else if (typeof raw.nodePath !== 'string') errors.push({ field: 'nodePath', message: 'nodePath 必须是路径字符串' });
    else next.nodePath = path.resolve(raw.nodePath);
  }

  for (const key of ['autoStartRuntime', 'closeRuntimeOnExit', 'allowExternalRuntime', 'onboardingCompleted', 'devFixtures']) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'boolean') errors.push({ field: key, message: `${key} 必须是布尔值` });
      else next[key] = raw[key];
    }
  }

  if (raw.quality !== undefined) {
    if (!QUALITY_LEVELS.includes(raw.quality)) errors.push({ field: 'quality', message: `quality 必须是 ${QUALITY_LEVELS.join('/')}` });
    else next.quality = raw.quality;
  }

  if (raw.nebulaEngine !== undefined) {
    if (!NEBULA_ENGINES.includes(raw.nebulaEngine)) errors.push({ field: 'nebulaEngine', message: `nebulaEngine 必须是 ${NEBULA_ENGINES.join('/')}` });
    else next.nebulaEngine = raw.nebulaEngine;
  }

  for (const key of ['unityWebglDir', 'unityExePath']) {
    if (raw[key] !== undefined) {
      if (raw[key] === null || raw[key] === '') next[key] = null;
      else if (typeof raw[key] !== 'string') errors.push({ field: key, message: `${key} 必须是路径字符串` });
      else next[key] = path.resolve(raw[key]);
    }
  }

  if (raw.schemaVersion !== undefined) {
    const v = clampInt(raw.schemaVersion, 1, 99);
    if (v !== null) next.schemaVersion = v;
  }

  next.schemaVersion = SETTINGS_SCHEMA_VERSION;
  return { settings: next, errors };
}

function effectiveRuntimeUrl(settings) {
  return settings.runtimeUrl || paths.runtimeUrl(settings.port);
}

function createSettingsStore(options = {}) {
  const logger = options.logger;
  const filePath = options.filePath || paths.settingsFilePath();
  const emitter = new EventEmitter();
  let settings = defaultSettings();
  let loaded = false;
  let saveQueue = Promise.resolve();

  function load() {
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(text);
      const { settings: normalized, errors } = normalizeSettings(parsed, defaultSettings());
      settings = normalized;
      loaded = true;
      if (errors.length && logger) logger.warn('settings', '设置文件包含无效字段，已忽略', { errors });
      if (logger) logger.info('settings', '设置已加载', { filePath, dataDir: settings.dataDir, port: settings.port });
    } catch (error) {
      loaded = false;
      settings = defaultSettings();
      if (error && error.code !== 'ENOENT' && logger) logger.warn('settings', '设置文件读取失败，使用默认值', { message: error.message });
    }
    return get();
  }

  function get() {
    return { ...settings };
  }

  function saveSync() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, filePath);
      loaded = true;
      return { ok: true };
    } catch (error) {
      if (logger) logger.error('settings', '设置保存失败', { message: error.message });
      return { ok: false, error: error.message };
    }
  }

  function save() {
    saveQueue = saveQueue.then(() => saveSync());
    return saveQueue;
  }

  /**
   * 应用补丁（校验失败不落盘），成功返回 { settings, errors, changed }。
   */
  async function update(patch) {
    const { settings: next, errors } = normalizeSettings(patch, settings);
    if (errors.length) return { ok: false, errors, settings: get() };
    const changed = JSON.stringify(next) !== JSON.stringify(settings);
    settings = next;
    if (changed) await save();
    if (changed) {
      emitter.emit('change', get());
      if (logger) {
        logger.info('settings', '设置已更新', {
          changedKeys: Object.keys(patch || {}),
          dataDir: settings.dataDir,
          port: settings.port,
          autoStartRuntime: settings.autoStartRuntime,
          onboardingCompleted: settings.onboardingCompleted,
        });
      }
    }
    return { ok: true, settings: get(), errors: [], changed };
  }

  function onChange(handler) {
    emitter.on('change', handler);
    return () => emitter.off('change', handler);
  }

  /**
   * 命令行参数覆盖（--fca-home / --port / capture 生命周期开关）：仅内存生效，不写盘。
   * @param {{dataDir?:string, port?:number, runtimeUrl?:string, autoStartRuntime?:boolean,
   *          closeRuntimeOnExit?:boolean, allowExternalRuntime?:boolean, devFixtures?:boolean,
   *          nebulaEngine?:'unity'|'webgl'}} patch
   */
  function override(patch) {
    const clean = {};
    for (const key of ['dataDir', 'port', 'runtimeUrl', 'autoStartRuntime', 'closeRuntimeOnExit', 'allowExternalRuntime', 'devFixtures', 'nebulaEngine']) {
      if (patch && patch[key] !== undefined && patch[key] !== null && patch[key] !== '') clean[key] = patch[key];
    }
    if (!Object.keys(clean).length) return get();
    const { settings: next, errors } = normalizeSettings(clean, settings);
    if (errors.length) {
      if (logger) logger.warn('settings', '命令行参数覆盖无效，已忽略', { errors });
      return get();
    }
    settings = next;
    emitter.emit('change', get());
    if (logger) logger.info('settings', '命令行参数覆盖（仅本次运行）', { dataDir: settings.dataDir, port: settings.port });
    return get();
  }

  return {
    get,
    load,
    save,
    update,
    override,
    onChange,
    filePath: () => filePath,
    effectiveRuntimeUrl: () => effectiveRuntimeUrl(settings),
    isLoaded: () => loaded,
    defaults: defaultSettings,
  };
}

module.exports = { createSettingsStore, defaultSettings, normalizeSettings, effectiveRuntimeUrl, QUALITY_LEVELS, NEBULA_ENGINES, SETTINGS_SCHEMA_VERSION };
