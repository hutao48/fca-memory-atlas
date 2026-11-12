// FCA Local Runtime — API 路由共用工具（请求元信息 / 查询参数解析）
import { badRequest, validationFailed } from '../core/errors.js';

const ACTOR_DISPLAY = {
  desktop: '桌面应用',
  'dsh-plugin': 'DSH 插件',
  cli: 'CLI',
  test: '测试客户端',
};

/**
 * 构造写操作的事件元信息（actor/source/trace_id）。
 * @param {object} ctx 路由上下文
 * @param {{system?: boolean}} [options]
 */
export function requestMeta(ctx, { system = false } = {}) {
  const clientKind = ctx.clientKind ?? 'cli';
  const actorKind = system ? 'system' : clientKind === 'dsh-plugin' ? 'agent' : 'user';
  const actorId = actorKind === 'system' ? 'runtime' : clientKind === 'dsh-plugin' ? 'dsh-plugin' : 'local';
  return {
    actor: { kind: actorKind, id: actorId, display: system ? '系统' : ACTOR_DISPLAY[clientKind] ?? clientKind },
    source: { kind: clientKind, id: `${clientKind}-main`, version: ctx.config.productVersion },
    traceId: ctx.traceId,
  };
}

export function splitList(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value.flatMap((item) => splitList(item));
  if (typeof value === 'object') return Object.values(value).flatMap((item) => splitList(item));
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

export function parseJsonField(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    throw validationFailed([{ field, message: '必须是合法 JSON' }]);
  }
}

export function parseNumberField(value, field, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw validationFailed([{ field, message: `必须是 ${min}..${max} 之间的数字` }]);
  }
  return n;
}

/**
 * 把 query 中的筛选参数转换为 buildMemoryFilterSql 用的 filters 对象。
 * 支持 Desktop/QA 使用的记忆类型/标签/项目/参与者/时间区间。
 */
export function filtersFromQuery(query = {}) {
  let filters = {};
  if (query.filters !== undefined && query.filters !== '') {
    const parsed = parseJsonField(query.filters, 'filters');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) filters = { ...parsed };
  }
  const types = splitList(query.memory_types ?? query.types ?? query.type);
  if (types.length) filters.types = types;
  const tags = splitList(query.tags ?? query.tag_ids);
  if (tags.length) filters.tags = tags;
  const projects = splitList(query.projects ?? query.project);
  if (projects.length) filters.projects = projects;
  const participants = splitList(query.participants ?? query.participant ?? query.entity_ids);
  if (participants.length) filters.entity_ids = participants;
  if (query.from !== undefined && query.from !== '') filters.occurred_from = query.from;
  if (query.to !== undefined && query.to !== '') filters.occurred_to = query.to;
  if (query.occurred_from !== undefined && query.occurred_from !== '') filters.occurred_from = query.occurred_from;
  if (query.occurred_to !== undefined && query.occurred_to !== '') filters.occurred_to = query.occurred_to;
  const sourceTypes = splitList(query.source_types);
  if (sourceTypes.length) filters.source_types = sourceTypes;
  for (const key of ['min_importance', 'max_importance', 'min_credibility', 'max_credibility']) {
    if (query[key] !== undefined && query[key] !== '') filters[key] = Number(query[key]);
  }
  if (query.demo !== undefined) filters.demo = parseBool(query.demo);
  if (query.agent_generated !== undefined) filters.agent_generated = parseBool(query.agent_generated);
  if (query.deleted_only !== undefined) filters.deleted_only = parseBool(query.deleted_only);
  return filters;
}

export function requireString(value, field, { maxLength = 500, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw validationFailed([{ field, message: '必须是字符串' }]);
  }
  if (value.length > maxLength) throw validationFailed([{ field, message: `不得超过 ${maxLength} 字符` }]);
  return value;
}

export function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`${field} 必须是 JSON 对象`);
  }
  return value;
}
