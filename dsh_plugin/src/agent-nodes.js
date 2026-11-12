/**
 * Agent turn nodes: turn-level aggregation of the agent's own thinking process.
 *
 * User requirement ("更全"): an automatic memory should not only contain the
 * user's input, but also the important nodes of the agent's process — reasoning,
 * tool calls and tool results. Writing one memory per tool call would flood the
 * atlas, so this module buffers one DSH turn and emits **one** aggregated
 * `procedural` memory at `turn/end`, with three sections:
 *
 *   【关键推理】 first ~1500 chars of the turn's reasoning blocks
 *   【工具执行】 up to N tool calls: name + redacted/truncated args + result
 *   【结论】    first ~800 chars of the last assistant text of the turn
 *
 * This module is pure: it only extracts/sanitizes/formats values. De-duplication,
 * rate limiting, queueing and transport stay in `auto-memory.js`. Event shapes
 * are taken from real DSH session logs (session format v4):
 *
 *   assistant/message.data.message.content = [{type:'reasoning',text}, {type:'text',text}, {type:'tool-call',...}]
 *   tool/call.data = { turn, step, callId, name, arguments: "JSON string" }
 *   tool/result.data.message = { role:'tool', source:{kind:'tool',callId}, toolCallId, content:[{type:'text',text}], isError }
 *   turn/end.data = { turn, reason:{kind} }
 *
 * @module dsh-plugin-fca-memory/src/agent-nodes
 */

import { createHash } from 'node:crypto'
import { sessionId8 } from './session-scope.js'

/** Title prefix of one aggregated agent node memory. */
export const AGENT_NODE_TITLE_PREFIX = 'Agent 思考节点'

/** Fixed memory type of an agent node memory (user choice: 更全 → procedural). */
export const AGENT_NODE_MEMORY_TYPE = 'procedural'

/** Fixed importance of an agent node memory (task spec). */
export const AGENT_NODE_IMPORTANCE = 0.55

const MAX_REASONING_BUDGET_FACTOR = 3
const MAX_TURN_BODY_CHARS = 60_000

/** Join every text/reasoning block of a DSH content-block array. */
function blocksOfType(content, type) {
  if (typeof content === 'string') return type === 'text' ? content : ''
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === type && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Split one assistant message content into reasoning and visible text.
 * @param content - `assistant/message.data.message.content`.
 * @returns `{ reasoning, text }` — both plain strings, possibly ''.
 */
export function messageContentParts(content) {
  return {
    reasoning: blocksOfType(content, 'reasoning').trim(),
    text: blocksOfType(content, 'text').trim(),
  }
}

/** Hash helper used for de-duplicating identical agent node bodies. */
export function hashAgentBody(body) {
  return createHash('sha256').update(String(body || ''), 'utf8').digest('hex').slice(0, 20)
}

function collapseWhitespace(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function truncate(text, maxChars) {
  const value = String(text || '')
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : 2000
  return value.length > limit ? `${value.slice(0, limit)}…[truncated]` : value
}

/**
 * Redact + normalize + truncate one free-form segment of text.
 * Redaction happens before truncation so a secret cut in half cannot slip
 * through the configured patterns.
 */
export function sanitizeSegment(text, redact, maxChars) {
  const raw = typeof text === 'string' ? text : ''
  const redacted = typeof redact === 'function' ? redact(raw) : raw
  const collapsed = collapseWhitespace(redacted)
  return truncate(collapsed, maxChars)
}

/** Compact `key=value` rendering of parsed tool arguments. */
function compactValue(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Summarize tool-call arguments for the memory body.
 * @param rawArguments - `tool/call.data.arguments` (JSON string) or an object.
 * @param options.redact - redactor function.
 * @param options.maxChars - cap of the summary.
 */
export function summarizeToolArguments(rawArguments, options = {}) {
  const redact = typeof options.redact === 'function' ? options.redact : (value) => value
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : 400
  let source = ''
  let parsed = null
  if (typeof rawArguments === 'string') {
    source = rawArguments
    try {
      parsed = JSON.parse(rawArguments)
    } catch {
      parsed = null
    }
  } else if (rawArguments && typeof rawArguments === 'object') {
    parsed = rawArguments
    try {
      source = JSON.stringify(rawArguments)
    } catch {
      source = String(rawArguments)
    }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const keys = Object.keys(parsed)
    if (keys.length > 0) {
      const pairs = keys.slice(0, 12).map((key) => {
        const value = compactValue(parsed[key])
        const flat = collapseWhitespace(value)
        return `${key}=${flat}`
      })
      source = pairs.join(', ')
    }
  }
  return sanitizeSegment(source, redact, maxChars)
}

/** Join the visible text of one `tool/result` message. */
export function toolResultText(message) {
  if (!message || typeof message !== 'object') return ''
  return blocksOfType(message.content, 'text').trim()
}

/**
 * Summarize one tool result.
 * @param message - `tool/result.data.message`.
 * @param options.redact - redactor function.
 * @param options.maxChars - cap of the summary.
 * @returns `{ callId, isError, summary }`.
 */
export function summarizeToolResult(message, options = {}) {
  const source = message && typeof message === 'object' ? message : {}
  const nested = source.source && typeof source.source === 'object' ? source.source : {}
  return {
    callId: typeof source.toolCallId === 'string' ? source.toolCallId : typeof nested.callId === 'string' ? nested.callId : '',
    isError: source.isError === true,
    summary: sanitizeSegment(toolResultText(source), options.redact, options.maxChars),
  }
}

/**
 * Format the aggregated body of one Agent 思考节点 memory.
 * All inputs must already be sanitized by the caller.
 * @returns the body string (three sections, always present).
 */
export function formatAgentTurnBody({
  reasoning,
  toolNodes,
  totalToolCalls,
  conclusion,
  maxChars,
  maxToolNodes,
  occurredAt,
  turn,
  children,
}) {
  const tools = Array.isArray(toolNodes) ? toolNodes.filter(Boolean) : []
  const toolLimit = Number.isInteger(maxToolNodes) && maxToolNodes > 0 ? maxToolNodes : 8
  const shown = tools.slice(0, toolLimit)
  const total = Number.isInteger(totalToolCalls) && totalToolCalls > tools.length ? totalToolCalls : tools.length

  const reasoningText = collapseWhitespace(reasoning)
  const conclusionText = collapseWhitespace(conclusion)

  const sections = []
  const meta = [`时间：${formatTimeForBody(occurredAt)}`]
  if (Number.isInteger(turn) && turn > 0) meta.push(`第 ${turn} 回合`)
  const childList = Array.isArray(children) ? children.filter(Boolean) : []
  if (childList.length > 0) meta.push(`子会话：${childList.join(',')}`)
  sections.push(meta.join(' · '))
  sections.push('')
  sections.push('【关键推理】')
  sections.push(reasoningText || '（本回合无推理文本）')
  sections.push('')
  sections.push('【工具执行】')
  if (shown.length === 0) {
    sections.push('（本回合未调用工具）')
  } else {
    shown.forEach((node, index) => {
      const name = collapseWhitespace(node && node.name) || '未知工具'
      const args = collapseWhitespace(node && node.args)
      const result = collapseWhitespace(node && node.result)
      sections.push(`${index + 1}. ${name} · 参数：${args || '（无参数）'}`)
      if (!node || !node.hasResult) sections.push('   结果：（未观测到结果事件）')
      else if (node.isError) sections.push(`   结果（失败）：${result || '（空结果）'}`)
      else sections.push(`   结果：${result || '（空结果）'}`)
    })
    if (total > shown.length) {
      sections.push(`（本回合共 ${total} 个工具调用，正文仅保留前 ${shown.length} 个；完整序列见 DSH 会话日志）`)
    }
  }
  sections.push('')
  sections.push('【结论】')
  sections.push(conclusionText || '（本回合未产生结论文本）')

  const body = sections.join('\n')
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? Math.min(maxChars, MAX_TURN_BODY_CHARS) : 8000
  return body.length > limit ? `${body.slice(0, limit)}…[truncated]` : body
}

/**
 * Build one aggregated `procedural` memory payload for a finished turn.
 * @param options.sessionId - DSH session id (source note uses its 8-char prefix).
 * @param options.turn - turn number from `turn/end.data.turn`.
 * @param options.workspace - `{ label, cwd }` resolved from the Session.
 * @param options.reasoning - sanitized reasoning text.
 * @param options.toolNodes - `[{ name, args, result, isError, hasResult }]` (sanitized).
 * @param options.totalToolCalls - number of observed tool/call events this turn.
 * @param options.conclusion - sanitized final assistant text.
 * @param options.tags - tag names to attach (caller composes workspace tag etc.).
 * @param options.children - child session ids (or id8 strings) spawned in this turn.
 * @param options.occurredAt - ISO occurrence time of the turn (v0.3).
 * @param options.limits - `{ reasoningChars, conclusionChars, maxChars, maxToolNodes }`.
 * @param options.sourceRef - FCA client id.
 */
export function buildAgentMemoryPayload(options = {}) {
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId : ''
  const turn = Number.isInteger(options.turn) && options.turn > 0 ? options.turn : 1
  const workspace = options.workspace && typeof options.workspace === 'object' ? options.workspace : { label: 'default', cwd: '' }
  const limits = options.limits && typeof options.limits === 'object' ? options.limits : {}
  const reasoning = truncate(collapseWhitespace(options.reasoning), Number.isInteger(limits.reasoningChars) ? limits.reasoningChars : 1500)
  const conclusion = truncate(collapseWhitespace(options.conclusion), Number.isInteger(limits.conclusionChars) ? limits.conclusionChars : 800)
  const children = normalizeChildren(options.children)
  const occurredAt = typeof options.occurredAt === 'string' && options.occurredAt ? options.occurredAt : ''
  const body = formatAgentTurnBody({
    reasoning,
    conclusion,
    toolNodes: options.toolNodes,
    totalToolCalls: options.totalToolCalls,
    maxChars: limits.maxChars,
    maxToolNodes: limits.maxToolNodes,
    occurredAt,
    turn,
    children,
  })
  const workspaceLabel = String(workspace.label || 'default')
  const cwd = String(workspace.cwd || '')
  const noteParts = [`Agent思考节点：DSH 会话 ${sessionId8(sessionId) || 'unknown'} 第 ${turn} 回合，工作区 ${workspaceLabel}`]
  if (occurredAt) noteParts.push(`occurred_at=${occurredAt}`)
  if (children.length > 0) noteParts.push(`children=${children.join(',')}`)
  if (cwd) noteParts.push(`cwd=${cwd.length > 160 ? `${cwd.slice(0, 160)}…` : cwd}`)
  const tags = Array.isArray(options.tags) ? options.tags.slice(0, 16) : []
  for (const childId8 of children) {
    const childTag = `children:${childId8}`
    if (!tags.includes(childTag)) tags.push(childTag)
  }
  const payload = {
    title: `${AGENT_NODE_TITLE_PREFIX} · 第 ${turn} 回合`,
    body,
    memory_type: AGENT_NODE_MEMORY_TYPE,
    source: {
      type: 'agent',
      ref: options.sourceRef || 'dsh-plugin',
      note: noteParts.join('；'),
    },
    importance: AGENT_NODE_IMPORTANCE,
    tags: tags.slice(0, 16),
    origin: 'agent',
  }
  if (occurredAt) {
    payload.occurred_at = occurredAt
    payload.occurred_precision = 'exact'
  }
  if (options.project && typeof options.project === 'string' && options.project.trim()) {
    payload.project = { name: options.project.trim() }
  }
  return payload
}

/** Normalize a children list to lowercase 8-char ids (dedupe, order preserved). */
export function normalizeChildren(children) {
  const out = []
  if (!Array.isArray(children)) return out
  for (const value of children) {
    if (typeof value !== 'string' && (!value || typeof value !== 'object')) continue
    const id8 = sessionId8(value)
    if (!id8 || out.includes(id8)) continue
    out.push(id8)
    if (out.length >= 16) break
  }
  return out
}

// ------------------------------------------------------- subagent sessions (v0.3)

/** Tag attached to every aggregated child (subagent/teammate) session memory. */
export const SUBAGENT_SESSION_TAG = 'Agent子会话'

/** Title prefix of an aggregated child session memory. */
export const SUBAGENT_SESSION_TITLE_PREFIX = '子 Agent 会话'

/** Fixed importance of a child session memory (Lead-confirmed contract). */
export const SUBAGENT_SESSION_IMPORTANCE = 0.5

/**
 * Format the aggregated body of one 子 Agent 会话 memory.
 * Sections: 任务 / 关键推理 / 工具执行 / 结果 / 结论 (Lead-confirmed contract).
 * All inputs must already be sanitized by the caller.
 */
export function formatSubagentSessionBody({
  task,
  reasoning,
  toolNodes,
  totalToolCalls,
  result,
  conclusion,
  occurredAt,
  turn,
  childId8,
  parentId8,
  maxChars,
  maxToolNodes,
}) {
  const tools = Array.isArray(toolNodes) ? toolNodes.filter(Boolean) : []
  const toolLimit = Number.isInteger(maxToolNodes) && maxToolNodes > 0 ? maxToolNodes : 12
  const shown = tools.slice(0, toolLimit)
  const total = Number.isInteger(totalToolCalls) && totalToolCalls > tools.length ? totalToolCalls : tools.length
  const sections = []
  const meta = [`时间：${formatTimeForBody(occurredAt)}`]
  if (Number.isInteger(turn) && turn > 0) meta.push(`第 ${turn} 回合`)
  if (childId8) meta.push(`子会话：${childId8}`)
  if (parentId8) meta.push(`父会话：${parentId8}`)
  sections.push(meta.join(' · '))
  sections.push('')
  sections.push('【任务】')
  sections.push(collapseWhitespace(task) || '（未观测到 spawn prompt / 任务文本）')
  sections.push('')
  sections.push('【关键推理】')
  sections.push(collapseWhitespace(reasoning) || '（本回合无推理文本）')
  sections.push('')
  sections.push('【工具执行】')
  if (shown.length === 0) {
    sections.push('（本回合未调用工具）')
  } else {
    shown.forEach((node, index) => {
      const name = collapseWhitespace(node && node.name) || '未知工具'
      const args = collapseWhitespace(node && node.args)
      const toolResult = collapseWhitespace(node && node.result)
      sections.push(`${index + 1}. ${name} · 参数：${args || '（无参数）'}`)
      if (!node || !node.hasResult) sections.push('   结果：（未观测到结果事件）')
      else if (node.isError) sections.push(`   结果（失败）：${toolResult || '（空结果）'}`)
      else sections.push(`   结果：${toolResult || '（空结果）'}`)
    })
    if (total > shown.length) {
      sections.push(`（本回合共 ${total} 个工具调用，正文仅保留前 ${shown.length} 个；完整序列见 DSH 会话日志）`)
    }
  }
  sections.push('')
  sections.push('【结果】')
  sections.push(collapseWhitespace(result) || '（未观测到结果/工具输出）')
  sections.push('')
  sections.push('【结论】')
  sections.push(collapseWhitespace(conclusion) || '（本回合未产生结论文本）')
  const body = sections.join('\n')
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? Math.min(maxChars, MAX_TURN_BODY_CHARS) : 12000
  return body.length > limit ? `${body.slice(0, limit)}…[truncated]` : body
}

/**
 * Build one aggregated `episodic` memory payload for a finished child session turn.
 * @param options.sessionId - child session id (full).
 * @param options.parentSessionId - parent session id (full, may be '').
 * @param options.turn - child turn number.
 * @param options.workspace - `{ label, cwd }`.
 * @param options.task - sanitized spawn prompt / task text.
 * @param options.reasoning - sanitized reasoning text.
 * @param options.toolNodes - sanitized tool nodes.
 * @param options.totalToolCalls - observed tool/call count.
 * @param options.result - sanitized result summary.
 * @param options.conclusion - sanitized final assistant text.
 * @param options.occurredAt - ISO occurrence time (first child event).
 * @param options.tags - caller-composed tags (Agent子会话/subagent-session/... etc).
 * @param options.limits - `{ taskChars, reasoningChars, conclusionChars, toolArgChars, toolResultChars, maxChars, maxToolNodes }`.
 * @param options.sourceRef - FCA client id.
 */
export function buildSubagentSessionPayload(options = {}) {
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId : ''
  const parentSessionId = typeof options.parentSessionId === 'string' ? options.parentSessionId : ''
  const turn = Number.isInteger(options.turn) && options.turn > 0 ? options.turn : 1
  const workspace = options.workspace && typeof options.workspace === 'object' ? options.workspace : { label: 'default', cwd: '' }
  const limits = options.limits && typeof options.limits === 'object' ? options.limits : {}
  const childId8 = sessionId8(sessionId)
  const parentId8 = sessionId8(parentSessionId)
  const occurredAt = typeof options.occurredAt === 'string' && options.occurredAt ? options.occurredAt : ''
  const task = truncate(collapseWhitespace(options.task), Number.isInteger(limits.taskChars) ? limits.taskChars : 1200)
  const reasoning = truncate(collapseWhitespace(options.reasoning), Number.isInteger(limits.reasoningChars) ? limits.reasoningChars : 1500)
  const conclusion = truncate(collapseWhitespace(options.conclusion), Number.isInteger(limits.conclusionChars) ? limits.conclusionChars : 800)
  const result = truncate(collapseWhitespace(options.result), Number.isInteger(limits.resultChars) ? limits.resultChars : 1000)
  const workspaceLabel = String(workspace.label || 'default')
  const body = formatSubagentSessionBody({
    task,
    reasoning,
    toolNodes: options.toolNodes,
    totalToolCalls: options.totalToolCalls,
    result,
    conclusion,
    occurredAt,
    turn,
    childId8,
    parentId8,
    maxChars: limits.maxChars,
    maxToolNodes: limits.maxToolNodes,
  })
  const noteParts = [
    `子Agent会话：DSH 会话 ${childId8 || 'unknown'} 第 ${turn} 回合，父会话 ${parentId8 || 'unknown'}，工作区 ${workspaceLabel}`,
  ]
  if (occurredAt) noteParts.push(`occurred_at=${occurredAt}`)
  if (workspace.cwd) noteParts.push(`cwd=${String(workspace.cwd).slice(0, 160)}`)
  const payload = {
    title: `${SUBAGENT_SESSION_TITLE_PREFIX} · ${workspaceLabel} · ${childId8 || 'unknown'}`,
    body,
    memory_type: 'episodic',
    source: {
      type: 'agent',
      ref: options.sourceRef || 'dsh-plugin',
      note: noteParts.join('；'),
    },
    importance: SUBAGENT_SESSION_IMPORTANCE,
    tags: Array.isArray(options.tags) ? options.tags.slice(0, 16) : [],
    origin: 'agent',
  }
  if (occurredAt) {
    payload.occurred_at = occurredAt
    payload.occurred_precision = 'exact'
  }
  if (options.project && typeof options.project === 'string' && options.project.trim()) {
    payload.project = { name: options.project.trim() }
  }
  return payload
}

/** Render a short time line for memory bodies (UTC, no milliseconds). */
function formatTimeForBody(iso) {
  if (typeof iso !== 'string' || !iso) return '（未知）'
  return iso.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z')
}


/** Max characters of raw reasoning buffered per turn (bounded memory). */
export function reasoningBudget(reasoningChars) {
  const base = Number.isInteger(reasoningChars) && reasoningChars > 0 ? reasoningChars : 1500
  return base * MAX_REASONING_BUDGET_FACTOR
}
