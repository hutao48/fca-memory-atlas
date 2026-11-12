// FCA Local Runtime — 本地认证与回环限制（契约 §0）
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_BYTES = 32; // 64 hex chars

export function generateToken() {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * 确保 token 文件存在；服务端启动/init 时自动生成。
 * @returns {{token: string, created: boolean, tokenPath: string}}
 */
export function ensureTokenFile(tokenPath, { create = true } = {}) {
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing.length >= 32) return { token: existing, created: false, tokenPath };
  } catch {
    // fallthrough
  }
  if (!create) {
    const err = new Error(
      `未找到 Runtime 认证 token 文件：${tokenPath}。请先运行 fca-runtime init 生成，或启动一次 fca-runtime serve。`,
    );
    err.code = 'TOKEN_NOT_FOUND';
    throw err;
  }
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  const token = generateToken();
  fs.writeFileSync(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  return { token, created: true, tokenPath };
}

export function readTokenFile(tokenPath) {
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  if (!token) {
    const err = new Error(`Runtime token 文件为空：${tokenPath}`);
    err.code = 'TOKEN_EMPTY';
    throw err;
  }
  return token;
}

export function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    // 仍执行一次比较，行为尽量恒定
    try {
      timingSafeEqual(ba, ba);
    } catch {
      /* ignore */
    }
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export function extractBearerToken(req) {
  const header = req.headers?.authorization;
  if (!header || typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  return match[1].trim();
}

/**
 * 登录校验：Bearer token 必须与 token 文件一致。
 * 注意：/events/stream 额外允许 ?token=（EventSource 不能自定义 header 的兼容路径，
 * Desktop 用 fetch 流时仍应使用标准 Authorization header）。
 */
export function authenticateRequest(req, token, { allowQueryToken = false } = {}) {
  const headerToken = extractBearerToken(req);
  if (headerToken !== null) {
    return { ok: timingSafeEqualStr(headerToken, token), via: 'header' };
  }
  if (allowQueryToken) {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const qToken = url.searchParams.get('token') ?? url.searchParams.get('access_token');
      if (qToken) return { ok: timingSafeEqualStr(qToken, token), via: 'query' };
    } catch {
      /* ignore */
    }
  }
  return { ok: false, via: null };
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackAddress(address) {
  if (!address) return false;
  const normalized = String(address);
  if (LOOPBACK_ADDRESSES.has(normalized)) return true;
  return normalized.startsWith('127.');
}

export function isLoopbackHost(host) {
  const h = String(host ?? '').toLowerCase().trim();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

/** token 文件中的 token 仅用于本机回环客户端；用于日志脱敏 secrets 列表。 */
export function tokenSecrets(token) {
  return token ? [token] : [];
}
