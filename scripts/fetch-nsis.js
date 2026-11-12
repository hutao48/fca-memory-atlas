#!/usr/bin/env node
/**
 * 获取 NSIS 3.04 构建工具链到 .cache/nsis（可离线重复构建安装包）。
 * 来源：npmmirror 镜像的 electron-builder-binaries（GitHub 下载在本机不可达，已实测）。
 */
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PATHS, ensureDir } from './lib/common.js';

const nsisDir = join(PATHS.cache, 'nsis');
const makensis = join(nsisDir, 'Bin', 'makensis.exe');
const resourcesMarker = join(nsisDir, 'Include', 'MUI2.nsh');

if (existsSync(makensis) && existsSync(resourcesMarker)) {
  const out = execFileSync(makensis, ['/VERSION'], { encoding: 'utf8' }).trim();
  console.log(`[nsis] OK ${out} at ${makensis}`);
  process.exit(0);
}

ensureDir(nsisDir);

const downloads = [
  {
    url: 'https://npmmirror.com/mirrors/electron-builder-binaries/nsis-3.0.4.1/nsis-3.0.4.1.7z',
    file: join(nsisDir, 'nsis-3.0.4.1.7z'),
    minSize: 1_000_000,
  },
  {
    url: 'https://npmmirror.com/mirrors/electron-builder-binaries/nsis-resources-3.4.1/nsis-resources-3.4.1.7z',
    file: join(nsisDir, 'nsis-resources-3.4.1.7z'),
    minSize: 500_000,
  },
];

async function download(url, dest, minSize) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const file = createWriteStream(dest);
  for await (const chunk of res.body) {
    if (!file.write(chunk)) await new Promise((r) => file.once('drain', r));
  }
  await new Promise((r) => file.end(r));
  if (statSync(dest).size < minSize) throw new Error(`payload too small: ${dest}`);
}

for (const d of downloads) {
  if (existsSync(d.file) && statSync(d.file).size >= d.minSize) {
    console.log(`[nsis] cached ${d.file}`);
    continue;
  }
  console.log(`[nsis] downloading ${d.url}`);
  await download(d.url, d.file, d.minSize);
}

// Windows 自带 bsdtar 支持读取 7z
for (const d of downloads) {
  console.log(`[nsis] extracting ${d.file}`);
  execFileSync('tar.exe', ['-xf', d.file], { cwd: nsisDir, stdio: 'inherit' });
}

if (!existsSync(makensis)) throw new Error(`makensis not found after extraction: ${makensis}`);
if (!existsSync(resourcesMarker)) throw new Error('NSIS resources (Include/MUI2.nsh) missing; nsis-resources extraction failed');
const version = execFileSync(makensis, ['/VERSION'], { encoding: 'utf8' }).trim();
console.log(`[nsis] ready: ${version} at ${makensis}`);
