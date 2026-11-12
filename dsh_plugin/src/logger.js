/**
 * Structured, redacting logger for the FCA Memory Atlas bridge.
 *
 * Every log record goes through the Host logger (`ctx.logger(name)`), which the
 * Desktop host forwards to its own log pipeline. Records never contain the
 * Runtime bearer token or memory bodies; only identifiers, sizes and counters.
 *
 * @module dsh-plugin-fca-memory/src/logger
 */

const LEVELS = { silent: 0, error: 1, info: 2, debug: 3 }

/** Built-in secrets redaction patterns, always applied before any log or upload. */
const BUILTIN_PATTERNS = [
  { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g },
  { name: 'sk-key', pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/g },
  { name: 'authorization-header', pattern: /(["']?(?:authorization|x-fca-token)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi },
  { name: 'secret-field', pattern: /(["']?(?:api[_-]?key|apikey|token|secret|password)["']?\s*[:=]\s*["'])[^"']{4,}(["'])/gi },
]

/**
 * Compile the configured redaction patterns and merge them with the built-ins.
 * @param patterns - extra regular-expression sources from the plugin config.
 * @param logger - logger used to report invalid patterns.
 * @returns a redactor with `redact(text)` and `patterns` metadata.
 */
export function createRedactor(patterns, logger) {
  const sources = []
  for (const name of ['bearer', 'sk-key', 'authorization-header', 'secret-field']) {
    const builtin = BUILTIN_PATTERNS.find((item) => item.name === name)
    if (builtin) sources.push(builtin)
  }
  for (const [index, source] of (patterns || []).entries()) {
    try {
      sources.push({ name: `config-${index}`, pattern: new RegExp(source, 'g') })
    } catch (error) {
      logger.warn('ignoring invalid redactPatterns entry', { index, message: error && error.message })
    }
  }

  return {
    patterns: sources.map((item) => item.name),
    /**
     * Redact every configured and built-in secret pattern.
     * @param text - arbitrary text (may be null).
     * @returns the redacted text, or '' for non-string input.
     */
    redact(text) {
      if (typeof text !== 'string' || !text) return ''
      let result = text
      for (const source of sources) {
        // `lastIndex` is stateful on global regexes; reset before every pass.
        source.pattern.lastIndex = 0
        result = result.replace(source.pattern, (match, prefix, suffix) => {
          if (typeof prefix === 'string' && typeof suffix === 'string') return `${prefix}[redacted]${suffix}`
          return '[redacted]'
        })
      }
      return result
    },
  }
}

/** JSON.stringify that never throws. */
export function safeJson(value, limit = 2000) {
  try {
    const text = JSON.stringify(value)
    if (typeof text !== 'string') return String(value)
    return text.length > limit ? `${text.slice(0, limit)}…` : text
  } catch {
    return '[unserializable]'
  }
}

/**
 * Create the plugin logger.
 * @param ctx - Cordis context of the plugin fiber.
 * @param config - normalized plugin configuration (uses `logLevel`).
 * @returns a tiny leveled logger writing through the Host logger.
 */
export function createLogger(ctx, config) {
  const threshold = LEVELS[config.logLevel] ?? LEVELS.info
  let hostLogger = null
  try {
    if (typeof ctx.logger === 'function') hostLogger = ctx.logger('fca-memory-bridge')
  } catch {
    hostLogger = null
  }

  function emit(level, message, fields) {
    if (threshold < (LEVELS[level] ?? LEVELS.info)) return
    const text = fields === undefined ? String(message) : `${message} ${safeJson(fields)}`
    try {
      if (hostLogger && typeof hostLogger[level] === 'function') hostLogger[level](text)
      else if (typeof console[level] === 'function') console[level](`[fca-memory-bridge] ${text}`)
    } catch {
      // Logging must never break the Host.
    }
  }

  return {
    level: config.logLevel,
    error: (message, fields) => emit('error', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    info: (message, fields) => emit('info', message, fields),
    debug: (message, fields) => emit('debug', message, fields),
  }
}
