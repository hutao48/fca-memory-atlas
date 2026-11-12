// FCA Local Runtime — HTTP 响应辅助（统一 JSON / 错误体格式，契约 §7）
import { ApiError, toErrorBody } from '../core/errors.js';

export function reply(body, status = 200, headers = {}) {
  return { status, body, headers };
}

export function created(body, headers = {}) {
  return reply(body, 201, headers);
}

export function noContent(headers = {}) {
  return { status: 204, body: undefined, headers };
}

export function sendJson(res, status, body, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  const text = body === undefined ? '' : JSON.stringify(body);
  const payload = body === undefined ? undefined : Buffer.from(text, 'utf8');
  const finalHeaders = {
    'Content-Type': 'application/json; charset=utf-8',
    ...(payload ? { 'Content-Length': String(payload.length) } : {}),
    ...headers,
  };
  res.writeHead(status, finalHeaders);
  if (payload) res.end(payload);
  else res.end();
  return payload ? payload.length : 0;
}

export function sendError(res, err, traceId) {
  const apiErr = err instanceof ApiError ? err : new ApiError('INTERNAL', err?.message ?? '内部错误');
  const body = toErrorBody(apiErr, traceId);
  const headers = {};
  if (apiErr.code === 'UNAUTHORIZED') headers['WWW-Authenticate'] = 'Bearer realm="fca-runtime"';
  return sendJson(res, apiErr.status, body, headers);
}
