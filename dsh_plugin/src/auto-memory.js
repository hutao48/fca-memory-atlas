/**
 * Automatic memory capture ("完全自动添加记忆").
 *
 * Subscribes to the same `session/event` feed as the audit capture, but instead
 * of posting audit events it turns selected session content into real memory
 * records through `POST /api/v1/memory/store`.
 *
 * Two layers (v0.2):
 *
 * 1) Message memories — real user-authored text (and, in `autoMemory: all`,
 *    assistant text). Host-injected user-role messages are never stored.
 * 2) Agent turn nodes — at `turn/end`, one aggregated `procedural` memory that
 *    records the agent's own process for that turn: key reasoning, tool calls
 *    (name + redacted/truncated arguments) and tool results (status + summary),
 *    plus the conclusion. This is user-selected "更全" coverage.
 *
 * Both layers attribute every memory to the DSH workspace: a `workspace:<label>`
 * tag (nebula spiral arm), the full cwd in `source.note`, and (when the label is
 * known) a `project` entity named `<label> 工作区`.
 *
 * Design rules (aligned with the FCA contract / product principles):
 * - Everything is redacted with the same redactor as the audit flow, length
 *   capped and sent only to the local Runtime (127.0.0.1). Nothing leaves the
 *   machine.
 * - Every derived memory is versioned and traceable: source.ref = dsh-plugin,
 *   source.note records the DSH session id + seq/role or session + turn.
 * - Global: the plugin listens at the Host root, so messages from every DSH
 *   session (including subagent sessions) are captured while the plugin is loaded.
 * - Bounded: per-hour rate limits, turn-buffer caps, text budgets, queue cap and
 *   retry limit; a Runtime outage never grows memory without bound and never
 *   surfaces as a DSH error.
 *
 * @module dsh-plugin-fca-memory/src/auto-memory
 */

import { createHash } from 'node:crypto'
import { CLIENT_ID } from './config.js'
import { describeSessionScope } from './session-scope.js'
import {
  AGENT_NODE_MEMORY_TYPE,
  AGENT_NODE_TITLE_PREFIX,
  buildAgentMemoryPayload,
  messageContentParts,
  reasoningBudget,
  sanitizeSegment,
  summarizeToolArguments,
  summarizeToolResult,
} from './agent-nodes.js'
import { resolveWorkspace, truncateCwd, workspaceProjectName, workspaceTagName } from './workspace.js'

/** Event roles this module understands and their extraction rules. */
const ROLE_BY_EVENT = {
  'user/message': 'user',
  'assistant/message': 'assistant',
}

/** Event types consumed by the agent turn-node buffer (independent of roles). */
const AGENT_EVENT_TYPES = new Set(['turn/start', 'assistant/message', 'tool/call', 'tool/result', 'turn/end'])

/** Tag attached to every aggregated agent node memory (task spec). */
export const AGENT_NODE_TAG = 'Agent思考节点'

/** Tag attached to every aggregated agent node memory (task spec). */
export const AGENT_SESSION_TAG = 'DSH会话'

const RETRY_LIMIT = 3
const RETRY_BASE_MS = 2000
const SEEN_LIMIT = 2000
const HOUR_MS = 60 * 60 * 1000
/** Maximum number of concurrently buffered (session, turn) pairs. */
const AGENT_TURN_LIMIT = 32
/** Maximum number of remembered finished turns (session + turn de-duplication). */
const AGENT_DONE_LIMIT = 2000
/** Maximum number of cached per-session workspaces. */
const WORKSPACE_CACHE_LIMIT = 200
/** Maximum number of cached per-session scopes (root human vs. child/subagent). */
const SCOPE_CACHE_LIMIT = 200
/** Maximum number of distinct workspace labels kept in `fca_status`. */
const WORKSPACE_LABEL_LIMIT = 20

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

/** Trim, drop empties and de-duplicate tag names (order preserved, max 16). */
function normalizeTags(list) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'string') continue
    const tag = item.trim()
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
    if (out.length >= 16) break
  }
  return out
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
 * @param options.proc - process-like object providing `cwd()` (injectable in tests).
 */
export function createAutoMemory({ config, logger, client, redactor, state, proc }) {
  const mode = config.autoMemory || 'off'
  const enabled = mode !== 'off'
  const tags = Array.isArray(config.autoMemoryTags) ? config.autoMemoryTags.slice(0, 16) : ['DSH自动记忆']
  const agentMode = config.autoMemoryAgentNodes || 'off'
  const agentEnabled = enabled && agentMode !== 'off'
  const processLike = proc && typeof proc === 'object' ? proc : process
  const limits = {
    reasoningChars: config.autoMemoryAgentReasoningChars,
    conclusionChars: config.autoMemoryAgentConclusionChars,
    toolArgChars: config.autoMemoryAgentToolArgChars,
    toolResultChars: config.autoMemoryAgentToolResultChars,
    maxChars: config.autoMemoryAgentMaxChars,
    maxToolNodes: config.autoMemoryAgentMaxToolNodes,
  }
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
    skippedChildSession: 0,
  }
  const agentCounters = {
    eventsSeen: 0,
    turnsSeen: 0,
    captured: 0,
    stored: 0,
    failed: 0,
    dropped: 0,
    skippedEmpty: 0,
    skippedDuplicate: 0,
    skippedRate: 0,
    toolCallsSeen: 0,
    toolResultsSeen: 0,
  }
  const queue = []
  const seenKeys = new Map()
  const recentTexts = new Map()
  const timestamps = []
  const agentTimestamps = []
  /** Finished turns, keyed `sessionId:turn` (de-duplication). */
  const doneAgentTurns = new Map()
  /** Buffered in-progress turns, keyed `sessionId:turn`. */
  const agentTurns = new Map()
  /** Per-session workspace cache (SessionHeader.cwd is immutable). */
  const workspaceCache = new Map()
  /** Per-session scope cache (SessionHeader lineage is immutable). */
  const scopeCache = new Map()
  /** label → { label, cwd, lastAt } for `fca_status`. */
  const workspaceLabels = new Map()
  let lastWorkspace = null
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

  function rateLimited(bucket, list, limit, code, label) {
    const cutoff = Date.now() - HOUR_MS
    while (list.length > 0 && list[0] < cutoff) list.shift()
    if (list.length >= limit) {
      noteError(code, `${label} exceeded ${limit} entries/hour`)
      return true
    }
    list.push(Date.now())
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
          if (item.kind === 'agent') agentCounters.stored += 1
          continue
        }
        item.attempts += 1
        counters.failed += 1
        if (item.kind === 'agent') agentCounters.failed += 1
        noteError(response.code || 'MEMORY_REJECTED', response.message)
        if (item.attempts >= RETRY_LIMIT) {
          queue.shift()
          counters.dropped += 1
          if (item.kind === 'agent') agentCounters.dropped += 1
          logger.warn('dropping undeliverable auto memory', {
            kind: item.kind || 'message',
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

  /** Resolve (and cache) the workspace of one session. Never throws. */
  function workspaceFor(sessionId, session) {
    const cached = workspaceCache.get(sessionId)
    if (cached) {
      lastWorkspace = cached
      return cached
    }
    let workspace
    try {
      workspace = resolveWorkspace(session, { proc: processLike })
    } catch {
      workspace = { cwd: '', label: 'default', source: 'none' }
    }
    const record = { label: workspace.label, cwd: workspace.cwd, source: workspace.source }
    workspaceCache.set(sessionId, record)
    if (workspaceCache.size > WORKSPACE_CACHE_LIMIT) {
      const oldest = workspaceCache.keys().next().value
      if (oldest !== undefined) workspaceCache.delete(oldest)
    }
    const known = workspaceLabels.get(record.label) || { label: record.label, cwd: record.cwd, lastAt: 0 }
    known.cwd = record.cwd || known.cwd
    known.lastAt = Date.now()
    workspaceLabels.set(record.label, known)
    if (workspaceLabels.size > WORKSPACE_LABEL_LIMIT) {
      workspaceLabels.delete(workspaceLabels.keys().next().value)
    }
    lastWorkspace = record
    return record
  }

  /**
   * Resolve (and cache) the scope of one session: root human conversation vs.
   * spawned child (subagent/teammate). Only user-message memories are gated by
   * this; Agent 思考节点 keeps capturing child sessions too.
   */
  function scopeFor(sessionId, session) {
    const cached = scopeCache.get(sessionId)
    if (cached) return cached
    let scope
    try {
      scope = describeSessionScope(session)
    } catch {
      scope = { kind: 'root', reason: 'root', parentSession: '', origin: '', delegationDepth: null }
    }
    scopeCache.set(sessionId, scope)
    if (scopeCache.size > SCOPE_CACHE_LIMIT) {
      const oldest = scopeCache.keys().next().value
      if (oldest !== undefined) scopeCache.delete(oldest)
    }
    return scope
  }

  function enqueue(payload, kind) {
    if (queue.length >= config.eventQueueLimit) {
      queue.shift()
      counters.dropped += 1
      if (kind === 'agent') agentCounters.dropped += 1
      noteError('AUTO_MEMORY_QUEUE_OVERFLOW', `auto memory queue exceeded ${config.eventQueueLimit}`)
    }
    queue.push({ payload, attempts: 0, kind })
  }

  function buildMessagePayload(sessionId, role, seq, text, workspace) {
    const roleTag = role === 'assistant' ? 'DSH助手消息' : 'DSH用户消息'
    const workspaceTag = workspaceTagName(workspace.label)
    const payload = {
      title: deriveTitle(text),
      body: text,
      memory_type: config.autoMemoryMemoryType || 'episodic',
      source: {
        type: 'agent',
        ref: CLIENT_ID,
        note: `自动记忆：DSH 会话 ${String(sessionId).slice(0, 8)} 的${role === 'assistant' ? '助手' : '用户'}消息（seq=${seq}，工作区 ${workspace.label}：${truncateCwd(workspace.cwd)}）`,
      },
      importance: deriveImportance(text),
      tags: normalizeTags(tags.concat(roleTag, workspaceTag)),
      origin: 'agent',
    }
    const project = workspaceProjectName(workspace.label)
    if (project) payload.project = { name: project }
    return payload
  }

  // ------------------------------------------------------- agent turn nodes

  function agentTurnKey(sessionId, turn) {
    return `${sessionId}:${turn}`
  }

  function turnNumberOf(data) {
    return Number.isInteger(data.turn) && data.turn > 0 ? data.turn : null
  }

  function ensureAgentTurn(sessionId, turn, workspace) {
    const key = agentTurnKey(sessionId, turn)
    let buffer = agentTurns.get(key)
    if (buffer) return buffer
    while (agentTurns.size >= AGENT_TURN_LIMIT) {
      const oldest = agentTurns.keys().next().value
      if (oldest === undefined) break
      agentTurns.delete(oldest)
    }
    buffer = {
      key,
      sessionId,
      turn,
      workspace: workspace || { label: 'default', cwd: '', source: 'none' },
      reasoning: '',
      reasoningChars: 0,
      conclusion: '',
      tools: [],
      toolIndex: new Map(),
    }
    agentTurns.set(key, buffer)
    return buffer
  }

  function latestAgentTurn(sessionId) {
    let found = null
    for (const buffer of agentTurns.values()) {
      if (buffer.sessionId === sessionId) found = buffer
    }
    return found
  }

  function appendReasoning(buffer, reasoning) {
    const budget = reasoningBudget(limits.reasoningChars)
    if (buffer.reasoningChars >= budget) return
    const remaining = budget - buffer.reasoningChars
    const chunk = reasoning.length > remaining ? reasoning.slice(0, remaining) : reasoning
    if (!chunk) return
    buffer.reasoning = buffer.reasoning ? `${buffer.reasoning}\n${chunk}` : chunk
    buffer.reasoningChars += chunk.length
  }

  function rememberDoneTurn(key) {
    doneAgentTurns.set(key, Date.now())
    if (doneAgentTurns.size > AGENT_DONE_LIMIT) doneAgentTurns.delete(doneAgentTurns.keys().next().value)
  }

  function handleAgentEvent(sessionId, event, workspace) {
    const type = event.type
    const data = isObject(event.data) ? event.data : {}
    const turn = turnNumberOf(data)

    if (type === 'turn/start') {
      if (turn === null) return
      ensureAgentTurn(sessionId, turn, workspace)
      return
    }

    if (type === 'assistant/message') {
      const buffer = ensureAgentTurn(sessionId, turn === null ? 1 : turn, workspace)
      const message = isObject(data.message) ? data.message : {}
      const parts = messageContentParts(message.content)
      // Redact/truncate before buffering: a secret must never be kept in memory
      // (or partially truncated) even if this turn is later dropped.
      if (parts.reasoning) appendReasoning(buffer, sanitizeSegment(parts.reasoning, redactor.redact, reasoningBudget(limits.reasoningChars)))
      // 结论 = the *last* assistant visible text of the turn.
      if (parts.text) buffer.conclusion = sanitizeSegment(parts.text, redactor.redact, limits.conclusionChars)
      return
    }

    if (type === 'tool/call') {
      const buffer = ensureAgentTurn(sessionId, turn === null ? 1 : turn, workspace)
      const callId = typeof data.callId === 'string' ? data.callId : ''
      const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : '未知工具'
      const args = summarizeToolArguments(data.arguments, { redact: redactor.redact, maxChars: limits.toolArgChars })
      const node = { callId, name, args, result: '', isError: false, hasResult: false }
      buffer.tools.push(node)
      if (callId) buffer.toolIndex.set(callId, node)
      agentCounters.toolCallsSeen += 1
      return
    }

    if (type === 'tool/result') {
      const message = isObject(data.message) ? data.message : null
      const summary = summarizeToolResult(message, { redact: redactor.redact, maxChars: limits.toolResultChars })
      agentCounters.toolResultsSeen += 1
      const buffer = turn !== null ? agentTurns.get(agentTurnKey(sessionId, turn)) : latestAgentTurn(sessionId)
      if (!buffer) return
      let node = summary.callId ? buffer.toolIndex.get(summary.callId) : null
      if (!node) {
        node = { callId: summary.callId, name: '工具结果', args: '', result: '', isError: false, hasResult: false }
        buffer.tools.push(node)
      }
      node.result = summary.summary
      node.isError = summary.isError
      node.hasResult = true
      return
    }

    if (type === 'turn/end') {
      const buffer = turn !== null ? agentTurns.get(agentTurnKey(sessionId, turn)) : latestAgentTurn(sessionId)
      if (!buffer) return
      agentTurns.delete(buffer.key)
      agentCounters.turnsSeen += 1
      finalizeAgentTurn(buffer, workspace)
    }
  }

  function finalizeAgentTurn(buffer, resolvedWorkspace) {
    const hasContent = Boolean(buffer.reasoning.trim() || buffer.conclusion.trim()) || buffer.tools.length > 0
    if (!hasContent) {
      agentCounters.skippedEmpty += 1
      return
    }
    if (doneAgentTurns.has(buffer.key)) {
      agentCounters.skippedDuplicate += 1
      return
    }
    const workspace =
      resolvedWorkspace && resolvedWorkspace.label ? resolvedWorkspace : buffer.workspace
    const workspaceTag = workspaceTagName(workspace.label)
    const agentTags = normalizeTags([AGENT_NODE_TAG, workspaceTag, AGENT_SESSION_TAG])
    const payload = buildAgentMemoryPayload({
      sessionId: buffer.sessionId,
      turn: buffer.turn,
      workspace,
      reasoning: buffer.reasoning,
      toolNodes: buffer.tools,
      totalToolCalls: buffer.tools.length,
      conclusion: buffer.conclusion,
      tags: agentTags,
      limits,
      sourceRef: CLIENT_ID,
      project: workspaceProjectName(workspace.label),
    })
    // Sanity: never enqueue an empty aggregate (formatting always fills the
    // three sections, but a turn with only whitespace must not become a memory).
    if (!payload.body.trim()) {
      agentCounters.skippedEmpty += 1
      return
    }
    if (rateLimited('agent', agentTimestamps, config.autoMemoryAgentMaxPerHour, 'AUTO_MEMORY_AGENT_RATE_LIMIT', 'agent node memory')) {
      agentCounters.skippedRate += 1
      return
    }
    rememberDoneTurn(buffer.key)
    enqueue(payload, 'agent')
    agentCounters.captured += 1
    if (state.connected) scheduleFlush(0)
    logger.debug('agent turn node queued', {
      session: buffer.sessionId.slice(0, 8),
      turn: buffer.turn,
      tools: buffer.tools.length,
      chars: payload.body.length,
      queued: queue.length,
    })
  }

  return {
    get enabled() {
      return enabled && !disposed
    },
    get agentEnabled() {
      return agentEnabled && !disposed
    },
    mode,
    agentMode,

    /**
     * Feed one committed session event. Never throws.
     * @param session - the Session whose log grew (needs `.id` / `.header.cwd`).
     * @param event - the committed SessionEvent (needs `.type`, `.seq`).
     */
    handle(session, event) {
      try {
        if (!enabled || disposed) return
        const type = event && event.type
        if (!type) return
        const sessionId = session && typeof session.id === 'string' ? session.id : null
        if (!sessionId) return
        const workspace = workspaceFor(sessionId, session)

        if (agentEnabled && AGENT_EVENT_TYPES.has(type)) {
          agentCounters.eventsSeen += 1
          handleAgentEvent(sessionId, event, workspace)
          // assistant/message may also be a message memory in `all` mode.
          if (type !== 'assistant/message') return
        }

        const role = ROLE_BY_EVENT[type]
        if (!role) return
        if (role === 'assistant' && mode !== 'all') return
        counters.seen += 1

        // v0.2.1: user-message memories are only captured for the human root
        // conversation. Spawned subagent/teammate sessions deliver their spawn
        // prompt (and delegated team instructions) as `user/message` with
        // `source.kind === "user"`; those must not become memories. Agent turn
        // nodes (above) still cover child sessions.
        if (role === 'user') {
          const scope = scopeFor(sessionId, session)
          if (scope.kind === 'child') {
            counters.skippedChildSession += 1
            logger.debug('auto memory skipped child-session user message', {
              session: sessionId.slice(0, 8),
              reason: scope.reason,
            })
            return
          }
        }

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
        if (textRecentlySeen(hashText(sanitizeSegment(raw, redactor.redact, config.autoMemoryMaxChars)))) {
          counters.skippedDuplicate += 1
          return
        }
        if (rateLimited('message', timestamps, config.autoMemoryMaxPerHour, 'AUTO_MEMORY_RATE_LIMIT', 'auto memory')) {
          counters.skippedRate += 1
          return
        }

        const payload = buildMessagePayload(sessionId, role, seq, text, workspace)
        enqueue(payload, 'message')
        counters.captured += 1
        if (state.connected) scheduleFlush(0)
        logger.debug('auto memory queued', {
          role,
          chars: text.length,
          workspace: workspace.label,
          queued: queue.length,
        })
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
      const known = Array.from(workspaceLabels.values())
        .sort((left, right) => right.lastAt - left.lastAt)
        .map((item) => ({ label: item.label, cwd: item.cwd, last_at: item.lastAt ? new Date(item.lastAt).toISOString() : null }))
      let rootSessions = 0
      let childSessions = 0
      for (const scope of scopeCache.values()) {
        if (scope.kind === 'child') childSessions += 1
        else rootSessions += 1
      }
      return {
        mode,
        enabled: enabled && !disposed,
        memoryType: config.autoMemoryMemoryType,
        tags,
        workspace: {
          last: lastWorkspace ? { ...lastWorkspace } : null,
          known,
        },
        sessions: {
          root: rootSessions,
          child: childSessions,
          policy: 'user-messages: root human session only; agent nodes: every session',
        },
        agentNodes: {
          mode: agentMode,
          enabled: agentEnabled && !disposed,
          tag: AGENT_NODE_TAG,
          memoryType: AGENT_NODE_MEMORY_TYPE,
          title: `${AGENT_NODE_TITLE_PREFIX} · 第 N 回合`,
          activeTurns: agentTurns.size,
          limits: {
            maxToolNodes: limits.maxToolNodes,
            maxPerHour: config.autoMemoryAgentMaxPerHour,
            reasoningChars: limits.reasoningChars,
            conclusionChars: limits.conclusionChars,
            toolArgChars: limits.toolArgChars,
            toolResultChars: limits.toolResultChars,
            maxChars: limits.maxChars,
          },
          counters: { ...agentCounters },
        },
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
      agentTimestamps.length = 0
      doneAgentTurns.clear()
      agentTurns.clear()
      workspaceCache.clear()
      scopeCache.clear()
      workspaceLabels.clear()
      lastWorkspace = null
    },
  }
}
