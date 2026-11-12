/**
 * Session event capture.
 *
 * Maps committed DSH session events onto the frozen FCA event envelope
 * (`agent.event_received`, contract §6), then delivers them to
 * `POST /api/v1/event` with an idempotent `client_event_id`.
 *
 * Design rules:
 * - The Session log is the source of truth; capture is a derived, lossy feed.
 * - A capture policy decides what leaves the Host. Default `turn-summaries`
 *   uploads one small audit event per completed turn, no message bodies.
 * - Text is redacted and truncated before it is queued.
 * - Delivery is best effort with bounded retry and a bounded local queue; a
 *   Runtime outage never surfaces as an error in DSH and never grows memory
 *   without bound.
 *
 * @module dsh-plugin-fca-memory/src/capture
 */

import { randomBytes } from 'node:crypto'
import { PLUGIN_VERSION, CLIENT_ID } from './config.js'

/** New contract-shaped trace id (`trc_` + 32 lowercase hex chars). */
function newTraceId() {
  return `trc_${randomBytes(16).toString('hex')}`
}

/** Policies and the DSH event types each one forwards. */
const POLICY_EVENTS = {
  'off': [],
  'user-messages': ['user/message'],
  'turn-summaries': ['turn/end'],
  'full': ['user/message', 'assistant/message', 'turn/end', 'tool/call', 'tool/result'],
}

const RETRY_LIMIT = 3
const RETRY_BASE_MS = 1500
const DEDUPE_LIMIT = 500

/** Extract plain text from a DSH message content-block array. */
function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** True when the value is a plain object. */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Create the capture subsystem.
 * @param options.config - normalized plugin configuration.
 * @param options.logger - plugin logger.
 * @param options.client - Runtime client.
 * @param options.redactor - redactor created by the logger module.
 * @param options.state - shared bridge state (read for connection status).
 * @returns the capture controller.
 */
export function createCapture({ config, logger, client, redactor, state }) {
  const allowed = new Set(POLICY_EVENTS[config.capturePolicy] || [])
  const queue = []
  const dedupe = new Set()
  const counters = { received: 0, queued: 0, sent: 0, failed: 0, dropped: 0, suppressed: 0 }
  let lastError = null
  let flushing = false
  let disposed = false
  let retryTimer = null
  let flushTimer = null
  let attemptsInCycle = 0

  function noteError(code, message) {
    lastError = { at: new Date().toISOString(), code: code || 'UNKNOWN', message: String(message || '') }
  }

  /** Redact then truncate to `maxEventBytes` (UTF-8 bytes, never split mid-character). */
  function sanitize(text, limitBytes) {
    const redacted = redactor.redact(typeof text === 'string' ? text : '')
    if (!redacted) return ''
    let out = redacted
    if (Buffer.byteLength(out, 'utf8') > limitBytes) {
      out = out.slice(0, Math.max(0, limitBytes))
      while (out.length > 0 && Buffer.byteLength(out, 'utf8') > limitBytes) out = out.slice(0, -1)
      out = `${out}…[truncated]`
    }
    return out
  }

  /** Build the contract §6 event envelope for one DSH event. */
  function envelopeFor(sessionId, event) {
    const type = event && event.type
    const seq = event && event.seq
    const data = isObject(event && event.data) ? event.data : {}
    const payload = {
      dsh: { event: type, seq: typeof seq === 'number' ? seq : null, session_id: sessionId },
    }

    if (type === 'turn/end') {
      payload.turn = typeof data.turn === 'number' ? data.turn : null
      payload.reason = isObject(data.reason) && typeof data.reason.kind === 'string' ? data.reason.kind : null
    } else if (type === 'user/message') {
      const text = sanitize(textOfContent(data.content), Math.min(config.maxEventBytes, 4096))
      payload.role = 'user'
      if (text) payload.text = text
      payload.bytes = Buffer.byteLength(text || '', 'utf8')
    } else if (type === 'assistant/message') {
      const message = isObject(data.message) ? data.message : {}
      const text = sanitize(textOfContent(message.content), Math.min(config.maxEventBytes, 4096))
      payload.role = 'assistant'
      if (text) payload.text = text
      payload.bytes = Buffer.byteLength(text || '', 'utf8')
      if (isObject(data.usage) && typeof data.usage.inputTokens === 'number') {
        payload.usage = { input: data.usage.inputTokens, output: data.usage.outputTokens ?? null }
      }
    } else if (type === 'tool/call') {
      // Arguments are deliberately not captured: they can carry secrets.
      payload.tool = typeof data.name === 'string' ? data.name : null
    } else if (type === 'tool/result') {
      payload.tool_call_id = typeof data.callId === 'string' ? data.callId : null
      payload.is_error = Boolean(data.error)
      if (isObject(data.error) && typeof data.error.code === 'string') payload.error_code = data.error.code
    }

    return {
      schema_version: '1.0',
      type: 'agent.event_received',
      ts: new Date().toISOString(),
      actor: { kind: 'agent', id: `agent:${sessionId}`, display: 'DSH Agent' },
      source: { kind: CLIENT_ID, id: 'dsh-plugin', version: PLUGIN_VERSION },
      payload,
      trace_id: newTraceId(),
      client_event_id: `dsh:${sessionId}:${payload.dsh.seq === null ? '0' : payload.dsh.seq}:${type}`,
    }
  }

  function scheduleFlush(delayMs = 0) {
    if (disposed) return
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    const timer = setTimeout(() => {
      retryTimer = null
      flushTimer = null
      void flush()
    }, Math.max(0, delayMs))
    if (typeof timer.unref === 'function') timer.unref()
    if (delayMs > 0) retryTimer = timer
    else flushTimer = timer
  }

  async function flush() {
    if (disposed || flushing || queue.length === 0) return
    flushing = true
    try {
      while (queue.length > 0 && !disposed) {
        const item = queue[0]
        const response = await client.submitEvent(item.event)
        if (response.ok) {
          queue.shift()
          counters.sent += 1
          attemptsInCycle = 0
          continue
        }
        item.attempts += 1
        counters.failed += 1
        noteError(response.code || 'EVENT_REJECTED', response.message)
        if (item.attempts >= RETRY_LIMIT) {
          queue.shift()
          counters.dropped += 1
          logger.warn('dropping undeliverable event', { attempts: item.attempts, code: response.code, queued: queue.length })
        } else {
          // Back off and stop this cycle; the next flush retries the same head.
          scheduleFlush(RETRY_BASE_MS * item.attempts)
          break
        }
      }
      if (queue.length > 0 && !disposed && !retryTimer) scheduleFlush(RETRY_BASE_MS)
    } catch (error) {
      noteError('CAPTURE_ERROR', error && error.message)
    } finally {
      flushing = false
    }
  }

  return {
    /** Number of policy-allowed event types (0 when capture is off). */
    get enabled() {
      return allowed.size > 0
    },

    policy: config.capturePolicy,

    /**
     * Feed one committed session event. Never throws.
     * @param session - the Session whose log grew (needs `.id`).
     * @param event - the committed SessionEvent (needs `.type`, `.seq`).
     */
    handle(session, event) {
      try {
        if (disposed || allowed.size === 0) return
        const type = event && event.type
        if (typeof type !== 'string' || !allowed.has(type)) return
        const sessionId = session && typeof session.id === 'string' ? session.id : null
        if (!sessionId) return
        counters.received += 1
        const envelope = envelopeFor(sessionId, event)
        if (dedupe.has(envelope.client_event_id)) {
          counters.suppressed += 1
          return
        }
        dedupe.add(envelope.client_event_id)
        if (dedupe.size > DEDUPE_LIMIT) {
          const oldest = dedupe.values().next().value
          if (oldest !== undefined) dedupe.delete(oldest)
        }
        if (queue.length >= config.eventQueueLimit) {
          queue.shift()
          counters.dropped += 1
          noteError('QUEUE_OVERFLOW', `capture queue exceeded ${config.eventQueueLimit} events`)
        }
        queue.push({ event: envelope, attempts: 0 })
        counters.queued += 1
        // Deliver promptly while connected; otherwise the periodic flush retries.
        if (state.connected) scheduleFlush(0)
      } catch (error) {
        noteError('CAPTURE_ERROR', error && error.message)
        logger.debug('capture handler failed', { message: error && error.message })
      }
    },

    /** Force one delivery cycle (used by fca_status / tests). */
    async flushNow() {
      await flush()
    },

    /** Snapshot for `fca_status`. */
    stats() {
      return {
        policy: config.capturePolicy,
        enabled: allowed.size > 0,
        queued: queue.length,
        counters: { ...counters },
        lastError: lastError ? { ...lastError } : null,
      }
    },

    /** Stop timers; queued events are kept in memory only. */
    dispose() {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      if (flushTimer) clearTimeout(flushTimer)
      retryTimer = null
      flushTimer = null
      queue.length = 0
      dedupe.clear()
    },
  }
}

/** Exposed for tests: which event types a policy forwards. */
export function eventTypesForPolicy(policy) {
  return (POLICY_EVENTS[policy] || []).slice()
}
