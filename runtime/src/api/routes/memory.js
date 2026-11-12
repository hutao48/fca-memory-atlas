// 记忆 API（契约 §4）：store/search/list/get/patch/delete/restore/merge/split/versions/diff
import { reply, created } from '../../server/respond.js';
import { requestMeta } from '../util.js';
import { badRequest, validationFailed } from '../../core/errors.js';

export function registerMemoryRoutes({ router, services, config }) {
  router.add(
    'POST',
    '/api/v1/memory/store',
    (ctx) => created(services.memory.create(ctx.body, requestMeta(ctx))),
    { description: '新建记忆 → Memory' },
  );

  router.add(
    'POST',
    '/api/v1/memory/search',
    (ctx) => {
      const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
      return reply(services.search.search(body));
    },
    { description: '搜索：{query, mode:fulltext|semantic|hybrid, filters, limit, cursor}' },
  );

  // 列表查询（Lead 补充端点，向后兼容新增）
  router.add(
    'GET',
    '/api/v1/memories',
    (ctx) => {
      const items = services.memory.list({
        q: ctx.query.q,
        memory_type: ctx.query.memory_type,
        tags: ctx.query.tags,
        project: ctx.query.project,
        participant: ctx.query.participant,
        from: ctx.query.from,
        to: ctx.query.to,
        include_deleted: ctx.query.include_deleted,
        only_deleted: ctx.query.only_deleted,
        sort: ctx.query.sort,
        limit: ctx.query.limit,
        cursor: ctx.query.cursor,
      });
      return reply(items);
    },
    { description: '记忆列表（q/类型/标签/项目/参与者/时间/排序/分页）' },
  );

  router.add(
    'GET',
    '/api/v1/memory/:id',
    (ctx) => {
      const includeDeleted = ctx.query.include_deleted === 'true';
      return reply(
        services.memory.get(ctx.params.id, {
          version: ctx.query.version ?? null,
          include_deleted: includeDeleted,
        }),
      );
    },
    { description: '记忆详情 {memory, relations, layout, versions_count}；?version= 历史版本' },
  );

  router.add(
    'PATCH',
    '/api/v1/memory/:id',
    (ctx) => reply(services.memory.patch(ctx.params.id, ctx.body, requestMeta(ctx))),
    { description: '修改记忆（乐观并发 expected_version → 409 VERSION_CONFLICT）' },
  );

  router.add(
    'DELETE',
    '/api/v1/memory/:id',
    (ctx) => {
      const hard = ctx.query.hard === 'true';
      const confirm = ctx.query.confirm === 'true';
      return reply(services.memory.remove(ctx.params.id, { hard, confirm }, requestMeta(ctx)));
    },
    { description: '删除记忆（默认软删；?hard=true&confirm=true 硬删除需用户显式授权）' },
  );

  router.add(
    'POST',
    '/api/v1/memory/:id/restore',
    (ctx) => reply(services.memory.restore(ctx.params.id, requestMeta(ctx))),
    { description: '从回收站恢复软删除记忆' },
  );

  router.add(
    'POST',
    '/api/v1/memory/:id/merge',
    (ctx) => {
      if (!ctx.body || typeof ctx.body !== 'object') throw badRequest('merge body 必须是 JSON 对象');
      return reply(services.memory.merge(ctx.params.id, ctx.body, requestMeta(ctx)));
    },
    { description: '合并记忆 {source_ids:[], target_id, strategy:keep_target|prepend_sources}' },
  );

  router.add(
    'POST',
    '/api/v1/memory/:id/split',
    (ctx) => {
      if (!ctx.body || typeof ctx.body !== 'object') throw badRequest('split body 必须是 JSON 对象');
      if (!Array.isArray(ctx.body.parts)) throw validationFailed([{ field: 'parts', message: '必须提供 parts 数组' }]);
      return created(services.memory.split(ctx.params.id, ctx.body, requestMeta(ctx)));
    },
    { description: '拆分记忆 {parts:[{title, body, ...}]} → 新记忆列表' },
  );

  router.add(
    'GET',
    '/api/v1/memory/:id/versions',
    (ctx) =>
      reply(
        services.memory.versions(ctx.params.id, {
          limit: ctx.query.limit,
          cursor: ctx.query.cursor,
          before_version: ctx.query.before_version ?? null,
        }),
      ),
    { description: '版本历史（默认最近 100 条，?before_version=&limit=&cursor=）' },
  );

  router.add(
    'GET',
    '/api/v1/memory/:id/diff',
    (ctx) => {
      if (!ctx.query.from || !ctx.query.to) {
        throw validationFailed([{ field: 'from', message: '必须提供 from 与 to 版本号' }]);
      }
      return reply(services.memory.diff(ctx.params.id, { from: ctx.query.from, to: ctx.query.to }));
    },
    { description: '版本差异（RFC6902 JSON Patch）' },
  );
}
