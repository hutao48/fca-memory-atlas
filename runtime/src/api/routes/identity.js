// 身份/认知 API（契约 §4/§3.6）
import { reply } from '../../server/respond.js';
import { requestMeta } from '../util.js';

export function registerIdentityRoutes({ router, services }) {
  router.add('GET', '/api/v1/identity', () => reply(services.identity.get()), { description: '读取身份' });
  router.add(
    'POST',
    '/api/v1/identity',
    (ctx) => reply(services.identity.update(ctx.body, requestMeta(ctx))),
    { description: '更新身份（版本化，可选 expected_version）' },
  );
  router.add('GET', '/api/v1/cognition', () => reply(services.cognition.get()), { description: '读取认知状态（模拟）' });
  router.add(
    'POST',
    '/api/v1/cognition',
    (ctx) => reply(services.cognition.update(ctx.body, requestMeta(ctx))),
    { description: '更新认知状态（模拟，不代表主观感受）' },
  );
}
