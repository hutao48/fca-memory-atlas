// 数据库迁移 / 事务 / WAL / 完整性 / DatabaseHolder 初始化（离线模块测试，不启动 HTTP）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  openDatabase,
  closeQuietly,
  withTransaction,
  getUserVersion,
  tableExists,
  integrityCheck,
  quickCheck,
  getMeta,
  setMeta,
  getLayoutVersion,
  bumpLayoutVersion,
  collectCounts,
  requireDb,
} from '../src/persistence/db.js';
import { applyMigrations, getMigrationState, LATEST_SCHEMA_VERSION, MIGRATIONS } from '../src/persistence/migrations.js';
import { DatabaseHolder } from '../src/persistence/holder.js';
import { resolveConfig, ensureDirectories } from '../src/config/index.js';
import { ApiError } from '../src/core/errors.js';
import { makeHome, cleanupHome } from './helpers.js';

let home;
let config;

before(() => {
  home = makeHome('db');
  config = resolveConfig({ argv: ['init', `--fca-home=${home}`] });
  ensureDirectories(config);
});

after(() => {
  cleanupHome(home);
});

test('迁移：从空库应用 v1，PRAGMA user_version 与 schema_migrations 一致；重复执行幂等', () => {
  const db = openDatabase(config.paths.db);
  try {
    assert.equal(getUserVersion(db), 0);
    const applied = applyMigrations(db, {});
    assert.equal(applied.from, 0);
    assert.equal(applied.to, LATEST_SCHEMA_VERSION);
    assert.equal(applied.applied.length, MIGRATIONS.length);
    assert.equal(getUserVersion(db), LATEST_SCHEMA_VERSION);
    // 核心表存在
    for (const table of ['memories', 'memory_versions', 'entities', 'relations', 'tags', 'events', 'layout_nodes', 'layout_views', 'identity', 'cognition', 'llm_providers', 'llm_queue', 'memory_fts']) {
      assert.ok(tableExists(db, table), `缺少表 ${table}`);
    }
    // 再次迁移 no-op
    const again = applyMigrations(db, {});
    assert.equal(again.applied.length, 0);
    assert.equal(again.from, LATEST_SCHEMA_VERSION);
    const state = getMigrationState(db);
    assert.equal(state.user_version, LATEST_SCHEMA_VERSION);
    assert.equal(state.schema_version, LATEST_SCHEMA_VERSION);
    assert.ok(state.items.length >= 1);
    assert.ok(state.items.every((row) => typeof row.applied_at === 'string'));
  } finally {
    closeQuietly(db);
  }
});

test('迁移：数据库版本高于 Runtime 支持版本时拒绝降级', () => {
  const dbPath = path.join(home, 'future', 'fca.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    db.exec('PRAGMA user_version = 99');
    assert.throws(
      () => applyMigrations(db, {}),
      (err) => err.message.includes('高于 Runtime 支持的版本'),
    );
  } finally {
    closeQuietly(db);
  }
});

test('事务：withTransaction 提交生效、异常回滚且异常原样抛出', () => {
  const db = openDatabase(config.paths.db);
  try {
    withTransaction(db, () => {
      db.prepare('INSERT INTO meta(key, value, updated_at) VALUES(?,?,?)').run('tx-commit', '1', new Date().toISOString());
    });
    assert.equal(getMeta(db, 'tx-commit'), '1');

    assert.throws(
      () =>
        withTransaction(db, () => {
          db.prepare('INSERT INTO meta(key, value, updated_at) VALUES(?,?,?)').run('tx-rollback', '1', new Date().toISOString());
          throw new Error('boom');
        }),
      /boom/,
    );
    assert.equal(getMeta(db, 'tx-rollback'), null, '异常必须回滚事务');
  } finally {
    closeQuietly(db);
  }
});

test('WAL / 完整性检查 / 布局版本 / 表计数', () => {
  const db = openDatabase(config.paths.db);
  try {
    const mode = db.prepare('PRAGMA journal_mode').get();
    assert.equal(String(mode.journal_mode).toLowerCase(), 'wal');
    assert.equal(integrityCheck(db).ok, true);
    assert.equal(quickCheck(db).ok, true);
    assert.equal(getLayoutVersion(db), 0);
    assert.equal(bumpLayoutVersion(db), 1);
    assert.equal(bumpLayoutVersion(db), 2);
    assert.equal(getLayoutVersion(db), 2);
    const counts = collectCounts(db);
    assert.equal(counts.memories, 0);
    assert.equal(counts.events, 0);
    assert.equal(typeof counts.layout_nodes, 'number');
    // 未初始化时 requireDb 抛 NOT_INITIALIZED
    assert.throws(
      () => requireDb(null),
      (err) => err instanceof ApiError && err.code === 'NOT_INITIALIZED',
    );
  } finally {
    closeQuietly(db);
  }
});

test('DatabaseHolder：initialize 建库 + 默认 identity/cognition，重复 initialize 幂等', () => {
  const home2 = makeHome('db-holder');
  try {
    const cfg = resolveConfig({ argv: ['init', `--fca-home=${home2}`] });
    ensureDirectories(cfg);
    const holder = new DatabaseHolder({ config: cfg, logger: null });
    assert.equal(holder.isInitialized, false);
    assert.equal(holder.open(), null, '不存在的库 open 应保持未初始化');
    assert.equal(holder.state, 'no-db');

    const first = holder.initialize();
    assert.equal(first.created, true);
    assert.equal(first.schema_version, LATEST_SCHEMA_VERSION);
    assert.equal(holder.isInitialized, true);
    assert.equal(holder.status().db, 'ok');
    assert.deepEqual(holder.counts().memories, 0);

    const identity = holder.db.prepare('SELECT * FROM identity').all();
    assert.equal(identity.length, 1);
    assert.equal(identity[0].display_name, '我');
    const cognition = holder.db.prepare('SELECT * FROM cognition WHERE singleton = 1').get();
    assert.ok(cognition);
    assert.equal(cognition.mode, 'idle');
    assert.equal(cognition.note, '模拟状态，不代表主观感受');

    const second = holder.initialize();
    assert.equal(second.created, false, '已存在的库再次 init 不得重建');
    assert.equal(holder.db.prepare('SELECT count(*) c FROM identity').get().c, 1);
    holder.close();
    assert.equal(holder.state, 'closed');

    // 重新打开已初始化库
    const holder2 = new DatabaseHolder({ config: cfg, logger: null });
    holder2.open();
    assert.equal(holder2.isInitialized, true);
    assert.equal(holder2.schemaVersion, LATEST_SCHEMA_VERSION);
    holder2.close();
  } finally {
    cleanupHome(home2);
  }
});

test('损坏数据库：holder.open 进入 error 状态并抛 DATABASE_ERROR（不静默重建）', () => {
  const home3 = makeHome('db-corrupt');
  try {
    const cfg = resolveConfig({ argv: ['init', `--fca-home=${home3}`] });
    ensureDirectories(cfg);
    fs.writeFileSync(cfg.paths.db, 'this is definitely not a sqlite database file, just garbage bytes');
    const holder = new DatabaseHolder({ config: cfg, logger: null });
    assert.throws(
      () => holder.open(),
      (err) => err instanceof ApiError && err.code === 'DATABASE_ERROR',
    );
    assert.equal(holder.isInitialized, false);
    assert.equal(holder.state, 'error');
    assert.equal(holder.status().db, 'error');
    holder.close();
  } finally {
    cleanupHome(home3);
  }
});
