// CLI 全命令实测：init/serve/status/health/stop/seed --demo/logs/migrate/backup/restore/export/import（真实子进程）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  makeHome,
  cleanupHome,
  runCli,
  parseCliJson,
  startRuntime,
  disposeRuntime,
  initHome,
  readToken,
  waitUntil,
} from './helpers.js';

let home;
let rt;
let backupId;
let exportJsonPath;
let exportCounts;
const home2 = makeHome('cli-import-target');

before(async () => {
  home = makeHome('cli');
});
after(async () => {
  await disposeRuntime(rt);
  cleanupHome(home);
  cleanupHome(home2);
});

test('init / version / status（未运行）/ 未知命令错误码', async () => {
  const init = await runCli(['init', `--fca-home=${home}`]);
  assert.equal(init.code, 0, init.stderr);
  const initJson = parseCliJson(init.stdout);
  assert.equal(initJson.ok, true);
  assert.equal(initJson.created, true);
  assert.equal(initJson.initialized, true);
  assert.equal(initJson.schema_version, 1);
  assert.ok(fs.existsSync(initJson.db_path));
  assert.ok(fs.existsSync(initJson.token_path));
  assert.equal(readToken(home).length, 64);

  const initAgain = await runCli(['init', `--fca-home=${home}`]);
  assert.equal(initAgain.code, 0);
  const initAgainJson = parseCliJson(initAgain.stdout);
  assert.equal(initAgainJson.created, false);
  assert.equal(initAgainJson.already_initialized, true);

  const version = await runCli(['version']);
  assert.equal(version.code, 0);
  const versionJson = parseCliJson(version.stdout);
  assert.equal(versionJson.version, '0.1.0');
  assert.equal(versionJson.api_version, '1');

  const status = await runCli(['status', `--fca-home=${home}`]);
  assert.equal(status.code, 0);
  const statusJson = parseCliJson(status.stdout);
  assert.equal(statusJson.running, false);
  assert.equal(statusJson.data_dir, home);

  const unknown = await runCli(['not-a-command', `--fca-home=${home}`]);
  assert.equal(unknown.code, 2);
  const unknownJson = parseCliJson(unknown.stdout);
  assert.equal(unknownJson.ok, false);
  assert.equal(unknownJson.error.code, 'UNKNOWN_COMMAND');

  const badArgs = await runCli(['seed', `--fca-home=${home}`]);
  assert.equal(badArgs.code, 2);
  assert.equal(parseCliJson(badArgs.stdout).error.code, 'BAD_ARGUMENTS');
});

test('seed --demo（离线）：生成演示数据并写入真实布局', async () => {
  const seed = await runCli(['seed', '--demo', '--count=20', `--fca-home=${home}`]);
  assert.equal(seed.code, 0, seed.stderr);
  const json = parseCliJson(seed.stdout);
  assert.equal(json.ok, true);
  assert.equal(json.seeded, true);
  assert.equal(json.demo, true);
  assert.equal(json.memories, 20);
  assert.ok(json.relations >= 1);
  assert.ok(json.entities >= 1);
  assert.ok(json.layout_nodes >= 20);
  assert.ok(json.layout_version >= 1);
});

test('serve + status/health + CLI stop：真实进程与真实 HTTP', async () => {
  // 本文件后续要验证 logs 命令，因此这次 serve 显式使用 info 级别日志
  rt = await startRuntime({ home, init: false, env: { FCA_LOG_LEVEL: 'info' } });
  const token = readToken(home);
  assert.equal(rt.token, token);

  const health = await runCli(['health', `--fca-home=${home}`, `--port=${rt.port}`]);
  assert.equal(health.code, 0);
  const healthJson = parseCliJson(health.stdout);
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.api_version, '1');
  assert.equal(healthJson.initialized, true);

  const status = await runCli(['status', `--fca-home=${home}`, `--port=${rt.port}`]);
  assert.equal(status.code, 0);
  const statusJson = parseCliJson(status.stdout);
  assert.equal(statusJson.running, true);
  assert.equal(statusJson.pid, rt.child.pid);
  assert.equal(statusJson.port, rt.port);

  // 演示数据在 HTTP 层可见（真实库）
  const graph = await rt.api('/api/v1/graph');
  assert.ok(graph.json.nodes.length >= 20);
  const demoList = await rt.api('/api/v1/memories?demo=true&limit=100');
  assert.equal(demoList.json.total, 20);

  const stop = await runCli(['stop', `--fca-home=${home}`, `--port=${rt.port}`]);
  assert.equal(stop.code, 0, stop.stderr);
  const stopJson = parseCliJson(stop.stdout);
  assert.equal(stopJson.ok, true);
  assert.equal(stopJson.running, false);
  assert.equal(stopJson.message, 'stopped');
  // 进程已退出
  for (let i = 0; i < 40 && !rt.childState.exited; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(rt.childState.exited, true);

  const statusAfter = await runCli(['status', `--fca-home=${home}`, `--port=${rt.port}`]);
  assert.equal(parseCliJson(statusAfter.stdout).running, false);
});

test('logs / migrate / backup / export（离线路径）', async () => {
  const logs = await runCli(['logs', '--limit=10', `--fca-home=${home}`]);
  assert.equal(logs.code, 0);
  const logsJson = parseCliJson(logs.stdout);
  assert.equal(logsJson.ok, true);
  assert.ok(Array.isArray(logsJson.items));
  assert.ok(Array.isArray(logsJson.files));
  assert.ok(logsJson.files.length >= 1, 'serve 后应存在运行时日志文件');
  assert.ok(logsJson.items.length >= 1, '应能读到日志尾部');

  const migrate = await runCli(['migrate', `--fca-home=${home}`]);
  assert.equal(migrate.code, 0);
  const migrateJson = parseCliJson(migrate.stdout);
  assert.equal(migrateJson.ok, true);
  assert.equal(migrateJson.migrated, true);
  assert.equal(migrateJson.user_version, 1);
  assert.equal(migrateJson.schema_version, 1);

  const backup = await runCli(['backup', '--note=CLI 备份', `--fca-home=${home}`]);
  assert.equal(backup.code, 0, backup.stderr);
  const backupJson = parseCliJson(backup.stdout);
  assert.equal(backupJson.ok, true);
  assert.equal(backupJson.online, false);
  assert.match(backupJson.backup_id, /^bak_[0-9a-f]{32}$/);
  assert.ok(fs.existsSync(backupJson.path));
  assert.ok(backupJson.size > 0);
  backupId = backupJson.backup_id;

  const exportResult = await runCli(['export', '--format=json', '--path=cli-export.json', `--fca-home=${home}`]);
  assert.equal(exportResult.code, 0, exportResult.stderr);
  const exportJson = parseCliJson(exportResult.stdout);
  assert.equal(exportJson.ok, true);
  assert.equal(exportJson.online, false);
  assert.ok(fs.existsSync(exportJson.path));
  exportJsonPath = exportJson.path;
  exportCounts = exportJson.counts;
  assert.equal(exportCounts.memories, 20);
  const bundle = JSON.parse(fs.readFileSync(exportJsonPath, 'utf8'));
  assert.equal(bundle.format, 'fca-export');
});

test('import（离线导入到第二个数据目录）+ migrate 校验', async () => {
  const init = await initHome(home2);
  assert.equal(init.code, 0);
  const importResult = await runCli(['import', exportJsonPath, `--fca-home=${home2}`]);
  assert.equal(importResult.code, 0, importResult.stderr);
  const importJson = parseCliJson(importResult.stdout);
  assert.equal(importJson.ok, true);
  assert.equal(importJson.online, false);
  assert.equal(importJson.imported.memories, 20);
  assert.ok(importJson.imported.tags >= 1);
  assert.equal(typeof importJson.import_batch, 'string');

  const migrate = await runCli(['migrate', `--fca-home=${home2}`]);
  assert.equal(migrate.code, 0);
  assert.equal(parseCliJson(migrate.stdout).user_version, 1);

  // 导入后的数据可再导出（真实 SQLite 往返）
  const reExport = await runCli(['export', '--format=jsonl', `--fca-home=${home2}`]);
  assert.equal(reExport.code, 0);
  const reExportJson = parseCliJson(reExport.stdout);
  assert.equal(reExportJson.counts.memories, 20);
  assert.ok(fs.existsSync(reExportJson.path));
});

test('数据库损坏 → CLI 离线 restore 备份恢复（验收场景 F），恢复后数据完整', async () => {
  // 破坏主库文件（模拟损坏）
  const dbPath = path.join(home, 'db', 'fca.db');
  fs.writeFileSync(dbPath, 'corrupted-database-bytes-not-sqlite');
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {
      /* ignore */
    }
  }
  // 损坏后 status 仍能运行（不打开库），但 migrate 会失败
  const badMigrate = await runCli(['migrate', `--fca-home=${home}`]);
  assert.equal(badMigrate.code, 1);
  const badMigrateJson = parseCliJson(badMigrate.stdout);
  assert.equal(badMigrateJson.ok, false);
  assert.equal(badMigrateJson.error.code, 'NOT_INITIALIZED');

  const restore = await runCli(['restore', backupId, `--fca-home=${home}`]);
  assert.equal(restore.code, 0, `stdout=${restore.stdout}\nstderr=${restore.stderr}`);
  const restoreJson = parseCliJson(restore.stdout);
  assert.equal(restoreJson.ok, true);
  assert.equal(restoreJson.online, false);
  assert.equal(restoreJson.restored, true);
  assert.equal(restoreJson.requires_restart, false);

  // 恢复后可打开、可导出完整数据（20 条演示记忆）
  const migrated = await runCli(['migrate', `--fca-home=${home}`]);
  assert.equal(migrated.code, 0);
  const after = await runCli(['export', '--format=json', `--fca-home=${home}`]);
  assert.equal(after.code, 0);
  const afterJson = parseCliJson(after.stdout);
  assert.equal(afterJson.counts.memories, 20);
});

test('seed --demo --clear：清除全部演示数据（离线）', async () => {
  const clear = await runCli(['seed', '--demo', '--clear', `--fca-home=${home}`]);
  assert.equal(clear.code, 0, `stdout=${clear.stdout}\nstderr=${clear.stderr}`);
  const clearJson = parseCliJson(clear.stdout);
  assert.equal(clearJson.ok, true);
  assert.equal(clearJson.cleared, true);
  assert.equal(clearJson.demo_memories, 20);
  assert.ok(clearJson.demo_tags >= 1, '演示标签应被清理');

  const exportAfter = await runCli(['export', '--format=json', `--fca-home=${home}`]);
  assert.equal(exportAfter.code, 0);
  const exportAfterJson = parseCliJson(exportAfter.stdout);
  assert.equal(exportAfterJson.counts.memories, 0, '清除后不得残留演示记忆');
  assert.equal(exportAfterJson.counts.entities, 0, '清除后不得残留演示实体');
  assert.equal(exportAfterJson.counts.tags, 0, '清除后不得残留仅被演示记忆引用的标签');
});

test('安全边界：CLI 不会误停/误判“配置端口上的其它数据目录 Runtime”', async () => {
  const homeB = makeHome('cli-foreign-home');
  const rtA = await startRuntime({ home: makeHome('cli-foreign-owner') });
  try {
    await initHome(homeB);
    // 共享机器负载高时单次 /health 探测可能超时（CLI 探测超时 1.5s），因此轮询到结果稳定为止；
    // CLI 的安全语义不变：探测到 foreign 实例 → 不操作；探测不到 → 视为本目录未运行，同样不操作。
    const pollStatus = await waitUntil(
      async () => {
        const result = await runCli(['status', `--fca-home=${homeB}`, `--port=${rtA.port}`]);
        const json = parseCliJson(result.stdout);
        if (json && json.other_runtime && json.other_runtime.data_dir === rtA.home) return { result, json };
        return null;
      },
      { timeoutMs: 20_000, intervalMs: 400 },
    );
    assert.equal(pollStatus.result.code, 0);
    assert.equal(pollStatus.json.running, false);
    assert.equal(pollStatus.json.other_runtime.data_dir, rtA.home);

    // 2) stop：绝不关闭别人的实例（同样轮询等待“识别到 foreign”的稳定结果）
    const stopOutcome = await waitUntil(
      async () => {
        const result = await runCli(['stop', `--fca-home=${homeB}`, `--port=${rtA.port}`]);
        const json = parseCliJson(result.stdout);
        if (json && json.running === false && /另一个数据目录/.test(String(json.message))) return { result, json };
        return null;
      },
      { timeoutMs: 20_000, intervalMs: 400 },
    );
    assert.equal(stopOutcome.result.code, 0);
    assert.equal(stopOutcome.json.running, false);
    assert.match(stopOutcome.json.message, /另一个数据目录/);
    const healthAfterStop = await rtA.api('/health');
    assert.equal(healthAfterStop.status, 200);
    assert.equal(healthAfterStop.json.initialized, true);
    assert.equal(rtA.childState.exited, false, 'CLI stop 不得停止其它数据目录的 Runtime');

    // 3) seed：foreign 端口存在时按离线安全写本数据目录（不与别的实例的库冲突）
    const seeded = await runCli(['seed', '--demo', '--count=3', `--fca-home=${homeB}`, `--port=${rtA.port}`]);
    assert.equal(seeded.code, 0, `stdout=${seeded.stdout}\nstderr=${seeded.stderr}`);
    const seededJson = parseCliJson(seeded.stdout);
    assert.equal(seededJson.seeded, true);
    assert.equal(seededJson.memories, 3);
    // A 仍然健康、数据未被影响
    const healthAfterSeed = await rtA.api('/health');
    assert.equal(healthAfterSeed.status, 200);
  } finally {
    await disposeRuntime(rtA);
    cleanupHome(homeB);
  }
});
