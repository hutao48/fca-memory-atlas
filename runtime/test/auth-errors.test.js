// 认证与回环限制、错误码映射、追踪 ID、请求校验（真实 Runtime + 真实 HTTP）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, startRuntime, disposeRuntime, runCli, sleep, waitUntil } from './helpers.js';

let rt;
let rtLarge;

before(async () => {
  rt = await startRuntime({ home: makeHome('auth-errors') });
});
after(async () => {
  await disposeRuntime(rt);
  await disposeRuntime(rtLarge);
});

test('GET /health：免认证、契约字段；任何合法客户端的请求都可访问', async () => {
  const response = await fetch(`${rt.url}/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-fca-trace-id').startsWith('trc_'), true);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.version, '0.1.0');
  assert.equal(body.api_version, '1');
  assert.equal(typeof body.uptime_ms, 'number');
  assert.equal(body.initialized, true);
  assert.equal(body.db, 'ok');

  for (const clientKind of ['desktop', 'dsh-plugin', 'cli', 'test']) {
    const res = await fetch(`${rt.url}/health`, { headers: { 'x-fca-client': clientKind } });
    assert.equal(res.status, 200, `合法 X-FCA-Client=${clientKind} 应被接受`);
  }
});

test('认证：缺 token / 错 token → 401 UNAUTHORIZED（含 WWW-Authenticate）；正确 token 通过', async () => {
  const missing = await fetch(`${rt.url}/api/v1/state`);
  assert.equal(missing.status, 401);
  assert.match(String(missing.headers.get('www-authenticate')), /Bearer/);
  const missingBody = await missing.json();
  assert.equal(missingBody.error.code, 'UNAUTHORIZED');
  assert.ok(missingBody.error.trace_id.startsWith('trc_'));

  const wrong = await fetch(`${rt.url}/api/v1/state`, { headers: { authorization: 'Bearer wrong-token-1234567890' } });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error.code, 'UNAUTHORIZED');

  const ok = await rt.api('/api/v1/state');
  assert.equal(ok.status, 200);
  assert.ok(ok.json.identity);
  assert.ok(ok.json.cognition);
  assert.ok(ok.json.counts);
  assert.ok(Array.isArray(ok.json.catalogs.tags));
  assert.ok(Array.isArray(ok.json.catalogs.projects));
  assert.equal(ok.json.api_version, '1');
  assert.ok(ok.json.capabilities.llm);
});

test('追踪 ID：响应头回显客户端 X-FCA-Trace-Id，错误体 trace_id 与响应头一致', async () => {
  const traceId = 'trc_client_supplied_0123456789';
  const missing = await fetch(`${rt.url}/api/v1/state`, { headers: { 'x-fca-trace-id': traceId } });
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get('x-fca-trace-id'), traceId);
  assert.equal((await missing.json()).error.trace_id, traceId);
});

test('错误码：404 NOT_FOUND / 405 METHOD_NOT_ALLOWED + Allow / 415 / 400 / 非法 X-FCA-Client 400', async () => {
  const notFound = await rt.api('/api/v1/not-a-real-endpoint');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.json.error.code, 'NOT_FOUND');

  // 405：该端点只注册了 POST（用无参数路径，避免 /memory/:id 通配匹配）
  const methodNotAllowed = await rt.api('/api/v1/backup');
  assert.equal(methodNotAllowed.status, 405);
  assert.equal(methodNotAllowed.json.error.code, 'METHOD_NOT_ALLOWED');
  assert.ok(String(methodNotAllowed.headers.get('allow')).includes('POST'));

  const badMedia = await fetch(`${rt.url}/api/v1/memory/store`, {
    method: 'POST',
    headers: { authorization: `Bearer ${rt.token}`, 'content-type': 'text/plain' },
    body: 'not json',
  });
  assert.equal(badMedia.status, 415);
  assert.equal((await badMedia.json()).error.code, 'UNSUPPORTED_MEDIA_TYPE');

  const badJson = await fetch(`${rt.url}/api/v1/memory/store`, {
    method: 'POST',
    headers: { authorization: `Bearer ${rt.token}`, 'content-type': 'application/json' },
    body: '{"title": "broken',
  });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error.code, 'BAD_REQUEST');

  const badClient = await fetch(`${rt.url}/api/v1/state`, {
    headers: { authorization: `Bearer ${rt.token}`, 'x-fca-client': 'evil-client' },
  });
  assert.equal(badClient.status, 400);
  assert.equal((await badClient.json()).error.code, 'BAD_REQUEST');

  const badMemory = await rt.api(`/api/v1/memory/mem_${'0'.repeat(32)}`);
  assert.equal(badMemory.status, 404);
  assert.equal(badMemory.json.error.code, 'NOT_FOUND');
});

test('PAYLOAD_TOO_LARGE：超过 maxBodyBytes 的请求 → 413（隔离 Runtime 配置 2KB 上限）', async () => {
  rtLarge = await startRuntime({
    home: makeHome('auth-errors-large'),
    env: { FCA_MAX_BODY_BYTES: '2048' },
  });
  const body = { title: '大请求体测试', body: 'x'.repeat(5000) };
  const response = await rtLarge.api('/api/v1/memory/store', { method: 'POST', body });
  assert.equal(response.status, 413);
  assert.equal(response.json.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(response.json.error.details.max_bytes, 2048);
});

test('NOT_INITIALIZED：未 init 的 Runtime /health=degraded、业务端点 503；POST /db/init 后恢复', async () => {
  const empty = await startRuntime({ home: makeHome('auth-errors-empty'), init: false });
  try {
    const health = await empty.api('/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.status, 'degraded');
    assert.equal(health.json.initialized, false);
    assert.equal(health.json.db, 'uninitialized');

    const state = await empty.api('/api/v1/state');
    assert.equal(state.status, 503);
    assert.equal(state.json.error.code, 'NOT_INITIALIZED');

    const init = await empty.api('/api/v1/db/init', { method: 'POST', body: {} });
    assert.equal(init.status, 201);
    assert.equal(init.json.initialized, true);
    assert.equal(init.json.created, true);
    const after = await empty.api('/api/v1/state');
    assert.equal(after.status, 200);
    const healthAfter = await empty.api('/health');
    assert.equal(healthAfter.json.status, 'ok');
    assert.equal(healthAfter.json.initialized, true);
  } finally {
    await disposeRuntime(empty);
  }
});

test('回环限制：监听非回环地址被配置层拒绝（ConfigError，退出码 2）', async () => {
  const home = makeHome('auth-errors-loopback');
  const result = await runCli(['serve', `--fca-home=${home}`, '--host=0.0.0.0', '--port=17895']);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /拒绝监听非回环地址/);
  const json = JSON.parse(result.stdout.trim());
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'CONFIG_ERROR');
});

test('shutdown：非 cli/desktop/test 客户端 → 403 FORBIDDEN；合法客户端触发优雅关闭且进程退出', async () => {
  const forbidden = await fetch(`${rt.url}/api/v1/shutdown`, {
    method: 'POST',
    headers: { authorization: `Bearer ${rt.token}`, 'x-fca-client': 'dsh-plugin', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error.code, 'FORBIDDEN');
  // 仍可用
  assert.equal((await rt.api('/health')).status, 200);

  const shutdown = await rt.api('/api/v1/shutdown', { method: 'POST', body: {} });
  assert.equal(shutdown.status, 200);
  assert.equal(shutdown.json.ok, true);
  assert.equal(shutdown.json.shutting_down, true);
  await waitUntil(() => rt.childState.exited, { timeoutMs: 8000 });
  assert.equal(rt.childState.exitCode, 0);
  // 关闭后端口不再可用
  await sleep(100);
  await assert.rejects(() => fetch(`${rt.url}/health`));
});
