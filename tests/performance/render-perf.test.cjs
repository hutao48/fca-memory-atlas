'use strict';

/**
 * 桌面渲染性能测试（真实 Electron WebGL2 星云 + 真实 Runtime 数据，不使用 mock/伪造帧率）。
 *
 * 对每个节点规模（默认 100 / 1000 / 10000）：
 *  - 启动隔离 Runtime（10000 规模优先复用已有性能数据集 .cache/qa-home/qa-performance/perf）
 *  - 通过 desktop/main/capture.js 打开真实桌面窗口，等待图谱落定后读取 nebula.getStats()
 *  - 记录真实 FPS / 帧时间 / p95 帧时间 / draw calls / 渲染节点数 / 画质档位 / GPU / 分辨率
 *  - 输出 artifacts/reports/render-performance.json 与 artifacts/reports/perf/render-<n>.png
 *
 * 可用 FCA_RENDER_TIERS=100,1000,10000 控制规模；结果写入 artifacts/reports/render-performance.json。
 */
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const c = require('../e2e/lib/common.cjs');
const rt = require('../e2e/lib/runtime.cjs');
const { runCapture } = require('../e2e/lib/capture.cjs');

const TIERS = String(process.env.FCA_RENDER_TIERS || '100,1000,10000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0)
  .sort((a, b) => a - b);
const PERF_HOME = path.join(c.PATHS.QA_HOME_ROOT, 'qa-performance', 'perf');
const WORK = path.join(c.PATHS.QA_HOME_ROOT, 'qa-render');
const OUT_DIR = path.join(c.PATHS.REPORTS, 'perf');
const results = [];

async function seedMemories(handle, count) {
  const http = handle.http;
  const started = Date.now();
  let next = 0;
  const concurrency = 8;
  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= count) return;
      const res = await http.post('/api/v1/memory/store', {
        title: `渲染性能样本 #${i} 星云节点`,
        body: `第 ${i} 条用于桌面渲染性能测量的记忆；包含星云渲染、关系光丝、时间线、检索等关键词。`,
        memory_type: ['episodic', 'semantic', 'project', 'autobiographical'][i % 4],
        occurred_at: new Date(Date.UTC(2025, 0, 1) + i * 7200_000).toISOString(),
        occurred_precision: 'exact',
        importance: Number((0.2 + ((i % 80) / 100)).toFixed(2)),
        tags: i % 10 === 0 ? ['渲染性能', `组-${i % 25}`] : undefined,
        participants: i % 25 === 0 ? [{ name: `渲染人物-${i % 10}` }] : undefined,
      });
      if (res.status !== 201) throw new Error(`seed #${i} 失败：${res.status} ${res.text.slice(0, 200)}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return Date.now() - started;
}

test(`render-perf: 真实 Electron 星云渲染性能（${TIERS.join('/')} 节点，GPU WebGL2）`, { timeout: 20 * 60 * 1000 }, async () => {
  assert.ok(c.fileExists(c.PATHS.ELECTRON), '缺少 Electron，可运行 node scripts/fetch-electron.js');
  c.ensureDir(OUT_DIR);
  for (const tier of TIERS) {
    let reuse = false;
    let home = path.join(WORK, `n${tier}`, 'home');
    let handle = null;
    try {
      if (tier === 10000 && c.fileExists(path.join(PERF_HOME, 'db', 'fca.db'))) {
        home = PERF_HOME;
        reuse = true;
        handle = await rt.startRuntime({ name: `render-${tier}`, runId: 'qa-render', fcaHome: home, fresh: false });
      } else {
        handle = await rt.startRuntime({ name: `render-${tier}`, runId: 'qa-render', fcaHome: home, fresh: true });
      }
      let seedMs = 0;
      const state = await handle.http.get('/api/v1/state');
      let current = state.json.counts.memories;
      if (current < tier) {
        seedMs = await seedMemories(handle, tier - current);
      }
      const graph = await handle.http.get('/api/v1/graph', { timeoutMs: 120000 });
      const nodes = graph.json.nodes.length;
      assert.ok(nodes >= tier, `graph 节点数 ${nodes} < ${tier}`);
      // 真实 Electron 渲染截图 + nebula 性能探针
      const capture = runCapture({
        scene: `render-${tier}`,
        fcaHome: home,
        port: handle.port,
        out: path.join(OUT_DIR, `render-${tier}.png`),
        wait: 3000,
        userdata: path.join('.cache', `qa-render-userdata-${tier}`),
        timeoutMs: 300000,
      });
      assert.equal(capture.exitCode, 0, `capture 失败（exit=${capture.exitCode}）：${capture.stderr_tail}`);
      assert.equal(capture.captured, true);
      assert.ok(capture.bytes > 100_000, `截图过小：${capture.bytes}`);
      assert.ok(capture.state, '未解析到 [capture] state');
      assert.equal(capture.state.fatal, null, `桌面出现 fatal：${JSON.stringify(capture.state.fatal)}`);
      const neb = capture.state.nebula || {};
      assert.equal(neb.webgl2, true, '桌面未使用 WebGL2');
      assert.ok(Number.isFinite(neb.fps) && neb.fps > 0, `FPS 无效：${neb.fps}`);
      assert.ok(Number.isFinite(neb.frame_ms), `帧时间无效：${neb.frame_ms}`);
      assert.ok(neb.rendered_nodes > 0, '渲染节点数为 0');
      const tierResult = {
        tier,
        reused_dataset: reuse,
        seed_ms: seedMs,
        graph_nodes: nodes,
        graph_edges: graph.json.edges.length,
        graph_clusters: graph.json.clusters.length,
        capture_ms: capture.ms,
        png: path.relative(c.ROOT, capture.png).replace(/\\/g, '/'),
        png_bytes: capture.bytes,
        view: capture.state.view,
        quality: capture.state.quality,
        source: capture.state.source,
        graph_status: capture.state.graphStatus,
        render: {
          fps: neb.fps,
          frame_ms: neb.frame_ms,
          p95_frame_ms: neb.p95_frame_ms,
          draw_calls: neb.draw_calls,
          rendered_nodes: neb.rendered_nodes,
          rendered_edges: neb.rendered_edges,
          labels: neb.labels,
          pipeline: neb.pipeline,
          quality: neb.quality,
          webgl2: neb.webgl2,
          hdr: neb.hdr,
          resolution: neb.resolution,
          gpu: neb.gpu,
        },
      };
      results.push(tierResult);
      console.log(
        `[render-perf] ${tier} 节点：FPS=${neb.fps} frame=${neb.frame_ms}ms p95=${neb.p95_frame_ms}ms draw_calls=${neb.draw_calls} rendered_nodes=${neb.rendered_nodes}/${neb.rendered_edges} edges quality=${neb.quality} capture=${capture.ms}ms seed=${seedMs}ms`,
      );
    } finally {
      if (handle) await rt.stopRuntime(handle).catch(() => {});
    }
  }
  const report = {
    generated_at: c.nowIso(),
    runner: 'tests/performance/render-perf.test.cjs',
    device: results[0] && results[0].render ? { gpu: results[0].render.gpu, webgl2: results[0].render.webgl2 } : null,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    tiers: results,
  };
  c.writeJson(path.join(c.PATHS.REPORTS, 'render-performance.json'), report);
  console.log(`[render-perf] 报告：artifacts/reports/render-performance.json（${results.length} 个规模）`);
  assert.equal(results.length, TIERS.length);
});
