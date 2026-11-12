/**
 * FCA Memory Atlas — 本地化格式化工具
 * 契约见 lib/contracts.md §2.4 ctx.format。
 */

const MEMORY_TYPE_LABELS = {
  working: '工作记忆',
  episodic: '情景记忆',
  semantic: '语义记忆',
  procedural: '程序记忆',
  autobiographical: '自传记忆',
  project: '项目记忆',
  relational: '关系记忆',
  emotional: '情感记忆',
  custom: '自定义',
};

const MEMORY_TYPE_COLORS = {
  working: 'cyan',
  episodic: 'blue',
  semantic: 'violet',
  procedural: 'green',
  autobiographical: 'gold',
  project: 'rose',
  relational: 'magenta',
  emotional: 'rose',
  custom: 'neutral',
};

const ENTITY_KIND_LABELS = {
  person: '人物',
  project: '项目',
  place: '地点',
  concept: '概念',
  organization: '组织',
  other: '其它',
};

const RELATION_TYPE_LABELS = {
  temporal_before: '时间上在…之前',
  temporal_after: '时间上在…之后',
  participates_in: '参与',
  shared_experience: '共同经历',
  knowledge_link: '知识关联',
  causal: '因果',
  derived_from: '派生自',
  belongs_to_project: '属于项目',
  emotional_link: '情感关联',
  custom: '自定义关系',
};

const SOURCE_TYPE_LABELS = {
  user: '用户输入',
  agent: 'Agent 生成',
  system: '系统',
  external: '外部来源',
  inference: '推断（未验证）',
  import: '导入',
};

const ORIGIN_LABELS = {
  user: '手动创建',
  agent: 'Agent 自动生成',
  revised: '人工修订',
};

const PRECISION_LABELS = {
  exact: '精确时间',
  day: '精确到日',
  month: '精确到月',
  year: '精确到年',
  approximate: '估计时间',
  unknown: '时间未知',
};

const CHANGE_KIND_LABELS = {
  create: '创建',
  update: '修改',
  merge: '合并',
  split: '拆分',
  restore: '恢复',
  delete: '删除',
  import: '导入',
};

const QUALITY_LABELS = {
  ultra: '极致',
  high: '高',
  medium: '中',
  low: '低',
  off: '关闭特效',
};

const NODE_KIND_LABELS = {
  memory: '记忆',
  entity: '实体',
};

function pad(n) {
  return String(n).padStart(2, '0');
}

function parseDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export const format = {
  /** 2026-11-12 10:00 */
  datetime(value) {
    const date = parseDate(value);
    if (!date) return '—';
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  },

  /** 2026-11-12 */
  date(value) {
    const date = parseDate(value);
    if (!date) return '—';
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  },

  /** 10:00 */
  time(value) {
    const date = parseDate(value);
    if (!date) return '—';
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  },

  /** 相对时间：刚刚 / 5 分钟前 / 3 小时前 / 2 天前 / 3 个月前 / 2025-01-02 */
  relativeTime(value) {
    const date = parseDate(value);
    if (!date) return '—';
    const diffMs = Date.now() - date.getTime();
    const abs = Math.abs(diffMs);
    const future = diffMs < 0;
    const suffix = future ? '后' : '前';
    if (abs < 45 * 1000) return '刚刚';
    if (abs < 60 * 60 * 1000) return `${Math.round(abs / 60000)} 分钟${suffix}`;
    if (abs < 24 * 60 * 60 * 1000) return `${Math.round(abs / 3600000)} 小时${suffix}`;
    if (abs < 30 * 24 * 60 * 60 * 1000) return `${Math.round(abs / 86400000)} 天${suffix}`;
    if (abs < 365 * 24 * 60 * 60 * 1000) return `${Math.round(abs / (30 * 86400000))} 个月${suffix}`;
    return `${Math.round(abs / (365 * 86400000))} 年${suffix}`;
  },

  /** 时间范围（用于时间筛选显示） */
  range(from, to) {
    if (!from && !to) return '全部时间';
    if (from && to) return `${this.date(from)} — ${this.date(to)}`;
    if (from) return `${this.date(from)} 起`;
    return `截至 ${this.date(to)}`;
  },

  number(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    if (Math.abs(n) >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (Math.abs(n) >= 10000) return `${(n / 1000).toFixed(1)}k`;
    return new Intl.NumberFormat('zh-CN').format(n);
  },

  percent(value, digits = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return `${(n * 100).toFixed(digits)}%`;
  },

  memoryTypeLabel(type) {
    return MEMORY_TYPE_LABELS[type] || type || '未分类';
  },

  memoryTypeColor(type) {
    return MEMORY_TYPE_COLORS[type] || 'neutral';
  },

  entityKindLabel(kind) {
    return ENTITY_KIND_LABELS[kind] || kind || '实体';
  },

  relationTypeLabel(type) {
    return RELATION_TYPE_LABELS[type] || type || '关系';
  },

  sourceTypeLabel(type) {
    return SOURCE_TYPE_LABELS[type] || type || '未知来源';
  },

  originLabel(origin) {
    return ORIGIN_LABELS[origin] || origin || '—';
  },

  precisionLabel(precision) {
    return PRECISION_LABELS[precision] || precision || '—';
  },

  changeKindLabel(kind) {
    return CHANGE_KIND_LABELS[kind] || kind || '变更';
  },

  qualityLabel(level) {
    return QUALITY_LABELS[level] || level;
  },

  nodeKindLabel(kind) {
    return NODE_KIND_LABELS[kind] || kind;
  },

  /** 时间筛选预设 → {from,to} */
  presetRange(preset) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (preset === 'today') return { from: start.toISOString(), to: now.toISOString() };
    if (preset === 'week') {
      const day = (start.getDay() + 6) % 7; // 周一为起点
      start.setDate(start.getDate() - day);
      return { from: start.toISOString(), to: now.toISOString() };
    }
    if (preset === 'month') {
      start.setDate(1);
      return { from: start.toISOString(), to: now.toISOString() };
    }
    if (preset === 'quarter') {
      const month = Math.floor(now.getMonth() / 3) * 3;
      const d = new Date(now.getFullYear(), month, 1);
      return { from: d.toISOString(), to: now.toISOString() };
    }
    if (preset === 'year') {
      const d = new Date(now.getFullYear(), 0, 1);
      return { from: d.toISOString(), to: now.toISOString() };
    }
    return { from: null, to: null };
  },

  /** 字节数 → 人类可读（KB/MB/GB） */
  bytes(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  },

  /** 毫秒 → 人类可读 */
  duration(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n < 1000) return `${Math.round(n)} ms`;
    if (n < 60000) return `${(n / 1000).toFixed(1)} s`;
    if (n < 3600000) return `${Math.floor(n / 60000)} 分钟`;
    if (n < 86400000) return `${Math.floor(n / 3600000)} 小时`;
    return `${Math.floor(n / 86400000)} 天`;
  },

  /** 截断字符串（视觉展示用） */
  truncate(text, max = 60) {
    const s = String(text == null ? '' : text);
    if (s.length <= max) return s;
    return `${s.slice(0, Math.max(0, max - 1))}…`;
  },

  fileSize: 'bytes',

  labels: {
    memoryTypes: MEMORY_TYPE_LABELS,
    memoryTypeColors: MEMORY_TYPE_COLORS,
    entityKinds: ENTITY_KIND_LABELS,
    relationTypes: RELATION_TYPE_LABELS,
    sourceTypes: SOURCE_TYPE_LABELS,
    origins: ORIGIN_LABELS,
    precisions: PRECISION_LABELS,
    changeKinds: CHANGE_KIND_LABELS,
    qualityLevels: QUALITY_LABELS,
  },
};

export default format;
