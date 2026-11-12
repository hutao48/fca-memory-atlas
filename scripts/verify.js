#!/usr/bin/env node
/**
 * FCA Alpha 0.1 端到端验收脚本（真实进程/真实 HTTP，不使用 Mock）。
 * 可在 Runtime 就绪后运行；后续由 QA 扩展为完整 15 节场景 A-F。
 *
 * 用法：node scripts/verify.js [--fca-home=<dir>] [--port=17860]
 * 退出码 0 = 关键验收项通过。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PATHS, PROJECT_ROOT, ensureDir, timestamp } from './lib/common.js';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const FCA_HOME = resolve(option('fca-home', join(PATHS.cache, 'verify-home')));
const PORT = Number(option('port', '17860'));
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readToken() {
  const p = join(FCA_HOME, 'config', 'runtime-token');
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8').trim();
}

async function api(pathname, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-fca-client': 'cli',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function main() {
  console.log(`[verify] FCA_HOME=${FCA_HOME} PORT=${PORT} ${timestamp()}`);
  if (!existsSync(join(PROJECT_ROOT, 'runtime', 'bin', 'fca-runtime.js'))) {
    record('Runtime 源码存在', false, 'runtime/bin/fca-runtime.js not found');
    return finish();
  }
  ensureDir(FCA_HOME);

  // 1. 初始化空库
  const init = spawn(process.execPath, [join(PROJECT_ROOT, 'runtime', 'bin', 'fca-runtime.js'), 'init', `--fca-home=${FCA_HOME}`], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  });
  const initCode = await new Promise((r) => init.on('exit', r));
  record('初始化空白数据库', initCode === 0, `exit=${initCode}`);

  // 2. 启动 Runtime
  const runtime = spawn(process.execPath, [join(PROJECT_ROOT, 'runtime', 'bin', 'fca-runtime.js'), 'serve', `--fca-home=${FCA_HOME}`, `--port=${PORT}`], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  runtime.stdout.on('data', (d) => process.stdout.write(`[runtime] ${d}`));
  runtime.stderr.on('data', (d) => process.stderr.write(`[runtime] ${d}`));

  let healthy = false;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const r = await api('/health');
      if (r.status === 200) {
        healthy = true;
        record('GET /health', true, JSON.stringify(r.json).slice(0, 200));
        break;
      }
    } catch {
      /* not up yet */
    }
  }
  if (!healthy) {
    record('GET /health', false, 'runtime did not become healthy in 15s');
    runtime.kill();
    return finish();
  }

  const token = readToken();
  record('token 文件自动生成', Boolean(token));

  // 3. 认证
  const unauth = await api('/api/v1/state');
  record('未认证请求返回 401', unauth.status === 401, `status=${unauth.status}`);

  // 4. 空图（无假数据）
  const emptyGraph = await api('/api/v1/graph', { token });
  record(
    '空库返回空星图（无假节点）',
    emptyGraph.status === 200 && Array.isArray(emptyGraph.json?.nodes) && emptyGraph.json.nodes.length === 0,
    `nodes=${emptyGraph.json?.nodes?.length}`,
  );

  // 5. 创建人物 + 经历 + 关系（验收场景 B 的前半）
  const person = await api('/api/v1/entities', { method: 'POST', token, body: { kind: 'person', name: '验证人物' } });
  record('创建人物实体', person.status < 300, `status=${person.status}`);
  const mem = await api('/api/v1/memory/store', {
    method: 'POST',
    token,
    body: {
      title: '验证记忆',
      body: '这是一条由验收脚本创建的真实记忆。',
      memory_type: 'episodic',
      occurred_at: new Date().toISOString(),
      occurred_precision: 'exact',
      source: { type: 'user' },
      importance: 0.7,
      participants: [{ name: '验证人物' }],
    },
  });
  record('创建记忆', mem.status < 300, `status=${mem.status}`);
  const memId = mem.json?.id ?? mem.json?.memory?.id;
  record('记忆 ID 规则', typeof memId === 'string' && memId.startsWith('mem_'), memId);
  const rel = await api('/api/v1/relations', {
    method: 'POST',
    token,
    body: {
      from: { kind: 'entity', id: person.json?.id },
      to: { kind: 'memory', id: memId },
      relation_type: 'participates_in',
      directed: true,
      label: '参与',
    },
  });
  record('创建关系（独立实体）', rel.status < 300, `status=${rel.status}`);

  // 6. 乐观并发冲突
  const got = await api(`/api/v1/memory/${memId}`, { token });
  const version = got.json?.memory?.version ?? got.json?.version;
  const patchOk = await api(`/api/v1/memory/${memId}`, {
    method: 'PATCH',
    token,
    body: { expected_version: version, title: '验证记忆（已修改）' },
  });
  record('PATCH 记忆', patchOk.status < 300, `status=${patchOk.status}`);
  const patchConflict = await api(`/api/v1/memory/${memId}`, {
    method: 'PATCH',
    token,
    body: { expected_version: version, title: '过期版本修改' },
  });
  record('版本冲突返回 409/错误码', patchConflict.status === 409 && patchConflict.json?.error?.code === 'VERSION_CONFLICT', JSON.stringify(patchConflict.json).slice(0, 160));

  // 7. 搜索
  const search = await api('/api/v1/memory/search', { method: 'POST', token, body: { query: '验证', limit: 10 } });
  record('全文搜索返回真实结果', search.status === 200 && (search.json?.items?.length ?? 0) > 0, `items=${search.json?.items?.length}`);

  // 8. 星图与布局
  const graph = await api('/api/v1/graph', { token });
  record('星图包含真实节点', graph.status === 200 && (graph.json?.nodes?.length ?? 0) >= 2, `nodes=${graph.json?.nodes?.length} edges=${graph.json?.edges?.length}`);
  record('星图节点含坐标', (graph.json?.nodes ?? []).every((n) => n.position && Number.isFinite(n.position.x)));
  const relayout = await api('/api/v1/layout/recompute', { method: 'POST', token, body: {} });
  record('自动布局接口可用', relayout.status < 300, `status=${relayout.status}`);

  // 9. 事件 + SSE
  const sseController = new AbortController();
  const ssePromise = (async () => {
    const res = await fetch(`${BASE}/api/v1/events/stream`, {
      headers: { authorization: `Bearer ${token}`, 'x-fca-client': 'cli' },
      signal: sseController.signal,
    });
    const reader = res.body.getReader();
    const { value } = await reader.read();
    sseController.abort();
    return new TextDecoder().decode(value);
  })().catch(() => '');
  await sleep(200);
  await api('/api/v1/memory/store', { method: 'POST', token, body: { title: '触发事件', body: '用于 SSE 验证', memory_type: 'semantic' } });
  const sseFrame = await Promise.race([ssePromise, sleep(4000).then(() => '')]);
  record('SSE 推送已提交事件', /fca\.event|event:/.test(sseFrame), sseFrame.slice(0, 120).replace(/\n/g, ' '));

  // 10. 备份 / 恢复
  const backup = await api('/api/v1/backup', { method: 'POST', token, body: {} });
  record('创建备份', backup.status < 300 && Boolean(backup.json?.backup_id), JSON.stringify(backup.json).slice(0, 160));
  const backups = await api('/api/v1/backups', { token });
  record('备份列表可查询', backups.status === 200 && (backups.json?.items?.length ?? backups.json?.backups?.length ?? 0) > 0);

  // 11. 导出 / 系统状态
  const exportRes = await api('/api/v1/export', { method: 'POST', token, body: { format: 'json' } });
  record('完整导出可用', exportRes.status < 300, JSON.stringify(exportRes.json).slice(0, 160));
  const status = await api('/api/v1/system/status', { token });
  record('系统状态可用（含 GPU 探测字段）', status.status === 200 && status.json?.gpu !== undefined, JSON.stringify(status.json?.gpu ?? null));

  // 12. 数据库健康
  const health = await api('/api/v1/db/health', { token });
  record('数据库完整性检查', health.status === 200, JSON.stringify(health.json).slice(0, 200));

  // 13. 关闭 Runtime 并检查进程退出
  const shutdown = await api('/api/v1/shutdown', { method: 'POST', token, body: {} });
  record('优雅关闭', shutdown.status < 300, `status=${shutdown.status}`);
  const exited = await Promise.race([
    new Promise((r) => runtime.on('exit', (code) => r(code))),
    sleep(8000).then(() => 'timeout'),
  ]);
  record('Runtime 进程退出', exited !== 'timeout', `exit=${exited}`);
  if (exited === 'timeout') runtime.kill();

  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[verify] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error('[verify] failed checks:');
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.log('[verify] ALL CHECKS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('[verify] fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
