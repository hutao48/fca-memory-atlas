// FCA Local Runtime — 记忆 CRUD / 版本历史 / diff / 合并 / 拆分 / 软删 / 恢复 / 乐观并发
import { newId } from '../core/ids.js';
import { nowIso } from '../core/time.js';
import { diffJson } from '../core/json-patch.js';
import {
  badRequest,
  validationFailed,
  notFound,
  gone,
  forbidden,
  versionConflict,
  internal,
} from '../core/errors.js';
import { bumpLayoutVersion } from '../persistence/db.js';
import { normalizeCreateInput, normalizePatchInput, validateExpectedVersion, MEMORY_TYPE_SET } from './validate.js';
import { buildMemoryFilterSql } from './filters.js';
import { presentMemory, memoryRef, presentVersion, presentLayoutNode } from './present.js';
import { indexMemory, removeMemoryIndex, rebuildFulltextIndex } from './fulltext.js';
import { upsertEmbedding, removeEmbedding, rebuildEmbeddings } from './semantic.js';

const MAX_MERGE_SOURCES = 50;
const MAX_SPLIT_PARTS = 50;
const MERGE_STRATEGIES = new Set(['keep_target', 'prepend_sources']);
const MAX_VERSIONS_PAGE = 500;

function parseCursor(cursor, field = 'cursor') {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    const offset = Number(parsed.o);
    if (!Number.isInteger(offset) || offset < 0) throw new Error('bad');
    return offset;
  } catch {
    throw badRequest(`${field} 不合法`);
  }
}

function makeCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

export function createMemoryService({ dbHolder, events, logger, config, tags, entities, relations }) {
  function db() {
    return dbHolder.requireDb();
  }

  function getRow(d, id) {
    return d.prepare('SELECT * FROM memories WHERE id = ?').get(id) ?? null;
  }

  function isTombstoned(d, id) {
    return Boolean(d.prepare('SELECT id FROM hard_deleted_memories WHERE id = ?').get(id));
  }

  /** 读取记忆行；支持软删（默认返回）与硬删（GONE）。 */
  function rowOrThrow(d, id, { allowDeleted = true } = {}) {
    const row = getRow(d, id);
    if (!row) {
      if (isTombstoned(d, id)) throw gone(`记忆已被硬删除：${id}`);
      throw notFound(`记忆不存在：${id}`);
    }
    if (row.deleted_at && !allowDeleted) throw notFound(`记忆已删除，请先恢复：${id}`);
    return row;
  }

  function writeVersionTx(d, { memoryId, version, changeKind, snapshot, diff = [], meta = {}, sourceEventId = null }) {
    const verId = newId('version');
    d.prepare(
      `INSERT INTO memory_versions(ver_id, memory_id, version, change_kind, snapshot, diff, actor_kind, actor_id, source_event_id, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      verId,
      memoryId,
      version,
      changeKind,
      JSON.stringify(snapshot),
      JSON.stringify(diff),
      meta.actor?.kind ?? 'system',
      meta.actor?.id ?? 'runtime',
      sourceEventId,
      nowIso(),
    );
    return verId;
  }

  /** 索引一条记忆（全文 + 语义 embedding），事务内调用。 */
  function reindexTx(d, memoryId) {
    const row = getRow(d, memoryId);
    if (!row) return;
    const tagNames = d
      .prepare(
        `SELECT t.name FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.memory_id = ? AND t.deleted_at IS NULL ORDER BY t.name`,
      )
      .all(memoryId)
      .map((r) => r.name);
    indexMemory(d, memoryId, { title: row.title, body: row.body, tagNames });
    upsertEmbedding(d, memoryId, { title: row.title, body: row.body, tagNames });
  }

  /** 根据 memory_participants / memory_project 同步派生关系，事务内调用。 */
  function syncAutoLinksTx(d, memoryId, meta) {
    const participantIds = d
      .prepare('SELECT entity_id FROM memory_participants WHERE memory_id = ?')
      .all(memoryId)
      .map((r) => r.entity_id);
    const project = d.prepare('SELECT entity_id FROM memory_project WHERE memory_id = ?').get(memoryId);
    return relations.syncAutoLinksTx(d, memoryId, {
      participantEntityIds: participantIds,
      projectEntityId: project?.entity_id ?? null,
    }, meta);
  }

  /**
   * 事务内插入记忆本体 + 标签/参与者/项目/情绪 + 索引。
   * @returns {{memoryId: string, events: object[]}}
   */
  function insertMemoryTx(d, normalized, meta) {
    const now = nowIso();
    const memoryId = newId('memory');
    d.prepare(
      `INSERT INTO memories(id, title, body, memory_type, occurred_at, occurred_precision, occurred_end_at,
        source_type, source_ref, source_note, credibility, importance, display_weight, origin, agent_generated, demo,
        created_by_kind, created_by_id, updated_by_kind, updated_by_id, created_at, updated_at, version, deleted_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NULL)`,
    ).run(
      memoryId,
      normalized.title,
      normalized.body,
      normalized.memory_type,
      normalized.occurred_at,
      normalized.occurred_precision,
      normalized.occurred_end_at,
      normalized.source.type,
      normalized.source.ref,
      normalized.source.note,
      normalized.credibility,
      normalized.importance,
      normalized.display_weight,
      normalized.origin,
      normalized.agent_generated ? 1 : 0,
      normalized.demo ? 1 : 0,
      meta.actor?.kind ?? 'user',
      meta.actor?.id ?? 'local',
      meta.actor?.kind ?? 'user',
      meta.actor?.id ?? 'local',
      now,
      now,
    );
    const outEvents = [];
    const tagRows = tags.ensureManyTx(d, normalized.tags);
    tags.attachToMemoryTx(d, memoryId, tagRows);
    const insertParticipant = d.prepare('INSERT OR IGNORE INTO memory_participants(memory_id, entity_id, role) VALUES(?,?,?)');
    for (const participant of normalized.participants) {
      const ensured = entities.ensureTx(
        d,
        participant.entity_id ? { entity_id: participant.entity_id } : { name: participant.name, kind: 'person' },
        { defaultKind: 'person', meta },
      );
      if (ensured.event) outEvents.push(ensured.event);
      insertParticipant.run(memoryId, ensured.entity.id, participant.role);
    }
    if (normalized.project) {
      const ensured = entities.ensureTx(
        d,
        normalized.project.id ? { entity_id: normalized.project.id } : { name: normalized.project.name, kind: 'project' },
        { defaultKind: 'project', meta },
      );
      if (ensured.event) outEvents.push(ensured.event);
      d.prepare('INSERT OR REPLACE INTO memory_project(memory_id, entity_id) VALUES(?,?)').run(memoryId, ensured.entity.id);
    }
    if (normalized.emotion) {
      d.prepare('INSERT OR REPLACE INTO memory_emotion(memory_id, valence, arousal, label) VALUES(?,?,?,?)').run(
        memoryId,
        normalized.emotion.valence,
        normalized.emotion.arousal,
        normalized.emotion.label,
      );
    }
    reindexTx(d, memoryId);
    return { memoryId, events: outEvents };
  }

  function create(input, meta = {}) {
    const normalized = normalizeCreateInput(input, { meta, allowDemo: meta.allowDemo === true });
    const d = db();
    const outEvents = [];
    let created;
    d.exec('BEGIN IMMEDIATE');
    try {
      const inserted = insertMemoryTx(d, normalized, meta);
      outEvents.push(...inserted.events);
      const prepared = events.prepare(
        d,
        {
          type: 'memory.created',
          actor: meta.actor,
          source: meta.source,
          subject: { kind: 'memory', id: inserted.memoryId },
          payload: {
            memory_id: inserted.memoryId,
            title: normalized.title,
            memory_type: normalized.memory_type,
            source_type: normalized.source.type,
            agent_generated: normalized.agent_generated,
            demo: normalized.demo,
            origin: normalized.origin,
          },
          trace_id: meta.traceId,
        },
        {},
      );
      outEvents.push(prepared.event);
      const snapshot = presentMemory(d, getRow(d, inserted.memoryId));
      writeVersionTx(d, {
        memoryId: inserted.memoryId,
        version: 1,
        changeKind: 'create',
        snapshot,
        diff: [],
        meta,
        sourceEventId: prepared.event.id,
      });
      outEvents.push(...syncAutoLinksTx(d, inserted.memoryId, meta));
      d.exec('COMMIT');
      created = presentMemory(d, getRow(d, inserted.memoryId));
    } catch (err) {
      try {
        d.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    events.publish(outEvents);
    return created;
  }

  function patch(id, input, meta = {}) {
    const fields = normalizePatchInput(input, { meta });
    const expected = fields.expected_version;
    delete fields.expected_version;
    const d = db();
    const outEvents = [];
    let memory;
    d.exec('BEGIN IMMEDIATE');
    try {
      const row = rowOrThrow(d, id, { allowDeleted: false });
      if (expected !== undefined && expected !== Number(row.version)) throw versionConflict(Number(row.version));
      const before = presentMemory(d, row);
      const now = nowIso();
      const version = Number(row.version) + 1;
      const sets = [];
      const values = [];
      const set = (column, value) => {
        sets.push(`${column}=?`);
        values.push(value);
      };
      if (fields.title !== undefined) set('title', fields.title);
      if (fields.body !== undefined) set('body', fields.body);
      if (fields.memory_type !== undefined) set('memory_type', fields.memory_type);
      if (fields.occurred_at !== undefined) set('occurred_at', fields.occurred_at);
      if (fields.occurred_precision !== undefined) set('occurred_precision', fields.occurred_precision);
      if (fields.occurred_end_at !== undefined) set('occurred_end_at', fields.occurred_end_at);
      if (fields.occurred_at !== undefined && fields.occurred_at === null) {
        if (fields.occurred_end_at === undefined) set('occurred_end_at', null);
        if (fields.occurred_precision === undefined) set('occurred_precision', 'unknown');
      }
      if (fields.source !== undefined) {
        set('source_type', fields.source.type);
        set('source_ref', fields.source.ref);
        set('source_note', fields.source.note);
      }
      if (fields.credibility !== undefined) set('credibility', fields.credibility);
      if (fields.importance !== undefined) set('importance', fields.importance);
      if (fields.display_weight !== undefined) set('display_weight', fields.display_weight);
      if (fields.origin !== undefined) set('origin', fields.origin);
      if (fields.agent_generated !== undefined) set('agent_generated', fields.agent_generated ? 1 : 0);
      set('updated_at', now);
      set('updated_by_kind', meta.actor?.kind ?? 'user');
      set('updated_by_id', meta.actor?.id ?? 'local');
      set('version', version);
      d.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);

      let structureChanged = false;
      if (fields.tags !== undefined) {
        const tagRows = tags.ensureManyTx(d, fields.tags);
        tags.attachToMemoryTx(d, id, tagRows);
        structureChanged = true;
      }
      if (fields.participants !== undefined) {
        d.prepare('DELETE FROM memory_participants WHERE memory_id = ?').run(id);
        const insertParticipant = d.prepare('INSERT OR IGNORE INTO memory_participants(memory_id, entity_id, role) VALUES(?,?,?)');
        for (const participant of fields.participants) {
          const ensured = entities.ensureTx(
            d,
            participant.entity_id ? { entity_id: participant.entity_id } : { name: participant.name, kind: 'person' },
            { defaultKind: 'person', meta },
          );
          if (ensured.event) outEvents.push(ensured.event);
          insertParticipant.run(id, ensured.entity.id, participant.role);
        }
        structureChanged = true;
      }
      if (fields.project !== undefined) {
        d.prepare('DELETE FROM memory_project WHERE memory_id = ?').run(id);
        if (fields.project) {
          const ensured = entities.ensureTx(
            d,
            fields.project.id ? { entity_id: fields.project.id } : { name: fields.project.name, kind: 'project' },
            { defaultKind: 'project', meta },
          );
          if (ensured.event) outEvents.push(ensured.event);
          d.prepare('INSERT OR REPLACE INTO memory_project(memory_id, entity_id) VALUES(?,?)').run(id, ensured.entity.id);
        }
        structureChanged = true;
      }
      if (fields.emotion !== undefined) {
        d.prepare('DELETE FROM memory_emotion WHERE memory_id = ?').run(id);
        if (fields.emotion) {
          d.prepare('INSERT OR REPLACE INTO memory_emotion(memory_id, valence, arousal, label) VALUES(?,?,?,?)').run(
            id,
            fields.emotion.valence,
            fields.emotion.arousal,
            fields.emotion.label,
          );
        }
      }
      reindexTx(d, id);
      const after = presentMemory(d, getRow(d, id));
      const diff = diffJson(before, after);
      const changedFields = Object.keys(fields);
      const prepared = events.prepare(
        d,
        {
          type: 'memory.updated',
          actor: meta.actor,
          source: meta.source,
          subject: { kind: 'memory', id },
          payload: { memory_id: id, version, changed_fields: changedFields },
          trace_id: meta.traceId,
        },
        {},
      );
      outEvents.push(prepared.event);
      writeVersionTx(d, {
        memoryId: id,
        version,
        changeKind: 'update',
        snapshot: after,
        diff,
        meta,
        sourceEventId: prepared.event.id,
      });
      if (structureChanged) outEvents.push(...syncAutoLinksTx(d, id, meta));
      d.exec('COMMIT');
      memory = after;
    } catch (err) {
      try {
        d.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    events.publish(outEvents);
    return memory;
  }

  function get(id, { version = null, include_deleted = false, include_relations = true } = {}) {
    const d = db();
    const row = rowOrThrow(d, id, { allowDeleted: true });
    let snapshotRow = row;
    if (version !== null && version !== undefined && version !== '') {
      const wanted = Number(version);
      if (!Number.isInteger(wanted) || wanted < 1) throw validationFailed([{ field: 'version', message: '必须是正整数' }]);
      const ver = d.prepare('SELECT * FROM memory_versions WHERE memory_id = ? AND version = ?').get(id, wanted);
      if (!ver) throw notFound(`记忆 ${id} 不存在版本 ${wanted}`);
      const snapshot = (() => {
        try {
          return JSON.parse(ver.snapshot);
        } catch {
          return null;
        }
      })();
      if (!snapshot) throw internal(`版本 ${wanted} 快照损坏`);
      return {
        memory: snapshot,
        relations: include_relations ? relations.forMemory(d, id, { include_deleted }) : [],
        layout: presentLayoutNode(
          d.prepare("SELECT * FROM layout_nodes WHERE node_kind = 'memory' AND node_id = ?").get(id),
        ),
        versions_count: Number(d.prepare('SELECT count(*) c FROM memory_versions WHERE memory_id = ?').get(id)?.c ?? 0),
        version_view: wanted,
      };
    }
    const resolved = presentMemory(d, snapshotRow);
    return {
      memory: resolved,
      relations: include_relations ? relations.forMemory(d, id, { include_deleted }) : [],
      layout: presentLayoutNode(d.prepare("SELECT * FROM layout_nodes WHERE node_kind = 'memory' AND node_id = ?").get(id)),
      versions_count: Number(d.prepare('SELECT count(*) c FROM memory_versions WHERE memory_id = ?').get(id)?.c ?? 0),
    };
  }

  function presentWithRelations(id) {
    const d = db();
    const row = rowOrThrow(d, id, { allowDeleted: true });
    return { memory: presentMemory(d, row) };
  }

  function remove(id, { hard = false, confirm = false } = {}, meta = {}) {
    const d = db();
    const outEvents = [];
    let result;
    if (hard) {
      if (!confirm) throw forbidden('硬删除需要显式授权：query 参数 hard=true&confirm=true');
      if ((meta.actor?.kind ?? 'user') !== 'user') throw forbidden('硬删除仅限用户显式授权操作');
      d.exec('BEGIN IMMEDIATE');
      try {
        const row = rowOrThrow(d, id, { allowDeleted: true });
        const version = Number(row.version) + 1;
        removeMemoryIndex(d, id);
        removeEmbedding(d, id);
        d.prepare('INSERT OR REPLACE INTO hard_deleted_memories(id, title, deleted_at) VALUES(?,?,?)').run(id, row.title, nowIso());
        d.prepare("DELETE FROM layout_nodes WHERE node_kind = 'memory' AND node_id = ?").run(id);
        const relationEvents = relations.removeAllForNodeTx(d, 'memory', id, meta);
        outEvents.push(...relationEvents);
        d.prepare('DELETE FROM memory_versions WHERE memory_id = ?').run(id);
        d.prepare('DELETE FROM memories WHERE id = ?').run(id);
        bumpLayoutVersion(d);
        const prepared = events.prepare(
          d,
          {
            type: 'memory.deleted',
            actor: meta.actor,
            source: meta.source,
            subject: { kind: 'memory', id },
            payload: {
              memory_id: id,
              version,
              hard: true,
              soft: false,
              relations_deleted: relationEvents.length,
            },
            trace_id: meta.traceId,
          },
          {},
        );
        outEvents.push(prepared.event);
        d.exec('COMMIT');
        result = { id, hard: true, deleted_at: nowIso(), version };
      } catch (err) {
        try {
          d.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw err;
      }
      events.publish(outEvents);
      return result;
    }
    d.exec('BEGIN IMMEDIATE');
    try {
      const row = rowOrThrow(d, id, { allowDeleted: true });
      if (row.deleted_at) {
        d.exec('COMMIT');
        const memory = presentMemory(d, getRow(d, id));
        events.publish([]);
        return { memory, already_deleted: true };
      }
      const now = nowIso();
      const version = Number(row.version) + 1;
      d.prepare('UPDATE memories SET deleted_at=?, updated_at=?, version=?, updated_by_kind=?, updated_by_id=? WHERE id=?').run(
        now,
        now,
        version,
        meta.actor?.kind ?? 'user',
        meta.actor?.id ?? 'local',
        id,
      );
      const snapshot = presentMemory(d, getRow(d, id));
      const prepared = events.prepare(
        d,
        {
          type: 'memory.deleted',
          actor: meta.actor,
          source: meta.source,
          subject: { kind: 'memory', id },
          payload: { memory_id: id, version, soft: true, hard: false },
          trace_id: meta.traceId,
        },
        {},
      );
      outEvents.push(prepared.event);
      writeVersionTx(d, {
        memoryId: id,
        version,
        changeKind: 'delete',
        snapshot,
        diff: diffJson(presentMemory(d, row), snapshot),
        meta,
        sourceEventId: prepared.event.id,
      });
      d.exec('COMMIT');
      result = { memory: snapshot, already_deleted: false };
    } catch (err) {
      try {
        d.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    events.publish(outEvents);
    return result;
  }

  function restore(id, meta = {}) {
    const d = db();
    const outEvents = [];
    let memory;
    d.exec('BEGIN IMMEDIATE');
    try {
      if (isTombstoned(d, id)) throw gone(`记忆已被硬删除，无法恢复：${id}`);
      const row = rowOrThrow(d, id, { allowDeleted: true });
      if (!row.deleted_at) {
        d.exec('COMMIT');
        return presentMemory(d, row);
      }
      const now = nowIso();
      const version = Number(row.version) + 1;
      d.prepare('UPDATE memories SET deleted_at=NULL, updated_at=?, version=?, updated_by_kind=?, updated_by_id=? WHERE id=?').run(
        now,
        version,
        meta.actor?.kind ?? 'user',
        meta.actor?.id ?? 'local',
        id,
      );
      const snapshot = presentMemory(d, getRow(d, id));
      const prepared = events.prepare(
        d,
        {
          type: 'memory.restored',
          actor: meta.actor,
          source: meta.source,
          subject: { kind: 'memory', id },
          payload: { memory_id: id, version },
          trace_id: meta.traceId,
        },
        {},
      );
      outEvents.push(prepared.event);
      writeVersionTx(d, {
        memoryId: id,
        version,
        changeKind: 'restore',
        snapshot,
        diff: [],
        meta,
        sourceEventId: prepared.event.id,
      });
      d.exec('COMMIT');
      memory = snapshot;
    } catch (err) {
      try {
        d.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    events.publish(outEvents);
    return memory;
  }

  function merge(urlTargetId, input, meta = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('merge body 必须是 JSON 对象');
    const targetId = input.target_id ?? urlTargetId;
    if (input.target_id && urlTargetId && input.target_id !== urlTargetId) {
      throw badRequest('target_id 与 URL 中的记忆 ID 不一致');
    }
    const sourceIds = Array.isArray(input.source_ids) ? [...new Set(input.source_ids.map(String))] : null;
    if (!sourceIds || sourceIds.length === 0) throw validationFailed([{ field: 'source_ids', message: '必须是非空数组' }]);
    if (sourceIds.length > MAX_MERGE_SOURCES) throw validationFailed([{ field: 'source_ids', message: `不得超过 ${MAX_MERGE_SOURCES} 条` }]);
    if (sourceIds.includes(targetId)) throw validationFailed([{ field: 'source_ids', message: '不能包含 target_id 自身' }]);
    const strategy = input.strategy ?? 'keep_target';
    if (!MERGE_STRATEGIES.has(strategy)) {
      throw validationFailed([{ field: 'strategy', message: '必须是 keep_target|prepend_sources' }]);
    }
    const d = db();
    const outEvents = [];
    let result;
    d.exec('BEGIN IMMEDIATE');
    try {
      const target = rowOrThrow(d, targetId, { allowDeleted: false });
      if (input.expected_version !== undefined) {
        validateExpectedVersion(target, { expected_version: Number(input.expected_version) });
        if (Number(input.expected_version) !== Number(target.version)) throw versionConflict(Number(target.version));
      }
      const sources = sourceIds.map((sid) => rowOrThrow(d, sid, { allowDeleted: false }));
      const before = presentMemory(d, target);
      const now = nowIso();
      const version = Number(target.version) + 1;
      let body = target.body ?? '';
      if (strategy === 'prepend_sources') {
        const parts = [...sources.map((s) => s.body ?? '').filter((b) => b.trim()), body].filter((b) => b.trim());
        body = parts.join('\n\n');
      }
      const importance = Math.max(Number(target.importance), ...sources.map((s) => Number(s.importance)));
      const displayWeight = Math.max(Number(target.display_weight), ...sources.map((s) => Number(s.display_weight)));
      d.prepare(
        'UPDATE memories SET body=?, importance=?, display_weight=?, updated_at=?, updated_by_kind=?, updated_by_id=?, version=? WHERE id=?',
      ).run(body, importance, displayWeight, now, meta.actor?.kind ?? 'user', meta.actor?.id ?? 'local', version, targetId);
      // 标签并集
      const tagIds = new Set();
      for (const memId of [targetId, ...sourceIds]) {
        for (const row of d.prepare('SELECT tag_id FROM memory_tags WHERE memory_id = ?').all(memId)) tagIds.add(row.tag_id);
      }
      const insertTag = d.prepare('INSERT OR IGNORE INTO memory_tags(memory_id, tag_id) VALUES(?,?)');
      for (const tagId of tagIds) insertTag.run(targetId, tagId);
      // 参与者并集
      const participantRows = [];
      const seenParticipant = new Set();
      for (const memId of [targetId, ...sourceIds]) {
        for (const row of d.prepare('SELECT entity_id, role FROM memory_participants WHERE memory_id = ?').all(memId)) {
          const key = `${row.entity_id}:${row.role}`;
          if (seenParticipant.has(key)) continue;
          seenParticipant.add(key);
          participantRows.push(row);
        }
      }
      d.prepare('DELETE FROM memory_participants WHERE memory_id = ?').run(targetId);
      const insertParticipant = d.prepare('INSERT OR IGNORE INTO memory_participants(memory_id, entity_id, role) VALUES(?,?,?)');
      for (const row of participantRows) insertParticipant.run(targetId, row.entity_id, row.role);
      // 项目/情绪：target 优先，否则取第一个有值的 source
      if (!d.prepare('SELECT entity_id FROM memory_project WHERE memory_id = ?').get(targetId)) {
        for (const sid of sourceIds) {
          const proj = d.prepare('SELECT entity_id FROM memory_project WHERE memory_id = ?').get(sid);
          if (proj) {
            d.prepare('INSERT OR REPLACE INTO memory_project(memory_id, entity_id) VALUES(?,?)').run(targetId, proj.entity_id);
            break;
          }
        }
      }
      if (!d.prepare('SELECT memory_id FROM memory_emotion WHERE memory_id = ?').get(targetId)) {
        for (const sid of sourceIds) {
          const emo = d.prepare('SELECT valence, arousal, label FROM memory_emotion WHERE memory_id = ?').get(sid);
          if (emo) {
            d.prepare('INSERT OR REPLACE INTO memory_emotion(memory_id, valence, arousal, label) VALUES(?,?,?,?)').run(
              targetId,
              emo.valence,
              emo.arousal,
              emo.label,
            );
            break;
          }
        }
      }
      reindexTx(d, targetId);
      const after = presentMemory(d, getRow(d, targetId));
      const prepared = events.prepare(
        d,
        {
          type: 'memory.merged',
          actor: meta.actor,
          source: meta.source,
          subject: { kind: 'memory', id: targetId },
          payload: { memory_id: targetId, target_id: targetId, source_ids: sourceIds, strategy, version },
          trace_id: meta.traceId,
        },
        {},
      );
      outEvents.push(prepared.event);
      writeVersionTx(d, {
        memoryId: targetId,
        version,
        changeKind: 'merge',
        snapshot: after,
        diff: diffJson(before, after),
        meta,
        sourceEventId: prepared.event.id,
      });
      // 源记忆软删（保留历史）
      const deletedSources = [];
      for (const source of sources) {
        const sourceVersion = Number(source.version) + 1;
        d.prepare('UPDATE memories SET deleted_at=?, updated_at=?, version=?, updated_by_kind=?, updated_by_id=? WHERE id=?').run(
          now,
          now,
          sourceVersion,
          meta.actor?.kind ?? 'user',
          meta.actor?.id ?? 'local',
          source.id,
        );
        const snapshot = presentMemory(d, getRow(d, source.id));
        writeVersionTx(d, {
          memoryId: source.id,
          version: sourceVersion,
          changeKind: 'merge',
          snapshot,
          diff: [{ op: 'replace', path: '/deleted_at', value: now }],
          meta,
          sourceEventId: prepared.event.id,
        });
        deletedSources.push(snapshot);
      }
      outEvents.push(...syncAutoLinksTx(d, targetId, meta));
      d.exec('COMMIT');
      result = { memory: after, sources: deletedSources, merged_ids: sourceIds, target_id: targetId, strategy };
    } catch (err) {
      try {
        d.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    events.publish(outEvents);
    return result;
  }

  function split(id, input, meta = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('split body 必须是 JSON 对象');
    if (!Array.isArray(input.parts) || input.parts.length === 0) {
      throw validationFailed([{ field: 'parts', message: '必须是非空数组' }]);
    }
    if (input.parts.length > MAX_SPLIT_PARTS) throw validationFailed([{ field: 'parts', message: `不得超过 ${MAX_SPLIT_PARTS} 个` }]);
    const d = db();
    const outEvents = [];
    let result;
    d.exec('BEGIN IMMEDIATE');
    try {
      const parent = rowOrThrow(d, id, { allowDeleted: false });
      if (input.expected_version !== undefined && Number(input.expected_version) !== Number(parent.version)) {
        throw versionConflict(Number(parent.version));
      }
      const parentBefore = presentMemory(d, parent);
      const parentTags = d.prepare('SELECT t.id, t.name FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.memory_id = ?').all(id);
      const parentParticipants = d
        .prepare('SELECT mp.entity_id, mp.role, e.name, e.kind FROM memory_participants mp JOIN entities e ON e.id = mp.entity_id WHERE mp.memory_id = ?')
        .all(id);
      const parentProjectRow = d
        .prepare('SELECT mp.entity_id, e.name FROM memory_project mp JOIN entities e ON e.id = mp.entity_id WHERE mp.memory_id = ?')
        .get(id);
      const parentEmotion = d.prepare('SELECT valence, arousal, label FROM memory_emotion WHERE memory_id = ?').get(id);
      const now = nowIso();
      const partIds = [];
      const normalizedParts = [];
      for (const part of input.parts) {
        if (!part || typeof part !== 'object' || Array.isArray(part)) {
          throw validationFailed([{ field: 'parts', message: '每个 part 必须是对象' }]);
        }
        const base = {
          title: part.title, // 必须由调用方提供
          body: part.body ?? '',
          memory_type: part.memory_type ?? parent.memory_type,
          occurred_at: part.occurred_at !== undefined ? part.occurred_at : parent.occurred_at,
          occurred_precision: part.occurred_precision !== undefined ? part.occurred_precision : parent.occurred_precision,
          occurred_end_at: part.occurred_end_at !== undefined ? part.occurred_end_at : parent.occurred_end_at,
          source: part.source !== undefined ? part.source : { type: parent.source_type, ref: parent.source_ref, note: parent.source_note },
          credibility: part.credibility !== undefined ? part.credibility : parent.credibility,
          importance: part.importance !== undefined ? part.importance : parent.importance,
          display_weight: part.display_weight !== undefined ? part.display_weight : parent.display_weight,
          tags:
            part.tags !== undefined
              ? part.tags
              : parentTags.map((t) => ({ id: t.id, name: t.name })),
          participants:
            part.participants !== undefined
              ? part.participants
              : parentParticipants.map((p) => ({ entity_id: p.entity_id, role: p.role })),
          project:
            part.project !== undefined
              ? part.project
              : parentProjectRow
                ? { entity_id: parentProjectRow.entity_id, name: parentProjectRow.name }
                : null,
          emotion:
            part.emotion !== undefined
              ? part.emotion
              : parentEmotion
                ? { valence: parentEmotion.valence, arousal: parentEmotion.arousal, label: parentEmotion.label }
                : null,
          origin: part.origin ?? 'user',
        };
        normalizedParts.push(normalizeCreateInput(base, { meta, allowDemo: meta.allowDemo === true }));
      }
      for (const normalized of normalizedParts) {
        const inserted = insertMemoryTx(d, normalized, meta);
        outEvents.push(...inserted.events);
        partIds.push(inserted.memoryId);
      }
      const version = Number(parent.version) + 1;
      d.prepare('UPDATE memories SET deleted_at=?, updated_at=?, version=?, updated_by_kind=?, updated_by_id=? WHERE id=?').run(
        now,
        now,
        version,
        meta.actor?.kind ?? 'user',
        meta.actor?.id ?? 'local',
        id,
      );
      const prepared = events.prepare(
        d,
        {
          type: 'memory.split',
          actor: meta.actor,
          source: meta.source,
          subject: { kind: 'memory', id },
          payload: { memory_id: id, parent_id: id, part_ids: partIds, part_count: partIds.length, version },
          trace_id: meta.traceId,
        },
        {},
      );
      outEvents.push(prepared.event);
      const parentSnapshot = presentMemory(d, getRow(d, id));
      writeVersionTx(d, {
        memoryId: id,
        version,
        changeKind: 'split',
        snapshot: parentSnapshot,
        diff: diffJson(parentBefore, parentSnapshot),
        meta,
        sourceEventId: prepared.event.id,
      });
      for (const partId of partIds) {
        writeVersionTx(d, {
          memoryId: partId,
          version: 1,
          changeKind: 'create',
          snapshot: presentMemory(d, getRow(d, partId)),
          diff: [],
          meta,
          sourceEventId: prepared.event.id,
        });
        outEvents.push(...syncAutoLinksTx(d, partId, meta));
      }
      const parts = partIds.map((pid) => presentMemory(d, getRow(d, pid)));
      d.exec('COMMIT');
      result = { parts, memory: parentSnapshot, parent_id: id, part_ids: partIds };
    } catch (err) {
      try {
        d.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    events.publish(outEvents);
    return result;
  }

  function versions(id, { limit = 100, cursor = null, before_version = null } = {}) {
    const d = db();
    rowOrThrow(d, id, { allowDeleted: true });
    const parsedLimit = Math.min(MAX_VERSIONS_PAGE, Math.max(1, Number(limit) || 100));
    let before = before_version === null || before_version === undefined || before_version === '' ? null : Number(before_version);
    let offset = 0;
    if (before === null && cursor) {
      const decoded = (() => {
        try {
          return JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
        } catch {
          throw badRequest('cursor 不合法');
        }
      })();
      before = Number(decoded.b ?? NaN);
      offset = Number(decoded.o ?? 0);
      if (!Number.isInteger(before)) throw badRequest('cursor 不合法');
    }
    if (before !== null && (!Number.isInteger(before) || before < 1)) {
      throw validationFailed([{ field: 'before_version', message: '必须是正整数' }]);
    }
    const where = ['memory_id = ?'];
    const params = [id];
    if (before !== null) {
      where.push('version < ?');
      params.push(before);
    }
    const total = Number(d.prepare('SELECT count(*) c FROM memory_versions WHERE memory_id = ?').get(id)?.c ?? 0);
    const rows = d
      .prepare(`SELECT * FROM memory_versions WHERE ${where.join(' AND ')} ORDER BY version DESC LIMIT ? OFFSET ?`)
      .all(...params, parsedLimit, offset);
    const last = rows[rows.length - 1];
    const next = last && Number(last.version) > 1
      ? makeCursor2({ b: Number(last.version), o: 0 })
      : null;
    return {
      items: rows.map(presentVersion),
      next_cursor: next,
      next_before_version: last && Number(last.version) > 1 ? Number(last.version) : null,
      total,
    };
  }

  function makeCursor2(obj) {
    return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  }

  function diff(id, { from, to } = {}) {
    const d = db();
    const row = rowOrThrow(d, id, { allowDeleted: true });
    const fromVersion = Number(from);
    const toVersion = Number(to);
    if (!Number.isInteger(fromVersion) || fromVersion < 1) throw validationFailed([{ field: 'from', message: '必须是正整数' }]);
    if (!Number.isInteger(toVersion) || toVersion < 1) throw validationFailed([{ field: 'to', message: '必须是正整数' }]);
    const fromRow = d.prepare('SELECT * FROM memory_versions WHERE memory_id = ? AND version = ?').get(id, fromVersion);
    if (!fromRow) throw notFound(`记忆 ${id} 不存在版本 ${fromVersion}`);
    const toRow = d.prepare('SELECT * FROM memory_versions WHERE memory_id = ? AND version = ?').get(id, toVersion);
    if (!toRow) throw notFound(`记忆 ${id} 不存在版本 ${toVersion}`);
    const fromSnapshot = JSON.parse(fromRow.snapshot);
    const toSnapshot = JSON.parse(toRow.snapshot);
    const operations = diffJson(fromSnapshot, toSnapshot);
    return {
      memory_id: id,
      from_version: fromVersion,
      to_version: toVersion,
      from: fromVersion,
      to: toVersion,
      current_version: Number(row.version),
      operations,
      patch: operations,
    };
  }

  /** 全量重建全文索引与语义索引（导入/迁移/维护用）。 */
  function rebuildIndexes() {
    const d = db();
    const fts = rebuildFulltextIndex(d, { logger });
    const semantic = rebuildEmbeddings(d, { logger });
    return { fulltext: fts, semantic };
  }

  function escapeLike(value) {
    return String(value).replace(/[\\%_]/g, (m) => `\\${m}`);
  }

  /**
   * GET /api/v1/memories 列表查询（q LIKE + 结构化筛选 + 排序 + 分页）。
   * @param {object} query
   */
  function list(query = {}) {
    const d = db();
    const filters = {};
    if (query.memory_type) filters.types = String(query.memory_type).split(',').map((s) => s.trim()).filter(Boolean);
    if (query.tags) filters.tags = String(query.tags).split(',').map((s) => s.trim()).filter(Boolean);
    if (query.project) filters.projects = String(query.project).split(',').map((s) => s.trim()).filter(Boolean);
    if (query.participant) filters.entity_ids = String(query.participant).split(',').map((s) => s.trim()).filter(Boolean);
    if (query.from) filters.occurred_from = query.from;
    if (query.to) filters.occurred_to = query.to;
    if (query.demo !== undefined) filters.demo = query.demo === true || query.demo === 'true';
    if (query.agent_generated !== undefined) filters.agent_generated = query.agent_generated === true || query.agent_generated === 'true';
    const includeDeleted = query.include_deleted === true || query.include_deleted === 'true';
    const onlyDeleted = query.only_deleted === true || query.only_deleted === 'true';
    if (onlyDeleted) filters.deleted_only = true;
    const filter = buildMemoryFilterSql(filters, { includeDeleted });
    const conditions = [filter.sql];
    const params = [...filter.params];
    const q = query.q === undefined || query.q === null ? '' : String(query.q).trim();
    if (q) {
      const like = `%${escapeLike(q)}%`;
      conditions.push(
        `(m.title LIKE ? ESCAPE '\\' OR m.body LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM memory_tags mt2 JOIN tags t2 ON t2.id = mt2.tag_id WHERE mt2.memory_id = m.id AND t2.name LIKE ? ESCAPE '\\'))`,
      );
      params.push(like, like, like);
    }
    const where = conditions.filter(Boolean).length ? `WHERE ${conditions.filter(Boolean).join(' AND ')}` : '';
    const sortMap = {
      updated_at: 'm.updated_at',
      created_at: 'm.created_at',
      occurred_at: 'm.occurred_at',
      importance: 'm.importance',
      display_weight: 'm.display_weight',
      title: 'm.title',
    };
    const rawSort = String(query.sort ?? '-updated_at');
    const desc = rawSort.startsWith('-');
    const sortColumn = sortMap[rawSort.replace(/^-/, '')];
    if (!sortColumn) {
      throw validationFailed([{ field: 'sort', message: `必须是 ${Object.keys(sortMap).join('|')}（可加 - 前缀降序）` }]);
    }
    const parsedLimit = Math.min(500, Math.max(1, Number(query.limit) || 50));
    let offset = 0;
    if (query.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(String(query.cursor), 'base64url').toString('utf8'));
        const o = Number(decoded.o);
        if (!Number.isInteger(o) || o < 0) throw new Error('bad');
        offset = o;
      } catch {
        throw badRequest('cursor 不合法');
      }
    }
    const total = Number(d.prepare(`SELECT count(*) c FROM memories m ${where}`).get(...params)?.c ?? 0);
    const rows = d
      .prepare(
        `SELECT m.* FROM memories m ${where}
         ORDER BY (${sortColumn} IS NULL) ASC, ${sortColumn} ${desc ? 'DESC' : 'ASC'}, m.id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, parsedLimit, offset);
    const nextOffset = offset + rows.length;
    return {
      items: rows.map((row) => presentMemory(d, row)),
      next_cursor: nextOffset < total ? Buffer.from(JSON.stringify({ o: nextOffset }), 'utf8').toString('base64url') : null,
      total,
    };
  }

  function count() {
    const d = db();
    return {
      active: Number(d.prepare('SELECT count(*) c FROM memories WHERE deleted_at IS NULL').get()?.c ?? 0),
      deleted: Number(d.prepare('SELECT count(*) c FROM memories WHERE deleted_at IS NOT NULL').get()?.c ?? 0),
    };
  }

  return {
    create,
    patch,
    get,
    list,
    remove,
    restore,
    merge,
    split,
    versions,
    diff,
    rebuildIndexes,
    count,
    rowOrThrow,
    getRow,
    presentWithRelations,
    writeVersionTx,
    reindexTx,
    memoryRef,
  };
}
