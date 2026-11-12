// 关系 / 实体 / 标签 与图数据（真实 Runtime）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, startRuntime, disposeRuntime } from './helpers.js';

let rt;

before(async () => {
  rt = await startRuntime({ home: makeHome('relations') });
});
after(async () => {
  await disposeRuntime(rt);
});

async function createEntity(body) {
  const response = await rt.api('/api/v1/entities', { method: 'POST', body });
  return response;
}

test('实体 CRUD：种类/名称/别名校验、重名 DUPLICATE、乐观并发、软删', async () => {
  const created = await createEntity({
    kind: 'person',
    name: '李雷',
    description: '测试人物',
    aliases: ['小李'],
    metadata: { source: 'unit-test' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const entity = created.json;
  assert.match(entity.id, /^ent_[0-9a-f]{32}$/);
  assert.equal(entity.kind, 'person');
  assert.equal(entity.name, '李雷');
  assert.deepEqual(entity.aliases, ['小李']);
  assert.deepEqual(entity.metadata, { source: 'unit-test' });
  assert.equal(entity.version, 1);

  // 同 kind + name 重复
  const duplicate = await createEntity({ kind: 'person', name: '李雷' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error.code, 'DUPLICATE');
  assert.equal(typeof duplicate.json.error.details.existing_id, 'string');

  // 非法 kind → 422
  const invalid = await createEntity({ kind: 'alien', name: 'X' });
  assert.equal(invalid.status, 422);

  // 列表过滤
  const byKind = await rt.api('/api/v1/entities?kind=person');
  assert.ok(byKind.json.items.some((item) => item.id === entity.id));
  const byQ = await rt.api('/api/v1/entities?kind=person&q=李雷');
  assert.ok(byQ.json.items.some((item) => item.id === entity.id));

  // PATCH + 版本冲突
  const patched = await rt.api(`/api/v1/entities/${entity.id}`, {
    method: 'PATCH',
    body: { expected_version: 1, description: '更新后的描述' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.version, 2);
  assert.equal(patched.json.description, '更新后的描述');
  const conflict = await rt.api(`/api/v1/entities/${entity.id}`, { method: 'PATCH', body: { expected_version: 1, name: '李雷2' } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, 'VERSION_CONFLICT');
  assert.equal(conflict.json.error.details.current_version, 2);

  // 软删 + 同类型同名可重新创建
  const removed = await rt.api(`/api/v1/entities/${entity.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.notEqual(removed.json.deleted_at, null);
  const deletedDetail = await rt.api(`/api/v1/entities/${entity.id}`);
  assert.equal(deletedDetail.status, 200);
  const recreated = await createEntity({ kind: 'person', name: '李雷' });
  assert.equal(recreated.status, 201);
  assert.notEqual(recreated.json.id, entity.id);
  const listDefault = await rt.api('/api/v1/entities?kind=person&q=李雷');
  assert.equal(listDefault.json.items.some((item) => item.id === entity.id), false);
  const listDeleted = await rt.api('/api/v1/entities?kind=person&q=李雷&include_deleted=true');
  assert.ok(listDeleted.json.items.some((item) => item.id === entity.id));
});

test('关系：独立实体 CRUD、软删不删两端、端点校验、乐观并发', async () => {
  const person = (await createEntity({ kind: 'person', name: '韩梅梅' })).json;
  const memory = (
    await rt.api('/api/v1/memory/store', {
      method: 'POST',
      body: { title: '与韩梅梅旅行', body: '一起去看了海。', memory_type: 'episodic', participants: [{ entity_id: person.id, role: 'companion' }] },
    })
  ).json;

  // 记忆参与者自动派生关系（source_ref=auto:memory-links）
  const autoList = await rt.api(`/api/v1/relations?node_kind=memory&node_id=${memory.id}`);
  assert.equal(autoList.status, 200);
  const auto = autoList.json.items.find((item) => item.from.kind === 'entity' && item.from.id === person.id);
  assert.ok(auto, '记忆参与者应自动派生 participates_in 关系');
  assert.equal(auto.relation_type, 'participates_in');

  const created = await rt.api('/api/v1/relations', {
    method: 'POST',
    body: {
      from: { kind: 'entity', id: person.id },
      to: { kind: 'memory', id: memory.id },
      relation_type: 'shared_experience',
      directed: true,
      label: '共同经历',
      evidence: '手动建立',
      confidence: 0.9,
      weight: 1.2,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const relation = created.json;
  assert.match(relation.id, /^rel_[0-9a-f]{32}$/);
  assert.deepEqual(relation.from, { kind: 'entity', id: person.id });
  assert.deepEqual(relation.to, { kind: 'memory', id: memory.id });
  assert.equal(relation.relation_type, 'shared_experience');
  assert.equal(relation.label, '共同经历');
  assert.equal(relation.confidence, 0.9);
  assert.equal(relation.weight, 1.2);
  assert.equal(relation.version, 1);

  // PATCH + 并发冲突
  const patched = await rt.api(`/api/v1/relations/${relation.id}`, {
    method: 'PATCH',
    body: { expected_version: 1, label: '共同经历（已改）', confidence: 0.95 },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.version, 2);
  assert.equal(patched.json.label, '共同经历（已改）');
  const conflict = await rt.api(`/api/v1/relations/${relation.id}`, { method: 'PATCH', body: { expected_version: 1, label: 'x' } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, 'VERSION_CONFLICT');

  // 非法 relation_type / 缺少端点 / 端点不存在
  const invalidType = await rt.api('/api/v1/relations', {
    method: 'POST',
    body: { from: { kind: 'entity', id: person.id }, to: { kind: 'memory', id: memory.id }, relation_type: 'not-a-type' },
  });
  assert.equal(invalidType.status, 422);
  const missingEndpoint = await rt.api('/api/v1/relations', { method: 'POST', body: { from: { kind: 'entity', id: person.id } } });
  assert.equal(missingEndpoint.status, 422);
  const unknownEndpoint = await rt.api('/api/v1/relations', {
    method: 'POST',
    body: { from: { kind: 'entity', id: `ent_${'0'.repeat(32)}` }, to: { kind: 'memory', id: memory.id }, relation_type: 'custom' },
  });
  assert.equal(unknownEndpoint.status, 404);

  // 过滤：relation_type / node
  const byType = await rt.api(`/api/v1/relations?node_id=${memory.id}&relation_type=shared_experience`);
  assert.ok(byType.json.items.some((item) => item.id === relation.id));
  const byNodeKind = await rt.api(`/api/v1/relations?node_kind=entity&node_id=${person.id}`);
  assert.ok(byNodeKind.json.items.length >= 2);

  // 删除关系：两端对象仍存在
  const removed = await rt.api(`/api/v1/relations/${relation.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.notEqual(removed.json.deleted_at, null);
  assert.equal((await rt.api(`/api/v1/memory/${memory.id}`)).status, 200);
  assert.equal((await rt.api(`/api/v1/entities/${person.id}`)).status, 200);
  const defaultList = await rt.api(`/api/v1/relations?node_id=${memory.id}`);
  assert.equal(defaultList.json.items.some((item) => item.id === relation.id), false);
  const withDeleted = await rt.api(`/api/v1/relations?node_id=${memory.id}&include_deleted=true`);
  assert.ok(withDeleted.json.items.some((item) => item.id === relation.id));
});

test('标签：按名称自动创建/复用、目录计数、PATCH 替换标签', async () => {
  const first = (
    await rt.api('/api/v1/memory/store', { method: 'POST', body: { title: '标签记忆一', body: '内容一', tags: ['同名标签', '第二标签'] } })
  ).json;
  const second = (await rt.api('/api/v1/memory/store', { method: 'POST', body: { title: '标签记忆二', body: '内容二', tags: ['同名标签'] } })).json;
  assert.equal(first.tags.length, 2);
  const shared = first.tags[first.tag_names.indexOf('同名标签')];
  assert.equal(second.tags[0], shared, '同名标签应复用同一个 tag_ ID');

  const catalog = await rt.api('/api/v1/tags');
  assert.equal(catalog.status, 200);
  const sharedTag = catalog.json.items.find((item) => item.id === shared);
  assert.ok(sharedTag);
  assert.equal(sharedTag.name, '同名标签');
  assert.equal(sharedTag.count, 2);
  assert.ok(catalog.json.items.every((item) => /^tag_[0-9a-f]{32}$/.test(item.id)));

  const filtered = await rt.api('/api/v1/tags?q=第二');
  assert.deepEqual(
    filtered.json.items.map((item) => item.name),
    ['第二标签'],
  );

  // PATCH 用标签 ID 替换 → 旧标签从该记忆移除
  const other = catalog.json.items.find((item) => item.name === '第二标签');
  const patched = await rt.api(`/api/v1/memory/${first.id}`, {
    method: 'PATCH',
    body: { tags: [{ id: other.id, name: other.name }] },
  });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.json.tag_names, ['第二标签']);
  // 记忆搜索按标签过滤
  const search = await rt.api('/api/v1/memory/search', { method: 'POST', body: { query: '标签记忆', filters: { tags: ['同名标签'] } } });
  assert.deepEqual(
    search.json.items.map((item) => item.memory.id),
    [second.id],
  );
});

test('图数据 /graph：节点/边/聚类来自真实数据，坐标已持久化且满足渲染契约', async () => {
  const graph = await rt.api('/api/v1/graph');
  assert.equal(graph.status, 200);
  const body = graph.json;
  assert.equal(body.api_version, '1');
  assert.ok(Array.isArray(body.nodes));
  assert.ok(Array.isArray(body.edges));
  assert.ok(Array.isArray(body.clusters));
  assert.equal(body.stats.nodes, body.nodes.length);
  assert.equal(body.stats.edges, body.edges.length);
  assert.ok(Number.isInteger(body.layout_version));
  assert.ok(body.layout_version >= 1);

  assert.ok(body.nodes.length >= 2);
  for (const node of body.nodes) {
    assert.ok(['memory', 'entity'].includes(node.kind));
    assert.equal(typeof node.label, 'string');
    assert.ok(node.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y) && Number.isFinite(node.position.z));
    assert.ok(node.position.x >= -5000 && node.position.x <= 5000);
    assert.ok(node.position.y >= -5000 && node.position.y <= 5000);
    assert.ok(node.position.z >= -800 && node.position.z <= 800);
    assert.ok(typeof node.cluster_id === 'string');
    assert.ok(typeof node.degree === 'number');
    assert.ok(Array.isArray(node.tags));
  }
  const nodeIds = new Set(body.nodes.map((node) => node.id));
  for (const edge of body.edges) {
    assert.ok(nodeIds.has(edge.from));
    assert.ok(nodeIds.has(edge.to));
    assert.ok(typeof edge.relation_type === 'string');
    assert.ok(edge.directed === true || edge.directed === false);
    assert.equal(typeof edge.weight, 'number');
  }
  for (const cluster of body.clusters) {
    assert.ok(cluster.node_ids.length >= 1);
    assert.ok(cluster.node_ids.every((id) => nodeIds.has(id)));
    assert.ok(Number.isFinite(cluster.centroid.x));
    assert.ok(Number.isFinite(cluster.density));
    assert.ok(Array.isArray(cluster.dominant_types));
    assert.ok(typeof cluster.color_hint === 'string');
  }
  // 所有节点都应落在某个 cluster 中（真实分配的聚类）
  const clustered = new Set(body.clusters.flatMap((cluster) => cluster.node_ids));
  for (const node of body.nodes) assert.ok(clustered.has(node.id), `节点 ${node.id} 未分配聚类`);
});
