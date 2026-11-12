// GET /api/v1/logs（已脱敏日志尾部）
import { reply } from '../../server/respond.js';
import { tailLogs } from '../../logging/index.js';

export function registerLogRoutes({ router, config }) {
  router.add(
    'GET',
    '/api/v1/logs',
    (ctx) => {
      let limit = Number(ctx.query.limit);
      if (!Number.isFinite(limit) || limit <= 0) limit = 100;
      limit = Math.min(1000, Math.floor(limit));
      const level = ctx.query.level ?? null;
      const since = ctx.query.since ?? null;
      const items = tailLogs(config, { level, limit, since });
      return reply({
        items,
        total: items.length,
        limit,
        level,
        log_dir: config.paths.logsDir,
        file: `runtime-<YYYYMMDD>.log`,
      });
    },
    { requiresDb: false, description: '日志尾部（?level=&limit=&since=，已脱敏）' },
  );
}
