/**
 * ⚠️ DEV-ONLY — 开发期夹具数据（不属于生产代码，最终交付前删除）
 *
 * 用途：Runtime 尚未就绪时，让 Shell / 编辑器 / 截图流程可以开发与联调 UI。
 * 约束：
 *  - UI 必须显示醒目标注「开发夹具数据（dev-only）」；
 *  - 只在 ?dev=1 或 settings.devFixtures=true 时加载；
 *  - 生产环境不包含本目录（最终交付前删除 desktop/renderer/lib/dev/）。
 *
 * 数据结构严格遵循 docs/PUBLIC_INTERFACE_FREEZE.md §5（GET /graph 响应）。
 */

function iso(year, month, day, hour = 10, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0).toISOString();
}

const CLUSTER_COLORS = {
  'cluster_2026_spring': 'cyan',
  'cluster_project_atlas': 'violet',
  'cluster_people': 'gold',
  'cluster_travel': 'rose',
  'cluster_learning': 'blue',
};

function node(id, kind, type, label, extra = {}) {
  return {
    id,
    kind,
    type,
    label,
    importance: 0.5,
    display_weight: 1,
    credibility: 0.8,
    occurred_at: null,
    degree: 0,
    cluster_id: null,
    position: { x: 0, y: 0, z: 0 },
    pinned: false,
    tags: [],
    deleted: false,
    agent_generated: false,
    ...extra,
  };
}

function edge(id, from, to, relationType, weight = 1, label = '') {
  return {
    id,
    from,
    to,
    relation_type: relationType,
    weight,
    directed: true,
    confidence: 0.85,
    label: label || relationType,
    deleted: false,
  };
}

/** 生成 20+ 条符合契约的演示图，用于开发期 UI 联调 */
export function createDevFixtureGraph() {
  const nodes = [
    // 项目线
    node('mem_dev01', 'memory', 'project', '开始搭建 FCA Memory Atlas 原型', {
      importance: 0.92, display_weight: 1.8, credibility: 1, occurred_at: iso(2026, 11, 2, 9, 30),
      cluster_id: 'cluster_2026_spring', tags: ['tag_dev', 'tag_project'], degree: 3,
      position: { x: -120, y: -60, z: 24 },
    }),
    node('mem_dev02', 'memory', 'episodic', '第一次在 DSH 里验证 Cordis 插件加载', {
      importance: 0.78, display_weight: 1.3, credibility: 0.95, occurred_at: iso(2026, 11, 3, 14, 10),
      cluster_id: 'cluster_2026_spring', tags: ['tag_dev', 'tag_dsh'], degree: 2,
      position: { x: 40, y: -110, z: -12 },
    }),
    node('mem_dev03', 'memory', 'semantic', 'FCA 的三层记忆模型：工作/情景/长期', {
      importance: 0.7, display_weight: 1.1, credibility: 0.9, occurred_at: iso(2026, 11, 4, 11, 0),
      cluster_id: 'cluster_learning', tags: ['tag_design'], degree: 2,
      position: { x: 180, y: 40, z: 18 },
    }),
    node('mem_dev04', 'memory', 'project', '星云渲染需要 WebGL2 半分辨率 raymarch', {
      importance: 0.86, display_weight: 1.6, credibility: 0.85, occurred_at: iso(2026, 11, 5, 16, 40),
      cluster_id: 'cluster_project_atlas', tags: ['tag_project', 'tag_render'], degree: 2,
      position: { x: 260, y: -30, z: 60 },
    }),
    node('mem_dev05', 'memory', 'episodic', '和团队讨论本地优先的数据主权边界', {
      importance: 0.64, display_weight: 0.9, credibility: 1, occurred_at: iso(2026, 11, 6, 10, 20),
      cluster_id: 'cluster_people', tags: ['tag_team'], degree: 2,
      position: { x: -300, y: 80, z: -8 },
    }),
    node('mem_dev06', 'memory', 'procedural', '如何用 node:sqlite 做迁移与 WAL 检查', {
      importance: 0.58, display_weight: 0.85, credibility: 0.92, occurred_at: iso(2026, 11, 6, 15, 0),
      cluster_id: 'cluster_learning', tags: ['tag_dev', 'tag_sqlite'], degree: 1,
      position: { x: 120, y: 170, z: 34 },
    }),
    node('mem_dev07', 'memory', 'emotional', 'Alpha 里程碑前的紧张与期待', {
      importance: 0.5, display_weight: 0.8, credibility: 0.9, occurred_at: iso(2026, 11, 7, 22, 30),
      cluster_id: 'cluster_2026_spring', tags: ['tag_journal'], degree: 1,
      position: { x: -80, y: 190, z: -20 },
    }),
    node('mem_dev08', 'memory', 'autobiographical', '从旧项目迁移出来，只保留新的独立仓库', {
      importance: 0.76, display_weight: 1.2, credibility: 1, occurred_at: iso(2026, 11, 8, 9, 10),
      cluster_id: 'cluster_2026_spring', tags: ['tag_journal'], degree: 2,
      position: { x: -220, y: -140, z: 12 },
    }),
    node('mem_dev09', 'memory', 'relational', '与设计师对齐深空视觉基调', {
      importance: 0.6, display_weight: 0.9, credibility: 0.85, occurred_at: iso(2026, 11, 9, 13, 25),
      cluster_id: 'cluster_people', tags: ['tag_team', 'tag_render'], degree: 2,
      position: { x: -260, y: 20, z: 8 },
    }),
    node('mem_dev10', 'memory', 'episodic', '第一次看到 1000 节点星云平稳运行', {
      importance: 0.82, display_weight: 1.4, credibility: 0.9, occurred_at: iso(2026, 11, 10, 17, 45),
      cluster_id: 'cluster_project_atlas', tags: ['tag_render', 'tag_project'], degree: 2,
      position: { x: 330, y: 90, z: -34 },
    }),
    node('mem_dev11', 'memory', 'semantic', '关系应当是一等公民，而不是记忆的附注', {
      importance: 0.68, display_weight: 1.0, credibility: 0.85, occurred_at: iso(2026, 11, 10, 21, 0),
      cluster_id: 'cluster_learning', tags: ['tag_design'], degree: 1,
      position: { x: 250, y: 210, z: 20 },
    }),
    node('mem_dev12', 'memory', 'working', '本周要完成桌面外壳与真实联调', {
      importance: 0.72, display_weight: 1.15, credibility: 1, occurred_at: iso(2026, 11, 11, 8, 50),
      cluster_id: 'cluster_2026_spring', tags: ['tag_project'], degree: 2,
      position: { x: -40, y: 30, z: 42 },
    }),
    // 实体节点
    node('ent_dev_person_1', 'entity', 'person', '李澄', {
      importance: 0.7, display_weight: 1.0, credibility: 1, cluster_id: 'cluster_people', tags: ['tag_team'], degree: 2,
      position: { x: -350, y: 140, z: 0 },
    }),
    node('ent_dev_person_2', 'entity', 'person', '周见微', {
      importance: 0.55, display_weight: 0.85, credibility: 1, cluster_id: 'cluster_people', tags: ['tag_team'], degree: 1,
      position: { x: -180, y: 250, z: -18 },
    }),
    node('ent_dev_project_1', 'entity', 'project', 'FCA Memory Atlas', {
      importance: 0.95, display_weight: 1.9, credibility: 1, cluster_id: 'cluster_project_atlas', tags: ['tag_project'], degree: 3,
      position: { x: 220, y: -160, z: 48 },
    }),
    node('ent_dev_place_1', 'entity', 'place', '杭州', {
      importance: 0.4, display_weight: 0.7, credibility: 1, cluster_id: 'cluster_travel', tags: ['tag_journal'], degree: 1,
      position: { x: 430, y: 200, z: -52 },
    }),
    node('ent_dev_concept_1', 'entity', 'concept', '本地优先架构', {
      importance: 0.78, display_weight: 1.2, credibility: 0.95, cluster_id: 'cluster_learning', tags: ['tag_design'], degree: 2,
      position: { x: 60, y: 300, z: 16 },
    }),
  ];

  const edges = [
    edge('rel_dev01', 'mem_dev01', 'ent_dev_project_1', 'belongs_to_project', 1, '属于项目'),
    edge('rel_dev02', 'mem_dev04', 'ent_dev_project_1', 'belongs_to_project', 1, '属于项目'),
    edge('rel_dev03', 'mem_dev10', 'ent_dev_project_1', 'belongs_to_project', 1, '属于项目'),
    edge('rel_dev04', 'mem_dev05', 'ent_dev_person_1', 'shared_experience', 0.9, '共同经历'),
    edge('rel_dev05', 'mem_dev09', 'ent_dev_person_2', 'shared_experience', 0.8, '共同经历'),
    edge('rel_dev06', 'mem_dev09', 'ent_dev_person_1', 'participates_in', 0.85, '参与'),
    edge('rel_dev07', 'mem_dev03', 'ent_dev_concept_1', 'knowledge_link', 0.9, '知识关联'),
    edge('rel_dev08', 'mem_dev11', 'ent_dev_concept_1', 'derived_from', 0.75, '派生自'),
    edge('rel_dev09', 'mem_dev01', 'mem_dev02', 'temporal_before', 0.7, '时间上在…之前'),
    edge('rel_dev10', 'mem_dev02', 'mem_dev04', 'causal', 0.8, '因果'),
    edge('rel_dev11', 'mem_dev04', 'mem_dev10', 'temporal_before', 0.65, '时间上在…之前'),
    edge('rel_dev12', 'mem_dev06', 'mem_dev03', 'knowledge_link', 0.6, '知识关联'),
    edge('rel_dev13', 'mem_dev07', 'mem_dev08', 'emotional_link', 0.55, '情感关联'),
    edge('rel_dev14', 'mem_dev12', 'ent_dev_project_1', 'belongs_to_project', 1, '属于项目'),
    edge('rel_dev15', 'ent_dev_place_1', 'mem_dev08', 'knowledge_link', 0.4, '地点相关'),
    edge('rel_dev16', 'mem_dev08', 'mem_dev07', 'causal', 0.5, '因果'),
  ];

  // 计算 degree
  const degree = new Map();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  }
  for (const n of nodes) n.degree = degree.get(n.id) || 0;

  const clusters = [
    { id: 'cluster_2026_spring', label: '2026 深秋 · 启动季', density: 0.72, dominant_types: ['episodic', 'project', 'working'], color_hint: 'cyan' },
    { id: 'cluster_project_atlas', label: '项目 · Memory Atlas', density: 0.68, dominant_types: ['project', 'episodic'], color_hint: 'violet' },
    { id: 'cluster_people', label: '人物 · 协作网络', density: 0.51, dominant_types: ['relational', 'person'], color_hint: 'gold' },
    { id: 'cluster_travel', label: '地点 · 杭州', density: 0.33, dominant_types: ['place'], color_hint: 'rose' },
    { id: 'cluster_learning', label: '学习 · 架构与设计', density: 0.58, dominant_types: ['semantic', 'procedural'], color_hint: 'blue' },
  ].map((cluster) => {
    const ids = nodes.filter((n) => n.cluster_id === cluster.id).map((n) => n.id);
    const cx = ids.reduce((sum, id) => sum + (nodes.find((n) => n.id === id).position.x || 0), 0) / Math.max(1, ids.length);
    const cy = ids.reduce((sum, id) => sum + (nodes.find((n) => n.id === id).position.y || 0), 0) / Math.max(1, ids.length);
    return { ...cluster, node_ids: ids, centroid: { x: Math.round(cx), y: Math.round(cy), z: 0 } };
  });

  return {
    api_version: '1',
    layout_version: 1,
    view: { center: [0, 0, 0], zoom: 1, view_id: null },
    nodes,
    edges,
    clusters,
    stats: { nodes: nodes.length, edges: edges.length, clusters: clusters.length, generated_at: new Date().toISOString() },
    // 明确标记来源，UI 必须显示 dev-only 横幅
    _dev_fixture: true,
  };
}

/** 空库形态（真实空库应显示空状态；此夹具仅用于开发期检查空态样式） */
export function createDevEmptyGraph() {
  return {
    api_version: '1',
    layout_version: 0,
    view: { center: [0, 0, 0], zoom: 1, view_id: null },
    nodes: [],
    edges: [],
    clusters: [],
    stats: { nodes: 0, edges: 0, clusters: 0, generated_at: new Date().toISOString() },
    _dev_fixture: true,
  };
}

export const DEV_CLUSTER_COLORS = CLUSTER_COLORS;
