#!/usr/bin/env node
/**
 * Unity WebGL 内嵌集成自检（不启动 Electron 窗口；只验证 desktop/main/unity-embed.js 的真实集成路径）。
 *
 * 覆盖：
 *  1. Unity WebGL 构建解析（开发版 artifacts/unity/FCANebulaWebGL；打包版 <InstallDir>/unity/FCANebulaWebGL；
 *     环境变量 FCA_UNITY_WEBGL_DIR 覆盖；FCA_UNITY_WEBGL_DISABLE=1 模拟缺失）。
 *  2. 本地只读静态服务真实启动（127.0.0.1 随机端口）：MIME 正确（.wasm/.js/.data/.png…）、防目录穿越、404。
 *  3. iframe URL 契约：?runtime-url=<runtime>&token=<bearer>&quality=<q>&poll=2（token 只打印长度/存在性）。
 *  4. 构建完整性：index.html + Build/*.loader.js/.framework.js/.wasm/.data（或压缩 .gz/.br）+ 关键文件大小。
 *  5. 输出 artifacts/unity/integration-final/integration-report.json（可作验收证据）。
 *
 * 用法（在项目根执行）：
 *   node scripts/unity-integration-check.js
 *   node scripts/unity-integration-check.js --fca-home=<FCA_DATA_DIR> --out-dir=artifacts/unity/integration-final
 *   node scripts/unity-integration-check.js --resolve-only
 *   FCA_UNITY_WEBGL_DISABLE=1 node scripts/unity-integration-check.js   # 验证回退分支的报告
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { createUnityEmbed, resolveUnityWebglDir } = require(join(PROJECT_ROOT, 'desktop', 'main', 'unity-embed.js'));

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
    else if (arg.startsWith('--')) out[arg.slice(2)] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const fcaHome = resolve(args['fca-home'] || process.env.FCA_HOME || join(process.env.LOCALAPPDATA || '', 'FCA-Memory-Atlas'));
const outDir = resolve(args['out-dir'] || join(PROJECT_ROOT, 'artifacts', 'unity', 'integration-final'));
const reportPath = resolve(args.report || join(outDir, 'integration-report.json'));
const resolveOnly = Boolean(args['resolve-only']);

function loadSettings() {
  try {
    const parsed = JSON.parse(require('node:fs').readFileSync(join(fcaHome, 'desktop-settings.json'), 'utf8').replace(/^\uFEFF/, ''));
    return { dataDir: parsed.dataDir || fcaHome, quality: parsed.quality || 'high', port: parsed.port || 17860 };
  } catch {
    return { dataDir: process.env.FCA_DATA_DIR || fcaHome, quality: 'high', port: 17860 };
  }
}

const logger = {
  info: (scope, message, meta) => console.log(`[unity-webgl-check][info][${scope}] ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`),
  warn: (scope, message, meta) => console.log(`[unity-webgl-check][warn][${scope}] ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`),
  error: (scope, message, meta) => console.log(`[unity-webgl-check][error][${scope}] ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`),
  child(scope) {
    return {
      info: (message, meta) => logger.info(scope, message, meta),
      warn: (message, meta) => logger.warn(scope, message, meta),
      error: (message, meta) => logger.error(scope, message, meta),
    };
  },
};

const settings = loadSettings();
const result = {
  ok: false,
  mode: 'embedded-webgl',
  generated_at: new Date().toISOString(),
  project_root: PROJECT_ROOT,
  settings_file: join(fcaHome, 'desktop-settings.json'),
  data_dir: settings.dataDir,
  quality: settings.quality,
  runtime_url: `http://127.0.0.1:${settings.port || 17860}`,
  resolve: null,
  build: null,
  serve: null,
  iframe_url: null,
  checks: {},
  error: null,
};

function finish(code) {
  result.ok = Object.values(result.checks).length > 0 && Object.values(result.checks).every(Boolean);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\n[unity-webgl-check] 报告：${reportPath}`);
  console.log(`[unity-webgl-check] ${result.ok ? 'PASS' : 'FAIL'}${result.error ? ` — ${result.error}` : ''}`);
  process.exit(code !== undefined ? code : result.ok ? 0 : 2);
}

function walk(dir, depth = 0) {
  const out = [];
  if (!existsSync(dir) || depth > 3) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, depth + 1));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

async function main() {
  const resolution = resolveUnityWebglDir(settings);
  result.resolve = { dir: resolution.dir, source: resolution.source, packaged: resolution.packaged, searched: resolution.searched };
  console.log(`[unity-webgl-check] build dir: ${resolution.dir || '(未找到)'} source=${resolution.source || '—'}`);
  for (const item of resolution.searched) console.log(`  ${item.exists ? '✓' : '✗'} ${item.path}  (${item.source})`);

  if (!resolution.dir) {
    result.error = '未找到 Unity WebGL 构建（index.html）——桌面应用会回退 WebGL 星云（允许状态；本自检需要构建产物）';
    result.checks = { build_found: false };
    finish(resolveOnly ? 0 : 2);
    return;
  }
  const files = walk(resolution.dir);
  const rel = (p) => p.slice(resolution.dir.length + 1).replace(/\\/g, '/');
  const fileInfo = files.map((p) => ({ path: rel(p), bytes: statSync(p).size }));
  const names = new Set(fileInfo.map((f) => f.path.toLowerCase()));
  const find = (pattern) => fileInfo.find((f) => pattern.test(f.path.toLowerCase())) || null;
  const loaderJs = find(/\.loader\.js$/);
  const frameworkJs = find(/\.framework\.js$/);
  const wasm = find(/\.wasm(\.gz|\.br)?$/);
  const data = find(/\.data(\.gz|\.br)?$/) || find(/\.data\.unityweb$/);
  result.build = {
    dir: resolution.dir,
    source: resolution.source,
    files: fileInfo.length,
    total_bytes: fileInfo.reduce((sum, f) => sum + f.bytes, 0),
    index: fileInfo.find((f) => f.path.toLowerCase() === 'index.html') || null,
    loader_js: loaderJs,
    framework_js: frameworkJs,
    wasm,
    data,
    sample_graph: fileInfo.find((f) => f.path.toLowerCase().endsWith('sample-graph.json')) || null,
    build_info: existsSync(join(resolution.dir, 'fca-webgl-build-info.json'))
      ? JSON.parse(require('node:fs').readFileSync(join(resolution.dir, 'fca-webgl-build-info.json'), 'utf8').replace(/^\uFEFF/, ''))
      : null,
  };
  console.log(`[unity-webgl-check] build: ${fileInfo.length} files / ${(result.build.total_bytes / 1048576).toFixed(1)} MiB`);

  if (resolveOnly) {
    result.checks = { build_found: true };
    finish(0);
    return;
  }

  const settingsStore = {
    get: () => ({ ...settings, dataDir: settings.dataDir, quality: settings.quality, nebulaEngine: 'unity' }),
    effectiveRuntimeUrl: () => result.runtime_url,
  };
  const embed = createUnityEmbed({ logger, settings: settingsStore });
  const started = await embed.start();
  result.serve = { ok: Boolean(started.ok), error: started.error || null };
  if (!started.ok) {
    result.error = started.error ? started.error.message : 'Unity WebGL 静态服务启动失败';
    result.checks = { build_found: true, server_start: false };
    await embed.dispose();
    finish(2);
    return;
  }
  const status = embed.getStatus();
  let base;
  try {
    const parsed = new URL(started.frameUrl);
    base = parsed.origin;
    result.iframe_url = {
      origin: base,
      path: parsed.pathname,
      params: {
        'runtime-url': parsed.searchParams.get('runtime-url'),
        quality: parsed.searchParams.get('quality'),
        poll: parsed.searchParams.get('poll'),
        token_present: Boolean(parsed.searchParams.get('token')),
        token_length: (parsed.searchParams.get('token') || '').length,
      },
    };
  } catch (error) {
    result.error = `iframe URL 解析失败：${error.message}`;
    result.checks = { build_found: true, server_start: true, iframe_url: false };
    await embed.dispose();
    finish(2);
    return;
  }
  result.serve = {
    ok: true,
    port: status.port,
    dir: status.dir,
    source: status.source,
    token_available: status.tokenAvailable,
    iframe_url: result.iframe_url,
  };

  const fetchCheck = async (relPath, expectTypeRe) => {
    const url = `${base}/${relPath}`;
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    return {
      path: relPath,
      status: res.status,
      content_type: res.headers.get('content-type'),
      bytes: buf.byteLength,
      ok: res.status === 200 && (!expectTypeRe || expectTypeRe.test(res.headers.get('content-type') || '')) && buf.byteLength > 0,
    };
  };
  const fetchResults = [];
  fetchResults.push(await fetchCheck('index.html', /text\/html/));
  if (loaderJs) fetchResults.push(await fetchCheck(loaderJs.path, /javascript/));
  if (frameworkJs) fetchResults.push(await fetchCheck(frameworkJs.path, /javascript/));
  if (wasm) fetchResults.push(await fetchCheck(wasm.path, /application\/wasm/));
  if (data) fetchResults.push(await fetchCheck(data.path, /application\/octet-stream/));
  const missing = await fetch(`${base}/__nope__.js`).then((r) => r.status).catch(() => -1);
  const traversal = await fetch(`${base}/..%2f..%2fpackage.json`).then((r) => r.status).catch(() => -1);

  const checks = {
    build_found: true,
    server_start: true,
    iframe_url: Boolean(result.iframe_url.params['runtime-url'] && result.iframe_url.params.quality && result.iframe_url.params.token_present),
    mime_and_size: fetchResults.every((item) => item.ok),
    static_404: missing === 404,
    traversal_blocked: traversal === 403 || traversal === 404 || traversal === 400,
    build_assets: Boolean(loaderJs && frameworkJs && wasm && data),
    build_info_ok: Boolean(result.build.build_info && result.build.build_info.total_errors === 0),
  };
  result.checks = checks;
  result.fetch = fetchResults;
  result.serve.stats = embed.getStatus().stats;
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!result.ok) result.error = Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key).join(', ');
  await embed.dispose();
  finish(result.ok ? 0 : 2);
}

main().catch((error) => {
  result.error = error && error.stack ? error.stack : String(error);
  result.checks = { ...(result.checks || {}), unexpected_error: false };
  finish(2);
});
