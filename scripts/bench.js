#!/usr/bin/env node
/**
 * FCA 性能基准（真实 HTTP，不使用 Mock）。
 * 用法：
 *   node scripts/bench.js --fca-home=<dir> --port=17860 [--rounds=30]
 * 说明：需已有演示数据（runtime `seed --demo`）或先通过 API 写入；本脚本测量：
 *   - /health 延迟
 *   - /api/v1/graph 生成与传输延迟（按不同规模，若数据规模不足则如实报告当前规模）
 *   - /api/v1/memory/search 延迟
 *   - /api/v1/timeline 延迟
 *   - /api/v1/memory/store 写入延迟
 * 输出：控制台表格 + artifacts/reports/bench-runtime.json
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PATHS, ensureDir } from './lib/common.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const FCA_HOME = resolve(opt('fca-home', join(PATHS.cache, 'bench-home')));
const PORT = Number(opt('port', '17860'));
const ROUNDS = Number(opt('rounds', '20'));
const BASE = `http://127.0.0.1:${PORT}`;

const tokenPath = join(FCA_HOME, 'config', 'runtime-token');
const token = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : process.env.FCA_TOKEN;

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}
async function timed(fn) {
  const t0 = performance.now();
  const result = await fn();
  return { ms: performance.now() - t0, result };
}
function summarize(name, samples, extra = {}) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    name,
    n: samples.length,
    min_ms: Number(sorted[0].toFixed(2)),
    p50_ms: Number(percentile(sorted, 50).toFixed(2)),
    p95_ms: Number(percentile(sorted, 95).toFixed(2)),
    max_ms: Number(sorted[sorted.length - 1].toFixed(2)),
    avg_ms: Number((samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(2)),
    ...extra,
  };
}

async function api(pathname, init = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'x-fca-client': 'test',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json, bytes: text.length };
}

const report = { generated_at: new Date().toISOString(), base_url: BASE, rounds: ROUNDS, groups: [], env: {} };

async function main() {
  const health = await api('/health');
  if (health.status !== 200) {
    console.error('[bench] runtime not healthy; start it first');
    process.exit(1);
  }
  report.env.health = health.json;

  // graph size
  const graph = await api('/api/v1/graph');
  const nodeCount = graph.json?.nodes?.length ?? 0;
  const edgeCount = graph.json?.edges?.length ?? 0;
  report.env.graph = { nodes: nodeCount, edges: edgeCount };

  const healthSamples = [];
  for (let i = 0; i < ROUNDS; i++) {
    const { ms } = await timed(() => api('/health'));
    healthSamples.push(ms);
  }
  report.groups.push(summarize('GET /health', healthSamples));

  const graphSamples = [];
  let graphBytes = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const { ms, result } = await timed(() => api('/api/v1/graph'));
    graphSamples.push(ms);
    graphBytes = result.bytes;
  }
  report.groups.push(summarize('GET /api/v1/graph', graphSamples, { nodes: nodeCount, edges: edgeCount, bytes: graphBytes }));

  const searchSamples = [];
  for (let i = 0; i < ROUNDS; i++) {
    const { ms } = await timed(() =>
      api('/api/v1/memory/search', {
        method: 'POST',
        body: JSON.stringify({ query: '记忆', mode: 'hybrid', limit: 20 }),
      }),
    );
    searchSamples.push(ms);
  }
  report.groups.push(summarize('POST /api/v1/memory/search', searchSamples));

  const timelineSamples = [];
  for (let i = 0; i < ROUNDS; i++) {
    const { ms } = await timed(() => api('/api/v1/timeline?granularity=month'));
    timelineSamples.push(ms);
  }
  report.groups.push(summarize('GET /api/v1/timeline', timelineSamples));

  const storeSamples = [];
  for (let i = 0; i < ROUNDS; i++) {
    const { ms } = await timed(() =>
      api('/api/v1/memory/store', {
        method: 'POST',
        body: JSON.stringify({
          title: `bench 记忆 ${i}`,
          body: '性能基准测试写入的真实记忆，可随后删除。',
          memory_type: 'semantic',
          source: { type: 'system' },
        }),
      }),
    );
    storeSamples.push(ms);
  }
  report.groups.push(summarize('POST /api/v1/memory/store', storeSamples));

  ensureDir(PATHS.reports);
  const out = join(PATHS.reports, 'bench-runtime.json');
  writeFileSync(out, JSON.stringify(report, null, 2));

  console.log('\n[bench] results');
  console.table(report.groups);
  console.log(`[bench] graph size: ${nodeCount} nodes / ${edgeCount} edges`);
  console.log(`[bench] report: ${out}`);
}

main().catch((e) => {
  console.error('[bench] fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
