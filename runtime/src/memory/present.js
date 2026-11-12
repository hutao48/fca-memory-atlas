// FCA Local Runtime — 记忆响应装配（契约 §3.1）
import { toIso } from '../core/time.js';

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * 把内存数据行装配为契约 Memory 对象。
 * 额外字段 `tag_names` 与 `demo` 为向后兼容的附加字段（契约 §3.1 要求响应同含 tag_names）。
 */
export function presentMemory(db, row, { tags = null } = {}) {
  if (!row) return null;
  const tagRows = tags !== null ? tags : queryTags(db, row.id);
  const participantRows = queryParticipants(db, row.id);
  const projectRow = queryProject(db, row.id);
  const emotionRow = queryEmotion(db, row.id);
  return {
    id: row.id,
    title: row.title,
    body: row.body ?? '',
    memory_type: row.memory_type,
    occurred_at: row.occurred_at ?? null,
    occurred_precision: row.occurred_precision ?? 'unknown',
    occurred_end_at: row.occurred_end_at ?? null,
    source: {
      type: row.source_type ?? 'user',
      ref: row.source_ref ?? null,
      note: row.source_note ?? null,
    },
    credibility: Number(row.credibility),
    importance: Number(row.importance),
    display_weight: Number(row.display_weight),
    tags: tagRows.map((t) => t.id),
    tag_names: tagRows.map((t) => t.name),
    participants: participantRows,
    project: projectRow,
    emotion: emotionRow,
    origin: row.origin,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: Number(row.version),
    deleted_at: row.deleted_at ?? null,
    agent_generated: Boolean(row.agent_generated),
    demo: Boolean(row.demo),
    created_by: { kind: row.created_by_kind ?? 'user', id: row.created_by_id ?? 'local' },
    updated_by: { kind: row.updated_by_kind ?? 'user', id: row.updated_by_id ?? 'local' },
  };
}

export function queryTags(db, memoryId) {
  return db
    .prepare(
      `SELECT t.id, t.name, t.color FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id
       WHERE mt.memory_id = ? AND t.deleted_at IS NULL ORDER BY t.name ASC`,
    )
    .all(memoryId);
}

export function queryParticipants(db, memoryId) {
  const rows = db
    .prepare(
      `SELECT mp.entity_id, mp.role, e.name, e.kind FROM memory_participants mp
       JOIN entities e ON e.id = mp.entity_id
       WHERE mp.memory_id = ? ORDER BY e.name ASC, mp.role ASC`,
    )
    .all(memoryId);
  return rows.map((r) => ({ entity_id: r.entity_id, name: r.name, role: r.role }));
}

export function queryProject(db, memoryId) {
  const row = db
    .prepare(
      `SELECT e.id, e.name FROM memory_project mp JOIN entities e ON e.id = mp.entity_id WHERE mp.memory_id = ?`,
    )
    .get(memoryId);
  return row ? { entity_id: row.id, name: row.name } : null;
}

export function queryEmotion(db, memoryId) {
  const row = db.prepare('SELECT valence, arousal, label FROM memory_emotion WHERE memory_id = ?').get(memoryId);
  if (!row) return null;
  return {
    valence: row.valence == null ? null : Number(row.valence),
    arousal: row.arousal == null ? null : Number(row.arousal),
    label: row.label ?? null,
  };
}

/** 时间线 / 列表使用的轻量记忆引用。 */
export function memoryRef(row) {
  return {
    id: row.id,
    title: row.title,
    memory_type: row.memory_type,
    occurred_at: row.occurred_at ?? null,
    importance: Number(row.importance),
    display_weight: Number(row.display_weight),
    agent_generated: Boolean(row.agent_generated),
    deleted: Boolean(row.deleted_at),
  };
}

/** 版本历史行装配。 */
export function presentVersion(row) {
  if (!row) return null;
  return {
    ver_id: row.ver_id,
    memory_id: row.memory_id,
    version: Number(row.version),
    change_kind: row.change_kind,
    snapshot: parseJson(row.snapshot, null),
    diff: parseJson(row.diff, []),
    actor: { kind: row.actor_kind ?? 'system', id: row.actor_id ?? 'runtime' },
    source_event_id: row.source_event_id ?? null,
    created_at: row.created_at,
  };
}

/** 布局节点行装配。 */
export function presentLayoutNode(row) {
  if (!row) return null;
  return {
    node_kind: row.node_kind,
    node_id: row.node_id,
    x: Number(row.x),
    y: Number(row.y),
    z: Number(row.z),
    pinned: Boolean(row.pinned),
    cluster_id: row.cluster_id ?? null,
    updated_at: row.updated_at,
  };
}

/** 布局视图行装配。 */
export function presentLayoutView(row) {
  if (!row) return null;
  let camera = {};
  let layerConfig = {};
  try {
    camera = JSON.parse(row.camera);
  } catch {
    camera = {};
  }
  try {
    layerConfig = JSON.parse(row.layer_config);
  } catch {
    layerConfig = {};
  }
  return {
    id: row.view_id,
    view_id: row.view_id,
    name: row.name,
    is_default: Boolean(row.is_default),
    camera,
    layer_config: layerConfig,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export { toIso };
