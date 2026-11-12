'use strict';

/**
 * QA 测试公共夹具（CJS）：
 *  - 启动/停止隔离 Runtime（真实子进程 + 真实 HTTP）
 *  - 记录每个测试用例的真实结果，退出时写 artifacts/reports/<name>.json
 *  - 提供唯一数据后缀，避免同一 Runtime 内测试互相污染
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const c = require('../e2e/lib/common.cjs');
const rt = require('../e2e/lib/runtime.cjs');
const fs = require('node:fs');
const path = require('node:path');

const results = [];
let runtimeHandle = null;
let suiteName = 'qa';
let counter = 0;

function uniq(prefix = 'qa') {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/** 记录并运行一个用例；断言失败时保留真实错误并写报告。 */
function qa(name, fn, options = {}) {
  test(name, { timeout: options.timeout }, async () => {
    const started = Date.now();
    try {
      const detail = await fn();
      results.push({ name, status: 'PASS', ms: Date.now() - started, detail: typeof detail === 'string' ? detail : '' });
    } catch (error) {
      results.push({ name, status: 'FAIL', ms: Date.now() - started, error: String((error && error.message) || error) });
      throw error;
    }
  });
}

async function start(options = {}) {
  suiteName = options.suite || options.name || 'qa';
  runtimeHandle = await rt.startRuntime({ runId: `qa-${suiteName}`, ...options });
  return runtimeHandle;
}

function handle() {
  if (!runtimeHandle) throw new Error('Runtime 尚未启动（在 before 中调用 harness.start）');
  return runtimeHandle;
}

function http() {
  return handle().http;
}

async function stop() {
  if (runtimeHandle) {
    const h = runtimeHandle;
    runtimeHandle = null;
    await rt.stopRuntime(h).catch(() => {});
  }
}

function reportPath(name) {
  return path.join(c.PATHS.REPORTS, `${name}.json`);
}

function writeReport(extra = {}) {
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const report = {
    suite: suiteName,
    generated_at: c.nowIso(),
    runtime: runtimeHandle ? { port: runtimeHandle.port, fca_home: runtimeHandle.fcaHome, node: runtimeHandle.nodeBin, version: runtimeHandle.version, api_version: runtimeHandle.apiVersion } : null,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    stats: { total: results.length, passed, failed },
    results,
    ...extra,
  };
  c.ensureDir(c.PATHS.REPORTS);
  fs.writeFileSync(reportPath(suiteName), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\n[qa] ${suiteName}: ${passed}/${results.length} 用例通过（失败 ${failed}）→ ${path.relative(c.ROOT, reportPath(suiteName))}`);
  return report;
}

/** 注册 before/after（供测试文件一行接入）。 */
function lifecycle(options = {}) {
  before(async () => {
    await start(options);
  });
  after(async () => {
    const extra = typeof options.reportExtra === 'function' ? options.reportExtra() : {};
    writeReport(extra);
    await stop();
  });
}

module.exports = {
  assert,
  c,
  rt,
  qa,
  test,
  before,
  after,
  start,
  stop,
  handle,
  http,
  uniq,
  writeReport,
  lifecycle,
  results,
};
