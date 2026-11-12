// 事件：POST /event 幂等 + 校验 + 追踪 ID / SQLite+JSONL 双写 / SSE 推送 + Last-Event-ID 补发（真实 Runtime）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeHome, startRuntime, disposeRuntime, subscribeSse, waitUntil } from './helpers.js';

let rt;
const emittedEventIds = [];

before(async () => {
  rt = await startRuntime({ home: makeHome('events') });
});
after(async () => {
  await disposeRuntime(rt);
});

test('POST /event：client_event_id 幂等、契约事件结构、追踪 ID 回显', async () => {
  const traceId = `trc_${'1'.repeat(32)}`;
  const payload = {
    type: 'agent.event_received',
    ts: '2026-05-20T08:00:00.000Z',
    actor: { kind: 'agent', id: 'dsh-plugin', display: 'DSH Agent' },
    source: { kind: 'test', id: 'test-main', version: '0.1.0' },
    subject: { kind: 'session', id: 'sess-1' },
    payload: { note: '事件审计测试' },
    trace_id: traceId,
    client_event_id: 'client-evt-1',
  };
  const created = await rt.api('/api/v1/event', { method: 'POST', body: payload, headers: { 'x-fca-trace-id': traceId } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.duplicate, false);
  const event = created.json.event;
  assert.match(event.id, /^evt_[0-9a-f]{32}$/);
  assert.equal(event.schema_version, '1.0');
  assert.equal(event.type, 'agent.event_received');
  assert.equal(event.ts, '2026-05-20T08:00:00.000Z');
  assert.deepEqual(event.actor, { kind: 'agent', id: 'dsh-plugin', display: 'DSH Agent' });
  assert.deepEqual(event.source, { kind: 'test', id: 'test-main', version: '0.1.0' });
  assert.deepEqual(event.subject, { kind: 'session', id: 'sess-1' });
  assert.deepEqual(event.payload, { note: '事件审计测试' });
  assert.equal(event.trace_id, traceId);
  assert.equal(event.client_event_id, 'client-evt-1');
  assert.ok(Number.isInteger(event.seq) && event.seq >= 1);
  assert.equal(created.headers.get('x-fca-trace-id'), traceId);
  emittedEventIds.push(event.id);

  // 相同 client_event_id 幂等：返回 200 duplicate:true 且同一条事件
  const duplicate = await rt.api('/api/v1/event', { method: 'POST', body: payload, headers: { 'x-fca-trace-id': traceId } });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.json.duplicate, true);
  assert.equal(duplicate.json.event.id, event.id);
  assert.equal(duplicate.json.event.seq, event.seq);
});

test('POST /event：非法类型/非法 actor/source/超大 payload 如实 4xx', async () => {
  const badType = await rt.api('/api/v1/event', { method: 'POST', body: { type: 'not.a.real.type' } });
  assert.equal(badType.status, 422);
  assert.equal(badType.json.error.code, 'VALIDATION_FAILED');
  const badActor = await rt.api('/api/v1/event', { method: 'POST', body: { type: 'system.error', actor: { kind: 'alien' } } });
  assert.equal(badActor.status, 422);
  const badSource = await rt.api('/api/v1/event', { method: 'POST', body: { type: 'system.error', source: { kind: 'unknown-client' } } });
  assert.equal(badSource.status, 422);
  const notObject = await rt.api('/api/v1/event', { method: 'POST', body: 'just-a-string' });
  assert.equal(notObject.status, 400);
  assert.equal(notObject.json.error.code, 'BAD_REQUEST');
});

test('SSE：fca.event 帧格式、heartbeat/ready 首帧、真实变更推送', async () => {
  const sse = await subscribeSse(rt);
  try {
    // 首帧应是 heartbeat 或 ready（hub 约定先发 heartbeat + fca.ready）
    await waitUntil(() => sse.frames.length >= 1, { timeoutMs: 5000 });
    assert.ok(sse.frames.some((frame) => frame.event === 'heartbeat'), '应收到 heartbeat');
    assert.ok(sse.frames.some((frame) => frame.event === 'fca.ready'), '应收到 fca.ready');
    const ready = sse.frames.find((frame) => frame.event === 'fca.ready');
    assert.equal(ready.data.api_version, '1');
    assert.ok(Number.isInteger(ready.data.seq));

    const created = await rt.api('/api/v1/memory/store', {
      method: 'POST',
      body: { title: 'SSE 推送测试', body: '这条记忆应通过 SSE 推送到客户端。', memory_type: 'episodic' },
    });
    assert.equal(created.status, 201);
    const event = await sse.waitForEvent((item) => item.type === 'memory.created' && item.subject?.id === created.json.id, {
      timeoutMs: 8000,
    });
    assert.equal(event.schema_version, '1.0');
    assert.ok(Number.isInteger(event.seq));
    assert.equal(event.actor.kind, 'user');
    assert.equal(event.source.kind, 'test');
    assert.ok(event.trace_id.startsWith('trc_'));

    // SSE 帧内容：event: fca.event / id: <seq> / data: <Event JSON>
    const frame = sse.frames.find((item) => item.event === 'fca.event' && item.data?.id === event.id);
    assert.ok(frame, '应收到对应 SSE 帧');
    assert.equal(frame.id, event.seq);
    assert.match(frame.raw, /event: fca\.event/);
    assert.match(frame.raw, new RegExp(`id: ${event.seq}`));
    assert.match(frame.raw, /data: \{/);
  } finally {
    await sse.close();
  }
});

test('SSE：types 过滤只推送订阅类型；Last-Event-ID 断线补发缺失事件', async () => {
  const filtered = await subscribeSse(rt, { types: ['memory.created'] });
  try {
    await waitUntil(() => filtered.frames.some((frame) => frame.event === 'fca.ready'), { timeoutMs: 5000 });
    await rt.api('/api/v1/event', {
      method: 'POST',
      body: { type: 'agent.event_received', source: { kind: 'cli' }, payload: { note: '不应被 memory.created 订阅收到' } },
    });
    await rt.api('/api/v1/memory/store', { method: 'POST', body: { title: '过滤测试记忆', body: '应被收到' } });
    const received = await filtered.waitForEvent((item) => item.type === 'memory.created', { timeoutMs: 8000 });
    assert.equal(received.type, 'memory.created');
    // 再等一小会儿，确认 agent.event_received 没被推送
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(filtered.events.some((item) => item.type === 'agent.event_received'), false, 'types 过滤必须生效');
  } finally {
    await filtered.close();
  }

  // 记录当前 seq，制造两个新事件后用 Last-Event-ID 补发
  const state = await rt.api('/api/v1/state');
  const lastSeq = state.json.sync.last_event_seq;
  const one = await rt.api('/api/v1/memory/store', { method: 'POST', body: { title: '补发事件一', body: '补发测试' } });
  const two = await rt.api('/api/v1/memory/store', { method: 'POST', body: { title: '补发事件二', body: '补发测试' } });
  assert.equal(one.status, 201);
  assert.equal(two.status, 201);

  const replay = await subscribeSse(rt, { lastEventId: lastSeq });
  try {
    const replayed = await replay.waitForEvent(
      (item) => (item.type === 'memory.created' && item.subject?.id === one.json.id) || item.subject?.id === two.json.id,
      { timeoutMs: 8000 },
    );
    assert.ok(replayed.seq > lastSeq);
    await waitUntil(
      () => replay.events.some((item) => item.subject?.id === one.json.id) && replay.events.some((item) => item.subject?.id === two.json.id),
      { timeoutMs: 8000 },
    );
    // 补发不包含 lastSeq 之前的事件
    assert.ok(replay.events.every((item) => item.seq > lastSeq));
  } finally {
    await replay.close();
  }
});

test('SSE：?token= 查询参数兼容 EventSource（仅 events/stream 允许）', async () => {
  const controller = new AbortController();
  const response = await fetch(`${rt.url}/api/v1/events/stream?token=${encodeURIComponent(rt.token)}`, {
    headers: { 'x-fca-client': 'test', accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(String(response.headers.get('content-type')), /text\/event-stream/);
  const reader = response.body.getReader();
  const { value } = await reader.read();
  controller.abort();
  assert.match(new TextDecoder().decode(value), /event: heartbeat|event: fca\.ready/);
});

test('事件 JSONL 双写：events-YYYY-MM.jsonl 可追溯到 SQLite 事件表（同一事件双写）', async () => {
  const dir = path.join(rt.home, 'events');
  const files = fs.readdirSync(dir).filter((name) => /^events-\d{4}-\d{2}\.jsonl$/.test(name));
  assert.ok(files.length >= 1, '应生成按月 JSONL 事件日志');
  const lines = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8').trim();
    if (!raw) continue;
    for (const line of raw.split('\n')) {
      const parsed = JSON.parse(line);
      assert.equal(parsed.schema_version, '1.0');
      assert.match(parsed.id, /^evt_[0-9a-f]{32}$/);
      assert.ok(typeof parsed.type === 'string');
      assert.ok(Number.isInteger(parsed.seq));
      lines.push(parsed);
    }
  }
  for (const id of emittedEventIds) {
    assert.ok(lines.some((event) => event.id === id), `JSONL 中缺少事件 ${id}`);
  }
  // JSONL 行与 SQLite 事件表一一对应（seq 唯一；JSONL 中每条事件在 DB 中存在且 seq 一致）
  const seqs = lines.map((event) => event.seq);
  assert.equal(new Set(seqs).size, seqs.length, '同一事件不应在 JSONL 中重复出现');
  const db = new DatabaseSync(path.join(rt.home, 'db', 'fca.db'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT id, seq FROM events').all();
    const byId = new Map(rows.map((row) => [row.id, Number(row.seq)]));
    assert.ok(lines.length <= rows.length, 'JSONL 行数不应多于 SQLite 事件数');
    for (const line of lines) {
      assert.equal(byId.get(line.id), line.seq, `JSONL 事件 seq 与 SQLite 不一致：${line.id}`);
    }
    for (const id of emittedEventIds) assert.ok(byId.has(id), `SQLite 事件表缺少 ${id}`);
    // 客户端连接审计事件（契约 §6）
    assert.ok(
      db.prepare("SELECT count(*) c FROM events WHERE type = 'system.client.connected'").get().c >= 1,
      'SSE 连接应写入 system.client.connected 审计事件',
    );
  } finally {
    db.close();
  }
  const index = await rt.api('/api/v1/state');
  assert.ok(index.json.sync.event_count >= lines.length);
});
