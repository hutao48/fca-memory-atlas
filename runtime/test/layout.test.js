// 布局：force_v1 确定性自动布局 / 坐标持久化 / 拖拽只写布局表（不修改记忆）/ 命名视图（真实 Runtime）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, startRuntime, disposeRuntime } from './helpers.js';

let rt;
const memoryIds = [];

before(async () => {
  rt = await startRuntime({ home: makeHome('layout') });
  const person = (
    await rt.api('/api/v1/entities', { method: 'POST', body: { kind: 'person', name: '布局助手' } })
  ).json;
  for (let i = 0; i < 4; i += 1) {
    const response = await rt.api('/api/v1/memory/store', {
      method: 'POST',
      body: {
        title: `布局记忆 ${i}`,
        body: `布局测试正文 ${i}`,
        memory_type: i === 0 ? 'project' : 'episodic',
        tags: [i % 2 === 0 ? '布局标签A' : '布局标签B'],
        participants: [{ entity_id: person.id }],
      },
    });
    assert.equal(response.status, 201);
    memoryIds.push(response.json.id);
  }
  // 建立一条关系
  const relation = await rt.api('/api/v1/relations', {
    method: 'POST',
    body: {
      from: { kind: 'memory', id: memoryIds[0] },
      to: { kind: 'memory', id: memoryIds[1] },
      relation_type: 'temporal_after',
      directed: true,
    },
  });
  assert.equal(relation.status, 201);
  // 一次 /graph 触发首次全量布局
  const graph = await rt.api('/api/v1/graph');
  assert.equal(graph.status, 200);
});

after(async () => {
  await disposeRuntime(rt);
});

test('首次渲染自动布局：所有节点持久化坐标、在边界内、layout_version 递增', async () => {
  const graph = await rt.api('/api/v1/graph');
  assert.ok(graph.json.nodes.length >= 5);
  assert.ok(graph.json.layout_version >= 1);

  const nodes = await rt.api('/api/v1/layout/nodes');
  assert.equal(nodes.status, 200);
  assert.equal(nodes.json.total, graph.json.nodes.length);
  assert.equal(nodes.json.layout_version, graph.json.layout_version);
  for (const item of nodes.json.items) {
    assert.ok(['memory', 'entity'].includes(item.node_kind));
    assert.ok(item.x >= -5000 && item.x <= 5000);
    assert.ok(item.y >= -5000 && item.y <= 5000);
    assert.ok(item.z >= -800 && item.z <= 800);
    assert.equal(typeof item.updated_at, 'string');
  }
});

test('拖拽星体：只写布局表，不修改记忆正文/版本/关系（布局隔离）', async () => {
  const targetId = memoryIds[0];
  const before = await rt.api(`/api/v1/memory/${targetId}`);
  assert.equal(before.status, 200);
  const beforeMemory = before.json.memory;
  const beforeRelations = before.json.relations.length;

  const moved = await rt.api('/api/v1/layout/nodes', {
    method: 'POST',
    body: { updates: [{ node_kind: 'memory', node_id: targetId, x: 321.5, y: -88.25, z: 12.75, pinned: true }] },
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.updated, 1);
  assert.ok(moved.json.layout_version >= 2);

  const after = await rt.api(`/api/v1/memory/${targetId}`);
  assert.equal(after.status, 200);
  const afterMemory = after.json.memory;
  assert.equal(afterMemory.title, beforeMemory.title);
  assert.equal(afterMemory.body, beforeMemory.body);
  assert.equal(afterMemory.version, beforeMemory.version, '拖拽不得改变记忆版本');
  assert.equal(afterMemory.updated_at, beforeMemory.updated_at, '拖拽不得改变记忆 updated_at');
  assert.equal(after.json.relations.length, beforeRelations, '拖拽不得增删关系');
  // 记忆详情中的 layout 字段读取的是布局表
  assert.equal(after.json.layout.x, 321.5);
  assert.equal(after.json.layout.y, -88.25);
  assert.equal(after.json.layout.z, 12.75);
  assert.equal(after.json.layout.pinned, true);

  const layout = await rt.api(`/api/v1/layout/nodes?node_kind=memory&node_id=${targetId}`);
  assert.equal(layout.json.items.length, 1);
  assert.equal(layout.json.items[0].x, 321.5);
  assert.equal(layout.json.items[0].pinned, true);

  // graph 节点位置与 pinned 同步
  const graph = await rt.api('/api/v1/graph');
  const node = graph.json.nodes.find((item) => item.id === targetId);
  assert.equal(node.pinned, true);
  assert.deepEqual(node.position, { x: 321.5, y: -88.25, z: 12.75 });
});

test('recompute(force_v1)：保留 pinned 坐标、对相同输入确定（两次结果一致）', async () => {
  const targetId = memoryIds[0];
  const first = await rt.api('/api/v1/layout/recompute', {
    method: 'POST',
    body: { algorithm: 'force_v1', cluster_separation: 0.8 },
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.algorithm, 'force_v1');
  assert.ok(first.json.nodes >= 5);
  assert.ok(first.json.preserved_pinned >= 1);

  const pinnedAfter = await rt.api(`/api/v1/layout/nodes?node_id=${targetId}`);
  assert.equal(pinnedAfter.json.items[0].x, 321.5, 'pinned 节点坐标在重算后必须保持');
  assert.equal(pinnedAfter.json.items[0].y, -88.25);
  assert.equal(pinnedAfter.json.items[0].pinned, true);

  const nodesA = (await rt.api('/api/v1/layout/nodes')).json.items;
  const second = await rt.api('/api/v1/layout/recompute', { method: 'POST', body: { algorithm: 'force_v1' } });
  assert.equal(second.status, 200);
  const nodesB = (await rt.api('/api/v1/layout/nodes')).json.items;
  assert.deepEqual(
    nodesB.map((item) => [item.node_kind, item.node_id, item.x, item.y, item.z, item.pinned]),
    nodesA.map((item) => [item.node_kind, item.node_id, item.x, item.y, item.z, item.pinned]),
    'force_v1 必须确定性：相同输入两次布局结果一致',
  );

  // 非法算法 / cluster_separation → 422
  const badAlgorithm = await rt.api('/api/v1/layout/recompute', { method: 'POST', body: { algorithm: 'force_v2' } });
  assert.equal(badAlgorithm.status, 422);
  const badSeparation = await rt.api('/api/v1/layout/recompute', { method: 'POST', body: { cluster_separation: 2 } });
  assert.equal(badSeparation.status, 422);
});

test('reset：清空手动坐标并重算（pinned 全部清除）', async () => {
  const reset = await rt.api('/api/v1/layout/reset', { method: 'POST', body: {} });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.reset, true);
  assert.equal(reset.json.preserved_pinned, 0);
  const nodes = await rt.api('/api/v1/layout/nodes');
  assert.ok(nodes.json.items.length >= 5);
  assert.ok(nodes.json.items.every((item) => item.pinned === false), 'reset 后不应残留 pinned');
  // reset 也不改变记忆
  const memory = await rt.api(`/api/v1/memory/${memoryIds[0]}`);
  assert.equal(memory.json.memory.version, 1);
});

test('保存坐标校验：不存在节点 404、越界/空数组/重复节点 422', async () => {
  const unknown = await rt.api('/api/v1/layout/nodes', {
    method: 'POST',
    body: { updates: [{ node_kind: 'memory', node_id: `mem_${'0'.repeat(32)}`, x: 1, y: 2 }] },
  });
  assert.equal(unknown.status, 404);
  const outOfBounds = await rt.api('/api/v1/layout/nodes', {
    method: 'POST',
    body: { updates: [{ node_kind: 'memory', node_id: memoryIds[1], x: 99999, y: 0 }] },
  });
  assert.equal(outOfBounds.status, 422);
  const empty = await rt.api('/api/v1/layout/nodes', { method: 'POST', body: { updates: [] } });
  assert.equal(empty.status, 422);
  const duplicate = await rt.api('/api/v1/layout/nodes', {
    method: 'POST',
    body: {
      updates: [
        { node_kind: 'memory', node_id: memoryIds[1], x: 1, y: 1 },
        { node_kind: 'memory', node_id: memoryIds[1], x: 2, y: 2 },
      ],
    },
  });
  assert.equal(duplicate.status, 422);
  const badKind = await rt.api('/api/v1/layout/nodes', {
    method: 'POST',
    body: { updates: [{ node_kind: 'tag', node_id: memoryIds[1], x: 1, y: 1 }] },
  });
  assert.equal(badKind.status, 422);
});

test('命名视图：创建/列表/默认视图生效于 /graph/删除/重名冲突', async () => {
  const created = await rt.api('/api/v1/layout/views', {
    method: 'POST',
    body: {
      name: '俯视图',
      is_default: true,
      camera: { center: [10, 20, 30], zoom: 2 },
      layer_config: { edges: true, labels: false },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.match(created.json.view_id, /^view_[0-9a-f]{32}$/);
  assert.equal(created.json.id, created.json.view_id);
  assert.deepEqual(created.json.camera.center, [10, 20, 30]);
  assert.equal(created.json.camera.zoom, 2);
  assert.deepEqual(created.json.layer_config, { edges: true, labels: false });
  assert.equal(created.json.is_default, true);

  const list = await rt.api('/api/v1/layout/views');
  assert.ok(list.json.items.some((item) => item.view_id === created.json.view_id));

  const graph = await rt.api('/api/v1/graph');
  assert.deepEqual(graph.json.view.center, [10, 20, 30]);
  assert.equal(graph.json.view.zoom, 2);
  assert.equal(graph.json.view.view_id, created.json.view_id);

  // 同视图名 → 409 DUPLICATE
  const duplicate = await rt.api('/api/v1/layout/views', { method: 'POST', body: { name: '俯视图' } });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error.code, 'DUPLICATE');
  // 非法 camera → 422
  const invalid = await rt.api('/api/v1/layout/views', { method: 'POST', body: { name: '非法视图', camera: { center: [1, 2] } } });
  assert.equal(invalid.status, 422);

  // 删除视图后 graph 回到默认相机
  const removed = await rt.api(`/api/v1/layout/views/${created.json.view_id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.deleted, true);
  const graphAfter = await rt.api('/api/v1/graph');
  assert.deepEqual(graphAfter.json.view.center, [0, 0, 0]);
  assert.equal(graphAfter.json.view.zoom, 1);
  const listAfter = await rt.api('/api/v1/layout/views');
  assert.equal(listAfter.json.items.some((item) => item.view_id === created.json.view_id), false);
  // 契约只提供列表读取（无单视图 GET），重复 DELETE → 404
  const removedAgain = await rt.api(`/api/v1/layout/views/${created.json.view_id}`, { method: 'DELETE' });
  assert.equal(removedAgain.status, 404);
  assert.equal(removedAgain.json.error.code, 'NOT_FOUND');
});
