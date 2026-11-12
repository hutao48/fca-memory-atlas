/**
 * DSH 插件纯函数单测（真实模块导入，不 mock）：
 *  - logger.createRedactor：Bearer / sk-* / Authorization / secret 字段 / 自定义模式脱敏
 *  - logger.safeJson：不可序列化与截断
 *  - capture.eventTypesForPolicy：采集策略 → 事件类型映射
 *  - config.normalizeConfig：默认值、URL 校验、策略枚举、上限裁剪、非法值回退
 *  - workspace：SessionHeader.cwd → workspace:<label> 归属（优先 header → cwd → meta → process.cwd()）
 *  - auto-memory：用户消息 / Agent 思考节点（turn/end 聚合、分节、脱敏、去重、限流）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor, safeJson } from '../../../dsh_plugin/src/logger.js';
import { eventTypesForPolicy } from '../../../dsh_plugin/src/capture.js';
import { createAutoMemory } from '../../../dsh_plugin/src/auto-memory.js';
import {
  resolveWorkspace,
  workspaceLabelFromCwd,
  workspaceTagName,
  workspaceProjectName,
} from '../../../dsh_plugin/src/workspace.js';
import { describeSessionScope, isChildSession } from '../../../dsh_plugin/src/session-scope.js';
import {
  formatAgentTurnBody,
  messageContentParts,
  summarizeToolArguments,
  summarizeToolResult,
} from '../../../dsh_plugin/src/agent-nodes.js';
import {
  normalizeConfig,
  defaultConfig,
  CAPTURE_POLICIES,
  PLUGIN_VERSION,
  CLIENT_ID,
  DEFAULT_RUNTIME_URL,
} from '../../../dsh_plugin/src/config.js';

const fakeLogger = { calls: [], warn(msg, fields) { this.calls.push([msg, fields]); } };
function redactor(patterns = []) {
  return createRedactor(patterns, fakeLogger);
}

test('plugin/logger: Bearer token / sk-key / Authorization / secret 字段脱敏', () => {
  const r = redactor();
  // authorization-header 规则会整体替换（丢弃 key 前缀），保证 secret 绝不出现在输出中
  assert.equal(r.redact('Authorization: Bearer abcdefghijklmnop'), '[redacted]');
  assert.equal(r.redact('token=Bearer abcdefghijklmnop'), 'token=[redacted]');
  const sk = r.redact('api key is sk-test-placeholder-not-a-real-key done');
  assert.ok(!sk.includes('sk-test-placeholder-not-a-real-key'), sk);
  assert.ok(sk.includes('[redacted]'));
  const header = r.redact('{"authorization":"Bearer top-secret-token","content-type":"application/json"}');
  assert.ok(!header.includes('top-secret-token'), header);
  assert.ok(header.includes('application/json'), '非敏感字段应保留');
  const secretField = r.redact('{"api_key":"sk-abcdefghijklmnop","token":"abcdef123456","safe":"keep"}');
  assert.ok(!secretField.includes('sk-abcdefghijklmnop'), secretField);
  assert.ok(!secretField.includes('abcdef123456'), secretField);
  assert.ok(secretField.includes('"safe":"keep"'), secretField);
  // 多次调用不受全局正则 lastIndex 影响
  assert.equal(r.redact('Bearer 1234567890abcdef'), r.redact('Bearer 1234567890abcdef'));
});

test('plugin/logger: 非字符串输入返回空串；空串原样返回', () => {
  const r = redactor();
  assert.equal(r.redact(null), '');
  assert.equal(r.redact(undefined), '');
  assert.equal(r.redact(12345), '');
  assert.equal(r.redact(''), '');
  assert.equal(r.redact('plain text 没有秘密'), 'plain text 没有秘密');
});

test('plugin/logger: 自定义 redactPatterns 生效，非法正则被忽略并 warn', () => {
  const r = redactor(['QA-SECRET-[0-9]+']);
  assert.equal(r.redact('值 QA-SECRET-12345 结束'), '值 [redacted] 结束');
  const invalid = redactor(['([', 'X-[A-Z]+']);
  assert.equal(invalid.redact('X-ABC'), '[redacted]');
  assert.ok(fakeLogger.calls.some(([msg]) => String(msg).includes('invalid redactPatterns')), '非法正则应记录 warn');
  assert.deepEqual(r.patterns, ['bearer', 'sk-key', 'authorization-header', 'secret-field', 'config-0']);
});

test('plugin/logger: safeJson 截断与不可序列化保护', () => {
  assert.equal(safeJson({ a: 1 }), '{"a":1}');
  const long = safeJson({ text: 'x'.repeat(300) }, 50);
  assert.ok(long.length <= 51);
  assert.ok(long.endsWith('…'));
  const circular = {};
  circular.self = circular;
  assert.equal(safeJson(circular), '[unserializable]');
  assert.equal(safeJson(undefined), 'undefined');
});

test('plugin/capture: 采集策略 → 事件类型映射（off 最安全，full 最全）', () => {
  assert.deepEqual(eventTypesForPolicy('off'), []);
  assert.deepEqual(eventTypesForPolicy('user-messages'), ['user/message']);
  assert.deepEqual(eventTypesForPolicy('turn-summaries'), ['turn/end']);
  assert.deepEqual(eventTypesForPolicy('full'), ['user/message', 'assistant/message', 'turn/end', 'tool/call', 'tool/result']);
  assert.deepEqual(eventTypesForPolicy('unknown-policy'), []);
  assert.deepEqual(eventTypesForPolicy(undefined), []);
  // 返回副本：外部修改不污染内部映射
  const list = eventTypesForPolicy('full');
  list.push('hacked');
  assert.deepEqual(eventTypesForPolicy('full'), ['user/message', 'assistant/message', 'turn/end', 'tool/call', 'tool/result']);
});

test('plugin/config: 默认配置完整且与契约常量一致', () => {
  assert.equal(PLUGIN_VERSION, '0.2.1');
  assert.equal(CLIENT_ID, 'dsh-plugin');
  assert.equal(DEFAULT_RUNTIME_URL, 'http://127.0.0.1:17860');
  assert.deepEqual(CAPTURE_POLICIES, ['off', 'user-messages', 'turn-summaries', 'full']);
  const defaults = defaultConfig();
  assert.equal(defaults.runtimeUrl, DEFAULT_RUNTIME_URL);
  assert.equal(defaults.capturePolicy, 'turn-summaries');
  assert.equal(defaults.autoStartRuntime, true);
  assert.equal(defaults.injectContext, false);
  assert.equal(defaults.maxEventBytes, 8192);
  assert.equal(defaults.logLevel, 'info');
  // v0.1.2：自动记忆默认关闭（安全默认），可在 bundle config 中打开
  assert.equal(defaults.autoMemory, 'off');
  assert.equal(defaults.autoMemoryMemoryType, 'episodic');
  assert.deepEqual(defaults.autoMemoryTags, ['DSH自动记忆']);
  // v0.2：Agent 思考节点默认关闭以保持向后兼容；交付 bundle 的 cordis.patch.yml 默认开启 summary
  assert.equal(defaults.autoMemoryAgentNodes, 'off');
  assert.equal(defaults.autoMemoryAgentMaxToolNodes, 8);
  assert.equal(defaults.autoMemoryAgentReasoningChars, 1500);
  assert.equal(defaults.autoMemoryAgentConclusionChars, 800);
  assert.equal(defaults.autoMemoryAgentToolArgChars, 400);
  assert.equal(defaults.autoMemoryAgentToolResultChars, 600);
  assert.equal(defaults.autoMemoryAgentMaxChars, 12000);
  assert.equal(defaults.autoMemoryAgentMaxPerHour, 60);
});

test('plugin/config: normalizeConfig 校验 URL / 策略枚举 / 整数上限 / 未知字段忽略', () => {
  const config = normalizeConfig({
    runtimeUrl: 'http://127.0.0.1:17999/',
    capturePolicy: 'off',
    maxEventBytes: 10 * 1024 * 1024,
    eventQueueLimit: 999999,
    logLevel: 'nonsense',
    redactPatterns: ['SECRET-\\d+', '', 42, null],
    unknownField: 'ignored',
  });
  assert.equal(config.runtimeUrl, 'http://127.0.0.1:17999');
  assert.equal(config.capturePolicy, 'off');
  assert.ok(config.maxEventBytes <= 1024 * 1024, `maxEventBytes 应被裁剪：${config.maxEventBytes}`);
  assert.ok(config.eventQueueLimit <= 5000, `eventQueueLimit 应被裁剪：${config.eventQueueLimit}`);
  assert.equal(config.logLevel, 'info', '非法 logLevel 回退默认值');
  assert.deepEqual(config.redactPatterns, ['SECRET-\\d+'], 'redactPatterns 仅保留非空字符串');
  assert.equal(config.unknownField, undefined);
  assert.throws(() => normalizeConfig({ runtimeUrl: 'ws://127.0.0.1:1' }), /http/);
  assert.throws(() => normalizeConfig({ runtimeUrl: 'not-a-url' }), /http/);
  assert.throws(() => normalizeConfig({ capturePolicy: 'everything' }), /capturePolicy/);
  // 非对象输入按默认值处理，不抛错
  const fallback = normalizeConfig(null);
  assert.equal(fallback.runtimeUrl, DEFAULT_RUNTIME_URL);
});

test('plugin/config: 布尔/整数字段类型严格（字符串 "true" 不应被当真）', () => {
  const config = normalizeConfig({ autoStartRuntime: 'true', injectContext: 'yes', startTimeoutMs: '5000', maxEventBytes: 0 });
  const defaults = defaultConfig();
  assert.equal(config.autoStartRuntime, defaults.autoStartRuntime, '字符串布尔应回退默认');
  assert.equal(config.injectContext, defaults.injectContext);
  assert.equal(config.startTimeoutMs, defaults.startTimeoutMs, '字符串整数应回退默认');
  assert.equal(config.maxEventBytes, defaults.maxEventBytes, '0 不是正整数应回退默认');
});

test('plugin/config: 自动记忆（autoMemory）配置校验与裁剪', () => {
  const config = normalizeConfig({
    autoMemory: 'user-messages',
    autoMemoryMinChars: 5,
    autoMemoryMaxChars: 500,
    autoMemoryMaxPerHour: 30,
    autoMemoryMemoryType: 'semantic',
    autoMemoryTags: ['A', ' B ', '', 42, null],
  });
  assert.equal(config.autoMemory, 'user-messages');
  assert.equal(config.autoMemoryMinChars, 5);
  assert.equal(config.autoMemoryMaxChars, 500);
  assert.equal(config.autoMemoryMaxPerHour, 30);
  assert.equal(config.autoMemoryMemoryType, 'semantic');
  assert.deepEqual(config.autoMemoryTags, ['A', 'B'], '仅保留非空字符串标签');
  assert.throws(() => normalizeConfig({ autoMemory: 'every-message' }), /autoMemory/);
  const fallback = normalizeConfig({ autoMemoryMemoryType: 'made-up' });
  assert.equal(fallback.autoMemoryMemoryType, 'episodic', '非法 memory_type 回退 episodic');
});

test('plugin/config: Agent 思考节点配置校验与上限裁剪', () => {
  const config = normalizeConfig({
    autoMemoryAgentNodes: 'summary',
    autoMemoryAgentMaxToolNodes: 99,
    autoMemoryAgentReasoningChars: 5000,
    autoMemoryAgentConclusionChars: 900,
    autoMemoryAgentToolArgChars: 120,
    autoMemoryAgentToolResultChars: 240,
    autoMemoryAgentMaxChars: 9000,
    autoMemoryAgentMaxPerHour: 12,
  });
  assert.equal(config.autoMemoryAgentNodes, 'summary');
  assert.equal(config.autoMemoryAgentMaxToolNodes, 32, '工具条数上限 32');
  assert.equal(config.autoMemoryAgentReasoningChars, 5000);
  assert.equal(config.autoMemoryAgentConclusionChars, 900);
  assert.equal(config.autoMemoryAgentToolArgChars, 120);
  assert.equal(config.autoMemoryAgentToolResultChars, 240);
  assert.equal(config.autoMemoryAgentMaxChars, 9000);
  assert.equal(config.autoMemoryAgentMaxPerHour, 12);
  assert.throws(() => normalizeConfig({ autoMemoryAgentNodes: 'full' }), /autoMemoryAgentNodes/);
  // 非法字符串/0 回退默认值（类型严格）
  const fallback = normalizeConfig({ autoMemoryAgentNodes: 42, autoMemoryAgentMaxToolNodes: '8', autoMemoryAgentMaxChars: 0 });
  assert.equal(fallback.autoMemoryAgentNodes, 'off');
  assert.equal(fallback.autoMemoryAgentMaxToolNodes, 8);
  assert.equal(fallback.autoMemoryAgentMaxChars, 12000);
});

// ---------------------------------------------------------------- auto memory

function autoMemoryHarness(overrides = {}) {
  const calls = [];
  const loggerCalls = [];
  const config = normalizeConfig({
    autoMemory: 'user-messages',
    autoMemoryMinChars: 5,
    autoMemoryMaxChars: 2000,
    autoMemoryMaxPerHour: 120,
    autoMemoryMemoryType: 'episodic',
    autoMemoryTags: ['DSH自动记忆'],
    ...overrides,
  });
  const harness = {
    calls,
    loggerCalls,
    config,
    state: { connected: true },
    client: {
      async storeMemory(payload) {
        calls.push(payload);
        return { ok: true, status: 201, data: { memory: { id: 'mem_test' } } };
      },
    },
    logger: {
      debug: (msg, fields) => loggerCalls.push(['debug', msg, fields]),
      warn: (msg, fields) => loggerCalls.push(['warn', msg, fields]),
      info: () => {},
      error: () => {},
    },
    redactor: { redact: (text) => String(text).replace(/sk-[A-Za-z0-9]+/g, '[redacted]') },
  };
  harness.auto = createAutoMemory({
    config: harness.config,
    logger: harness.logger,
    client: harness.client,
    redactor: harness.redactor,
    state: harness.state,
  });
  return harness;
}

function userEvent(seq, text, sourceKind = 'user') {
  return { type: 'user/message', seq, data: { content: [{ type: 'text', text }], source: { kind: sourceKind } } };
}

function assistantEvent(seq, text) {
  return {
    type: 'assistant/message',
    seq,
    data: { message: { content: [{ type: 'text', text }], source: { kind: 'model' } } },
  };
}

test('plugin/auto-memory: 用户消息自动转成真实记忆（标题/正文/来源/标签/类型）', async () => {
  const h = autoMemoryHarness();
  const session = { id: 'sess_auto_0001' };
  h.auto.handle(session, userEvent(7, '我下周三要去杭州出差，和产品团队开会'));
  assert.equal(h.auto.stats().counters.seen, 1);
  assert.equal(h.auto.stats().counters.captured, 1);
  await h.auto.flushNow();
  assert.equal(h.calls.length, 1, '应调用一次 memory/store');
  const payload = h.calls[0];
  assert.ok(payload.title.includes('杭州'), payload.title);
  assert.ok(payload.body.includes('杭州'));
  assert.equal(payload.memory_type, 'episodic');
  assert.equal(payload.origin, 'agent');
  assert.equal(payload.source.type, 'agent');
  assert.equal(payload.source.ref, 'dsh-plugin');
  assert.ok(payload.source.note.includes('sess_aut'), 'source.note 需带会话标识');
  assert.ok(payload.tags.includes('DSH自动记忆'));
  assert.ok(payload.tags.includes('DSH用户消息'));
  assert.ok(payload.importance >= 0.3 && payload.importance <= 0.9);
  const stats = h.auto.stats();
  assert.equal(stats.counters.stored, 1);
  assert.equal(stats.queued, 0);
});

test('plugin/auto-memory: 短消息/重复消息/助手消息（user-messages 模式）被跳过；敏感信息脱敏', async () => {
  const h = autoMemoryHarness();
  const session = { id: 'sess_auto_0002' };
  h.auto.handle(session, userEvent(1, '好的')); // 太短
  assert.equal(h.auto.stats().counters.skippedShort, 1);
  h.auto.handle(session, assistantEvent(2, '这是助手的回复内容'));
  assert.equal(h.auto.stats().counters.seen, 1, 'user-messages 模式不应处理助手消息');
  h.auto.handle(session, userEvent(3, '我的 API key 是 sk-abcdefghijklmnop 请记住'));
  h.auto.handle(session, userEvent(3, '我的 API key 是 sk-abcdefghijklmnop 请记住')); // 重复 seq
  assert.equal(h.auto.stats().counters.skippedDuplicate, 1);
  await h.auto.flushNow();
  assert.equal(h.calls.length, 1);
  assert.ok(!h.calls[0].body.includes('sk-abcdefghijklmnop'), '敏感 key 必须脱敏');
  assert.ok(h.calls[0].body.includes('[redacted]'));
});

test('plugin/auto-memory: all 模式捕获助手消息；每时上限生效', async () => {
  const h = autoMemoryHarness({ autoMemory: 'all', autoMemoryMaxPerHour: 2 });
  const session = { id: 'sess_auto_0003' };
  h.auto.handle(session, assistantEvent(1, '助手消息一：项目里程碑已完成'));
  assert.equal(h.auto.stats().counters.captured, 1);
  h.auto.handle(session, userEvent(2, '消息二：明天继续'));
  assert.equal(h.auto.stats().counters.captured, 2);
  h.auto.handle(session, userEvent(3, '消息三：这条应被限流'));
  assert.equal(h.auto.stats().counters.skippedRate, 1);
  await h.auto.flushNow();
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls[0].tags.includes('DSH助手消息'));
});

test('plugin/auto-memory: 关闭状态不处理任何消息', () => {
  const h = autoMemoryHarness({ autoMemory: 'off' });
  h.auto.handle({ id: 'sess_auto_0004' }, userEvent(1, '这条消息不会被自动记忆捕获'));
  assert.equal(h.auto.stats().counters.seen, 0);
  assert.equal(h.auto.enabled, false);
});

test('plugin/auto-memory: 只采集真实用户消息（Host 注入的 user-role 消息全部跳过）', async () => {
  const h = autoMemoryHarness();
  const session = { id: 'sess_auto_0005' };
  const injected = [
    ['runtime-context', 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'],
    ['skill-catalog', '<system-reminder>可用技能列表…</system-reminder>'],
    ['time-context', 'Time sampled while preparing turn 1, step 1: 2026-11-12T18:36:50+09:00'],
    ['tool-jobs', 'background job pwsh-443f75f770074caf finished'],
    ['agent-message', 'Team message from desktop-app: 进度同步'],
    ['user-approval', 'The user changed the approval policy'],
  ];
  injected.forEach(([kind, text], index) => h.auto.handle(session, userEvent(index + 1, text, kind)));
  assert.equal(h.auto.stats().counters.captured, 0, '注入消息不得自动写记忆');
  assert.equal(h.auto.stats().counters.skippedNonText, injected.length);
  h.auto.handle(session, userEvent(20, '这是用户自己输入的真实消息，应该被自动记忆', 'user'));
  assert.equal(h.auto.stats().counters.captured, 1);
  await h.auto.flushNow();
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0].body.includes('用户自己输入'));
});

// ------------------------------------------------- workspace（v0.2 工作区归属）

test('plugin/workspace: SessionHeader.cwd 推断工作区标签（优先级/回退/不抛错）', () => {
  // 优先 session.header.cwd（DSH Session 的真实不可变 header）
  assert.deepEqual(resolveWorkspace({ id: 's1', header: { cwd: 'D:\\FCA' } }), {
    cwd: 'D:\\FCA',
    label: 'FCA',
    source: 'session.header.cwd',
  });
  // header 优先于 session.cwd
  assert.equal(resolveWorkspace({ header: { cwd: 'D:\\A' }, cwd: 'D:\\B' }).label, 'A');
  // 回退 session.cwd / session.meta.cwd；POSIX 路径同样可用
  assert.equal(resolveWorkspace({ cwd: '/home/user/project-x' }).label, 'project-x');
  assert.equal(resolveWorkspace({ meta: { cwd: 'C:\\Work\\Alpha' } }).label, 'Alpha');
  // 无 cwd 时回退 process.cwd()（注入 proc 以便测试）
  assert.deepEqual(resolveWorkspace({}, { proc: { cwd: () => 'D:\\Fallback\\WS' } }), {
    cwd: 'D:\\Fallback\\WS',
    label: 'WS',
    source: 'process.cwd',
  });
  // 完全拿不到 cwd → default，不抛错
  assert.equal(resolveWorkspace({}, { proc: { cwd: () => '' } }).label, 'default');
  assert.equal(resolveWorkspace(null).label.length > 0, true);
  // 标签/标签名/项目名
  assert.equal(workspaceLabelFromCwd('D:\\FCA\\'), 'FCA');
  assert.equal(workspaceLabelFromCwd('  '), '');
  assert.equal(workspaceTagName('FCA'), 'workspace:FCA');
  assert.equal(workspaceTagName(''), 'workspace:default');
  assert.equal(workspaceProjectName('FCA'), 'FCA 工作区');
  assert.equal(workspaceProjectName('default'), '');
});

test('plugin/session-scope: 真实 SessionHeader 形状 → root / child 判定（v0.2.1）', () => {
  // 真实根会话（session-d9ea76db… 实测）：无 parentSession/origin，delegationDepth=0
  const root = {
    id: 'session-d9ea76db-0089-45d3-9daf-647fb4c19f4a',
    header: { id: 'session-d9ea76db-0089-45d3-9daf-647fb4c19f4a', cwd: 'D:\\FCA', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' },
  };
  assert.deepEqual(describeSessionScope(root), {
    kind: 'root',
    reason: 'root',
    parentSession: '',
    origin: '',
    delegationDepth: 0,
  });
  assert.equal(isChildSession(root), false);
  // 真实子代理会话（c5ed45ae…/3c4e45fe… 实测）：parentSession + origin=subagent + delegationDepth=1
  const child = {
    id: 'c5ed45ae-32a1-4460-aee0-30c168797d5e',
    header: {
      id: 'c5ed45ae-32a1-4460-aee0-30c168797d5e',
      cwd: 'D:\\FCA',
      parentSession: 'session-d9ea76db-0089-45d3-9daf-647fb4c19f4a',
      isSeeded: false,
      origin: 'subagent',
      delegationDepth: 1,
      agentPreset: 'cordis',
    },
  };
  const childScope = describeSessionScope(child);
  assert.equal(childScope.kind, 'child');
  assert.equal(childScope.reason, 'parent-session');
  assert.equal(childScope.parentSession, 'session-d9ea76db-0089-45d3-9daf-647fb4c19f4a');
  assert.equal(isChildSession(child), true);
  // 单项回退：只有 origin / 只有 delegationDepth / 只有 parentSessionId（兼容字段）
  assert.equal(describeSessionScope({ header: { origin: 'subagent' } }).reason, 'origin-subagent');
  assert.equal(describeSessionScope({ header: { delegationDepth: 2 } }).reason, 'delegation-depth');
  assert.equal(describeSessionScope({ header: { parentSessionId: 'session-x' } }).reason, 'parent-session');
  assert.equal(describeSessionScope({ parentSession: 'session-x' }).kind, 'child');
  // 无 header / 空对象 / null → 按根会话处理（绝不因形状变化吞掉真实用户消息）
  assert.equal(describeSessionScope({ id: 's1' }).kind, 'root');
  assert.equal(describeSessionScope(null).kind, 'root');
  assert.equal(describeSessionScope(undefined).kind, 'root');
  // 被 forge/fork 出来的人类会话（seeded/fork 但无 lineage 字段）仍是根会话
  assert.equal(describeSessionScope({ header: { isSeeded: false, delegationDepth: 0, agentPreset: 'standard' } }).kind, 'root');
});

test('plugin/auto-memory: 子会话 user-role 消息被过滤（skippedChildSession），根会话真实用户消息不受影响', async () => {
  const h = autoMemoryHarness();
  const rootSession = { id: 'sess_root_scope', header: { cwd: 'D:\\FCA', isSeeded: false, delegationDepth: 0 } };
  const childSession = {
    id: 'sess_child_scope',
    header: {
      cwd: 'D:\\FCA',
      parentSession: 'sess_root_scope',
      isSeeded: false,
      origin: 'subagent',
      delegationDepth: 1,
    },
  };
  // 子会话 spawn prompt（真实形状：user/message + source.kind=user）不得写入
  h.auto.handle(childSession, userEvent(9, '<teammate 子会话启动提示词（测试夹具，已脱敏）>'));
  assert.equal(h.auto.stats().counters.skippedChildSession, 1);
  assert.equal(h.auto.stats().counters.captured, 0);
  // 根会话真实用户消息正常写入
  h.auto.handle(rootSession, userEvent(10, '这是一条根会话里的真实用户消息，应该被自动记忆'));
  assert.equal(h.auto.stats().counters.captured, 1);
  await h.auto.flushNow();
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0].body.includes('根会话里的真实用户消息'));
  const stats = h.auto.stats();
  assert.equal(stats.sessions.child, 1);
  assert.equal(stats.sessions.root, 1);
  assert.equal(stats.sessions.policy.includes('root human session only'), true);
});

test('plugin/auto-memory: 子会话的 Agent 思考节点仍然采集（只过滤 user 消息）', async () => {
  const h = agentHarness();
  const childSession = {
    id: 'sess_child_agent',
    header: { cwd: 'D:\\FCA', parentSession: 'sess_root_scope', isSeeded: false, origin: 'subagent', delegationDepth: 1 },
  };
  h.auto.handle(childSession, userEvent(9, '你是 teammate 启动提示词，不应写入消息记忆'));
  h.auto.handle(childSession, turnStartEvent(10, 1));
  h.auto.handle(childSession, assistantTurnEvent(11, 1, { reasoning: '子会话里的推理应进入 Agent 思考节点' }));
  h.auto.handle(childSession, toolCallEvent(12, 1, 'call_x', 'pwsh', { command: 'Get-Date' }));
  h.auto.handle(childSession, toolResultEvent(13, 1, 'call_x', '2026-11-12'));
  h.auto.handle(childSession, assistantTurnEvent(14, 1, { text: '子会话结论。' }));
  h.auto.handle(childSession, turnEndEvent(15, 1));
  await h.auto.flushNow();
  assert.equal(h.auto.stats().counters.skippedChildSession, 1);
  assert.equal(h.auto.stats().counters.captured, 0, '子会话 user 消息不写消息记忆');
  assert.equal(h.auto.stats().agentNodes.counters.captured, 1, '子会话 Agent 思考节点照常采集');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].memory_type, 'procedural');
  assert.ok(h.calls[0].tags.includes('Agent思考节点'));
  assert.ok(h.calls[0].body.includes('子会话里的推理应进入 Agent 思考节点'));
});

test('plugin/auto-memory: 用户消息记忆带 workspace:<label> 标签 / project / cwd 来源', async () => {
  const h = autoMemoryHarness();
  const session = { id: 'sess_ws_0001', header: { cwd: 'D:\\FCA\\FCA-Memory-Atlas' } };
  h.auto.handle(session, userEvent(1, '请记住：这个项目的星图按工作区分组显示'));
  await h.auto.flushNow();
  assert.equal(h.calls.length, 1);
  const payload = h.calls[0];
  assert.ok(payload.tags.includes('DSH自动记忆'));
  assert.ok(payload.tags.includes('DSH用户消息'));
  assert.ok(payload.tags.includes('workspace:FCA-Memory-Atlas'), JSON.stringify(payload.tags));
  assert.equal(payload.project.name, 'FCA-Memory-Atlas 工作区');
  assert.ok(payload.source.note.includes('D:\\FCA\\FCA-Memory-Atlas'), payload.source.note);
  const stats = h.auto.stats();
  assert.equal(stats.workspace.last.label, 'FCA-Memory-Atlas');
  assert.equal(stats.workspace.last.source, 'session.header.cwd');
  assert.ok(stats.workspace.known.some((item) => item.label === 'FCA-Memory-Atlas'));
});

// ------------------------------------------- Agent 思考节点（v0.2 turn/end 聚合）

function agentHarness(overrides = {}) {
  return autoMemoryHarness({ autoMemoryAgentNodes: 'summary', ...overrides });
}

function turnStartEvent(seq, turn) {
  return { type: 'turn/start', seq, data: { turn } };
}

function assistantTurnEvent(seq, turn, { reasoning, text, toolCalls } = {}) {
  const content = [];
  if (reasoning) content.push({ type: 'reasoning', text: reasoning });
  for (const call of toolCalls || []) {
    content.push({ type: 'tool-call', id: call.callId, name: call.name, arguments: JSON.stringify(call.arguments || {}) });
  }
  if (text) content.push({ type: 'text', text });
  return { type: 'assistant/message', seq, data: { turn, step: 1, message: { role: 'assistant', content } } };
}

function toolCallEvent(seq, turn, callId, name, args) {
  return {
    type: 'tool/call',
    seq,
    data: { turn, step: 1, callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
  };
}

function toolResultEvent(seq, turn, callId, text, isError = false) {
  return {
    type: 'tool/result',
    seq,
    data: {
      turn,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text }],
        isError,
      },
    },
  };
}

function turnEndEvent(seq, turn) {
  return { type: 'turn/end', seq, data: { turn, reason: { kind: 'completed' } } };
}

test('plugin/agent-nodes: 纯函数提取/摘要（reasoning/text/工具参数与结果）', () => {
  const parts = messageContentParts([
    { type: 'reasoning', text: '第一段推理' },
    { type: 'text', text: '可见回复' },
    { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{}' },
  ]);
  assert.equal(parts.reasoning, '第一段推理');
  assert.equal(parts.text, '可见回复');
  const redact = (value) => String(value).replace(/sk-[A-Za-z0-9]+/g, '[redacted]');
  const args = summarizeToolArguments('{"file_path":"docs/A.md","token":"sk-abcdefghijklmnop"}', { redact, maxChars: 400 });
  assert.ok(args.includes('file_path=docs/A.md'), args);
  assert.ok(!args.includes('sk-abcdefghijklmnop'), args);
  assert.ok(args.includes('[redacted]'));
  const result = summarizeToolResult(
    { toolCallId: 'call_1', content: [{ type: 'text', text: '结果 sk-abcdefghijklmnop 完成' }], isError: false },
    { redact, maxChars: 600 },
  );
  assert.equal(result.callId, 'call_1');
  assert.equal(result.isError, false);
  assert.ok(!result.summary.includes('sk-abcdefghijklmnop'));
  // 三节始终存在，无内容时给出真实占位
  const body = formatAgentTurnBody({ reasoning: '', toolNodes: [], totalToolCalls: 0, conclusion: '' });
  assert.ok(body.includes('【关键推理】') && body.includes('【工具执行】') && body.includes('【结论】'));
  assert.ok(body.includes('（本回合无推理文本）'));
  assert.ok(body.includes('（本回合未调用工具）'));
});

test('plugin/auto-memory: turn/end 聚合一条 Agent 思考节点记忆（分节/标签/类型/来源）', async () => {
  const h = agentHarness();
  const session = { id: 'sess_agent_0001', header: { cwd: 'D:\\FCA' } };
  h.auto.handle(session, turnStartEvent(1, 1));
  h.auto.handle(session, assistantTurnEvent(2, 1, { reasoning: '先读冻结契约，确认事件字段后再写解析。' }));
  h.auto.handle(session, toolCallEvent(3, 1, 'call_a', 'read', { file_path: 'docs/PUBLIC_INTERFACE_FREEZE.md' }));
  h.auto.handle(session, toolResultEvent(4, 1, 'call_a', '<path>冻结契约</path>'));
  h.auto.handle(session, assistantTurnEvent(5, 1, { reasoning: '工具结果确认事件字段名。' }));
  h.auto.handle(session, toolCallEvent(6, 1, 'call_b', 'pwsh', { command: 'Get-ChildItem' }));
  h.auto.handle(session, toolResultEvent(7, 1, 'call_b', 'Mode Name\r\n---- ----\r\nd----- src'));
  h.auto.handle(session, assistantTurnEvent(8, 1, { text: '勘察完成，下一步写解析器。' }));
  h.auto.handle(session, turnEndEvent(9, 1));

  const counters = h.auto.stats().agentNodes.counters;
  assert.equal(counters.eventsSeen, 9, 'turn/start + assistant*3 + tool/call*2 + tool/result*2 + turn/end');
  assert.equal(counters.turnsSeen, 1);
  assert.equal(counters.toolCallsSeen, 2);
  assert.equal(counters.toolResultsSeen, 2);
  assert.equal(counters.captured, 1);

  await h.auto.flushNow();
  assert.equal(h.calls.length, 1, '一轮只写一条聚合记忆');
  const payload = h.calls[0];
  assert.equal(payload.title, 'Agent 思考节点 · 第 1 回合');
  assert.equal(payload.memory_type, 'procedural');
  assert.equal(payload.importance, 0.55);
  assert.equal(payload.origin, 'agent');
  assert.equal(payload.source.type, 'agent');
  assert.equal(payload.source.ref, 'dsh-plugin');
  assert.ok(payload.source.note.includes('sess_age'), payload.source.note);
  assert.ok(payload.source.note.includes('第 1 回合'), payload.source.note);
  assert.ok(payload.source.note.includes('D:\\FCA'), payload.source.note);
  assert.deepEqual(payload.tags.slice(0, 3), ['Agent思考节点', 'workspace:FCA', 'DSH会话']);
  assert.equal(payload.project.name, 'FCA 工作区');
  assert.ok(payload.body.includes('【关键推理】'));
  assert.ok(payload.body.includes('先读冻结契约'));
  assert.ok(payload.body.includes('工具结果确认事件字段名'));
  assert.ok(payload.body.includes('【工具执行】'));
  assert.ok(payload.body.includes('read · 参数：file_path=docs/PUBLIC_INTERFACE_FREEZE.md'));
  assert.ok(payload.body.includes('冻结契约'));
  assert.ok(payload.body.includes('pwsh · 参数：command=Get-ChildItem'));
  assert.ok(payload.body.includes('【结论】'));
  assert.ok(payload.body.includes('勘察完成，下一步写解析器。'), '结论取该回合最后一条 assistant text');
  // 同一 session+turn 的重复 turn/end 去重（重复回合需要重新出现该 turn 的事件才会再次触发）
  h.auto.handle(session, assistantTurnEvent(10, 1, { reasoning: '重复的同一回合推理' }));
  h.auto.handle(session, turnEndEvent(11, 1));
  assert.equal(h.auto.stats().agentNodes.counters.skippedDuplicate, 1);
  assert.equal(h.auto.stats().agentNodes.counters.captured, 1);
});

test('plugin/auto-memory: Agent 思考节点脱敏、工具条数截断、失败结果标记', async () => {
  const h = agentHarness({ autoMemoryAgentMaxToolNodes: 2 });
  const session = { id: 'sess_agent_0002', header: { cwd: 'D:\\Work\\Qingyun' } };
  h.auto.handle(session, turnStartEvent(1, 2));
  h.auto.handle(session, assistantTurnEvent(2, 2, { reasoning: '密钥是 sk-abcdefghijklmnop，推理里也必须脱敏' }));
  for (let index = 0; index < 4; index += 1) {
    h.auto.handle(session, toolCallEvent(3 + index * 2, 2, `call_${index}`, `tool_${index}`, { token: `sk-secretsecretsecret${index}` }));
    h.auto.handle(session, toolResultEvent(4 + index * 2, 2, `call_${index}`, `结果 sk-abcdefghijklmnop ${index}`, index === 0));
  }
  h.auto.handle(session, assistantTurnEvent(20, 2, { text: '结论也带 sk-abcdefghijklmnop' }));
  h.auto.handle(session, turnEndEvent(21, 2));
  await h.auto.flushNow();
  assert.equal(h.calls.length, 1);
  const payload = h.calls[0];
  assert.ok(!payload.body.includes('sk-abcdefghijklmnop'), '敏感 key 必须脱敏');
  assert.ok(payload.body.includes('[redacted]'));
  assert.ok(payload.body.includes('tool_0') && payload.body.includes('tool_1'));
  assert.ok(!payload.body.includes('tool_2'), '超过 autoMemoryAgentMaxToolNodes 的工具不渲染');
  assert.ok(payload.body.includes('本回合共 4 个工具调用，正文仅保留前 2 个'));
  assert.ok(payload.body.includes('结果（失败）：'), 'isError=true 的结果需标注失败');
  assert.ok(payload.tags.includes('workspace:Qingyun'));
});

test('plugin/auto-memory: Agent 思考节点 off / 空 turn / 限流', async () => {
  // 默认 off：不缓冲、不写
  const off = autoMemoryHarness();
  const offSession = { id: 'sess_agent_off', header: { cwd: 'D:\\FCA' } };
  off.auto.handle(offSession, turnStartEvent(1, 1));
  off.auto.handle(offSession, assistantTurnEvent(2, 1, { reasoning: '不应被记录' }));
  off.auto.handle(offSession, turnEndEvent(3, 1));
  assert.equal(off.auto.stats().agentNodes.counters.eventsSeen, 0);
  assert.equal(off.calls.length, 0);
  assert.equal(off.auto.stats().agentNodes.enabled, false);

  // 空 turn：不写记忆
  const empty = agentHarness();
  const emptySession = { id: 'sess_agent_empty', header: { cwd: 'D:\\FCA' } };
  empty.auto.handle(emptySession, turnStartEvent(1, 1));
  empty.auto.handle(emptySession, turnEndEvent(2, 1));
  await empty.auto.flushNow();
  assert.equal(empty.calls.length, 0);
  assert.equal(empty.auto.stats().agentNodes.counters.skippedEmpty, 1);

  // 每小时限流
  const limited = agentHarness({ autoMemoryAgentMaxPerHour: 1 });
  const limitedSession = { id: 'sess_agent_rate', header: { cwd: 'D:\\FCA' } };
  for (const turn of [1, 2]) {
    limited.auto.handle(limitedSession, assistantTurnEvent(turn * 2, turn, { reasoning: `第 ${turn} 轮推理` }));
    limited.auto.handle(limitedSession, turnEndEvent(turn * 2 + 1, turn));
  }
  await limited.auto.flushNow();
  assert.equal(limited.calls.length, 1);
  assert.equal(limited.auto.stats().agentNodes.counters.skippedRate, 1);
  assert.equal(limited.auto.stats().lastError.code, 'AUTO_MEMORY_AGENT_RATE_LIMIT');
});

