// FCA Local Runtime — 系统状态（db/存储/GPU/LLM/客户端/错误统计）
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { collectCounts, collectDbSizes, integrityCheck, getUserVersion } from '../persistence/db.js';

const GPU_CACHE_MS = 30_000;

function parseGpuQuery(stdout) {
  const line = String(stdout ?? '').trim().split(/\r?\n/)[0];
  if (!line) return null;
  const parts = line.split(',').map((s) => s.trim());
  if (parts.length < 2) return null;
  const memoryMb = Number(parts[1]);
  return {
    available: true,
    name: parts[0] || null,
    memory_total_mb: Number.isFinite(memoryMb) ? memoryMb : null,
    driver_version: parts[2] ?? null,
    utilization_percent: parts[3] !== undefined && parts[3] !== '' ? Number(parts[3]) : null,
    source: 'nvidia-smi',
    probed_at: new Date().toISOString(),
  };
}

export function createSystemService({ config, dbHolder, logger, state, hub }) {
  let gpuCache = { at: 0, value: null, error: null };
  let gpuInFlight = null;

  function probeGpu() {
    if (Date.now() - gpuCache.at < GPU_CACHE_MS) return Promise.resolve(gpuCache.value);
    if (gpuInFlight) return gpuInFlight;
    gpuInFlight = new Promise((resolve) => {
      execFile(
        'nvidia-smi',
        ['--query-gpu=name,memory.total,driver_version,utilization.gpu', '--format=csv,noheader,nounits'],
        { timeout: 2500, windowsHide: true, encoding: 'utf8' },
        (err, stdout) => {
          const value = err ? null : parseGpuQuery(stdout);
          gpuCache = { at: Date.now(), value, error: err ? String(err.message ?? err) : null };
          gpuInFlight = null;
          resolve(value);
        },
      );
    });
    return gpuInFlight;
  }

  function storageInfo() {
    const sizes = collectDbSizes(config.paths.db);
    let freeBytes = null;
    let totalBytes = null;
    try {
      const stat = fs.statfsSync(config.paths.home);
      freeBytes = Number(stat.bavail) * Number(stat.bsize);
      totalBytes = Number(stat.blocks) * Number(stat.bsize);
    } catch {
      freeBytes = null;
    }
    return { ...sizes, free_bytes: freeBytes, total_bytes: totalBytes };
  }

  async function status() {
    const dbState = dbHolder.status();
    const db = dbHolder.isInitialized ? dbHolder.db : null;
    const dbInfo = {
      path: config.paths.db,
      ...dbState,
      user_version: db ? getUserVersion(db) : null,
      integrity: null,
      counts: null,
    };
    if (db) {
      try {
        const integrity = integrityCheck(db);
        dbInfo.integrity = integrity.ok ? 'ok' : integrity.messages.join('; ');
        dbInfo.counts = collectCounts(db);
      } catch (err) {
        dbInfo.integrity = `error: ${err.message}`;
      }
    }
    let llm = { configured: false, providers: 0, queue: { pending: 0, sent: 0, failed: 0, completed: 0 } };
    if (db) {
      try {
        const providers = db.prepare('SELECT count(*) c FROM llm_providers WHERE enabled = 1').get();
        const total = db.prepare('SELECT count(*) c FROM llm_providers').get();
        llm.providers = Number(providers?.c ?? 0);
        llm.provider_total = Number(total?.c ?? 0);
        llm.configured = llm.providers > 0;
        const rows = db.prepare('SELECT status, count(*) c FROM llm_queue GROUP BY status').all();
        for (const row of rows) {
          if (llm.queue[row.status] !== undefined) llm.queue[row.status] = Number(row.c);
        }
      } catch {
        /* schema 不含 llm 表时忽略 */
      }
    }
    const gpu = await probeGpu();
    const mem = process.memoryUsage();
    return {
      version: config.productVersion,
      product_version: config.productVersion,
      api_version: config.apiVersion,
      uptime_ms: Date.now() - state.startedAtMs,
      started_at: state.startedAt,
      pid: config.pid,
      host: config.host,
      port: state.port ?? config.port,
      url: state.url ?? config.url,
      data_dir: config.paths.home,
      node_version: config.nodeVersion,
      platform: config.platform,
      shutting_down: Boolean(state.shuttingDown),
      db: dbInfo,
      storage: storageInfo(),
      gpu,
      llm,
      clients: {
        connected: hub ? hub.count() : 0,
        items: hub ? hub.snapshot() : [],
      },
      counts: dbInfo.counts,
      errors: state.errorStats ?? { count: 0, last: null },
      memory: {
        rss_bytes: mem.rss,
        heap_used_bytes: mem.heapUsed,
        heap_total_bytes: mem.heapTotal,
      },
      log_dir: config.paths.logsDir,
      event_log_dir: config.paths.eventsDir,
      backups_dir: config.paths.backupsDir,
    };
  }

  function health() {
    const dbState = dbHolder.status();
    const degraded = state.shuttingDown || !dbState.initialized || dbState.db === 'error';
    return {
      status: degraded ? 'degraded' : 'ok',
      version: config.productVersion,
      product_version: config.productVersion,
      api_version: config.apiVersion,
      uptime_ms: Date.now() - state.startedAtMs,
      initialized: dbState.initialized,
      db: dbState.db,
      pid: config.pid,
      data_dir: config.paths.home, // 附加字段：CLI 校验“该端口上的 Runtime 是否属于当前 FCA_HOME”
      shutting_down: Boolean(state.shuttingDown),
    };
  }

  return { status, health, probeGpu, storageInfo };
}
