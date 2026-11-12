/**
 * DSH workspace attribution for automatic memories (v0.2).
 *
 * The user requirement: every memory captured in one DSH workspace must land on
 * one spiral arm of the FCA nebula. The renderer groups by the `workspace:<label>`
 * tag, so the plugin derives a stable label from the Session's real working
 * directory and attaches the full cwd to the memory note.
 *
 * Resolution order (first usable wins):
 *   1. `session.header.cwd` — the durable SessionHeader of this DSH release
 *      (immutable creation metadata; verified against
 *      `@deepseek-ai/dsh-session/lib/types`, `snapshotSessionHeader`);
 *   2. `session.cwd` — older/alternate Session shapes;
 *   3. `session.meta.cwd` / `session.header.meta.cwd` — defensive fallbacks;
 *   4. `process.cwd()` — last resort, so a memory is never left unattributed.
 *
 * A pure label is the basename of the cwd (e.g. `D:\FCA` → `FCA`). Nothing in
 * this module throws: a malformed session only degrades to the fallback.
 *
 * @module dsh-plugin-fca-memory/src/workspace
 */

import path from 'node:path'

/** Maximum characters of a workspace tag (`workspace:<label>` must stay < 100). */
const TAG_PREFIX = 'workspace:'
const MAX_LABEL_CHARS = 64
const MAX_CWD_NOTE_CHARS = 160

/** Normalize one cwd candidate: trim only, keep the original separators. */
export function normalizeCwd(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : ''
}

/** True for Windows drive-letter and UNC paths. */
function isWindowsPath(cwd) {
  return /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\')
}

/**
 * Human-readable workspace label from a cwd.
 * @param cwd - absolute directory path (Windows or POSIX).
 * @returns the basename, whitespace-collapsed and length-capped; '' if unusable.
 */
export function workspaceLabelFromCwd(cwd) {
  const value = normalizeCwd(cwd)
  if (!value) return ''
  const impl = isWindowsPath(value) ? path.win32 : path.posix
  let base = ''
  try {
    base = impl.basename(value)
  } catch {
    return ''
  }
  base = String(base || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!base || base === '.' || base === '..' || /^[\\/]+$/.test(base)) return ''
  return base.slice(0, MAX_LABEL_CHARS)
}

/**
 * Turn a label into the tag name stored in FCA (`workspace:<label>`).
 * Non-empty tags are required by the Runtime; missing labels become `default`.
 */
export function workspaceTagName(label) {
  const safe = String(label || '').trim() || 'default'
  return `${TAG_PREFIX}${safe}`.slice(0, 100)
}

/** Project entity name used for workspace grouping (`<label> 工作区`). */
export function workspaceProjectName(label) {
  const safe = String(label || '').trim()
  if (!safe || safe === 'default') return ''
  return `${safe} 工作区`
}

/** Truncate a cwd for the memory note without losing the drive root. */
export function truncateCwd(cwd, max = MAX_CWD_NOTE_CHARS) {
  const value = normalizeCwd(cwd)
  if (!value) return ''
  const limit = Number.isInteger(max) && max > 16 ? max : MAX_CWD_NOTE_CHARS
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/**
 * Resolve the workspace of one DSH Session.
 * @param session - Host Session (`{ id, header: { cwd } }`) or a duck-typed event.
 * @param options.proc - process-like object providing `cwd()` (injectable in tests).
 * @returns `{ cwd, label, source }` — never throws.
 */
export function resolveWorkspace(session, options = {}) {
  const proc = options.proc && typeof options.proc === 'object' ? options.proc : process
  const candidates = [
    ['session.header.cwd', session && session.header && session.header.cwd],
    ['session.cwd', session && session.cwd],
    ['session.meta.cwd', session && session.meta && session.meta.cwd],
    ['session.header.meta.cwd', session && session.header && session.header.meta && session.header.meta.cwd],
  ]
  for (const [source, candidate] of candidates) {
    const cwd = normalizeCwd(candidate)
    if (!cwd) continue
    const label = workspaceLabelFromCwd(cwd)
    if (label) return { cwd, label, source }
  }
  let fallback = ''
  try {
    fallback = normalizeCwd(typeof proc.cwd === 'function' ? proc.cwd() : '')
  } catch {
    fallback = ''
  }
  const label = workspaceLabelFromCwd(fallback)
  if (label) return { cwd: fallback, label, source: 'process.cwd' }
  return { cwd: fallback, label: 'default', source: 'none' }
}
