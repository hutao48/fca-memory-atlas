// FCA Local Runtime — ID 规则（契约 §1，不可变）
// 格式：<prefix>_<32 位小写 hex>（16 随机字节）
import { randomBytes } from 'node:crypto';

export const ID_PREFIXES = Object.freeze({
  memory: 'mem_',
  entity: 'ent_',
  relation: 'rel_',
  event: 'evt_',
  version: 'ver_',
  tag: 'tag_',
  layout: 'lay_',
  view: 'view_',
  backup: 'bak_',
  trace: 'trc_',
  identity: 'idn_', // §3.6 示例使用 idn_ 前缀（§1 前缀表未列出，按 §3.6 实现，见报告）
});

const PREFIX_SET = new Set(Object.values(ID_PREFIXES).map((p) => p.slice(0, -1)));

/**
 * 生成一个符合契约的新 ID。
 * @param {keyof typeof ID_PREFIXES} kind
 * @returns {string}
 */
export function newId(kind) {
  const prefix = ID_PREFIXES[kind];
  if (!prefix) throw new Error(`unknown id kind: ${kind}`);
  return `${prefix}${randomBytes(16).toString('hex')}`;
}

export function newTraceId() {
  return `${ID_PREFIXES.trace}${randomBytes(16).toString('hex')}`;
}

/** 校验任意 FCA ID 字符串（返回是否合法）。 */
export function isValidId(value) {
  if (typeof value !== 'string') return false;
  const idx = value.indexOf('_');
  if (idx <= 0) return false;
  const prefix = value.slice(0, idx);
  const hex = value.slice(idx + 1);
  return PREFIX_SET.has(prefix) && /^[0-9a-f]{32}$/.test(hex);
}

/** 校验指定类型的 ID。 */
export function isValidIdOf(value, kind) {
  if (!isValidId(value)) return false;
  return value.startsWith(ID_PREFIXES[kind]);
}

/** 宽松校验：外部导入数据可能来自旧版本，只要求 prefix_hex 形状。 */
export function looksLikeId(value, kind = null) {
  if (typeof value !== 'string' || value.length < 8) return false;
  const m = /^([a-z]+)_([0-9a-f]{16,64})$/.exec(value);
  if (!m) return false;
  if (kind) return m[1] === kind;
  return true;
}
