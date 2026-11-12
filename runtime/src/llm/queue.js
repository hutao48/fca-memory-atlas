// FCA Local Runtime — LLM 离线队列（ADR-007 §4：API 不可达 → 入队、状态可查、退避重试、绝不伪造输出）
// 表结构沿用 migration v1 的 llm_queue；调度信息（下次重试时间）由 updated_at + attempts 计算，
// 不新增 schema 列（避免公共数据库 schema 变更）。
import { newId } from '../core/ids.js';
import { nowIso } from '../core/time.js';
import { notFound, validationFailed } from '../core/errors.js';

export const QUEUE_STATUS = Object.freeze({
  PENDING: 'pending',
  SENT: 'sent',
  FAILED: 'failed',
  COMPLETED: 'completed',
});
const STATUS_SET = new Set(Object.values(QUEUE_STATUS));
const MAX_ATTEMPTS = 8;
const MAX_REQUEST_BYTES = 64 * 1024;

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * 创建队列访问器。
 * @param {{dbHolder:object, config:object, logger:object}} deps
 */
export function createLlmQueue({ dbHolder, config, logger }) {
  const db = () => dbHolder.requireDb();

  function baseBackoffMs() {
    const n = Number(config?.llmQueueRetryBaseMs);
    return Number.isFinite(n) && n >= 1000 ? n : 30_000;
  }

  /** 指数退避：base * 2^(attempts-1)，上限 30 分钟。 */
  function backoffMs(attempts) {
    const n = Math.max(0, Number(attempts) || 0);
    const raw = baseBackoffMs() * 2 ** Math.max(0, n - 1);
    return Math.min(raw, 30 * 60_000);
  }

  function nextRetryAt(updatedAt, attempts) {
    const base = Date.parse(updatedAt);
    if (!Number.isFinite(base)) return null;
    return new Date(base + backoffMs(attempts)).toISOString();
  }

  function presentRow(row) {
    if (!row) return null;
    const request = parseJson(row.request, {});
    const status = row.status;
    return {
      queue_id: row.queue_id,
      status,
      request,
      result: row.result ? parseJson(row.result, null) : null,
      error: row.error ?? null,
      last_error_code: request?.last_error_code ?? null,
      attempts: Number(row.attempts),
      max_attempts: MAX_ATTEMPTS,
      retryable: status === QUEUE_STATUS.PENDING && Number(row.attempts) < MAX_ATTEMPTS,
      next_retry_at: status === QUEUE_STATUS.PENDING ? nextRetryAt(row.updated_at, Number(row.attempts)) : null,
      provider_id: request?.provider_id ?? null,
      reason: request?.reason ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * 入队一次失败的 LLM 请求（保留当时的最小上下文，便于恢复后重试）。
   * @returns {string} queue_id
   */
  function enqueue(request, { reason = 'provider_unavailable', error = null, errorCode = null, providerId = null } = {}) {
    const payload = {
      ...request,
      provider_id: providerId ?? request?.provider_id ?? null,
      reason,
      last_error_code: errorCode,
    };
    let json = JSON.stringify(payload);
    if (Buffer.byteLength(json, 'utf8') > MAX_REQUEST_BYTES) {
      payload.messages = null; // 超大 messages 不落库；重试时按 query+context 重建
      json = JSON.stringify(payload);
    }
    const queueId = newId('event');
    const now = nowIso();
    db()
      .prepare('INSERT INTO llm_queue(queue_id, status, request, result, error, attempts, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(queueId, QUEUE_STATUS.PENDING, json, null, error ? String(error) : null, 1, now, now);
    logger?.info?.('LLM 请求已入离线队列', { queue_id: queueId, reason, provider_id: payload.provider_id });
    return queueId;
  }

  function getRow(queueId) {
    return db().prepare('SELECT * FROM llm_queue WHERE queue_id = ?').get(String(queueId)) ?? null;
  }

  function get(queueId) {
    const row = getRow(queueId);
    if (!row) throw notFound(`LLM 队列项不存在：${queueId}`);
    return presentRow(row);
  }

  function list({ status = null, limit = 50 } = {}) {
    const d = db();
    const parsedLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    let rows;
    if (status) {
      if (!STATUS_SET.has(status)) {
        throw validationFailed([{ field: 'status', message: `必须是 ${[...STATUS_SET].join('|')}` }]);
      }
      rows = d.prepare('SELECT * FROM llm_queue WHERE status = ? ORDER BY created_at ASC LIMIT ?').all(status, parsedLimit);
    } else {
      rows = d
        .prepare("SELECT * FROM llm_queue WHERE status IN ('pending','failed') ORDER BY created_at ASC LIMIT ?")
        .all(parsedLimit);
    }
    const items = rows.map(presentRow);
    const total = Number(
      d
        .prepare(
          status ? 'SELECT count(*) c FROM llm_queue WHERE status = ?' : "SELECT count(*) c FROM llm_queue WHERE status IN ('pending','failed')",
        )
        .get(...(status ? [status] : []))?.c ?? 0,
    );
    return { items, total, limit: parsedLimit, status: status ?? 'pending+failed' };
  }

  function markCompleted(queueId, result) {
    const json = JSON.stringify(result ?? null);
    db()
      .prepare("UPDATE llm_queue SET status = 'completed', result = ?, error = NULL, attempts = attempts + 1, updated_at = ? WHERE queue_id = ?")
      .run(json, nowIso(), String(queueId));
    return get(queueId);
  }

  /**
   * 标记一次失败（attempts 自增；transient 且未耗尽 → 回到 pending 等退避重试）。
   * @param {'configuration'|'transient'} classification
   * @returns {{status:string, attempts:number, next_retry_at:string|null}}
   */
  function markFailure(queueId, { classification = 'transient', message = 'unknown', code = null } = {}) {
    const row = getRow(queueId);
    if (!row) throw notFound(`LLM 队列项不存在：${queueId}`);
    const attempts = Number(row.attempts) + 1;
    const exhausted = attempts >= MAX_ATTEMPTS;
    const status = classification === 'configuration' || exhausted ? QUEUE_STATUS.FAILED : QUEUE_STATUS.PENDING;
    const updatedAt = nowIso();
    db()
      .prepare('UPDATE llm_queue SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE queue_id = ?')
      .run(status, attempts, String(message), updatedAt, String(queueId));
    return {
      status,
      attempts,
      exhausted,
      last_error_code: code,
      next_retry_at: status === QUEUE_STATUS.PENDING ? nextRetryAt(updatedAt, attempts) : null,
    };
  }

  /** 找出到期的待重试项（按上次更新时间 + 指数退避判断）。 */
  function listDue({ now = Date.now(), limit = 5 } = {}) {
    const rows = db()
      .prepare("SELECT * FROM llm_queue WHERE status = 'pending' AND attempts < ? ORDER BY updated_at ASC LIMIT ?")
      .all(MAX_ATTEMPTS, Math.max(1, Number(limit) || 5));
    return rows
      .filter((row) => {
        const due = Date.parse(nextRetryAt(row.updated_at, Number(row.attempts)) ?? '');
        return !Number.isFinite(due) || due <= now;
      })
      .map(presentRow);
  }

  function counts() {
    const rows = db().prepare('SELECT status, count(*) c FROM llm_queue GROUP BY status').all();
    const out = { pending: 0, sent: 0, failed: 0, completed: 0 };
    for (const row of rows) if (out[row.status] !== undefined) out[row.status] = Number(row.c);
    return out;
  }

  return {
    enqueue,
    get,
    getRow,
    list,
    markCompleted,
    markFailure,
    listDue,
    counts,
    presentRow,
    backoffMs,
    nextRetryAt,
    MAX_ATTEMPTS,
  };
}
