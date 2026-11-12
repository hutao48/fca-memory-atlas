// FCA Local Runtime — 数据库生命周期持有者（打开/关闭/初始化/恢复后替换句柄）
import fs from 'node:fs';
import {
  openDatabase,
  closeQuietly,
  quickCheck,
  getUserVersion,
  tableExists,
  getMeta,
  setMeta,
  getLayoutVersion,
  collectCounts,
  collectDbSizes,
} from './db.js';
import { applyMigrations, LATEST_SCHEMA_VERSION } from './migrations.js';
import { newId } from '../core/ids.js';
import { notInitialized, databaseError } from '../core/errors.js';

/**
 * DatabaseHolder 负责在服务进程中安全地打开/关闭/替换 SQLite 连接
 *（恢复备份时需要先关闭连接再替换文件）。
 */
export class DatabaseHolder {
  /**
   * @param {{config: object, logger: object, beforeMigrate?: Function}} options
   */
  constructor({ config, logger, beforeMigrate = null }) {
    this.config = config;
    this.logger = logger;
    this.beforeMigrate = beforeMigrate;
    /** @type {import('node:sqlite').DatabaseSync | null} */
    this.db = null;
    /** closed | no-db | empty | open | error */
    this.state = 'closed';
    this.error = null;
    this.schemaVersion = 0;
    this.initializedAt = null;
    this.createdOnInit = false;
    this.openedAt = null;
  }

  get isInitialized() {
    return this.db !== null && this.state === 'open' && this.schemaVersion >= LATEST_SCHEMA_VERSION;
  }

  get dbPath() {
    return this.config.paths.db;
  }

  /** 健康状态摘要（供 /health、/system/status 使用）。 */
  status() {
    return {
      initialized: this.isInitialized,
      state: this.state,
      db: this.state === 'error' ? 'error' : this.isInitialized ? 'ok' : 'uninitialized',
      schema_version: this.schemaVersion,
      target_schema_version: LATEST_SCHEMA_VERSION,
      error: this.error ? String(this.error.message ?? this.error) : null,
      opened_at: this.openedAt,
    };
  }

  /** 返回数据库连接；未初始化时抛出契约错误。 */
  requireDb() {
    if (this.state === 'error') {
      throw databaseError(`数据库不可用：${this.error?.message ?? 'unknown'}`, { state: this.state });
    }
    if (!this.isInitialized) throw notInitialized();
    return this.db;
  }

  _openHandle() {
    this.db = openDatabase(this.dbPath);
    return this.db;
  }

  /**
   * 启动时打开已存在的数据库；不存在则保持未初始化状态（允许 /db/init 初始化）。
   * 已有库会自动执行迁移（迁移前回调 beforeMigrate 做备份）。
   */
  open() {
    if (this.db) return this.db;
    if (!fs.existsSync(this.dbPath) || fs.statSync(this.dbPath).size === 0) {
      this.state = 'no-db';
      this.schemaVersion = 0;
      return null;
    }
    try {
      this.db = this._openHandle();
      const q = quickCheck(this.db);
      if (!q.ok) {
        throw databaseError(`数据库完整性检查失败：${q.messages.join('; ')}`);
      }
      let version = getUserVersion(this.db);
      const hasSchema = tableExists(this.db, 'schema_migrations') || tableExists(this.db, 'memories');
      if (version === 0 && !hasSchema) {
        this.state = 'empty';
        this.schemaVersion = 0;
        this.logger?.info?.('数据库文件存在但尚未初始化 schema', { db: this.dbPath });
        return this.db;
      }
      if (version < LATEST_SCHEMA_VERSION) {
        const result = applyMigrations(this.db, { logger: this.logger, beforeMigrate: this.beforeMigrate });
        version = getUserVersion(this.db);
        this.logger?.info?.('数据库已迁移', { from: result.from, to: version });
      }
      this.schemaVersion = version;
      this.state = 'open';
      this.openedAt = new Date().toISOString();
      this.initializedAt = getMeta(this.db, 'initialized_at', this.openedAt);
      this.ensureBaseRows();
      return this.db;
    } catch (err) {
      this.error = err;
      this.state = 'error';
      this.schemaVersion = 0;
      closeQuietly(this.db);
      this.db = null;
      throw err instanceof Error && err.code === 'DATABASE_ERROR'
        ? err
        : databaseError(`无法打开数据库 ${this.dbPath}：${err.message}`, { state: this.state });
    }
  }

  /** 初始化空库（幂等）：建 schema + 默认身份/认知行。 */
  initialize() {
    const existed = fs.existsSync(this.dbPath) && fs.statSync(this.dbPath).size > 0;
    const created = !existed;
    try {
      if (this.db) {
        // 已有连接（例如 serve 启动时处于 no-db 状态后调用 db/init）
        const version = getUserVersion(this.db);
        if (version < LATEST_SCHEMA_VERSION) {
          applyMigrations(this.db, { logger: this.logger, beforeMigrate: this.beforeMigrate });
        }
      } else {
        this.db = this._openHandle();
        const version = getUserVersion(this.db);
        const hasSchema = tableExists(this.db, 'schema_migrations') || tableExists(this.db, 'memories');
        if (version === 0 && !hasSchema) {
          applyMigrations(this.db, { logger: this.logger });
        } else if (version < LATEST_SCHEMA_VERSION) {
          applyMigrations(this.db, { logger: this.logger, beforeMigrate: this.beforeMigrate });
        }
      }
      this.schemaVersion = getUserVersion(this.db);
      this.state = 'open';
      this.error = null;
      this.openedAt = new Date().toISOString();
      this.createdOnInit = created;
      if (!getMeta(this.db, 'initialized_at')) setMeta(this.db, 'initialized_at', new Date().toISOString());
      this.initializedAt = getMeta(this.db, 'initialized_at');
      this.ensureBaseRows();
      return {
        created,
        created_at: this.initializedAt,
        schema_version: this.schemaVersion,
        db_path: this.dbPath,
      };
    } catch (err) {
      this.error = err;
      this.state = 'error';
      closeQuietly(this.db);
      this.db = null;
      if (err instanceof Error && err.code === 'DATABASE_ERROR') throw err;
      throw databaseError(`初始化数据库失败：${err.message}`);
    }
  }

  /** 默认 identity/cognition 行（非伪造数据：空 profile 与 idle 状态）。 */
  ensureBaseRows() {
    const db = this.db;
    if (!db) return;
    const identityCount = Number(db.prepare('SELECT count(*) c FROM identity').get()?.c ?? 0);
    if (identityCount === 0) {
      db.prepare(
        'INSERT INTO identity(identity_id, display_name, summary, values_json, preferences_json, boundaries_json, version, updated_at) VALUES(?,?,?,?,?,?,?,?)',
      ).run(newId('identity'), '我', '', '[]', '{}', '[]', 1, new Date().toISOString());
    }
    const cognition = db.prepare('SELECT singleton FROM cognition WHERE singleton = 1').get();
    if (!cognition) {
      db.prepare(
        'INSERT INTO cognition(singleton, focus, attention_targets, working_memory, mood_json, mode, note, updated_at) VALUES(1,?,?,?,?,?,?,?)',
      ).run('', '[]', '[]', null, 'idle', '模拟状态，不代表主观感受', new Date().toISOString());
    }
    if (!getMeta(db, 'layout_version')) setMeta(db, 'layout_version', '0');
  }

  /** 关闭连接（恢复/关闭服务时调用）。 */
  close() {
    if (this.db) {
      closeQuietly(this.db);
      this.db = null;
    }
    this.state = 'closed';
  }

  /** 替换数据库文件后重新打开（供 restore 使用）。 */
  reopen() {
    this.close();
    return this.open();
  }

  layoutVersion() {
    if (!this.db || !this.isInitialized) return 0;
    return getLayoutVersion(this.db);
  }

  counts() {
    if (!this.db || !this.isInitialized) return null;
    return collectCounts(this.db);
  }

  sizes() {
    return collectDbSizes(this.dbPath);
  }
}
