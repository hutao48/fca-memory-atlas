// FCA Local Runtime — 备份/恢复（VACUUM INTO + sha256 + integrity_check + 在线/离线恢复）
import fs from 'node:fs';
import path from 'node:path';
import {
  openDatabase,
  closeQuietly,
  integrityCheck,
  checkpointWal,
  sha256File,
  collectCounts,
  replaceDatabaseFile,
  getUserVersion,
  quickCheck,
} from '../persistence/db.js';
import { LATEST_SCHEMA_VERSION } from '../persistence/migrations.js';
import { newId } from '../core/ids.js';
import { nowIso } from '../core/time.js';
import { backupFailed, restoreFailed, notFound, validationFailed } from '../core/errors.js';

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function escapeSqlPath(p) {
  return p.replace(/'/g, "''");
}

/** 纯备份：对已打开的 db 做 VACUUM INTO + manifest（不写事件）。 */
export function backupDatabase(db, config, { note = null, logger = null } = {}) {
  const backupId = newId('backup');
  const backupsDir = config.paths.backupsDir;
  fs.mkdirSync(backupsDir, { recursive: true });
  const fileName = `fca-backup-${stamp()}-${backupId.slice(-8)}.db`;
  const target = path.join(backupsDir, fileName);
  const started = Date.now();
  try {
    checkpointWal(db);
    db.exec(`VACUUM INTO '${escapeSqlPath(target)}'`);
  } catch (err) {
    logger?.error?.('备份失败', { error: err.message });
    throw backupFailed(`备份失败：${err.message}`);
  }
  let size = 0;
  try {
    size = fs.statSync(target).size;
  } catch {
    throw backupFailed('备份文件写入后不可读');
  }
  const checksum = sha256File(target);
  const counts = collectCounts(db);
  const manifest = {
    backup_id: backupId,
    file_name: fileName,
    path: target,
    size,
    sha256: checksum,
    created_at: nowIso(),
    schema_version: getUserVersion(db),
    product_version: config.productVersion,
    api_version: config.apiVersion,
    counts,
    note,
    took_ms: Date.now() - started,
  };
  try {
    fs.writeFileSync(`${target}.manifest.json`, JSON.stringify(manifest, null, 2), 'utf8');
  } catch (err) {
    throw backupFailed(`备份 manifest 写入失败：${err.message}`);
  }
  logger?.info?.('备份完成', { backup_id: backupId, path: target, size, took_ms: manifest.took_ms });
  return manifest;
}

export function listBackups(config) {
  const dir = config.paths.backupsDir;
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.db.manifest.json'));
  } catch {
    return { items: [], total: 0 };
  }
  const items = [];
  for (const file of files) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const dbPath = manifest.path ?? path.join(dir, manifest.file_name);
      let valid = false;
      let actualSize = 0;
      let checksumOk = false;
      try {
        actualSize = fs.statSync(dbPath).size;
        valid = actualSize === Number(manifest.size);
        if (valid && manifest.sha256) checksumOk = sha256File(dbPath) === manifest.sha256;
      } catch {
        valid = false;
      }
      items.push({ ...manifest, path: dbPath, valid, checksum_ok: checksumOk, actual_size: actualSize });
    } catch {
      /* 忽略损坏 manifest */
    }
  }
  items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return { items, total: items.length };
}

export function getBackup(config, backupId) {
  const { items } = listBackups(config);
  const found = items.find((item) => item.backup_id === backupId);
  if (!found) throw notFound(`备份不存在：${backupId}`);
  return found;
}

/** 校验备份文件可打开且 integrity_check 通过。 */
export function verifyBackupFile(filePath) {
  let db;
  try {
    db = openDatabase(filePath, { readonly: true });
    const integrity = integrityCheck(db);
    const schemaVersion = getUserVersion(db);
    return { ok: integrity.ok, integrity: integrity.messages, schema_version: schemaVersion };
  } finally {
    closeQuietly(db);
  }
}

/** 删除备份（文件 + manifest）。 */
export function deleteBackupFiles(config, manifest) {
  const dbPath = manifest.path ?? path.join(config.paths.backupsDir, manifest.file_name);
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}.manifest.json`, { force: true });
  return { deleted: true, backup_id: manifest.backup_id, path: dbPath };
}

function pruneTempReplaced(config) {
  try {
    const tempDir = config.paths.tempDir;
    if (!fs.existsSync(tempDir)) return;
    const cutoff = Date.now() - 7 * 86_400_000;
    for (const file of fs.readdirSync(tempDir)) {
      if (!/^replaced-.*\.db$/.test(file)) continue;
      const full = path.join(tempDir, file);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * 恢复备份。
 * @param {{
 *   config: object, logger: object, backupId: string,
 *   holder: import('../persistence/holder.js').DatabaseHolder,
 *   events: object, meta?: object
 * }} options
 */
export function restoreFromBackup({ config, logger, backupId, holder, events, meta = {} }) {
  const manifest = getBackup(config, backupId);
  const sourcePath = manifest.path;
  if (!fs.existsSync(sourcePath)) throw restoreFailed(`备份文件不存在：${sourcePath}`);
  const actualSize = fs.statSync(sourcePath).size;
  if (actualSize !== Number(manifest.size)) throw restoreFailed('备份文件大小与 manifest 不一致，拒绝恢复');
  const actualChecksum = sha256File(sourcePath);
  if (manifest.sha256 && actualChecksum !== manifest.sha256) throw restoreFailed('备份文件 sha256 校验失败，拒绝恢复');
  const verification = verifyBackupFile(sourcePath);
  if (!verification.ok) throw restoreFailed(`备份文件完整性检查失败：${verification.integrity.join('; ')}`);
  if (verification.schema_version > LATEST_SCHEMA_VERSION) {
    throw restoreFailed(`备份 schema 版本 ${verification.schema_version} 高于当前 Runtime 支持版本 ${LATEST_SCHEMA_VERSION}`);
  }

  // 1) 恢复前先把当前库备份（若当前库可用）
  let preRestore = null;
  if (holder.isInitialized && holder.db) {
    try {
      preRestore = backupDatabase(holder.db, config, { note: `自动备份：恢复 ${backupId} 之前的数据库`, logger });
    } catch (err) {
      logger?.warn?.('恢复前自动备份失败（继续恢复）', { error: err.message });
    }
  }

  // 2) 暂存副本 + 关闭连接 + 替换文件
  fs.mkdirSync(config.paths.tempDir, { recursive: true });
  const stagedPath = path.join(config.paths.tempDir, `restore-${Date.now()}-${backupId.slice(-8)}.db`);
  fs.copyFileSync(sourcePath, stagedPath);
  holder.close();
  let replaceResult;
  try {
    replaceResult = replaceDatabaseFile(config.paths.db, stagedPath, { keepOld: true });
  } catch (err) {
    try {
      holder.open();
    } catch {
      /* ignore */
    }
    throw restoreFailed(`替换数据库文件失败：${err.message}`);
  }

  // 3) 重新打开（自动迁移）+ 校验；失败则回滚旧库
  let reopened = null;
  try {
    reopened = holder.open();
    if (!holder.isInitialized) throw new Error('恢复后的数据库未通过初始化校验');
    const check = quickCheck(reopened);
    if (!check.ok) throw new Error(`恢复后的数据库 quick_check 失败：${check.messages.join('; ')}`);
  } catch (err) {
    // 回滚
    try {
      if (replaceResult.oldPath && fs.existsSync(replaceResult.oldPath)) {
        fs.rmSync(config.paths.db, { force: true });
        for (const suffix of ['-wal', '-shm']) fs.rmSync(`${config.paths.db}${suffix}`, { force: true });
        fs.renameSync(replaceResult.oldPath, config.paths.db);
      }
    } catch (rollbackErr) {
      logger?.error?.('恢复失败且回滚旧数据库失败！请手动处理', { error: rollbackErr.message, old_path: replaceResult.oldPath });
      throw restoreFailed(`恢复失败且回滚失败：${err.message}；旧库保留在 ${replaceResult.oldPath}`);
    }
    try {
      holder.open();
    } catch {
      /* ignore */
    }
    throw restoreFailed(`恢复后数据库无法打开，已回滚旧库：${err.message}`);
  }

  // 4) 清理暂存/旧库替换文件
  try {
    fs.rmSync(stagedPath, { force: true });
  } catch {
    /* ignore */
  }
  if (replaceResult.oldPath) {
    try {
      if (preRestore) fs.rmSync(replaceResult.oldPath, { force: true });
      else {
        const keep = path.join(config.paths.tempDir, `replaced-${Date.now()}.db`);
        fs.renameSync(replaceResult.oldPath, keep);
        logger?.warn?.('恢复前当前数据库不可用，旧文件已保留', { path: keep });
      }
    } catch {
      /* ignore */
    }
  }
  pruneTempReplaced(config);

  // 5) 事件 + 结果
  let event = null;
  try {
    const prepared = events.prepare(reopened, {
      type: 'restore.completed',
      actor: meta.actor,
      source: meta.source,
      subject: { kind: 'backup', id: backupId },
      payload: {
        backup_id: backupId,
        restored_at: nowIso(),
        schema_version: verification.schema_version,
        pre_restore_backup_id: preRestore?.backup_id ?? null,
        requires_restart: false,
      },
      trace_id: meta.traceId,
    });
    event = prepared.event;
  } catch (err) {
    logger?.warn?.('恢复完成事件写入失败', { error: err.message });
  }
  if (event) events.publish(event);
  const counts = collectCounts(reopened);
  logger?.info?.('备份恢复完成', { backup_id: backupId, schema_version: verification.schema_version, pre_restore_backup_id: preRestore?.backup_id ?? null });
  return {
    restored: true,
    backup_id: backupId,
    path: sourcePath,
    requires_restart: false,
    schema_version: verification.schema_version,
    pre_restore_backup_id: preRestore?.backup_id ?? null,
    counts,
    restored_at: nowIso(),
  };
}

export function createBackupService({ dbHolder, config, logger, events }) {
  function create({ note = null } = {}, meta = {}) {
    const db = dbHolder.requireDb();
    const manifest = backupDatabase(db, config, { note: note == null ? null : String(note).slice(0, 500), logger });
    let prepared = null;
    try {
      prepared = events.prepare(db, {
        type: 'backup.created',
        actor: meta.actor,
        source: meta.source,
        subject: { kind: 'backup', id: manifest.backup_id },
        payload: {
          backup_id: manifest.backup_id,
          path: manifest.path,
          size: manifest.size,
          sha256: manifest.sha256,
          created_at: manifest.created_at,
        },
        trace_id: meta.traceId,
      });
      events.publish(prepared.event);
    } catch (err) {
      logger?.warn?.('备份事件写入失败', { error: err.message });
    }
    return {
      backup_id: manifest.backup_id,
      path: manifest.path,
      size: manifest.size,
      checksum: manifest.sha256,
      sha256: manifest.sha256,
      created_at: manifest.created_at,
      schema_version: manifest.schema_version,
      counts: manifest.counts,
      note: manifest.note,
      took_ms: manifest.took_ms,
    };
  }

  function list() {
    return listBackups(config);
  }

  function remove(backupId, { confirm = false } = {}, meta = {}) {
    if (!confirm) throw validationFailed([{ field: 'confirm', message: '删除备份需要显式确认（?confirm=true）' }]);
    const manifest = getBackup(config, backupId);
    const db = dbHolder.isInitialized ? dbHolder.db : null;
    const result = deleteBackupFiles(config, manifest);
    if (db) {
      try {
        const prepared = events.prepare(db, {
          type: 'backup.deleted',
          actor: meta.actor,
          source: meta.source,
          subject: { kind: 'backup', id: backupId },
          payload: { backup_id: backupId, path: result.path },
          trace_id: meta.traceId,
        });
        events.publish(prepared.event);
      } catch (err) {
        logger?.warn?.('备份删除事件写入失败', { error: err.message });
      }
    }
    return result;
  }

  function restore(backupId, meta = {}) {
    return restoreFromBackup({ config, logger, backupId, holder: dbHolder, events, meta });
  }

  return { create, list, remove, restore, verify: (backupId) => {
    const manifest = getBackup(config, backupId);
    const verification = verifyBackupFile(manifest.path);
    return { backup_id: backupId, ...verification };
  } };
}
