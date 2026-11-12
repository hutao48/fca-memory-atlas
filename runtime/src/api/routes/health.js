// GET /health（免认证，契约 §4）
import { reply } from '../../server/respond.js';

export function registerHealthRoutes({ router, services }) {
  router.add(
    'GET',
    '/health',
    (ctx) => reply(services.system.health()),
    { auth: false, requiresDb: false, description: '健康检查（免认证）' },
  );
  // 便捷别名（与 /health 相同语义，向后兼容）
  router.add(
    'GET',
    '/api/v1/health',
    (ctx) => reply(services.system.health()),
    { auth: false, requiresDb: false, description: '健康检查别名' },
  );
}
