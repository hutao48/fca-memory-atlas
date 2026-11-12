#!/usr/bin/env node
/**
 * 录制 FCA Memory Atlas 真实运行画面（WebM）。
 *
 * 用法：
 *   tools\node.cmd scripts\record.js [--fca-home=.cache/record-home] [--port=17862]
 *                                    [--out=artifacts/recordings/fca-atlas-nebula.webm]
 *                                    [--seconds=10] [--view=atlas] [--scenario=demo] [--no-runtime]
 *
 * 原理：用 .cache/electron-dist/electron.exe 以 scripts/electron-capture/record.cjs 为入口，
 * 加载真实 renderer + 真实 Runtime 数据，在页面内用 MediaRecorder 录制 WebGL 画布，
 * 录制期间注入真实滚轮缩放输入。输出为可播放的 VP9 WebM。
 *
 * 注意：本机 DSH 工具 shell 为受限制令牌，Electron 必须加 --no-sandbox 且清除
 * ELECTRON_RUN_AS_NODE；真实用户从桌面启动桌面软件不需要这些参数。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PATHS, PROJECT_ROOT, electronEnv, findElectron, ensureDir } from './lib/common.js';

const args = process.argv.slice(2);
const has = (name) => args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const pick = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  return has(name) ? true : fallback;
};

const out = resolve(PROJECT_ROOT, String(pick('out', 'artifacts/recordings/fca-atlas-nebula.webm')));
ensureDir(dirname(out));
ensureDir(join(PROJECT_ROOT, '.cache'));

const entry = join(PROJECT_ROOT, 'scripts', 'electron-capture', 'record.cjs');
if (!existsSync(entry)) {
  console.error(`[record] 缺少入口：${entry}`);
  process.exit(1);
}

const passthrough = args.filter((a) => a !== '--no-sandbox');
const child = spawn(findElectron(), [entry, ...passthrough, '--no-sandbox'], {
  cwd: PROJECT_ROOT,
  env: electronEnv(),
  stdio: 'inherit',
});
child.on('exit', (code) => {
  if (existsSync(out)) console.log(`[record] 已生成 ${out}`);
  process.exit(code ?? 0);
});
