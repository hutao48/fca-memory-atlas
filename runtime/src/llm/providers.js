// FCA Local Runtime — LLM Provider 配置存储（ADR-007）
// Provider 抽象：kind ∈ deepseek | openai-compatible | custom；支持多个 Provider 与默认选择。
// 约定：
//  - API Key 只以 AES-256-GCM 密文信封落库（见 key-vault.js），对外只返回掩码；
//  - provider_id 复用 ent_ 前缀（内部对象，不在公共 ID 契约表内；与旧离线兜底兼容）；
//  - “默认 Provider”存 meta.llm_default_provider_id，避免变更公共数据库 schema。
import { newId } from '../core/ids.js';
import { nowIso } from '../core/time.js';
import { getMeta, setMeta } from '../persistence/db.js';
import { validationFailed, notFound, duplicate, badRequest, llmNotConfigured, ApiError } from '../core/errors.js';
import { loadMasterKey, encryptSecret, decryptSecret, maskSecret, isEncryptedSecret } from './key-vault.js';

export const PROVIDER_KINDS = Object.freeze(['deepseek', 'openai-compatible', 'custom']);
export const DEFAULT_PROVIDER_META_KEY = 'llm_default_provider_id';
const KIND_SET = new Set(PROVIDER_KINDS);
const KIND_ALIASES = Object.freeze({
  deepseek: 'deepseek',
  openai: 'openai-compatible',
  'openai-compatible': 'openai-compatible',
  openai_compatible: 'openai-compatible',
  custom: 'custom',
});
const PRESETS = Object.freeze({
  deepseek: { base_url: 'https://api.deepseek.com', model: 'deepseek-chat', timeout_ms: 60_000 },
  'openai-compatible': { base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', timeout_ms: 30_000 },
  custom: { base_url: null, model: null, timeout_ms: 30_000 },
});
const MAX_NAME = 200;
const MAX_MODEL = 200;
const MAX_KEY = 4096;
const MIN_TIMEOUT = 1_000;
const MAX_TIMEOUT = 120_000;

/** 桌面端 Provider 类型使用 openai_compatible（下划线），对外响应同时给出 type 别名。 */
export function desktopProviderType(kind) {
  return kind === 'openai-compatible' ? 'openai_compatible' : kind;
}

function normalizeKind(input, errors) {
  const raw = input?.kind ?? input?.type;
  const kind = KIND_ALIASES[String(raw ?? '')];
  if (!kind) {
    errors.push({ field: 'kind', message: `必须是 ${PROVIDER_KINDS.join('|')}（也接受 type: openai_compatible）` });
    return 'custom';
  }
  return kind;
}

function normalizeBaseUrl(value, errors, field = 'base_url') {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const s = String(value).trim();
  if (!/^https?:\/\/[^\s]+$/i.test(s)) {
    errors.push({ field, message: '必须是 http(s) URL' });
    return null;
  }
  return s.replace(/\/+$/, '');
}

function normalizeModel(value, errors) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const s = String(value).trim();
  if (s.length > MAX_MODEL) {
    errors.push({ field: 'model', message: `不得超过 ${MAX_MODEL} 字符` });
    return null;
  }
  return s;
}

function normalizeTimeout(value, errors) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null; // null = 使用 kind 预设
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_TIMEOUT || n > MAX_TIMEOUT) {
    errors.push({ field: 'timeout_ms', message: `必须是 ${MIN_TIMEOUT}..${MAX_TIMEOUT} 的整数` });
    return null;
  }
  return n;
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Provider 存储。dbHolder 提供连接；config 提供 secrets 目录。
 */
export function createProviderStore({ dbHolder, config, logger }) {
  const db = () => dbHolder.requireDb();
  let cachedMasterKey = null;

  function masterKey() {
    if (!cachedMasterKey) cachedMasterKey = loadMasterKey(config);
    return cachedMasterKey;
  }

  function defaultProviderId(d) {
    const value = getMeta(d, DEFAULT_PROVIDER_META_KEY, null);
    return value ? String(value) : null;
  }

  function setDefaultProviderId(d, providerId) {
    setMeta(d, DEFAULT_PROVIDER_META_KEY, providerId ?? '');
  }

  function timeoutMetaKey(providerId) {
    return `llm_provider_timeout:${providerId}`;
  }

  /** Provider 超时：meta 中的显式配置 > kind 预设 > 全局配置。 */
  function timeoutFor(row, d = null) {
    try {
      const stored = getMeta(d ?? db(), timeoutMetaKey(row.provider_id), null);
      const n = Number(stored);
      if (Number.isInteger(n) && n >= MIN_TIMEOUT && n <= MAX_TIMEOUT) return n;
    } catch {
      /* ignore */
    }
    return PRESETS[row.kind]?.timeout_ms ?? config.llmRequestTimeoutMs ?? 30_000;
  }

  /** 把数据库行装配为对外 Provider（Key 永远只给掩码）。 */
  function presentProvider(row, d) {
    if (!row) return null;
    const defId = defaultProviderId(d ?? db());
    let masked = null;
    let keyError = null;
    if (row.api_key) {
      try {
        const { value } = decryptSecret(row.api_key, masterKey());
        masked = maskSecret(value);
      } catch (err) {
        keyError = err.code ?? 'LLM_KEY_UNREADABLE';
        masked = '***';
        logger?.warn?.('LLM Provider API Key 无法解密（需重新配置）', { provider_id: row.provider_id, error: err.message });
      }
    }
    return {
      provider_id: row.provider_id,
      id: row.provider_id,
      name: row.name,
      kind: row.kind,
      type: desktopProviderType(row.kind),
      base_url: row.base_url ?? null,
      model: row.model ?? null,
      enabled: Boolean(row.enabled),
      is_default: defId ? defId === row.provider_id : false,
      has_api_key: Boolean(row.api_key),
      api_key_masked: masked,
      key_error: keyError,
      timeout_ms: timeoutFor(row, d),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  function list() {
    const d = db();
    const rows = d.prepare('SELECT * FROM llm_providers ORDER BY created_at ASC, provider_id ASC').all();
    const items = rows.map((row) => presentProvider(row, d));
    return { items, total: items.length };
  }

  function getRow(id) {
    if (typeof id !== 'string' || !id) return null;
    return db().prepare('SELECT * FROM llm_providers WHERE provider_id = ?').get(id) ?? null;
  }

  function get(id) {
    const row = getRow(id);
    if (!row) throw notFound(`LLM Provider 不存在：${id}`);
    return presentProvider(row);
  }

  /** 解密 API Key；旧版明文遗留会自动重新加密写回，保证“不落盘明文”。 */
  function revealApiKey(row) {
    if (!row?.api_key) return null;
    if (!isEncryptedSecret(row.api_key)) {
      const plaintext = String(row.api_key);
      try {
        const encrypted = encryptSecret(plaintext, masterKey());
        db().prepare('UPDATE llm_providers SET api_key = ?, updated_at = ? WHERE provider_id = ?').run(encrypted, nowIso(), row.provider_id);
        row.api_key = encrypted;
        logger?.info?.('已将旧版明文 API Key 迁移为 AES-256-GCM 密文', { provider_id: row.provider_id });
      } catch (err) {
        logger?.warn?.('旧版明文 API Key 重新加密失败（仍按明文使用）', { provider_id: row.provider_id, error: err.message });
      }
      return plaintext;
    }
    return decryptSecret(row.api_key, masterKey()).value;
  }

  function validateCreate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('Provider 必须是 JSON 对象');
    const errors = [];
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) errors.push({ field: 'name', message: '必填' });
    else if (name.length > MAX_NAME) errors.push({ field: 'name', message: `不得超过 ${MAX_NAME} 字符` });
    const kind = normalizeKind(input, errors);
    const preset = PRESETS[kind];
    let baseUrl = normalizeBaseUrl(input.base_url, errors);
    if (baseUrl === undefined) baseUrl = preset.base_url;
    let model = normalizeModel(input.model, errors);
    if (model === undefined) model = preset.model;
    let timeoutMs = normalizeTimeout(input.timeout_ms, errors);
    if (timeoutMs === undefined || timeoutMs === null) timeoutMs = preset.timeout_ms;
    let apiKey = null;
    if (input.api_key !== undefined && input.api_key !== null && input.api_key !== '') {
      const key = String(input.api_key).trim();
      if (key.length > MAX_KEY) errors.push({ field: 'api_key', message: `不得超过 ${MAX_KEY} 字符` });
      else if (!key) errors.push({ field: 'api_key', message: '不能为空' });
      else apiKey = key;
    }
    let enabled = true;
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') errors.push({ field: 'enabled', message: '必须是布尔值' });
      else enabled = input.enabled;
    }
    let isDefault = false;
    if (input.is_default !== undefined) {
      if (typeof input.is_default !== 'boolean') errors.push({ field: 'is_default', message: '必须是布尔值' });
      else isDefault = input.is_default;
    }
    if (errors.length) throw validationFailed(errors);
    if (kind !== 'custom' && !baseUrl) throw validationFailed([{ field: 'base_url', message: `${kind} 类型需要 Base URL` }]);
    return { name, kind, baseUrl, model, timeoutMs, apiKey, enabled, isDefault };
  }

  function create(input) {
    const fields = validateCreate(input);
    const d = db();
    const existing = d.prepare('SELECT provider_id FROM llm_providers WHERE name = ?').get(fields.name);
    if (existing) throw duplicate(existing.provider_id, `LLM Provider 名称已存在：${fields.name}`);
    const providerId = newId('entity'); // 内部对象 ID，与旧离线兜底实现保持兼容
    const now = nowIso();
    const apiKeyEnc = fields.apiKey ? encryptSecret(fields.apiKey, masterKey()) : null;
    d.exec('BEGIN IMMEDIATE');
    try {
      d.prepare(
        `INSERT INTO llm_providers(provider_id, name, kind, base_url, model, api_key, enabled, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(providerId, fields.name, fields.kind, fields.baseUrl, fields.model, apiKeyEnc, fields.enabled ? 1 : 0, now, now);
      setMeta(d, timeoutMetaKey(providerId), String(fields.timeoutMs));
      if (fields.isDefault) setDefaultProviderId(d, providerId);
      d.exec('COMMIT');
    } catch (err) {
      try {
        d.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      if (/UNIQUE|constraint/i.test(String(err.message ?? ''))) throw duplicate(null, `LLM Provider 名称已存在：${fields.name}`);
      throw err;
    }
    logger?.info?.('LLM Provider 已创建', { provider_id: providerId, kind: fields.kind, enabled: fields.enabled, is_default: fields.isDefault });
    return presentProvider(getRow(providerId));
  }

  function patch(id, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('Provider 必须是 JSON 对象');
    const row = getRow(id);
    if (!row) throw notFound(`LLM Provider 不存在：${id}`);
    const errors = [];
    const next = {
      name: row.name,
      kind: row.kind,
      base_url: row.base_url,
      model: row.model,
      enabled: Boolean(row.enabled),
      timeout_ms: timeoutFor(row),
      api_key: row.api_key,
    };
    let isDefault;
    if (input.name !== undefined) {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name) errors.push({ field: 'name', message: '不能为空' });
      else if (name.length > MAX_NAME) errors.push({ field: 'name', message: `不得超过 ${MAX_NAME} 字符` });
      else next.name = name;
    }
    if (input.kind !== undefined || input.type !== undefined) next.kind = normalizeKind(input, errors);
    if (input.base_url !== undefined) {
      const baseUrl = normalizeBaseUrl(input.base_url, errors);
      next.base_url = baseUrl;
    }
    if (input.model !== undefined) next.model = normalizeModel(input.model, errors);
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') errors.push({ field: 'enabled', message: '必须是布尔值' });
      else next.enabled = input.enabled;
    }
    if (input.timeout_ms !== undefined) {
      const t = normalizeTimeout(input.timeout_ms, errors);
      next.timeout_ms = t === null ? PRESETS[next.kind]?.timeout_ms ?? 30_000 : t;
    }
    if (input.is_default !== undefined) {
      if (typeof input.is_default !== 'boolean') errors.push({ field: 'is_default', message: '必须是布尔值' });
      else isDefault = input.is_default;
    }
    // API Key：undefined=不修改；null/''=清除；字符串=重新加密写入
    if (input.api_key !== undefined) {
      if (input.api_key === null || input.api_key === '') next.api_key = null;
      else {
        const key = String(input.api_key).trim();
        if (!key) next.api_key = null;
        else if (key.length > MAX_KEY) errors.push({ field: 'api_key', message: `不得超过 ${MAX_KEY} 字符` });
        else next.api_key = key;
      }
    }
    if (errors.length) throw validationFailed(errors);
    if (next.kind !== 'custom' && !next.base_url) throw validationFailed([{ field: 'base_url', message: `${next.kind} 类型需要 Base URL` }]);
    const conflict = db().prepare('SELECT provider_id FROM llm_providers WHERE name = ? AND provider_id != ?').get(next.name, id);
    if (conflict) throw duplicate(conflict.provider_id, `LLM Provider 名称已存在：${next.name}`);
    const apiKeyEnc = next.api_key && !isEncryptedSecret(next.api_key) ? encryptSecret(next.api_key, masterKey()) : next.api_key;
    const d = db();
    d.exec('BEGIN IMMEDIATE');
    try {
      d.prepare(
        `UPDATE llm_providers SET name=?, kind=?, base_url=?, model=?, api_key=?, enabled=?, updated_at=? WHERE provider_id=?`,
      ).run(next.name, next.kind, next.base_url, next.model, apiKeyEnc, next.enabled ? 1 : 0, nowIso(), id);
      if (input.timeout_ms !== undefined) {
        if (input.timeout_ms === null || input.timeout_ms === '') {
          d.prepare('DELETE FROM meta WHERE key = ?').run(timeoutMetaKey(id));
        } else {
          setMeta(d, timeoutMetaKey(id), String(next.timeout_ms));
        }
      }
      if (isDefault === true) {
        setDefaultProviderId(d, id);
      } else if (isDefault === false && defaultProviderId(d) === id) {
        setDefaultProviderId(d, null);
      }
      d.exec('COMMIT');
    } catch (err) {
      try {
        d.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    logger?.info?.('LLM Provider 已更新', { provider_id: id, enabled: next.enabled });
    return presentProvider(getRow(id));
  }

  function remove(id) {
    const row = getRow(id);
    if (!row) throw notFound(`LLM Provider 不存在：${id}`);
    const d = db();
    d.exec('BEGIN IMMEDIATE');
    try {
      d.prepare('DELETE FROM llm_providers WHERE provider_id = ?').run(id);
      if (defaultProviderId(d) === id) setDefaultProviderId(d, null);
      d.exec('COMMIT');
    } catch (err) {
      try {
        d.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    logger?.info?.('LLM Provider 已删除', { provider_id: id });
    return { deleted: true, provider_id: id };
  }

  /**
   * 选择本次调用使用的 Provider 行。
   * 优先级：显式 provider_id > 默认 Provider > 最早创建的启用 Provider。
   * @param {string|null} providerId
   * @param {{allowNone?: boolean}} [options] allowNone=true 时“一个都没配置”返回 null（由路由入离线队列）
   */
  function pickForRequest(providerId = null, { allowNone = false } = {}) {
    const d = db();
    if (providerId) {
      const row = d.prepare('SELECT * FROM llm_providers WHERE provider_id = ?').get(String(providerId));
      if (!row) throw notFound(`LLM Provider 不存在：${providerId}`);
      if (!row.enabled) throw llmNotConfigured(`LLM Provider 已禁用：${row.name}`, { provider_id: row.provider_id, reason: 'provider_disabled' });
      return row;
    }
    const defId = defaultProviderId(d);
    if (defId) {
      const row = d.prepare('SELECT * FROM llm_providers WHERE provider_id = ? AND enabled = 1').get(defId);
      if (row) return row;
    }
    const row = d.prepare('SELECT * FROM llm_providers WHERE enabled = 1 ORDER BY created_at ASC, provider_id ASC LIMIT 1').get();
    if (row) return row;
    if (allowNone) return null;
    throw llmNotConfigured('尚未配置可用的 LLM Provider（本地记忆功能不受影响）', {
      reason: 'no_provider_configured',
      how_to: 'POST /api/v1/llm/providers {name, kind: deepseek|openai-compatible|custom, base_url, model, api_key}',
    });
  }

  /** 调用参数（含明文 Key；只在内存中短暂存在，绝不写日志/响应）。 */
  function runtimeConfig(row) {
    let apiKey = null;
    if (row.api_key) {
      try {
        apiKey = revealApiKey(row);
      } catch (err) {
        throw new ApiError('LLM_NOT_CONFIGURED', `Provider ${row.name} 的 API Key 无法解密：${err.message}`, {
          provider_id: row.provider_id,
          reason: 'key_unreadable',
        });
      }
    }
    const model = row.model ?? PRESETS[row.kind]?.model ?? null;
    if (!model) throw llmNotConfigured(`Provider ${row.name} 未配置模型名`, { provider_id: row.provider_id, reason: 'missing_model' });
    return {
      id: row.provider_id,
      name: row.name,
      kind: row.kind,
      baseUrl: row.base_url ?? PRESETS[row.kind]?.base_url ?? null,
      model,
      timeoutMs: timeoutFor(row),
      apiKey,
    };
  }

  return {
    list,
    get,
    getRow,
    create,
    patch,
    remove,
    pickForRequest,
    runtimeConfig,
    presentProvider,
    revealApiKey,
    PRESETS,
  };
}

export { parseJson };
