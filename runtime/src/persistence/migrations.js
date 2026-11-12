// FCA Local Runtime — schema 迁移（schema_migrations + PRAGMA user_version，契约 §8）
import { getUserVersion, tableExists, withTransaction, setMeta, getMeta } from './db.js';

export const LATEST_SCHEMA_VERSION = 1;

const MIGRATION_1_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  memory_type TEXT NOT NULL,
  occurred_at TEXT,
  occurred_precision TEXT NOT NULL DEFAULT 'unknown',
  occurred_end_at TEXT,
  source_type TEXT NOT NULL DEFAULT 'user',
  source_ref TEXT,
  source_note TEXT,
  credibility REAL NOT NULL DEFAULT 0.5,
  importance REAL NOT NULL DEFAULT 0.5,
  display_weight REAL NOT NULL DEFAULT 1.0,
  origin TEXT NOT NULL DEFAULT 'user',
  agent_generated INTEGER NOT NULL DEFAULT 0,
  demo INTEGER NOT NULL DEFAULT 0,
  created_by_kind TEXT NOT NULL DEFAULT 'user',
  created_by_id TEXT NOT NULL DEFAULT 'local',
  updated_by_kind TEXT NOT NULL DEFAULT 'user',
  updated_by_id TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_deleted ON memories(deleted_at);
CREATE INDEX IF NOT EXISTS idx_memories_occurred ON memories(occurred_at);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);
CREATE INDEX IF NOT EXISTS idx_memories_demo ON memories(demo);

CREATE TABLE IF NOT EXISTS hard_deleted_memories (
  id TEXT PRIMARY KEY,
  title TEXT,
  deleted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_active_name ON tags(name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag_id);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  aliases TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_active_kind_name ON entities(kind, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);

CREATE TABLE IF NOT EXISTS memory_participants (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'participant',
  PRIMARY KEY (memory_id, entity_id, role)
);
CREATE INDEX IF NOT EXISTS idx_memory_participants_entity ON memory_participants(entity_id);

CREATE TABLE IF NOT EXISTS memory_project (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_memory_project_entity ON memory_project(entity_id);

CREATE TABLE IF NOT EXISTS memory_emotion (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  valence REAL,
  arousal REAL,
  label TEXT
);

CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY,
  from_kind TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_kind TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  directed INTEGER NOT NULL DEFAULT 1,
  label TEXT,
  evidence TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  source_type TEXT NOT NULL DEFAULT 'user',
  source_ref TEXT,
  source_note TEXT,
  weight REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_kind, from_id);
CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_kind, to_id);
CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(relation_type);
CREATE INDEX IF NOT EXISTS idx_relations_deleted ON relations(deleted_at);

CREATE TABLE IF NOT EXISTS memory_versions (
  ver_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  change_kind TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  diff TEXT NOT NULL DEFAULT '[]',
  actor_kind TEXT,
  actor_id TEXT,
  source_event_id TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_mem_ver ON memory_versions(memory_id, version);
CREATE INDEX IF NOT EXISTS idx_versions_mem ON memory_versions(memory_id, created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  schema_version TEXT NOT NULL,
  type TEXT NOT NULL,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  source TEXT NOT NULL,
  subject TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  trace_id TEXT,
  client_event_id TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS layout_nodes (
  node_kind TEXT NOT NULL,
  node_id TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  z REAL NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  cluster_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (node_kind, node_id)
);
CREATE INDEX IF NOT EXISTS idx_layout_cluster ON layout_nodes(cluster_id);

CREATE TABLE IF NOT EXISTS layout_views (
  view_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  camera TEXT NOT NULL DEFAULT '{}',
  layer_config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_layout_views_name ON layout_views(name);

CREATE TABLE IF NOT EXISTS identity (
  identity_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  values_json TEXT NOT NULL DEFAULT '[]',
  preferences_json TEXT NOT NULL DEFAULT '{}',
  boundaries_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cognition (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  focus TEXT NOT NULL DEFAULT '',
  attention_targets TEXT NOT NULL DEFAULT '[]',
  working_memory TEXT NOT NULL DEFAULT '[]',
  mood_json TEXT,
  mode TEXT NOT NULL DEFAULT 'idle',
  note TEXT NOT NULL DEFAULT '模拟状态，不代表主观感受',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  dim INTEGER NOT NULL,
  model TEXT NOT NULL,
  vec BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_providers (
  provider_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'openai-compatible',
  base_url TEXT,
  model TEXT,
  api_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_providers_name ON llm_providers(name);

CREATE TABLE IF NOT EXISTS llm_queue (
  queue_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  request TEXT NOT NULL,
  result TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_queue_status ON llm_queue(status);
`;

/** 逐版本迁移定义。after(db) 用于无法放在单个 SQL 字符串里的对象（如 FTS5 虚拟表）。 */
export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial-schema',
    sql: MIGRATION_1_SQL,
    after(db) {
      // FTS5 中文索引表（tokenize 由写入端预分词保证）
      if (!tableExists(db, 'memory_fts')) {
        db.exec(
          "CREATE VIRTUAL TABLE memory_fts USING fts5(memory_id UNINDEXED, title, body, tags, tokenize='unicode61')",
        );
      }
    },
  },
];

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

/**
 * 应用所有待执行迁移。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{logger?: object, beforeMigrate?: (fromVersion:number, toVersion:number) => any, dryRun?: boolean}} [options]
 * @returns {{from:number,to:number,applied:Array<{version:number,name:string}>}}
 */
export function applyMigrations(db, { logger, beforeMigrate, dryRun = false } = {}) {
  ensureMigrationsTable(db);
  const from = getUserVersion(db);
  if (from > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `数据库 schema 版本 ${from} 高于 Runtime 支持的版本 ${LATEST_SCHEMA_VERSION}，请升级 Runtime（拒绝降级）。`,
    );
  }
  if (from === LATEST_SCHEMA_VERSION) return { from, to: from, applied: [] };
  const pending = MIGRATIONS.filter((m) => m.version > from).sort((a, b) => a.version - b.version);
  if (dryRun) return { from, to: LATEST_SCHEMA_VERSION, applied: pending.map((m) => ({ version: m.version, name: m.name })) };
  if (from > 0 && beforeMigrate) {
    try {
      beforeMigrate(from, LATEST_SCHEMA_VERSION);
    } catch (err) {
      logger?.error?.('迁移前自动备份失败，继续迁移（建议手动备份）', { error: err.message });
    }
  }
  const applied = [];
  for (const migration of pending) {
    withTransaction(db, () => {
      if (migration.sql) db.exec(migration.sql);
      if (typeof migration.after === 'function') migration.after(db);
      db.prepare('INSERT OR REPLACE INTO schema_migrations(version, name, applied_at) VALUES(?,?,?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      db.exec(`PRAGMA user_version = ${Number(migration.version)}`);
    });
    applied.push({ version: migration.version, name: migration.name });
    logger?.info?.('数据库迁移完成', { version: migration.version, name: migration.name });
  }
  const now = new Date().toISOString();
  setMeta(db, 'schema_version', String(LATEST_SCHEMA_VERSION));
  if (!getMeta(db, 'initialized_at')) setMeta(db, 'initialized_at', now);
  return { from, to: LATEST_SCHEMA_VERSION, applied };
}

export function getMigrationState(db) {
  const userVersion = getUserVersion(db);
  let rows = [];
  if (tableExists(db, 'schema_migrations')) {
    rows = db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all();
  }
  return { user_version: userVersion, schema_version: LATEST_SCHEMA_VERSION, items: rows };
}
