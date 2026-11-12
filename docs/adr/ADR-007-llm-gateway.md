# ADR-007：LLM Gateway —— Provider 抽象 + 本地密钥加密 + 最小上下文 + 离线队列

- 状态：已接受（2026-11-12）
- 决策者：Lead（架构）
- 关联：ARCHITECTURE.md §4、PUBLIC_INTERFACE_FREEZE.md §4

## 背景

LLM 继续通过 API 调用且模型必须可替换；默认禁止上传全库/全日志/全关系图/未经选择的个人数据；API Key 不得硬编码或写入普通日志；API 断开时本地功能不受影响且不得伪装成功。

## 决策

1. **Provider 抽象**：`Provider` 接口 `{ id, kind: 'deepseek'|'openai-compatible'|'custom', baseUrl, model, timeoutMs, chat(messages, opts) }`；配置存 `llm_providers` 表，支持多个 Provider 与默认选择。
2. **最小上下文**：调用前由 Runtime 本地检索（全文+语义）选 top-K 记忆，按字段白名单与 token 预算裁剪（标题/正文摘要/时间/来源/可信度），附带“数据来源与筛选说明”；绝不整库上传；上下文构造器可配置预算与字段。
3. **密钥安全**：API Key 用 AES-256-GCM 加密存储，主密钥文件位于数据目录 `secrets/master.key` 并限制 ACL（仅当前用户）；日志/错误/响应一律掩码（`sk-***abcd`）；支持通过 Desktop 设置写入，不落盘明文。
4. **离线队列**：API 不可达时请求写 `event_queue`（状态 queued/未处理），SSE 通知客户端；恢复后按退避重试；每步状态与失败原因可查；绝不返回伪造的模型输出。
5. **可替换性**：更换 Provider/模型不影响记忆、身份、布局、认知状态；不把模型特定字段写入记忆主数据。

## 后果

- 用户可本地浏览/编辑/星图完全不依赖 API。
- 需要在 API 调用链路中加入预算与脱敏测试（QA 覆盖“默认不上传全库”的断言）。
