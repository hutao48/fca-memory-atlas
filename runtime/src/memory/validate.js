// FCA Local Runtime — 记忆写入校验与归一化（契约 §2/§3.1）
import { toIso } from '../core/time.js';
import { validationFailed, badRequest, versionConflict } from '../core/errors.js';
import { MAX_MEMORY_BODY_CHARS, MAX_MEMORY_TITLE_CHARS } from '../config/index.js';

export const MEMORY_TYPES = Object.freeze([
  'working',
  'episodic',
  'semantic',
  'procedural',
  'autobiographical',
  'project',
  'relational',
  'emotional',
]);
export const OCCURRED_PRECISIONS = Object.freeze(['exact', 'day', 'month', 'year', 'approximate', 'unknown']);
export const SOURCE_TYPES = Object.freeze(['user', 'agent', 'system', 'external', 'inference', 'import']);
export const ORIGINS = Object.freeze(['user', 'agent', 'revised']);
export const CHANGE_KINDS = Object.freeze(['create', 'update', 'merge', 'split', 'restore', 'delete', 'import']);
export const MEMORY_TYPE_SET = new Set(MEMORY_TYPES);
const PRECISION_SET = new Set(OCCURRED_PRECISIONS);
const SOURCE_TYPE_SET = new Set(SOURCE_TYPES);
const ORIGIN_SET = new Set(ORIGINS);

export const MAX_TAGS = 64;
export const MAX_PARTICIPANTS = 64;
const MAX_ROLE = 60;
const MAX_EMOTION_LABEL = 60;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function pushErr(errors, field, message) {
  errors.push({ field, message });
}

function normalizeTagRefs(refs, errors) {
  if (refs === undefined || refs === null) return undefined;
  if (!Array.isArray(refs)) {
    pushErr(errors, 'tags', '必须是数组');
    return [];
  }
  if (refs.length > MAX_TAGS) pushErr(errors, 'tags', `标签数量不得超过 ${MAX_TAGS}`);
  const out = [];
  for (const ref of refs) {
    if (typeof ref === 'string') {
      const trimmed = ref.trim();
      if (!trimmed) pushErr(errors, 'tags', '标签不能为空');
      else if (trimmed.length > 100) pushErr(errors, 'tags', '标签名不得超过 100 字符');
      else out.push(/^tag_[0-9a-f]{32}$/.test(trimmed) ? { id: trimmed, name: null } : { id: null, name: trimmed });
    } else if (isPlainObject(ref)) {
      const id = typeof ref.id === 'string' ? ref.id : null;
      const name = typeof ref.name === 'string' ? ref.name.trim() : '';
      if (!id && !name) pushErr(errors, 'tags', '标签对象需要 id 或 name');
      else {
        if (name && name.length > 100) pushErr(errors, 'tags', '标签名不得超过 100 字符');
        out.push({ id, name });
      }
    } else {
      pushErr(errors, 'tags', '标签必须是字符串或对象');
    }
  }
  return out;
}

function normalizeParticipants(refs, errors) {
  if (refs === undefined || refs === null) return undefined;
  if (!Array.isArray(refs)) {
    pushErr(errors, 'participants', '必须是数组');
    return [];
  }
  if (refs.length > MAX_PARTICIPANTS) pushErr(errors, 'participants', `参与者不得超过 ${MAX_PARTICIPANTS}`);
  const out = [];
  for (const ref of refs) {
    if (typeof ref === 'string') {
      const name = ref.trim();
      if (!name) pushErr(errors, 'participants', '参与者名称不能为空');
      else out.push({ entity_id: null, name, role: 'participant' });
    } else if (isPlainObject(ref)) {
      const entityId = typeof ref.entity_id === 'string' ? ref.entity_id : typeof ref.id === 'string' ? ref.id : null;
      const name = typeof ref.name === 'string' ? ref.name.trim() : '';
      const role = ref.role === undefined || ref.role === null ? 'participant' : String(ref.role).trim() || 'participant';
      if (!entityId && !name) pushErr(errors, 'participants', '参与者需要 entity_id 或 name');
      else if (role.length > MAX_ROLE) pushErr(errors, 'participants', `role 不得超过 ${MAX_ROLE} 字符`);
      else out.push({ entity_id: entityId, name: name || null, role });
    } else {
      pushErr(errors, 'participants', '参与者必须是字符串或对象');
    }
  }
  return out;
}

function normalizeProject(ref, errors) {
  if (ref === undefined) return undefined;
  if (ref === null || ref === '') return null;
  if (typeof ref === 'string') {
    const name = ref.trim();
    if (!name) return null;
    return { id: /^ent_[0-9a-f]{32}$/.test(name) ? name : null, name };
  }
  if (isPlainObject(ref)) {
    const id = typeof ref.entity_id === 'string' ? ref.entity_id : typeof ref.id === 'string' ? ref.id : null;
    const name = typeof ref.name === 'string' ? ref.name.trim() : '';
    if (!id && !name) {
      pushErr(errors, 'project', '项目需要 entity_id 或 name');
      return null;
    }
    return { id, name: name || null };
  }
  pushErr(errors, 'project', '必须是字符串、对象或 null');
  return null;
}

function normalizeEmotion(ref, errors) {
  if (ref === undefined) return undefined;
  if (ref === null) return null;
  if (!isPlainObject(ref)) {
    pushErr(errors, 'emotion', '必须是对象或 null');
    return null;
  }
  const out = { valence: null, arousal: null, label: null };
  if (ref.valence !== undefined && ref.valence !== null) {
    const n = Number(ref.valence);
    if (!Number.isFinite(n) || n < -1 || n > 1) pushErr(errors, 'emotion.valence', '必须在 -1..1 之间');
    else out.valence = n;
  }
  if (ref.arousal !== undefined && ref.arousal !== null) {
    const n = Number(ref.arousal);
    if (!Number.isFinite(n) || n < 0 || n > 1) pushErr(errors, 'emotion.arousal', '必须在 0..1 之间');
    else out.arousal = n;
  }
  if (ref.label !== undefined && ref.label !== null) {
    const label = String(ref.label).trim();
    if (label.length > MAX_EMOTION_LABEL) pushErr(errors, 'emotion.label', `不得超过 ${MAX_EMOTION_LABEL} 字符`);
    else out.label = label || null;
  }
  if (out.valence === null && out.arousal === null && out.label === null) return null;
  return out;
}

function normalizeSource(ref, errors) {
  if (ref === undefined || ref === null) return { type: 'user', ref: null, note: null };
  if (typeof ref === 'string') {
    if (!SOURCE_TYPE_SET.has(ref)) pushErr(errors, 'source.type', `必须是 ${SOURCE_TYPES.join('|')}`);
    return { type: SOURCE_TYPE_SET.has(ref) ? ref : 'user', ref: null, note: null };
  }
  if (!isPlainObject(ref)) {
    pushErr(errors, 'source', '必须是对象或字符串');
    return { type: 'user', ref: null, note: null };
  }
  const type = ref.type ?? 'user';
  if (!SOURCE_TYPE_SET.has(type)) pushErr(errors, 'source.type', `必须是 ${SOURCE_TYPES.join('|')}`);
  return {
    type: SOURCE_TYPE_SET.has(type) ? type : 'user',
    ref: ref.ref == null ? null : String(ref.ref).slice(0, 500),
    note: ref.note == null ? null : String(ref.note).slice(0, 2000),
  };
}

function normalizeNumberField(value, field, errors, { min, max, fallback }) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    pushErr(errors, field, '必须是数字');
    return fallback;
  }
  const lo = min === undefined ? -Infinity : min;
  const hi = max === undefined ? Infinity : max;
  if (n < lo || n > hi) {
    pushErr(errors, field, `必须在 ${lo}..${hi} 之间`);
    return fallback;
  }
  return n;
}

function normalizeOccurred(input, errors, { mode }) {
  const provided = input.occurred_at !== undefined || input.occurred_precision !== undefined || input.occurred_end_at !== undefined;
  if (!provided && mode === 'patch') return undefined;
  const occurredAt = input.occurred_at === undefined ? undefined : toIso(input.occurred_at);
  if (input.occurred_at !== undefined && input.occurred_at !== null && occurredAt === null) {
    pushErr(errors, 'occurred_at', '必须是 ISO 8601 时间字符串或 null');
  }
  let precision;
  if (input.occurred_precision !== undefined) {
    if (!PRECISION_SET.has(input.occurred_precision)) pushErr(errors, 'occurred_precision', `必须是 ${OCCURRED_PRECISIONS.join('|')}`);
    else precision = input.occurred_precision;
  }
  let occurredEndAt = input.occurred_end_at === undefined ? undefined : toIso(input.occurred_end_at);
  if (input.occurred_end_at !== undefined && input.occurred_end_at !== null && occurredEndAt === null) {
    pushErr(errors, 'occurred_end_at', '必须是 ISO 8601 时间字符串或 null');
  }
  if (mode === 'patch') {
    const out = {};
    if (occurredAt !== undefined) out.occurred_at = occurredAt;
    if (precision !== undefined) out.occurred_precision = precision;
    if (occurredEndAt !== undefined) out.occurred_end_at = occurredEndAt;
    return out;
  }
  // create 模式：容错默认
  if (occurredAt === null || occurredAt === undefined) {
    precision = precision === undefined || precision === 'unknown' ? 'unknown' : 'unknown';
  } else if (precision === undefined) {
    precision = 'exact';
  } else if (precision === 'unknown') {
    precision = 'exact';
  }
  if (occurredEndAt && occurredAt && occurredEndAt < occurredAt) {
    pushErr(errors, 'occurred_end_at', '不得早于 occurred_at');
  }
  if (occurredEndAt && !occurredAt) pushErr(errors, 'occurred_end_at', '设置 occurred_end_at 时必须提供 occurred_at');
  return { occurred_at: occurredAt ?? null, occurred_precision: precision, occurred_end_at: occurredEndAt ?? null };
}

/**
 * 新建记忆输入归一化。
 * @param {object} input
 * @param {{meta?: object, allowDemo?: boolean}} [options]
 */
export function normalizeCreateInput(input, { meta = {}, allowDemo = false } = {}) {
  if (!isPlainObject(input)) throw badRequest('记忆必须是 JSON 对象');
  const errors = [];
  const title = typeof input.title === 'string' ? input.title : '';
  if (!title.trim()) pushErr(errors, 'title', '标题必填');
  if (title.length > MAX_MEMORY_TITLE_CHARS) pushErr(errors, 'title', `标题不得超过 ${MAX_MEMORY_TITLE_CHARS} 字符`);
  const body = input.body === undefined || input.body === null ? '' : String(input.body);
  if (body.length > MAX_MEMORY_BODY_CHARS) pushErr(errors, 'body', `正文不得超过 ${MAX_MEMORY_BODY_CHARS} 字符`);
  const memoryType = input.memory_type ?? 'episodic';
  if (!MEMORY_TYPE_SET.has(memoryType)) pushErr(errors, 'memory_type', `必须是 ${MEMORY_TYPES.join('|')}`);
  const occurred = normalizeOccurred(input, errors, { mode: 'create' });
  const source = normalizeSource(input.source, errors);
  const credibility = normalizeNumberField(input.credibility, 'credibility', errors, { min: 0, max: 1, fallback: 0.5 });
  const importance = normalizeNumberField(input.importance, 'importance', errors, { min: 0, max: 1, fallback: 0.5 });
  const displayWeight = normalizeNumberField(input.display_weight, 'display_weight', errors, { min: 0, max: 2, fallback: 1.0 });
  const tags = normalizeTagRefs(input.tags, errors) ?? [];
  const participants = normalizeParticipants(input.participants, errors) ?? [];
  const project = normalizeProject(input.project, errors) ?? null;
  const emotion = normalizeEmotion(input.emotion, errors) ?? null;
  let origin = input.origin ?? (meta.actor?.kind === 'agent' ? 'agent' : 'user');
  if (!ORIGIN_SET.has(origin)) {
    pushErr(errors, 'origin', `必须是 ${ORIGINS.join('|')}`);
    origin = 'user';
  }
  const agentGenerated = input.agent_generated === true || origin === 'agent';
  const demo = allowDemo === true && input.demo === true;
  if (errors.length) throw validationFailed(errors);
  return {
    title,
    body,
    memory_type: memoryType,
    ...occurred,
    source,
    credibility,
    importance,
    display_weight: displayWeight,
    tags,
    participants,
    project,
    emotion,
    origin,
    agent_generated: agentGenerated,
    demo,
  };
}

/** PATCH 输入归一化：只返回请求提供的字段（用于部分更新）。 */
export function normalizePatchInput(input, { meta = {} } = {}) {
  if (!isPlainObject(input)) throw badRequest('PATCH body 必须是 JSON 对象');
  const errors = [];
  const out = {};
  if (input.title !== undefined) {
    const title = typeof input.title === 'string' ? input.title : '';
    if (!title.trim()) pushErr(errors, 'title', '标题不能为空');
    if (title.length > MAX_MEMORY_TITLE_CHARS) pushErr(errors, 'title', `标题不得超过 ${MAX_MEMORY_TITLE_CHARS} 字符`);
    out.title = title;
  }
  if (input.body !== undefined) {
    const body = input.body === null ? '' : String(input.body);
    if (body.length > MAX_MEMORY_BODY_CHARS) pushErr(errors, 'body', `正文不得超过 ${MAX_MEMORY_BODY_CHARS} 字符`);
    out.body = body;
  }
  if (input.memory_type !== undefined) {
    if (!MEMORY_TYPE_SET.has(input.memory_type)) pushErr(errors, 'memory_type', `必须是 ${MEMORY_TYPES.join('|')}`);
    else out.memory_type = input.memory_type;
  }
  const occurred = normalizeOccurred(input, errors, { mode: 'patch' });
  if (occurred) Object.assign(out, occurred);
  if (input.source !== undefined) out.source = normalizeSource(input.source, errors);
  if (input.credibility !== undefined) out.credibility = normalizeNumberField(input.credibility, 'credibility', errors, { min: 0, max: 1, fallback: 0.5 });
  if (input.importance !== undefined) out.importance = normalizeNumberField(input.importance, 'importance', errors, { min: 0, max: 1, fallback: 0.5 });
  if (input.display_weight !== undefined) {
    out.display_weight = normalizeNumberField(input.display_weight, 'display_weight', errors, { min: 0, max: 2, fallback: 1.0 });
  }
  if (input.tags !== undefined) out.tags = normalizeTagRefs(input.tags, errors) ?? [];
  if (input.participants !== undefined) out.participants = normalizeParticipants(input.participants, errors) ?? [];
  if (input.project !== undefined) out.project = normalizeProject(input.project, errors) ?? null;
  if (input.emotion !== undefined) out.emotion = normalizeEmotion(input.emotion, errors) ?? null;
  if (input.origin !== undefined) {
    if (!ORIGIN_SET.has(input.origin)) pushErr(errors, 'origin', `必须是 ${ORIGINS.join('|')}`);
    else {
      out.origin = input.origin;
      out.agent_generated = input.origin === 'agent';
    }
  } else if (typeof input.agent_generated === 'boolean') {
    out.agent_generated = input.agent_generated;
  }
  if (input.expected_version !== undefined) {
    const v = Number(input.expected_version);
    if (!Number.isInteger(v) || v < 1) pushErr(errors, 'expected_version', '必须是正整数');
    else out.expected_version = v;
  }
  if (errors.length) throw validationFailed(errors);
  if (Object.keys(out).filter((k) => k !== 'expected_version').length === 0) {
    throw validationFailed([{ field: null, message: 'PATCH 未提供任何可更新字段' }]);
  }
  return out;
}

/**
 * 校验 expected_version（可选参数语义：提供即做乐观并发检查）。
 * @param {{version:number}} row 当前数据行
 * @param {object} input 请求 body
 */
export function validateExpectedVersion(row, input) {
  if (!row || !input || input.expected_version === undefined) return;
  const expected = Number(input.expected_version);
  if (expected !== Number(row.version)) throw versionConflict(Number(row.version));
}
