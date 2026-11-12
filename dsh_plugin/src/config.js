/**
 * Configuration surface of the FCA Memory Atlas bridge.
 *
 * The plugin exports `Config`, which Cordis validates before `apply()` runs
 * (`resolveConfig` in @deepseek-ai/cordis reads `Config['~standard'].validate`).
 * The primary schema uses `@deepseek-ai/schemastery` — the same schema library
 * the shipped Harness plugins use — so the Plugin Manager can project it into
 * the Settings UI. If that package cannot be imported from the Host's module
 * scope, a hand-written Standard Schema v1 with identical validation is used
 * instead, so configuration always validates.
 *
 * @module dsh-plugin-fca-memory/src/config
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Plugin package version (mirrors package.json). */
export const PLUGIN_VERSION = '0.1.4'

/** FCA HTTP API major version this plugin speaks (contract §8). */
export const FCA_API_VERSION = '1'

/** Client identity sent as `X-FCA-Client` (contract §0). */
export const CLIENT_ID = 'dsh-plugin'

/** Default FCA Local Runtime origin. */
export const DEFAULT_RUNTIME_URL = 'http://127.0.0.1:17860'

/** Allowed capture policies, safest first. */
export const CAPTURE_POLICIES = ['off', 'user-messages', 'turn-summaries', 'full']

/** Automatic memory modes: off | user messages only | user + assistant messages. */
export const AUTO_MEMORY_MODES = ['off', 'user-messages', 'all']

/** Memory types accepted by the FCA contract (§2). */
export const MEMORY_TYPES = [
  'working',
  'episodic',
  'semantic',
  'procedural',
  'autobiographical',
  'project',
  'relational',
  'emotional',
]

/** Field catalogue: type, default and meaning of every configuration key. */
export const CONFIG_FIELDS = {
  runtimeUrl: {
    type: 'string',
    default: DEFAULT_RUNTIME_URL,
    description: 'FCA Local Runtime origin, e.g. http://127.0.0.1:17860.',
  },
  fcaHome: {
    type: 'string',
    default: '',
    description: 'FCA data directory. Empty resolves $FCA_HOME, else %LOCALAPPDATA%\\FCA-Memory-Atlas.',
  },
  tokenPath: {
    type: 'string',
    default: '',
    description: 'Runtime bearer-token file. Empty resolves <fcaHome>/config/runtime-token.',
  },
  autoStartRuntime: {
    type: 'boolean',
    default: true,
    description: 'Try to launch runtime/bin/fca-runtime.js when the Runtime is not reachable.',
  },  runtimeScriptPath: {
    type: 'string',
    default: '',
    description: 'Explicit path to runtime/bin/fca-runtime.js. Empty auto-detects it.',
  },
  nodePath: {
    type: 'string',
    default: '',
    description: 'Node executable used to start the Runtime. Empty detects a bundled Node 24.',
  },
  startTimeoutMs: {
    type: 'integer',
    default: 15000,
    description: 'How long to wait for a launched Runtime to answer /health.',
  },
  capturePolicy: {
    type: 'enum',
    values: CAPTURE_POLICIES,
    default: 'turn-summaries',
    description: 'Which session events are forwarded to the Runtime: off | user-messages | turn-summaries | full.',
  },
  redactPatterns: {
    type: 'array',
    default: [],
    description: 'Extra regular expressions whose matches are replaced with [redacted] before any upload.',
  },
  injectContext: {
    type: 'boolean',
    default: false,
    description: 'Inject a small FCA memory digest into the model prompt (off by default).',
  },
  maxEventBytes: {
    type: 'integer',
    default: 8192,
    description: 'Upper bound of one captured event payload after truncation.',
  },
  eventQueueLimit: {
    type: 'integer',
    default: 200,
    description: 'Maximum number of queued events waiting for the Runtime.',
  },
  autoMemory: {
    type: 'enum',
    values: AUTO_MEMORY_MODES,
    default: 'off',
    description:
      'Fully automatic memory writing: off | user-messages (save every user message from every DSH session) | all (user + assistant messages).',
  },
  autoMemoryMinChars: {
    type: 'integer',
    default: 8,
    description: 'Auto-memory: ignore messages shorter than this many characters.',
  },
  autoMemoryMaxChars: {
    type: 'integer',
    default: 2000,
    description: 'Auto-memory: body length cap per stored memory.',
  },
  autoMemoryMaxPerHour: {
    type: 'integer',
    default: 120,
    description: 'Auto-memory: hard rate limit (memories per rolling hour).',
  },
  autoMemoryMemoryType: {
    type: 'enum',
    values: MEMORY_TYPES,
    default: 'episodic',
    description: 'Auto-memory: memory_type used for captured conversation messages.',
  },
  autoMemoryTags: {
    type: 'array',
    default: ['DSH自动记忆'],
    description: 'Auto-memory: tag names attached to every captured memory.',
  },
  requestTimeoutMs: {
    type: 'integer',
    default: 5000,
    description: 'Timeout of one Runtime HTTP request.',
  },
  healthTimeoutMs: {
    type: 'integer',
    default: 1500,
    description: 'Timeout of one Runtime /health probe.',
  },
  connectIntervalMs: {
    type: 'integer',
    default: 30000,
    description: 'How often the plugin re-probes Runtime health while disconnected.',
  },
  logLevel: {
    type: 'enum',
    values: ['silent', 'error', 'info', 'debug'],
    default: 'info',
    description: 'Plugin log verbosity. Tokens and memory bodies are never logged.',
  },
}

/** Default configuration values. */
export function defaultConfig() {
  const result = {}
  for (const [key, field] of Object.entries(CONFIG_FIELDS)) {
    result[key] = Array.isArray(field.default) ? field.default.slice() : field.default
  }
  return result
}

function asString(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function asPositiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * Validate and normalize a raw loader config object.
 * @param raw - configuration object from cordis.patch.yml (possibly partial).
 * @returns the complete, normalized configuration.
 * @throws TypeError with a human-readable message when a value is unusable.
 */
export function normalizeConfig(raw) {
  const base = defaultConfig()
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const config = { ...base }

  config.runtimeUrl = asString(input.runtimeUrl, base.runtimeUrl).trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s]+$/i.test(config.runtimeUrl)) {
    throw new TypeError(`runtimeUrl must be an absolute http(s) URL, received ${JSON.stringify(input.runtimeUrl)}`)
  }
  config.fcaHome = asString(input.fcaHome, base.fcaHome).trim()
  config.tokenPath = asString(input.tokenPath, base.tokenPath).trim()
  config.autoStartRuntime = asBoolean(input.autoStartRuntime, base.autoStartRuntime)
  config.runtimeScriptPath = asString(input.runtimeScriptPath, base.runtimeScriptPath).trim()
  config.nodePath = asString(input.nodePath, base.nodePath).trim()
  config.startTimeoutMs = asPositiveInt(input.startTimeoutMs, base.startTimeoutMs)

  const policy = asString(input.capturePolicy, base.capturePolicy)
  if (!CAPTURE_POLICIES.includes(policy)) {
    throw new TypeError(`capturePolicy must be one of ${CAPTURE_POLICIES.join(' | ')}, received ${JSON.stringify(input.capturePolicy)}`)
  }
  config.capturePolicy = policy

  if (Array.isArray(input.redactPatterns)) {
    config.redactPatterns = input.redactPatterns
      .filter((item) => typeof item === 'string' && item.length > 0)
      .slice(0, 64)
  }

  config.injectContext = asBoolean(input.injectContext, base.injectContext)
  config.maxEventBytes = Math.min(asPositiveInt(input.maxEventBytes, base.maxEventBytes), 1024 * 1024)
  config.eventQueueLimit = Math.min(asPositiveInt(input.eventQueueLimit, base.eventQueueLimit), 5000)

  const autoMemory = asString(input.autoMemory, base.autoMemory)
  if (!AUTO_MEMORY_MODES.includes(autoMemory)) {
    throw new TypeError(
      `autoMemory must be one of ${AUTO_MEMORY_MODES.join(' | ')}, received ${JSON.stringify(input.autoMemory)}`,
    )
  }
  config.autoMemory = autoMemory
  config.autoMemoryMinChars = Math.min(asPositiveInt(input.autoMemoryMinChars, base.autoMemoryMinChars), 1000)
  config.autoMemoryMaxChars = Math.min(asPositiveInt(input.autoMemoryMaxChars, base.autoMemoryMaxChars), 20_000)
  config.autoMemoryMaxPerHour = Math.min(asPositiveInt(input.autoMemoryMaxPerHour, base.autoMemoryMaxPerHour), 10_000)
  const memoryType = asString(input.autoMemoryMemoryType, base.autoMemoryMemoryType)
  config.autoMemoryMemoryType = MEMORY_TYPES.includes(memoryType) ? memoryType : base.autoMemoryMemoryType
  if (Array.isArray(input.autoMemoryTags)) {
    config.autoMemoryTags = input.autoMemoryTags
      .filter((item) => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
      .slice(0, 16)
  }
  config.requestTimeoutMs = asPositiveInt(input.requestTimeoutMs, base.requestTimeoutMs)
  config.healthTimeoutMs = asPositiveInt(input.healthTimeoutMs, base.healthTimeoutMs)
  config.connectIntervalMs = asPositiveInt(input.connectIntervalMs, base.connectIntervalMs)

  const level = asString(input.logLevel, base.logLevel)
  config.logLevel = CONFIG_FIELDS.logLevel.values.includes(level) ? level : base.logLevel
  return config
}

/** Build the fallback Standard Schema v1 document for the configuration. */
export function createStandardConfigSchema() {
  return {
    '~standard': {
      version: 1,
      vendor: 'dsh-plugin-fca-memory',
      validate(value) {
        try {
          return { value: normalizeConfig(value) }
        } catch (error) {
          return { issues: [{ message: error && error.message ? error.message : String(error) }] }
        }
      },
    },
  }
}

/**
 * Resolve the schema exported as `Config`.
 *
 * Tries `@deepseek-ai/schemastery` first (the Host's own schema library, which
 * also gives the Plugin Manager a projectable JSON Schema), and falls back to
 * the Standard Schema above when it is unavailable.
 * @returns the schema document plus the mechanism that produced it.
 */
export async function createConfigSchema() {
  try {
    const imported = await import('@deepseek-ai/schemastery')
    const z = imported && (imported.default ?? imported)
    if (!z || typeof z.object !== 'function') throw new Error('schemastery object() is unavailable')
    const shape = {}
    for (const [key, field] of Object.entries(CONFIG_FIELDS)) {
      let schema
      if (field.type === 'boolean') schema = z.boolean()
      else if (field.type === 'integer') schema = z.number().step(1)
      else if (field.type === 'array') schema = z.array(z.string())
      else if (field.type === 'enum') schema = z.union(field.values.map((value) => z.const(value)))
      else schema = z.string()
      shape[key] = schema.default(field.default).description(field.description)
    }
    const schema = z.object(shape)
    // Probe the schema once so a shape mismatch is caught here, not at activation.
    const probe = schema['~standard'].validate({})
    if (!probe || probe.issues) throw new Error('schemastery schema rejected the default configuration')
    return { schema, mechanism: 'schemastery' }
  } catch {
    return { schema: createStandardConfigSchema(), mechanism: 'standard-schema' }
  }
}

/** Absolute directory of this plugin package. */
export function resolvePluginRoot(moduleUrl) {
  try {
    return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..')
  } catch {
    return process.cwd()
  }
}

/**
 * Resolve the FCA data directory.
 * @param config - normalized configuration.
 * @param env - environment (injectable for tests).
 */
export function resolveFcaHome(config, env = process.env) {
  if (config.fcaHome) return config.fcaHome
  if (env.FCA_HOME) return env.FCA_HOME
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(localAppData, 'FCA-Memory-Atlas')
}

/** Resolve the runtime token file path. */
export function resolveTokenPath(config, fcaHome) {
  return config.tokenPath || path.join(fcaHome, 'config', 'runtime-token')
}

/**
 * Candidate Node runtimes shipped inside the current DSH installation.
 *
 * DSH NEXT 2.0.22 keeps its bundled Node at
 * `<install-dir>\resources\runtime\<arch>\primary-runtime\dependencies\node\bin\node.exe`
 * (the pre-2.0 `%USERPROFILE%\.dsh\dsh-runtimes\...` layout was removed by a
 * DSH update). The Host process is Electron, so `process.resourcesPath` and
 * `process.execPath` are the reliable anchors; the arch directory is discovered
 * by scanning `resources\runtime` instead of hard-coding `x64`.
 * @returns {string[]} existing absolute node.exe paths, best first.
 */
function dshBundledNodeCandidates(proc = process) {
  const resourceRoots = []
  if (typeof proc.resourcesPath === 'string' && proc.resourcesPath) {
    resourceRoots.push(proc.resourcesPath)
  }
  if (proc.execPath) {
    // Electron app: <install-dir>\DSH NEXT.exe -> <install-dir>\resources.
    resourceRoots.push(path.join(path.dirname(proc.execPath), 'resources'))
  }
  const seen = new Set()
  const candidates = []
  for (const root of resourceRoots) {
    if (!root || seen.has(root)) continue
    seen.add(root)
    const runtimeRoot = path.join(root, 'runtime')
    let archDirs = []
    try {
      archDirs = fs.readdirSync(runtimeRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        // `x64` first, then any other arch directory.
        .sort((left, right) => Number(right === 'x64') - Number(left === 'x64'))
    } catch {
      continue
    }
    for (const arch of archDirs) {
      const deps = path.join(runtimeRoot, arch, 'primary-runtime', 'dependencies', 'node')
      candidates.push(path.join(deps, 'bin', 'node.exe'))
      candidates.push(path.join(deps, 'bin', 'node'))
      candidates.push(path.join(deps, 'node.exe'))
    }
  }
  return candidates
}

/**
 * Locate a Node executable able to run the FCA Runtime (Node >= 22.5 for
 * `node:sqlite`). Detection chain (first existing wins):
 *
 *  1. `nodePath` config (explicit user override);
 *  2. `FCA_NODE` environment variable, then legacy `FCA_NODE_PATH`;
 *  3. the Node runtime bundled with the current DSH installation
 *     (`<DSH install>\resources\runtime\<arch>\primary-runtime\dependencies\node\bin\node.exe`);
 *  4. the legacy DSH-managed layout `%USERPROFILE%\.dsh\dsh-runtimes\...`
 *     (kept for older DSH releases; gone in DSH NEXT 2.0.22);
 *  5. the project's vendored Node (`<plugin package>/../vendor/node/node.exe`);
 *  6. the current process itself (Electron + `ELECTRON_RUN_AS_NODE=1`).
 *
 * @param config - normalized plugin configuration.
 * @param env - environment (injectable for tests).
 * @param pluginRoot - absolute plugin package directory (for the vendor fallback).
 * @param proc - process-like object (injectable for tests; defaults to `process`).
 * @returns {{ path: string|null, source: string }}
 */
export function findNodeRuntime(config, env = process.env, pluginRoot = null, proc = process) {
  const candidates = []
  if (config.nodePath) candidates.push({ path: config.nodePath, source: 'config' })
  if (env.FCA_NODE) candidates.push({ path: env.FCA_NODE, source: 'environment' })
  if (env.FCA_NODE_PATH) candidates.push({ path: env.FCA_NODE_PATH, source: 'environment' })

  for (const candidatePath of dshBundledNodeCandidates(proc)) {
    candidates.push({ path: candidatePath, source: 'dsh-runtime' })
  }

  // Older DSH releases kept every managed runtime under ~/.dsh/dsh-runtimes.
  const dshHome = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const runtimesDir = path.join(dshHome, 'dsh-runtimes')
  try {
    const entries = fs.readdirSync(runtimesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      // Prefer the primary runtime, then any other managed runtime.
      .sort((left, right) => Number(right === 'dsh-next-primary-runtime') - Number(left === 'dsh-next-primary-runtime'))
    for (const entry of entries) {
      candidates.push({ path: path.join(runtimesDir, entry, 'dependencies', 'node', 'bin', 'node.exe'), source: 'dsh-runtime-legacy' })
      candidates.push({ path: path.join(runtimesDir, entry, 'dependencies', 'node', 'bin', 'node'), source: 'dsh-runtime-legacy' })
      candidates.push({ path: path.join(runtimesDir, entry, 'dependencies', 'node', 'node.exe'), source: 'dsh-runtime-legacy' })
    }
  } catch {
    // No legacy DSH-managed runtimes: fall through to the vendored Node.
  }

  // Project layout: <repo>/dsh_plugin + <repo>/vendor/node/node.exe. A package
  // installed from the .tgz lives outside the repo, so both probes may miss.
  if (pluginRoot) {
    candidates.push({ path: path.resolve(pluginRoot, '..', 'vendor', 'node', 'node.exe'), source: 'vendor-node' })
    candidates.push({ path: path.resolve(pluginRoot, '..', 'vendor', 'node', 'bin', 'node.exe'), source: 'vendor-node' })
    candidates.push({ path: path.resolve(pluginRoot, 'vendor', 'node', 'node.exe'), source: 'vendor-node' })
    candidates.push({ path: path.resolve(pluginRoot, 'vendor', 'node', 'bin', 'node.exe'), source: 'vendor-node' })
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate.path)) return candidate
    } catch {
      // ignore unreadable candidate
    }
  }
  // Last resort: the current process. Under Electron this needs
  // ELECTRON_RUN_AS_NODE=1 and Node >= 22.5 for node:sqlite.
  return { path: process.execPath || null, source: 'host-process' }
}

/**
 * Locate `runtime/bin/fca-runtime.js`.
 * @returns the absolute script path, or null when it cannot be found.
 */
export function findRuntimeScript(config, pluginRoot, env = process.env) {
  const candidates = []
  if (config.runtimeScriptPath) candidates.push(config.runtimeScriptPath)
  if (env.FCA_RUNTIME_SCRIPT) candidates.push(env.FCA_RUNTIME_SCRIPT)
  if (pluginRoot) {
    candidates.push(path.resolve(pluginRoot, '..', 'runtime', 'bin', 'fca-runtime.js'))
    candidates.push(path.resolve(pluginRoot, 'runtime', 'bin', 'fca-runtime.js'))
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // ignore unreadable candidate
    }
  }
  return null
}


