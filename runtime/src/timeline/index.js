// FCA Local Runtime — 时间线（契约 /timeline）
import { toIso, GRANULARITIES, generateBuckets, bucketKey } from '../core/time.js';
import { validationFailed } from '../core/errors.js';
import { buildMemoryFilterSql } from '../memory/filters.js';
import { memoryRef } from '../memory/present.js';

const MAX_ITEMS = 1000;

export function createTimelineService({ dbHolder }) {
  function get({
    from = null,
    to = null,
    granularity = 'day',
    filters = {},
    limit = 200,
    cursor = null,
    include_deleted = false,
  } = {}) {
    if (!GRANULARITIES.includes(granularity)) {
      throw validationFailed([{ field: 'granularity', message: `必须是 ${GRANULARITIES.join('|')}` }]);
    }
    if (filters && (typeof filters !== 'object' || Array.isArray(filters))) {
      throw validationFailed([{ field: 'filters', message: '必须是对象' }]);
    }
    const d = dbHolder.requireDb();
    const filter = buildMemoryFilterSql(filters ?? {}, { includeDeleted: include_deleted });
    const where = [filter.sql, 'm.occurred_at IS NOT NULL'].filter(Boolean);
    const params = [...filter.params];
    let rangeFrom = from ? toIso(from) : null;
    let rangeTo = to ? toIso(to) : null;
    if (from && !rangeFrom) throw validationFailed([{ field: 'from', message: '必须是 ISO 时间' }]);
    if (to && !rangeTo) throw validationFailed([{ field: 'to', message: '必须是 ISO 时间' }]);
    if (!rangeFrom || !rangeTo) {
      const bounds = d
        .prepare(`SELECT min(m.occurred_at) min_at, max(m.occurred_at) max_at FROM memories m WHERE ${where.join(' AND ')}`)
        .get(...params);
      if (!rangeFrom) rangeFrom = bounds?.min_at ?? null;
      if (!rangeTo) rangeTo = bounds?.max_at ?? null;
    }
    if (!rangeTo) rangeTo = rangeFrom;
    const range = { from: rangeFrom, to: rangeTo, granularity };
    if (!rangeFrom || !rangeTo) {
      return { buckets: [], items: [], range, total: 0, next_cursor: null };
    }
    if (rangeFrom > rangeTo) {
      throw validationFailed([{ field: 'range', message: 'from 不得晚于 to' }]);
    }
    let generated;
    try {
      generated = generateBuckets(rangeFrom, rangeTo, granularity);
    } catch (err) {
      throw validationFailed([{ field: 'range', message: err.message }]);
    }
    let parsedLimit = Number(limit);
    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) parsedLimit = 200;
    parsedLimit = Math.min(MAX_ITEMS, Math.floor(parsedLimit));
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
    const whereRange = [...where, 'm.occurred_at >= ?', 'm.occurred_at <= ?'];
    const paramsRange = [...params, rangeFrom, rangeTo];
    const rows = d
      .prepare(
        `SELECT * FROM memories m WHERE ${whereRange.join(' AND ')}
         ORDER BY m.occurred_at ASC, m.id ASC`,
      )
      .all(...paramsRange);
    const bucketMap = new Map();
    generated.keys.forEach((key, index) => {
      bucketMap.set(key, { key, label: generated.labels[index], count: 0, node_ids: [], present_types: new Set() });
    });
    for (const row of rows) {
      const key = bucketKey(row.occurred_at, granularity);
      const bucket = bucketMap.get(key);
      if (!bucket) continue;
      bucket.count += 1;
      bucket.node_ids.push(row.id);
      bucket.present_types.add(row.memory_type);
    }
    const buckets = [...bucketMap.values()].map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      count: bucket.count,
      node_ids: bucket.node_ids,
      present_types: [...bucket.present_types].sort(),
    }));
    const page = rows.slice(offset, offset + parsedLimit);
    const nextOffset = offset + page.length;
    return {
      buckets,
      items: page.map(memoryRef),
      range,
      total: rows.length,
      next_cursor: nextOffset < rows.length
        ? Buffer.from(JSON.stringify({ o: nextOffset }), 'utf8').toString('base64url')
        : null,
    };
  }

  return { get };
}
