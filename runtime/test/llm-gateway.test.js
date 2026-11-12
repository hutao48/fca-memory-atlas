// LLM Gateway 真实链路测试（真实 Runtime 子进程 + 真实 HTTP；Provider 使用本地 fake 服务做确定性验证，
// 不声称是真实 DeepSeek/OpenAI API 调用的交付证据——真实 API 需要用户自己的 Key/网络，见 artifacts/reports/runtime-llm-gateway.md）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeHome, startRuntime, disposeRuntime, startFakeProvider, getUnusedPort } from './helpers.js';

const PLAINTEXT_KEY = 'sk-unit-test-1234567890abcdef';
let rt;
let fake;
let providerId;
let deadProviderId;
let noProviderQueueId;

before(async () => {
  rt = await startRuntime({
    home: makeHome('llm-gateway'),
    // 关闭自动重试、缩短退避，保证测试确定性
    env: { FCA_LLM_AUTO_RETRY: 'false', FCA_LLM_QUEUE_RETRY_BASE_MS: '1000' },
  });
  fake = await startFakeProvider();
});

after(async () => {
  await fake?.close();
  await disposeRuntime(rt);
});

test('未配置 Provider：GET providers 空；POST complete 返回 202 {queued:true} 入离线队列（不伪造输出）', async () => {
  const providers = await rt.api('/api/v1/llm/providers');
  assert.equal(providers.status, 200);
  assert.equal(providers.json.total, 0);

  const complete = await rt.api('/api/v1/llm/complete', { method: 'POST', body: { query: '随便问点' } });
  assert.equal(complete.status, 202);
  assert.equal(complete.json.queued, true);
  assert.equal(complete.json.reason, 'no_provider_configured');
  assert.equal(complete.json.offline, true);
  assert.equal(complete.json.error.code, 'LLM_NOT_CONFIGURED');
  noProviderQueueId = complete.json.queue_id;
  assert.ok(String(noProviderQueueId).startsWith('evt_'));

  const queue = await rt.api('/api/v1/llm/queue');
  assert.equal(queue.status, 200);
  const item = queue.json.items.find((entry) => entry.queue_id === noProviderQueueId);
  assert.ok(item);
  assert.equal(item.status, 'pending');
  assert.equal(item.request.reason, 'no_provider_configured');
});

test('Provider CRUD：校验、名称去重、默认选择、Key 掩码；DB 中只有 AES-256-GCM 密文（无明文）', async () => {
  const created = await rt.api('/api/v1/llm/providers', {
    method: 'POST',
    body: {
      name: 'fake-main',
      type: 'openai_compatible', // Desktop 设置页使用的字段/值
      base_url: fake.baseUrl,
      model: 'fake-model',
      api_key: PLAINTEXT_KEY,
      is_default: true,
    },
  });
  assert.equal(created.status, 201);
  providerId = created.json.provider_id;
  assert.match(providerId, /^ent_[0-9a-f]{32}$/);
  assert.equal(created.json.kind, 'openai-compatible');
  assert.equal(created.json.type, 'openai_compatible');
  assert.equal(created.json.has_api_key, true);
  assert.equal(created.json.api_key_masked, 'sk-***cdef');
  assert.equal(created.json.is_default, true);
  assert.equal(JSON.stringify(created.json).includes(PLAINTEXT_KEY), false, '响应不得回显明文 Key');

  // 列表同样只给掩码
  const list = await rt.api('/api/v1/llm/providers');
  assert.equal(list.json.total, 1);
  assert.equal(JSON.stringify(list.json).includes(PLAINTEXT_KEY), false);

  // 数据库落盘为 enc:v1 信封，且无明文
  const db = new DatabaseSync(path.join(rt.home, 'db', 'fca.db'), { readOnly: true });
  try {
    const row = db.prepare('SELECT api_key FROM llm_providers WHERE provider_id = ?').get(providerId);
    assert.match(String(row.api_key), /^enc:v1:/);
    assert.equal(String(row.api_key).includes(PLAINTEXT_KEY), false);
  } finally {
    db.close();
  }
  // 主密钥文件在本机数据目录（secrets/master.key），有内容
  const masterKeyFile = path.join(rt.home, 'secrets', 'master.key');
  assert.ok(fs.existsSync(masterKeyFile), '应生成 secrets/master.key');
  assert.equal(fs.readFileSync(masterKeyFile, 'utf8').trim().length, 64);

  // 名称重复 → 409 DUPLICATE
  const duplicate = await rt.api('/api/v1/llm/providers', {
    method: 'POST',
    body: { name: 'fake-main', kind: 'custom', base_url: fake.baseUrl, model: 'x' },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error.code, 'DUPLICATE');

  // 非法 kind → 422 VALIDATION_FAILED
  const invalid = await rt.api('/api/v1/llm/providers', { method: 'POST', body: { name: 'bad-kind', kind: 'not-a-kind' } });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.json.error.code, 'VALIDATION_FAILED');

  // deepseek 预设默认 base_url/model
  const deepseek = await rt.api('/api/v1/llm/providers', { method: 'POST', body: { name: 'preset-deepseek', kind: 'deepseek', api_key: 'sk-preset' } });
  assert.equal(deepseek.status, 201);
  assert.equal(deepseek.json.base_url, 'https://api.deepseek.com');
  assert.equal(deepseek.json.model, 'deepseek-chat');
  await rt.api(`/api/v1/llm/providers/${deepseek.json.provider_id}`, { method: 'DELETE' });

  // PATCH：模型/超时可更新，Key 不回显
  const patched = await rt.api(`/api/v1/llm/providers/${providerId}`, {
    method: 'PATCH',
    body: { model: 'fake-model-2', timeout_ms: 5000 },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.model, 'fake-model-2');
  assert.equal(patched.json.timeout_ms, 5000);
  assert.equal(JSON.stringify(patched.json).includes(PLAINTEXT_KEY), false);

  // 未配置时入队的请求：配置好默认 Provider 后 retry 应得到真实输出（离线队列恢复）
  const recovered = await rt.api(`/api/v1/llm/queue/${noProviderQueueId}/retry`, { method: 'POST', body: {} });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.json));
  assert.equal(recovered.json.completed, true);
  assert.match(recovered.json.text, /^fake-reply:/);
});

test('POST /llm/complete：真实 HTTP 调用 Provider，返回真实响应 + Bearer Key + 只发送最小上下文（不整库上传）', async () => {
  const target = await rt.api('/api/v1/memory/store', {
    method: 'POST',
    body: { title: 'Alpha 项目周会', body: '本周 Alpha 项目完成 Runtime 集成，下一步做视觉验收。', memory_type: 'project', importance: 0.9 },
  });
  assert.equal(target.status, 201);
  // 构造大量无关记忆：如果整库上传，Provider 会看到全部私有内容；正确实现只上传 top-K 最小上下文。
  const unrelatedIds = [];
  for (let i = 0; i < 30; i += 1) {
    const created = await rt.api('/api/v1/memory/store', {
      method: 'POST',
      body: { title: `无关私人记录 ${i}`, body: `SECRET_MARKER_${i}_XYZ 与 Alpha 无关的私人内容，绝不应整库上传。`, memory_type: 'semantic' },
    });
    assert.equal(created.status, 201);
    unrelatedIds.push(created.json.id);
  }
  const totalMemories = 31;

  const before = fake.requests.length;
  const response = await rt.api('/api/v1/llm/complete', {
    method: 'POST',
    body: { query: 'Alpha 项目进展如何？', max_tokens: 64, temperature: 0.2 },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.queued, false);
  assert.equal(response.json.offline, false);
  assert.match(response.json.text, /^fake-reply:/);
  assert.equal(response.json.content, response.json.text);
  assert.equal(response.json.provider, 'fake-main');
  assert.equal(response.json.provider_id, providerId);
  assert.equal(response.json.model, 'fake-model-2');
  assert.equal(response.json.usage.total_tokens, 18);

  // Provider 端确实收到了真实 HTTP 请求
  assert.equal(fake.requests.length, before + 1);
  const received = fake.requests.at(-1);
  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/v1/chat/completions');
  assert.equal(received.headers.authorization, `Bearer ${PLAINTEXT_KEY}`);
  assert.equal(received.body.model, 'fake-model-2');
  assert.equal(received.body.stream, false);
  assert.equal(received.body.max_tokens, 64);
  assert.equal(received.body.temperature, 0.2);

  // 上下文是最小集合：包含目标记忆文本，未选中的无关记忆不得上传
  const payloadText = JSON.stringify(received.body);
  assert.ok(payloadText.includes('Alpha 项目周会'), '应包含检索到的相关记忆');
  const markerHits = [...payloadText.matchAll(/SECRET_MARKER_(\d+)_XYZ/g)].map((match) => match[1]);
  const uniqueMarkers = new Set(markerHits);
  assert.ok(response.json.context.count >= 1);
  assert.ok(response.json.context.count <= 5, `上下文条数应受 top-K 限制，实际 ${response.json.context.count}`);
  assert.equal(response.json.context.memory_ids.length, response.json.context.count);
  assert.equal(response.json.context.chars <= 6000, true, '上下文受字符预算限制');
  assert.ok(uniqueMarkers.size <= response.json.context.count, '上传的无关记忆数不得超过已选上下文条数');
  assert.ok(uniqueMarkers.size < totalMemories - 1, '不得整库上传（30 条无关记忆不应全部出现）');
  assert.ok(payloadText.length < 40_000, '请求体应远小于整库导出体积');
  const systemMessage = received.body.messages[0];
  assert.equal(systemMessage.role, 'system');
  assert.ok(systemMessage.content.includes('数据来源与筛选说明'));
  assert.ok(systemMessage.content.includes('不发送整库'));
  assert.equal(received.body.messages.at(-1).role, 'user');
  assert.ok(received.body.messages.at(-1).content.includes('Alpha 项目进展'));
});

test('POST /llm/complete：兼容 Desktop 的 messages-only 调用（返回 content 字段）', async () => {
  const before = fake.requests.length;
  const response = await rt.api('/api/v1/llm/complete', {
    method: 'POST',
    body: { provider_id: providerId, messages: [{ role: 'user', content: 'ping（FCA 设置页连接测试）' }], max_tokens: 8 },
  });
  assert.equal(response.status, 200);
  assert.ok(response.json.text.startsWith('fake-reply:'));
  assert.equal(typeof response.json.content, 'string');
  assert.equal(fake.requests.length, before + 1);
  const messages = fake.requests.at(-1).body.messages;
  assert.equal(messages[0].role, 'system');
  assert.equal(messages.at(-1).content, 'ping（FCA 设置页连接测试）');
});

test('配置类错误（Provider 401）如实返回 409 LLM_NOT_CONFIGURED，不伪装成功、不入队', async () => {
  const authFake = await startFakeProvider({ mode: 'auth' });
  try {
    const provider = await rt.api('/api/v1/llm/providers', {
      method: 'POST',
      body: { name: 'auth-fail', type: 'openai_compatible', base_url: authFake.baseUrl, model: 'x', api_key: 'sk-bad-key' },
    });
    assert.equal(provider.status, 201);
    const queueBefore = await rt.api('/api/v1/llm/queue');
    const response = await rt.api('/api/v1/llm/complete', {
      method: 'POST',
      body: { query: '会失败的问题', provider_id: provider.json.provider_id },
    });
    assert.equal(response.status, 409);
    assert.equal(response.json.error.code, 'LLM_NOT_CONFIGURED');
    assert.equal(response.json.error.details.provider_http_status, 401);
    assert.equal(response.json.error.details.queued, false);
    const queueAfter = await rt.api('/api/v1/llm/queue');
    assert.equal(queueAfter.json.total, queueBefore.json.total, '配置类错误不应入队');
    await rt.api(`/api/v1/llm/providers/${provider.json.provider_id}`, { method: 'DELETE' });
  } finally {
    await authFake.close();
  }
});

test('不可达 Provider：complete 返回 202 {queued:true}，队列可查；仍不可达 retry 返回 202；恢复后 retry 返回真实结果', async () => {
  const deadPort = await getUnusedPort();
  const created = await rt.api('/api/v1/llm/providers', {
    method: 'POST',
    body: {
      name: 'dead-provider',
      type: 'openai_compatible',
      base_url: `http://127.0.0.1:${deadPort}/v1`,
      model: 'dead-model',
      api_key: 'sk-dead-key-000000',
    },
  });
  assert.equal(created.status, 201);
  deadProviderId = created.json.provider_id;

  const offline = await rt.api('/api/v1/llm/complete', {
    method: 'POST',
    body: { query: '离线队列测试', provider_id: deadProviderId },
  });
  assert.equal(offline.status, 202);
  assert.equal(offline.json.queued, true);
  assert.equal(offline.json.status, 'pending');
  assert.equal(offline.json.reason, 'provider_unavailable');
  assert.ok(String(offline.json.queue_id).startsWith('evt_'));
  assert.equal(offline.json.error.code, 'LLM_UNAVAILABLE');
  assert.equal(offline.json.error.message.includes('不可达') || offline.json.error.message.includes('超时'), true);

  const queue = await rt.api('/api/v1/llm/queue');
  assert.equal(queue.status, 200);
  const item = queue.json.items.find((entry) => entry.queue_id === offline.json.queue_id);
  assert.ok(item, '离线请求应出现在队列中');
  assert.equal(item.status, 'pending');
  assert.equal(item.attempts, 1);
  assert.ok(item.request.query.includes('离线队列测试'));
  assert.ok(item.next_retry_at === null || typeof item.next_retry_at === 'string');

  // 仍不可达时手动 retry：202 且保持 pending（如实反映）
  const retryFail = await rt.api(`/api/v1/llm/queue/${offline.json.queue_id}/retry`, { method: 'POST', body: {} });
  assert.equal(retryFail.status, 202);
  assert.equal(retryFail.json.queued, true);
  assert.equal(retryFail.json.retryable, true);

  // Provider 恢复（同一 Provider 指向本地 fake 服务）后 retry → 完成并返回真实输出
  const patched = await rt.api(`/api/v1/llm/providers/${deadProviderId}`, {
    method: 'PATCH',
    body: { base_url: fake.baseUrl },
  });
  assert.equal(patched.status, 200);
  const retryOk = await rt.api(`/api/v1/llm/queue/${offline.json.queue_id}/retry`, { method: 'POST', body: {} });
  assert.equal(retryOk.status, 200);
  assert.equal(retryOk.json.completed, true);
  assert.match(retryOk.json.text, /^fake-reply:/);
  assert.equal(retryOk.json.usage.total_tokens, 18);

  // 完成后默认队列不再包含它；?status=completed 可查到结果
  const pendingList = await rt.api('/api/v1/llm/queue');
  assert.equal(pendingList.json.items.some((entry) => entry.queue_id === offline.json.queue_id), false);
  const completedList = await rt.api('/api/v1/llm/queue?status=completed');
  assert.equal(completedList.status, 200);
  const completedItem = completedList.json.items.find((entry) => entry.queue_id === offline.json.queue_id);
  assert.ok(completedItem);
  assert.ok(completedItem.result.text.startsWith('fake-reply:'));

  // 已完成的队列项再次 retry：幂等返回 completed
  const retryAgain = await rt.api(`/api/v1/llm/queue/${offline.json.queue_id}/retry`, { method: 'POST', body: {} });
  assert.equal(retryAgain.status, 200);
  assert.equal(retryAgain.json.completed, true);
  assert.equal(retryAgain.json.already_completed, true);
});

test('offline_queue:false 时不可达直接 503 LLM_UNAVAILABLE（不排队）；队列接口校验与 404', async () => {
  const deadPort = await getUnusedPort();
  const created = await rt.api('/api/v1/llm/providers', {
    method: 'POST',
    body: { name: 'noqueue-provider', type: 'openai_compatible', base_url: `http://127.0.0.1:${deadPort}/v1`, model: 'x' },
  });
  const response = await rt.api('/api/v1/llm/complete', {
    method: 'POST',
    body: { query: '不要排队', provider_id: created.json.provider_id, offline_queue: false },
  });
  assert.equal(response.status, 503);
  assert.equal(response.json.error.code, 'LLM_UNAVAILABLE');
  assert.equal(response.json.error.details.queued, false);

  const badStatus = await rt.api('/api/v1/llm/queue?status=whatever');
  assert.equal(badStatus.status, 422);
  assert.equal(badStatus.json.error.code, 'VALIDATION_FAILED');

  const notFoundRetry = await rt.api('/api/v1/llm/queue/evt_doesnotexist/retry', { method: 'POST', body: {} });
  assert.equal(notFoundRetry.status, 404);
  assert.equal(notFoundRetry.json.error.code, 'NOT_FOUND');

  const invalidComplete = await rt.api('/api/v1/llm/complete', { method: 'POST', body: {} });
  assert.equal(invalidComplete.status, 422);
  assert.equal(invalidComplete.json.error.code, 'VALIDATION_FAILED');
  await rt.api(`/api/v1/llm/providers/${created.json.provider_id}`, { method: 'DELETE' });
});

test('禁用 Provider：显式调用返回 409；删除后列表同步', async () => {
  const created = await rt.api('/api/v1/llm/providers', {
    method: 'POST',
    body: { name: 'to-disable', type: 'custom', base_url: fake.baseUrl, model: 'x', enabled: false },
  });
  assert.equal(created.status, 201);
  const disabled = await rt.api('/api/v1/llm/complete', {
    method: 'POST',
    body: { query: 'x', provider_id: created.json.provider_id },
  });
  assert.equal(disabled.status, 409);
  assert.equal(disabled.json.error.code, 'LLM_NOT_CONFIGURED');
  assert.equal(disabled.json.error.details.reason, 'provider_disabled');
  const removed = await rt.api(`/api/v1/llm/providers/${created.json.provider_id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.deleted, true);
});

test('审计事件：llm.request.sent/completed/queued/failed 真实写入 SQLite 事件表', async () => {
  const db = new DatabaseSync(path.join(rt.home, 'db', 'fca.db'), { readOnly: true });
  try {
    const rows = db.prepare("SELECT type, count(*) c FROM events WHERE type LIKE 'llm.request.%' GROUP BY type").all();
    const types = new Set(rows.map((row) => row.type));
    assert.ok(types.has('llm.request.sent'), `事件类型缺失 sent：${[...types].join(',')}`);
    assert.ok(types.has('llm.request.completed'), `事件类型缺失 completed：${[...types].join(',')}`);
    assert.ok(types.has('llm.request.queued'), `事件类型缺失 queued：${[...types].join(',')}`);
    assert.ok(types.has('llm.request.failed'), `事件类型缺失 failed：${[...types].join(',')}`);
  } finally {
    db.close();
  }
});
