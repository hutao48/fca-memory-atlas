// FCA Local Runtime — 聚类（确定性，供渲染星云与图例使用）
export const COLOR_HINTS = Object.freeze(['cyan', 'blue', 'violet', 'magenta', 'rose', 'gold', 'white']);

export const TYPE_COLOR_HINT = Object.freeze({
  working: 'white',
  episodic: 'cyan',
  semantic: 'blue',
  procedural: 'gold',
  autobiographical: 'violet',
  project: 'magenta',
  relational: 'rose',
  emotional: 'rose',
});

export const TYPE_LABELS = Object.freeze({
  working: '工作记忆',
  episodic: '情景记忆',
  semantic: '语义记忆',
  procedural: '程序记忆',
  autobiographical: '自传记忆',
  project: '项目记忆',
  relational: '关系记忆',
  emotional: '情感记忆',
});

export const ENTITY_KIND_LABELS = Object.freeze({
  person: '人物',
  project: '项目',
  place: '地点',
  concept: '概念',
  organization: '组织',
  other: '其他',
});

const ENTITY_KIND_COLOR = Object.freeze({
  person: 'gold',
  project: 'magenta',
  place: 'cyan',
  concept: 'blue',
  organization: 'white',
  other: 'white',
});

const MAX_CLUSTERS = 48;
const MIN_CLUSTER_SIZE = 1;

function sortNodeKeys(keys) {
  return [...keys].sort((a, b) => {
    const [ak, ai] = a.split(':');
    const [bk, bi] = b.split(':');
    if (ak !== bk) return ak.localeCompare(bk);
    return ai.localeCompare(bi);
  });
}

function computeDominant(members, data) {
  const counts = new Map();
  for (const nodeKey of members) {
    const [kind, id] = nodeKey.split(':');
    let label;
    if (kind === 'memory') {
      const row = data.memories.find((m) => m.id === id);
      label = row?.memory_type ?? 'unknown';
    } else {
      const row = data.entityById.get(id);
      label = row?.kind ?? 'other';
    }
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([k]) => k);
}

/**
 * 计算确定性聚类。
 * @param {ReturnType<import('../graph/data.js').loadGraphData>} data
 * @returns {{assignments: Map<string,string>, clusters: Array<object>, groupByMemory: Map<string,string>}}
 */
export function computeClusters(data) {
  const memoryById = new Map(data.memories.map((m) => [m.id, m]));
  /** @type {Map<string, {key:string,label:string,base:string,members:string[]}>} */
  const groups = new Map();

  function ensureGroup(key, label, base) {
    if (!groups.has(key)) groups.set(key, { key, label, base, members: [] });
    return groups.get(key);
  }

  function preferredGroup(entry) {
    const project = data.projectByMemory.get(entry.id);
    if (project?.entity_id) {
      return { key: `project:${project.entity_id}`, label: project.name || '未命名项目', base: 'project' };
    }
    const tags = data.tagsByMemory.get(entry.id) ?? [];
    if (tags.length > 0) {
      return { key: `tag:${tags[0].id}`, label: `#${tags[0].name}`, base: 'tag' };
    }
    const type = entry.memory_type;
    return { key: `type:${type}`, label: TYPE_LABELS[type] ?? type, base: 'type' };
  }

  for (const row of data.memories) {
    const group = preferredGroup(row);
    ensureGroup(group.key, group.label, group.base).members.push(`memory:${row.id}`);
  }

  // 聚类数量控制：保留最大的非 type 聚类，其余并入 type 聚类
  if (groups.size > MAX_CLUSTERS) {
    const preferred = [...groups.values()]
      .filter((g) => g.base !== 'type')
      .sort((a, b) => (b.members.length - a.members.length) || a.key.localeCompare(b.key));
    const kept = new Set(preferred.slice(0, Math.max(0, MAX_CLUSTERS - 8)).map((g) => g.key));
    const typeGroups = new Map([...groups.entries()].filter(([, g]) => g.base === 'type'));
    groups.clear();
    for (const g of typeGroups.values()) groups.set(g.key, g);
    for (const g of preferred) {
      if (kept.has(g.key)) {
        groups.set(g.key, g);
        continue;
      }
      for (const nodeKey of g.members) {
        const id = nodeKey.slice('memory:'.length);
        const row = memoryById.get(id);
        const key = `type:${row?.memory_type ?? 'unknown'}`;
        if (!groups.has(key)) {
          groups.set(key, {
            key,
            label: TYPE_LABELS[row?.memory_type] ?? row?.memory_type ?? '其它',
            base: 'type',
            members: [],
          });
        }
        groups.get(key).members.push(nodeKey);
      }
    }
  }

  // 记忆节点 -> 组
  const memoryGroup = new Map();
  for (const g of groups.values()) for (const nodeKey of g.members) memoryGroup.set(nodeKey, g.key);

  // 实体节点：归入关联记忆最多的聚类；无关联则按实体类型聚类
  const entityGroups = new Map();
  for (const entity of data.entities) {
    const nodeKey = `entity:${entity.id}`;
    const linkedMemories = data.entityMemoryLinks.get(entity.id) ?? new Set();
    const counts = new Map();
    for (const memoryId of linkedMemories) {
      const g = memoryGroup.get(`memory:${memoryId}`);
      if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    let best = null;
    for (const [g, count] of counts) {
      if (best === null || count > best.count || (count === best.count && g < best.group)) best = { group: g, count };
    }
    if (best && groups.has(best.group)) {
      groups.get(best.group).members.push(nodeKey);
    } else {
      const key = `entity:${entity.kind}`;
      if (!entityGroups.has(key)) {
        const label = ENTITY_KIND_LABELS[entity.kind] ?? entity.kind;
        entityGroups.set(key, { key, label: `${label}（实体）`, base: 'entity', members: [], entityKind: entity.kind });
      }
      entityGroups.get(key).members.push(nodeKey);
    }
  }
  for (const g of entityGroups.values()) groups.set(g.key, g);

  // 丢弃空聚类，按大小排序并分配稳定 ID
  const ordered = [...groups.values()].filter((g) => g.members.length >= MIN_CLUSTER_SIZE);
  ordered.sort((a, b) => (b.members.length - a.members.length) || a.key.localeCompare(b.key));

  const assignments = new Map();
  const clusters = [];
  ordered.forEach((group, index) => {
    const id = `cluster_${index}`;
    const nodeIds = sortNodeKeys(group.members);
    for (const nodeKey of nodeIds) assignments.set(nodeKey, id);
    const dominant = computeDominant(group.members, data);
    let colorHint = null;
    for (const type of dominant) {
      if (TYPE_COLOR_HINT[type]) {
        colorHint = TYPE_COLOR_HINT[type];
        break;
      }
      if (ENTITY_KIND_COLOR[type]) {
        colorHint = ENTITY_KIND_COLOR[type];
        break;
      }
    }
    clusters.push({
      id,
      key: group.key,
      label: group.label,
      node_ids: nodeIds,
      dominant_types: dominant,
      color_hint: colorHint ?? COLOR_HINTS[index % COLOR_HINTS.length],
      node_count: nodeIds.length,
    });
  });

  return { assignments, clusters, groupByMemory: memoryGroup };
}

export { MAX_CLUSTERS };
