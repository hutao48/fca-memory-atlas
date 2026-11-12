// 导出/导入 API（契约 §4；仅支持 FCA 自身导出格式）
import { reply } from '../../server/respond.js';
import { requestMeta } from '../util.js';

export function registerExchangeRoutes({ router, services }) {
  router.add(
    'POST',
    '/api/v1/export',
    (ctx) => reply(services.exchange.exportData(ctx.body ?? {}, requestMeta(ctx))),
    { description: '导出 {format:json|jsonl|zip, filters?, path?} → {path,format,size,counts}' },
  );

  router.add(
    'POST',
    '/api/v1/import',
    (ctx) => reply(services.exchange.importData(ctx.body, requestMeta(ctx))),
    { description: '导入 FCA 导出格式 {path} 或 {data}（JSON/JSONL/ZIP）' },
  );
}
