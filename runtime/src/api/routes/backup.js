// 备份/恢复 API（契约 §4）
import { reply } from '../../server/respond.js';
import { requestMeta } from '../util.js';
import { validationFailed } from '../../core/errors.js';

export function registerBackupRoutes({ router, services }) {
  router.add(
    'POST',
    '/api/v1/backup',
    (ctx) => reply(services.backup.create({ note: ctx.body?.note ?? null }, requestMeta(ctx)), 201),
    { description: '创建备份 → {backup_id,path,size,checksum,created_at,...}' },
  );

  router.add(
    'GET',
    '/api/v1/backups',
    () => reply(services.backup.list()),
    { requiresDb: false, description: '备份列表 {items,total}（DB 不可用时也可用于恢复选择）' },
  );

  router.add(
    'POST',
    '/api/v1/restore',
    (ctx) => {
      const backupId = ctx.body?.backup_id;
      if (typeof backupId !== 'string' || !backupId) {
        throw validationFailed([{ field: 'backup_id', message: '必须提供 backup_id' }]);
      }
      return reply(services.backup.restore(backupId, requestMeta(ctx, { system: true })));
    },
    { requiresDb: false, description: '校验并恢复备份（DB 损坏时也可调用；requires_restart:false）' },
  );

  router.add(
    'DELETE',
    '/api/v1/backups/:id',
    (ctx) => reply(services.backup.remove(ctx.params.id, { confirm: ctx.query.confirm === 'true' }, requestMeta(ctx))),
    { requiresDb: false, description: '删除备份（需 ?confirm=true 显式确认）' },
  );
}
