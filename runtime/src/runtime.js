// FCA Local Runtime — 进程装配（离线 CLI 操作 / HTTP 服务启动/关闭 / pid+lock 文件）
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirectories } from './config/index.js';
import { ConfigError } from './core/errors.js';
import { DatabaseHolder } from './persistence/holder.js';
import { createEventStore } from './events/index.js';
import { createSseHub } from './events/hub.js';
import { buildServices } from './services.js';
import { createHttpServer } from './server/index.js';
import { backupDatabase } from './backup/index.js';
import { ensureTokenFile } from './security/auth.js';
import { newTraceId } from './core/ids.js';

/**
 * 判断是否为"父进程/stdout 管道已关闭"类错误。
 * 这类错误不应触发 uncaughtException 日志链路（否则日志写入本身会再次 EPIPE，形成死循环）。
 */
export function isBrokenPipeError(err) {
  if (!err) return false;
  const code = err.code || err.errno;
  return code === 'EPIPE' || code === 'ECONNRESET' || /EPIPE|broken pipe/i.test(String(err.message || ''));
}

// 保护控制台流：桌面 app 崩溃/被强杀后，Runtime 继承的 stdout/stderr 管道会关闭。
// 不监听 'error' 时，任何一次控制台写入都会异步触发 EPIPE 'error' 事件 → uncaughtException。
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === 'function') {
    stream.on('error', (err) => {
      if (isBrokenPipeError(err)) return;
      // 其它控制台错误同样不作为进程级异常：日志文件仍然可写，Runtime 继续运行。
    });
  }
}

export const LOCK_FILE_NAME = 'runtime.lock';

export function lockFilePath(config) {
  return path.join(config.paths.home, LOCK_FILE_NAME);
}

/** 写 runtime.pid 与 runtime.lock（含 pid/port/started_at）。 */
export function writeRuntimeFiles(config, info) {
  const payload = {
    pid: info.pid ?? config.pid,
    port: info.port ?? config.port,
    host: info.host ?? config.host,
    url: info.url ?? config.url,
    started_at: info.started_at ?? new Date().toISOString(),
    data_dir: config.paths.home,
    version: config.productVersion,
    api_version: config.apiVersion,
  };
  try {
    fs.mkdirSync(config.paths.home, { recursive: true });
    fs.writeFileSync(config.paths.pidFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.writeFileSync(lockFilePath(config), `${JSON.stringify({ ...payload, lock: 'fca-runtime', lockfile: true }, null, 2)}\n`, 'utf8');
    return payload;
  } catch (err) {
    throw new ConfigError(`无法写入 Runtime pid/lock 文件：${err.message}`);
  }
}

export function readRuntimeInfo(config) {
  for (const filePath of [config.paths.pidFile, lockFilePath(config)]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && Number.isInteger(Number(parsed.pid))) {
        return {
          ...parsed,
          pid: Number(parsed.pid),
          port: parsed.port === undefined ? config.port : Number(parsed.port),
          source_file: filePath,
        };
      }
    } catch {
      /* 继续尝试下一个文件 */
    }
  }
  return null;
}

export function removeRuntimeFiles(config) {
  for (const filePath of [config.paths.pidFile, lockFilePath(config)]) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

export function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** 迁移前自动备份（仅已有 schema 的库升级时触发）。 */
export function makeBeforeMigrate(config, logger, holderRef) {
  return (fromVersion, toVersion) => {
    try {
      if (!holderRef.holder.db) return;
      const manifest = backupDatabase(holderRef.holder.db, config, {
        note: `迁移前自动备份 v${fromVersion} → v${toVersion}`,
        logger,
      });
      logger?.info?.('迁移前自动备份完成', { backup_id: manifest.backup_id, path: manifest.path });
    } catch (err) {
      logger?.warn?.('迁移前自动备份失败（继续迁移）', { error: err.message });
    }
  };
}

/**
 * 离线 Runtime（CLI：init/backup/restore/export/import/seed/migrate 使用）。
 */
export function createOfflineRuntime({ config, logger, createToken = false }) {
  ensureDirectories(config);
  let tokenInfo = null;
  if (createToken) tokenInfo = ensureTokenFile(config.paths.tokenFile);
  const holderRef = { holder: null };
  holderRef.holder = new DatabaseHolder({
    config,
    logger,
    beforeMigrate: makeBeforeMigrate(config, logger, holderRef),
  });
  const holder = holderRef.holder;
  const events = createEventStore({ dbHolder: holder, config, logger });
  const services = buildServices({ config, logger, dbHolder: holder, events, hub: null });
  return {
    config,
    logger,
    holder,
    events,
    services,
    token: tokenInfo?.token ?? null,
    tokenPath: config.paths.tokenFile,
    close() {
      holder.close();
      logger.close?.();
    },
  };
}

function readyLine(info) {
  return `FCA_RUNTIME_READY ${JSON.stringify(info)}`;
}

/**
 * 启动 HTTP Runtime。
 * @returns {Promise<object>}
 */
export async function startRuntime({ config, logger }) {
  ensureDirectories(config);
  const tokenInfo = ensureTokenFile(config.paths.tokenFile);
  logger.addSecret?.(tokenInfo.token);

  const state = {
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    shuttingDown: false,
    errorStats: { count: 0, last: null },
    port: null,
    url: null,
    requestShutdown: null,
  };
  const holderRef = { holder: null };
  holderRef.holder = new DatabaseHolder({
    config,
    logger,
    beforeMigrate: makeBeforeMigrate(config, logger, holderRef),
  });
  const holder = holderRef.holder;
  try {
    holder.open();
    if (holder.isInitialized) {
      logger.info('数据库已打开', { db: config.paths.db, schema_version: holder.schemaVersion });
    } else {
      logger.warn('数据库尚未初始化（可通过 POST /api/v1/db/init 初始化空库）', { db: config.paths.db, state: holder.state });
    }
  } catch (err) {
    logger.error('数据库打开失败：服务将以降级状态启动（可调用 POST /api/v1/restore 恢复备份）', {
      error: err.message,
      db: config.paths.db,
    });
  }

  const events = createEventStore({ dbHolder: holder, config, logger });
  const hub = createSseHub({ config, logger, eventStore: events, startedAtMs: state.startedAtMs });
  events.setHub(hub);
  const services = buildServices({ config, logger, dbHolder: holder, events, hub, state });
  const httpServer = await createHttpServer({
    config,
    logger,
    token: tokenInfo.token,
    holder,
    events,
    hub,
    services,
    state,
  });

  let address;
  try {
    address = await httpServer.start();
  } catch (err) {
    holder.close();
    logger.close?.();
    if (err && err.code === 'EADDRINUSE') {
      throw new ConfigError(
        `端口 ${config.port} 已被占用：可能已有 Runtime 在运行（用 fca-runtime status / stop 查看），或其它程序占用了该端口（可用 --port 更换）。`,
        'PORT_IN_USE',
      );
    }
    if (err && err.code === 'EACCES') {
      throw new ConfigError(`无权限监听 ${config.host}:${config.port}：${err.message}`, 'PORT_ACCESS');
    }
    throw err;
  }
  state.port = address.port;
  state.url = `http://${config.host === 'localhost' ? '127.0.0.1' : config.host}:${address.port}`;

  writeRuntimeFiles(config, {
    pid: config.pid,
    port: address.port,
    host: config.host,
    url: state.url,
    started_at: state.startedAt,
  });

  const readyInfo = {
    status: 'ready',
    pid: config.pid,
    host: config.host,
    port: address.port,
    url: state.url,
    fca_home: config.paths.home,
    data_dir: config.paths.home,
    db_path: config.paths.db,
    token_path: config.paths.tokenFile,
    pid_file: config.paths.pidFile,
    lock_file: lockFilePath(config),
    log_dir: config.paths.logsDir,
    event_log_dir: config.paths.eventsDir,
    backup_dir: config.paths.backupsDir,
    api_version: config.apiVersion,
    product_version: config.productVersion,
    initialized: holder.isInitialized,
    schema_version: holder.schemaVersion,
    started_at: state.startedAt,
  };
  if (holder.isInitialized) {
    try {
      const prepared = events.prepare(holder.db, {
        type: 'system.started',
        actor: { kind: 'system', id: 'runtime', display: '系统' },
        source: { kind: 'cli', id: 'cli-main', version: config.productVersion },
        subject: { kind: 'system', id: null },
        payload: { pid: config.pid, host: config.host, port: address.port, data_dir: config.paths.home, version: config.productVersion, api_version: config.apiVersion },
        trace_id: newTraceId(),
      });
      events.publish(prepared.event);
    } catch (err) {
      logger.warn('system.started 事件写入失败', { error: err.message });
    }
  }
  logger.info('FCA Local Runtime 已启动', {
    url: state.url,
    pid: config.pid,
    data_dir: config.paths.home,
    initialized: holder.isInitialized,
  });
  // 机器可读的 READY 行（Desktop/CLI/测试用于发现端口与数据目录）
  try {
    process.stdout.write(`${readyLine(readyInfo)}\n`);
  } catch (err) {
    if (!isBrokenPipeError(err)) throw err;
  }

  let shutdownPromise = null;
  async function shutdown(reason = 'api') {
    if (shutdownPromise) return shutdownPromise;
    state.shuttingDown = true;
    logger.info('Runtime 正在关闭', { reason });
    shutdownPromise = (async () => {
      try {
        if (holder.isInitialized && holder.db) {
          const prepared = events.prepare(holder.db, {
            type: 'system.stopped',
            actor: { kind: 'system', id: 'runtime', display: '系统' },
            source: { kind: 'cli', id: 'cli-main', version: config.productVersion },
            subject: { kind: 'system', id: null },
            payload: { pid: config.pid, reason, uptime_ms: Date.now() - state.startedAtMs },
            trace_id: newTraceId(),
          });
          events.publish(prepared.event);
        }
      } catch (err) {
        logger.warn('system.stopped 事件写入失败', { error: err.message });
      }
      try {
        hub.closeAll({ reason });
      } catch {
        /* ignore */
      }
      await httpServer.stop();
      holder.close();
      removeRuntimeFiles(config);
      logger.info('Runtime 已关闭', { reason, uptime_ms: Date.now() - state.startedAtMs });
      await logger.flush?.();
    })();
    return shutdownPromise;
  }

  state.requestShutdown = (reason = 'api') => {
    shutdown(reason)
      .then(() => {
        setTimeout(() => process.exit(0), 20);
      })
      .catch((err) => {
        logger.error('关闭失败', { error: err.message });
        process.exit(1);
      });
  };

  const onSignal = () => {
    shutdown('signal')
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('uncaughtException', (err) => {
    // 管道关闭类错误：直接忽略，绝不能再调用 logger（logger 写 stderr 会再次 EPIPE）。
    if (isBrokenPipeError(err)) return;
    try {
      logger.error('uncaughtException', { error: err.message, stack: String(err.stack ?? '').slice(0, 4000) });
    } catch {
      /* 日志链路自身失败时不影响进程存活 */
    }
    state.errorStats.count += 1;
    state.errorStats.last = { code: 'INTERNAL', message: err.message, ts: new Date().toISOString(), trace_id: null };
  });
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    logger.error('unhandledRejection', { error: message, stack: reason instanceof Error ? String(reason.stack ?? '').slice(0, 4000) : null });
    state.errorStats.count += 1;
    state.errorStats.last = { code: 'INTERNAL', message, ts: new Date().toISOString(), trace_id: null };
  });

  return {
    config,
    logger,
    holder,
    events,
    hub,
    services,
    state,
    httpServer,
    address,
    url: state.url,
    token: tokenInfo.token,
    tokenPath: config.paths.tokenFile,
    readyInfo,
    shutdown,
  };
}
