// FCA Local Runtime — node:sqlite 持久层封装（WAL / 事务 / 完整性检查 / 元信息）
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ApiError, databaseError } from '../core/errors.js';

export const BUSY_TIMEOUT_MS = 5_000;

/**
 * 打开 SQLite 数据库并应用运行时 PRAGMA。
 * @param {string} dbPath
 * @param {{readonly?: boolean}} [options]
 */
export function openDatabase(dbPath, { readonly = false } = {}) {
  if (!readonly) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: readonly });
  } catch (err) {
    throw databaseError(`无法打开数据库 ${dbPath}: ${err.message}`);
  }
  try {
    if (!readonly) {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('PRAGMA temp_store = MEMORY');
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      db.exec('PRAGMA foreign_keys = ON');
    }
  } catch (err) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw databaseError(`初始化数据库 PRAGMA 失败: ${err.message}`);
  }
  return db;
}

export function closeQuietly(db) {
  if (!db) return;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* ignore */
  }
  try {
    db.close();
  } catch {
    /* ignore */
  }
}

/**
 * 在 SQLite 事务中执行 fn；异常自动回滚。
 * @template T
 * @param {DatabaseSync} db
 * @param {() => T} fn
 * @param {{immediate?: boolean}} [options]
 * @returns {T}
 */
export function withTransaction(db, fn, { immediate = true } = {}) {
  db.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function getUserVersion(db) {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row?.user_version ?? 0);
}

export function tableExists(db, name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name);
  return Boolean(row);
}

/** PRAGMA integrity_check（完整）。 */
export function integrityCheck(db) {
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    const messages = rows.map((r) => r.integrity_check);
    return { ok: messages.length === 1 && messages[0] === 'ok', messages };
  } catch (err) {
    return { ok: false, messages: [String(err.message ?? err)] };
  }
}

/** PRAGMA quick_check（启动时较快）。 */
export function quickCheck(db) {
  try {
    const rows = db.prepare('PRAGMA quick_check').all();
    const messages = rows.map((r) => r.quick_check);
    return { ok: messages.length === 1 && messages[0] === 'ok', messages };
  } catch (err) {
    return { ok: false, messages: [String(err.message ?? err)] };
  }
}

export function checkpointWal(db) {
  try {
    const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    return { ok: true, ...row };
  } catch (err) {
    return { ok: false, error: String(err.message ?? err) };
  }
}

export function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(db, key, value) {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO meta(key, value, updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(key, String(value), now);
  return value;
}

export function getLayoutVersion(db) {
  return Number(getMeta(db, 'layout_version', '0')) || 0;
}

/** 递增并持久化 layout_version（布局坐标/聚类变更时调用）。 */
export function bumpLayoutVersion(db) {
  const next = getLayoutVersion(db) + 1;
  setMeta(db, 'layout_version', String(next));
  return next;
}

/** 当前数据库全部业务表计数。 */
export function collectCounts(db) {
  const one = (sql) => {
    try {
      return Number(db.prepare(sql).get()?.c ?? 0);
    } catch {
      return 0;
    }
  };
  return {
    memories: one('SELECT count(*) c FROM memories WHERE deleted_at IS NULL'),
    deleted_memories: one('SELECT count(*) c FROM memories WHERE deleted_at IS NOT NULL'),
    demo_memories: one('SELECT count(*) c FROM memories WHERE demo = 1 AND deleted_at IS NULL'),
    entities: one('SELECT count(*) c FROM entities WHERE deleted_at IS NULL'),
    relations: one('SELECT count(*) c FROM relations WHERE deleted_at IS NULL'),
    tags: one('SELECT count(*) c FROM tags WHERE deleted_at IS NULL'),
    events: one('SELECT count(*) c FROM events'),
    versions: one('SELECT count(*) c FROM memory_versions'),
    layout_nodes: one('SELECT count(*) c FROM layout_nodes'),
    layout_views: one('SELECT count(*) c FROM layout_views'),
  };
}

/** 数据库文件体积信息（含 WAL）。 */
export function collectDbSizes(dbPath) {
  const sizeOf = (p) => {
    try {
      return fs.statSync(p).size;
    } catch {
      return 0;
    }
  };
  const dbBytes = sizeOf(dbPath);
  const walBytes = sizeOf(`${dbPath}-wal`);
  const shmBytes = sizeOf(`${dbPath}-shm`);
  return { db_bytes: dbBytes, wal_bytes: walBytes, shm_bytes: shmBytes, total_bytes: dbBytes + walBytes };
}

export function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** 复制数据库到一个新文件（安全：先 checkpoint）。 */
export function copyDatabaseFile(db, fromPath, toPath) {
  checkpointWal(db);
  fs.mkdirSync(path.dirname(toPath), { recursive: true });
  fs.copyFileSync(fromPath, toPath);
  return toPath;
}

/**
 * 安全替换数据库文件：调用方必须先关闭数据库连接。
 * 保留原库为 .replaced-<ts> 以防万一（可被 backup 清理）。
 */
export function replaceDatabaseFile(dbPath, sourcePath, { keepOld = true } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  for (const suffix of ['-wal', '-shm']) {
    const p = `${dbPath}${suffix}`;
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
  let oldPath = null;
  if (fs.existsSync(dbPath) && keepOld) {
    oldPath = `${dbPath}.replaced-${Date.now()}`;
    fs.renameSync(dbPath, oldPath);
  }
  fs.copyFileSync(sourcePath, dbPath);
  return { oldPath };
}

export function requireDb(db) {
  if (!db) throw new ApiError('NOT_INITIALIZED', '数据库尚未初始化，请先调用 POST /api/v1/db/init');
  return db;
}

export { DatabaseSync };
