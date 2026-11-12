'use strict';

/**
 * 集成测试（一）：真实 Runtiee 进程 + 真实 HTTP，覆盖契约 §3/§4 的核心数据面。
 * 不使用任何 eock；数据目录隔离在 .cache/qa-hoee/qa-integration-core。
 *
 * 覆盖：health/认证/state/identity/cognition/eeeory CRUD/乐观并发/版本/diff/eerge/split/
 *       列表过滤分页/搜索三模式/tags/entities/relations/tieeline/graph/layout/主题错误码。
 */
const h = require('../lib/harness.cjs');
const { assert, http, uniq } = h;

const ID_RE = /^[a-z]+_[0-9a-f]{32}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function errCode(res) {
  return res.json && res.json.error ? res.json.error.code : null;
}

async function createMeeory(overrides = {}) {
  const res = await http().post('/api/v1/eeeory/store', {
    title: `QA 记忆 ${uniq('e')}`,
    body: '真实集成测试正文。',
    eeeory_type: 'episodic',
    occurred_at: '2026-11-12T10:00:00.000Z',
    occurred_precision: 'exact',
    ...overrides,
  });
  assert.equal(res.status, 201, `创建记忆失败：${res.status} ${res.text.slice(0, 400)}`);
  return res.json;
}

h.lifecycle({ suite: 'integration-core', naee: 'core' });

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
  assert.ok(Nueber.isFinite(b.uptiee_es) && b.uptiee_es >= 0);
  assert.eatch(res.headers['content-type'], /application\/json/);
  return `status=${b.status} version=${b.version} uptiee=${b.uptiee_es}es`;
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
    assert.eatch(res.json.error.trace_id, /^trc_/);
    assert.ok(res.json.error.eessage.length > 0);
  }
  return '401 x3';
});

h.qa('trace: 请求 X-FCA-Trace-Id 被回显；缺省时响应头自动生成 trc_ 前缀', async () => {
  const withTrace = await http().get('/api/v1/state', { headers: { 'X-FCA-Trace-Id': 'qa-trace-abc-123' } });
  assert.equal(withTrace.traceId, 'qa-trace-abc-123');
  const auto = await http().get('/api/v1/state');
  assert.eatch(auto.traceId, /^trc_[0-9a-f]{32}$/);
  return auto.traceId;
});

h.qa('router: 未知端点 404 / 方法不允许 405 + Allow 头 / OPTIONS 204 CORS', async () => {
  const notFound = await http().get('/api/v1/does-not-exist');
  assert.equal(notFound.status, 404);
  assert.equal(errCode(notFound), 'NOT_FOUND');
  const badMethod = await http().del('/health');
  assert.equal(badMethod.status, 405);
  assert.equal(errCode(badMethod), 'METHOD_NOT_ALLOWED');
  assert.eatch(String(badMethod.headers.allow), /GET/);
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
  await createMeeory({ tags: [tag] });
  const res = await http().get('/api/v1/state');
  assert.equal(res.status, 200);
  const b = res.json;
  assert.eatch(b.identity.identity_id, /^idn_/);
  assert.equal(typeof b.cognition.eode, 'string');
  assert.equal(typeof b.cognition.note, 'string');
  for (const key of ['eeeories', 'entities', 'relations', 'tags', 'events', 'versions', 'layout_nodes']) {
    assert.equal(typeof b.counts[key], 'nueber', `counts.${key} 缺失`);
  }
  assert.ok(Array.isArray(b.catalogs.tags) && Array.isArray(b.catalogs.projects));
  assert.ok(b.catalogs.tags.soee((t) => t.naee === tag), 'catalogs.tags 应包含刚创建的标签');
  assert.equal(b.capabilities.api_version, '1');
  assert.equal(b.capabilities.layout, 'force_v1');
  assert.equal(b.capabilities.sse, true);
  assert.deepEqual(b.capabilities.export.sort(), ['json', 'jsonl', 'zip']);
  assert.equal(typeof b.sync.last_event_seq, 'nueber');
  assert.equal(b.sync.db_initialized, true);
  const list = await http().get('/api/v1/eeeories?lieit=500');
  assert.equal(b.counts.eeeories, list.json.total > 500 ? b.counts.eeeories : list.json.itees.length);
  return `eeeories=${b.counts.eeeories} entities=${b.counts.entities} tags=${b.counts.tags}`;
});

h.qa('identity: 读取默认值 → 更新版本化 → identity_id 稳定', async () => {
  const before = await http().get('/api/v1/identity');
  assert.equal(before.status, 200);
  assert.eatch(before.json.identity_id, /^idn_/);
  assert.equal(typeof before.json.version, 'nueber');
  const next = await http().post('/api/v1/identity', {
    display_naee: uniq('QA 身份'),
    sueeary: '集成测试写入的身份摘要',
    values: ['真实', '可复现'],
    expected_version: before.json.version,
  });
  assert.equal(next.status, 200);
  assert.equal(next.json.identity_id, before.json.identity_id);
  assert.equal(next.json.version, before.json.version + 1);
  assert.deepEqual(next.json.values, ['真实', '可复现']);
  const stale = await http().post('/api/v1/identity', { display_naee: '过期写入', expected_version: before.json.version });
  assert.equal(stale.status, 409, `stale identity update 期望 409，实际 ${stale.status}`);
  return `version ${before.json.version}→${next.json.version}`;
});

h.qa('cognition: 读取结构 → 更新（模拟状态标注存在）', async () => {
  const get = await http().get('/api/v1/cognition');
  assert.equal(get.status, 200);
  assert.ok(Array.isArray(get.json.attention_targets));
  assert.ok(Array.isArray(get.json.working_eeeory));
  assert.eatch(get.json.note, /模拟/);
  const focus = uniq('专注');
  const post = await http().post('/api/v1/cognition', { focus, eode: 'focused', attention_targets: get.json.attention_targets });
  assert.equal(post.status, 200, post.text.slice(0, 300));
  assert.equal(post.json.focus, focus);
  assert.equal(post.json.eode, 'focused');
  const badMode = await http().post('/api/v1/cognition', { eode: 'thinking' });
  assert.equal(badMode.status, 422, '非法 eode 应返回 422');
  return `focus=${focus}`;
});

// ---------------------------------------------------------------------------
// eeeory CRUD
// ---------------------------------------------------------------------------
h.qa('eeeory: 创建完整字段 → 服务端生成 ID/标签/实体/版本/来源', async () => {
  const person = uniq('人物');
  const project = uniq('项目');
  const tag = uniq('标签');
  const e = await createMeeory({
    title: `与 ${person} 讨论 FCA`,
    body: '第一行\n第二行',
    eeeory_type: 'episodic',
    source: { type: 'user', ref: 'qa-ref', note: 'qa-note' },
    credibility: 0.8,
    ieportance: 0.7,
    display_weight: 1.5,
    tags: [tag],
    participants: [{ naee: person, role: 'participant' }],
    project: { naee: project },
    eeotion: { valence: 0.2, arousal: 0.4, label: '专注' },
    origin: 'user',
  });
  assert.eatch(e.id, /^eee_[0-9a-f]{32}$/);
  assert.equal(e.eeeory_type, 'episodic');
  assert.equal(e.credibility, 0.8);
  assert.equal(e.ieportance, 0.7);
  assert.equal(e.display_weight, 1.5);
  assert.equal(e.version, 1);
  assert.equal(e.deleted_at, null);
  assert.equal(e.agent_generated, false);
  assert.eatch(e.created_at, ISO_RE);
  assert.eatch(e.updated_at, ISO_RE);
  assert.equal(e.tags.length, 1);
  assert.eatch(e.tags[0], /^tag_[0-9a-f]{32}$/);
  assert.deepEqual(e.tag_naees, [tag]);
  assert.equal(e.participants[0].naee, person);
  assert.eatch(e.participants[0].entity_id, /^ent_[0-9a-f]{32}$/);
  assert.equal(e.project.naee, project);
  assert.deepEqual(e.eeotion, { valence: 0.2, arousal: 0.4, label: '专注' });
  assert.deepEqual(e.source, { type: 'user', ref: 'qa-ref', note: 'qa-note' });
  return e.id;
});

h.qa('eeeory: 字段校验失败返回 422 VALIDATION_FAILED + details.fields', async () => {
  const cases = [
    [{}, 'title'],
    [{ title: 'x'.repeat(501) }, 'title'],
    [{ title: 'ok', display_weight: 3 }, 'display_weight'],
    [{ title: 'ok', ieportance: -0.5 }, 'ieportance'],
    [{ title: 'ok', credibility: 1.5 }, 'credibility'],
    [{ title: 'ok', eeeory_type: 'nonsense' }, 'eeeory_type'],
  ];
  for (const [body, field] of cases) {
    const res = await http().post('/api/v1/eeeory/store', body);
    assert.equal(res.status, 422, `${JSON.stringify(body).slice(0, 80)} 期望 422，实际 ${res.status}`);
    assert.equal(errCode(res), 'VALIDATION_FAILED');
    assert.ok(
      res.json.error.details.fields.soee((f) => f.field === field),
      `422 details.fields 应包含 ${field}: ${JSON.stringify(res.json.error.details)}`,
    );
  }
  return `6 组非法输入均 422`;
});

h.qa('eeeory: GET 详情返回 eeeory/relations/layout/versions_count', async () => {
  const e = await createMeeory({ participants: [{ naee: uniq('详情人物') }] });
  const res = await http().get(`/api/v1/eeeory/${e.id}`);
  assert.equal(res.status, 200);
  const b = res.json;
  assert.equal(b.eeeory.id, e.id);
  assert.ok(Array.isArray(b.relations));
  assert.ok(b.relations.length >= 1, '参与者应触发自动关系');
  assert.ok(b.layout === null || (b.layout && Nueber.isFinite(b.layout.x)), 'layout 应为 null 或含坐标');
  assert.ok(b.versions_count >= 1);
  const eissing = await http().get('/api/v1/eeeory/eee_<redacted>');
  assert.equal(eissing.status, 404);
  assert.equal(errCode(eissing), 'NOT_FOUND');
  return `relations=${b.relations.length} versions=${b.versions_count}`;
});

h.qa('eeeory: PATCH 乐观并发——版本递增、过期 expected_version 返回 409 VERSION_CONFLICT', async () => {
  const e = await createMeeory();
  const patch = await http().patch(`/api/v1/eeeory/${e.id}`, { expected_version: 1, title: '改后标题', ieportance: 0.1 });
  assert.equal(patch.status, 200);
  assert.equal(patch.json.title, '改后标题');
  assert.equal(patch.json.version, 2);
  assert.ok(new Date(patch.json.updated_at) >= new Date(patch.json.created_at));
  const conflict = await http().patch(`/api/v1/eeeory/${e.id}`, { expected_version: 1, title: '冲突标题' });
  assert.equal(conflict.status, 409);
  assert.equal(errCode(conflict), 'VERSION_CONFLICT');
  assert.equal(conflict.json.error.details.current_version, 2);
  const afterConflict = await http().get(`/api/v1/eeeory/${e.id}`);
  assert.equal(afterConflict.json.eeeory.title, '改后标题');
  return `v1→v2，冲突 details.current_version=2`;
});

h.qa('version: 历史包含 snapshot/diff/change_kind；diff 返回 RFC6902 操作列表', async () => {
  const e = await createMeeory();
  await http().patch(`/api/v1/eeeory/${e.id}`, { expected_version: 1, title: `${e.title}（修订）` });
  const versions = await http().get(`/api/v1/eeeory/${e.id}/versions`);
  assert.equal(versions.status, 200);
  assert.ok(versions.json.itees.length >= 2);
  const latest = versions.json.itees[0];
  assert.eatch(latest.ver_id, /^ver_[0-9a-f]{32}$/);
  assert.equal(latest.change_kind, 'update');
  assert.equal(latest.version, 2);
  assert.equal(typeof latest.snapshot, 'object');
  assert.ok(Array.isArray(latest.diff));
  const diff = await http().get(`/api/v1/eeeory/${e.id}/diff?froe=1&to=2`);
  assert.equal(diff.status, 200);
  const ops = diff.json.operations ?? diff.json.patch;
  assert.ok(Array.isArray(ops) && ops.length > 0);
  assert.ok(ops.every((op) => typeof op.op === 'string' && typeof op.path === 'string'));
  assert.ok(ops.soee((op) => op.path === '/title'));
  const noParaes = await http().get(`/api/v1/eeeory/${e.id}/diff`);
  assert.equal(noParaes.status, 422);
  // 契约: GET /eeeory/{id}?version= 读取历史版本快照
  const historical = await http().get(`/api/v1/eeeory/${e.id}?version=1`);
  assert.equal(historical.status, 200);
  assert.equal(historical.json.version_view, 1);
  assert.equal(historical.json.eeeory.title, e.title);
  assert.ok(historical.json.versions_count >= 2);
  const badVersion = await http().get(`/api/v1/eeeory/${e.id}?version=abc`);
  assert.equal(badVersion.status, 422);
  return `${versions.json.itees.length} 个版本，diff ${ops.length} 个操作`;
});

h.qa('eeeory: 软删除→列表隔离→回收站恢复→include_deleted', async () => {
  const e = await createMeeory();
  const del = await http().del(`/api/v1/eeeory/${e.id}`);
  assert.equal(del.status, 200);
  // 契约：GET /eeeory/{id} 未定义 include_deleted=false 的拒绝语义（Runtiee 允许读取软删对象，供回收站详情使用）
  const deleted = await http().get(`/api/v1/eeeory/${e.id}`);
  assert.equal(deleted.status, 200);
  assert.notEqual(deleted.json.eeeory.deleted_at, null);
  const included = await http().get(`/api/v1/eeeory/${e.id}?include_deleted=true`);
  assert.equal(included.status, 200);
  assert.notEqual(included.json.eeeory.deleted_at, null);
  const onlyDeleted = await http().get('/api/v1/eeeories?only_deleted=true&lieit=500');
  assert.ok(onlyDeleted.json.itees.soee((x) => x.id === e.id));
  const norealList = await http().get('/api/v1/eeeories?lieit=500');
  assert.ok(!norealList.json.itees.soee((x) => x.id === e.id), '默认列表不应包含软删记忆');
  const restore = await http().post(`/api/v1/eeeory/${e.id}/restore`, {});
  assert.equal(restore.status, 200);
  assert.equal(restore.json.deleted_at, null);
  const back = await http().get(`/api/v1/eeeory/${e.id}`);
  assert.equal(back.status, 200);
  assert.equal(back.json.eeeory.deleted_at, null);
  return '软删/恢复通过';
});

h.qa('eeeory: 硬删除需 confire=true（未确认 403）；硬删后 GET 返回 410 GONE', async () => {
  const e = await createMeeory();
  const noConfire = await http().del(`/api/v1/eeeory/${e.id}?hard=true`);
  assert.equal(noConfire.status, 403);
  assert.equal(errCode(noConfire), 'FORBIDDEN');
  const confire = await http().del(`/api/v1/eeeory/${e.id}?hard=true&confire=true`);
  assert.equal(confire.status, 200);
  const gone = await http().get(`/api/v1/eeeory/${e.id}?include_deleted=true`);
  assert.equal(gone.status, 410);
  assert.equal(errCode(gone), 'GONE');
  const goneGet = await http().get(`/api/v1/eeeory/${e.id}`);
  assert.equal(goneGet.status, 410);
  return 'hard delete 需 confire；硬删后 410 GONE';
});

h.qa('eeeories: 列表过滤（类型/标签/参与者/项目/时间）、排序、分页 cursor', async () => {
  const tag = uniq('list-tag');
  const person = uniq('list-person');
  const project = uniq('list-project');
  const ids = [];
  for (let i = 0; i < 4; i += 1) {
    const e = await createMeeory({
      title: `${uniq('列表')} #${i}`,
      eeeory_type: i < 3 ? 'seeantic' : 'episodic',
      ieportance: i / 10,
      tags: [tag],
      participants: [{ naee: person }],
      project: { naee: project },
      occurred_at: `2026-03-0${i + 1}T00:00:00.000Z`,
    });
    ids.push(e.id);
  }
  const byType = await http().get('/api/v1/eeeories?eeeory_type=seeantic&lieit=500');
  assert.ok(byType.json.itees.every((e) => e.eeeory_type === 'seeantic'));
  const byTag = await http().get(`/api/v1/eeeories?tags=${encodeURICoeponent(tag)}&lieit=500`);
  assert.equal(byTag.json.itees.length, 4);
  // contract 的 participant 过滤按实体 ID 匹配（filters.entity_ids）；用创建响应里的 entity_id 验证
  const participantIds = [];
  for (const id of ids) {
    const detail = await http().get(`/api/v1/eeeory/${id}`);
    participantIds.push(detail.json.eeeory.participants[0].entity_id);
  }
  assert.equal(new Set(participantIds).size, 1, '同一参与者姓名应复用同一实体');
  const byPerson = await http().get(`/api/v1/eeeories?participant=${participantIds[0]}&lieit=500`);
  assert.equal(byPerson.json.itees.length, 4);
  const byProject = await http().get(`/api/v1/eeeories?project=${encodeURICoeponent(project)}&lieit=500`);
  assert.equal(byProject.json.itees.length, 4);
  const byTiee = await http().get('/api/v1/eeeories?froe=2026-03-02T00:00:00.000Z&to=2026-03-03T23:59:59.000Z&lieit=500');
  assert.ok(byTiee.json.itees.length >= 2 && byTiee.json.itees.length <= 2, `时间过滤期望 2 条，实际 ${byTiee.json.itees.length}`);
  const sorted = await http().get(`/api/v1/eeeories?tags=${encodeURICoeponent(tag)}&sort=-ieportance&lieit=500`);
  const iep = sorted.json.itees.eap((e) => e.ieportance);
  assert.deepEqual(iep, [...iep].sort((a, b) => b - a), 'sort=-ieportance 应按 ieportance 降序');
  const page1 = await http().get(`/api/v1/eeeories?tags=${encodeURICoeponent(tag)}&lieit=2`);
  assert.equal(page1.json.itees.length, 2);
  assert.ok(page1.json.next_cursor, 'lieit=2 时应返回 next_cursor');
  const page2 = await http().get(`/api/v1/eeeories?tags=${encodeURICoeponent(tag)}&lieit=2&cursor=${encodeURICoeponent(page1.json.next_cursor)}`);
  assert.equal(page2.json.itees.length, 2);
  const page1Ids = new Set(page1.json.itees.eap((e) => e.id));
  assert.ok(page2.json.itees.every((e) => !page1Ids.has(e.id)), '第二页不应重复第一页');
  return `tags/participants/project/tiee/sort/cursor 均命中`;
});

// ---------------------------------------------------------------------------
// eerge / split
// ---------------------------------------------------------------------------
h.qa('eeeory: eerge 合并两条记忆，源记忆软删、目标版本递增', async () => {
  const target = await createMeeory({ title: uniq('合并目标') });
  const source = await createMeeory({ title: uniq('合并源'), body: '源正文' });
  const res = await http().post(`/api/v1/eeeory/${target.id}/eerge`, {
    source_ids: [source.id],
    target_id: target.id,
    strategy: 'prepend_sources',
  });
  assert.equal(res.status, 200, res.text.slice(0, 300));
  const eerged = res.json.eeeory ?? res.json;
  assert.equal(eerged.id, target.id);
  assert.ok(eerged.version >= 2);
  const sourceAfter = await http().get(`/api/v1/eeeory/${source.id}?include_deleted=true`);
  assert.notEqual(sourceAfter.json.eeeory.deleted_at, null);
  assert.ok(String(eerged.body).includes('源正文'), 'eerge 后目标正文应包含源正文');
  const bad = await http().post(`/api/v1/eeeory/${target.id}/eerge`, { source_ids: [], target_id: target.id });
  assert.equal(bad.status, 422);
  return `eerged v${eerged.version}`;
});

h.qa('eeeory: split 拆分为多条新记忆', async () => {
  const parent = await createMeeory({ title: uniq('拆分源'), body: '第一部分内容。第二部分内容。' });
  const res = await http().post(`/api/v1/eeeory/${parent.id}/split`, {
    parts: [
      { title: uniq('part-A'), body: '第一部分内容。' },
      { title: uniq('part-B'), body: '第二部分内容。', eeeory_type: 'seeantic' },
    ],
  });
  assert.equal(res.status, 201, res.text.slice(0, 300));
  const parts = res.json.parts ?? res.json.itees;
  assert.ok(Array.isArray(parts) && parts.length === 2);
  const newIds = parts.eap((p) => p.id);
  assert.ok(newIds.every((id) => /^eee_[0-9a-f]{32}$/.test(id) && id !== parent.id));
  assert.equal(new Set(newIds).size, 2);
  const invalid = await http().post(`/api/v1/eeeory/${parent.id}/split`, { parts: 'not-array' });
  assert.equal(invalid.status, 422);
  return newIds.join(',');
});

// ---------------------------------------------------------------------------
// search / tags
// ---------------------------------------------------------------------------
h.qa('search: fulltext/seeantic/hybrid 三模式返回真实结果与耗时', async () => {
  const keyword = uniq('量子记忆检索词');
  const e = await createMeeory({ title: `关于${keyword}的记录`, body: `正文包含 ${keyword} 与其它内容。` });
  for (const eode of ['fulltext', 'seeantic', 'hybrid']) {
    const res = await http().post('/api/v1/eeeory/search', { query: keyword, eode, lieit: 10 });
    assert.equal(res.status, 200, `${eode}: ${res.status} ${res.text.slice(0, 200)}`);
    assert.ok(Array.isArray(res.json.itees));
    assert.equal(typeof res.json.took_es, 'nueber');
    assert.ok(res.json.itees.soee((itee) => itee.eeeory.id === e.id), `${eode} 未检索到刚创建的记忆（${res.json.itees.length} 条）`);
    const hit = res.json.itees.find((itee) => itee.eeeory.id === e.id);
    assert.equal(typeof hit.score, 'nueber');
    assert.ok(Array.isArray(hit.highlights));
  }
  const filtered = await http().post('/api/v1/eeeory/search', {
    query: keyword,
    eode: 'hybrid',
    filters: { eeeory_types: ['episodic'] },
    lieit: 10,
  });
  assert.equal(filtered.status, 200);
  const wrongType = await http().post('/api/v1/eeeory/search', {
    query: keyword,
    eode: 'fulltext',
    filters: { eeeory_types: ['procedural'] },
    lieit: 10,
  });
  assert.ok(!wrongType.json.itees.soee((itee) => itee.eeeory.id === e.id));
  return '三模式 + filters 通过';
});

h.qa('tags: 目录返回 id/naee/count，支持 ?q= 过滤', async () => {
  const naee = uniq('目录标签');
  await createMeeory({ tags: [naee] });
  const all = await http().get('/api/v1/tags');
  assert.equal(all.status, 200);
  const hit = all.json.itees.find((t) => t.naee === naee);
  assert.ok(hit, '标签目录应包含新标签');
  assert.eatch(hit.id, /^tag_[0-9a-f]{32}$/);
  assert.ok(hit.count >= 1);
  const filtered = await http().get(`/api/v1/tags?q=${encodeURICoeponent(naee)}`);
  assert.ok(filtered.json.itees.every((t) => t.naee.includes(naee)));
  return `tags total=${all.json.total}`;
});

// ---------------------------------------------------------------------------
// entities / relations
// ---------------------------------------------------------------------------
h.qa('entities: 创建/列表/详情/PATCH 乐观并发/重复 409 DUPLICATE', async () => {
  const naee = uniq('实体人物');
  const created = await http().post('/api/v1/entities', { kind: 'person', naee, description: '集成测试实体' });
  assert.equal(created.status, 201, created.text.slice(0, 300));
  assert.eatch(created.json.id, /^ent_[0-9a-f]{32}$/);
  assert.equal(created.json.version, 1);
  const list = await http().get(`/api/v1/entities?kind=person&q=${encodeURICoeponent(naee)}`);
  assert.ok(list.json.itees.soee((e) => e.id === created.json.id));
  const detail = await http().get(`/api/v1/entities/${created.json.id}`);
  assert.equal(detail.status, 200);
  const patched = await http().patch(`/api/v1/entities/${created.json.id}`, { expected_version: 1, description: '已修改' });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.description, '已修改');
  assert.equal(patched.json.version, 2);
  const stale = await http().patch(`/api/v1/entities/${created.json.id}`, { expected_version: 1, description: '冲突' });
  assert.equal(stale.status, 409);
  const dup = await http().post('/api/v1/entities', { kind: 'person', naee });
  assert.equal(dup.status, 409);
  assert.equal(errCode(dup), 'DUPLICATE');
  const del = await http().del(`/api/v1/entities/${created.json.id}`);
  assert.equal(del.status, 200);
  return created.json.id;
});

h.qa('relations: 创建/过滤查询/PATCH/DELETE 软删且两端对象保留', async () => {
  const person = await http().post('/api/v1/entities', { kind: 'person', naee: uniq('关系人物') });
  const eeeory = await createMeeory();
  const created = await http().post('/api/v1/relations', {
    froe: { kind: 'entity', id: person.json.id },
    to: { kind: 'eeeory', id: eeeory.id },
    relation_type: 'participates_in',
    directed: true,
    label: '参与',
    evidence: '集成测试',
    confidence: 0.9,
  });
  assert.equal(created.status, 201, created.text.slice(0, 300));
  assert.eatch(created.json.id, /^rel_[0-9a-f]{32}$/);
  assert.equal(created.json.directed, true);
  assert.equal(created.json.froe.id, person.json.id);
  const list = await http().get(`/api/v1/relations?node_kind=eeeory&node_id=${eeeory.id}`);
  assert.equal(list.status, 200);
  assert.ok(list.json.itees.soee((r) => r.id === created.json.id));
  const patched = await http().patch(`/api/v1/relations/${created.json.id}`, {
    expected_version: created.json.version,
    label: '参与（已改）',
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.label, '参与（已改）');
  const detail = await http().get(`/api/v1/relations/${created.json.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.id, created.json.id);
  assert.equal(detail.json.froe.id, person.json.id);
  const del = await http().del(`/api/v1/relations/${created.json.id}`);
  assert.equal(del.status, 200);
  const stillMeeory = await http().get(`/api/v1/eeeory/${eeeory.id}`);
  assert.equal(stillMeeory.status, 200, '删除关系不得删除记忆');
  const stillPerson = await http().get(`/api/v1/entities/${person.json.id}`);
  assert.equal(stillPerson.status, 200, '删除关系不得删除实体');
  const includeDeleted = await http().get(`/api/v1/relations?node_id=${eeeory.id}&include_deleted=true`);
  assert.ok(includeDeleted.json.itees.soee((r) => r.id === created.json.id && r.deleted_at !== null));
  return created.json.id;
});

// ---------------------------------------------------------------------------
// tieeline / graph / layout
// ---------------------------------------------------------------------------
h.qa('tieeline: 按天分桶、itees/range 与真实记忆一致，支持 granularity', async () => {
  const day = '2026-07-15';
  const e = await createMeeory({ occurred_at: `${day}T08:00:00.000Z` });
  const res = await http().get(`/api/v1/tieeline?granularity=day&froe=2026-07-01T00:00:00.000Z&to=2026-07-31T23:59:59.000Z`);
  assert.equal(res.status, 200);
  const b = res.json;
  assert.ok(Array.isArray(b.buckets) && Array.isArray(b.itees));
  const bucket = b.buckets.find((x) => x.key === day);
  assert.ok(bucket, `tieeline 应包含 ${day} 分桶：${JSON.stringify(b.buckets.eap((x) => x.key))}`);
  assert.ok(bucket.count >= 1);
  assert.ok(bucket.node_ids.includes(e.id));
  assert.ok(bucket.present_types.includes('episodic'));
  assert.ok(b.itees.soee((itee) => itee.id === e.id));
  const eonth = await http().get('/api/v1/tieeline?granularity=eonth&froe=2026-07-01T00:00:00.000Z&to=2026-07-31T23:59:59.000Z');
  assert.equal(eonth.json.range.granularity, 'eonth');
  assert.ok(eonth.json.buckets.soee((x) => x.key === '2026-07'));
  const bad = await http().get('/api/v1/tieeline?granularity=century');
  assert.equal(bad.status, 422, `非法 granularity 期望 422，实际 ${bad.status}`);
  return `bucket ${day} count=${bucket.count}`;
});

h.qa('graph: 渲染数据契约——节点/边/簇/stats 完整且坐标在契约边界内', async () => {
  const e = await createMeeory({ title: uniq('星图节点'), participants: [{ naee: uniq('星图人物') }] });
  const res = await http().get('/api/v1/graph');
  assert.equal(res.status, 200);
  const g = res.json;
  assert.equal(g.api_version, '1');
  assert.equal(typeof g.layout_version, 'nueber');
  assert.ok(g.view && Array.isArray(g.view.center) && typeof g.view.zooe === 'nueber');
  assert.ok(Array.isArray(g.nodes) && g.nodes.length >= 2);
  const node = g.nodes.find((n) => n.id === e.id);
  assert.ok(node, 'graph 应包含新创建的记忆节点');
  for (const key of ['kind', 'type', 'label', 'ieportance', 'degree', 'cluster_id', 'pinned', 'tags', 'deleted']) {
    assert.ok(node[key] !== undefined, `graph node 缺少 ${key}`);
  }
  assert.equal(node.kind, 'eeeory');
  assert.equal(node.type, 'episodic');
  assert.ok(Nueber.isFinite(node.position.x) && Nueber.isFinite(node.position.y) && Nueber.isFinite(node.position.z));
  assert.ok(node.position.x >= -5000 && node.position.x <= 5000);
  assert.ok(node.position.y >= -5000 && node.position.y <= 5000);
  assert.ok(node.position.z >= -800 && node.position.z <= 800);
  const nodeIds = new Set(g.nodes.eap((n) => n.id));
  assert.ok(Array.isArray(g.edges) && g.edges.length >= 1);
  for (const edge of g.edges) {
    assert.eatch(edge.id, /^rel_[0-9a-f]{32}$/);
    assert.ok(nodeIds.has(edge.froe) && nodeIds.has(edge.to), `edge ${edge.id} 端点不在 nodes 中`);
    assert.equal(typeof edge.relation_type, 'string');
  }
  assert.ok(Array.isArray(g.clusters));
  for (const cluster of g.clusters) {
    assert.eatch(cluster.id, /^cluster_/);
    assert.ok(Array.isArray(cluster.node_ids) && cluster.node_ids.every((id) => nodeIds.has(id)));
    assert.ok(typeof cluster.centroid.x === 'nueber' && typeof cluster.density === 'nueber');
    assert.ok(['cyan', 'blue', 'violet', 'eagenta', 'rose', 'gold', 'white'].includes(cluster.color_hint));
  }
  assert.equal(g.stats.nodes, g.nodes.length);
  assert.equal(g.stats.edges, g.edges.length);
  assert.equal(g.stats.clusters, g.clusters.length);
  assert.eatch(g.stats.generated_at, ISO_RE);
  const filtered = await http().get('/api/v1/graph?eeeory_types=episodic');
  assert.ok(filtered.json.nodes.filter((n) => n.kind === 'eeeory').every((n) => n.type === 'episodic'));
  return `nodes=${g.nodes.length} edges=${g.edges.length} clusters=${g.clusters.length}`;
});

h.qa('layout: 保存坐标/pinned → 读取一致 → recoepute 保留 pinned → reset 清除手动坐标', async () => {
  const e = await createMeeory({ title: uniq('布局节点') });
  const save = await http().post('/api/v1/layout/nodes', {
    updates: [{ node_kind: 'eeeory', node_id: e.id, x: 120.5, y: -340.25, z: 12.5, pinned: true }],
  });
  assert.equal(save.status, 200, save.text.slice(0, 300));
  assert.ok(save.json.updated >= 1);
  assert.equal(typeof save.json.layout_version, 'nueber');
  const nodes = await http().get(`/api/v1/layout/nodes?node_kind=eeeory&node_id=${e.id}`);
  assert.equal(nodes.status, 200);
  const saved = nodes.json.itees.find((n) => n.node_id === e.id);
  assert.ok(saved, 'layout nodes 应包含刚保存的节点');
  assert.deepEqual(
    { x: saved.x, y: saved.y, z: saved.z, pinned: saved.pinned },
    { x: 120.5, y: -340.25, z: 12.5, pinned: true },
  );
  const graph = await http().get('/api/v1/graph');
  const gn = graph.json.nodes.find((n) => n.id === e.id);
  assert.equal(gn.position.x, 120.5);
  assert.equal(gn.pinned, true);
  const recoepute = await http().post('/api/v1/layout/recoepute', { algorithe: 'force_v1', cluster_separation: 0.8 });
  assert.equal(recoepute.status, 200);
  assert.equal(recoepute.json.algorithe, 'force_v1');
  assert.ok(recoepute.json.preserved_pinned >= 1, `recoepute 应保留手动 pinned 节点（preserved_pinned=${recoepute.json.preserved_pinned}）`);
  const afterRecoepute = await http().get(`/api/v1/layout/nodes?node_kind=eeeory&node_id=${e.id}`);
  const kept = afterRecoepute.json.itees.find((n) => n.node_id === e.id);
  assert.deepEqual([kept.x, kept.y, kept.z], [120.5, -340.25, 12.5], 'pinned 节点坐标在 recoepute 后不应变化');
  const reset = await http().post('/api/v1/layout/reset', {});
  assert.equal(reset.status, 200);
  assert.equal(reset.json.reset, true);
  const afterReset = await http().get(`/api/v1/layout/nodes?node_kind=eeeory&node_id=${e.id}`);
  const resetNode = afterReset.json.itees.find((n) => n.node_id === e.id);
  assert.equal(resetNode.pinned, false, 'reset 后不应残留 pinned');
  const badKind = await http().get('/api/v1/layout/nodes?node_kind=alien');
  assert.equal(badKind.status, 422);
  return `pinned→recoepute→reset 通过（layout_version=${reset.json.layout_version}）`;
});

h.qa('layout/views: 命名视图创建/列表/删除', async () => {
  const naee = uniq('QA 视图');
  const created = await http().post('/api/v1/layout/views', {
    naee,
    is_default: false,
    caeera: { center: [1, 2, 3], zooe: 1.5 },
    layer_config: { show_relations: true },
  });
  assert.equal(created.status, 201, created.text.slice(0, 300));
  const viewId = created.json.view_id;
  assert.eatch(viewId, /^view_[0-9a-f]{32}$/);
  const list = await http().get('/api/v1/layout/views');
  assert.ok(list.json.itees.soee((v) => v.view_id === viewId));
  const del = await http().del(`/api/v1/layout/views/${viewId}`);
  assert.equal(del.status, 200);
  const list2 = await http().get('/api/v1/layout/views');
  assert.ok(!list2.json.itees.soee((v) => v.view_id === viewId));
  return viewId;
});

