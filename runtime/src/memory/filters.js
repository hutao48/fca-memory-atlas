// FCA Local Runtime — 记忆筛选 SQL 构建（memory.search / timeline 共用）
import { toIso } from '../core/time.js';
import { validationFailed } from '../core/errors.js';
import { MEMORY_TYPE_SET, MEMORY_TYPES, SOURCE_TYPES } from './validate.js';

const SOURCE_TYPE_SET = new Set(SOURCE_TYPES);

function asArray(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function placeholders(n) {
  return Array.from({ length: n }, () => '?').join(',');
}

/**
 * 构建作用于 `memories` 表的筛选 SQL。
 * @param {object} filters
 * @param {{alias?: string, includeDeleted?: boolean}} [options]
 * @returns {{sql:string, params:any[]}}
 */
export function buildMemoryFilterSql(filters = {}, { alias = 'm', includeDeleted = false } = {}) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    throw validationFailed([{ field: 'filters', message: '必须是对象' }]);
  }
  const conditions = [];
  const params = [];
  const f = filters;

  const deletedOnly = f.deleted_only === true;
  if (deletedOnly) {
    conditions.push(`${alias}.deleted_at IS NOT NULL`);
  } else if (!includeDeleted && f.include_deleted !== true) {
    conditions.push(`${alias}.deleted_at IS NULL`);
  }

  const types = asArray(f.types ?? f.memory_types);
  if (types.length) {
    for (const t of types) {
      if (!MEMORY_TYPE_SET.has(t)) throw validationFailed([{ field: 'filters.types', message: `未知 memory_type：${t}（允许 ${MEMORY_TYPES.join('|')}）` }]);
    }
    conditions.push(`${alias}.memory_type IN (${placeholders(types.length)})`);
    params.push(...types);
  }

  const sourceTypes = asArray(f.source_types ?? f.sourceTypes);
  if (sourceTypes.length) {
    for (const t of sourceTypes) {
      if (!SOURCE_TYPE_SET.has(t)) throw validationFailed([{ field: 'filters.source_types', message: `未知 source_type：${t}` }]);
    }
    conditions.push(`${alias}.source_type IN (${placeholders(sourceTypes.length)})`);
    params.push(...sourceTypes);
  }

  const tags = asArray(f.tags ?? f.tag_ids ?? f.tag_names);
  if (tags.length) {
    conditions.push(
      `EXISTS (SELECT 1 FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.memory_id = ${alias}.id AND t.deleted_at IS NULL AND (t.id IN (${placeholders(tags.length)}) OR t.name IN (${placeholders(tags.length)})))`,
    );
    params.push(...tags, ...tags);
  }

  const projects = asArray(f.projects ?? f.project_ids ?? f.project_names);
  if (projects.length) {
    conditions.push(
      `EXISTS (SELECT 1 FROM memory_project mp JOIN entities e ON e.id = mp.entity_id WHERE mp.memory_id = ${alias}.id AND (e.id IN (${placeholders(projects.length)}) OR e.name IN (${placeholders(projects.length)})))`,
    );
    params.push(...projects, ...projects);
  }

  const entityIds = asArray(f.entity_ids ?? f.entities);
  if (entityIds.length) {
    conditions.push(
      `(EXISTS (SELECT 1 FROM memory_participants p WHERE p.memory_id = ${alias}.id AND p.entity_id IN (${placeholders(entityIds.length)})) OR EXISTS (SELECT 1 FROM memory_project mp2 WHERE mp2.memory_id = ${alias}.id AND mp2.entity_id IN (${placeholders(entityIds.length)})))`,
    );
    params.push(...entityIds, ...entityIds);
  }

  const occurredFrom = f.occurred_from ?? f.from ?? f.time_from;
  const occurredTo = f.occurred_to ?? f.to ?? f.time_to;
  if (occurredFrom) {
    const iso = toIso(occurredFrom);
    if (!iso) throw validationFailed([{ field: 'filters.occurred_from', message: '必须是 ISO 时间' }]);
    conditions.push(`${alias}.occurred_at IS NOT NULL AND ${alias}.occurred_at >= ?`);
    params.push(iso);
  }
  if (occurredTo) {
    const iso = toIso(occurredTo);
    if (!iso) throw validationFailed([{ field: 'filters.occurred_to', message: '必须是 ISO 时间' }]);
    conditions.push(`${alias}.occurred_at IS NOT NULL AND ${alias}.occurred_at <= ?`);
    params.push(iso);
  }

  if (f.created_from) {
    const iso = toIso(f.created_from);
    if (!iso) throw validationFailed([{ field: 'filters.created_from', message: '必须是 ISO 时间' }]);
    conditions.push(`${alias}.created_at >= ?`);
    params.push(iso);
  }
  if (f.created_to) {
    const iso = toIso(f.created_to);
    if (!iso) throw validationFailed([{ field: 'filters.created_to', message: '必须是 ISO 时间' }]);
    conditions.push(`${alias}.created_at <= ?`);
    params.push(iso);
  }

  const numeric = [
    ['min_importance', 'importance', '>='],
    ['max_importance', 'importance', '<='],
    ['min_credibility', 'credibility', '>='],
    ['max_credibility', 'credibility', '<='],
    ['min_display_weight', 'display_weight', '>='],
    ['max_display_weight', 'display_weight', '<='],
  ];
  for (const [key, column, op] of numeric) {
    if (f[key] === undefined || f[key] === null || f[key] === '') continue;
    const n = Number(f[key]);
    if (!Number.isFinite(n)) throw validationFailed([{ field: `filters.${key}`, message: '必须是数字' }]);
    conditions.push(`${alias}.${column} ${op} ?`);
    params.push(n);
  }

  if (typeof f.agent_generated === 'boolean') {
    conditions.push(`${alias}.agent_generated = ?`);
    params.push(f.agent_generated ? 1 : 0);
  }
  if (typeof f.demo === 'boolean') {
    conditions.push(`${alias}.demo = ?`);
    params.push(f.demo ? 1 : 0);
  }
  if (f.demo_only === true) conditions.push(`${alias}.demo = 1`);
  if (f.exclude_demo === true) conditions.push(`${alias}.demo = 0`);

  return { sql: conditions.join(' AND '), params };
}

/** 解析路由传入的 limit/cursor（统一分页）。 */
export function parsePagination({ limit, cursor }, { defaultLimit = 50, maxLimit = 500 } = {}) {
  let parsedLimit = Number(limit);
  if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) parsedLimit = defaultLimit;
  parsedLimit = Math.min(maxLimit, Math.floor(parsedLimit));
  let offset = 0;
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
      const o = Number(decoded.o);
      if (!Number.isInteger(o) || o < 0) throw new Error('bad');
      offset = o;
    } catch {
      throw validationFailed([{ field: 'cursor', message: 'cursor 不合法' }]);
    }
  }
  return { limit: parsedLimit, offset };
}

export function makeCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}
