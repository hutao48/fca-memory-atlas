'use strict';

/**
 * E2E 验收场景（真实 Runtime 进程 + 真实 HTTP + 真实 Electron 渲染截图，不使用 mock）。
 *
 * 场景：
 *  A 空库无假数据：新 FCA_HOME → 空图/空库，UI 截图 nodes=0、source=runtime
 *  B 手动创建人物/经历/关系 → 重启后数据与布局（含 pinned 坐标）恢复，UI 截图吃到真实数据
 *  D 编辑同步 + 版本历史：desktop 客户端 PATCH → SSE memory.updated → versions/diff；重启后版本仍可查
 *  E LLM API 断开时本地可读写：provider 指向死端口 → /llm/complete 202 queued；本地读写/搜索/布局正常；重启后仍正常
 *  F 备份 → 模拟数据库损坏 → /restore 校验恢复：损坏期 /state=503，恢复后数据回到备份时点、db/health ok
 *
 * UI 截图复用 desktop-app 的 desktop/main/capture.js（Electron），由 QA 在真实数据上驱动。
 * 可用 FCA_E2E_UI=0 跳过 UI 截图（只跑 API 断言）；完整验收应为 1（默认）。
 *
 * 产出：artifacts/reports/e2e-scenarios.json + artifacts/reports/e2e-scenarios.md + artifacts/reports/e2e/*.png
 */
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const c = require('../e2e/lib/common.cjs');
const rt = require('../e2e/lib/runtime.cjs');
const { runCapture } = require('../e2e/lib/capture.cjs');

const RUN_ID = 'qa-e2e';
const UI = process.env.FCA_E2E_UI !== '0';
const REPORT_DIR = path.join(c.PATHS.REPORTS, 'e2e');
const scenarios = [];
let current = null;
const device = {};

function startScenario(id, title) {
  current = { id, title, status: 'PASS', checks: [], screenshots: [], started_at: c.nowIso() };
  scenarios.push(current);
  console.log(`\n[E2E] ===== 场景 ${id}: ${title} =====`);
}

function check(name, ok, detail = '') {
  current.checks.push({ name, status: ok ? 'PASS' : 'FAIL', detail: String(detail).slice(0, 600) });
  if (!ok) current.status = 'FAIL';
  console.log(`[E2E][${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`);
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    check(name, true, typeof detail === 'string' ? detail : '');
    return true;
  } catch (error) {
    check(name, false, error && error.message ? error.message : String(error));
    return false;
  }
}

function recordCapture(capture) {
  if (!capture) return;
  current.screenshots.push({
    scene: capture.scene,
    path: capture.png_rel,
    bytes: capture.bytes,
    ms: capture.ms,
    exit_code: capture.exitCode,
    captured: capture.captured,
    render_state: capture.state
      ? {
          view: capture.state.view,
          runtime: capture.state.runtime,
          apiVersion: capture.state.apiVersion,
          graphStatus: capture.state.graphStatus,
          source: capture.state.source,
          nodes: capture.state.nodes,
          edges: capture.state.edges,
          clusters: capture.state.clusters,
          quality: capture.state.quality,
          fatal: capture.state.fatal,
          nebula: capture.state.nebula
            ? {
                fps: capture.state.nebula.fps,
                frame_ms: capture.state.nebula.frame_ms,
                p95_frame_ms: capture.state.nebula.p95_frame_ms,
                draw_calls: capture.state.nebula.draw_calls,
                rendered_nodes: capture.state.nebula.rendered_nodes,
                rendered_edges: capture.state.nebula.rendered_edges,
                quality: capture.state.nebula.quality,
                webgl2: capture.state.nebula.webgl2,
                gpu: capture.state.nebula.gpu,
              }
            : null,
        }
      : null,
  });
}

async function withRuntime(options, fn) {
  const handle = await rt.startRuntime(options);
  try {
    return await fn(handle);
  } finally {
    await rt.stopRuntime(handle).catch(() => {});
  }
}

async function createMemory(http, overrides = {}) {
  const res = await http.post('/api/v1/memory/store', {
    title: `QA E2E 记忆 ${Date.now().toString(36)}`,
    body: '真实 E2E 场景数据。',
    memory_type: 'episodic',
    ...overrides,
  });
  assert.equal(res.status, 201, `创建记忆失败：${res.status} ${res.text.slice(0, 300)}`);
  return res.json;
}

async function shutdownAndWait(handle) {
  await rt.stopRuntime(handle);
  assert.ok(handle.exitInfo(), 'Runtime 应已退出');
}

// ---------------------------------------------------------------------------
// 场景实现
// ---------------------------------------------------------------------------
async function scenarioA() {
  startScenario('A', '空库无假数据（全新 FCA_HOME）');
  const home = path.join(c.PATHS.QA_HOME_ROOT, `${RUN_ID}-a`, 'home');
  const handle = await rt.startRuntime({ name: 'a-empty', runId: `${RUN_ID}-a`, fcaHome: home, fresh: true });
  const http = handle.http;
  try {
    await checkAsync('Runtime 健康且数据库已初始化（空库）', async () => {
      const health = await http.get('/health', { token: null });
      assert.equal(health.status, 200);
      assert.equal(health.json.initialized, true);
      assert.equal(health.json.status, 'ok');
      return `api_version=${health.json.api_version} db=${health.json.db}`;
    });
    await checkAsync('graph 为空：nodes=0 / edges=0 / clusters=0（无假节点）', async () => {
      const graph = await http.get('/api/v1/graph');
      assert.equal(graph.status, 200);
      assert.equal(graph.json.nodes.length, 0);
      assert.equal(graph.json.edges.length, 0);
      assert.equal(graph.json.clusters.length, 0);
      assert.equal(graph.json.stats.nodes, 0);
      return 'empty graph';
    });
    await checkAsync('记忆/实体/关系/演示数据计数均为 0；timeline 为空', async () => {
      const state = await http.get('/api/v1/state');
      assert.equal(state.json.counts.memories, 0);
      assert.equal(state.json.counts.entities, 0);
      assert.equal(state.json.counts.relations, 0);
      assert.equal(state.json.counts.demo_memories, 0);
      assert.equal(state.json.catalogs.tags.length, 0);
      const list = await http.get('/api/v1/memories');
      assert.equal(list.json.total, 0);
      const timeline = await http.get('/api/v1/timeline');
      assert.equal(timeline.json.items.length, 0);
      assert.equal(timeline.json.buckets.length, 0);
      return 'counts all 0';
    });
    await checkAsync('系统状态记录真实 GPU / Node / 平台（用于测试设备信息）', async () => {
      const sys = await http.get('/api/v1/system/status');
      assert.equal(sys.status, 200);
      device.gpu = sys.json.gpu;
      device.node_version = sys.json.node_version;
      device.platform = sys.json.platform;
      device.runtime_version = sys.json.version;
      device.api_version = sys.json.api_version;
      device.storage = sys.json.storage;
      return `GPU=${sys.json.gpu ? sys.json.gpu.name : 'n/a'} node=${sys.json.node_version} ${sys.json.platform}`;
    });
    if (UI) {
      const capture = runCapture({ scene: 'A', scenario: 'empty', fcaHome: home, port: handle.port, out: path.join(REPORT_DIR, 'qa-e2e-A-empty.png') });
      recordCapture(capture);
      await checkAsync('UI 截图成功（Electron 真实渲染，空库）', async () => {
        assert.equal(capture.exitCode, 0);
        assert.equal(capture.captured, true);
        assert.ok(capture.bytes > 100_000, `PNG 过小：${capture.bytes}`);
        assert.ok(capture.state, 'stdout 未解析到 [capture] state');
        assert.equal(capture.state.fatal, null);
        return `${capture.png_rel} ${(capture.bytes / 1024).toFixed(0)}KB ${capture.ms}ms`;
      });
      await checkAsync('UI 空态：source=runtime 且 nodes=0（不显示假节点）', async () => {
        assert.equal(capture.state.source, 'runtime');
        assert.equal(capture.state.nodes, 0);
        assert.equal(capture.state.edges, 0);
        assert.equal(capture.state.graphStatus, 'ready');
        return `nodes=${capture.state.nodes} source=${capture.state.source}`;
      });
    }
  } finally {
    await rt.stopRuntime(handle).catch(() => {});
  }
}

async function scenarioB() {
  startScenario('B', '手动创建人物/经历/关系 → 重启后数据与布局恢复');
  const home = path.join(c.PATHS.QA_HOME_ROOT, `${RUN_ID}-b`, 'home');
  let first = null;
  let created = null;
  try {
    first = await rt.startRuntime({ name: 'b-create', runId: `${RUN_ID}-b`, fcaHome: home, fresh: true });
    const http = first.http;
    await checkAsync('初始为空白库', async () => {
      const graph = await http.get('/api/v1/graph');
      assert.equal(graph.json.nodes.length, 0);
      return 'nodes=0';
    });
    await checkAsync('创建人物实体 + 经历记忆（含时间/地点信息）+ 关系', async () => {
      const person = await http.post('/api/v1/entities', { kind: 'person', name: `E2E 人物-${Date.now().toString(36)}`, description: '手动创建的真实人物' });
      assert.equal(person.status, 201);
      const place = await http.post('/api/v1/entities', { kind: 'place', name: '杭州·西湖' });
      assert.equal(place.status, 201);
      const memory = await createMemory(http, {
        title: 'E2E 经历：与 E2E 人物在西湖边讨论记忆系统',
        body: '这是验收场景 B 手动创建的经历。可复现、可检索、可持久化。',
        occurred_at: '2026-11-01T09:30:00.000Z',
        occurred_precision: 'exact',
        participants: [{ name: person.json.name, role: 'participant' }],
        tags: ['E2E 验收', '西湖'],
        project: { name: 'FCA Alpha 验收' },
        importance: 0.8,
      });
      const relation = await http.post('/api/v1/relations', {
        from: { kind: 'entity', id: person.json.id },
        to: { kind: 'memory', id: memory.id },
        relation_type: 'shared_experience',
        directed: false,
        label: '共同经历',
        evidence: 'E2E 场景 B 手动建立',
        confidence: 0.95,
      });
      assert.equal(relation.status, 201);
      created = { personId: person.json.id, placeId: place.json.id, memoryId: memory.id, relationId: relation.json.id, title: memory.title };
      return `person=${person.json.id} memory=${memory.id} relation=${relation.json.id}`;
    });
    await checkAsync('拖动星体：保存 pinned 坐标 (120.5,-340.25,12.5)', async () => {
      const save = await http.post('/api/v1/layout/nodes', {
        updates: [{ node_kind: 'memory', node_id: created.memoryId, x: 120.5, y: -340.25, z: 12.5, pinned: true }],
      });
      assert.equal(save.status, 200);
      assert.ok(save.json.updated >= 1);
      created.layoutVersion = save.json.layout_version;
      return `layout_version=${save.json.layout_version}`;
    });
    await checkAsync('星图/时间线包含真实数据', async () => {
      const graph = await http.get('/api/v1/graph');
      assert.ok(graph.json.nodes.length >= 3);
      assert.ok(graph.json.edges.length >= 1);
      assert.ok(graph.json.clusters.length >= 1);
      const timeline = await http.get('/api/v1/timeline?granularity=day');
      assert.ok(timeline.json.items.some((m) => m.id === created.memoryId));
      return `nodes=${graph.json.nodes.length} edges=${graph.json.edges.length} clusters=${graph.json.clusters.length}`;
    });
    await shutdownAndWait(first);
    first = null;

    // 重启（同一 FCA_HOME，不 fresh）
    const restarted = await rt.startRuntime({ name: 'b-restart', runId: `${RUN_ID}-b`, fcaHome: home, fresh: false });
    try {
      await checkAsync('重启后记忆/人物/关系数据完整恢复', async () => {
        const memory = await restarted.http.get(`/api/v1/memory/${created.memoryId}`);
        assert.equal(memory.status, 200);
        assert.equal(memory.json.memory.title, created.title);
        assert.equal(memory.json.memory.id, created.memoryId);
        const person = await restarted.http.get(`/api/v1/entities/${created.personId}`);
        assert.equal(person.status, 200);
        const relations = await restarted.http.get(`/api/v1/relations?node_kind=memory&node_id=${created.memoryId}`);
        assert.ok(relations.json.items.some((r) => r.id === created.relationId));
        return 'memory/entity/relation 均恢复';
      });
      await checkAsync('重启后布局与 pinned 坐标恢复（星图位置一致）', async () => {
        const nodes = await restarted.http.get(`/api/v1/layout/nodes?node_kind=memory&node_id=${created.memoryId}`);
        const node = nodes.json.items.find((n) => n.node_id === created.memoryId);
        assert.ok(node, '布局记录应存在');
        assert.deepEqual({ x: node.x, y: node.y, z: node.z, pinned: node.pinned }, { x: 120.5, y: -340.25, z: 12.5, pinned: true });
        const graph = await restarted.http.get('/api/v1/graph');
        const gn = graph.json.nodes.find((n) => n.id === created.memoryId);
        assert.equal(gn.position.x, 120.5);
        assert.equal(gn.position.y, -340.25);
        assert.equal(gn.pinned, true);
        assert.ok(graph.json.layout_version >= created.layoutVersion);
        return `pinned 坐标恢复，layout_version=${graph.json.layout_version}`;
      });
      if (UI) {
        const capture = runCapture({ scene: 'B', fcaHome: home, port: restarted.port, out: path.join(REPORT_DIR, 'qa-e2e-B-atlas.png'), wait: 3000 });
        recordCapture(capture);
        await checkAsync('UI 截图成功且吃到真实数据（source=runtime, nodes>=3）', async () => {
          assert.equal(capture.exitCode, 0);
          assert.equal(capture.captured, true);
          assert.ok(capture.bytes > 100_000);
          assert.ok(capture.state, 'stdout 未解析到 [capture] state');
          assert.equal(capture.state.source, 'runtime');
          assert.ok(capture.state.nodes >= 3, `渲染节点数=${capture.state.nodes}`);
          assert.ok(capture.state.edges >= 1);
          assert.equal(capture.state.fatal, null);
          return `${capture.png_rel} nodes=${capture.state.nodes} edges=${capture.state.edges} fps=${capture.state.nebula ? capture.state.nebula.fps : 'n/a'}`;
        });
      }
    } finally {
      await rt.stopRuntime(restarted).catch(() => {});
    }
  } finally {
    if (first) await rt.stopRuntime(first).catch(() => {});
  }
}

async function scenarioD() {
  startScenario('D', '编辑同步 + 版本历史（SSE 实时推送 / 版本与 diff / 重启后仍可追溯）');
  const home = path.join(c.PATHS.QA_HOME_ROOT, `${RUN_ID}-d`, 'home');
  const handle = await rt.startRuntime({ name: 'd-edit', runId: `${RUN_ID}-d`, fcaHome: home, fresh: true });
  let memory = null;
  try {
    const http = handle.http;
    memory = await createMemory(http, { title: 'E2E-D 待编辑记忆', body: '原始正文', importance: 0.3 });
    const sse = c.createSseClient({
      url: `http://127.0.0.1:${handle.port}/api/v1/events/stream`,
      token: handle.token,
      clientKind: 'test',
    });
    await sse.connect();
    try {
      await checkAsync('desktop 客户端 PATCH 记忆（乐观并发 expected_version=1）', async () => {
        const res = await http.patch(`/api/v1/memory/${memory.id}`, { expected_version: 1, title: 'E2E-D 已编辑标题', importance: 0.9 });
        assert.equal(res.status, 200);
        assert.equal(res.json.version, 2);
        return `v${res.json.version}`;
      });
      await checkAsync('SSE 实时收到 memory.updated 事件（subject=该记忆）', async () => {
        const ev = await sse.waitForEvent((e) => e.event === 'fca.event' && e.data.type === 'memory.updated' && e.data.subject.id === memory.id, 8000, 'memory.updated SSE');
        assert.ok(ev.data.seq > 0);
        return `seq=${ev.data.seq}`;
      });
    } finally {
      sse.close();
    }
    await checkAsync('版本历史 2 个版本且快照标题可区分', async () => {
      const versions = await http.get(`/api/v1/memory/${memory.id}/versions`);
      assert.equal(versions.status, 200);
      assert.ok(versions.json.items.length >= 2);
      const titles = versions.json.items.map((v) => v.snapshot && v.snapshot.title).filter(Boolean);
      assert.ok(titles.includes('E2E-D 待编辑记忆'));
      assert.ok(titles.includes('E2E-D 已编辑标题'));
      return versions.json.items.map((v) => `v${v.version}:${v.change_kind}`).join(',');
    });
    await checkAsync('版本差异 diff(1→2) 包含 /title 与 /importance 操作', async () => {
      const diff = await http.get(`/api/v1/memory/${memory.id}/diff?from=1&to=2`);
      assert.equal(diff.status, 200);
      const ops = diff.json.operations ?? diff.json.patch;
      assert.ok(ops.some((op) => op.path === '/title'));
      assert.ok(ops.some((op) => op.path === '/importance'));
      return `${ops.length} ops`;
    });
    await shutdownAndWait(handle);
    const restarted = await rt.startRuntime({ name: 'd-restart', runId: `${RUN_ID}-d`, fcaHome: home, fresh: false });
    try {
      await checkAsync('重启后版本历史仍可查（≥2 且最新版本为编辑后内容）', async () => {
        const versions = await restarted.http.get(`/api/v1/memory/${memory.id}/versions`);
        assert.ok(versions.json.items.length >= 2);
        const current = await restarted.http.get(`/api/v1/memory/${memory.id}`);
        assert.equal(current.json.memory.title, 'E2E-D 已编辑标题');
        assert.equal(current.json.memory.version, 2);
        return `versions=${versions.json.items.length}`;
      });
    } finally {
      await rt.stopRuntime(restarted).catch(() => {});
    }
  } finally {
    await rt.stopRuntime(handle).catch(() => {});
  }
}

async function scenarioE() {
  startScenario('E', 'LLM API 断开时本地可读写（离线队列，不伪造输出）');
  const home = path.join(c.PATHS.QA_HOME_ROOT, `${RUN_ID}-e`, 'home');
  const handle = await rt.startRuntime({ name: 'e-offline', runId: `${RUN_ID}-e`, fcaHome: home, fresh: true });
  let memory = null;
  let provider = null;
  try {
    const http = handle.http;
    await checkAsync('配置一个不可达的 LLM Provider（127.0.0.1:9）', async () => {
      provider = await http.post('/api/v1/llm/providers', {
        name: `E2E 离线 Provider ${Date.now().toString(36)}`,
        kind: 'openai-compatible',
        base_url: 'http://127.0.0.1:9',
        model: 'offline',
        api_key: 'sk-e2e-offline',
      });
      assert.equal(provider.status, 201);
      assert.ok(/^.*\*\*\*.*$/.test(String(provider.json.api_key_masked)));
      return provider.json.provider_id;
    });
    memory = await createMemory(http, { title: 'E2E-E 离线期间创建的记忆', body: 'LLM 不可达时本地写入必须成功。' });
    await checkAsync('LLM complete 在 API 断开时返回 202 queued（不伪造输出）', async () => {
      const res = await http.post('/api/v1/llm/complete', { query: '总结这条记忆', memory_ids: [memory.id], provider_id: provider.json.provider_id, offline_queue: true });
      assert.equal(res.status, 202);
      assert.equal(res.json.queued, true);
      assert.equal(res.json.offline, true);
      assert.equal(res.json.reason, 'provider_unavailable');
      assert.ok(!res.json.text, '离线响应不得包含伪造的文本输出');
      return `queue_id=${res.json.queue_id}`;
    });
    await checkAsync('离线期间本地读写/搜索/布局全部可用', async () => {
      const read = await http.get(`/api/v1/memory/${memory.id}`);
      assert.equal(read.status, 200);
      const patch = await http.patch(`/api/v1/memory/${memory.id}`, { expected_version: 1, importance: 0.88 });
      assert.equal(patch.status, 200);
      const search = await http.post('/api/v1/memory/search', { query: '离线期间', mode: 'hybrid', limit: 5 });
      assert.ok(search.json.items.some((i) => i.memory.id === memory.id));
      const layout = await http.post('/api/v1/layout/recompute', {});
      assert.equal(layout.status, 200);
      const graph = await http.get('/api/v1/graph');
      assert.ok(graph.json.nodes.some((n) => n.id === memory.id));
      return '读/写/搜索/布局均可用';
    });
    await checkAsync('离线队列可查询且包含该请求', async () => {
      const queue = await http.get('/api/v1/llm/queue');
      assert.ok(queue.json.items.some((q) => q.status === 'pending' || q.status === 'failed'));
      return `queue=${queue.json.items.length}`;
    });
    await shutdownAndWait(handle);
    const restarted = await rt.startRuntime({ name: 'e-restart', runId: `${RUN_ID}-e`, fcaHome: home, fresh: false });
    try {
      await checkAsync('重启后离线队列与本地记忆仍在，本地读写继续可用', async () => {
        const read = await restarted.http.get(`/api/v1/memory/${memory.id}`);
        assert.equal(read.status, 200);
        const queue = await restarted.http.get('/api/v1/llm/queue');
        assert.ok(queue.json.items.length >= 1, '离线队列应持久化');
        const write = await createMemory(restarted.http, { title: 'E2E-E 重启后本地继续写入' });
        assert.equal(write.id.startsWith('mem_'), true);
        return `queue=${queue.json.items.length}`;
      });
    } finally {
      await rt.stopRuntime(restarted).catch(() => {});
    }
  } finally {
    await rt.stopRuntime(handle).catch(() => {});
  }
}

async function scenarioF() {
  startScenario('F', '备份 → 模拟数据库损坏 → /restore 校验恢复');
  const home = path.join(c.PATHS.QA_HOME_ROOT, `${RUN_ID}-f`, 'home');
  const handle = await rt.startRuntime({ name: 'f-backup', runId: `${RUN_ID}-f`, fcaHome: home, fresh: true });
  let backup = null;
  let baseMemory = null;
  let postMemory = null;
  try {
    const http = handle.http;
    baseMemory = await createMemory(http, { title: 'E2E-F 备份时点记忆', body: '备份必须包含这条。' });
    await checkAsync('创建备份并校验 manifest/sha256', async () => {
      backup = await http.post('/api/v1/backup', { note: 'E2E-F 恢复测试' });
      assert.equal(backup.status, 201);
      assert.ok(fs.existsSync(backup.json.path));
      assert.match(backup.json.sha256, /^[0-9a-f]{64}$/);
      return `${backup.json.backup_id} size=${backup.json.size}`;
    });
    postMemory = await createMemory(http, { title: 'E2E-F 备份后新增记忆', body: '恢复后应消失。' });
    await shutdownAndWait(handle);
  } finally {
    await rt.stopRuntime(handle).catch(() => {});
  }

  // 故障注入：直接破坏 SQLite 主文件（模拟磁盘损坏）
  const dbPath = path.join(home, 'db', 'fca.db');
  await checkAsync('故障注入：把 fca.db 写成垃圾数据（模拟损坏），删除 WAL/SHM', async () => {
    assert.ok(fs.existsSync(dbPath), 'db 文件应存在');
    fs.writeFileSync(dbPath, Buffer.concat([Buffer.from('CORRUPTED-FCA-DB-BY-QA-F'), Buffer.alloc(8192, 0x00)]));
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    return `${dbPath} 已破坏`;
  });

  const degraded = await rt.startRuntime({ name: 'f-degraded', runId: `${RUN_ID}-f`, fcaHome: home, fresh: false, recover: true });
  try {
    await checkAsync('/health 在数据库损坏时报告 degraded（进程仍可提供恢复入口）', async () => {
      const health = await degraded.http.get('/health', { token: null });
      assert.equal(health.status, 200);
      assert.equal(health.json.status, 'degraded');
      assert.equal(health.json.db, 'error');
      return `status=${health.json.status} db=${health.json.db}`;
    });
    await checkAsync('数据库损坏时业务端点返回 503 DATABASE_ERROR（不返回假数据）', async () => {
      const res = await degraded.http.get('/api/v1/state');
      assert.equal(res.status, 503);
      assert.equal(res.json.error.code, 'DATABASE_ERROR');
      return '503 DATABASE_ERROR';
    });
    await checkAsync('POST /restore 校验并恢复备份（无需重启 Runtime）', async () => {
      const res = await degraded.http.post('/api/v1/restore', { backup_id: backup.json.backup_id });
      assert.equal(res.status, 200, res.text.slice(0, 400));
      assert.equal(res.json.restored, true);
      assert.equal(res.json.requires_restart, false);
      return `restored ${res.json.backup_id}`;
    });
    await checkAsync('恢复后：备份时点记忆存在、备份后新增记忆不存在、db/health ok', async () => {
      const restoredMem = await degraded.http.get(`/api/v1/memory/${baseMemory.id}`);
      assert.equal(restoredMem.status, 200);
      assert.equal(restoredMem.json.memory.title, baseMemory.title);
      const gone = await degraded.http.get(`/api/v1/memory/${postMemory.id}?include_deleted=true`);
      assert.equal(gone.status, 404, '备份后新增数据应随恢复消失');
      const dbHealth = await degraded.http.get('/api/v1/db/health');
      assert.equal(dbHealth.json.ok, true);
      assert.equal(dbHealth.json.integrity, 'ok');
      return `restored memory=${baseMemory.id}`;
    });
  } finally {
    await rt.stopRuntime(degraded).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 报告输出
// ---------------------------------------------------------------------------
function writeReports() {
  c.ensureDir(REPORT_DIR);
  const passedChecks = scenarios.reduce((n, s) => n + s.checks.filter((x) => x.status === 'PASS').length, 0);
  const failedChecks = scenarios.reduce((n, s) => n + s.checks.filter((x) => x.status === 'FAIL').length, 0);
  const report = {
    generated_at: c.nowIso(),
    runner: 'tests/e2e/scenarios.test.cjs',
    ui_capture_enabled: UI,
    device,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    summary: {
      scenarios: scenarios.length,
      failed_scenarios: scenarios.filter((s) => s.status === 'FAIL').length,
      checks: passedChecks + failedChecks,
      passed_checks: passedChecks,
      failed_checks: failedChecks,
    },
    scenarios,
  };
  c.writeJson(path.join(c.PATHS.REPORTS, 'e2e-scenarios.json'), report);

  const lines = [];
  lines.push('# FCA Alpha 0.1 — E2E 验收场景报告（A/B/D/E/F）');
  lines.push('');
  lines.push(`- 生成时间：${report.generated_at}`);
  lines.push(`- 运行方式：真实 Runtime 子进程（vendor Node ${report.node}）+ 真实 HTTP；UI 截图复用 desktop/main/capture.js（Electron）`);
  lines.push(`- 测试设备：${device.gpu ? `${device.gpu.name}（${device.gpu.memory_total_mb}MB, driver ${device.gpu.driver_version}）` : 'GPU 未探测到'} / ${report.platform} / Node ${report.node}`);
  lines.push(`- UI 截图：${UI ? '已执行（artifacts/reports/e2e/*.png）' : '按 FCA_E2E_UI=0 跳过'}`);
  lines.push(`- 结果：${report.summary.scenarios} 个场景 / ${report.summary.checks} 项检查，通过 ${passedChecks}，失败 ${failedChecks}`);
  lines.push('');
  lines.push('## 场景总览');
  lines.push('');
  lines.push('| 场景 | 说明 | 结果 | 检查数 | 截图 |');
  lines.push('|---|---|---|---|---|');
  for (const s of scenarios) {
    lines.push(`| ${s.id} | ${s.title} | ${s.status} | ${s.checks.filter((x) => x.status === 'PASS').length}/${s.checks.length} | ${s.screenshots.map((x) => `[${x.path.split('/').pop()}](../${x.path.replace('artifacts/', '')})`).join('<br>') || '—'} |`);
  }
  for (const s of scenarios) {
    lines.push('');
    lines.push(`## 场景 ${s.id}：${s.title}`);
    lines.push('');
    const capture = s.screenshots[0];
    if (capture) {
      lines.push(`截图：![${s.id}](../../${capture.path})（${(capture.bytes / 1024).toFixed(0)}KB，${capture.ms}ms，capture exit=${capture.exit_code}）`);
      if (capture.render_state) {
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(capture.render_state, null, 2));
        lines.push('```');
      }
      lines.push('');
    }
    lines.push('| 检查项 | 结果 | 证据/说明 |');
    lines.push('|---|---|---|');
    for (const chk of s.checks) {
      lines.push(`| ${chk.name} | ${chk.status} | ${String(chk.detail || '').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
    }
  }
  lines.push('');
  lines.push('## 复用 desktop-app 视觉验收截图（同一真实 Runtime 数据）');
  lines.push('');
  lines.push('- `artifacts/screenshots/final-atlas-overview.png` / `final-atlas-clusters.png` / `final-atlas-detail.png` / `final-atlas-focus.png` / `final-atlas-legend.png` / `final-atlas-quality-off.png`：有真实数据（seed --demo 194 节点/382 关系/22 聚类，source=runtime）');
  lines.push('- `artifacts/screenshots/final-atlas-empty.png`：空库无假数据（独立空库，nodes=0）');
  c.writeText(path.join(c.PATHS.REPORTS, 'e2e-scenarios.md'), `${lines.join('\n')}\n`);
  console.log(`\n[E2E] 报告：artifacts/reports/e2e-scenarios.json / e2e-scenarios.md；检查通过 ${passedChecks}/${passedChecks + failedChecks}`);
  return report;
}

// ---------------------------------------------------------------------------
// 主测试（顺序执行 5 个场景；任一 scenario setup 抛错不影响后续场景）
// ---------------------------------------------------------------------------
test('E2E 验收场景 A/B/D/E/F（真实 Runtime，可选真实 Electron 截图）', { timeout: 20 * 60 * 1000 }, async () => {
  try {
    await scenarioA();
  } catch (error) {
    check('场景 A 执行异常', false, error.message);
  }
  try {
    await scenarioB();
  } catch (error) {
    check('场景 B 执行异常', false, error.message);
  }
  try {
    await scenarioD();
  } catch (error) {
    check('场景 D 执行异常', false, error.message);
  }
  try {
    await scenarioE();
  } catch (error) {
    check('场景 E 执行异常', false, error.message);
  }
  try {
    await scenarioF();
  } catch (error) {
    check('场景 F 执行异常', false, error.message);
  }
  const report = writeReports();
  assert.equal(report.summary.failed_scenarios, 0, `存在失败场景：${scenarios.filter((s) => s.status === 'FAIL').map((s) => s.id).join(',')}`);
});
