/**
 * FCA Memory Atlas — 记忆层级（父记忆 / 子 Agent 会话记忆）解析工具
 *
 * 数据契约（Lead 2026-11-13 确认，插件 v0.3 / memory-pipeline 写入，桌面/Unity 共用）：
 *  子会话记忆 tags：`Agent子会话`、`subagent-session:<childId8>`、`parent-session:<parentId8>`、
 *                  `parent-memory:<parentMemoryId>`、`workspace:<label>`
 *  父记忆（Agent思考节点）tags 额外：每个子会话一个 `children:<childId8>`（一个父可多个）
 *  关系：from=父记忆 → to=子会话记忆，relation_type=`custom`，label=`spawned_subagent`（API 拒绝则 derived_from）
 *
 * 本模块只做纯函数解析（unit test 覆盖）；UI 侧据此拉取子记忆、展示可展开区块与关系树。
 */

/** 关系类型白名单（custom + spawned_subagent 由 isHierarchyRelation 额外判定） */
export const HIERARCHY_RELATION_TYPES = Object.freeze([
  'subagent',
  'subagent_session',
  'spawned_subagent',
  'spawned',
  'child_of',
  'parent_of',
  'has_child',
  'derived_from',
]);

/** 标签前缀（大小写不敏感；值可为完整 id 或 8 位短 id） */
export const CHILD_TAG_PREFIXES = Object.freeze(['children:', 'child:']);
export const PARENT_MEMORY_TAG_PREFIXES = Object.freeze(['parent-memory:', 'parent_memory:', 'parent:']);
export const PARENT_SESSION_TAG_PREFIXES = Object.freeze(['parent-session:', 'parent_session:']);
export const CHILD_SESSION_TAG_PREFIXES = Object.freeze(['subagent-session:', 'subagent_session:']);
export const CHILD_SESSION_MARKER_TAG = 'Agent子会话';

/** custom 关系 label 里表示父子层级的可读标签 */
const HIERARCHY_LABELS = Object.freeze(['spawned_subagent', 'spawned-subagent', 'subagent', 'child_session', 'spawned']);

/** 关系标签 → 可读中文（关系探索/详情展示用） */
const RELATION_LABEL_TEXT = Object.freeze({
  spawned_subagent: '派生自 Agent 子会话',
  spawned: '生成子 Agent 会话',
  derived_from: '派生自',
});

/** 标签数组可能是 tag 名（tag_names）或 tag id（tags）；统一取可读字符串集合 */
export function collectTagStrings(memory) {
  const out = new Set();
  if (!memory) return [];
  const candidates = [memory.tag_names, memory.tags, memory.tags_raw].filter(Array.isArray);
  for (const list of candidates) {
    for (const item of list) {
      if (typeof item === 'string' && item.trim()) out.add(item.trim());
      else if (item && typeof item === 'object') {
        const label = item.name || item.label || item.tag_name || item.id;
        if (typeof label === 'string' && label.trim()) out.add(label.trim());
      }
    }
  }
  return [...out];
}

export function normalizeRelationType(value) {
  return String(value || '').trim().toLowerCase();
}

export function isHierarchyRelationType(value) {
  return HIERARCHY_RELATION_TYPES.includes(normalizeRelationType(value));
}

/** 是否为父子层级关系（含 custom + label spawned_subagent 契约） */
export function isHierarchyRelation(relation) {
  if (!relation) return false;
  const type = normalizeRelationType(relation.relation_type);
  if (isHierarchyRelationType(type)) return true;
  if (type === 'custom') {
    const label = String(relation.label || '').trim().toLowerCase();
    return HIERARCHY_LABELS.some((candidate) => label.includes(candidate));
  }
  return false;
}

/** 从标签解析所有层级引用 */
export function parseHierarchyHints(memory) {
  const tags = collectTagStrings(memory);
  const childRefs = [];
  const parentRefs = [];
  const parentSessionRefs = [];
  const sessionRefs = [];
  let isChildSession = false;
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    if (lower === CHILD_SESSION_MARKER_TAG.toLowerCase()) {
      isChildSession = true;
      continue;
    }
    const childPrefix = CHILD_TAG_PREFIXES.find((prefix) => lower.startsWith(prefix));
    if (childPrefix) {
      const ref = tag.slice(childPrefix.length).trim();
      if (ref) childRefs.push(ref);
      continue;
    }
    const parentPrefix = PARENT_MEMORY_TAG_PREFIXES.find((prefix) => lower.startsWith(prefix));
    if (parentPrefix) {
      const ref = tag.slice(parentPrefix.length).trim();
      if (ref) {
        parentRefs.push(ref);
        isChildSession = true;
      }
      continue;
    }
    const parentSessionPrefix = PARENT_SESSION_TAG_PREFIXES.find((prefix) => lower.startsWith(prefix));
    if (parentSessionPrefix) {
      const ref = tag.slice(parentSessionPrefix.length).trim();
      if (ref) parentSessionRefs.push(ref);
      isChildSession = true;
      continue;
    }
    const sessionPrefix = CHILD_SESSION_TAG_PREFIXES.find((prefix) => lower.startsWith(prefix));
    if (sessionPrefix) {
      const ref = tag.slice(sessionPrefix.length).trim();
      if (ref) sessionRefs.push(ref);
      continue;
    }
  }
  return {
    tags,
    childRefs: [...new Set(childRefs)],
    parentRefs: [...new Set(parentRefs)],
    parentSessionRefs: [...new Set(parentSessionRefs)],
    sessionRefs: [...new Set(sessionRefs)],
    isChildSession,
    hasHierarchy: childRefs.length > 0 || parentRefs.length > 0 || isChildSession,
  };
}

/** 关系方向：'parent_to_child' | 'child_to_parent' */
export function hierarchyRelationDirection(relation) {
  if (!relation) return 'parent_to_child';
  const type = normalizeRelationType(relation.relation_type);
  const label = String(relation.label || '').trim().toLowerCase();
  if (type === 'child_of' || (type === 'derived_from' && !HIERARCHY_LABELS.some((candidate) => label.includes(candidate)))) {
    return 'child_to_parent';
  }
  return 'parent_to_child';
}

/**
 * 判断关系是否为“父记忆 → 子记忆”的层级关系。
 * @returns {'child'|'parent'|null} 相对 currentNodeId：'child' 表示另一端是子记忆；'parent' 表示另一端是父记忆
 */
export function classifyHierarchyRelation(relation, currentNodeId) {
  if (!isHierarchyRelation(relation)) return null;
  const from = relation.from || null;
  const to = relation.to || null;
  if (!from || !to || !from.id || !to.id) return null;
  const direction = hierarchyRelationDirection(relation);
  const childSide = direction === 'child_to_parent' ? from : to;
  const parentSide = direction === 'child_to_parent' ? to : from;
  if (!currentNodeId) return 'child';
  if (parentSide.id === currentNodeId) return 'child';
  if (childSide.id === currentNodeId) return 'parent';
  return 'child';
}

/** 层级关系在 UI 中的可读标签 */
export function hierarchyRelationLabel(relation) {
  if (!relation) return '子 Agent 会话';
  const raw = String(relation.label || relation.relation_type || '').trim();
  const lower = raw.toLowerCase();
  if (RELATION_LABEL_TEXT[lower]) return RELATION_LABEL_TEXT[lower];
  if (lower.includes('spawn')) return '派生自 Agent 子会话';
  return raw || '子 Agent 会话';
}

export function normalizeId(value) {
  return String(value || '').trim().toLowerCase();
}

/** id 是否匹配引用（支持完整 id / 8 位短 id / 带 mem_ 前缀的短 id） */
export function idMatchesRef(id, ref) {
  const full = normalizeId(id);
  const target = normalizeId(ref).replace(/^(mem|ent|tag)_/, '');
  if (!full || !target) return false;
  return full === normalizeId(ref) || full.replace(/^(mem|ent|tag)_/, '').startsWith(target);
}

export function shortId(id, length = 8) {
  const raw = String(id || '').replace(/^mem_/, '');
  return raw.slice(0, length);
}

/**
 * 把引用解析成完整节点 id：优先用 graph nodes 前缀匹配，其次完整 mem_ id 原样保留，否则 null（未索引）。
 */
export function resolveRefs(refs, nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const out = [];
  const seen = new Set();
  for (const ref of Array.isArray(refs) ? refs : []) {
    if (!ref) continue;
    const match = list.find((node) => node && node.id && idMatchesRef(node.id, ref)) || null;
    const id = match ? match.id : /^mem_[0-9a-f]{16,}$/i.test(ref) ? ref : null;
    const key = id || `ref:${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ref, id, resolved: Boolean(match), node: match });
  }
  return out;
}

/**
 * 汇总一条记忆的层级信息（tags + relations）。
 */
export function buildHierarchySummary(memory, relations, nodes) {
  const memoryId = memory && memory.id ? memory.id : null;
  const hints = parseHierarchyHints(memory);
  const childRefs = [...hints.childRefs];
  const parentRefs = [...hints.parentRefs];
  for (const relation of Array.isArray(relations) ? relations : []) {
    if (!isHierarchyRelation(relation)) continue;
    const from = relation.from || null;
    const to = relation.to || null;
    if (!from || !to || from.kind !== 'memory' || to.kind !== 'memory') continue;
    if (!memoryId) continue;
    if (hierarchyRelationDirection(relation) === 'child_to_parent') {
      if (to.id === memoryId) childRefs.push(from.id);
      else if (from.id === memoryId) parentRefs.push(to.id);
    } else {
      if (from.id === memoryId) childRefs.push(to.id);
      else if (to.id === memoryId) parentRefs.push(from.id);
    }
  }
  const children = resolveRefs(childRefs, nodes);
  const parents = resolveRefs(parentRefs, nodes);
  return {
    memoryId,
    isChildSession: hints.isChildSession,
    childRefs: hints.childRefs,
    parentRefs: hints.parentRefs,
    parentSessionRefs: hints.parentSessionRefs,
    sessionRefs: hints.sessionRefs,
    children,
    parents,
    childCount: children.length,
    parentCount: parents.length,
    hasHierarchy: children.length > 0 || parents.length > 0 || hints.isChildSession,
  };
}

/** 子记忆列表项的数据整理（详情渲染用） */
export function toChildMemoryItem(memory, node) {
  if (!memory && !node) return null;
  const id = (memory && memory.id) || (node && node.id) || null;
  const title = (memory && (memory.title || memory.label)) || (node && node.label) || id || '（未知记忆）';
  const type = (memory && memory.memory_type) || (node && node.type) || null;
  const time = (memory && (memory.occurred_at || memory.created_at)) || (node && node.occurred_at) || null;
  const bodyPreview = memory && memory.body ? String(memory.body).replace(/\s+/g, ' ').trim().slice(0, 90) : '';
  return { id, title, type, time, bodyPreview };
}
