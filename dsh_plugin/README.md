# dsh-plugin-fca-memory — FCA Memory Atlas 的 DSH 正式插件（bundle）

把本机 DeepSeek Harness（DSH）接进 **FCA Memory Atlas** 的本地认知服务：给 Agent 注册记忆检索/写入工具，**把你在任意 DSH 会话里输入的消息与 Agent 每回合的思考节点自动写成 FCA 记忆**并归到当前工作区的星云旋臂，把会话事件按安全策略回传 FCA Runtime，并可选地在系统提示里注入一小段记忆摘要。

- 产品：FCA Alpha 0.1 · Product B
- 插件版本：`0.3.1`
- 形态：Cordis **bundle**（`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml` + Host 入口 `main.js` 的 `export function apply(ctx, config)`）
- 依赖：DSH NEXT（Electron，实测 `dsh-desktop-next 2.0.22-next` / `@deepseek-ai/cordis 4.1.0` / loader `1.1.0`）+ 本机 FCA Local Runtime（`http://127.0.0.1:17860`，接口见 `docs/PUBLIC_INTERFACE_FREEZE.md`）
- 零第三方运行时依赖：只用 `node:` 内置模块（`node:http` 不直接用，HTTP 用 Host 自带的 `fetch`）

---

## 1. 安装

**唯一正确方式**是通过 DSH 的 plugin_manager（不要手改 profile 的 `package.json` / `cordis.patch.yml`）：

### 方式 A：直接安装本目录（开发/本机推荐，`link:` 方式）

```
plugin_manager action=install_bundle target=<本目录绝对路径>
# 例：target=D:\FCA\FCA-Memory-Atlas\dsh_plugin
```

安装器会：把本目录以 `link:` 依赖装进当前 profile、把 bundle 加入 `dsh.profile.bundles`、套用 `cordis.patch.yml` 的 insert 行（行 id = `fca-memory-bridge`）。
返回 `application: "applied"` 表示配置已生效；`warnings` 为空表示没有诊断。安装后可用：
- `cordis_inspect_query(host, Config, listConfigs{name:'dsh-plugin-fca-memory'})` 看行状态；
- `cordis_inspect_query(host, Tool, listTools)` 应能看到 `fca_status` / `fca_memory_search` / `fca_memory_store` / `fca_memory_get`；
- 在任意会话里让 Agent 调 `fca_status`。

> 如果返回 `restart-required`（`restartReason: "module-comparison"`）：说明 profile 里已加载过本插件的旧模块且磁盘文件已变化，DSH 拒绝热替换。处理：重启 DSH；或见 §7「升级」。

### 方式 B：从交付包 `.tgz` 安装（发布/分发用）

交付包：`artifacts/plugin/dsh-plugin-fca-memory-0.1.3.tgz`（npm pack 格式，内含 `package/` 前缀，共 16 个文件；SHA256 与字节数以 `artifacts/plugin/` 下实际产物为准，本次复测值记录在 `docs/DSH_PLUGIN_ENVIRONMENT_REPORT.md` §8.1）。

```powershell
# 1) 解包到本地任意目录（推荐放项目外或 vendor/ 下）
mkdir D:\FCA\fca-plugin-pkg
tar -xzf artifacts\plugin\dsh-plugin-fca-memory-0.1.3.tgz -C D:\FCA\fca-plugin-pkg
# 2) 用解包后的目录安装（仍然是 plugin_manager 安装，不要手改 profile）
plugin_manager action=install_bundle target=D:\FCA\fca-plugin-pkg\package
```

（plugin_manager 的 target 可以是包目录绝对路径、包名或安装 spec；本机实测目录方式可用。离线环境请沿用目录方式。）

### 校验安装结果

- 安装返回里 `application` 必须是 `applied`，`warnings: []`；
- `cordis_inspect_query(host, Tool, listTools)` 里出现 4 个 `fca_*` 工具；
- Host 日志 `%USERPROFILE%\.dsh\logs\desktop-next.log` 出现 `[fca-memory-bridge] plugin loaded` 与 `bridge started`；
- 让 Agent 调 `fca_status`，`runtime.reachable=true` 且 `api_version="1"`。


## 2. 前置条件

| 项 | 说明 |
|---|---|
| FCA Runtime | 默认 `http://127.0.0.1:17860`；首次运行会生成 `<FCA_HOME>/config/runtime-token` |
| FCA 数据目录 | `$FCA_HOME`，否则 `%LOCALAPPDATA%\FCA-Memory-Atlas` |
| Node（仅自动拉起时） | 需要 Node ≥ 22.5（`node:sqlite`）。探测顺序（第一个存在的胜出）：① `nodePath` 配置；② 环境变量 `FCA_NODE`（兼容旧 `FCA_NODE_PATH`）；③ **当前 DSH 安装目录自带 Node** `<DSH install>\resources\runtime\x64\primary-runtime\dependencies\node\bin\node.exe`（DSH NEXT 2.0.22 实测 v24.21.0；由 `process.resourcesPath`/`process.execPath` 推断，自动扫描 arch 目录）；④ 旧版 DSH 的 `%USERPROFILE%\.dsh\dsh-runtimes\*\dependencies\node\bin\node.exe`（DSH NEXT 2.0.22 已删除该目录，仅作兼容）；⑤ 项目 `vendor\node\node.exe`（仓库开发布局）；⑥ Host 进程本身 + `ELECTRON_RUN_AS_NODE=1`。`fca_status.local.nodePath/nodeSource` 会如实显示最终选中的路径与来源 |
| 自动拉起目标 | `<插件包>/../runtime/bin/fca-runtime.js`（即仓库内 `runtime/bin/fca-runtime.js`），可用 `runtimeScriptPath` 覆盖 |

Runtime 没起来时插件**不会假装连接成功**：`fca_status` 会显示 `phase: "unreachable"` / `lastError` 与「需先启动 Runtime」的操作建议。

## 3. 配置项

在 `cordis.patch.yml` 的 insert 行 `config:` 下设置（覆盖会替换整段 config，其余字段走默认值）。校验由 `Config`（Standard Schema v1）在激活前完成，非法值会以 `ValidationError` 拒绝加载。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `runtimeUrl` | string | `http://127.0.0.1:17860` | Runtime 源地址（http/https） |
| `fcaHome` | string | `""` | FCA 数据目录；空 = `$FCA_HOME`，再缺省 `%LOCALAPPDATA%\FCA-Memory-Atlas` |
| `tokenPath` | string | `""` | token 文件；空 = `<fcaHome>/config/runtime-token` |
| `autoStartRuntime` | boolean | `true` | Runtime 不可达时尝试拉起一次（不会循环重试、不用 shell） |
| `runtimeScriptPath` | string | `""` | 显式指定 `runtime/bin/fca-runtime.js` |
| `nodePath` | string | `""` | 显式指定 Node 可执行文件 |
| `startTimeoutMs` | integer | `15000` | 拉起后等待 `/health` 的上限 |
| `capturePolicy` | enum | `turn-summaries` | 审计事件采集策略：`off` / `user-messages` / `turn-summaries` / `full` |
| `autoMemory` | enum | `off`（bundle 配置为 `user-messages`） | **完全自动添加记忆**：`off` / `user-messages`（任意 DSH 会话里的真实用户消息自动写成记忆）/ `all`（用户 + 助手消息） |
| `autoMemoryMinChars` | integer | `8` | 自动记忆：短于该字符数的消息忽略 |
| `autoMemoryMaxChars` | integer | `2000` | 自动记忆：单条记忆正文上限 |
| `autoMemoryMaxPerHour` | integer | `120` | 自动记忆：每小时最多写入条数（硬限流） |
| `autoMemoryMemoryType` | enum | `episodic` | 自动记忆使用的 memory_type |
| `autoMemoryTags` | string[] | `["DSH自动记忆"]` | 自动记忆附带的标签（另会自动追加 `DSH用户消息` / `DSH助手消息` / `workspace:<label>`） |
| `autoMemoryAgentNodes` | enum | `off`（bundle 配置为 `summary`） | **Agent 思考节点**（v0.2）：`off` / `summary`（每回合结束聚合 1 条 procedural 记忆：关键推理 + 工具执行 + 结论） |
| `autoMemoryAgentMaxToolNodes` | integer | `8` | Agent 思考节点：单条记忆最多渲染的工具调用条数 |
| `autoMemoryAgentReasoningChars` | integer | `1500` | Agent 思考节点：关键推理摘要字数上限 |
| `autoMemoryAgentConclusionChars` | integer | `800` | Agent 思考节点：结论摘要字数上限 |
| `autoMemoryAgentToolArgChars` | integer | `400` | Agent 思考节点：单个工具参数摘要字数上限（脱敏后截断） |
| `autoMemoryAgentToolResultChars` | integer | `600` | Agent 思考节点：单个工具结果摘要字数上限（脱敏后截断） |
| `autoMemoryAgentMaxChars` | integer | `12000` | Agent 思考节点：聚合正文上限（需容纳推理+8 个工具节点+结论） |
| `autoMemoryAgentMaxPerHour` | integer | `60` | Agent 思考节点：每小时最多写入条数（独立于消息记忆的限流） |
| `autoMemorySubagentCapture` | enum | `off`（bundle 配置为 `summary`） | **子 Agent 会话全量采集**（v0.3）：`off` / `summary`（每个子会话每回合聚合 1 条 episodic 记忆：任务/关键推理/工具执行/结果/结论） |
| `autoMemorySubagentMaxToolNodes` | integer | `12` | 子 Agent 会话：单条记忆最多渲染的工具调用条数 |
| `autoMemorySubagentTaskChars` | integer | `1200` | 子 Agent 会话：spawn prompt/任务摘要字数上限 |
| `autoMemorySubagentReasoningChars` | integer | `1500` | 子 Agent 会话：关键推理摘要字数上限 |
| `autoMemorySubagentConclusionChars` | integer | `800` | 子 Agent 会话：结论摘要字数上限 |
| `autoMemorySubagentResultChars` | integer | `1000` | 子 Agent 会话：结果摘要字数上限 |
| `autoMemorySubagentToolArgChars` | integer | `400` | 子 Agent 会话：单个工具参数摘要上限（脱敏后） |
| `autoMemorySubagentToolResultChars` | integer | `600` | 子 Agent 会话：单个工具结果摘要上限（脱敏后） |
| `autoMemorySubagentMaxChars` | integer | `12000` | 子 Agent 会话：聚合正文上限 |
| `autoMemorySubagentMaxPerHour` | integer | `60` | 子 Agent 会话：每小时最多写入条数（独立限流） |
| `autoMemoryContextRecovery` | boolean | `false`（bundle 配置为 `true`） | **上下文压缩恢复**（v0.3）：注入常驻恢复指令 + 压缩后动态提醒（`systemPrompt` section/context），并监听真实 `compaction/*` 事件 |
| `autoMemoryContextRecoveryMaxChars` | integer | `900` | 上下文恢复提醒的最大字数 |
| `redactPatterns` | string[] | `[]` | 额外脱敏正则（内置 Bearer / `sk-*` / apikey / token 字段模式之外） |
| `injectContext` | boolean | `false` | 是否向系统提示注入记忆摘要 |
| `maxEventBytes` | integer | `8192` | 单个事件 payload 截断上限 |
| `eventQueueLimit` | integer | `200` | 本地待发队列上限（超出丢最旧并计数） |
| `requestTimeoutMs` | integer | `5000` | 单次 Runtime 请求超时 |
| `healthTimeoutMs` | integer | `1500` | 单次 `/health` 探针超时 |
| `connectIntervalMs` | integer | `30000` | 断线时重试 / 在线时刷新健康状态的周期 |
| `logLevel` | enum | `info` | `silent` / `error` / `info` / `debug` |

## 4. 给 Agent 的工具

| 工具 | 作用 | 对应契约 |
|---|---|---|
| `fca_status` | Runtime 可达性/版本/API 兼容、采集队列、提示注入状态、自动拉起结果、本地路径、最近错误（不含 token） | `/health` |
| `fca_memory_search` | 检索记忆（`query`、`mode`、`limit`、`memory_type`、`tags`、时间范围、`include_deleted`） | `POST /api/v1/memory/search` |
| `fca_memory_store` | 写入一条记忆（`title`、`body`、`memory_type`、`occurred_at`、`importance`、`tags`、`participants`、`project`、`source_note`），`origin=agent`、`source.ref=dsh-plugin` | `POST /api/v1/memory/store` |
| `fca_memory_get` | 按 id 读完整记忆 + 关系 + 版本数，可带 `version` 读历史版本 | `GET /api/v1/memory/{id}` |
| `fca_memory_context` | **上下文恢复**（v0.3）：按 workspace 返回最近记忆（含真实 `occurred_at`）、最近 Agent 思考节点、子 Agent 会话摘要、关键决策；压缩后/记不清时先调用它 | `GET /api/v1/memories`（本地过滤） |

工具输出统一为紧凑 JSON：`{ ok: true, ... }` 或 `{ ok: false, error: { code, message, trace_id? }, hint? }`。Runtime 不可达/未授权时不会抛出到 Host，只返回结构化失败并提示先启动 Runtime。

## 5. 会话事件采集（默认安全）

监听 Cordis 的 `session/event`（提交后事件流），按策略把事件映射成契约 §6 的 `agent.event_received` 审计事件，`POST /api/v1/event`：

| 策略 | 采集内容 |
|---|---|
| `off` | 不采集 |
| `user-messages` | 仅 `user/message` 的用户文本（脱敏+截断） |
| `turn-summaries`（默认） | 仅 `turn/end` 的回合号与结束原因（无正文） |
| `full` | `user/message`、`assistant/message`（文本）、`turn/end`、`tool/call`（只记工具名）、`tool/result`（错误码）。**不采集工具参数** |

事件信封示例（实际请求体）：

```json
{
  "schema_version": "1.0",
  "type": "agent.event_received",
  "ts": "2026-11-12T07:39:04.051Z",
  "actor": { "kind": "agent", "id": "agent:<sessionId>", "display": "DSH Agent" },
  "source": { "kind": "dsh-plugin", "id": "dsh-plugin", "version": "0.1.0" },
  "payload": { "dsh": { "event": "turn/end", "seq": 42, "session_id": "…" }, "turn": 3, "reason": "completed" },
  "trace_id": "trc_…",
  "client_event_id": "dsh:<sessionId>:42:turn/end"
}
```

- `client_event_id` 幂等：Runtime 可据此去重；
- 文本先脱敏（内置 + `redactPatterns`）再按 `maxEventBytes` 截断；
- 有界队列 + 最多 3 次退避重试 + 超限丢弃计数；任何异常都在插件内吞掉，**不会拖垮 DSH**；
- 采集是单向审计流，不是状态同步；不订阅 SSE（`/events/stream` 未使用）。

### 5.1 自动记忆（v0.1.3+，完全自动添加记忆）

`autoMemory` 打开后（交付 bundle 默认 `user-messages`），插件会把**你在任意 DSH 会话中输入的每条真实用户消息**自动写成一条真实 FCA 记忆（`POST /api/v1/memory/store`），桌面软件通过 SSE 实时看到新星体——无需你在会话里下任何"记住"指令，也不需要每个会话单独授权。

- **跨会话**：插件监听 Host 根作用域的 `session/event`，所有会话（包括之后新建的会话）都生效。
- **只收真实用户消息**：按 `user/message.data.source.kind === "user"` 过滤。Host 注入的 user-role 消息（runtime-context、skill-catalog、time-context、后台任务通知、Agent 消息转发、审批通知等）**不会**变成记忆。
- **只采人类根会话（v0.2.1）**：subagent/teammate 子会话的 spawn prompt 也是 `user/message` 且 `source.kind === "user"`（真实实测），但它们不是用户输入。插件按真实 `SessionHeader` 判定会话作用域——`parentSession`/`parentSessionId` 存在、`delegationDepth > 0` 或 `origin === "subagent"` 视为子会话，其 user 消息只计入 `auto_memory.counters.skippedChildSession`，不写记忆；人类根会话（无上述字段、`delegationDepth: 0`，如真实主会话 `session-…`）的真实用户消息不受影响，仍正常带 `workspace:<label>` 写入。**Agent 思考节点（turn/end 聚合）对子会话照常采集**（团队协作过程本身就是有价值的 Agent 过程记忆）。
- **工作区归属（v0.2）**：从真实 DSH `Session` 的 `session.header.cwd`（不可变 header，实测 DSH NEXT 2.0.22 格式 v4）推断工作区，回退 `session.cwd` / `session.meta.cwd`，最后回退 `process.cwd()`；取 basename 作为标签（如 `D:\FCA` → `workspace:FCA`）。`source.note` 记录完整 cwd（≤160 字符），`project` 设为 `<label> 工作区`（Runtime 自动 find-or-create 项目实体，星图/Unity 按 `workspace:*` 标签分组即得"一条旋臂"）。
- **生成内容**：`title`=消息首行（≤80 字）、`body`=脱敏后正文（≤`autoMemoryMaxChars`）、`memory_type`=`autoMemoryMemoryType`、`tags`=`autoMemoryTags`+角色标签+`workspace:<label>`、`source.note` 记录 DSH 会话 id 前缀、seq、工作区 label 与 cwd、`origin=agent`；每条都有版本历史，可在桌面软件编辑/删除。
- **安全与有界**：复用同一套密钥/令牌脱敏；队列有界、每时硬限流（`autoMemoryMaxPerHour`）、按 `session:seq:role` 与正文哈希去重；Runtime 离线时排队，恢复后重试（最多 3 次，超限丢弃并计数）。记忆只写入本机 `127.0.0.1` 的 FCA Runtime。
- **状态**：`fca_status.auto_memory` 返回 `mode/enabled/workspace{last,known}/sessions{root,child,policy}/counters{seen,captured,stored,failed,dropped,skippedShort,skippedDuplicate,skippedRate,skippedNonText,skippedChildSession}` 与 limits，便于核对是否在工作。
- **关闭**：把 `autoMemory` 设为 `off`（重装/更新插件配置后生效）。

已知边界：`autoMemory` 只写入"消息原文"级别的事实，不做 LLM 摘要/抽取；超长消息截断；重复内容 1 小时内只记一次；`user-messages` 模式不采集助手回复（需要时设 `all`）；只采人类根会话的 user 消息（子会话 spawn prompt 不写，v0.2.1）。

### 5.2 Agent 思考节点（v0.2，用户选择"更全"）

用户要求自动记忆**不只包含用户输入，还要包含 Agent 思考过程中的重要节点**（推理 + 工具调用要点 + 工具结果摘要）。实现方式：在内存里按 `session:turn` 缓冲一回合内的事件，`turn/end` 时聚合为 **1 条** `procedural` 记忆（避免每次工具调用都写一条淹没星图）：

| 事件（真实 DSH 事件形状） | 提取内容 |
|---|---|
| `assistant/message`（`data.message.content[]` 的 `reasoning` / `text` 块） | 关键推理（该回合前段，≤`autoMemoryAgentReasoningChars`）与最后一段可见文本（结论，≤`autoMemoryAgentConclusionChars`） |
| `tool/call`（`data.name` + `data.arguments` JSON 字符串） | 工具名 + 脱敏后的参数摘要（`key=value` 紧凑格式，≤`autoMemoryAgentToolArgChars`） |
| `tool/result`（`data.message.content[]` + `isError` + `toolCallId`） | 状态（成功/失败）+ 脱敏后的结果摘要（≤`autoMemoryAgentToolResultChars`），按 `callId` 关联回对应工具 |
| `turn/end` | 生成聚合并入队 |

生成的记忆：

- `title` = `Agent 思考节点 · 第 N 回合`；`memory_type` = `procedural`；`importance` = `0.55`；
- `body` 固定三节：`【关键推理】`（无内容时给真实占位）/`【工具执行】`（最多 `autoMemoryAgentMaxToolNodes` 条，每条 名称+参数摘要+结果摘要；超过时注明"共 N 个，正文仅保留前 M 个"）/`【结论】`；
- `tags` = `["Agent思考节点", "workspace:<label>", "DSH会话"]`；`project` = `<label> 工作区`；
- `source.note` = `Agent思考节点：DSH 会话 <id 前缀8> 第 N 回合，工作区 <label>；cwd=<完整路径 ≤160 字>`；`origin=agent`；
- **同一 session+turn 只写一次**（`turn/end` 重复/重放去重）；**只要有实际内容才写**（空回合跳过）；独立每时限流 `autoMemoryAgentMaxPerHour`；正文上限 `autoMemoryAgentMaxChars`；
- 工具参数/结果/推理/结论全部先经同一 `redactor` 脱敏再截断，敏感内容不会进记忆；日志只记录会话前缀/回合/工具数/字符数。

`fca_status.auto_memory.agentNodes` 返回 `mode/enabled/tag/memoryType/title/activeTurns/limits/counters{eventsSeen,turnsSeen,captured,stored,failed,dropped,skippedEmpty,skippedDuplicate,skippedRate,toolCallsSeen,toolResultsSeen}`，可直接核对采集是否在工作。

> 说明：`autoMemoryAgentNodes` 在 `config.js` 中默认 `off`（向后兼容旧配置），交付 bundle 的 `cordis.patch.yml` 默认 `summary`——安装本 bundle 即开启；若只想保留消息记忆，把该项改为 `off`。

### 5.3 子 Agent 会话全量采集与父子层级（v0.3）

用户要求"跟子 agent 之间的对话以及思考过程也得全部写进去，视觉上点开主 agent 的记忆节点拓展打开子 agent 记忆节点"。v0.3 对 **child 会话**（`session.header.parentSession` / `origin:"subagent"` / `delegationDepth>0`）按 `session+turn` 聚合：

- **采集内容**：spawn prompt（子会话首条 `source.kind="user"` 消息 = 任务）、`assistant/message` 的 reasoning/text、`tool/call`（工具名+脱敏参数摘要）、`tool/result`（成功/失败+脱敏结果摘要）、结论。
- **生成 1 条 `episodic` 记忆/子会话回合**（父会话的 Agent思考节点仍是 `procedural`，二者不重复）：
  - `title` = `子 Agent 会话 · <workspaceLabel> · <childId8>`；
  - `tags` = `Agent子会话`、`subagent-session:<childId8>`、`parent-session:<parentId8>`、`workspace:<label>`、`DSH会话`（父回合另含 `children:<childId8>`，每个子会话一个独立 tag）。**id8 规范化（v0.3.1）**：`session-<uuid>` 会去掉 `session-` 前缀后取 8 位（如 `session-d9ea76db-…` → `d9ea76db`），对象引用取 `.sessionId/.session_id/.id`；失败计入 `fca_status.tagNormalization.failed`；
  - `body` 分节：`【任务】` / `【关键推理】` / `【工具执行】` / `【结果】` / `【结论】`，首行含 `时间`/回合/子会话/父会话；脱敏+截断（正文 ≤12000 字、工具 ≤12 条）；
  - `occurred_at` = 子会话首条事件时间（`occurred_precision="exact"`）；去重 `session+turn`；独立每时限流 `autoMemorySubagentMaxPerHour`。
- **父记忆 children tags**：父回合通过 `subagent/catalog` 事件（`data.childId`，真实父会话事件）记录该回合 spawn 的子会话；父 Agent思考节点写入时每个子会话追加一个 `children:<childId8>` tag。
- **父子关系（Runtime relation）**：父 Agent思考节点记忆 → 子会话记忆，`POST /api/v1/relations`，`relation_type="custom"`（`label="spawned_subagent"`，`directed=true`，confidence/weight=1，source=agent）；`custom` 被拒时自动回退 `derived_from` 并计数。关系建立后给子记忆 PATCH 追加兜底 tag `parent-memory:<父memoryId>`（失败容忍并在 `fca_status.relations` 计数/lastError 记录）。
- **可观测**：`fca_status.auto_memory.subagentSessions`（mode/counters/limits）、`.relations`（created/failed/fallbackType/tagPatched/pendingWaiters）、`.compactions`、`.recovery`。

### 5.4 上下文压缩恢复（v0.3）

用户要求"压缩上下文后必须重读记忆节点，在记不清干过什么的时候也要读记忆节点恢复上下文中被压缩的记忆"。实现基于真实 DSH 能力（`@deepseek-ai/dsh-system-prompt` 的 `systemPrompt.section/context`、真实 `compaction/start|prune|summary|end` 会话事件）：

- **常驻恢复指令**（`autoMemoryContextRecovery: true`）：注册 `systemPrompt.section`（`fca-memory-recovery-instruction`，order 940），提示模型"上下文被压缩/记不清时先调用 `fca_memory_context` 重读记忆"。
- **压缩后动态提醒**：插件监听真实 compaction 事件；`compaction/end` 后该会话标记 `needsRecovery`，下一次提示组装时 `systemPrompt.context`（`fca-memory-recovery-state`，order 941）渲染压缩次数/时间、工作区、压缩摘要开头，并要求先调用 `fca_memory_context`。模型真正调用 `fca_memory_context` 后（观察 `tool/call` 事件）提醒自动清除。
- **恢复工具** `fca_memory_context`：按 workspace 返回最近记忆（含 `occurred_at`）、最近 Agent思考节点、子 Agent 会话摘要、关键决策；参数 `workspace` / `limit` / `turnLimit` / `subagentLimit` / `decisionLimit`。
- **限制（如实）**：本插件不自行触发压缩；若压缩发生在插件未加载期间则无提醒（下次真实压缩会恢复）。另提供可落地兜底：在 `cordis.patch.yml`/项目 `AGENTS.md` 或系统提示中加入"上下文压缩后必须先调用 `fca_memory_context`"的 Agent 指令（插件已通过 section 自动注入同样的规则，无需手工重复）。

## 6. 系统提示注入（默认关）

`injectContext: true` 时注册一个 `systemPrompt.context`（名字 `fca-memory-digest`，order 900），最多约 700 字符：身份摘要 + 认知焦点 + 注意力/工作记忆里最多 3 条记忆标题/摘要。

因为 `systemPrompt.context` 的取值是**同步**的（提示组装不能 await HTTP），注入的是**缓存摘要**：连接建立后、每次记忆工具调用后、以及每 60s 异步刷新。摘要有更新时下一次模型步生效。

## 7. 卸载 / 升级

**卸载**（推荐）：

```
plugin_manager action=remove_bundle target=dsh-plugin-fca-memory
# 等价的 CLI（profile 名按实际填）：
#   dsh plugin --profile desktop remove dsh-plugin-fca-memory
```

删除 `link:` 依赖与 bundle 选择。若插件正在运行，DSH 可能返回 `restart-required`（`module-comparison`），重启 DSH 完成。

**升级**：DSH 对 `link:` 安装的插件**不会**热替换已加载的 JS 模块（实测 `module-comparison` 会一直要求重启，且同名文件会被 Node ESM 缓存住）。两条可行路径：

1. **推荐：重启 DSH**。改完代码 → `remove_bundle` → `install_bundle` → 重启 DSH 后生效（最稳、无缓存歧义）。
2. **不重启的实测绕过**（仅开发期方便，交付/验收仍建议重启确认）：
   1. 让**入口文件和代码目录**都换成新路径（如 `main.js` → `main2.js`、`src/` → `src2/`，同步改 `package.json` 的 `main`、`exports["."]`、`files` 以及 `main2.js` 里的相对导入）——只换入口不够，`src/*.js` 也会被 Node ESM 按 URL 缓存；
   2. `plugin_manager action=remove_bundle target=dsh-plugin-fca-memory`；
   3. `plugin_manager action=install_bundle target=<本目录绝对路径>`（或解包后的新目录，见 §1 方式 B）；
   4. 用 Host 日志（`[fca-memory-bridge] plugin loaded`）与 `fca_status.plugin.started_at` 确认新实例已加载；用 `fca_status.plugin.config_schema` 等新字段确认运行的是新代码。

> 改名是为了让每个模块的 URL 变化、绕过 Node 的 ESM 缓存；直接覆盖同名文件时 DSH 会继续跑旧代码直到重启。升级已发布包（`.tgz`）时，解包到**新目录**再安装同样会得到新模块 URL。

**打包交付**（发布用）：

```powershell
# 在本插件目录生成 npm-pack 格式交付包（files 字段会过滤内容）
tools\pnpm.cmd --dir dsh_plugin pack --pack-destination D:\FCA\FCA-Memory-Atlas\artifacts\plugin
# 说明：--dir dsh_plugin 会让相对 destination 解析到 dsh_plugin 下，故用绝对路径；
# 也可用 DSH 自带 node + pnpm.mjs 执行等价命令（2026-11-12 复测使用，不依赖批处理包装）：
# & '<DSH 安装>\resources\runtime\x64\primary-runtime\dependencies\node\bin\node.exe' '<DSH 安装>\resources\runtime\x64\primary-runtime\dependencies\pnpm\bin\pnpm.mjs' --dir dsh_plugin pack --pack-destination D:\FCA\FCA-Memory-Atlas\artifacts\plugin
# 产物：artifacts\plugin\dsh-plugin-fca-memory-0.3.1.tgz
```


## 8. 排错

| 现象 | 处理 |
|---|---|
| `fca_status.runtime.reachable=false` | 启动 Runtime：`node runtime/bin/fca-runtime.js serve`；或把 `autoStartRuntime` 保持 `true` 并确认 `runtimeScriptPath` 自动探测成功 |
| `lastError.code = NO_TOKEN` | Runtime 可达但没读到 token 文件：先启动一次 Runtime 生成 `<fcaHome>/config/runtime-token`，或用 `tokenPath` 指定 |
| `runtime.compatible=false` | Runtime API 主版本不是 `1`：插件会明确报「不兼容」，不降级冒充成功 |
| `auto_start.error` 提到 node/script | 用 `nodePath` / `runtimeScriptPath` 显式指定；页面/日志会保留拉起后的 stderr 前 400 字符 |
| Config 在 Plugin Manager 显示 unsupported | 见 §9：Config 是手写 Standard Schema，cordis 校验正常但 UI 无法投影表单 |
| 装了但工具没出现 | 看 Host 日志是否有 `plugin loaded`；若为 `restart-required`/`module-comparison`，重启 DSH 或按 §7 换入口名重装 |

## 9. 已知限制（如实说明）

1. **Config 的 UI 表单投影不支持**：`Config` 是手写 Standard Schema v1（cordis 的原生校验契约，见 `@deepseek-ai/cordis` `src/fiber.ts` 的 `resolveConfig`），`cordis_inspect_query` 的 Config 目录会显示 `status: "unsupported"`（无法投影成 JSON Schema 表单）。配置校验、默认值、生效均正常。代码里保留 `@deepseek-ai/schemastery` 优先路径：如果插件模块作用域能解析该包，会自动改用 schemastery schema 并获得 UI 表单投影（本机实测解析不到，走回退）。
2. **link: 安装的插件不能在运行中热替换代码**（DSH HMR `module-comparison` 限制）；升级需按 §7 或重启。
3. **`/fca` 命令已注册，但命令执行只能由 UI 触发**，本插件未附带 Client/Web 半，不提供可视化面板。
4. **不订阅 Runtime 的 SSE**：`/events/stream` 未使用（单向审计推送足够；桌面端负责可视化增量同步）。
5. **审计采集不捕获工具参数与结果**（可能含密钥），`full` 策略也只记工具名与错误码。**自动记忆**（v0.2 Agent 思考节点）会在脱敏+截断后把工具参数/结果摘要写入本地 FCA 记忆库（同样只在本机）；审计事件流与自动记忆是两条独立通道。
6. 插件异常一律隔离在插件内部；如果 Runtime 长时间不可用，队列会按上限丢弃并计数，不会无限增长。
7. **采集队列在“运行时恢复”后的 flush 时机（v0.1.3 已修复）**：`turn/end` 若在 Runtime 停机窗口内被采集，会先入队（不丢）；v0.1.3 起插件自动拉起 Runtime 成功后会立即 flush 审计事件与自动记忆队列，无需等下一次健康轮询。详见 `docs/PLUGIN_INTEGRATION_TEST.md` §6.5。
8. **自动记忆的边界**：消息记忆只保存消息原文（不做 LLM 摘要/事实抽取），超过 `autoMemoryMaxChars` 截断；Agent 思考节点是**规则聚合摘要**（非 LLM 总结）：推理/结论截取前段固定字数、工具节点最多 8 条、正文上限 `autoMemoryAgentMaxChars`，超出会截断；短消息、重复内容、Host 注入消息不保存；**只采人类根会话的 user 消息（子会话 spawn prompt 不写，v0.2.1）**；每小时有硬限流（消息与 Agent 节点各自独立）；消息/推理/工具摘要内敏感内容会被脱敏后仍然写入本地记忆库（只在本机）。不想保存时把 `autoMemory` 设为 `off`（同时关闭 Agent 节点）或把 `autoMemoryAgentNodes` 设为 `off`（只关思考节点）。
9. **自动记忆只新增、不修改已有记忆**：自动流程不会改写/删除旧记忆（避免误覆盖）；例外（v0.3）：父子关系建立后会给**子会话记忆** PATCH 追加 `parent-memory:<父memoryId>` 兜底 tag（只追加 tag，不改标题/正文）。修正/删除请在桌面软件里做，或通过 Runtime API 的 PATCH/DELETE。
10. **从解包目录安装时的自动拉起路径**：`autoStartRuntime` 默认找 `<插件包>/../runtime/bin/fca-runtime.js`；若插件包不在 Runtime 相邻目录，请设置 `runtimeScriptPath`（本机验收用 junction 让该路径可用）。
11. **v0.3 子 Agent 会话记忆是规则聚合摘要（非 LLM 总结）**：spawn prompt/推理/结论按字数截断，工具最多 12 条，正文 ≤12000 字；超长内容后续步骤的细节可能被截断，完整序列始终保留在 DSH 会话日志中（`<DSH_HOME>\sessions\`）。
12. **v0.3 父子关系依赖实时事件顺序**：父回合的 `children:`/关系要求父会话 `subagent/catalog`（或子会话首个事件）与父 `turn/end` 都在插件运行期间被观察到；若子代理在插件未加载/父回合已结束后才完成，关系可能缺失（tags 兜底 `parent-memory:*` 仍可工作）。关系失败不会阻塞记忆写入，`fca_status.relations.lastError` 会记录。
13. **v0.3 上下文恢复提醒为"提示注入"而非强制工具调用**：插件通过 `systemPrompt.section/context` 让模型看到恢复规则和压缩提醒，但最终是否调用 `fca_memory_context` 由模型决定；插件不拦截/不强制模型步骤。提醒在模型调用该工具后自动清除。
14. **时间戳精度**：`occurred_at` 取真实 DSH 事件时间（epoch ms），`occurred_precision="exact"`；仅当事件缺少 time 时回退到捕获时间（仍写 exact 并记录在 source.note）。旧记忆不会补写 occurred_at。



