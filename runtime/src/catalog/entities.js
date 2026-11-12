// FCA Local Runtime — 实体服务（人物/项目/地点/概念/组织）
import { newId } from '../core/ids.js';
import { nowIso } from '../core/time.js';
import { validationFailed, notFound, versionConflict, duplicate, badRequest } from '../core/errors.js';

export const ENTITY_KINDS = Object.freeze(['person', 'project', 'place', 'concept', 'organization', 'other']);
const ENTITY_KIND_SET = new Set(ENTITY_KINDS);
const MAX_NAME = 200;
const MAX_DESCRIPTION = 20_000;
const MAX_ALIASES = 64;
const MAX_METADATA_BYTES = 64 * 1024;

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function createEntityService({ dbHolder, events, logger }) {
  function presentEntity(row) {
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      description: row.description ?? '',
      aliases: parseJson(row.aliases, []),
      metadata: parseJson(row.metadata, {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
      version: Number(row.version),
      deleted_at: row.deleted_at ?? null,
    };
  }

  function getRow(db, id) {
    return db.prepare('SELECT * FROM entities WHERE id = ?').get(id) ?? null;
  }

  function get(id, { include_deleted = true } = {}) {
    const db = dbHolder.requireDb();
    const row = getRow(db, id);
    if (!row) throw notFound(`实体不存在：${id}`);
    if (row.deleted_at && !include_deleted) throw notFound(`实体已删除：${id}`);
    return presentEntity(row);
  }

  function findRowByKindName(db, kind, name) {
    return db
      .prepare('SELECT * FROM entities WHERE kind = ? AND name = ? AND deleted_at IS NULL')
      .get(kind, name) ?? null;
  }

  function validateCreate(input, fieldPrefix = '') {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('实体必须是 JSON 对象');
    const errors = [];
    const kind = input.kind ?? 'concept';
    if (!ENTITY_KIND_SET.has(kind)) errors.push({ field: 'kind', message: `必须是 ${ENTITY_KINDS.join('|')}` });
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) errors.push({ field: 'name', message: '实体名称必填' });
    else if (name.length > MAX_NAME) errors.push({ field: 'name', message: `名称不得超过 ${MAX_NAME} 字符` });
    const description = input.description === undefined || input.description === null ? '' : String(input.description);
    if (description.length > MAX_DESCRIPTION) errors.push({ field: 'description', message: `描述不得超过 ${MAX_DESCRIPTION} 字符` });
    let aliases = [];
    if (input.aliases !== undefined && input.aliases !== null) {
      if (!Array.isArray(input.aliases)) errors.push({ field: 'aliases', message: '必须是字符串数组' });
      else {
        aliases = input.aliases.map((a) => String(a).trim()).filter(Boolean);
        if (aliases.length > MAX_ALIASES) errors.push({ field: 'aliases', message: `别名不得超过 ${MAX_ALIASES} 个` });
      }
    }
    const metadata = input.metadata === undefined || input.metadata === null ? {} : input.metadata;
    if (typeof metadata !== 'object' || Array.isArray(metadata)) errors.push({ field: 'metadata', message: '必须是 JSON 对象' });
    else if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > MAX_METADATA_BYTES) {
      errors.push({ field: 'metadata', message: `metadata 超过 ${MAX_METADATA_BYTES} 字节` });
    }
    if (errors.length) throw validationFailed(errors);
    return { kind, name, description, aliases, metadata };
  }

  /** 事务内创建实体（自动去重：kind+name 已存在则复用）。 */
  function ensureTx(db, ref, { defaultKind = 'concept', meta, createIfMissing = true } = {}) {
    if (ref === null || ref === undefined) return null;
    let id = null;
    let name = '';
    let kind = defaultKind;
    let description = '';
    let aliases = [];
    let metadata = {};
    if (typeof ref === 'string') {
      const trimmed = ref.trim();
      if (!trimmed) throw validationFailed([{ field: 'entity', message: '实体名称不能为空' }]);
      if (/^ent_[0-9a-f]{32}$/.test(trimmed)) id = trimmed;
      else name = trimmed;
    } else if (typeof ref === 'object' && !Array.isArray(ref)) {
      id = typeof ref.entity_id === 'string' ? ref.entity_id : typeof ref.id === 'string' ? ref.id : null;
      name = typeof ref.name === 'string' ? ref.name.trim() : '';
      if (typeof ref.kind === 'string' && ENTITY_KIND_SET.has(ref.kind)) kind = ref.kind;
      description = typeof ref.description === 'string' ? ref.description : '';
      if (Array.isArray(ref.aliases)) aliases = ref.aliases.map(String);
      if (ref.metadata && typeof ref.metadata === 'object') metadata = ref.metadata;
    } else {
      throw validationFailed([{ field: 'entity', message: '实体引用必须是字符串或对象' }]);
    }

    if (id) {
      const row = getRow(db, id);
      if (!row) throw validationFailed([{ field: 'entity_id', message: `实体不存在：${id}` }]);
      if (row.deleted_at) {
        db.prepare('UPDATE entities SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(nowIso(), id);
      }
      return { entity: presentEntity(getRow(db, id)), created: false, event: null };
    }
    if (!name) throw validationFailed([{ field: 'entity.name', message: '实体名称必填' }]);
    if (name.length > MAX_NAME) throw validationFailed([{ field: 'entity.name', message: `名称不得超过 ${MAX_NAME} 字符` }]);
    const existing = findRowByKindName(db, kind, name);
    if (existing) return { entity: presentEntity(existing), created: false, event: null };
    if (!createIfMissing) return null;
    const now = nowIso();
    const newEntityId = newId('entity');
    db.prepare(
      `INSERT INTO entities(id, kind, name, description, aliases, metadata, created_at, updated_at, version)
       VALUES(?,?,?,?,?,?,?,?,1)`,
    ).run(newEntityId, kind, name, description, JSON.stringify(aliases), JSON.stringify(metadata), now, now);
    const row = getRow(db, newEntityId);
    const prepared = events
      ? events.prepare(
          db,
          {
            type: 'entity.created',
            actor: meta?.actor,
            source: meta?.source,
            subject: { kind: 'entity', id: newEntityId },
            payload: { kind, name, auto_created: true },
            trace_id: meta?.traceId,
          },
          {},
        )
      : null;
    return { entity: presentEntity(row), created: true, event: prepared?.event ?? null };
  }

  function create(input, meta = {}) {
    const db = dbHolder.requireDb();
    const fields = validateCreate(input);
    const db2 = db;
    const result = (() => {
      db2.exec('BEGIN IMMEDIATE');
      try {
        const existing = findRowByKindName(db2, fields.kind, fields.name);
        if (existing) {
          db2.exec('ROLLBACK');
          throw duplicate(existing.id, `同类型同名称实体已存在：${fields.name}`);
        }
        const now = nowIso();
        const id = newId('entity');
        db2.prepare(
          `INSERT INTO entities(id, kind, name, description, aliases, metadata, created_at, updated_at, version)
           VALUES(?,?,?,?,?,?,?,?,1)`,
        ).run(id, fields.kind, fields.name, fields.description, JSON.stringify(fields.aliases), JSON.stringify(fields.metadata), now, now);
        const prepared = events.prepare(
          db2,
          {
            type: 'entity.created',
            actor: meta.actor,
            source: meta.source,
            subject: { kind: 'entity', id },
            payload: { kind: fields.kind, name: fields.name },
            trace_id: meta.traceId,
          },
          {},
        );
        db2.exec('COMMIT');
        return { entity: presentEntity(getRow(db2, id)), event: prepared.event };
      } catch (err) {
        try {
          db2.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw err;
      }
    })();
    events.publish(result.event);
    return result.entity;
  }

  function patch(id, input, meta = {}) {
    const db = dbHolder.requireDb();
    const row = getRow(db, id);
    if (!row || row.deleted_at) throw notFound(`实体不存在或已删除：${id}`);
    if (input && typeof input === 'object' && input.expected_version !== undefined) {
      const expected = Number(input.expected_version);
      if (!Number.isInteger(expected) || expected < 1) {
        throw validationFailed([{ field: 'expected_version', message: '必须是正整数' }]);
      }
      if (expected !== Number(row.version)) throw versionConflict(Number(row.version));
    }
    const current = presentEntity(row);
    const errors = [];
    const next = { ...current };
    if (input.kind !== undefined) {
      if (!ENTITY_KIND_SET.has(input.kind)) errors.push({ field: 'kind', message: `必须是 ${ENTITY_KINDS.join('|')}` });
      else next.kind = input.kind;
    }
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name) errors.push({ field: 'name', message: '实体名称必填' });
      else if (name.length > MAX_NAME) errors.push({ field: 'name', message: `名称不得超过 ${MAX_NAME} 字符` });
      else next.name = name;
    }
    if (input.description !== undefined) {
      const d = String(input.description);
      if (d.length > MAX_DESCRIPTION) errors.push({ field: 'description', message: `描述不得超过 ${MAX_DESCRIPTION} 字符` });
      else next.description = d;
    }
    if (input.aliases !== undefined) {
      if (!Array.isArray(input.aliases)) errors.push({ field: 'aliases', message: '必须是字符串数组' });
      else next.aliases = input.aliases.map(String);
    }
    if (input.metadata !== undefined) {
      if (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata)) {
        errors.push({ field: 'metadata', message: '必须是 JSON 对象' });
      } else next.metadata = input.metadata;
    }
    if (errors.length) throw validationFailed(errors);
    const conflict = db
      .prepare('SELECT id FROM entities WHERE kind = ? AND name = ? AND deleted_at IS NULL AND id != ?')
      .get(next.kind, next.name, id);
    if (conflict) throw duplicate(conflict.id, `同类型同名称实体已存在：${next.name}`);
    const now = nowIso();
    const version = Number(row.version) + 1;
    db.exec('BEGIN IMMEDIATE');
    let prepared;
    try {
      db.prepare(
        `UPDATE entities SET kind=?, name=?, description=?, aliases=?, metadata=?, updated_at=?, version=? WHERE id=?`,
      ).run(
        next.kind,
        next.name,
        next.description,
        JSON.stringify(next.aliases),
        JSON.stringify(next.metadata),
        now,
        version,
        id,
      );
      prepared = events.prepare(
        db,
        {
          type: 'entity.updated',
          actor: meta.actor,
          source: meta.source,
          subject: { kind: 'entity', id },
          payload: { version, changed_fields: Object.keys(input).filter((k) => k !== 'expected_version') },
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
    return presentEntity(getRow(db, id));
  }

  function remove(id, meta = {}) {
    const db = dbHolder.requireDb();
    const row = getRow(db, id);
    if (!row) throw notFound(`实体不存在：${id}`);
    if (row.deleted_at) return presentEntity(row); // 幂等
    const now = nowIso();
    const version = Number(row.version) + 1;
    db.exec('BEGIN IMMEDIATE');
    let prepared;
    try {
      db.prepare('UPDATE entities SET deleted_at=?, updated_at=?, version=? WHERE id=?').run(now, now, version, id);
      prepared = events.prepare(
        db,
        {
          type: 'entity.deleted',
          actor: meta.actor,
          source: meta.source,
          subject: { kind: 'entity', id },
          payload: { version, soft: true },
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
    return presentEntity(getRow(db, id));
  }

  function list({ kind = null, q = null, include_deleted = false, limit = 50, cursor = null } = {}) {
    const db = dbHolder.requireDb();
    const parsedLimit = Math.min(500, Math.max(1, Number(limit) || 50));
    let offset = 0;
    if (cursor) {
      try {
        offset = Number(JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')).o);
        if (!Number.isInteger(offset) || offset < 0) throw new Error('bad cursor');
      } catch {
        throw badRequest('cursor 不合法');
      }
    }
    const where = [];
    const params = [];
    if (!include_deleted) where.push('deleted_at IS NULL');
    if (kind) {
      where.push('kind = ?');
      params.push(kind);
    }
    if (q) {
      where.push('(name LIKE ? OR aliases LIKE ? OR description LIKE ?)');
      const like = `%${String(q).replace(/[%_]/g, (m) => `\\${m}`)}%`;
      params.push(like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(db.prepare(`SELECT count(*) c FROM entities ${whereSql}`).get(...params)?.c ?? 0);
    const rows = db
      .prepare(`SELECT * FROM entities ${whereSql} ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`)
      .all(...params, parsedLimit, offset);
    const nextOffset = offset + rows.length;
    return {
      items: rows.map(presentEntity),
      next_cursor: nextOffset < total ? Buffer.from(JSON.stringify({ o: nextOffset }), 'utf8').toString('base64url') : null,
      total,
    };
  }

  /** 记忆响应里参与者的 entity 名称解析（允许已软删实体仍显示历史名称）。 */
  function namesByIds(db, ids) {
    const map = new Map();
    if (!ids.length) return map;
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, name, kind, deleted_at FROM entities WHERE id IN (${placeholders})`).all(...ids);
    for (const row of rows) map.set(row.id, row);
    return map;
  }

  return { create, get, patch, remove, list, ensureTx, presentEntity, namesByIds, getRow, ENTITY_KINDS };
}
