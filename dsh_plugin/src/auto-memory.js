/**
 * Automatic memory capture ("完全自动添加记忆") — v0.3.
 *
 * Subscribes to the same `session/event` feed as the audit capture, but turns
 * selected session content into real memory records through
 * `POST /api/v1/memory/store`.
 *
 * Three layers:
 *
 * 1) Message memories — real user-authored text of the **human root session**
 *    (and, in `autoMemory: all`, assistant text). Host-injected messages and
 *    child-session spawn prompts never become standalone message memories.
 * 2) Agent turn nodes — root sessions only: one aggregated `procedural` memory
 *    per turn (reasoning + tool calls/results + conclusion). When the turn
 *    spawned child sessions, the memory gets one `children:<childId8>` tag per
 *    child and is linked to those child memories through Runtime relations.
 * 3) Child/subagent session memories (v0.3) — every child session turn becomes
 *    ONE aggregated `episodic` memory with `Agent子会话` /
 *    `subagent-session:<childId8>` / `parent-session:<parentId8>` tags and the
 *    task / reasoning / tools / result / conclusion body. The parent turn's
 *    agent-node memory is linked to it (`/api/v1/relations`, `custom` with
 *    `label:"spawned_subagent"`) and the child memory gets a
 *    `parent-memory:<parentMemoryId>` fallback tag via PATCH.
 *
 * Every derived memory carries `occurred_at` (ISO) + `occurred_precision:"exact"`
 * (v0.3): the real event time of the message / turn start / child spawn prompt.
 *
 * Context recovery: compaction events (`compaction/start|prune|summary|end`) are
 * observed per session; a compaction ends by flagging the session "needs
 * recovery", which the prompt-context module renders as a recovery instruction
 * until the agent calls `fca_memory_context` (observed through its `tool/call`).
 *
 * Design rules (FCA contract / product principles):
 * - Redact everything with the same redactor, length-cap and send only to the
 *   local Runtime (127.0.0.1).
 * - Every derived memory is versioned and traceable via source.ref/source.note.
 * - Bounded: per-layer hourly limits, buffer caps, body caps, queue cap,
 *   relation waiters cap; a Runtime outage never grows memory without bound and
 *   never surfaces as a DSH error.
 *
 * @module dsh-plugin-fca-memory/src/auto-memory
 */

import { createHash } from 'node:crypto'
import { CLIENT_ID } from './config.js'
import { describeSessionScope, sessionId8 } from './session-scope.js'
import {
  AGENT_NODE_MEMORY_TYPE,
  AGENT_NODE_TITLE_PREFIX,
  buildAgentMemoryPayload,
  buildSubagentSessionPayload,
  messageContentParts,
  normalizeChildren,
  reasoningBudget,
  sanitizeSegment,
  SUBAGENT_SESSION_TAG,
  summarizeToolArguments,
  summarizeToolResult,
} from './agent-nodes.js'
import { occurredAtOf } from './time.js'
import { resolveWorkspace, truncateCwd, workspaceProjectName, workspaceTagName } from './workspace.js'

/** Event roles this module understands and their extraction rules. */
const ROLE_BY_EVENT = {
  'user/message': 'user',
  'assistant/message': 'assistant',
}

/** Turn events consumed by both the root agent buffer and child buffers. */
const TURN_EVENT_TYPES = new Set(['turn/start', 'assistant/message', 'tool/call', 'tool/result', 'turn/end'])

/** Child-session events: the turn lifecycle plus the spawn-prompt user message. */
const SUBAGENT_EVENT_TYPES = new Set([...TURN_EVENT_TYPES, 'user/message'])

/** Compaction events (real DSH session format v4: start/prune/summary/end). */
const COMPACTION_EVENT_TYPES = new Set(['compaction/start', 'compaction/prune', 'compaction/summary', 'compaction/end'])

/** Parent-session event that announces a spawned child session. */
const SUBAGENT_CATALOG_EVENT = 'subagent/catalog'

/** Tag attached to every aggregated agent turn node memory. */
export const AGENT_NODE_TAG = 'Agent思考节点'

/** Tag attached to every aggregated child-session memory. */
export const SUBAGENT_TAG = SUBAGENT_SESSION_TAG

/** Tag attached to every auto memory that belongs to a DSH session. */
export const AGENT_SESSION_TAG = 'DSH会话'

/** Tool name whose invocation means "the agent re-read its memories". */
export const RECOVERY_TOOL_NAME = 'fca_memory_context'

/** Runtime relation contract used for parent → child links (Lead-confirmed). */
export const SPAWN_RELATION_TYPE = 'custom'
export const SPAWN_RELATION_LABEL = 'spawned_subagent'
export const SPAWN_RELATION_FALLBACK_TYPE = 'derived_from'

const RETRY_LIMIT = 3
const RETRY_BASE_MS = 2000
const SEEN_LIMIT = 2000
const HOUR_MS = 60 * 60 * 1000
/** Maximum number of concurrently buffered (session, turn) pairs. */
const TURN_BUFFER_LIMIT = 32
/** Maximum number of remembered finished turns (session + turn de-duplication). */
const DONE_TURN_LIMIT = 2000
/** Maximum number of cached per-session workspaces/scopes. */
const SESSION_CACHE_LIMIT = 200
/** Maximum number of distinct workspace labels kept in `fca_status`. */
const WORKSPACE_LABEL_LIMIT = 20
/** Maximum number of open-turn entries and parent→children maps. */
const OPEN_TURN_LIMIT = 200
const CHILDREN_MAP_LIMIT = 200
/** Maximum waiters for a parent memory whose child memories are not stored yet. */
const RELATION_WAITER_LIMIT = 200
/** Maximum remembered relation pairs. */
const RELATION_PAIR_LIMIT = 2000
/** Maximum remembered child memories per child session. */
const CHILD_MEMORY_LIMIT = 8
/** Maximum remembered compacted sessions. */
const COMPACTION_SESSION_LIMIT = 200

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
    if (out.length >= 20) break
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

/** Epoch-ms of a committed SessionEvent (0 when absent). */
function eventEpoch(event) {
  return event && typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : 0
}

/**
 * Create the automatic memory writer.
 * @param options.config - normalized configuration.
 * @param options.logger - plugin logger.
 * @param options.client - Runtime client (`client.storeMemory`, `createRelation`, `patchMemory`, `getMemory`).
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
  const subagentMode = config.autoMemorySubagentCapture || 'off'
  const subagentEnabled = enabled && subagentMode !== 'off'
  const recoveryEnabled = Boolean(config.autoMemoryContextRecovery)
  const processLike = proc && typeof proc === 'object' ? proc : process
  const agentLimits = {
    reasoningChars: config.autoMemoryAgentReasoningChars,
    conclusionChars: config.autoMemoryAgentConclusionChars,
    toolArgChars: config.autoMemoryAgentToolArgChars,
    toolResultChars: config.autoMemoryAgentToolResultChars,
    maxChars: config.autoMemoryAgentMaxChars,
    maxToolNodes: config.autoMemoryAgentMaxToolNodes,
  }
  const subagentLimits = {
    taskChars: config.autoMemorySubagentTaskChars,
    reasoningChars: config.autoMemorySubagentReasoningChars,
    conclusionChars: config.autoMemorySubagentConclusionChars,
    resultChars: config.autoMemorySubagentResultChars,
    toolArgChars: config.autoMemorySubagentToolArgChars,
    toolResultChars: config.autoMemorySubagentToolResultChars,
    maxChars: config.autoMemorySubagentMaxChars,
    maxToolNodes: config.autoMemorySubagentMaxToolNodes,
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
    childrenTagged: 0,
  }
  const subagentCounters = {
    eventsSeen: 0,
    turnsSeen: 0,
    captured: 0,
    stored: 0,
    failed: 0,
    dropped: 0,
    skippedEmpty: 0,
    skippedDuplicate: 0,
    skippedRate: 0,
    spawnPromptsSeen: 0,
    toolCallsSeen: 0,
    toolResultsSeen: 0,
    childrenTagged: 0,
    idNormalizeFailed: 0,
  }
  const relationCounters = {
    attempted: 0,
    created: 0,
    failed: 0,
    fallbackType: 0,
    pendingWaiters: 0,
    tagPatchAttempted: 0,
    tagPatched: 0,
    tagPatchFailed: 0,
    idNormalizeFailed: 0,
  }
  const compactionCounters = {
    eventsSeen: 0,
    prunes: 0,
    started: 0,
    finished: 0,
    sessions: 0,
    lastAt: null,
  }
  const recoveryCounters = {
    enabled: recoveryEnabled,
    sessionsMarked: 0,
    clearedByTool: 0,
    renders: 0,
  }
  const queue = []
  const seenKeys = new Map()
  const recentTexts = new Map()
  const messageTimestamps = []
  const agentTimestamps = []
  const subagentTimestamps = []
  /** Root-session agent turn buffers, keyed `sessionId:turn`. */
  const agentTurns = new Map()
  /** Child-session buffers, keyed `sessionId:turn`. */
  const subagentTurns = new Map()
  /** Finished turns, keyed `sessionId:turn`. */
  const doneAgentTurns = new Map()
  const doneSubagentTurns = new Map()
  /** Current open turn per session (parent → child association). */
  const openTurns = new Map()
  /** Parent children, keyed `parentSessionId:turn` → Set<childSessionId>. */
  const childrenByParentTurn = new Map()
  /** Last observed turn per session (fallback when a turn/open is missed). */
  const lastTurnBySession = new Map()
  /** Stored child memories, childSessionId → [{id, version, tags}] (newest last). */
  const childMemories = new Map()
  /** Relation waiters: parent memory stored before its child memories. */
  const relationWaiters = []
  /** Linked parent memory → child memory pairs (idempotency). */
  const linkedPairs = new Set()
  /** Per-session workspace / scope caches. */
  const workspaceCache = new Map()
  const scopeCache = new Map()
  const workspaceLabels = new Map()
  /** Compaction state per session. */
  const compactionBySession = new Map()
  let lastWorkspace = null
  let lastError = null
  let lastRelationError = null
  let flushing = false
  let disposed = false
  let retryTimer = null
  let flushTimer = null

  function noteError(code, message) {
    lastError = { at: new Date().toISOString(), code: code || 'UNKNOWN', message: String(message || '') }
  }

  function noteRelationError(code, message) {
    lastRelationError = { at: new Date().toISOString(), code: code || 'RELATION_ERROR', message: String(message || '') }
  }

  function remember(map, key, value, limit = SEEN_LIMIT) {
    map.set(key, value)
    if (map.size > limit) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
  }

  function textRecentlySeen(hash) {
    const at = recentTexts.get(hash)
    if (at && Date.now() - at < HOUR_MS) return true
    recentTexts.set(hash, Date.now())
    if (recentTexts.size > SEEN_LIMIT) recentTexts.delete(recentTexts.keys().next().value)
    return false
  }

  function rateLimited(list, limit, code, label) {
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
          else if (item.kind === 'subagent') subagentCounters.stored += 1
          if (typeof item.onStored === 'function') {
            const memory = response.data && isObject(response.data) ? response.data.memory ?? response.data : null
            try {
              await item.onStored(memory)
            } catch (error) {
              noteRelationError('ON_STORED_FAILED', error && error.message)
            }
          }
          continue
        }
        item.attempts += 1
        counters.failed += 1
        if (item.kind === 'agent') agentCounters.failed += 1
        else if (item.kind === 'subagent') subagentCounters.failed += 1
        noteError(response.code || 'MEMORY_REJECTED', response.message)
        if (item.attempts >= RETRY_LIMIT) {
          queue.shift()
          counters.dropped += 1
          if (item.kind === 'agent') agentCounters.dropped += 1
          else if (item.kind === 'subagent') subagentCounters.dropped += 1
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
  function sanitize(text, maxChars = config.autoMemoryMaxChars) {
    const redacted = redactor.redact(typeof text === 'string' ? text : '').trim()
    if (!redacted) return ''
    const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : config.autoMemoryMaxChars
    if (redacted.length <= limit) return redacted
    return `${redacted.slice(0, limit)}…[truncated]`
  }

  // ------------------------------------------------------------- workspaces

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
    remember(workspaceCache, sessionId, record, SESSION_CACHE_LIMIT)
    const known = workspaceLabels.get(record.label) || { label: record.label, cwd: record.cwd, lastAt: 0 }
    known.cwd = record.cwd || known.cwd
    known.lastAt = Date.now()
    remember(workspaceLabels, record.label, known, WORKSPACE_LABEL_LIMIT)
    lastWorkspace = record
    return record
  }

  /** Resolve (and cache) the scope of one session: root human vs. child. */
  function scopeFor(sessionId, session) {
    const cached = scopeCache.get(sessionId)
    if (cached) return cached
    let scope
    try {
      scope = describeSessionScope(session)
    } catch {
      scope = { kind: 'root', reason: 'root', parentSession: '', origin: '', delegationDepth: null }
    }
    remember(scopeCache, sessionId, scope, SESSION_CACHE_LIMIT)
    return scope
  }

  /** Workspace label of one known session ('' when unknown). */
  function workspaceLabelFor(sessionId) {
    const cached = workspaceCache.get(sessionId)
    return cached ? cached.label : ''
  }

  // ----------------------------------------------------------- turn tracking

  function openTurnOf(sessionId) {
    const entry = openTurns.get(sessionId)
    if (entry) return entry.turn
    return null
  }

  function setOpenTurn(sessionId, turn, time) {
    const next = { turn, startedAt: Number.isFinite(time) ? time : 0 }
    remember(openTurns, sessionId, next, OPEN_TURN_LIMIT)
    lastTurnBySession.set(sessionId, next)
    if (lastTurnBySession.size > OPEN_TURN_LIMIT) {
      const oldest = lastTurnBySession.keys().next().value
      if (oldest !== undefined) lastTurnBySession.delete(oldest)
    }
  }

  function closeOpenTurn(sessionId) {
    openTurns.delete(sessionId)
  }

  function lastTurnOf(sessionId) {
    const open = openTurns.get(sessionId)
    if (open) return open.turn
    const last = lastTurnBySession.get(sessionId)
    return last ? last.turn : null
  }

  /** Register one spawned child under the parent session's current turn. */
  function registerChildSpawn(parentSessionId, childSessionId, time) {
    if (!parentSessionId || !childSessionId) return
    if (!sessionId8(childSessionId)) {
      relationCounters.idNormalizeFailed += 1
      return
    }
    const turn = openTurnOf(parentSessionId) ?? lastTurnOf(parentSessionId)
    if (!Number.isInteger(turn) || turn <= 0) return
    const key = `${parentSessionId}:${turn}`
    let set = childrenByParentTurn.get(key)
    if (!set) {
      set = new Set()
      childrenByParentTurn.set(key, set)
      if (childrenByParentTurn.size > CHILDREN_MAP_LIMIT) {
        childrenByParentTurn.delete(childrenByParentTurn.keys().next().value)
      }
    }
    set.add(childSessionId)
    logger.debug('auto memory registered child spawn', {
      parent: parentSessionId.slice(0, 8),
      child: childSessionId.slice(0, 8),
      turn,
      at: Number.isFinite(time) ? new Date(time).toISOString() : null,
    })
  }

  function childrenOfParentTurn(parentSessionId, turn) {
    if (!parentSessionId || !Number.isInteger(turn)) return []
    const set = childrenByParentTurn.get(`${parentSessionId}:${turn}`)
    return set ? Array.from(set) : []
  }

  // ------------------------------------------------------------- persistence

  function enqueue(payload, kind, onStored) {
    if (queue.length >= config.eventQueueLimit) {
      queue.shift()
      counters.dropped += 1
      if (kind === 'agent') agentCounters.dropped += 1
      else if (kind === 'subagent') subagentCounters.dropped += 1
      noteError('AUTO_MEMORY_QUEUE_OVERFLOW', `auto memory queue exceeded ${config.eventQueueLimit}`)
    }
    queue.push({ payload, attempts: 0, kind, onStored })
  }

  function buildMessagePayload(sessionId, role, seq, text, workspace, occurredAt) {
    const roleTag = role === 'assistant' ? 'DSH助手消息' : 'DSH用户消息'
    const workspaceTag = workspaceTagName(workspace.label)
    const noteParts = [
      `自动记忆：DSH 会话 ${sessionId8(sessionId) || 'unknown'} 的${role === 'assistant' ? '助手' : '用户'}消息（seq=${seq}，工作区 ${workspace.label}：${truncateCwd(workspace.cwd)}）`,
    ]
    if (occurredAt) noteParts.push(`occurred_at=${occurredAt}`)
    const payload = {
      title: deriveTitle(text),
      body: text,
      memory_type: config.autoMemoryMemoryType || 'episodic',
      source: { type: 'agent', ref: CLIENT_ID, note: noteParts.join('；') },
      importance: deriveImportance(text),
      tags: normalizeTags(tags.concat(roleTag, workspaceTag)),
      origin: 'agent',
    }
    if (occurredAt) {
      payload.occurred_at = occurredAt
      payload.occurred_precision = 'exact'
    }
    const project = workspaceProjectName(workspace.label)
    if (project) payload.project = { name: project }
    return payload
  }

  // ------------------------------------------------------- relation linking

  function relationPairKey(parentMemoryId, childMemoryId) {
    return `${parentMemoryId}>${childMemoryId}`
  }

  async function patchParentMemoryTag(childMemory, parentMemoryId) {
    if (!childMemory || typeof childMemory.id !== 'string') return
    const tag = `parent-memory:${parentMemoryId}`
    relationCounters.tagPatchAttempted += 1
    try {
      const current = await client.getMemory(childMemory.id)
      if (!current.ok || !current.data || !current.data.memory) {
        relationCounters.tagPatchFailed += 1
        noteRelationError('PARENT_TAG_READ_FAILED', current.code || 'memory read failed')
        return
      }
      const memory = current.data.memory
      const existing = Array.isArray(memory.tag_names) ? memory.tag_names : Array.isArray(memory.tags) ? memory.tags : []
      if (existing.includes(tag)) {
        relationCounters.tagPatched += 1
        return
      }
      const nextTags = normalizeTags([...existing, tag])
      const patched = await client.patchMemory(memory.id, {
        expected_version: memory.version,
        tags: nextTags,
      })
      if (patched.ok) {
        relationCounters.tagPatched += 1
      } else {
        relationCounters.tagPatchFailed += 1
        noteRelationError('PARENT_TAG_PATCH_FAILED', patched.code || 'patch failed')
      }
    } catch (error) {
      relationCounters.tagPatchFailed += 1
      noteRelationError('PARENT_TAG_PATCH_ERROR', error && error.message)
    }
  }

  async function createSpawnRelation(parentMemoryId, childMemory) {
    const pairKey = relationPairKey(parentMemoryId, childMemory.id)
    if (linkedPairs.has(pairKey)) return
    relationCounters.attempted += 1
    const base = {
      from: { kind: 'memory', id: parentMemoryId },
      to: { kind: 'memory', id: childMemory.id },
      directed: true,
      label: SPAWN_RELATION_LABEL,
      evidence: 'DSH 父回合 spawn 了该子会话（DSH automatic memory pipeline）',
      confidence: 1,
      weight: 1,
      source: { type: 'agent', ref: CLIENT_ID, note: `auto:${SPAWN_RELATION_LABEL}` },
    }
    let response = await client.createRelation({ ...base, relation_type: SPAWN_RELATION_TYPE })
    if (!response.ok) {
      relationCounters.fallbackType += 1
      logger.warn('spawn relation custom type rejected, trying derived_from', {
        code: response.code,
        message: response.message,
      })
      response = await client.createRelation({ ...base, relation_type: SPAWN_RELATION_FALLBACK_TYPE })
    }
    if (response.ok) {
      linkedPairs.add(pairKey)
      if (linkedPairs.size > RELATION_PAIR_LIMIT) linkedPairs.delete(linkedPairs.keys().next().value)
      relationCounters.created += 1
      logger.debug('spawn relation created', {
        parent: parentMemoryId.slice(0, 12),
        child: childMemory.id.slice(0, 12),
        type: response.data && response.data.relation ? response.data.relation.relation_type : SPAWN_RELATION_TYPE,
      })
    } else {
      relationCounters.failed += 1
      noteRelationError(response.code || 'RELATION_REJECTED', response.message)
      return
    }
    await patchParentMemoryTag(childMemory, parentMemoryId)
  }

  function childMemoryList(childSessionId) {
    return childMemories.get(childSessionId) || []
  }

  async function storeChildMemoryRecord(childSessionId, memory) {
    if (!childSessionId || !memory || typeof memory.id !== 'string') return
    const list = childMemories.get(childSessionId) || []
    list.push({ id: memory.id, version: memory.version, tags: memory.tag_names ?? [] })
    while (list.length > CHILD_MEMORY_LIMIT) list.shift()
    childMemories.set(childSessionId, list)
    if (childMemories.size > CHILD_MEMORY_LIMIT * 32) {
      const oldest = childMemories.keys().next().value
      if (oldest !== undefined) childMemories.delete(oldest)
    }
    // Satisfy parent memories that were stored before this child memory.
    for (let index = relationWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = relationWaiters[index]
      if (waiter.childSessionId !== childSessionId) continue
      relationWaiters.splice(index, 1)
      await createSpawnRelation(waiter.parentMemoryId, memory)
    }
    relationCounters.pendingWaiters = relationWaiters.length
  }

  async function linkParentChildren(parentMemoryId, parentSessionId, turn, childSessionIds) {
    if (!parentMemoryId || !childSessionIds || childSessionIds.length === 0) return
    for (const childSessionId of childSessionIds) {
      if (!sessionId8(childSessionId)) {
        relationCounters.idNormalizeFailed += 1
        continue
      }
      const memories = childMemoryList(childSessionId)
      if (memories.length === 0) {
        relationWaiters.push({ parentMemoryId, childSessionId })
        while (relationWaiters.length > RELATION_WAITER_LIMIT) relationWaiters.shift()
        relationCounters.pendingWaiters = relationWaiters.length
        continue
      }
      for (const memory of memories) await createSpawnRelation(parentMemoryId, memory)
    }
    logger.debug('parent turn linked to child memories', {
      parent: parentMemoryId.slice(0, 12),
      parentSession: String(parentSessionId || '').slice(0, 8),
      turn,
      children: childSessionIds.length,
    })
  }

  // ------------------------------------------------------ root agent buffers

  function agentTurnKey(sessionId, turn) {
    return `${sessionId}:${turn}`
  }

  function turnNumberOf(data) {
    return isObject(data) && Number.isInteger(data.turn) && data.turn > 0 ? data.turn : null
  }

  function ensureAgentTurn(sessionId, turn, workspace, time) {
    const key = agentTurnKey(sessionId, turn)
    let buffer = agentTurns.get(key)
    if (buffer) return buffer
    while (agentTurns.size >= TURN_BUFFER_LIMIT) {
      const oldest = agentTurns.keys().next().value
      if (oldest === undefined) break
      agentTurns.delete(oldest)
    }
    buffer = {
      key,
      sessionId,
      turn,
      workspace: workspace || { label: 'default', cwd: '', source: 'none' },
      startedAt: Number.isFinite(time) && time > 0 ? time : 0,
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
    const budget = reasoningBudget(agentLimits.reasoningChars)
    if (buffer.reasoningChars >= budget) return
    const remaining = budget - buffer.reasoningChars
    const chunk = reasoning.length > remaining ? reasoning.slice(0, remaining) : reasoning
    if (!chunk) return
    buffer.reasoning = buffer.reasoning ? `${buffer.reasoning}\n${chunk}` : chunk
    buffer.reasoningChars += chunk.length
  }

  function attachToolResult(buffer, data, limits) {
    const message = isObject(data.message) ? data.message : null
    const summary = summarizeToolResult(message, { redact: redactor.redact, maxChars: limits.toolResultChars })
    const turn = turnNumberOf(data)
    const target = turn !== null ? agentTurns.get(agentTurnKey(buffer.sessionId, turn)) : null
    const working = target || buffer
    let node = summary.callId ? working.toolIndex.get(summary.callId) : null
    if (!node) {
      node = { callId: summary.callId, name: '工具结果', args: '', result: '', isError: false, hasResult: false }
      working.tools.push(node)
    }
    node.result = summary.summary
    node.isError = summary.isError
    node.hasResult = true
    return summary
  }

  function handleAgentEvent(sessionId, event, workspace) {
    const type = event.type
    const data = isObject(event.data) ? event.data : {}
    const turn = turnNumberOf(data)
    const time = eventEpoch(event)

    if (type === 'turn/start') {
      if (turn === null) return
      setOpenTurn(sessionId, turn, time)
      ensureAgentTurn(sessionId, turn, workspace, time)
      return
    }

    if (type === 'assistant/message') {
      const buffer = ensureAgentTurn(sessionId, turn === null ? 1 : turn, workspace, time)
      const message = isObject(data.message) ? data.message : {}
      const parts = messageContentParts(message.content)
      if (parts.reasoning) {
        appendReasoning(buffer, sanitizeSegment(parts.reasoning, redactor.redact, reasoningBudget(agentLimits.reasoningChars)))
      }
      if (parts.text) buffer.conclusion = sanitizeSegment(parts.text, redactor.redact, agentLimits.conclusionChars)
      return
    }

    if (type === 'tool/call') {
      const buffer = ensureAgentTurn(sessionId, turn === null ? 1 : turn, workspace, time)
      const callId = typeof data.callId === 'string' ? data.callId : ''
      const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : '未知工具'
      const args = summarizeToolArguments(data.arguments, { redact: redactor.redact, maxChars: agentLimits.toolArgChars })
      const node = { callId, name, args, result: '', isError: false, hasResult: false }
      buffer.tools.push(node)
      if (callId) buffer.toolIndex.set(callId, node)
      agentCounters.toolCallsSeen += 1
      return
    }

    if (type === 'tool/result') {
      agentCounters.toolResultsSeen += 1
      const buffer = turn !== null ? agentTurns.get(agentTurnKey(sessionId, turn)) : latestAgentTurn(sessionId)
      if (buffer) attachToolResult(buffer, data, agentLimits)
      return
    }

    if (type === 'turn/end') {
      const buffer = turn !== null ? agentTurns.get(agentTurnKey(sessionId, turn)) : latestAgentTurn(sessionId)
      if (buffer) {
        agentTurns.delete(buffer.key)
        agentCounters.turnsSeen += 1
        finalizeAgentTurn(buffer, workspace)
      }
      return
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
    const workspace = resolvedWorkspace && resolvedWorkspace.label ? resolvedWorkspace : buffer.workspace
    const children = childrenOfParentTurn(buffer.sessionId, buffer.turn)
    const childrenForLink = []
    for (const childSessionId of children) {
      if (!sessionId8(childSessionId)) {
        relationCounters.idNormalizeFailed += 1
        continue
      }
      childrenForLink.push(childSessionId)
    }
    const baseTags = normalizeTags([
      AGENT_NODE_TAG,
      workspaceTagName(workspace.label),
      AGENT_SESSION_TAG,
    ])
    const occurred = occurredAtOf({ time: buffer.startedAt })
    const payload = buildAgentMemoryPayload({
      sessionId: buffer.sessionId,
      turn: buffer.turn,
      workspace,
      reasoning: buffer.reasoning,
      toolNodes: buffer.tools,
      totalToolCalls: buffer.tools.length,
      conclusion: buffer.conclusion,
      tags: baseTags,
      children: childrenForLink,
      occurredAt: occurred.occurred_at,
      limits: agentLimits,
      sourceRef: CLIENT_ID,
      project: workspaceProjectName(workspace.label),
    })
    if (!payload.body.trim()) {
      agentCounters.skippedEmpty += 1
      return
    }
    if (rateLimited(agentTimestamps, config.autoMemoryAgentMaxPerHour, 'AUTO_MEMORY_AGENT_RATE_LIMIT', 'agent node memory')) {
      agentCounters.skippedRate += 1
      return
    }
    remember(doneAgentTurns, buffer.key, Date.now(), DONE_TURN_LIMIT)
    const parentSessionId = buffer.sessionId
    const turn = buffer.turn
    if (childrenForLink.length > 0) agentCounters.childrenTagged += 1
    enqueue(payload, 'agent', async (memory) => {
      if (!memory || typeof memory.id !== 'string' || childrenForLink.length === 0) return
      await linkParentChildren(memory.id, parentSessionId, turn, childrenForLink)
      childrenByParentTurn.delete(`${parentSessionId}:${turn}`)
    })
    agentCounters.captured += 1
    if (state.connected) scheduleFlush(0)
    logger.debug('agent turn node queued', {
      session: buffer.sessionId.slice(0, 8),
      turn: buffer.turn,
      tools: buffer.tools.length,
      children: childrenForLink.length,
      occurredAt: payload.occurred_at,
      chars: payload.body.length,
      queued: queue.length,
    })
  }

  // ------------------------------------------------- child/subagent buffers

  function subagentTurnKey(sessionId, turn) {
    return `${sessionId}:${turn}`
  }

  function ensureSubagentTurn(sessionId, turn, workspace, time, scope) {
    const key = subagentTurnKey(sessionId, turn)
    let buffer = subagentTurns.get(key)
    if (buffer) return buffer
    while (subagentTurns.size >= TURN_BUFFER_LIMIT) {
      const oldest = subagentTurns.keys().next().value
      if (oldest === undefined) break
      subagentTurns.delete(oldest)
    }
    const parentSessionId = scope && typeof scope.parentSession === 'string' ? scope.parentSession : ''
    const parentTurn = parentSessionId ? (openTurnOf(parentSessionId) ?? lastTurnOf(parentSessionId)) : null
    buffer = {
      key,
      sessionId,
      parentSessionId,
      parentTurn,
      turn,
      workspace: workspace || { label: 'default', cwd: '', source: 'none' },
      startedAt: Number.isFinite(time) && time > 0 ? time : 0,
      task: '',
      taskChars: 0,
      reasoning: '',
      reasoningChars: 0,
      conclusion: '',
      tools: [],
      toolIndex: new Map(),
      lastToolResult: '',
      errorTools: 0,
    }
    subagentTurns.set(key, buffer)
    if (parentSessionId && Number.isInteger(parentTurn) && parentTurn > 0) {
      // Fallback association when the parent's `subagent/catalog` is missed.
      const associationKey = `${parentSessionId}:${parentTurn}`
      let set = childrenByParentTurn.get(associationKey)
      if (!set) {
        set = new Set()
        childrenByParentTurn.set(associationKey, set)
      }
      set.add(sessionId)
    }
    return buffer
  }

  function latestSubagentTurn(sessionId) {
    let found = null
    for (const buffer of subagentTurns.values()) {
      if (buffer.sessionId === sessionId) found = buffer
    }
    return found
  }

  function appendSubagentTask(buffer, text) {
    const budget = Math.max(subagentLimits.taskChars * 3, 120)
    if (buffer.taskChars >= budget) return
    const remaining = budget - buffer.taskChars
    const chunk = text.length > remaining ? text.slice(0, remaining) : text
    if (!chunk) return
    buffer.task = buffer.task ? `${buffer.task}\n${chunk}` : chunk
    buffer.taskChars += chunk.length
    subagentCounters.spawnPromptsSeen += 1
  }

  function handleSubagentEvent(sessionId, session, event, workspace) {
    const type = event.type
    const data = isObject(event.data) ? event.data : {}
    const turn = turnNumberOf(data)
    const time = eventEpoch(event)
    const scope = scopeFor(sessionId, session)

    if (type === 'turn/start') {
      if (turn === null) return
      setOpenTurn(sessionId, turn, time)
      ensureSubagentTurn(sessionId, turn, workspace, time, scope)
      return
    }

    if (type === 'user/message') {
      counters.seen += 1
      counters.skippedChildSession += 1
      const source = isObject(data.source) ? data.source : null
      if (source && source.kind === 'user') {
        const childTurn = turnNumberOf(data) ?? openTurnOf(sessionId) ?? 1
        const buffer = ensureSubagentTurn(sessionId, childTurn, workspace, time, scope)
        const raw = textOfContent(data.content)
        if (raw.trim()) appendSubagentTask(buffer, sanitizeSegment(raw, redactor.redact, Math.max(subagentLimits.taskChars * 3, 120)))
      }
      return
    }

    if (type === 'assistant/message') {
      const buffer = ensureSubagentTurn(sessionId, turn === null ? 1 : turn, workspace, time, scope)
      const message = isObject(data.message) ? data.message : {}
      const parts = messageContentParts(message.content)
      if (parts.reasoning) {
        appendReasoning(buffer, sanitizeSegment(parts.reasoning, redactor.redact, reasoningBudget(subagentLimits.reasoningChars)))
      }
      if (parts.text) buffer.conclusion = sanitizeSegment(parts.text, redactor.redact, subagentLimits.conclusionChars)
      return
    }

    if (type === 'tool/call') {
      const buffer = ensureSubagentTurn(sessionId, turn === null ? 1 : turn, workspace, time, scope)
      const callId = typeof data.callId === 'string' ? data.callId : ''
      const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : '未知工具'
      const args = summarizeToolArguments(data.arguments, { redact: redactor.redact, maxChars: subagentLimits.toolArgChars })
      const node = { callId, name, args, result: '', isError: false, hasResult: false }
      buffer.tools.push(node)
      if (callId) buffer.toolIndex.set(callId, node)
      subagentCounters.toolCallsSeen += 1
      return
    }

    if (type === 'tool/result') {
      const buffer = turn !== null ? subagentTurns.get(subagentTurnKey(sessionId, turn)) : latestSubagentTurn(sessionId)
      if (buffer) {
        const summary = summarizeToolResult(isObject(data.message) ? data.message : null, {
          redact: redactor.redact,
          maxChars: subagentLimits.toolResultChars,
        })
        let node = summary.callId ? buffer.toolIndex.get(summary.callId) : null
        if (!node) {
          node = { callId: summary.callId, name: '工具结果', args: '', result: '', isError: false, hasResult: false }
          buffer.tools.push(node)
        }
        node.result = summary.summary
        node.isError = summary.isError
        node.hasResult = true
        if (summary.isError) buffer.errorTools += 1
        if (summary.summary) buffer.lastToolResult = summary.summary.slice(0, subagentLimits.resultChars)
      }
      subagentCounters.toolResultsSeen += 1
      return
    }

    if (type === 'turn/end') {
      const buffer = turn !== null ? subagentTurns.get(subagentTurnKey(sessionId, turn)) : latestSubagentTurn(sessionId)
      if (buffer) {
        subagentTurns.delete(buffer.key)
        subagentCounters.turnsSeen += 1
        finalizeSubagentTurn(buffer, workspace)
      }
    }
  }

  function finalizeSubagentTurn(buffer, resolvedWorkspace) {
    const hasContent =
      Boolean(buffer.task.trim() || buffer.reasoning.trim() || buffer.conclusion.trim()) || buffer.tools.length > 0
    if (!hasContent) {
      subagentCounters.skippedEmpty += 1
      return
    }
    if (doneSubagentTurns.has(buffer.key)) {
      subagentCounters.skippedDuplicate += 1
      return
    }
    const workspace = resolvedWorkspace && resolvedWorkspace.label ? resolvedWorkspace : buffer.workspace
    const childId8 = sessionId8(buffer.sessionId)
    const parentId8 = sessionId8(buffer.parentSessionId)
    if (buffer.sessionId && !childId8) subagentCounters.idNormalizeFailed += 1
    if (buffer.parentSessionId && !parentId8) subagentCounters.idNormalizeFailed += 1
    const children = childrenOfParentTurn(buffer.sessionId, buffer.turn)
    const occurred = occurredAtOf({ time: buffer.startedAt })
    const payloadTags = normalizeTags([
      SUBAGENT_TAG,
      `subagent-session:${childId8}`,
      parentId8 ? `parent-session:${parentId8}` : '',
      workspaceTagName(workspace.label),
      AGENT_SESSION_TAG,
      ...children.map((childSessionId) => `children:${sessionId8(childSessionId)}`),
    ])
    const payload = buildSubagentSessionPayload({
      sessionId: buffer.sessionId,
      parentSessionId: buffer.parentSessionId,
      turn: buffer.turn,
      workspace,
      task: buffer.task,
      reasoning: buffer.reasoning,
      toolNodes: buffer.tools,
      totalToolCalls: buffer.tools.length,
      result: buffer.lastToolResult
        ? `${buffer.errorTools > 0 ? `（含 ${buffer.errorTools} 个失败工具）` : ''}${buffer.lastToolResult}`
        : '',
      conclusion: buffer.conclusion,
      occurredAt: occurred.occurred_at,
      tags: payloadTags,
      limits: subagentLimits,
      sourceRef: CLIENT_ID,
      project: workspaceProjectName(workspace.label),
    })
    if (!payload.body.trim()) {
      subagentCounters.skippedEmpty += 1
      return
    }
    if (rateLimited(subagentTimestamps, config.autoMemorySubagentMaxPerHour, 'AUTO_MEMORY_SUBAGENT_RATE_LIMIT', 'subagent session memory')) {
      subagentCounters.skippedRate += 1
      return
    }
    remember(doneSubagentTurns, buffer.key, Date.now(), DONE_TURN_LIMIT)
    const childSessionId = buffer.sessionId
    const childrenForLink = children.slice()
    if (childrenForLink.length > 0) subagentCounters.childrenTagged += 1
    enqueue(payload, 'subagent', async (memory) => {
      if (!memory || typeof memory.id !== 'string') return
      await storeChildMemoryRecord(childSessionId, memory)
      if (childrenForLink.length > 0) {
        // A child session may itself have spawned children (nested hierarchy):
        // link this child-session memory to its own child memories.
        await linkParentChildren(memory.id, childSessionId, buffer.turn, childrenForLink)
        childrenByParentTurn.delete(`${childSessionId}:${buffer.turn}`)
      }
      if (buffer.parentSessionId && Number.isInteger(buffer.parentTurn) && buffer.parentTurn > 0) {
        logger.debug('child session memory stored', {
          child: childId8,
          parentSession: sessionId8(buffer.parentSessionId),
          parentTurn: buffer.parentTurn,
          memoryId: memory.id,
        })
      }
    })
    subagentCounters.captured += 1
    if (state.connected) scheduleFlush(0)
    logger.debug('subagent session memory queued', {
      child: childId8,
      parent: parentId8 || 'none',
      turn: buffer.turn,
      tools: buffer.tools.length,
      occurredAt: payload.occurred_at,
      chars: payload.body.length,
      queued: queue.length,
    })
  }

  // --------------------------------------------------------------- compaction

  function compactionRecord(sessionId) {
    let record = compactionBySession.get(sessionId)
    if (!record) {
      record = {
        sessionId8: sessionId8(sessionId),
        count: 0,
        prunes: 0,
        startedAt: null,
        lastAt: null,
        summaryHead: '',
        pending: false,
      }
      compactionBySession.set(sessionId, record)
      if (compactionBySession.size > COMPACTION_SESSION_LIMIT) {
        compactionBySession.delete(compactionBySession.keys().next().value)
      }
    }
    return record
  }

  function handleCompactionEvent(sessionId, event) {
    const type = event.type
    const data = isObject(event.data) ? event.data : {}
    const occurred = occurredAtOf(event)
    const record = compactionRecord(sessionId)
    compactionCounters.eventsSeen += 1
    compactionCounters.lastAt = occurred.occurred_at
    if (type === 'compaction/start') {
      compactionCounters.started += 1
      record.startedAt = occurred.occurred_at
      return
    }
    if (type === 'compaction/prune') {
      compactionCounters.prunes += 1
      record.prunes += 1
      return
    }
    if (type === 'compaction/summary') {
      if (Array.isArray(data.summary)) {
        const raw = data.summary
          .filter((block) => block && block.type === 'text')
          .map((block) => block.text)
          .join('\n')
        const head = sanitizeSegment(raw, redactor.redact, Math.min(800, config.autoMemoryContextRecoveryMaxChars))
        if (head) record.summaryHead = head
      }
      return
    }
    if (type === 'compaction/end') {
      compactionCounters.finished += 1
      record.count += 1
      record.lastAt = occurred.occurred_at
      record.pending = true
      recoveryCounters.sessionsMarked += 1
      compactionCounters.sessions = compactionBySession.size
      logger.info('session context compacted, memory recovery armed', {
        session: record.sessionId8,
        count: record.count,
        at: record.lastAt,
        summary: record.summaryHead ? `${record.summaryHead.slice(0, 80)}…` : null,
      })
    }
  }

  /** Called when the agent runs `fca_memory_context` (it re-read its memories). */
  function clearRecovery(sessionId) {
    const record = compactionBySession.get(sessionId)
    if (!record || !record.pending) return false
    record.pending = false
    recoveryCounters.clearedByTool += 1
    logger.info('context recovery completed by fca_memory_context', { session: record.sessionId8 })
    return true
  }

  /** Snapshot used by the prompt-context recovery module. Never throws. */
  function recoveryInfo(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return null
    const record = compactionBySession.get(sessionId)
    const workspace = workspaceCache.get(sessionId) || null
    return {
      needsRecovery: Boolean(record && record.pending),
      compactedAt: record ? record.lastAt : null,
      count: record ? record.count : 0,
      summaryHead: record ? record.summaryHead : '',
      workspace: workspace ? { label: workspace.label, cwd: workspace.cwd } : null,
    }
  }

  function recordRecoveryRender() {
    recoveryCounters.renders += 1
  }

  // ------------------------------------------------------------------ handle

  return {
    get enabled() {
      return enabled && !disposed
    },
    get agentEnabled() {
      return agentEnabled && !disposed
    },
    get subagentEnabled() {
      return subagentEnabled && !disposed
    },
    mode,
    agentMode,
    subagentMode,

    /**
     * Feed one committed session event. Never throws.
     * @param session - the Session whose log grew (needs `.id` / `.header`).
     * @param event - the committed SessionEvent (needs `.type`).
     */
    handle(session, event) {
      try {
        if (!enabled || disposed) return
        const type = event && event.type
        if (!type) return
        const sessionId = session && typeof session.id === 'string' ? session.id : null
        if (!sessionId) return
        const workspace = workspaceFor(sessionId, session)

        // Compaction detection is independent of capture layers and never
        // writes an ordinary memory.
        if (COMPACTION_EVENT_TYPES.has(type)) {
          handleCompactionEvent(sessionId, event)
          return
        }

        // Parent announces a spawned child session (`subagent/catalog`).
        if (type === SUBAGENT_CATALOG_EVENT) {
          const data = isObject(event.data) ? event.data : {}
          if (typeof data.childId === 'string' && data.childId) {
            registerChildSpawn(sessionId, data.childId, eventEpoch(event))
          }
          return
        }

        // The agent re-read its memories: clear the post-compaction reminder.
        if (recoveryEnabled && type === 'tool/call') {
          const data = isObject(event.data) ? event.data : {}
          if (data.name === RECOVERY_TOOL_NAME) clearRecovery(sessionId)
        }

        const scope = scopeFor(sessionId, session)
        const isChild = scope.kind === 'child'

        // Turn lifecycle bookkeeping for parent→child association.
        if (type === 'turn/start') {
          const turn = turnNumberOf(isObject(event.data) ? event.data : {})
          if (turn !== null) setOpenTurn(sessionId, turn, eventEpoch(event))
        }

        if (isChild) {
          if (subagentEnabled && SUBAGENT_EVENT_TYPES.has(type)) {
            subagentCounters.eventsSeen += 1
            handleSubagentEvent(sessionId, session, event, workspace)
          } else {
            if (type === 'user/message') {
              counters.seen += 1
              counters.skippedChildSession += 1
              return
            }
            if (agentEnabled && TURN_EVENT_TYPES.has(type)) {
              // Backward-compatible fallback: subagent capture off but agent
              // nodes on → child turns still get a procedural agent node.
              agentCounters.eventsSeen += 1
              handleAgentEvent(sessionId, event, workspace)
            }
          }
          if (type === 'turn/end') closeOpenTurn(sessionId)
          return
        }

        if (agentEnabled && TURN_EVENT_TYPES.has(type)) {
          agentCounters.eventsSeen += 1
          handleAgentEvent(sessionId, event, workspace)
          if (type === 'turn/end') {
            closeOpenTurn(sessionId)
            return
          }
          if (type !== 'assistant/message') return
          // assistant/message may also be a message memory in `all` mode.
        }

        const role = ROLE_BY_EVENT[type]
        if (!role) {
          if (type === 'turn/end') closeOpenTurn(sessionId)
          return
        }
        if (role === 'assistant' && mode !== 'all') return
        counters.seen += 1

        const data = isObject(event.data) ? event.data : {}
        // For user-role messages only real user-authored text is captured. The
        // Host injects many other user-role messages (runtime context, skill
        // catalog, time context, background-job notices, agent relays, approval
        // notices…); their `source.kind` is never plain `user` and they must not
        // become memories. Root-session messages only (children handled above).
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
        remember(seenKeys, key, Date.now())
        if (textRecentlySeen(hashText(sanitizeSegment(raw, redactor.redact, config.autoMemoryMaxChars)))) {
          counters.skippedDuplicate += 1
          return
        }
        if (rateLimited(messageTimestamps, config.autoMemoryMaxPerHour, 'AUTO_MEMORY_RATE_LIMIT', 'auto memory')) {
          counters.skippedRate += 1
          return
        }

        const occurred = occurredAtOf(event)
        const payload = buildMessagePayload(sessionId, role, seq, text, workspace, occurred.occurred_at)
        enqueue(payload, 'message')
        counters.captured += 1
        if (state.connected) scheduleFlush(0)
        logger.debug('auto memory queued', {
          role,
          chars: text.length,
          occurredAt: payload.occurred_at,
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

    /** Workspace label of one session (for the context-recovery prompt). */
    workspaceLabelFor,

    /** Post-compaction recovery snapshot for one session. */
    recoveryInfo,

    /** Mark one session's recovery reminder as satisfied. */
    clearRecovery,

    /** Called by the recovery prompt-context renderer (observability). */
    recordRecoveryRender,

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
      const compacted = Array.from(compactionBySession.values())
        .filter((record) => record.count > 0)
        .sort((left, right) => String(right.lastAt).localeCompare(String(left.lastAt)))
        .slice(0, 10)
        .map((record) => ({
          session: record.sessionId8,
          count: record.count,
          prunes: record.prunes,
          last_at: record.lastAt,
          pending_recovery: record.pending,
          summary_head: record.summaryHead ? `${record.summaryHead.slice(0, 160)}…` : null,
        }))
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
          openTurns: openTurns.size,
          trackedChildren: Array.from(childrenByParentTurn.values()).reduce((sum, set) => sum + set.size, 0),
          policy: 'user-messages: root human session only; agent nodes: root; subagent sessions: child',
        },
        agentNodes: {
          mode: agentMode,
          enabled: agentEnabled && !disposed,
          tag: AGENT_NODE_TAG,
          memoryType: AGENT_NODE_MEMORY_TYPE,
          title: `${AGENT_NODE_TITLE_PREFIX} · 第 N 回合`,
          activeTurns: agentTurns.size,
          limits: {
            maxToolNodes: agentLimits.maxToolNodes,
            maxPerHour: config.autoMemoryAgentMaxPerHour,
            reasoningChars: agentLimits.reasoningChars,
            conclusionChars: agentLimits.conclusionChars,
            toolArgChars: agentLimits.toolArgChars,
            toolResultChars: agentLimits.toolResultChars,
            maxChars: agentLimits.maxChars,
          },
          counters: { ...agentCounters },
        },
        subagentSessions: {
          mode: subagentMode,
          enabled: subagentEnabled && !disposed,
          tag: SUBAGENT_TAG,
          memoryType: 'episodic',
          title: '子 Agent 会话 · <workspace> · <childId8>',
          activeTurns: subagentTurns.size,
          limits: {
            maxToolNodes: subagentLimits.maxToolNodes,
            maxPerHour: config.autoMemorySubagentMaxPerHour,
            taskChars: subagentLimits.taskChars,
            reasoningChars: subagentLimits.reasoningChars,
            conclusionChars: subagentLimits.conclusionChars,
            resultChars: subagentLimits.resultChars,
            toolArgChars: subagentLimits.toolArgChars,
            toolResultChars: subagentLimits.toolResultChars,
            maxChars: subagentLimits.maxChars,
          },
          counters: { ...subagentCounters },
        },
        relations: {
          type: SPAWN_RELATION_TYPE,
          label: SPAWN_RELATION_LABEL,
          fallbackType: SPAWN_RELATION_FALLBACK_TYPE,
          counters: { ...relationCounters, pendingWaiters: relationWaiters.length },
          lastError: lastRelationError ? { ...lastRelationError } : null,
        },
        tagNormalization: {
          rule: 'sessionId8: strip leading "session-", then first 8 hex chars (object refs via .sessionId/.id)',
          failed: subagentCounters.idNormalizeFailed + relationCounters.idNormalizeFailed,
          subagentFailed: subagentCounters.idNormalizeFailed,
          relationFailed: relationCounters.idNormalizeFailed,
        },
        compactions: {
          eventsSeen: compactionCounters.eventsSeen,
          prunes: compactionCounters.prunes,
          started: compactionCounters.started,
          finished: compactionCounters.finished,
          sessions: compacted,
          pendingRecovery: compacted.filter((record) => record.pending_recovery).length,
          lastAt: compactionCounters.lastAt,
        },
        recovery: {
          enabled: recoveryEnabled,
          counters: { ...recoveryCounters },
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
      messageTimestamps.length = 0
      agentTimestamps.length = 0
      subagentTimestamps.length = 0
      doneAgentTurns.clear()
      doneSubagentTurns.clear()
      agentTurns.clear()
      subagentTurns.clear()
      openTurns.clear()
      lastTurnBySession.clear()
      childrenByParentTurn.clear()
      childMemories.clear()
      relationWaiters.length = 0
      linkedPairs.clear()
      workspaceCache.clear()
      scopeCache.clear()
      workspaceLabels.clear()
      compactionBySession.clear()
      lastWorkspace = null
    },
  }
}
