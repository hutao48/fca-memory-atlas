/**
 * DSH 插件纯函数单测（真实模块导入，不 mock）：
 *  - logger.createRedactor：Bearer / sk-* / Authorization / secret 字段 / 自定义模式脱敏
 *  - logger.safeJson：不可序列化与截断
 *  - capture.eventTypesForPolicy：采集策略 → 事件类型映射
 *  - config.normalizeConfig：默认值、URL 校验、策略枚举、上限裁剪、非法值回退
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor, safeJson } from '../../../dsh_plugin/src/logger.js';
import { eventTypesForPolicy } from '../../../dsh_plugin/src/capture.js';
import { createAutoMemory } from '../../../dsh_plugin/src/auto-memory.js';
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
  const sk = r.redact('api key is sk-abcdefghijklmnopqrstuvwx done');
  assert.ok(!sk.includes('sk-abcdefghijklmnopqrstuvwx'), sk);
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
  assert.equal(PLUGIN_VERSION, '0.1.4');
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

