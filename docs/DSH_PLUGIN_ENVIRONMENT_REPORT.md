# DSH 插件环境报告（真实证据版）

- 项目：FCA Alpha 0.1 / Product B（DSH 正式插件）
- 调查与实现者：Teammate `dsh-plugin`
- 时间：2026-11-12
- 结论：**真实 DSH 插件 SDK 可用且已完成真实安装、真实加载、真实 Agent 调用与真实 Runtime 通信验证**。不存在“需要伪造 SDK”的情况；有 3 项 DSH 真实限制被实测记录（见 §10），均已给出绕过方案或如实标注。

> **2026-11-12 更新（真实 Runtime 已交付）**：真实 FCA Local Runtime `0.1.0` 就绪后完成复测——安装 → 加载 → 4 个工具注册 → 真实 Agent 调用 → 真实 Runtime HTTP/SQLite 往返全部通过；stub 时代证据已替换为真实 Runtime 证据（§9）。同时 DSH NEXT 2.0.22 删除了旧 `%USERPROFILE%\.dsh\dsh-runtimes` 目录，插件 Node 探测链已修复并在真实 Host 内验证（§9.4）。

> **2026-11-12 更新（插件 v0.2）**：插件升级到 `0.2.0`（工作区归属 `workspace:<label>` + Agent 思考节点 `autoMemoryAgentNodes`）。真实安装（`application:"applied"`）→ Host 日志 `plugin loaded {…,"autoMemoryAgentNodes":"summary"}` → `fca_status.plugin.version=0.2.0` → 真实子代理会话 `turn/end` 聚合出带 `workspace:FCA` / `Agent思考节点` 标签的 `procedural` 记忆（`mem_<redacted>`，body 三节 + 真实工具节点 + project 关系）。详见 §12。

> 本文所有结论均来自三类证据之一：(a) 本机 DSH 安装目录内的真实源码/清单文件（Host 侧文件读取，路径在 `...\resources\app.asar` 内可直接读取）；(b) `cordis_inspect_query` 的内省结果；(c) 本机真实执行产生的命令输出与 Host 日志。凡未验证的项都标为「未验证」。

---

## 1. DSH 产品与版本

| 项 | 实测值 | 证据 |
|---|---|---|
| 产品 | DSH NEXT / `dsh-desktop-next` | `C:\Users\<user>\AppData\Local\Programs\DSH NEXT\resources\app.asar\package.json` → `"name": "dsh-desktop-next"` |
| 应用版本 | `2.0.22-next` | 同上 `"version": "2.0.22-next"` |
| DSH 核心包 | `@deepseek-ai/dsh` = `0.2.2-rc.1`（agent-loop / tools / system-prompt / plugin-manager 等同版本） | 同上 `dependencies`；`app.asar.unpacked/node_modules/@deepseek-ai/dsh-agent-preset/package.json` → `"version": "0.2.2-rc.1"` |
| Cordis | `@deepseek-ai/cordis` = `4.1.0`，loader `@deepseek-ai/cordis-plugin-loader` = `1.1.0` | `app.asar/package.json` 依赖；`app.asar/node_modules/@deepseek-ai/cordis/package.json` |
| Node 要求 | `engines.node = "^22.19.0 || >=24.0.0"` | `app.asar/package.json` |
| 形态 | Electron 桌面版，`main: lib/main.js`，`type: module` | `app.asar/package.json` |

## 2. Profile（插件安装位置）

| 项 | 实测值 | 证据 |
|---|---|---|
| 当前 profile | `desktop` | 本会话 shell 中 `$env:DSH_PROFILE` = `desktop`；`$env:DSH_PROFILE_DIR` = `<DSH_HOME>\profiles\desktop` |
| profile 目录 | `<DSH_HOME>\profiles\desktop` | 目录存在，含 `cordis.yml`、`cordis.patch.yml`、`package.json`、`node_modules`、`.plugin-manager` |
| 组合入口 | `cordis.yml` 内容为 `[]`（真正的条目由 bundle 层 + profile patch 层叠加） | 文件首行注释：`# dsh profile root — an empty entry list. The tree is composed as patches: each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then --patch overlays.` |
| bundle 选择表 | `package.json` → `dsh.profile.bundles: [...]`（有序；安装新 bundle 追加到末尾，影响配置优先级） | `plugin-manager` README §Use this package：“A bundle toggle changes `package.json`'s ordered `dsh.profile.bundles` list.” |
| 用户 patch 层 | `cordis.patch.yml`（`- id: … / disabled / config / name` 覆盖与 insert） | 该文件真实内容（含 `desktop-shell`、`plugin-market`、`agent-default-model` 等覆盖行） |
| 包管理器 | pnpm `11.28.5`，`nodeLinker: hoisted` | `.plugin-manager` 安装日志 `Done in … using pnpm v11.28.5`；`node_modules/.modules.yaml` → `"nodeLinker": "hoisted"` |
| 本插件安装状态（交付态） | 已安装并选中：`dependencies["dsh-plugin-fca-memory"]="link:D:/FCA/FCA-Memory-Atlas/dsh_plugin"`；`dsh.profile.bundles` 末尾含 `dsh-plugin-fca-memory`（第 21/21 位）；`plugin_manager list_plugins` 该行 `enabled:true, fiberPhase:"active"`；4 个 `fca_*` 工具可调用 | 2026-11-12 复测 `plugin_manager install_bundle` → `application:"applied"`（§8） |

## 3. 插件清单格式（bundle manifest）

一个第三方正式插件 = **npm 包 + bundle 声明**：

```json
{
  "name": "dsh-plugin-fca-memory",
  "version": "0.1.0",
  "type": "module",
  "main": "main.js",
  "exports": { ".": "./main.js", "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" },
  "files": ["main.js", "src", "cordis.patch.yml", "locale/*.json", "icon.svg", "README.md"],
  "icon": "./icon.svg",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "engines": { "fcaRuntime": ">=0.1.0 <0.2.0" }
}
```

`cordis.patch.yml`（本插件真实文件）：

```yaml
- insert:
    - id: fca-memory-bridge
      name: dsh-plugin-fca-memory
      config:
        runtimeUrl: http://127.0.0.1:17860
        autoStartRuntime: true
        capturePolicy: turn-summaries
        injectContext: false
        redactPatterns: []
```

证据与对照：
- 语法与字段来自插件开发技能 `app.asar.unpacked\node_modules\@deepseek-ai\dsh-agent-preset\skills\cordis-plugin-development\references\host-plugin.md`（manifest / locale / icon / files / `dsh.bundle.patch`）；模板 `templates/decoration/package.json`、`templates/mcp/package.json`。
- 真实第三方实例：`<DSH_HOME>\profiles\desktop\node_modules\dsh-whale-widget\`（`package.json` 含 `dsh.bundle.patch`、`cordis.patch.yml` 为 `- insert: [{id, name}]`）；`@momasiku/dsh-pilot`（含 `lib/index.js` + `cordis.patch.yml` + `exports`）。
- 显示元数据：`locale/en.json` + `locale/zh.json` 的 `meta.title` / `meta.description`，`icon.svg`（≤256 KiB，包内相对路径）。当前用户 locale = `zh`（`<DSH_HOME>\desktop-locale.json` → `{"desktop":"zh"}`）。

## 4. 加载机制（Loader 源码证据）

| 环节 | 实现 | 证据文件（app.asar 内） |
|---|---|---|
| 树组合 | profile 的 `cordis.yml` 是空数组，bundle patch 与 profile patch 叠加成条目树 | `..\profiles\desktop\cordis.yml` |
| 条目导入 | `Entry._init()` → `this.parent.tree.import(name)` → `loader.unwrapExports(moduleNamespace)` → `ctx.registry.plugin(plugin, config)` | `@deepseek-ai/cordis-plugin-loader/src/config/entry.ts` L213-238 |
| 裸模块名解析 | `EntryTree.import()`：`cordis:` 前缀走 builtin；其余用 `createResolve(baseUrl)` 的 `import.meta.resolve`（锚定“配置工程”的 package scope） | `src/config/tree.ts` L182-201、`src/resolve.ts` L62-75 |
| 插件回调形态 | `apply(ctx, config)`（函数插件）或默认导出 Service 类；二选一 | `host-plugin.md` Host plugin export forms；本插件实际使用 `apply` |
| 配置校验 | fiber 启动前 `resolveConfig()` → `runtime.Config['~standard'].validate(config)`；校验失败抛 `ValidationError`，插件不激活 | `@deepseek-ai/cordis/src/fiber.ts` L50-62 |
| 生命周期 | `FiberState`: PENDING/LOADING/ACTIVE/FAILED/UNLOADING/DISPOSED；`_reload()` 执行插件回调，`_unload()` 逆序执行 disposers | `src/fiber.ts` L147-154、L681-746 |
| 资源归属 | `ctx.effect()` / `ctx.on()` / `ctx.tools.register()` 的 disposer 由 fiber 持有，卸载时统一释放 | `src/fiber.ts` L421-567（effect）；本插件所有注册均在 `apply` 内 |
| 热替换 | HMR 对比加载模块与磁盘文件，替换被改动的模块；link 包目标也在对比范围 | `@deepseek-ai/dsh-hmr/README.md` L49、L65-71、§Known Limitations L111 |

## 5. 生命周期 / 导出契约（本插件实际使用）

```js
export const name = 'fca-memory-bridge'          // Cordis 注册名（诊断/日志可见）
export const inject = ['tools']                   // 硬依赖：tools 服务就绪才激活
export const Config = { '~standard': { … } }      // Standard Schema v1（cordis 原生契约）
export function apply(ctx, config) { … }          // 插件主体；所有资源用 ctx.* 注册
```

- **可选服务**：`commands`、`systemPrompt` 用 `ctx.inject(['commands'], child => …)` 局部等待，缺失时插件仍可工作（`host-plugin.md` 的 “Put optional services in `inject` or `ctx.inject([...], ...)`”）。
- **动态读取服务**：`ctx.get('name')` 返回 `undefined` 时须自行判空（内省给出 `requiresUndefinedCheck: true`）。
- **配置持久化**：若插件需要写回自己的配置，必须用 `configEditor.edit(entry, change)`（由 loader 串行化并校验），**不得**直接读改写 profile 的 `cordis.patch.yml`（`host-plugin.md` §Persist your own configuration）。本插件为只读配置（不写回）。
- 凭证：`ctx.credentials.modifyRecord()` / `credentials` 服务（本插件不保存任何凭证；Runtime token 由 FCA 自己生成在数据目录，插件只读文件）。

## 6. 事件订阅

`cordis_inspect_query(host, Event, listEvents{event:'session/event'})` 的真实契约：

```
name: session/event
description: Post-commit, fire-and-forget append feed. The listener snapshot resolves before the log push,
             but callbacks run after it; observer failures are logged and contained.
mode: emit
signature: 'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
```

本插件在 `apply` 里：

```js
ctx.on('session/event', (session, event) => { try { bridge.capture.handle(session, event) } catch {} })
```

- `session.id` = SessionId，`event.type` / `event.seq` / `event.data` 是提交后的真实事件；
- 监听者异常会被 Host 记录并吞掉（不会让 append 失败），插件内再包一层 try/catch 双保险；
- 事件类型参考：`turn/start|end`、`step/start|end`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`request/header|context` 等（`SessionEventMap`，见 `app.asar/node_modules/@deepseek-ai/dsh-session` 类型）。
- 其他可选事件（本项目未使用）：`agent/inbox/inserted`、`agent/status`、`tools/execute`、`tools/result`、`system-prompt/*`（`Event.listEvents` 可查全部）。

## 7. Host 服务（内省得到的真实签名）

### 7.1 `tools`（注册工具的唯一入口）

```
tools.register(definition: ToolDefinition, options: ToolRegistrationOptions = {}): () => void
  — "Register globally or in the calling agent scope. Scoped tools shadow globals;
     duplicates within one layer and the reserved `run_code` name fail."
tools.restrict(filter) / tools.get / tools.executable / tools.resolve / tools.definitions / tools.schemas
```

`ToolDefinition`（`Tool.listTools` 的 referencedTypes 原文）：

```ts
export interface ToolDefinition extends ToolSchema {
  readonly output: ToolOutputDefinition;
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
  projectContent?(exec, result): ContentBlock[] | undefined;
  finalizeContent?(exec, result): ContentBlock[] | undefined;
  timeoutMs?: number;
  isConcurrencySafe?(args: unknown): boolean;
  presentCall?(args: unknown): ToolCallView | undefined;
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined;
}
export interface ToolSchema { name: string; description: string; parameters: Record<string, unknown>; deferLoading?: true }
export interface ToolOutputDefinition {
  readonly schema: JsonSchemaNode;
  render(args: unknown, value: JsonValue): ContentBlock[];
  presentationMeta?(args: unknown, value: JsonValue): JsonValue;
}
```

本插件注册 4 个工具（`src/tools.js`），参数用 JSON Schema（`type/properties/required/items/enum/additionalProperties`，即 `JsonSchemaNode` 支持的子集），输出 `schema: { type: 'object' }`，`render` 返回 `[{ type: 'text', text }]`。**安装后真实被 Agent 调用成功**（见 §9）。

> 未使用 `defineTool()`（`@deepseek-ai/dsh-tools` 的语法糖）：实测插件模块作用域无法解析该裸包名（见 §10.1），而 `tools.register` 接受原生 `ToolDefinition`，因此直接写原生定义，零依赖、无伪造。

### 7.2 `systemPrompt`（提示组装输入）

```
systemPrompt.section(section: PromptSection): () => void      // 静态/函数文本段，order 排序
systemPrompt.context(context: PromptContext): () => void       // 动态运行时上下文
systemPrompt.variable(name, provider) / tools(provider) / assemble(context)
export interface PromptContext { name; order; text: string | ((ctx: AssembleContext) => string); interpolate?; required? }
```

注意：`text` 是**同步**的 —— 提示组装不能 await。本插件的 `injectContext` 因此使用缓存摘要（见 README §6）。

### 7.3 `commands`（人类命令）

```
commands.register(definition: CommandDefinition): () => void
  — "Register a global or calling-agent-scoped command."
export interface CommandDefinition {
  definitionId?; name: string; description: string;
  input?: { hint: string; attachments?: boolean };
  recordInput?: boolean;
  handler(invocation): CommandResult | Promise<CommandResult>;
}
export type CommandResult =
  | { kind: 'success'; text?: string; sourceEventSeq?: SessionSeq }
  | { kind: 'error'; text: string };
```

本插件注册 `/fca`（`src/commands.js`）。

### 7.4 其他相关服务（本插件未使用，但对后续扩展有效）

| 服务 | 关键方法 | 用途 |
|---|---|---|
| `configEditor` | `entries()` / `configuration()` / `edit(entry, change)` | 写回插件自身配置（必须走它） |
| `credentials` | `resolve/describe/set/unset/readRecord/modifyRecord/deleteRecord` | 密钥（本插件不存密钥） |
| `timer` | `timeout/interval/throttle/debounce` | 可被 fiber 自动回收的定时器（本插件用 `setInterval` + `ctx.effect` 清理，效果等价） |
| `agents` / `agentLoop` | `list()/get(id)/create/resume` | Agent 级注册与编排 |
| `sessionProbe`→`session` | 事件 `session/event` | 会话日志 |

### 7.5 日志

`ctx.logger` 是可调用的 `LoggerService`：`ctx.logger(name?)` 返回命名 logger，方法 `error/warn/info/debug`，支持 `%s/%d/%o` 占位符。本插件用 `ctx.logger('fca-memory-bridge')`，Host 日志真实可见：

```
07:38:48.175Z [info] plugin loaded {"runtimeUrl":"http://127.0.0.1:17860/","schema":"standard-schema","capturePolicy":"turn-summaries"} [host.kernel.fca-memory-bridge]
07:38:48.257Z [info] bridge started {"connected":true,"phase":"connected",…} [host.kernel.fca-memory-bridge]
```

（`<DSH_HOME>\logs\desktop-next.log`）

## 8. 安装 / 热加载 / 验证方式

| 操作 | 真实结果 |
|---|---|
| `plugin_manager install_bundle target=D:\FCA\FCA-Memory-Atlas\dsh_plugin` | **2026-11-12 复测（真实交付态）**：`application: "applied"`、`warnings: []`、`packageResult.exitCode: 0`；pnpm 输出 `+ dsh-plugin-fca-memory 0.1.0 <- D:\FCA\FCA-Memory-Atlas\dsh_plugin`（`Done in 870ms`，logPath `…\.plugin-manager\logs\operation-g0OjQP\pnpm.log`）；**未触发** `restart-required`/`module-comparison`（安装前 profile 中无该插件，`main.js`+`src/` 是首次加载的新模块 URL） |
| 内省确认行 | `Config.listConfigs{name:'dsh-plugin-fca-memory'}` → `entry id: include:fca-memory-bridge, patchId: fca-memory-bridge, status: unsupported`（见 §10.1）；`plugin_manager list_plugins` 中该行 `enabled:true, fiberPhase:"active"`（交付态：已选中且实例在运行，Host 重启后按 profile 的 bundle 列表自动重新加载） |
| 内省确认工具 | `Tool.listTools` 输出含 `fca_memory_search`、`fca_memory_store`、`fca_memory_get`、`fca_status`（在 Agent 可见工具集中） |
| 安装日志 | `<DSH_HOME>\profiles\desktop\.plugin-manager\logs\operation-*\pnpm.log` |
| 权限 | `plugin_manager` 每个动作要求 `danger-full-access` 或该次调用的审批；本会话为 danger-full-access。安装的 Host 代码在进程内执行、位于工作区 sandbox 之外（plugin-manager README §Use this package / §Summary） |
| 卸载 | `plugin_manager remove_bundle target=dsh-plugin-fca-memory`：删除 `link:` 依赖 + 取消 bundle 选择（pnpm 输出 `- dsh-plugin-fca-memory link:…`） |
| HMR 行为 | 改动已加载的 link 包文件后，后续 install/remove/enable 返回 `application:"restart-required"`, `restartReason:"module-comparison"`，Host 日志 `changed modules keep running their previous code until a restart`（见 §10.2） |
| **v0.2 升级重装（2026-11-12 19:20，真实）** | tgz 解包到**新目录** `.cache\plugin-relink-v020\package`（新模块 URL）→ `plugin_manager remove_bundle target=dsh-plugin-fca-memory`（`changed:true, application:"applied"`）→ `install_bundle target=D:\FCA\FCA-Memory-Atlas\.cache\plugin-relink-v020\package`（`changed:true, application:"applied", version:"0.2.0"`，pnpm `+ dsh-plugin-fca-memory 0.2.0 <- …\plugin-relink-v020\package`）；**未出现** `restart-required`/`module-comparison`，插件在运行中完成升级 |

**验证方式（本插件实际使用）**：`plugin_manager` 结果里的 `application`/`warnings` 判状态 → `cordis_inspect_query` 确认注册（Config/Tool）→ Host 日志确认 `apply` 执行 → 真实 Agent 工具调用 → 观察 Runtime 侧访问日志。

### 8.1 交付包（npm-pack 格式）

2026-11-12 复测重新打包的真实输出（使用 DSH 自带 `node.exe` + `…\dependencies\pnpm\bin\pnpm.mjs` 执行等价命令，不依赖批处理包装；`tools\pnpm.cmd` 包装同样实测可用）：

```
package: dsh-plugin-fca-memory@0.2.0
Tarball Contents
cordis.patch.yml
icon.svg
locale/en.json
locale/zh.json
main.js
package.json
README.md
src/agent-nodes.js
src/auto-memory.js
src/bridge.js
src/capture.js
src/client.js
src/commands.js
src/config.js
src/launcher.js
src/logger.js
src/prompt-context.js
src/tools.js
src/workspace.js
Tarball Details
D:\FCA\FCA-Memory-Atlas\artifacts\plugin\dsh-plugin-fca-memory-0.2.0.tgz
```

- 包内为 `package/` 前缀（npm pack 规范），`tar -tzf` 复核 **19 个文件**（v0.2 新增 `src/workspace.js`、`src/agent-nodes.js`），无多余文件（`files` 字段生效）；
- 大小 `47,543 B`，SHA256 `FD7CD90B9074C7EE2FCB2747366345109F4851D1B312E17F3F353C78F1564A2F`（v0.2：`workspace:<label>` 工作区归属 + Agent 思考节点 `autoMemoryAgentNodes`；包内 `main.js`/`src/**`/`cordis.patch.yml` 与源码逐文件哈希一致，`package.json` 仅因 npm-pack 去掉文件末尾换行而哈希不同）；
- 两种安装方式（目录直接装 / 解包后装）与卸载、升级、link 热替换限制见 `dsh_plugin/README.md` §1、§7。

## 9. 真实端到端验证（本机实际输出）

### 9.1 真实 Agent 调用插件工具（本会话 = 真实 DSH Agent，2026-11-12 复测）

真实 FCA Local Runtime `0.1.0`（`127.0.0.1:17860`，数据目录 `%LOCALAPPDATA%\FCA-Memory-Atlas`）已启动，插件与本会话的工具调用实测：

```
fca_status        → {"ok":true,"plugin":{"phase":"connected","started_at":"2026-11-12T08:24:02.474Z","config_schema":"standard-schema"},
                     "runtime":{"url":"http://127.0.0.1:17860","reachable":true,"http_status":200,
                                "version":"0.1.0","api_version":"1","compatible":true,"status":"ok","db":"ok"},
                     "capture":{"policy":"turn-summaries","enabled":true,"queued":0}}
fca_memory_store  → {"ok":true,"memory":{"id":"mem_<redacted>",
                     "title":"FCA 插件真实链路验证：DSH Agent 写入","version":1,"deleted":false},
                     "runtime":{"version":"0.1.0","api_version":"1"}}
fca_memory_search → {"ok":true,"count":2,"took_ms":1.17,"items":[{"id":"mem_e9fce187…","score":1},
                     {"id":"mem_<redacted>","score":0.20839}]}
fca_memory_get    → {"ok":true,"memory":{"id":"mem_e9fce187…","body":"…","project":{"name":"FCA Memory Atlas"}},
                     "relations":[{"relation_type":"belongs_to_project",…}],"versions_count":1}
fca_memory_get(非法 id) → {"ok":false,"error":{"code":"BAD_REQUEST",…}}
```

其中 `mem_141a67e4…` 由 Lead 的真实会话通过同一插件写入（场景 C 证据）；另有一条测试者用 PowerShell 旁路写入的乱码探针 `mem_cb340f8a…` 已软删除（`deleted_at` 已置位，检索不再返回）。详细矩阵与原始输出见 `docs/PLUGIN_INTEGRATION_TEST.md` §1/§4/§7。

**事件采集（T17）也已真实落库**：真实 DSH 子代理会话 `a9e94d45-877d-441e-8d1d-672cfe25d057`（Lead 用 `subagent` 工具启动的独立真实会话）完成一轮 turn 后，插件按 `turn-summaries` 策略捕获 `turn/end` → `agent.event_received` 写入 `<FCA_HOME>\events\events-2026-11.jsonl`（seq=15，payload 只含 turn/reason，无正文）+ Runtime 访问日志 `POST /api/v1/event 201 client=dsh-plugin`；`fca_status.capture.counters` 最终为 `received=1, queued=0, sent=1, failed=0, dropped=0`。验证期间 Runtime 被另一 teammate 的测试进程误 stop 两次，事件先入队、插件自动拉起 Runtime、恢复后 flush 成功——同时验证了“断线排队 + 自动拉起 + 恢复后重发”。原始证据见 `docs/PLUGIN_INTEGRATION_TEST.md` §8.2/§8.3。

### 9.2 Runtime 侧真实访问日志（证明 HTTP 链路，客户端头 `X-FCA-Client: dsh-plugin`）

`C:\Users\<user>\AppData\Local\FCA-Memory-Atlas\logs\runtime-20261112.log`（真实 Runtime 的 `kind:"access"` 记录；`user_agent:"node"` 即插件在 Host 内 `fetch` 发出的请求）：

```
{"ts":"2026-11-12T08:24:02.551Z","msg":"http.request","kind":"access","method":"GET","path":"/health","status":200,"trace_id":"trc_8b1df118…","client":"dsh-plugin","ip":"127.0.0.1","user_agent":"node"}
{"ts":"2026-11-12T08:24:11.327Z","msg":"http.request","kind":"access","method":"POST","path":"/api/v1/memory/store","status":201,"trace_id":"trc_db1b246a…","client":"dsh-plugin","ip":"127.0.0.1","user_agent":"node"}
{"ts":"2026-11-12T08:24:11.662Z","msg":"http.request","kind":"access","method":"POST","path":"/api/v1/memory/store","status":201,"trace_id":"trc_bfd720bb…","client":"dsh-plugin","ip":"127.0.0.1","user_agent":"node"}
{"ts":"2026-11-12T08:24:13.726Z","msg":"http.request","kind":"access","method":"POST","path":"/api/v1/memory/search","status":200,"trace_id":"trc_5626740c…","client":"dsh-plugin","ip":"127.0.0.1","user_agent":"node"}
{"ts":"2026-11-12T08:24:13.728Z","msg":"http.request","kind":"access","method":"GET","path":"/api/v1/memory/mem_141a67e4…","status":200,"trace_id":"trc_ec4b22c6…","client":"dsh-plugin","ip":"127.0.0.1","user_agent":"node"}
{"ts":"2026-11-12T08:24:14.681Z","msg":"http.request","kind":"access","method":"POST","path":"/api/v1/memory/search","status":200,"trace_id":"trc_b4c3fdf3…","client":"dsh-plugin","ip":"127.0.0.1","user_agent":"node"}
{"ts":"2026-11-12T08:24:14.682Z","msg":"http.request","kind":"access","method":"GET","path":"/api/v1/memory/mem_e9fce187…","status":200,"trace_id":"trc_10a3d5fe…","client":"dsh-plugin","ip":"127.0.0.1","user_agent":"node"}
{"ts":"2026-11-12T08:37:32.549Z","msg":"http.request","kind":"access","method":"POST","path":"/api/v1/event","status":201,"trace_id":"trc_<redacted>","client":"dsh-plugin","ip":"127.0.0.1","content_length":"621","user_agent":"node"}
（另有每 30s 一条 GET /health 200，`connectIntervalMs=30000` 的连接维护轮询）
```

Runtime 侧事件日志 `<FCA_HOME>\events\events-2026-11.jsonl` 同时落库 15 条审计事件（`db.initialized`×1、`system.started`×3、`system.stopped`×2、`memory.created`×3、`entity.created`×1、`relation.created`×2、`layout.recomputed`×1、`memory.deleted`×1、`agent.event_received`×1），`source:{kind:"dsh-plugin",id:"dsh-plugin-main"}`、`trace_id` 与访问日志同源。

> 说明：上一版 §9 的 Runtime 侧记录来自**明确标记的协议 stub**（`.cache/fca-stub/runtime-stub.js`，`health.stub=true`，不计交付物），属协议/链路验证；stub 已停止并清理，本版已全部替换为真实 Runtime 证据。详细复测见 `docs/PLUGIN_INTEGRATION_TEST.md` §7。

### 9.3 自动拉起 Runtime（历史证据 + 本次 Node 探测链修复）

- 历史（stub 代 Runtime，上一轮 harness）：插件在 DSH Host 进程内用 DSH 自带 Node 成功拉起 Runtime 进程：

```
auto_start: { "attempted": true, "started": true,
  "node": "C:\\Users\\<user>\\.dsh\\dsh-runtimes\\dsh-next-primary-runtime\\dependencies\\node\\bin\\node.exe",
  "node_source": "dsh-runtime", "pid": 15996, "error": null }
```

- **该路径已被 DSH 更新删除**（DSH NEXT 2.0.22 不再有 `%USERPROFILE%\.dsh\dsh-runtimes`，改为 `<DSH 安装目录>\resources\runtime\x64\primary-runtime\dependencies\node\bin\node.exe`）。插件 `src/config.js` 的 `findNodeRuntime()` 已修复为：`nodePath` 配置 → `FCA_NODE`（兼容 `FCA_NODE_PATH`）→ DSH 安装目录自带 Node → 旧 `~/.dsh/dsh-runtimes`（兼容保留）→ 项目 `vendor\node` → Host 进程 + `ELECTRON_RUN_AS_NODE=1`。
- **本次真实 Host 内的验证（2026-11-12 08:35:52，真实自动拉起成功）**：
  - Runtime 被另一 teammate 测试进程通过 `POST /api/v1/shutdown` 关闭（08:35:13、08:36:18 两次，`client:"cli"`，非本插件），插件进入 `unreachable` 并记录 `lastError:{code:"RUNTIME_UNREACHABLE",…}`；
  - 插件在 Host 进程内 `spawn` 真实 Runtime：

```json
"auto_start": {
  "attempted": true, "started": true,
  "node": "C:\\Users\\<user>\\AppData\\Local\\Programs\\DSH NEXT\\resources\\runtime\\x64\\primary-runtime\\dependencies\\node\\bin\\node.exe",
  "node_source": "dsh-runtime",
  "script": "D:\\FCA\\FCA-Memory-Atlas\\runtime\\bin\\fca-runtime.js",
  "pid": 9984, "error": null }
```

  - Runtime 日志佐证：`08:35:52.918 FCA Local Runtime 已启动 pid=9984`；随后 `GET /health` → 200。Node v24.21.0（`node:sqlite` 可用），即 Node 探测链修复在真实自动拉起路径上生效。

- 对照组（历史 harness）：`autoStartRuntime=false` + 端口不可达 → `phase:"unreachable"`，`lastError:{code:"RUNTIME_UNREACHABLE",…}`，工具返回结构化失败并提示启动方式 —— 即“未连接就如实报告，不假装成功”。

### 9.4 Node 探测链修复（代码与事实，2026-11-12）

| 项 | 事实 |
|---|---|
| 旧代码 | 只探测 `%USERPROFILE%\.dsh\dsh-runtimes\*\dependencies\node\bin\node.exe`（DSH NEXT 2.0.22 已删除该目录）+ `process.execPath` |
| 新代码 | `src/config.js` `findNodeRuntime(config, env, pluginRoot)`：① `nodePath` 配置；② `FCA_NODE`；③ 当前 DSH 安装目录自带 Node（由 `process.resourcesPath` / `process.execPath` 推断，扫描 `resources\runtime\<arch>\primary-runtime\dependencies\node\bin\node.exe`）；④ 旧 `~/.dsh/dsh-runtimes`（兼容）；⑤ 项目 `vendor\node\node.exe`；⑥ Host 进程 + `ELECTRON_RUN_AS_NODE=1` |
| 调用点 | `src/launcher.js`（自动拉起）与 `src/bridge.js`（`fca_status.local`）均传入 `pluginRoot` 以便 vendor 回退生效 |
| 验证 | 真实 Host 内 `nodeSource="dsh-runtime"`、`nodePath=<DSH 安装>\resources\runtime\x64\primary-runtime\dependencies\node\bin\node.exe`；另有独立的探测优先级单测（模拟 Electron Host 对象）覆盖 ①/②/⑤/⑥ 四个分支 |
| 文档 | `dsh_plugin/README.md` §2 已同步更新探测顺序 |

## 10. 真实限制（明确“不支持/需绕行”的项）

### 10.1 插件模块作用域无法解析 `@deepseek-ai/*` 裸包名 → 不能用 `schemastery`/`defineTool` 语法糖

- 事实：本插件代码里 `await import('@deepseek-ai/schemastery')` 失败（回退到手写 Standard Schema，Host 日志 `"schema":"standard-schema"`）。
- 影响 1：`Config` 只能用 Standard Schema v1（cordis 原生契约，校验/默认值正常），但 `cordis_inspect_query` 的 Config 目录显示 `status: unsupported` —— **Plugin Manager 无法把它投影成配置表单**。
- 影响 2：不能用 `@deepseek-ai/dsh-tools` 的 `defineTool()`（dsh-pilot 那种写法），必须直接构造原生 `ToolDefinition`（本插件即如此，已真实注册成功）。
- 依据：`cordis-plugin-loader/src/config/tree.ts` 的模块解析锚定“配置工程 baseUrl”，而插件自身 ESM 导入按模块真实路径解析；`dsh-hmr` README §Known Limitations 也说明 link 包的作用域差异。
- 可选改进（未做）：把插件装成 profile 内真实拷贝（非 link）或让 DSH 侧提供解析映射，即可让 `schemastery` 生效；代码已保留“优先 schemastery、失败回退”的双路径。

### 10.2 link: 安装的插件无法在运行中热替换代码

- 事实：改动已加载的 `D:\...\dsh_plugin\*.js` 后，`install_bundle`/`remove_bundle`/`set_plugin` 均返回 `application:"restart-required"`、`restartReason:"module-comparison"`；Host 日志：`changed modules keep running their previous code until a restart: [{"url":"file:///D:/FCA/FCA-Memory-Atlas/dsh_plugin/index.js","reason":"module-comparison"}]`（记录的是早期入口 `index.js`；机制对任何已加载模块 URL 都成立，含 `lib/*.js`、`src/*.js`）。
- 原因（源码依据）：`dsh-hmr` 在应用就绪时记录对比基线；link 目标在基线之后才加入、且文件已变化时“无法比较”，按规则要求重启（`dsh-hmr/README.md` §Use this package L49、Known Limitations L111/L116）。
- 实测绕行（已成功，无需重启 DSH）：让**入口文件与代码目录**都换成新 URL（本插件实际演进：`index.js` → `host.js` → `entry.js` → `main.js`，代码目录 `lib/` → `src/`），同步 `main`/`exports`/`files` 与相对导入 → `remove_bundle` → `install_bundle`；新 URL 绕过 Node ESM 缓存，Host 日志出现新代码的 `plugin loaded` + `bridge started`。仅换入口不够：入口的静态导入链（`src/*.js`）仍会命中旧缓存，必须让代码目录 URL 也变化。
- 2026-11-12 复测：本次安装前 profile 中已无该插件（旧实例已卸载），`main.js`+`src/` 是 Host 从未加载过的新模块 URL，因此 `install_bundle` 直接 `application:"applied"`，**未触发** `restart-required`；上述限制仍适用于“升级已加载的 link 插件”。
- 建议：正式升级仍以**重启 DSH** 为最稳；本插件 README §7 给出两种流程。

### 10.3 命令执行 / UI 侧验证缺口

- `/fca` 已通过 `commands.register` 注册（无异常告警），但命令只能由 UI 触发；本会话没有浏览器控制能力，因此“命令执行结果展示”未验证（如实标注）。
- 本插件无 Client/Web 半（`dsh.client`），因此没有 Slot/面板需要验证；Product B 的范围是 Host 侧桥接与 Agent 工具。

### 10.4 未使用的可选能力（非缺陷，明确范围）

- 未订阅 SSE `/api/v1/events/stream`（采集是单向推送；增量可视化由桌面端负责）。
- 未实现 `agent.inject()` per-agent 上下文：`systemPrompt.context` + 缓存摘要已满足“最小注入”需求，且不阻塞提示组装。
- 未实现配置写回（`configEditor`）：插件不修改用户配置，避免与用户 patch 层冲突。

### 10.5 采集队列在“运行时恢复”后的 flush 时机（插件内部边界，已定位）

- 现象（2026-11-12 实测）：`turn/end` 在 Runtime 停机窗口内被采集并入队；插件自动拉起 Runtime 成功后连接恢复，但队列直到下一次成功 `connect()` 才 flush（本次为 08:37:32，延迟约 1 分 40 秒），事件不丢但非即时投递。
- 原因：`src/bridge.js` 的 `connect()` 只在「首次健康探测成功」分支调用 `capture.flushNow()`；自动拉起成功分支与 `main.js` 的 30s 健康轮询成功分支均未 flush；`capture.handle()` 在未连接时也不安排 flush。
- 影响与建议：仅影响“运行中 Runtime 重启且由插件自动拉起”这一窗口；建议下个补丁在自动拉起成功分支与健康轮询成功分支各加一次 `capture.flushNow()`（约 2 行）。为保证“已安装实例 = 已验证代码”，本次未改代码，详见 `docs/PLUGIN_INTEGRATION_TEST.md` §6.5 与 `dsh_plugin/README.md` §9。

## 11. 复现实验的命令清单

```powershell
# 真实 Runtime（交付口径：默认数据目录 %LOCALAPPDATA%\FCA-Memory-Atlas、默认端口 17860）
$node = 'C:\Users\<user>\AppData\Local\Programs\DSH NEXT\resources\runtime\x64\primary-runtime\dependencies\node\bin\node.exe'
& $node 'D:\FCA\FCA-Memory-Atlas\runtime\bin\fca-runtime.js' init
& $node 'D:\FCA\FCA-Memory-Atlas\runtime\bin\fca-runtime.js' serve   # 后台常驻
Invoke-RestMethod http://127.0.0.1:17860/health
Get-Content (Join-Path $env:LOCALAPPDATA 'FCA-Memory-Atlas\logs\runtime-*.log') -Tail 20   # 访问日志
Get-Content (Join-Path $env:LOCALAPPDATA 'FCA-Memory-Atlas\events\events-2026-11.jsonl') -Tail 5

# 安装（真实安装；交付态保持安装）
plugin_manager action=install_bundle target=D:\FCA\FCA-Memory-Atlas\dsh_plugin
# 内省
cordis_inspect_query(host, Config, listConfigs, {name:'dsh-plugin-fca-memory'})
cordis_inspect_query(host, Tool, listTools, {})
cordis_inspect_query(host, Service, listService, {service:'commands'})
cordis_inspect_query(host, Event, listEvents, {event:'session/event'})
# Host 日志
Select-String '<DSH_HOME>\logs\desktop-next.log' -Pattern 'fca-memory-bridge|plugin loaded|module-comparison'
# 打包（复测使用的等价命令：DSH 自带 node + pnpm.mjs）
$dshNode = 'C:\Users\<user>\AppData\Local\Programs\DSH NEXT\resources\runtime\x64\primary-runtime\dependencies\node\bin\node.exe'
$pnpmMjs = 'C:\Users\<user>\AppData\Local\Programs\DSH NEXT\resources\runtime\x64\primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
& $dshNode $pnpmMjs --dir dsh_plugin pack --pack-destination D:\FCA\FCA-Memory-Atlas\artifacts\plugin
```

> 注：`plugin_manager` 内部的 pnpm 调用在 Host 进程内执行；打包也可用 `tools\node.cmd` / `tools\pnpm.cmd` 包装（本机实测 pnpm `11.28.5`，见 `docs/ENVIRONMENT_REPORT.md`）。

## 12. v0.2 更新：工作区归属 + Agent 思考节点（2026-11-12 真实验证）

插件 `0.2.0` 在**不重启 DSH** 的前提下完成真实升级与验证。与 DSH 环境相关的结论：

| 项 | 真实结果 | 证据 |
|---|---|---|
| 新模块 URL 热替换 | 升级走"tgz 解包到新目录 `.cache\plugin-relink-v020\package` → remove_bundle → install_bundle"，未触发 `restart-required`/`module-comparison`；三个新改模块（`main.js`、`src/auto-memory.js`、`src/config.js`）均以新 URL 加载 | `plugin_manager` 返回 `application:"applied"`；Host 日志 `plugin loaded {…,"autoMemoryAgentNodes":"summary"}`（§8 表格"v0.2 升级重装"行、`artifacts/plugin/v0.2-install-log.json`） |
| SessionHeader.cwd 可用性 | DSH NEXT 2.0.22 的 `Session` 对象暴露不可变 `header`（`get id() { return this.header.id }`，`snapshotSessionHeader` 返回创建元数据，含 `cwd`）；插件从 `session.header.cwd` 真实解析出 `D:\FCA`，`fca_status.auto_memory.workspace.last.source="session.header.cwd"` | `app.asar` 内 `@deepseek-ai/dsh-session/lib/types/index.js`（`Session` 类、`SessionHeader` 校验 `cwd` 必须为绝对路径）+ 真实 `fca_status` |
| 真实 session 事件形状（格式 v4） | `assistant/message.data.message.content[]` 含 `reasoning`/`text` 块；`tool/call.data={turn,step,callId,name,arguments(JSON 字符串)}`；`tool/result.data.message={role,toolCallId,isError,content[]}`；`turn/end.data={turn,reason}`。插件按真实形状解析，无字段猜测 | 真实会话日志 `<DSH_HOME>\sessions\--D-FCA--\*\session.v4.jsonl.zstd` 解压核对（`c5ed45ae…` 134 事件、`session-d9ea76db…` 5104 事件）；回放证据 `artifacts/plugin/v0.2-session-replay.json` |
| 跨会话采集 | 插件在 Host 根作用域监听 `session/event`，真实子代理会话（`c3769704…`）的 `turn/end` 聚合写入 Runtime 记忆 `mem_<redacted>`（`procedural`，tags=`Agent思考节点,DSH会话,workspace:FCA`，project=`FCA 工作区`，body 3349 字三节） | `artifacts/plugin/v0.2-verification.json`；`GET /api/v1/memory/{id}` 原始响应（`docs/PLUGIN_INTEGRATION_TEST.md` §11.3） |
| 计数可观测 | `fca_status.auto_memory.agentNodes.counters`：`eventsSeen=96, turnsSeen=1, captured=1, stored=1, toolCallsSeen=33, toolResultsSeen=33`；`workspace.last={label:"FCA",cwd:"D:\FCA",source:"session.header.cwd"}`；`capture.counters.received=sent=1` | 真实 `fca_status` 调用（`artifacts/plugin/v0.2-install-log.json`） |
| 交付包 | `artifacts/plugin/dsh-plugin-fca-memory-0.2.0.tgz`：47,543 B，19 文件（新增 `src/workspace.js`、`src/agent-nodes.js`），SHA256 `FD7CD90B9074C7EE2FCB2747366345109F4851D1B312E17F3F353C78F1564A2F` | `tar -tzf` + 解包目录与源码逐文件哈希一致（同名文件仅 `package.json` 因 npm-pack 去尾换行不同） |
| 单元测试 | `tools\node.cmd --test tests\unit\plugin\plugin-pure.test.js` → 21/21 PASS | 本机真实执行输出 |

未覆盖/限制：① 真实 Runtime 中"用户消息带 workspace:FCA"需升级后第一条真实用户输入才会出现（消息路径已由 21 项单测 + 5133 个真实事件回放覆盖，见 `docs/PLUGIN_INTEGRATION_TEST.md` §11.4）；② Config 的 UI 投影限制、`/fca` UI 执行缺口与 §10 相同，未改变；③ 插件无 Client/Web 半，星云按 `workspace:*` 分组渲染由桌面/Unity 侧消费。

### 12.1 v0.2.1：子会话 user-role 消息过滤（2026-11-12，真实回归）

| 项 | 真实结果 | 证据 |
|---|---|---|
| 根因（真实 session header） | DSH session 格式 v4：人类根会话 `delegationDepth:0` 且无 `parentSession`/`origin`；子代理会话含 `parentSession`+`origin:"subagent"`+`delegationDepth:1`。子代理的 spawn prompt 由 Host 以 `user/message` 且 `source.kind:"user"` 下发 → v0.2.0 误采为 episodic 记忆 | `inspect-headers` 解压真实日志：`session-d9ea76db…`（root）/`c5ed45ae…`/`3c4e45fe…`/`3d3bcb2a…`（child）；`@deepseek-ai/dsh-session` 的 SessionHeader 校验（`parentSession`/`origin` 只允许 `"subagent"`/`delegationDepth`） |
| 过滤实现 | 新增 `src/session-scope.js`：`parentSession`（兼容 `parentSessionId`）| `delegationDepth>0` | `origin==="subagent"` → child。仅 child 的 **user 消息**跳过（`skippedChildSession` 计数）；root 真实用户消息不受影响；Agent 思考节点对 child 照常采集 | `fca_status.auto_memory.sessions={root,child,policy}`、`counters.skippedChildSession` |
| 真实回归 | v0.2.1 安装后启动真实 workflow 子代理会话 `6d4ba096…`（child，depth 2）：其 spawn prompt（user/message+source.kind=user）**未产生 episodic 记忆**；`skippedChildSession=5, captured=0`；该子会话 Agent 节点仍写入（测试残留已软删） | `artifacts/plugin/v0.2.1-child-filter-evidence.json`；`docs/PLUGIN_INTEGRATION_TEST.md` §11.7.3 |
| 噪声清理 | 3 条 teammate 提示词记忆（desktop-integration/memory-pipeline/unity-renderer spawn prompt）经 `DELETE /api/v1/memory/{id}` 真实软删除；graph nodes 12→9、memories 11→8，graph/默认列表不再出现、`include_deleted=true` 可在回收站检出 | `artifacts/plugin/v0.2.1-cleanup-evidence.json`；§11.7.4 |
| 交付/安装 | `artifacts/plugin/dsh-plugin-fca-memory-0.2.1.tgz`：51,184 B，20 文件（新增 `src/session-scope.js`），SHA256 `ED799DC1D2F186DF862D34D42A88FAEC1CFD905C12D2BDE9EC91054537937403`；新目录 `.cache/plugin-relink-v021/package` remove+install（`application:"applied"`, version 0.2.1），未重启 DSH；Host 日志 `10:34:51.555Z plugin loaded` | `artifacts/plugin/v0.2.1-install-log.json` |
| 单测 | `tools\node.cmd --test tests\unit\plugin\plugin-pure.test.js` → **24/24 PASS**（新增 session-scope 形状判定、子会话过滤+计数器、子会话 Agent 节点仍采集、根会话不受影响） | 本机真实执行输出 |

观察（非插件行为，如实标注）：① 升级前后旧自动记忆的 `workspace:FCA` 标签由其它流程/Lead 回填（插件无历史迁移代码）；② 19:34:26 Runtime pid 14248→52104 为其它 teammate 操作（非本任务），数据目录/数据完整。

---

## 13. 插件 v0.3.x：时间戳 / 子 Agent 全量记忆 / 父子层级 / 上下文恢复（2026-11-13 真实验证）

### 13.1 与 DSH 环境相关的真实结论

| 项 | 真实结果 | 证据 |
|---|---|---|
| 事件时间字段 | `SessionEvent.time`（epoch ms）是真实时间来源：`user/message` 有 time、`turn/start` 有 time、子会话首条事件有 time；插件据此写 `occurred_at`(ISO)+`occurred_precision="exact"` | 真实会话日志（session format v4）+ Runtime 记忆 `mem_293f1b1a…`/`mem_87cf63da…` 的 occurred_at（`docs/PLUGIN_INTEGRATION_TEST.md` §12.2） |
| spawn 提示词形状 | child 会话首条 `user/message`（`source.kind="user"`）即 spawn prompt；父会话通过 `subagent/catalog`（`data.childId`）宣告子会话 → 用于 `children:<id8>` 与父子关系 | 真实事件：`subagent/catalog`（父会话）、child `user/message` seq=9；真实记忆 `mem_63aa5ac5…`/`mem_87cf63da…`（§12.3） |
| memory↔memory 关系契约 | `POST /api/v1/relations` 支持 `from/to={kind:'memory',id}`；`relation_type` 枚举含 `custom`/`derived_from`；插件用 `custom` + `label:"spawned_subagent"`（达标，无需 fallback），真实关系 `rel_a95800f5…` | Runtime `relations` 服务（`runtime/src/catalog/relations.js`）+ 真实 API 响应 |
| 提示注入能力（系统提示） | `systemPrompt.section(text)` 静态注入与 `systemPrompt.context({text(context)})` 动态注入均可用；`AssembleContext.agent` 可取会话 id；插件 section `fca-memory-recovery-instruction` **真实出现在 Agent 提示中** | `@deepseek-ai/dsh-system-prompt` `lib/index.js`（`assemble()`/`resolveContext()`）+ 本机真实会话提示观测 |
| compaction 事件 | 真实会话存在 `compaction/start|prune|summary|end`（FCA 主历史会话实测 22 prune + start/summary/end）；插件按这些真实事件置 `needsRecovery` 并在下一次 prompt 组装渲染恢复提醒，调用 `fca_memory_context` 后清除 | 真实历史会话日志（`session-d9ea76db…`）+ 单测 `plugin/auto-memory: 真实 compaction 事件…`；**限制**：安装 v0.3.x 后本机暂未发生新压缩（`fca_status.compactions.eventsSeen=0`），该路径由真实事件形状单测覆盖，下一次真实压缩自动生效 |
| 安装/兼容 | v0.3.1 tgz：68,625 B，22 文件，SHA256 `651F764C…`；新目录 `.cache/plugin-relink-v031/package` remove+install（`applied`，0.3.1，未重启 DSH）；`engines.fcaRuntime` 仍 `>=0.1.0 <0.2.0` | `artifacts/plugin/v0.3.1-install-log.json` |
| id8 规范化 | `session-<uuid>` 的 id8 已修复为去前缀取 8 位（旧 bug `parent-session:session-`），3 条存量记忆 PATCH 修复（HTTP 200）；v0.3.1 新写入 tags 全部 8 位 hex，`tagNormalization.failed=0` | `artifacts/plugin/v0.3.1-tag-repair.json`；记忆 `mem_cfd58ede…` 等 |

### 13.2 可观测（`fca_status.auto_memory`）

- 新增 `subagentSessions{mode,enabled,tag,counters{eventsSeen,turnsSeen,captured,stored,spawnPromptsSeen,toolCallsSeen,toolResultsSeen,childrenTagged,idNormalizeFailed}}`；
- `relations{type,label,fallbackType,counters{attempted,created,failed,fallbackType,pendingWaiters,tagPatchAttempted,tagPatched,tagPatchFailed,idNormalizeFailed},lastError}`；
- `tagNormalization{rule,failed,subagentFailed,relationFailed}`；`compactions{eventsSeen,prunes,started,finished,sessions,pendingRecovery,lastAt}`；`recovery{enabled,counters{sessionsMarked,clearedByTool,renders}}`；`context_recovery{enabled,renders,...}`。
- 真实快照（v0.3.1 进程）：`subagentSessions.stored=2, childrenTagged=1`；`relations.created=1, tagPatched=1`；`tagNormalization.failed=0`；`compactions.eventsSeen=0`；`recovery.enabled=true`。

### 13.3 测试与清理

- 单测 `tools\node.cmd --test tests\unit\plugin\plugin-pure.test.js` → **33/33 PASS**。
- 测试噪声：先 2 次父子探针的重复记忆对 4 条已真实软删除（`DELETE /api/v1/memory/{id}`）；保留 v0.3.1 最终验证对（`mem_63aa5ac5…` ↔ `mem_87cf63da…`，relation `rel_a95800f5…`）+ 真实 teammate 会话记忆；graph 57→53、memories 50→46（include_deleted 60），证据 `artifacts/plugin/v0.3.1-noise-cleanup.json`。
- 未覆盖/限制：① 真实 compaction 恢复提醒待下一次真实压缩（当前 0 次，单测覆盖事件形状与渲染逻辑）；② 旧记忆 `occurred_at` 不补齐（任务约定只保证新写入）；③ 父子关系依赖插件运行期间观察父回合与 spawn 事件，插件离线期间的子会话无法建立 relation（tags 兜底仍可渲染默认层级）。
