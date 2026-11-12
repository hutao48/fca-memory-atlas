#!/usr/bin/env node
/**
 * FCA 通用脚本工具：统一 Node 运行时定位、Electron 启动、日志。
 * 供 scripts/*.js 复用；不依赖第三方包。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PATHS = {
  root: PROJECT_ROOT,
  runtimeBin: join(PROJECT_ROOT, 'runtime', 'bin', 'fca-runtime.js'),
  runtimeSrc: join(PROJECT_ROOT, 'runtime', 'src'),
  desktopDir: join(PROJECT_ROOT, 'desktop'),
  desktopMain: join(PROJECT_ROOT, 'desktop', 'main', 'main.js'),
  cache: join(PROJECT_ROOT, '.cache'),
  artifacts: join(PROJECT_ROOT, 'artifacts'),
  screenshots: join(PROJECT_ROOT, 'artifacts', 'screenshots'),
  reports: join(PROJECT_ROOT, 'artifacts', 'reports'),
};

/** 定位 Electron 可执行文件：优先项目缓存，其次 desktop/node_modules。 */
export function findElectron() {
  const candidates = [
    join(PATHS.cache, 'electron-dist', 'electron.exe'),
    join(PROJECT_ROOT, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe'),
    join(PROJECT_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  throw new Error(
    'Cannot find Electron. Expected .cache/electron-dist/electron.exe or an installed electron package.\n' +
      'Run: node scripts/fetch-electron.js',
  );
}

/** 本机 shell 环境带 ELECTRON_RUN_AS_NODE=1，启动 Electron 前必须清除。 */
export function electronEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** 启动 Electron 并等待退出，返回 exit code。 */
export function runElectron(args, options = {}) {
  const exe = findElectron();
  const child = spawn(exe, args, {
    cwd: options.cwd ?? PROJECT_ROOT,
    env: electronEnv(options.env ?? {}),
    stdio: options.stdio ?? 'inherit',
    windowsHide: false,
  });
  return new Promise((resolvePromise, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolvePromise({ code, signal }));
  });
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
