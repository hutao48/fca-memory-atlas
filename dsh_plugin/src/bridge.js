/**
 * Bridge orchestrator: connection lifecycle, tool handlers, prompt digest.
 *
 * One instance lives per plugin fiber. It owns the Runtime client, the event
 * capture queue and the cached prompt digest, and exposes the operations the
 * registered tools and the `/fca` command call.
 *
 * Failure model: nothing here throws into the Host. Every entry point returns a
 * structured result and records the failure in `state.lastError`, which
 * `fca_status` and `/fca` report.
 *
 * @module dsh-plugin-fca-memory/src/bridge
 */

import {
  FCA_API_VERSION,
  PLUGIN_VERSION,
  normalizeConfig,
  resolveFcaHome,
  resolveTokenPath,
  findNodeRuntime,
  findRuntimeScript,
} from './config.js'
import { createLogger, createRedactor, safeJson } from './logger.js'
import { RuntimeClient } from './client.js'
import { startRuntime, fileInfo } from './launcher.js'
import { createCapture } from './capture.js'
import { createAutoMemory } from './auto-memory.js'
import { registerTools } from './tools.js'
import { registerPromptContext } from './prompt-context.js'
import { registerCommands } from './commands.js'

const MEMORY_TYPES = ['working', 'episodic', 'semantic', 'procedural', 'autobiographical', 'project', 'relational', 'emotional']
const MEMORY_ID = /^mem_[0-9a-f]{32}$/

const SEARCH_MODES = ['fulltext', 'semantic', 'hybrid']

function nowIso() {
  return new Date().toISOString()
}

function truncate(text, limit) {
  const value = typeof text === 'string' ? text : ''
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/** Short memory projection for tool output (keeps model tokens bounded). */
function memorySummary(memory) {
  if (!memory || typeof memory !== 'object') return null
  return {
    id: memory.id ?? null,
    title: memory.title ?? null,
    memory_type: memory.memory_type ?? null,
    occurred_at: memory.occurred_at ?? null,
    importance: typeof memory.importance === 'number' ? memory.importance : null,
    display_weight: typeof memory.display_weight === 'number' ? memory.display_weight : null,
    tags: Array.isArray(memory.tag_names) ? memory.tag_names : Array.isArray(memory.tags) ? memory.tags : [],
    version: typeof memory.version === 'number' ? memory.version : null,
    updated_at: memory.updated_at ?? null,
    deleted: Boolean(memory.deleted_at),
  }
}

/**
 * Create the bridge for one plugin fiber.
 * @param ctx - Cordis context of the plugin fiber.
 * @param rawConfig - validated (or raw) plugin config.
 * @param pluginRoot - absolute plugin package directory.
 */
export function createBridge(ctx, rawConfig, pluginRoot) {
  const config = normalizeConfig(rawConfig)
  const logger = createLogger(ctx, config)
  const redactor = createRedactor(config.redactPatterns, logger)
  const fcaHome = resolveFcaHome(config)
  const tokenPath = resolveTokenPath(config, fcaHome)
  const client = new RuntimeClient({ config, logger, tokenPath })

  const state = {
    phase: 'starting',
    connected: false,
    startedAt: nowIso(),
    lastConnectAt: null,
    lastConnectedAt: null,
    connectAttempts: 0,
    runtime: {
      url: config.runtimeUrl,
      reachable: false,
      httpStatus: null,
      version: null,
      apiVersion: null,
      compatible: null,
      uptimeMs: null,
      db: null,
      status: null,
      error: null,
    },
    autoStart: null,
    lastError: null,
    prompt: { enabled: config.injectContext, refreshedAt: null, textLength: 0, lastError: null },
    disposed: false,
  }

  /** The prompt digest writer is installed by the prompt-context registration. */
  const prompt = {
    refresh: async () => {},
    text: () => '',
  }

  /** Event capture queue (policy/redaction/retry live in its own module). */
  const capture = createCapture({ config, logger, client, redactor, state })

  /** Fully automatic memory writer (turns conversation text into real memories). */
  const autoMemory = createAutoMemory({ config, logger, client, redactor, state })

  function noteError(code, message) {
    state.lastError = { at: nowIso(), code: code || 'UNKNOWN', message: String(message || '') }
  }

  function applyHealth(health) {
    state.lastConnectAt = nowIso()
    if (!health || !health.reachable) {
      // A Runtime that stopped answering must not keep its last known version
      // and compatibility: fca_status has to reflect the current reality.
      state.connected = false
      state.phase = 'unreachable'
      state.runtime = {
        url: config.runtimeUrl,
        reachable: false,
        httpStatus: health ? health.httpStatus : null,
        version: null,
        apiVersion: null,
        compatible: null,
        uptimeMs: null,
        db: null,
        status: null,
        error: health ? health.message : 'no health response',
      }
      return false
    }
    const body = health.health && typeof health.health === 'object' ? health.health : {}
    const compatible = health.apiVersion === FCA_API_VERSION
    const degraded = body.status === 'degraded'
    state.connected = compatible
    state.phase = compatible ? (degraded ? 'degraded' : 'connected') : 'incompatible'
    state.runtime = {
      url: config.runtimeUrl,
      reachable: true,
      httpStatus: health.httpStatus,
      version: typeof body.version === 'string' ? body.version : null,
      apiVersion: health.apiVersion,
      compatible,
      uptimeMs: typeof body.uptime_ms === 'number' ? body.uptime_ms : null,
      db: typeof body.db === 'string' ? body.db : null,
      status: typeof body.status === 'string' ? body.status : null,
      error: compatible ? null : `Runtime API version ${health.apiVersion} is incompatible with this plugin (expects ${FCA_API_VERSION})`,
    }
    if (compatible) {
      state.lastConnectedAt = nowIso()
    } else {
      noteError('API_INCOMPATIBLE', state.runtime.error)
    }
    return compatible
  }

  /**
   * Probe health and, when allowed, start the Runtime once.
   * @param options.allowStart - whether a missing Runtime may be launched.
   * @returns true when the Runtime is reachable and compatible.
   */
  async function connect(options = {}) {
    if (state.disposed) return false
    const allowStart = options.allowStart !== false
    state.connectAttempts += 1
    state.phase = 'starting'
    let health = await client.health()
    if (health.reachable) {
      applyHealth(health)
      // Deliver events that queued while the Runtime was away.
      void capture.flushNow()
      void autoMemory.flushNow()
      void prompt.refresh()
      return state.connected
    }

    if (allowStart && config.autoStartRuntime && !state.autoStart?.attempted) {
      const report = await startRuntime({ config, logger, client, pluginRoot })
      state.autoStart = {
        ...report,
        node: report.node,
        script: report.script,
        health: undefined,
      }
      if (report.started && report.health) {
        applyHealth(report.health)
        // A previously unreachable Runtime is now up: deliver anything that
        // queued while it was away (audit events and auto memories).
        void capture.flushNow()
        void autoMemory.flushNow()
        void prompt.refresh()
        return state.connected
      }
      noteError('AUTO_START_FAILED', report.error || 'Runtime could not be started')
    }

    applyHealth(health)
    if (!state.connected && !state.lastError) {
      noteError(health.code || 'RUNTIME_UNREACHABLE', health.message || 'FCA Runtime is not reachable')
    }
    return state.connected
  }

  /** Ensure a usable connection (token included) before a memory tool call. */
  async function ensureReady() {
    if (state.disposed) return false
    if (state.connected && client.hasToken()) return true
    await connect({ allowStart: true })
    if (state.connected && !client.hasToken()) {
      noteError('NO_TOKEN', `Runtime is reachable but the token file is missing: ${tokenPath}`)
      return false
    }
    return state.connected
  }

  function failureResult(result, hint) {
    const value = {
      ok: false,
      error: {
        code: result.code || 'RUNTIME_ERROR',
        message: result.message || 'FCA Runtime request failed',
      },
      runtime: { url: config.runtimeUrl, version: state.runtime.version, api_version: state.runtime.apiVersion },
    }
    if (result.traceId) value.error.trace_id = result.traceId
    if (hint) value.hint = hint
    return value
  }

  function runtimeTag() {
    return { url: config.runtimeUrl, version: state.runtime.version, api_version: state.runtime.apiVersion }
  }

  const bridge = {
    config,
    logger,
    client,
    state,
    prompt,
    fcaHome,
    tokenPath,
    pluginRoot,
    noteError,
    connect,
    ensureReady,

    /** `fca_memory_search` implementation. */
    async search(args, exec) {
      const query = typeof args?.query === 'string' ? args.query : ''
      if (!query.trim()) return { ok: false, error: { code: 'BAD_REQUEST', message: 'query must be a non-empty string' } }
      const ready = await ensureReady()
      if (!ready) {
        return {
          ok: false,
          error: { code: state.runtime.reachable ? 'RUNTIME_NOT_READY' : 'RUNTIME_UNREACHABLE', message: state.lastError ? state.lastError.message : 'FCA Runtime is not available' },
          hint: 'Start the FCA Runtime (runtime/bin/fca-runtime.js serve) or enable autoStartRuntime, then retry.',
        }
      }
      const mode = SEARCH_MODES.includes(args?.mode) ? args.mode : 'hybrid'
      const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 50) : 10
      const filters = {}
      if (typeof args?.memory_type === 'string' && MEMORY_TYPES.includes(args.memory_type)) filters.memory_type = args.memory_type
      if (Array.isArray(args?.tags) && args.tags.length) filters.tags = args.tags.filter((tag) => typeof tag === 'string').slice(0, 20)
      if (typeof args?.occurred_from === 'string') filters.from = args.occurred_from
      if (typeof args?.occurred_to === 'string') filters.to = args.occurred_to
      const searchBody = { query: query.slice(0, 2000), mode, filters, limit }
      // `include_deleted` is a top-level search option in the frozen contract.
      if (args?.include_deleted === true) searchBody.include_deleted = true

      const result = await client.searchMemory(searchBody)
      if (!result.ok) {
        void connect({ allowStart: false })
        return failureResult(result, 'FCA Runtime returned an error; check fca_status.')
      }
      const items = Array.isArray(result.data?.items) ? result.data.items : []
      void prompt.refresh()
      return {
        ok: true,
        query,
        mode,
        took_ms: typeof result.data?.took_ms === 'number' ? result.data.took_ms : null,
        count: items.length,
        next_cursor: result.data?.next_cursor ?? null,
        items: items.map((item) => ({
          ...memorySummary(item?.memory ?? item),
          score: typeof item?.score === 'number' ? item.score : null,
          excerpt: truncate(item?.memory?.body ?? '', 400) || null,
        })),
        runtime: runtimeTag(),
      }
    },

    /** `fca_memory_store` implementation. */
    async store(args, exec) {
      const title = typeof args?.title === 'string' ? args.title.trim() : ''
      const body = typeof args?.body === 'string' ? args.body : ''
      if (!title) return { ok: false, error: { code: 'BAD_REQUEST', message: 'title must be a non-empty string' } }
      if (!body.trim()) return { ok: false, error: { code: 'BAD_REQUEST', message: 'body must be a non-empty string' } }
      const ready = await ensureReady()
      if (!ready) {
        return {
          ok: false,
          error: { code: state.runtime.reachable ? 'RUNTIME_NOT_READY' : 'RUNTIME_UNREACHABLE', message: state.lastError ? state.lastError.message : 'FCA Runtime is not available' },
          hint: 'Start the FCA Runtime (runtime/bin/fca-runtime.js serve) or enable autoStartRuntime, then retry.',
        }
      }
      const sessionId = exec && exec.agent && typeof exec.agent.id === 'string' ? exec.agent.id : null
      const payload = {
        title: title.slice(0, 500),
        body,
        memory_type: MEMORY_TYPES.includes(args?.memory_type) ? args.memory_type : 'episodic',
        origin: 'agent',
        source: {
          type: 'agent',
          ref: 'dsh-plugin',
          note: sessionId ? `dsh session ${sessionId}` : 'dsh agent',
        },
      }
      if (typeof args?.occurred_at === 'string') payload.occurred_at = args.occurred_at
      if (typeof args?.importance === 'number') payload.importance = Math.min(Math.max(args.importance, 0), 1)
      if (Array.isArray(args?.tags)) payload.tags = args.tags.filter((tag) => typeof tag === 'string' && tag.trim()).slice(0, 20).map((tag) => tag.trim())
      if (Array.isArray(args?.participants)) {
        payload.participants = args.participants
          .map((item) => {
            if (typeof item === 'string' && item.trim()) return { name: item.trim() }
            if (item && typeof item === 'object' && typeof item.name === 'string' && item.name.trim()) return { name: item.name.trim() }
            return null
          })
          .filter(Boolean)
          .slice(0, 20)
      }
      if (typeof args?.project === 'string' && args.project.trim()) payload.project = { name: args.project.trim() }
      if (typeof args?.source_note === 'string' && args.source_note.trim()) payload.source.note = args.source_note.trim().slice(0, 200)

      const result = await client.storeMemory(payload)
      if (!result.ok) {
        void connect({ allowStart: false })
        return failureResult(result, 'FCA Runtime rejected the memory; check fca_status.')
      }
      const memory = result.data?.memory ?? result.data
      void prompt.refresh()
      return {
        ok: true,
        memory: memorySummary(memory),
        runtime: runtimeTag(),
      }
    },

    /** `fca_memory_get` implementation. */
    async get(args) {
      const id = typeof args?.id === 'string' ? args.id.trim() : ''
      if (!MEMORY_ID.test(id)) {
        return { ok: false, error: { code: 'BAD_REQUEST', message: `id must match mem_<32 lowercase hex>, received ${JSON.stringify(args?.id)}` } }
      }
      const ready = await ensureReady()
      if (!ready) {
        return {
          ok: false,
          error: { code: state.runtime.reachable ? 'RUNTIME_NOT_READY' : 'RUNTIME_UNREACHABLE', message: state.lastError ? state.lastError.message : 'FCA Runtime is not available' },
          hint: 'Start the FCA Runtime (runtime/bin/fca-runtime.js serve) or enable autoStartRuntime, then retry.',
        }
      }
      const version = Number.isInteger(args?.version) && args.version > 0 ? args.version : undefined
      const result = await client.getMemory(id, version)
      if (!result.ok) {
        void connect({ allowStart: false })
        return failureResult(result, result.code === 'NOT_FOUND' ? 'No memory with this id exists (or it was hard-deleted).' : undefined)
      }
      const memory = result.data?.memory ?? null
      const relations = Array.isArray(result.data?.relations) ? result.data.relations : []
      return {
        ok: true,
        memory: memory
          ? {
              ...memorySummary(memory),
              body: truncate(memory.body, 4000),
              body_truncated: typeof memory.body === 'string' && memory.body.length > 4000,
              participants: Array.isArray(memory.participants) ? memory.participants : [],
              project: memory.project ?? null,
              occurred_precision: memory.occurred_precision ?? null,
              created_at: memory.created_at ?? null,
              created_by: memory.created_by ?? null,
            }
          : null,
        relations: relations.slice(0, 20).map((relation) => ({
          id: relation?.id ?? null,
          relation_type: relation?.relation_type ?? null,
          from: relation?.from ?? null,
          to: relation?.to ?? null,
          label: relation?.label ?? null,
        })),
        versions_count: typeof result.data?.versions_count === 'number' ? result.data.versions_count : null,
        layout: result.data?.layout ?? null,
        runtime: runtimeTag(),
      }
    },

    /** `fca_status` implementation: connection, capture, prompt and local paths. */
    async status() {
      if (!state.connected) {
        // A status call is a natural moment to re-probe and, when allowed,
        // launch the Runtime once. Repeated spawns are prevented by autoStart.attempted.
        await connect({ allowStart: !state.autoStart?.attempted })
      }
      const node = findNodeRuntime(config, process.env, pluginRoot)
      const script = findRuntimeScript(config, pluginRoot)
      return {
        ok: true,
        plugin: {
          name: 'dsh-plugin-fca-memory',
          version: PLUGIN_VERSION,
          phase: state.disposed ? 'stopped' : state.phase,
          started_at: state.startedAt,
          config_schema: bridge.schemaMechanism ?? null,
        },
        runtime: {
          url: config.runtimeUrl,
          reachable: state.runtime.reachable,
          http_status: state.runtime.httpStatus,
          version: state.runtime.version,
          api_version: state.runtime.apiVersion,
          compatible: state.runtime.compatible,
          status: state.runtime.status,
          db: state.runtime.db,
          uptime_ms: state.runtime.uptimeMs,
          error: state.runtime.error,
          last_connected_at: state.lastConnectedAt,
          connect_attempts: state.connectAttempts,
        },
        capture: capture.stats(),
        auto_memory: autoMemory.stats(),
        prompt_context: {
          enabled: state.prompt.enabled,
          refreshed_at: state.prompt.refreshedAt,
          text_length: state.prompt.textLength,
          error: state.prompt.lastError,
        },
        auto_start: state.autoStart
          ? {
              attempted: state.autoStart.attempted,
              started: state.autoStart.started,
              node: state.autoStart.node,
              node_source: state.autoStart.nodeSource,
              script: state.autoStart.script,
              pid: state.autoStart.pid,
              error: state.autoStart.error,
              stderr: truncate(state.autoStart.stderr, 400),
            }
          : { attempted: false },
        config: {
          capturePolicy: config.capturePolicy,
          autoMemory: config.autoMemory,
          autoMemoryMinChars: config.autoMemoryMinChars,
          autoMemoryMaxChars: config.autoMemoryMaxChars,
          autoMemoryMaxPerHour: config.autoMemoryMaxPerHour,
          autoMemoryMemoryType: config.autoMemoryMemoryType,
          injectContext: config.injectContext,
          autoStartRuntime: config.autoStartRuntime,
          maxEventBytes: config.maxEventBytes,
          eventQueueLimit: config.eventQueueLimit,
          requestTimeoutMs: config.requestTimeoutMs,
          logLevel: config.logLevel,
          redactPatterns: redactor.patterns,
        },
        local: {
          fcaHome,
          fcaHomeExists: fileInfo(fcaHome).exists,
          tokenPath,
          tokenPresent: client.hasToken(),
          runtimeScriptPath: script,
          runtimeScriptPresent: Boolean(script),
          nodePath: node.path,
          nodeSource: node.source,
        },
        lastError: state.lastError,
      }
    },

    /** One-line status used by the `/fca` command. */
    statusLine() {
      const runtime = state.runtime
      const auto = autoMemory.stats()
      if (state.connected) {
        return `FCA Runtime 已连接：${config.runtimeUrl}（版本 ${runtime.version ?? '未知'}，API v${runtime.apiVersion ?? '?'}）· 采集策略 ${config.capturePolicy} · 自动记忆 ${auto.mode}（已存 ${auto.counters.stored}）· 队列 ${capture.stats().queued}`
      }
      const reason = runtime.error || (state.lastError && state.lastError.message) || '未连接'
      return `FCA Runtime 未连接：${reason}。启动方式：runtime/bin/fca-runtime.js serve（或设置 autoStartRuntime=true）。`
    },
  }

  /** Wire the optional registrations. */
  bridge.register = () => {
    const disposers = []
    try {
      registerTools({ ctx, config, bridge })
    } catch (error) {
      logger.error('tool registration failed', { message: error && error.message })
      noteError('TOOL_REGISTRATION_FAILED', error && error.message)
    }
    try {
      ctx.inject(['commands'], (child) => {
        try {
          registerCommands({ ctx: child, config, bridge })
        } catch (error) {
          logger.warn('command registration failed', { message: error && error.message })
        }
      })
    } catch (error) {
      logger.debug('commands service unavailable', { message: error && error.message })
    }
    try {
      ctx.inject(['systemPrompt'], (child) => {
        try {
          registerPromptContext({ ctx: child, config, bridge, prompt, state, logger })
        } catch (error) {
          logger.warn('prompt context registration failed', { message: error && error.message })
          state.prompt.lastError = error && error.message ? error.message : String(error)
        }
      })
    } catch (error) {
      logger.debug('systemPrompt service unavailable', { message: error && error.message })
    }
    return disposers
  }

  /** Capture the plugin's own teardown. */
  bridge.dispose = () => {
    state.disposed = true
    state.phase = 'stopped'
    try {
      capture.dispose()
    } catch {
      // ignore
    }
    try {
      autoMemory.dispose()
    } catch {
      // ignore
    }
    try {
      client.abort()
    } catch {
      // ignore
    }
  }

  /** Expose the capture controller for the session/event listener. */
  bridge.capture = capture
  /** Expose the automatic memory writer for the session/event listener. */
  bridge.autoMemory = autoMemory
  bridge.safeJson = safeJson

  return bridge
}
