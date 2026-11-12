// FCA Local Runtime — LLM Gateway HTTP 路由（契约 §4 / ADR-007）
// 由 runtime/src/api/index.js 动态 import 并优先于内置离线兜底注册；导出 registerLlmRoutes(deps)。
//
// 行为契约（诚实优先，绝不伪装成功）：
//   - 未配置/禁用 Provider、Key 无法解密 → 409 LLM_NOT_CONFIGURED；
//   - Provider 不可达/超时/限流/5xx → 202 {queued:true, queue_id}（入离线队列，可重试）；
//   - 调用成功 → 200 真实模型输出；
//   - 调用方可传 offline_queue:false 要求失败时直接 503 LLM_UNAVAILABLE 而不排队；
//   - 所有 Provider 响应只返回 Key 掩码；请求上下文只含本地检索后的最小记忆集合。
import { reply, created } from '../server/respond.js';
import { requestMeta } from '../api/util.js';
import { ApiError, validationFailed, llmUnavailable, notFound } from '../core/errors.js';
import { nowIso } from '../core/time.js';
import { newTraceId } from '../core/ids.js';
import { createProviderStore } from './providers.js';
import { createLlmClient, LlmCallError } from './client.js';
import { createLlmQueue } from './queue.js';
import { selectContext, composeChatMessages, pickQueryFromMessages } from './context.js';

const MAX_MESSAGES = 32;
const MAX_MESSAGE_CHARS = 60_000;
const RETRY_INTERVAL_MIN_MS = 5_000;
const RETRY_INTERVAL_MAX_MS = 60_000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseIntegerField(value, field, { min, max }) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw validationFailed([{ field, message: `必须是 ${min}..${max} 的整数` }]);
  }
  return n;
}

function parseOptionalBoolean(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw validationFailed([{ field, message: '必须是布尔值' }]);
  return value;
}

function normalizeMessages(messages) {
  if (messages === undefined || messages === null) return undefined;
  if (!Array.isArray(messages)) throw validationFailed([{ field: 'messages', message: '必须是数组' }]);
  if (messages.length === 0) throw validationFailed([{ field: 'messages', message: '不能为空数组' }]);
  if (messages.length > MAX_MESSAGES) throw validationFailed([{ field: 'messages', message: `不得超过 ${MAX_MESSAGES} 条` }]);
  return messages.map((message, index) => {
    if (!isPlainObject(message)) throw validationFailed([{ field: `messages[${index}]`, message: '必须是对象' }]);
    const role = String(message.role ?? '');
    if (!['system', 'user', 'assistant'].includes(role)) {
      throw validationFailed([{ field: `messages[${index}].role`, message: '必须是 system|user|assistant' }]);
    }
    if (typeof message.content === 'string') {
      if (message.content.length > MAX_MESSAGE_CHARS) {
        throw validationFailed([{ field: `messages[${index}].content`, message: `不得超过 ${MAX_MESSAGE_CHARS} 字符` }]);
      }
      return { role, content: message.content };
    }
    if (Array.isArray(message.content)) return { role, content: message.content };
    throw validationFailed([{ field: `messages[${index}].content`, message: '必须是字符串或文本 part 数组' }]);
  });
}

/** 归一化 POST /llm/complete 请求体（兼容 Desktop 的 messages-only 调用与契约的 query 调用）。 */
export function normalizeCompleteInput(body) {
  if (!isPlainObject(body)) throw validationFailed([{ field: null, message: 'body 必须是 JSON 对象' }]);
  const errors = [];
  const messages = (() => {
    try {
      return normalizeMessages(body.messages);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw err;
    }
  })();
  let query = '';
  if (typeof body.query === 'string') query = body.query.trim();
  else if (typeof body.prompt === 'string') query = body.prompt.trim();
  const queryFromMessages = query ? '' : pickQueryFromMessages(messages);
  if (!query && !queryFromMessages && !messages) {
    errors.push({ field: 'query', message: '必须提供 query/prompt 或 messages' });
  }
  let memoryIds;
  if (body.memory_ids !== undefined && body.memory_ids !== null) {
    if (!Array.isArray(body.memory_ids)) errors.push({ field: 'memory_ids', message: '必须是数组' });
    else memoryIds = body.memory_ids.map(String).filter(Boolean).slice(0, 40);
  } else if (body.memory_id) {
    memoryIds = [String(body.memory_id)];
  }
  const providerId = body.provider_id === undefined || body.provider_id === null || body.provider_id === ''
    ? null
    : String(body.provider_id);
  if (errors.length) throw validationFailed(errors);
  return {
    query: query || queryFromMessages || '',
    messages,
    memory_ids: memoryIds,
    top_k: parseIntegerField(body.top_k, 'top_k', { min: 1, max: 20 }),
    budget_chars: parseIntegerField(body.budget_chars, 'budget_chars', { min: 500, max: 100_000 }),
    max_tokens: parseIntegerField(body.max_tokens, 'max_tokens', { min: 1, max: 32_768 }),
    temperature: (() => {
      if (body.temperature === undefined || body.temperature === null || body.temperature === '') return undefined;
      const n = Number(body.temperature);
      if (!Number.isFinite(n) || n < 0 || n > 2) throw validationFailed([{ field: 'temperature', message: '必须在 0..2 之间' }]);
      return n;
    })(),
    use_context: parseOptionalBoolean(body.use_context, 'use_context'),
    offline_queue: parseOptionalBoolean(body.offline_queue, 'offline_queue'),
    provider_id: providerId,
    system_prompt: typeof body.system_prompt === 'string' ? body.system_prompt.slice(0, 20_000) : null,
  };
}

export async function registerLlmRoutes(deps) {
  const { router, config, logger, holder, events, services, state } = deps;
  const fetchImpl = deps.fetchImpl ?? deps.llmFetchImpl ?? globalThis.fetch;
  const providers = createProviderStore({ dbHolder: holder, config, logger });
  const client = createLlmClient({ fetchImpl, logger });
  const queue = createLlmQueue({ dbHolder: holder, config, logger });
  const inFlight = new Set();

  /** 写审计事件；事件写入失败不得影响主流程（LLM 调用本身才是业务事实）。 */
  function emitEvent(type, { meta, subject = null, payload = {} } = {}) {
    try {
      const d = holder.requireDb();
      const prepared = events.prepare(d, {
        type,
        actor: meta?.actor,
        source: meta?.source,
        subject: subject ?? { kind: 'llm', id: null },
        payload,
        trace_id: meta?.traceId,
      });
      events.publish(prepared.event);
      return prepared.event;
    } catch (err) {
      logger?.warn?.('LLM 事件写入失败（不影响主流程）', { type, error: err.message });
      return null;
    }
  }

  function systemMeta() {
    return {
      actor: { kind: 'system', id: 'runtime', display: '系统' },
      source: { kind: 'cli', id: 'runtime', version: config.productVersion },
      traceId: newTraceId(),
    };
  }

  function buildContextForRequest(input) {
    const d = holder.requireDb();
    return selectContext(
      { db: d, services, config, logger },
      {
        query: input.query,
        memory_ids: input.memory_ids,
        top_k: input.top_k,
        budget_chars: input.budget_chars,
        use_context: input.use_context,
      },
    );
  }

  function contextSummary(context) {
    return {
      selection: context.selection,
      count: context.items.length,
      chars: context.chars,
      memory_ids: context.items.map((item) => item.id),
      note: context.note,
    };
  }

  function buildQueueRequest(input, context, providerId) {
    return {
      query: input.query || null,
      messages: input.messages
        ? input.messages.slice(0, MAX_MESSAGES).map((message) => ({
            role: message.role,
            content: typeof message.content === 'string' ? message.content.slice(0, 8000) : String(message.content ?? '').slice(0, 8000),
          }))
        : null,
      system_prompt: input.system_prompt,
      memory_ids: input.memory_ids ?? null,
      context,
      max_tokens: input.max_tokens ?? null,
      temperature: input.temperature ?? null,
      provider_id: providerId ?? null,
    };
  }

  // ---------------------------------------------------------------- providers CRUD
  router.add('GET', '/api/v1/llm/providers', () => reply(providers.list()), {
    description: 'LLM Provider 列表（API Key 只返回掩码）',
  });

  router.add('POST', '/api/v1/llm/providers', (ctx) => created(providers.create(ctx.body ?? {})), {
    description: '新建 LLM Provider（kind: deepseek|openai-compatible|custom；key 加密落库）',
  });

  router.add('PATCH', '/api/v1/llm/providers/:id', (ctx) => reply(providers.patch(ctx.params.id, ctx.body ?? {})), {
    description: '修改 LLM Provider（api_key 传 null 清除；is_default 切换默认）',
  });

  router.add('DELETE', '/api/v1/llm/providers/:id', (ctx) => reply(providers.remove(ctx.params.id)), {
    description: '删除 LLM Provider（不影响本地记忆）',
  });

  // ---------------------------------------------------------------- complete
  router.add(
    'POST',
    '/api/v1/llm/complete',
    async (ctx) => {
      const meta = requestMeta(ctx);
      const input = normalizeCompleteInput(ctx.body ?? {});
      const providerRow = providers.pickForRequest(input.provider_id, { allowNone: true });
      const context = buildContextForRequest(input);

      // 未配置任何 Provider：按契约 §4 / docs/API.md 入离线队列（202），恢复配置后可 retry；
      // 不返回伪造的模型输出（LLM_NOT_CONFIGURED 仅用于“已配置但不可用/配置错误”的场景）。
      if (!providerRow) {
        let queueId;
        try {
          queueId = queue.enqueue(buildQueueRequest(input, context, null), {
            reason: 'no_provider_configured',
            error: '尚未配置可用的 LLM Provider',
            errorCode: 'LLM_NOT_CONFIGURED',
            providerId: null,
          });
        } catch (queueErr) {
          throw llmUnavailable(`尚未配置可用的 LLM Provider，且离线队列写入失败：${queueErr.message}`, { queued: false, queue_error: queueErr.message });
        }
        emitEvent('llm.request.queued', {
          meta,
          subject: { kind: 'llm', id: queueId },
          payload: { queue_id: queueId, reason: 'no_provider_configured', offline: true, context_items: context.items.length },
        });
        logger?.warn?.('未配置 LLM Provider，请求已入离线队列（不伪造输出）', { queue_id: queueId });
        return reply(
          {
            queued: true,
            queue_id: queueId,
            status: 'pending',
            reason: 'no_provider_configured',
            offline: true,
            error: { code: 'LLM_NOT_CONFIGURED', message: '尚未配置可用的 LLM Provider（已入队，配置后可重试；本地记忆功能不受影响）' },
            context: contextSummary(context),
          },
          202,
        );
      }

      const providerCfg = providers.runtimeConfig(providerRow);
      const messages = composeChatMessages({
        messages: input.messages,
        query: input.query,
        context,
        system_prompt: input.system_prompt,
      });

      emitEvent('llm.request.sent', {
        meta,
        subject: { kind: 'llm', id: providerRow.provider_id },
        payload: {
          provider_id: providerRow.provider_id,
          provider: providerRow.name,
          kind: providerRow.kind,
          model: providerCfg.model,
          context_items: context.items.length,
          context_chars: context.chars,
          context_selection: context.selection,
        },
      });

      try {
        const result = await client.chat(providerCfg, messages, {
          max_tokens: input.max_tokens,
          temperature: input.temperature,
        });
        emitEvent('llm.request.completed', {
          meta,
          subject: { kind: 'llm', id: providerRow.provider_id },
          payload: {
            provider_id: providerRow.provider_id,
            provider: providerRow.name,
            model: result.model,
            usage: result.usage,
            context_items: context.items.length,
            offline: false,
          },
        });
        return reply({
          text: result.text,
          content: result.text,
          provider: providerRow.name,
          provider_id: providerRow.provider_id,
          model: result.model,
          usage: result.usage,
          finish_reason: result.finish_reason,
          offline: false,
          queued: false,
          elapsed_ms: result.elapsed_ms,
          context: contextSummary(context),
        });
      } catch (err) {
        if (!(err instanceof LlmCallError)) throw err;
        if (err.classification === 'configuration') {
          emitEvent('llm.request.failed', {
            meta,
            subject: { kind: 'llm', id: providerRow.provider_id },
            payload: { provider_id: providerRow.provider_id, provider: providerRow.name, error: err.message, code: err.code, queued: false },
          });
          throw new ApiError(err.code === 'LLM_UNAVAILABLE' ? 'LLM_UNAVAILABLE' : 'LLM_NOT_CONFIGURED', err.message, {
            ...err.details,
            queued: false,
          });
        }
        if (input.offline_queue === false) {
          emitEvent('llm.request.failed', {
            meta,
            subject: { kind: 'llm', id: providerRow.provider_id },
            payload: { provider_id: providerRow.provider_id, provider: providerRow.name, error: err.message, code: err.code, queued: false },
          });
          throw llmUnavailable(err.message, { ...err.details, queued: false });
        }
        let queueId;
        try {
          queueId = queue.enqueue(buildQueueRequest(input, context, providerRow.provider_id), {
            reason: 'provider_unavailable',
            error: err.message,
            errorCode: err.code,
            providerId: providerRow.provider_id,
          });
        } catch (queueErr) {
          throw llmUnavailable(`LLM 不可达（${err.message}），且离线队列写入失败：${queueErr.message}`, {
            ...err.details,
            queued: false,
            queue_error: queueErr.message,
          });
        }
        emitEvent('llm.request.failed', {
          meta,
          subject: { kind: 'llm', id: queueId },
          payload: { queue_id: queueId, provider_id: providerRow.provider_id, provider: providerRow.name, error: err.message, code: err.code, queued: true },
        });
        emitEvent('llm.request.queued', {
          meta,
          subject: { kind: 'llm', id: queueId },
          payload: {
            queue_id: queueId,
            provider_id: providerRow.provider_id,
            reason: 'provider_unavailable',
            offline: true,
            context_items: context.items.length,
          },
        });
        logger?.warn?.('LLM API 不可达，请求已入离线队列（不伪造输出）', {
          queue_id: queueId,
          provider_id: providerRow.provider_id,
          reason: err.reason,
        });
        return reply(
          {
            queued: true,
            queue_id: queueId,
            status: 'pending',
            reason: 'provider_unavailable',
            offline: true,
            error: { code: err.code, message: err.message, details: err.details ?? {} },
            context: contextSummary(context),
          },
          202,
        );
      }
    },
    { description: '检索最小记忆上下文后调用 LLM；不可达 → 202 {queued:true,queue_id}；未配置 → 409' },
  );

  // ---------------------------------------------------------------- queue
  router.add(
    'GET',
    '/api/v1/llm/queue',
    (ctx) => reply(queue.list({ status: ctx.query.status ?? null, limit: ctx.query.limit })),
    { description: '未处理 LLM 请求队列（默认 pending+failed；?status=&limit=）' },
  );

  /** 执行一条队列项（供手动 retry 与自动退避重试共用）。 */
  async function runQueuedItem(queueId, { meta, source }) {
    const row = queue.getRow(queueId);
    if (!row) return { outcome: 'skipped', reason: 'not_found' };
    if (row.status === 'completed') return { outcome: 'completed', already: true, queue: queue.get(queueId) };
    if (row.status === 'failed') return { outcome: 'failed', queue: queue.get(queueId), reason: 'already_failed' };
    if (inFlight.has(queueId)) return { outcome: 'skipped', reason: 'in_flight', queue: queue.get(queueId) };
    inFlight.add(queueId);
    try {
      const request = queue.get(queueId).request ?? {};
      let providerRow;
      try {
        providerRow = providers.pickForRequest(request.provider_id ?? null);
      } catch (err) {
        if (err.code === 'NOT_FOUND' && request.provider_id) {
          try {
            providerRow = providers.pickForRequest(null, { allowNone: true });
          } catch (fallbackErr) {
            return { outcome: 'queued', reason: fallbackErr.details?.reason ?? 'no_provider_configured', queue: queue.get(queueId), error: fallbackErr };
          }
          if (!providerRow) return { outcome: 'queued', reason: 'no_provider_configured', queue: queue.get(queueId), error: err };
        } else if (err.code === 'LLM_NOT_CONFIGURED') {
          return { outcome: 'queued', reason: err.details?.reason ?? 'no_provider_configured', queue: queue.get(queueId), error: err };
        } else {
          throw err;
        }
      }
      const providerCfg = providers.runtimeConfig(providerRow);
      const context = request.context ?? { items: [], chars: 0, selection: 'none', note: '', stats: {} };
      const messages = composeChatMessages({
        messages: request.messages ?? null,
        query: request.query ?? '',
        context,
        system_prompt: request.system_prompt ?? null,
      });
      emitEvent('llm.request.sent', {
        meta,
        subject: { kind: 'llm', id: providerRow.provider_id },
        payload: {
          queue_id: queueId,
          provider_id: providerRow.provider_id,
          provider: providerRow.name,
          model: providerCfg.model,
          context_items: context.items?.length ?? 0,
          retry_source: source,
        },
      });
      try {
        const result = await client.chat(providerCfg, messages, {
          max_tokens: request.max_tokens ?? undefined,
          temperature: request.temperature ?? undefined,
        });
        const record = queue.markCompleted(queueId, {
          text: result.text,
          usage: result.usage,
          model: result.model,
          provider: providerRow.name,
          provider_id: providerRow.provider_id,
          completed_at: nowIso(),
          retry_source: source,
        });
        emitEvent('llm.request.completed', {
          meta,
          subject: { kind: 'llm', id: providerRow.provider_id },
          payload: { queue_id: queueId, provider_id: providerRow.provider_id, provider: providerRow.name, model: result.model, usage: result.usage, retry_source: source },
        });
        logger?.info?.('LLM 队列项重试成功', { queue_id: queueId, provider_id: providerRow.provider_id, retry_source: source });
        return { outcome: 'completed', queue: record, result, provider: providerRow };
      } catch (err) {
        if (!(err instanceof LlmCallError)) throw err;
        const failure = queue.markFailure(queueId, { classification: err.classification, message: err.message, code: err.code });
        emitEvent('llm.request.failed', {
          meta,
          subject: { kind: 'llm', id: queueId },
          payload: { queue_id: queueId, provider_id: providerRow.provider_id, error: err.message, code: err.code, retry_source: source, attempts: failure.attempts },
        });
        if (failure.status === 'failed') {
          logger?.warn?.('LLM 队列项重试失败（已停止重试，错误如实保留）', { queue_id: queueId, error: err.message, attempts: failure.attempts });
        } else {
          logger?.warn?.('LLM 队列项重试仍不可达，已安排退避重试', { queue_id: queueId, error: err.message, next_retry_at: failure.next_retry_at });
        }
        return { outcome: failure.status === 'failed' ? 'failed' : 'queued', queue: queue.get(queueId), error: err, failure, provider: providerRow };
      }
    } finally {
      inFlight.delete(queueId);
    }
  }

  router.add(
    'POST',
    '/api/v1/llm/queue/:id/retry',
    async (ctx) => {
      const queueId = ctx.params.id;
      const row = queue.getRow(queueId);
      if (!row) throw notFound(`LLM 队列项不存在：${queueId}`);
      const meta = requestMeta(ctx);
      const outcome = await runQueuedItem(queueId, { meta, source: 'manual' });
      if (outcome.outcome === 'completed') {
        const result = outcome.result ?? outcome.queue?.result ?? null;
        return reply({
          completed: true,
          queue_id: queueId,
          text: result?.text ?? null,
          content: result?.text ?? null,
          provider: result?.provider ?? outcome.queue?.provider_id ?? null,
          model: result?.model ?? null,
          usage: result?.usage ?? null,
          already_completed: Boolean(outcome.already),
        });
      }
      if (outcome.outcome === 'queued') {
        const errorPayload = outcome.error
          ? { code: outcome.error.code, message: outcome.error.message }
          : { code: 'LLM_UNAVAILABLE', message: 'LLM 仍不可达（请求保留在离线队列中）' };
        return reply(
          {
            queued: true,
            queue_id: queueId,
            status: 'pending',
            retryable: true,
            reason: outcome.reason ?? 'provider_unavailable',
            next_retry_at: outcome.failure?.next_retry_at ?? null,
            error: errorPayload,
          },
          202,
        );
      }
      if (outcome.outcome === 'failed') {
        const err = outcome.error;
        throw new ApiError(err?.code === 'LLM_NOT_CONFIGURED' ? 'LLM_NOT_CONFIGURED' : 'LLM_UNAVAILABLE', err?.message ?? 'LLM 调用失败（不伪造输出）', {
          queue_id: queueId,
          attempts: outcome.failure?.attempts ?? null,
          retryable: false,
        });
      }
      return reply({ queued: true, queue_id: queueId, status: 'pending', reason: outcome.reason ?? 'skipped' }, 202);
    },
    { description: '重试离线队列项（成功返回真实模型输出；配置类错误 409；仍不可达 202）' },
  );

  // ---------------------------------------------------------------- 自动退避重试（可选，可在 config 关闭）
  let retryTimer = null;
  let retryRunning = false;
  if (config.llmAutoRetry !== false) {
    const baseMs = Number(config.llmQueueRetryBaseMs) > 0 ? Number(config.llmQueueRetryBaseMs) : 30_000;
    const intervalMs = Math.max(RETRY_INTERVAL_MIN_MS, Math.min(RETRY_INTERVAL_MAX_MS, Math.floor(baseMs / 2)));
    retryTimer = setInterval(async () => {
      if (retryRunning || state?.shuttingDown) return;
      retryRunning = true;
      try {
        const due = queue.listDue({ limit: 3 });
        for (const item of due) {
          try {
            await runQueuedItem(item.queue_id, { meta: systemMeta(), source: 'auto_backoff' });
          } catch (err) {
            logger?.warn?.('LLM 队列自动重试异常', { queue_id: item.queue_id, error: err.message });
          }
        }
      } catch (err) {
        logger?.warn?.('LLM 队列自动重试扫描失败', { error: err.message });
      } finally {
        retryRunning = false;
      }
    }, intervalMs);
    retryTimer.unref?.();
  }

  logger?.info?.('LLM Gateway 已挂载', {
    routes: router.list().filter((route) => route.path.startsWith('/api/v1/llm')).length,
    auto_retry: config.llmAutoRetry !== false,
    provider_kinds: ['deepseek', 'openai-compatible', 'custom'],
  });

  return {
    stopAutoRetry() {
      if (retryTimer) clearInterval(retryTimer);
      retryTimer = null;
    },
    providers,
    queue,
    client,
  };
}

export const LLM_ROUTE_MODULE = 'runtime/src/llm/routes.js';
export const LLM_ROUTE_EXPORT = 'registerLlmRoutes';
