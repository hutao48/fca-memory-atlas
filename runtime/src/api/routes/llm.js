// LLM 路由内置离线兜底（LLM Gateway 组实现 runtime/src/llm/routes.js 后本文件不再注册）
// 契约 §4：providers CRUD / complete（离线 → 202 queued）/ queue / retry
import { reply } from '../../server/respond.js';
import { requestMeta } from '../util.js';
import { newId } from '../../core/ids.js';
import { nowIso } from '../../core/time.js';
import { ApiError, badRequest, notFound, validationFailed } from '../../core/errors.js';

const MASK = '***';

function maskProvider(row) {
  if (!row) return null;
  return {
    provider_id: row.provider_id,
    id: row.provider_id,
    name: row.name,
    kind: row.kind,
    base_url: row.base_url,
    model: row.model,
    enabled: Boolean(row.enabled),
    api_key_masked: row.api_key ? MASK : null,
    has_api_key: Boolean(row.api_key),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function registerLlmFallbackRoutes({ router, holder, events, services, logger }) {
  function db() {
    return holder.requireDb();
  }

  router.add(
    'GET',
    '/api/v1/llm/providers',
    () => {
      const d = db();
      const rows = d.prepare('SELECT * FROM llm_providers ORDER BY created_at ASC').all();
      return reply({ items: rows.map(maskProvider), total: rows.length });
    },
    { description: 'LLM Provider 列表（Key 掩码）' },
  );

  router.add(
    'POST',
    '/api/v1/llm/providers',
    (ctx) => {
      const d = db();
      const body = ctx.body ?? {};
      const errors = [];
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) errors.push({ field: 'name', message: '必填' });
      const baseUrl = body.base_url ? String(body.base_url) : null;
      if (baseUrl && !/^https?:\/\//i.test(baseUrl)) errors.push({ field: 'base_url', message: '必须是 http(s) URL' });
      if (errors.length) throw validationFailed(errors);
      if (d.prepare('SELECT 1 x FROM llm_providers WHERE name = ?').get(name)) {
        throw new ApiError('DUPLICATE', `Provider 已存在：${name}`);
      }
      const now = nowIso();
      const providerId = newId('entity'); // provider 内部 ID 复用 ent_ 前缀（非公开对象）
      d.prepare(
        'INSERT INTO llm_providers(provider_id, name, kind, base_url, model, api_key, enabled, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      ).run(
        providerId,
        name,
        body.kind ?? 'openai-compatible',
        baseUrl,
        body.model ?? null,
        body.api_key ?? null,
        body.enabled === false ? 0 : 1,
        now,
        now,
      );
      return reply(maskProvider(d.prepare('SELECT * FROM llm_providers WHERE provider_id = ?').get(providerId)), 201);
    },
    { description: '新建 LLM Provider（Key 掩码返回）' },
  );

  router.add(
    'PATCH',
    '/api/v1/llm/providers/:id',
    (ctx) => {
      const d = db();
      const row = d.prepare('SELECT * FROM llm_providers WHERE provider_id = ?').get(ctx.params.id);
      if (!row) throw notFound(`Provider 不存在：${ctx.params.id}`);
      const body = ctx.body ?? {};
      const next = {
        name: body.name ?? row.name,
        kind: body.kind ?? row.kind,
        base_url: body.base_url !== undefined ? body.base_url : row.base_url,
        model: body.model !== undefined ? body.model : row.model,
        api_key: body.api_key !== undefined ? body.api_key : row.api_key,
        enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : row.enabled,
      };
      d.prepare(
        'UPDATE llm_providers SET name=?, kind=?, base_url=?, model=?, api_key=?, enabled=?, updated_at=? WHERE provider_id=?',
      ).run(next.name, next.kind, next.base_url, next.model, next.api_key, next.enabled, nowIso(), ctx.params.id);
      return reply(maskProvider(d.prepare('SELECT * FROM llm_providers WHERE provider_id = ?').get(ctx.params.id)));
    },
    { description: '修改 LLM Provider' },
  );

  router.add(
    'DELETE',
    '/api/v1/llm/providers/:id',
    (ctx) => {
      const d = db();
      const row = d.prepare('SELECT * FROM llm_providers WHERE provider_id = ?').get(ctx.params.id);
      if (!row) throw notFound(`Provider 不存在：${ctx.params.id}`);
      d.prepare('DELETE FROM llm_providers WHERE provider_id = ?').run(ctx.params.id);
      return reply({ deleted: true, provider_id: ctx.params.id });
    },
    { description: '删除 LLM Provider' },
  );

  function enqueue(d, request, status = 'pending') {
    const queueId = newId('event');
    const now = nowIso();
    d.prepare('INSERT INTO llm_queue(queue_id, status, request, attempts, created_at, updated_at) VALUES(?,?,?,0,?,?)').run(
      queueId,
      status,
      JSON.stringify(request),
      now,
      now,
    );
    return queueId;
  }

  function buildContext(d, body) {
    const ids = Array.isArray(body.memory_ids) ? body.memory_ids.slice(0, 20) : [];
    const memories = [];
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      const rows = d.prepare(`SELECT id, title, body FROM memories WHERE id IN (${ph}) AND deleted_at IS NULL`).all(...ids);
      for (const row of rows) memories.push({ id: row.id, title: row.title, body: String(row.body).slice(0, 2000) });
    } else if (body.query) {
      try {
        const result = services.search.search({ query: String(body.query), mode: 'hybrid', limit: 3 });
        for (const item of result.items) memories.push({ id: item.memory.id, title: item.memory.title, body: item.memory.body.slice(0, 2000) });
      } catch {
        /* 搜索失败不影响离线排队 */
      }
    }
    return memories;
  }

  async function tryComplete(d, provider, request) {
    if (!provider || !provider.base_url) return { ok: false, error: 'provider 未配置 base_url' };
    const url = `${String(provider.base_url).replace(/\/$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const messages = [
        { role: 'system', content: '你是 FCA Memory Atlas 的本地记忆助手，请基于给出的记忆谨慎回答。' },
        {
          role: 'user',
          content: `${request.query ?? request.prompt ?? ''}\n\n[相关记忆]\n${request.context.map((m) => `- ${m.title}: ${m.body}`).join('\n')}`,
        },
      ];
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(provider.api_key ? { Authorization: `Bearer ${provider.api_key}` } : {}),
        },
        body: JSON.stringify({ model: provider.model ?? 'local', messages, max_tokens: request.max_tokens ?? 512 }),
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content ?? null;
      if (!text) return { ok: false, error: '响应中没有内容' };
      return { ok: true, text, usage: data.usage ?? null, provider_name: provider.name };
    } catch (err) {
      return { ok: false, error: String(err.message ?? err) };
    } finally {
      clearTimeout(timer);
    }
  }

  router.add(
    'POST',
    '/api/v1/llm/complete',
    async (ctx) => {
      const d = db();
      const body = ctx.body ?? {};
      if (!body.query && !body.prompt) throw validationFailed([{ field: 'query', message: '必须提供 query 或 prompt' }]);
      const context = buildContext(d, body);
      const providerRow = body.provider_id
        ? d.prepare('SELECT * FROM llm_providers WHERE provider_id = ? AND enabled = 1').get(body.provider_id)
        : d.prepare('SELECT * FROM llm_providers WHERE enabled = 1 ORDER BY created_at ASC LIMIT 1').get();
      const request = {
        query: body.query ?? body.prompt,
        context,
        max_tokens: body.max_tokens ?? null,
        provider_id: providerRow?.provider_id ?? null,
      };
      const meta = requestMeta(ctx);
      if (!providerRow) {
        const queueId = enqueue(d, { ...request, reason: 'no_provider_configured' });
        try {
          const prepared = events.prepare(d, {
            type: 'llm.request.queued',
            actor: meta.actor,
            source: meta.source,
            subject: { kind: 'llm', id: queueId },
            payload: { queue_id: queueId, reason: 'no_provider_configured', offline: true },
            trace_id: ctx.traceId,
          });
          events.publish(prepared.event);
        } catch (err) {
          logger?.warn?.('LLM 排队事件写入失败', { error: err.message });
        }
        return reply({ queued: true, queue_id: queueId, reason: 'no_provider_configured', offline: true }, 202);
      }
      const attempt = await tryComplete(d, providerRow, request);
      if (!attempt.ok) {
        const queueId = enqueue(d, { ...request, reason: 'provider_unavailable', error: attempt.error });
        try {
          const failed = events.prepare(d, {
            type: 'llm.request.failed',
            actor: meta.actor,
            source: meta.source,
            subject: { kind: 'llm', id: queueId },
            payload: { queue_id: queueId, error: attempt.error, queued: true },
            trace_id: ctx.traceId,
          });
          events.publish(failed.event);
          const queued = events.prepare(d, {
            type: 'llm.request.queued',
            actor: meta.actor,
            source: meta.source,
            subject: { kind: 'llm', id: queueId },
            payload: { queue_id: queueId, reason: 'provider_unavailable', offline: true },
            trace_id: ctx.traceId,
          });
          events.publish(queued.event);
        } catch (err) {
          logger?.warn?.('LLM 失败/排队事件写入失败', { error: err.message });
        }
        return reply({ queued: true, queue_id: queueId, reason: 'provider_unavailable', error: attempt.error }, 202);
      }
      try {
        const completed = events.prepare(d, {
          type: 'llm.request.completed',
          actor: meta.actor,
          source: meta.source,
          subject: { kind: 'llm', id: providerRow.provider_id },
          payload: { provider: providerRow.name, model: providerRow.model, usage: attempt.usage },
          trace_id: ctx.traceId,
        });
        events.publish(completed.event);
      } catch (err) {
        logger?.warn?.('LLM 完成事件写入失败', { error: err.message });
      }
      return reply({
        text: attempt.text,
        provider: attempt.provider_name,
        model: providerRow.model,
        usage: attempt.usage,
        offline: false,
      });
    },
    { description: 'LLM 补全：检索最小记忆上下文；离线/不可达 → 202 {queued:true,queue_id}' },
  );

  router.add(
    'GET',
    '/api/v1/llm/queue',
    (ctx) => {
      const d = db();
      const status = ctx.query.status ?? null;
      const limit = Math.min(200, Math.max(1, Number(ctx.query.limit) || 50));
      const where = status ? 'WHERE status = ?' : "WHERE status IN ('pending','failed')";
      const params = status ? [status] : [];
      const rows = d.prepare(`SELECT * FROM llm_queue ${where} ORDER BY created_at ASC LIMIT ?`).all(...params, limit);
      return reply({
        items: rows.map((row) => ({
          queue_id: row.queue_id,
          status: row.status,
          request: JSON.parse(row.request),
          result: row.result ? JSON.parse(row.result) : null,
          error: row.error ?? null,
          attempts: Number(row.attempts),
          created_at: row.created_at,
          updated_at: row.updated_at,
        })),
        total: rows.length,
      });
    },
    { description: '未处理 LLM 请求队列' },
  );

  router.add(
    'POST',
    '/api/v1/llm/queue/:id/retry',
    async (ctx) => {
      const d = db();
      const row = d.prepare('SELECT * FROM llm_queue WHERE queue_id = ?').get(ctx.params.id);
      if (!row) throw notFound(`队列项不存在：${ctx.params.id}`);
      const request = JSON.parse(row.request);
      const providerRow = request.provider_id
        ? d.prepare('SELECT * FROM llm_providers WHERE provider_id = ? AND enabled = 1').get(request.provider_id)
        : d.prepare('SELECT * FROM llm_providers WHERE enabled = 1 ORDER BY created_at ASC LIMIT 1').get();
      const now = nowIso();
      if (!providerRow) {
        d.prepare('UPDATE llm_queue SET attempts = attempts + 1, updated_at = ? WHERE queue_id = ?').run(now, ctx.params.id);
        return reply({ queued: true, queue_id: ctx.params.id, reason: 'no_provider_configured' }, 202);
      }
      const attempt = await tryComplete(d, providerRow, request);
      if (!attempt.ok) {
        d.prepare("UPDATE llm_queue SET status='failed', attempts = attempts + 1, error=?, updated_at=? WHERE queue_id=?").run(
          attempt.error,
          now,
          ctx.params.id,
        );
        return reply({ queued: true, queue_id: ctx.params.id, error: attempt.error }, 202);
      }
      d.prepare("UPDATE llm_queue SET status='completed', attempts = attempts + 1, result=?, error=NULL, updated_at=? WHERE queue_id=?").run(
        JSON.stringify({ text: attempt.text, usage: attempt.usage ?? null }),
        now,
        ctx.params.id,
      );
      return reply({ completed: true, queue_id: ctx.params.id, text: attempt.text, usage: attempt.usage ?? null });
    },
    { description: '重试队列项' },
  );
}

// 供可选外部模块参考的注册函数名（api/index.js 会优先尝试 runtime/src/llm/routes.js）
export const LLM_ROUTE_MODULE = 'runtime/src/llm/routes.js';
export const LLM_ROUTE_EXPORT = 'registerLlmRoutes';
export { badRequest };
