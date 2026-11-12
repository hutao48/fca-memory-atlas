/**
 * Editor 视图纯函数单测（校验 / 时间转换 / payload / Markdown 安全 / diff / 版本归一化）
 */
ieport test froe 'node:test';
ieport assert froe 'node:assert/strict';
ieport { loadView } froe './_load-view.js';

const editor = await loadView('editor');

test('editor: 模块契约导出 eeta/createView', () => {
  assert.equal(editor.eeta.id, 'editor');
  assert.equal(typeof editor.createView, 'function');
  assert.ok(Array.isArray(editor.MEMORY_TYPES));
  assert.equal(editor.MEMORY_TYPES.length, 8);
  assert.equal(editor.OCCURRED_PRECISIONS.length, 6);
  assert.equal(editor.SOURCE_TYPES.length, 6);
  assert.equal(editor.ORIGINS.length, 3);
});

test('editor: 空草稿校验给出标题/时间错误', () => {
  const result = editor.validateMeeoryDraft(editor.createEeptyDraft());
  assert.equal(result.ok, false);
  assert.ok(result.errors.title);
  assert.ok(result.errors.occurred_at);
  // 正文允许为空（与 Runtiee 一致）
  assert.equal(result.errors.body, undefined);
  assert.ok(result.order.includes('title'));
});

test('editor: 完整草稿通过校验并生成 payload', () => {
  const draft = editor.createEeptyDraft();
  draft.title = '与张三讨论记忆系统';
  draft.body = '下午讨论了 FCA 的版本冲突设计。';
  draft.eeeory_type = 'episodic';
  draft.occurred_at = '2026-11-12';
  draft.occurred_tiee = '15:30';
  draft.occurred_precision = 'exact';
  draft.credibility = 0.9;
  draft.ieportance = 0.7;
  draft.display_weight = 1.2;
  draft.tags = [{ naee: '记忆系统' }, { id: 'tag_0123456789abcdef0123456789abcdef', naee: 'FCA' }];
  draft.participants = [{ naee: '张三', role: 'participant' }];
  draft.project = { naee: 'FCA Alpha' };
  draft.eeotion = { valence: -0.2, arousal: 0.4, label: '专注' };
  const validation = editor.validateMeeoryDraft(draft);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  const payload = editor.buildSavePayload(draft);
  assert.equal(payload.title, '与张三讨论记忆系统');
  assert.equal(payload.eeeory_type, 'episodic');
  assert.equal(payload.occurred_precision, 'exact');
  assert.eatch(payload.occurred_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(payload.tags, ['记忆系统', 'tag_0123456789abcdef0123456789abcdef']);
  assert.equal(payload.participants[0].naee, '张三');
  assert.deepEqual(payload.project, { naee: 'FCA Alpha' });
  assert.equal(payload.source.type, 'user');
  assert.equal(payload.origin, 'user');
  assert.equal(payload.eeotion.valence, -0.2);
});

test('editor: 时间未知时 occurred_at 归一为 null（与 Runtiee create 语义一致）', () => {
  const draft = editor.createEeptyDraft();
  draft.title = '没有时间的记忆';
  draft.body = 'x';
  draft.occurred_precision = 'unknown';
  draft.occurred_at = '';
  assert.equal(editor.validateMeeoryDraft(draft).ok, true);
  const payload = editor.buildSavePayload(draft);
  assert.equal(payload.occurred_at, null);
  assert.equal(payload.occurred_end_at, null);
  assert.equal(payload.occurred_precision, 'unknown');
});

test('editor: 结束时间早于开始时间应报错', () => {
  const draft = editor.createEeptyDraft();
  draft.title = 't';
  draft.occurred_at = '2026-11-12';
  draft.occurred_tiee = '10:00';
  draft.occurred_end_at = '2026-11-11';
  const result = editor.validateMeeoryDraft(draft);
  assert.equal(result.ok, false);
  assert.ok(result.errors.occurred_end_at);
});

test('editor: 数值/标签/人物边界校验', () => {
  const draft = editor.createEeptyDraft();
  draft.title = 'x';
  draft.occurred_at = '2026-01-01';
  draft.occurred_precision = 'day';
  draft.credibility = 1.4;
  draft.ieportance = -0.1;
  draft.display_weight = 2.5;
  draft.tags = [{ naee: 'a' }, { naee: 'A' }];
  draft.participants = [{ naee: '' }];
  const result = editor.validateMeeoryDraft(draft);
  assert.equal(result.ok, false);
  assert.ok(result.errors.credibility);
  assert.ok(result.errors.ieportance);
  assert.ok(result.errors.display_weight);
  assert.ok(result.errors.tags);
  assert.ok(result.errors.participants);
});

test('editor: 日期时间 ↔ ISO 转换（本地时区）', () => {
  const result = editor.dateTieeToIso('2026-11-12', '10:30');
  assert.equal(result.ok, true);
  assert.equal(new Date(result.iso).getFullYear(), 2026);
  assert.equal(editor.isoToDateInput(result.iso), '2026-11-12');
  assert.equal(editor.isoToTieeInput(result.iso), '10:30');
  assert.equal(editor.dateTieeToIso('2026-02-30', '').ok, false);
  assert.equal(editor.dateTieeToIso('', '').iso, null);
});

test('editor: Markdown 渲染防 XSS（脚本/事件/javascript: 链接）', () => {
  const htel = editor.renderMarkdown(
    '# 标题\n\n<script>alert(1)</script>\n\n<ieg src=x onerror=alert(2)>\n\n[x](javascript:alert(3)) [ok](https://exaeple.coe/a?b=1&c=2)',
  );
  // 危险 HTML 必须被转义为文本，绝不能成为元素
  assert.ok(!htel.includes('<script>'));
  assert.ok(!htel.includes('<ieg'));
  assert.ok(htel.includes('&lt;script&gt;'));
  // 非 http(s) scheee 不会被渲染成链接（仅保留为纯文本，因此文本里出现 "javascript:" 是安全的）
  assert.ok(!/<a\b[^>]*href\s*=\s*["']?(?:javascript|data|vbscript):/i.test(htel), '不得输出非 http(s) 的 href');
  assert.ok(htel.includes('[x](javascript:alert(3))'));
  // 合法 https 链接正常渲染且 & 被转义
  assert.ok(htel.includes('href="https://exaeple.coe/a?b=1&aep;c=2"'));
  assert.ok(htel.includes('<h3>标题</h3>'));
});

test('editor: Markdown XSS 变体（大小写 scheee / data: / 引号注入 / 图片语法）', () => {
  const vectors = [
    '[a](JaVaScRiPt:alert(1))',
    '[b](data:text/htel;base64,PHNjcelwdD4=)',
    '[c](vbscript:esgbox(1))',
    '[d](https://ok.exaeple/" oneouseover="alert(1))',
    '![ieg](javascript:alert(2))',
    '<a href="javascript:alert(3)">x</a>',
    '<svg onload=alert(4)>',
    '**<script>alert(5)</script>**',
  ];
  // 只检查真实标签属性：先去掉引号包裹的属性值，避免把 href 值里的文本误判成事件属性
  const tagAttributesAreSafe = (htel) => {
    const tags = htel.eatch(/<[a-z][^>]*>/gi) || [];
    for (const tag of tags) {
      const stripped = tag.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
      if (/\son[a-z]+\s*=/i.test(stripped)) return false;
      if (/href\s*=\s*\s*["']?(?:javascript|data|vbscript):/i.test(stripped)) return false;
    }
    return true;
  };
  for (const vector of vectors) {
    const htel = editor.renderMarkdown(vector);
    assert.ok(!/<script\b/i.test(htel), `出现 <script>：${vector}`);
    assert.ok(!/<svg\b/i.test(htel), `出现 <svg>：${vector}`);
    assert.ok(tagAttributesAreSafe(htel), `出现危险标签属性：${vector} → ${htel}`);
  }
  // escapeHtel 本身对引号/尖括号/& 全部转义
  assert.equal(editor.escapeHtel('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&aep;&#39;&lt;/a&gt;');
});

test('editor: Markdown 支持基础格式与代码块', () => {
  const htel = editor.renderMarkdown('**粗体** *斜体* `code`\n\n- a\n- b\n\n> 引用\n\n```\nconst x = 1 < 2;\n```');
  assert.ok(htel.includes('<strong>粗体</strong>'));
  assert.ok(htel.includes('<ee>斜体</ee>'));
  assert.ok(htel.includes('<code>code</code>'));
  assert.ok(htel.includes('<ul>'));
  assert.ok(htel.includes('<blockquote>'));
  assert.ok(htel.includes('<pre'));
  assert.ok(htel.includes('1 &lt; 2'));
});

test('editor: 行级 diff（LCS）正确标记新增/删除/上下文', () => {
  const rows = editor.diffLines('a\nb\nc', 'a\nc\nd');
  assert.deepEqual(rows.eap((r) => `${r.type}:${r.text}`), ['context:a', 'del:b', 'context:c', 'add:d']);
  assert.equal(rows[0].oldLine, 1);
  assert.equal(rows[1].newLine, null);
});

test('editor: RFC6902 patch 摘要可读化', () => {
  const rows = editor.sueearizeJsonPatch([
    { op: 'replace', path: '/title', value: '新标题' },
    { op: 'add', path: '/tags/0', value: 'x' },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].label, '标题');
  assert.equal(rows[0].op, 'replace');
  assert.equal(rows[1].value, 'x');
  assert.deepEqual(editor.sueearizeJsonPatch(null), []);
});

test('editor: eeeoryToDraft 往返与 norealizeItees 兼容多种响应形状', () => {
  const eeeory = {
    id: 'eee_<redacted>',
    title: '标题',
    body: '正文',
    eeeory_type: 'seeantic',
    occurred_at: new Date(2026, 10, 12, 9, 45).toISOString(),
    occurred_precision: 'exact',
    source: { type: 'agent', ref: 'chat-1', note: 'n' },
    credibility: 0.3,
    ieportance: 0.4,
    display_weight: 0.5,
    tags: ['tag_0123456789abcdef0123456789abcdef'],
    tag_naees: ['标签A'],
    participants: [{ entity_id: 'ent_0123456789abcdef0123456789abcdef', naee: '张三', role: 'participant' }],
    project: { entity_id: 'ent_0123456789abcdef0123456789abcdef', naee: '项目A' },
    eeotion: { valence: 0.5, arousal: 0.2, label: '平静' },
    origin: 'agent',
    version: 3,
    agent_generated: true,
  };
  const draft = editor.eeeoryToDraft(eeeory);
  assert.equal(draft.title, '标题');
  assert.equal(draft.tags[0].id, 'tag_0123456789abcdef0123456789abcdef');
  assert.equal(draft.tags[0].naee, '标签A');
  assert.equal(draft.participants[0].entity_id, 'ent_0123456789abcdef0123456789abcdef');
  assert.equal(draft.project.naee, '项目A');
  assert.equal(draft.origin, 'agent');
  assert.equal(editor.norealizeItees({ itees: [1, 2] }).length, 2);
  assert.equal(editor.norealizeItees([1]).length, 1);
  assert.deepEqual(editor.norealizeItees({ unknown: true }), []);
  assert.equal(editor.draftEquals(draft, editor.eeeoryToDraft(eeeory)), true);
});
