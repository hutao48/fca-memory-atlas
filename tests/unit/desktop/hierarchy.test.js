/**
 * FCA Memory Atlas — 子 Agent 层级解析单元测试（node:test）
 * 运行：tools\node.cmd --test tests/unit/desktop/hierarchy.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// desktop/package.json 是 commonjs，renderer 下是浏览器 ESM：与 _load-view.js 一样用 data: URL 加载真实源文件
const HERE = dirname(fileURLToPath(import.meta.url));
const hierSource = readFileSync(join(HERE, '..', '..', '..', 'desktop', 'renderer', 'lib', 'hierarchy.js'), 'utf8');
const hierarchy = await import(`data:text/javascript;base64,${Buffer.from(hierSource, 'utf8').toString('base64')}`);
const {
  HIERARCHY_RELATION_TYPES,
  buildHierarchySummary,
  classifyHierarchyRelation,
  collectTagStrings,
  hierarchyRelationLabel,
  idMatchesRef,
  isHierarchyRelation,
  parseHierarchyHints,
  resolveRefs,
  shortId,
  toChildMemoryItem,
} = hierarchy;

const CHILD_ID = 'mem_<redacted>';
const PARENT_ID = 'mem_<redacted>';
const UNRELATED_ID = 'mem_<redacted>';

const nodes = [
  { id: PARENT_ID, kind: 'memory', label: 'Agent 思考节点 · 第 1 回合', type: 'procedural' },
  { id: CHILD_ID, kind: 'memory', label: '子 Agent 会话记忆', type: 'episodic' },
  { id: UNRELATED_ID, kind: 'memory', label: '普通记忆', type: 'semantic' },
];

test('collectTagStrings 合并 tag_names / tags / 对象标签', () => {
  const memory = { tag_names: ['Agent子会话', 'workspace:FCA'], tags: ['tag_x', { name: 'parent-memory:' + shortId(PARENT_ID) }] };
  const tags = collectTagStrings(memory);
  assert.ok(tags.includes('Agent子会话'));
  assert.ok(tags.includes('workspace:FCA'));
  assert.ok(tags.some((tag) => tag.startsWith('parent-memory:')));
});

test('parseHierarchyHints：父记忆 children:<id8>（可多个）', () => {
  const memory = {
    id: PARENT_ID,
    tag_names: [`children:${shortId(CHILD_ID)}`, `children:${shortId(UNRELATED_ID)}`, 'Agent思考节点', 'workspace:FCA'],
  };
  const hints = parseHierarchyHints(memory);
  assert.equal(hints.childRefs.length, 2);
  assert.equal(hints.parentRefs.length, 0);
  assert.equal(hints.isChildSession, false);
  assert.equal(hints.hasHierarchy, true);
});

test('parseHierarchyHints：子会话记忆 tags（Agent子会话 + parent-memory + parent-session + subagent-session）', () => {
  const memory = {
    id: CHILD_ID,
    tag_names: ['Agent子会话', `subagent-session:${shortId(CHILD_ID)}`, 'parent-session:1234abcd', `parent-memory:${PARENT_ID}`, 'workspace:FCA'],
  };
  const hints = parseHierarchyHints(memory);
  assert.equal(hints.isChildSession, true);
  assert.deepEqual(hints.parentRefs, [PARENT_ID]);
  assert.deepEqual(hints.parentSessionRefs, ['1234abcd']);
  assert.deepEqual(hints.sessionRefs, [shortId(CHILD_ID)]);
  assert.equal(hints.hasHierarchy, true);
});

test('idMatchesRef 支持完整 id / 8 位短 id / mem_ 前缀', () => {
  assert.equal(idMatchesRef(CHILD_ID, CHILD_ID), true);
  assert.equal(idMatchesRef(CHILD_ID, shortId(CHILD_ID)), true);
  assert.equal(idMatchesRef(CHILD_ID, `mem_${shortId(CHILD_ID)}`), true);
  assert.equal(idMatchesRef(CHILD_ID, shortId(UNRELATED_ID)), false);
});

test('resolveRefs：短 id 解析到 graph 节点，未索引短 id 保持 unresolved', () => {
  const resolved = resolveRefs([shortId(CHILD_ID), 'deadbeef'], nodes);
  assert.equal(resolved[0].id, CHILD_ID);
  assert.equal(resolved[0].resolved, true);
  assert.equal(resolved[1].id, null);
  assert.equal(resolved[1].resolved, false);
});

test('isHierarchyRelation：custom + label spawned_subagent 算层级；无关 custom 不算', () => {
  assert.equal(
    isHierarchyRelation({ relation_type: 'custom', label: 'spawned_subagent', from: { kind: 'memory', id: PARENT_ID }, to: { kind: 'memory', id: CHILD_ID } }),
    true,
  );
  assert.equal(isHierarchyRelation({ relation_type: 'derived_from' }), true);
  assert.equal(isHierarchyRelation({ relation_type: 'custom', label: '好友' }), false);
  assert.equal(isHierarchyRelation({ relation_type: 'knowledge_link' }), false);
  assert.ok(HIERARCHY_RELATION_TYPES.includes('derived_from'));
});

test('classifyHierarchyRelation：父记忆视角为 child，子记忆视角为 parent（custom spawned_subagent 方向 父→子）', () => {
  const relation = {
    relation_type: 'custom',
    label: 'spawned_subagent',
    from: { kind: 'memory', id: PARENT_ID },
    to: { kind: 'memory', id: CHILD_ID },
  };
  assert.equal(classifyHierarchyRelation(relation, PARENT_ID), 'child');
  assert.equal(classifyHierarchyRelation(relation, CHILD_ID), 'parent');
  const derived = { relation_type: 'derived_from', from: { kind: 'memory', id: CHILD_ID }, to: { kind: 'memory', id: PARENT_ID } };
  assert.equal(classifyHierarchyRelation(derived, PARENT_ID), 'child');
  assert.equal(classifyHierarchyRelation(derived, CHILD_ID), 'parent');
  assert.equal(classifyHierarchyRelation({ relation_type: 'custom', label: 'note' }, PARENT_ID), null);
});

test('buildHierarchySummary：父记忆 children tags + 关系去重，子记忆返回父记忆', () => {
  const parentMemory = {
    id: PARENT_ID,
    tag_names: [`children:${shortId(CHILD_ID)}`, `children:${shortId(UNRELATED_ID)}`, 'Agent思考节点'],
  };
  const parentSummary = buildHierarchySummary(parentMemory, [], nodes);
  assert.equal(parentSummary.childCount, 2);
  assert.equal(parentSummary.parentCount, 0);
  assert.equal(parentSummary.isChildSession, false);
  assert.equal(parentSummary.hasHierarchy, true);

  const childMemory = { id: CHILD_ID, tag_names: ['Agent子会话', `parent-memory:${PARENT_ID}`] };
  const relation = {
    relation_type: 'custom',
    label: 'spawned_subagent',
    from: { kind: 'memory', id: PARENT_ID },
    to: { kind: 'memory', id: CHILD_ID },
  };
  const childSummary = buildHierarchySummary(childMemory, [relation], nodes);
  assert.equal(childSummary.parentCount, 1);
  assert.equal(childSummary.parents[0].id, PARENT_ID);
  assert.equal(childSummary.childCount, 0); // 子记忆自身视角：无 children 引用
  assert.equal(childSummary.isChildSession, true);
});

test('hierarchyRelationLabel 输出可读标签（不回显 [object Object]）', () => {
  assert.equal(hierarchyRelationLabel({ relation_type: 'custom', label: 'spawned_subagent' }), '派生自 Agent 子会话');
  assert.equal(hierarchyRelationLabel({ relation_type: 'derived_from' }), '派生自');
  assert.equal(hierarchyRelationLabel({ relation_type: 'custom', label: '自定义标签' }), '自定义标签');
  assert.notEqual(hierarchyRelationLabel(null), '[object Object]');
});

test('toChildMemoryItem 整理标题/时间/摘要，缺字段不伪造', () => {
  const item = toChildMemoryItem({ id: CHILD_ID, title: '子会话记忆', memory_type: 'episodic', created_at: '2026-11-13T00:00:00.000Z', body: '  a\n b  ' }, null);
  assert.equal(item.id, CHILD_ID);
  assert.equal(item.title, '子会话记忆');
  assert.equal(item.type, 'episodic');
  assert.equal(item.bodyPreview, 'a b');
  const fromNode = toChildMemoryItem(null, { id: CHILD_ID, label: '节点标签', type: 'semantic' });
  assert.equal(fromNode.title, '节点标签');
});
