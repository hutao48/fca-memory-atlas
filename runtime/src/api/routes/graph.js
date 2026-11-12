// GET /api/v1/graph（契约 §5 + Lead 补充筛选参数）
import { reply } from '../../server/respond.js';
import { filtersFromQuery, parseBool, requestMeta } from '../util.js';

export function registerGraphRoutes({ router, services }) {
  router.add(
    'GET',
    '/api/v1/graph',
    (ctx) => {
      const filters = filtersFromQuery(ctx.query);
      const hasFilters = Object.keys(filters).length > 0;
      return reply(
        services.graph.build(
          {
            filters: hasFilters ? filters : null,
            include_deleted: parseBool(ctx.query.include_deleted),
            include_entities: ctx.query.include_entities === undefined ? true : parseBool(ctx.query.include_entities, true),
            view_id: ctx.query.view_id ?? null,
          },
          requestMeta(ctx),
        ),
      );
    },
    { description: '渲染图数据 {api_version,layout_version,view,nodes,edges,clusters,stats}；空库返回真实空图' },
  );
}
