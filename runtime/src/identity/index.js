// FCA Local Runtime — 身份（Identity）服务（契约 §3.6）
import { nowIso } from '../core/time.js';
import { validationFailed, versionConflict, notFound } from '../core/errors.js';

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function createIdentityService({ dbHolder, events }) {
  function getRow(db) {
    return db.prepare('SELECT * FROM identity LIMIT 1').get() ?? null;
  }

  function present(row) {
    if (!row) return null;
    return {
      identity_id: row.identity_id,
      display_name: row.display_name,
      summary: row.summary ?? '',
      values: parseJson(row.values_json, []),
      preferences: parseJson(row.preferences_json, {}),
      boundaries: parseJson(row.boundaries_json, []),
      version: Number(row.version),
      updated_at: row.updated_at,
    };
  }

  function get() {
    const db = dbHolder.requireDb();
    const row = getRow(db);
    if (!row) throw notFound('身份记录不存在');
    return present(row);
  }

  function update(input, meta = {}) {
    const db = dbHolder.requireDb();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw validationFailed([{ field: null, message: 'body 必须是 JSON 对象' }]);
    const row = getRow(db);
    if (!row) throw notFound('身份记录不存在');
    if (input.expected_version !== undefined) {
      const expected = Number(input.expected_version);
      if (!Number.isInteger(expected) || expected < 1) throw validationFailed([{ field: 'expected_version', message: '必须是正整数' }]);
      if (expected !== Number(row.version)) throw versionConflict(Number(row.version));
    }
    const errors = [];
    const next = {
      display_name: row.display_name,
      summary: row.summary ?? '',
      values: parseJson(row.values_json, []),
      preferences: parseJson(row.preferences_json, {}),
      boundaries: parseJson(row.boundaries_json, []),
    };
    if (input.display_name !== undefined) {
      const name = String(input.display_name).trim();
      if (!name) errors.push({ field: 'display_name', message: '不能为空' });
      else if (name.length > 200) errors.push({ field: 'display_name', message: '不得超过 200 字符' });
      else next.display_name = name;
    }
    if (input.summary !== undefined) {
      const summary = String(input.summary);
      if (summary.length > 20_000) errors.push({ field: 'summary', message: '不得超过 20000 字符' });
      else next.summary = summary;
    }
    if (input.values !== undefined) {
      if (!Array.isArray(input.values)) errors.push({ field: 'values', message: '必须是数组' });
      else next.values = input.values;
    }
    if (input.preferences !== undefined) {
      if (!input.preferences || typeof input.preferences !== 'object' || Array.isArray(input.preferences)) {
        errors.push({ field: 'preferences', message: '必须是对象' });
      } else next.preferences = input.preferences;
    }
    if (input.boundaries !== undefined) {
      if (!Array.isArray(input.boundaries)) errors.push({ field: 'boundaries', message: '必须是数组' });
      else next.boundaries = input.boundaries;
    }
    if (errors.length) throw validationFailed(errors);
    const version = Number(row.version) + 1;
    const now = nowIso();
    db.exec('BEGIN IMMEDIATE');
    let prepared;
    try {
      db.prepare(
        'UPDATE identity SET display_name=?, summary=?, values_json=?, preferences_json=?, boundaries_json=?, version=?, updated_at=? WHERE identity_id=?',
      ).run(
        next.display_name,
        next.summary,
        JSON.stringify(next.values),
        JSON.stringify(next.preferences),
        JSON.stringify(next.boundaries),
        version,
        now,
        row.identity_id,
      );
      prepared = events.prepare(
        db,
        {
          type: 'identity.updated',
          actor: meta.actor,
          source: meta.source,
          subject: { kind: 'identity', id: row.identity_id },
          payload: { version, changed_fields: Object.keys(input).filter((k) => k !== 'expected_version') },
          trace_id: meta.traceId,
        },
        {},
      );
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    events.publish(prepared.event);
    return present(getRow(db));
  }

  return { get, update };
}
