#!/usr/bin/env node
// FCA Nebula WebGL — deterministic acceptance screenshots via Chrome DevTools Protocol.
//
// Why CDP: Unity WebGL needs real WebGL frames and the in-canvas HUD; headless Edge with
// `--virtual-time-budget` is flaky for long running WebGL apps. This script launches
// headless Edge once, waits until the Unity bridge reports `window.__FCA_READY__`, then
// switches camera views through the page bridge and captures full-page screenshots.
//
// Usage:
//   node unity/FCANebula/scripts/capture-webgl-cdp.mjs \
//     --url "http://127.0.0.1:18080/index.html?runtime-url=...&token=...&quality=low&view=0&auto-rotate=0" \
//     --out artifacts/unity/webgl-shots --width 1280 --height 800
//
// Requires Node >= 22 (global WebSocket/fetch). Edge/Chrome must be installed.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

function parseArgs(argv) {
  const args = {
    url: '',
    out: 'artifacts/unity/webgl-shots',
    width: 1280,
    height: 800,
    edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    debugPort: 0,
    timeoutMs: 240000,
    settleMs: 2500,
    views: '0,1,2',
    labels: '0',
    emulation: '0',
    manifestExtra: ''
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = i + 1 < argv.length ? argv[i + 1] : '';
    switch (key) {
      case '--url': args.url = value; i++; break;
      case '--out': args.out = value; i++; break;
      case '--width': args.width = parseInt(value, 10); i++; break;
      case '--height': args.height = parseInt(value, 10); i++; break;
      case '--edge': args.edge = value; i++; break;
      case '--debug-port': args.debugPort = parseInt(value, 10); i++; break;
      case '--timeout': args.timeoutMs = parseInt(value, 10); i++; break;
      case '--settle': args.settleMs = parseInt(value, 10); i++; break;
      case '--views': args.views = value; i++; break;
      case '--labels': args.labels = value; i++; break;
      case '--emulation': args.emulation = value; i++; break;
      case '--manifest-extra': args.manifestExtra = value; i++; break;
      default: break;
    }
  }
  if (!args.url) throw new Error('--url is required');
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SECURITY: the iframe URL carries the FCA bearer token. Never persist it: strip the token
// query parameter before writing URLs to logs/manifests.
function sanitizeUrl(url) {
  if (!url) return url;
  return String(url).replace(/([?&]token=)[^&]*/gi, '$1[REDACTED]');
}

class CdpClient {
  constructor(wsUrl, timeoutMs) {
    this.wsUrl = wsUrl;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.consoleEntries = [];
    this.logEntries = [];
    this.exceptions = [];
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('websocket connect timeout')), 15000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolvePromise(); });
      this.ws.addEventListener('error', (e) => { clearTimeout(timer); rejectPromise(new Error('websocket error')); });
    });
    this.ws.addEventListener('message', (event) => this.onMessage(event));
  }

  onMessage(event) {
    let message;
    try { message = JSON.parse(event.data); } catch (e) { return; }
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message + ' (' + pending.method + ')'));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      const entry = {
        type: message.params.type,
        ts: message.params.timestamp,
        text: (message.params.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || '')).join(' ')
      };
      this.consoleEntries.push(entry);
    } else if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails || {};
      this.exceptions.push({ text: details.text || '', exception: details.exception ? details.exception.description : '' });
    } else if (message.method === 'Log.entryAdded') {
      const entry = message.params.entry || {};
      this.logEntries.push({ level: entry.level, source: entry.source, text: entry.text });
    }
  }

  send(method, params = {}, timeoutOverrideMs = 0) {
    const id = this.nextId++;
    const timeoutMs = timeoutOverrideMs > 0 ? timeoutOverrideMs : this.timeoutMs;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, method });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rejectPromise(new Error('CDP timeout: ' + method));
        }
      }, timeoutMs);
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result.exceptionDetails) {
      return { ok: false, error: result.exceptionDetails.text };
    }
    return { ok: true, value: result.result ? result.result.value : undefined };
  }

  async screenshot() {
    // Software WebGL (SwiftShader) in headless Edge can take a long time to composite a
    // full raymarched frame; give the screenshot command its own generous timeout.
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, 180000);
    return Buffer.from(result.data, 'base64');
  }

  close() {
    try { this.ws.close(); } catch (e) { /* ignore */ }
  }
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function findPageTarget(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, 3000);
      const page = (targets || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) { /* browser still starting */ }
    await sleep(300);
  }
  throw new Error('Edge DevTools endpoint not available on port ' + port);
}

function killProcessTree(proc) {
  if (!proc || proc.killed) return;
  try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
  if (process.platform === 'win32' && proc.pid) {
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (e) { /* ignore */ }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });
  const logDir = join(outDir, 'logs');
  mkdirSync(logDir, { recursive: true });

  const debugPort = args.debugPort || (9200 + Math.floor(Math.random() * 500));
  const userDataDir = join(tmpdir(), 'fca-cdp-edge-' + randomBytes(4).toString('hex'));
  const edgeArgs = [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    // Headless window chrome eats ~30px width / ~142px height: compensate so the viewport
    // lands close to the requested acceptance size.
    `--window-size=${args.width + 30},${args.height + 142}`,
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--mute-audio',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--force-device-scale-factor=1',
    'about:blank'
  ];

  console.log('[cdp] launching Edge, debug port', debugPort);
  const edge = spawn(args.edge, edgeArgs, { stdio: 'ignore', windowsHide: true });
  let cdp = null;
  const files = [];
  const startedAt = new Date();
  let state = null;
  let viewportActual = '';

  try {
    const target = await findPageTarget(debugPort);
    console.log('[cdp] page target:', target.url);
    cdp = new CdpClient(target.webSocketDebuggerUrl, 30000);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');
    // Force an exact viewport before navigation so the Unity canvas is created at the right
    // size (resizing a live WebGL canvas later can leave stale framebuffer content).
    // NOTE: CDP device-metrics emulation on top of Unity WebGL produced duplicated HUD
    // artifacts in headless Edge screenshots, so it is opt-in and off by default.
    if (args.emulation === '1') {
      try {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: args.width,
          height: args.height,
          deviceScaleFactor: 1,
          mobile: false
        });
      } catch (e) {
        console.warn('[cdp] setDeviceMetricsOverride failed:', e.message);
      }
    }
    await cdp.send('Page.navigate', { url: args.url });
    console.log('[cdp] navigated to', sanitizeUrl(args.url));

    // Wait until the Unity bridge reports a rendered real graph.
    const readyDeadline = Date.now() + args.timeoutMs;
    let ready = false;
    while (Date.now() < readyDeadline) {
      const probe = await cdp.evaluate(
        'JSON.stringify({ready: !!window.__FCA_READY__, state: window.__FCA_NEBULA_STATE__ || null, href: location.href})'
      );
      if (probe.ok && probe.value) {
        const parsed = JSON.parse(probe.value);
        if (parsed.state) state = parsed.state;
        if (parsed.ready && parsed.state && parsed.state.nodes > 0) {
          ready = true;
          break;
        }
      }
      await sleep(500);
    }
    if (!ready) {
      throw new Error('Unity WebGL did not report ready within ' + args.timeoutMs + 'ms (console log saved)');
    }
    console.log('[cdp] unity ready:', JSON.stringify(state));
    const metricsProbe = await cdp.evaluate(
      '(function(){var c=document.querySelector("#unity-canvas");return JSON.stringify({dpr:window.devicePixelRatio,iw:window.innerWidth,ih:window.innerHeight,cssW:c?c.clientWidth:0,cssH:c?c.clientHeight:0,bufW:c?c.width:0,bufH:c?c.height:0,scrollH:document.documentElement.scrollHeight});})()'
    );
    viewportActual = metricsProbe.ok ? metricsProbe.value : '';
    console.log('[cdp] viewport:', viewportActual);
    await sleep(args.settleMs);

    const views = args.views.split(',').map((v) => parseInt(v.trim(), 10)).filter((v) => !isNaN(v));
    for (const view of views) {
      // Labels are user-toggleable in the WebGL player; acceptance shots keep them off for
      // a clean nebula, the selected-memory panel in view 1 still shows the real title/body.
      await cdp.evaluate(`(function(){ try { return !!(window.FCA_NEBULA && window.FCA_NEBULA.postCommand('labels:${args.labels}')); } catch(e) { return false; } })()`);
      const applied = await cdp.evaluate(`(function(){ try { return !!(window.FCA_NEBULA && window.FCA_NEBULA.setView(${view})); } catch(e) { return false; } })()`);
      console.log('[cdp] view', view, 'applied=', applied.ok && applied.value, 'labels=', args.labels);
      const waitMs = view === 1 ? args.settleMs + 1500 : args.settleMs;
      await sleep(waitMs);
      const buffer = await cdp.screenshot();
      const file = join(outDir, `webgl-view-${view}.png`);
      writeFileSync(file, buffer);
      files.push(file);
      console.log('[cdp] captured', file, buffer.length, 'bytes');
    }

    const finalState = await cdp.evaluate('JSON.stringify(window.__FCA_NEBULA_STATE__ || null)');
    if (finalState.ok && finalState.value) {
      try {
        const parsedState = JSON.parse(finalState.value);
        if (parsedState) state = parsedState;
      } catch (e) { /* keep previous */ }
    }
  } finally {
    if (cdp) {
      writeFileSync(join(logDir, 'webgl-console.log'), cdp.consoleEntries.map((l) => `[${l.type}] ${l.text}`).join('\n'), 'utf8');
      writeFileSync(join(logDir, 'webgl-browser-log.log'), cdp.logEntries.map((l) => `[${l.level}/${l.source}] ${l.text}`).join('\n'), 'utf8');
      writeFileSync(join(logDir, 'webgl-exceptions.log'), cdp.exceptions.map((l) => `${l.text}\n${l.exception}`).join('\n\n'), 'utf8');
      cdp.close();
    }
    killProcessTree(edge);
  }

  const buildInfoPath = resolve(args.out, '..', 'FCANebulaWebGL', 'fca-webgl-build-info.json');
  let buildInfo = null;
  try { buildInfo = JSON.parse(readFileSync(buildInfoPath, 'utf8')); } catch (e) { /* optional */ }

  // Include every view captured so far in this output directory (per-view runs merge here).
  try {
    const { readdirSync } = await import('node:fs');
    for (const entry of readdirSync(outDir)) {
      if (/^webgl-view-\d+\.png$/.test(entry)) {
        const full = join(outDir, entry);
        if (!files.includes(full)) files.push(full);
      }
    }
    files.sort();
  } catch (e) { /* keep captured files */ }

  let manifestExtra = null;
  if (args.manifestExtra) {
    try { manifestExtra = JSON.parse(readFileSync(args.manifestExtra, 'utf8')); } catch (e) { /* optional */ }
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    started_at: startedAt.toISOString(),
    format: 'fca-nebula-webgl-shots-cdp/v1',
    url: sanitizeUrl(args.url),
    viewport: `${args.width}x${args.height}`,
    viewport_actual: viewportActual,
    unity_version: buildInfo ? buildInfo.unity_version : null,
    compression: buildInfo ? buildInfo.compression : null,
    connected: state ? !!state.connected : null,
    sample_data: state ? !!state.sample : null,
    nodes: state ? state.nodes : null,
    edges: state ? state.edges : null,
    arms: state ? state.arms : null,
    arm_summary: state ? state.armSummary : null,
    layout_signature: state ? state.layout : null,
    diagnostics: state ? {
      token_provided: state.tokenProvided,
      volume_material_ok: state.volumeMaterialOk,
      arm_count_uniform: state.armCountUniform,
      emission_scale: state.emissionScale,
      march_steps: state.marchSteps
    } : null,
    files,
    note: manifestExtra && manifestExtra.note ? manifestExtra.note : 'FCA Nebula WebGL 真实 Runtime 数据截图（headless Edge + SwiftShader）。'
  };
  const manifestPath = join(outDir, 'webgl-shots-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log('[cdp] manifest:', manifestPath);
  console.log('[cdp] state:', JSON.stringify({ connected: manifest.connected, nodes: manifest.nodes, edges: manifest.edges, arms: manifest.arms, arm_summary: manifest.arm_summary, diagnostics: manifest.diagnostics }));
  if (!manifest.connected) {
    console.warn('[cdp] WARNING: page reports connected=false');
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error('[cdp] FAILED:', error && error.stack ? error.stack : error);
  process.exit(1);
});
