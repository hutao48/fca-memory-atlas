// 记忆 CRUD / 版本历史 / diff / 软删+回收站 / 合并 / 拆分 / 乐观并发（真实 Runtime + 真实 HTTP）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, startRuntime, disposeRuntime } from './helpers.js';

let rt;

before(async () => {
  rt = await startRuntime({ home: makeHome('memory') });
});
after(async () => {
  await disposeRuntime(rt);
});

async function createMemory(overrides = {}) {
  const response = await rt.api('/api/v1/memory/store', {
    method: 'POST',
    body: {
      title: '默认记忆',
      body: '默认正文',
      memory_type: 'episodic',
      ...overrides,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return response.json;
}

test('创建记忆：契约字段完整、ID 规则、实体/标签自动解析、默认精度规则', async () => {
  const memory = await createMemory({
    title: '与张三讨论项目A',
    body: '2026 年春季，与张三讨论了项目A 的架构。',
    occurred_at: '2026-03-01T10:00:00.000Z',
    occurred_precision: 'exact',
    tags: ['架构', '项目A'],
    participants: [{ name: '张三' }],
    project: { name: '项目A' },
    emotion: { valence: 0.4, arousal: 0.5, label: '平静' },
    credibility: 0.9,
    importance: 0.8,
    display_weight: 1.5,
  });
  assert.match(memory.id, /^mem_[0-9a-f]{32}$/);
  assert.equal(memory.title, '与张三讨论项目A');
  assert.equal(memory.memory_type, 'episodic');
  assert.equal(memory.occurred_at, '2026-03-01T10:00:00.000Z');
  assert.equal(memory.occurred_precision, 'exact');
  assert.equal(memory.credibility, 0.9);
  assert.equal(memory.importance, 0.8);
  assert.equal(memory.display_weight, 1.5);
  assert.equal(memory.version, 1);
  assert.equal(memory.deleted_at, null);
  assert.equal(memory.origin, 'user');
  assert.equal(memory.agent_generated, false);
  assert.equal(memory.created_by.kind, 'user');
  // 标签被解析为 tag_ ID，且响应同含 tag_names
  assert.equal(memory.tags.length, 2);
  assert.ok(memory.tags.every((id) => /^tag_[0-9a-f]{32}$/.test(id)));
  assert.deepEqual([...memory.tag_names].sort(), ['架构', '项目A'].sort());
  // 参与者/项目被解析为实体
  assert.equal(memory.participants.length, 1);
  assert.match(memory.participants[0].entity_id, /^ent_[0-9a-f]{32}$/);
  assert.equal(memory.participants[0].name, '张三');
  assert.equal(memory.participants[0].role, 'participant');
  assert.match(memory.project.entity_id, /^ent_[0-9a-f]{32}$/);
  assert.equal(memory.project.name, '项目A');
  assert.deepEqual(memory.emotion, { valence: 0.4, arousal: 0.5, label: '平静' });

  // 无 occurred_at → precision=unknown
  const noTime = await createMemory({ title: '没有时间的记忆' });
  assert.equal(noTime.occurred_at, null);
  assert.equal(noTime.occurred_precision, 'unknown');

  // 校验失败：缺标题 / 非法 memory_type / 非法 occurred_at
  const missingTitle = await rt.api('/api/v1/memory/store', { method: 'POST', body: { body: 'x' } });
  assert.equal(missingTitle.status, 422);
  assert.equal(missingTitle.json.error.code, 'VALIDATION_FAILED');
  assert.ok(missingTitle.json.error.details.fields.some((field) => field.field === 'title'));
  const badType = await rt.api('/api/v1/memory/store', { method: 'POST', body: { title: 'x', memory_type: 'not-a-type' } });
  assert.equal(badType.status, 422);
  const badTime = await rt.api('/api/v1/memory/store', { method: 'POST', body: { title: 'x', occurred_at: 'not-a-time' } });
  assert.equal(badTime.status, 422);
});

test('详情/版本历史：PATCH 生成新版本、快照与 RFC6902 diff 可读', async () => {
  const memory = await createMemory({ title: '版本测试 v1', body: '第一版正文' });
  const detail = await rt.api(`/api/v1/memory/${memory.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.memory.version, 1);
  assert.equal(detail.json.versions_count, 1);
  assert.ok(Array.isArray(detail.json.relations));
  assert.equal(detail.json.layout, null);

  const patched = await rt.api(`/api/v1/memory/${memory.id}`, {
    method: 'PATCH',
    body: { expected_version: 1, title: '版本测试 v2', importance: 0.9 },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.version, 2);
  assert.equal(patched.json.title, '版本测试 v2');
  assert.equal(patched.json.updated_by.kind, 'user');

  const versions = await rt.api(`/api/v1/memory/${memory.id}/versions`);
  assert.equal(versions.status, 200);
  assert.equal(versions.json.total, 2);
  assert.deepEqual(
    versions.json.items.map((item) => item.version),
    [2, 1],
  );
  assert.equal(versions.json.items[0].change_kind, 'update');
  assert.equal(versions.json.items[1].change_kind, 'create');
  assert.equal(versions.json.items[1].snapshot.title, '版本测试 v1');
  assert.ok(Array.isArray(versions.json.items[0].diff));
  assert.ok(versions.json.items[0].diff.some((op) => op.path === '/title' && op.value === '版本测试 v2'));
  assert.ok(versions.json.items[0].ver_id.startsWith('ver_'));
  assert.equal(versions.json.next_cursor, null);

  // 历史版本读取
  const old = await rt.api(`/api/v1/memory/${memory.id}?version=1`);
  assert.equal(old.status, 200);
  assert.equal(old.json.memory.title, '版本测试 v1');
  assert.equal(old.json.version_view, 1);
  const missingVersion = await rt.api(`/api/v1/memory/${memory.id}?version=99`);
  assert.equal(missingVersion.status, 404);

  // diff 1 -> 2
  const diff = await rt.api(`/api/v1/memory/${memory.id}/diff?from=1&to=2`);
  assert.equal(diff.status, 200);
  assert.equal(diff.json.from_version, 1);
  assert.equal(diff.json.to_version, 2);
  assert.equal(diff.json.current_version, 2);
  assert.ok(Array.isArray(diff.json.operations));
  assert.ok(diff.json.operations.some((op) => op.path === '/title'));
  const missingDiff = await rt.api(`/api/v1/memory/${memory.id}/diff?from=1`);
  assert.equal(missingDiff.status, 422);

  // 历史版本不可修改（软删除后仍可读历史）
  await rt.api(`/api/v1/memory/${memory.id}`, { method: 'DELETE' });
  const versionsAfterDelete = await rt.api(`/api/v1/memory/${memory.id}/versions`);
  assert.equal(versionsAfterDelete.status, 200);
  assert.equal(versionsAfterDelete.json.total, 3);
  assert.equal(versionsAfterDelete.json.items[0].change_kind, 'delete');
});

test('乐观并发：expected_version 冲突返回 409 VERSION_CONFLICT（含 current_version），旧版本号不可覆盖', async () => {
  const memory = await createMemory({ title: '并发测试' });
  const first = await rt.api(`/api/v1/memory/${memory.id}`, { method: 'PATCH', body: { expected_version: 1, title: '并发测试 A' } });
  assert.equal(first.status, 200);
  assert.equal(first.json.version, 2);
  const conflict = await rt.api(`/api/v1/memory/${memory.id}`, { method: 'PATCH', body: { expected_version: 1, title: '并发测试 B' } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, 'VERSION_CONFLICT');
  assert.equal(conflict.json.error.details.current_version, 2);
  // 非法 expected_version → 422
  const invalid = await rt.api(`/api/v1/memory/${memory.id}`, { method: 'PATCH', body: { expected_version: 0, title: 'x' } });
  assert.equal(invalid.status, 422);
  // 无任何可更新字段 → 422
  const empty = await rt.api(`/api/v1/memory/${memory.id}`, { method: 'PATCH', body: {} });
  assert.equal(empty.status, 422);
});

test('列表查询：结构化筛选 / q 搜索 / 排序 / 分页 / 回收站开关', async () => {
  const alpha = await createMemory({ title: '列表-Alpha', body: '搜索引擎优化', memory_type: 'project', importance: 0.9, tags: ['列表标签'] });
  const beta = await createMemory({ title: '列表-Beta', body: '普通记录', memory_type: 'episodic', importance: 0.1 });
  const gamma = await createMemory({ title: '列表-Gamma', body: '被删除的记录', memory_type: 'semantic', importance: 0.5 });
  await rt.api(`/api/v1/memory/${gamma.id}`, { method: 'DELETE' });

  // memory_type 过滤
  const byType = await rt.api('/api/v1/memories?memory_type=project&q=列表-Alpha');
  assert.equal(byType.status, 200);
  assert.ok(byType.json.items.some((item) => item.id === alpha.id));
  assert.equal(byType.json.items.some((item) => item.id === beta.id), false);
  assert.equal(typeof byType.json.total, 'number');
  assert.ok(Array.isArray(byType.json.items));

  // q 模糊搜索（标题/正文/标签）
  const byQ = await rt.api('/api/v1/memories?q=搜索引擎');
  assert.ok(byQ.json.items.some((item) => item.id === alpha.id));
  const byTagQ = await rt.api('/api/v1/memories?q=列表标签');
  assert.ok(byTagQ.json.items.some((item) => item.id === alpha.id));

  // 排序 -importance
  const sorted = await rt.api('/api/v1/memories?q=列表-&sort=-importance&limit=2');
  assert.equal(sorted.status, 200);
  assert.ok(sorted.json.items.length <= 2);
  const sortedAsc = await rt.api('/api/v1/memories?q=列表-&sort=importance&limit=500');
  const values = sortedAsc.json.items.map((item) => item.importance);
  assert.deepEqual(values, [...values].sort((a, b) => a - b));

  // 分页 cursor
  const page1 = await rt.api('/api/v1/memories?limit=1');
  assert.equal(page1.status, 200);
  assert.equal(page1.json.items.length, 1);
  assert.equal(typeof page1.json.next_cursor, 'string');
  const page2 = await rt.api(`/api/v1/memories?limit=1&cursor=${encodeURIComponent(page1.json.next_cursor)}`);
  assert.equal(page2.status, 200);
  assert.notEqual(page2.json.items[0].id, page1.json.items[0].id);
  const badCursor = await rt.api('/api/v1/memories?cursor=not-a-cursor');
  assert.equal(badCursor.status, 400);
  assert.equal(badCursor.json.error.code, 'BAD_REQUEST');

  // 默认排除软删；only_deleted / include_deleted
  const normal = await rt.api('/api/v1/memories?q=列表-Gamma');
  assert.equal(normal.json.items.length, 0);
  const onlyDeleted = await rt.api('/api/v1/memories?only_deleted=true&q=列表-Gamma');
  assert.ok(onlyDeleted.json.items.some((item) => item.id === gamma.id));
  const includeDeleted = await rt.api('/api/v1/memories?include_deleted=true&q=列表-Gamma');
  assert.ok(includeDeleted.json.items.some((item) => item.id === gamma.id));

  // 非法 sort → 422
  const badSort = await rt.api('/api/v1/memories?sort=not-a-column');
  assert.equal(badSort.status, 422);
});

test('软删除 / 回收站恢复 / 硬删除（GONE + 关系与索引清理）', async () => {
  const memory = await createMemory({ title: '回收站测试', body: '将被软删' });
  const soft = await rt.api(`/api/v1/memory/${memory.id}`, { method: 'DELETE' });
  assert.equal(soft.status, 200);
  assert.equal(soft.json.already_deleted, false);
  assert.equal(soft.json.memory.deleted_at !== null, true);
  const softAgain = await rt.api(`/api/v1/memory/${memory.id}`, { method: 'DELETE' });
  assert.equal(softAgain.status, 200);
  assert.equal(softAgain.json.already_deleted, true);

  // 软删后搜索不返回，include_deleted 可查
  const search = await rt.api('/api/v1/memory/search', { method: 'POST', body: { query: '回收站测试', limit: 10 } });
  assert.equal(search.json.items.some((item) => item.memory.id === memory.id), false);
  const searchDeleted = await rt.api('/api/v1/memory/search', { method: 'POST', body: { query: '回收站测试', include_deleted: true } });
  assert.ok(searchDeleted.json.items.some((item) => item.memory.id === memory.id));

  // 恢复：版本+1，change_kind=restore
  const restored = await rt.api(`/api/v1/memory/${memory.id}/restore`, { method: 'POST', body: {} });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.deleted_at, null);
  const versions = await rt.api(`/api/v1/memory/${memory.id}/versions`);
  assert.equal(versions.json.items[0].change_kind, 'restore');

  // 硬删除需要显式 confirm；缺 confirm → 403 FORBIDDEN
  const hardNoConfirm = await rt.api(`/api/v1/memory/${memory.id}?hard=true`, { method: 'DELETE' });
  assert.equal(hardNoConfirm.status, 403);
  assert.equal(hardNoConfirm.json.error.code, 'FORBIDDEN');
  const hard = await rt.api(`/api/v1/memory/${memory.id}?hard=true&confirm=true`, { method: 'DELETE' });
  assert.equal(hard.status, 200);
  assert.equal(hard.json.hard, true);
  // 硬删后：GET → 410 GONE；versions → 410；restore → 410
  const gone = await rt.api(`/api/v1/memory/${memory.id}`);
  assert.equal(gone.status, 410);
  assert.equal(gone.json.error.code, 'GONE');
  const goneVersions = await rt.api(`/api/v1/memory/${memory.id}/versions`);
  assert.equal(goneVersions.status, 410);
  const goneRestore = await rt.api(`/api/v1/memory/${memory.id}/restore`, { method: 'POST', body: {} });
  assert.equal(goneRestore.status, 410);
});

test('合并记忆：keep_target 与 prepend_sources 策略、源记忆软删、标签/参与者并集、版本 change_kind=merge', async () => {
  const target = await createMemory({ title: '合并目标', body: '目标正文', tags: ['合并A'], participants: ['甲'] });
  const source1 = await createMemory({ title: '合并源一', body: '源一正文', tags: ['合并B'], participants: ['乙'], importance: 0.95 });
  const merged = await rt.api(`/api/v1/memory/${target.id}/merge`, {
    method: 'POST',
    body: { source_ids: [source1.id], strategy: 'prepend_sources' },
  });
  assert.equal(merged.status, 200);
  assert.equal(merged.json.target_id, target.id);
  assert.deepEqual(merged.json.merged_ids, [source1.id]);
  assert.ok(merged.json.memory.body.includes('源一正文'), 'prepend_sources 应拼接源正文');
  assert.ok(merged.json.memory.body.includes('目标正文'));
  assert.equal(merged.json.memory.importance, 0.95);
  assert.deepEqual([...merged.json.memory.tag_names].sort(), ['合并A', '合并B'].sort());
  assert.equal(merged.json.memory.participants.length, 2);
  // 源记忆已软删且保留历史
  const sourceAfter = await rt.api(`/api/v1/memory/${source1.id}`);
  assert.equal(sourceAfter.status, 200);
  assert.equal(sourceAfter.json.memory.deleted_at !== null, true);
  const sourceVersions = await rt.api(`/api/v1/memory/${source1.id}/versions`);
  assert.ok(sourceVersions.json.items.some((item) => item.change_kind === 'merge'));
  // 目标版本 change_kind=merge
  const targetVersions = await rt.api(`/api/v1/memory/${target.id}/versions`);
  assert.equal(targetVersions.json.items[0].change_kind, 'merge');

  // 校验：source_ids 为空 / 包含自身
  const empty = await rt.api(`/api/v1/memory/${target.id}/merge`, { method: 'POST', body: { source_ids: [] } });
  assert.equal(empty.status, 422);
  const self = await rt.api(`/api/v1/memory/${target.id}/merge`, { method: 'POST', body: { source_ids: [target.id] } });
  assert.equal(self.status, 422);
});

test('拆分记忆：parts 生成新记忆、父记忆软删、事件与版本可查', async () => {
  const parent = await createMemory({ title: '拆分父记忆', body: '父正文', tags: ['拆分标签'] });
  const split = await rt.api(`/api/v1/memory/${parent.id}/split`, {
    method: 'POST',
    body: {
      parts: [
        { title: '拆分子一', body: '子一正文' },
        { title: '拆分子二', body: '子二正文', memory_type: 'semantic' },
      ],
    },
  });
  assert.equal(split.status, 201);
  assert.equal(split.json.part_ids.length, 2);
  assert.equal(split.json.parts[0].title, '拆分子一');
  assert.equal(split.json.parts[1].memory_type, 'semantic');
  assert.deepEqual(split.json.parts[0].tag_names, ['拆分标签'], '默认继承父标签');
  assert.equal(split.json.memory.deleted_at !== null, true, '父记忆默认软删');
  const parentVersions = await rt.api(`/api/v1/memory/${parent.id}/versions`);
  assert.equal(parentVersions.json.items[0].change_kind, 'split');
  // 缺少 parts
  const invalid = await rt.api(`/api/v1/memory/${parent.id}/split`, { method: 'POST', body: { parts: [] } });
  assert.equal(invalid.status, 422);
});
