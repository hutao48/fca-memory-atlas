#!/usr/bin/env node
/**
 * 统一测试入口：按分组运行 node:test 套件，汇总真实结果，非零退出表示失败。
 *
 * 用法：
 *   node scripts/run-tests.js --all             # 全部分组
 *   node scripts/run-tests.js --unit --integration
 *   node scripts/run-tests.js --security --performance
 *   node scripts/run-tests.js --list            # 只列出将运行的文件
 *
 * 分组：unit / integration / e2e / security / performance / install / runtime
 * 说明：本脚本只运行 tests/ 与 runtime/test 下的 *.test.{js,mjs,cjs}；各分组独立子进程执行，
 *       结果写入 artifacts/reports/test-run.json（真实命令输出尾部一并记录）。
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { PATHS } from './lib/common.js';

const args = process.argv.slice(2);
const HELP = args.includes('--help') || args.includes('-h');
const LIST_ONLY = args.includes('--list');
const ALL = args.includes('--all') || args.length === 0 || LIST_ONLY;

const GROUPS = [
  { name: 'unit', dirs: [join(PATHS.root, 'tests', 'unit')] },
  { name: 'integration', dirs: [join(PATHS.root, 'tests', 'integration')] },
  { name: 'e2e', dirs: [join(PATHS.root, 'tests', 'e2e')] },
  { name: 'security', dirs: [join(PATHS.root, 'tests', 'security')] },
  { name: 'performance', dirs: [join(PATHS.root, 'tests', 'performance')] },
  { name: 'install', dirs: [join(PATHS.root, 'tests', 'install')] },
  { name: 'runtime', dirs: [join(PATHS.root, 'runtime', 'test')] },
];

const GROUP_TIMEOUT_MS = {
  unit: 5 * 60_000,
  integration: 10 * 60_000,
  e2e: 25 * 60_000,
  security: 10 * 60_000,
  performance: 30 * 60_000,
  install: 20 * 60_000,
  runtime: 15 * 60_000,
};

// 分组级 node:test 额外参数。
// runtime/test 的 CLI 子进程测试共享默认端口/串行假设，并行执行会互相干扰，故固定串行。
// performance 组内 api-perf 与 render-perf 共享 10000 节点数据集（render 复用 api 建好的 .cache 数据），
// 两个文件必须串行，否则会并发争用同一 FCA_HOME/端口。
const GROUP_TEST_ARGS = {
  runtime: ['--test-concurrency=1'],
  performance: ['--test-concurrency=1'],
};

if (HELP) {
  console.log('用法: node scripts/run-tests.js [--all] [--list] [--unit] [--integration] [--e2e] [--security] [--performance] [--install] [--runtime]');
  process.exit(0);
}

function collectTestFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        // 跳过依赖产物/临时目录
        if (/node_modules|\.cache|qa-logs/.test(entry.name)) continue;
        walk(p);
      } else if (/\.test\.(js|mjs|cjs)$/.test(entry.name)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

function runGroup(group, files) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', ...(GROUP_TEST_ARGS[group.name] || []), ...files], {
      cwd: PATHS.root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(text);
    });
    const killer = setTimeout(() => {
      timedOut = true;
      console.error(`[test] ${group.name} 超时（${GROUP_TIMEOUT_MS[group.name] || 600_000}ms），终止子进程`);
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, GROUP_TIMEOUT_MS[group.name] || 600_000);
    child.on('exit', (code, signal) => {
      clearTimeout(killer);
      resolve({
        group: group.name,
        files: files.length,
        code: timedOut ? 124 : code ?? 1,
        signal,
        timed_out: timedOut,
        ms: Date.now() - startedAt,
        stdout_tail: stdout.slice(-4000),
        stderr_tail: stderr.slice(-4000),
      });
    });
  });
}

const selected = ALL ? GROUPS : GROUPS.filter((g) => args.includes(`--${g.name}`));
if (selected.length === 0) {
  console.error('[test] 未选择分组。用 --all 或 --unit/--integration/--e2e/--security/--performance/--install/--runtime');
  process.exit(2);
}

const plan = selected.map((group) => ({ group, files: group.dirs.flatMap(collectTestFiles) }));
if (LIST_ONLY) {
  for (const item of plan) {
    console.log(`[test] ${item.group.name}: ${item.files.length} 个文件`);
    for (const file of item.files) console.log(`  - ${relative(PATHS.root, file)}`);
  }
  process.exit(0);
}

let failures = 0;
const summary = [];
for (const item of plan) {
  if (item.files.length === 0) {
    console.log(`\n[test] ${item.group.name}: no test files (skipped)`);
    summary.push({ group: item.group.name, files: 0, code: 0, skipped: true });
    continue;
  }
  console.log(`\n[test] ===== ${item.group.name} (${item.files.length} files) =====`);
  const result = await runGroup(item.group, item.files);
  summary.push(result);
  if (result.code !== 0) failures += 1;
}

console.log('\n[test] ===== summary =====');
for (const s of summary) {
  const text = s.skipped ? 'SKIP' : s.code === 0 ? 'PASS' : `FAIL(code=${s.code}${s.timed_out ? ',timeout' : ''})`;
  console.log(`[test] ${text.padEnd(16)} ${s.group} (${s.files} files${s.ms ? `, ${(s.ms / 1000).toFixed(1)}s` : ''})`);
}

const report = {
  generated_at: new Date().toISOString(),
  runner: 'scripts/run-tests.js',
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  args,
  summary,
  total_groups: summary.length,
  failed_groups: failures,
};
try {
  mkdirSync(PATHS.reports, { recursive: true });
  writeFileSync(join(PATHS.reports, 'test-run.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[test] 报告：${relative(PATHS.root, join(PATHS.reports, 'test-run.json'))}`);
} catch (error) {
  console.warn(`[test] 报告写入失败：${error.message}`);
}

if (failures > 0) {
  console.error(`[test] ${failures} group(s) failed`);
  process.exit(1);
}
console.log('[test] all selected groups passed');
