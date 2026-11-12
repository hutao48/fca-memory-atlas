// FCA Local Runtime — LLM API Key 本地加密（AES-256-GCM，ADR-007）
// 设计约束：
//  - 主密钥只存本机数据目录 <FCA_HOME>/secrets/master.key（32 字节随机数，权限 0600）；
//  - 数据库里只落密文信封 `enc:v1:<iv>:<tag>:<ciphertext>`（hex），绝不明文落盘；
//  - 日志/错误/HTTP 响应一律只给掩码（如 `sk-***abcd`）；
//  - 兼容旧版本遗留的明文 api_key 值：读取时允许解密为原文（由 providers 层负责写回密文）。
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const MASTER_KEY_BYTES = 32;
export const MASTER_KEY_FILE = 'master.key';
export const ENVELOPE_PREFIX = 'enc:v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';
const HEX_RE = /^[0-9a-f]+$/i;

/** 主密钥文件路径（secrets/master.key）。 */
export function masterKeyPath(config) {
  const dir = config?.paths?.secretsDir ?? path.join(config?.paths?.home ?? '.', 'secrets');
  return path.join(dir, MASTER_KEY_FILE);
}

const keyCache = new Map();

function parseKeyMaterial(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (text.length === MASTER_KEY_BYTES * 2 && HEX_RE.test(text)) return Buffer.from(text, 'hex');
  try {
    const b64 = Buffer.from(text, 'base64');
    if (b64.length === MASTER_KEY_BYTES) return b64;
  } catch {
    /* ignore */
  }
  const utf8 = Buffer.from(text, 'utf8');
  return utf8.length === MASTER_KEY_BYTES ? utf8 : null;
}

/**
 * 读取或创建主密钥（幂等）。首次创建时目录 0700、文件 0600。
 * @param {object} config runtime config（需 config.paths.secretsDir）
 * @param {{create?: boolean}} [options] create=false 时文件缺失返回 null
 * @returns {Buffer|null}
 */
export function loadMasterKey(config, { create = true } = {}) {
  const filePath = masterKeyPath(config);
  const cached = keyCache.get(filePath);
  if (cached) return cached;
  let key = null;
  try {
    key = parseKeyMaterial(fs.readFileSync(filePath, 'utf8'));
  } catch {
    key = null;
  }
  if (key) {
    keyCache.set(filePath, key);
    return key;
  }
  if (!create) return null;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  key = randomBytes(MASTER_KEY_BYTES);
  fs.writeFileSync(filePath, `${key.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(path.dirname(filePath), 0o700);
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* Windows 上 chmod 语义有限；文档中说明目录权限由安装器/用户 ACL 保证 */
  }
  keyCache.set(filePath, key);
  return key;
}

/** 仅测试/维护使用：清空进程内主密钥缓存。 */
export function clearMasterKeyCache() {
  keyCache.clear();
}

export function isEncryptedSecret(stored) {
  return typeof stored === 'string' && stored.startsWith(`${ENVELOPE_PREFIX}:`);
}

/**
 * 加密一个密钥字符串。返回可直接写入 SQLite 的密文信封。
 * @param {string} plaintext
 * @param {Buffer} masterKey
 */
export function encryptSecret(plaintext, masterKey) {
  if (typeof plaintext !== 'string') throw new TypeError('encryptSecret 需要字符串明文');
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== MASTER_KEY_BYTES) {
    throw new TypeError(`主密钥必须是 ${MASTER_KEY_BYTES} 字节 Buffer`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * 解密数据库中的 api_key 值。
 * @param {string|null} stored
 * @param {Buffer} masterKey
 * @returns {{value: string|null, encrypted: boolean}}
 *   encrypted=false 表示该值来自旧版本明文遗留（调用方应尽快重新加密写回）。
 */
export function decryptSecret(stored, masterKey) {
  if (stored === null || stored === undefined || stored === '') return { value: null, encrypted: false };
  const text = String(stored);
  if (!isEncryptedSecret(text)) return { value: text, encrypted: false };
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== MASTER_KEY_BYTES) {
    const err = new Error('主密钥不可用，无法解密已保存的 API Key（请重新配置 Provider）');
    err.code = 'LLM_KEY_UNREADABLE';
    throw err;
  }
  const parts = text.split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    const err = new Error('API Key 密文格式无法识别');
    err.code = 'LLM_KEY_UNREADABLE';
    throw err;
  }
  const iv = Buffer.from(parts[2], 'hex');
  const tag = Buffer.from(parts[3], 'hex');
  const ciphertext = Buffer.from(parts[4], 'hex');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    const err = new Error('API Key 密文参数损坏');
    err.code = 'LLM_KEY_UNREADABLE';
    throw err;
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, masterKey, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return { value: plaintext, encrypted: true };
  } catch {
    const err = new Error('API Key 解密失败（主密钥不匹配或密文被篡改），请重新配置 Provider');
    err.code = 'LLM_KEY_UNREADABLE';
    throw err;
  }
}

/**
 * 掩码：`sk-abcd…wxyz` 形态的 Key 显示为 `sk-***wxyz`；其它显示 `***wxyz`。
 * @param {string|null|undefined} plaintext
 * @returns {string|null}
 */
export function maskSecret(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const s = String(plaintext);
  if (s.length <= 4) return '***';
  const last4 = s.slice(-4);
  const prefixMatch = /^([A-Za-z]{2,5})([-_])/.exec(s);
  if (prefixMatch) return `${prefixMatch[1]}${prefixMatch[2]}***${last4}`;
  return `***${last4}`;
}
