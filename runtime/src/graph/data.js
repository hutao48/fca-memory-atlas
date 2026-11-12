// FCA Local Runtime — Graph 数据装载（记忆/实体/关系/标签/参与者/项目），供布局与 /graph 使用
import { buildMemoryFilterSql } from '../memory/filters.js';

/**
 * 装载图数据。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{include_deleted?: boolean, filters?: object|null, include_entities?: boolean}} [options]
 */
export function loadGraphData(db, { include_deleted = false, filters = null, include_entities = true } = {}) {
  const filtered = filters && Object.keys(filters).length > 0;
  let memoryRows;
  if (filtered) {
    const filter = buildMemoryFilterSql(filters, { includeDeleted: include_deleted });
    const where = filter.sql ? `WHERE ${filter.sql}` : '';
    memoryRows = db.prepare(`SELECT m.* FROM memories m ${where}`).all(...filter.params);
  } else {
    memoryRows = db
      .prepare(`SELECT * FROM memories ${include_deleted ? '' : 'WHERE deleted_at IS NULL'}`)
      .all();
  }
  const memoryIds = memoryRows.map((r) => r.id);
  const memoryIdSet = new Set(memoryIds);

  const entityRows = db
    .prepare(`SELECT * FROM entities ${include_deleted ? '' : 'WHERE deleted_at IS NULL'}`)
    .all();
  const entityById = new Map(entityRows.map((r) => [r.id, r]));

  const relationRows = db
    .prepare(`SELECT * FROM relations ${include_deleted ? '' : 'WHERE deleted_at IS NULL'}`)
    .all();

  const tagsByMemory = new Map();
  const participantsByMemory = new Map();
  const projectByMemory = new Map();
  const entityMemoryLinks = new Map(); // entityId -> Set(memoryId)

  const memoryIdChunks = [];
  for (let i = 0; i < memoryIds.length; i += 500) memoryIdChunks.push(memoryIds.slice(i, i + 500));

  for (const chunk of memoryIdChunks) {
    const ph = chunk.map(() => '?').join(',');
    const tagRows = db
      .prepare(
        `SELECT mt.memory_id, t.id, t.name, t.color FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id
         WHERE mt.memory_id IN (${ph}) AND t.deleted_at IS NULL ORDER BY t.name ASC`,
      )
      .all(...chunk);
    for (const row of tagRows) {
      if (!tagsByMemory.has(row.memory_id)) tagsByMemory.set(row.memory_id, []);
      tagsByMemory.get(row.memory_id).push({ id: row.id, name: row.name, color: row.color ?? null });
    }
    const participantRows = db
      .prepare(
        `SELECT mp.memory_id, mp.entity_id, mp.role, e.name, e.kind FROM memory_participants mp
         JOIN entities e ON e.id = mp.entity_id WHERE mp.memory_id IN (${ph})`,
      )
      .all(...chunk);
    for (const row of participantRows) {
      if (!participantsByMemory.has(row.memory_id)) participantsByMemory.set(row.memory_id, []);
      participantsByMemory.get(row.memory_id).push({ entity_id: row.entity_id, name: row.name, kind: row.kind, role: row.role });
      if (!entityMemoryLinks.has(row.entity_id)) entityMemoryLinks.set(row.entity_id, new Set());
      entityMemoryLinks.get(row.entity_id).add(row.memory_id);
    }
    const projectRows = db
      .prepare(
        `SELECT mp.memory_id, mp.entity_id, e.name, e.kind FROM memory_project mp JOIN entities e ON e.id = mp.entity_id
         WHERE mp.memory_id IN (${ph})`,
      )
      .all(...chunk);
    for (const row of projectRows) {
      projectByMemory.set(row.memory_id, { entity_id: row.entity_id, name: row.name, kind: row.kind });
      if (!entityMemoryLinks.has(row.entity_id)) entityMemoryLinks.set(row.entity_id, new Set());
      entityMemoryLinks.get(row.entity_id).add(row.memory_id);
    }
  }

  const nodeKeys = new Set();
  for (const id of memoryIds) nodeKeys.add(`memory:${id}`);
  const activeRelations = [];
  for (const row of relationRows) {
    const fromKey = `${row.from_kind}:${row.from_id}`;
    const toKey = `${row.to_kind}:${row.to_id}`;
    const fromKnown = row.from_kind === 'memory' ? memoryIdSet.has(row.from_id) : entityById.has(row.from_id);
    const toKnown = row.to_kind === 'memory' ? memoryIdSet.has(row.to_id) : entityById.has(row.to_id);
    if (!fromKnown || !toKnown) continue;
    activeRelations.push(row);
    if (row.from_kind === 'entity') {
      if (!entityMemoryLinks.has(row.from_id)) entityMemoryLinks.set(row.from_id, new Set());
      if (row.to_kind === 'memory' && memoryIdSet.has(row.to_id)) entityMemoryLinks.get(row.from_id).add(row.to_id);
    }
    if (row.to_kind === 'entity' && row.from_kind === 'memory' && memoryIdSet.has(row.from_id)) {
      if (!entityMemoryLinks.has(row.to_id)) entityMemoryLinks.set(row.to_id, new Set());
      entityMemoryLinks.get(row.to_id).add(row.from_id);
    }
  }

  let includedEntityRows = entityRows;
  if (include_entities === false) {
    includedEntityRows = [];
  } else if (filtered) {
    const referenced = new Set();
    for (const row of activeRelations) {
      if (row.from_kind === 'entity') referenced.add(row.from_id);
      if (row.to_kind === 'entity') referenced.add(row.to_id);
    }
    for (const entityId of entityMemoryLinks.keys()) {
      if ([...(entityMemoryLinks.get(entityId) ?? [])].some((mid) => memoryIdSet.has(mid))) referenced.add(entityId);
    }
    includedEntityRows = entityRows.filter((r) => referenced.has(r.id));
  }
  for (const row of includedEntityRows) nodeKeys.add(`entity:${row.id}`);

  const degree = new Map();
  for (const row of activeRelations) {
    const fromKey = `${row.from_kind}:${row.from_id}`;
    const toKey = `${row.to_kind}:${row.to_id}`;
    degree.set(fromKey, (degree.get(fromKey) ?? 0) + 1);
    degree.set(toKey, (degree.get(toKey) ?? 0) + 1);
  }

  return {
    memories: memoryRows,
    memoryIds,
    memoryIdSet,
    entities: includedEntityRows,
    entityById,
    relations: activeRelations,
    tagsByMemory,
    participantsByMemory,
    projectByMemory,
    entityMemoryLinks,
    nodeKeys,
    degree,
    filtered,
  };
}
