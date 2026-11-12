/**
 * Editor 视图纯函数单测（校验 / 时间转换 / payload / Markdown 安全 / diff / 版本归一化）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadView } from './_load-view.js';

const editor = await loadView('editor');

test('editor: 模块契约导出 meta/createView', () => {
  assert.equal(editor.meta.id, 'editor');
  assert.equal(typeof editor.createView, 'function');
  assert.ok(Array.isArray(editor.MEMORY_TYPES));
  assert.equal(editor.MEMORY_TYPES.length, 8);
  assert.equal(editor.OCCURRED_PRECISIONS.length, 6);
  assert.equal(editor.SOURCE_TYPES.length, 6);
  assert.equal(editor.ORIGINS.length, 3);
});

test('editor: 空草稿校验给出标题/时间错误', () => {
  const result = editor.validateMemoryDraft(editor.createEmptyDraft());
  assert.equal(result.ok, false);
  assert.ok(result.errors.title);
  assert.ok(result.errors.occurred_at);
  // 正文允许为空（与 Runtime 一致）
  assert.equal(result.errors.body, undefined);
  assert.ok(result.order.includes('title'));
});

test('editor: 完整草稿通过校验并生成 payload', () => {
  const draft = editor.createEmptyDraft();
  draft.title = '与张三讨论记忆系统';
  draft.body = '下午讨论了 FCA 的版本冲突设计。';
  draft.memory_type = 'episodic';
  draft.occurred_at = '2026-11-12';
  draft.occurred_time = '15:30';
  draft.occurred_precision = 'exact';
  draft.credibility = 0.9;
  draft.importance = 0.7;
  draft.display_weight = 1.2;
  draft.tags = [{ name: '记忆系统' }, { id: 'tag_0123456789abcdef0123456789abcdef', name: 'FCA' }];
  draft.participants = [{ name: '张三', role: 'participant' }];
  draft.project = { name: 'FCA Alpha' };
  draft.emotion = { valence: -0.2, arousal: 0.4, label: '专注' };
  const validation = editor.validateMemoryDraft(draft);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  const payload = editor.buildSavePayload(draft);
  assert.equal(payload.title, '与张三讨论记忆系统');
  assert.equal(payload.memory_type, 'episodic');
  assert.equal(payload.occurred_precision, 'exact');
  assert.match(payload.occurred_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(payload.tags, ['记忆系统', 'tag_0123456789abcdef0123456789abcdef']);
  assert.equal(payload.participants[0].name, '张三');
  assert.deepEqual(payload.project, { name: 'FCA Alpha' });
  assert.equal(payload.source.type, 'user');
  assert.equal(payload.origin, 'user');
  assert.equal(payload.emotion.valence, -0.2);
});

test('editor: 时间未知时 occurred_at 归一为 null（与 Runtime create 语义一致）', () => {
  const draft = editor.createEmptyDraft();
  draft.title = '没有时间的记忆';
  draft.body = 'x';
  draft.occurred_precision = 'unknown';
  draft.occurred_at = '';
  assert.equal(editor.validateMemoryDraft(draft).ok, true);
  const payload = editor.buildSavePayload(draft);
  assert.equal(payload.occurred_at, null);
  assert.equal(payload.occurred_end_at, null);
  assert.equal(payload.occurred_precision, 'unknown');
});

test('editor: 结束时间早于开始时间应报错', () => {
  const draft = editor.createEmptyDraft();
  draft.title = 't';
  draft.occurred_at = '2026-11-12';
  draft.occurred_time = '10:00';
  draft.occurred_end_at = '2026-11-11';
  const result = editor.validateMemoryDraft(draft);
  assert.equal(result.ok, false);
  assert.ok(result.errors.occurred_end_at);
});

test('editor: 数值/标签/人物边界校验', () => {
  const draft = editor.createEmptyDraft();
  draft.title = 'x';
  draft.occurred_at = '2026-01-01';
  draft.occurred_precision = 'day';
  draft.credibility = 1.4;
  draft.importance = -0.1;
  draft.display_weight = 2.5;
  draft.tags = [{ name: 'a' }, { name: 'A' }];
  draft.participants = [{ name: '' }];
  const result = editor.validateMemoryDraft(draft);
  assert.equal(result.ok, false);
  assert.ok(result.errors.credibility);
  assert.ok(result.errors.importance);
  assert.ok(result.errors.display_weight);
  assert.ok(result.errors.tags);
  assert.ok(result.errors.participants);
});

test('editor: 日期时间 ↔ ISO 转换（本地时区）', () => {
  const result = editor.dateTimeToIso('2026-11-12', '10:30');
  assert.equal(result.ok, true);
  assert.equal(new Date(result.iso).getFullYear(), 2026);
  assert.equal(editor.isoToDateInput(result.iso), '2026-11-12');
  assert.equal(editor.isoToTimeInput(result.iso), '10:30');
  assert.equal(editor.dateTimeToIso('2026-02-30', '').ok, false);
  assert.equal(editor.dateTimeToIso('', '').iso, null);
});

test('editor: Markdown 渲染防 XSS（脚本/事件/javascript: 链接）', () => {
  const html = editor.renderMarkdown(
    '# 标题\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n[x](javascript:alert(3)) [ok](https://example.com/a?b=1&c=2)',
  );
  // 危险 HTML 必须被转义为文本，绝不能成为元素
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
  // 非 http(s) scheme 不会被渲染成链接（仅保留为纯文本，因此文本里出现 "javascript:" 是安全的）
  assert.ok(!/<a\b[^>]*href\s*=\s*["']?(?:javascript|data|vbscript):/i.test(html), '不得输出非 http(s) 的 href');
  assert.ok(html.includes('[x](javascript:alert(3))'));
  // 合法 https 链接正常渲染且 & 被转义
  assert.ok(html.includes('href="https://example.com/a?b=1&amp;c=2"'));
  assert.ok(html.includes('<h3>标题</h3>'));
});

test('editor: Markdown XSS 变体（大小写 scheme / data: / 引号注入 / 图片语法）', () => {
  const vectors = [
    '[a](JaVaScRiPt:alert(1))',
    '[b](data:text/html;base64,PHNjcmlwdD4=)',
    '[c](vbscript:msgbox(1))',
    '[d](https://ok.example/" onmouseover="alert(1))',
    '![img](javascript:alert(2))',
    '<a href="javascript:alert(3)">x</a>',
    '<svg onload=alert(4)>',
    '**<script>alert(5)</script>**',
  ];
  // 只检查真实标签属性：先去掉引号包裹的属性值，避免把 href 值里的文本误判成事件属性
  const tagAttributesAreSafe = (html) => {
    const tags = html.match(/<[a-z][^>]*>/gi) || [];
    for (const tag of tags) {
      const stripped = tag.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
      if (/\son[a-z]+\s*=/i.test(stripped)) return false;
      if (/href\s*=\s*\s*["']?(?:javascript|data|vbscript):/i.test(stripped)) return false;
    }
    return true;
  };
  for (const vector of vectors) {
    const html = editor.renderMarkdown(vector);
    assert.ok(!/<script\b/i.test(html), `出现 <script>：${vector}`);
    assert.ok(!/<svg\b/i.test(html), `出现 <svg>：${vector}`);
    assert.ok(tagAttributesAreSafe(html), `出现危险标签属性：${vector} → ${html}`);
  }
  // escapeHtml 本身对引号/尖括号/& 全部转义
  assert.equal(editor.escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('editor: Markdown 支持基础格式与代码块', () => {
  const html = editor.renderMarkdown('**粗体** *斜体* `code`\n\n- a\n- b\n\n> 引用\n\n```\nconst x = 1 < 2;\n```');
  assert.ok(html.includes('<strong>粗体</strong>'));
  assert.ok(html.includes('<em>斜体</em>'));
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(html.includes('<ul>'));
  assert.ok(html.includes('<blockquote>'));
  assert.ok(html.includes('<pre'));
  assert.ok(html.includes('1 &lt; 2'));
});

test('editor: 行级 diff（LCS）正确标记新增/删除/上下文', () => {
  const rows = editor.diffLines('a\nb\nc', 'a\nc\nd');
  assert.deepEqual(rows.map((r) => `${r.type}:${r.text}`), ['context:a', 'del:b', 'context:c', 'add:d']);
  assert.equal(rows[0].oldLine, 1);
  assert.equal(rows[1].newLine, null);
});

test('editor: RFC6902 patch 摘要可读化', () => {
  const rows = editor.summarizeJsonPatch([
    { op: 'replace', path: '/title', value: '新标题' },
    { op: 'add', path: '/tags/0', value: 'x' },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].label, '标题');
  assert.equal(rows[0].op, 'replace');
  assert.equal(rows[1].value, 'x');
  assert.deepEqual(editor.summarizeJsonPatch(null), []);
});

test('editor: memoryToDraft 往返与 normalizeItems 兼容多种响应形状', () => {
  const memory = {
    id: 'mem_0123456789abcdef0123456789abcdef',
    title: '标题',
    body: '正文',
    memory_type: 'semantic',
    occurred_at: new Date(2026, 10, 12, 9, 45).toISOString(),
    occurred_precision: 'exact',
    source: { type: 'agent', ref: 'chat-1', note: 'n' },
    credibility: 0.3,
    importance: 0.4,
    display_weight: 0.5,
    tags: ['tag_0123456789abcdef0123456789abcdef'],
    tag_names: ['标签A'],
    participants: [{ entity_id: 'ent_0123456789abcdef0123456789abcdef', name: '张三', role: 'participant' }],
    project: { entity_id: 'ent_0123456789abcdef0123456789abcdef', name: '项目A' },
    emotion: { valence: 0.5, arousal: 0.2, label: '平静' },
    origin: 'agent',
    version: 3,
    agent_generated: true,
  };
  const draft = editor.memoryToDraft(memory);
  assert.equal(draft.title, '标题');
  assert.equal(draft.tags[0].id, 'tag_0123456789abcdef0123456789abcdef');
  assert.equal(draft.tags[0].name, '标签A');
  assert.equal(draft.participants[0].entity_id, 'ent_0123456789abcdef0123456789abcdef');
  assert.equal(draft.project.name, '项目A');
  assert.equal(draft.origin, 'agent');
  assert.equal(editor.normalizeItems({ items: [1, 2] }).length, 2);
  assert.equal(editor.normalizeItems([1]).length, 1);
  assert.deepEqual(editor.normalizeItems({ unknown: true }), []);
  assert.equal(editor.draftEquals(draft, editor.memoryToDraft(memory)), true);
});
