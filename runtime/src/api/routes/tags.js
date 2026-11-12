// 标签目录 API（Lead 补充端点：GET /api/v1/tags）
import { reply } from '../../server/respond.js';

export function registerTagRoutes({ router, services, holder }) {
  router.add(
    'GET',
    '/api/v1/tags',
    (ctx) => {
      const d = holder.requireDb();
      return reply({
        items: services.tags.catalog(d, { q: ctx.query.q, limit: ctx.query.limit }),
        total: services.tags.count(d),
      });
    },
    { description: '标签目录 [{id,name,count,created_at}]，?q= 过滤' },
  );
}
