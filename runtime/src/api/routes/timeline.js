// GET /api/v1/timeline（契约 §4 + Lead 补充服务端筛选参数）
import { reply } from '../../server/respond.js';
import { filtersFromQuery, parseBool } from '../util.js';

export function registerTimelineRoutes({ router, services }) {
  router.add(
    'GET',
    '/api/v1/timeline',
    (ctx) => {
      const filters = filtersFromQuery(ctx.query);
      return reply(
        services.timeline.get({
          from: ctx.query.from ?? ctx.query.occurred_from ?? null,
          to: ctx.query.to ?? ctx.query.occurred_to ?? null,
          granularity: ctx.query.granularity ?? 'day',
          filters,
          limit: ctx.query.limit,
          cursor: ctx.query.cursor,
          include_deleted: parseBool(ctx.query.include_deleted),
        }),
      );
    },
    { description: '时间线 {buckets,items,range}；筛选：memory_types/tags/projects/participants/from/to' },
  );
}
