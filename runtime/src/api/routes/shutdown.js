// POST /api/v1/shutdown（仅本地客户端/CLI）
import { reply } from '../../server/respond.js';
import { forbidden } from '../../core/errors.js';

const ALLOWED_CLIENTS = new Set(['cli', 'desktop', 'test']);

// 注意：X-FCA-Client 是“客户端标识”而非安全边界（本地调用方可自称任意合法值）。
// 真正的边界是「仅回环 + Bearer token」；这里的白名单只用于限制关闭入口的误用。
export function registerShutdownRoutes({ router, state }) {
  router.add(
    'POST',
    '/api/v1/shutdown',
    (ctx) => {
      if (!ALLOWED_CLIENTS.has(ctx.clientKind)) {
        throw forbidden(`客户端 ${ctx.clientKind} 不允许关闭 Runtime（仅 cli/desktop/test）`);
      }
      const body = {
        ok: true,
        shutting_down: true,
        pid: ctx.config.pid,
        port: state.port ?? ctx.config.port,
        uptime_ms: Date.now() - state.startedAtMs,
        message: 'Runtime 正在优雅关闭（已完成 WAL checkpoint）',
      };
      // 先让响应返回，再关闭进程
      setTimeout(() => {
        try {
          state.requestShutdown?.('api');
        } catch {
          /* ignore */
        }
      }, 50);
      return reply(body);
    },
    { requiresDb: false, description: '请求 Runtime 优雅关闭' },
  );
}
