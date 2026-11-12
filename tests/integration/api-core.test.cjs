'use strict';

/**
 * 集成测试（一）：真实 Runtime 进程 + 真实 HTTP，覆盖契约 §3/§4 的核心数据面。
 * 不使用任何 mock；数据目录隔离在 .cache/qa-home/qa-integration-core。
 *
 * 覆盖：health/认证/state/identity/cognition/memory CRUD/乐观并发/版本/diff/merge/split/
 *       列表过滤分页/搜索三模式/tags/entities/relations/timeline/graph/layout/主题错误码。
 */
const h = require('../lib/harness.cjs');
const { assert, http, uniq } = h;

const ID_RE = /^[a-z]+_[0-9a-f]{32}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function errCode(res) {
  return res.json && res.json.error ? res.json.error.code : null;
}

async function createMemory(overrides = {}) {
  const res = await http().post('/api/v1/memory/store', {
    title: `QA 记忆 ${uniq('m')}`,
    body: '真实集成测试正文。',
    memory_type: 'episodic',
    occurred_at: '2026-11-12T10:00:00.000Z',
    occurred_precision: 'exact',
    ...overrides,
  });
  assert.equal(res.status, 201, `创建记忆失败：${res.status} ${res.text.slice(0, 400)}`);
  return res.json;
}

h.lifecycle({ suite: 'integration-core', name: 'core' });

// ---------------------------------------------------------------------------
// 健康检查 / 认证 / 追踪
// ---------------------------------------------------------------------------
h.qa('health: 免认证返回契约字段且 api_version=1', async () => {
  const res = await http().get('/health', { token: null });
  assert.equal(res.status, 200);
  const b = res.json;
  assert.equal(b.status, 'ok');
  assert.equal(b.api_version, '1');
  assert.equal(b.version, '0.1.0');
  assert.equal(b.db, 'ok');
  assert.equal(b.initialized, true);
  assert.ok(Number.isFinite(b.uptime_ms) && b.uptime_ms >= 0);
  assert.match(res.headers['content-type'], /application\/json/);
  return `status=${b.status} version=${b.version} uptime=${b.uptime_ms}ms`;
});

h.qa('auth: 无 token / 错误 token / 非 Bearer 均 401 UNAUTHORIZED 且含 trace_id', async () => {
  const cases = [
    await http().get('/api/v1/state', { token: null }),
    await http().get('/api/v1/state', { token: 'f'.repeat(64) }),
    await http().get('/api/v1/state', { token: null, headers: { Authorization: 'Basic abc' } }),
  ];
  for (const res of cases) {
    assert.equal(res.status, 401);
    assert.equal(errCode(res), 'UNAUTHORIZED');
    assert.match(res.json.error.trace_id, /^trc_/);
    assert.ok(res.json.error.message.length > 0);
  }
  return '401 x3';
});

h.qa('trace: 请求 X-FCA-Trace-Id 被回显；缺省时响应头自动生成 trc_ 前缀', async () => {
  const withTrace = await http().get('/api/v1/state', { headers: { 'X-FCA-Trace-Id': 'qa-trace-abc-123' } });
  assert.equal(withTrace.traceId, 'qa-trace-abc-123');
  const auto = await http().get('/api/v1/state');
  assert.match(auto.traceId, /^trc_[0-9a-f]{32}$/);
  return auto.traceId;
});

h.qa('router: 未知端点 404 / 方法不允许 405 + Allow 头 / OPTIONS 204 CORS', async () => {
  const notFound = await http().get('/api/v1/does-not-exist');
  assert.equal(notFound.status, 404);
  assert.equal(errCode(notFound), 'NOT_FOUND');
  const badMethod = await http().del('/health');
  assert.equal(badMethod.status, 405);
  assert.equal(errCode(badMethod), 'METHOD_NOT_ALLOWED');
  assert.match(String(badMethod.headers.allow), /GET/);
  const options = await http().request('OPTIONS', '/api/v1/state', { token: null });
  assert.equal(options.status, 204);
  assert.equal(options.headers['access-control-allow-origin'], '*');
  return '404/405/204';
});

// ---------------------------------------------------------------------------
// state / identity / cognition
// ---------------------------------------------------------------------------
h.qa('state: identity/cognition/counts/catalogs/capabilities/sync 结构与真实计数一致', async () => {
  const tag = uniq('state-tag');
  await createMemory({ tags: [tag] });
  const res = await http().get('/api/v1/state');
  assert.equal(res.status, 200);
  const b = res.json;
  assert.match(b.identity.identity_id, /^idn_/);
  assert.equal(typeof b.cognition.mode, 'string');
  assert.equal(typeof b.cognition.note, 'string');
  for (const key of ['memories', 'entities', 'relations', 'tags', 'events', 'versions', 'layout_nodes']) {
    assert.equal(typeof b.counts[key], 'number', `counts.${key} 缺失`);
  }
  assert.ok(Array.isArray(b.catalogs.tags) && Array.isArray(b.catalogs.projects));
  assert.ok(b.catalogs.tags.some((t) => t.name === tag), 'catalogs.tags 应包含刚创建的标签');
  assert.equal(b.capabilities.api_version, '1');
  assert.equal(b.capabilities.layout, 'force_v1');
  assert.equal(b.capabilities.sse, true);
  assert.deepEqual(b.capabilities.export.sort(), ['json', 'jsonl', 'zip']);
  assert.equal(typeof b.sync.last_event_seq, 'number');
  assert.equal(b.sync.db_initialized, true);
  const list = await http().get('/api/v1/memories?limit=500');
  assert.equal(b.counts.memories, list.json.total > 500 ? b.counts.memories : list.json.items.length);
  return `memories=${b.counts.memories} entities=${b.counts.entities} tags=${b.counts.tags}`;
});

h.qa('identity: 读取默认值 → 更新版本化 → identity_id 稳定', async () => {
  const before = await http().get('/api/v1/identity');
  assert.equal(before.status, 200);
  assert.match(before.json.identity_id, /^idn_/);
  assert.equal(typeof before.json.version, 'number');
  const next = await http().post('/api/v1/identity', {
    display_name: uniq('QA 身份'),
    summary: '集成测试写入的身份摘要',
    values: ['真实', '可复现'],
    expected_version: before.json.version,
  });
  assert.equal(next.status, 200);
  assert.equal(next.json.identity_id, before.json.identity_id);
  assert.equal(next.json.version, before.json.version + 1);
  assert.deepEqual(next.json.values, ['真实', '可复现']);
  const stale = await http().post('/api/v1/identity', { display_name: '过期写入', expected_version: before.json.version });
  assert.equal(stale.status, 409, `stale identity update 期望 409，实际 ${stale.status}`);
  return `version ${before.json.version}→${next.json.version}`;
});

h.qa('cognition: 读取结构 → 更新（模拟状态标注存在）', async () => {
  const get = await http().get('/api/v1/cognition');
  assert.equal(get.status, 200);
  assert.ok(Array.isArray(get.json.attention_targets));
  assert.ok(Array.isArray(get.json.working_memory));
  assert.match(get.json.note, /模拟/);
  const focus = uniq('专注');
  const post = await http().post('/api/v1/cognition', { focus, mode: 'focused', attention_targets: get.json.attention_targets });
  assert.equal(post.status, 200, post.text.slice(0, 300));
  assert.equal(post.json.focus, focus);
  assert.equal(post.json.mode, 'focused');
  const badMode = await http().post('/api/v1/cognition', { mode: 'thinking' });
  assert.equal(badMode.status, 422, '非法 mode 应返回 422');
  return `focus=${focus}`;
});

// ---------------------------------------------------------------------------
// memory CRUD
// ---------------------------------------------------------------------------
h.qa('memory: 创建完整字段 → 服务端生成 ID/标签/实体/版本/来源', async () => {
  const person = uniq('人物');
  const project = uniq('项目');
  const tag = uniq('标签');
  const m = await createMemory({
    title: `与 ${person} 讨论 FCA`,
    body: '第一行\n第二行',
    memory_type: 'episodic',
    source: { type: 'user', ref: 'qa-ref', note: 'qa-note' },
    credibility: 0.8,
    importance: 0.7,
    display_weight: 1.5,
    tags: [tag],
    participants: [{ name: person, role: 'participant' }],
    project: { name: project },
    emotion: { valence: 0.2, arousal: 0.4, label: '专注' },
    origin: 'user',
  });
  assert.match(m.id, /^mem_[0-9a-f]{32}$/);
  assert.equal(m.memory_type, 'episodic');
  assert.equal(m.credibility, 0.8);
  assert.equal(m.importance, 0.7);
  assert.equal(m.display_weight, 1.5);
  assert.equal(m.version, 1);
  assert.equal(m.deleted_at, null);
  assert.equal(m.agent_generated, false);
  assert.match(m.created_at, ISO_RE);
  assert.match(m.updated_at, ISO_RE);
  assert.equal(m.tags.length, 1);
  assert.match(m.tags[0], /^tag_[0-9a-f]{32}$/);
  assert.deepEqual(m.tag_names, [tag]);
  assert.equal(m.participants[0].name, person);
  assert.match(m.participants[0].entity_id, /^ent_[0-9a-f]{32}$/);
  assert.equal(m.project.name, project);
  assert.deepEqual(m.emotion, { valence: 0.2, arousal: 0.4, label: '专注' });
  assert.deepEqual(m.source, { type: 'user', ref: 'qa-ref', note: 'qa-note' });
  return m.id;
});

h.qa('memory: 字段校验失败返回 422 VALIDATION_FAILED + details.fields', async () => {
  const cases = [
    [{}, 'title'],
    [{ title: 'x'.repeat(501) }, 'title'],
    [{ title: 'ok', display_weight: 3 }, 'display_weight'],
    [{ title: 'ok', importance: -0.5 }, 'importance'],
    [{ title: 'ok', credibility: 1.5 }, 'credibility'],
    [{ title: 'ok', memory_type: 'nonsense' }, 'memory_type'],
  ];
  for (const [body, field] of cases) {
    const res = await http().post('/api/v1/memory/store', body);
    assert.equal(res.status, 422, `${JSON.stringify(body).slice(0, 80)} 期望 422，实际 ${res.status}`);
    assert.equal(errCode(res), 'VALIDATION_FAILED');
    assert.ok(
      res.json.error.details.fields.some((f) => f.field === field),
      `422 details.fields 应包含 ${field}: ${JSON.stringify(res.json.error.details)}`,
    );
  }
  return `6 组非法输入均 422`;
});

h.qa('memory: GET 详情返回 memory/relations/layout/versions_count', async () => {
  const m = await createMemory({ participants: [{ name: uniq('详情人物') }] });
  const res = await http().get(`/api/v1/memory/${m.id}`);
  assert.equal(res.status, 200);
  const b = res.json;
  assert.equal(b.memory.id, m.id);
  assert.ok(Array.isArray(b.relations));
  assert.ok(b.relations.length >= 1, '参与者应触发自动关系');
  assert.ok(b.layout === null || (b.layout && Number.isFinite(b.layout.x)), 'layout 应为 null 或含坐标');
  assert.ok(b.versions_count >= 1);
  const missing = await http().get('/api/v1/memory/mem_0123456789abcdef0123456789abcdef');
  assert.equal(missing.status, 404);
  assert.equal(errCode(missing), 'NOT_FOUND');
  return `relations=${b.relations.length} versions=${b.versions_count}`;
});

h.qa('memory: PATCH 乐观并发——版本递增、过期 expected_version 返回 409 VERSION_CONFLICT', async () => {
  const m = await createMemory();
  const patch = await http().patch(`/api/v1/memory/${m.id}`, { expected_version: 1, title: '改后标题', importance: 0.1 });
  assert.equal(patch.status, 200);
  assert.equal(patch.json.title, '改后标题');
  assert.equal(patch.json.version, 2);
  assert.ok(new Date(patch.json.updated_at) >= new Date(patch.json.created_at));
  const conflict = await http().patch(`/api/v1/memory/${m.id}`, { expected_version: 1, title: '冲突标题' });
  assert.equal(conflict.status, 409);
  assert.equal(errCode(conflict), 'VERSION_CONFLICT');
  assert.equal(conflict.json.error.details.current_version, 2);
  const afterConflict = await http().get(`/api/v1/memory/${m.id}`);
  assert.equal(afterConflict.json.memory.title, '改后标题');
  return `v1→v2，冲突 details.current_version=2`;
});

h.qa('version: 历史包含 snapshot/diff/change_kind；diff 返回 RFC6902 操作列表', async () => {
  const m = await createMemory();
  await http().patch(`/api/v1/memory/${m.id}`, { expected_version: 1, title: `${m.title}（修订）` });
  const versions = await http().get(`/api/v1/memory/${m.id}/versions`);
  assert.equal(versions.status, 200);
  assert.ok(versions.json.items.length >= 2);
  const latest = versions.json.items[0];
  assert.match(latest.ver_id, /^ver_[0-9a-f]{32}$/);
  assert.equal(latest.change_kind, 'update');
  assert.equal(latest.version, 2);
  assert.equal(typeof latest.snapshot, 'object');
  assert.ok(Array.isArray(latest.diff));
  const diff = await http().get(`/api/v1/memory/${m.id}/diff?from=1&to=2`);
  assert.equal(diff.status, 200);
  const ops = diff.json.operations ?? diff.json.patch;
  assert.ok(Array.isArray(ops) && ops.length > 0);
  assert.ok(ops.every((op) => typeof op.op === 'string' && typeof op.path === 'string'));
  assert.ok(ops.some((op) => op.path === '/title'));
  const noParams = await http().get(`/api/v1/memory/${m.id}/diff`);
  assert.equal(noParams.status, 422);
  // 契约: GET /memory/{id}?version= 读取历史版本快照
  const historical = await http().get(`/api/v1/memory/${m.id}?version=1`);
  assert.equal(historical.status, 200);
  assert.equal(historical.json.version_view, 1);
  assert.equal(historical.json.memory.title, m.title);
  assert.ok(historical.json.versions_count >= 2);
  const badVersion = await http().get(`/api/v1/memory/${m.id}?version=abc`);
  assert.equal(badVersion.status, 422);
  return `${versions.json.items.length} 个版本，diff ${ops.length} 个操作`;
});

h.qa('memory: 软删除→列表隔离→回收站恢复→include_deleted', async () => {
  const m = await createMemory();
  const del = await http().del(`/api/v1/memory/${m.id}`);
  assert.equal(del.status, 200);
  // 契约：GET /memory/{id} 未定义 include_deleted=false 的拒绝语义（Runtime 允许读取软删对象，供回收站详情使用）
  const deleted = await http().get(`/api/v1/memory/${m.id}`);
  assert.equal(deleted.status, 200);
  assert.notEqual(deleted.json.memory.deleted_at, null);
  const included = await http().get(`/api/v1/memory/${m.id}?include_deleted=true`);
  assert.equal(included.status, 200);
  assert.notEqual(included.json.memory.deleted_at, null);
  const onlyDeleted = await http().get('/api/v1/memories?only_deleted=true&limit=500');
  assert.ok(onlyDeleted.json.items.some((x) => x.id === m.id));
  const normalList = await http().get('/api/v1/memories?limit=500');
  assert.ok(!normalList.json.items.some((x) => x.id === m.id), '默认列表不应包含软删记忆');
  const restore = await http().post(`/api/v1/memory/${m.id}/restore`, {});
  assert.equal(restore.status, 200);
  assert.equal(restore.json.deleted_at, null);
  const back = await http().get(`/api/v1/memory/${m.id}`);
  assert.equal(back.status, 200);
  assert.equal(back.json.memory.deleted_at, null);
  return '软删/恢复通过';
});

h.qa('memory: 硬删除需 confirm=true（未确认 403）；硬删后 GET 返回 410 GONE', async () => {
  const m = await createMemory();
  const noConfirm = await http().del(`/api/v1/memory/${m.id}?hard=true`);
  assert.equal(noConfirm.status, 403);
  assert.equal(errCode(noConfirm), 'FORBIDDEN');
  const confirm = await http().del(`/api/v1/memory/${m.id}?hard=true&confirm=true`);
  assert.equal(confirm.status, 200);
  const gone = await http().get(`/api/v1/memory/${m.id}?include_deleted=true`);
  assert.equal(gone.status, 410);
  assert.equal(errCode(gone), 'GONE');
  const goneGet = await http().get(`/api/v1/memory/${m.id}`);
  assert.equal(goneGet.status, 410);
  return 'hard delete 需 confirm；硬删后 410 GONE';
});

h.qa('memories: 列表过滤（类型/标签/参与者/项目/时间）、排序、分页 cursor', async () => {
  const tag = uniq('list-tag');
  const person = uniq('list-person');
  const project = uniq('list-project');
  const ids = [];
  for (let i = 0; i < 4; i += 1) {
    const m = await createMemory({
      title: `${uniq('列表')} #${i}`,
      memory_type: i < 3 ? 'semantic' : 'episodic',
      importance: i / 10,
      tags: [tag],
      participants: [{ name: person }],
      project: { name: project },
      occurred_at: `2026-03-0${i + 1}T00:00:00.000Z`,
    });
    ids.push(m.id);
  }
  const byType = await http().get('/api/v1/memories?memory_type=semantic&limit=500');
  assert.ok(byType.json.items.every((m) => m.memory_type === 'semantic'));
  const byTag = await http().get(`/api/v1/memories?tags=${encodeURIComponent(tag)}&limit=500`);
  assert.equal(byTag.json.items.length, 4);
  // contract 的 participant 过滤按实体 ID 匹配（filters.entity_ids）；用创建响应里的 entity_id 验证
  const participantIds = [];
  for (const id of ids) {
    const detail = await http().get(`/api/v1/memory/${id}`);
    participantIds.push(detail.json.memory.participants[0].entity_id);
  }
  assert.equal(new Set(participantIds).size, 1, '同一参与者姓名应复用同一实体');
  const byPerson = await http().get(`/api/v1/memories?participant=${participantIds[0]}&limit=500`);
  assert.equal(byPerson.json.items.length, 4);
  const byProject = await http().get(`/api/v1/memories?project=${encodeURIComponent(project)}&limit=500`);
  assert.equal(byProject.json.items.length, 4);
  const byTime = await http().get('/api/v1/memories?from=2026-03-02T00:00:00.000Z&to=2026-03-03T23:59:59.000Z&limit=500');
  assert.ok(byTime.json.items.length >= 2 && byTime.json.items.length <= 2, `时间过滤期望 2 条，实际 ${byTime.json.items.length}`);
  const sorted = await http().get(`/api/v1/memories?tags=${encodeURIComponent(tag)}&sort=-importance&limit=500`);
  const imp = sorted.json.items.map((m) => m.importance);
  assert.deepEqual(imp, [...imp].sort((a, b) => b - a), 'sort=-importance 应按 importance 降序');
  const page1 = await http().get(`/api/v1/memories?tags=${encodeURIComponent(tag)}&limit=2`);
  assert.equal(page1.json.items.length, 2);
  assert.ok(page1.json.next_cursor, 'limit=2 时应返回 next_cursor');
  const page2 = await http().get(`/api/v1/memories?tags=${encodeURIComponent(tag)}&limit=2&cursor=${encodeURIComponent(page1.json.next_cursor)}`);
  assert.equal(page2.json.items.length, 2);
  const page1Ids = new Set(page1.json.items.map((m) => m.id));
  assert.ok(page2.json.items.every((m) => !page1Ids.has(m.id)), '第二页不应重复第一页');
  return `tags/participants/project/time/sort/cursor 均命中`;
});

// ---------------------------------------------------------------------------
// merge / split
// ---------------------------------------------------------------------------
h.qa('memory: merge 合并两条记忆，源记忆软删、目标版本递增', async () => {
  const target = await createMemory({ title: uniq('合并目标') });
  const source = await createMemory({ title: uniq('合并源'), body: '源正文' });
  const res = await http().post(`/api/v1/memory/${target.id}/merge`, {
    source_ids: [source.id],
    target_id: target.id,
    strategy: 'prepend_sources',
  });
  assert.equal(res.status, 200, res.text.slice(0, 300));
  const merged = res.json.memory ?? res.json;
  assert.equal(merged.id, target.id);
  assert.ok(merged.version >= 2);
  const sourceAfter = await http().get(`/api/v1/memory/${source.id}?include_deleted=true`);
  assert.notEqual(sourceAfter.json.memory.deleted_at, null);
  assert.ok(String(merged.body).includes('源正文'), 'merge 后目标正文应包含源正文');
  const bad = await http().post(`/api/v1/memory/${target.id}/merge`, { source_ids: [], target_id: target.id });
  assert.equal(bad.status, 422);
  return `merged v${merged.version}`;
});

h.qa('memory: split 拆分为多条新记忆', async () => {
  const parent = await createMemory({ title: uniq('拆分源'), body: '第一部分内容。第二部分内容。' });
  const res = await http().post(`/api/v1/memory/${parent.id}/split`, {
    parts: [
      { title: uniq('part-A'), body: '第一部分内容。' },
      { title: uniq('part-B'), body: '第二部分内容。', memory_type: 'semantic' },
    ],
  });
  assert.equal(res.status, 201, res.text.slice(0, 300));
  const parts = res.json.parts ?? res.json.items;
  assert.ok(Array.isArray(parts) && parts.length === 2);
  const newIds = parts.map((p) => p.id);
  assert.ok(newIds.every((id) => /^mem_[0-9a-f]{32}$/.test(id) && id !== parent.id));
  assert.equal(new Set(newIds).size, 2);
  const invalid = await http().post(`/api/v1/memory/${parent.id}/split`, { parts: 'not-array' });
  assert.equal(invalid.status, 422);
  return newIds.join(',');
});

// ---------------------------------------------------------------------------
// search / tags
// ---------------------------------------------------------------------------
h.qa('search: fulltext/semantic/hybrid 三模式返回真实结果与耗时', async () => {
  const keyword = uniq('量子记忆检索词');
  const m = await createMemory({ title: `关于${keyword}的记录`, body: `正文包含 ${keyword} 与其它内容。` });
  for (const mode of ['fulltext', 'semantic', 'hybrid']) {
    const res = await http().post('/api/v1/memory/search', { query: keyword, mode, limit: 10 });
    assert.equal(res.status, 200, `${mode}: ${res.status} ${res.text.slice(0, 200)}`);
    assert.ok(Array.isArray(res.json.items));
    assert.equal(typeof res.json.took_ms, 'number');
    assert.ok(res.json.items.some((item) => item.memory.id === m.id), `${mode} 未检索到刚创建的记忆（${res.json.items.length} 条）`);
    const hit = res.json.items.find((item) => item.memory.id === m.id);
    assert.equal(typeof hit.score, 'number');
    assert.ok(Array.isArray(hit.highlights));
  }
  const filtered = await http().post('/api/v1/memory/search', {
    query: keyword,
    mode: 'hybrid',
    filters: { memory_types: ['episodic'] },
    limit: 10,
  });
  assert.equal(filtered.status, 200);
  const wrongType = await http().post('/api/v1/memory/search', {
    query: keyword,
    mode: 'fulltext',
    filters: { memory_types: ['procedural'] },
    limit: 10,
  });
  assert.ok(!wrongType.json.items.some((item) => item.memory.id === m.id));
  return '三模式 + filters 通过';
});

h.qa('tags: 目录返回 id/name/count，支持 ?q= 过滤', async () => {
  const name = uniq('目录标签');
  await createMemory({ tags: [name] });
  const all = await http().get('/api/v1/tags');
  assert.equal(all.status, 200);
  const hit = all.json.items.find((t) => t.name === name);
  assert.ok(hit, '标签目录应包含新标签');
  assert.match(hit.id, /^tag_[0-9a-f]{32}$/);
  assert.ok(hit.count >= 1);
  const filtered = await http().get(`/api/v1/tags?q=${encodeURIComponent(name)}`);
  assert.ok(filtered.json.items.every((t) => t.name.includes(name)));
  return `tags total=${all.json.total}`;
});

// ---------------------------------------------------------------------------
// entities / relations
// ---------------------------------------------------------------------------
h.qa('entities: 创建/列表/详情/PATCH 乐观并发/重复 409 DUPLICATE', async () => {
  const name = uniq('实体人物');
  const created = await http().post('/api/v1/entities', { kind: 'person', name, description: '集成测试实体' });
  assert.equal(created.status, 201, created.text.slice(0, 300));
  assert.match(created.json.id, /^ent_[0-9a-f]{32}$/);
  assert.equal(created.json.version, 1);
  const list = await http().get(`/api/v1/entities?kind=person&q=${encodeURIComponent(name)}`);
  assert.ok(list.json.items.some((e) => e.id === created.json.id));
  const detail = await http().get(`/api/v1/entities/${created.json.id}`);
  assert.equal(detail.status, 200);
  const patched = await http().patch(`/api/v1/entities/${created.json.id}`, { expected_version: 1, description: '已修改' });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.description, '已修改');
  assert.equal(patched.json.version, 2);
  const stale = await http().patch(`/api/v1/entities/${created.json.id}`, { expected_version: 1, description: '冲突' });
  assert.equal(stale.status, 409);
  const dup = await http().post('/api/v1/entities', { kind: 'person', name });
  assert.equal(dup.status, 409);
  assert.equal(errCode(dup), 'DUPLICATE');
  const del = await http().del(`/api/v1/entities/${created.json.id}`);
  assert.equal(del.status, 200);
  return created.json.id;
});

h.qa('relations: 创建/过滤查询/PATCH/DELETE 软删且两端对象保留', async () => {
  const person = await http().post('/api/v1/entities', { kind: 'person', name: uniq('关系人物') });
  const memory = await createMemory();
  const created = await http().post('/api/v1/relations', {
    from: { kind: 'entity', id: person.json.id },
    to: { kind: 'memory', id: memory.id },
    relation_type: 'participates_in',
    directed: true,
    label: '参与',
    evidence: '集成测试',
    confidence: 0.9,
  });
  assert.equal(created.status, 201, created.text.slice(0, 300));
  assert.match(created.json.id, /^rel_[0-9a-f]{32}$/);
  assert.equal(created.json.directed, true);
  assert.equal(created.json.from.id, person.json.id);
  const list = await http().get(`/api/v1/relations?node_kind=memory&node_id=${memory.id}`);
  assert.equal(list.status, 200);
  assert.ok(list.json.items.some((r) => r.id === created.json.id));
  const patched = await http().patch(`/api/v1/relations/${created.json.id}`, {
    expected_version: created.json.version,
    label: '参与（已改）',
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.label, '参与（已改）');
  const detail = await http().get(`/api/v1/relations/${created.json.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.id, created.json.id);
  assert.equal(detail.json.from.id, person.json.id);
  const del = await http().del(`/api/v1/relations/${created.json.id}`);
  assert.equal(del.status, 200);
  const stillMemory = await http().get(`/api/v1/memory/${memory.id}`);
  assert.equal(stillMemory.status, 200, '删除关系不得删除记忆');
  const stillPerson = await http().get(`/api/v1/entities/${person.json.id}`);
  assert.equal(stillPerson.status, 200, '删除关系不得删除实体');
  const includeDeleted = await http().get(`/api/v1/relations?node_id=${memory.id}&include_deleted=true`);
  assert.ok(includeDeleted.json.items.some((r) => r.id === created.json.id && r.deleted_at !== null));
  return created.json.id;
});

// ---------------------------------------------------------------------------
// timeline / graph / layout
// ---------------------------------------------------------------------------
h.qa('timeline: 按天分桶、items/range 与真实记忆一致，支持 granularity', async () => {
  const day = '2026-07-15';
  const m = await createMemory({ occurred_at: `${day}T08:00:00.000Z` });
  const res = await http().get(`/api/v1/timeline?granularity=day&from=2026-07-01T00:00:00.000Z&to=2026-07-31T23:59:59.000Z`);
  assert.equal(res.status, 200);
  const b = res.json;
  assert.ok(Array.isArray(b.buckets) && Array.isArray(b.items));
  const bucket = b.buckets.find((x) => x.key === day);
  assert.ok(bucket, `timeline 应包含 ${day} 分桶：${JSON.stringify(b.buckets.map((x) => x.key))}`);
  assert.ok(bucket.count >= 1);
  assert.ok(bucket.node_ids.includes(m.id));
  assert.ok(bucket.present_types.includes('episodic'));
  assert.ok(b.items.some((item) => item.id === m.id));
  const month = await http().get('/api/v1/timeline?granularity=month&from=2026-07-01T00:00:00.000Z&to=2026-07-31T23:59:59.000Z');
  assert.equal(month.json.range.granularity, 'month');
  assert.ok(month.json.buckets.some((x) => x.key === '2026-07'));
  const bad = await http().get('/api/v1/timeline?granularity=century');
  assert.equal(bad.status, 422, `非法 granularity 期望 422，实际 ${bad.status}`);
  return `bucket ${day} count=${bucket.count}`;
});

h.qa('graph: 渲染数据契约——节点/边/簇/stats 完整且坐标在契约边界内', async () => {
  const m = await createMemory({ title: uniq('星图节点'), participants: [{ name: uniq('星图人物') }] });
  const res = await http().get('/api/v1/graph');
  assert.equal(res.status, 200);
  const g = res.json;
  assert.equal(g.api_version, '1');
  assert.equal(typeof g.layout_version, 'number');
  assert.ok(g.view && Array.isArray(g.view.center) && typeof g.view.zoom === 'number');
  assert.ok(Array.isArray(g.nodes) && g.nodes.length >= 2);
  const node = g.nodes.find((n) => n.id === m.id);
  assert.ok(node, 'graph 应包含新创建的记忆节点');
  for (const key of ['kind', 'type', 'label', 'importance', 'degree', 'cluster_id', 'pinned', 'tags', 'deleted']) {
    assert.ok(node[key] !== undefined, `graph node 缺少 ${key}`);
  }
  assert.equal(node.kind, 'memory');
  assert.equal(node.type, 'episodic');
  assert.ok(Number.isFinite(node.position.x) && Number.isFinite(node.position.y) && Number.isFinite(node.position.z));
  assert.ok(node.position.x >= -5000 && node.position.x <= 5000);
  assert.ok(node.position.y >= -5000 && node.position.y <= 5000);
  assert.ok(node.position.z >= -800 && node.position.z <= 800);
  const nodeIds = new Set(g.nodes.map((n) => n.id));
  assert.ok(Array.isArray(g.edges) && g.edges.length >= 1);
  for (const edge of g.edges) {
    assert.match(edge.id, /^rel_[0-9a-f]{32}$/);
    assert.ok(nodeIds.has(edge.from) && nodeIds.has(edge.to), `edge ${edge.id} 端点不在 nodes 中`);
    assert.equal(typeof edge.relation_type, 'string');
  }
  assert.ok(Array.isArray(g.clusters));
  for (const cluster of g.clusters) {
    assert.match(cluster.id, /^cluster_/);
    assert.ok(Array.isArray(cluster.node_ids) && cluster.node_ids.every((id) => nodeIds.has(id)));
    assert.ok(typeof cluster.centroid.x === 'number' && typeof cluster.density === 'number');
    assert.ok(['cyan', 'blue', 'violet', 'magenta', 'rose', 'gold', 'white'].includes(cluster.color_hint));
  }
  assert.equal(g.stats.nodes, g.nodes.length);
  assert.equal(g.stats.edges, g.edges.length);
  assert.equal(g.stats.clusters, g.clusters.length);
  assert.match(g.stats.generated_at, ISO_RE);
  const filtered = await http().get('/api/v1/graph?memory_types=episodic');
  assert.ok(filtered.json.nodes.filter((n) => n.kind === 'memory').every((n) => n.type === 'episodic'));
  return `nodes=${g.nodes.length} edges=${g.edges.length} clusters=${g.clusters.length}`;
});

h.qa('layout: 保存坐标/pinned → 读取一致 → recompute 保留 pinned → reset 清除手动坐标', async () => {
  const m = await createMemory({ title: uniq('布局节点') });
  const save = await http().post('/api/v1/layout/nodes', {
    updates: [{ node_kind: 'memory', node_id: m.id, x: 120.5, y: -340.25, z: 12.5, pinned: true }],
  });
  assert.equal(save.status, 200, save.text.slice(0, 300));
  assert.ok(save.json.updated >= 1);
  assert.equal(typeof save.json.layout_version, 'number');
  const nodes = await http().get(`/api/v1/layout/nodes?node_kind=memory&node_id=${m.id}`);
  assert.equal(nodes.status, 200);
  const saved = nodes.json.items.find((n) => n.node_id === m.id);
  assert.ok(saved, 'layout nodes 应包含刚保存的节点');
  assert.deepEqual(
    { x: saved.x, y: saved.y, z: saved.z, pinned: saved.pinned },
    { x: 120.5, y: -340.25, z: 12.5, pinned: true },
  );
  const graph = await http().get('/api/v1/graph');
  const gn = graph.json.nodes.find((n) => n.id === m.id);
  assert.equal(gn.position.x, 120.5);
  assert.equal(gn.pinned, true);
  const recompute = await http().post('/api/v1/layout/recompute', { algorithm: 'force_v1', cluster_separation: 0.8 });
  assert.equal(recompute.status, 200);
  assert.equal(recompute.json.algorithm, 'force_v1');
  assert.ok(recompute.json.preserved_pinned >= 1, `recompute 应保留手动 pinned 节点（preserved_pinned=${recompute.json.preserved_pinned}）`);
  const afterRecompute = await http().get(`/api/v1/layout/nodes?node_kind=memory&node_id=${m.id}`);
  const kept = afterRecompute.json.items.find((n) => n.node_id === m.id);
  assert.deepEqual([kept.x, kept.y, kept.z], [120.5, -340.25, 12.5], 'pinned 节点坐标在 recompute 后不应变化');
  const reset = await http().post('/api/v1/layout/reset', {});
  assert.equal(reset.status, 200);
  assert.equal(reset.json.reset, true);
  const afterReset = await http().get(`/api/v1/layout/nodes?node_kind=memory&node_id=${m.id}`);
  const resetNode = afterReset.json.items.find((n) => n.node_id === m.id);
  assert.equal(resetNode.pinned, false, 'reset 后不应残留 pinned');
  const badKind = await http().get('/api/v1/layout/nodes?node_kind=alien');
  assert.equal(badKind.status, 422);
  return `pinned→recompute→reset 通过（layout_version=${reset.json.layout_version}）`;
});

h.qa('layout/views: 命名视图创建/列表/删除', async () => {
  const name = uniq('QA 视图');
  const created = await http().post('/api/v1/layout/views', {
    name,
    is_default: false,
    camera: { center: [1, 2, 3], zoom: 1.5 },
    layer_config: { show_relations: true },
  });
  assert.equal(created.status, 201, created.text.slice(0, 300));
  const viewId = created.json.view_id;
  assert.match(viewId, /^view_[0-9a-f]{32}$/);
  const list = await http().get('/api/v1/layout/views');
  assert.ok(list.json.items.some((v) => v.view_id === viewId));
  const del = await http().del(`/api/v1/layout/views/${viewId}`);
  assert.equal(del.status, 200);
  const list2 = await http().get('/api/v1/layout/views');
  assert.ok(!list2.json.items.some((v) => v.view_id === viewId));
  return viewId;
});

