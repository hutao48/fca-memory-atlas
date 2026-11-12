/**
 * Unity ↔ Electron 选中同步纯函数单测（node:test）
 * 运行：vendor\node\node.exe --test tests\unit\desktop\unity-selection.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, '..', '..', '..', 'desktop', 'renderer', 'lib', 'unity-selection.js'), 'utf8');
const mod = await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`);
const {
  buildUnityCommandMessage,
  buildUnitySelectCommand,
  parseUnityCommand,
  parseUnitySelectMessage,
  shouldAcceptUnitySelection,
  UNITY_COMMAND_MESSAGE,
  UNITY_SELECT_MESSAGE,
} = mod;

const MEM = 'mem_<redacted>';
const ENT = 'ent_11112222333344445555666677778888';

test('常量契约', () => {
  assert.equal(UNITY_SELECT_MESSAGE, 'fca-unity-select');
  assert.equal(UNITY_COMMAND_MESSAGE, 'fca-unity-command');
});

test('parseUnitySelectMessage：payload 包裹形态', () => {
  const parsed = parseUnitySelectMessage({
    type: 'fca-unity-select',
    payload: { id: MEM, kind: 'memory', title: '记忆标题', memoryType: 'episodic', arm: 'FCA', importance: 0.8, selected: true },
  });
  assert.equal(parsed.clear, false);
  assert.equal(parsed.id, MEM);
  assert.equal(parsed.kind, 'memory');
  assert.equal(parsed.title, '记忆标题');
  assert.equal(parsed.memoryType, 'episodic');
  assert.equal(parsed.arm, 'FCA');
});

test('parseUnitySelectMessage：扁平形态 + entity 前缀推断', () => {
  const parsed = parseUnitySelectMessage({ type: 'fca-unity-select', id: ENT, selected: true });
  assert.equal(parsed.kind, 'entity');
  assert.equal(parsed.id, ENT);
});

test('parseUnitySelectMessage：clear / 取消选中变体', () => {
  assert.equal(parseUnitySelectMessage({ type: 'fca-unity-select', payload: { clear: true } }).clear, true);
  assert.equal(parseUnitySelectMessage({ type: 'fca-unity-select', payload: { id: null, selected: false } }).clear, true);
  assert.equal(parseUnitySelectMessage({ type: 'fca-unity-select', id: '', selected: false }).clear, true);
  assert.equal(parseUnitySelectMessage(null), null);
});

test('buildUnitySelectCommand / parseUnityCommand 往返', () => {
  assert.equal(buildUnitySelectCommand(MEM), `select:${MEM}`);
  assert.equal(buildUnitySelectCommand(null), 'select:clear');
  assert.equal(buildUnitySelectCommand(''), 'select:clear');
  assert.deepEqual(parseUnityCommand(`select:${MEM}`), { verb: 'select', id: MEM });
  assert.deepEqual(parseUnityCommand('select:clear'), { verb: 'select', id: null });
  assert.deepEqual(parseUnityCommand('view:1'), { verb: 'view:1', id: null });
});

test('buildUnityCommandMessage 形状（跨源 postMessage 契约）', () => {
  assert.deepEqual(buildUnityCommandMessage(`select:${MEM}`), { type: 'fca-unity-command', command: `select:${MEM}` });
});

test('shouldAcceptUnitySelection：当前已选中同一 id → 拒绝（防循环）', () => {
  const verdict = shouldAcceptUnitySelection({
    incoming: { clear: false, id: MEM },
    currentPrimaryId: MEM,
    now: 10000,
  });
  assert.equal(verdict.accept, false);
  assert.equal(verdict.reason, 'same-as-current');
});

test('shouldAcceptUnitySelection：忽略 Electron 刚发出命令的回声', () => {
  const verdict = shouldAcceptUnitySelection({
    incoming: { clear: false, id: MEM },
    currentPrimaryId: 'mem_other',
    lastSentId: MEM,
    lastSentAt: 9000,
    now: 10000,
    echoWindowMs: 1500,
  });
  assert.equal(verdict.accept, false);
  assert.equal(verdict.reason, 'echo-of-own-command');
});

test('shouldAcceptUnitySelection：回声窗口过期后可接受', () => {
  const verdict = shouldAcceptUnitySelection({
    incoming: { clear: false, id: MEM },
    currentPrimaryId: 'mem_other',
    lastSentId: MEM,
    lastSentAt: 1000,
    now: 20000,
  });
  assert.equal(verdict.accept, true);
});

test('shouldAcceptUnitySelection：用户真正切换节点 → 接受', () => {
  const verdict = shouldAcceptUnitySelection({
    incoming: { clear: false, id: MEM },
    currentPrimaryId: 'mem_other',
    lastSentId: 'mem_other',
    lastSentAt: 1000,
    now: 20000,
  });
  assert.equal(verdict.accept, true);
  assert.equal(verdict.reason, 'ok');
});

test('shouldAcceptUnitySelection：clear 事件不触发右栏清空', () => {
  const verdict = shouldAcceptUnitySelection({ incoming: { clear: true, id: null }, currentPrimaryId: MEM, now: 20000 });
  assert.equal(verdict.accept, false);
  assert.equal(verdict.reason, 'clear');
});

test('shouldAcceptUnitySelection：短时间重复同一事件被节流', () => {
  const verdict = shouldAcceptUnitySelection({
    incoming: { clear: false, id: MEM },
    currentPrimaryId: 'mem_other',
    lastAcceptedId: MEM,
    lastAcceptedAt: 9000,
    now: 9020,
    throttleMs: 80,
  });
  assert.equal(verdict.accept, false);
  assert.equal(verdict.reason, 'throttled-duplicate');
});
