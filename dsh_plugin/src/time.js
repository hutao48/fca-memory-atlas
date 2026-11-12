/**
 * Timestamp helpers for automatic memory (v0.3).
 *
 * User requirement: every automatic memory must carry a real occurrence time
 * instead of "发生时间未知". DSH session events carry `time: number` (epoch
 * milliseconds); that is the authoritative clock for derived memories:
 *
 * - user message memory  → the `user/message` event time;
 * - Agent 思考节点      → the turn's first observed event time (turn/start time
 *                          when available, else the first event of the turn);
 * - 子 Agent 会话记忆   → the child session's first observed event time
 *                          (the spawn-prompt `user/message` time).
 *
 * All derived times are written as ISO 8601 with `occurred_precision: 'exact'`
 * so the Desktop/Unity surfaces stop grouping them as unknown.
 *
 * @module dsh-plugin-fca-memory/src/time
 */

/**
 * Convert an epoch-millisecond event time to an ISO string.
 * @param value - `SessionEvent.time` or any epoch-ms number.
 * @returns ISO string, or '' when the value is not a finite positive number.
 */
export function eventTimeIso(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return ''
  try {
    const date = new Date(value)
    const time = date.getTime()
    if (!Number.isFinite(time)) return ''
    return date.toISOString()
  } catch {
    return ''
  }
}

/**
 * Resolve the occurrence time for one derived memory.
 * @param event - committed SessionEvent (`time` is epoch ms).
 * @param fallback - optional fallback epoch ms (e.g. buffered first event time)
 * @param now - injectable clock for tests (`Date.now`-like function).
 * @returns `{ occurred_at, occurred_precision }` — always a valid ISO string
 *   with precision `exact` (falls back to the capture time, never null).
 */
export function occurredAtOf(event, fallback, now = Date.now) {
  const fromEvent = event && typeof event === 'object' ? eventTimeIso(event.time) : ''
  if (fromEvent) return { occurred_at: fromEvent, occurred_precision: 'exact' }
  const fromFallback = eventTimeIso(fallback)
  if (fromFallback) return { occurred_at: fromFallback, occurred_precision: 'exact' }
  let captured = ''
  try {
    captured = eventTimeIso(typeof now === 'function' ? now() : Date.now())
  } catch {
    captured = ''
  }
  return { occurred_at: captured || new Date().toISOString(), occurred_precision: 'exact' }
}

/** Short human-readable UTC rendering used inside memory bodies. */
export function formatIsoForBody(iso) {
  if (typeof iso !== 'string' || !iso) return ''
  return iso.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z')
}
