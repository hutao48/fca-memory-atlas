'use strict';

/**
 * Electron 截图/渲染探针调用封装（复用 desktop/main/capture.js，不重复实现截图工具）。
 * 关键点：
 *  - 必须清除 ELECTRON_RUN_AS_NODE（本机 DSH de-elevated 环境）
 *  - 必须加 --no-sandbox
 *  - 每个进程独立 --userdata，避免与 desktop-app 并行截图抢 Chromium profile 锁
 *  - 用 spawnSync 等待 GUI 进程真正退出（PowerShell 的 & 不会等待 GUI）
 *  - 权威断言来自 stdout 的 `[capture] state = {...}` 与 CAPTURED 行
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const c = require('./common.cjs');

/**
 * @param {{scene:string, fcaHome:string, port:number, out:string, view?:string, scenario?:string|null,
 *          width?:number, height?:number, wait?:number, userdata?:string, timeoutMs?:number}} options
 */
function runCapture(options) {
  const exe = c.PATHS.ELECTRON;
  if (!c.fileExists(exe)) throw new Error(`Electron 可执行文件不存在：${exe}（运行 node scripts/fetch-electron.js）`);
  const outAbs = path.resolve(c.ROOT, options.out);
  const homeAbs = path.resolve(c.ROOT, options.fcaHome);
  const userdataAbs = path.resolve(c.ROOT, options.userdata || path.join('.cache', `capture-userdata-qa-${options.scene}`));
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  const args = [
    'desktop/main/capture.js',
    `--fca-home=${homeAbs}`,
    `--port=${options.port}`,
    '--no-runtime',
    '--no-init',
    `--out=${outAbs}`,
    `--width=${options.width || 1600}`,
    `--height=${options.height || 1000}`,
    `--wait=${options.wait || 2500}`,
    '--no-sandbox',
    `--userdata=${userdataAbs}`,
  ];
  if (options.scenario) args.push(`--scenario=${options.scenario}`);
  if (options.view) args.push(`--view=${options.view}`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const started = Date.now();
  const result = spawnSync(exe, args, {
    cwd: c.ROOT,
    env,
    encoding: 'utf8',
    timeout: options.timeoutMs || 240_000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  let state = null;
  const stateMatches = [...stdout.matchAll(/\[capture\] state = (\{[\s\S]*?\})\s*$/gm)];
  if (stateMatches.length > 0) {
    try {
      state = JSON.parse(stateMatches[stateMatches.length - 1][1]);
    } catch {
      state = null;
    }
  }
  const captured = /CAPTURED (\S+) bytes=(\d+) size=(\d+)x(\d+)/.exec(stdout);
  const pngBytes = fs.existsSync(outAbs) ? fs.statSync(outAbs).size : 0;
  return {
    scene: options.scene,
    exitCode: result.status,
    signal: result.signal,
    ms: Date.now() - started,
    state,
    png: outAbs,
    png_rel: path.relative(c.ROOT, outAbs).replace(/\\/g, '/'),
    bytes: pngBytes,
    captured: Boolean(captured),
    gpu_hint: /ANGLE \(([^)]*NVIDIA[^)]*)\)/.exec(String(state && state.nebula && state.nebula.gpu))?.[1] || null,
    stdout_tail: stdout.slice(-2500),
    stderr_tail: stderr.slice(-1500),
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

module.exports = { runCapture };
