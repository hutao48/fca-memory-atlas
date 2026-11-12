// FCA Local Runtime — RFC 6902 JSON Patch 生成器（供版本历史 diff 使用）
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function escapePointerToken(token) {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1');
}

function joinPath(base, token) {
  const t = escapePointerToken(token);
  if (!base) return `/${t}`;
  return `${base}/${t}`;
}

/**
 * 生成把 before 变成 after 的 RFC6902 操作数组。
 * 对象逐键递归；数组整体替换（RFC6902 合法操作，语义清晰且稳定）。
 */
export function diffJson(before, after, basePath = '') {
  if (Object.is(before, after)) return [];
  if (isPlainObject(before) && isPlainObject(after)) {
    const ops = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      const hasBefore = Object.prototype.hasOwnProperty.call(before, key);
      const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
      const path = joinPath(basePath, key);
      if (hasBefore && !hasAfter) {
        ops.push({ op: 'remove', path });
      } else if (!hasBefore && hasAfter) {
        ops.push({ op: 'add', path, value: after[key] });
      } else {
        ops.push(...diffJson(before[key], after[key], path));
      }
    }
    return ops;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (JSON.stringify(before) === JSON.stringify(after)) return [];
    return [{ op: 'replace', path: basePath || '/', value: after }];
  }
  if (basePath === '') return [{ op: 'replace', path: '/', value: after }];
  return [{ op: 'replace', path: basePath, value: after }];
}

/** 基础 JSON Patch 应用器（用于测试/校验导入数据，保留扩展操作支持）。 */
export function applyJsonPatch(document, ops) {
  let doc = structuredClone(document);
  for (const op of ops) {
    const segments = op.path === '' ? [] : op.path.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (segments.length === 0) {
      if (op.op === 'replace' || op.op === 'add') doc = structuredClone(op.value);
      else if (op.op === 'remove') doc = undefined;
      continue;
    }
    let parent = doc;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i];
      if (parent === undefined || parent === null) throw new Error(`invalid patch path: ${op.path}`);
      parent = Array.isArray(parent) ? parent[Number(seg)] : parent[seg];
    }
    const last = segments[segments.length - 1];
    if (op.op === 'remove') {
      if (Array.isArray(parent)) parent.splice(Number(last), 1);
      else delete parent[last];
    } else if (op.op === 'add') {
      if (Array.isArray(parent)) {
        if (last === '-') parent.push(op.value);
        else parent.splice(Number(last), 0, op.value);
      } else parent[last] = op.value;
    } else if (op.op === 'replace') {
      if (Array.isArray(parent)) parent[Number(last)] = op.value;
      else parent[last] = op.value;
    } else {
      throw new Error(`unsupported patch op: ${op.op}`);
    }
  }
  return doc;
}
