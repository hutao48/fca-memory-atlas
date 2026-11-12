// 备份/恢复 + 导出/导入（FCA 自身格式；真实文件 + 真实 SQLite；含损坏 ZIP → 422 的回归测试）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHome, startRuntime, disposeRuntime } from './helpers.js';

let rt;
const ids = {};

before(async () => {
  rt = await startRuntime({ home: makeHome('backup-exchange') });
  const a = await rt.api('/api/v1/memory/store', {
    method: 'POST',
    body: { title: '备份前记忆 A', body: '这条应被备份并在恢复后存在。', memory_type: 'episodic', tags: ['备份标签'] },
  });
  const b = await rt.api('/api/v1/memory/store', {
    method: 'POST',
    body: { title: '备份前记忆 B', body: '语义记忆内容。', memory_type: 'semantic' },
  });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  ids.a = a.json.id;
  ids.b = b.json.id;
});

after(async () => {
  await disposeRuntime(rt);
});

test('创建备份 / 备份列表：manifest、sha256、size、valid 校验', async () => {
  const backup = await rt.api('/api/v1/backup', { method: 'POST', body: { note: 'runtime 测试备份' } });
  assert.equal(backup.status, 201, JSON.stringify(backup.json));
  const body = backup.json;
  assert.match(body.backup_id, /^bak_[0-9a-f]{32}$/);
  assert.ok(fs.existsSync(body.path), '备份文件应真实存在');
  assert.ok(body.size > 0);
  assert.match(body.sha256, /^[0-9a-f]{64}$/);
  assert.equal(body.checksum, body.sha256);
  assert.equal(body.counts.memories >= 2, true);
  assert.equal(body.note, 'runtime 测试备份');
  ids.validBackup = body;

  const list = await rt.api('/api/v1/backups');
  assert.equal(list.status, 200);
  const item = list.json.items.find((entry) => entry.backup_id === body.backup_id);
  assert.ok(item);
  assert.equal(item.valid, true);
  assert.equal(item.checksum_ok, true);
  assert.equal(item.size, fs.statSync(body.path).size);
});

test('恢复：恢复后数据回到快照状态、DB 可继续写入（requires_restart:false）', async () => {
  const after = await rt.api('/api/v1/memory/store', {
    method: 'POST',
    body: { title: '备份后新增记忆 C', body: '恢复后这条应消失（不在快照中）。', memory_type: 'working' },
  });
  assert.equal(after.status, 201);
  ids.c = after.json.id;

  const restored = await rt.api('/api/v1/restore', { method: 'POST', body: { backup_id: ids.validBackup.backup_id } });
  assert.equal(restored.status, 200, JSON.stringify(restored.json));
  assert.equal(restored.json.restored, true);
  assert.equal(restored.json.requires_restart, false);
  assert.equal(restored.json.backup_id, ids.validBackup.backup_id);
  assert.ok(restored.json.counts);

  const a = await rt.api(`/api/v1/memory/${ids.a}`);
  assert.equal(a.status, 200);
  assert.equal(a.json.memory.title, '备份前记忆 A');
  const c = await rt.api(`/api/v1/memory/${ids.c}`);
  assert.equal(c.status, 404, '恢复快照后，快照之后的写入应不在库中');
  // 恢复后数据库仍可正常写入
  const write = await rt.api('/api/v1/memory/store', { method: 'POST', body: { title: '恢复后写入', body: 'ok' } });
  assert.equal(write.status, 201);
  const health = await rt.api('/api/v1/db/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
});

test('损坏备份：size/sha256 不匹配时拒绝恢复（RESTORE_FAILED 500），不破坏当前库', async () => {
  const backup = await rt.api('/api/v1/backup', { method: 'POST', body: { note: '将被篡改的备份' } });
  assert.equal(backup.status, 201);
  fs.appendFileSync(backup.json.path, 'tampered-bytes');
  const list = await rt.api('/api/v1/backups');
  const tampered = list.json.items.find((entry) => entry.backup_id === backup.json.backup_id);
  assert.equal(tampered.valid, false);
  const restore = await rt.api('/api/v1/restore', { method: 'POST', body: { backup_id: backup.json.backup_id } });
  assert.equal(restore.status, 500);
  assert.equal(restore.json.error.code, 'RESTORE_FAILED');
  // 当前库未被破坏
  const a = await rt.api(`/api/v1/memory/${ids.a}`);
  assert.equal(a.status, 200);
  assert.equal(a.json.memory.title, '备份前记忆 A');
  // 清理篡改备份（需显式 confirm）
  const noConfirm = await rt.api(`/api/v1/backups/${backup.json.backup_id}`, { method: 'DELETE' });
  assert.equal(noConfirm.status, 422);
  const confirmed = await rt.api(`/api/v1/backups/${backup.json.backup_id}?confirm=true`, { method: 'DELETE' });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.json.deleted, true);
  const missing = await rt.api('/api/v1/restore', { method: 'POST', body: { backup_id: backup.json.backup_id } });
  assert.equal(missing.status, 404);
});

test('导出：json / jsonl / zip 三种格式真实落盘、计数正确、过滤生效', async () => {
  const json = await rt.api('/api/v1/export', { method: 'POST', body: { format: 'json' } });
  assert.equal(json.status, 200);
  assert.equal(json.json.format, 'json');
  assert.ok(fs.existsSync(json.json.path));
  const bundle = JSON.parse(fs.readFileSync(json.json.path, 'utf8'));
  assert.equal(bundle.format, 'fca-export');
  assert.equal(bundle.format_version, '1.0');
  assert.equal(bundle.api_version, '1');
  assert.equal(bundle.counts.memories, bundle.data.memories.length);
  assert.ok(bundle.counts.memories >= 2);
  assert.ok(Array.isArray(bundle.data.tags));
  ids.exportJson = json.json;

  const jsonl = await rt.api('/api/v1/export', { method: 'POST', body: { format: 'jsonl' } });
  assert.equal(jsonl.status, 200);
  const jsonlText = fs.readFileSync(jsonl.json.path, 'utf8');
  const jsonlLines = jsonlText.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(jsonlLines[0].kind, 'manifest');
  assert.equal(jsonlLines[0].format, 'fca-export');
  assert.ok(jsonlLines.some((line) => line.kind === 'memory'));
  ids.exportJsonl = jsonl.json;

  const zip = await rt.api('/api/v1/export', { method: 'POST', body: { format: 'zip' } });
  assert.equal(zip.status, 200);
  const zipBytes = fs.readFileSync(zip.json.path);
  assert.equal(zipBytes.slice(0, 2).toString(), 'PK', 'ZIP 文件应有 PK 头');
  ids.exportZip = zip.json;

  const filtered = await rt.api('/api/v1/export', { method: 'POST', body: { format: 'json', filters: { types: ['semantic'] } } });
  assert.equal(filtered.status, 200);
  assert.equal(filtered.json.counts.memories, 1);
  const filteredBundle = JSON.parse(fs.readFileSync(filtered.json.path, 'utf8'));
  assert.ok(filteredBundle.data.memories.every((memory) => memory.memory_type === 'semantic'));

  const badFormat = await rt.api('/api/v1/export', { method: 'POST', body: { format: 'xml' } });
  assert.equal(badFormat.status, 422);
  const badPath = await rt.api('/api/v1/export', { method: 'POST', body: { path: 123 } });
  assert.equal(badPath.status, 400);
});

test('导入：FCA 导出的 jsonl / zip / inline JSON 可导入新 Runtime；损坏 ZIP 与旧格式如实 422', async () => {
  const rt2 = await startRuntime({ home: makeHome('backup-exchange-import') });
  try {
    const jsonlImport = await rt2.api('/api/v1/import', { method: 'POST', body: { path: ids.exportJsonl.path } });
    assert.equal(jsonlImport.status, 200, JSON.stringify(jsonlImport.json));
    assert.ok(jsonlImport.json.imported.memories >= 2);
    assert.equal(typeof jsonlImport.json.import_batch, 'string');
    const list = await rt2.api('/api/v1/memories?limit=100');
    assert.ok(list.json.items.some((memory) => memory.title === '备份前记忆 A'));

    const zipImport = await rt2.api('/api/v1/import', { method: 'POST', body: { path: ids.exportZip.path } });
    assert.equal(zipImport.status, 200, JSON.stringify(zipImport.json));
    assert.ok(zipImport.json.imported.memories >= 2);

    const inline = await rt2.api('/api/v1/import', {
      method: 'POST',
      body: {
        data: {
          format: 'fca-export',
          format_version: '1.0',
          data: {
            memories: [{ title: '内联导入记忆', body: '来自 inline JSON 的数据', memory_type: 'semantic' }],
          },
        },
      },
    });
    assert.equal(inline.status, 200, JSON.stringify(inline.json));
    assert.equal(inline.json.imported.memories, 1);
    const found = await rt2.api('/api/v1/memories?q=内联导入记忆');
    assert.ok(found.json.items.some((memory) => memory.title === '内联导入记忆'));

    // 损坏 ZIP → 422 IMPORT_FAILED（BUG-3 回归）；且不写入任何数据
    const countsBefore = (await rt2.api('/api/v1/db/health')).json.counts;
    const garbageZip = path.join(rt2.home, 'exports', 'garbage.zip');
    fs.mkdirSync(path.dirname(garbageZip), { recursive: true });
    fs.writeFileSync(garbageZip, 'this is not a zip file at all');
    const corrupt = await rt2.api('/api/v1/import', { method: 'POST', body: { path: garbageZip } });
    assert.equal(corrupt.status, 422, JSON.stringify(corrupt.json));
    assert.equal(corrupt.json.error.code, 'IMPORT_FAILED');
    const countsAfter = (await rt2.api('/api/v1/db/health')).json.counts;
    assert.deepEqual(countsAfter, countsBefore, '损坏 ZIP 导入失败不得写入任何数据');

    // 旧记忆系统格式（非 fca-export）→ 422
    const legacy = path.join(rt2.home, 'exports', 'legacy.json');
    fs.writeFileSync(legacy, JSON.stringify({ memories: [{ title: '旧格式' }] }));
    const legacyImport = await rt2.api('/api/v1/import', { method: 'POST', body: { path: legacy } });
    assert.equal(legacyImport.status, 422);
    assert.equal(legacyImport.json.error.code, 'IMPORT_FAILED');
    // 不存在文件 → 404；path 非字符串 → 400
    const missing = await rt2.api('/api/v1/import', { method: 'POST', body: { path: path.join(rt2.home, 'exports', 'nope.json') } });
    assert.equal(missing.status, 404);
    const badPath = await rt2.api('/api/v1/import', { method: 'POST', body: { path: 123 } });
    assert.equal(badPath.status, 400);
    assert.equal(badPath.json.error.code, 'BAD_REQUEST');
  } finally {
    await disposeRuntime(rt2);
  }
});
