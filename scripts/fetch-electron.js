#!/usr/bin/env node
/**
 * 获取/校验 Electron 运行时（离线缓存）。
 * - 已存在 .cache/electron-dist/electron.exe 则校验版本并退出 0。
 * - 否则从 npm 镜像下载固定版本 zip 并解压到 .cache/electron-dist。
 * 版本固定在 ELECTRON_VERSION，避免构建漂移。
 */
import { existsSync, mkdirSync, statSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PATHS, ensureDir } from './lib/common.js';

const ELECTRON_VERSION = '38.2.1';
const MIRRORS = [
  `https://npmmirror.com/mirrors/electron/${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-win32-x64.zip`,
  `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-win32-x64.zip`,
];

const distDir = join(PATHS.cache, 'electron-dist');
const exe = join(distDir, 'electron.exe');
const versionFile = join(distDir, 'version');

function hasCompleteDist() {
  if (!existsSync(exe)) return false;
  if (!existsSync(join(distDir, 'resources', 'default_app.asar'))) return false;
  const locales = join(distDir, 'locales');
  if (!existsSync(locales)) return false;
  return true;
}

if (hasCompleteDist() && existsSync(versionFile)) {
  const version = readFileSync(versionFile, 'utf8').trim();
  if (version === ELECTRON_VERSION) {
    console.log(`[electron] OK ${version} at ${exe}`);
    process.exit(0);
  }
  console.log(`[electron] version mismatch: ${version} != ${ELECTRON_VERSION}, re-fetching`);
}

ensureDir(PATHS.cache);

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let written = 0;
  const file = createWriteStream(dest);
  for await (const chunk of res.body) {
    written += chunk.length;
    if (!file.write(chunk)) await new Promise((r) => file.once('drain', r));
    if (total) process.stdout.write(`\r[electron] ${(written / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB`);
  }
  await new Promise((r) => file.end(r));
  console.log('');
}

const zip = join(PATHS.cache, `electron-v${ELECTRON_VERSION}-win32-x64.zip`);
if (!existsSync(zip) || statSync(zip).size < 100_000_000) {
  let lastErr;
  for (const url of MIRRORS) {
    try {
      console.log(`[electron] downloading ${url}`);
      await download(url, zip);
      lastErr = undefined;
      break;
    } catch (e) {
      console.warn(`[electron] mirror failed: ${e.message}`);
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
}

console.log('[electron] extracting...');
execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${distDir}' -Force`], { stdio: 'inherit' });

if (!hasCompleteDist()) {
  console.error('[electron] extraction incomplete: missing resources/default_app.asar or locales/');
  process.exit(1);
}
const version = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : 'unknown';
writeFileSync(join(PATHS.cache, 'electron-version.txt'), version);
console.log(`[electron] ready: ${version} at ${exe}`);
