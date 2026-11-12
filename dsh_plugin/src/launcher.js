/**
 * Safe Runtime auto-start.
 *
 * The Desktop Host runs inside Electron, so spawning the FCA Local Runtime
 * (a Node 24 program that needs `node:sqlite`) requires a real Node executable.
 * The launcher prefers a DSH-managed Node runtime, falls back to the host
 * executable with `ELECTRON_RUN_AS_NODE=1`, and never uses a shell: the argv is
 * fixed (`<runtimeScript> serve`) and the environment is inherited, so no user
 * data is interpolated into a command line.
 *
 * A launch is attempted at most once per plugin instance; the outcome is
 * reported through `fca_status` instead of being retried in a loop.
 *
 * @module dsh-plugin-fca-memory/src/launcher
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { findNodeRuntime, findRuntimeScript, resolveFcaHome } from './config.js'

/** Maximum bytes kept from a launched Runtime's stderr for diagnostics. */
const STDERR_LIMIT = 8192

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * Start the FCA Local Runtime and wait until `/health` answers.
 * @param options.config - normalized plugin configuration.
 * @param options.logger - plugin logger.
 * @param options.client - Runtime client used for the health probes.
 * @param options.pluginRoot - absolute plugin package directory.
 * @returns a report object: `{ attempted, started, node, script, pid, health, error, stderr }`.
 */
export async function startRuntime({ config, logger, client, pluginRoot }) {
  const report = {
    attempted: false,
    started: false,
    node: null,
    nodeSource: null,
    script: null,
    pid: null,
    health: null,
    error: null,
    stderr: '',
    cwd: null,
  }

  if (!config.autoStartRuntime) {
    report.error = 'autoStartRuntime is disabled; start the Runtime manually (runtime/bin/fca-runtime.js serve).'
    return report
  }

  const script = findRuntimeScript(config, pluginRoot)
  if (!script) {
    report.error = 'runtime/bin/fca-runtime.js was not found; set runtimeScriptPath or start the Runtime manually.'
    return report
  }
  report.script = script

  const node = findNodeRuntime(config, process.env, pluginRoot)
  if (!node || !node.path) {
    report.error = 'no Node executable found; set nodePath to a Node >= 22.5 binary.'
    return report
  }
  report.node = node.path
  report.nodeSource = node.source

  const fcaHome = resolveFcaHome(config)
  const env = { ...process.env, FCA_HOME: fcaHome }
  // Pass the configured port through the documented environment override so a
  // non-default runtimeUrl still starts a Runtime the plugin can reach.
  try {
    const port = new URL(config.runtimeUrl).port
    if (port) env.FCA_PORT = port
  } catch {
    // runtimeUrl was validated already; ignore a parse failure here
  }
  if (node.source === 'host-process') {
    // Electron's binary behaves as Node only with this switch.
    env.ELECTRON_RUN_AS_NODE = '1'
  } else {
    delete env.ELECTRON_RUN_AS_NODE
  }

  const cwd = path.resolve(path.dirname(script), '..', '..')
  report.cwd = cwd
  report.attempted = true

  let child
  try {
    child = spawn(node.path, [script, 'serve'], {
      cwd,
      env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    report.error = `spawn failed: ${error && error.message ? error.message : String(error)}`
    return report
  }
  report.pid = typeof child.pid === 'number' ? child.pid : null

  let stderrText = ''
  try {
    child.stderr?.on('data', (chunk) => {
      if (stderrText.length >= STDERR_LIMIT) return
      stderrText += String(chunk).slice(0, STDERR_LIMIT - stderrText.length)
    })
    // Drain stdout so the child can never block on a full pipe.
    child.stdout?.on('data', () => {})
  } catch {
    // stream plumbing is best-effort diagnostics only
  }
  let exit = null
  child.once('error', (error) => {
    exit = { code: null, signal: null, message: error && error.message ? error.message : String(error) }
  })
  child.once('exit', (code, signal) => {
    exit = { code, signal, message: null }
  })
  try {
    child.unref()
    child.stderr?.unref?.()
    child.stdout?.unref?.()
  } catch {
    // unref is optional
  }
  logger.info('launching FCA Runtime', { node: node.path, nodeSource: node.source, script, pid: report.pid })

  const deadline = Date.now() + config.startTimeoutMs
  let health = null
  while (Date.now() < deadline) {
    await delay(300)
    if (exit) {
      report.error = `Runtime exited during startup (${exit.message || `code ${exit.code}${exit.signal ? `, signal ${exit.signal}` : ''}`})`
      report.stderr = stderrText.slice(0, 2000)
      return report
    }
    health = await client.health()
    if (health.reachable) break
  }
  report.health = health
  report.stderr = stderrText.slice(0, 2000)
  if (health && health.reachable) {
    report.started = true
    logger.info('FCA Runtime started', { pid: report.pid, version: health.health && health.health.version })
  } else {
    report.error = `Runtime did not answer /health within ${config.startTimeoutMs} ms`
  }
  return report
}

/** True when a file exists and looks readable (used in status output). */
export function fileInfo(file) {
  try {
    const stat = fs.statSync(file)
    return { path: file, exists: true, bytes: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return { path: file, exists: false, bytes: 0, mtimeMs: 0 }
  }
}
