// FCA Local Runtime — 认知状态（Cognition）服务（契约 §3.6；模拟状态，不代表主观感受）
import { nowIso } from '../core/time.js';
import { validationFailed, notFound } from '../core/errors.js';

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

const MODES = ['idle', 'focused', 'reflecting', 'listening', 'working', 'offline'];
const MODE_SET = new Set(MODES);

export function createCognitionService({ dbHolder, events }) {
  function getRow(db) {
    return db.prepare('SELECT * FROM cognition WHERE singleton = 1').get() ?? null;
  }

  function present(row) {
    if (!row) return null;
    return {
      focus: row.focus ?? '',
      attention_targets: parseJson(row.attention_targets, []),
      working_memory: parseJson(row.working_memory, []),
      mood: parseJson(row.mood_json, null),
      mode: row.mode,
      note: row.note ?? '模拟状态，不代表主观感受',
      updated_at: row.updated_at,
    };
  }

  function get() {
    const db = dbHolder.requireDb();
    const row = getRow(db);
    if (!row) throw notFound('认知状态记录不存在');
    return present(row);
  }

  function normalizeMood(mood, errors) {
    if (mood === undefined) return undefined;
    if (mood === null) return null;
    if (typeof mood !== 'object' || Array.isArray(mood)) {
      errors.push({ field: 'mood', message: '必须是对象或 null' });
      return null;
    }
    const out = { valence: null, arousal: null, label: null };
    if (mood.valence !== undefined && mood.valence !== null) {
      const n = Number(mood.valence);
      if (!Number.isFinite(n) || n < -1 || n > 1) errors.push({ field: 'mood.valence', message: '必须在 -1..1 之间' });
      else out.valence = n;
    }
    if (mood.arousal !== undefined && mood.arousal !== null) {
      const n = Number(mood.arousal);
      if (!Number.isFinite(n) || n < 0 || n > 1) errors.push({ field: 'mood.arousal', message: '必须在 0..1 之间' });
      else out.arousal = n;
    }
    if (mood.label !== undefined && mood.label !== null) {
      const label = String(mood.label).trim();
      if (label.length > 60) errors.push({ field: 'mood.label', message: '不得超过 60 字符' });
      else out.label = label || null;
    }
    return out;
  }

  function update(input, meta = {}) {
    const db = dbHolder.requireDb();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw validationFailed([{ field: null, message: 'body 必须是 JSON 对象' }]);
    const row = getRow(db);
    if (!row) throw notFound('认知状态记录不存在');
    const errors = [];
    const next = present(row);
    if (input.focus !== undefined) {
      if (typeof input.focus !== 'string') errors.push({ field: 'focus', message: '必须是字符串' });
      else if (input.focus.length > 2000) errors.push({ field: 'focus', message: '不得超过 2000 字符' });
      else next.focus = input.focus;
    }
    for (const field of ['attention_targets', 'working_memory']) {
      if (input[field] === undefined) continue;
      if (!Array.isArray(input[field])) errors.push({ field, message: '必须是数组' });
      else if (input[field].length > 64) errors.push({ field, message: '不得超过 64 项' });
      else next[field] = input[field].map(String);
    }
    const mood = normalizeMood(input.mood, errors);
    if (mood !== undefined) next.mood = mood;
    if (input.mode !== undefined) {
      if (!MODE_SET.has(input.mode)) errors.push({ field: 'mode', message: `必须是 ${MODES.join('|')}` });
      else next.mode = input.mode;
    }
    if (input.note !== undefined) {
      if (typeof input.note !== 'string' || input.note.length > 500) errors.push({ field: 'note', message: '必须是不超过 500 字符的字符串' });
      else next.note = input.note;
    }
    if (errors.length) throw validationFailed(errors);
    const now = nowIso();
    db.exec('BEGIN IMMEDIATE');
    let prepared;
    try {
      db.prepare(
        'UPDATE cognition SET focus=?, attention_targets=?, working_memory=?, mood_json=?, mode=?, note=?, updated_at=? WHERE singleton=1',
      ).run(
        next.focus,
        JSON.stringify(next.attention_targets),
        JSON.stringify(next.working_memory),
        next.mood === null ? null : JSON.stringify(next.mood),
        next.mode,
        next.note,
        now,
      );
      prepared = events.prepare(
        db,
        {
          type: 'cognition.updated',
          actor: meta.actor,
          source: meta.source,
          subject: { kind: 'cognition', id: null },
          payload: { mode: next.mode, changed_fields: Object.keys(input) },
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

  return { get, update, MODES };
}
