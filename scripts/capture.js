#!/usr/bin/env node
/**
 * 通用 Electron 截图/渲染捕获工具（用于验收截图与视觉回归）。
 * 用法：
 *   node scripts/capture.js --target=desktop --out=artifacts/screenshots/desktop-atlas.png --width=1600 --height=1000
 *   node scripts/capture.js --url=file:///.../demo.html --out=...
 *   node scripts/capture.js --target=desktop --view=timeline --wait=2500 --eval="..." 
 * 实现：以 Electron 入口脚本（本目录 electron-capture/harness.js 通过 --capture-config 传参）启动，
 *       BrowserWindow 加载目标 → 等待 → capturePage → PNG。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PATHS, findElectron, electronEnv, ensureDir, PROJECT_ROOT } from './lib/common.js';

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (arg.startsWith('--')) out[arg.slice(2)] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const width = Number(args.width ?? 1600);
const height = Number(args.height ?? 1000);
const wait = Number(args.wait ?? 2500);
const out = resolve(PROJECT_ROOT, args.out ?? join('artifacts', 'screenshots', 'capture.png'));

const config = {
  out,
  width,
  height,
  wait,
  url: args.url ?? null,
  target: args.target ?? null,
  view: args.view ?? null,
  eval: args.eval ?? null,
  show: Boolean(args.show),
  fcaHome: args['fca-home'] ?? null,
  deviceScaleFactor: Number(args.scale ?? 1),
};

if (config.url && config.target) {
  console.error('Use either --url or --target, not both');
  process.exit(2);
}
if (!existsSync(join(PATHS.cache, 'electron-dist'))) {
  console.warn('[capture] Electron cache missing; run node scripts/fetch-electron.js first');
}

ensureDir(join(PATHS.artifacts, 'screenshots'));

const harness = join(PROJECT_ROOT, 'scripts', 'electron-capture', 'harness.js');
const configFile = join(PATHS.cache, `capture-config-${Date.now()}.json`);
ensureDir(PATHS.cache);
(await import('node:fs')).writeFileSync(configFile, JSON.stringify(config, null, 2));

const exe = findElectron();
console.log(`[capture] ${exe}`);
console.log(`[capture] config: ${configFile}`);

const child = spawn(exe, [harness, `--capture-config=${configFile}`], {
  cwd: PROJECT_ROOT,
  env: electronEnv(),
  stdio: 'inherit',
});
const hardTimeoutMs = Number(args.timeout ?? 90000);
const killer = setTimeout(() => {
  console.error(`[capture] TIMEOUT after ${hardTimeoutMs}ms; killing electron`);
  try {
    child.kill();
  } catch {}
}, hardTimeoutMs);
child.on('exit', (code) => {
  clearTimeout(killer);
  if (existsSync(out)) console.log(`[capture] written ${out}`);
  process.exit(code ?? 0);
});
