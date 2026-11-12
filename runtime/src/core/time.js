// FCA Local Runtime — 时间与时间线分桶工具
export const MS_DAY = 86_400_000;

export const GRANULARITIES = Object.freeze(['day', 'week', 'month', 'year']);

export function nowIso() {
  return new Date().toISOString();
}

/** 宽松转 ISO；非法返回 null。 */
export function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function isIsoDate(value) {
  if (typeof value !== 'string') return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}T/.test(value.trim());
}

export function compareIso(a, b) {
  return String(a).localeCompare(String(b));
}

/** YYYY-MM */
export function monthKey(iso) {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** YYYY-MM-DD（UTC） */
export function dayKey(iso) {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function yearKey(iso) {
  return String(new Date(iso).getUTCFullYear());
}

/** ISO 周键 YYYY-Www（周一为一周起点） */
export function weekKey(iso) {
  const d = new Date(iso);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (t.getUTCDay() + 6) % 7; // 周一=0
  t.setUTCDate(t.getUTCDate() - dayNum + 3); // 该周周四
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * MS_DAY));
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function seasonOf(iso) {
  const m = new Date(iso).getUTCMonth() + 1;
  if (m >= 3 && m <= 5) return '春季';
  if (m >= 6 && m <= 8) return '夏季';
  if (m >= 9 && m <= 11) return '秋季';
  return '冬季';
}

export function quarterOf(iso) {
  return Math.floor(new Date(iso).getUTCMonth() / 3) + 1;
}

export function bucketKey(iso, granularity) {
  switch (granularity) {
    case 'day':
      return dayKey(iso);
    case 'week':
      return weekKey(iso);
    case 'month':
      return monthKey(iso);
    case 'year':
      return yearKey(iso);
    default:
      return dayKey(iso);
  }
}

export function bucketLabel(key, granularity) {
  switch (granularity) {
    case 'day':
      return key;
    case 'week':
      return key;
    case 'month': {
      const [y, m] = key.split('-');
      return `${y}年${Number(m)}月`;
    }
    case 'year':
      return `${key}年`;
    default:
      return key;
  }
}

/** 返回给定粒度的桶起始时间（UTC）。 */
export function bucketStart(iso, granularity) {
  const d = new Date(iso);
  switch (granularity) {
    case 'day':
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    case 'week': {
      const dayNum = (d.getUTCDay() + 6) % 7;
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dayNum));
    }
    case 'month':
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    case 'year':
      return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    default:
      return new Date(d);
  }
}

/** 下一个桶的起始时间。 */
export function nextBucketStart(startDate, granularity) {
  const d = new Date(startDate);
  switch (granularity) {
    case 'day':
      return new Date(d.getTime() + MS_DAY);
    case 'week':
      return new Date(d.getTime() + 7 * MS_DAY);
    case 'month':
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    case 'year':
      return new Date(Date.UTC(d.getUTCFullYear() + 1, 0, 1));
    default:
      return new Date(d.getTime() + MS_DAY);
  }
}

export const MAX_TIMELINE_BUCKETS = 5000;

/**
 * 生成 [from, to] 范围内的全部桶（含空桶，便于时间线稳定绘制）。
 * @returns {{keys: string[], labels: string[]}}
 */
export function generateBuckets(fromIso, toIso, granularity) {
  if (!GRANULARITIES.includes(granularity)) throw new Error(`invalid granularity: ${granularity}`);
  const start = bucketStart(fromIso, granularity);
  const end = new Date(toIso);
  const keys = [];
  const labels = [];
  let cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    const iso = cursor.toISOString();
    const key = bucketKey(iso, granularity);
    keys.push(key);
    labels.push(bucketLabel(key, granularity));
    if (keys.length > MAX_TIMELINE_BUCKETS) {
      throw new Error(`时间范围过大：${granularity} 粒度超过 ${MAX_TIMELINE_BUCKETS} 个桶`);
    }
    cursor = nextBucketStart(cursor, granularity);
  }
  return { keys, labels };
}

/** 供 JSON 序列化稳定使用的 ISO 比较器。 */
export function sortIsoAsc(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}
