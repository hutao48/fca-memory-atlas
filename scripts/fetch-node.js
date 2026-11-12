#!/usr/bin/env node
/**
 * 获取官方 Node 24 x64 运行时到 vendor/node/node.exe（安装包随包分发；不要求用户预装 Node）。
 * 固定版本，优先 nodejs.org，失败回退 npmmirror 镜像。
 */
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from './lib/common.js';

const NODE_VERSION = 'v24.11.0';
const outDir = join(PROJECT_ROOT, 'vendor', 'node');
const outFile = join(outDir, 'node.exe');
const MIN_SIZE = 80_000_000;

if (existsSync(outFile) && statSync(outFile).size >= MIN_SIZE) {
  const version = execFileSync(outFile, ['--version'], { encoding: 'utf8' }).trim();
  console.log(`[node] OK ${version} at ${outFile}`);
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });

const urls = [
  `https://npmmirror.com/mirrors/node/${NODE_VERSION}/win-x64/node.exe`,
  `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`,
];

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const file = createWriteStream(outFile);
  let written = 0;
  for await (const chunk of res.body) {
    written += chunk.length;
    if (!file.write(chunk)) await new Promise((r) => file.once('drain', r));
    process.stdout.write(`\r[node] ${(written / 1048576).toFixed(1)} MiB`);
  }
  await new Promise((r) => file.end(r));
  console.log('');
  if (statSync(outFile).size < MIN_SIZE) throw new Error('downloaded node.exe is too small');
}

let lastErr;
for (const url of urls) {
  try {
    console.log(`[node] downloading ${url}`);
    await download(url);
    lastErr = undefined;
    break;
  } catch (e) {
    console.warn(`[node] failed: ${e.message}`);
    lastErr = e;
  }
}
if (lastErr) throw lastErr;

const version = execFileSync(outFile, ['--version'], { encoding: 'utf8' }).trim();
console.log(`[node] ready: ${version} at ${outFile}`);
