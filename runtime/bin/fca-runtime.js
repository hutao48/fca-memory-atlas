#!/usr/bin/env node
// FCA Local Runtime — CLI 入口
// 用法：fca-runtime <serve|init|status|stop|health|backup|restore|export|import|seed|migrate|logs|version>
// 通用参数：--fca-home=<dir>、--port=<port>、--host=<host>、--json、--quiet、--help
import fs from 'node:fs';
import path from 'node:path';
import { resolveConfig, ensureDirectories, PRODUCT_VERSION, API_VERSION, describeDefaults } from '../src/config/index.js';
import { ConfigError, ApiError } from '../src/core/errors.js';
import { createLogger, tailLogs } from '../src/logging/index.js';
import { readTokenFile } from '../src/security/auth.js';
import { newTraceId } from '../src/core/ids.js';
import { nowIso } from '../src/core/time.js';
import {
  startRuntime,
  createOfflineRuntime,
  readRuntimeInfo,
  removeRuntimeFiles,
  isProcessAlive,
} from '../src/runtime.js';
import { seedDemo } from '../src/seed/demo.js';
import { getMigrationState } from '../src/persistence/migrations.js';

const HELP = `FCA Local Runtime CLI (v${PRODUCT_VERSION}, API v${API_VERSION})

用法: fca-runtime <command> [options]

命令:
  init                 初始化数据目录与空数据库（幂等；生成认证 token）
  serve                启动本地 HTTP Runtime（127.0.0.1，默认端口 17860）
  status               查看运行状态（pid/port/uptime/version/db）
  stop                 优雅停止 Runtime（幂等：未运行也返回 0）
  health               调用 GET /health 输出健康 JSON
  backup [--note=...]  创建备份（Runtime 未运行时离线备份）
  restore <backup_id>  恢复备份（在线或离线；离线恢复前需停止 Runtime）
  export [--format=json|jsonl|zip] [--path=...]   导出 FCA 格式
  import <path> [--format=...]                    导入 FCA 导出文件
  seed --demo [--clear] [--count=120]             生成/清除演示数据（需先停止 Runtime）
  migrate              执行数据库迁移（需先停止 Runtime）
  logs [--level=] [--limit=] [--since=]           读取脱敏日志尾部
  version              打印版本

通用参数:
  --fca-home=<绝对路径>  数据目录（默认 %LOCALAPPDATA%\\FCA-Memory-Atlas；env FCA_HOME 优先于默认）
  --port=<端口>          监听端口或连接端口（CLI 优先于配置文件）
  --host=<主机>          监听地址（仅允许回环，除非 FCA_ALLOW_REMOTE=1）
  --json                 以 JSON 输出（默认即为 JSON）
  --quiet                不输出人类可读日志到 stderr
  --help                 显示本帮助

环境变量: FCA_HOME / FCA_PORT / FCA_HOST / FCA_LOG_LEVEL / FCA_SSE_HEARTBEAT_MS / FCA_ALLOW_REMOTE
`;

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_CONFIG = 2;
const EXIT_PORT = 3;

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHuman(text) {
  process.stderr.write(`${text}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseUrl(config, info = null) {
  if (info?.url) return String(info.url).replace(/\/$/, '');
  const host = config.host === 'localhost' ? '127.0.0.1' : config.host;
  return `http://${host}:${config.port}`;
}

async function httpRequest(config, pathname, { method = 'GET', body, auth = true, timeoutMs = 15_000, client = 'cli', info = null } = {}) {
  const headers = {
    'X-FCA-Client': client,
    'X-FCA-Trace-Id': newTraceId(),
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    let token;
    try {
      token = readTokenFile(config.paths.tokenFile);
    } catch (err) {
      const error = new Error(`无法读取 token 文件 ${config.paths.tokenFile}：${err.message}（先运行 init）`);
      error.code = 'TOKEN_NOT_FOUND';
      throw error;
    }
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${baseUrl(config, info)}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!response.ok) {
    const message = json?.error?.message ?? `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.code = json?.error?.code ?? 'HTTP_ERROR';
    error.body = json;
    throw error;
  }
  return json;
}

async function probeHealth(config, { timeoutMs = 1500, info = null } = {}) {
  try {
    const response = await fetch(`${baseUrl(config, info)}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * 探测“当前 FCA_HOME 自己的” Runtime。
 * 端口上的 /health 可能属于其它数据目录的实例（例如桌面/插件常驻在同一端口）：
 * 用 health.data_dir 交叉校验，避免 CLI 误判为已运行、甚至误停别的实例。
 * @returns {Promise<object|null>} 返回 health 本体；foreign=true 表示端口被其它数据目录实例占用
 */
async function probeOwnRuntime(config, { timeoutMs = 1500, info = null } = {}) {
  const health = await probeHealth(config, { timeoutMs, info });
  if (!health) return null;
  const remoteHome = health.data_dir ? path.resolve(String(health.data_dir)) : null;
  if (remoteHome) {
    if (remoteHome !== path.resolve(config.paths.home)) {
      return { ...health, foreign: true, other_data_dir: remoteHome };
    }
    return { ...health, foreign: false };
  }
  // 旧版本 Runtime 的 /health 无 data_dir：若本数据目录存在 pid/lock 文件（info），
  // 认为该端口上的实例就是自己；否则视为其它数据目录的未知实例，宁可离线操作也不误停。
  if (info) return { ...health, foreign: false };
  return { ...health, foreign: true, other_data_dir: null };
}

function cliMeta(config) {
  return {
    actor: { kind: 'user', id: 'cli', display: 'CLI' },
    source: { kind: 'cli', id: 'cli-main', version: config.productVersion },
    traceId: newTraceId(),
  };
}

function emitOfflineEvent(rt, type, payload) {
  try {
    if (!rt.holder.isInitialized || !rt.holder.db) return null;
    const prepared = rt.events.prepare(rt.holder.db, {
      type,
      actor: { kind: 'user', id: 'cli', display: 'CLI' },
      source: { kind: 'cli', id: 'cli-main', version: rt.config.productVersion },
      subject: { kind: type.split('.')[0], id: null },
      payload,
      trace_id: newTraceId(),
    });
    rt.events.publish(prepared.event);
    return prepared.event;
  } catch {
    return null;
  }
}

async function commandInit(config, logger) {
  ensureDirectories(config);
  const rt = createOfflineRuntime({ config, logger, createToken: true });
  try {
    const result = rt.holder.initialize();
    let eventId = null;
    if (result.created) {
      const event = emitOfflineEvent(rt, 'db.initialized', {
        created: true,
        schema_version: result.schema_version,
        db_path: result.db_path,
      });
      eventId = event?.id ?? null;
    }
    return {
      ok: true,
      initialized: true,
      created: result.created,
      already_initialized: !result.created,
      data_dir: config.paths.home,
      db_path: config.paths.db,
      token_path: config.paths.tokenFile,
      log_dir: config.paths.logsDir,
      pid_file: config.paths.pidFile,
      schema_version: result.schema_version,
      created_at: result.created_at,
      event_id: eventId,
    };
  } finally {
    rt.close();
  }
}

async function commandServe(config, logger) {
  ensureDirectories(config);
  const info = readRuntimeInfo(config);
  if (info && isProcessAlive(info.pid)) {
    const health = await probeHealth(config, { info });
    if (health) {
      return {
        code: EXIT_OK,
        result: {
          ok: true,
          already_running: true,
          message: 'already running',
          ...info,
          health,
          token_path: config.paths.tokenFile,
        },
        terminate: true,
      };
    }
    printHuman(`[warn] 发现陈旧 pid 文件（pid=${info.pid} 不存在或健康检查失败），已清理后重新启动`);
    removeRuntimeFiles(config);
  }
  const runtime = await startRuntime({ config, logger });
  // startRuntime 打印 FCA_RUNTIME_READY 行；进程保持运行直到 shutdown/signal
  printHuman(
    `FCA Local Runtime 已启动: ${runtime.url} (pid=${config.pid})\n` +
      `  data_dir: ${config.paths.home}\n  token:    ${config.paths.tokenFile}\n  logs:     ${config.paths.logsDir}\n  pid:      ${config.paths.pidFile}`,
  );
  return { code: null, result: null, keepAlive: true, runtime };
}

async function commandStatus(config, logger) {
  const info = readRuntimeInfo(config);
  const probe = await probeOwnRuntime(config, { info });
  const health = probe && !probe.foreign ? probe : null;
  const otherRuntime = probe?.foreign
    ? { url: baseUrl(config, info), pid: probe.pid ?? null, data_dir: probe.other_data_dir, initialized: probe.initialized ?? null }
    : null;
  let system = null;
  if (health) {
    try {
      system = await httpRequest(config, '/api/v1/system/status', { info, timeoutMs: 4000 });
    } catch {
      system = null;
    }
  }
  const db = rtDbSummary(config, info);
  return {
    ok: true,
    running: Boolean(health),
    pid: info?.pid ?? health?.pid ?? null,
    port: info?.port ?? (health ? config.port : config.port),
    url: baseUrl(config, info),
    uptime_ms: health?.uptime_ms ?? null,
    started_at: info?.started_at ?? system?.started_at ?? null,
    version: health?.version ?? config.productVersion,
    api_version: health?.api_version ?? config.apiVersion,
    initialized: health?.initialized ?? null,
    health,
    other_runtime: otherRuntime,
    db,
    counts: system?.counts ?? null,
    gpu: system?.gpu ?? null,
    clients: system?.clients ?? null,
    data_dir: config.paths.home,
    db_path: config.paths.db,
    token_path: config.paths.tokenFile,
    pid_file: config.paths.pidFile,
    lock_file: path.join(config.paths.home, 'runtime.lock'),
    log_dir: config.paths.logsDir,
    event_log_dir: config.paths.eventsDir,
    backup_dir: config.paths.backupsDir,
  };
}

function rtDbSummary(config, info) {
  const summary = {
    path: config.paths.db,
    exists: false,
    size_bytes: null,
    user_version: null,
    initialized: null,
  };
  try {
    const stat = fs.statSync(config.paths.db);
    summary.exists = true;
    summary.size_bytes = stat.size;
  } catch {
    return summary;
  }
  if (!info && !isProcessAlive(info?.pid)) {
    // 离线读取 schema 版本（不修改库）
    try {
      summary.user_version = null;
    } catch {
      /* ignore */
    }
  }
  return summary;
}

async function commandStop(config, logger) {
  const info = readRuntimeInfo(config);
  const probe = await probeOwnRuntime(config, { info });
  const health = probe && !probe.foreign ? probe : null;
  if (!info && !health) {
    removeRuntimeFiles(config);
    const result = { ok: true, running: false, message: 'not running', data_dir: config.paths.home };
    if (probe?.foreign) {
      result.message = 'not running（配置端口上运行的是另一个数据目录的 Runtime，未对其操作）';
      result.other_runtime = { url: baseUrl(config), pid: probe.pid ?? null, data_dir: probe.other_data_dir };
    }
    return result;
  }
  const pid = info?.pid ?? health?.pid ?? null;
  if (health) {
    try {
      await httpRequest(config, '/api/v1/shutdown', { method: 'POST', body: {}, info, timeoutMs: 4000, client: 'cli' });
    } catch (err) {
      logger.warn('HTTP shutdown 调用失败，将使用进程信号', { error: err.message });
    }
  }
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const stillAlive = pid ? isProcessAlive(pid) : false;
    const stillHealth = await probeHealth(config, { timeoutMs: 600, info });
    if (!stillAlive && !stillHealth) break;
    await sleep(150);
  }
  if (pid && isProcessAlive(pid) && pid !== config.pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
    await sleep(500);
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
  removeRuntimeFiles(config);
  const stillAlive = pid ? isProcessAlive(pid) : false;
  return {
    ok: !stillAlive,
    running: stillAlive,
    message: stillAlive ? `进程 ${pid} 仍在运行（可能需要手动结束）` : 'stopped',
    pid,
    port: info?.port ?? health?.port ?? config.port,
    data_dir: config.paths.home,
  };
}

async function commandHealth(config, logger) {
  const probe = await probeOwnRuntime(config);
  if (!probe) return { code: EXIT_ERROR, result: { ok: false, running: false, url: baseUrl(config), message: 'Runtime 未运行或健康检查失败' } };
  if (probe.foreign) {
    return {
      code: EXIT_ERROR,
      result: {
        ok: false,
        running: false,
        url: baseUrl(config),
        message: '配置端口上运行的是另一个数据目录的 Runtime（不是当前 FCA_HOME）',
        other_runtime: { pid: probe.pid ?? null, data_dir: probe.other_data_dir },
      },
    };
  }
  return { code: EXIT_OK, result: { ok: true, running: true, url: baseUrl(config), ...probe } };
}

async function withRuntimeOrOffline(config, logger, onlineFn, offlineFn, { requireOnline = false } = {}) {
  const info = readRuntimeInfo(config);
  const probe = await probeOwnRuntime(config, { info });
  const health = probe && !probe.foreign ? probe : null;
  if (health) return onlineFn(info, health);
  if (probe?.foreign) {
    logger?.warn?.('配置端口上的 Runtime 属于其它数据目录，本次对本数据目录执行离线操作', {
      port: config.port,
      other_data_dir: probe.other_data_dir,
    });
  }
  if (requireOnline) {
    throw new ConfigError(`Runtime 未运行（${baseUrl(config, info)}），请先启动 fca-runtime serve`, 'RUNTIME_NOT_RUNNING');
  }
  const rt = createOfflineRuntime({ config, logger });
  try {
    let openError = null;
    try {
      rt.holder.open();
    } catch (err) {
      openError = err;
    }
    return offlineFn(rt, openError);
  } finally {
    rt.close();
  }
}

async function commandBackup(config, logger) {
  const note = config.flags.note ? String(config.flags.note) : null;
  return withRuntimeOrOffline(
    config,
    logger,
    async (info) => {
      const result = await httpRequest(config, '/api/v1/backup', { method: 'POST', body: { note }, info });
      return { ok: true, online: true, ...result };
    },
    (rt) => {
      if (!rt.holder.isInitialized) throw new ApiError('NOT_INITIALIZED', '数据库尚未初始化，请先运行 fca-runtime init');
      const result = rt.services.backup.create({ note }, cliMeta(config));
      return { ok: true, online: false, ...result };
    },
  );
}

async function commandRestore(config, logger) {
  const backupId = config.positional[0];
  if (!backupId) throw new ConfigError('用法: fca-runtime restore <backup_id>', 'BAD_ARGUMENTS');
  const probe = await probeOwnRuntime(config, { info: readRuntimeInfo(config) });
  const online = probe && !probe.foreign ? probe : null;
  if (online) {
    const result = await httpRequest(config, '/api/v1/restore', { method: 'POST', body: { backup_id: backupId } });
    return { ok: true, online: true, ...result };
  }
  const rt = createOfflineRuntime({ config, logger });
  try {
    try {
      rt.holder.open();
    } catch {
      // DB 可能已损坏：restore 会替换文件，允许继续
    }
    const result = rt.services.backup.restore(backupId, cliMeta(config));
    return { ok: true, online: false, ...result };
  } finally {
    rt.close();
  }
}

async function commandExport(config, logger) {
  const format = config.flags.format ? String(config.flags.format) : 'json';
  const exportPath = config.flags.path ? String(config.flags.path) : null;
  return withRuntimeOrOffline(
    config,
    logger,
    async (info) => {
      const result = await httpRequest(config, '/api/v1/export', {
        method: 'POST',
        body: { format, path: exportPath },
        info,
        timeoutMs: 120_000,
      });
      return { ok: true, online: true, ...result };
    },
    (rt) => {
      if (!rt.holder.isInitialized) throw new ApiError('NOT_INITIALIZED', '数据库尚未初始化');
      const result = rt.services.exchange.exportData({ format, path: exportPath }, cliMeta(config));
      return { ok: true, online: false, ...result };
    },
  );
}

async function commandImport(config, logger) {
  const filePath = config.positional[0] ?? config.flags.path;
  if (!filePath) throw new ConfigError('用法: fca-runtime import <file.json|file.jsonl|file.zip>', 'BAD_ARGUMENTS');
  const format = config.flags.format ? String(config.flags.format) : null;
  return withRuntimeOrOffline(
    config,
    logger,
    async (info) => {
      const result = await httpRequest(config, '/api/v1/import', {
        method: 'POST',
        body: { path: path.resolve(String(filePath)), format },
        info,
        timeoutMs: 300_000,
      });
      return { ok: true, online: true, ...result };
    },
    (rt) => {
      if (!rt.holder.isInitialized) throw new ApiError('NOT_INITIALIZED', '数据库尚未初始化');
      const result = rt.services.exchange.importData({ path: path.resolve(String(filePath)), format }, cliMeta(config));
      return { ok: true, online: false, ...result };
    },
  );
}

async function commandSeed(config, logger) {
  const probe = await probeOwnRuntime(config, { info: readRuntimeInfo(config) });
  if (probe && !probe.foreign) {
    throw new ConfigError(
      'Runtime 正在运行：seed 会直接写数据库，请先执行 fca-runtime stop 再 seed（seed 完成后重新 serve）',
      'RUNTIME_RUNNING',
    );
  }
  const rt = createOfflineRuntime({ config, logger });
  try {
    let openError = null;
    try {
      rt.holder.open();
    } catch (err) {
      openError = err;
    }
    if (!rt.holder.isInitialized) {
      throw new ApiError('NOT_INITIALIZED', `数据库尚未初始化${openError ? `（${openError.message}）` : ''}，请先运行 fca-runtime init`);
    }
    const clear = Boolean(config.flags.clear);
    const count = config.flags.count ? Number(config.flags.count) : 120;
    const result = seedDemo(rangeDeps(rt), { clear, count });
    return { ok: true, online: false, ...result, data_dir: config.paths.home, db_path: config.paths.db };
  } finally {
    rt.close();
  }
}

function rangeDeps(rt) {
  return { config: rt.config, logger: rt.logger, holder: rt.holder, events: rt.events, services: rt.services };
}

async function commandMigrate(config, logger) {
  const probe = await probeOwnRuntime(config, { info: readRuntimeInfo(config) });
  if (probe && !probe.foreign) throw new ConfigError('Runtime 正在运行，请先 fca-runtime stop 再执行 migrate', 'RUNTIME_RUNNING');
  const rt = createOfflineRuntime({ config, logger });
  try {
    let openError = null;
    try {
      rt.holder.open();
    } catch (err) {
      openError = err;
    }
    if (!rt.holder.isInitialized) {
      throw new ApiError('NOT_INITIALIZED', `数据库尚未初始化或无法打开${openError ? `（${openError.message}）` : ''}，请先运行 fca-runtime init`);
    }
    const state = getMigrationState(rt.holder.db);
    if (state.user_version > state.schema_version) {
      throw new ConfigError('数据库 schema 版本高于当前 Runtime 支持版本，请升级 Runtime', 'SCHEMA_TOO_NEW');
    }
    return { ok: true, migrated: true, ...state, db_path: config.paths.db };
  } finally {
    rt.close();
  }
}

function commandLogs(config, logger) {
  let limit = Number(config.flags.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = 100;
  const level = config.flags.level ? String(config.flags.level) : null;
  const since = config.flags.since ? String(config.flags.since) : null;
  const items = tailLogs(config, { level, limit: Math.min(2000, limit), since });
  return {
    ok: true,
    items,
    total: items.length,
    log_dir: config.paths.logsDir,
    files: (() => {
      try {
        return fs.readdirSync(config.paths.logsDir).filter((f) => f.endsWith('.log')).sort();
      } catch {
        return [];
      }
    })(),
    data_dir: config.paths.home,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  let config;
  try {
    config = resolveConfig({ argv });
  } catch (err) {
    const code = err instanceof ConfigError ? err.exitCode ?? EXIT_CONFIG : EXIT_CONFIG;
    printJson({ ok: false, error: { code: err.code ?? 'CONFIG_ERROR', message: err.message } });
    return code;
  }
  if (config.flags.help || !config.command) {
    process.stdout.write(HELP);
    return config.command ? EXIT_OK : EXIT_ERROR;
  }
  const quiet = Boolean(config.flags.quiet);
  const logger = createLogger({ config, silent: quiet });
  try {
    switch (config.command) {
      case 'init': {
        printJson(await commandInit(config, logger));
        return EXIT_OK;
      }
      case 'serve': {
        const { code, result, keepAlive } = await commandServe(config, logger);
        if (keepAlive) return null; // 进程保持运行
        if (result) printJson(result);
        return code ?? EXIT_OK;
      }
      case 'status': {
        printJson(await commandStatus(config, logger));
        return EXIT_OK;
      }
      case 'stop': {
        printJson(await commandStop(config, logger));
        return EXIT_OK;
      }
      case 'health': {
        const { code, result } = await commandHealth(config, logger);
        printJson(result);
        return code;
      }
      case 'backup': {
        printJson(await commandBackup(config, logger));
        return EXIT_OK;
      }
      case 'restore': {
        printJson(await commandRestore(config, logger));
        return EXIT_OK;
      }
      case 'export': {
        printJson(await commandExport(config, logger));
        return EXIT_OK;
      }
      case 'import': {
        printJson(await commandImport(config, logger));
        return EXIT_OK;
      }
      case 'seed': {
        if (!config.flags.demo && !config.flags.clear) {
          throw new ConfigError('用法: fca-runtime seed --demo [--clear] [--count=120]', 'BAD_ARGUMENTS');
        }
        printJson(await commandSeed(config, logger));
        return EXIT_OK;
      }
      case 'migrate': {
        printJson(await commandMigrate(config, logger));
        return EXIT_OK;
      }
      case 'logs': {
        printJson(commandLogs(config, logger));
        return EXIT_OK;
      }
      case 'version':
      case '--version': {
        printJson({ ok: true, product: 'FCA Local Runtime', version: PRODUCT_VERSION, api_version: API_VERSION });
        return EXIT_OK;
      }
      default:
        throw new ConfigError(`未知命令：${config.command}（fca-runtime --help 查看用法）`, 'UNKNOWN_COMMAND');
    }
  } catch (err) {
    const isApi = err instanceof ApiError;
    const code = err instanceof ConfigError ? err.exitCode ?? EXIT_CONFIG : isApi ? (err.status === 401 ? EXIT_ERROR : EXIT_ERROR) : EXIT_ERROR;
    printJson({
      ok: false,
      error: {
        code: err.code ?? (isApi ? 'API_ERROR' : 'ERROR'),
        message: err.message,
        details: err.details ?? err.body?.error?.details ?? null,
        http_status: err.status ?? null,
      },
    });
    if (err instanceof ConfigError && err.code === 'PORT_IN_USE') return EXIT_PORT;
    return code;
  } finally {
    if (config.command !== 'serve') logger.close?.();
  }
}

const exitCode = await main();
if (typeof exitCode === 'number') {
  process.exitCode = exitCode;
  // 不调用 process.exit()：让 stdout/日志流与 undici 句柄自然收尾，避免 Windows 上
  // 强制退出与异步句柄关闭竞争触发的 libuv 断言（0xC0000409）。
  // 若仍有保持进程存活的外部句柄，最多 2s 后强制退出（兜底，不阻塞 CLI）。
  const force = setTimeout(() => process.exit(exitCode), 2000);
  force.unref();
}
