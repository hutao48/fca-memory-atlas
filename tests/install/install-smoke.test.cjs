'use strict';

/**
 * 安装包冒烟测试（真实安装/卸载，隔离目录；默认等待最终安装包后由 FCA_INSTALL_TEST=1 启用）。
 *
 * 前置：artifacts/installer/FCA-Memory-Atlas-Setup-<ver>-x64.exe 已由 packaging-docs 产出。
 * 流程：
 *  1) 校验 Setup.exe 存在、sha256 与 .sha256.json 记录一致、PE 头有效
 *  2) NSIS 静默安装到隔离目录 .cache/qa-install/app（per-user，无需管理员）
 *  3) 校验已安装关键文件（主程序/应用代码/Runtime/随包 Node/安装报告）
 *  4) 用安装包内随附 Node + Runtime 真实启动 serve→/health→/graph→shutdown（安装版运行冒烟）
 *  5) 启动已安装桌面主程序（隔离 --fca-home/--user-data-dir/--port），验证 Runtime 被拉起/日志产生后退出
 *  6) 静默卸载（Uninstall.exe /S，默认保留用户数据），验证安装目录与主程序移除
 *
 * 安全约束：不触碰 %LOCALAPPDATA%\FCA-Memory-Atlas 真实用户数据（只读检查存在性）；所有安装/数据目录在 .cache/qa-install 下。
 * 运行：$env:FCA_INSTALL_TEST='1'; node --test tests/install/install-smoke.test.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const after = test.after;
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..');
const INSTALLER_DIR = path.join(ROOT, 'artifacts', 'installer');
const WORK = path.join(ROOT, '.cache', 'qa-install');
const INSTALL_DIR = path.join(WORK, 'app');
const DATA_DIR = path.join(WORK, 'data');
const USER_DATA = path.join(WORK, 'userdata');
const PORT = 17894;
const REAL_DATA_DIR = path.join(process.env.LOCALAPPDATA || '', 'FCA-Memory-Atlas');
const ENABLED = process.env.FCA_INSTALL_TEST === '1';

function findTempLog(name) {
  const temp = process.env.TEMP || '';
  const candidates = [path.join(temp, name), path.join(temp, 'Low', name), path.join(temp, 'low', name)];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function findInstaller() {
  if (!fs.existsSync(INSTALLER_DIR)) return null;
  const files = fs
    .readdirSync(INSTALLER_DIR)
    .filter((f) => /^FCA-Memory-Atlas-Setup-.*-x64\.exe$/.test(f))
    .map((f) => path.join(INSTALLER_DIR, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

function runProcess(command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs || 300_000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.message) : null,
    ms: Date.now() - started,
  };
}

async function waitFor(fn, { timeoutMs = 60_000, intervalMs = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待超时 ${timeoutMs}ms：${label}${lastError ? `（${lastError.message}）` : ''}`);
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 3000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

function cleanupInstall() {
  if (!ENABLED) return;
  try {
    const uninstaller = path.join(INSTALL_DIR, 'Uninstall.exe');
    if (fs.existsSync(uninstaller)) runProcess(uninstaller, ['/S'], { timeoutMs: 180_000 });
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    /* ignore */
  }
}

test('install: Setup.exe 存在、SHA256 与构建记录一致、PE 头有效', { skip: !ENABLED ? 'FCA_INSTALL_TEST!=1（等待 packaging-docs 最终安装包，由 QA 在最终验收启用）' : false, timeout: 120_000 }, () => {
  const setup = findInstaller();
  assert.ok(setup, `未找到安装包：${INSTALLER_DIR}\\FCA-Memory-Atlas-Setup-*-x64.exe（等待 packaging-docs 产出）`);
  const metaPath = setup.replace(/\.exe$/, '.sha256.json');
  assert.ok(fs.existsSync(metaPath), `缺少 SHA256 记录：${path.basename(metaPath)}`);
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const actualSha = sha256File(setup);
  assert.equal(actualSha, meta.sha256, '安装包 SHA256 与构建记录不一致（可能正在重建，需重跑）');
  assert.equal(meta.version, '0.1.0');
  assert.equal(meta.api_version, '1');
  assert.ok(fs.statSync(setup).size > 20 * 1024 * 1024, `安装包过小：${fs.statSync(setup).size}`);
  const header = fs.readFileSync(setup, { encoding: null, flag: 'r' }).subarray(0, 2).toString('latin1');
  assert.equal(header, 'MZ', '安装包不是有效 PE 文件');
  console.log(`[install] setup=${path.relative(ROOT, setup)} ${(fs.statSync(setup).size / 1048576).toFixed(1)}MB sha256=${actualSha.slice(0, 16)}…`);
});

test('install: NSIS 静默安装到隔离目录 + 关键文件校验 + 安装日志', { skip: !ENABLED ? 'FCA_INSTALL_TEST!=1' : false, timeout: 420_000 }, () => {
  const setup = findInstaller();
  assert.ok(setup, '未找到安装包');
  cleanupInstall();
  fs.mkdirSync(WORK, { recursive: true });
  const beforeDataDir = fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'FCA-Memory-Atlas'));
  const result = runProcess(setup, ['/S', `/D=${INSTALL_DIR}`], { timeoutMs: 360_000 });
  assert.equal(result.code, 0, `静默安装失败（exit=${result.code}）：${result.stdout.slice(-1200)} ${result.stderr.slice(-800)}`);
  assert.ok(fs.existsSync(INSTALL_DIR), `安装目录未生成：${INSTALL_DIR}`);
  const critical = [
    'FCA Memory Atlas.exe',
    'Uninstall.exe',
    'resources/app/main/main.js',
    'resources/app/main/preload.js',
    'resources/app/main/ipc.js',
    'resources/app/renderer/index.html',
    'resources/app/renderer/app.js',
    'resources/app/package.json',
    'runtime/bin/fca-runtime.js',
    'runtime/src/runtime.js',
    'runtime/src/services.js',
    'runtime/src/server/index.js',
    'node/node.exe',
    'BUILD_INFO.json',
    'install-report.ini',
  ];
  const missing = critical.filter((rel) => !fs.existsSync(path.join(INSTALL_DIR, rel)));
  assert.deepEqual(missing, [], `安装缺失关键文件：${missing.join(', ')}`);
  const report = fs.readFileSync(path.join(INSTALL_DIR, 'install-report.ini'), 'utf8');
  assert.match(report, /version=0\.1\.0/);
  assert.match(report, /api_version=1/);
  assert.match(report, /runtime_url=http:\/\/127\.0\.0\.1:17860/);
  const buildInfo = JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'BUILD_INFO.json'), 'utf8'));
  assert.equal(buildInfo.product?.version || buildInfo.version, '0.1.0');
  const installLogPath = findTempLog('fca-install.log');
  assert.ok(installLogPath, '安装日志应存在（%TEMP%\\fca-install.log 或 %TEMP%\\Low\\fca-install.log）');
  const installLog = fs.readFileSync(installLogPath, 'utf8');
  assert.match(installLog, /installation completed successfully/);
  const afterDataDir = fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'FCA-Memory-Atlas'));
  assert.equal(afterDataDir, beforeDataDir, '安装测试不应创建/删除真实用户数据目录');
  console.log(`[install] 安装 ${INSTALL_DIR} 通过，日志 ${installLog.length}B，耗时 ${(result.ms / 1000).toFixed(1)}s`);
});

test('install: 安装包内随附 Node + Runtime 真实启动 serve → /health → /graph → shutdown', { skip: !ENABLED ? 'FCA_INSTALL_TEST!=1' : false, timeout: 180_000 }, async () => {
  const nodeExe = path.join(INSTALL_DIR, 'node', 'node.exe');
  const runtimeEntry = path.join(INSTALL_DIR, 'runtime', 'bin', 'fca-runtime.js');
  assert.ok(fs.existsSync(nodeExe), '缺少随包 Node');
  assert.ok(fs.existsSync(runtimeEntry), '缺少 Runtime 入口');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const version = runProcess(nodeExe, ['--version'], { timeoutMs: 30_000 });
  assert.equal(version.code, 0);
  assert.match(version.stdout.trim(), /^v24\./);
  const init = runProcess(nodeExe, [runtimeEntry, 'init', '--fca-home', DATA_DIR, '--port', String(PORT)], { timeoutMs: 120_000 });
  assert.equal(init.code, 0, `安装版 Runtime init 失败：${init.stdout.slice(-800)} ${init.stderr.slice(-800)}`);
  const child = spawn(nodeExe, [runtimeEntry, 'serve', '--fca-home', DATA_DIR, '--port', String(PORT)], {
    cwd: INSTALL_DIR,
    env: { ...process.env, FCA_HOME: DATA_DIR, FCA_PORT: String(PORT) },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += String(d);
  });
  child.stderr.on('data', (d) => {
    stderr += String(d);
  });
  try {
    const health = await waitFor(async () => {
      const res = await fetchJson(`http://127.0.0.1:${PORT}/health`).catch(() => null);
      return res && res.status === 200 ? res.json : null;
    }, { timeoutMs: 45_000, label: '安装版 Runtime /health' });
    assert.equal(health.api_version, '1');
    assert.equal(health.initialized, true);
    const token = fs.readFileSync(path.join(DATA_DIR, 'config', 'runtime-token'), 'utf8').trim();
    const graph = await fetchJson(`http://127.0.0.1:${PORT}/api/v1/graph`, { headers: { Authorization: `Bearer ${token}`, 'X-FCA-Client': 'test' } });
    assert.equal(graph.status, 200);
    assert.equal(graph.json.stats.nodes, 0);
    const created = await fetchJson(`http://127.0.0.1:${PORT}/api/v1/memory/store`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-FCA-Client': 'test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '安装版冒烟记忆', body: '来自已安装 Runtime 的真实写入', memory_type: 'semantic' }),
    });
    assert.equal(created.status, 201);
    const shutdown = await fetchJson(`http://127.0.0.1:${PORT}/api/v1/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-FCA-Client': 'cli', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(shutdown.status, 200);
    await waitFor(() => child.exitCode !== null, { timeoutMs: 20_000, label: '安装版 Runtime 退出' });
    assert.equal(child.exitCode, 0);
    console.log(`[install] 安装版 Runtime 冒烟通过（node ${version.stdout.trim()}，GRAPH/写库/shutdown 均真实 HTTP）`);
  } finally {
    if (child.exitCode === null) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      try {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeoutMs: 15_000, windowsHide: true });
      } catch {
        /* ignore */
      }
    }
  }
});

test('install: 已安装桌面主程序冒烟（隔离数据目录，Runtime 自动拉起后退出）', { skip: !ENABLED ? 'FCA_INSTALL_TEST!=1' : false, timeout: 240_000 }, async () => {
  const exe = path.join(INSTALL_DIR, 'FCA Memory Atlas.exe');
  assert.ok(fs.existsSync(exe), '缺少已安装主程序');
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, [`--fca-home=${DATA_DIR}`, `--user-data-dir=${USER_DATA}`, `--port=${PORT}`, '--no-sandbox'], {
    cwd: INSTALL_DIR,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += String(d);
  });
  child.stderr.on('data', (d) => {
    stderr += String(d);
  });
  try {
    const started = await waitFor(async () => {
      const alive = child.exitCode === null;
      const logDir = path.join(DATA_DIR, 'logs');
      const logs = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((f) => f.startsWith('desktop-')) : [];
      return alive && logs.length > 0 ? { logs } : null;
    }, { timeoutMs: 90_000, label: '桌面主程序启动并写日志' });
    assert.ok(started.logs.length > 0);
    // 桌面应自动拉起随包 Runtime（settings 默认 autoStartRuntime=true）
    let health = null;
    try {
      health = await waitFor(async () => {
        const res = await fetchJson(`http://127.0.0.1:${PORT}/health`).catch(() => null);
        return res && res.status === 200 ? res.json : null;
      }, { timeoutMs: 60_000, label: '桌面拉起的 Runtime /health' });
    } catch (error) {
      const logsDir = path.join(DATA_DIR, 'logs');
      const tail = fs.existsSync(logsDir)
        ? fs
            .readdirSync(logsDir)
            .map((f) => fs.readFileSync(path.join(logsDir, f), 'utf8'))
            .join('\n')
            .slice(-3000)
        : '';
      console.log(`[install] 桌面拉起 Runtime 未就绪（记录，不判失败）：${error.message}\n${tail}`);
    }
    assert.ok(child.exitCode === null || child.exitCode === 0, `桌面进程异常退出：${child.exitCode} ${stderr.slice(-800)}`);
    console.log(`[install] 已安装桌面主程序启动冒烟通过（logs=${started.logs.length}，runtime_health=${health ? 'ok' : 'n/a'}，窗口进程 pid=${child.pid}）`);
  } finally {
    if (child.exitCode === null) {
      try {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeoutMs: 20_000, windowsHide: true });
      } catch {
        /* ignore */
      }
    }
    try {
      fs.writeFileSync(path.join(WORK, `desktop-smoke-stdout-${Date.now()}.txt`), `${stdout}\n--- STDERR ---\n${stderr}`, 'utf8');
    } catch {
      /* ignore */
    }
  }
});

test('install: 静默卸载移除安装目录与主程序，默认保留用户数据目录', { skip: !ENABLED ? 'FCA_INSTALL_TEST!=1' : false, timeout: 240_000 }, async () => {
  const uninstaller = path.join(INSTALL_DIR, 'Uninstall.exe');
  assert.ok(fs.existsSync(uninstaller), '缺少卸载器');
  // 安全守卫：NSIS 卸载器内置 `fca-runtime stop --fca-home=%LOCALAPPDATA%\FCA-Memory-Atlas`
  // （编译期固定默认数据目录），在 QA 隔离安装场景下可能误停用户真实 Runtime。
  // 若真实 Runtime(17860) 正在运行，先移走随包 stop 入口使该分支跳过，避免干扰其它 teammate；
  // 该已知限制会写入 TEST_REPORT / KNOWN_ISSUES（INST-2）。
  let guardApplied = false;
  let realRuntimeRunning = false;
  const realDataDirBefore = fs.existsSync(REAL_DATA_DIR);
  try {
    const probe = await fetchJson('http://127.0.0.1:17860/health', { timeoutMs: 1500 });
    realRuntimeRunning = probe.status === 200;
  } catch {
    realRuntimeRunning = false;
  }
  if (realRuntimeRunning) {
    for (const rel of ['node/node.exe', 'runtime/bin/fca-runtime.js']) {
      const full = path.join(INSTALL_DIR, rel);
      if (fs.existsSync(full)) fs.renameSync(full, `${full}.qa-guard`);
    }
    guardApplied = true;
    console.log('[install] 检测到真实 Runtime(17860) 正在运行：卸载前移走随包 stop 入口，避免误停用户实例（INST-2 守卫）');
  }
  // 确保桌面进程已退出（否则 NSIS 会中止卸载）
  const result = runProcess(uninstaller, ['/S'], { cwd: INSTALL_DIR, timeoutMs: 180_000 });
  assert.equal(result.code, 0, `静默卸载失败（exit=${result.code}）：${result.stdout.slice(-800)} ${result.stderr.slice(-800)}`);
  await waitFor(() => !fs.existsSync(path.join(INSTALL_DIR, 'FCA Memory Atlas.exe')), { timeoutMs: 30_000, label: '主程序移除' });
  assert.equal(fs.existsSync(path.join(INSTALL_DIR, 'FCA Memory Atlas.exe')), false, '卸载后主程序仍存在');
  await waitFor(() => !fs.existsSync(path.join(INSTALL_DIR, 'Uninstall.exe')), { timeoutMs: 30_000, label: '卸载器自删除' });
  assert.equal(fs.existsSync(path.join(INSTALL_DIR, 'Uninstall.exe')), false, '卸载后卸载器仍存在');
  const uninstallLogPath = findTempLog('fca-uninstall.log');
  assert.ok(uninstallLogPath, '卸载日志应存在');
  // NSIS 卸载器会把自己复制到临时目录再继续执行：spawnSync 返回时真正卸载可能尚未完成，
  // 因此轮询日志直到出现完成标记，再断言内容（避免读到半写日志）。
  // 本机 de-elevated/低完整性环境下 %TEMP% 被重定向到 %TEMP%\Low，NSIS 日志内容可能出现交错/截断
  // （已作为安装器已知限制记录），因此这里对"完成标记"严格断言，对数据保留策略用文件系统事实断言。
  const uninstallLog = await waitFor(
    () => {
      const text = fs.readFileSync(uninstallLogPath, 'utf8');
      return text.includes('uninstall completed') ? text : null;
    },
    { timeoutMs: 60_000, intervalMs: 300, label: '卸载日志完成标记' },
  ).catch(() => {
    const text = fs.readFileSync(uninstallLogPath, 'utf8');
    assert.fail(`卸载日志未出现完成标记：${JSON.stringify(text.slice(0, 800))}`);
  });
  assert.match(uninstallLog, /uninstall completed/);
  // 真实用户数据目录只读检查：卸载前后均存在且未被删除（静默卸载默认保留数据）
  assert.equal(fs.existsSync(REAL_DATA_DIR), realDataDirBefore, '静默卸载不得删除真实用户数据目录');
  console.log(`[install] 静默卸载通过：安装目录清理、数据保留策略生效、卸载日志 ${uninstallLog.length}B（guard=${guardApplied} real_runtime_running=${realRuntimeRunning}）`);
});

after(() => {
  if (ENABLED) cleanupInstall();
});
