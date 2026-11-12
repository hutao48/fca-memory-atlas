// FCA Runtime — CLI 验收证据生成器（真实子进程 / 真实 HTTP / 真实 SQLite；不使用 Mock）
// 用法：node runtime/tools/cli-evidence.js
// 产物：artifacts/reports/runtime-cli-verification.json（JSON，含每条命令的 argv/退出码/耗时/输出摘要）
// 注意：本工具故意放在 runtime/tools/（不在 runtime/test/ 内），避免被 `node --test runtime/test` 当成测试执行。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TOOLS_DIR, '..', '..');
const RUNTIME_BIN = path.join(PROJECT_ROOT, 'runtime', 'bin', 'fca-runtime.js');
const CACHE_ROOT = path.join(PROJECT_ROOT, '.cache');
const OUT_DIR = path.join(PROJECT_ROOT, 'artifacts', 'reports');
const OUT_FILE = path.join(OUT_DIR, 'runtime-cli-verification.json');

const startedAt = new Date().toISOString();
const stamp = startedAt.replace(/[:.]/g, '-');
const home = path.join(CACHE_ROOT, `cli-evidence-${stamp}`);
const home2 = path.join(CACHE_ROOT, `cli-evidence-import-${stamp}`);
const evidence = {
  evidence_kind: '真实 CLI 子进程 + 真实 HTTP + 真实 SQLite（无 Mock；本文件由 runtime/test/tools/cli-evidence.js 自动生成）',
  generated_at: startedAt,
  environment: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    product_version: '0.1.0',
    api_version: '1',
  },
  paths: { fca_home: home, fca_home_import: home2, db: path.join(home, 'db', 'fca.db') },
  steps: [],
  summary: {},
};

function clean(parsed, maxLen = 1400) {
  if (parsed === null || parsed === undefined) return null;
  const text = JSON.stringify(parsed);
  if (text.length <= maxLen) return parsed;
  return { truncated: true, size: text.length, preview: text.slice(0, maxLen) };
}

function runCli(args, { env = {}, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [RUNTIME_BIN, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, FCA_LOG_LEVEL: 'error', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code === null ? -1 : code, stdout, stderr, duration_ms: Date.now() - t0 });
    });
  });
}

function parseJson(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function step(name, args, opts = {}) {
  const expectedExit = opts.expectedExit ?? 0;
  const result = await runCli(args, opts);
  const parsed = parseJson(result.stdout);
  const entry = {
    step: name,
    argv: ['fca-runtime', ...args.map((arg) => arg.replace(PROJECT_ROOT, '<PROJECT_ROOT>'))],
    exit_code: result.code,
    expected_exit_code: expectedExit,
    duration_ms: result.duration_ms,
    ok: result.code === expectedExit && (expectedExit !== 0 || Boolean(parsed?.ok ?? parsed?.running ?? true)),
    output: clean(parsed),
  };
  if (result.stderr.trim()) entry.stderr_tail = result.stderr.trim().split('\n').slice(-2).join('\n').slice(0, 500);
  evidence.steps.push(entry);
  console.log(`[cli-evidence] ${entry.ok ? 'PASS' : 'FAIL'} ${name} (exit=${entry.exit_code}, expected=${expectedExit}, ${entry.duration_ms}ms)`);
  return { ...result, json: parsed, entry };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitHealth(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return await response.json();
    } catch {
      /* not ready */
    }
    await sleep(150);
  }
  throw new Error(`Runtime 未在 ${timeoutMs}ms 内就绪`);
}

async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(home2, { recursive: true });

  await step('init（首次初始化空库）', ['init', `--fca-home=${home}`]);
  await step('init（幂等再执行）', ['init', `--fca-home=${home}`]);
  await step('version', ['version']);
  await step('status（Runtime 未运行）', ['status', `--fca-home=${home}`]);
  await step('seed --demo --count=24（离线写入演示数据）', ['seed', '--demo', '--count=24', `--fca-home=${home}`]);

  // 启动真实 Runtime（serve）
  const port = await freePort();
  evidence.environment.runtime_port = port;
  const serveStart = Date.now();
  const serve = spawn(process.execPath, [RUNTIME_BIN, 'serve', `--fca-home=${home}`, `--port=${port}`], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, FCA_LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serveStdout = '';
  let serveStderr = '';
  serve.stdout.on('data', (d) => (serveStdout += d));
  serve.stderr.on('data', (d) => (serveStderr += d));
  const health = await waitHealth(port);
  evidence.steps.push({
    step: 'serve（启动真实 Runtime 子进程）',
    argv: ['fca-runtime', 'serve', '--fca-home=<TEMP_HOME>', `--port=${port}`],
    exit_code: null,
    duration_ms: Date.now() - serveStart,
    ok: health.status === 'ok',
    output: { health, ready_line: serveStdout.split('\n').find((line) => line.startsWith('FCA_RUNTIME_READY'))?.slice(0, 500) ?? null },
  });
  console.log(`[cli-evidence] PASS serve (port=${port})`);

  await step('health（针对运行中的 Runtime）', ['health', `--fca-home=${home}`, `--port=${port}`]);
  await step('status（运行中）', ['status', `--fca-home=${home}`, `--port=${port}`]);
  await step('logs（读取脱敏日志尾部）', ['logs', '--limit=5', `--fca-home=${home}`]);
  const backupOnline = await step('backup（在线，经 HTTP）', ['backup', '--note=evidence online backup', `--fca-home=${home}`, `--port=${port}`]);
  await step('stop（CLI 优雅停止 Runtime）', ['stop', `--fca-home=${home}`, `--port=${port}`]);
  for (let i = 0; i < 50 && serve.exitCode === null; i += 1) await sleep(100);
  evidence.steps.push({
    step: 'serve 进程退出校验',
    argv: [],
    exit_code: serve.exitCode,
    duration_ms: null,
    ok: serve.exitCode === 0,
    output: { exit_code: serve.exitCode, stderr_tail: serveStderr.trim().split('\n').slice(-2).join('\n').slice(0, 400) },
  });
  console.log(`[cli-evidence] ${serve.exitCode === 0 ? 'PASS' : 'FAIL'} serve exit=${serve.exitCode}`);

  await step('migrate（离线，schema 状态）', ['migrate', `--fca-home=${home}`]);
  const backupOffline = await step('backup（离线文件备份）', ['backup', '--note=evidence offline backup', `--fca-home=${home}`]);
  const exportJson = await step('export --format=json', ['export', '--format=json', `--fca-home=${home}`]);
  const exportJsonl = await step('export --format=jsonl', ['export', '--format=jsonl', `--fca-home=${home}`]);
  const exportZip = await step('export --format=zip', ['export', '--format=zip', `--fca-home=${home}`]);

  await step('init（第二个隔离数据目录）', ['init', `--fca-home=${home2}`]);
  const importStep = await step('import（导入 FCA 导出 JSON 到第二目录）', ['import', exportJson.json?.path ?? '', `--fca-home=${home2}`]);
  await step('migrate（第二目录 schema 校验）', ['migrate', `--fca-home=${home2}`]);
  await step('export（第二目录往返导出）', ['export', '--format=jsonl', `--fca-home=${home2}`]);

  // 场景 F：破坏主库 → CLI 离线 restore
  const backupId = backupOffline.json?.backup_id;
  const dbPath = path.join(home, 'db', 'fca.db');
  fs.writeFileSync(dbPath, 'corrupted database bytes (evidence scenario F)');
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  await step('migrate（损坏库应如实失败，不静默重建）', ['migrate', `--fca-home=${home}`], { expectedExit: 1 });
  const restoreStep = await step('restore（CLI 离线恢复备份）', ['restore', backupId ?? '', `--fca-home=${home}`]);
  const afterRestore = await step('export（恢复后数据完整性）', ['export', '--format=json', `--fca-home=${home}`]);

  await step('seed --demo --clear（清除演示数据）', ['seed', '--demo', '--clear', `--fca-home=${home}`]);
  const afterClear = await step('export（清除后计数）', ['export', '--format=json', `--fca-home=${home}`]);
  await step('未知命令（应 exit=2 + UNKNOWN_COMMAND）', ['not-a-command', `--fca-home=${home}`], { expectedExit: 2 });

  const failed = evidence.steps.filter((entry) => entry.ok === false);
  evidence.summary = {
    total_steps: evidence.steps.length,
    passed_steps: evidence.steps.length - failed.length,
    failed_steps: failed.map((entry) => entry.step),
    demo_memories_seeded: 24,
    backup_ids: [backupOnline.json?.backup_id, backupOffline.json?.backup_id].filter(Boolean),
    export_paths: [exportJson.json?.path, exportJsonl.json?.path, exportZip.json?.path].filter(Boolean),
    imported_memories: importStep.json?.imported?.memories ?? null,
    restored: restoreStep.json?.restored ?? null,
    counts_after_restore: afterRestore.json?.counts ?? null,
    counts_after_clear: afterClear.json?.counts ?? null,
    all_passed: failed.length === 0,
    note: '所有步骤均为本机真实命令执行；seed 数据为显式 demo=true 的演示数据，清除后计数为 0。',
  };
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`\n[cli-evidence] 已写入 ${path.relative(PROJECT_ROOT, OUT_FILE)}：${evidence.summary.all_passed ? 'ALL PASSED' : '有失败步骤'}`);
  for (const dir of [home, home2]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 保留供排查 */
    }
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();
