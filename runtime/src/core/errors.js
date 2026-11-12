// FCA Local Runtime — 统一错误码（契约 §7，严格映射 HTTP 状态）
export const ERROR_HTTP_STATUS = Object.freeze({
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
  DUPLICATE: 409,
  GONE: 410,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  NOT_INITIALIZED: 503,
  DATABASE_ERROR: 503,
  BACKUP_FAILED: 500,
  RESTORE_FAILED: 500,
  IMPORT_FAILED: 422,
  LLM_NOT_CONFIGURED: 409,
  LLM_UNAVAILABLE: 503,
  SHUTTING_DOWN: 503,
});

export class ApiError extends Error {
  /**
   * @param {string} code 契约 §7 中的错误码
   * @param {string} message 人类可读信息（可能含中文）
   * @param {object} [details]
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.code = ERROR_HTTP_STATUS[code] ? code : 'INTERNAL';
    this.status = ERROR_HTTP_STATUS[this.code];
    this.details = details ?? {};
  }
}

export class ConfigError extends Error {
  constructor(message, code = 'CONFIG_ERROR') {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.exitCode = 2;
  }
}

export function badRequest(message, details) {
  return new ApiError('BAD_REQUEST', message, details);
}

/**
 * 字段校验失败：details.fields = [{field, message}]
 * @param {Array<{field?:string,message:string}>|Record<string,string>} fields
 */
export function validationFailed(fields, message = '请求字段校验失败') {
  let list;
  if (Array.isArray(fields)) {
    list = fields.map((f) => ({ field: f.field ?? null, message: String(f.message ?? f) }));
  } else if (fields && typeof fields === 'object') {
    list = Object.entries(fields).map(([field, m]) => ({ field, message: String(m) }));
  } else {
    list = [{ field: null, message: String(fields ?? 'invalid') }];
  }
  return new ApiError('VALIDATION_FAILED', message, { fields: list });
}

export function unauthorized(message = '缺少或错误的 Bearer token') {
  return new ApiError('UNAUTHORIZED', message);
}

export function forbidden(message = '当前地址或权限不允许该操作') {
  return new ApiError('FORBIDDEN', message);
}

export function notFound(message = '对象不存在') {
  return new ApiError('NOT_FOUND', message);
}

export function gone(message = '对象已被硬删除') {
  return new ApiError('GONE', message);
}

export function conflict(message = '冲突', details) {
  return new ApiError('CONFLICT', message, details);
}

export function versionConflict(currentVersion, message = '版本冲突：数据已被其它操作修改') {
  return new ApiError('VERSION_CONFLICT', message, { current_version: currentVersion });
}

export function duplicate(existingId, message = '重复的唯一键') {
  return new ApiError('DUPLICATE', message, { existing_id: existingId });
}

export function payloadTooLarge(maxBytes, message = `请求体超过限制（最大 ${maxBytes} 字节）`) {
  return new ApiError('PAYLOAD_TOO_LARGE', message, { max_bytes: maxBytes });
}

export function unsupportedMediaType(message = 'Content-Type 必须为 application/json') {
  return new ApiError('UNSUPPORTED_MEDIA_TYPE', message);
}

export function internal(message = '内部错误', details) {
  return new ApiError('INTERNAL', message, details);
}

export function databaseError(message = 'SQLite 数据库错误', details) {
  return new ApiError('DATABASE_ERROR', message, details);
}

export function backupFailed(message = '备份失败', details) {
  return new ApiError('BACKUP_FAILED', message, details);
}

export function restoreFailed(message = '恢复失败', details) {
  return new ApiError('RESTORE_FAILED', message, details);
}

export function importFailed(message = '导入失败', details) {
  return new ApiError('IMPORT_FAILED', message, details);
}

export function llmNotConfigured(message = 'LLM Provider 尚未配置', details = undefined) {
  return new ApiError('LLM_NOT_CONFIGURED', message, details);
}

export function llmUnavailable(message = 'LLM 服务不可用', details = undefined) {
  return new ApiError('LLM_UNAVAILABLE', message, details);
}

export function notInitialized(message = '数据库尚未初始化，请先调用 POST /api/v1/db/init') {
  return new ApiError('NOT_INITIALIZED', message);
}

export function shuttingDown() {
  return new ApiError('SHUTTING_DOWN', 'Runtime 正在关闭');
}

/** 将任意异常规范化为契约错误体。 */
export function toErrorBody(err, traceId) {
  if (err instanceof ApiError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        details: err.details ?? {},
        trace_id: traceId,
      },
    };
  }
  const message = err && err.message ? String(err.message) : '内部错误';
  return {
    error: {
      code: 'INTERNAL',
      message,
      details: {},
      trace_id: traceId,
    },
  };
}

export function isSqliteError(err) {
  if (!err) return false;
  const code = String(err.code ?? '');
  const msg = String(err.message ?? '');
  return /SQLITE|constraint|database|sqlite/i.test(code) || /SQLITE|constraint failed|database (is locked|disk)/i.test(msg);
}
