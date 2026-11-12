// FCA Local Runtime — seed --demo：约 120 条中文演示记忆 + 实体/关系/时间分布
// 明确标注 demo=true，仅用于演示/性能测试；默认空白库不会被混入。
// 所有数据由确定性 PRNG 生成（同一版本可复现）。
import { newId } from '../core/ids.js';
import { newTraceId } from '../core/ids.js';
import { nowIso } from '../core/time.js';
import { createHash } from 'node:crypto';
import { ApiError } from '../core/errors.js';

const MAX_DEMO_COUNT = 500;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rnd, list) {
  return list[Math.floor(rnd() * list.length)];
}

function pickMany(rnd, list, min, max) {
  const count = min + Math.floor(rnd() * (max - min + 1));
  const pool = [...list];
  const out = [];
  for (let i = 0; i < count && pool.length > 0; i += 1) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return out;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const PEOPLE = [
  { name: '张伟', description: '产品经理，长期合作的项目伙伴' },
  { name: '李娜', description: '设计师，擅长视觉与信息架构' },
  { name: '王芳', description: '多年好友，喜欢旅行和摄影' },
  { name: '陈晨', description: '后端工程师，负责数据平台' },
  { name: '刘洋', description: '大学同学，现居杭州' },
  { name: '赵敏', description: '读书会发起人，喜欢非虚构写作' },
  { name: '孙浩', description: '跑步搭子，周末常一起长距离' },
  { name: '周婷', description: '家人的朋友，从事教育工作' },
  { name: '吴磊', description: '前同事，创业中' },
  { name: '郑爽', description: '邻居，咖啡爱好者' },
  { name: '林涛', description: '健身教练，负责训练计划' },
  { name: '何静', description: '心理咨询师，偶尔交流正念练习' },
];

const PROJECTS = [
  { name: '星图计划', description: '个人记忆可视化产品项目' },
  { name: '晨光读书会', description: '每两周一次的线下读书会' },
  { name: '长跑训练营', description: '为半程马拉松做准备' },
  { name: '家庭旅行 2026', description: '春季家庭旅行计划' },
  { name: 'FCA 记忆图谱', description: '本地记忆基础设施研究项目' },
];

const PLACES = ['杭州西湖', '上海外滩', '成都青城山', '北京中关村', '苏州平江路', '厦门环岛路'];
const CONCEPTS = ['分布式系统', '摄影构图', '时间管理', '咖啡冲泡', '天文摄影', '正念冥想', '信息架构', '复盘方法'];
const ORGANIZATIONS = ['FCA 实验室', '城市徒步社', '晨光读书会'];

const TAGS = ['工作', '学习', '阅读', '旅行', '家庭', '朋友', '健康', '跑步', '摄影', '咖啡', '音乐', '电影', '复盘', '计划', '灵感', '情绪', '会议', '美食', '城市', '冥想', '写作', '产品', '数据', '天文'];

const SENTENCES = {
  work: [
    '上午和团队过了一遍需求，把范围收敛到最小可用版本。',
    '会后整理了三项待办，并确认了下周的评审时间。',
    '把接口契约写进文档，避免前后端理解出现偏差。',
    '复盘时发现真正的瓶颈在数据同步，不在界面。',
    '今天把原型跑通，第一次看到完整链路。',
    '临时插入的线上问题处理完，记下根因和后续改进项。',
  ],
  study: [
    '读完了这一章，对一致性模型有了更直观的理解。',
    '做了笔记，把关键概念之间的联系画成了图。',
    '尝试用自己的话解释一遍，发现有一处理解还不够稳。',
    '下午对照文档做了个小实验，结论和预期基本一致。',
    '把不懂的问题列出来，准备下次请教。',
  ],
  life: [
    '傍晚一起散步，聊了很久最近的状态。',
    '做了一顿简单的晚饭，味道比上次好。',
    '给家里打了电话，听他们讲了最近的琐事。',
    '周末把房间重新布置了一下，心情舒展不少。',
    '和朋友约在咖啡馆，聊到快打烊才走。',
  ],
  travel: [
    '早上出发，路上的光线很好，拍了不少照片。',
    '沿着湖边走了两个小时，风很舒服。',
    '在巷子里找到一家很小的店，安静又好吃。',
    '看日落的时候突然觉得应该多出来走走。',
    '回程路上整理照片，挑出最喜欢的三张。',
  ],
  health: [
    '按计划完成了今天的跑量，配速比上周稳定。',
    '拉伸时间加长了一些，膝盖没有再不舒服。',
    '训练结束后记录心率和体感，方便下周调整。',
    '早起有点困难，但还是出门完成了训练。',
    '教练提醒步频可以再提一点，明天试试。',
  ],
  reflection: [
    '回顾这一周，最重要的变化是开始固定时间复盘。',
    '意识到注意力被切得太碎，决定减少同时进行的任务。',
    '写下来之后，很多纠结的问题其实没那么复杂。',
    '给下个月定了三个具体的小目标，不再贪多。',
    '今天状态一般，允许自己慢一点，也算一种进步。',
  ],
};

const TITLES = {
  work: ['需求评审：{project}', '{project} 最小版本打通', '与{person}同步项目进度', '接口契约整理', '{project} 问题复盘', '下午的开发联调'],
  study: ['读完《{concept}》相关章节', '{concept} 学习笔记', '关于{tag}的一次小实验', '向{person}请教{concept}', '整理{concept}的知识脉络'],
  life: ['和{person}一起吃晚饭', '周末的家庭时间', '咖啡店的午后', '给家里打电话', '一次久违的散步'],
  travel: ['在{place}的一天', '{place}的黄昏', '周末短途：{place}', '旅行照片整理', '出发去{place}'],
  health: ['晨跑记录', '与{person}一起训练', '恢复训练第 {n} 天', '训练计划调整', '长距离慢跑'],
  reflection: ['本周复盘', '关于注意力的反思', '月度小结', '情绪记录', '给未来的自己写几句'],
};

const TAG_BY_CATEGORY = {
  work: ['工作', '产品', '会议', '数据', '计划'],
  study: ['学习', '阅读', '写作', '灵感', '复盘'],
  life: ['家庭', '朋友', '美食', '城市', '情绪'],
  travel: ['旅行', '摄影', '城市', '朋友', '美食'],
  health: ['健康', '跑步', '计划', '复盘'],
  reflection: ['复盘', '情绪', '冥想', '写作', '计划'],
};

function isoAt(rnd, daysAgoBase = 1030) {
  const days = Math.floor((1 - rnd() ** 1.5) * daysAgoBase);
  const base = Date.UTC(2024, 0, 1) + days * 86_400_000;
  const hour = 8 + Math.floor(rnd() * 13);
  const minute = Math.floor(rnd() * 60);
  return new Date(base + hour * 3_600_000 + minute * 60_000);
}

function buildMemoryDraft(rnd, index, entities) {
  const categories = ['work', 'work', 'work', 'study', 'study', 'life', 'life', 'travel', 'health', 'reflection'];
  const category = categories[index % categories.length];
  const person = pick(rnd, PEOPLE);
  const project = pick(rnd, PROJECTS);
  const place = pick(rnd, PLACES);
  const concept = pick(rnd, CONCEPTS);
  const tagPool = TAG_BY_CATEGORY[category];
  const tags = [...new Set([pick(rnd, tagPool), pick(rnd, tagPool), ...(rnd() < 0.4 ? [pick(rnd, tagPool)] : [])])].slice(0, 4);
  const titleTemplate = pick(rnd, TITLES[category]);
  const title = titleTemplate
    .replace('{project}', project.name)
    .replace('{person}', person.name)
    .replace('{concept}', concept)
    .replace('{place}', place)
    .replace('{tag}', pick(rnd, TAGS))
    .replace('{n}', String(1 + Math.floor(rnd() * 20)));
  const bodySentences = pickMany(rnd, SENTENCES[category], 2, 3);
  const detail = pick(rnd, [
    `同行的还有${pick(rnd, PEOPLE).name}。`,
    `时间大概是${['上午', '中午', '下午', '傍晚', '晚上'][Math.floor(rnd() * 5)]}。`,
    `记下这件事，是因为它和最近的${pick(rnd, ['计划', '复盘', '项目进度', '状态'])}有关。`,
    `有个细节值得记下来：${pick(rnd, ['光线很好', '沟通比预期顺利', '节奏有点赶', '比想象中安静'])}。`,
  ]);
  const body = `${bodySentences.join('')}${detail}`;
  const occurred = isoAt(rnd);
  const precision = rnd() < 0.65 ? 'exact' : rnd() < 0.85 ? 'day' : 'month';
  let occurredAt = occurred.toISOString();
  if (precision === 'day') occurredAt = occurredAt.slice(0, 10) + 'T00:00:00.000Z';
  if (precision === 'month') occurredAt = occurredAt.slice(0, 7) + '-01T00:00:00.000Z';
  if (precision === 'exact' && rnd() < 0.2) occurredAt = null; // 少量 unknown
  const memoryType = (() => {
    if (category === 'work') return rnd() < 0.35 ? 'project' : 'episodic';
    if (category === 'study') return rnd() < 0.6 ? 'semantic' : 'procedural';
    if (category === 'life') return rnd() < 0.4 ? 'relational' : 'episodic';
    if (category === 'travel') return rnd() < 0.25 ? 'autobiographical' : 'episodic';
    if (category === 'health') return rnd() < 0.5 ? 'procedural' : 'episodic';
    return rnd() < 0.6 ? 'autobiographical' : 'working';
  })();
  const participantCount = category === 'life' || category === 'travel' ? 1 + Math.floor(rnd() * 2) : rnd() < 0.5 ? 1 : 0;
  const participants = pickMany(rnd, PEOPLE, participantCount, participantCount).map((p) => ({ name: p.name, role: rnd() < 0.5 ? 'participant' : 'companion' }));
  const projectRef = category === 'work' || rnd() < 0.25 ? { name: project.name } : null;
  const emotion = ['emotional', 'relational', 'autobiographical'].includes(memoryType) && rnd() < 0.7
    ? {
        valence: round(rnd() * 1.6 - 0.6, 2),
        arousal: round(0.2 + rnd() * 0.6, 2),
        label: pick(rnd, ['平静', '愉快', '满足', '疲惫', '期待', '放松']),
      }
    : null;
  const source = rnd() < 0.82 ? 'user' : rnd() < 0.7 ? 'agent' : 'external';
  const origin = source === 'agent' ? 'agent' : 'user';
  return {
    title,
    body,
    memory_type: memoryType,
    occurred_at: occurredAt,
    occurred_precision: occurredAt ? precision : 'unknown',
    source: { type: source, ref: source === 'external' ? 'demo:external' : null, note: '演示数据' },
    credibility: round(0.7 + rnd() * 0.3, 2),
    importance: round(0.2 + rnd() * 0.75, 2),
    display_weight: round(0.6 + rnd() * 1.3, 2),
    tags,
    participants,
    project: projectRef,
    emotion,
    origin,
    agent_generated: origin === 'agent',
    demo: true,
    _category: category,
    _personName: person.name,
    _projectName: project.name,
    _place: place,
  };
}

export function seedDemo(deps, { clear = false, count = 120 } = {}) {
  const { config, logger, holder, events, services } = deps;
  if (!holder.isInitialized) {
    throw new ApiError('NOT_INITIALIZED', '数据库尚未初始化，请先运行 fca-runtime init');
  }
  const d = holder.db;
  const demoCount = Number(d.prepare('SELECT count(*) c FROM memories WHERE demo = 1').get()?.c ?? 0);
  if (clear) {
    if (demoCount === 0) return { cleared: true, demo_memories: 0, demo_entities: 0, message: '没有演示数据' };
    return clearDemo(deps);
  }
  if (demoCount > 0) {
    throw new ApiError('CONFLICT', `已存在 ${demoCount} 条演示数据，请先运行 seed --demo --clear 再重新生成`);
  }
  const total = Math.min(MAX_DEMO_COUNT, Math.max(1, Number(count) || 120));
  const rnd = mulberry32(0x5eed2026);
  const meta = {
    actor: { kind: 'user', id: 'local', display: '用户' },
    source: { kind: 'cli', id: 'seed', version: config.productVersion },
    traceId: newTraceId(),
    allowDemo: true,
  };
  // 1) 预创建实体（人物/项目/地点/概念/组织），metadata.demo=true
  const entityMeta = { ...meta, actor: { kind: 'system', id: 'seed', display: '演示数据生成器' } };
  const entityIds = {};
  const createEntities = (kind, items) => {
    for (const item of items) {
      const name = typeof item === 'string' ? item : item.name;
      try {
        const existing = d
          .prepare('SELECT id FROM entities WHERE kind = ? AND name = ? AND deleted_at IS NULL')
          .get(kind, name);
        let entityId = existing?.id;
        if (!entityId) {
          const created = services.entities.create(
            { kind, name, description: typeof item === 'string' ? '' : item.description ?? '', metadata: { demo: true } },
            entityMeta,
          );
          entityId = created.id;
        } else {
          d.prepare('UPDATE entities SET metadata = ? WHERE id = ?').run(JSON.stringify({ demo: true }), entityId);
        }
        entityIds[`${kind}:${name}`] = entityId;
      } catch (err) {
        logger?.warn?.('演示实体创建失败', { kind, name, error: err.message });
      }
    }
  };
  createEntities('person', PEOPLE);
  createEntities('project', PROJECTS);
  createEntities('place', PLACES);
  createEntities('concept', CONCEPTS);
  createEntities('organization', ORGANIZATIONS);

  // 2) 生成记忆
  const created = [];
  for (let i = 0; i < total; i += 1) {
    const draft = buildMemoryDraft(rnd, i, entityIds);
    const input = {
      title: draft.title,
      body: draft.body,
      memory_type: draft.memory_type,
      occurred_at: draft.occurred_at,
      occurred_precision: draft.occurred_precision,
      source: draft.source,
      credibility: draft.credibility,
      importance: draft.importance,
      display_weight: draft.display_weight,
      tags: draft.tags,
      participants: draft.participants,
      project: draft.project,
      emotion: draft.emotion,
      origin: draft.origin,
      agent_generated: draft.agent_generated,
      demo: true,
    };
    try {
      const memory = services.memory.create(input, meta);
      created.push({ memory, draft });
    } catch (err) {
      logger?.warn?.('演示记忆创建失败', { index: i, error: err.message });
    }
  }

  // 3) 关系：同项目时间链、共同参与者、同标签知识链接、情绪链接
  const relationService = services.relations;
  const relMeta = { ...meta, actor: { kind: 'system', id: 'seed', display: '演示数据生成器' } };
  let relationCount = 0;
  const createRelation = (from, to, type, label, confidence, evidence) => {
    try {
      relationService.create(
        {
          from: { kind: 'memory', id: from },
          to: { kind: 'memory', id: to },
          relation_type: type,
          directed: true,
          label,
          confidence,
          evidence,
          source: { type: 'system', ref: 'demo-seed', note: '演示数据' },
          weight: 1.0,
        },
        relMeta,
      );
      relationCount += 1;
    } catch (err) {
      logger?.debug?.('演示关系创建跳过', { error: err.message });
    }
  };
  const byProject = new Map();
  const byTag = new Map();
  const byPerson = new Map();
  for (const item of created) {
    const id = item.memory.id;
    if (item.draft._projectName && item.draft._category === 'work') {
      if (!byProject.has(item.draft._projectName)) byProject.set(item.draft._projectName, []);
      byProject.get(item.draft._projectName).push(id);
    }
    for (const tag of item.memory.tag_names) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(id);
    }
    for (const p of item.memory.participants) {
      if (!byPerson.has(p.name)) byPerson.set(p.name, []);
      byPerson.get(p.name).push(id);
    }
  }
  for (const [, ids] of byProject) {
    for (let i = 0; i + 1 < ids.length && i < 10; i += 1) {
      createRelation(ids[i], ids[i + 1], 'temporal_before', '发生在之前', 0.85, '演示数据：同一项目内的时间顺序');
    }
  }
  for (const [, ids] of byPerson) {
    for (let i = 0; i + 1 < ids.length && i < 6; i += 1) {
      createRelation(ids[i], ids[i + 1], 'shared_experience', '共同经历', 0.8, '演示数据：与同一个人有关的连续记忆');
    }
  }
  for (const [, ids] of byTag) {
    for (let i = 0; i + 1 < ids.length && i < 4; i += 1) {
      if (rnd() < 0.6) createRelation(ids[i], ids[i + 1], 'knowledge_link', '知识关联', 0.7, '演示数据：共享标签');
    }
  }
  const memoryEntities = [
    { type: 'temporal_after', label: '发生在之后', confidence: 0.8 },
    { type: 'causal', label: '因果相关', confidence: 0.65 },
    { type: 'emotional_link', label: '情绪关联', confidence: 0.75 },
  ];
  for (let i = 0; i + 1 < created.length && i < 30; i += 1) {
    if (rnd() < 0.35) {
      const template = memoryEntities[Math.floor(rnd() * memoryEntities.length)];
      createRelation(created[i].memory.id, created[i + 1].memory.id, template.type, template.label, template.confidence, '演示数据：随机关联');
    }
  }

  // 4) 标记演示实体（metadata.demo）
  for (const entityId of Object.values(entityIds)) {
    try {
      d.prepare('UPDATE entities SET metadata = ? WHERE id = ?').run(JSON.stringify({ demo: true }), entityId);
    } catch {
      /* ignore */
    }
  }

  // 5) 统计 + 触发一次布局（让 Desktop 首次打开即有坐标）
  let layoutInfo = null;
  try {
    layoutInfo = services.layout.ensureLayout(meta);
  } catch (err) {
    logger?.warn?.('演示数据布局生成失败（将在首次打开图时重试）', { error: err.message });
  }
  const summary = {
    seeded: true,
    demo: true,
    memories: created.length,
    relations: relationCount,
    entities: Object.keys(entityIds).length,
    layout_nodes: layoutInfo ? layoutInfo.rows.size : 0,
    layout_version: layoutInfo?.layoutVersion ?? null,
    note: '演示数据已标记 demo=true；使用 seed --demo --clear 清除',
  };
  logger?.info?.('演示数据生成完成', summary);
  return summary;
}

function clearDemo(deps) {
  const { config, logger, holder, events, services } = deps;
  const d = holder.db;
  const meta = {
    actor: { kind: 'user', id: 'local', display: '用户' },
    source: { kind: 'cli', id: 'seed', version: config.productVersion },
    traceId: newTraceId(),
  };
  const demoMemoryIds = d.prepare('SELECT id FROM memories WHERE demo = 1').all().map((r) => r.id);
  const demoEntityIds = d
    .prepare("SELECT id FROM entities WHERE metadata LIKE '%\"demo\":true%'")
    .all()
    .map((r) => r.id);
  // 演示记忆使用的标签：删除演示记忆后若标签不再被任何记忆引用则一并清理（被用户记忆引用的保留）
  const demoTaggings = d
    .prepare('SELECT DISTINCT mt.tag_id AS tag_id FROM memory_tags mt JOIN memories m ON m.id = mt.memory_id WHERE m.demo = 1')
    .all();
  const outEvents = [];
  let layoutChanged = false;
  let removedTags = 0;
  d.exec('BEGIN IMMEDIATE');
  try {
    for (const memoryId of demoMemoryIds) {
      const row = d.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId);
      if (!row) continue;
      // 关联关系物理清理
      d.prepare(
        "DELETE FROM relations WHERE (from_kind='memory' AND from_id=?) OR (to_kind='memory' AND to_id=?)",
      ).run(memoryId, memoryId);
      d.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(memoryId);
      d.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(memoryId);
      d.prepare('DELETE FROM memory_versions WHERE memory_id = ?').run(memoryId);
      d.prepare("DELETE FROM layout_nodes WHERE node_kind = 'memory' AND node_id = ?").run(memoryId);
      d.prepare('INSERT OR REPLACE INTO hard_deleted_memories(id, title, deleted_at) VALUES(?,?,?)').run(
        memoryId,
        row.title,
        nowIso(),
      );
      d.prepare('DELETE FROM memories WHERE id = ?').run(memoryId);
      layoutChanged = true;
      const prepared = events.prepare(d, {
        type: 'memory.deleted',
        actor: meta.actor,
        source: meta.source,
        subject: { kind: 'memory', id: memoryId },
        payload: { memory_id: memoryId, hard: true, soft: false, demo_clear: true },
        trace_id: meta.traceId,
      });
      outEvents.push(prepared.event);
    }
    // 清理因演示记忆删除而变成孤儿的演示标签（仍被用户记忆引用的标签保留）
    for (const row of demoTaggings) {
      const stillUsed = d.prepare('SELECT 1 AS x FROM memory_tags WHERE tag_id = ? LIMIT 1').get(row.tag_id);
      if (stillUsed) continue;
      d.prepare('DELETE FROM tags WHERE id = ?').run(row.tag_id);
      removedTags += 1;
    }
    for (const entityId of demoEntityIds) {
      const row = d.prepare('SELECT * FROM entities WHERE id = ?').get(entityId);
      if (!row) continue;
      d.prepare(
        "DELETE FROM relations WHERE (from_kind='entity' AND from_id=?) OR (to_kind='entity' AND to_id=?)",
      ).run(entityId, entityId);
      d.prepare("DELETE FROM layout_nodes WHERE node_kind = 'entity' AND node_id = ?").run(entityId);
      d.prepare('DELETE FROM entities WHERE id = ?').run(entityId);
      layoutChanged = true;
      const prepared = events.prepare(d, {
        type: 'entity.deleted',
        actor: meta.actor,
        source: meta.source,
        subject: { kind: 'entity', id: entityId },
        payload: { entity_id: entityId, hard: true, soft: false, demo_clear: true },
        trace_id: meta.traceId,
      });
      outEvents.push(prepared.event);
    }
    if (layoutChanged) {
      d.prepare("INSERT INTO meta(key, value, updated_at) VALUES('layout_version', CAST(COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key='layout_version'),0) + 1 AS TEXT), ?) ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at").run(nowIso());
    }
    d.exec('COMMIT');
  } catch (err) {
    try {
      d.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
  events.publish(outEvents);
  try {
    services.memory.rebuildIndexes();
  } catch (err) {
    logger?.warn?.('清理演示数据后重建索引失败', { error: err.message });
  }
  const summary = { cleared: true, demo_memories: demoMemoryIds.length, demo_entities: demoEntityIds.length, demo_tags: removedTags };
  logger?.info?.('演示数据已清除', summary);
  return summary;
}

export function demoFingerprint() {
  return createHash('sha256').update('fca-demo-seed-v1').digest('hex').slice(0, 16);
}
