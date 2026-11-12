// FCA Local Runtime — /api/v1 路由注册（模块化；LLM Gateway 可插拔）
import { registerHealthRoutes } from './routes/health.js';
import { registerStateRoutes } from './routes/state.js';
import { registerEventRoutes } from './routes/events.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerTagRoutes } from './routes/tags.js';
import { registerRelationRoutes } from './routes/relations.js';
import { registerEntityRoutes } from './routes/entities.js';
import { registerIdentityRoutes } from './routes/identity.js';
import { registerTimelineRoutes } from './routes/timeline.js';
import { registerGraphRoutes } from './routes/graph.js';
import { registerLayoutRoutes } from './routes/layout.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerBackupRoutes } from './routes/backup.js';
import { registerExchangeRoutes } from './routes/exchange.js';
import { registerDbRoutes } from './routes/db.js';
import { registerLogRoutes } from './routes/logs.js';
import { registerShutdownRoutes } from './routes/shutdown.js';
import { registerLlmFallbackRoutes } from './routes/llm.js';

/**
 * 注册全部 HTTP 路由。
 * LLM Gateway 组的模块（runtime/src/llm/routes.js，导出 registerLlmRoutes(deps)）存在时优先使用；
 * 否则使用内置离线兜底（providers CRUD + /complete 202 queued + queue/retry）。
 * @param {{router:object, config:object, logger:object, token:string, holder:object, events:object, hub:object, services:object, state:object}} deps
 */
export async function registerApiRoutes(deps) {
  registerHealthRoutes(deps);
  registerStateRoutes(deps);
  registerEventRoutes(deps);
  registerMemoryRoutes(deps);
  registerTagRoutes(deps);
  registerRelationRoutes(deps);
  registerEntityRoutes(deps);
  registerIdentityRoutes(deps);
  registerTimelineRoutes(deps);
  registerGraphRoutes(deps);
  registerLayoutRoutes(deps);
  registerSystemRoutes(deps);
  registerBackupRoutes(deps);
  registerExchangeRoutes(deps);
  registerDbRoutes(deps);
  registerLogRoutes(deps);
  registerShutdownRoutes(deps);

  // ---- LLM Gateway 可插拔挂载点 ----
  try {
    const mod = await import('../llm/routes.js');
    if (mod && typeof mod.registerLlmRoutes === 'function') {
      await mod.registerLlmRoutes(deps);
      deps.logger?.info?.('LLM Gateway routes 已挂载（runtime/src/llm/routes.js）');
      return;
    }
    deps.logger?.warn?.('runtime/src/llm/routes.js 存在但未导出 registerLlmRoutes，使用内置离线兜底');
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') {
      deps.logger?.warn?.('LLM Gateway routes 加载失败，使用内置离线兜底', { error: err?.message ?? String(err) });
    }
  }
  registerLlmFallbackRoutes(deps);
  deps.logger?.debug?.('LLM 使用内置离线兜底路由');
}
