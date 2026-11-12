// 实体 API（契约 §4）
import { reply, created } from '../../server/respond.js';
import { requestMeta } from '../util.js';

export function registerEntityRoutes({ router, services }) {
  router.add(
    'GET',
    '/api/v1/entities',
    (ctx) =>
      reply(
        services.entities.list({
          kind: ctx.query.kind ?? null,
          q: ctx.query.q ?? null,
          include_deleted: ctx.query.include_deleted === 'true',
          limit: ctx.query.limit,
          cursor: ctx.query.cursor,
        }),
      ),
    { description: '实体列表（?kind=&q=&include_deleted=）' },
  );

  router.add(
    'POST',
    '/api/v1/entities',
    (ctx) => created(services.entities.create(ctx.body, requestMeta(ctx))),
    { description: '新建实体 → Entity' },
  );

  router.add(
    'GET',
    '/api/v1/entities/:id',
    (ctx) => reply(services.entities.get(ctx.params.id, { include_deleted: ctx.query.include_deleted !== 'false' })),
    { description: '实体详情' },
  );

  router.add(
    'PATCH',
    '/api/v1/entities/:id',
    (ctx) => reply(services.entities.patch(ctx.params.id, ctx.body, requestMeta(ctx))),
    { description: '修改实体（乐观并发 expected_version）' },
  );

  router.add(
    'DELETE',
    '/api/v1/entities/:id',
    (ctx) => reply(services.entities.remove(ctx.params.id, requestMeta(ctx))),
    { description: '软删实体' },
  );
}
