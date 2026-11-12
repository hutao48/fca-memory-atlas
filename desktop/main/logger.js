'use strict';

/**
 * FCA Desktop — 应用日志
 * 写入 <FCA_HOME>/logs/desktop-YYYYMMDD.log（JSONL，逐行），自动脱敏 token / authorization 等敏感字段。
 * 同时输出到 stdout（便于捕获进程输出排障）。
 */

const fs = require('node:fs');
const path = require('node:path');

const SENSITIVE_KEY_RE = /(token|authorization|password|secret|api[_-]?key|credential|cookie)/i;
const SENSITIVE_VALUE_RE = [
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /(token["':=\s]+)[A-Za-z0-9._~+/=-]{8,}/gi,
];

function redactValue(value, depth) {
  if (depth > 6) return '[DEPTH_LIMIT]';
  if (value == null) return value;
  if (typeof value === 'string') {
    let out = value;
    for (const re of SENSITIVE_VALUE_RE) out = out.replace(re, '$1[REDACTED]');
    return out;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(key)) out[key] = '[REDACTED]';
      else out[key] = redactValue(val, depth + 1);
    }
    return out;
  }
  return value;
}

function redact(meta) {
  if (!meta) return undefined;
  try {
    return redactValue(meta, 0);
  } catch {
    return { _redact_error: true };
  }
}

function timestampParts(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return {
    y: date.getFullYear(),
    m: pad(date.getMonth() + 1),
    d: pad(date.getDate()),
    hh: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds()),
    ms: String(date.getMilliseconds()).padStart(3, '0'),
  };
}

function createLogger(options = {}) {
  let logDir = options.logDir || null;
  let fileStamp = null;
  let filePath = null;
  let queue = Promise.resolve();
  let mirrorToConsole = options.mirrorToConsole !== false;
  const recent = [];
  const maxRecent = 300;

  function ensureFile() {
    if (!logDir) return null;
    const now = new Date();
    const p = timestampParts(now);
    const stamp = `${p.y}${p.m}${p.d}`;
    if (fileStamp !== stamp || !filePath) {
      fileStamp = stamp;
      try {
        fs.mkdirSync(logDir, { recursive: true });
        filePath = path.join(logDir, `desktop-${stamp}.log`);
      } catch {
        filePath = null;
      }
    }
    return filePath;
  }

  function write(level, scope, message, meta) {
    const payload = {
      ts: new Date().toISOString(),
      level,
      scope,
      msg: typeof message === 'string' ? message : String(message),
    };
    if (meta !== undefined) payload.meta = redact(meta);
    if (options.appVersion) payload.app = options.appVersion;
    if (options.pid !== false) payload.pid = process.pid;

    const line = JSON.stringify(payload);
    recent.push(payload);
    if (recent.length > maxRecent) recent.shift();

    const target = ensureFile();
    if (target) {
      queue = queue
        .then(() => fs.promises.appendFile(target, `${line}\n`, 'utf8'))
        .catch(() => {});
    }
    if (mirrorToConsole) {
      const prefix = `[${payload.ts}] [${level.toUpperCase()}] [${scope}]`;
      if (level === 'error') console.error(prefix, payload.msg, payload.meta ?? '');
      else console.log(prefix, payload.msg, payload.meta ?? '');
    }
    return payload;
  }

  return {
    get logDir() {
      return logDir;
    },
    get filePath() {
      return filePath;
    },
    setLogDir(dir) {
      if (dir && dir !== logDir) {
        logDir = dir;
        fileStamp = null;
        filePath = null;
        ensureFile();
      }
    },
    setMirrorConsole(v) {
      mirrorToConsole = Boolean(v);
    },
    info(scope, message, meta) {
      return write('info', scope, message, meta);
    },
    warn(scope, message, meta) {
      return write('warn', scope, message, meta);
    },
    error(scope, message, meta) {
      return write('error', scope, message, meta);
    },
    debug(scope, message, meta) {
      return write('debug', scope, message, meta);
    },
    child(scope) {
      return {
        info: (message, meta) => write('info', scope, message, meta),
        warn: (message, meta) => write('warn', scope, message, meta),
        error: (message, meta) => write('error', scope, message, meta),
        debug: (message, meta) => write('debug', scope, message, meta),
      };
    },
    recent(limit = 100) {
      return recent.slice(-limit);
    },
    async flush() {
      try {
        await queue;
      } catch {
        /* ignore */
      }
    },
    redact,
  };
}

module.exports = { createLogger, redact };
