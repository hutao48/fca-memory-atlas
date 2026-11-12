// FCA Local Runtime — /api/v1/graph 组装（契约 §5：渲染数据唯一来源）
import { nowIso } from '../core/time.js';
import { loadGraphData } from './data.js';
import { computeClusters } from '../layout/clusters.js';

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function positionFromRow(row) {
  if (!row) return { x: 0, y: 0, z: 0 };
  return { x: Number(row.x), y: Number(row.y), z: Number(row.z) };
}

export function createGraphService({ dbHolder, layout, config }) {
  /**
   * @param {{filters?:object|null, include_deleted?:boolean, include_entities?:boolean, view_id?:string|null}} options
   * @param {object} meta 事件元信息
   */
  function build(options = {}, meta = {}) {
    const d = dbHolder.requireDb();
    const includeDeleted = options.include_deleted === true;
    const includeEntities = options.include_entities !== false;
    const filters = options.filters ?? null;
    // 保证所有活动节点有持久化坐标（首次自动布局 / 新节点增量放置）
    const ensured = layout.ensureLayout(meta);
    const data = loadGraphData(d, { include_deleted: includeDeleted, filters, include_entities: includeEntities });
    const layoutRows = layout.loadRowsMap(d);
    const clusterResult = computeClusters(data);

    const positionById = new Map();
    const nodes = [];
    for (const row of data.memories) {
      const key = `memory:${row.id}`;
      const layoutRow = layoutRows.get(key);
      const position = positionFromRow(layoutRow);
      positionById.set(row.id, position);
      const tags = data.tagsByMemory.get(row.id) ?? [];
      nodes.push({
        id: row.id,
        kind: 'memory',
        type: row.memory_type,
        label: row.title,
        importance: Number(row.importance),
        display_weight: Number(row.display_weight),
        credibility: Number(row.credibility),
        occurred_at: row.occurred_at ?? null,
        degree: 0,
        cluster_id: clusterResult.assignments.get(key) ?? layoutRow?.cluster_id ?? null,
        position,
        pinned: Boolean(layoutRow?.pinned),
        tags: tags.map((t) => t.name),
        tag_ids: tags.map((t) => t.id),
        deleted: Boolean(row.deleted_at),
        agent_generated: Boolean(row.agent_generated),
        demo: Boolean(row.demo),
      });
    }
    for (const row of data.entities) {
      const key = `entity:${row.id}`;
      const layoutRow = layoutRows.get(key);
      const position = positionFromRow(layoutRow);
      positionById.set(row.id, position);
      nodes.push({
        id: row.id,
        kind: 'entity',
        type: row.kind,
        label: row.name,
        importance: clamp01(0.15 + 0.1 * (data.degree.get(key) ?? 0)),
        display_weight: 1.0,
        credibility: 1.0,
        occurred_at: null,
        degree: 0,
        cluster_id: clusterResult.assignments.get(key) ?? layoutRow?.cluster_id ?? null,
        position,
        pinned: Boolean(layoutRow?.pinned),
        tags: [],
        tag_ids: [],
        deleted: Boolean(row.deleted_at),
        agent_generated: false,
        demo: false,
      });
    }

    const includedIds = new Set(nodes.map((n) => n.id));
    const edges = [];
    for (const row of data.relations) {
      if (!includedIds.has(row.from_id) || !includedIds.has(row.to_id)) continue;
      edges.push({
        id: row.id,
        from: row.from_id,
        to: row.to_id,
        from_kind: row.from_kind,
        to_kind: row.to_kind,
        relation_type: row.relation_type,
        weight: Number(row.weight),
        directed: Boolean(row.directed),
        confidence: Number(row.confidence),
        label: row.label ?? null,
        deleted: Boolean(row.deleted_at),
      });
    }
    // degree 按实际返回的边计算
    const degree = new Map();
    for (const edge of edges) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }
    for (const node of nodes) node.degree = degree.get(node.id) ?? 0;

    // clusters：只输出当前返回节点范围内的成员，centroid/density 由真实坐标计算
    const clusters = [];
    for (const cluster of clusterResult.clusters) {
      const memberIds = [];
      for (const nodeKey of cluster.node_ids) {
        const id = nodeKey.slice(nodeKey.indexOf(':') + 1);
        if (includedIds.has(id)) memberIds.push(id);
      }
      if (memberIds.length === 0) continue;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (const id of memberIds) {
        const pos = positionById.get(id) ?? { x: 0, y: 0, z: 0 };
        sx += pos.x;
        sy += pos.y;
        sz += pos.z;
      }
      const centroid = {
        x: Math.round((sx / memberIds.length) * 100) / 100,
        y: Math.round((sy / memberIds.length) * 100) / 100,
        z: Math.round((sz / memberIds.length) * 100) / 100,
      };
      let spread = 0;
      for (const id of memberIds) {
        const pos = positionById.get(id) ?? { x: 0, y: 0, z: 0 };
        spread += Math.hypot(pos.x - centroid.x, pos.y - centroid.y, pos.z - centroid.z);
      }
      spread /= memberIds.length;
      clusters.push({
        id: cluster.id,
        label: cluster.label,
        node_ids: memberIds,
        centroid,
        density: Math.round((memberIds.length / (memberIds.length + spread)) * 1000) / 1000,
        dominant_types: cluster.dominant_types,
        color_hint: cluster.color_hint,
      });
    }

    let view = null;
    if (options.view_id) {
      view = layout.getView(options.view_id);
    } else {
      view = layout.defaultView();
    }
    return {
      api_version: config.apiVersion,
      layout_version: ensured.layoutVersion,
      view: {
        center: Array.isArray(view?.camera?.center) && view.camera.center.length === 3 ? view.camera.center : [0, 0, 0],
        zoom: Number.isFinite(Number(view?.camera?.zoom)) ? Number(view.camera.zoom) : 1.0,
        view_id: view?.id ?? null,
      },
      nodes,
      edges,
      clusters,
      stats: {
        nodes: nodes.length,
        edges: edges.length,
        clusters: clusters.length,
        generated_at: nowIso(),
      },
    };
  }

  return { build };
}
