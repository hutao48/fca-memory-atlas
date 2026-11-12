/**
 * FCA Memory Atlas — 记忆编辑器视图（Desktop Editor 组，Alpha 0.1）
 *
 * 上游契约：docs/PUBLIC_INTERFACE_FREEZE.md（数据模型/API/枚举）
 * 模块契约：desktop/renderer/lib/contracts.md v1.0 §2 视图注册 / §3 store / §4 api / §6 ui / §8 tokens
 *
 * 本视图职责：
 *  - 新建 / 编辑 / 软删除 / 恢复记忆（真实 Runtime API，经 ctx.api）
 *  - 全字段编辑：标题、正文、类型、发生时间+精度、来源、可信度、重要性、显示权重、标签、参与人物、项目、情绪、origin
 *  - 保存前本地校验；乐观并发冲突（VERSION_CONFLICT）可见并可选择「加载最新 / 覆盖保存」
 *  - 版本历史列表 + 双版本 diff（RFC6902 字段差异 + 正文行级差异）、载入历史版本
 *  - 合并重复记忆 / 拆分记忆入口（调用 merge/split API，需确认）
 *  - Markdown 预览（自实现安全渲染，防 XSS）
 *  - 深链：#view=editor&id=mem_…；无 id 为新建模式
 *  - 未保存草稿本地备份与恢复（仅 UI 草稿，不冒充业务数据）
 *
 * 约束：零第三方依赖、无构建步骤、原生 ESM；不直接 fetch；仅使用 CSS 变量。
 */

export const meta = {
  id: 'editor',
  title: '记忆编辑器',
  icon: 'edit',
  order: 50,
  nav: false,
  shortcut: 'g e',
};

/* ============================================================================
 * 常量（与冻结枚举一致；新增只能追加）
 * ========================================================================== */

export const MEMORY_TYPES = [
  { value: 'working', label: '工作记忆', hint: '当前任务上下文' },
  { value: 'episodic', label: '情景记忆', hint: '发生过的具体事件' },
  { value: 'semantic', label: '语义记忆', hint: '事实与知识' },
  { value: 'procedural', label: '程序记忆', hint: '技能与做法' },
  { value: 'autobiographical', label: '自传记忆', hint: '关于自身的经历' },
  { value: 'project', label: '项目记忆', hint: '项目相关进展' },
  { value: 'relational', label: '关系记忆', hint: '人物之间的关系' },
  { value: 'emotional', label: '情绪记忆', hint: '情绪体验' },
];

export const OCCURRED_PRECISIONS = [
  { value: 'exact', label: '精确到时刻' },
  { value: 'day', label: '精确到日' },
  { value: 'month', label: '精确到月' },
  { value: 'year', label: '精确到年' },
  { value: 'approximate', label: '估计时间' },
  { value: 'unknown', label: '时间未知' },
];

export const SOURCE_TYPES = [
  { value: 'user', label: '用户记录' },
  { value: 'agent', label: 'Agent 生成' },
  { value: 'system', label: '系统产生' },
  { value: 'external', label: '外部来源' },
  { value: 'inference', label: '模型推断（未验证）' },
  { value: 'import', label: '导入' },
];

export const ORIGINS = [
  { value: 'user', label: '手动创建' },
  { value: 'agent', label: 'Agent 自动生成' },
  { value: 'revised', label: '人工修订' },
];

export const CHANGE_KIND_LABEL = {
  create: '创建',
  update: '更新',
  merge: '合并',
  split: '拆分',
  restore: '恢复',
  delete: '删除',
  import: '导入',
};

export const PRECISION_LABEL = OCCURRED_PRECISIONS.reduce((acc, item) => {
  acc[item.value] = item.label;
  return acc;
}, {});

export const PRECISION_TONE = {
  exact: 'green',
  day: 'green',
  month: 'cyan',
  year: 'cyan',
  approximate: 'gold',
  unknown: 'rose',
};

const MAX_TAGS = 32;
const MAX_PARTICIPANTS = 32;
const MAX_TITLE = 500;
const MAX_BODY = 1_000_000;
const MAX_SOURCE_TEXT = 2000;
const DRAFT_KEY = 'fca.editor.draft';
const PREVIEW_KEY = 'fca.editor.preview';
const ASIDE_KEY = 'fca.editor.asideTab';

function typeLabel(value) {
  return (MEMORY_TYPES.find((t) => t.value === value) || {}).label || value || '未分类';
}

function sourceTypeLabel(value) {
  return (SOURCE_TYPES.find((t) => t.value === value) || {}).label || value || '—';
}

function originLabel(value) {
  return (ORIGINS.find((t) => t.value === value) || {}).label || value || '—';
}

/* ============================================================================
 * 纯函数区（无 DOM，供 tests/unit/desktop 直接导入测试）
 * ========================================================================== */

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 从 ISO 字符串提取本地 date 值（YYYY-MM-DD）；无效返回 '' */
export function isoToDateInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 从 ISO 字符串提取本地时间值（HH:mm）；无效返回 '' */
export function isoToTimeInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 把日期/时间输入转换成 ISO 字符串。
 * precision=month/year 时取该月/该年起点（本地时区），仍保存为 ISO 时间点。
 * 返回 { ok, iso, error }。
 */
export function dateTimeToIso(dateStr, timeStr) {
  if (!dateStr) return { ok: true, iso: null, error: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr).trim());
  if (!m) return { ok: false, iso: null, error: '日期格式应为 YYYY-MM-DD' };
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return { ok: false, iso: null, error: '日期不合法' };
  let hh = 0;
  let mm = 0;
  if (timeStr) {
    const t = /^(\d{2}):(\d{2})$/.exec(String(timeStr).trim());
    if (!t) return { ok: false, iso: null, error: '时间格式应为 HH:mm' };
    hh = Number(t[1]);
    mm = Number(t[2]);
    if (hh > 23 || mm > 59) return { ok: false, iso: null, error: '时间不合法' };
  }
  const date = new Date(y, mo - 1, d, hh, mm, 0, 0);
  // 校验真实存在（例如 2025-02-30 会被 Date 归一化到 3 月）
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) {
    return { ok: false, iso: null, error: '日期不存在' };
  }
  return { ok: true, iso: date.toISOString(), error: null };
}

/** 新建空白草稿（纯数据） */
export function createEmptyDraft() {
  return {
    title: '',
    body: '',
    memory_type: 'episodic',
    occurred_at: '',
    occurred_time: '',
    occurred_precision: 'exact',
    occurred_end_at: '',
    occurred_end_time: '',
    source_type: 'user',
    source_ref: '',
    source_note: '',
    credibility: 0.8,
    importance: 0.6,
    display_weight: 1,
    tags: [], // [{id?, name}]
    participants: [], // [{entity_id?, name, role}]
    project: null, // {entity_id?, name}
    emotion: null, // {valence, arousal, label}
    origin: 'user',
  };
}

/** 服务端 Memory → 表单草稿（纯数据） */
export function memoryToDraft(memory) {
  const mem = memory || {};
  const draft = createEmptyDraft();
  draft.title = mem.title || '';
  draft.body = mem.body || '';
  draft.memory_type = mem.memory_type || 'episodic';
  draft.occurred_at = isoToDateInput(mem.occurred_at);
  draft.occurred_time = isoToTimeInput(mem.occurred_at);
  draft.occurred_precision = mem.occurred_precision || (mem.occurred_at ? 'exact' : 'unknown');
  draft.occurred_end_at = isoToDateInput(mem.occurred_end_at);
  draft.occurred_end_time = isoToTimeInput(mem.occurred_end_at);
  if (mem.occurred_end_at && !draft.occurred_end_at) draft.occurred_end_at = isoToDateInput(mem.occurred_end_at);
  const src = mem.source || {};
  draft.source_type = src.type || 'user';
  draft.source_ref = src.ref || '';
  draft.source_note = src.note || '';
  draft.credibility = Number.isFinite(mem.credibility) ? mem.credibility : 0.8;
  draft.importance = Number.isFinite(mem.importance) ? mem.importance : 0.6;
  draft.display_weight = Number.isFinite(mem.display_weight) ? mem.display_weight : 1;
  const tagNames = Array.isArray(mem.tag_names) ? mem.tag_names : [];
  draft.tags = (Array.isArray(mem.tags) ? mem.tags : []).map((id, i) => ({ id, name: tagNames[i] || id }));
  if (!draft.tags.length && Array.isArray(mem.tag_names)) draft.tags = mem.tag_names.map((name) => ({ name }));
  draft.participants = (Array.isArray(mem.participants) ? mem.participants : []).map((p) => ({
    entity_id: p.entity_id || p.id || undefined,
    name: p.name || '',
    role: p.role || 'participant',
  }));
  draft.project = mem.project && (mem.project.entity_id || mem.project.name)
    ? { entity_id: mem.project.entity_id || undefined, name: mem.project.name || '' }
    : null;
  draft.emotion = mem.emotion ? {
    valence: Number.isFinite(mem.emotion.valence) ? mem.emotion.valence : 0.5,
    arousal: Number.isFinite(mem.emotion.arousal) ? mem.emotion.arousal : 0.5,
    label: mem.emotion.label || '',
  } : null;
  draft.origin = mem.origin || (mem.agent_generated ? 'agent' : 'user');
  return draft;
}

/**
 * 表单草稿 → API 写入 payload（纯数据）。
 * 标签/人物/项目：已有 id 发 id，新建发 name（Runtime 负责解析/创建）。
 */
export function buildSavePayload(draft) {
  if (!draft) return {};
  const payload = {
    title: String(draft.title || '').trim(),
    body: String(draft.body || ''),
    memory_type: draft.memory_type || 'episodic',
    occurred_precision: draft.occurred_precision || 'unknown',
    source: {
      type: draft.source_type || 'user',
      ref: draft.source_ref ? String(draft.source_ref).trim() : null,
      note: draft.source_note ? String(draft.source_note).trim() : null,
    },
    credibility: clamp01(draft.credibility, 0, 1),
    importance: clamp01(draft.importance, 0, 1),
    display_weight: clamp01(draft.display_weight, 0, 2),
    tags: (draft.tags || [])
      .map((t) => (t.id ? t.id : String(t.name || '').trim()))
      .filter(Boolean),
    participants: (draft.participants || [])
      .map((p) => ({
        ...(p.entity_id ? { entity_id: p.entity_id } : { name: String(p.name || '').trim() }),
        role: p.role || 'participant',
      }))
      .filter((p) => p.entity_id || p.name),
    project: draft.project && (draft.project.entity_id || String(draft.project.name || '').trim())
      ? (draft.project.entity_id ? { entity_id: draft.project.entity_id } : { name: String(draft.project.name).trim() })
      : null,
    emotion: draft.emotion
      ? {
          valence: clamp01(draft.emotion.valence, -1, 1),
          arousal: clamp01(draft.emotion.arousal, 0, 1),
          label: String(draft.emotion.label || '').trim() || null,
        }
      : null,
    origin: draft.origin || 'user',
  };

  // 时间未知：不发送发生时间（Runtime 对 create 的容错语义会把 unknown+时间 归一为 exact，这里保持语义一致）
  if (draft.occurred_precision === 'unknown') {
    payload.occurred_at = null;
    payload.occurred_end_at = null;
  } else {
    const start = dateTimeToIso(draft.occurred_at, draft.occurred_precision === 'exact' || draft.occurred_precision === 'approximate' ? draft.occurred_time : '');
    payload.occurred_at = start.ok ? start.iso : null;
    const end = dateTimeToIso(draft.occurred_end_at, draft.occurred_precision === 'exact' ? draft.occurred_end_time : '');
    payload.occurred_end_at = end.ok ? end.iso : null;
  }
  return payload;
}

/**
 * 保存前校验（纯函数）。
 * 返回 { ok, errors: {field: message}, order: [field...] }；order 用于聚焦第一个错误。
 */
export function validateMemoryDraft(draft) {
  const errors = {};
  const order = [];
  const fail = (field, message) => {
    if (!errors[field]) {
      errors[field] = message;
      order.push(field);
    }
  };

  const title = String(draft?.title ?? '').trim();
  if (!title) fail('title', '标题不能为空');
  else if (title.length > MAX_TITLE) fail('title', `标题不能超过 ${MAX_TITLE} 个字符（当前 ${title.length}）`);

  const body = String(draft?.body ?? '');
  if (body.length > MAX_BODY) fail('body', `正文超过 ${MAX_BODY} 字符上限（当前 ${body.length}）`);

  if (!MEMORY_TYPES.some((t) => t.value === draft?.memory_type)) fail('memory_type', '记忆类型不可识别');

  if (!OCCURRED_PRECISIONS.some((p) => p.value === draft?.occurred_precision)) fail('occurred_precision', '时间精度不可识别');

  const precision = draft?.occurred_precision;
  const start = dateTimeToIso(draft?.occurred_at, precision === 'exact' || precision === 'approximate' ? draft?.occurred_time : '');
  if (!start.ok) fail('occurred_at', start.error);
  else if (!start.iso && precision !== 'unknown') fail('occurred_at', '请选择发生时间，或将时间精度设为「时间未知」');
  if (!start.iso && draft?.occurred_end_at) fail('occurred_end_at', '未设置开始时间时不能设置结束时间');

  const end = dateTimeToIso(draft?.occurred_end_at, precision === 'exact' ? draft?.occurred_end_time : '');
  if (!end.ok) fail('occurred_end_at', end.error);
  else if (end.iso && start.iso && new Date(end.iso).getTime() < new Date(start.iso).getTime()) {
    fail('occurred_end_at', '结束时间不能早于开始时间');
  }

  if (!SOURCE_TYPES.some((s) => s.value === draft?.source_type)) fail('source_type', '来源类型不可识别');
  if (String(draft?.source_ref ?? '').length > MAX_SOURCE_TEXT) fail('source_ref', '来源引用过长');
  if (String(draft?.source_note ?? '').length > MAX_SOURCE_TEXT) fail('source_note', '来源备注过长');

  for (const [field, min, max] of [['credibility', 0, 1], ['importance', 0, 1], ['display_weight', 0, 2]]) {
    const value = Number(draft?.[field]);
    if (!Number.isFinite(value) || value < min || value > max) fail(field, `取值必须在 ${min} 至 ${max} 之间`);
  }

  const tags = Array.isArray(draft?.tags) ? draft.tags : [];
  if (tags.length > MAX_TAGS) fail('tags', `标签不能超过 ${MAX_TAGS} 个`);
  const seenTags = new Set();
  for (const tag of tags) {
    const name = String(tag?.name || '').trim();
    if (!tag?.id && !name) fail('tags', '标签名不能为空');
    if (!tag?.id && name.length > 64) fail('tags', '单个标签名不能超过 64 个字符');
    const key = (name || tag?.id || '').toLowerCase();
    if (seenTags.has(key)) fail('tags', `标签重复：${name || tag?.id}`);
    seenTags.add(key);
  }

  const parts = Array.isArray(draft?.participants) ? draft.participants : [];
  if (parts.length > MAX_PARTICIPANTS) fail('participants', `参与人物不能超过 ${MAX_PARTICIPANTS} 个`);
  for (const p of parts) {
    if (!p?.entity_id && !String(p?.name || '').trim()) fail('participants', '参与人物需要姓名或实体');
    if (String(p?.role || '').length > 60) fail('participants', '角色描述不能超过 60 字符');
  }

  if (draft?.project && !draft.project.entity_id && !String(draft.project.name || '').trim()) {
    fail('project', '项目需要名称或实体');
  }

  if (draft?.emotion) {
    const valence = Number(draft.emotion.valence);
    if (!Number.isFinite(valence) || valence < -1 || valence > 1) fail('emotion', '情绪效价必须在 -1 至 1 之间');
    const arousal = Number(draft.emotion.arousal);
    if (!Number.isFinite(arousal) || arousal < 0 || arousal > 1) fail('emotion', '情绪唤醒度必须在 0 至 1 之间');
  }

  if (!ORIGINS.some((o) => o.value === draft?.origin)) fail('origin', '来源标记不可识别');

  return { ok: order.length === 0, errors, order };
}

/**
 * 安全 Markdown → HTML（用于正文预览，防 XSS）。
 * 只支持基础格式：标题/段落/无序列表/有序列表/引用/代码块/行内代码/粗体/斜体/链接。
 * 链接仅允许 http(s)。所有文本先整体转义，再套用受限标签。
 */
export function renderMarkdown(markdown) {
  const src = String(markdown ?? '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const out = [];
  let inCode = false;
  let codeLines = [];
  let listMode = null; // 'ul' | 'ol'
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${inlineMarkdown(escapeHtml(para.join('\n')).replace(/\n/g, '<br>'))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (listMode) {
      out.push(`</${listMode}>`);
      listMode = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine;
    if (/^\s*```/.test(line)) {
      if (inCode) {
        out.push(`<pre class="view-editor-md__code"><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        flushPara();
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      closeList();
      const level = Math.min(heading[1].length + 2, 6); // 至少 h3，避免与外壳标题冲突
      out.push(`<h${level}>${inlineMarkdown(escapeHtml(heading[2].trim()))}</h${level}>`);
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      flushPara();
      closeList();
      out.push('<hr>');
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushPara();
      closeList();
      out.push(`<blockquote>${inlineMarkdown(escapeHtml(quote[1]))}</blockquote>`);
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      flushPara();
      if (listMode !== 'ul') {
        closeList();
        out.push('<ul>');
        listMode = 'ul';
      }
      out.push(`<li>${inlineMarkdown(escapeHtml(ul[1]))}</li>`);
      continue;
    }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      flushPara();
      if (listMode !== 'ol') {
        closeList();
        out.push('<ol>');
        listMode = 'ol';
      }
      out.push(`<li>${inlineMarkdown(escapeHtml(ol[1]))}</li>`);
      continue;
    }
    para.push(line);
  }
  if (inCode) {
    out.push(`<pre class="view-editor-md__code"><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  }
  flushPara();
  closeList();
  if (!out.length) return '<p class="view-editor-md__empty">（正文为空）</p>';
  return out.join('\n');
}

/** HTML 转义（导出的纯函数，测试覆盖 XSS） */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

const MARKDOWN_PLACEHOLDER = '\u0000';

function inlineMarkdown(escaped) {
  const codes = [];
  let text = String(escaped);
  // 行内代码先占位，避免其中的 * _ 被当作强调
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    codes.push(code);
    return `${MARKDOWN_PLACEHOLDER}${codes.length - 1}${MARKDOWN_PLACEHOLDER}`;
  });
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  text = text.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noreferrer noopener" target="_blank">$1</a>');
  text = text.replace(new RegExp(`${MARKDOWN_PLACEHOLDER}(\\d+)${MARKDOWN_PLACEHOLDER}`, 'g'), (_m, index) => `<code>${codes[Number(index)]}</code>`);
  return text;
}

/**
 * 行级 diff（LCS）。超大文本降级为「全删全增」以免内存爆炸。
 * 返回 [{ type:'context'|'add'|'del', text, oldLine, newLine }]
 */
export function diffLines(oldText, newText) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  if (a.length * b.length > 4_000_000) {
    return [
      ...a.map((text, i) => ({ type: 'del', text, oldLine: i + 1, newLine: null })),
      ...b.map((text, i) => ({ type: 'add', text, oldLine: null, newLine: i + 1 })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i += 1) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'context', text: a[i], oldLine: i + 1, newLine: j + 1 });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'del', text: a[i], oldLine: i + 1, newLine: null });
      i += 1;
    } else {
      rows.push({ type: 'add', text: b[j], oldLine: null, newLine: j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    rows.push({ type: 'del', text: a[i], oldLine: i + 1, newLine: null });
    i += 1;
  }
  while (j < m) {
    rows.push({ type: 'add', text: b[j], oldLine: null, newLine: j + 1 });
    j += 1;
  }
  return rows;
}

/** RFC6902 patch → 可读摘要（纯函数） */
export function summarizeJsonPatch(patch) {
  if (!Array.isArray(patch)) return [];
  return patch.map((op) => {
    const operation = String(op?.op || '');
    const path = String(op?.path || '');
    const label = patchPathLabel(path);
    let display = '';
    if (op && Object.prototype.hasOwnProperty.call(op, 'value')) {
      display = stringifyValue(op.value);
    } else if (op && Object.prototype.hasOwnProperty.call(op, 'from')) {
      display = `← ${stringifyValue(op.from)}`;
    }
    return { op: operation, path, label, value: display, raw: op };
  });
}

function patchPathLabel(path) {
  if (!path) return '（根）';
  const field = path.split('/').filter(Boolean).pop() || path;
  const map = {
    title: '标题',
    body: '正文',
    memory_type: '记忆类型',
    occurred_at: '发生时间',
    occurred_end_at: '结束时间',
    occurred_precision: '时间精度',
    source: '来源',
    credibility: '可信度',
    importance: '重要性',
    display_weight: '显示权重',
    tags: '标签',
    participants: '参与人物',
    project: '项目',
    emotion: '情绪',
    origin: '来源标记',
    version: '版本号',
    deleted_at: '删除时间',
    updated_at: '更新时间',
    agent_generated: 'Agent 生成标记',
  };
  return map[field] || field;
}

function stringifyValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'string') return value.length > 240 ? `${value.slice(0, 240)}…（共 ${value.length} 字符）` : value;
  try {
    const text = JSON.stringify(value);
    return text.length > 240 ? `${text.slice(0, 240)}…` : text;
  } catch {
    return String(value);
  }
}

/** 统一把 API 分页/数组响应归一化为数组（纯函数） */
export function normalizeItems(response, keys = ['items', 'results', 'data', 'versions']) {
  if (Array.isArray(response)) return response;
  if (!response || typeof response !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(response[key])) return response[key];
  }
  return [];
}

/** 两个表单草稿是否等价（用于脏检查；纯函数） */
export function draftEquals(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function clamp01(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/* ============================================================================
 * 视图实现
 * ========================================================================== */

export function createView(ctx) {
  const U = ctx.ui || {};
  const doc = document;
  const api = ctx.api;
  const disposers = [];
  let root = null;
  let styleEl = null;
  let currentContainer = null;

  const state = {
    mode: 'new', // new | edit | loading | error
    memoryId: null,
    memory: null,
    draft: createEmptyDraft(),
    baseline: createEmptyDraft(),
    errors: {},
    errorOrder: [],
    saving: false,
    loading: false,
    loadError: null,
    saveError: null,
    conflict: null,
    preview: readLocal(PREVIEW_KEY) === '1',
    asideTab: readLocal(ASIDE_KEY) || 'versions',
    versions: [],
    versionsLoading: false,
    versionsError: null,
    diffSelection: [],
    diffResult: null,
    relations: [],
    relationsLoading: false,
    draftBanner: null,
    splitRows: [],
    mergeRows: [],
    externalChange: null,
  };

  const dom = {};

  /* ------------------------------ 小工具 ------------------------------ */

  function readLocal(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeLocal(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* localStorage 不可用时静默降级（仅 UI 偏好） */
    }
  }

  function notify(type, message) {
    try {
      if (typeof ctx.toast === 'function') ctx.toast(message, { type });
      else if (U.toast) U.toast(message, { type });
    } catch {
      /* noop */
    }
  }

  function errInfo(err) {
    return {
      message: (err && (err.userMessage || err.message)) || '未知错误',
      code: (err && err.code) || 'UNKNOWN',
      traceId: (err && (err.traceId || (err.details && err.details.trace_id))) || null,
    };
  }

  function icon(name, opts) {
    try {
      if (typeof U.icon === 'function') return U.icon(name, opts || { size: 16 });
    } catch {
      /* 外壳图标不可用时退化为无图标 */
    }
    return null;
  }

  /** 轻量 DOM 构造器（不依赖外壳实现，避免组件签名差异导致白屏） */
  function el(tag, attrs, children) {
    const node = doc.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
        else if (key === 'on' && typeof value === 'object') {
          for (const [eventName, handler] of Object.entries(value)) {
            if (typeof handler === 'function') node.addEventListener(eventName, handler);
          }
        } else if (key in node) {
          try {
            node[key] = value;
          } catch {
            node.setAttribute(key, String(value));
          }
        } else {
          node.setAttribute(key, String(value));
        }
      }
    }
    append(node, children);
    return node;
  }

  function append(parent, children) {
    if (children === null || children === undefined || children === false) return parent;
    if (Array.isArray(children)) {
      for (const child of children) append(parent, child);
      return parent;
    }
    if (children instanceof Node) parent.append(children);
    else parent.append(doc.createTextNode(String(children)));
    return parent;
  }

  function button(opts = {}) {
    const variant = opts.variant || 'secondary';
    const node = el('button', {
      class: `view-editor__btn view-editor__btn--${variant}${opts.size === 'sm' ? ' view-editor__btn--sm' : ''}`,
      type: 'button',
      title: opts.title || '',
      disabled: Boolean(opts.disabled || opts.loading),
      'data-testid': opts.testid || null,
      on: { click: (event) => opts.onClick && opts.onClick(event) },
    }, [
      opts.icon ? icon(opts.icon, { size: 15 }) : null,
      opts.label ? el('span', { text: opts.label }) : null,
      opts.loading ? el('span', { class: 'view-editor__btn-spinner', 'aria-hidden': 'true' }) : null,
    ]);
    if (opts.loading) node.classList.add('is-loading');
    return node;
  }

  function field(labelText, control, opts = {}) {
    return el('label', { class: `view-editor__field${opts.wide ? ' view-editor__field--wide' : ''}` }, [
      el('span', { class: 'view-editor__label' }, [
        labelText,
        opts.required ? el('span', { class: 'view-editor__req', text: '*' }) : null,
        opts.hint ? el('span', { class: 'view-editor__hint', text: opts.hint }) : null,
      ]),
      control,
      opts.error ? el('span', { class: 'view-editor__error', text: opts.error, 'data-testid': opts.errorTestid || null }) : null,
    ]);
  }

  function textInput(opts = {}) {
    const node = el('input', {
      class: 'view-editor__input',
      type: opts.type || 'text',
      value: opts.value ?? '',
      placeholder: opts.placeholder || '',
      maxlength: opts.maxlength || null,
      min: opts.min ?? null,
      max: opts.max ?? null,
      step: opts.step || null,
      disabled: Boolean(opts.disabled),
      'data-testid': opts.testid || null,
      autocomplete: 'off',
      spellcheck: 'false',
    });
    if (opts.onInput) node.addEventListener('input', (e) => opts.onInput(e.target.value, e));
    if (opts.onChange) node.addEventListener('change', (e) => opts.onChange(e.target.value, e));
    return node;
  }

  function textArea(opts = {}) {
    const node = el('textarea', {
      class: `view-editor__input view-editor__textarea${opts.mono ? ' view-editor__textarea--mono' : ''}`,
      rows: String(opts.rows || 8),
      placeholder: opts.placeholder || '',
      disabled: Boolean(opts.disabled),
      'data-testid': opts.testid || null,
      spellcheck: 'false',
    });
    node.value = opts.value ?? '';
    if (opts.onInput) node.addEventListener('input', (e) => opts.onInput(e.target.value, e));
    return node;
  }

  function selectInput(options, value, onChange, opts = {}) {
    const node = el('select', {
      class: 'view-editor__input view-editor__select',
      disabled: Boolean(opts.disabled),
      'data-testid': opts.testid || null,
      'aria-label': opts.ariaLabel || null,
    });
    for (const option of options) {
      const opt = el('option', { value: option.value, text: option.label });
      if (option.value === value) opt.selected = true;
      if (option.disabled) opt.disabled = true;
      node.append(opt);
    }
    node.value = value;
    node.addEventListener('change', (e) => onChange(e.target.value));
    return node;
  }

  function slope(value, min, max, step, onChange, testid) {
    const wrap = el('div', { class: 'view-editor__slope' });
    const range = el('input', {
      class: 'view-editor__range',
      type: 'range',
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(value),
      'data-testid': testid || null,
    });
    const num = el('input', {
      class: 'view-editor__input view-editor__number',
      type: 'number',
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(value),
    });
    const sync = (next, from) => {
      const n = Number(next);
      if (!Number.isFinite(n)) return;
      const clamped = Math.min(max, Math.max(min, n));
      if (from !== 'range') range.value = String(clamped);
      if (from !== 'num') num.value = String(clamped);
      onChange(clamped);
    };
    range.addEventListener('input', (e) => sync(e.target.value, 'range'));
    num.addEventListener('input', (e) => sync(e.target.value, 'num'));
    wrap.append(range, num);
    return wrap;
  }

  function section(title, content, opts = {}) {
    return el('section', { class: 'view-editor__section' }, [
      el('div', { class: 'view-editor__section-head' }, [
        el('h3', { class: 'view-editor__section-title', text: title }),
        opts.actions || null,
      ]),
      content,
    ]);
  }

  function badge(text, tone, testid) {
    return el('span', {
      class: `view-editor__badge view-editor__badge--${tone || 'neutral'}`,
      text,
      'data-testid': testid || null,
    });
  }

  function errorBox(title, detail, retry, testid) {
    return el('div', { class: 'view-editor__errorbox', role: 'alert', 'data-testid': testid || 'editor-error' }, [
      el('div', { class: 'view-editor__errorbox-title', text: title }),
      detail ? el('div', { class: 'view-editor__errorbox-detail', text: detail }) : null,
      retry ? button({ label: '重试', icon: 'refresh', size: 'sm', onClick: retry }) : null,
    ]);
  }

  function emptyBox(title, description, actions) {
    try {
      if (typeof U.emptyState === 'function') {
        return U.emptyState({ icon: 'edit', title, description, actions: actions || [] });
      }
    } catch {
      /* fallthrough */
    }
    return el('div', { class: 'view-editor__emptybox' }, [
      el('div', { class: 'view-editor__emptybox-title', text: title }),
      el('div', { class: 'view-editor__emptybox-desc', text: description || '' }),
      actions ? el('div', {}, actions.map((a) => button({ label: a.label, variant: a.variant, onClick: a.onClick }))) : null,
    ]);
  }

  /* --------------------------- 数据访问（防御归一化） --------------------------- */

  async function fetchMemory(id) {
    const res = await api.getMemory(id);
    const memory = (res && res.memory) || res || null;
    if (!memory || !memory.id) {
      const err = new Error('Runtime 未返回有效记忆对象');
      err.code = 'BAD_RESPONSE';
      throw err;
    }
    return { memory, relations: normalizeItems(res, ['relations']), versionsCount: res && (res.versions_count || res.versionsCount) };
  }

  async function fetchVersions(id) {
    const res = await api.getVersions(id, { limit: 100 });
    return normalizeItems(res);
  }

  async function fetchDiff(id, from, to) {
    const res = await api.getDiff(id, { from, to });
    const patch = Array.isArray(res) ? res : (res && (res.diff || res.patch)) || [];
    return patch;
  }

  async function fetchRelations(id) {
    if (typeof api.listRelations !== 'function') return [];
    const res = await api.listRelations({ node_kind: 'memory', node_id: id, include_deleted: false });
    return normalizeItems(res);
  }

  async function loadMemory(id, opts = {}) {
    state.mode = 'loading';
    state.loading = true;
    state.loadError = null;
    state.memoryId = id;
    state.externalChange = null;
    render();
    try {
      const { memory, relations, versionsCount } = await fetchMemory(id);
      state.memory = memory;
      state.mode = 'edit';
      state.draft = memoryToDraft(memory);
      state.baseline = memoryToDraft(memory);
      state.errors = {};
      state.errorOrder = [];
      state.conflict = null;
      state.saveError = null;
      state.versionsCount = versionsCount;
      if (Array.isArray(relations) && relations.length) state.relations = relations;
      if (!opts.keepVersions) {
        state.versions = [];
        state.diffSelection = [];
        state.diffResult = null;
      }
      state.relationsLoading = true;
      render();
      loadVersions(id);
      loadRelations(id);
      renderTitleBar();
      setStatus();
    } catch (err) {
      const info = errInfo(err);
      state.mode = 'error';
      state.loading = false;
      state.loadError = info;
      render();
    } finally {
      state.loading = false;
    }
  }

  async function loadVersions(id) {
    state.versionsLoading = true;
    state.versionsError = null;
    if (state.asideTab === 'versions') renderVersions();
    try {
      state.versions = await fetchVersions(id);
      state.versionsLoading = false;
      if (state.asideTab === 'versions') renderAside();
    } catch (err) {
      state.versionsLoading = false;
      state.versionsError = errInfo(err);
      if (state.asideTab === 'versions') renderVersions();
    }
  }

  async function loadRelations(id) {
    state.relationsLoading = true;
    if (state.asideTab === 'relations') renderRelations();
    try {
      state.relations = await fetchRelations(id);
    } catch (err) {
      state.relations = [];
      state.relationsError = errInfo(err);
    } finally {
      state.relationsLoading = false;
      if (state.asideTab === 'relations') renderAside();
    }
  }

  async function loadInitial() {
    const params = getParams();
    const id = params.get ? params.get('id') : null;
    loadDraftBanner();
    if (id) {
      await loadMemory(id);
    } else {
      state.mode = 'new';
      state.memoryId = null;
      state.memory = null;
      state.draft = createEmptyDraft();
      state.baseline = createEmptyDraft();
      render();
      setStatus();
    }
  }

  function getParams() {
    try {
      const params = ctx.router && ctx.router.params;
      if (params && typeof params.get === 'function') return params;
    } catch {
      /* noop */
    }
    // 退化：直接从 location.hash 解析，保证 capture/e2e 深链可用
    try {
      const hash = window.location.hash.replace(/^#/, '');
      const queryIndex = hash.indexOf('&');
      return new URLSearchParams(queryIndex >= 0 ? hash.slice(queryIndex + 1) : '');
    } catch {
      return new URLSearchParams('');
    }
  }

  /* ------------------------------- 草稿 ------------------------------- */

  function loadDraftBanner() {
    try {
      const raw = readLocal(DRAFT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.form) return;
      state.draftBanner = {
        form: parsed.form,
        at: parsed.at || null,
        memoryId: parsed.memoryId || null,
      };
    } catch {
      state.draftBanner = null;
    }
  }

  function persistDraft() {
    if (!isDirty()) {
      clearDraft();
      return;
    }
    const saved = {
      form: state.draft,
      at: new Date().toISOString(),
      memoryId: state.memoryId,
    };
    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify(saved));
    } catch {
      /* 容量不足时忽略 */
    }
  }

  function clearDraft() {
    try {
      window.localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* noop */
    }
  }

  function acceptDraft() {
    if (!state.draftBanner) return;
    state.draft = { ...createEmptyDraft(), ...state.draftBanner.form };
    state.draftBanner = null;
    state.errors = {};
    render();
    notify('info', '已恢复本地草稿（尚未写入 Runtime）');
  }

  function discardDraft() {
    state.draftBanner = null;
    clearDraft();
    render();
  }

  function isDirty() {
    return !draftEquals(state.draft, state.baseline);
  }

  /* ------------------------------- 渲染 ------------------------------- */

  function mount(container) {
    currentContainer = container;
    styleEl = doc.createElement('style');
    styleEl.id = 'view-editor-style';
    styleEl.textContent = EDITOR_CSS;
    doc.head.append(styleEl);

    root = el('div', { class: 'view-editor fca-scroll', 'data-testid': 'view-editor' });
    container.append(root);
    const initialParams = getParams();
    const initialId = initialParams.get ? initialParams.get('id') : null;
    state.mode = initialId ? 'loading' : 'new';
    render();
    loadInitial();

    const onBeforeUnload = (event) => {
      if (!isDirty()) return undefined;
      event.preventDefault();
      event.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    disposers.push(() => window.removeEventListener('beforeunload', onBeforeUnload));

    const onKeydown = (event) => {
      if (!isDirty()) return;
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
      }
    };
    doc.addEventListener('keydown', onKeydown);
    disposers.push(() => doc.removeEventListener('keydown', onKeydown));

    // 外部更新提示（SSE 广播；容忍 payload 形状差异）
    const offUpdated = subscribeEvent('sse:memory.updated', (event) => {
      const id = subjectIdOf(event);
      if (!id || id !== state.memoryId) return;
      if (isDirty()) {
        state.externalChange = { at: new Date().toISOString(), dirty: true };
        renderBanner();
      } else {
        loadMemory(id, { keepVersions: true });
        notify('info', '该记忆已在其它客户端更新，已刷新为最新版本');
      }
    });
    if (offUpdated) disposers.push(offUpdated);
    const offDeleted = subscribeEvent('sse:memory.deleted', (event) => {
      const id = subjectIdOf(event);
      if (!id || id !== state.memoryId) return;
      loadMemory(id, { keepVersions: true });
    });
    if (offDeleted) disposers.push(offDeleted);
  }

  function subscribeEvent(name, handler) {
    try {
      if (ctx.events && typeof ctx.events.on === 'function') {
        const off = ctx.events.on(name, handler);
        return typeof off === 'function' ? off : () => ctx.events.off && ctx.events.off(name, handler);
      }
    } catch {
      /* noop */
    }
    return null;
  }

  function subjectIdOf(event) {
    if (!event || typeof event !== 'object') return null;
    if (event.subject && typeof event.subject === 'object') return event.subject.id || null;
    if (event.event && event.event.subject) return event.event.subject.id || null;
    if (event.payload && event.payload.id) return event.payload.id;
    return null;
  }

  function render() {
    if (!root) return;
    root.textContent = '';
    if (state.mode === 'loading') {
      root.append(renderLoading());
      return;
    }
    if (state.mode === 'error') {
      root.append(el('div', { class: 'view-editor__center' }, [
        errorBox('无法加载记忆', state.loadError ? `${state.loadError.message}${state.loadError.traceId ? `（trace: ${state.loadError.traceId}）` : ''}` : '', () => loadMemory(state.memoryId)),
        el('div', { class: 'view-editor__center-actions' }, [
          button({ label: '新建记忆', icon: 'plus', variant: 'primary', onClick: () => startNew() }),
          button({ label: '返回列表', icon: 'list', onClick: () => navigate('list') }),
        ]),
      ]));
      return;
    }
    root.append(renderHeader());
    dom.bannerHost = el('div', { class: 'view-editor__banner-host' });
    root.append(dom.bannerHost);
    renderBanner();

    const grid = el('div', { class: 'view-editor__grid' });
    dom.formHost = el('div', { class: 'view-editor__form', 'data-testid': 'editor-form' });
    dom.asideHost = el('aside', { class: 'view-editor__aside' });
    grid.append(dom.formHost, dom.asideHost);
    root.append(grid);
    renderForm();
    renderAside();
  }

  function renderLoading() {
    const label = el('div', { class: 'view-editor__loading' }, [el('div', { class: 'view-editor__spinner' }), el('div', { text: '正在读取记忆…' })]);
    return label;
  }

  function renderHeader() {
    const isEdit = state.mode === 'edit' && state.memory;
    const mem = state.memory;
    const header = el('div', { class: 'view-editor__bar' });
    const left = el('div', { class: 'view-editor__bar-left' }, [
      el('button', {
        class: 'view-editor__back',
        type: 'button',
        title: '返回记忆列表',
        'aria-label': '返回记忆列表',
        on: { click: () => navigate('list') },
      }, [icon('chevron-left', { size: 16 }), el('span', { text: '列表' })]),
      el('div', { class: 'view-editor__heading' }, [
        el('div', { class: 'view-editor__heading-title', 'data-testid': 'editor-heading', text: isEdit ? (mem.title || '未命名记忆') : '新建记忆' }),
        el('div', { class: 'view-editor__heading-meta' }, [
          isEdit ? badge(typeLabel(mem.memory_type), 'cyan') : badge('新建', 'gold'),
          isEdit ? el('span', { class: 'view-editor__mono', text: mem.id }) : el('span', { class: 'view-editor__mono view-editor__mono--dim', text: '尚未写入 Runtime' }),
          isEdit ? el('span', { class: 'view-editor__muted', text: `v${mem.version ?? '?'}` }) : null,
          isEdit && mem.deleted_at ? badge('回收站', 'rose') : null,
          isEdit && mem.agent_generated ? badge('Agent 生成', 'violet') : null,
          isDirty() ? badge('未保存', 'gold', 'editor-dirty') : null,
        ]),
      ]),
    ]);
    const right = el('div', { class: 'view-editor__bar-actions' });
    right.append(
      button({ label: state.preview ? '编辑正文' : '预览正文', icon: 'eye', variant: 'ghost', testid: 'editor-preview-toggle', onClick: () => togglePreview() }),
      button({ label: '版本历史', icon: 'history', variant: 'ghost', testid: 'editor-versions-btn', onClick: () => { state.asideTab = 'versions'; renderAside(); } }),
      button({ label: '关系', icon: 'relation', variant: 'ghost', testid: 'editor-relations-btn', onClick: () => { state.asideTab = 'relations'; renderAside(); } }),
      button({ label: '合并', icon: 'merge', variant: 'ghost', testid: 'editor-merge-btn', disabled: !isEdit || Boolean(mem && mem.deleted_at), onClick: () => openMergeDialog() }),
      button({ label: '拆分', icon: 'split', variant: 'ghost', testid: 'editor-split-btn', disabled: !isEdit || Boolean(mem && mem.deleted_at), onClick: () => openSplitDialog() }),
      isEdit && mem.deleted_at
        ? button({ label: '恢复', icon: 'history', variant: 'secondary', testid: 'editor-restore', onClick: () => restoreMemory() })
        : button({ label: '删除', icon: 'trash', variant: 'danger', testid: 'editor-delete', disabled: !isEdit, onClick: () => softDelete() }),
      button({
        label: '保存',
        icon: 'save',
        variant: 'primary',
        testid: 'editor-save',
        loading: state.saving,
        disabled: state.saving || Boolean(isEdit && mem && mem.deleted_at),
        onClick: () => save(),
      }),
    );
    header.append(left, right);
    return header;
  }

  function renderBanner() {
    if (!dom.bannerHost) return;
    dom.bannerHost.textContent = '';
    const banners = [];
    if (state.draftBanner) {
      banners.push(renderNotice({
        tone: 'gold',
        title: '检测到未保存的本地草稿',
        detail: `${state.draftBanner.at ? formatDateTime(state.draftBanner.at) : '时间未知'} · 草稿只保存在本机 UI，未写入 Runtime`,
        actions: [
          { label: '恢复草稿', variant: 'primary', onClick: acceptDraft },
          { label: '丢弃', variant: 'ghost', onClick: discardDraft },
        ],
      }));
    }
    if (state.saveError) {
      banners.push(renderNotice({
        tone: 'rose',
        title: '保存失败',
        detail: `${state.saveError.message}${state.saveError.code ? ` · ${state.saveError.code}` : ''}${state.saveError.traceId ? ` · trace ${state.saveError.traceId}` : ''}`,
        actions: [{ label: '再次保存', variant: 'secondary', onClick: () => save() }, { label: '关闭', variant: 'ghost', onClick: () => { state.saveError = null; renderBanner(); } }],
      }));
    }
    if (state.conflict) {
      banners.push(renderNotice({
        tone: 'rose',
        title: `版本冲突：Runtime 中当前版本为 v${state.conflict.currentVersion ?? '?'}`,
        detail: '该记忆已被其它客户端修改。你的本地修改仍在编辑器中，可选择加载最新或覆盖保存。',
        actions: [
          { label: '加载最新（放弃本地修改）', variant: 'secondary', testid: 'editor-conflict-reload', onClick: () => resolveConflict('reload') },
          { label: '覆盖保存', variant: 'primary', testid: 'editor-conflict-overwrite', onClick: () => resolveConflict('overwrite') },
        ],
      }));
    }
    if (state.externalChange) {
      banners.push(renderNotice({
        tone: 'cyan',
        title: '该记忆已在其它客户端更新',
        detail: state.externalChange.dirty ? '你当前有未保存修改，已保留本地内容；可加载最新版本或继续覆盖保存。' : '点击加载最新版本。',
        actions: [{ label: '加载最新', variant: 'secondary', onClick: () => loadMemory(state.memoryId) }],
      }));
    }
    if (state.memory && state.memory.deleted_at) {
      banners.push(renderNotice({
        tone: 'rose',
        title: '该记忆已在回收站（软删除）',
        detail: '软删除保留全部历史；恢复后可继续编辑。',
        actions: [{ label: '恢复记忆', variant: 'primary', testid: 'editor-restore-banner', onClick: () => restoreMemory() }],
      }));
    }
    if (state.mode === 'edit' && !state.memory) {
      banners.push(renderNotice({ tone: 'rose', title: '记忆对象缺失', detail: '无法读取记忆数据。' }));
    }
    for (const banner of banners) dom.bannerHost.append(banner);
  }

  function renderNotice(opts) {
    return el('div', { class: `view-editor__notice view-editor__notice--${opts.tone || 'cyan'}`, role: 'status' }, [
      el('div', { class: 'view-editor__notice-body' }, [
        el('div', { class: 'view-editor__notice-title', text: opts.title }),
        opts.detail ? el('div', { class: 'view-editor__notice-detail', text: opts.detail }) : null,
      ]),
      opts.actions ? el('div', { class: 'view-editor__notice-actions' }, opts.actions.map((a) => button(a))) : null,
    ]);
  }

  function renderForm() {
    if (!dom.formHost) return;
    dom.formHost.textContent = '';
    const draft = state.draft;
    const deleted = Boolean(state.memory && state.memory.deleted_at);
    const disabled = deleted;

    // 标题
    dom.titleInput = textInput({
      value: draft.title,
      placeholder: '一句话概括这条记忆（必填，≤500 字）',
      maxlength: MAX_TITLE,
      testid: 'editor-title',
      disabled,
      onInput: (value) => updateDraft('title', value),
    });
    dom.titleInput.classList.add('view-editor__title-input');
    dom.formHost.append(field('标题', dom.titleInput, { required: true, wide: true, error: state.errors.title, errorTestid: 'editor-error-title' }));

    // 类型 + 精度 + 时间
    dom.typeSelect = selectInput(MEMORY_TYPES, draft.memory_type, (value) => updateDraft('memory_type', value), {
      testid: 'editor-type',
      disabled,
      ariaLabel: '记忆类型',
    });
    dom.precisionSelect = selectInput(OCCURRED_PRECISIONS, draft.occurred_precision, (value) => updateDraft('occurred_precision', value, true), {
      testid: 'editor-precision',
      disabled,
      ariaLabel: '时间精度',
    });
    const dateRow = el('div', { class: 'view-editor__date-row' });
    const precision = draft.occurred_precision;
    const showTime = precision === 'exact' || precision === 'approximate';
    dom.dateInput = textInput({
      value: draft.occurred_at,
      type: 'date',
      testid: 'editor-date',
      disabled: disabled || precision === 'unknown',
      onInput: (value) => updateDraft('occurred_at', value),
    });
    dateRow.append(dom.dateInput);
    if (showTime) {
      dom.timeInput = textInput({
        value: draft.occurred_time,
        type: 'time',
        testid: 'editor-time',
        disabled,
        onInput: (value) => updateDraft('occurred_time', value),
      });
      dateRow.append(dom.timeInput);
    }
    if (precision === 'approximate') dateRow.append(el('span', { class: 'view-editor__date-hint', text: '估计时间：保存后按所选时间点参与时间线' }));
    if (precision === 'unknown') dateRow.append(el('span', { class: 'view-editor__date-hint', text: '时间未知：occurred_at 保存为 null，不参与时间线分桶' }));

    const typeRow = el('div', { class: 'view-editor__row view-editor__row--2' }, [
      field('记忆类型', dom.typeSelect, { required: true, error: state.errors.memory_type }),
      field('发生时间精度', dom.precisionSelect, { required: true, error: state.errors.occurred_precision }),
    ]);
    dom.formHost.append(typeRow);
    dom.formHost.append(field('发生时间', dateRow, { error: state.errors.occurred_at, errorTestid: 'editor-error-date', hint: '按本地时区保存为 ISO 8601；unknown 表示缺失时间' }));

    if (showTime || precision === 'day' || precision === 'month' || precision === 'year') {
      const endRow = el('div', { class: 'view-editor__date-row' });
      dom.endDateInput = textInput({
        value: draft.occurred_end_at,
        type: 'date',
        testid: 'editor-end-date',
        disabled,
        onInput: (value) => updateDraft('occurred_end_at', value),
      });
      endRow.append(dom.endDateInput);
      if (precision === 'exact') {
        dom.endTimeInput = textInput({
          value: draft.occurred_end_time,
          type: 'time',
          testid: 'editor-end-time',
          disabled,
          onInput: (value) => updateDraft('occurred_end_time', value),
        });
        endRow.append(dom.endTimeInput);
      }
      dom.formHost.append(field('结束时间（可选）', endRow, { error: state.errors.occurred_end_at }));
    }

    // 正文
    const bodyHost = el('div', { class: 'view-editor__body-wrap' });
    if (state.preview) {
      const rendered = el('div', { class: 'view-editor__preview fca-scroll', 'data-testid': 'editor-preview' });
      rendered.innerHTML = renderMarkdown(draft.body);
      bodyHost.append(rendered);
    } else {
      dom.bodyInput = textArea({
        value: draft.body,
        rows: 16,
        placeholder: '记录发生的事情、想法、事实或过程…\n\n支持基础 Markdown：**粗体**、*斜体*、`代码`、# 标题、- 列表、> 引用、``` 代码块、[链接](https://…)',
        testid: 'editor-body',
        disabled,
        onInput: (value) => updateDraft('body', value),
      });
      dom.bodyInput.classList.add('view-editor__body-input');
      bodyHost.append(dom.bodyInput);
      const stats = el('div', { class: 'view-editor__body-stats' });
      stats.textContent = `${draft.body.length} 字符 · ${draft.body.split('\n').length} 行`;
      bodyHost.append(stats);
    }
    dom.formHost.append(field('正文', bodyHost, { required: true, wide: true, error: state.errors.body, errorTestid: 'editor-error-body' }));

    // 标签
    dom.formHost.append(section('标签', renderTagEditor(disabled), { actions: el('span', { class: 'view-editor__section-hint', text: 'Enter 添加，可自由输入标签名' }) }));

    // 参与人物
    dom.formHost.append(section('参与人物', renderParticipantsEditor(disabled), { actions: el('span', { class: 'view-editor__section-hint', text: '从实体中选择或直接输入姓名' }) }));

    // 项目
    dom.formHost.append(section('所属项目', renderProjectEditor(disabled)));

    // 来源信息
    const sourceGrid = el('div', { class: 'view-editor__grid-fields' }, [
      field('来源类型', selectInput(SOURCE_TYPES, draft.source_type, (value) => updateDraft('source_type', value), { disabled }), { error: state.errors.source_type }),
      field('来源引用（ref）', textInput({ value: draft.source_ref, placeholder: 'URL / 会话 ID / 文件名等', testid: 'editor-source-ref', disabled, onInput: (v) => updateDraft('source_ref', v) }), { error: state.errors.source_ref }),
      field('来源备注（note）', textInput({ value: draft.source_note, placeholder: '补充说明', testid: 'editor-source-note', disabled, onInput: (v) => updateDraft('source_note', v) }), { error: state.errors.source_note }),
    ]);
    dom.formHost.append(section('来源', sourceGrid));

    // 评分
    const scoreGrid = el('div', { class: 'view-editor__grid-fields' }, [
      field('可信度（0-1）', slope(draft.credibility, 0, 1, 0.01, (v) => updateDraft('credibility', v), 'editor-credibility'), { error: state.errors.credibility, hint: '这条记忆有多可靠' }),
      field('重要性（0-1）', slope(draft.importance, 0, 1, 0.01, (v) => updateDraft('importance', v), 'editor-importance'), { error: state.errors.importance, hint: '对认知主体的重要程度' }),
      field('显示权重（0-2）', slope(draft.display_weight, 0, 2, 0.05, (v) => updateDraft('display_weight', v), 'editor-display-weight'), { error: state.errors.display_weight, hint: '星图中星体亮度倍率' }),
    ]);
    dom.formHost.append(section('认知权重', scoreGrid));

    // 情绪
    dom.formHost.append(section('情绪记录', renderEmotionEditor(disabled), {
      actions: el('label', { class: 'view-editor__checkline' }, [
        el('input', {
          type: 'checkbox',
          checked: Boolean(draft.emotion),
          'data-testid': 'editor-emotion-enabled',
          on: {
            change: (event) => {
              updateDraft('emotion', event.target.checked ? { valence: 0.5, arousal: 0.5, label: '' } : null, true);
            },
          },
        }),
        el('span', { text: '记录情绪状态' }),
      ]),
    }));

    // 来源标记 / Agent 生成
    const originRow = el('div', { class: 'view-editor__grid-fields' }, [
      field('来源标记 origin', selectInput(ORIGINS, draft.origin, (value) => updateDraft('origin', value), { testid: 'editor-origin', disabled }), {
        error: state.errors.origin,
        hint: '手动创建 / Agent 自动生成 / 人工修订',
      }),
      el('div', { class: 'view-editor__readonly' }, [
        el('span', { class: 'view-editor__label', text: 'Agent 生成标记' }),
        el('div', {}, [
          state.memory && state.memory.agent_generated ? badge('Agent 生成', 'violet') : badge('人工创建', 'green'),
          el('div', { class: 'view-editor__hint', text: '由 Runtime 依据 origin 维护，保存后刷新' }),
        ]),
      ]),
    ]);
    dom.formHost.append(section('来源标记', originRow));

    // 只读元信息
    if (state.mode === 'edit' && state.memory) {
      const mem = state.memory;
      dom.formHost.append(section('元信息', el('div', { class: 'view-editor__meta-grid' }, [
        metaItem('记忆 ID', mem.id, true),
        metaItem('当前版本', `v${mem.version ?? '?'}`),
        metaItem('创建时间', formatDateTime(mem.created_at)),
        metaItem('更新时间', formatDateTime(mem.updated_at)),
        metaItem('创建者', actorText(mem.created_by)),
        metaItem('更新者', actorText(mem.updated_by)),
        mem.deleted_at ? metaItem('删除时间', formatDateTime(mem.deleted_at)) : null,
      ].filter(Boolean))));
    }
  }

  function metaItem(label, value, mono) {
    return el('div', { class: 'view-editor__meta-item' }, [
      el('span', { class: 'view-editor__meta-label', text: label }),
      el('span', { class: `view-editor__meta-value${mono ? ' view-editor__mono' : ''}`, text: value == null ? '—' : String(value) }),
    ]);
  }

  function actorText(actor) {
    if (!actor) return '—';
    const kind = actor.kind || 'unknown';
    const map = { user: '用户', agent: 'Agent', system: '系统', plugin: '插件' };
    return `${map[kind] || kind}${actor.id ? ` · ${actor.id}` : ''}`;
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    try {
      if (ctx.format && typeof ctx.format.datetime === 'function') return ctx.format.datetime(iso);
    } catch {
      /* fallthrough */
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function renderTagEditor(disabled) {
    const host = el('div', { class: 'view-editor__chips', 'data-testid': 'editor-tags' });
    for (const tag of state.draft.tags) {
      host.append(el('span', { class: 'view-editor__chip' }, [
        el('span', { text: tag.name || tag.id }),
        el('button', {
          type: 'button',
          class: 'view-editor__chip-remove',
          'aria-label': `移除标签 ${tag.name || tag.id}`,
          disabled,
          on: { click: () => { state.draft.tags = state.draft.tags.filter((t) => t !== tag); updateDraft('tags', state.draft.tags, true); } },
        }, ['×']),
      ]));
    }
    const input = textInput({
      placeholder: '输入标签后按 Enter',
      testid: 'editor-tags-input',
      disabled,
      onInput: () => { renderTagSuggestions(); },
    });
    const onKey = (event) => {
      if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
        event.preventDefault();
        addTag(input.value);
        input.value = '';
        renderTagSuggestions();
      }
    };
    input.addEventListener('keydown', onKey);
    host.append(input);
    const suggestions = el('div', { class: 'view-editor__suggestions' });
    input._suggestionsHost = suggestions;
    host.append(suggestions);
    // 挂载后异步加载标签建议（若 Runtime /state 提供；否则优雅降级为自由输入）
    setTimeout(() => loadTagSuggestions().then((tags) => { input._knownTags = tags; renderTagSuggestions(); }), 0);
    return host;
  }

  let knownTags = null;
  let knownTagsLoading = false;

  async function loadTagSuggestions() {
    if (knownTags || knownTagsLoading) return knownTags;
    knownTagsLoading = true;
    try {
      const res = await api.getState();
      const arr = findTagArray(res);
      if (arr) {
        knownTags = arr.map((t) => (typeof t === 'string' ? { name: t } : { id: t.id, name: t.name || t.label || t.id })).filter((t) => t.name);
      } else {
        knownTags = null; // Runtime 未提供标签目录 → 自由输入
      }
    } catch {
      knownTags = null;
    } finally {
      knownTagsLoading = false;
    }
    return knownTags;
  }

  function findTagArray(res) {
    if (!res || typeof res !== 'object') return null;
    const candidates = [res.tags, res.tag_list, res.state && res.state.tags, res.data && res.data.tags];
    for (const c of candidates) if (Array.isArray(c)) return c;
    return null;
  }

  function renderTagSuggestions() {
    const host = dom.formHost && dom.formHost.querySelector('[data-testid="editor-tags"]');
    if (!host) return;
    const input = host.querySelector('[data-testid="editor-tags-input"]');
    const suggestionHost = host.querySelector('.view-editor__suggestions');
    if (!input || !suggestionHost) return;
    suggestionHost.textContent = '';
    const query = String(input.value || '').trim().toLowerCase();
    const existing = new Set(state.draft.tags.map((t) => (t.name || '').toLowerCase()));
    const list = (knownTags || []).filter((t) => !existing.has((t.name || '').toLowerCase()));
    if (!list.length) return;
    const matches = query ? list.filter((t) => (t.name || '').toLowerCase().includes(query)) : list.slice(0, 8);
    for (const tag of matches.slice(0, 8)) {
      suggestionHost.append(el('button', {
        type: 'button',
        class: 'view-editor__suggestion',
        text: tag.name,
        on: { click: () => { addTag(tag.name, tag.id); input.value = ''; renderTagSuggestions(); } },
      }));
    }
  }

  function addTag(raw, id) {
    const name = String(raw || '').trim().replace(/^#/, '');
    if (!name && !id) return;
    const exists = state.draft.tags.some((t) => (t.id && t.id === id) || (t.name || '').toLowerCase() === name.toLowerCase());
    if (exists) {
      notify('warn', `标签已存在：${name}`);
      return;
    }
    if (state.draft.tags.length >= MAX_TAGS) {
      notify('warn', `标签最多 ${MAX_TAGS} 个`);
      return;
    }
    state.draft.tags = [...state.draft.tags, id ? { id, name: name || id } : { name }];
    updateDraft('tags', state.draft.tags, true);
  }

  function renderParticipantsEditor(disabled) {
    const host = el('div', { class: 'view-editor__participants', 'data-testid': 'editor-participants' });
    const list = el('div', { class: 'view-editor__chips' });
    for (const p of state.draft.participants) {
      list.append(el('span', { class: 'view-editor__chip view-editor__chip--person' }, [
        el('span', { text: `${p.name || p.entity_id}${p.role && p.role !== 'participant' ? `（${p.role}）` : ''}` }),
        el('button', {
          type: 'button',
          class: 'view-editor__chip-remove',
          'aria-label': `移除参与人物 ${p.name || p.entity_id}`,
          disabled,
          on: {
            click: () => {
              state.draft.participants = state.draft.participants.filter((x) => x !== p);
              updateDraft('participants', state.draft.participants, true);
            },
          },
        }, ['×']),
      ]));
    }
    host.append(list);

    const personInput = textInput({ placeholder: '搜索人物实体或输入姓名', testid: 'editor-participants-input', disabled });
    const roleInput = textInput({ value: 'participant', placeholder: '角色（默认 participant）', testid: 'editor-participant-role', disabled });
    const dropdown = el('div', { class: 'view-editor__suggestions view-editor__suggestions--floating' });
    const addBtn = button({
      label: '添加',
      icon: 'plus',
      size: 'sm',
      disabled,
      testid: 'editor-participants-add',
      onClick: () => {
        addParticipant({ name: personInput.value.trim() }, roleInput.value.trim());
        personInput.value = '';
        renderSuggestions(dropdown, []);
      },
    });
    const row = el('div', { class: 'view-editor__inline-row' }, [personInput, roleInput, addBtn]);
    host.append(row, dropdown);

    let timer = null;
    let selected = null;
    const search = async () => {
      const q = personInput.value.trim();
      selected = null;
      if (!q) {
        renderSuggestions(dropdown, []);
        return;
      }
      try {
        const res = await api.listEntities({ kind: 'person', q, limit: 8 });
        const items = normalizeItems(res);
        const existingIds = new Set(state.draft.participants.map((p) => p.entity_id).filter(Boolean));
        renderSuggestions(dropdown, items.filter((it) => !existingIds.has(it.id)), {
          onPick: (entity) => {
            selected = entity;
            personInput.value = entity.name || entity.id;
            renderSuggestions(dropdown, []);
          },
          onCreate: async () => {
            try {
              const entity = await api.createEntity({ kind: 'person', name: q });
              addParticipant({ entity_id: entity.id, name: entity.name || q }, roleInput.value.trim());
              personInput.value = '';
              renderSuggestions(dropdown, []);
            } catch (err) {
              notify('error', errInfo(err).message);
            }
          },
          createLabel: q,
        });
      } catch (err) {
        renderSuggestions(dropdown, [], { error: errInfo(err).message });
      }
    };
    personInput.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(search, 220);
    });
    personInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (selected) addParticipant({ entity_id: selected.id, name: selected.name || selected.id }, roleInput.value.trim());
        else addParticipant({ name: personInput.value.trim() }, roleInput.value.trim());
        personInput.value = '';
        selected = null;
        renderSuggestions(dropdown, []);
      }
    });
    return host;
  }

  function addParticipant(person, role) {
    const name = String(person.name || '').trim();
    if (!person.entity_id && !name) {
      notify('warn', '请输入人物姓名或选择实体');
      return;
    }
    if (state.draft.participants.length >= MAX_PARTICIPANTS) {
      notify('warn', `参与人物最多 ${MAX_PARTICIPANTS} 个`);
      return;
    }
    const dup = state.draft.participants.some((p) => (person.entity_id && p.entity_id === person.entity_id) || (!person.entity_id && !p.entity_id && p.name === name));
    if (dup) {
      notify('warn', `人物已添加：${name || person.entity_id}`);
      return;
    }
    state.draft.participants = [...state.draft.participants, { ...person, role: role || 'participant' }];
    updateDraft('participants', state.draft.participants, true);
  }

  function renderProjectEditor(disabled) {
    const host = el('div', { class: 'view-editor__participants', 'data-testid': 'editor-project' });
    const current = el('div', { class: 'view-editor__chips' });
    if (state.draft.project) {
      current.append(el('span', { class: 'view-editor__chip view-editor__chip--project' }, [
        el('span', { text: state.draft.project.name || state.draft.project.entity_id }),
        el('button', {
          type: 'button',
          class: 'view-editor__chip-remove',
          'aria-label': '移除项目',
          disabled,
          on: { click: () => updateDraft('project', null, true) },
        }, ['×']),
      ]));
    } else {
      current.append(el('span', { class: 'view-editor__muted', text: '未关联项目' }));
    }
    host.append(current);
    const input = textInput({ placeholder: '搜索项目实体或输入项目名', testid: 'editor-project-input', disabled });
    const dropdown = el('div', { class: 'view-editor__suggestions view-editor__suggestions--floating' });
    const addBtn = button({
      label: '设置项目',
      icon: 'plus',
      size: 'sm',
      disabled,
      onClick: () => {
        const name = input.value.trim();
        if (!name) return;
        updateDraft('project', { name }, true);
        input.value = '';
        renderSuggestions(dropdown, []);
      },
    });
    host.append(el('div', { class: 'view-editor__inline-row' }, [input, addBtn]), dropdown);
    let timer = null;
    const search = async () => {
      const q = input.value.trim();
      if (!q) {
        renderSuggestions(dropdown, []);
        return;
      }
      try {
        const res = await api.listEntities({ kind: 'project', q, limit: 8 });
        renderSuggestions(dropdown, normalizeItems(res), {
          onPick: (entity) => {
            updateDraft('project', { entity_id: entity.id, name: entity.name || entity.id }, true);
            input.value = '';
            renderSuggestions(dropdown, []);
          },
          onCreate: async () => {
            try {
              const entity = await api.createEntity({ kind: 'project', name: q });
              updateDraft('project', { entity_id: entity.id, name: entity.name || q }, true);
              input.value = '';
              renderSuggestions(dropdown, []);
            } catch (err) {
              notify('error', errInfo(err).message);
            }
          },
          createLabel: q,
        });
      } catch (err) {
        renderSuggestions(dropdown, [], { error: errInfo(err).message });
      }
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(search, 220);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const name = input.value.trim();
        if (name) updateDraft('project', { name }, true);
        input.value = '';
        renderSuggestions(dropdown, []);
      }
    });
    return host;
  }

  function renderSuggestions(host, items, opts = {}) {
    if (!host) return;
    host.textContent = '';
    if (opts.error) {
      host.append(el('div', { class: 'view-editor__suggestion-error', text: `实体查询失败：${opts.error}` }));
      return;
    }
    for (const item of items) {
      host.append(el('button', {
        type: 'button',
        class: 'view-editor__suggestion',
        on: { click: () => opts.onPick && opts.onPick(item) },
      }, [
        el('span', { text: item.name || item.id }),
        el('span', { class: 'view-editor__suggestion-meta', text: [item.kind, item.id ? item.id.slice(0, 12) : ''].filter(Boolean).join(' · ') }),
      ]));
    }
    if (opts.onCreate && opts.createLabel) {
      host.append(el('button', {
        type: 'button',
        class: 'view-editor__suggestion view-editor__suggestion--create',
        on: { click: () => opts.onCreate() },
      }, [`＋ 新建实体「${opts.createLabel}」`]));
    }
    if (!items.length && !opts.onCreate && !opts.error) host.textContent = '';
  }

  function renderEmotionEditor(disabled) {
    if (!state.draft.emotion) {
      return el('div', { class: 'view-editor__muted', text: '未记录情绪。勾选上方开关后可记录效价/唤醒度/标签。' });
    }
    const emotion = state.draft.emotion;
    const readOnly = disabled;
    return el('div', { class: 'view-editor__grid-fields' }, [
      field('效价 valence（-1 消极 → 1 积极）', slope(emotion.valence, -1, 1, 0.01, (v) => updateDraft('emotion', { ...state.draft.emotion, valence: v }), 'editor-emotion-valence'), { error: state.errors.emotion }),
      field('唤醒度 arousal（0 平静 → 1 激动）', slope(emotion.arousal, 0, 1, 0.01, (v) => updateDraft('emotion', { ...state.draft.emotion, arousal: v }), 'editor-emotion-arousal')),
      field('情绪标签', textInput({ value: emotion.label, placeholder: '例如：平静、焦虑、希望', testid: 'editor-emotion-label', disabled: readOnly, onInput: (v) => updateDraft('emotion', { ...state.draft.emotion, label: v }) })),
    ]);
  }

  function updateDraft(field, value, rerender) {
    state.draft[field] = value;
    delete state.errors[field];
    if (rerender) {
      renderForm();
      renderHeaderRefresh();
      setStatus();
    } else {
      renderHeaderRefresh();
      setStatus();
      // 同步错误提示：字段错误存在时就地清除
      if (state.errorOrder.includes(field)) renderForm();
    }
  }

  function renderHeaderRefresh() {
    const titleHost = root && root.querySelector('[data-testid="editor-heading"]');
    if (titleHost && state.mode === 'edit' && state.memory) titleHost.textContent = state.memory.title || '未命名记忆';
    // 未保存标记
    const active = root && root.querySelector('[data-testid="editor-dirty"]');
    if (isDirty() && !active) {
      const meta = root && root.querySelector('.view-editor__heading-meta');
      if (meta) meta.append(badge('未保存', 'gold', 'editor-dirty'));
    } else if (!isDirty() && active) {
      active.remove();
    }
  }

  function setStatus() {
    try {
      if (!ctx.status) return;
      if (state.mode === 'edit' && state.memory) {
        const dirty = isDirty();
        ctx.status.set('editor.state', {
          label: dirty ? `未保存 · v${state.memory.version ?? '?'}` : `已保存 · v${state.memory.version ?? '?'}`,
          tone: dirty ? 'warn' : 'ok',
          title: state.memory.id,
        });
      } else if (state.mode === 'new') {
        ctx.status.set('editor.state', { label: isDirty() ? '新建 · 未保存' : '新建记忆', tone: isDirty() ? 'warn' : 'idle' });
      }
    } catch {
      /* 状态栏扩展失败不影响主流程 */
    }
  }

  function togglePreview() {
    state.preview = !state.preview;
    writeLocal(PREVIEW_KEY, state.preview ? '1' : '0');
    render();
    setStatus();
  }

  function renderAside() {
    if (!dom.asideHost) return;
    dom.asideHost.textContent = '';
    const tabs = el('div', { class: 'view-editor__tabs', role: 'tablist' });
    for (const tab of [
      { id: 'versions', label: `版本历史${state.versions.length ? `（${state.versions.length}）` : ''}` },
      { id: 'relations', label: `关系${state.relations.length ? `（${state.relations.length}）` : ''}` },
      { id: 'help', label: '说明' },
    ]) {
      tabs.append(el('button', {
        type: 'button',
        class: `view-editor__tab${state.asideTab === tab.id ? ' is-active' : ''}`,
        role: 'tab',
        'aria-selected': String(state.asideTab === tab.id),
        text: tab.label,
        on: {
          click: () => {
            state.asideTab = tab.id;
            writeLocal(ASIDE_KEY, tab.id);
            renderAside();
          },
        },
      }));
    }
    dom.asideHost.append(tabs);
    const panel = el('div', { class: 'view-editor__tabpanel fca-scroll' });
    dom.asideHost.append(panel);
    if (state.asideTab === 'versions') renderVersions(panel);
    else if (state.asideTab === 'relations') renderRelations(panel);
    else renderHelp(panel);
  }

  function renderVersions(host) {
    const target = host || (dom.asideHost && dom.asideHost.querySelector('.view-editor__tabpanel'));
    if (!target) return;
    target.textContent = '';
    if (state.mode !== 'edit') {
      target.append(el('div', { class: 'view-editor__aside-empty', text: '新建记忆保存后才会产生版本历史。' }));
      return;
    }
    if (state.versionsLoading) {
      target.append(el('div', { class: 'view-editor__aside-empty', text: '正在读取版本历史…' }));
      return;
    }
    if (state.versionsError) {
      target.append(errorBox('版本历史读取失败', `${state.versionsError.message}${state.versionsError.traceId ? ` · ${state.versionsError.traceId}` : ''}`, () => loadVersions(state.memoryId)));
      return;
    }
    if (!state.versions.length) {
      target.append(el('div', { class: 'view-editor__aside-empty', text: '暂无版本记录（Runtime 未返回版本历史）。' }));
      return;
    }
    const toolbar = el('div', { class: 'view-editor__aside-toolbar' }, [
      el('span', { class: 'view-editor__muted', text: `共 ${state.versions.length} 个版本 · 勾选两个版本比较` }),
      button({
        label: '比较选中',
        icon: 'history',
        size: 'sm',
        variant: 'secondary',
        testid: 'editor-diff-btn',
        disabled: state.diffSelection.length !== 2,
        onClick: () => openDiff(),
      }),
    ]);
    target.append(toolbar);
    const list = el('div', { class: 'view-editor__versions', 'data-testid': 'editor-versions' });
    for (const version of state.versions) {
      const versionNo = version.version;
      const selected = state.diffSelection.includes(versionNo);
      const row = el('div', {
        class: `view-editor__version-row${selected ? ' is-selected' : ''}`,
        'data-testid': `editor-version-${versionNo}`,
        on: {
          click: () => {
            state.diffSelection = toggleVersionSelection(versionNo);
            renderAside();
          },
        },
      }, [
        el('span', { class: 'view-editor__version-no', text: `v${versionNo}` }),
        el('span', { class: `view-editor__badge view-editor__badge--${versionTone(version.change_kind)}`, text: CHANGE_KIND_LABEL[version.change_kind] || version.change_kind || '—' }),
        el('span', { class: 'view-editor__version-time', text: formatDateTime(version.created_at) }),
        el('span', { class: 'view-editor__version-actor', text: actorText(version.actor) }),
      ]);
      if (version.version === (state.memory && state.memory.version)) row.classList.add('is-current');
      list.append(row);
      if (selected && state.diffResult) list.append(renderDiffBlock(versionNo));
    }
    target.append(list);

    if (state.diffResult) {
      target.append(renderDiffPanel());
    }

    const actions = el('div', { class: 'view-editor__aside-actions' }, [
      button({
        label: '载入选中版本到编辑器',
        icon: 'history',
        size: 'sm',
        disabled: state.diffSelection.length !== 1,
        onClick: () => loadSelectedVersion(),
      }),
      button({ label: '刷新历史', icon: 'refresh', size: 'sm', variant: 'ghost', onClick: () => loadVersions(state.memoryId) }),
    ]);
    target.append(actions);
  }

  function versionTone(kind) {
    return { create: 'green', update: 'cyan', merge: 'violet', split: 'gold', restore: 'green', delete: 'rose', import: 'blue' }[kind] || 'neutral';
  }

  function toggleVersionSelection(versionNo) {
    const current = state.diffSelection.slice();
    const index = current.indexOf(versionNo);
    if (index >= 0) current.splice(index, 1);
    else {
      current.push(versionNo);
      while (current.length > 2) current.shift();
    }
    current.sort((a, b) => a - b);
    state.diffResult = null;
    return current;
  }

  async function openDiff() {
    if (state.diffSelection.length !== 2) return;
    const from = state.diffSelection[0];
    const to = state.diffSelection[1];
    try {
      const patch = await fetchDiff(state.memoryId, from, to);
      const fromVersion = state.versions.find((v) => v.version === from);
      const toVersion = state.versions.find((v) => v.version === to);
      const fromBody = snapshotBody(fromVersion);
      const toBody = snapshotBody(toVersion);
      state.diffResult = {
        from,
        to,
        patch,
        rows: summarizeJsonPatch(patch),
        bodyRows: diffLines(fromBody, toBody),
        fromMeta: fromVersion,
        toMeta: toVersion,
      };
      renderAside();
    } catch (err) {
      notify('error', `读取版本差异失败：${errInfo(err).message}`);
    }
  }

  function snapshotBody(version) {
    if (!version) return '';
    const snapshot = version.snapshot || {};
    return snapshot.body || '';
  }

  function renderDiffBlock(versionNo) {
    return el('div', { class: 'view-editor__diff-inline' }, [
      button({
        label: `载入 v${versionNo} 到编辑器`,
        size: 'sm',
        variant: 'ghost',
        onClick: (event) => {
          event.stopPropagation();
          loadVersion(versionNo);
        },
      }),
    ]);
  }

  function renderDiffPanel() {
    const result = state.diffResult;
    if (!result) return null;
    const panel = el('div', { class: 'view-editor__diff', 'data-testid': 'editor-diff' });
    panel.append(el('div', { class: 'view-editor__diff-head' }, [
      el('strong', { text: `v${result.from} → v${result.to} 差异` }),
      el('span', { class: 'view-editor__muted', text: `字段变更 ${result.rows.length} 处 · 正文 ${result.bodyRows.filter((r) => r.type !== 'context').length} 行变化` }),
      button({ label: '关闭', size: 'sm', variant: 'ghost', onClick: () => { state.diffResult = null; renderAside(); } }),
    ]));
    if (result.rows.length) {
      const table = el('div', { class: 'view-editor__diff-fields' });
      for (const row of result.rows) {
        const opLabel = { add: '新增', remove: '删除', replace: '替换', move: '移动', copy: '复制', test: '测试' }[row.op] || row.op;
        table.append(el('div', { class: `view-editor__diff-row view-editor__diff-row--${row.op}` }, [
          el('span', { class: 'view-editor__badge view-editor__badge--cyan', text: opLabel }),
          el('span', { class: 'view-editor__diff-label', text: row.label }),
          el('span', { class: 'view-editor__diff-value', text: row.value || '—' }),
        ]));
      }
      panel.append(table);
    } else {
      panel.append(el('div', { class: 'view-editor__aside-empty', text: '字段无差异（仅正文或元数据变化）。' }));
    }
    if (result.bodyRows.length) {
      const code = el('div', { class: 'view-editor__diff-code', 'data-testid': 'editor-diff-body' });
      let changed = 0;
      for (const row of result.bodyRows) {
        if (row.type !== 'context') changed += 1;
        if (row.type === 'context' && changed > 200 && result.bodyRows.length > 400) {
          code.append(el('div', { class: 'view-editor__diff-line view-editor__diff-line--context', text: '…（上下文行已折叠）' }));
          break;
        }
        code.append(el('div', { class: `view-editor__diff-line view-editor__diff-line--${row.type}` }, [
          el('span', { class: 'view-editor__diff-gutter', text: row.type === 'del' ? `-${row.oldLine ?? ''}` : row.type === 'add' ? `+${row.newLine ?? ''}` : String(row.oldLine ?? '') }),
          el('span', { class: 'view-editor__diff-text', text: row.text === '' ? ' ' : row.text }),
        ]));
      }
      panel.append(el('div', { class: 'view-editor__diff-subtitle', text: '正文行级差异' }), code);
    }
    return panel;
  }

  async function loadSelectedVersion() {
    if (state.diffSelection.length !== 1) return;
    await loadVersion(state.diffSelection[0]);
  }

  async function loadVersion(versionNo) {
    try {
      const { memory } = await fetchMemoryWithVersion(state.memoryId, versionNo);
      const draft = memoryToDraft(memory);
      state.draft = draft;
      render();
      renderAside();
      notify('info', `已载入 v${versionNo} 内容到编辑器（保存后产生新版本）`);
    } catch (err) {
      notify('error', `载入版本失败：${errInfo(err).message}`);
    }
  }

  async function fetchMemoryWithVersion(id, version) {
    const res = await api.getMemory(id, { version });
    const memory = (res && res.memory) || res;
    if (!memory || !memory.id) throw new Error('Runtime 未返回该版本快照');
    return { memory };
  }

  function renderRelations(host) {
    const target = host || (dom.asideHost && dom.asideHost.querySelector('.view-editor__tabpanel'));
    if (!target) return;
    target.textContent = '';
    if (state.mode !== 'edit') {
      target.append(el('div', { class: 'view-editor__aside-empty', text: '新建记忆保存后才会产生关系。' }));
      return;
    }
    if (state.relationsLoading) {
      target.append(el('div', { class: 'view-editor__aside-empty', text: '正在读取关系…' }));
      return;
    }
    if (state.relationsError) {
      target.append(errorBox('关系读取失败', state.relationsError.message, () => loadRelations(state.memoryId)));
      return;
    }
    if (!state.relations.length) {
      target.append(el('div', { class: 'view-editor__aside-empty', text: '该记忆当前没有关系。可在「关系」视图创建。' }));
    } else {
      const list = el('div', { class: 'view-editor__relations' });
      for (const rel of state.relations) {
        const other = otherNode(rel, 'memory', state.memoryId);
        list.append(el('div', { class: 'view-editor__relation-row' }, [
          el('span', { class: 'view-editor__badge view-editor__badge--cyan', text: rel.relation_type || '—' }),
          el('span', { class: 'view-editor__relation-target', text: other ? `${other.kind === 'entity' ? '实体' : '记忆'} ${shortId(other.id)}` : '—' }),
          el('span', { class: 'view-editor__muted', text: rel.label || '' }),
        ]));
      }
      target.append(list);
    }
    target.append(el('div', { class: 'view-editor__aside-actions' }, [
      button({
        label: '在关系视图中编辑',
        icon: 'relation',
        size: 'sm',
        onClick: () => navigate('relations', { node_id: state.memoryId, node_kind: 'memory' }),
      }),
      button({ label: '刷新', icon: 'refresh', size: 'sm', variant: 'ghost', onClick: () => loadRelations(state.memoryId) }),
    ]));
  }

  function otherNode(rel, kind, selfId) {
    const from = rel.from || {};
    const to = rel.to || {};
    if (from.kind === kind && from.id === selfId) return to;
    if (to.kind === kind && to.id === selfId) return from;
    return null;
  }

  function shortId(id) {
    if (!id) return '—';
    const parts = String(id).split('_');
    return parts.length > 1 ? `${parts[0]}_${parts[1].slice(0, 6)}…` : String(id).slice(0, 10);
  }

  function renderHelp(host) {
    host.append(el('div', { class: 'view-editor__help' }, [
      el('p', { text: '快捷键：Ctrl+S 保存；上方「预览正文」切换 Markdown 预览。' }),
      el('p', { text: '冲突处理：保存时若 Runtime 中版本已前进，会显示冲突横幅，可选择加载最新或覆盖保存。' }),
      el('p', { text: '版本历史：勾选两个版本后点「比较选中」查看字段与正文差异；「载入选中版本到编辑器」只在本地填充，保存后才产生新版本。' }),
      el('p', { text: '合并/拆分：调用 Runtime 的 merge/split API，操作前会要求确认。' }),
      el('p', { class: 'view-editor__muted', text: '所有修改经 Runtime API 持久化；未保存内容不会出现在星图与列表中。' }),
    ]));
  }

  /* ------------------------------- 操作 ------------------------------- */

  async function save() {
    if (state.saving) return;
    if (state.memory && state.memory.deleted_at) {
      notify('warn', '回收站中的记忆不能编辑，请先恢复');
      return;
    }
    const validation = validateMemoryDraft(state.draft);
    state.errors = validation.errors;
    state.errorOrder = validation.order;
    state.saveError = null;
    if (!validation.ok) {
      renderForm();
      const first = validation.order[0];
      notify('error', `请修正表单：${validation.errors[first]}`);
      const input = root.querySelector(`[data-testid="editor-${first.replace(/_/g, '-')}"]`);
      if (input && typeof input.focus === 'function') input.focus();
      return;
    }
    state.saving = true;
    render();
    try {
      const payload = buildSavePayload(state.draft);
      let saved;
      if (state.mode === 'edit' && state.memoryId) {
        saved = await api.patchMemory(state.memoryId, { ...payload, expected_version: state.memory.version });
      } else {
        saved = await api.storeMemory(payload);
      }
      const memory = normalizeSaved(saved);
      if (!memory || !memory.id) {
        // Runtime 可能只返回 {id}；用 GET 补齐完整对象
        const refreshed = await fetchMemory(memory && memory.id ? memory.id : state.memoryId);
        commitSaved(refreshed.memory);
      } else {
        commitSaved(memory);
      }
      notify('success', state.mode === 'new' ? '记忆已创建并写入 Runtime' : '记忆已保存');
    } catch (err) {
      const info = errInfo(err);
      if (info.code === 'VERSION_CONFLICT') {
        const currentVersion = (err && err.details && (err.details.current_version || err.details.currentVersion)) || null;
        state.conflict = { currentVersion, details: err && err.details };
        state.saving = false;
        render();
        notify('warn', '保存冲突：该记忆已被其他客户端修改');
        return;
      }
      state.saveError = info;
      state.saving = false;
      render();
      notify('error', `保存失败：${info.message}`);
      return;
    }
    state.saving = false;
    render();
    setStatus();
  }

  function normalizeSaved(response) {
    if (!response || typeof response !== 'object') return null;
    if (response.memory && typeof response.memory === 'object') return response.memory;
    if (response.id && (response.title !== undefined || response.version !== undefined)) return response;
    return null;
  }

  function commitSaved(memory) {
    state.memory = memory;
    state.mode = 'edit';
    state.memoryId = memory.id;
    state.draft = memoryToDraft(memory);
    state.baseline = memoryToDraft(memory);
    state.errors = {};
    state.errorOrder = [];
    state.conflict = null;
    state.saveError = null;
    state.draftBanner = null;
    clearDraft();
    loadVersions(memory.id);
    loadRelations(memory.id);
    const params = getParams();
    const currentId = params.get ? params.get('id') : null;
    if (currentId !== memory.id) {
      try {
        if (ctx.router && typeof ctx.router.navigate === 'function') ctx.router.navigate('editor', { id: memory.id });
        else window.location.hash = `view=editor&id=${encodeURIComponent(memory.id)}`;
      } catch {
        /* 导航失败不阻塞保存结果 */
      }
    }
  }

  async function resolveConflict(choice) {
    if (!state.conflict) return;
    if (choice === 'reload') {
      state.conflict = null;
      await loadMemory(state.memoryId);
      notify('info', '已加载 Runtime 中最新的记忆版本');
      return;
    }
    // 覆盖：取最新版本号后，用本地内容重写（仍保留乐观并发保护）
    state.saving = true;
    render();
    try {
      const { memory } = await fetchMemory(state.memoryId);
      if (memory.deleted_at) {
        state.conflict = null;
        state.saving = false;
        await loadMemory(state.memoryId);
        notify('warn', '该记忆已被其他客户端删除，无法覆盖保存');
        return;
      }
      const payload = buildSavePayload(state.draft);
      const saved = await api.patchMemory(state.memoryId, { ...payload, expected_version: memory.version });
      const savedMemory = normalizeSaved(saved) || memory;
      state.saving = false;
      state.conflict = null;
      commitSaved({ ...savedMemory, id: state.memoryId, version: savedMemory.version ?? memory.version + 1 });
      notify('success', `已覆盖保存（基于 Runtime v${memory.version} 之后的最新状态）`);
      render();
    } catch (err) {
      state.saving = false;
      const info = errInfo(err);
      if (info.code === 'VERSION_CONFLICT') {
        state.conflict = { currentVersion: (err && err.details && err.details.current_version) || null };
        render();
        notify('warn', '再次发生版本冲突，请重试');
        return;
      }
      state.conflict = null;
      state.saveError = info;
      render();
      notify('error', `覆盖保存失败：${info.message}`);
    }
  }

  async function softDelete() {
    if (!state.memoryId) return;
    const mem = state.memory;
    let ok = false;
    try {
      if (ctx.dialogs && typeof ctx.dialogs.confirm === 'function') {
        ok = await ctx.dialogs.confirm({
          title: '移入回收站？',
          message: `将软删除记忆「${mem ? mem.title : state.memoryId}」。历史与关系保留，可在回收站恢复。`,
          confirmLabel: '移入回收站',
          danger: true,
        });
      } else {
        ok = window.confirm('移入回收站（软删除）？历史与关系保留，可在回收站恢复。');
      }
    } catch {
      ok = false;
    }
    if (!ok) return;
    try {
      await api.deleteMemory(state.memoryId, {});
      notify('success', '已移入回收站（软删除）');
      await loadMemory(state.memoryId, { keepVersions: true });
    } catch (err) {
      notify('error', `删除失败：${errInfo(err).message}`);
    }
  }

  async function restoreMemory() {
    if (!state.memoryId) return;
    try {
      await api.restoreMemory(state.memoryId);
      notify('success', '记忆已从回收站恢复');
      await loadMemory(state.memoryId, { keepVersions: true });
    } catch (err) {
      notify('error', `恢复失败：${errInfo(err).message}`);
    }
  }

  function openMergeDialog() {
    const searchInput = textInput({ placeholder: '搜索要合并进来的重复记忆…', testid: 'editor-merge-search' });
    const resultsHost = el('div', { class: 'view-editor__dialog-results', 'data-testid': 'editor-merge-results' });
    const strategy = selectInput(
      [{ value: 'keep_target', label: '保留目标正文（source 作为历史）' }, { value: 'prepend_sources', label: '把 source 正文前置到目标正文' }],
      'keep_target',
      () => {},
    );
    const selected = new Map();
    const runSearch = async () => {
      const q = searchInput.value.trim();
      if (!q) return;
      resultsHost.textContent = '';
      resultsHost.append(el('div', { class: 'view-editor__muted', text: '搜索中…' }));
      try {
        const res = await api.searchMemory({ query: q, mode: 'fulltext', limit: 10 });
        const items = normalizeItems(res);
        resultsHost.textContent = '';
        if (!items.length) {
          resultsHost.append(el('div', { class: 'view-editor__muted', text: '没有匹配的记忆' }));
          return;
        }
        for (const item of items) {
          const memory = item.memory || item;
          if (!memory || memory.id === state.memoryId) continue;
          const row = el('label', { class: 'view-editor__dialog-row' }, [
            el('input', {
              type: 'checkbox',
              on: {
                change: (event) => {
                  if (event.target.checked) selected.set(memory.id, memory);
                  else selected.delete(memory.id);
                },
              },
            }),
            el('span', { class: 'view-editor__dialog-row-main' }, [
              el('span', { text: memory.title || memory.id }),
              el('span', { class: 'view-editor__muted', text: `${typeLabel(memory.memory_type)} · v${memory.version ?? '?'}` }),
            ]),
          ]);
          resultsHost.append(row);
        }
        if (!resultsHost.children.length) resultsHost.append(el('div', { class: 'view-editor__muted', text: '没有可合并的其它记忆' }));
      } catch (err) {
        resultsHost.textContent = '';
        resultsHost.append(el('div', { class: 'view-editor__error', text: `搜索失败：${errInfo(err).message}` }));
      }
    };
    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') runSearch();
    });
    const content = el('div', { class: 'view-editor__dialog' }, [
      el('p', { class: 'view-editor__muted', text: `合并会调用 Runtime merge API：把选中的重复记忆合并进当前记忆「${state.draft.title || state.memoryId}」。来源记忆将软删除，历史保留。` }),
      el('div', { class: 'view-editor__inline-row' }, [searchInput, button({ label: '搜索', icon: 'search', size: 'sm', onClick: runSearch })]),
      resultsHost,
      field('合并策略', strategy),
    ]);
    openDialog({
      title: '合并重复记忆',
      subtitle: '确认前不会写入任何数据',
      content,
      width: 620,
      actions: [
        { label: '取消', variant: 'ghost', closeOnClick: true },
        {
          label: '确认合并',
          variant: 'danger',
          onClick: async (close, helpers) => {
            const sourceIds = Array.from(selected.keys());
            if (!sourceIds.length) {
              notify('warn', '请先勾选要合并的重复记忆');
              return;
            }
            if (typeof helpers?.setBusy === 'function') helpers.setBusy(true);
            try {
              await api.mergeMemories(state.memoryId, { source_ids: sourceIds, target_id: state.memoryId, strategy: strategy.value });
              close();
              notify('success', `已合并 ${sourceIds.length} 条记忆`);
              await loadMemory(state.memoryId);
            } catch (err) {
              notify('error', `合并失败：${errInfo(err).message}`);
              if (typeof helpers?.setBusy === 'function') helpers.setBusy(false);
            }
          },
        },
      ],
    });
  }

  function openSplitDialog() {
    const rows = [];
    const rowsHost = el('div', { class: 'view-editor__split-rows', 'data-testid': 'editor-split-rows' });
    const addRow = (init) => {
      const body = textArea({ value: init.body || '', rows: 4, placeholder: '这一部分的正文', testid: `editor-split-body-${rows.length}` });
      const title = textInput({ value: init.title || '', placeholder: '部分标题（必填）', testid: `editor-split-title-${rows.length}` });
      const type = selectInput(MEMORY_TYPES, init.memory_type || state.draft.memory_type, () => {}, { ariaLabel: '部分记忆类型' });
      const rowEl = el('div', { class: 'view-editor__split-row' }, [
        title,
        el('div', { class: 'view-editor__inline-row' }, [type, el('span', { class: 'view-editor__muted', text: `第 ${rows.length + 1} 部分` })]),
        body,
      ]);
      const record = { el: rowEl, title, body, type };
      rows.push(record);
      rowsHost.append(rowEl);
    };
    // 初始：把当前正文按空行切成两段
    const chunks = String(state.draft.body || '').split(/\n{2,}/).filter((c) => c.trim());
    if (chunks.length >= 2) {
      addRow({ title: state.draft.title ? `${state.draft.title}（1）` : '', body: chunks[0] });
      addRow({ title: state.draft.title ? `${state.draft.title}（2）` : '', body: chunks.slice(1).join('\n\n') });
    } else {
      addRow({ title: state.draft.title ? `${state.draft.title}（1）` : '', body: state.draft.body });
      addRow({ title: '', body: '' });
    }
    const content = el('div', { class: 'view-editor__dialog' }, [
      el('p', { class: 'view-editor__muted', text: '拆分将调用 Runtime split API：当前记忆保留为第一部分，其余部分创建为新记忆。请至少填写两个部分。' }),
      rowsHost,
      button({ label: '＋ 增加部分', size: 'sm', variant: 'ghost', onClick: () => addRow({}) }),
    ]);
    openDialog({
      title: '拆分记忆',
      subtitle: `当前：${state.draft.title || state.memoryId}`,
      content,
      width: 680,
      actions: [
        { label: '取消', variant: 'ghost', closeOnClick: true },
        {
          label: '确认拆分',
          variant: 'primary',
          onClick: async (close, helpers) => {
            const parts = rows
              .map((row) => ({
                title: row.title.value.trim(),
                body: row.body.value,
                memory_type: row.type.value,
              }))
              .filter((p) => p.title || p.body.trim());
            if (parts.length < 2) {
              notify('warn', '拆分至少需要两个非空部分');
              return;
            }
            if (parts.some((p) => !p.title)) {
              notify('warn', '每个部分都需要标题');
              return;
            }
            if (parts.some((p) => !String(p.body).trim())) {
              notify('warn', '每个部分都需要正文');
              return;
            }
            if (typeof helpers?.setBusy === 'function') helpers.setBusy(true);
            try {
              const res = await api.splitMemory(state.memoryId, { parts });
              close();
              const created = normalizeItems(res);
              notify('success', `已拆分为 ${created.length || parts.length} 条记忆`);
              if (created.length && created[0].id) navigate('editor', { id: created[0].id });
              else await loadMemory(state.memoryId);
            } catch (err) {
              notify('error', `拆分失败：${errInfo(err).message}`);
              if (typeof helpers?.setBusy === 'function') helpers.setBusy(false);
            }
          },
        },
      ],
    });
  }

  /** 通用对话框：优先 ctx.ui.dialog；不可用时退化为 window.confirm（仅两种结果）。 */
  function openDialog(opts) {
    try {
      if (typeof U.dialog === 'function') {
        const actions = (opts.actions || []).map((action) => ({
          label: action.label,
          variant: action.variant,
          closeOnClick: action.closeOnClick,
          onClick: (close) => {
            if (action.onClick) {
              const helpers = {
                setBusy: (busy) => dlg.setBusy && dlg.setBusy(busy),
              };
              return action.onClick(close, helpers);
            }
            close && close();
          },
        }));
        const dlg = U.dialog({ title: opts.title, subtitle: opts.subtitle, content: opts.content, actions, width: opts.width || 560 });
        return dlg;
      }
    } catch (err) {
      console.warn('[editor] ui.dialog 不可用，退化为原生对话框', err);
    }
    // 退化路径（仅保证不静默失败）
    const primary = (opts.actions || []).find((a) => a.onClick);
    if (primary && window.confirm(`${opts.title}\n\n${opts.subtitle || ''}\n\n继续？`)) {
      Promise.resolve(primary.onClick(() => {}, { setBusy: () => {} })).catch((err) => notify('error', errInfo(err).message));
    }
    return { close: () => {}, setBusy: () => {} };
  }

  function startNew() {
    state.mode = 'new';
    state.memory = null;
    state.memoryId = null;
    state.draft = createEmptyDraft();
    state.baseline = createEmptyDraft();
    state.errors = {};
    state.saveError = null;
    state.conflict = null;
    try {
      if (ctx.router && typeof ctx.router.navigate === 'function') ctx.router.navigate('editor', {});
      else window.location.hash = 'view=editor';
    } catch {
      /* noop */
    }
    render();
    setStatus();
    const input = root && root.querySelector('[data-testid="editor-title"]');
    if (input && typeof input.focus === 'function') input.focus();
  }

  function navigate(view, params) {
    try {
      if (ctx.router && typeof ctx.router.navigate === 'function') ctx.router.navigate(view, params || {});
      else {
        const query = params && Object.keys(params).length
          ? `&${Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
          : '';
        window.location.hash = `view=${view}${query}`;
      }
    } catch {
      /* noop */
    }
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  function unmount() {
    persistDraft();
    try {
      if (ctx.status && typeof ctx.status.remove === 'function') ctx.status.remove('editor.state');
    } catch {
      /* noop */
    }
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        /* noop */
      }
    }
    disposers.length = 0;
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    styleEl = null;
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    dom.formHost = null;
    dom.asideHost = null;
    dom.bannerHost = null;
  }

  function activate() {
    if (!root) return;
    const params = getParams();
    const id = params.get ? params.get('id') : null;
    if (id && id !== state.memoryId) {
      persistDraft();
      loadMemory(id);
    } else if (!id && state.mode === 'edit') {
      // 路由回到新建模式
      state.mode = 'new';
      state.memory = null;
      state.memoryId = null;
      state.draft = createEmptyDraft();
      state.baseline = createEmptyDraft();
      render();
    }
  }

  function deactivate() {
    setStatus();
  }

  function handleCommand(command) {
    if (command === 'view:refresh') {
      if (state.memoryId) loadMemory(state.memoryId, { keepVersions: true });
      return true;
    }
    if (command === 'editor:save') {
      save();
      return true;
    }
    return false;
  }

  function getSnapshot() {
    return { memoryId: state.memoryId, mode: state.mode, dirty: isDirty(), asideTab: state.asideTab };
  }

  return { mount, unmount, activate, deactivate, handleCommand, getSnapshot };
}

/* ============================================================================
 * 视图样式：仅使用样式令牌变量（禁止硬编码颜色）；命名空间 view-editor-*
 * ========================================================================== */

const EDITOR_CSS = `
.view-editor { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--fca-bg-1); color:var(--fca-text); font-family:var(--fca-font-ui); font-size:var(--fca-text-md); }
.view-editor__center { display:flex; flex-direction:column; align-items:center; gap:var(--fca-space-3); padding:var(--fca-space-6); }
.view-editor__center-actions { display:flex; gap:var(--fca-space-2); }
.view-editor__loading { display:flex; flex-direction:column; align-items:center; gap:var(--fca-space-3); padding:var(--fca-space-6); color:var(--fca-text-dim); }
.view-editor__spinner { width:22px;height:22px;border-radius:50%;border:2px solid var(--fca-border-strong);border-top-color:var(--fca-accent);animation:view-editor-spin .8s linear infinite; }
@keyframes view-editor-spin { to { transform:rotate(360deg); } }
.view-editor__bar { display:flex; align-items:center; justify-content:space-between; gap:var(--fca-space-3); padding:var(--fca-space-2) var(--fca-space-4); border-bottom:1px solid var(--fca-border); background:var(--fca-bg-2); flex-wrap:wrap; }
.view-editor__bar-left { display:flex; align-items:center; gap:var(--fca-space-3); min-width:0; }
.view-editor__bar-actions { display:flex; align-items:center; gap:var(--fca-space-1); flex-wrap:wrap; }
.view-editor__back { display:inline-flex; align-items:center; gap:4px; height:28px; padding:0 var(--fca-space-2); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); background:var(--fca-bg-3); color:var(--fca-text-dim); cursor:pointer; font:inherit; font-size:var(--fca-text-sm); }
.view-editor__back:hover { background:var(--fca-bg-4); color:var(--fca-text); }
.view-editor__heading { min-width:0; }
.view-editor__heading-title { font-size:var(--fca-text-lg); font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:44vw; }
.view-editor__heading-meta { display:flex; align-items:center; gap:var(--fca-space-2); margin-top:2px; flex-wrap:wrap; }
.view-editor__mono { font-family:var(--fca-font-mono); font-size:var(--fca-text-xs); color:var(--fca-text-dim); }
.view-editor__mono--dim { color:var(--fca-text-muted); }
.view-editor__muted { color:var(--fca-text-muted); font-size:var(--fca-text-sm); }
.view-editor__btn { display:inline-flex; align-items:center; gap:6px; height:28px; padding:0 var(--fca-space-3); border-radius:var(--fca-radius-sm); border:1px solid var(--fca-border); background:var(--fca-bg-3); color:var(--fca-text); font:inherit; font-size:var(--fca-text-sm); cursor:pointer; white-space:nowrap; transition:background var(--fca-dur-fast) var(--fca-ease), border-color var(--fca-dur-fast) var(--fca-ease); }
.view-editor__btn:hover { background:var(--fca-bg-4); border-color:var(--fca-border-strong); }
.view-editor__btn:disabled { opacity:.45; cursor:not-allowed; }
.view-editor__btn--primary { background:var(--fca-accent-soft); border-color:var(--fca-accent); color:var(--fca-accent-strong); }
.view-editor__btn--primary:hover { background:var(--fca-accent-soft); filter:brightness(1.15); }
.view-editor__btn--ghost { background:transparent; border-color:transparent; color:var(--fca-text-dim); }
.view-editor__btn--ghost:hover { background:var(--fca-bg-3); color:var(--fca-text); }
.view-editor__btn--danger { background:transparent; border-color:var(--fca-danger); color:var(--fca-danger); }
.view-editor__btn--danger:hover { background:color-mix(in srgb, var(--fca-danger) 14%, transparent); }
.view-editor__btn--sm { height:24px; padding:0 var(--fca-space-2); font-size:var(--fca-text-xs); }
.view-editor__btn-spinner { width:11px;height:11px;border-radius:50%;border:2px solid var(--fca-border-strong);border-top-color:var(--fca-accent);animation:view-editor-spin .8s linear infinite; }
.view-editor__banner-host { display:flex; flex-direction:column; gap:1px; }
.view-editor__notice { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--fca-space-3); padding:var(--fca-space-2) var(--fca-space-4); border-bottom:1px solid var(--fca-border); background:var(--fca-bg-2); }
.view-editor__notice--gold { background:color-mix(in srgb, var(--fca-gold) 10%, var(--fca-bg-2)); border-left:3px solid var(--fca-gold); }
.view-editor__notice--rose { background:color-mix(in srgb, var(--fca-danger) 10%, var(--fca-bg-2)); border-left:3px solid var(--fca-danger); }
.view-editor__notice--cyan { background:color-mix(in srgb, var(--fca-accent) 9%, var(--fca-bg-2)); border-left:3px solid var(--fca-accent); }
.view-editor__notice-body { min-width:0; }
.view-editor__notice-title { font-size:var(--fca-text-sm); font-weight:600; }
.view-editor__notice-detail { font-size:var(--fca-text-xs); color:var(--fca-text-dim); margin-top:2px; }
.view-editor__notice-actions { display:flex; gap:var(--fca-space-2); flex-shrink:0; flex-wrap:wrap; }
.view-editor__grid { display:grid; grid-template-columns:minmax(0,1fr) 320px; flex:1; min-height:0; }
.view-editor__form { overflow-y:auto; padding:var(--fca-space-4) var(--fca-space-5) var(--fca-space-6); min-width:0; scrollbar-width:thin; }
.view-editor__aside { border-left:1px solid var(--fca-border); background:var(--fca-bg-2); display:flex; flex-direction:column; min-height:0; }
.view-editor__tabs { display:flex; border-bottom:1px solid var(--fca-border); flex-shrink:0; }
.view-editor__tab { flex:1; padding:var(--fca-space-2) var(--fca-space-1); background:transparent; border:none; border-bottom:2px solid transparent; color:var(--fca-text-muted); font:inherit; font-size:var(--fca-text-sm); cursor:pointer; }
.view-editor__tab:hover { color:var(--fca-text); background:var(--fca-bg-3); }
.view-editor__tab.is-active { color:var(--fca-accent-strong); border-bottom-color:var(--fca-accent); }
.view-editor__tabpanel { flex:1; overflow-y:auto; padding:var(--fca-space-3); min-height:0; scrollbar-width:thin; }
.view-editor__aside-empty { color:var(--fca-text-muted); font-size:var(--fca-text-sm); padding:var(--fca-space-3) 0; line-height:1.6; }
.view-editor__aside-toolbar { display:flex; align-items:center; justify-content:space-between; gap:var(--fca-space-2); margin-bottom:var(--fca-space-2); flex-wrap:wrap; }
.view-editor__aside-actions { display:flex; gap:var(--fca-space-2); padding-top:var(--fca-space-3); margin-top:var(--fca-space-3); border-top:1px solid var(--fca-border); flex-wrap:wrap; }
.view-editor__versions { display:flex; flex-direction:column; gap:2px; }
.view-editor__version-row { display:grid; grid-template-columns:42px 54px 1fr auto; align-items:center; gap:var(--fca-space-2); padding:5px var(--fca-space-2); border:1px solid transparent; border-radius:var(--fca-radius-sm); cursor:pointer; font-size:var(--fca-text-xs); }
.view-editor__version-row:hover { background:var(--fca-bg-3); }
.view-editor__version-row.is-selected { border-color:var(--fca-accent); background:var(--fca-accent-soft); }
.view-editor__version-row.is-current .view-editor__version-no { color:var(--fca-gold); }
.view-editor__version-no { font-family:var(--fca-font-mono); color:var(--fca-text-dim); }
.view-editor__version-time { color:var(--fca-text-muted); }
.view-editor__version-actor { color:var(--fca-text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:110px; }
.view-editor__diff { margin-top:var(--fca-space-2); border-top:1px solid var(--fca-border); padding-top:var(--fca-space-2); }
.view-editor__diff-head { display:flex; justify-content:space-between; align-items:center; gap:var(--fca-space-2); margin-bottom:var(--fca-space-2); flex-wrap:wrap; font-size:var(--fca-text-sm); }
.view-editor__diff-fields { display:flex; flex-direction:column; gap:2px; }
.view-editor__diff-row { display:grid; grid-template-columns:52px 110px 1fr; gap:var(--fca-space-2); padding:3px 0; font-size:var(--fca-text-xs); border-bottom:1px dashed var(--fca-border); }
.view-editor__diff-label { color:var(--fca-text-dim); }
.view-editor__diff-value { color:var(--fca-text); font-family:var(--fca-font-mono); word-break:break-all; }
.view-editor__diff-subtitle { font-size:var(--fca-text-sm); color:var(--fca-text-dim); margin:var(--fca-space-3) 0 var(--fca-space-1); }
.view-editor__diff-code { font-family:var(--fca-font-mono); font-size:var(--fca-text-xs); background:var(--fca-bg-0); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); max-height:280px; overflow:auto; }
.view-editor__diff-line { display:flex; gap:var(--fca-space-2); padding:1px var(--fca-space-2); white-space:pre-wrap; word-break:break-word; }
.view-editor__diff-line--add { background:color-mix(in srgb, var(--fca-green) 14%, transparent); }
.view-editor__diff-line--del { background:color-mix(in srgb, var(--fca-danger) 14%, transparent); }
.view-editor__diff-line--context { color:var(--fca-text-muted); }
.view-editor__diff-gutter { flex:0 0 52px; color:var(--fca-text-muted); text-align:right; user-select:none; }
.view-editor__diff-text { white-space:pre-wrap; word-break:break-word; }
.view-editor__relations { display:flex; flex-direction:column; gap:var(--fca-space-1); }
.view-editor__relation-row { display:flex; align-items:center; gap:var(--fca-space-2); padding:4px 0; border-bottom:1px dashed var(--fca-border); font-size:var(--fca-text-xs); }
.view-editor__relation-target { font-family:var(--fca-font-mono); color:var(--fca-text-dim); }
.view-editor__help p { font-size:var(--fca-text-sm); color:var(--fca-text-dim); line-height:1.7; margin:0 0 var(--fca-space-2); }
.view-editor__field { display:flex; flex-direction:column; gap:4px; margin-bottom:var(--fca-space-3); min-width:0; }
.view-editor__field--wide { grid-column:1/-1; }
.view-editor__label { display:flex; align-items:center; gap:var(--fca-space-2); font-size:var(--fca-text-sm); color:var(--fca-text-dim); }
.view-editor__req { color:var(--fca-danger); }
.view-editor__hint { font-size:var(--fca-text-xs); color:var(--fca-text-muted); margin-left:auto; font-weight:400; }
.view-editor__input { width:100%; box-sizing:border-box; background:var(--fca-bg-3); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); color:var(--fca-text); font:inherit; font-size:var(--fca-text-md); padding:6px var(--fca-space-2); outline:none; }
.view-editor__input:focus { border-color:var(--fca-accent); box-shadow:0 0 0 2px var(--fca-accent-soft); }
.view-editor__input:disabled { opacity:.55; cursor:not-allowed; }
.view-editor__select { height:31px; }
.view-editor__textarea { resize:vertical; line-height:1.6; font-family:var(--fca-font-ui); }
.view-editor__textarea--mono { font-family:var(--fca-font-mono); }
.view-editor__title-input { font-size:var(--fca-text-lg); font-weight:600; height:38px; }
.view-editor__body-input { min-height:220px; }
.view-editor__body-wrap { display:flex; flex-direction:column; gap:4px; }
.view-editor__body-stats { font-size:var(--fca-text-xs); color:var(--fca-text-muted); text-align:right; }
.view-editor__preview { min-height:220px; background:var(--fca-bg-2); border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); padding:var(--fca-space-3) var(--fca-space-4); line-height:1.75; overflow:auto; }
.view-editor__preview h3,.view-editor__preview h4,.view-editor__preview h5,.view-editor__preview h6 { margin:var(--fca-space-3) 0 var(--fca-space-1); font-size:var(--fca-text-md); color:var(--fca-accent-strong); }
.view-editor__preview p { margin:0 0 var(--fca-space-2); }
.view-editor__preview ul,.view-editor__preview ol { margin:0 0 var(--fca-space-2); padding-left:var(--fca-space-5); }
.view-editor__preview blockquote { margin:0 0 var(--fca-space-2); padding:2px var(--fca-space-3); border-left:2px solid var(--fca-border-strong); color:var(--fca-text-dim); }
.view-editor__preview code { font-family:var(--fca-font-mono); background:var(--fca-bg-0); padding:1px 4px; border-radius:3px; }
.view-editor__preview pre { background:var(--fca-bg-0); border:1px solid var(--fca-border); padding:var(--fca-space-2); border-radius:var(--fca-radius-sm); overflow:auto; }
.view-editor__preview a { color:var(--fca-accent); }
.view-editor__preview hr { border:none; border-top:1px solid var(--fca-border); margin:var(--fca-space-3) 0; }
.view-editor__md__empty { color:var(--fca-text-muted); }
.view-editor__row--2 { display:grid; grid-template-columns:1fr 1fr; gap:var(--fca-space-3); }
.view-editor__grid-fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:0 var(--fca-space-3); }
.view-editor__date-row { display:flex; gap:var(--fca-space-2); align-items:center; flex-wrap:wrap; }
.view-editor__date-row .view-editor__input[type="date"] { flex:0 0 170px; }
.view-editor__date-row .view-editor__input[type="time"] { flex:0 0 110px; }
.view-editor__date-hint { font-size:var(--fca-text-xs); color:var(--fca-text-muted); }
.view-editor__section { margin:0 0 var(--fca-space-4); padding:var(--fca-space-3); border:1px solid var(--fca-border); border-radius:var(--fca-radius); background:var(--fca-bg-2); }
.view-editor__section-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:var(--fca-space-2); gap:var(--fca-space-2); }
.view-editor__section-title { margin:0; font-size:var(--fca-text-sm); color:var(--fca-text-dim); font-weight:600; letter-spacing:.02em; }
.view-editor__section-hint { font-size:var(--fca-text-xs); color:var(--fca-text-muted); }
.view-editor__chips { display:flex; flex-wrap:wrap; gap:var(--fca-space-1); align-items:center; }
.view-editor__chip { display:inline-flex; align-items:center; gap:4px; padding:2px 4px 2px var(--fca-space-2); border-radius:999px; background:var(--fca-accent-soft); border:1px solid var(--fca-border-strong); color:var(--fca-text); font-size:var(--fca-text-xs); }
.view-editor__chip--person { background:color-mix(in srgb, var(--fca-violet) 14%, transparent); }
.view-editor__chip--project { background:color-mix(in srgb, var(--fca-green) 14%, transparent); }
.view-editor__chip-remove { border:none; background:transparent; color:var(--fca-text-muted); cursor:pointer; font-size:var(--fca-text-sm); padding:0 3px; line-height:1; }
.view-editor__chip-remove:hover { color:var(--fca-danger); }
.view-editor__chips > .view-editor__input { flex:1; min-width:160px; width:auto; height:28px; font-size:var(--fca-text-sm); }
.view-editor__suggestions { display:flex; flex-wrap:wrap; gap:var(--fca-space-1); margin-top:4px; }
.view-editor__suggestions--floating { min-height:0; }
.view-editor__suggestion { border:1px solid var(--fca-border); background:var(--fca-bg-3); color:var(--fca-text-dim); border-radius:var(--fca-radius-sm); padding:2px var(--fca-space-2); font:inherit; font-size:var(--fca-text-xs); cursor:pointer; display:inline-flex; gap:6px; align-items:center; }
.view-editor__suggestion:hover { border-color:var(--fca-accent); color:var(--fca-text); }
.view-editor__suggestion--create { color:var(--fca-green); border-style:dashed; }
.view-editor__suggestion-meta { color:var(--fca-text-muted); font-family:var(--fca-font-mono); }
.view-editor__suggestion-error { color:var(--fca-danger); font-size:var(--fca-text-xs); }
.view-editor__inline-row { display:flex; gap:var(--fca-space-2); align-items:center; margin-top:var(--fca-space-2); flex-wrap:wrap; }
.view-editor__inline-row .view-editor__input { flex:1; min-width:140px; width:auto; height:29px; }
.view-editor__participants { display:flex; flex-direction:column; }
.view-editor__slope { display:flex; align-items:center; gap:var(--fca-space-2); }
.view-editor__range { flex:1; accent-color:var(--fca-accent); min-width:60px; }
.view-editor__number { width:64px; flex:0 0 64px; text-align:right; }
.view-editor__checkline { display:inline-flex; align-items:center; gap:var(--fca-space-2); font-size:var(--fca-text-sm); color:var(--fca-text-dim); cursor:pointer; }
.view-editor__checkline input { accent-color:var(--fca-accent); }
.view-editor__readonly { display:flex; flex-direction:column; gap:4px; margin-bottom:var(--fca-space-3); }
.view-editor__meta-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:var(--fca-space-2); }
.view-editor__meta-item { display:flex; flex-direction:column; gap:2px; }
.view-editor__meta-label { font-size:var(--fca-text-xs); color:var(--fca-text-muted); }
.view-editor__meta-value { font-size:var(--fca-text-sm); color:var(--fca-text-dim); word-break:break-all; }
.view-editor__badge { display:inline-flex; align-items:center; padding:1px 6px; border-radius:999px; font-size:var(--fca-text-xs); border:1px solid var(--fca-border-strong); color:var(--fca-text-dim); white-space:nowrap; }
.view-editor__badge--cyan { color:var(--fca-accent); border-color:color-mix(in srgb, var(--fca-accent) 45%, transparent); background:var(--fca-accent-soft); }
.view-editor__badge--gold { color:var(--fca-gold); border-color:color-mix(in srgb, var(--fca-gold) 45%, transparent); background:color-mix(in srgb, var(--fca-gold) 12%, transparent); }
.view-editor__badge--rose { color:var(--fca-rose); border-color:color-mix(in srgb, var(--fca-rose) 45%, transparent); background:color-mix(in srgb, var(--fca-rose) 12%, transparent); }
.view-editor__badge--green { color:var(--fca-green); border-color:color-mix(in srgb, var(--fca-green) 45%, transparent); background:color-mix(in srgb, var(--fca-green) 12%, transparent); }
.view-editor__badge--violet { color:var(--fca-violet); border-color:color-mix(in srgb, var(--fca-violet) 45%, transparent); background:color-mix(in srgb, var(--fca-violet) 12%, transparent); }
.view-editor__badge--blue { color:var(--fca-accent-strong); border-color:var(--fca-border-strong); background:var(--fca-bg-3); }
.view-editor__badge--neutral { background:var(--fca-bg-3); }
.view-editor__error { color:var(--fca-danger); font-size:var(--fca-text-xs); }
.view-editor__errorbox { border:1px solid color-mix(in srgb, var(--fca-danger) 50%, var(--fca-border)); background:color-mix(in srgb, var(--fca-danger) 8%, var(--fca-bg-2)); border-radius:var(--fca-radius); padding:var(--fca-space-3); display:flex; flex-direction:column; gap:var(--fca-space-2); max-width:560px; }
.view-editor__errorbox-title { color:var(--fca-danger); font-weight:600; }
.view-editor__errorbox-detail { color:var(--fca-text-dim); font-size:var(--fca-text-sm); word-break:break-word; }
.view-editor__emptybox { padding:var(--fca-space-5); text-align:center; }
.view-editor__emptybox-title { font-size:var(--fca-text-lg); margin-bottom:var(--fca-space-2); }
.view-editor__emptybox-desc { color:var(--fca-text-muted); margin-bottom:var(--fca-space-3); }
.view-editor__dialog { display:flex; flex-direction:column; gap:var(--fca-space-3); max-height:60vh; overflow:auto; }
.view-editor__dialog p { margin:0; line-height:1.6; }
.view-editor__dialog-results { display:flex; flex-direction:column; gap:2px; max-height:220px; overflow:auto; border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); padding:var(--fca-space-1); }
.view-editor__dialog-row { display:flex; align-items:center; gap:var(--fca-space-2); padding:4px var(--fca-space-1); border-radius:var(--fca-radius-sm); cursor:pointer; }
.view-editor__dialog-row:hover { background:var(--fca-bg-3); }
.view-editor__dialog-row-main { display:flex; flex-direction:column; }
.view-editor__split-rows { display:flex; flex-direction:column; gap:var(--fca-space-3); }
.view-editor__split-row { border:1px solid var(--fca-border); border-radius:var(--fca-radius-sm); padding:var(--fca-space-2); display:flex; flex-direction:column; gap:var(--fca-space-2); }
@media (max-width: 1180px) { .view-editor__grid { grid-template-columns:minmax(0,1fr); } .view-editor__aside { border-left:none; border-top:1px solid var(--fca-border); max-height:360px; } }
@media (max-width: 720px) { .view-editor__row--2 { grid-template-columns:1fr; } .view-editor__heading-title { max-width:60vw; } }
`;
