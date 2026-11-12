'use strict';

/**
 * 安全测试（真实 Runtime 进程 + 真实 HTTP，不使用 mock）。
 * 覆盖：认证矩阵、非回环监听拒绝、路径穿越（导出/导入/备份）、ZIP 解压炸弹与格式校验、
 *       zip-slip、并发写冲突（PATCH / 幂等事件）、日志脱敏、硬删除权限、CORS、异常输入健壮性。
 *
 * 说明：FCA Runtime 的信任边界为「仅回环地址 + Bearer token」。以下用例区分：
 *  - 断言型（必须通过）：认证、回环限制、日志脱敏、并发、权限、异常输入不崩溃；
 *  - 记录型（风险观察）：路径不受限、解压无上限、无速率限制——如实记录当前行为并在报告中列为风险。
 */
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const h = require('../lib/harness.cjs');
const { buildZip } = require('../lib/zip-build.cjs');
const { assert, http, uniq, c } = h;

const evidence = { risks: [], notes: [] };

function errCode(res) {
  return res.json && res.json.error ? res.json.error.code : null;
}

function lanIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return null;
}

async function createMemory(overrides = {}) {
  const res = await http().post('/api/v1/memory/store', {
    title: `QA 安全记忆 ${uniq('sec')}`,
    body: '安全测试正文。',
    memory_type: 'episodic',
    ...overrides,
  });
  assert.equal(res.status, 201, `创建记忆失败：${res.status} ${res.text.slice(0, 300)}`);
  return res.json;
}

h.lifecycle({
  suite: 'security',
  name: 'security',
  reportExtra: () => evidence,
});

// ---------------------------------------------------------------------------
// 认证与回环
// ---------------------------------------------------------------------------
h.qa('auth: 受保护端点无 token/错误 token 一律 401；/health 免认证；query token 仅 SSE 允许', async () => {
  const endpoints = [
    ['GET', '/api/v1/state'],
    ['GET', '/api/v1/memories'],
    ['GET', '/api/v1/graph'],
    ['GET', '/api/v1/timeline'],
    ['GET', '/api/v1/logs'],
    ['GET', '/api/v1/system/status'],
    ['GET', '/api/v1/backups'],
    ['GET', '/api/v1/llm/providers'],
    ['GET', '/api/v1/db/health'],
    ['POST', '/api/v1/backup'],
  ];
  for (const [method, endpoint] of endpoints) {
    const res = method === 'POST' ? await http().post(endpoint, {}, { token: null }) : await http().get(endpoint, { token: null });
    assert.equal(res.status, 401, `${method} ${endpoint} 无 token 期望 401，实际 ${res.status}`);
    assert.equal(errCode(res), 'UNAUTHORIZED');
  }
  const health = await http().get('/health', { token: null });
  assert.equal(health.status, 200);
  const queryToken = await http().get('/api/v1/state?token=whatever', { token: null });
  assert.equal(queryToken.status, 401, 'query token 仅 SSE 允许，其他端点应 401');
  // SSE：无 token 401；?token= 合法值可连接
  const rt = h.handle();
  const noAuth = c.createSseClient({ url: `http://127.0.0.1:${rt.port}/api/v1/events/stream`, token: null, clientKind: 'test' });
  let sseRejected = false;
  try {
    await noAuth.connect();
    await new Promise((r) => setTimeout(r, 300));
    sseRejected = noAuth.events.length === 0 && noAuth.errors.length > 0;
  } catch {
    sseRejected = true;
  } finally {
    noAuth.close();
  }
  assert.ok(sseRejected, 'SSE 无 token 应被拒绝（401/连接失败）');
  const withQuery = c.createSseClient({
    url: `http://127.0.0.1:${rt.port}/api/v1/events/stream?token=${encodeURIComponent(rt.token)}`,
    token: null,
    clientKind: 'test',
  });
  await withQuery.connect();
  try {
    const ready = await withQuery.waitForEvent((ev) => ev.event === 'fca.ready', 5000, 'fca.ready');
    assert.equal(ready.data.api_version, '1');
  } finally {
    withQuery.close();
  }
  evidence.auth = { checked_endpoints: endpoints.length, sse_query_token: true };
  return `401 x${endpoints.length} + SSE token 校验通过`;
});

h.qa('auth: token 文件为 64 hex；token 不出现在 /health、/state 响应中', async () => {
  const rt = h.handle();
  const token = fs.readFileSync(rt.paths.tokenFile, 'utf8').trim();
  assert.match(token, /^[0-9a-f]{64}$/);
  const health = await http().get('/health', { token: null });
  const state = await http().get('/api/v1/state');
  assert.ok(!JSON.stringify(health.json).includes(token));
  assert.ok(!JSON.stringify(state.json).includes(token));
  return '64 hex token，未泄漏';
});

h.qa('loopback: 配置层拒绝监听非回环地址（--host=0.0.0.0 无 allow-remote 时启动失败）', async () => {
  const nodeBin = c.resolveNodeBin();
  const home = path.join(c.PATHS.QA_HOME_ROOT, 'security', 'nonloopback');
  const result = c.runProcess(nodeBin, [c.PATHS.RUNTIME_ENTRY, 'serve', '--fca-home', home, '--port', '17895', '--host', '0.0.0.0'], {
    cwd: c.ROOT,
    timeoutMs: 30000,
    env: { ...process.env, FCA_HOME: home },
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.code, 0, '非回环监听应启动失败');
  assert.match(output, /拒绝监听非回环地址|allow-remote|allowRemote/i, `输出应包含拒绝原因：${output.slice(0, 800)}`);
  evidence.loopback_refusal = { exit_code: result.code, message: output.replace(/\s+/g, ' ').slice(0, 300) };
  return `exit=${result.code}`;
});

h.qa('loopback: Runtime 仅监听 127.0.0.1，局域网 IP 无法连接', async () => {
  const lan = lanIPv4();
  if (!lan) {
    evidence.notes.push('未找到非回环 IPv4，跳过 LAN 连接探测');
    return 'SKIP: 无 LAN IPv4';
  }
  const rt = h.handle();
  const reachable = await new Promise((resolve) => {
    const sock = net.connect({ port: rt.port, host: lan });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(1200, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
  assert.equal(reachable, false, `Runtime 不应在非回环地址 ${lan} 上可达`);
  evidence.loopback_lan = { lan_ip: lan, reachable };
  return `${lan}:${rt.port} 不可达`;
});

// ---------------------------------------------------------------------------
// 路径穿越 / 备份 ID
// ---------------------------------------------------------------------------
h.qa('path: 导出/导入路径未限制在 exportsDir（相对 .. 可逃逸）——风险如实记录', async () => {
  const rt = h.handle();
  const traversalName = `qa-traversal-${Date.now()}.json`;
  const res = await http().post('/api/v1/export', { format: 'json', path: `..\\${traversalName}` });
  assert.ok(res.status < 300, `导出失败：${res.status}`);
  const escapedOutsideExports = path.dirname(res.json.path) !== rt.paths.exportsDir;
  assert.ok(fs.existsSync(res.json.path));
  evidence.risks.push({
    id: 'SEC-PATH-1',
    severity: 'low',
    title: 'export/import path 未限制在 FCA_HOME/exports，可写/读任意本机路径（需 Bearer token + 回环）',
    observed: res.json.path,
    containment_expected: 'path 应限制在 exportsDir 或明确文档化为本地可信 API',
  });
  // 绝对路径导出同样被接受
  const absDir = path.join(c.ROOT, '.cache', 'qa-security-abs');
  fs.mkdirSync(absDir, { recursive: true });
  const absPath = path.join(absDir, `abs-export-${Date.now()}.json`);
  const abs = await http().post('/api/v1/export', { format: 'json', path: absPath });
  assert.equal(abs.status, 200);
  assert.ok(fs.existsSync(absPath));
  // 导回（导入）该绝对路径文件应成功
  const imp = await http().post('/api/v1/import', { path: absPath });
  assert.equal(imp.status, 200);
  evidence.risks.push({
    id: 'SEC-PATH-2',
    severity: 'low',
    title: 'import 支持任意绝对路径与 ../ 相对路径读取 FCA 格式文件',
    observed: absPath,
  });
  fs.rmSync(res.json.path, { force: true });
  fs.rmSync(absDir, { recursive: true, force: true });
  return `逃逸出 exportsDir=${escapedOutsideExports}（已记录风险）`;
});

h.qa('path: backup_id 不支持路径穿越（404）；备份删除/恢复不接受非法 ID', async () => {
  const bad = await http().post('/api/v1/restore', { backup_id: '../../config/runtime-token' });
  assert.equal(bad.status, 404, `非法 backup_id 期望 404，实际 ${bad.status}`);
  const bad2 = await http().post('/api/v1/restore', { backup_id: '..\\..\\db\\fca.db' });
  assert.equal(bad2.status, 404);
  const badDelete = await http().del('/api/v1/backups/..%2F..%2Fconfig%2Fruntime-token?confirm=true');
  assert.equal(badDelete.status, 404);
  const rt = h.handle();
  assert.ok(fs.existsSync(rt.paths.tokenFile), 'token 文件不得被备份接口影响');
  return '备份接口无路径穿越';
});

// ---------------------------------------------------------------------------
// ZIP 格式 / zip-slip / 解压炸弹
// ---------------------------------------------------------------------------
h.qa('zip: 非 ZIP/ZIP 缺 manifest/损坏数据被 422 IMPORT_FAILED 拒绝，不落盘', async () => {
  const rt = h.handle();
  const dir = rt.paths.exportsDir;
  fs.mkdirSync(dir, { recursive: true });
  const garbageZip = path.join(dir, `qa-garbage-${Date.now()}.zip`);
  fs.writeFileSync(garbageZip, Buffer.from('this is not a zip file at all'));
  const r1 = await http().post('/api/v1/import', { path: garbageZip });
  assert.equal(r1.status, 422, `无效 ZIP 期望 422，实际 ${r1.status}`);
  assert.equal(errCode(r1), 'IMPORT_FAILED');
  const noManifest = path.join(dir, `qa-nomanifest-${Date.now()}.zip`);
  fs.writeFileSync(noManifest, buildZip([{ name: 'memories.jsonl', data: '{"kind":"memory","data":{}}' }]));
  const r2 = await http().post('/api/v1/import', { path: noManifest });
  assert.equal(r2.status, 422);
  assert.match(r2.json.error.message, /manifest/i);
  const badManifest = path.join(dir, `qa-badmanifest-${Date.now()}.zip`);
  fs.writeFileSync(badManifest, buildZip([{ name: 'manifest.json', data: '{"format":"legacy-other-system"}' }]));
  const r3 = await http().post('/api/v1/import', { path: badManifest });
  assert.equal(r3.status, 422);
  return '垃圾/缺 manifest/非法 manifest 均 422';
});

h.qa('zip: zip-slip 条目（../../ 路径）不会被解压写盘', async () => {
  const rt = h.handle();
  const outsideTarget = path.join(rt.fcaHome, 'qa-zipslip-escaped.txt');
  const mark = uniq('zipslip');
  const zipPath = path.join(rt.paths.exportsDir, `qa-zipslip-${Date.now()}.zip`);
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  const manifest = {
    kind: 'manifest',
    format: 'fca-export',
    format_version: '1.0',
    data: { memories: [], entities: [], relations: [], tags: [], versions: [], layout_nodes: [], layout_views: [] },
  };
  fs.writeFileSync(
    zipPath,
    buildZip([
      { name: 'manifest.json', data: JSON.stringify(manifest) },
      { name: '../../qa-zipslip-escaped.txt', data: mark },
      { name: '..\\..\\qa-zipslip-backslash.txt', data: mark },
      { name: 'C:\\qa-zipslip-absolute.txt', data: mark },
    ]),
  );
  const res = await http().post('/api/v1/import', { path: zipPath });
  assert.ok(res.status < 500, `zip-slip 导入不应 500：${res.status} ${res.text.slice(0, 200)}`);
  const dir = rt.paths.exportsDir;
  const escaped = [];
  for (const candidate of [outsideTarget, path.join(rt.fcaHome, '..', 'qa-zipslip-escaped.txt'), path.join(c.ROOT, 'C:\\qa-zipslip-absolute.txt')]) {
    if (fs.existsSync(candidate)) escaped.push(candidate);
  }
  // 逐级向上确认没有在 exportsDir 之外写文件
  let parent = path.dirname(dir);
  for (let i = 0; i < 3; i += 1) {
    for (const name of ['qa-zipslip-escaped.txt', 'qa-zipslip-backslash.txt']) {
      const candidate = path.join(parent, name);
      if (fs.existsSync(candidate)) escaped.push(candidate);
    }
    parent = path.dirname(parent);
  }
  assert.deepEqual(escaped, [], `zip-slip 逃逸写盘：${escaped.join(', ')}`);
  return 'zip-slip 未写盘';
});

h.qa('zip: 解压炸弹（64MB 未压缩 → ~70KB ZIP）被完整解压——风险如实记录', async () => {
  const rt = h.handle();
  const before = await http().get('/api/v1/system/status');
  const rssBefore = before.json.memory.rss_bytes;
  const inflatedBytes = 64 * 1024 * 1024;
  const zipped = buildZip([
    {
      name: 'manifest.json',
      data: JSON.stringify({ kind: 'manifest', format: 'fca-export', format_version: '1.0', data: { memories: [] } }),
    },
    { name: 'junk.jsonl', data: Buffer.alloc(inflatedBytes, 0x30), deflate: true },
  ]);
  const started = Date.now();
  const res = await http().post('/api/v1/import', { zip_base64: zipped.toString('base64') }, { timeoutMs: 120000 });
  const elapsed = Date.now() - started;
  assert.ok(res.status < 500, `解压炸弹不应导致 500：${res.status}`);
  const after = await http().get('/api/v1/system/status');
  const rssAfter = after.json.memory.rss_bytes;
  const health = await http().get('/health', { token: null });
  assert.equal(health.status, 200, '处理解压炸弹后 Runtime 应仍健康');
  const ratio = Number((inflatedBytes / zipped.length).toFixed(1));
  evidence.risks.push({
    id: 'SEC-ZIP-BOMB',
    severity: 'medium',
    title: 'ZIP 导入无解压上限：~70KB 上传可解压 64MB（比例约 1000:1），可放大至 GB 级内存/CPU 消耗',
    compressed_bytes: zipped.length,
    inflated_bytes: inflatedBytes,
    ratio,
    elapsed_ms: elapsed,
    rss_before: rssBefore,
    rss_after: rssAfter,
    status: res.status,
  });
  assert.ok(ratio > 100, '测试 zip 应具备高压缩比');
  return `${zipped.length}B → ${inflatedBytes}B（${ratio}:1），耗时 ${elapsed}ms，RSS ${(rssBefore / 1048576).toFixed(1)}→${(rssAfter / 1048576).toFixed(1)}MB`;
});

// ---------------------------------------------------------------------------
// 并发写冲突
// ---------------------------------------------------------------------------
h.qa('concurrency: 12 个并发 PATCH（同一 expected_version）仅 1 个成功，其余 409 VERSION_CONFLICT', async () => {
  const m = await createMemory();
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => http().patch(`/api/v1/memory/${m.id}`, { expected_version: 1, title: `并发修改 ${i}` })),
  );
  const ok = results.filter((r) => r.status === 200);
  const conflicts = results.filter((r) => r.status === 409);
  assert.equal(ok.length, 1, `期望仅 1 个成功，实际 ${ok.length}（状态：${results.map((r) => r.status).join(',')}）`);
  assert.equal(conflicts.length, 11);
  assert.ok(conflicts.every((r) => errCode(r) === 'VERSION_CONFLICT'));
  const final = await http().get(`/api/v1/memory/${m.id}`);
  assert.equal(final.json.memory.version, 2);
  evidence.concurrency = { patch_success: ok.length, patch_conflict: conflicts.length, final_version: 2 };
  return `1×200 / 11×409，final v2`;
});

h.qa('concurrency: 10 个并发相同 client_event_id 的事件仅落库一次（幂等）', async () => {
  const key = uniq('concurrent-idem');
  const results = await Promise.all(
    Array.from({ length: 10 }, () => http().post('/api/v1/event', { type: 'agent.event_received', client_event_id: key, payload: { n: 1 } })),
  );
  assert.ok(results.every((r) => r.status === 201 || r.status === 200), `并发事件状态异常：${results.map((r) => r.status).join(',')}`);
  const created = results.filter((r) => r.status === 201).length;
  const dup = results.filter((r) => r.status === 200 && r.json.duplicate === true).length;
  assert.equal(created, 1, `应仅 1 个 201 创建，实际 ${created}`);
  assert.equal(dup, 9, `应 9 个 200 duplicate，实际 ${dup}`);
  const ids = new Set(results.map((r) => r.json.event.id));
  assert.equal(ids.size, 1, '幂等事件应返回同一事件 ID');
  evidence.concurrent_events = { created, duplicate: dup };
  return `1×201 / 9×200 duplicate`;
});

// ---------------------------------------------------------------------------
// 权限 / 异常输入 / CORS / 脱敏补充
// ---------------------------------------------------------------------------
h.qa('permission: 硬删除仅限用户（dsh-plugin 客户端 403，test/cli 允许）', async () => {
  const m = await createMemory();
  const byPlugin = await http().del(`/api/v1/memory/${m.id}?hard=true&confirm=true`, { headers: { 'X-FCA-Client': 'dsh-plugin' } });
  assert.equal(byPlugin.status, 403, `dsh-plugin 硬删除期望 403，实际 ${byPlugin.status}`);
  assert.equal(errCode(byPlugin), 'FORBIDDEN');
  const still = await http().get(`/api/v1/memory/${m.id}`);
  assert.equal(still.status, 200, '被拒绝的硬删除不应生效');
  const byCli = await http().del(`/api/v1/memory/${m.id}?hard=true&confirm=true`, { headers: { 'X-FCA-Client': 'cli' } });
  assert.equal(byCli.status, 200);
  return '403 for agent / 200 for user';
});

h.qa('input: 事件 payload 超 256KB 被 422；事件 type 缺失被 400；__proto__ 注入不污染全局', async () => {
  const big = await http().post('/api/v1/event', { type: 'agent.event_received', payload: { blob: 'x'.repeat(300 * 1024) } });
  assert.equal(big.status, 422, `超大 payload 期望 422，实际 ${big.status}`);
  assert.equal(errCode(big), 'VALIDATION_FAILED');
  const noType = await http().post('/api/v1/event', { payload: {} });
  assert.ok([400, 422].includes(noType.status), `缺 type 期望 400/422，实际 ${noType.status}`);
  const pollution = await http().post('/api/v1/memory/store', {
    title: uniq('原型污染'),
    body: 'x',
    __proto__: { polluted: true },
  });
  assert.equal(pollution.status, 201);
  assert.equal({}.polluted, undefined, '服务端不应把 __proto__ 注入全局原型');
  const state = await http().get('/api/v1/state');
  assert.equal(state.status, 200);
  evidence.prototype_pollution = '未发生';
  return 'payload 422 / type 400-422 / 原型未污染';
});

h.qa('input: 路径解码与异常 URI 不产生 500；不存在的 URL 编码路径返回 404', async () => {
  for (const endpoint of ['/api/v1/memory/%2e%2e%2f%2e%2e', '/api/v1/%00bad', '/api/v1/memory/..%5c..%5cstate', '/api/v1/llm/queue/..%2F..%2Fstate/retry']) {
    const res = await http().request('GET', endpoint);
    assert.ok(res.status < 500, `${endpoint} 不应 500，实际 ${res.status} ${res.text.slice(0, 200)}`);
    assert.ok([400, 404, 405].includes(res.status), `${endpoint} 期望 400/404/405，实际 ${res.status}`);
  }
  return '异常 URI 无 500';
});

h.qa('cors: OPTIONS/普通响应带 Access-Control-Allow-Origin（本地 API 的 CORS 放宽，风险记录）', async () => {
  const options = await http().request('OPTIONS', '/api/v1/memory/store', {
    token: null,
    headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
  });
  assert.equal(options.status, 204);
  assert.equal(options.headers['access-control-allow-origin'], '*');
  assert.match(String(options.headers['access-control-allow-headers']), /Authorization/i);
  const normal = await http().get('/api/v1/state', { headers: { Origin: 'https://example.com' } });
  assert.equal(normal.headers['access-control-allow-origin'], '*');
  evidence.risks.push({
    id: 'SEC-CORS',
    severity: 'info',
    title: 'CORS 允许任意 Origin（*）；token 在本地文件且必须显式携带，实际风险低，但浏览器侧网页若获知 token 可跨站调用',
  });
  return 'ACAO=*';
});

h.qa('logs: SSE query token 与错误 token 不出现在日志/事件中', async () => {
  const rt = h.handle();
  const wrongToken = `deadbeef${Date.now().toString(16)}`;
  await http().get('/api/v1/state', { token: wrongToken });
  const sse = c.createSseClient({
    url: `http://127.0.0.1:${rt.port}/api/v1/events/stream?token=${encodeURIComponent(rt.token)}`,
    token: null,
    clientKind: 'test',
  });
  await sse.connect().catch(() => {});
  await sse.waitForEvent((ev) => ev.event === 'fca.ready', 5000, 'fca.ready').catch(() => {});
  sse.close();
  await new Promise((r) => setTimeout(r, 200));
  const logs = await http().get('/api/v1/logs?limit=300');
  const text = JSON.stringify(logs.json.items);
  assert.ok(!text.includes(rt.token), 'SSE query token 不应出现在日志中');
  assert.ok(!text.includes(wrongToken), '错误 token 不应出现在日志中');
  const dir = rt.paths.logsDir;
  let disk = '';
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.log'))) disk += fs.readFileSync(path.join(dir, file), 'utf8');
  assert.ok(!disk.includes(rt.token), '磁盘日志不应包含 runtime token');
  assert.ok(!disk.includes(wrongToken), '磁盘日志不应包含错误 token');
  evidence.log_redaction = 'token 未落日志';
  return 'query token/错误 token 均未落日志';
});

h.qa('rate-limit: 连续 30 次错误 token 请求均 401，Runtime 未实现限流（契约 RATE_LIMITED 未使用，记录）', async () => {
  const statuses = [];
  for (let i = 0; i < 30; i += 1) {
    const res = await http().get('/api/v1/state', { token: `bad${i}` });
    statuses.push(res.status);
  }
  assert.ok(statuses.every((s) => s === 401), `全部应为 401：${statuses.join(',')}`);
  evidence.notes.push('Runtime 未实现 RATE_LIMITED(429) 限流；本地回环 + token 模型下风险低');
  return '30×401，无限流（记录）';
});
