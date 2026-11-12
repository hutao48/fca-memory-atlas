/**
 * HTTP client for the FCA Local Runtime.
 *
 * Speaks only the frozen contract (docs/PUBLIC_INTERFACE_FREEZE.md §4):
 * Bearer auth, `X-FCA-Client` identity, `X-FCA-Trace-Id` tracing and the
 * JSON error envelope. Every method resolves to a result object instead of
 * throwing, so a Runtime outage can never break the DSH Host.
 *
 * @module dsh-plugin-fca-memory/src/client
 */

import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { CLIENT_ID, FCA_API_VERSION, PLUGIN_VERSION } from './config.js'

/** Generate a contract-shaped trace id (`trc_` + 32 lowercase hex chars). */
export function newTraceId() {
  return `trc_${randomBytes(16).toString('hex')}`
}

function combineSignal(timeoutMs, disposeSignal) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!disposeSignal) return timeout
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([timeout, disposeSignal])
  return timeout
}

/** One FCA Runtime HTTP client bound to one plugin instance. */
export class RuntimeClient {
  /**
   * @param options.config - normalized plugin configuration.
   * @param options.logger - plugin logger.
   * @param options.tokenPath - absolute token file path.
   */
  constructor({ config, logger, tokenPath }) {
    this.config = config
    this.logger = logger
    this.tokenPath = tokenPath
    this.tokenCache = { value: null, mtimeMs: -1, readAt: 0 }
    this.disposeController = new AbortController()
    this.disposed = false
  }

  /** Stop every in-flight request (called on plugin unload). */
  abort() {
    this.disposed = true
    try {
      this.disposeController.abort()
    } catch {
      // already aborted
    }
  }

  /**
   * Read the bearer token from disk. Cached by file mtime, never logged.
   * @returns the token string, or null when the file is missing/unreadable.
   */
  readToken() {
    let stat
    try {
      stat = fs.statSync(this.tokenPath)
    } catch {
      this.tokenCache = { value: null, mtimeMs: -1, readAt: Date.now() }
      return null
    }
    if (this.tokenCache.value && this.tokenCache.mtimeMs === stat.mtimeMs) return this.tokenCache.value
    try {
      const token = fs.readFileSync(this.tokenPath, 'utf8').trim()
      this.tokenCache = { value: token || null, mtimeMs: stat.mtimeMs, readAt: Date.now() }
      return this.tokenCache.value
    } catch {
      return null
    }
  }

  /** True when a token file is present and non-empty. */
  hasToken() {
    return Boolean(this.readToken())
  }

  /**
   * Perform one JSON request against the Runtime.
   * @param method - HTTP method.
   * @param pathName - absolute path beginning with '/'.
   * @param options.body - JSON-serializable body.
   * @param options.timeoutMs - per-request timeout.
   * @param options.auth - whether to send the bearer token.
   * @returns `{ ok, status, data, traceId, code, message, details }`, never throws.
   */
  async request(method, pathName, options = {}) {
    const auth = options.auth !== false
    const timeoutMs = options.timeoutMs || this.config.requestTimeoutMs
    const traceId = newTraceId()
    const headers = {
      Accept: 'application/json',
      'X-FCA-Client': CLIENT_ID,
      'X-FCA-Trace-Id': traceId,
    }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8'
    if (auth) {
      const token = this.readToken()
      if (!token) {
        return {
          ok: false,
          status: null,
          data: null,
          traceId,
          code: 'NO_TOKEN',
          message: `FCA runtime token not found at ${this.tokenPath}. Start the FCA Runtime once so it creates the token file.`,
        }
      }
      headers.Authorization = `Bearer ${token}`
    }

    if (this.disposed) {
      return { ok: false, status: null, data: null, traceId, code: 'PLUGIN_UNLOADED', message: 'plugin was unloaded' }
    }

    let response
    try {
      response = await fetch(`${this.config.runtimeUrl}${pathName}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: combineSignal(timeoutMs, this.disposeController.signal),
      })
    } catch (error) {
      return {
        ok: false,
        status: null,
        data: null,
        traceId,
        code: 'RUNTIME_UNREACHABLE',
        message: `cannot reach FCA Runtime at ${this.config.runtimeUrl}: ${error && error.message ? error.message : String(error)}`,
      }
    }

    const responseTrace = response.headers.get('x-fca-trace-id') || traceId
    const text = await response.text().catch(() => '')
    let data = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = null
      }
    }

    if (response.ok) {
      return { ok: true, status: response.status, data, traceId: responseTrace, code: null, message: null }
    }
    const envelope = data && data.error ? data.error : null
    return {
      ok: false,
      status: response.status,
      data,
      traceId: responseTrace,
      code: envelope && envelope.code ? envelope.code : `HTTP_${response.status}`,
      message: envelope && envelope.message ? envelope.message : `FCA Runtime returned HTTP ${response.status}`,
      details: envelope && envelope.details ? envelope.details : undefined,
    }
  }

  /**
   * Probe `/health` (the only unauthenticated route).
   * @returns `{ reachable, httpStatus, health, apiVersion, compatible, code, message }`.
   */
  async health() {
    const result = await this.request('GET', '/health', { auth: false, timeoutMs: this.config.healthTimeoutMs })
    if (!result.ok) {
      return {
        reachable: false,
        httpStatus: result.status,
        health: null,
        apiVersion: null,
        compatible: false,
        code: result.code,
        message: result.message,
      }
    }
    const health = result.data && typeof result.data === 'object' ? result.data : {}
    const apiVersion = typeof health.api_version === 'string' ? health.api_version : null
    return {
      reachable: true,
      httpStatus: result.status,
      health,
      apiVersion,
      compatible: apiVersion === FCA_API_VERSION,
      code: null,
      message: null,
    }
  }

  /** Submit one `agent.event_received` audit event. */
  submitEvent(event) {
    return this.request('POST', '/api/v1/event', { body: event })
  }

  /** POST /api/v1/memory/search. */
  searchMemory(payload) {
    return this.request('POST', '/api/v1/memory/search', { body: payload })
  }

  /** POST /api/v1/memory/store. */
  storeMemory(payload) {
    return this.request('POST', '/api/v1/memory/store', { body: payload })
  }

  /** GET /api/v1/memory/{id}[?version=]. */
  getMemory(id, version) {
    const suffix = version === undefined || version === null ? '' : `?version=${encodeURIComponent(String(version))}`
    return this.request('GET', `/api/v1/memory/${encodeURIComponent(id)}${suffix}`)
  }

  /** GET /api/v1/state. */
  getState() {
    return this.request('GET', '/api/v1/state')
  }

  /** GET /api/v1/cognition. */
  getCognition() {
    return this.request('GET', '/api/v1/cognition')
  }
}

/** Plugin source identity used in event envelopes. */
export function pluginSource() {
  return { kind: CLIENT_ID, id: 'dsh-plugin', version: PLUGIN_VERSION }
}
