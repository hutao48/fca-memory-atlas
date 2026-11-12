/**
 * DSH session scope detection for automatic memory (v0.2.1).
 *
 * Real DSH session headers (format v4, verified against installed
 * `@deepseek-ai/dsh-session/lib/types` `snapshotSessionHeader`):
 *
 *   root human session:  { id, cwd, isSeeded:false, delegationDepth:0, agentPreset:"standard" }
 *                        (no `parentSession`, no `origin`)
 *   subagent/teammate:   { id, cwd, parentSession:"session-…", isSeeded:false,
 *                          origin:"subagent", delegationDepth:1, agentPreset:"cordis" }
 *
 * The Host injects a spawned subagent's spawn prompt as a `user/message` whose
 * `data.source.kind` is `"user"`. That is how teammate startup prompts leaked
 * into auto memory in v0.2.0. The fix: user-message memories are only captured
 * for the human root session; child sessions are skipped (and counted), while
 * Agent 思考节点 (turn/end aggregation) keeps working for every session.
 *
 * `origin` is only allowed to be `"subagent"` by the SessionHeader validator, so
 * that is the only non-root origin handled. Fork/seed/resume of a human session
 * keeps no `origin`/`parentSession` and therefore stays a root conversation.
 *
 * @module dsh-plugin-fca-memory/src/session-scope
 */

/** First non-empty string among the candidates. */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function asDepth(value) {
  return Number.isInteger(value) && value >= 0 ? value : null
}

/**
 * Describe the scope (root human conversation vs. child/subagent) of a Session.
 *
 * @param session - Host Session (`{ id, header }`) or a duck-typed object.
 * @returns `{ kind: 'root'|'child', reason, parentSession, origin, delegationDepth }`
 *   — never throws; an object without lineage metadata is treated as `root` so
 *   real user messages are never lost because of a shape change.
 */
export function describeSessionScope(session) {
  const source = session && typeof session === 'object' ? session : {}
  const header = source.header && typeof source.header === 'object' ? source.header : source
  const parentSession =
    firstString(header.parentSession, header.parentSessionId, source.parentSession, source.parentSessionId) ||
    extractSessionId(header.parentSession) ||
    extractSessionId(header.parentSessionId) ||
    extractSessionId(source.parentSession)
  const origin = firstString(header.origin, source.origin)
  const delegationDepth = asDepth(header.delegationDepth) ?? asDepth(source.delegationDepth)
  const scope = {
    kind: 'root',
    reason: 'root',
    parentSession,
    origin,
    delegationDepth,
  }
  if (parentSession) {
    scope.kind = 'child'
    scope.reason = 'parent-session'
    return scope
  }
  if (delegationDepth !== null && delegationDepth > 0) {
    scope.kind = 'child'
    scope.reason = 'delegation-depth'
    return scope
  }
  if (origin === 'subagent') {
    scope.kind = 'child'
    scope.reason = 'origin-subagent'
    return scope
  }
  return scope
}

/**
 * True when this Session is a spawned child (subagent/teammate) session.
 * @param session - Host Session or duck-typed object.
 */
export function isChildSession(session) {
  return describeSessionScope(session).kind === 'child'
}

/**
 * Extract a session id string from a value that may be a string or a
 * `{ sessionId | session_id | id }` object (v0.3.1 tag normalization).
 * @param value - candidate session reference.
 * @returns the trimmed id string, or ''.
 */
export function extractSessionId(value) {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object') return ''
  for (const key of ['sessionId', 'session_id', 'id', 'session']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return ''
}

/**
 * Stable 8-char session id prefix used in tags (`subagent-session:<id8>`,
 * `parent-session:<id8>`, `children:<id8>`) and in memory titles.
 *
 * Normalization (v0.3.1, Lead-confirmed contract): strip a leading `session-`
 * prefix, then use the first 8 hex/base36 characters of the actual id — e.g.
 * `session-d9ea76db-0089-...` → `d9ea76db` (never the useless `session-`).
 * Object references use `.sessionId`/`.session_id`/`.id`.
 *
 * @param id - full SessionId (string) or a session-reference object.
 * @returns normalized lowercase 8-char id, or '' when unusable.
 */
export function sessionId8(id) {
  const value = extractSessionId(id)
  if (!value) return ''
  let text = value.toLowerCase()
  if (text.startsWith('session-')) text = text.slice('session-'.length)
  const hexMatch = text.match(/^[0-9a-f]{8}/)
  if (hexMatch) return hexMatch[0]
  return text.replace(/[^0-9a-z]/g, '').slice(0, 8)
}

/**
 * Parent session id of a child session ('' for root sessions).
 * Handles `header.parentSession` as a string or a `{ sessionId }` object.
 * @param session - Host Session or duck-typed object.
 */
export function parentSessionOf(session) {
  const source = session && typeof session === 'object' ? session : {}
  const header = source.header && typeof source.header === 'object' ? source.header : source
  return (
    extractSessionId(header.parentSession) ||
    extractSessionId(header.parentSessionId) ||
    extractSessionId(source.parentSession) ||
    extractSessionId(source.parentSessionId)
  )
}

