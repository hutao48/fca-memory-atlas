// 数据库管理 API（契约 §4）：init/health/migrations/vacuum
import { reply } from '../../server/respond.js';
import { requestMeta } from '../util.js';
import { collectCounts, collectDbSizes, integrityCheck, checkpointWal } from '../../persistence/db.js';
import { getMigrationState } from '../../persistence/migrations.js';

export function registerDbRoutes({ router, config, holder, events, logger }) {
  router.add(
    'POST',
    '/api/v1/db/init',
    (ctx) => {
      const wasInitialized = holder.isInitialized;
      const result = holder.initialize();
      let event = null;
      if (result.created || !wasInitialized) {
        try {
          const prepared = events.prepare(holder.db, {
            type: 'db.initialized',
            actor: requestMeta(ctx).actor,
            source: requestMeta(ctx).source,
            subject: { kind: 'db', id: null },
            payload: {
              created: result.created,
              schema_version: result.schema_version,
              db_path: result.db_path,
            },
            trace_id: ctx.traceId,
          });
          events.publish(prepared.event);
          event = prepared.event;
        } catch (err) {
          logger?.warn?.('db.initialized 事件写入失败', { error: err.message });
        }
      }
      return reply(
        {
          initialized: true,
          created: result.created,
          already_initialized: wasInitialized,
          schema_version: result.schema_version,
          db_path: result.db_path,
          token_path: config.paths.tokenFile,
          event_id: event?.id ?? null,
        },
        result.created ? 201 : 200,
      );
    },
    { requiresDb: false, description: '首次初始化空库（幂等）' },
  );

  router.add(
    'GET',
    '/api/v1/db/health',
    (ctx) => {
      const d = holder.requireDb();
      const integrity = integrityCheck(d);
      const sizes = collectDbSizes(config.paths.db);
      let pageCount = null;
      let pageSize = null;
      let freelist = null;
      try {
        pageCount = Number(d.prepare('PRAGMA page_count').get()?.page_count ?? 0);
        pageSize = Number(d.prepare('PRAGMA page_size').get()?.page_size ?? 0);
        freelist = Number(d.prepare('PRAGMA freelist_count').get()?.freelist_count ?? 0);
      } catch {
        /* ignore */
      }
      return reply({
        ok: integrity.ok,
        integrity: integrity.ok ? 'ok' : integrity.messages.join('; '),
        integrity_messages: integrity.messages,
        initialized: holder.isInitialized,
        user_version: holder.schemaVersion,
        migration: getMigrationState(d),
        counts: collectCounts(d),
        size: { ...sizes, page_count: pageCount, page_size: pageSize, freelist_count: freelist },
        path: config.paths.db,
        checked_at: new Date().toISOString(),
      });
    },
    { description: 'PRAGMA integrity_check + 计数 + 体积' },
  );

  router.add(
    'GET',
    '/api/v1/db/migrations',
    () => reply(getMigrationState(holder.requireDb())),
    { description: '迁移版本（user_version + schema_migrations）' },
  );

  router.add(
    'POST',
    '/api/v1/db/vacuum',
    (ctx) => {
      const d = holder.requireDb();
      const before = collectDbSizes(config.paths.db);
      const started = Date.now();
      d.exec('VACUUM');
      checkpointWal(d);
      const after = collectDbSizes(config.paths.db);
      const tookMs = Date.now() - started;
      const prepared = events.prepare(d, {
        type: 'db.vacuumed',
        actor: requestMeta(ctx).actor,
        source: requestMeta(ctx).source,
        subject: { kind: 'db', id: null },
        payload: { before_bytes: before.db_bytes, after_bytes: after.db_bytes, took_ms: tookMs },
        trace_id: ctx.traceId,
      });
      events.publish(prepared.event);
      return reply({
        ok: true,
        before_bytes: before.db_bytes,
        after_bytes: after.db_bytes,
        saved_bytes: Math.max(0, before.db_bytes - after.db_bytes),
        took_ms: tookMs,
        event_id: prepared.event.id,
      });
    },
    { description: 'VACUUM 压缩数据库' },
  );
}
