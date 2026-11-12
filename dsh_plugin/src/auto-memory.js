/**
 * Automatic memory capture ("完全自动添加记忆").
 *
 * Subscribes to the same `session/event` feed as the audit capture, but instead
 * of posting audit events it turns selected *message text* into real memory
 * records through `POST /api/v1/memory/store`.
 *
 * Design rules (aligned with the FCA contract / product principles):
 * - Only user-authored / assistant text messages are considered; tool arguments,
 *   tool results, system prompts and reasoning are never stored.
 * - Text is redacted with the same redactor as the audit flow, length-capped and
 *   sent only to the local Runtime (127.0.0.1). Nothing leaves the machine.
 * - Every derived memory is versioned and traceable: source.ref = dsh-plugin,
 *   source.note records the DSH session id + seq + role.
 * - Global: the plugin listens at the Host root, so messages from every DSH
 *   session (including subagent sessions) are captured while the plugin is loaded.
 * - Bounded: per-hour rate limit + queue cap + retry limit; a Runtime outage
 *   never grows memory without bound and never surfaces as a DSH error.
 *
 * @module dsh-plugin-fca-memory/src/auto-memory
 */

import { createHash } from 'node:crypto'
import { PLUGIN_VERSION, CLIENT_ID } from './config.js'

/** Event roles this module understands and their extraction rules. */
const ROLE_BY_EVENT = {
  'user/message': 'user',
  'assistant/message': 'assistant',
}

const RETRY_LIMIT = 3
const RETRY_BASE_MS = 2000
const SEEN_LIMIT = 2000
const HOUR_MS = 60 * 60 * 1000

/** Extract plain text from a DSH message content-block array. */
function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Short deterministic hash used for text de-duplication. */
function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 20)
}

/** Derive a human-readable title from the first non-empty line. */
function deriveTitle(text) {
  const line = text
    .split('\n')
    .map((value) => value.trim())
    .find((value) => value.length > 0)
  const cleaned = (line || text)
    .replace(/^[#>*\-\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return 'DSH 会话消息'
  return cleaned.length > 80 ? `${cleaned.slice(0, 80)}…` : cleaned
}

/** Small heuristic importance so notable statements stand out in the atlas. */
function deriveImportance(text) {
  let importance = 0.45
  if (text.length >= 80) importance = 0.55
  if (text.length >= 240) importance = 0.65
  if (/(记住|记得|喜欢|最爱|偏好|重要|决定|计划|目标|约定|生日|名字|习惯|项目|提醒|不要|必须)/.test(text)) {
    importance += 0.15
  }
  return Math.max(0.3, Math.min(0.9, Math.round(importance * 100) / 100))
}

/**
 * Create the automatic memory writer.
 * @param options.config - normalized configuration.
 * @param options.logger - plugin logger.
 * @param options.client - Runtime client (`client.storeMemory`).
 * @param options.redactor - redactor created by the logger module.
 * @param options.state - shared bridge state (read for connection status).
 */
export function createAutoMemory({ config, logger, client, redactor, state }) {
  const mode = config.autoMemory || 'off'
  const enabled = mode !== 'off'
  const tags = Array.isArray(config.autoMemoryTags) ? config.autoMemoryTags.slice(0, 16) : ['DSH自动记忆']
  const counters = {
    seen: 0,
    captured: 0,
    stored: 0,
    failed: 0,
    dropped: 0,
    skippedShort: 0,
    skippedDuplicate: 0,
    skippedRate: 0,
    skippedNonText: 0,
  }
  const queue = []
  const seenKeys = new Map()
  const recentTexts = new Map()
  const timestamps = []
  let lastError = null
  let flushing = false
  let disposed = false
  let retryTimer = null
  let flushTimer = null

  function noteError(code, message) {
    lastError = { at: new Date().toISOString(), code: code || 'UNKNOWN', message: String(message || '') }
  }

  function remember(key) {
    seenKeys.set(key, Date.now())
    if (seenKeys.size > SEEN_LIMIT) {
      const oldest = seenKeys.keys().next().value
      if (oldest !== undefined) seenKeys.delete(oldest)
    }
  }

  function textRecentlySeen(hash) {
    const at = recentTexts.get(hash)
    if (at && Date.now() - at < HOUR_MS) return true
    recentTexts.set(hash, Date.now())
    if (recentTexts.size > SEEN_LIMIT) recentTexts.delete(recentTexts.keys().next().value)
    return false
  }

  function rateLimited() {
    const cutoff = Date.now() - HOUR_MS
    while (timestamps.length > 0 && timestamps[0] < cutoff) timestamps.shift()
    if (timestamps.length >= config.autoMemoryMaxPerHour) return true
    timestamps.push(Date.now())
    return false
  }

  function scheduleFlush(delayMs = 0) {
    if (disposed) return
    if (retryTimer) clearTimeout(retryTimer)
    if (flushTimer) clearTimeout(flushTimer)
    retryTimer = null
    flushTimer = null
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
        const response = await client.storeMemory(item.payload)
        if (response.ok) {
          queue.shift()
          counters.stored += 1
          continue
        }
        item.attempts += 1
        counters.failed += 1
        noteError(response.code || 'MEMORY_REJECTED', response.message)
        if (item.attempts >= RETRY_LIMIT) {
          queue.shift()
          counters.dropped += 1
          logger.warn('dropping undeliverable auto memory', {
            attempts: item.attempts,
            code: response.code,
            queued: queue.length,
          })
        } else {
          scheduleFlush(RETRY_BASE_MS * item.attempts)
          break
        }
      }
      if (queue.length > 0 && !disposed && !retryTimer) scheduleFlush(RETRY_BASE_MS)
    } catch (error) {
      noteError('AUTO_MEMORY_ERROR', error && error.message)
    } finally {
      flushing = false
    }
  }

  /** Redact + trim + cap one message text. */
  function sanitize(text) {
    const redacted = redactor.redact(typeof text === 'string' ? text : '').trim()
    if (!redacted) return ''
    if (redacted.length <= config.autoMemoryMaxChars) return redacted
    return `${redacted.slice(0, config.autoMemoryMaxChars)}…[truncated]`
  }

  function buildPayload(sessionId, role, seq, text) {
    const roleTag = role === 'assistant' ? 'DSH助手消息' : 'DSH用户消息'
    const payload = {
      title: deriveTitle(text),
      body: text,
      memory_type: config.autoMemoryMemoryType || 'episodic',
      source: {
        type: 'agent',
        ref: CLIENT_ID,
        note: `自动记忆：DSH 会话 ${String(sessionId).slice(0, 8)} 的${role === 'assistant' ? '助手' : '用户'}消息（seq=${seq}）`,
      },
      importance: deriveImportance(text),
      tags: tags.concat(roleTag),
      origin: 'agent',
    }
    return payload
  }

  return {
    get enabled() {
      return enabled && !disposed
    },
    mode,

    /**
     * Feed one committed session event. Never throws.
     * @param session - the Session whose log grew (needs `.id`).
     * @param event - the committed SessionEvent (needs `.type`, `.seq`).
     */
    handle(session, event) {
      try {
        if (!enabled || disposed) return
        const role = ROLE_BY_EVENT[event && event.type]
        if (!role) return
        if (role === 'assistant' && mode !== 'all') return
        const sessionId = session && typeof session.id === 'string' ? session.id : null
        if (!sessionId) return
        counters.seen += 1

        const data = isObject(event.data) ? event.data : {}
        // For user-role messages only real user-authored text is captured. The
        // Host injects many other user-role messages (runtime context, skill
        // catalog, time context, background-job notices, agent relays, approval
        // notices…); their `source.kind` is never plain `user` and they must not
        // become memories.
        const source = isObject(data.source) ? data.source : null
        if (role === 'user' && (!source || source.kind !== 'user')) {
          counters.skippedNonText += 1
          return
        }
        const content = role === 'user' ? data.content : isObject(data.message) ? data.message.content : undefined
        const raw = textOfContent(content)
        if (!raw.trim()) {
          counters.skippedNonText += 1
          return
        }
        // Slash commands are Host UI actions, not conversation content.
        if (/^\/\S/.test(raw.trim())) {
          counters.skippedNonText += 1
          return
        }
        const text = sanitize(raw)
        if (text.length < config.autoMemoryMinChars) {
          counters.skippedShort += 1
          return
        }

        const seq = typeof event.seq === 'number' ? event.seq : 0
        const key = `${sessionId}:${seq}:${role}`
        if (seenKeys.has(key)) {
          counters.skippedDuplicate += 1
          return
        }
        remember(key)
        if (textRecentlySeen(hashText(text))) {
          counters.skippedDuplicate += 1
          return
        }
        if (rateLimited()) {
          counters.skippedRate += 1
          noteError('AUTO_MEMORY_RATE_LIMIT', `auto memory exceeded ${config.autoMemoryMaxPerHour} entries/hour`)
          return
        }

        const payload = buildPayload(sessionId, role, seq, text)
        if (queue.length >= config.eventQueueLimit) {
          queue.shift()
          counters.dropped += 1
          noteError('AUTO_MEMORY_QUEUE_OVERFLOW', `auto memory queue exceeded ${config.eventQueueLimit}`)
        }
        queue.push({ payload, attempts: 0 })
        counters.captured += 1
        if (state.connected) scheduleFlush(0)
        logger.debug('auto memory queued', { role, chars: text.length, queued: queue.length })
      } catch (error) {
        noteError('AUTO_MEMORY_ERROR', error && error.message)
        logger.debug('auto memory handler failed', { message: error && error.message })
      }
    },

    /** Force one delivery cycle (used on reconnect / fca_status). */
    async flushNow() {
      await flush()
    },

    /** Snapshot for `fca_status`. */
    stats() {
      return {
        mode,
        enabled: enabled && !disposed,
        memoryType: config.autoMemoryMemoryType,
        tags,
        queued: queue.length,
        limits: {
          minChars: config.autoMemoryMinChars,
          maxChars: config.autoMemoryMaxChars,
          maxPerHour: config.autoMemoryMaxPerHour,
        },
        counters: { ...counters },
        lastError: lastError ? { ...lastError } : null,
      }
    },

    /** Stop timers; queued payloads are kept in memory only. */
    dispose() {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      if (flushTimer) clearTimeout(flushTimer)
      retryTimer = null
      flushTimer = null
      queue.length = 0
      seenKeys.clear()
      recentTexts.clear()
      timestamps.length = 0
    },
  }
}
