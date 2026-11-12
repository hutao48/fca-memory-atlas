// GET /api/v1/system/status
import { reply } from '../../server/respond.js';

export function registerSystemRoutes({ router, services }) {
  router.add(
    'GET',
    '/api/v1/system/status',
    async (ctx) => reply(await services.system.status()),
    { requiresDb: false, description: '数据库/存储/GPU/LLM/客户端/错误统计（DB 未初始化也可访问）' },
  );
}
