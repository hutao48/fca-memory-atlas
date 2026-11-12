'use strict';

/**
 * 集成测试（二）：真实 Runtime 的运维/事件面。
 * 覆盖：事件与 SSE（首帧/fca.ready/心跳/Last-Event-ID 补发）、备份/恢复（含损坏备份拒绝）、
 *       导出/导入（json/jsonl/zip + 非法格式 + 路径语义）、数据库管理、system/status、
 *       日志与脱敏、LLM 离线队列、错误码矩阵、客户端头偏差、优雅关闭。
 *
 * 该 Runtime 通过环境变量启用 250ms SSE 心跳与 8KB 请求体上限，以真实验证这些机制。
 */
const fs = require('node:fs');
const path = require('node:path');
const h = require('../lib/harness.cjs');
const { assert, http, uniq, c } = h;

const ID_RE = /^[a-z]+_[0-9a-f]{32}$/;
let systemStatusSnapshot = null;
const evidence = {};

function errCode(res) {
  return res.json && res.json.error ? res.json.error.code : null;
}

async function createMemory(overrides = {}) {
  const res = await http().post('/api/v1/memory/store', {
    title: `QA 运维记忆 ${uniq('m')}`,
    body: '运维面集成测试正文。',
    memory_type: 'episodic',
    ...overrides,
  });
  assert.equal(res.status, 201, `创建记忆失败：${res.status} ${res.text.slice(0, 300)}`);
  return res.json;
}

h.lifecycle({
  suite: 'integration-ops',
  name: 'ops',
  env: { FCA_SSE_HEARTBEAT_MS: '250', FCA_MAX_BODY_BYTES: '8192' },
  reportExtra: () => evidence,
});

// ---------------------------------------------------------------------------
// 事件 + SSE
// ---------------------------------------------------------------------------
h.qa('event: 提交事件返回契约事件体；client_event_id 幂等（第二次 200 duplicate:true 且 id 相同）', async () => {
  const key = uniq('idem');
  const first = await http().post('/api/v1/event', {
    type: 'agent.event_received',
    client_event_id: key,
    payload: { note: '幂等测试' },
    subject: { kind: 'agent', id: 'qa' },
  });
  assert.equal(first.status, 201, first.text.slice(0, 300));
  const ev = first.json.event;
  assert.equal(first.json.duplicate, false);
  assert.equal(ev.schema_version, '1.0');
  assert.match(ev.id, /^evt_[0-9a-f]{32}$/);
  assert.equal(typeof ev.seq, 'number');
  assert.equal(ev.type, 'agent.event_received');
  assert.match(ev.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(ev.actor.kind, 'user');
  assert.equal(ev.source.kind, 'test');
  assert.deepEqual(ev.subject, { kind: 'agent', id: 'qa' });
  assert.match(ev.trace_id, /^trc_/);
  assert.equal(ev.client_event_id, key);
  const second = await http().post('/api/v1/event', { type: 'agent.event_received', client_event_id: key, payload: {} });
  assert.equal(second.status, 200);
  assert.equal(second.json.duplicate, true);
  assert.equal(second.json.event.id, ev.id);
  return `seq=${ev.seq}`;
});

h.qa('sse: 连接收到 heartbeat/fca.ready 首帧，订阅后收到 memory.created（event=fca.event, id=seq）', async () => {
  const rt = h.handle();
  const sse = c.createSseClient({
    url: `http://127.0.0.1:${rt.port}/api/v1/events/stream`,
    token: rt.token,
    clientKind: 'test',
  });
  await sse.connect();
  try {
    const heartbeat = await sse.waitForEvent((ev) => ev.event === 'heartbeat', 5000, 'heartbeat 首帧');
    assert.ok(heartbeat.data && typeof heartbeat.data.ts === 'string');
    const ready = await sse.waitForEvent((ev) => ev.event === 'fca.ready', 5000, 'fca.ready 首帧');
    assert.equal(typeof ready.data.seq, 'number');
    assert.equal(ready.data.api_version, '1');
    assert.equal(ready.data.heartbeat_ms, 250);
    const m = await createMemory({ title: uniq('SSE 触发') });
    const ev = await sse.waitForEvent((e) => e.event === 'fca.event' && e.data.type === 'memory.created' && e.data.subject.id === m.id, 8000, 'memory.created');
    assert.match(ev.id, /^\d+$/);
    assert.equal(ev.data.subject.kind, 'memory');
    assert.match(ev.data.trace_id, /^trc_/);
    assert.ok(ev.data.seq >= ready.data.seq);
    evidence.sse = { heartbeat_ms: ready.data.heartbeat_ms, first_event_seq: ev.data.seq, raw_frames: sse.rawFrames.length };
    return `seq=${ev.data.seq}`;
  } finally {
    sse.close();
  }
});

h.qa('sse: Last-Event-ID 断线重连补发缺失事件；types 过滤生效', async () => {
  const rt = h.handle();
  const stateBefore = await http().get('/api/v1/state');
  const seqBefore = stateBefore.json.sync.last_event_seq;
  const m = await createMemory({ title: uniq('重连补发') });
  // 只订阅 memory.* 类型：补发帧应只有匹配类型
  const sse = c.createSseClient({
    url: `http://127.0.0.1:${rt.port}/api/v1/events/stream?types=memory.created,relation.created`,
    token: rt.token,
    clientKind: 'test',
  });
  await sse.connect({ lastEventId: seqBefore });
  try {
    const replayed = await sse.waitForEvent(
      (ev) => ev.event === 'fca.event' && ev.data.type === 'memory.created' && ev.data.subject.id === m.id,
      8000,
      'Last-Event-ID 补发',
    );
    assert.ok(replayed.data.seq > seqBefore);
    const types = sse.events.filter((ev) => ev.event === 'fca.event').map((ev) => ev.data.type);
    assert.ok(types.every((t) => t.startsWith('memory.') || t.startsWith('relation.')), `types 过滤失效：${types.slice(0, 10).join(',')}`);
    evidence.sse_replay = { from_seq: seqBefore, replayed_seq: replayed.data.seq, filtered_types: [...new Set(types)] };
    return `补发 seq ${seqBefore}→${replayed.data.seq}`;
  } finally {
    sse.close();
  }
});

// ---------------------------------------------------------------------------
// 备份 / 恢复
// ---------------------------------------------------------------------------
h.qa('backup: 创建返回 backup_id/path/size/checksum/counts，文件与 manifest 真实落盘，列表 valid/checksum_ok', async () => {
  const created = await http().post('/api/v1/backup', { note: '集成测试备份' });
  assert.equal(created.status, 201, created.text.slice(0, 300));
  const b = created.json;
  assert.match(b.backup_id, /^bak_[0-9a-f]{32}$/);
  assert.ok(fs.existsSync(b.path), `备份文件不存在：${b.path}`);
  assert.ok(b.size > 0 && fs.statSync(b.path).size === b.size);
  assert.match(b.checksum, /^[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(`${b.path}.manifest.json`), 'manifest 文件不存在');
  assert.equal(typeof b.counts.memories, 'number');
  assert.equal(b.schema_version, 1);
  const list = await http().get('/api/v1/backups');
  assert.equal(list.status, 200);
  const item = list.json.items.find((x) => x.backup_id === b.backup_id);
  assert.ok(item, '备份列表应包含新备份');
  assert.equal(item.valid, true);
  assert.equal(item.checksum_ok, true);
  evidence.backup = { size: b.size, took_ms: b.took_ms, counts: b.counts };
  return `${b.backup_id} size=${b.size}B`;
});

h.qa('restore: 备份→新增数据→恢复→数据回到备份时点（requires_restart=false）', async () => {
  const marker = await createMemory({ title: uniq('恢复标记') });
  const backup = await http().post('/api/v1/backup', { note: '恢复往返' });
  assert.equal(backup.status, 201);
  const afterBackup = await createMemory({ title: uniq('备份后新增') });
  const restore = await http().post('/api/v1/restore', { backup_id: backup.json.backup_id });
  assert.equal(restore.status, 200, restore.text.slice(0, 500));
  const r = restore.json;
  assert.equal(r.restored, true);
  assert.equal(r.requires_restart, false);
  assert.equal(typeof r.pre_restore_backup_id, 'string');
  assert.match(r.pre_restore_backup_id, /^bak_/);
  const markerAfter = await http().get(`/api/v1/memory/${marker.id}`);
  assert.equal(markerAfter.status, 200, '恢复后备份时点记忆应存在');
  const afterRestore = await http().get(`/api/v1/memory/${afterBackup.id}?include_deleted=true`);
  assert.equal(afterRestore.status, 404, '恢复后备份之后新增的数据应不存在');
  const dbHealth = await http().get('/api/v1/db/health');
  assert.equal(dbHealth.json.ok, true);
  evidence.restore = { backup_id: backup.json.backup_id, pre_restore_backup_id: r.pre_restore_backup_id };
  return `restored to ${backup.json.backup_id}`;
});

h.qa('restore: 损坏备份（内容被篡改）被校验拒绝（RESTORE_FAILED），当前库不受影响', async () => {
  const backup = await http().post('/api/v1/backup', { note: '损坏测试' });
  assert.equal(backup.status, 201);
  const filePath = backup.json.path;
  fs.writeFileSync(filePath, Buffer.alloc(4096, 0x41)); // 篡改：大小与内容均不符
  const bad = await http().post('/api/v1/restore', { backup_id: backup.json.backup_id });
  assert.equal(bad.status, 500, `损坏备份期望 500，实际 ${bad.status} ${bad.text.slice(0, 200)}`);
  assert.equal(errCode(bad), 'RESTORE_FAILED');
  const list = await http().get('/api/v1/backups');
  const item = list.json.items.find((x) => x.backup_id === backup.json.backup_id);
  assert.equal(item.valid, false, '损坏备份应在列表标记 valid=false');
  const state = await http().get('/api/v1/state');
  assert.equal(state.status, 200, '拒绝恢复后 Runtime 应仍可用');
  await http().del(`/api/v1/backups/${backup.json.backup_id}?confirm=true`);
  return '损坏备份被拒绝且服务可用';
});

h.qa('backup: 删除备份需 confirm=true（422），确认后文件删除且列表不再出现', async () => {
  const backup = await http().post('/api/v1/backup', { note: '删除测试' });
  assert.equal(backup.status, 201);
  const noConfirm = await http().del(`/api/v1/backups/${backup.json.backup_id}`);
  assert.equal(noConfirm.status, 422);
  const del = await http().del(`/api/v1/backups/${backup.json.backup_id}?confirm=true`);
  assert.equal(del.status, 200);
  assert.equal(fs.existsSync(backup.json.path), false, '备份文件应被删除');
  const list = await http().get('/api/v1/backups');
  assert.ok(!list.json.items.some((x) => x.backup_id === backup.json.backup_id));
  const notFound = await http().post('/api/v1/restore', { backup_id: backup.json.backup_id });
  assert.equal(notFound.status, 404);
  return '删除/404 通过';
});

// ---------------------------------------------------------------------------
// 导出 / 导入
// ---------------------------------------------------------------------------
h.qa('export: json/jsonl/zip 三格式真实写盘且内容/计数与 API 一致', async () => {
  const created = [];
  for (let i = 0; i < 3; i += 1) created.push(await createMemory({ title: uniq('导出') }));
  const json = await http().post('/api/v1/export', { format: 'json' });
  assert.equal(json.status, 200, json.text.slice(0, 200));
  assert.equal(json.json.format, 'json');
  assert.ok(fs.existsSync(json.json.path));
  const bundle = JSON.parse(fs.readFileSync(json.json.path, 'utf8'));
  assert.equal(bundle.format, 'fca-export');
  assert.ok(Array.isArray(bundle.data.memories));
  assert.equal(bundle.data.memories.length, json.json.counts.memories);
  const apiList = await http().get('/api/v1/memories?limit=500');
  assert.equal(json.json.counts.memories, apiList.json.total);
  const jsonl = await http().post('/api/v1/export', { format: 'jsonl' });
  assert.equal(jsonl.status, 200);
  const lines = fs.readFileSync(jsonl.json.path, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
  assert.equal(lines[0].kind, 'manifest');
  assert.equal(lines[0].format, 'fca-export');
  assert.ok(lines.length >= jsonl.json.counts.memories);
  const zip = await http().post('/api/v1/export', { format: 'zip' });
  assert.equal(zip.status, 200);
  const zipBuf = fs.readFileSync(zip.json.path);
  assert.equal(zipBuf.subarray(0, 4).toString('latin1'), 'PK\u0003\u0004');
  assert.ok(zip.json.size > 0);
  evidence.export = { json: json.json.size, jsonl: jsonl.json.size, zip: zip.json.size, counts: json.json.counts };
  return `json=${json.json.size}B jsonl=${jsonl.json.size}B zip=${zip.json.size}B`;
});

h.qa('export: filters 生效；非法 format 返回 422', async () => {
  const tag = uniq('导出过滤');
  await createMemory({ tags: [tag] });
  const filtered = await http().post('/api/v1/export', { format: 'json', filters: { tags: [tag] } });
  assert.equal(filtered.status, 200);
  const bundle = JSON.parse(fs.readFileSync(filtered.json.path, 'utf8'));
  assert.equal(bundle.data.memories.length, 1, `filters.tags 期望 1 条，实际 ${bundle.data.memories.length}`);
  assert.equal(bundle.data.memories[0].tags.length, 1);
  const bad = await http().post('/api/v1/export', { format: 'xml' });
  assert.equal(bad.status, 422);
  assert.equal(errCode(bad), 'VALIDATION_FAILED');
  return 'filters + 422 通过';
});

h.qa('import: 导入自身 json/jsonl/zip 导出（ID 重映射、计数真实增加、数据可读）', async () => {
  const source = await createMemory({ title: uniq('导入源') });
  const before = await http().get('/api/v1/state');
  for (const format of ['json', 'jsonl', 'zip']) {
    const exported = await http().post('/api/v1/export', { format });
    assert.equal(exported.status, 200);
    const imported = await http().post('/api/v1/import', { path: exported.json.path });
    assert.equal(imported.status, 200, `${format} import: ${imported.status} ${imported.text.slice(0, 300)}`);
    assert.ok(imported.json.imported.memories >= 1, `${format} imported.memories=${imported.json.imported.memories}`);
    assert.equal(imported.json.format_version, '1.0');
    assert.match(imported.json.import_batch, /^evt_/);
  }
  const after = await http().get('/api/v1/state');
  assert.ok(after.json.counts.memories > before.json.counts.memories, '导入后记忆总数应真实增加');
  const sourceAfter = await http().get(`/api/v1/memory/${source.id}`);
  assert.equal(sourceAfter.status, 200);
  evidence.import = { before: before.json.counts.memories, after: after.json.counts.memories };
  return `memories ${before.json.counts.memories}→${after.json.counts.memories}`;
});

h.qa('import: 非法格式/不存在文件/非 FCA 格式被拒绝', async () => {
  const rt = h.handle();
  const badFile = path.join(rt.paths.exportsDir, 'qa-bad-format.json');
  fs.mkdirSync(path.dirname(badFile), { recursive: true });
  fs.writeFileSync(badFile, JSON.stringify({ format: 'legacy-old-memory-v2', data: {} }), 'utf8');
  const bad = await http().post('/api/v1/import', { path: badFile });
  assert.equal(bad.status, 422, `旧格式导入期望 422，实际 ${bad.status}`);
  assert.equal(errCode(bad), 'IMPORT_FAILED');
  assert.match(bad.json.error.message, /FCA/);
  const missing = await http().post('/api/v1/import', { path: 'not-exist.json' });
  assert.equal(missing.status, 404);
  const badBody = await http().post('/api/v1/import', { path: 123 });
  assert.equal(badBody.status, 400);
  return '422/404/400 通过';
});

// ---------------------------------------------------------------------------
// db / system / logs
// ---------------------------------------------------------------------------
h.qa('db: health 完整性 ok、migrations 有 initial-schema、init 幂等、vacuum 可用', async () => {
  const health = await http().get('/api/v1/db/health');
  assert.equal(health.status, 200);
  const b = health.json;
  assert.equal(b.ok, true);
  assert.equal(b.integrity, 'ok');
  assert.equal(b.initialized, true);
  assert.equal(b.user_version, 1);
  assert.ok(b.counts.memories > 0);
  assert.ok(b.size.db_bytes > 0);
  assert.match(b.path, /fca\.db$/);
  assert.equal(b.migration.items[0].name, 'initial-schema');
  const migrations = await http().get('/api/v1/db/migrations');
  assert.equal(migrations.status, 200);
  assert.equal(migrations.json.user_version, 1);
  assert.ok(migrations.json.items.some((x) => x.name === 'initial-schema'));
  const init = await http().post('/api/v1/db/init', {});
  assert.equal(init.status, 200);
  assert.equal(init.json.created, false);
  assert.equal(init.json.initialized, true);
  const vacuum = await http().post('/api/v1/db/vacuum', {});
  assert.equal(vacuum.status, 200);
  assert.equal(vacuum.json.ok, true);
  assert.equal(typeof vacuum.json.took_ms, 'number');
  evidence.db = { db_bytes: b.size.db_bytes, wal_bytes: b.size.wal_bytes, counts: b.counts };
  return `db=${b.size.db_bytes}B integrity=${b.integrity}`;
});

h.qa('system/status: DB/存储/GPU/LLM/客户端/错误统计/内存字段齐全（记录真实 GPU）', async () => {
  const res = await http().get('/api/v1/system/status');
  assert.equal(res.status, 200);
  const s = res.json;
  systemStatusSnapshot = s;
  for (const key of ['version', 'api_version', 'uptime_ms', 'pid', 'host', 'port', 'node_version', 'platform', 'db', 'storage', 'gpu', 'llm', 'clients', 'errors', 'memory']) {
    assert.ok(s[key] !== undefined, `system/status 缺少 ${key}`);
  }
  assert.equal(s.host, '127.0.0.1');
  assert.equal(s.db.initialized, true);
  assert.equal(s.db.integrity, 'ok');
  assert.ok(s.storage.db_bytes > 0);
  assert.ok(s.memory.rss_bytes > 0);
  if (s.gpu) {
    assert.equal(s.gpu.available, true);
    assert.equal(typeof s.gpu.name, 'string');
    evidence.gpu = s.gpu;
  } else {
    evidence.gpu = { available: false };
  }
  assert.equal(typeof s.errors.count, 'number');
  evidence.system = {
    gpu: s.gpu,
    node_version: s.node_version,
    platform: s.platform,
    memory_rss: s.memory.rss_bytes,
    uptime_ms: s.uptime_ms,
    db_bytes: s.storage.db_bytes,
  };
  return `GPU=${s.gpu ? s.gpu.name : 'n/a'} RSS=${(s.memory.rss_bytes / 1048576).toFixed(1)}MB`;
});

h.qa('logs: 返回脱敏日志尾部；runtime token 与 LLM api_key 不落日志（磁盘文件同样检查）', async () => {
  const rt = h.handle();
  const secret = `sk-qa-SECRET-${Date.now().toString(16)}-do-not-log`;
  const provider = await http().post('/api/v1/llm/providers', {
    name: uniq('日志脱敏'),
    kind: 'openai-compatible',
    base_url: 'http://127.0.0.1:9',
    model: 'qa',
    api_key: secret,
  });
  assert.equal(provider.status, 201, provider.text.slice(0, 300));
  assert.match(String(provider.json.api_key_masked), /\*\*\*/, 'api_key 应以掩码返回');
  assert.ok(!JSON.stringify(provider.json).includes(secret), 'provider 响应不得包含原始 api_key');
  await http().post('/api/v1/llm/complete', { query: uniq('脱敏队列') });
  const logs = await http().get('/api/v1/logs?limit=200');
  assert.equal(logs.status, 200);
  assert.ok(Array.isArray(logs.json.items));
  const logText = JSON.stringify(logs.json.items);
  assert.ok(!logText.includes(secret), '日志接口泄漏 LLM api_key');
  assert.ok(!logText.includes(rt.token), '日志接口泄漏 runtime token');
  assert.ok(!/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/.test(logText), '日志接口出现未脱敏 Bearer');
  // 直接扫描磁盘日志文件（access log / runtime log）
  const dir = rt.paths.logsDir;
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.log')) : [];
  assert.ok(files.length > 0, '未找到日志文件');
  let diskText = '';
  for (const file of files) diskText += fs.readFileSync(path.join(dir, file), 'utf8');
  assert.ok(!diskText.includes(secret), '磁盘日志泄漏 LLM api_key');
  assert.ok(!diskText.includes(rt.token), '磁盘日志泄漏 runtime token');
  const limited = await http().get('/api/v1/logs?limit=2');
  assert.ok(limited.json.items.length <= 2);
  evidence.logs = { files: files.length, bytes: diskText.length, api_key_masked: true };
  await http().del(`/api/v1/llm/providers/${provider.json.provider_id}`);
  return `磁盘日志 ${files.length} 个文件 / ${diskText.length}B 未泄漏 secret`;
});

// ---------------------------------------------------------------------------
// LLM 离线
// ---------------------------------------------------------------------------
h.qa('llm: Provider CRUD（Key 掩码）→ 不可达 API → 202 queued 入队 → retry → 本地读写不受影响', async () => {
  const name = uniq('offline-provider');
  const rawKey = 'sk-offline-qa-key';
  const created = await http().post('/api/v1/llm/providers', {
    name,
    kind: 'openai-compatible',
    base_url: 'http://127.0.0.1:9',
    model: 'offline-model',
    api_key: rawKey,
  });
  assert.equal(created.status, 201, created.text.slice(0, 300));
  assert.match(String(created.json.api_key_masked), /\*\*\*/);
  assert.ok(!JSON.stringify(created.json).includes(rawKey), '原始 API Key 不得出现在响应中');
  assert.equal(created.json.has_api_key, true);
  const dup = await http().post('/api/v1/llm/providers', { name, kind: 'custom' });
  assert.equal(dup.status, 409);
  const list = await http().get('/api/v1/llm/providers');
  assert.ok(list.json.items.some((p) => p.provider_id === created.json.provider_id));
  // 离线（连接 127.0.0.1:9 必然失败）→ 202 queued
  const m = await createMemory({ title: uniq('LLM 离线时写入') });
  const complete = await http().post('/api/v1/llm/complete', {
    query: '总结最近记忆',
    memory_ids: [m.id],
    provider_id: created.json.provider_id,
    offline_queue: true,
  });
  assert.equal(complete.status, 202, `离线 complete 期望 202，实际 ${complete.status} ${complete.text.slice(0, 300)}`);
  assert.equal(complete.json.queued, true);
  assert.match(complete.json.queue_id, /^evt_/);
  assert.equal(complete.json.reason, 'provider_unavailable');
  assert.equal(complete.json.offline, true);
  assert.ok(!complete.json.text, '离线时不得伪造模型输出');
  const queue = await http().get('/api/v1/llm/queue');
  assert.ok(queue.json.items.some((q) => q.queue_id === complete.json.queue_id));
  const retry = await http().post(`/api/v1/llm/queue/${complete.json.queue_id}/retry`, {});
  assert.ok(retry.status === 202, `仍不可达时 retry 期望 202，实际 ${retry.status}`);
  assert.equal(retry.json.queued, true);
  // 离线时本地记忆读写仍然成功
  const read = await http().get(`/api/v1/memory/${m.id}`);
  assert.equal(read.status, 200);
  const patch = await http().patch(`/api/v1/memory/${m.id}`, { expected_version: read.json.memory.version, importance: 0.9 });
  assert.equal(patch.status, 200);
  const noQuery = await http().post('/api/v1/llm/complete', { provider_id: created.json.provider_id });
  assert.equal(noQuery.status, 422);
  await http().del(`/api/v1/llm/providers/${created.json.provider_id}`);
  evidence.llm_offline = { complete_status: complete.status, queue_id: complete.json.queue_id, retry_status: retry.status };
  return '202 queued / retry 202 / 本地读写不受影响';
});

h.qa('llm: 真实 HTTP 上游（本地 stub OpenAI-compatible 服务）→ complete 返回真实输出；队列 retry 成功路径', async () => {
  const nodeHttp = require('node:http');
  let received = 0;
  const server = nodeHttp.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: 'stub-answer: 本地上游返回的真实模型输出' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
          model: 'qa-stub-model',
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const upstreamPort = server.address().port;
  const providerIds = [];
  try {
    const provider = await http().post('/api/v1/llm/providers', {
      name: uniq('stub-provider'),
      kind: 'openai-compatible',
      base_url: `http://127.0.0.1:${upstreamPort}`,
      model: 'qa-stub-model',
      api_key: 'sk-stub-key',
    });
    assert.equal(provider.status, 201);
    providerIds.push(provider.json.provider_id);
    const complete = await http().post('/api/v1/llm/complete', {
      query: '用一句话总结今天的测试',
      provider_id: provider.json.provider_id,
    });
    assert.equal(complete.status, 200, `上游可达时 complete 期望 200，实际 ${complete.status} ${complete.text.slice(0, 300)}`);
    assert.match(String(complete.json.text), /stub-answer/);
    assert.equal(complete.json.offline, false);
    assert.equal(complete.json.queued, false);
    assert.equal(complete.json.model, 'qa-stub-model');
    assert.equal(complete.json.usage.total_tokens, 18);
    assert.ok(received >= 1, 'stub 上游应收到真实 HTTP 请求');

    // 队列 retry 成功路径：先指向死端口入队，再把 base_url 改到可用上游后 retry
    const dead = await http().post('/api/v1/llm/providers', {
      name: uniq('dead-provider'),
      kind: 'openai-compatible',
      base_url: 'http://127.0.0.1:9',
      model: 'dead-model',
    });
    assert.equal(dead.status, 201);
    providerIds.push(dead.json.provider_id);
    const queued = await http().post('/api/v1/llm/complete', {
      query: '先离线后重试',
      provider_id: dead.json.provider_id,
      offline_queue: true,
    });
    assert.equal(queued.status, 202);
    assert.equal(queued.json.queued, true);
    const patched = await http().patch(`/api/v1/llm/providers/${dead.json.provider_id}`, {
      base_url: `http://127.0.0.1:${upstreamPort}`,
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.base_url, `http://127.0.0.1:${upstreamPort}`);
    const retry = await http().post(`/api/v1/llm/queue/${queued.json.queue_id}/retry`, {});
    assert.equal(retry.status, 200, `retry 成功期望 200，实际 ${retry.status} ${retry.text.slice(0, 300)}`);
    assert.equal(retry.json.completed, true);
    assert.match(String(retry.json.text), /stub-answer/);
    evidence.llm_online = { complete_status: complete.status, retry_status: retry.status, usage: complete.json.usage };
    return `complete 200 + retry 200（真实本地 HTTP 上游收到 ${received} 次请求）`;
  } finally {
    for (const id of providerIds) await http().del(`/api/v1/llm/providers/${id}`).catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});
// ---------------------------------------------------------------------------
// 错误码矩阵 / 请求体限制 / 客户端头
// ---------------------------------------------------------------------------
h.qa('errors: 400 非法 JSON、415 Content-Type、413 超限请求体（真实 8KB 上限）', async () => {
  const rt = h.handle();
  const badJson = await http().post('/api/v1/memory/store', undefined, {
    rawBody: '{"title": ',
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(badJson.status, 400);
  assert.equal(errCode(badJson), 'BAD_REQUEST');
  const badType = await http().post('/api/v1/memory/store', undefined, {
    rawBody: 'title=x',
    headers: { 'Content-Type': 'text/plain' },
  });
  assert.equal(badType.status, 415);
  assert.equal(errCode(badType), 'UNSUPPORTED_MEDIA_TYPE');
  const tooLarge = await http().post('/api/v1/memory/store', undefined, {
    rawBody: JSON.stringify({ title: 'x'.repeat(20_000) }),
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(tooLarge.status, 413, `超过 maxBodyBytes(${rt.config?.maxBodyBytes ?? 8192}) 期望 413，实际 ${tooLarge.status}`);
  assert.equal(errCode(tooLarge), 'PAYLOAD_TOO_LARGE');
  evidence.limits = { max_body_bytes: 8192, too_large_status: tooLarge.status };
  return '400/415/413 通过';
});

h.qa('client: 契约允许的 X-FCA-Client 值均被接受；非法值返回 400 BAD_REQUEST', async () => {
  for (const kind of ['desktop', 'dsh-plugin', 'cli', 'test']) {
    const res = await http().get('/api/v1/state', { headers: { 'X-FCA-Client': kind } });
    assert.equal(res.status, 200);
  }
  const invalid = await http().get('/api/v1/state', { headers: { 'X-FCA-Client': 'evil-client' } });
  assert.equal(invalid.status, 400, `非法 X-FCA-Client 应返回 400，实际 ${invalid.status}`);
  assert.equal(errCode(invalid), 'BAD_REQUEST');
  evidence.invalid_client_kind_status = invalid.status;
  return '合法值 4/4 通过；非法值 400 BAD_REQUEST';
});

h.qa('shutdown: dsh-plugin 客户端 403；cli 优雅关闭后进程退出且 /health 不可用', async () => {
  const rt = h.handle();
  const forbidden = await http().post('/api/v1/shutdown', {}, { headers: { 'X-FCA-Client': 'dsh-plugin' } });
  assert.equal(forbidden.status, 403);
  assert.equal(errCode(forbidden), 'FORBIDDEN');
  const ok = await http().post('/api/v1/shutdown', {}, { headers: { 'X-FCA-Client': 'cli' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.shutting_down, true);
  const exited = await c.waitFor(() => rt.exitInfo(), { timeoutMs: 15000, label: 'Runtime 退出' }).catch(() => null);
  assert.ok(exited, '关闭请求后 Runtime 进程应在 15s 内退出');
  assert.equal(exited.code, 0);
  const after = await http().get('/health', { token: null, timeoutMs: 1500 });
  assert.ok(!after.ok || after.status !== 200, `进程退出后 /health 不应再返回 200（实际 status=${after.status}）`);
  evidence.shutdown = { exit_code: exited.code, shutdown_http: ok.status, health_after: after.status };
  return `exit=${exited.code}`;
});
