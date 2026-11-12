// 布局 API（契约 §3.5/§4）
import { reply } from '../../server/respond.js';
import { requestMeta } from '../util.js';

export function registerLayoutRoutes({ router, services }) {
  router.add(
    'GET',
    '/api/v1/layout/nodes',
    (ctx) => reply(services.layout.getNodes({ node_kind: ctx.query.node_kind ?? null, node_id: ctx.query.node_id ?? null })),
    { description: '读取持久化布局坐标 {items,layout_version}' },
  );

  router.add(
    'POST',
    '/api/v1/layout/nodes',
    (ctx) => reply(services.layout.saveNodes(ctx.body, requestMeta(ctx))),
    { description: '批量保存坐标 {updates:[{node_kind,node_id,x,y,z,pinned}]}' },
  );

  router.add(
    'POST',
    '/api/v1/layout/recompute',
    (ctx) => reply(services.layout.recompute(ctx.body ?? {}, requestMeta(ctx))),
    { description: '自动布局 {algorithm:"force_v1", cluster_separation:0.8}' },
  );

  router.add(
    'POST',
    '/api/v1/layout/reset',
    (ctx) => reply(services.layout.reset(requestMeta(ctx))),
    { description: '恢复布局（清空手动坐标并重算）' },
  );

  router.add(
    'GET',
    '/api/v1/layout/views',
    (ctx) => reply(services.layout.listViews({ limit: ctx.query.limit, cursor: ctx.query.cursor })),
    { description: '命名视图列表' },
  );

  router.add(
    'POST',
    '/api/v1/layout/views',
    (ctx) => reply(services.layout.createView(ctx.body, requestMeta(ctx)), 201),
    { description: '新建命名视图 {name,is_default,camera,layer_config}' },
  );

  router.add(
    'DELETE',
    '/api/v1/layout/views/:id',
    (ctx) => reply(services.layout.deleteView(ctx.params.id, requestMeta(ctx))),
    { description: '删除命名视图' },
  );
}
