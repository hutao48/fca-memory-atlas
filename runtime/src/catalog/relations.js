// FCA Local Runtime — 关系服务（独立数据实体；删除关系不删除两端对象）
import { newId } from '../core/ids.js';
import { nowIso, toIso } from '../core/time.js';
import {
  validationFailed,
  notFound,
  versionConflict,
  badRequest,
  gone,
} from '../core/errors.js';

export const RELATION_TYPES = Object.freeze([
  'temporal_before',
  'temporal_after',
  'participates_in',
  'shared_experience',
  'knowledge_link',
  'causal',
  'derived_from',
  'belongs_to_project',
  'emotional_link',
  'custom',
]);
const RELATION_TYPE_SET = new Set(RELATION_TYPES);
export const NODE_KINDS = Object.freeze(['memory', 'entity']);
const NODE_KIND_SET = new Set(NODE_KINDS);
export const SOURCE_TYPES = Object.freeze(['user', 'agent', 'system', 'external', 'inference', 'import']);
const SOURCE_TYPE_SET = new Set(SOURCE_TYPES);
export const AUTO_LINK_SOURCE_REF = 'auto:memory-links';
const AUTO_SPLIT_SOURCE_REF = 'auto:memory-split';
const MAX_LABEL = 1000;
const MAX_EVIDENCE = 2000;

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function createRelationService({ dbHolder, events, logger }) {
  function presentRelation(row) {
    if (!row) return null;
    return {
      id: row.id,
      from: { kind: row.from_kind, id: row.from_id },
      to: { kind: row.to_kind, id: row.to_id },
      relation_type: row.relation_type,
      directed: Boolean(row.directed),
      label: row.label ?? null,
      evidence: row.evidence ?? null,
      confidence: Number(row.confidence),
      source: { type: row.source_type, ref: row.source_ref ?? null, note: row.source_note ?? null },
      weight: Number(row.weight),
      created_at: row.created_at,
      updated_at: row.updated_at,
      version: Number(row.version),
      deleted_at: row.deleted_at ?? null,
    };
  }

  function getRow(db, id) {
    return db.prepare('SELECT * FROM relations WHERE id = ?').get(id) ?? null;
  }

  function nodeExists(db, kind, id) {
    if (!NODE_KIND_SET.has(kind)) return { ok: false, reason: 'kind' };
    if (kind === 'memory') {
      const tombstone = db.prepare('SELECT id FROM hard_deleted_memories WHERE id = ?').get(id);
      if (tombstone) return { ok: false, reason: 'hard_deleted' };
      const row = db.prepare('SELECT id, deleted_at FROM memories WHERE id = ?').get(id);
      if (!row) return { ok: false, reason: 'missing' };
      if (row.deleted_at) return { ok: false, reason: 'deleted' };
      return { ok: true };
    }
    const row = db.prepare('SELECT id, deleted_at FROM entities WHERE id = ?').get(id);
    if (!row) return { ok: false, reason: 'missing' };
    if (row.deleted_at) return { ok: false, reason: 'deleted' };
    return { ok: true };
  }

  function normalizeEndpoint(input, field) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw validationFailed([{ field, message: '必须是 {kind, id} 对象' }]);
    }
    const kind = input.kind ?? (typeof input.id === 'string' && input.id.startsWith('mem_') ? 'memory' : 'entity');
    const id = input.id ?? input.node_id ?? input.entity_id ?? input.memory_id;
    if (!NODE_KIND_SET.has(kind)) throw validationFailed([{ field: `${field}.kind`, message: `必须是 ${NODE_KINDS.join('|')}` }]);
    if (typeof id !== 'string' || !id) throw validationFailed([{ field: `${field}.id`, message: '缺少节点 ID' }]);
    return { kind, id };
  }

  function normalizeSource(source) {
    if (source === undefined || source === null) return { type: 'user', ref: null, note: null };
    if (typeof source === 'string') {
      if (!SOURCE_TYPE_SET.has(source)) throw validationFailed([{ field: 'source.type', message: `必须是 ${SOURCE_TYPES.join('|')}` }]);
      return { type: source, ref: null, note: null };
    }
    if (typeof source !== 'object' || Array.isArray(source)) throw validationFailed([{ field: 'source', message: '必须是对象' }]);
    const type = source.type ?? 'user';
    if (!SOURCE_TYPE_SET.has(type)) throw validationFailed([{ field: 'source.type', message: `必须是 ${SOURCE_TYPES.join('|')}` }]);
    return {
      type,
      ref: source.ref == null ? null : String(source.ref).slice(0, 500),
      note: source.note == null ? null : String(source.note).slice(0, MAX_EVIDENCE),
    };
  }

  function validateCreateInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('关系必须是 JSON 对象');
    const errors = [];
    const from = normalizeEndpoint(input.from, 'from');
    const to = normalizeEndpoint(input.to, 'to');
    const relationType = input.relation_type ?? 'custom';
    if (!RELATION_TYPE_SET.has(relationType)) {
      errors.push({ field: 'relation_type', message: `必须是 ${RELATION_TYPES.join('|')}` });
    }
    let directed = true;
    if (input.directed !== undefined) {
      if (typeof input.directed !== 'boolean') errors.push({ field: 'directed', message: '必须是布尔值' });
      else directed = input.directed;
    }
    const label = input.label == null ? null : String(input.label);
    if (label && label.length > MAX_LABEL) errors.push({ field: 'label', message: `label 不得超过 ${MAX_LABEL} 字符` });
    const evidence = input.evidence == null ? null : String(input.evidence);
    if (evidence && evidence.length > MAX_EVIDENCE) errors.push({ field: 'evidence', message: `evidence 不得超过 ${MAX_EVIDENCE} 字符` });
    let confidence = 0.5;
    if (input.confidence !== undefined && input.confidence !== null) {
      const n = Number(input.confidence);
      if (!Number.isFinite(n) || n < 0 || n > 1) errors.push({ field: 'confidence', message: '必须在 0..1 之间' });
      else confidence = n;
    }
    let weight = 1.0;
    if (input.weight !== undefined && input.weight !== null) {
      const n = Number(input.weight);
      if (!Number.isFinite(n) || n < 0) errors.push({ field: 'weight', message: '必须是非负数' });
      else weight = n;
    }
    const source = normalizeSource(input.source);
    if (errors.length) throw validationFailed(errors);
    return { from, to, relationType, directed, label, evidence, confidence, weight, source };
  }

  function assertEndpoints(db, from, to) {
    const fromCheck = nodeExists(db, from.kind, from.id);
    if (!fromCheck.ok) {
      if (fromCheck.reason === 'hard_deleted') throw gone(`from 节点已被硬删除：${from.id}`);
      throw notFound(`from 节点不存在或已删除：${from.id}`);
    }
    const toCheck = nodeExists(db, to.kind, to.id);
    if (!toCheck.ok) {
      if (toCheck.reason === 'hard_deleted') throw gone(`to 节点已被硬删除：${to.id}`);
      throw notFound(`to 节点不存在或已删除：${to.id}`);
    }
  }

  /** 事务内创建关系。 */
  function createTx(db, input, meta = {}, { sourceRefOverride = null } = {}) {
    const fields = validateCreateInput(input);
    assertEndpoints(db, fields.from, fields.to);
    const now = nowIso();
    const id = newId('relation');
    db.prepare(
      `INSERT INTO relations(id, from_kind, from_id, to_kind, to_id, relation_type, directed, label, evidence,
        confidence, source_type, source_ref, source_note, weight, created_at, updated_at, version)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
    ).run(
      id,
      fields.from.kind,
      fields.from.id,
      fields.to.kind,
      fields.to.id,
      fields.relationType,
      fields.directed ? 1 : 0,
      fields.label,
      fields.evidence,
      fields.confidence,
      fields.source.type,
      sourceRefOverride ?? fields.source.ref,
      fields.source.note,
      fields.weight,
      now,
      now,
    );
    const row = getRow(db, id);
    const prepared = events.prepare(
      db,
      {
        type: 'relation.created',
        actor: meta.actor,
        source: meta.source,
        subject: { kind: 'relation', id },
        payload: {
          relation_type: fields.relationType,
          from: fields.from,
          to: fields.to,
          auto: Boolean(sourceRefOverride),
        },
        trace_id: meta.traceId,
      },
      {},
    );
    return { relation: presentRelation(row), event: prepared.event };
  }

  function create(input, meta = {}) {
    const db = dbHolder.requireDb();
    let created;
    db.exec('BEGIN IMMEDIATE');
    try {
      created = createTx(db, input, meta);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    events.publish(created.event);
    return created.relation;
  }

  function patch(id, input, meta = {}) {
    const db = dbHolder.requireDb();
    const row = getRow(db, id);
    if (!row || row.deleted_at) throw notFound(`关系不存在或已删除：${id}`);
    if (input && typeof input === 'object' && input.expected_version !== undefined) {
      const expected = Number(input.expected_version);
      if (!Number.isInteger(expected) || expected < 1) throw validationFailed([{ field: 'expected_version', message: '必须是正整数' }]);
      if (expected !== Number(row.version)) throw versionConflict(Number(row.version));
    }
    const errors = [];
    const next = {
      relation_type: row.relation_type,
      directed: Boolean(row.directed),
      label: row.label,
      evidence: row.evidence,
      confidence: Number(row.confidence),
      weight: Number(row.weight),
      source_type: row.source_type,
      source_ref: row.source_ref,
      source_note: row.source_note,
    };
    const changed = [];
    if (input.relation_type !== undefined) {
      if (!RELATION_TYPE_SET.has(input.relation_type)) errors.push({ field: 'relation_type', message: '不合法' });
      else {
        next.relation_type = input.relation_type;
        changed.push('relation_type');
      }
    }
    if (input.directed !== undefined) {
      if (typeof input.directed !== 'boolean') errors.push({ field: 'directed', message: '必须是布尔值' });
      else {
        next.directed = input.directed;
        changed.push('directed');
      }
    }
    if (input.label !== undefined) {
      next.label = input.label == null ? null : String(input.label);
      changed.push('label');
    }
    if (input.evidence !== undefined) {
      next.evidence = input.evidence == null ? null : String(input.evidence);
      changed.push('evidence');
    }
    if (input.confidence !== undefined) {
      const n = Number(input.confidence);
      if (!Number.isFinite(n) || n < 0 || n > 1) errors.push({ field: 'confidence', message: '必须在 0..1 之间' });
      else {
        next.confidence = n;
        changed.push('confidence');
      }
    }
    if (input.weight !== undefined) {
      const n = Number(input.weight);
      if (!Number.isFinite(n) || n < 0) errors.push({ field: 'weight', message: '必须是非负数' });
      else {
        next.weight = n;
        changed.push('weight');
      }
    }
    if (input.source !== undefined) {
      const s = normalizeSource(input.source);
      next.source_type = s.type;
      next.source_ref = s.ref;
      next.source_note = s.note;
      changed.push('source');
    }
    if (input.from !== undefined || input.to !== undefined) {
      const from = input.from !== undefined ? normalizeEndpoint(input.from, 'from') : { kind: row.from_kind, id: row.from_id };
      const to = input.to !== undefined ? normalizeEndpoint(input.to, 'to') : { kind: row.to_kind, id: row.to_id };
      assertEndpoints(db, from, to);
      Object.assign(next, { from_kind: from.kind, from_id: from.id, to_kind: to.kind, to_id: to.id });
      changed.push('endpoints');
    }
    if (errors.length) throw validationFailed(errors);
    const now = nowIso();
    const version = Number(row.version) + 1;
    db.exec('BEGIN IMMEDIATE');
    let prepared;
    try {
      db.prepare(
        `UPDATE relations SET from_kind=?, from_id=?, to_kind=?, to_id=?, relation_type=?, directed=?, label=?, evidence=?,
          confidence=?, source_type=?, source_ref=?, source_note=?, weight=?, updated_at=?, version=? WHERE id=?`,
      ).run(
        next.from_kind ?? row.from_kind,
        next.from_id ?? row.from_id,
        next.to_kind ?? row.to_kind,
        next.to_id ?? row.to_id,
        next.relation_type,
        next.directed ? 1 : 0,
        next.label,
        next.evidence,
        next.confidence,
        next.source_type,
        next.source_ref,
        next.source_note,
        next.weight,
        now,
        version,
        id,
      );
      prepared = events.prepare(
        db,
        {
          type: 'relation.updated',
          actor: meta.actor,
          source: meta.source,
          subject: { kind: 'relation', id },
          payload: { version, changed_fields: changed },
          trace_id: meta.traceId,
        },
        {},
      );
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    events.publish(prepared.event);
    return presentRelation(getRow(db, id));
  }

  function remove(id, meta = {}) {
    const db = dbHolder.requireDb();
    const row = getRow(db, id);
    if (!row) throw notFound(`关系不存在：${id}`);
    if (row.deleted_at) return presentRelation(row); // 幂等
    const now = nowIso();
    const version = Number(row.version) + 1;
    db.exec('BEGIN IMMEDIATE');
    let prepared;
    try {
      db.prepare('UPDATE relations SET deleted_at=?, updated_at=?, version=? WHERE id=?').run(now, now, version, id);
      prepared = events.prepare(
        db,
        {
          type: 'relation.deleted',
          actor: meta.actor,
          source: meta.source,
          subject: { kind: 'relation', id },
          payload: { version, soft: true, endpoints_deleted: false },
          trace_id: meta.traceId,
        },
        {},
      );
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    events.publish(prepared.event);
    return presentRelation(getRow(db, id));
  }

  function get(id, { include_deleted = true } = {}) {
    const db = dbHolder.requireDb();
    const row = getRow(db, id);
    if (!row) throw notFound(`关系不存在：${id}`);
    if (row.deleted_at && !include_deleted) throw notFound(`关系已删除：${id}`);
    return presentRelation(row);
  }

  function list({ node_kind = null, node_id = null, relation_type = null, include_deleted = false, limit = 50, cursor = null } = {}) {
    const db = dbHolder.requireDb();
    const parsedLimit = Math.min(500, Math.max(1, Number(limit) || 50));
    let offset = 0;
    if (cursor) {
      try {
        offset = Number(JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')).o);
        if (!Number.isInteger(offset) || offset < 0) throw new Error('bad');
      } catch {
        throw badRequest('cursor 不合法');
      }
    }
    const where = [];
    const params = [];
    if (!include_deleted) where.push('deleted_at IS NULL');
    if (node_id) {
      if (!NODE_KIND_SET.has(node_kind ?? 'memory') && !NODE_KIND_SET.has(node_kind ?? 'entity')) {
        throw validationFailed([{ field: 'node_kind', message: `必须是 ${NODE_KINDS.join('|')}` }]);
      }
      if (node_kind) {
        where.push('((from_kind = ? AND from_id = ?) OR (to_kind = ? AND to_id = ?))');
        params.push(node_kind, node_id, node_kind, node_id);
      } else {
        where.push('(from_id = ? OR to_id = ?)');
        params.push(node_id, node_id);
      }
    } else if (node_kind) {
      if (!NODE_KIND_SET.has(node_kind)) throw validationFailed([{ field: 'node_kind', message: `必须是 ${NODE_KINDS.join('|')}` }]);
      where.push('(from_kind = ? OR to_kind = ?)');
      params.push(node_kind, node_kind);
    }
    if (relation_type) {
      if (!RELATION_TYPE_SET.has(relation_type)) {
        throw validationFailed([{ field: 'relation_type', message: `必须是 ${RELATION_TYPES.join('|')}` }]);
      }
      where.push('relation_type = ?');
      params.push(relation_type);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(db.prepare(`SELECT count(*) c FROM relations ${whereSql}`).get(...params)?.c ?? 0);
    const rows = db
      .prepare(`SELECT * FROM relations ${whereSql} ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`)
      .all(...params, parsedLimit, offset);
    const nextOffset = offset + rows.length;
    return {
      items: rows.map(presentRelation),
      next_cursor: nextOffset < total ? Buffer.from(JSON.stringify({ o: nextOffset }), 'utf8').toString('base64url') : null,
      total,
    };
  }

  /** 与某条记忆直接相连的关系（排除已删关系）。 */
  function forMemory(db, memoryId, { include_deleted = false } = {}) {
    const where = ["((from_kind = 'memory' AND from_id = ?) OR (to_kind = 'memory' AND to_id = ?))"];
    const params = [memoryId, memoryId];
    if (!include_deleted) where.push('deleted_at IS NULL');
    return db
      .prepare(`SELECT * FROM relations WHERE ${where.join(' AND ')} ORDER BY created_at ASC`)
      .all(...params)
      .map(presentRelation);
  }

  function findAutoLink(db, { fromKind, fromId, toKind, toId, relationType }) {
    return (
      db
        .prepare(
          `SELECT * FROM relations WHERE source_ref = ? AND from_kind=? AND from_id=? AND to_kind=? AND to_id=? AND relation_type=?`,
        )
        .get(AUTO_LINK_SOURCE_REF, fromKind, fromId, toKind, toId, relationType) ?? null
    );
  }

  /**
   * 同步记忆的参与者/项目派生关系（事务内）。返回需发布的事件。
   * 用户显式删除过的派生关系不会被自动复活（只补缺失的行）。
   */
  function syncAutoLinksTx(db, memoryId, { participantEntityIds = [], projectEntityId = null }, meta = {}) {
    const eventsOut = [];
    const desired = [];
    const seen = new Set();
    for (const entityId of participantEntityIds) {
      if (!entityId || seen.has(`p:${entityId}`)) continue;
      seen.add(`p:${entityId}`);
      desired.push({ fromKind: 'entity', fromId: entityId, toKind: 'memory', toId: memoryId, relationType: 'participates_in', label: '参与' });
    }
    if (projectEntityId && !seen.has(`j:${projectEntityId}`)) {
      seen.add(`j:${projectEntityId}`);
      desired.push({ fromKind: 'memory', fromId: memoryId, toKind: 'entity', toId: projectEntityId, relationType: 'belongs_to_project', label: '属于项目' });
    }
    const desiredKeys = new Set(desired.map((d) => `${d.fromKind}:${d.fromId}:${d.toKind}:${d.toId}:${d.relationType}`));
    const existingAuto = db
      .prepare(
        `SELECT * FROM relations WHERE source_ref = ? AND ((from_kind='memory' AND from_id=?) OR (to_kind='memory' AND to_id=?))`,
      )
      .all(AUTO_LINK_SOURCE_REF, memoryId, memoryId);
    // 1) 删除不再需要的 active 派生关系
    for (const row of existingAuto) {
      const key = `${row.from_kind}:${row.from_id}:${row.to_kind}:${row.to_id}:${row.relation_type}`;
      if (row.deleted_at || desiredKeys.has(key)) continue;
      const now = nowIso();
      db.prepare('UPDATE relations SET deleted_at=?, updated_at=?, version=version+1 WHERE id=?').run(now, now, row.id);
      const prepared = events.prepare(
        db,
        {
          type: 'relation.deleted',
          actor: meta.actor,
          source: meta.source,
          subject: { kind: 'relation', id: row.id },
          payload: { soft: true, auto_removed: true },
          trace_id: meta.traceId,
        },
        {},
      );
      eventsOut.push(prepared.event);
    }
    // 2) 补齐缺失的派生关系（已存在但被用户删除的保持删除状态）
    for (const link of desired) {
      const found = findAutoLink(db, link);
      if (found) continue;
      try {
        const created = createTx(
          db,
          {
            from: { kind: link.fromKind, id: link.fromId },
            to: { kind: link.toKind, id: link.toId },
            relation_type: link.relationType,
            label: link.label,
            evidence: '系统根据记忆参与者/项目自动建立',
            confidence: 1.0,
            source: { type: 'system', ref: null, note: 'auto-linked' },
            weight: 1.0,
            directed: true,
          },
          meta,
          { sourceRefOverride: AUTO_LINK_SOURCE_REF },
        );
        eventsOut.push(created.event);
      } catch (err) {
        logger?.warn?.('自动派生关系创建失败', { memory_id: memoryId, error: err.message });
      }
    }
    return eventsOut;
  }

  /** 硬删除记忆/实体时软删其全部关联关系（事务内），返回事件。 */
  function removeAllForNodeTx(db, kind, id, meta = {}) {
    const rows = db
      .prepare('SELECT * FROM relations WHERE deleted_at IS NULL AND ((from_kind=? AND from_id=?) OR (to_kind=? AND to_id=?))')
      .all(kind, id, kind, id);
    const eventsOut = [];
    for (const row of rows) {
      const now = nowIso();
      db.prepare('UPDATE relations SET deleted_at=?, updated_at=?, version=version+1 WHERE id=?').run(now, now, row.id);
      const prepared = events.prepare(
        db,
        {
          type: 'relation.deleted',
          actor: meta.actor,
          source: meta.source,
          subject: { kind: 'relation', id: row.id },
          payload: { soft: true, endpoint_hard_deleted: true },
          trace_id: meta.traceId,
        },
        {},
      );
      eventsOut.push(prepared.event);
    }
    return eventsOut;
  }

  return {
    create,
    createTx,
    patch,
    remove,
    get,
    list,
    forMemory,
    presentRelation,
    syncAutoLinksTx,
    removeAllForNodeTx,
    getRow,
    RELATION_TYPES,
  };
}
