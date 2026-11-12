// FCA Local Runtime — 布局服务：坐标持久化、确定性重算、增量放置、命名视图（契约 §3.5/§5）
import { newId } from '../core/ids.js';
import { nowIso } from '../core/time.js';
import { validationFailed, notFound, duplicate, badRequest } from '../core/errors.js';
import { bumpLayoutVersion, getLayoutVersion } from '../persistence/db.js';
import { presentLayoutNode, presentLayoutView } from '../memory/present.js';
import { loadGraphData } from '../graph/data.js';
import { computeClusters } from './clusters.js';
import { computeForceLayout, FORCE_ALGORITHM, WORLD_BOUNDS } from './force.js';

const MAX_BATCH = 5000;
const MAX_VIEWS_PAGE = 500;

function hashOffset(key, spread) {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h1 ^= key.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= key.charCodeAt(key.length - 1 - i);
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return {
    x: ((h1 % 20001) / 10000 - 1) * spread,
    y: ((h2 % 20001) / 10000 - 1) * spread,
    z: ((h1 % 40001) / 20000 - 1) * spread * 0.2,
  };
}

function nodeKey(kind, id) {
  return `${kind}:${id}`;
}

export function createLayoutService({ dbHolder, events, logger }) {
  function db() {
    return dbHolder.requireDb();
  }

  function loadRowsMap(d) {
    const rows = d.prepare('SELECT * FROM layout_nodes').all();
    const map = new Map();
    for (const row of rows) map.set(nodeKey(row.node_kind, row.node_id), row);
    return map;
  }

  function nodeExistsInDb(d, kind, id) {
    const table = kind === 'memory' ? 'memories' : 'entities';
    return Boolean(d.prepare(`SELECT 1 AS x FROM ${table} WHERE id = ?`).get(id));
  }

  function clusterCentroidFromRows(rows, clusterId) {
    let count = 0;
    let sx = 0;
    let sy = 0;
    for (const row of rows.values()) {
      if (row.cluster_id !== clusterId) continue;
      count += 1;
      sx += row.x;
      sy += row.y;
    }
    return count > 0 ? { x: sx / count, y: sy / count } : null;
  }

  function activeNodeKeys(data) {
    return [
      ...data.memories.map((m) => nodeKey('memory', m.id)),
      ...data.entities.map((e) => nodeKey('entity', e.id)),
    ];
  }

  function buildNodes(data, clusterResult, rows, { preservePinned = true } = {}) {
    const nodes = [];
    for (const row of data.memories) {
      const key = nodeKey('memory', row.id);
      const existing = rows.get(key);
      const pinned = preservePinned && existing?.pinned ? true : false;
      nodes.push({
        key,
        kind: 'memory',
        cluster_id: clusterResult.assignments.get(key) ?? null,
        pinned,
        x: pinned ? existing.x : undefined,
        y: pinned ? existing.y : undefined,
        z: pinned ? existing.z : undefined,
      });
    }
    for (const row of data.entities) {
      const key = nodeKey('entity', row.id);
      const existing = rows.get(key);
      const pinned = preservePinned && existing?.pinned ? true : false;
      nodes.push({
        key,
        kind: 'entity',
        cluster_id: clusterResult.assignments.get(key) ?? null,
        pinned,
        x: pinned ? existing.x : undefined,
        y: pinned ? existing.y : undefined,
        z: pinned ? existing.z : undefined,
      });
    }
    return nodes;
  }

  function edgesFor(data) {
    return data.relations.map((row) => ({
      fromKey: nodeKey(row.from_kind, row.from_id),
      toKey: nodeKey(row.to_kind, row.to_id),
      weight: Number(row.weight),
      confidence: Number(row.confidence),
    }));
  }

  function upsertRow(d, { key, clusterId, x, y, z, pinned }) {
    const [kind, id] = key.split(':');
    const now = nowIso();
    d.prepare(
      `INSERT INTO layout_nodes(node_kind, node_id, x, y, z, pinned, cluster_id, updated_at)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(node_kind, node_id) DO UPDATE SET
         x=excluded.x, y=excluded.y, z=excluded.z, pinned=excluded.pinned,
         cluster_id=excluded.cluster_id, updated_at=excluded.updated_at`,
    ).run(kind, id, Number(x), Number(y), Number(z ?? 0), pinned ? 1 : 0, clusterId ?? null, now);
  }

  /**
   * 确保所有活动节点都有持久化坐标与聚类分配（首次/导入后自动全量布局，新增节点增量放置）。
   * @param {object} meta
   */
  function ensureLayout(meta = {}) {
    const d = db();
    const data = loadGraphData(d, { include_deleted: false });
    const clusterResult = computeClusters(data);
    const rows = loadRowsMap(d);
    const activeKeys = activeNodeKeys(data);
    const activeKeySet = new Set(activeKeys);
    const staleKeys = [];
    for (const [key] of rows) {
      const [kind, id] = key.split(':');
      if (!nodeExistsInDb(d, kind, id)) staleKeys.push(key);
    }
    const missingKeys = activeKeys.filter((key) => !rows.has(key));
    const changedCluster = [];
    for (const key of activeKeys) {
      const row = rows.get(key);
      if (!row) continue;
      const want = clusterResult.assignments.get(key) ?? null;
      if (want && want !== row.cluster_id) changedCluster.push({ key, row, want });
    }
    if (staleKeys.length === 0 && missingKeys.length === 0 && changedCluster.length === 0) {
      return {
        rows,
        clusters: clusterResult.clusters,
        data,
        layoutVersion: getLayoutVersion(d),
        changed: false,
        reason: null,
      };
    }
    const needFull = rows.size === 0 || (activeKeys.length > 0 && missingKeys.length >= Math.max(2, Math.ceil(activeKeys.length * 0.2)));
    const started = performance.now();
    d.exec('BEGIN IMMEDIATE');
    let reason;
    try {
      for (const key of staleKeys) {
        const [kind, id] = key.split(':');
        d.prepare('DELETE FROM layout_nodes WHERE node_kind = ? AND node_id = ?').run(kind, id);
      }
      if (needFull) {
        reason = 'initial';
        const nodes = buildNodes(data, clusterResult, rows, { preservePinned: true });
        const positions = computeForceLayout({
          nodes,
          edges: edgesFor(data),
          clusters: clusterResult.clusters,
          clusterSeparation: 0.8,
        });
        for (const node of nodes) {
          const pos = positions.get(node.key);
          if (!pos) continue;
          upsertRow(d, {
            key: node.key,
            clusterId: node.cluster_id,
            x: pos.x,
            y: pos.y,
            z: pos.z,
            pinned: node.pinned,
          });
        }
      } else {
        reason = 'incremental';
        for (const row of changedCluster) {
          d.prepare('UPDATE layout_nodes SET cluster_id = ?, updated_at = ? WHERE node_kind = ? AND node_id = ?').run(
            row.want,
            nowIso(),
            row.row.node_kind,
            row.row.node_id,
          );
        }
        const currentRows = loadRowsMap(d);
        // 先给已有行补齐聚类
        for (const key of activeKeys) {
          const row = currentRows.get(key);
          if (!row) continue;
          const want = clusterResult.assignments.get(key) ?? null;
          if (want && want !== row.cluster_id) {
            d.prepare('UPDATE layout_nodes SET cluster_id = ?, updated_at = ? WHERE node_kind = ? AND node_id = ?').run(
              want,
              nowIso(),
              row.node_kind,
              row.node_id,
            );
            row.cluster_id = want;
          }
        }
        for (const key of activeKeys) {
          if (currentRows.has(key)) continue;
          const [kind, id] = key.split(':');
          const clusterId = clusterResult.assignments.get(key) ?? null;
          const centroid = clusterId ? clusterCentroidFromRows(currentRows, clusterId) : null;
          const offset = hashOffset(key, centroid ? 22 : 120);
          upsertRow(d, {
            key,
            clusterId,
            x: (centroid?.x ?? 0) + offset.x,
            y: (centroid?.y ?? 0) + offset.y,
            z: offset.z,
            pinned: false,
          });
        }
      }
      const layoutVersion = bumpLayoutVersion(d);
      const tookMs = Math.round((performance.now() - started) * 1000) / 1000;
      const prepared = events.prepare(
        d,
        {
          type: 'layout.recomputed',
          actor: meta.actor,
          source: meta.source,
          subject: { kind: 'layout', id: null },
          payload: {
            reason,
            incremental: !needFull,
            nodes: activeKeys.length,
            clusters: clusterResult.clusters.length,
            layout_version: layoutVersion,
            took_ms: tookMs,
          },
          trace_id: meta.traceId,
        },
        {},
      );
      d.exec('COMMIT');
      events.publish(prepared.event);
      return {
        rows: loadRowsMap(d),
        clusters: clusterResult.clusters,
        data,
        layoutVersion,
        changed: true,
        reason,
        took_ms: tookMs,
      };
    } catch (err) {
      try {
        d.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  function validateCoordinate(value, field, min, max, errors) {
    const n = Number(value);
    if (!Number.isFinite(n)) errors.push({ field, message: '必须是数字' });
    else if (n < min || n > max) errors.push({ field, message: `必须在 ${min}..${max} 之间` });
    return n;
  }

  /** POST /layout/nodes 批量保存坐标。 */
  function saveNodes(body, meta = {}) {
    const d = db();
    if (!body || typeof body !== 'object' || !Array.isArray(body.updates)) {
      throw validationFailed([{ field: 'updates', message: '必须提供 updates 数组' }]);
    }
    const updates = body.updates;
    if (updates.length === 0) throw validationFailed([{ field: 'updates', message: '不能为空' }]);
    if (updates.length > MAX_BATCH) throw validationFailed([{ field: 'updates', message: `单次不得超过 ${MAX_BATCH} 条` }]);
    const errors = [];
    const normalized = [];
    const seen = new Set();
    updates.forEach((item, index) => {
      if (!item || typeof item !== 'object') {
        errors.push({ field: `updates[${index}]`, message: '必须是对象' });
        return;
      }
      const kind = item.node_kind;
      if (kind !== 'memory' && kind !== 'entity') errors.push({ field: `updates[${index}].node_kind`, message: '必须是 memory|entity' });
      const id = item.node_id;
      if (typeof id !== 'string' || !id) errors.push({ field: `updates[${index}].node_id`, message: '缺少节点 ID' });
      const key = `${kind}:${id}`;
      if (seen.has(key)) {
        errors.push({ field: `updates[${index}]`, message: '同一节点重复更新' });
        return;
      }
      seen.add(key);
      normalized.push({
        kind,
        id,
        x: validateCoordinate(item.x, `updates[${index}].x`, WORLD_BOUNDS.x_min, WORLD_BOUNDS.x_max, errors),
        y: validateCoordinate(item.y, `updates[${index}].y`, WORLD_BOUNDS.y_min, WORLD_BOUNDS.y_max, errors),
        z: item.z === undefined ? 0 : validateCoordinate(item.z, `updates[${index}].z`, WORLD_BOUNDS.z_min, WORLD_BOUNDS.z_max, errors),
        pinned: item.pinned === undefined ? undefined : Boolean(item.pinned),
      });
    });
    if (errors.length) throw validationFailed(errors);
    const started = performance.now();
    let layoutVersion;
    const preparedEvents = [];
    d.exec('BEGIN IMMEDIATE');
    try {
      const existing = loadRowsMap(d);
      let pinnedCount = 0;
      for (const item of normalized) {
        const key = nodeKey(item.kind, item.id);
        if (!nodeExistsInDb(d, item.kind, item.id)) {
          throw notFound(`布局节点不存在：${item.kind}/${item.id}`);
        }
        const row = existing.get(key);
        const pinned = item.pinned === undefined ? Boolean(row?.pinned) : item.pinned;
        if (pinned) pinnedCount += 1;
        upsertRow(d, {
          key,
          clusterId: row?.cluster_id ?? null,
          x: item.x,
          y: item.y,
          z: item.z,
          pinned,
        });
      }
      layoutVersion = bumpLayoutVersion(d);
      const prepared = events.prepare(
        d,
        {
          type: 'layout.updated',
          actor: meta.actor,
          source: meta.source,
          subject: { kind: 'layout', id: null },
          payload: {
            count: normalized.length,
            pinned_count: pinnedCount,
            node_ids: normalized.slice(0, 100).map((n) => n.id),
            layout_version: layoutVersion,
          },
          trace_id: meta.traceId,
        },
        {},
      );
      preparedEvents.push(prepared.event);
      d.exec('COMMIT');
    } catch (err) {
      try {
        d.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    events.publish(preparedEvents);
    return {
      updated: normalized.length,
      layout_version: layoutVersion,
      took_ms: Math.round((performance.now() - started) * 1000) / 1000,
      updated_at: nowIso(),
    };
  }

  function internalRecompute(input, meta, { deleteAll = false } = {}) {
    const algorithm = input?.algorithm ?? FORCE_ALGORITHM;
    if (algorithm !== FORCE_ALGORITHM) {
      throw validationFailed([{ field: 'algorithm', message: `仅支持 ${FORCE_ALGORITHM}` }]);
    }
    let separation = 0.8;
    if (input?.cluster_separation !== undefined) {
      const n = Number(input.cluster_separation);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        throw validationFailed([{ field: 'cluster_separation', message: '必须在 0..1 之间' }]);
      }
      separation = n;
    }
    const preservePinned = input?.preserve_pinned === undefined ? true : Boolean(input.preserve_pinned);
    const d = db();
    const started = performance.now();
    const data = loadGraphData(d, { include_deleted: false });
    const clusterResult = computeClusters(data);
    const rows = loadRowsMap(d);
    const nodes = buildNodes(data, clusterResult, rows, { preservePinned });
    const positions = computeForceLayout({
      nodes,
      edges: edgesFor(data),
      clusters: clusterResult.clusters,
      clusterSeparation: separation,
    });
    let layoutVersion;
    let pinnedCount = 0;
    d.exec('BEGIN IMMEDIATE');
    try {
      if (deleteAll) d.exec('DELETE FROM layout_nodes');
      // 清理已硬删除节点的残留行
      const stale = [];
      for (const [key] of loadRowsMap(d)) {
        const [kind, id] = key.split(':');
        if (!nodeExistsInDb(d, kind, id)) stale.push(key);
      }
      for (const key of stale) {
        const [kind, id] = key.split(':');
        d.prepare('DELETE FROM layout_nodes WHERE node_kind = ? AND node_id = ?').run(kind, id);
      }
      for (const node of nodes) {
        const pos = positions.get(node.key);
        if (!pos) continue;
        if (node.pinned) pinnedCount += 1;
        upsertRow(d, {
          key: node.key,
          clusterId: node.cluster_id,
          x: pos.x,
          y: pos.y,
          z: pos.z,
          pinned: node.pinned,
        });
      }
      layoutVersion = bumpLayoutVersion(d);
      const tookMs = Math.round((performance.now() - started) * 1000) / 1000;
      const prepared = events.prepare(
        d,
        {
          type: 'layout.recomputed',
          actor: meta.actor,
          source: meta.source,
          subject: { kind: 'layout', id: null },
          payload: {
            algorithm,
            cluster_separation: separation,
            nodes: nodes.length,
            clusters: clusterResult.clusters.length,
            preserved_pinned: pinnedCount,
            reset: deleteAll,
            layout_version: layoutVersion,
            took_ms: tookMs,
          },
          trace_id: meta.traceId,
        },
        {},
      );
      d.exec('COMMIT');
      events.publish(prepared.event);
      return {
        algorithm,
        layout_version: layoutVersion,
        nodes: nodes.length,
        clusters: clusterResult.clusters.length,
        preserved_pinned: pinnedCount,
        took_ms: tookMs,
        reset: deleteAll,
      };
    } catch (err) {
      try {
        d.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  function recompute(input = {}, meta = {}) {
    return internalRecompute(input, meta);
  }

  function reset(meta = {}) {
    const result = internalRecompute({ algorithm: FORCE_ALGORITHM, preserve_pinned: false }, meta, { deleteAll: true });
    return { ...result, reset: true };
  }

  function getNodes({ node_kind = null, node_id = null } = {}) {
    const d = db();
    const where = [];
    const params = [];
    if (node_kind) {
      if (node_kind !== 'memory' && node_kind !== 'entity') {
        throw validationFailed([{ field: 'node_kind', message: '必须是 memory|entity' }]);
      }
      where.push('node_kind = ?');
      params.push(node_kind);
    }
    if (node_id) {
      where.push('node_id = ?');
      params.push(node_id);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = d.prepare(`SELECT * FROM layout_nodes ${whereSql} ORDER BY node_kind ASC, node_id ASC`).all(...params);
    return {
      items: rows.map(presentLayoutNode),
      total: rows.length,
      layout_version: getLayoutVersion(d),
    };
  }

  // ---------- 命名视图 ----------
  function normalizeCamera(camera, errors) {
    const out = { center: [0, 0, 0], zoom: 1 };
    if (camera === undefined || camera === null) return out;
    if (typeof camera !== 'object' || Array.isArray(camera)) {
      errors.push({ field: 'camera', message: '必须是对象' });
      return out;
    }
    if (camera.center !== undefined) {
      if (!Array.isArray(camera.center) || camera.center.length !== 3 || camera.center.some((v) => !Number.isFinite(Number(v)))) {
        errors.push({ field: 'camera.center', message: '必须是 3 个数字的数组' });
      } else out.center = camera.center.map(Number);
    }
    if (camera.zoom !== undefined) {
      const n = Number(camera.zoom);
      if (!Number.isFinite(n) || n <= 0 || n > 1000) errors.push({ field: 'camera.zoom', message: '必须在 (0,1000] 之间' });
      else out.zoom = n;
    }
    return out;
  }

  function listViews({ limit = 100, cursor = null } = {}) {
    const d = db();
    const parsedLimit = Math.min(MAX_VIEWS_PAGE, Math.max(1, Number(limit) || 100));
    let offset = 0;
    if (cursor) {
      try {
        offset = Number(JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')).o) || 0;
        if (!Number.isInteger(offset) || offset < 0) throw new Error('bad');
      } catch {
        throw badRequest('cursor 不合法');
      }
    }
    const total = Number(d.prepare('SELECT count(*) c FROM layout_views').get()?.c ?? 0);
    const rows = d
      .prepare('SELECT * FROM layout_views ORDER BY is_default DESC, created_at ASC LIMIT ? OFFSET ?')
      .all(parsedLimit, offset);
    const nextOffset = offset + rows.length;
    return {
      items: rows.map(presentLayoutView),
      next_cursor: nextOffset < total ? Buffer.from(JSON.stringify({ o: nextOffset }), 'utf8').toString('base64url') : null,
      total,
    };
  }

  function getView(viewId) {
    const d = db();
    const row = d.prepare('SELECT * FROM layout_views WHERE view_id = ?').get(viewId);
    if (!row) throw notFound(`布局视图不存在：${viewId}`);
    return presentLayoutView(row);
  }

  function defaultView() {
    const d = db();
    const row = d.prepare('SELECT * FROM layout_views WHERE is_default = 1 ORDER BY created_at ASC LIMIT 1').get();
    return row ? presentLayoutView(row) : null;
  }

  function createView(input, meta = {}) {
    const d = db();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('视图必须是 JSON 对象');
    const errors = [];
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) errors.push({ field: 'name', message: '视图名称必填' });
    else if (name.length > 200) errors.push({ field: 'name', message: '不得超过 200 字符' });
    const camera = normalizeCamera(input.camera, errors);
    let layerConfig = {};
    if (input.layer_config !== undefined) {
      if (!input.layer_config || typeof input.layer_config !== 'object' || Array.isArray(input.layer_config)) {
        errors.push({ field: 'layer_config', message: '必须是对象' });
      } else if (Buffer.byteLength(JSON.stringify(input.layer_config), 'utf8') > 64 * 1024) {
        errors.push({ field: 'layer_config', message: '不得超过 64KB' });
      } else layerConfig = input.layer_config;
    }
    const isDefault = Boolean(input.is_default);
    if (errors.length) throw validationFailed(errors);
    const existing = d.prepare('SELECT view_id FROM layout_views WHERE name = ?').get(name);
    if (existing) throw duplicate(existing.view_id, `视图名称已存在：${name}`);
    const now = nowIso();
    const viewId = newId('view');
    d.exec('BEGIN IMMEDIATE');
    let prepared;
    try {
      if (isDefault) d.prepare('UPDATE layout_views SET is_default = 0').run();
      d.prepare(
        'INSERT INTO layout_views(view_id, name, is_default, camera, layer_config, created_at, updated_at) VALUES(?,?,?,?,?,?,?)',
      ).run(viewId, name, isDefault ? 1 : 0, JSON.stringify(camera), JSON.stringify(layerConfig), now, now);
      prepared = events.prepare(
        d,
        {
          type: 'layout.view.saved',
          actor: meta.actor,
          source: meta.source,
          subject: { kind: 'layout_view', id: viewId },
          payload: { view_id: viewId, name, is_default: isDefault, action: 'created' },
          trace_id: meta.traceId,
        },
        {},
      );
      d.exec('COMMIT');
    } catch (err) {
      try {
        d.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    events.publish(prepared.event);
    return getView(viewId);
  }

  function deleteView(viewId, meta = {}) {
    const d = db();
    const row = d.prepare('SELECT * FROM layout_views WHERE view_id = ?').get(viewId);
    if (!row) throw notFound(`布局视图不存在：${viewId}`);
    d.exec('BEGIN IMMEDIATE');
    let prepared;
    try {
      d.prepare('DELETE FROM layout_views WHERE view_id = ?').run(viewId);
      prepared = events.prepare(
        d,
        {
          type: 'layout.view.saved',
          actor: meta.actor,
          source: meta.source,
          subject: { kind: 'layout_view', id: viewId },
          payload: { view_id: viewId, name: row.name, action: 'deleted' },
          trace_id: meta.traceId,
        },
        {},
      );
      d.exec('COMMIT');
    } catch (err) {
      try {
        d.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    events.publish(prepared.event);
    return { deleted: true, view_id: viewId, name: row.name };
  }

  function layoutForMemory(d, memoryId) {
    return presentLayoutNode(d.prepare("SELECT * FROM layout_nodes WHERE node_kind = 'memory' AND node_id = ?").get(memoryId));
  }

  return {
    ensureLayout,
    saveNodes,
    recompute,
    reset,
    getNodes,
    listViews,
    getView,
    defaultView,
    createView,
    deleteView,
    layoutForMemory,
    loadRowsMap,
    nodeKey,
  };
}
