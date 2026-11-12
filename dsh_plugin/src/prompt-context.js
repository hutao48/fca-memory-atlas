/**
 * Optional prompt-context injection.
 *
 * Adds one small FCA memory digest to the model prompt. The digest is a cached
 * snapshot because `systemPrompt.context` providers are synchronous: the
 * registry assembly cannot await HTTP. The cache is refreshed asynchronously
 * (after connect, after memory tool calls, and on a slow timer), so the next
 * model step sees a recent digest instead of blocking prompt assembly.
 *
 * Off by default (`injectContext: false`): the user opts in from the plugin
 * configuration.
 *
 * @module dsh-plugin-fca-memory/src/prompt-context
 */

/** Prompt context registration name (unique across the profile). */
const CONTEXT_NAME = 'fca-memory-digest'

/** Prompt context order: late, after the Host's own runtime contexts. */
const CONTEXT_ORDER = 900

/** Refresh interval of the cached digest. */
const REFRESH_INTERVAL_MS = 60000

/** Upper bound of the digest text injected into the system prompt. */
const MAX_DIGEST_CHARS = 700

function clip(text, limit) {
  const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/**
 * Register the FCA context contribution (only when `injectContext` is enabled).
 * @param options.ctx - context with the `systemPrompt` service.
 * @param options.config - normalized plugin configuration.
 * @param options.bridge - bridge holding the client and connection state.
 * @param options.prompt - digest holder shared with the bridge.
 * @param options.state - bridge state (for `prompt.*` bookkeeping).
 * @param options.logger - plugin logger.
 */
export function registerPromptContext({ ctx, config, bridge, prompt, state, logger }) {
  if (!config.injectContext) {
    logger.debug('prompt context injection disabled by configuration')
    return
  }

  let digest = ''
  let refreshing = false
  let timer = null
  let disposed = false

  async function refresh() {
    if (disposed || refreshing) return
    if (!state.connected) return
    refreshing = true
    try {
      const lines = []
      const stateResult = await bridge.client.getState()
      if (stateResult.ok && stateResult.data) {
        const data = stateResult.data
        const identity = data.identity && typeof data.identity === 'object' ? data.identity : null
        const cognition = data.cognition && typeof data.cognition === 'object' ? data.cognition : null
        if (identity && typeof identity.display_name === 'string') {
          lines.push(`Identity: ${clip(identity.display_name, 80)}${identity.summary ? ` — ${clip(identity.summary, 140)}` : ''}`)
        }
        if (cognition && typeof cognition.focus === 'string' && cognition.focus.trim()) {
          lines.push(`Current focus: ${clip(cognition.focus, 160)}`)
        }
        const attention = Array.isArray(cognition?.attention_targets) ? cognition.attention_targets.slice(0, 3) : []
        const working = Array.isArray(cognition?.working_memory) ? cognition.working_memory.slice(0, 3) : []
        const ids = [...new Set([...attention, ...working])].filter((id) => typeof id === 'string')
        for (const id of ids) {
          const memory = await bridge.client.getMemory(id)
          if (!memory.ok || !memory.data || !memory.data.memory) continue
          const item = memory.data.memory
          lines.push(`Relevant memory: ${clip(item.title, 120)}${item.body ? ` — ${clip(item.body, 200)}` : ''} (id ${item.id})`)
        }
      }
      if (lines.length === 0) {
        digest = ''
      } else {
        const header = 'The following is a local FCA Memory Atlas digest (read-only context; use fca_memory_search for more):'
        digest = clip([header, ...lines].join('\n'), MAX_DIGEST_CHARS)
      }
      state.prompt.refreshedAt = new Date().toISOString()
      state.prompt.textLength = digest.length
      state.prompt.lastError = null
      prompt.text = () => digest
    } catch (error) {
      state.prompt.lastError = error && error.message ? error.message : String(error)
      logger.debug('prompt digest refresh failed', { message: state.prompt.lastError })
    } finally {
      refreshing = false
    }
  }

  prompt.refresh = refresh

  // Registration is effect-owned by the passed context.
  ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    text: () => digest,
  })

  timer = setInterval(() => {
    void refresh()
  }, REFRESH_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()

  void refresh()

  ctx.effect(() => () => {
    disposed = true
    if (timer) clearInterval(timer)
    timer = null
  })

  logger.info('prompt context injection enabled')
}
