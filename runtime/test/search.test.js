// 搜索：FTS5 中文 bigram / 英文 / 高亮 / 语义 / 混合 / 筛选 / 分页（真实 Runtime）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, startRuntime, disposeRuntime } from './helpers.js';

let rt;
const ids = {};

before(async () => {
  rt = await startRuntime({ home: makeHome('search') });
  const create = async (body) => {
    const response = await rt.api('/api/v1/memory/store', { method: 'POST', body });
    assert.equal(response.status, 201, JSON.stringify(response.json));
    return response.json;
  };
  ids.cat = await create({
    title: '我的猫叫煤球',
    body: '煤球是一只黑色的猫，最喜欢在阳台晒太阳。',
    memory_type: 'episodic',
    occurred_at: '2026-04-01T00:00:00.000Z',
    importance: 0.8,
    tags: ['宠物', '猫'],
  });
  ids.ai = await create({
    title: '人工智能架构讨论',
    body: '讨论了人工智能系统的记忆架构与检索增强生成。',
    memory_type: 'semantic',
    occurred_at: '2026-05-01T00:00:00.000Z',
    importance: 0.6,
  });
  ids.english = await create({
    title: 'Alpha Runtime integration',
    body: 'Completed the runtime integration for project Alpha.',
    memory_type: 'project',
    occurred_at: '2026-06-01T00:00:00.000Z',
  });
  ids.deleted = await create({ title: '已删除的搜索结果', body: '这条会被软删，不应出现在默认搜索中。' });
  await rt.api(`/api/v1/memory/${ids.deleted.id}`, { method: 'DELETE' });
});

after(async () => {
  await disposeRuntime(rt);
});

function searchIds(response) {
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return response.json.items.map((item) => item.memory.id);
}

test('全文搜索：中文 bigram 命中（二字/多字/单字），不相关词不命中', async () => {
  const twoChar = await rt.api('/api/v1/memory/search', { method: 'POST', body: { query: '煤球', mode: 'fulltext', limit: 10 } });
  assert.ok(searchIds(twoChar).includes(ids.cat.id));
  assert.equal(twoChar.json.items[0].memory.id, ids.cat.id);
  const threeChar = await rt.api('/api/v1/memory/search', { method: 'POST', body: { query: '人工智', mode: 'fulltext' } });
  assert.ok(searchIds(threeChar).includes(ids.ai.id));
  // 单字走 unigram
  const oneChar = await rt.api('/api/v1/memory/search', { method: 'POST', body: { query: '猫', mode: 'fulltext' } });
  assert.ok(searchIds(oneChar).includes(ids.cat.id));
  // 不相关
  const unrelated = await rt.api('/api/v1/memory/search', { method: 'POST', body: { query: '宇宙飞船', mode: 'fulltext' } });
  assert.equal(unrelated.json.items.length, 0);
  assert.equal(unrelated.json.total, 0);
});

test('全文搜索：英文大小写不敏感 + 高亮 <mark> + 匹配字段', async () => {
  const english = await rt.api('/api/v1/memory/search', { method: 'POST', body: { query: 'alpha runtime', mode: 'fulltext' } });
  assert.ok(searchIds(english).includes(ids.english.id));
  const lower = await rt.api('/api/v1/memory/search', { method: 'POST', body: { query: 'ALPHA', mode: 'fulltext' } });
  assert.ok(searchIds(lower).includes(ids.english.id));
  const hit = english.json.items.find((item) => item.memory.id === ids.english.id);
  assert.ok(Array.isArray(hit.highlights));
  assert.ok(hit.highlights.length >= 1);
  const html = hit.highlights.map((entry) => entry.snippet).join('\n');
  assert.match(html, /<mark>/);
  assert.ok(['title', 'body', 'tags'].includes(hit.highlights[0].field));
  assert.ok(Array.isArray(hit.matched_by));
  assert.ok(hit.score !== undefined);
});

test('全文搜索：标签与正文也可命中；软删记忆默认排除、include_deleted 可查', async () => {
  const byTag = await rt.api('/api/v1/memory/search', { method: 'POST', body: { query: '宠物', mode: 'fulltext' } });
  assert.ok(searchIds(byTag).includes(ids.cat.id));
  const byBody = await rt.api('/api/v1/memory/search', { method: 'POST', body: { query: '阳台晒太阳', mode: 'fulltext' } });
  assert.ok(searchIds(byBody).includes(ids.cat.id));

  const deletedDefault = await rt.api('/api/v1/memory/search', { method: 'POST', body: { query: '已删除的搜索结果' } });
  assert.equal(deletedDefault.json.items.some((item) => item.memory.id === ids.deleted.id), false);
  const deletedIncluded = await rt.api('/api/v1/memory/search', { method: 'POST', body: { query: '已删除的搜索结果', include_deleted: true } });
  assert.ok(deletedIncluded.json.items.some((item) => item.memory.id === ids.deleted.id));
});

test('语义搜索与混合搜索：返回真实排序结果与引擎信息', async () => {
  const semantic = await rt.api('/api/v1/memory/search', { method: 'POST', body: { query: '黑色的猫', mode: 'semantic', limit: 5 } });
  assert.equal(semantic.status, 200);
  assert.equal(semantic.json.mode, 'semantic');
  assert.equal(semantic.json.engine.semantic, 'local-hash-v1');
  assert.ok(semantic.json.items.length >= 1);
  assert.equal(semantic.json.took_ms >= 0, true);

  const hybrid = await rt.api('/api/v1/memory/search', { method: 'POST', body: { query: '人工智能 记忆', mode: 'hybrid', limit: 5 } });
  assert.equal(hybrid.status, 200);
  assert.equal(hybrid.json.mode, 'hybrid');
  assert.ok(hybrid.json.items.length >= 1);
  assert.deepEqual([...new Set(hybrid.json.items.flatMap((item) => item.matched_by))].sort(), ['fulltext', 'semantic']);

  const invalidMode = await rt.api('/api/v1/memory/search', { method: 'POST', body: { query: 'x', mode: 'magic' } });
  assert.equal(invalidMode.status, 422);
  assert.equal(invalidMode.json.error.code, 'VALIDATION_FAILED');
});

test('搜索筛选：memory_type / tags / occurred 时间区间 / limit 分页', async () => {
  const byType = await rt.api('/api/v1/memory/search', {
    method: 'POST',
    body: { query: '架构', mode: 'fulltext', filters: { types: ['semantic'] } },
  });
  assert.ok(searchIds(byType).includes(ids.ai.id));
  assert.equal(searchIds(byType).includes(ids.cat.id), false);

  const byTag = await rt.api('/api/v1/memory/search', {
    method: 'POST',
    body: { query: '猫', mode: 'fulltext', filters: { tags: ['宠物'] } },
  });
  assert.ok(searchIds(byTag).includes(ids.cat.id));

  const byRange = await rt.api('/api/v1/memory/search', {
    method: 'POST',
    body: { query: '的', mode: 'fulltext', filters: { occurred_from: '2026-03-01T00:00:00.000Z', occurred_to: '2026-04-30T00:00:00.000Z' } },
  });
  assert.ok(searchIds(byRange).includes(ids.cat.id));
  assert.equal(searchIds(byRange).includes(ids.ai.id), false);

  const page1 = await rt.api('/api/v1/memory/search', { method: 'POST', body: { query: '的', limit: 1 } });
  assert.equal(page1.status, 200);
  assert.equal(page1.json.items.length, 1);
  assert.equal(typeof page1.json.next_cursor, 'string');
  const page2 = await rt.api('/api/v1/memory/search', { method: 'POST', body: { query: '的', limit: 1, cursor: page1.json.next_cursor } });
  assert.equal(page2.status, 200);
  assert.notEqual(page2.json.items[0].memory.id, page1.json.items[0].memory.id);
  const badCursor = await rt.api('/api/v1/memory/search', { method: 'POST', body: { query: '的', cursor: 'bad-cursor' } });
  assert.equal(badCursor.status, 422);
});

test('空查询返回最近记忆（recent 模式），非法过滤条件如实 422', async () => {
  const recent = await rt.api('/api/v1/memory/search', { method: 'POST', body: { query: '', limit: 3 } });
  assert.equal(recent.status, 200);
  assert.equal(recent.json.mode, 'recent');
  assert.ok(recent.json.items.length >= 1);
  assert.ok(recent.json.items.every((item) => item.score === 0));

  const badFilter = await rt.api('/api/v1/memory/search', {
    method: 'POST',
    body: { query: '猫', filters: { types: ['not-a-type'] } },
  });
  assert.equal(badFilter.status, 422);
  const overflowQuery = await rt.api('/api/v1/memory/search', { method: 'POST', body: { query: 'x'.repeat(2001) } });
  assert.equal(overflowQuery.status, 422);
});
