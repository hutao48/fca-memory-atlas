// FCA Memory Atlas — Nebula Renderer
// ⚠ TEST FIXTURE GENERATOR — synthetic demo data, NOT production memories.
// Shapes follow docs/PUBLIC_INTERFACE_FREEZE.md §5 exactly (nodes / edges / clusters / stats) so the
// renderer can be exercised and benchmarked before the Runtime exists. Production data comes from
// GET /api/v1/graph served by the FCA Local Runtime.
//
// Deterministic: same seed -> byte-identical graph (used by screenshots & benchmarks).
import { mulberry32, gaussian, hashString, clamp } from './glutil.js';

export const FIXTURE_NOTE =
  'TEST FIXTURE · 合成演示数据，非真实记忆。结构严格遵循 PUBLIC_INTERFACE_FREEZE §5 渲染数据契约；生产数据来自 Runtime GET /api/v1/graph。';

const PROJECTS = ['星图计划', '苍穹引擎', '雾港协议', '河洛知识库', '灯塔实验室', '回声项目', '潮汐观测站', '孤岛档案'];
const PERSONS = ['林川', '周雨', '陈默', '苏晚', '顾言', '沈青', '许岸', '唐棠', '程野', '白露', '陆遥', '何以'];
const PLACES = ['上海·杨浦', '杭州·西溪', '成都·青城山', '北京·中关村', '厦门·鼓浪屿', '南京·先锋书店', '深圳·南山', '大理·洱海'];
const TOPICS = ['记忆索引结构', '向量检索', '时间线视图', '数据备份策略', 'WebGL 渲染管线', '插件事件采集', '权限模型', '数据库迁移方案', '性能基线', '界面动效', '离线同步', '星云配色'];
const MILESTONES = ['完成第一个可用版本', '通过内部评审', '确定接口冻结', '打通端到端链路', '上线灰度测试', '完成性能优化'];
const BOOKS = ['《银河系漫游指南》', '《时间简史》', '《城市与狗》', '《夜航西飞》', '《宇宙的琴弦》'];
const EMOTIONS = ['平静', '欣慰', '有些怀念', '紧张', '轻松', '充实', '安静的喜悦'];
const THEMES = [
  { id: 'work', name: '工作与项目', color: 'blue', tags: ['工作', '项目'], labelPeriod: '长期项目' },
  { id: 'family', name: '家人与日常', color: 'rose', tags: ['家庭', '日常'], labelPeriod: '生活线' },
  { id: 'study', name: '学习与研究', color: 'cyan', tags: ['研究', '学习'], labelPeriod: '研究主题' },
  { id: 'travel', name: '旅行与城市', color: 'violet', tags: ['旅行', '地点'], labelPeriod: '旅途' },
  { id: 'friends', name: '朋友与对话', color: 'magenta', tags: ['朋友', '对话'], labelPeriod: '关系' },
  { id: 'creation', name: '创作与设计', color: 'gold', tags: ['创作', '设计'], labelPeriod: '创作线' },
  { id: 'health', name: '身体与习惯', color: 'white', tags: ['健康', '习惯'], labelPeriod: '日常节律' },
  { id: 'reading', name: '阅读与思考', color: 'cyan', tags: ['阅读', '思想'], labelPeriod: '阅读笔记' },
  { id: 'plans', name: '计划与复盘', color: 'blue', tags: ['计划', '复盘'], labelPeriod: '季度计划' },
  { id: 'music', name: '音乐与感官', color: 'magenta', tags: ['音乐', '感官'], labelPeriod: '听觉记忆' },
  { id: 'loss', name: '失落与告别', color: 'violet', tags: ['情感', '告别'], labelPeriod: '低语' },
  { id: 'city', name: '城市漫游', color: 'gold', tags: ['城市', '散步'], labelPeriod: '漫游' },
];

const hex32 = (rand) => Array.from({ length: 16 }, () => Math.floor(rand() * 256).toString(16).padStart(2, '0')).join('');
const pick = (rand, arr) => arr[Math.floor(rand() * arr.length) % arr.length];
const iso = (t) => new Date(t).toISOString();

function makeTitle(rand, kind, theme) {
  const project = pick(rand, PROJECTS), person = pick(rand, PERSONS), place = pick(rand, PLACES);
  const topic = pick(rand, TOPICS), book = pick(rand, BOOKS), emo = pick(rand, EMOTIONS);
  switch (kind) {
    case 'episodic': {
      const t = [
        `在${place}与${person}讨论${project}的${topic}`,
        `${project} 周会上确定了 ${topic} 的方向`,
        `和${person}一起整理 ${project} 的会议记录`,
        `傍晚在${place}散步，想到 ${project} 的 ${topic}`,
        `周末和${person}去了${place}，聊起很久以前的事`,
        `读完${book}第三章，记下关于${topic}的想法`,
      ];
      return pick(rand, t);
    }
    case 'semantic':
      return `${topic}备忘：${project} 的取舍与约束`;
    case 'procedural':
      return `学会在 ${project} 里用 ${topic} 的方法`;
    case 'autobiographical':
      return `关于${place}的一段回忆：${topic}`;
    case 'project':
      return `${project} 里程碑：${pick(rand, MILESTONES)}`;
    case 'relational':
      return `与${person}的连接：${pick(rand, ['一次长谈', '共同完成的事', '很久没有联系', '一起吃的晚饭'])}`;
    case 'emotional':
      return `${person}发来消息，我感到${emo}`;
    case 'working':
    default:
      return `待办：整理 ${project} 的 ${topic}`;
  }
}

function makeBody(rand, title, theme) {
  const person = pick(rand, PERSONS), place = pick(rand, PLACES);
  const core = pick(rand, [
    `现场记下的要点不多，但方向已经清楚。`,
    `这件事和${person}有关，值得在下次见面时再确认。`,
    `地点在${place}，天气安静，注意力比平时集中。`,
    `当时觉得重要，现在回看依然成立。`,
    `细节还需要补充，先留在这里，等后续检索时再展开。`,
  ]);
  return `${title}。${core}`;
}

const TYPE_BY_THEME = {
  work: ['project', 'episodic', 'semantic', 'working'],
  family: ['emotional', 'episodic', 'autobiographical'],
  study: ['semantic', 'procedural', 'episodic'],
  travel: ['episodic', 'autobiographical', 'emotional'],
  friends: ['relational', 'episodic', 'emotional'],
  creation: ['semantic', 'procedural', 'episodic'],
  health: ['procedural', 'working', 'emotional'],
  reading: ['semantic', 'autobiographical', 'episodic'],
  plans: ['working', 'project', 'semantic'],
  music: ['emotional', 'episodic', 'autobiographical'],
  loss: ['emotional', 'autobiographical', 'relational'],
  city: ['episodic', 'autobiographical', 'semantic'],
};

const REL_BY_TYPE = {
  episodic: 'shared_experience',
  semantic: 'knowledge_link',
  procedural: 'knowledge_link',
  autobiographical: 'temporal_before',
  project: 'derived_from',
  relational: 'emotional_link',
  emotional: 'emotional_link',
  working: 'knowledge_link',
};
const REL_LABEL = {
  temporal_before: '此前', temporal_after: '此后', participates_in: '参与', shared_experience: '共同经历',
  knowledge_link: '知识关联', causal: '因果', derived_from: '派生自', belongs_to_project: '属于项目',
  emotional_link: '情感连接', custom: '自定义',
};

/** Empty graph — real "no memories" state. Renderer must NOT invent nodes for this. */
export function makeEmptyGraph() {
  return {
    api_version: '1',
    layout_version: 0,
    view: { center: [0, 0, 0], zoom: 1.0, view_id: null },
    nodes: [],
    edges: [],
    clusters: [],
    stats: { nodes: 0, edges: 0, clusters: 0, generated_at: '2026-11-12T00:00:00.000Z' },
  };
}

/**
 * Synthetic contract-compliant graph.
 * @param {number} nodeCount total memory+entity nodes (memory count = nodeCount - entities)
 * @param {number} seed deterministic seed
 */
export function makeSyntheticGraph(nodeCount = 1000, seed = 20261112) {
  if (!nodeCount) return makeEmptyGraph();
  const rand = mulberry32(seed >>> 0);
  const clusterCount = clamp(Math.round(Math.sqrt(Math.max(16, nodeCount)) * 0.34), 5, 30);
  const themePool = [...THEMES].sort((a, b) => hashString(a.id) - hashString(b.id));
  const memoryCount = Math.max(20, Math.round(nodeCount * 0.9));
  const entityCount = Math.max(3, nodeCount - memoryCount);

  // ---- clusters on a loose 3-arm spiral disk (layout-like, not random blob) -------------------
  const clusters = [];
  const diskR = 1000 + 2400 * Math.min(1, Math.sqrt(nodeCount / 1000));
  for (let i = 0; i < clusterCount; i++) {
    const theme = themePool[i % themePool.length];
    const frac = (i + 0.6) / clusterCount;
    const arm = i % 3;
    const theta = arm * (Math.PI * 2 / 3) + frac * Math.PI * 2.0 + (rand() - 0.5) * 0.22;
    const radius = diskR * Math.pow(frac, 0.82) * (0.55 + rand() * 0.65);
    const cx = Math.cos(theta) * radius;
    const cy = Math.sin(theta) * radius;
    const cz = (rand() - 0.5) * 130;
    const share = 0.7 + rand() * 0.9;
    clusters.push({
      index: i,
      theme,
      cx, cy, cz,
      theta, radius,
      share,
      sigma: 110 + rand() * 220,
      label: clusterLabel(theme, rand, i),
      nodeIds: [],
    });
  }
  // normalize shares -> cluster memory counts
  const shareSum = clusters.reduce((s, c) => s + c.share, 0);
  const counts = clusters.map((c) => Math.max(4, Math.floor((memoryCount * c.share) / shareSum)));
  let assigned = counts.reduce((a, b) => a + b, 0);
  let fix = 0;
  while (assigned < memoryCount && fix < 10000) { counts[fix % counts.length]++; assigned++; fix++; }
  while (assigned > memoryCount && fix < 20000) { const k = fix % counts.length; if (counts[k] > 4) { counts[k]--; assigned--; } fix++; }

  const nodes = [];
  const edges = [];
  const nowMs = Date.parse('2026-11-12T00:00:00.000Z');
  const windowStart = Date.parse('2024-03-01T00:00:00.000Z');
  const positions = new Map();

  // ---- memory nodes per cluster ----------------------------------------------------------------
  for (let ci = 0; ci < clusters.length; ci++) {
    const c = clusters[ci];
    const types = TYPE_BY_THEME[c.theme.id] || TYPE_BY_THEME.study;
    for (let k = 0; k < counts[ci]; k++) {
      const type = k < 2 ? types[0] : pick(rand, types);
      const title = makeTitle(rand, type, c.theme);
      const id = 'mem_' + hex32(rand);
      const hot = rand() < 0.035;
      const importance = hot ? 0.72 + rand() * 0.28 : rand() < 0.55 ? 0.06 + rand() * 0.3 : 0.2 + rand() * 0.5;
      const displayWeight = hot ? 1.1 + rand() * 0.9 : rand() < 0.6 ? 0.35 + rand() * 0.5 : 0.6 + rand() * 0.8;
      const outlier = rand() < 0.06;
      const sig = c.sigma * (outlier ? 1.8 + rand() * 1.4 : 0.6 + rand() * 0.7);
      const px = c.cx + gaussian(rand) * sig;
      const py = c.cy + gaussian(rand) * sig * 0.86;
      const pz = c.cz + gaussian(rand) * 95;
      const hasTime = rand() > 0.035;
      const t0 = windowStart + rand() * (nowMs - windowStart);
      const node = {
        id, kind: 'memory', type, label: title,
        importance: +importance.toFixed(3),
        display_weight: +displayWeight.toFixed(3),
        credibility: +(0.55 + rand() * 0.45).toFixed(3),
        occurred_at: hasTime ? iso(t0) : null,
        degree: 0,
        cluster_id: 'cluster_' + ci,
        position: { x: +px.toFixed(2), y: +py.toFixed(2), z: +pz.toFixed(2) },
        pinned: rand() < 0.006,
        tags: [...new Set([...c.theme.tags, tagForType(type), type === 'working' ? '待办' : null].filter(Boolean))],
        deleted: false,
        agent_generated: rand() < 0.22,
      };
      nodes.push(node);
      c.nodeIds.push(id);
      positions.set(id, node.position);
    }
  }

  // ---- entity nodes (persons & project & place entities) --------------------------------------
  const entityKinds = ['person', 'person', 'person', 'project', 'place', 'concept', 'organization'];
  for (let e = 0; e < entityCount; e++) {
    const ci = Math.floor(rand() * clusters.length) % clusters.length;
    const c = clusters[ci];
    const ekind = pick(rand, entityKinds);
    const name = ekind === 'person' ? pick(rand, PERSONS) : ekind === 'project' ? pick(rand, PROJECTS) : ekind === 'place' ? pick(rand, PLACES) : ekind === 'organization' ? '灯塔实验室' : pick(rand, TOPICS);
    const id = 'ent_' + hex32(rand);
    const px = c.cx + gaussian(rand) * c.sigma * 0.5;
    const py = c.cy + gaussian(rand) * c.sigma * 0.45;
    const pz = c.cz + gaussian(rand) * 60;
    nodes.push({
      id, kind: 'entity', type: ekind, label: name,
      importance: +(0.15 + rand() * 0.4).toFixed(3),
      display_weight: +(0.5 + rand() * 0.7).toFixed(3),
      credibility: 1,
      occurred_at: null,
      degree: 0,
      cluster_id: 'cluster_' + ci,
      position: { x: +px.toFixed(2), y: +py.toFixed(2), z: +pz.toFixed(2) },
      pinned: false,
      tags: [ekind],
      deleted: false,
      agent_generated: false,
    });
    positions.set(id, { x: px, y: py, z: pz });
    c.nodeIds.push(id);
  }

  // ---- edges -----------------------------------------------------------------------------------
  const memByCluster = new Map();
  for (const n of nodes) {
    if (n.kind !== 'memory') continue;
    if (!memByCluster.has(n.cluster_id)) memByCluster.set(n.cluster_id, []);
    memByCluster.get(n.cluster_id).push(n);
  }
  const allMem = nodes.filter((n) => n.kind === 'memory');
  const allEnt = nodes.filter((n) => n.kind === 'entity');
  const addEdge = (from, to, type, extra = {}) => {
    edges.push({
      id: 'rel_' + hex32(rand),
      from, to, relation_type: type,
      weight: +(0.4 + rand() * 0.6).toFixed(3),
      directed: true,
      confidence: +(0.6 + rand() * 0.4).toFixed(3),
      label: REL_LABEL[type] || type,
      deleted: false,
      ...extra,
    });
  };

  // each entity -> nearby memories
  for (const ent of allEnt) {
    const mems = memByCluster.get(ent.cluster_id) || allMem;
    const nLinks = 3 + Math.floor(rand() * 7);
    const start = Math.floor(rand() * mems.length);
    for (let i = 0; i < nLinks && mems.length; i++) {
      const m = mems[(start + i * 3) % mems.length];
      if (m.id === ent.id) continue;
      const type = ent.type === 'person' ? 'participates_in' : ent.type === 'project' ? 'belongs_to_project' : 'knowledge_link';
      addEdge(ent.id, m.id, type);
    }
  }
  // within cluster memory-memory links
  const targetEdges = Math.round(memoryCount * 1.55);
  let guard = 0;
  while (edges.length < targetEdges && guard < targetEdges * 12) {
    guard++;
    const m = allMem[Math.floor(rand() * allMem.length)];
    const mems = memByCluster.get(m.cluster_id) || allMem;
    if (mems.length < 3) continue;
    const other = mems[Math.floor(rand() * mems.length)];
    if (other.id === m.id) continue;
    let type = REL_BY_TYPE[m.type] || 'knowledge_link';
    if (rand() < 0.06) type = 'causal';
    addEdge(m.id, other.id, type);
  }
  // cross-cluster knowledge links (rare long filaments)
  const crossCount = Math.round(memoryCount * 0.035);
  for (let i = 0; i < crossCount; i++) {
    const a = allMem[Math.floor(rand() * allMem.length)];
    const b = allMem[Math.floor(rand() * allMem.length)];
    if (a.id === b.id || a.cluster_id === b.cluster_id) continue;
    addEdge(a.id, b.id, rand() < 0.5 ? 'knowledge_link' : 'derived_from');
  }
  // temporal chain inside a few clusters (gives arcs with direction)
  for (let i = 0; i < Math.floor(clusterCount * 2); i++) {
    const c = clusters[i % clusters.length];
    const mems = (memByCluster.get('cluster_' + c.index) || []).filter((n) => n.occurred_at).slice(0, 24);
    for (let j = 1; j < mems.length; j++) {
      if (rand() < 0.28) addEdge(mems[j - 1].id, mems[j].id, 'temporal_before');
    }
  }

  // degree bookkeeping
  const deg = new Map();
  for (const e of edges) {
    deg.set(e.from, (deg.get(e.from) || 0) + 1);
    deg.set(e.to, (deg.get(e.to) || 0) + 1);
  }
  for (const n of nodes) n.degree = Math.min(64, deg.get(n.id) || 0);

  // ---- clusters payload: real centroid, density from compactness/importance --------------------
  const clusterPayload = clusters.map((c, ci) => {
    const members = nodes.filter((n) => n.cluster_id === 'cluster_' + ci);
    let sx = 0, sy = 0, sz = 0, sw = 0;
    for (const n of members) {
      const w = 0.4 + n.importance;
      sx += n.position.x * w; sy += n.position.y * w; sz += n.position.z * w; sw += w;
    }
    const centroid = members.length ? { x: sx / sw, y: sy / sw, z: sz / sw } : { x: c.cx, y: c.cy, z: c.cz };
    let varSum = 0;
    for (const n of members) varSum += (n.position.x - centroid.x) ** 2 + (n.position.y - centroid.y) ** 2;
    const rms = Math.sqrt(varSum / Math.max(1, members.length));
    const density = clamp(0.35 + 260 / (rms + 180), 0.2, 0.98);
    const dominant = {};
    for (const n of members) if (n.kind === 'memory') dominant[n.type] = (dominant[n.type] || 0) + 1;
    const dominantTypes = Object.entries(dominant).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
    return {
      id: 'cluster_' + ci,
      label: c.label,
      node_ids: members.map((n) => n.id),
      centroid: { x: +centroid.x.toFixed(2), y: +centroid.y.toFixed(2), z: +(c.cz).toFixed(2) },
      density: +density.toFixed(3),
      dominant_types: dominantTypes,
      color_hint: c.theme.color,
    };
  });

  return {
    api_version: '1',
    layout_version: 1,
    view: { center: [0, 0, 0], zoom: 1.0, view_id: null },
    nodes,
    edges,
    clusters: clusterPayload,
    stats: { nodes: nodes.length, edges: edges.length, clusters: clusterPayload.length, generated_at: '2026-11-12T00:00:00.000Z' },
  };
}

function clusterLabel(theme, rand, i) {
  const periods = ['2024 夏', '2025 春', '2025 秋', '2026 春', '2026 夏', '长期'];
  const kind = [
    `${pick(rand, PROJECTS)} · ${pick(rand, periods)}`,
    `${pick(rand, PLACES)} · ${pick(rand, periods)}`,
    `${theme.name} · ${pick(rand, periods)}`,
    `${pick(rand, PERSONS)} · ${pick(rand, periods)}`,
  ];
  return kind[i % kind.length];
}

function tagForType(type) {
  const map = {
    working: '工作', episodic: '情景', semantic: '语义', procedural: '方法', autobiographical: '回忆',
    project: '项目', relational: '关系', emotional: '情感',
  };
  return map[type] || '记忆';
}

/** Named scenarios used by demo.html / capture script. */
export function makeScenario(name, seed = 20261112) {
  switch (String(name)) {
    case 'empty': return makeEmptyGraph();
    case '100': return makeSyntheticGraph(100, seed);
    case '300': return makeSyntheticGraph(300, seed);
    case '1000': return makeSyntheticGraph(1000, seed);
    case '3000': return makeSyntheticGraph(3000, seed);
    case '10000': return makeSyntheticGraph(10000, seed);
    case 'demo':
    default: return makeSyntheticGraph(300, seed);
  }
}
