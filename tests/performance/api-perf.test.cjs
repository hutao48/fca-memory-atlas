'use strict';

/**
 * 性能测试（真实 Runtime + 真实 HTTP + 磁盘 SQLite；不使用 mock，不编造数据）。
 *
 * 数据集：通过公开 API POST /api/v1/memory/store 真实创建 100 / 1000 / 10000 条记忆
 *         （部分带人物/项目/标签，自动建立实体与关系），逐级累加并采集真实指标：
 *  - 写入：批量创建耗时、PATCH 延迟 p50/p95
 *  - 布局：POST /layout/recompute 延迟 + Runtime 返回的 took_ms/nodes/clusters
 *  - 查询：GET /graph（含响应体大小）、POST /memory/search（fulltext/hybrid）、GET /memories、GET /state
 *  - 存储/内存：db/health 的 db/wal 字节、system/status 的 RSS
 *
 * 可用环境变量：FCA_PERF_TIERS=100,1000,10000（默认）；FCA_PERF_LABEL 用于报告文件名。
 * 结果写入 artifacts/reports/performance.json。
 */
const fs = require('node:fs');
const h = require('../lib/harness.cjs');
const { assert, http, uniq } = h;

const TIERS = String(process.env.FCA_PERF_TIERS || '100,1000,10000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0)
  .sort((a, b) => a - b);
const LABEL = process.env.FCA_PERF_LABEL || 'performance';

let created = 0;
const people = [];
const metrics = { tiers: [], device: {}, generated_at: null, tiers_config: TIERS };

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(3));
}

async function timeIt(fn) {
  const started = process.hrtime.bigint();
  const value = await fn();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { value, ms: Number(ms.toFixed(3)) };
}

async function createBatch(count, startIndex) {
  const started = Date.now();
  const concurrency = 8;
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= count) return;
      const idx = startIndex + i;
      const body = {
        title: `性能样本 #${idx} ${uniq('p')}`,
        body: `第 ${idx} 条性能测试记忆。用于测量 100/1000/10000 节点下的真实写入、查询与布局延迟。附加文本：星云渲染、记忆检索、关系图谱。`,
        memory_type: ['episodic', 'semantic', 'project', 'autobiographical'][idx % 4],
        occurred_at: new Date(Date.UTC(2025, 0, 1) + idx * 3600_000).toISOString(),
        occurred_precision: 'exact',
        importance: Number((0.2 + ((idx % 80) / 100)).toFixed(2)),
        display_weight: Number((0.6 + ((idx % 40) / 100)).toFixed(2)),
      };
      if (idx % 20 === 0) {
        body.participants = [{ name: people[idx % people.length] }];
      }
      if (idx % 10 === 0) body.tags = ['性能测试', `分组-${idx % 25}`];
      if (idx % 50 === 0) body.project = { name: `QA 性能项目-${idx % 5}` };
      const res = await http().post('/api/v1/memory/store', body);
      if (res.status !== 201) throw new Error(`创建第 ${idx} 条失败：${res.status} ${res.text.slice(0, 200)}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  created += count;
  return Date.now() - started;
}

async function measureTier(n, extraCreateTimeMs) {
  // 1) 布局重算（真实 force_v1）
  const layout = await timeIt(async () => (await http().post('/api/v1/layout/recompute', { algorithm: 'force_v1', cluster_separation: 0.8 }, { timeoutMs: 300000 })).json);
  // 2) graph（含响应体大小）
  const graph = await timeIt(async () => {
    const res = await http().get('/api/v1/graph', { timeoutMs: 300000 });
    assert.equal(res.status, 200);
    return { json: res.json, bytes: Buffer.byteLength(res.text, 'utf8') };
  });
  assert.ok(graph.value.json.nodes.length >= n, `graph 节点数应 >= ${n}，实际 ${graph.value.json.nodes.length}`);
  assert.ok(graph.value.json.edges.length >= 1, 'graph 应包含真实关系边');
  assert.equal(graph.value.json.stats.nodes, graph.value.json.nodes.length);
  // 3) 搜索延迟
  const search = { fulltext: [], hybrid: [] };
  const queries = ['性能测试', '星云渲染', '记忆检索', '关系图谱', `性能样本 #${n - 1}`, '项目', 'autobiographical', '第 1 条', 'QA', `分组-${n % 25}`];
  for (const q of queries) {
    const ft = await timeIt(() => http().post('/api/v1/memory/search', { query: q, mode: 'fulltext', limit: 20 }, { timeoutMs: 60000 }));
    if (ft.value.status === 200) search.fulltext.push(ft.ms);
    const hy = await timeIt(() => http().post('/api/v1/memory/search', { query: q, mode: 'hybrid', limit: 20 }, { timeoutMs: 60000 }));
    if (hy.value.status === 200) search.hybrid.push(hy.ms);
  }
  // 4) PATCH 写延迟（取 10 条刚创建的记忆，逐个乐观并发更新）
  const list = await http().get(`/api/v1/memories?sort=-created_at&limit=10`, { timeoutMs: 60000 });
  const patchTimes = [];
  for (const mem of list.json.items) {
    const t = await timeIt(async () => {
      const res = await http().patch(`/api/v1/memory/${mem.id}`, { expected_version: mem.version, title: `${mem.title}（性能修订）`, importance: 0.95 });
      assert.equal(res.status, 200, `性能 PATCH 失败：${res.status}`);
    });
    patchTimes.push(t.ms);
  }
  // 5) 列表/状态延迟
  const listTimes = [];
  for (let i = 0; i < 5; i += 1) {
    const t = await timeIt(() => http().get('/api/v1/memories?limit=50', { timeoutMs: 60000 }));
    listTimes.push(t.ms);
  }
  const state = await timeIt(() => http().get('/api/v1/state', { timeoutMs: 60000 }));
  // 6) 存储/内存
  const dbHealth = (await http().get('/api/v1/db/health')).json;
  const sys = (await http().get('/api/v1/system/status')).json;
  const tier = {
    nodes: n,
    created_total: created,
    create_batch_ms: extraCreateTimeMs,
    layout: {
      http_ms: layout.ms,
      runtime_took_ms: layout.value.took_ms,
      nodes: layout.value.nodes,
      clusters: layout.value.clusters,
      layout_version: layout.value.layout_version,
    },
    graph: { http_ms: graph.ms, bytes: graph.value.bytes, nodes: graph.value.json.nodes.length, edges: graph.value.json.edges.length, clusters: graph.value.json.clusters.length },
    search: {
      queries: queries.length,
      fulltext_p50_ms: percentile(search.fulltext, 50),
      fulltext_p95_ms: percentile(search.fulltext, 95),
      hybrid_p50_ms: percentile(search.hybrid, 50),
      hybrid_p95_ms: percentile(search.hybrid, 95),
    },
    patch: { count: patchTimes.length, p50_ms: percentile(patchTimes, 50), p95_ms: percentile(patchTimes, 95) },
    list50: { p50_ms: percentile(listTimes, 50), p95_ms: percentile(listTimes, 95) },
    state_http_ms: state.ms,
    db: { db_bytes: dbHealth.size.db_bytes, wal_bytes: dbHealth.size.wal_bytes, total_bytes: dbHealth.size.total_bytes, counts: dbHealth.counts },
    rss_bytes: sys.memory.rss_bytes,
    heap_used_bytes: sys.memory.heap_used_bytes,
    gpu: sys.gpu,
  };
  metrics.tiers.push(tier);
  console.log(`[perf] tier ${n}: layout=${layout.ms}ms(runtime ${layout.value.took_ms}ms) graph=${graph.ms}ms/${(graph.value.bytes / 1048576).toFixed(1)}MB search_p50=${tier.search.hybrid_p50_ms}ms patch_p50=${tier.patch.p50_ms}ms rss=${(tier.rss_bytes / 1048576).toFixed(1)}MB db=${(dbHealth.size.db_bytes / 1048576).toFixed(1)}MB`);
  return tier;
}

h.lifecycle({
  suite: LABEL,
  name: 'perf',
  reportExtra: () => metrics,
});

h.qa(`perf: 真实创建 100/1000/10000 节点并采集布局/查询/写入延迟与 DB/内存（tiers=${TIERS.join(',')}）`, async () => {
  const startedAll = Date.now();
  // 人物池（10 个，用于制造真实关系边）
  for (let i = 0; i < 10; i += 1) people.push(`性能人物-${i}`);
  let previous = 0;
  for (const target of TIERS) {
    const batch = target - previous;
    const createMs = await createBatch(batch, previous);
    previous = target;
    await measureTier(target, createMs);
  }
  metrics.generated_at = new Date().toISOString();
  metrics.create_total_ms = Date.now() - startedAll;
  return `${TIERS.join('/')} 节点全部完成，总耗时 ${(metrics.create_total_ms / 1000).toFixed(1)}s`;
}, { timeout: 20 * 60 * 1000 });
