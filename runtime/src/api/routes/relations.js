// 关系 API（契约 §4）
import { reply, created } from '../../server/respond.js';
import { requestMeta } from '../util.js';

export function registerRelationRoutes({ router, services }) {
  router.add(
    'GET',
    '/api/v1/relations',
    (ctx) =>
      reply(
        services.relations.list({
          node_kind: ctx.query.node_kind ?? null,
          node_id: ctx.query.node_id ?? null,
          relation_type: ctx.query.relation_type ?? null,
          include_deleted: ctx.query.include_deleted === 'true',
          limit: ctx.query.limit,
          cursor: ctx.query.cursor,
        }),
      ),
    { description: '关系列表（?node_kind=&node_id=&relation_type=&include_deleted=）' },
  );

  router.add(
    'GET',
    '/api/v1/relations/:id',
    (ctx) => reply(services.relations.get(ctx.params.id, { include_deleted: ctx.query.include_deleted !== 'false' })),
    { description: '关系详情' },
  );

  router.add(
    'POST',
    '/api/v1/relations',
    (ctx) => created(services.relations.create(ctx.body, requestMeta(ctx))),
    { description: '新建关系 → Relation' },
  );

  router.add(
    'PATCH',
    '/api/v1/relations/:id',
    (ctx) => reply(services.relations.patch(ctx.params.id, ctx.body, requestMeta(ctx))),
    { description: '修改关系（乐观并发 expected_version）' },
  );

  router.add(
    'DELETE',
    '/api/v1/relations/:id',
    (ctx) => reply(services.relations.remove(ctx.params.id, requestMeta(ctx))),
    { description: '软删关系（不删除两端对象）' },
  );
}
