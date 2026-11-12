/**
 * Context-recovery assistant (v0.3).
 *
 * Two mechanisms are implemented against the real Host APIs (verified in
 * `@deepseek-ai/dsh-system-prompt`):
 *
 * 1) Always-on instruction — `systemPrompt.section()` inserts a short
 *    instruction into the system prompt telling the agent to call
 *    `fca_memory_context` after context compaction / when it cannot remember.
 * 2) Post-compaction reminder — `systemPrompt.context()` is a dynamic provider
 *    called on every prompt assembly with `AssembleContext.agent`. When the
 *    agent's session has a pending compaction (recorded by the auto-memory
 *    module from real `compaction/start|summary|end` events), it renders a
 *    recovery block (compaction time, count, compaction-summary head, workspace
 *    label) and asks for `fca_memory_context` before continuing. The reminder
 *    disappears once the agent actually calls `fca_memory_context` (observed as
 *    a `tool/call` event by the auto-memory module).
 *
 * This module also owns the pure formatting of `fca_memory_context` results, so
 * the tool handler is thin and unit-testable.
 *
 * @module dsh-plugin-fca-memory/src/context-recovery
 */

import { sessionId8 } from './session-scope.js'

/** Prompt section name (unique inside the profile). */
export const RECOVERY_SECTION_NAME = 'fca-memory-recovery-instruction'

/** Prompt context name (unique inside the profile). */
export const RECOVERY_CONTEXT_NAME = 'fca-memory-recovery-state'

/** Instruction always present when `autoMemoryContextRecovery` is enabled. */
export const RECOVERY_INSTRUCTION = [
  '【FCA 记忆恢复规则】本机有一个 FCA 长期记忆库（工具 fca_memory_context / fca_memory_search）。',
  '当上下文被压缩、或你记不清之前做过什么/做到哪一步/关键决定是什么时，必须先调用 fca_memory_context（可传 workspace 与 limit）重读最近记忆、Agent思考节点、子Agent会话与关键决策，再继续工作。',
  '不要凭空猜测被压缩掉的历史；不确定时先读记忆节点。',
].join('\n')

/** Section/context order: late, after Host runtime contexts (same area as the digest). */
export const RECOVERY_SECTION_ORDER = 940
export const RECOVERY_CONTEXT_ORDER = 941

const DEFAULT_MAX_CONTEXT_CHARS = 900
const DECISION_PATTERN = /(决定|决定要|计划|目标|要求|必须|不要|约定|偏好|喜欢|最爱|记住|规则|约束|里程碑|已完成|下一步)/

function clip(text, limit) {
  const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/**
 * Render the post-compaction recovery block for one agent.
 * @param info - `bridge.autoMemory.recoveryInfo(sessionId)` result.
 * @param maxChars - cap of the rendered text.
 * @returns the context text, or '' when no recovery is pending.
 */
export function buildRecoveryContextText(info, maxChars = DEFAULT_MAX_CONTEXT_CHARS) {
  if (!info || typeof info !== 'object') return ''
  if (info.needsRecovery !== true) return ''
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MAX_CONTEXT_CHARS
  const lines = []
  const when = typeof info.compactedAt === 'string' && info.compactedAt ? info.compactedAt : '刚刚'
  const count = Number.isInteger(info.count) && info.count > 0 ? info.count : 1
  const workspace = info.workspace && typeof info.workspace === 'object' ? info.workspace : null
  lines.push(`⚠ FCA 记忆恢复：本会话上下文已被压缩（第 ${count} 次，时间 ${when}）。`)
  if (workspace && workspace.label) lines.push(`当前工作区：${workspace.label}${workspace.cwd ? `（${clip(workspace.cwd, 120)}）` : ''}。`)
  lines.push('在继续之前，请先调用 fca_memory_context（可传 workspace / limit / turnLimit）重读最近记忆、Agent思考节点、子Agent会话与关键决策，恢复被压缩的工作上下文；不要凭猜测继续。')
  if (info.summaryHead) lines.push(`上次压缩摘要开头：${clip(info.summaryHead, Math.max(200, Math.floor(limit / 2)))}`)
  return clip(lines.join('\n'), limit)
}

/** Short excerpt of one memory body/title for tool output / digest. */
export function memoryExcerpt(memory, maxChars = 180) {
  if (!memory || typeof memory !== 'object') return ''
  const title = typeof memory.title === 'string' ? memory.title : ''
  const body = typeof memory.body === 'string' ? memory.body : ''
  return clip(title ? `${title} — ${body}` : body, maxChars)
}

/**
 * Classify a memories list into the recovery-tool sections.
 * @param items - `/api/v1/memories` items (Memory rows; `tag_names` may be absent).
 * @param options.limit - recent memories limit (default 12).
 * @param options.turnLimit - agent turn nodes limit (default 6).
 * @param options.subagentLimit - child session memories limit (default 5).
 * @param options.decisionLimit - key decisions limit (default 5).
 */
export function buildContextToolSections(items, options = {}) {
  const list = Array.isArray(items) ? items : []
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 50) : 12
  const turnLimit = Number.isInteger(options.turnLimit) && options.turnLimit > 0 ? Math.min(options.turnLimit, 30) : 6
  const subagentLimit = Number.isInteger(options.subagentLimit) && options.subagentLimit > 0 ? Math.min(options.subagentLimit, 30) : 5
  const decisionLimit = Number.isInteger(options.decisionLimit) && options.decisionLimit > 0 ? Math.min(options.decisionLimit, 20) : 5
  const tagsOf = (memory) =>
    Array.isArray(memory.tag_names) ? memory.tag_names : Array.isArray(memory.tags) ? memory.tags : []

  const recent = []
  const agentNodes = []
  const subagentSessions = []
  const decisions = []
  for (const memory of list) {
    if (!memory || typeof memory !== 'object') continue
    const tags = tagsOf(memory)
    const entry = {
      id: memory.id ?? null,
      title: typeof memory.title === 'string' ? memory.title : '',
      memory_type: memory.memory_type ?? null,
      occurred_at: memory.occurred_at ?? null,
      importance: typeof memory.importance === 'number' ? memory.importance : null,
      tags,
      excerpt: memoryExcerpt(memory, 220),
    }
    if (recent.length < limit) recent.push(entry)
    if (tags.includes('Agent思考节点') && agentNodes.length < turnLimit) agentNodes.push(entry)
    if (tags.includes('Agent子会话') && subagentSessions.length < subagentLimit) subagentSessions.push(entry)
    const haystack = `${entry.title}\n${entry.excerpt}`
    if (decisions.length < decisionLimit && DECISION_PATTERN.test(haystack)) {
      decisions.push({ id: entry.id, title: entry.title, occurred_at: entry.occurred_at, excerpt: clip(entry.excerpt, 160) })
    }
  }
  return { recent_memories: recent, agent_turn_nodes: agentNodes, subagent_sessions: subagentSessions, key_decisions: decisions }
}

/**
 * Build the JSON value returned by the `fca_memory_context` tool.
 * @param options.items - recent memories (already workspace-filtered).
 * @param options.workspace - `{ label, cwd, source }`.
 * @param options.recovery - `{ needsRecovery, compactedAt, count }`.
 * @param options.limits - `{ limit, turnLimit, subagentLimit, decisionLimit }`.
 */
export function buildContextToolResult(options = {}) {
  const sections = buildContextToolSections(options.items, options.limits)
  const workspace = options.workspace && typeof options.workspace === 'object' ? options.workspace : { label: 'default' }
  const recovery = options.recovery && typeof options.recovery === 'object' ? options.recovery : null
  return {
    ok: true,
    workspace: {
      label: workspace.label ?? 'default',
      cwd: workspace.cwd ?? null,
      source: workspace.source ?? null,
    },
    generated_at: new Date().toISOString(),
    counts: {
      recent_memories: sections.recent_memories.length,
      agent_turn_nodes: sections.agent_turn_nodes.length,
      subagent_sessions: sections.subagent_sessions.length,
      key_decisions: sections.key_decisions.length,
    },
    ...sections,
    recovery: {
      needs_recovery: Boolean(recovery && recovery.needsRecovery),
      compacted_at: recovery && recovery.compactedAt ? recovery.compactedAt : null,
      compaction_count: recovery && Number.isInteger(recovery.count) ? recovery.count : 0,
    },
    hint: recovery && recovery.needsRecovery
      ? '上下文刚被压缩：以上最近记忆/Agent思考节点/子Agent会话用于恢复工作上下文；继续前建议再调用 fca_memory_search 检索具体细节。'
      : '按需使用最近记忆与思考节点；更细的检索用 fca_memory_search。',
  }
}

/**
 * Register the recovery prompt contributions against a context that owns the
 * `systemPrompt` service.
 * @param options.ctx - context with `systemPrompt` (injected child context).
 * @param options.config - normalized plugin config.
 * @param options.bridge - bridge exposing `autoMemory` and state.
 * @param options.state - bridge state (observability counters live here).
 * @param options.logger - plugin logger.
 */
export function registerRecoveryContext({ ctx, config, bridge, state, logger }) {
  if (!config.autoMemoryContextRecovery) {
    logger.debug('context recovery prompt injection disabled by configuration')
    return
  }
  const maxChars =
    Number.isInteger(config.autoMemoryContextRecoveryMaxChars) && config.autoMemoryContextRecoveryMaxChars > 0
      ? config.autoMemoryContextRecoveryMaxChars
      : DEFAULT_MAX_CONTEXT_CHARS
  const recoveryState = {
    enabled: true,
    renders: 0,
    lastRenderedAt: null,
    lastSession: null,
  }
  state.contextRecovery = recoveryState

  return ctx.effect(() => {
    const disposers = []
    disposers.push(
      ctx.systemPrompt.section({
        name: RECOVERY_SECTION_NAME,
        order: RECOVERY_SECTION_ORDER,
        text: RECOVERY_INSTRUCTION,
      }),
    )
    disposers.push(
      ctx.systemPrompt.context({
        name: RECOVERY_CONTEXT_NAME,
        order: RECOVERY_CONTEXT_ORDER,
        text: (assembly) => {
          try {
            const sessionId = assembly && assembly.agent && typeof assembly.agent.id === 'string' ? assembly.agent.id : ''
            if (!sessionId) return ''
            const info = bridge.autoMemory && typeof bridge.autoMemory.recoveryInfo === 'function'
              ? bridge.autoMemory.recoveryInfo(sessionId)
              : null
            const text = buildRecoveryContextText(info, maxChars)
            if (!text) return ''
            recoveryState.renders += 1
            recoveryState.lastRenderedAt = new Date().toISOString()
            recoveryState.lastSession = sessionId8(sessionId) || sessionId.slice(0, 8)
            if (bridge.autoMemory && typeof bridge.autoMemory.recordRecoveryRender === 'function') {
              bridge.autoMemory.recordRecoveryRender()
            }
            logger.debug('context recovery reminder rendered', {
              session: recoveryState.lastSession,
              chars: text.length,
            })
            return text
          } catch (error) {
            logger.debug('context recovery context failed', { message: error && error.message })
            return ''
          }
        },
      }),
    )
    logger.info('context recovery prompt injection enabled', {
      section: RECOVERY_SECTION_NAME,
      context: RECOVERY_CONTEXT_NAME,
      maxChars,
    })
    return () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // ignore teardown errors
        }
      }
    }
  })
}
