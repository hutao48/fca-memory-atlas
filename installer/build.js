#!/usr/bin/env node
/**
 * FCA Memory Atlas Windows 安装包构建脚本（无第三方依赖，离线可重复构建）。
 *
 * 产物：artifacts/installer/FCA-Memory-Atlas-Setup-<version>-x64.exe
 *       artifacts/installer/FCA-Memory-Atlas-Setup-<version>-x64.sha256.json
 *       artifacts/reports/install-build-<timestamp>.json   （构建证据）
 *       artifacts/reports/install-build-<timestamp>.makensis.log（makensis 完整输出）
 *
 * 原理：
 *  1. 复用项目缓存的 Electron 38 官方分发（scripts/fetch-electron.js 负责下载），把 `electron.exe` 改名为
 *     `FCA Memory Atlas.exe`，应用代码放入 `resources/app/`（Electron 标准目录布局，入口 resources/app/main/main.js）。
 *  2. 随包附带 Node 24 运行时 `node/node.exe` 与 `runtime/`（FCA Local Runtime 源码），供桌面主动拉起。
 *  3. 用 NSIS 3.04（项目缓存 .cache/nsis）编译生成带卸载器的安装包（per-user，无需管理员）。
 *
 * payload 完整性（硬性要求，缺一即失败）：
 *   FCA Memory Atlas.exe
 *   resources/app/{package.json,main/main.js,main/preload.js,renderer/index.html,renderer/app.js}
 *   runtime/bin/fca-runtime.js、runtime/src/{runtime.js,services.js,server/index.js}
 *   node/node.exe、docs/USER_MANUAL.md、BUILD_INFO.json、LICENSE
 *
 * 用法：
 *   node installer/build.js [--skip-runtime] [--allow-incomplete] [--no-compress]
 *   --no-compress：不压缩（约 400MB，仅用于快速验证 NSIS 编译链，不用于交付）
 *   --allow-incomplete：缺少可选文件时只警告（交付构建禁止使用）
 * 要求：desktop/main/main.js、desktop/renderer/index.html、runtime/bin/fca-runtime.js 存在。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { PATHS, PROJECT_ROOT, ensureDir } from '../scripts/lib/common.js';

const VERSION = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')).version;
const options = new Set(process.argv.slice(2));
const ALLOW_INCOMPLETE = options.has('--allow-incomplete');
const COMPRESS = !options.has('--no-compress');
const SKIP_RUNTIME = options.has('--skip-runtime');
const BUILD_TIME = new Date();
const BUILD_STAMP = BUILD_TIME.toISOString().replace(/[:.]/g, '-');

const electronDist = join(PATHS.cache, 'electron-dist');
const nsisRoot = join(PATHS.cache, 'nsis');
const makensis = join(nsisRoot, 'Bin', 'makensis.exe');
const staging = join(PROJECT_ROOT, 'installer', '.staging');
const payload = join(staging, 'payload');
const output = join(PATHS.artifacts, 'installer');
const reports = join(PATHS.artifacts, 'reports');
const outFile = join(output, `FCA-Memory-Atlas-Setup-${VERSION}-x64.exe`);
const makensisLog = join(reports, `install-build-${BUILD_STAMP}.makensis.log`);
const buildReport = join(reports, `install-build-${BUILD_STAMP}.json`);

const criticalPayloadFiles = [
  'FCA Memory Atlas.exe',
  'resources/app/package.json',
  'resources/app/main/main.js',
  'resources/app/main/preload.js',
  'resources/app/main/ipc.js',
  'resources/app/main/runtime-manager.js',
  'resources/app/renderer/index.html',
  'resources/app/renderer/app.js',
  'runtime/bin/fca-runtime.js',
  'runtime/src/runtime.js',
  'runtime/src/services.js',
  'runtime/src/server/index.js',
  'node/node.exe',
  'docs/USER_MANUAL.md',
  'BUILD_INFO.json',
  'LICENSE',
];

function log(msg) {
  console.log(`[installer] ${msg}`);
}
function warn(msg) {
  console.warn(`[installer] WARN ${msg}`);
}
function fail(msg) {
  console.error(`[installer] ERROR: ${msg}`);
  process.exit(1);
}
function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function mustExist(p, label) {
  if (isFile(p)) return true;
  if (ALLOW_INCOMPLETE) {
    warn(`missing ${label}: ${p} (allowed by --allow-incomplete)`);
    return false;
  }
  fail(`missing ${label}: ${p}`);
}
function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  if (!existsSync(dir)) return { files, bytes };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = dirStats(p);
      files += sub.files;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += statSync(p).size;
    }
  }
  return { files, bytes };
}
function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}
function timestamp() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------- preflight
log(`FCA Memory Atlas installer build — version ${VERSION}${COMPRESS ? '' : ' (no-compress validation mode)'}`);
log(`project root: ${PROJECT_ROOT}`);

mustExist(join(electronDist, 'electron.exe'), 'Electron distribution (run: node scripts/fetch-electron.js)');
mustExist(join(electronDist, 'resources', 'default_app.asar'), 'Electron resources/default_app.asar');
mustExist(join(electronDist, 'version'), 'Electron distribution version file');
mustExist(join(PROJECT_ROOT, 'desktop', 'package.json'), 'desktop/package.json');
mustExist(join(PROJECT_ROOT, 'desktop', 'main', 'main.js'), 'desktop/main/main.js');
mustExist(join(PROJECT_ROOT, 'desktop', 'main', 'preload.js'), 'desktop/main/preload.js');
mustExist(join(PROJECT_ROOT, 'desktop', 'main', 'ipc.js'), 'desktop/main/ipc.js');
mustExist(join(PROJECT_ROOT, 'desktop', 'main', 'runtime-manager.js'), 'desktop/main/runtime-manager.js');
mustExist(join(PROJECT_ROOT, 'desktop', 'renderer', 'index.html'), 'desktop/renderer/index.html');
mustExist(join(PROJECT_ROOT, 'desktop', 'renderer', 'app.js'), 'desktop/renderer/app.js');
if (!SKIP_RUNTIME) {
  mustExist(join(PROJECT_ROOT, 'runtime', 'bin', 'fca-runtime.js'), 'runtime/bin/fca-runtime.js');
  mustExist(join(PROJECT_ROOT, 'runtime', 'src', 'runtime.js'), 'runtime/src/runtime.js');
  mustExist(join(PROJECT_ROOT, 'runtime', 'src', 'services.js'), 'runtime/src/services.js');
  mustExist(join(PROJECT_ROOT, 'runtime', 'src', 'server', 'index.js'), 'runtime/src/server/index.js');
}
for (const doc of ['USER_MANUAL.md', 'KNOWN_ISSUES.md', 'INSTALL_TEST.md']) {
  mustExist(join(PROJECT_ROOT, 'docs', doc), `docs/${doc}`);
}

// Node 24 运行时定位：优先项目 vendor（可复现），其次 DSH NEXT 随附运行时（本机开发环境兜底）。
// 注意：旧的 C:\\Users\\<user>\.dsh\dsh-runtimes\... 路径已在 DSH NEXT 升级后失效，不再使用。
const NODE_CANDIDATES = [
  { path: process.env.FCA_NODE, source: 'env:FCA_NODE' },
  { path: join(PROJECT_ROOT, 'vendor', 'node', 'node.exe'), source: 'vendor/node/node.exe' },
  {
    path: 'C:\\\\Users\\\\<user>\\AppData\\Local\\Programs\\DSH NEXT\\resources\\runtime\\x64\\primary-runtime\\dependencies\\node\\bin\\node.exe',
    source: 'dsh-next-runtime',
  },
  { path: 'C:\\Program Files\\nodejs\\node.exe', source: 'system-nodejs' },
].filter((c) => c.path);
let nodeExe = null;
for (const candidate of NODE_CANDIDATES) {
  if (!isFile(candidate.path)) continue;
  const size = statSync(candidate.path).size;
  if (size < 40_000_000) {
    warn(`node candidate too small, skipped: ${candidate.path} (${size} bytes)`);
    continue;
  }
  nodeExe = { path: candidate.path, source: candidate.source };
  break;
}
if (!nodeExe && !ALLOW_INCOMPLETE) {
  fail('node.exe not found (expected vendor/node/node.exe; run: node scripts/fetch-node.js)');
}
let nodeVersion = null;
if (nodeExe) {
  const probe = spawnSync(nodeExe.path, ['--version'], { encoding: 'utf8' });
  nodeVersion = probe.status === 0 ? probe.stdout.trim() : null;
  log(`using node: ${nodeExe.path} (${nodeVersion || 'version unknown'}, source=${nodeExe.source})`);
}

if (!isFile(makensis)) fail(`missing makensis: ${makensis} (run: node scripts/fetch-nsis.js)`);
const electronVersion = readFileSync(join(electronDist, 'version'), 'utf8').trim();
log(`electron: ${electronVersion} (${electronDist})`);
log(`makensis: ${makensis}`);

// API version 取自 desktop/main/paths.js（打包后运行时仍用它做兼容性校验）
let apiVersion = '1';
try {
  const pathsSource = readFileSync(join(PROJECT_ROOT, 'desktop', 'main', 'paths.js'), 'utf8');
  const match = /FCA_API_VERSION\s*=\s*'([^']+)'/.exec(pathsSource);
  if (match) apiVersion = match[1];
} catch {
  /* keep default */
}

// ---------------------------------------------------------------- staging
log('cleaning staging...');
rmSync(staging, { recursive: true, force: true });
ensureDir(payload);

log('copying Electron distribution (electron.exe -> FCA Memory Atlas.exe)...');
// 裁剪不必要体积：Electron 40+ 个语言包只保留实际使用的中/英语言，其它 .pak 删除；
// resources/default_app.asar 在 resources/app 存在时不会被使用，也删除。
const KEEP_LOCALES = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak', 'en-GB.pak']);
cpSync(electronDist, payload, {
  recursive: true,
  filter: (source) => {
    const name = source.replace(/\\/g, '/');
    const localeMatch = /\/locales\/([^/]+)$/.exec(name);
    if (localeMatch && statSync(source).isFile()) return KEEP_LOCALES.has(localeMatch[1]);
    return true;
  },
});
renameSync(join(payload, 'electron.exe'), join(payload, 'FCA Memory Atlas.exe'));
rmSync(join(payload, 'resources', 'app'), { recursive: true, force: true });
rmSync(join(payload, 'resources', 'app.asar'), { recursive: true, force: true });
const removedDefaultApp = existsSync(join(payload, 'resources', 'default_app.asar'));
rmSync(join(payload, 'resources', 'default_app.asar'), { recursive: true, force: true });
const removedLocales = readdirSync(join(payload, 'locales'))
  .filter((f) => f.endsWith('.pak') && !KEEP_LOCALES.has(f))
  .length;
const keptLocales = readdirSync(join(payload, 'locales')).filter((f) => f.endsWith('.pak'));
log(`electron payload trimmed: locales kept=[${keptLocales.join(', ')}], removed ${removedLocales} locale pak(s)${removedDefaultApp ? ', removed default_app.asar' : ''}`);

log('copying desktop application -> resources/app ...');
const appDir = join(payload, 'resources', 'app');
ensureDir(appDir);
const desktopEntries = ['package.json', 'main', 'renderer', 'assets', 'README.md'];
const copiedDesktop = [];
for (const entry of desktopEntries) {
  const src = join(PROJECT_ROOT, 'desktop', entry);
  if (!existsSync(src)) {
    if (entry === 'assets') warn('desktop/assets missing, skipped (optional)');
    else if (entry === 'README.md') warn('desktop/README.md missing, skipped (optional)');
    else fail(`missing required desktop entry: desktop/${entry}`);
    continue;
  }
  cpSync(src, join(appDir, entry), {
    recursive: true,
    filter: (source) => {
      const name = source.replace(/\\/g, '/');
      if (name.includes('/node_modules/')) return false;
      if (name.includes('/.cache/')) return false;
      if (name.includes('/tests/')) return false;
      if (name.includes('/.git/')) return false;
      if (/\.(map|ts|tsx)$/.test(name)) return false;
      return true;
    },
  });
  copiedDesktop.push(entry);
}
log(`desktop entries: ${copiedDesktop.join(', ')}`);

log('copying runtime (bin + src)...');
if (!SKIP_RUNTIME && existsSync(join(PROJECT_ROOT, 'runtime'))) {
  for (const entry of ['bin', 'src']) {
    const src = join(PROJECT_ROOT, 'runtime', entry);
    if (!existsSync(src)) fail(`missing runtime/${entry}`);
    cpSync(src, join(payload, 'runtime', entry), {
      recursive: true,
      filter: (source) => {
        const name = source.replace(/\\/g, '/');
        if (name.includes('/node_modules/')) return false;
        if (name.includes('/.cache/')) return false;
        if (name.includes('/data/')) return false;
        return true;
      },
    });
  }
} else {
  warn('runtime/ missing or --skip-runtime, skipped');
}

if (nodeExe) {
  log('copying bundled Node runtime...');
  ensureDir(join(payload, 'node'));
  cpSync(nodeExe.path, join(payload, 'node', 'node.exe'));
  writeFileSync(
    join(payload, 'node', 'README.txt'),
    [
      'Bundled Node.js runtime for FCA Local Runtime',
      '',
      `node.exe version: ${nodeVersion || 'unknown'} (win32-x64)`,
      `source: ${nodeExe.source}`,
      '',
      'Node.js is licensed under the MIT license. See https://nodejs.org/en/about/previous-releases',
      'This copy is bundled so FCA Local Runtime can run without a system-wide Node.js install.',
      '',
    ].join('\r\n'),
  );
}

// docs：安装目录 docs/（开始菜单“使用说明”）、resources/docs/（应用内“帮助 → 打开文档目录”）
log('copying docs and licenses...');
function copyDocs(targetDir) {
  ensureDir(targetDir);
  const docsSrc = join(PROJECT_ROOT, 'docs');
  for (const doc of readdirSync(docsSrc)) {
    const src = join(docsSrc, doc);
    if (statSync(src).isFile() && doc.endsWith('.md')) cpSync(src, join(targetDir, doc));
  }
  const adrDir = join(docsSrc, 'adr');
  if (existsSync(adrDir)) {
    ensureDir(join(targetDir, 'adr'));
    for (const doc of readdirSync(adrDir)) {
      const src = join(adrDir, doc);
      if (statSync(src).isFile() && doc.endsWith('.md')) cpSync(src, join(targetDir, 'adr', doc));
    }
  }
}
copyDocs(join(payload, 'docs'));
copyDocs(join(payload, 'resources', 'docs'));
for (const doc of ['README.md', 'CHANGELOG.md']) {
  if (existsSync(join(PROJECT_ROOT, doc))) cpSync(join(PROJECT_ROOT, doc), join(payload, doc));
}
// LICENSE：优先项目根 LICENSE，其次 installer/LICENSE.txt（随包许可证说明），都没有则写占位（仅 --allow-incomplete）
const licenseSrc = [join(PROJECT_ROOT, 'LICENSE'), join(PROJECT_ROOT, 'installer', 'LICENSE.txt')].find((p) => isFile(p));
if (licenseSrc) {
  cpSync(licenseSrc, join(payload, 'LICENSE'));
} else if (ALLOW_INCOMPLETE) {
  writeFileSync(join(payload, 'LICENSE'), 'FCA Memory Atlas Alpha 0.1 — internal alpha build. See docs/ for details.\n');
} else {
  fail('missing license file: expected LICENSE or installer/LICENSE.txt');
}

// 空白数据模板（存在且非空时随包分发）
const dataTemplate = join(PROJECT_ROOT, 'data_template');
if (existsSync(dataTemplate) && dirStats(dataTemplate).files > 0) {
  log('copying data_template...');
  cpSync(dataTemplate, join(payload, 'data_template'), { recursive: true });
}

// 版本标记（安装目录 BUILD_INFO.json，同时写入安装报告与构建证据）
const buildInfo = {
  product: 'FCA Memory Atlas',
  version: VERSION,
  api_version: apiVersion,
  channel: 'alpha',
  built_at: BUILD_TIME.toISOString(),
  build_host: process.env.COMPUTERNAME || 'unknown',
  builder: 'installer/build.js',
  electron: electronVersion,
  node: nodeExe ? { bundled: true, version: nodeVersion, source: nodeExe.source } : { bundled: false },
  layout: {
    desktop_exe: 'FCA Memory Atlas.exe',
    desktop_app: 'resources/app (entry: main/main.js)',
    runtime: 'runtime/bin/fca-runtime.js',
    runtime_src: 'runtime/src',
    node: 'node/node.exe',
    docs: 'docs/ (also resources/docs/)',
  },
  defaults: {
    install_dir: '%LOCALAPPDATA%\\Programs\\FCA Memory Atlas',
    data_dir: '%LOCALAPPDATA%\\FCA-Memory-Atlas',
    runtime_host: '127.0.0.1',
    runtime_port: 17860,
    install_log: '%TEMP%\\fca-install.log',
    uninstall_log: '%TEMP%\\fca-uninstall.log',
  },
  trimmed: {
    locales_kept: keptLocales,
    locales_removed_count: removedLocales,
    default_app_asar_removed: removedDefaultApp,
    licenses_chromium_kept: true,
    note: 'LICENSES.chromium.html kept for Chromium/Electron license compliance',
  },
  checks: {},
};
writeFileSync(join(payload, 'BUILD_INFO.json'), `${JSON.stringify(buildInfo, null, 2)}\n`);

// stamp desktop package version
const appPackagePath = join(appDir, 'package.json');
if (existsSync(appPackagePath)) {
  const pkg = JSON.parse(readFileSync(appPackagePath, 'utf8'));
  pkg.version = VERSION;
  pkg.description = 'FCA Memory Atlas — local cognitive memory desktop application';
  pkg.author = 'FCA Project';
  writeFileSync(appPackagePath, JSON.stringify(pkg, null, 2));
}

// ---------------------------------------------------------------- payload verification
log('verifying payload completeness...');
const missingCritical = [];
const criticalChecks = {};
for (const rel of criticalPayloadFiles) {
  const present = isFile(join(payload, rel));
  criticalChecks[rel] = present;
  if (!present) missingCritical.push(rel);
}
const appStats = dirStats(join(appDir));
const runtimeStats = dirStats(join(payload, 'runtime'));
const docsStats = dirStats(join(payload, 'docs'));
const payloadStatsFinal = dirStats(payload);
buildInfo.payload = {
  files: payloadStatsFinal.files,
  bytes: payloadStatsFinal.bytes,
  desktop_files: appStats.files,
  runtime_files: runtimeStats.files,
  docs_files: docsStats.files,
};
buildInfo.checks = {
  critical_files: criticalChecks,
  desktop_renderer_views_present: isFile(join(appDir, 'renderer', 'views', 'atlas.js')),
  desktop_renderer_styles_present: isFile(join(appDir, 'renderer', 'styles', 'tokens.css')),
  desktop_nebula_present: isFile(join(appDir, 'renderer', 'nebula', 'index.js')),
  runtime_llm_present: isFile(join(payload, 'runtime', 'src', 'api', 'routes', 'llm.js')),
  runtime_seed_present: isFile(join(payload, 'runtime', 'src', 'seed', 'demo.js')),
};
writeFileSync(join(payload, 'BUILD_INFO.json'), `${JSON.stringify(buildInfo, null, 2)}\n`);

if (missingCritical.length) {
  if (ALLOW_INCOMPLETE) {
    warn(`payload missing critical files (allowed): ${missingCritical.join(', ')}`);
  } else {
    fail(`payload incomplete, missing: ${missingCritical.join(', ')}`);
  }
}
log(
  `payload: ${payloadStatsFinal.files} files, ${(payloadStatsFinal.bytes / 1048576).toFixed(1)} MiB ` +
    `(desktop ${appStats.files} files, runtime ${runtimeStats.files} files, docs ${docsStats.files} files)`,
);

// ---------------------------------------------------------------- compile
ensureDir(output);
ensureDir(reports);
// 本机环境注意：makensis 3.04（x86）在默认 %TEMP%（C:\Users\<user>\AppData\Local\Temp）下创建
// 大于 ~32MB 的内存映射临时文件会失败（Internal compiler error #12345: error creating mmap），
// 表现为编译大文件（如 211MB 的 Electron 主程序）时立即失败。用项目内 D: 盘的临时目录可稳定编译。
// 该限制已记录在 docs/ENVIRONMENT_REPORT.md 与 docs/KNOWN_ISSUES.md。
const nsisTemp = join(staging, 'makensis-temp');
ensureDir(nsisTemp);
const defines = [
  `/DVERSION=${VERSION}`,
  `/DPRODUCTVERSION=${VERSION}`,
  `/DPAYLOAD=${payload}`,
  `/DOUTFILE=${outFile}`,
  `/DCOMPRESS=${COMPRESS ? 1 : 0}`,
  `/DBUILT_AT=${BUILD_TIME.toISOString()}`,
  `/DAPIVERSION=${apiVersion}`,
];
log(`makensis ${defines.join(' ')} installer.nsi`);
log(`makensis TEMP=${nsisTemp} (workaround for mmap >32MB failure under system %TEMP%)`);
const compileStart = Date.now();
const compile = spawnSync(
  makensis,
  ['/V4', '/INPUTCHARSET', 'UTF8', ...defines, join(PROJECT_ROOT, 'installer', 'installer.nsi')],
  {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, TEMP: nsisTemp, TMP: nsisTemp, TMPDIR: nsisTemp },
  },
);
const compileMs = Date.now() - compileStart;
const compileOutput = `${compile.stdout || ''}${compile.stderr || ''}`;
writeFileSync(makensisLog, compileOutput);
process.stdout.write(compileOutput);
log(`makensis exit=${compile.status} elapsed=${(compileMs / 1000).toFixed(1)}s log=${makensisLog}`);
if (compile.status === 0) {
  rmSync(nsisTemp, { recursive: true, force: true });
} else {
  warn(`keeping makensis temp dir for diagnosis: ${nsisTemp}`);
}
if (compile.status !== 0) fail(`makensis failed with code ${compile.status} (see ${makensisLog})`);
if (!isFile(outFile)) fail(`installer output not produced: ${outFile}`);

const size = statSync(outFile).size;
const sha256 = sha256File(outFile);
const meta = {
  file: outFile,
  version: VERSION,
  api_version: apiVersion,
  channel: 'alpha',
  size_bytes: size,
  size_mb: Number((size / 1048576).toFixed(1)),
  sha256,
  built_at: BUILD_TIME.toISOString(),
  electron: electronVersion,
  node: nodeVersion,
  node_source: nodeExe ? nodeExe.source : null,
  payload: buildInfo.payload,
  makensis: { exit_code: compile.status, elapsed_ms: compileMs, log: relative(PROJECT_ROOT, makensisLog) },
  checks: buildInfo.checks,
};
writeFileSync(join(output, `FCA-Memory-Atlas-Setup-${VERSION}-x64.sha256.json`), `${JSON.stringify(meta, null, 2)}\n`);
writeFileSync(buildReport, `${JSON.stringify({ ok: true, ...meta }, null, 2)}\n`);

log(`OK  ${outFile}`);
log(`    size ${meta.size_mb} MiB (${size} bytes)`);
log(`    sha256 ${sha256}`);
log(`    build report ${buildReport}`);
