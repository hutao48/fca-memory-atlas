// POST /api/v1/event + GET /api/v1/events/stream（契约 §4/§6）
import { reply } from '../../server/respond.js';
import { requestMeta } from '../util.js';
import { badRequest } from '../../core/errors.js';

export function registerEventRoutes({ router, events, hub, config, logger }) {
  router.add(
    'POST',
    '/api/v1/event',
    (ctx) => {
      if (!ctx.body || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw badRequest('事件必须是 JSON 对象');
      const meta = requestMeta(ctx);
      const prepared = events.emit(ctx.body, {
        traceId: ctx.traceId,
        clientKind: ctx.clientKind,
        actorKind: ctx.clientKind === 'dsh-plugin' ? 'agent' : 'user',
      });
      return reply(
        {
          event: prepared.event,
          duplicate: prepared.duplicate,
        },
        prepared.duplicate ? 200 : 201,
      );
    },
    { description: '提交事件（client_event_id 幂等；重复返回 duplicate:true 而非重复落库）' },
  );

  router.add(
    'GET',
    '/api/v1/events/stream',
    (ctx) => {
      const typesParam = ctx.searchParams.get('types');
      const types = typesParam ? typesParam.split(',').map((s) => s.trim()).filter(Boolean) : null;
      const lastEventId =
        ctx.req.headers['last-event-id'] ??
        ctx.searchParams.get('last_event_id') ??
        ctx.searchParams.get('lastEventId') ??
        null;
      hub.addClient(ctx.req, ctx.res, {
        clientKind: ctx.clientKind,
        lastEventId,
        types,
        traceId: ctx.traceId,
      });
      return undefined;
    },
    {
      raw: true,
      allowQueryToken: true,
      description: 'SSE 变更推送（event: fca.event / id: <seq> / 15s heartbeat / Last-Event-ID 补发）',
    },
  );
}
