// FCA Local Runtime — 事件存储（契约 §6）：SQLite 事件表 + JSONL 双写 + SSE 广播 + client_event_id 幂等
import fs from 'node:fs';
import path from 'node:path';
import { newId } from '../core/ids.js';
import { nowIso, toIso } from '../core/time.js';
import { PRODUCT_VERSION, EVENT_SCHEMA_VERSION } from '../config/index.js';
import { validationFailed, badRequest } from '../core/errors.js';

export const EVENT_TYPES = Object.freeze([
  // memory
  'memory.created',
  'memory.updated',
  'memory.deleted',
  'memory.restored',
  'memory.merged',
  'memory.split',
  'memory.imported',
  // relation
  'relation.created',
  'relation.updated',
  'relation.deleted',
  // entity
  'entity.created',
  'entity.updated',
  'entity.deleted',
  // layout
  'layout.updated',
  'layout.recomputed',
  'layout.view.saved',
  // identity / cognition
  'identity.updated',
  'cognition.updated',
  // backup / restore
  'backup.created',
  'backup.deleted',
  'restore.completed',
  // db
  'db.initialized',
  'db.migrated',
  'db.vacuumed',
  // llm
  'llm.request.queued',
  'llm.request.sent',
  'llm.request.failed',
  'llm.request.completed',
  // agent / system
  'agent.event_received',
  'system.started',
  'system.stopped',
  'system.client.connected',
  'system.client.disconnected',
  'system.error',
]);

export const EVENT_TYPE_SET = new Set(EVENT_TYPES);
export const ACTOR_KINDS = Object.freeze(['user', 'agent', 'system', 'plugin']);
export const CLIENT_KINDS = Object.freeze(['desktop', 'dsh-plugin', 'cli', 'test']);
const CLIENT_KIND_SET = new Set(CLIENT_KINDS);
const MAX_CLIENT_EVENT_ID = 200;
const MAX_PAYLOAD_BYTES = 256 * 1024;

function parseJsonSafe(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function normalizeActor(actor) {
  const base = actor && typeof actor === 'object' ? actor : {};
  const kind = base.kind ?? 'user';
  if (!ACTOR_KINDS.includes(kind)) {
    throw validationFailed([{ field: 'actor.kind', message: `必须是 ${ACTOR_KINDS.join('|')}` }]);
  }
  return {
    kind,
    id: base.id === undefined || base.id === null ? 'local' : String(base.id).slice(0, 200),
    display: base.display === undefined || base.display === null ? defaultActorDisplay(kind) : String(base.display).slice(0, 200),
  };
}

function defaultActorDisplay(kind) {
  switch (kind) {
    case 'agent':
      return 'Agent';
    case 'system':
      return '系统';
    case 'plugin':
      return '插件';
    default:
      return '用户';
  }
}

function normalizeSource(source, defaultClientKind = 'cli') {
  const base = source && typeof source === 'object' ? source : {};
  const kind = base.kind ?? defaultClientKind;
  if (!CLIENT_KIND_SET.has(kind)) {
    throw validationFailed([{ field: 'source.kind', message: `必须是 ${CLIENT_KINDS.join('|')}` }]);
  }
  return {
    kind,
    id: base.id === undefined || base.id === null ? `${kind}-main` : String(base.id).slice(0, 200),
    version: base.version === undefined || base.version === null ? PRODUCT_VERSION : String(base.version).slice(0, 60),
  };
}

function normalizeSubject(subject, type) {
  if (subject === undefined || subject === null) {
    return { kind: String(type).split('.')[0], id: null };
  }
  if (typeof subject !== 'object' || Array.isArray(subject)) {
    throw validationFailed([{ field: 'subject', message: '必须是对象 {kind, id}' }]);
  }
  return {
    kind: subject.kind === undefined || subject.kind === null ? String(type).split('.')[0] : String(subject.kind).slice(0, 60),
    id: subject.id === undefined || subject.id === null ? null : String(subject.id).slice(0, 120),
  };
}

/**
 * 把外部事件输入规范化为契约 Event 结构（不含 seq）。
 * @param {object} input
 * @param {{traceId?:string, clientKind?:string, actorKind?:string}} [context]
 */
export function normalizeEventInput(input, context = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('事件必须是 JSON 对象');
  }
  const type = input.type;
  if (typeof type !== 'string' || !EVENT_TYPE_SET.has(type)) {
    throw validationFailed(
      [{ field: 'type', message: `未知事件类型；允许值见契约 §6（${EVENT_TYPES.length} 种）` }],
      '事件类型不合法',
    );
  }
  const actor = normalizeActor(input.actor ?? { kind: context.actorKind ?? 'user', id: 'local' });
  const source = normalizeSource(input.source, context.clientKind ?? 'cli');
  const subject = normalizeSubject(input.subject, type);
  const payload = input.payload ?? {};
  if (payload !== null && (typeof payload !== 'object' || Array.isArray(payload))) {
    throw validationFailed([{ field: 'payload', message: '必须是 JSON 对象' }]);
  }
  let payloadJson = JSON.stringify(payload ?? {});
  if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw validationFailed([{ field: 'payload', message: `payload 超过 ${MAX_PAYLOAD_BYTES} 字节` }]);
  }
  let clientEventId = null;
  if (input.client_event_id !== undefined && input.client_event_id !== null && input.client_event_id !== '') {
    if (typeof input.client_event_id !== 'string' || input.client_event_id.length > MAX_CLIENT_EVENT_ID) {
      throw validationFailed([{ field: 'client_event_id', message: `必须是不超过 ${MAX_CLIENT_EVENT_ID} 字符的字符串` }]);
    }
    clientEventId = input.client_event_id;
  }
  const ts = toIso(input.ts) ?? nowIso();
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    id: newId('event'),
    type,
    ts,
    actor,
    source,
    subject,
    payload: payload ?? {},
    trace_id: input.trace_id ?? context.traceId ?? null,
    client_event_id: clientEventId,
  };
}

function rowToEvent(row) {
  if (!row) return null;
  return {
    schema_version: row.schema_version,
    id: row.id,
    seq: Number(row.seq),
    type: row.type,
    ts: row.ts,
    actor: parseJsonSafe(row.actor, {}),
    source: parseJsonSafe(row.source, {}),
    subject: parseJsonSafe(row.subject, null),
    payload: parseJsonSafe(row.payload, {}),
    trace_id: row.trace_id ?? null,
    client_event_id: row.client_event_id ?? null,
  };
}

/**
 * 事件存储。dbHolder 可在 restore 后替换连接；hub 可后置 attach（CLI 离线模式无 SSE）。
 */
export function createEventStore({ dbHolder, config, logger }) {
  let hub = null;
  let jsonlWriteFailures = 0;

  function setHub(nextHub) {
    hub = nextHub;
  }

  function appendJsonl(event) {
    try {
      const month = event.ts.slice(0, 7);
      const dir = config.paths.eventsDir;
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `events-${month}.jsonl`), `${JSON.stringify(event)}\n`, 'utf8');
    } catch (err) {
      jsonlWriteFailures += 1;
      logger?.warn?.('事件 JSONL 追加失败（SQLite 事件仍有效）', { error: err.message, event_id: event.id });
    }
  }

  /** 在调用方事务内插入事件（不写 JSONL、不广播），返回完整 Event。 */
  function prepare(db, input, context = {}) {
    const normalized = normalizeEventInput(input, context);
    if (normalized.client_event_id) {
      const existing = db
        .prepare('SELECT * FROM events WHERE client_event_id = ?')
        .get(normalized.client_event_id);
      if (existing) {
        return { event: rowToEvent(existing), duplicate: true };
      }
    }
    try {
      const info = db
        .prepare(
          `INSERT INTO events(id, schema_version, type, ts, actor, source, subject, payload, trace_id, client_event_id)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          normalized.id,
          normalized.schema_version,
          normalized.type,
          normalized.ts,
          JSON.stringify(normalized.actor),
          JSON.stringify(normalized.source),
          JSON.stringify(normalized.subject),
          JSON.stringify(normalized.payload),
          normalized.trace_id,
          normalized.client_event_id,
        );
      const seq = Number(info.lastInsertRowid);
      return { event: { ...normalized, seq }, duplicate: false };
    } catch (err) {
      // 并发写入同一 client_event_id：唯一约束冲突 → 返回已存在事件（幂等）
      if (normalized.client_event_id && /UNIQUE|constraint/i.test(String(err.message ?? ''))) {
        const existing = db.prepare('SELECT * FROM events WHERE client_event_id = ?').get(normalized.client_event_id);
        if (existing) return { event: rowToEvent(existing), duplicate: true };
      }
      throw err;
    }
  }

  /** 发布已插入事件（JSONL + SSE）。必须在事务 COMMIT 之后调用。 */
  function publish(events) {
    const list = Array.isArray(events) ? events : [events];
    for (const event of list) {
      if (!event) continue;
      appendJsonl(event);
      try {
        hub?.broadcast?.(event);
      } catch (err) {
        logger?.warn?.('SSE 广播失败', { error: err.message });
      }
    }
    return list;
  }

  /** 非事务场景便捷方法：插入 + 发布。 */
  function emit(input, context = {}) {
    const db = dbHolder.requireDb();
    const db2 = db;
    const prepared = prepare(db2, input, context);
    if (!prepared.duplicate) publish(prepared.event);
    return prepared;
  }

  function getBySeq(seq) {
    const db = dbHolder.requireDb();
    return rowToEvent(db.prepare('SELECT * FROM events WHERE seq = ?').get(Number(seq)));
  }

  function getById(id) {
    const db = dbHolder.requireDb();
    return rowToEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(id));
  }

  function findByClientEventId(clientEventId) {
    const db = dbHolder.requireDb();
    return rowToEvent(db.prepare('SELECT * FROM events WHERE client_event_id = ?').get(clientEventId));
  }

  /** 补发：seq 之后的事件（最多 limit 条）。 */
  function listAfterSeq(afterSeq, { limit = 5000 } = {}) {
    const db = dbHolder.requireDb();
    const rows = db
      .prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?')
      .all(Number(afterSeq) || 0, Number(limit) || 5000);
    return rows.map(rowToEvent);
  }

  function bounds() {
    const db = dbHolder.requireDb();
    const row = db.prepare('SELECT min(seq) min_seq, max(seq) max_seq, count(*) count FROM events').get();
    return {
      min_seq: row?.min_seq == null ? null : Number(row.min_seq),
      max_seq: row?.max_seq == null ? null : Number(row.max_seq),
      count: Number(row?.count ?? 0),
    };
  }

  function maxSeq() {
    const db = dbHolder.requireDb();
    const row = db.prepare('SELECT max(seq) max_seq FROM events').get();
    return row?.max_seq == null ? 0 : Number(row.max_seq);
  }

  function count() {
    const db = dbHolder.requireDb();
    return Number(db.prepare('SELECT count(*) c FROM events').get()?.c ?? 0);
  }

  function stats() {
    return { count: count(), jsonl_write_failures: jsonlWriteFailures };
  }

  return {
    setHub,
    prepare,
    publish,
    emit,
    getBySeq,
    getById,
    findByClientEventId,
    listAfterSeq,
    bounds,
    maxSeq,
    count,
    stats,
    appendJsonl,
  };
}
