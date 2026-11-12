/**
 * FCA Memory Atlas — DSH Host plugin (Cordis bundle entry).
 *
 * Entry for the bundle declared by package.json's `dsh.bundle.patch`. The
 * Cordis Loader imports this module, validates the exported `Config` against the
 * row's `config`, then calls `apply(ctx, config)`; the returned resources are
 * owned by that plugin fiber and removed when it unloads.
 *
 * Responsibilities:
 * - connect to the local FCA Runtime (contract: docs/PUBLIC_INTERFACE_FREEZE.md),
 *   optionally starting it with a detected Node runtime;
 * - register the memory tools `fca_memory_search` / `fca_memory_store` /
 *   `fca_memory_get` / `fca_status`;
 * - forward selected session events as `agent.event_received` audit events;
 * - optionally inject a small memory digest into the system prompt;
 * - expose a `/fca` human command.
 *
 * Nothing in this module may throw into the Host: every failure is recorded in
 * the bridge state and reported through `fca_status`.
 *
 * @module dsh-plugin-fca-memory
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConfigSchema } from './src/config.js'
import { createBridge } from './src/bridge.js'

/** Stable plugin identity inside the Cordis registry. */
export const name = 'fca-memory-bridge'

/** Services that must exist before this plugin activates. */
export const inject = ['tools']

/** Absolute directory of this plugin package. */
const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url))

/**
 * Config schema exported to the Loader.
 *
 * `createConfigSchema()` prefers `@deepseek-ai/schemastery` (the Host's own
 * schema library, which the Plugin Manager projects into the Settings UI) and
 * falls back to a hand-written Standard Schema v1. Cordis validates through
 * `Config['~standard'].validate` either way.
 */
const configSchema = await createConfigSchema()

/** Plugin configuration schema (Standard Schema v1 compatible). */
export const Config = configSchema.schema

/** Which mechanism produced `Config`; reported by fca_status. */
export const configSchemaMechanism = configSchema.mechanism

/**
 * Activate the bridge for one plugin fiber.
 * @param ctx - Cordis context owned by this plugin row.
 * @param rawConfig - configuration validated by the Loader (defaults applied).
 */
export function apply(ctx, rawConfig) {
  let bridge
  try {
    bridge = createBridge(ctx, rawConfig, PLUGIN_ROOT)
  } catch (error) {
    try {
      ctx.logger.error('FCA bridge could not be created', error)
    } catch {
      // Host logger unavailable: remain silent rather than throw.
    }
    return
  }

  bridge.schemaMechanism = configSchema.mechanism
  const { logger, config } = bridge

  // 1) Capabilities: tools first, so the model sees them as soon as possible.
  bridge.register()

  // 2) Capture committed session events (isolation: the handler never throws).
  try {
    ctx.on('session/event', (session, event) => {
      try {
        bridge.capture.handle(session, event)
      } catch (error) {
        logger.debug('session/event capture failed', { message: error && error.message })
      }
      try {
        bridge.autoMemory.handle(session, event)
      } catch (error) {
        logger.debug('session/event auto memory failed', { message: error && error.message })
      }
    })
  } catch (error) {
    logger.warn('could not subscribe to session/event', { message: error && error.message })
  }

  // 3) Lifecycle: connect now, then poll health / retry while disconnected.
  ctx.effect(() => {
    let disposed = false
    let timer = null

    const tick = () => {
      if (disposed) return
      if (bridge.state.connected) {
        // Refresh the cached runtime facts without launching anything.
        void bridge.client.health().then((health) => {
          if (disposed) return
          if (health.reachable) bridge.state.runtime.version = health.health && health.health.version ? health.health.version : bridge.state.runtime.version
          else void bridge.connect({ allowStart: false })
        }).catch(() => {})
      } else {
        void bridge.connect({ allowStart: false }).catch(() => {})
      }
    }

    timer = setInterval(tick, config.connectIntervalMs)
    if (typeof timer.unref === 'function') timer.unref()

    // Initial connection: may launch the Runtime once (autoStartRuntime).
    void bridge.connect({ allowStart: true }).then((connected) => {
      if (disposed) return
      logger.info('bridge started', {
        runtimeUrl: config.runtimeUrl,
        connected,
        phase: bridge.state.phase,
        capturePolicy: config.capturePolicy,
        autoMemory: config.autoMemory,
        injectContext: config.injectContext,
      })
    }).catch((error) => {
      logger.error('initial Runtime connection failed', { message: error && error.message })
    })

    return () => {
      disposed = true
      if (timer) clearInterval(timer)
      timer = null
      bridge.dispose()
    }
  })

  logger.info('plugin loaded', {
    runtimeUrl: config.runtimeUrl,
    schema: configSchema.mechanism,
    capturePolicy: config.capturePolicy,
    autoMemory: config.autoMemory,
  })
}
