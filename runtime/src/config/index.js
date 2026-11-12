// FCA Local Runtime — 配置解析（CLI > 环境变量 > <FCA_HOME>/config/runtime.json > 默认值）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigError } from '../core/errors.js';

export const PRODUCT_VERSION = '0.1.0';
export const API_VERSION = '1';
export const EVENT_SCHEMA_VERSION = '1.0';
export const DEFAULT_PORT = 17860;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;
export const SSE_REPLAY_LIMIT = 5_000;
export const MAX_MEMORY_BODY_CHARS = 1_000_000;
export const MAX_MEMORY_TITLE_CHARS = 500;

const BOOLEAN_FLAGS = new Set([
  'help',
  'json',
  'quiet',
  'verbose',
  'demo',
  'clear',
  'hard',
  'confirm',
  'force',
  'foreground',
  'allow-remote',
  'insecure',
  'no-color',
  'wait',
  'keep-pinned',
  'all',
]);

/** 解析 CLI 参数：返回 { command, flags, positional }。 */
export function parseArgv(argv = []) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith('-')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg === '-h') {
      flags.help = true;
    } else if (arg === '-v') {
      flags.verbose = true;
    } else if (arg === '-q') {
      flags.quiet = true;
    } else if (arg.startsWith('-') && arg.length > 1) {
      flags[arg.slice(1)] = true;
    } else {
      positional.push(arg);
    }
  }
  const command = positional.shift() ?? null;
  return { command, flags, positional };
}

export function defaultFcaHome(env = process.env) {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'FCA-Memory-Atlas');
}

export function isLoopbackHost(host) {
  const h = String(host ?? '').toLowerCase().trim();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]' || h === '127.0.0.2';
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function parseIntStrict(value, fallback, { min = -Infinity, max = Infinity, name = 'value' } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`配置项 ${name} 非法：${value}（要求 ${min}..${max} 的整数）`);
  }
  return n;
}

function readJsonFileSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 解析完整运行时配置。
 * @param {{argv?: string[], env?: NodeJS.ProcessEnv, cwd?: string}} [options]
 */
export function resolveConfig({ argv = [], env = process.env, cwd = process.cwd() } = {}) {
  const { command, flags, positional } = parseArgv(argv);
  const fcaHome = path.resolve(
    cwd,
    String(
      flags['fca-home'] ??
        flags['data-dir'] ??
        flags.home ??
        env.FCA_HOME ??
        env.FCA_DATA_DIR ??
        defaultFcaHome(env),
    ),
  );
  const configPath = path.join(fcaHome, 'config', 'runtime.json');
  const fileCfg = readJsonFileSafe(configPath);

  const pick = (...candidates) => candidates.find((v) => v !== undefined && v !== null && v !== '');
  const port = parseIntStrict(pick(flags.port, env.FCA_PORT, fileCfg.port, DEFAULT_PORT), DEFAULT_PORT, {
    min: 0,
    max: 65_535,
    name: 'port',
  });
  const host = String(pick(flags.host, env.FCA_HOST, fileCfg.host, DEFAULT_HOST));
  const allowRemote = parseBoolean(
    pick(flags['allow-remote'], env.FCA_ALLOW_REMOTE, fileCfg.allowRemote),
    false,
  );
  if (!allowRemote && !isLoopbackHost(host)) {
    throw new ConfigError(
      `拒绝监听非回环地址 ${host}：FCA Local Runtime 默认只允许 127.0.0.1。` +
        `如确需远程访问，请显式设置 FCA_ALLOW_REMOTE=1 或配置 allowRemote=true（安全风险自行承担）。`,
    );
  }

  const logLevel = String(pick(flags['log-level'], env.FCA_LOG_LEVEL, fileCfg.logLevel, 'info'));
  const dataDir = fcaHome;
  const paths = {
    home: dataDir,
    config: path.join(dataDir, 'config'),
    configFile: configPath,
    dbDir: path.join(dataDir, 'db'),
    db: path.join(dataDir, 'db', 'fca.db'),
    eventsDir: path.join(dataDir, 'events'),
    backupsDir: path.join(dataDir, 'backups'),
    logsDir: path.join(dataDir, 'logs'),
    exportsDir: path.join(dataDir, 'exports'),
    tempDir: path.join(dataDir, 'tmp'),
    secretsDir: path.join(dataDir, 'secrets'),
    tokenFile: path.join(dataDir, 'config', 'runtime-token'),
    pidFile: path.join(dataDir, 'runtime.pid'),
  };

  return Object.freeze({
    command,
    flags,
    positional,
    productVersion: PRODUCT_VERSION,
    apiVersion: API_VERSION,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    fcaHome,
    dataDir,
    paths,
    port,
    host,
    allowRemote,
    url: `http://${isLoopbackHost(host) ? (host === 'localhost' ? '127.0.0.1' : host) : host}:${port}`,
    logLevel,
    logMaxTail: parseIntStrict(env.FCA_LOG_TAIL ?? fileCfg.logMaxTail, 500, { min: 1, max: 10_000, name: 'logMaxTail' }),
    maxBodyBytes: parseIntStrict(pick(env.FCA_MAX_BODY_BYTES, fileCfg.maxBodyBytes), DEFAULT_MAX_BODY_BYTES, {
      min: 1024,
      max: 256 * 1024 * 1024,
      name: 'maxBodyBytes',
    }),
    sseHeartbeatMs: parseIntStrict(pick(env.FCA_SSE_HEARTBEAT_MS, fileCfg.sseHeartbeatMs), DEFAULT_SSE_HEARTBEAT_MS, {
      min: 50,
      max: 600_000,
      name: 'sseHeartbeatMs',
    }),
    sseReplayLimit: parseIntStrict(pick(env.FCA_SSE_REPLAY_LIMIT, fileCfg.sseReplayLimit), SSE_REPLAY_LIMIT, {
      min: 1,
      max: 100_000,
      name: 'sseReplayLimit',
    }),
    requestTimeoutMs: parseIntStrict(pick(env.FCA_REQUEST_TIMEOUT_MS, fileCfg.requestTimeoutMs), 30_000, {
      min: 1000,
      max: 300_000,
      name: 'requestTimeoutMs',
    }),
    // ---- LLM Gateway（ADR-007；全部可通过环境变量/配置文件覆盖）----
    llmRequestTimeoutMs: parseIntStrict(pick(env.FCA_LLM_TIMEOUT_MS, fileCfg.llmTimeoutMs), 30_000, {
      min: 1_000,
      max: 120_000,
      name: 'llmTimeoutMs',
    }),
    llmContextBudgetChars: parseIntStrict(pick(env.FCA_LLM_CONTEXT_BUDGET_CHARS, fileCfg.llmContextBudgetChars), 6_000, {
      min: 500,
      max: 100_000,
      name: 'llmContextBudgetChars',
    }),
    llmContextTopK: parseIntStrict(pick(env.FCA_LLM_CONTEXT_TOP_K, fileCfg.llmContextTopK), 5, {
      min: 1,
      max: 20,
      name: 'llmContextTopK',
    }),
    llmAutoRetry: parseBoolean(pick(env.FCA_LLM_AUTO_RETRY, fileCfg.llmAutoRetry), true),
    llmQueueRetryBaseMs: parseIntStrict(pick(env.FCA_LLM_QUEUE_RETRY_BASE_MS, fileCfg.llmQueueRetryBaseMs), 30_000, {
      min: 1_000,
      max: 3_600_000,
      name: 'llmQueueRetryBaseMs',
    }),
    env: String(env.FCA_ENV ?? 'production'),
    isTest: env.FCA_ENV === 'test',
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    hostname: os.hostname(),
    pid: process.pid,
    secrets: [],
  });
}

export function ensureDirectories(config) {
  const dirs = [
    config.paths.config,
    config.paths.dbDir,
    config.paths.eventsDir,
    config.paths.backupsDir,
    config.paths.logsDir,
    config.paths.exportsDir,
    config.paths.tempDir,
    config.paths.secretsDir,
  ];
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
  return config;
}

/** 默认 FCA_HOME（供 CLI 帮助/状态输出）。 */
export function describeDefaults() {
  return {
    fcaHome: defaultFcaHome(),
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    db: path.join(defaultFcaHome(), 'db', 'fca.db'),
  };
}
