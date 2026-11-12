// 回归测试：父进程/管道关闭导致的 EPIPE 不得让 Runtime 进入 uncaughtException 死循环。
// 背景 bug：桌面 app 被强杀后，Runtime 继承的 stderr 管道关闭；logger.stderr.write 异步触发
// 'error' 事件，无监听 → uncaughtException → logger 再写 stderr → 无限 EPIPE 刷屏，
// 事件循环被日志占满，/health 超时（2026-11-12 22:16 实际故障）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLogger } from '../src/logging/index.js';
import { isBrokenPipeError } from '../src/runtime.js';

function tmpLogsDir() {
  // 本机 DSH 工具 shell 是 Low IL，%TEMP% 不可写；优先使用仓库内 .cache 或环境变量指定目录。
  const root = process.env.FCA_TEST_TMP_ROOT || path.join(process.cwd(), '.cache', 'test-tmp');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'fca-log-'));
}

test('isBrokenPipeError: 识别 EPIPE / broken pipe / ECONNRESET', () => {
  assert.equal(isBrokenPipeError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })), true);
  assert.equal(isBrokenPipeError(new Error('EPIPE: broken pipe, write')), true);
  assert.equal(isBrokenPipeError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true);
  assert.equal(isBrokenPipeError(new Error('boom')), false);
  assert.equal(isBrokenPipeError(null), false);
});

test('logger: stderr 触发 EPIPE error 后不再尝试写控制台，且文件日志继续写入', async () => {
  const logsDir = tmpLogsDir();
  const fakeStderr = new EventEmitter();
  fakeStderr.write = () => {
    // 真实 stream 在管道关闭后 write 会返回 false 并异步 emit('error')；这里模拟异步 error。
    process.nextTick(() => fakeStderr.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
    return false;
  };
  const config = { logLevel: 'info', paths: { logsDir } };
  const logger = createLogger({ config, stderr: fakeStderr, silent: false });
  assert.doesNotThrow(() => logger.info('before pipe break'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  // 管道已断：后续日志不得抛错、不得反复写 stderr（consoleBroken 已置位）。
  let writeCalls = 0;
  fakeStderr.write = () => {
    writeCalls += 1;
    throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  };
  assert.doesNotThrow(() => logger.error('after pipe break', { detail: 'x' }));
  assert.equal(writeCalls, 0, 'EPIPE 后不应继续写 stderr');
  await logger.flush();
  const files = fs.readdirSync(logsDir).filter((f) => /^runtime-\d{8}\.log$/.test(f));
  assert.ok(files.length >= 1);
  const content = fs.readFileSync(path.join(logsDir, files[0]), 'utf8');
  assert.match(content, /after pipe break/);
  logger.close();
});

test('logger: silent=true 时完全不写 stderr（CLI quiet 模式）', () => {
  const logsDir = tmpLogsDir();
  const fakeStderr = new EventEmitter();
  let writes = 0;
  fakeStderr.write = () => {
    writes += 1;
    return true;
  };
  const logger = createLogger({ config: { logLevel: 'info', paths: { logsDir } }, stderr: fakeStderr, silent: true });
  logger.info('hello');
  logger.error('oops');
  assert.equal(writes, 0);
  logger.close();
});
