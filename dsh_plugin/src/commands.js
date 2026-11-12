/**
 * `/fca` command registration.
 *
 * A human command is a direct UI action: it runs without sending a message to
 * the model. It reports the same status `fca_status` returns to the Agent, in
 * one line, so a user can check connectivity from the composer.
 *
 * Registered through `ctx.commands.register(CommandDefinition)`; the definition
 * is effect-owned by the context that carries the `commands` service.
 *
 * @module dsh-plugin-fca-memory/src/commands
 */

/**
 * Register the `fca` human command.
 * @param options.ctx - context with the `commands` service.
 * @param options.config - normalized plugin configuration.
 * @param options.bridge - bridge exposing `statusLine()` and `status()`.
 */
export function registerCommands({ ctx, config, bridge }) {
  ctx.commands.register({
    name: 'fca',
    description: 'Show FCA Memory Atlas bridge status (Runtime connection, capture queue, last error).',
    input: { hint: '[status]' },
    recordInput: false,
    async handler(invocation) {
      try {
        const argument = String(invocation?.rawInput ?? '').trim()
        if (argument && argument !== 'status') {
          return { kind: 'error', text: `Unknown /fca argument "${argument}". Try /fca or /fca status.` }
        }
        const status = await bridge.status()
        const runtime = status.runtime
        const lines = [
          bridge.statusLine(),
          `Runtime: ${runtime.url} · reachable=${runtime.reachable} · version=${runtime.version ?? '—'} · api=${runtime.api_version ?? '—'}`,
          `Capture: policy=${status.capture.policy} queued=${status.capture.queued} sent=${status.capture.counters.sent} failed=${status.capture.counters.failed} dropped=${status.capture.counters.dropped}`,
          `Paths: home=${status.local.fcaHome} token=${status.local.tokenPresent ? 'present' : 'missing'}`,
        ]
        if (status.lastError) lines.push(`Last error: ${status.lastError.code} — ${status.lastError.message}`)
        return { kind: 'success', text: lines.join('\n') }
      } catch (error) {
        return { kind: 'error', text: `fca: ${error && error.message ? error.message : String(error)}` }
      }
    },
  })
}
