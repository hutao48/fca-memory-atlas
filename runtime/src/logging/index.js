// FCA Local Runtime — JSONL 结构化日志（<FCA_HOME>/logs/runtime-YYYYMMDD.log）+ 访问日志
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeForLog, redact } from '../security/redaction.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
// 单文件 JSONL 上限；超过后轮转为 .1（保留最近一份）。
// 背景：2026-11-12 EPIPE 死循环曾把 runtime 日志刷到 4.6GB，需要硬性兜底。
const MAX_LOG_BYTES = 64 * 1024 * 1024;
let sizeCheckCounter = 0;

function dayStamp(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function parseIsoSafe(s) {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function createLogger({ config, stderr = process.stderr, stdout = process.stdout, silent = false } = {}) {
  const secrets = [];
  let level = LEVELS[config.logLevel] ? config.logLevel : 'info';
  let filePath = path.join(config.paths.logsDir, `runtime-${dayStamp()}.log`);
  let stream = null;
  let closed = false;
  // 父进程（桌面 app/终端）崩溃或被强杀后，stdout/stderr 管道会关闭；
  // 此时对控制台的写入会触发 EPIPE 'error' 事件（异步），若无人监听会导致
  // uncaughtException 循环（每次日志都写一次 stderr → 又一次 EPIPE → 无限刷屏，
  // 事件循环被占满，/health 超时）。这里在首次 EPIPE 后永久关闭控制台输出，
  // 只保留文件日志；Runtime 继续对外提供服务。
  let consoleBroken = Boolean(silent);
  if (stderr && typeof stderr.on === 'function') {
    stderr.on('error', () => {
      consoleBroken = true;
    });
  }

  function ensureStream() {
    if (stream || closed) return stream;
    try {
      fs.mkdirSync(config.paths.logsDir, { recursive: true });
      stream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
      stream.on('error', () => {
        stream = null;
      });
    } catch {
      stream = null;
    }
    return stream;
  }

  function currentFilePath() {
    const todayPath = path.join(config.paths.logsDir, `runtime-${dayStamp()}.log`);
    if (todayPath !== filePath) {
      filePath = todayPath;
      if (stream) {
        try {
          stream.end();
        } catch {
          /* ignore */
        }
        stream = null;
      }
    }
    return filePath;
  }

  /** 超过上限时把当前文件轮转为 <file>.1，并重新打开新文件（防单次故障刷爆磁盘）。 */
  function rotateIfNeeded() {
    if (!stream) return;
    sizeCheckCounter += 1;
    if (sizeCheckCounter % 200 !== 0) return;
    try {
      const size = fs.statSync(currentFilePath()).size;
      if (size < MAX_LOG_BYTES) return;
      try {
        stream.end();
      } catch {
        /* ignore */
      }
      stream = null;
      try {
        fs.rmSync(`${filePath}.1`, { force: true });
        fs.renameSync(filePath, `${filePath}.1`);
      } catch {
        /* 轮转失败时下次继续尝试；不影响写入 */
      }
    } catch {
      /* ignore */
    }
  }

  function write(levelName, msg, fields = {}) {
    if (LEVELS[levelName] < LEVELS[level]) return;
    const entry = {
      ts: new Date().toISOString(),
      level: levelName,
      msg: String(msg),
      ...fields,
    };
    const clean = sanitizeForLog(entry, secrets);
    const line = `${JSON.stringify(clean)}\n`;
    rotateIfNeeded();
    const s = ensureStream();
    if (s) s.write(line);
    if (!consoleBroken) {
      const rendered = fields && Object.keys(fields).length ? ` ${JSON.stringify(sanitizeForLog(fields, secrets))}` : '';
      try {
        stderr.write(`[${clean.ts}] ${levelName.toUpperCase().padEnd(5)} ${clean.msg}${rendered}\n`);
      } catch (err) {
        consoleBroken = true;
      }
    }
    return clean;
  }

  function addSecret(secret) {
    if (secret && typeof secret === 'string' && !secrets.includes(secret)) secrets.push(secret);
  }

  function child(bindings = {}) {
    return {
      debug: (msg, fields) => write('debug', msg, { ...bindings, ...fields }),
      info: (msg, fields) => write('info', msg, { ...bindings, ...fields }),
      warn: (msg, fields) => write('warn', msg, { ...bindings, ...fields }),
      error: (msg, fields) => write('error', msg, { ...bindings, ...fields }),
      addSecret,
      access: (entry) => write('info', 'http.request', { kind: 'access', ...entry }),
      raw: write,
      child,
      get level() {
        return level;
      },
      setLevel(next) {
        if (LEVELS[next]) level = next;
      },
      flush() {
        return new Promise((resolve) => {
          if (stream) stream.end(() => resolve());
          else resolve();
        });
      },
      close() {
        closed = true;
        if (stream) {
          try {
            stream.end();
          } catch {
            /* ignore */
          }
          stream = null;
        }
      },
      currentFilePath,
    };
  }

  return child();
}

/**
 * 读取日志尾部（解析 JSONL，脱敏已写入内容）。
 * @param {object} config
 * @param {{level?:string, limit?:number, since?:string}} options
 */
export function tailLogs(config, { level = null, limit = 100, since = null } = {}) {
  const logsDir = config.paths.logsDir;
  const files = (() => {
    try {
      return fs
        .readdirSync(logsDir)
        .filter((f) => /^runtime-\d{8}\.log$/.test(f))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  })();
  const entries = [];
  const sinceDate = since ? parseIsoSafe(since) : null;
  outer: for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(logsDir, file), 'utf8');
    } catch {
      continue;
    }
    const lines = raw.split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (level && LEVELS[entry.level] < LEVELS[level]) continue;
      if (sinceDate) {
        const ts = parseIsoSafe(entry.ts);
        if (!ts || ts < sinceDate) continue;
      }
      entries.push(entry);
      if (entries.length >= limit) break outer;
    }
  }
  return entries.reverse();
}
