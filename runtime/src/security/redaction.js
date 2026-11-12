// FCA Local Runtime — 日志脱敏（token/authorization/password/secret/api key 等）
const SENSITIVE_KEY_RE = /(token|authorization|auth|password|passwd|secret|api[_-]?key|credential|cookie|bearer)/i;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const TOKENISH_RE = /\b[a-f0-9]{48,128}\b/gi;

export function isSensitiveKey(key) {
  return SENSITIVE_KEY_RE.test(String(key));
}

/**
 * 深度脱敏对象；返回新对象（数组保序）。
 * @param {*} value
 * @param {number} [depth]
 */
export function redact(value, depth = 0) {
  if (depth > 8) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'error' && v && typeof v === 'object') {
        out[k] = redact(v, depth + 1);
      } else if (isSensitiveKey(k) && typeof v !== 'object') {
        out[k] = '***';
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

/** 字符串中的 Bearer/token 形态内容脱敏。 */
export function redactText(text) {
  if (typeof text !== 'string') return text;
  let s = text.replace(BEARER_RE, 'Bearer ***');
  s = s.replace(TOKENISH_RE, '***');
  return s;
}

/** 把已知 secret（运行时 token 等）替换掉。 */
export function redactSecrets(value, secrets = [], depth = 0) {
  if (!secrets || secrets.length === 0) return value;
  if (depth > 8) return value;
  if (typeof value === 'string') {
    let s = value;
    for (const secret of secrets) {
      if (secret && secret.length >= 16) s = s.split(secret).join('***');
    }
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, secrets, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactSecrets(v, secrets, depth + 1);
    return out;
  }
  return value;
}

/** 组合脱敏：先按 key 再按已知 secret。 */
export function sanitizeForLog(value, secrets = []) {
  return redactSecrets(redact(value), secrets);
}
