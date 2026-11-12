# DSH 插件集成测试报告（FCA Memory Atlas · Product B）

- 插件：`dsh-plugin-fca-memory@0.3.1`（源码 `D:\FCA\FCA-Memory-Atlas\dsh_plugin`，交付包 `artifacts/plugin/dsh-plugin-fca-memory-0.3.1.tgz`；v0.3.1 记忆时间戳 + 子 Agent 全量记忆 + 父子层级 + 上下文恢复 + id8 规范化修复；v0.2.x 工作区/Agent 思考节点、v0.1.4 自动记忆保留）
- 被测环境（本次全部为真实组件，不含 stub）：
  - DSH NEXT `dsh-desktop-next 2.0.22-next`，profile `desktop`（`<DSH_HOME>\profiles\desktop`）
  - 真实 FCA Local Runtime `0.1.0`（`D:\FCA\FCA-Memory-Atlas\runtime\bin\fca-runtime.js`），`http://127.0.0.1:17860`
  - 真实数据目录 `%LOCALAPPDATA%\FCA-Memory-Atlas`（`C:\Users\<user>\AppData\Local\FCA-Memory-Atlas`），SQLite `db\fca.db`
- 测试者：Teammate `dsh-plugin`（在真实 DSH Host 内安装，用真实 Agent 会话调用工具）
- 时间：2026-11-12（UTC 08:22–08:37 / 本机 17:22–17:37）
- 结论：**真实安装（`application: "applied"`）→ 真实加载（Host 日志 `plugin loaded` / `bridge started`）→ 4 个 `fca_*` 工具注册 → 真实 Agent 调用 → 真实 Runtime HTTP/SQLite 往返 → 真实会话事件采集落库（T17）全部通过**；`/fca` 命令注册已验证、UI 执行未验证（原因见 §8.1）。事件采集队列在“运行时恢复后 flush 时机”有一个已定位的延迟边界（不丢事件），见 §6.5。
- **本版已把 stub 时代的结论替换为真实 Runtime 证据；仅保留必要的历史标注**（stub 只用于上一轮协议链路验证，`health.stub=true`，不计入交付）。

---

## 1. 测试矩阵

| # | 用例 | 方法 | 结果 |
|---|---|---|---|
| T1 | bundle 真实安装到 desktop profile | `plugin_manager install_bundle`，target=插件目录绝对路径 | ✅ `application: "applied"`，`warnings: []`，`packageResult.exitCode: 0`（§2） |
| T2 | profile 状态正确 | 读 profile `package.json`（只读）+ `plugin_manager list_plugins` | ✅ `dependencies["dsh-plugin-fca-memory"]="link:D:/FCA/FCA-Memory-Atlas/dsh_plugin"`；`dsh.profile.bundles` 末尾含该 bundle（第 21/21 位）；插件行 `enabled:true, fiberPhase:"active"`（§3.5） |
| T3 | 插件真实加载（`apply` 执行） | Host 日志 + `cordis_inspect_query Config` | ✅ `08:24:02.481Z [info] plugin loaded`、`08:24:03.021Z bridge started`（§3.1） |
| T4 | 工具真实注册且 Agent 可见 | `cordis_inspect_query(host, Tool, listTools)` + 本会话工具列表更新 | ✅ 4 个工具：`fca_status` / `fca_memory_search` / `fca_memory_store` / `fca_memory_get`（§3.4） |
| T5 | 真实 Agent 调用 `fca_status` | 本会话直接调用插件工具 | ✅ `phase:"connected"`，`runtime.reachable=true`，`version:"0.1.0"`，`api_version:"1"`，`compatible=true`，`db:"ok"`（§4） |
| T6 | 真实 Agent 调用 `fca_memory_store` | 同上（真实 Runtime） | ✅ 返回 `mem_<redacted>`；另一次由 Lead 真实会话写入 `mem_<redacted>` |
| T7 | 真实 Agent 调用 `fca_memory_search` | 同上（hybrid） | ✅ `count=2`，命中上述两条，含 `score` / `excerpt` |
| T8 | 真实 Agent 调用 `fca_memory_get` | 同上 | ✅ 返回完整 body、`relations=[belongs_to_project]`、`versions_count=1` |
| T9 | 非法入参被工具参数校验拦截 | `fca_memory_get{id:'not-a-memory-id'}` | ✅ `{ok:false,error:{code:'BAD_REQUEST',…}}` |
| T10 | Runtime 侧收到真实 HTTP（客户端头/追踪头/轮询） | 真实 Runtime 访问日志 `logs/runtime-2026*.log` | ✅ `client:"dsh-plugin"`、`trace_id:"trc_…"`、`user_agent:"node"`；另有 30s `/health` 轮询（§5） |
| T11 | 事件采集（策略/脱敏/幂等/队列/重试） | 历史：插件 harness 注入真实 `session/event` 形状 | ✅ 历史证据（stub 时代 harness，非本次真实 Host）；真实 Host 采集见 T17/§8.2 |
| T12 | 自动拉起 Runtime（真实 spawn） | 真实：插件在 Host 内用 DSH 自带 Node 拉起**真实 Runtime** | ✅ **2026-11-12 08:35:52 实测**：`auto_start:{attempted:true,started:true,node_source:"dsh-runtime",script:"…\\runtime\\bin\\fca-runtime.js",pid:9984,error:null}`；Runtime 日志 `08:35:52.918 FCA Local Runtime 已启动 pid=9984`（§8.3） |
| T13 | Runtime 不可达时如实报错 | 真实：Runtime 被外部测试进程关闭窗口内观察 | ✅ `lastError:{code:"RUNTIME_UNREACHABLE",message:"cannot reach FCA Runtime at http://127.0.0.1:17860: fetch failed"}`，恢复后自动重连（`connect_attempts` 递增）；历史 harness 对照组同样通过 |
| T14 | 插件卸载/回滚 | 历史 `plugin_manager remove_bundle`；本轮安装前 profile 中已无该插件 | ✅ 本轮安装即基于“profile 中无该插件”的干净状态 |
| T15 | 真实 FCA Runtime（非 stub）复测 | 真实 Runtime `init+serve` + 真实 Agent 工具调用 | ✅ **通过**，见 §7 |
| T16 | `/fca` 命令真实执行 | 需要 UI 触发命令 | ⚠️ 注册已生效（Host 日志无 `command registration failed`）；**UI 执行未验证**（无浏览器控制，见 §8.1） |
| T17 | 事件采集在真实会话中的落库 | 真实 Host `session/event` → Runtime `/api/v1/event` | ✅ **真实采集并落库**：`session a9e94d45…` 的 `turn/end` → `agent.event_received`（counters received=1/sent=1，Runtime `POST /api/v1/event 201`），见 §8.2 |
| T18 | v0.2 升级真实安装 + 加载 | 新目录解包 tgz → `plugin_manager remove_bundle` → `install_bundle` | ✅ **2026-11-12 19:20 实测**：`application:"applied"`、`version:"0.2.0"`；Host 日志 `plugin loaded {…,"autoMemoryAgentNodes":"summary"}`；`fca_status.plugin.version=0.2.0`、`auto_memory.workspace.last={label:"FCA",cwd:"D:\\FCA",source:"session.header.cwd"}`（§11） |
| T19 | 工作区标签 + Agent 思考节点真实落库 | 真实子代理会话（推理+工具调用+结果）→ `turn/end` → Runtime 记忆 | ✅ **真实**：`GET /api/v1/memories` 可检索到带 `workspace:FCA` 与 `Agent思考节点` 标签的记忆（含【关键推理】/【工具执行】/【结论】三节与真实工具节点），见 §11.3 |
| T20 | v0.2.1 子会话 user-role 消息过滤（真实回归） | 真实 workflow 子代理会话 spawn prompt + `turn/end` | ✅ **真实**：子会话 `6d4ba096…`（header `parentSession`/`origin:"subagent"`/`delegationDepth:2`）的 spawn prompt（user/message + `source.kind=user`）**未**产生 episodic 记忆，`fca_status.auto_memory.counters.skippedChildSession=5`、`sessions.child=2`；该子会话的 Agent 思考节点按设计仍写入（测试残留已软删），见 §11.7 |
| T21 | v0.3.1 记忆时间戳（真实 Runtime） | 真实用户消息/Agent思考节点/子会话记忆写入后查 API | ✅ 均带 `occurred_at`（ISO）+`occurred_precision="exact"`：用户消息 `mem_293f1b1a…`=`2026-11-12T16:43:35.332Z`、子会话 `mem_87cf63da…`=`16:44:13.898Z`、父回合 `mem_63aa5ac5…`=`16:44:11.360Z`（§12.2） |
| T22 | v0.3.1 子 Agent 会话全量记忆 + 父子层级（真实） | teammate 真实 workflow 子代理 → 子 turn/end + 父 turn/end → Runtime tags/relation | ✅ 子会话记忆 `mem_87cf63da…`（tags `Agent子会话/subagent-session:09be92a1/parent-session:c3769704/parent-memory:mem_63aa5ac5…/workspace:FCA`）；父回合记忆 `mem_63aa5ac5…` tags 含 `children:09be92a1`；关系 `rel_a95800f5…`=`custom/spawned_subagent`（from 父 → to 子）；计数器 `subagentSessions.stored=2/childrenTagged=1`、`relations.created=1/tagPatched=1`（§12.3） |
| T23 | `fca_memory_context` 上下文恢复工具（真实） | 真实 Agent 调用 + systemPrompt 恢复指令观测 | ✅ 真实返回 6 条最近记忆/3 条 Agent思考节点/3 条子Agent会话/3 条关键决策（含 occurred_at/tags，`recovery.needs_recovery=false`）；恢复指令 section 真实出现在 Agent 提示中；compaction→提醒路径受"本机安装后尚无新压缩事件"限制（单测+真实历史事件覆盖，§12.5/§12.6） |

## 2. 安装输出（T1/T2 原始结果）

`plugin_manager action=install_bundle target=D:\FCA\FCA-Memory-Atlas\dsh_plugin` 返回原文：

```json
{
  "stage": "enable",
  "target": "dsh-plugin-fca-memory",
  "enabled": true,
  "changed": true,
  "application": "applied",
  "registries": [null],
  "packageResult": {
    "exitCode": 0,
    "output": "✓ Lockfile passes supply-chain policies (verified 22m ago)\nProgress: resolved 1, reused 0, downloaded 0, added 0\n[WARN] Issues with peer dependencies found.\nPackages: -12\n------------\nProgress: resolved 121, reused 0, downloaded 0, added 0, done\n\ndependencies:\n+ dsh-plugin-fca-memory 0.1.0 <- D:\\FCA\\FCA-Memory-Atlas\\dsh_plugin\n\nDone in 870ms using pnpm v11.28.5\n",
    "truncated": false,
    "logPath": "C:\\Users\\<user>\\.dsh\\profiles\\desktop\\.plugin-manager\\logs\\operation-g0OjQP\\pnpm.log"
  },
  "bundle": "dsh-plugin-fca-memory",
  "version": "0.1.0",
  "warnings": []
}
```

- **未出现 `application:"restart-required"` / `restartReason:"module-comparison"`**：本轮安装前 profile 中确实没有该插件（无旧模块被 Host 加载过），`main.js` + `src/` 是新 URL，无需 README §7 的改名绕行。
- profile 复核（只读检查，未手改任何 profile 文件）：

```
dependencies: "dsh-plugin-fca-memory": "link:D:/FCA/FCA-Memory-Atlas/dsh_plugin"
dsh.profile.bundles: [..., "dsh-plugin-fca-memory"]   （列表末尾，已选中）
```

> 全程未修改 DSH 安装目录；安装/选择/卸载全部经 `plugin_manager`（内部由 pnpm + profile writer 完成）。

## 3. 加载证据（T3/T4）

### 3.1 Host 日志（`<DSH_HOME>\logs\desktop-next.log`）

```
2026-11-12T08:24:02.481Z [info] plugin loaded {"runtimeUrl":"http://127.0.0.1:17860/","schema":"standard-schema","capturePolicy":"turn-summaries"} [host.kernel.fca-memory-bridge] log {"hostTime":1794471842480,"hostSequence":3,"pluginId":"include:fca-memory-bridge"}
2026-11-12T08:24:03.021Z [info] bridge started {"runtimeUrl":"http://127.0.0.1:17860/","connected":true,"phase":"connected","capturePolicy":"turn-summaries","injectContext":false} [host.kernel.fca-memory-bridge] log {"hostTime":1794471843021,"hostSequence":4,"pluginId":"include:fca-memory-bridge"}
```

同内容也出现在 `desktop-next-2026-11-12.0.jsonl`（`source:"host.kernel.fca-memory-bridge"`、`level:"info"`）。

### 3.2 新代码确实在运行（Node 探测链修复的运行时证据）

`fca_status` 返回（节选）：

```json
"local": {
  "fcaHome": "C:\\Users\\<user>\\AppData\\Local\\FCA-Memory-Atlas",
  "fcaHomeExists": true,
  "tokenPath": "C:\\Users\\<user>\\AppData\\Local\\FCA-Memory-Atlas\\config\\runtime-token",
  "tokenPresent": true,
  "runtimeScriptPath": "D:\\FCA\\FCA-Memory-Atlas\\runtime\\bin\\fca-runtime.js",
  "runtimeScriptPresent": true,
  "nodePath": "C:\\Users\\<user>\\AppData\\Local\\Programs\\DSH NEXT\\resources\\runtime\\x64\\primary-runtime\\dependencies\\node\\bin\\node.exe",
  "nodeSource": "dsh-runtime"
}
```

即 `src/config.js` 的新探测链（`FCA_NODE` → DSH 安装目录自带 Node → 旧 `~/.dsh/dsh-runtimes` → 项目 `vendor\node` → Host 进程 + `ELECTRON_RUN_AS_NODE`）在真实 Host 内解析到了 DSH NEXT 2.0.22 的 Node v24.21.0。

### 3.3 Config 内省

```
cordis_inspect_query(host, Config, listConfigs{name:'dsh-plugin-fca-memory'})
→ [{ "id": "include:fca-memory-bridge", "patchId": "fca-memory-bridge",
     "name": "dsh-plugin-fca-memory", "status": "unsupported" }]
```

`status:"unsupported"` 的含义与原因见 §6.1（配置校验/默认值/生效正常，只是无法投影成 UI 表单）。

### 3.4 工具注册（T4）

`cordis_inspect_query(host, Tool, listTools)` 返回的工具列表中出现且仅出现这 4 个 `fca_*` 工具（`C:\Users\<user>\AppData\Local\Temp\dsh-spill-…\…cordis_inspect_query.txt` 行 386/449/515/536）：

- `fca_memory_search`（hybrid/fulltext/semantic 检索）
- `fca_memory_store`（写入记忆，`origin=agent`）
- `fca_memory_get`（按 id 读完整记忆/关系/版本）
- `fca_status`（Runtime 可达性/采集队列/路径/最近错误）

同时本会话（真实 DSH Agent）的工具列表在安装后立即出现这 4 个工具（工具注册 → `tools/change` → Agent 会话工具集刷新），说明注册对真实 Agent 生效，而不是只存在于插件内部。

### 3.5 插件行状态（Plugin Manager 内省）

`plugin_manager action=list_plugins` 中本插件行（列表末尾，`total:249`）：

```json
{"entryId":"include:fca-memory-bridge","moduleName":"dsh-plugin-fca-memory",
 "enabled":true,"fiberPhase":"active","patchId":"fca-memory-bridge"}
```

`enabled:true` + `fiberPhase:"active"` 即“bundle 已选中且插件实例在运行”；Host 重启后会按 profile 的 `dsh.profile.bundles` 自动重新加载（与本次安装同一 bundle 选择，无需再次手动安装）。

## 4. 真实 Agent 工具调用（T5–T9，真实 Runtime）

以下为真实 DSH Agent 会话直接调用插件工具的结果（节选；`runtime.url` 均为 `http://127.0.0.1:17860`，`version:"0.1.0"`，`api_version:"1"`）。

```
fca_status → ok=true
  plugin:  { name:"dsh-plugin-fca-memory", version:"0.1.0", phase:"connected",
             started_at:"2026-11-12T08:24:02.474Z", config_schema:"standard-schema" }
  runtime: { url:"http://127.0.0.1:17860", reachable:true, http_status:200,
             version:"0.1.0", api_version:"1", compatible:true, status:"ok", db:"ok",
             error:null, last_connected_at:"2026-11-12T08:24:03.021Z", connect_attempts:1 }
  capture: { policy:"turn-summaries", enabled:true, queued:0,
             counters:{received:0,queued:0,sent:0,failed:0,dropped:0,suppressed:0}, lastError:null }
  auto_start: { attempted:false }

fca_memory_store(title:"FCA 插件真实链路验证：DSH Agent 写入", memory_type:"episodic",
                 importance:0.8, tags:["dsh-plugin","e2e","真实链路"], project:"FCA Memory Atlas")
  → { "ok":true,
      "memory":{ "id":"mem_<redacted>", "title":"FCA 插件真实链路验证：DSH Agent 写入",
                 "memory_type":"episodic", "importance":0.8, "tags":["dsh-plugin","e2e","真实链路"],
                 "version":1, "deleted":false },
      "runtime":{ "url":"http://127.0.0.1:17860", "version":"0.1.0", "api_version":"1" } }

fca_memory_search(query:"FCA-PLUGIN-E2E 真实链路 插件验证", mode:"hybrid", limit:5)
  → { "ok":true, "count":2, "took_ms":1.17,
      "items":[ {id:"mem_<redacted>", score:1, excerpt:"…"},
                {id:"mem_<redacted>", score:0.20839, excerpt:"…"} ] }

fca_memory_get(id:"mem_<redacted>")
  → { "ok":true, "memory":{ id, title, body(完整), participants:[], project:{entity_id, name:"FCA Memory Atlas"},
                            occurred_precision:"unknown", created_at:"2026-11-12T08:24:11.659Z",
                            created_by:{kind:"agent", id:"dsh-plugin"} },
      "relations":[ {id:"rel_aa8763683324c29987fa0ecbf2650e23", relation_type:"belongs_to_project",
                     from:{kind:"memory", id:…}, to:{kind:"entity", id:"ent_37b8abcfa890b061b94b1b4d400023e9"},
                     label:"属于项目"} ],
      "versions_count":1 }

fca_memory_get(id:"not-a-memory-id")
  → { "ok":false, "error":{ "code":"BAD_REQUEST",
        "message":"id must match mem_<32 lowercase hex>, received \"not-a-memory-id\"" } }
```

- 两个写入记忆的 `created_by` 均为 `{kind:"agent", id:"dsh-plugin"}`，`origin=agent`（门禁：Agent 生成记忆标注正确）；
- UTF-8 中文标题/正文/标签在写入、检索、读回全链路无乱码（对比：绕过插件、用 Windows PowerShell 直接 POST 写入的探针确实产生过乱码，已软删除，见 §7.5）。

## 5. Runtime 通信证据（T10，真实 Runtime 访问日志）

真实 Runtime 自身访问日志 `C:\Users\<user>\AppData\Local\FCA-Memory-Atlas\logs\runtime-20261112.log`（节选，`user_agent:"node"` 即插件 Host 内 `fetch` 发起的真实请求；`user_agent` 为 Windows PowerShell 的是测试者的旁路探针）：

```
08:24:02.551Z GET    /health                     200 client=dsh-plugin trace=trc_<redacted> bytes=158
08:24:11.327Z POST   /api/v1/memory/store        201 client=dsh-plugin trace=trc_<redacted> bytes=1600
08:24:11.662Z POST   /api/v1/memory/store        201 client=dsh-plugin trace=trc_<redacted> bytes=1226
08:24:13.726Z POST   /api/v1/memory/search       200 client=dsh-plugin trace=trc_<redacted> bytes=4485
08:24:13.728Z GET    /api/v1/memory/mem_141a67e…200 client=dsh-plugin trace=trc_<redacted> bytes=2186
08:24:14.681Z POST   /api/v1/memory/search       200 client=dsh-plugin trace=trc_<redacted> bytes=3900
08:24:14.682Z GET    /api/v1/memory/mem_e9fce18…200 client=dsh-plugin trace=trc_<redacted> bytes=1812
08:24:32.481Z GET    /health                     200 client=dsh-plugin trace=trc_<redacted> bytes=158
08:25:02.481Z GET    /health                     200 client=dsh-plugin trace=trc_<redacted> bytes=159
08:25:32.481Z GET    /health                     200 client=dsh-plugin trace=trc_<redacted> bytes=159
08:26:02.481Z GET    /health                     200 client=dsh-plugin trace=trc_<redacted> bytes=159
08:26:32.480Z GET    /health                     200 client=dsh-plugin trace=trc_<redacted> bytes=159
```

- `client:"dsh-plugin"` 来自插件显式发送的 `X-FCA-Client` 头；`trace_id` 来自插件 `X-FCA-Trace-Id`（32 位 hex，`trc_` 前缀）；
- 每 30s 一次 `/health` 是插件的连接维护轮询（`connectIntervalMs=30000`），证明连接状态是持续维护的而非一次性探测；
- 所有请求状态码 200/201，无 4xx/5xx（除刻意构造的非法入参在客户端侧就被拦截，未发请求）。

## 6. 失败点与真实限制（按发生顺序，全部已定位）

### 6.1 Config 的 UI 投影为 `unsupported`（非阻塞，仍在）

- 现象：`Config.listConfigs` 显示 `status: "unsupported"`。
- 原因：cordis 只用 `Config['~standard'].validate` 做校验（`@deepseek-ai/cordis/src/fiber.ts` L50-62）；Inspect 的 JSON Schema 投影需要 schemastery 类型的 schema。插件模块作用域里 `import('@deepseek-ai/schemastery')` 解析失败 → 回退到手写 Standard Schema（Host 日志中 `"schema":"standard-schema"`）。
- 影响：配置校验/默认值/生效完全正常；仅 Plugin Manager 无法渲染配置表单。
- 处理：代码保留「优先 schemastery，失败回退」双路径；README §9 如实说明。

### 6.2 link: 插件的模块热替换被 DSH 拒绝（本次未触发）

- 历史现象（上一轮）：首次安装 `applied`；之后只要改动过插件目录里的 `.js`，任何 `install_bundle`/`remove_bundle`/`set_plugin` 都返回 `application:"restart-required"`、`restartReason:"module-comparison"`，且重新安装后仍跑旧代码（Node ESM 按 URL 缓存）。
- **本次真实安装未触发**：安装前 profile 中已无该插件（旧实例已卸载），`main.js`/`src/*.js` 第一次被 Host 加载，`application:"applied"` 直接生效。
- 升级已加载插件时仍需按 README §7 的两种方式（重启 DSH / 换 URL 改名重装）。

### 6.3 早期误操作的清理（已处理，历史）

- 早期用 PowerShell 变量 `$home` 撞上只读变量 `$HOME`，stub 曾在 `C:\Users\<user>\` 下创建 `config/ logs/ events/ db/`；已核对创建时间与内容后按绝对路径删除。本次验证前该数据目录已由 Runtime 重新 `init`（真实 `db\fca.db`、schema_version=1、token 64 位）。

### 6.4 `/fca` 命令执行验证缺口（如实标注）

- `commands.register` 已注册且 Host 日志无 `command registration failed`（若注册抛错，插件会记 `warn`）：
  - 命令：`/fca`，`description:"Show FCA Memory Atlas bridge status …"`，`input:{hint:"[status]"}`，`recordInput:false`；
  - `commands` 服务契约（`cordis_inspect_query(host, Service, listService{service:'commands'})`）：`register(definition)` / `@Remote list(agent)` / `@Remote execute(agent, line, …)`。
- **执行未验证**：命令只能从 UI 触发；本会话没有浏览器控制能力，且 DSH Web 服务（`http://127.0.0.1:4252`）对未授权请求返回 401（需要 GUI 的授权上下文）。因此只验证到“注册成功、无异常”，未验证“命令执行结果展示”。

### 6.5 采集队列在“运行时恢复”后的 flush 时机（已定位，非阻塞）

- 现象：`turn/end` 在 Runtime 停机窗口内被采集入队；插件自动拉起 Runtime 成功后（08:35:52）队列仍为 1 条未发送，直到下一次成功 `connect()`（08:37:32）才 flush（`sent=1`）。
- 原因：`src/bridge.js` 的 `connect()` 只在「首次健康探测成功」分支调用 `capture.flushNow()`；**自动拉起成功分支**和 `main.js` 的 30s 健康轮询成功分支都没有 flush。`capture.handle()` 在 `state.connected=false` 时也不会安排 flush（只在已连接时 `scheduleFlush(0)`）。
- 影响：运行中 Runtime 重启、由插件自动拉起后，停机窗口内采集的审计事件会延迟到下一次真实重连才发送（**事件不丢，但不是即时投递**）。
- 建议修复（约 2 行）：`connect()` 的自动拉起成功分支加 `void capture.flushNow()`；`main.js` 健康轮询 `health.reachable` 分支也调用 `bridge.capture.flushNow()`。本次为保证「已安装实例 = 已验证代码」未改代码，列入已知限制并在 `dsh_plugin/README.md` §9 说明。

## 7. 真实 FCA Runtime 复测（T15）

### 7.1 启动与数据目录（真实，非 stub）

- 启动方式（交付口径：默认数据目录 + 默认端口）：

```powershell
# 初始化数据目录（幂等；生成认证 token；建空库）
<node> runtime\bin\fca-runtime.js init
# 常驻服务
<node> runtime\bin\fca-runtime.js serve
```

`init` 真实输出（节选）：

```json
{ "ok": true, "initialized": true, "created": true, "already_initialized": false,
  "data_dir": "C:\\Users\\<user>\\AppData\\Local\\FCA-Memory-Atlas",
  "db_path": "C:\\Users\\<user>\\AppData\\Local\\FCA-Memory-Atlas\\db\\fca.db",
  "token_path": "C:\\Users\\<user>\\AppData\\Local\\FCA-Memory-Atlas\\config\\runtime-token",
  "schema_version": 1, "event_id": "evt_56e06d36b3c515bc94f0bef353af2ac1" }
```

数据目录实际内容（`%LOCALAPPDATA%\FCA-Memory-Atlas`）：

```
backups/ config/ db/ events/ exports/ logs/ secrets/ tmp/
runtime.lock (295 B)  runtime.pid (250 B)
config\runtime-token (65 B = 64 位 token + 换行)
db\fca.db (294912 B) db\fca.db-shm db\fca.db-wal
events\events-2026-11.jsonl
logs\runtime-20261112.log
```

`GET /health` 真实返回：

```json
{ "status":"ok", "version":"0.1.0", "product_version":"0.1.0", "api_version":"1",
  "uptime_ms":212400, "initialized":true, "db":"ok", "pid":23052, "shutting_down":false }
```

### 7.2 `fca_status` 指向真实 Runtime

见 §3.2：`runtime.version="0.1.0"`（旧 stub 为 `"0.1.0-stub"`）、`api_version="1"`、`compatible=true`、`db="ok"`、`reachable=true`、`http_status=200`。

### 7.3 记忆写入/检索/读取真实往返

见 §4 的 T6/T7/T8 输出。要点：

- 写入返回真实 `mem_<32 hex>` id 与 `version:1`；
- 检索命中且带真实 `score`（hybrid：全文本 `fts5-bigram-v1` + 本地语义 `local-hash-v1`，见 `/api/v1/memory/search` 的 `engine` 字段）；
- 读取返回真实 body、自动生成的 `belongs_to_project` 关系（`entity.created` + `relation.created` 事件同时落库）；
- 另有一条由 Lead 真实会话写入的 `mem_<redacted>`（场景 C 证据），同样 `created_by={kind:"agent",id:"dsh-plugin"}`。

### 7.4 真实事件落库（Runtime 侧审计日志）

`<FCA_HOME>\events\events-2026-11.jsonl`（真实 Runtime 写入，截至 T17 验证后共 15 条，事件类型分布）：

```
db.initialized ×1 | system.started ×3 | system.stopped ×2 | memory.created ×3
entity.created ×1 | relation.created ×2 | layout.recomputed ×1 | memory.deleted ×1
agent.event_received ×1（T17，见 §8.2）
```

（`system.started ×3 / system.stopped ×2` 是因为验证期间 Runtime 被另一 teammate 的测试进程两次通过 API 关闭，插件自动拉起一次 + 测试者手动重启一次；这些是真实审计事件，不是数据损坏。）

样例（`memory.created`，`source:{kind:"dsh-plugin",id:"dsh-plugin-main"}`，`trace_id` 与访问日志同源）：

```json
{"schema_version":"1.0","id":"evt_634e9dfe66d23731acc24746455f46c1","type":"memory.created",
 "ts":"2026-11-12T08:24:11.660Z","actor":{"kind":"agent","id":"dsh-plugin","display":"DSH 插件"},
 "source":{"kind":"dsh-plugin","id":"dsh-plugin-main","version":"0.1.0"},
 "subject":{"kind":"memory","id":"mem_<redacted>"},
 "payload":{"memory_id":"mem_<redacted>","title":"FCA 插件真实链路验证：DSH Agent 写入", …},
 "trace_id":"trc_<redacted>","client_event_id":null,"seq":7}
```

### 7.5 验证数据的清理

- 测试者用 Windows PowerShell 旁路探针写入的乱码记忆 `mem_<redacted>`（标题 `????:?? Runtime ????`，PowerShell 管道编码问题）已通过真实 API **软删除**：
  - `DELETE /api/v1/memory/mem_<redacted>` → `200`，返回 `version:2`、`deleted_at:"2026-11-12T08:25:34.795Z"`；
  - 同时产生 `memory.deleted`（`soft:true`）审计事件；
  - 复查检索 `total=2`（不再返回该条），其它记忆（`mem_141a67e4…`、`mem_e9fce187…`）保留为场景 C/T15 证据。
- 未删除任何用户真实数据；`<FCA_HOME>` 在本次验证前是全新的（旧 stub 痕迹已随上一轮清理，不存在 `logs/stub-access.jsonl`）。

### 7.6 与 stub 时代结论的差异（明确标注）

| 项 | 旧（stub） | 本次（真实 Runtime） |
|---|---|---|
| `runtime.version` | `0.1.0-stub` | `0.1.0` |
| 数据目录 | stub 自建 `stub-access.jsonl` | 真实 `db\fca.db` + `events\*.jsonl` + `logs\runtime-*.log` |
| 访问日志 | `<FCA_HOME>\logs\stub-access.jsonl` | `<FCA_HOME>\logs\runtime-20261112.log`（`kind:"access"`） |
| 事件写入 | stub events | 真实 `memory.created` / `entity.created` / `relation.created` / `layout.recomputed` 等 |
| 检索引擎 | stub 固定 score | 真实 `fts5-bigram-v1` + `local-hash-v1` |

## 8. T16 / T17

### 8.1 T16：`/fca` 命令

- ✅ 注册：`ctx.inject(['commands'], child => registerCommands(...))` 无异常；Host 日志无 `command registration failed`。
- ⚠️ 执行未验证：命令由 UI 触发（Composer `/fca`），本会话无浏览器控制；DSH Web 服务需要 GUI 授权（未授权请求 401）。如实标注为“注册已验证、UI 执行未验证”，不作通过结论。

### 8.2 T17：真实会话事件采集落库（已验证）

- 采集策略：`capturePolicy:"turn-summaries"`（只上报 `turn/end`，不含任何消息正文；默认安全档）。
- 真实链路：插件在 `apply` 里订阅 Host `session/event`（`mode:"emit"`，契约见 `cordis_inspect_query(host, Event, listEvents{event:'session/event'})`），把 `turn/end` 映射为契约 §6 的 `agent.event_received`，`POST /api/v1/event`（带 `client_event_id` 幂等键 + `X-FCA-Client`/`X-FCA-Trace-Id`）。
- **实测（2026-11-12，真实 Host 会话，非 harness）**：
  1. **触发源是真实 DSH Agent 会话**：`session a9e94d45-877d-441e-8d1d-672cfe25d057`（session 头：`"origin":"subagent"`、`"delegationDepth":1`、`"parentSession":"session-d9ea76db-…"`；由 Lead 用 `subagent` 工具启动的独立真实会话）在 `08:35:41` 创建、`08:35:45.978` 完成 `turn 1`（session 日志 seq=22，`{"turn":1,"reason":{"kind":"completed"}}`）。
  2. **插件采集计数**（真实 `fca_status.capture` 输出）：
     ```json
     { "policy":"turn-summaries", "enabled":true, "queued":0,
       "counters": { "received":1, "queued":1, "sent":1, "failed":0, "dropped":0, "suppressed":0 },
       "lastError": null }
     ```
  3. **Runtime 落库**（`<FCA_HOME>\events\events-2026-11.jsonl` 原始整行）：
     ```json
     {"schema_version":"1.0","id":"evt_16b052a5dd2eb738d9b3e7ea8af79480","type":"agent.event_received",
      "ts":"2026-11-12T08:35:45.982Z","actor":{"kind":"agent","id":"agent:a9e94d45-…","display":"DSH Agent"},
      "source":{"kind":"dsh-plugin","id":"dsh-plugin","version":"0.1.0"},"subject":{"kind":"agent","id":null},
      "payload":{"dsh":{"event":"turn/end","seq":22,"session_id":"a9e94d45-…"},"turn":1,"reason":"completed"},
      "trace_id":"trc_<redacted>",
      "client_event_id":"dsh:a9e94d45-…:22:turn/end","seq":15}
     ```
     → `payload` 仅含 `dsh.event/seq/session_id` + `turn` + `reason`，**无任何消息正文**（turn-summaries 策略）；`client_event_id` 幂等键形状符合契约。
  4. **Runtime HTTP 访问日志**（`<FCA_HOME>\logs\runtime-20261112.log`）：
     ```json
     {"ts":"2026-11-12T08:37:32.549Z","level":"info","msg":"http.request","kind":"access",
      "method":"POST","path":"/api/v1/event","status":201,"ms":3,
      "trace_id":"trc_<redacted>","client":"dsh-plugin","ip":"127.0.0.1",
      "content_length":"621","user_agent":"node"}
     ```
- **时序观察（断线排队 + 自动拉起 + 恢复后重发，已真实验证）**：该事件在 Runtime 被另一 teammate 误 `stop` 的窗口内（08:35:13–08:35:52，`client:"cli"`，不是本插件所为）被采集 → 先入队（`received=1/queued=1/sent=0`）；插件 08:35:52 自动拉起 Runtime（`auto_start.node_source="dsh-runtime"`，pid=9984）后连接恢复，队列在下一次成功 `connect()`（08:37:32，Runtime 被再次外部关闭后由手动重启 + `fca_status` 触发）flush 成功（`sent=1`，`queued=0`）——**事件未丢失**；投递延迟的原因与修复建议见 §6.5。
- 复测方式（可独立复现）：
  1. 在任意真实 Agent 会话里聊一轮（或让一个一次性子 agent 会话跑完），让 `turn/end` 产生；
  2. 调 `fca_status` 看 `capture.counters.received/sent ≥ 1` 且 `queued=0`；
  3. 查 `<FCA_HOME>\events\events-YYYY-MM.jsonl` 出现 `"type":"agent.event_received"`（`payload.dsh.event="turn/end"`，无正文）；
  4. 查 `<FCA_HOME>\logs\runtime-*.log` 出现 `POST /api/v1/event 201 client=dsh-plugin`。

### 8.3 T12 复测：真实自动拉起 Runtime（已验证）

- 前置：验证期间 Runtime 被外部测试进程通过 `POST /api/v1/shutdown` 关闭两次（08:35:13、08:36:18，访问日志 `client:"cli"`、`user_agent:"node"`，不是本插件所为）；插件随之进入 `unreachable`，`lastError:{code:"RUNTIME_UNREACHABLE",…}`。
- 真实自动拉起（08:35:52，插件在 Host 进程内 `spawn` 真实 Runtime）：

```json
"auto_start": {
  "attempted": true, "started": true,
  "node": "C:\\Users\\<user>\\AppData\\Local\\Programs\\DSH NEXT\\resources\\runtime\\x64\\primary-runtime\\dependencies\\node\\bin\\node.exe",
  "node_source": "dsh-runtime",
  "script": "D:\\FCA\\FCA-Memory-Atlas\\runtime\\bin\\fca-runtime.js",
  "pid": 9984, "error": null }
```

- Runtime 自身日志佐证：`{"ts":"2026-11-12T08:35:52.918Z","level":"info","msg":"FCA Local Runtime 已启动","url":"http://127.0.0.1:17860","pid":9984,"data_dir":"C:\\Users\\<user>\\AppData\\Local\\FCA-Memory-Atlas","initialized":true}`；随后 `GET /health` → 200。
- 即：Node 探测链修复后，插件在真实 Host 内用 DSH NEXT 2.0.22 自带 Node 成功拉起真实 Runtime；不可达期间如实报 `RUNTIME_UNREACHABLE`，不伪造连通。

## 9. 如何重跑（可复现）

- 真实环境复验：
  1. 启动真实 Runtime：`<node> runtime\bin\fca-runtime.js init` → `serve`；`GET http://127.0.0.1:17860/health` 为 200；
  2. 安装插件：`plugin_manager action=install_bundle target=D:\FCA\FCA-Memory-Atlas\dsh_plugin`；
  3. `cordis_inspect_query(host, Tool, listTools)` 应看到 4 个 `fca_*`；Host 日志出现 `[fca-memory-bridge] plugin loaded`；
  4. 真实 Agent 依次调 `fca_status` → `fca_memory_store` → `fca_memory_search` → `fca_memory_get`；
  5. 对照 `<FCA_HOME>\logs\runtime-*.log`（访问日志）与 `<FCA_HOME>\events\events-*.jsonl`（审计事件）。
- 开发期 harness（非交付物，历史遗留，位于 `.cache/fca-plugin-harness/run.mjs`，可能仍引用旧入口 `host.js/lib/`，仅作参考）：`<dsh-node> .cache\fca-plugin-harness\run.mjs --mode main|autostart|unreachable`。

## 10. 清理与回滚

- 本报告涉及的真实数据：保留 `mem_141a67e4…`（Lead 场景 C）与 `mem_e9fce187…`（T15）作为验证数据；已软删除测试者乱码探针 `mem_cb340f8a…`。
- 如需移除插件：`plugin_manager action=remove_bundle target=dsh-plugin-fca-memory`（历史 T14 已实测；运行中实例会停止，profile 依赖与 bundle 选择被移除）。
- 最终交付态：插件在 desktop profile 中已安装、bundle 已选中、Host 中处于 `active`/`connected`，4 个工具可用（保持安装状态作为交付）。

---

## 10. 自动记忆（autoMemory）——完全自动添加记忆（v0.1.4）

### 10.1 能力说明

- 插件新增 `autoMemory` 配置（`off | user-messages | all`），交付 bundle 默认 `user-messages`：**你在任意 DSH 会话中输入的每条真实用户消息，会自动写成一条真实 FCA 记忆**（`POST /api/v1/memory/store`），桌面软件通过 SSE 实时看到新星体；不需要在每个会话里下"记住"指令，也不需要逐会话授权。
- 只采真实用户消息：按 `session/event` 的 `user/message.data.source.kind === "user"` 过滤；Host 注入的 user-role 消息（runtime-context、skill-catalog、time-context、后台任务通知、Agent 消息转发、审批通知）不会入库。
- 每条自动记忆：`title`（消息首行 ≤80 字）、`body`（脱敏 ≤2000 字）、`memory_type=episodic`、`tags=["DSH自动记忆","DSH用户消息"]`、`source.ref=dsh-plugin`、`source.note` 含 DSH 会话 id 前缀与 seq、`origin=agent`；有版本历史，可在桌面软件编辑/删除。
- 安全/有界：复用插件既有密钥脱敏；队列有界、每小时硬限流 `autoMemoryMaxPerHour`（默认 120）、按 `session:seq:role` + 正文哈希去重；Runtime 离线时排队，恢复后重试（最多 3 次，超限丢弃计数）。

### 10.2 真实证据

**A. 跨会话自动写入（v0.1.2，真实 DSH 会话）**

- 触发：Lead 用 subagent 工具启动真实子代理会话 `5f9a9578-145c-4a5f-9433-8c3bb2039913`，其用户消息含"下周三去杭州出差，和产品团队开评审会"。
- `fca_status.auto_memory`：`{"mode":"user-messages","enabled":true,"counters":{"seen":6,"captured":6,"stored":6,"failed":0,...}}`（6 条均为自动写入；跨会话可见）。
- `GET /api/v1/graph`：nodes 由 1 → 7，其中自动生成节点 `mem_<redacted>` 标题即为该消息首行；全部是真实数据库记录（可在桌面星图看到）。
- 同批还发现：`runtime-context`、`skill-catalog`、`time-context`、`tool-jobs`、`agent-message` 等 **Host 注入的 user-role 消息被误采集**（共 5 条噪声），已定位并修复。

**B. 过滤与收尾修复（v0.1.3/v0.1.4）**

- 修复：`src/auto-memory.js` 增加 `source.kind === 'user'` 门禁（仅真实用户消息）；`src/bridge.js` 自动拉起 Runtime 成功后立即 flush 审计事件与自动记忆队列；版本 `PLUGIN_VERSION` 0.1.4。
- 单元测试（`node --test tests/unit/plugin/plugin-pure.test.js`）：**14/14 PASS**，新增覆盖：自动记忆标题/正文/来源/标签/类型、短消息/重复/助手消息跳过、脱敏、`all` 模式、每时限流、`off` 模式、**只采集真实用户消息（6 类 Host 注入消息全部 skippedNonText）**。
- 已安装 v0.1.4 到 desktop profile（`plugin_manager install_bundle`：`application:"applied"`，`version:"0.1.4"`）；`fca_status` 显示 `phase=connected`、`auto_memory.mode=user-messages/enabled=true`、`runtime.reachable=true`。
- 数据清理：v0.1.2 产生的 6 条测试/噪声自动记忆已软删除（保留 `mem_<redacted> · <personal-preference-memory-title（已脱敏）>`）。

**C. 待 confirm（如实标注）**

- v0.1.4 安装发生在本次交付会话进行中；其"真实 UI 用户消息 → 自动写入"的最终确认需**用户下一次在任意 DSH 会话中输入消息**后复查 `fca_status.auto_memory.counters.stored` 与桌面星图节点（插件监听 Host 根作用域，跨会话事件可达性已由 A 证明）。这属于观测时点问题，不是未实现功能。

### 10.3 配置与关闭

`cordis.patch.yml` 交付默认：`autoMemory: user-messages`、`autoMemoryMaxPerHour: 120`、`autoMemoryMaxChars: 2000`、`autoMemoryMemoryType: episodic`、`autoMemoryTags: [DSH自动记忆]`。把 `autoMemory` 改为 `off` 并重新安装/更新插件即可关闭自动写入。

---

## 11. v0.2：工作区归属 + Agent 思考节点（真实证据，2026-11-12 19:20–19:22）

> 本节全部为**升级后真实 Runtime 的真实数据**（`GET /api/v1/memories` / `GET /api/v1/memory/{id}` 原始响应），原始证据文件：`artifacts/plugin/v0.2-verification.json`（Runtime 证据）、`artifacts/plugin/v0.2-install-log.json`（安装/打包/Host 日志/单测）、`artifacts/plugin/v0.2-session-replay.json`（真实会话日志回放）。没有任何手工写入或伪造记忆。

### 11.1 变更内容（v0.1.4 → v0.2.0）

| 能力 | 实现 |
|---|---|
| 工作区归属 | 新增 `src/workspace.js`：从真实 DSH `Session` 的 `session.header.cwd`（DSH NEXT 2.0.22 格式 v4 的不可变 SessionHeader）推断 cwd，回退 `session.cwd` → `session.meta.cwd` → `process.cwd()`；basename 作为标签（`D:\FCA` → `workspace:FCA`）。每条自动记忆 tags 追加 `workspace:<label>`、`source.note` 记录完整 cwd（≤160 字）、`project` = `<label> 工作区`（Runtime 自动建项目实体并生成 `belongs_to_project` 关系）。 |
| Agent 思考节点 | 新增 `src/agent-nodes.js` + `src/auto-memory.js` 缓冲：按 `session:turn` 收集 `assistant/message` 的 reasoning/text、`tool/call`（工具名 + 脱敏参数摘要）、`tool/result`（成功/失败 + 脱敏结果摘要，按 `callId` 关联），`turn/end` 聚合为 **1 条** `procedural` 记忆（避免每工具一条）：title=`Agent 思考节点 · 第 N 回合`、body 三节`【关键推理】/【工具执行】/【结论】`、importance 0.55、tags=`Agent思考节点`+`workspace:<label>`+`DSH会话`、`source.note`=会话前缀+回合+工作区+cwd、同 session+turn 去重、空回合跳过、独立每时限流 60/h、正文上限 12000 字。 |
| 配置 | 新增 `autoMemoryAgentNodes`（`off`/`summary`，bundle 默认 `summary`）与 7 个上限/限流参数；`config.js` 默认 `off` 保持旧配置向后兼容。 |
| 可观测 | `fca_status.auto_memory` 新增 `workspace{last,known}`、`agentNodes{mode,enabled,tag,memoryType,title,activeTurns,limits,counters}`；`config` 段输出全部新配置。 |

### 11.2 真实升级安装与加载

- 交付包：`artifacts/plugin/dsh-plugin-fca-memory-0.2.0.tgz`（47,543 B，19 文件，SHA256 `FD7CD90B9074C7EE2FCB2747366345109F4851D1B312E17F3F353C78F1564A2F`）；解包目录与源码逐文件哈希一致。
- 安装方式（不重启 DSH、不用旧模块 URL）：tgz 解包到新目录 `.cache\plugin-relink-v020\package`（`runtime` junction 指向仓库 `runtime/`，保证 `autoStartRuntime` 路径探测）→ `plugin_manager remove_bundle target=dsh-plugin-fca-memory`（`changed:true, application:"applied"`）→ `plugin_manager install_bundle target=D:\FCA\FCA-Memory-Atlas\.cache\plugin-relink-v020\package`（`changed:true, application:"applied", version:"0.2.0"`）。未出现 `restart-required`/`module-comparison`。
- Host 日志（`<DSH_HOME>\logs\desktop-next.log`）：
  ```
  2026-11-12T10:20:03.739Z [info] plugin loaded {"runtimeUrl":"http://127.0.0.1:17860/","schema":"standard-schema","capturePolicy":"turn-summaries","autoMemory":"user-messages","autoMemoryAgentNodes":"summary"} [host.kernel.fca-memory-bridge]
  ```
- `fca_status`（升级后真实调用）：`plugin.version="0.2.0"`、`phase="connected"`、`started_at="2026-11-12T10:20:03.729Z"`、`runtime.reachable=true`、`runtime.version="0.1.0"`、`api_version="1"`、`config.autoMemoryAgentNodes="summary"`、`auto_memory.workspace.last={"label":"FCA","cwd":"D:\\FCA","source":"session.header.cwd"}`、`auto_memory.agentNodes.mode="summary"`（limits 见 §11.1）。

### 11.3 真实落库证据（workspace + Agent 思考节点）

**触发**：升级完成后，用真实子代理会话（teammate `dsh-plugin`，session `c3769704…`）做一次只读验证——它在该回合中调用了 `fca_status`、`pwsh`（`Get-Content …package.json | Select-String '"version"'`）、`send_message` 三个真实工具。该回合 `turn/end` 时插件自动写入 1 条聚合记忆（非手工写入、非 stub）。

**Runtime 原始响应**（`GET /api/v1/memory/mem_<redacted>`）：

```json
{
  "id": "mem_<redacted>",
  "title": "Agent 思考节点 · 第 2 回合",
  "memory_type": "procedural",
  "importance": 0.55,
  "origin": "agent",
  "tag_names": ["Agent思考节点", "DSH会话", "workspace:FCA"],
  "project": { "entity_id": "ent_22a399065458d8c9a9cac8addbc54f6e", "name": "FCA 工作区" },
  "source": { "type": "agent", "ref": "dsh-plugin", "note": "Agent思考节点：DSH 会话 c3769704 第 2 回合，工作区 FCA；cwd=D:\\FCA" },
  "created_at": "2026-11-12T10:21:43.776Z",
  "version": 1,
  "body_chars": 3349
}
```

关系（自动建立，证明工作区项目实体已形成）：`{"relation_type":"belongs_to_project","from":{"kind":"memory","id":"mem_<redacted>"},"to":{"kind":"entity","id":"ent_22a399065458d8c9a9cac8addbc54f6e"},"label":"属于项目","evidence":"系统根据记忆参与者/项目自动建立"}`。

**body 节选**（真实正文 3349 字，以下为节选，省略处以 `…` 标注）：

```text
【关键推理】
A new message from memory-pipeline (another teammate). They ask for a read-only verification:
1) Call fca_status once, confirm plugin.version=0.2.0 and auto_memory.agentNodes.mode="summary"
…（真实推理原文，前 1500 字截断）…

【工具执行】
1. fca_status · 参数：{}
   结果：{"ok":true,"plugin":{"name":"dsh-plugin-fca-memory","version":"0.2.0", …}[truncated]
2. pwsh · 参数：command=Get-Content D:\FCA\FCA-Memory-Atlas\dsh_plugin\package.json | Select-String '"version"', description=Read plugin package.json version line
   结果："version": "0.2.0",
3. send_message · 参数：message=只读验证结果（两项均通过）：① fca_status → plugin.version="0.2.0"…[truncated]
   结果：{"sent":true}

【结论】
只读验证完成（两项均通过），已回复 memory-pipeline：
1) fca_status → plugin.version="0.2.0"，auto_memory.agentNodes.mode="summary"…
2) pwsh → … 输出 "version": "0.2.0"。
调用的两个工具：fca_status、pwsh。未调用 fca_memory_store、未修改任何文件、未继续 task-3（其已完成）。
```

**插件侧计数器**（同次 `fca_status`，真实）：`auto_memory.agentNodes.counters={"eventsSeen":96,"turnsSeen":1,"captured":1,"stored":1,"failed":0,"dropped":0,"skippedEmpty":0,"skippedDuplicate":0,"skippedRate":0,"toolCallsSeen":33,"toolResultsSeen":33}`；`auto_memory.counters={"seen":5,"captured":0,"stored":1,…, "skippedNonText":5}`（本轮 5 条 `agent-message` 类 user-role 消息全部按设计过滤，不写消息记忆）；`capture.counters={"received":1,"queued":1,"sent":1,…}`（同回合 `turn/end` 审计事件同时落库）。

**复现命令**（真实 Runtime，只读）：

```powershell
$token = (Get-Content '<FCA_DATA_DIR>\config\runtime-token' -Raw).Trim()
$h = @{ Authorization = "Bearer $token" }
(Invoke-RestMethod 'http://127.0.0.1:17860/api/v1/memories?limit=100&sort=-created_at' -Headers $h).items |
  Where-Object { $_.tag_names -contains 'Agent思考节点' -or $_.tag_names -contains 'workspace:FCA' }
Invoke-RestMethod 'http://127.0.0.1:17860/api/v1/memory/mem_<redacted>' -Headers $h
```

### 11.4 用户消息的 workspace 标签（真实事件回放 + 单测；Runtime 观测点待下一次真实用户输入）

升级后尚无新的**真实用户输入**（本轮所有 `user/message` 均为 teammate 转发/系统注入，按设计过滤）。该路径由两层真实证据覆盖：

1. 单元测试：真实 `createAutoMemory` + 真实 session 形状 → 消息记忆 tags 含 `workspace:FCA-Memory-Atlas`、`project.name="FCA-Memory-Atlas 工作区"`、`source.note` 含完整 cwd（§11.5）。
2. 真实会话日志回放：把真实 DSH `session.v4.jsonl`（`c5ed45ae…`、`session-d9ea76db…`，共 5133 个真实事件）逐事件喂给**交付版** `src/auto-memory.js`，消息记忆与 Agent 节点分别产出：小会话 1 条消息记忆（`tags=DSH自动记忆,DSH用户消息,workspace:FCA`）+1 条 Agent 节点；主会话 14 条消息记忆 + 9 条 Agent 节点（`workspace:FCA`/`Agent思考节点` 全部正确）。证据：`artifacts/plugin/v0.2-session-replay.json`。

> 观测点限制（如实标注）：与 §10.2 C 同类——真实 Runtime 中"用户消息带 workspace:FCA"需要升级后的第一条**真实用户输入**才会出现；届时无需改代码。Agent 思考节点已由真实 `turn/end` 抢先证明工作区推断（同样的 `workspace:FCA` 标签与 `FCA 工作区` project）。

### 11.5 单元测试（21/21 通过）

```powershell
D:\FCA\FCA-Memory-Atlas\tools\node.cmd --test tests\unit\plugin\plugin-pure.test.js
# ℹ tests 21 / pass 21 / fail 0
```

新增覆盖：`resolveWorkspace` 优先级（header > cwd > meta > process.cwd()）与不抛错回退；消息记忆 `workspace:<label>`/project/cwd note；Agent 节点三节聚合 + 工具参数/结果摘要与 `callId` 关联 + 结论取"最后一段 assistant text" + `source.note`/importance/type/标签；敏感信息（推理/工具参数/结果/结论）脱敏；`autoMemoryAgentMaxToolNodes` 截断与"共 N 个仅保留前 M 个"提示；失败结果标注；同 session+turn 去重；空回合跳过；独立每时限流；`off` 模式不缓冲不写；配置默认值与非法值回退/裁剪。

### 11.6 风险与回滚

- **回滚**：`plugin_manager remove_bundle target=dsh-plugin-fca-memory` → `install_bundle target=D:\FCA\FCA-Memory-Atlas\.cache\plugin-relink-v014\package`（v0.1.4 目录仍在，profile 备份在 `.cache\plugin-relink-v020\backup\`）。回滚不需要重启 DSH。
- **记忆量**：每回合 1 条 Agent 节点，`autoMemoryAgentMaxPerHour=60` 独立限流；正文 ≤12,000 字；空回合不写、同回合去重。长时间多会话并发时仍受总队列（`eventQueueLimit`）与 3 次重试上限保护。
- **隐私**：推理/工具参数/结果/结论全部先过 `redactor`（内置 Bearer/`sk-*`/authorization/apikey-token 字段 + `redactPatterns`）再截断；日志只写会话前缀/回合/工具数/字符数，不写正文。工具参数可能包含本机路径/命令，均只写入本机 `127.0.0.1` Runtime。
- **项目实体副作用**：每个工作区 label 会 find-or-create 一个 `<label> 工作区` project 实体并生成 `belongs_to_project` 关系；这是本需求"同一工作区归一条旋臂"的分组依据，若不需要可把 project 字段去掉（tags 仍保留 `workspace:*`）。
- **未覆盖**：本插件无 Client/Web 半，UI 中"星云按 workspace 分组渲染"由桌面/Unity 侧消费 tags（不在本插件范围）；`/fca` 命令 UI 执行验证缺口同 §8.1。

---

## 11.7 v0.2.1：子会话 user-role 消息过滤 + 噪声清理（真实回归，2026-11-12 19:34–19:36）

### 11.7.1 问题与根因（真实会话数据结构）

v0.2.0 上线后 Runtime 里出现 3 条标题为 teammate 启动提示词的 episodic 记忆。用真实会话日志（`<DSH_HOME>\sessions\--D-FCA--\*\session.v4.jsonl.zstd`，DSH session 格式 v4）确认：

| 会话 | `header.parentSession` | `header.origin` | `header.delegationDepth` | 首条 `user/message` 的 `data.source.kind` |
|---|---|---|---|---|
| `session-d9ea76db…`（人类根会话） | 无 | 无 | `0` | `user-approval` 等注入；真实用户消息为 `user` |
| `c5ed45ae…`（unity-renderer teammate） | `session-d9ea76db…` | `subagent` | `1` | **`user`**（spawn prompt 正文「你是 …Unity 星云渲染…负责人」） |
| `3c4e45fe…`（memory-pipeline teammate） | `session-d9ea76db…` | `subagent` | `1` | **`user`**（spawn prompt 正文「你是 …自动记忆管线…负责人」） |
| `3d3bcb2a…`（desktop-integration teammate） | `session-d9ea76db…` | `subagent` | `1` | **`user`**（spawn prompt 正文「你是 …Electron ↔ Unity 集成…负责人」） |

**根因**：子代理会话的 spawn prompt 由 Host 以普通 `user/message`（`source.kind = "user"`）下发；v0.2.0 只按 `source.kind` 过滤注入消息，因此把 teammate 启动提示词当成了真实用户输入。真实 DSH `SessionHeader` 校验源码（`app.asar/node_modules/@deepseek-ai/dsh-session`）确认字段为 `parentSession` / `origin`（只允许 `"subagent"`）/ `delegationDepth`。

### 11.7.2 修复（v0.2.1）

新增 `dsh_plugin/src/session-scope.js`：`describeSessionScope(session)` 判定会话作用域——`header.parentSession`（兼容 `parentSessionId`）存在、或 `header.delegationDepth > 0`、或 `header.origin === "subagent"` 即为 **child**；无 lineage 字段（含 fork/seeded 的人类会话）保持 **root**（绝不因形状变化吞掉真实用户消息）。`auto-memory.js` 对 user 消息只写 root 会话；child 会话的 user 消息计入新计数器 `skippedChildSession` 并 debug 日志记录原因（`parent-session`/`delegation-depth`/`origin-subagent`）。**Agent 思考节点（turn/end 聚合）对子会话保持采集**。`fca_status.auto_memory` 新增 `sessions{root,child,policy}` 与 `counters.skippedChildSession`。

### 11.7.3 真实回归证据（真实子代理会话，非注入）

- 升级 v0.2.1 后（新目录解包 → remove+install，未重启 DSH）启动一个**真实 workflow 子代理会话** `6d4ba096-217c-435f-84aa-204324750d18`（header：`parentSession=3c4e45fe…`、`origin=subagent`、`delegationDepth=2`），其 spawn prompt 为 `user/message seq=9`、`data.source.kind="user"`、正文以「这是 FCA 插件的子会话过滤回归探针…」开头。
- Runtime 结果（`GET /api/v1/memories`）：**该 spawn prompt 没有产生任何 episodic 记忆**（按正文关键字检索命中数 = 0）；该子会话的 Agent 思考节点按设计仍写入（`mem_<redacted>`，procedural，tags=`Agent思考节点,DSH会话,workspace:FCA`），作为测试残留已软删除并在证据中保留完整 JSON。
- 插件计数器（同次 `fca_status`）：`auto_memory.sessions={"root":0,"child":2,"policy":"user-messages: root human session only; agent nodes: every session"}`；`counters={"seen":5,"captured":0,"stored":1,"skippedChildSession":5,…}`；`agentNodes.counters={"eventsSeen":86,"turnsSeen":1,"captured":1,"stored":1,…}`；`capture.counters={"received":1,"sent":1,…}`。即：子会话 user 消息 5 条全部跳过、captured=0，Agent 节点照常 1 条。
- 证据文件：`artifacts/plugin/v0.2.1-child-filter-evidence.json`（真实 session header/首条 user 消息/计数器快照/子会话 Agent 节点全文与清理记录）、`artifacts/plugin/v0.2.1-install-log.json`（打包/安装/Host 日志/单测）。

### 11.7.4 3 条 teammate 提示词噪声清理（真实 Runtime 软删除）

删除方式：`DELETE /api/v1/memory/{id}`（默认软删除 = 回收站，非硬删除；未使用 `hard=true`）：

| memory id | 来源（真实 session） | 会话 type |
|---|---|---|
| `mem_<redacted>` | `3d3bcb2a…`（desktop-integration 启动提示词） | episodic |
| `mem_<redacted>` | `3c4e45fe…`（memory-pipeline 启动提示词） | episodic |
| `mem_<redacted>` | `c5ed45ae…`（unity-renderer 启动提示词） | episodic |

验证（`artifacts/plugin/v0.2.1-cleanup-evidence.json`）：三条 `DELETE` 均 `200`；`GET /api/v1/graph` 节点数 **12 → 9**，三条均不在 graph；`GET /api/v1/memories` total **11 → 8**，默认列表不含三条；`GET /api/v1/memories?include_deleted=true` 仍可检出（回收站可恢复）。当前活跃记忆 8 条：2 条 Agent 思考节点（`mem_f700699…`、`mem_48e6e58…`）+ 5 条真实用户消息 + 1 条手工语义记忆，**无任何 teammate 提示词记忆**。

### 11.7.5 已知观察（如实标注，非本插件行为）

- 升级前后观察到：早于 v0.2 写入的旧自动记忆（`mem_5a0c18…` 等）的 tags 已被补上 `workspace:FCA`。该补标不是本插件代码行为（插件无历史记忆迁移逻辑），应为 Lead/其它流程另行回填；本插件只保证**新写入**记忆带 `workspace:<label>`。旧记忆无标签时渲染端归 default 旋臂的约定不变。
- 2026-11-12 19:34:26 Runtime pid 由 14248 变为 52104（其他 teammate 操作所致，非本任务执行；数据目录/数据完整，记忆数一致）。

### 11.7.6 v0.2.1 交付与验证

- 交付包：`artifacts/plugin/dsh-plugin-fca-memory-0.2.1.tgz`（51,184 B，20 文件，SHA256 `ED799DC1D2F186DF862D34D42A88FAEC1CFD905C12D2BDE9EC91054537937403`）；`engines.fcaRuntime` 仍为 `>=0.1.0 <0.2.0`（与 Runtime 0.1.0 兼容）。
- 安装：`plugin_manager remove_bundle`（`application:"applied"`）→ `install_bundle target=…\.cache\plugin-relink-v021\package`（`application:"applied", version:"0.2.1"`）；Host 日志 `2026-11-12T10:34:51.555Z plugin loaded {…,"autoMemoryAgentNodes":"summary"}`；profile 依赖 `link:…/plugin-relink-v021/package`；未重启 DSH。
- 单测：`tools\node.cmd --test tests\unit\plugin\plugin-pure.test.js` → **24/24 PASS**（新增 session-scope 判定、子会话 user 消息过滤 + skippedChildSession、子会话 Agent 节点仍采集、根会话不受影响）。
- 真实用户消息的 workspace 标签回归：本轮期间根会话没有新的真实用户输入；该路径的观测点仍为"用户下一条真实消息"（写入时必带 `workspace:FCA`，由 24 项单测 + 真实事件回放覆盖）。`skippedChildSession` 的真实增长已由 T20 证明子会话过滤生效。


---

## 12. v0.3.x：时间戳 + 子 Agent 全量记忆 + 父子层级 + 上下文恢复（2026-11-13 真实验证）

> 结论：**v0.3.1 已在真实 DSH Host + 真实 Runtime 中生效**（实际安装——非 stub）。真实子代理会话 → 插件自动写入「子 Agent 会话」episodic 记忆（`occurred_at` exact、契约 tags、`children:` 父标记）→ Runtime 真实 `custom/spawned_subagent` 父子关系 + 子记忆 `parent-memory:` 兜底 tag；`fca_memory_context` 真实返回工作区最近记忆/Agent思考节点/子Agent会话/关键决策；恢复指令（systemPrompt.section）真实出现在 Agent 提示中。原始证据：`artifacts/plugin/v0.3.1-install-log.json`、`v0.3.1-tag-repair.json`、`v0.3.1-noise-cleanup.json`、`v0.3.0-evidence.json`。

### 12.1 版本与安装（真实）

- `dsh-plugin-fca-memory@0.3.1`；tgz：`artifacts/plugin/dsh-plugin-fca-memory-0.3.1.tgz`（68,625 B，22 文件，SHA256 `651F764CB393D693725204988996399D69377EBDC143B16E1563A2741A0076E5`）。
- 升级路径（不重启 DSH、不重启 Runtime）：解包到新目录 `.cache/plugin-relink-v031/package` → `plugin_manager remove_bundle` → `install_bundle`（`application:"applied"`，`version:"0.3.1"`）→ Host 日志 `plugin loaded` → `fca_status.plugin.version="0.3.1"`、`started_at="2026-11-12T16:43:55.409Z"`、`local.runtimeScriptPath` 指向 v031 包目录。
- `enables.fcaRuntime` 仍为 `>=0.1.0 <0.2.0`（与 Runtime 0.1.0 兼容）。

### 12.2 记忆时间戳（用户："更新记忆自动记录时间"）

- 所有自动记忆写 `occurred_at`（ISO）+ `occurred_precision="exact"`：用户消息取 `user/message.time`；Agent思考节点取回合首个事件时间；子会话记忆取子会话首条事件时间。实现见 `src/time.js`。
- 真实样例（Runtime API）：
  - 用户消息 `mem_<redacted>`「旋臂布局不修改的前提下调整节点布局，同一条链在同一旋臂」→ `occurred_at=2026-11-12T16:43:35.332Z`、`precision=exact`、tags=`DSH用户消息,DSH自动记忆,workspace:FCA`；
  - 用户消息 `mem_863af208…` → `2026-11-12T16:40:22.891Z`；`mem_e5ad55…` → `16:40:07.304Z`（均为真实用户输入，非注入）；
  - 子会话记忆 `mem_87cf63da…` → `2026-11-12T16:44:13.898Z`；父回合 `mem_63aa5ac5…` → `16:44:11.360Z`。
- 旧记忆不迁移（无 occurred_at 的仍显示未知，符合任务约定）。

### 12.3 子 Agent 全量采集 + 父子层级（真实子代理会话）

**真实触发**：teammate `dsh-plugin` 在真实会话中用 workflow 启动 1 个最小子代理（child 会话 `09be92a1…`，parent=`c3769704…`，delegationDepth=2），子代理真实执行 `Get-Content .../package.json | Select-String '"version"'` 并回复 `0.3.1`。子代理 turn/end + dsh-plugin 的 turn/end 被插件 v0.3.1 自动聚合：

| 角色 | memory id | title | occurred_at | tags |
|---|---|---|---|---|
| 父回合（子会话 dsh-plugin 的回合） | `mem_<redacted>` | `子 Agent 会话 · FCA · c3769704` | `2026-11-12T16:44:11.360Z` | `Agent子会话`,`DSH会话`,**`children:09be92a1`**,`parent-session:d9ea76db`,`subagent-session:c3769704`,`workspace:FCA` |
| 子（workflow probe） | `mem_<redacted>` | `子 Agent 会话 · FCA · 09be92a1` | `2026-11-12T16:44:13.898Z` | `Agent子会话`,`DSH会话`,**`parent-memory:mem_63aa5ac5…`**,`parent-session:c3769704`,`subagent-session:09be92a1`,`workspace:FCA` |
| **父子关系** | `rel_a95800f55ab551511dac55a74b6052a8` | `custom` / label `spawned_subagent` / directed=true / confidence=1 / weight=1 / source=agent | created `2026-11-12T16:44:23.227Z` | from=`mem_63aa5ac5…` → to=`mem_87cf63da…` |

- 子会话记忆 body 分节（真实数据）：`时间：… · 第 N 回合 · 子会话：09be92a1 · 父会话：c3769704` + `【任务】`（spawn prompt 原文，脱敏/截断）+ `【关键推理】` + `【工具执行】`（工具名/参数摘要/结果摘要）+ `【结果】` + `【结论】`；`memory_type=episodic`、`importance=0.5`。
- 插件计数器（真实 `fca_status`，v0.3.1 进程内）：`subagentSessions.counters={"eventsSeen":94,"turnsSeen":2,"captured":2,"stored":2,"spawnPromptsSeen":1,"toolCallsSeen":30,"toolResultsSeen":28,"childrenTagged":1,"idNormalizeFailed":0}`；`relations.counters={"attempted":1,"created":1,"failed":0,"tagPatchAttempted":1,"tagPatched":1,"idNormalizeFailed":0}`；`tagNormalization.failed=0`。
- 层级可视化数据链：父记忆 tags `children:<childId8>`（每个子会话一个独立 tag）→ 子记忆 tags `parent-session:<parentId8>` + `parent-memory:<父memoryId>` → Runtime relation `custom/spawned_subagent`，Unity/桌面可直接按 tag 或 relation 展开子节点。

### 12.4 tag id8 规范化修复（v0.3.1，Lead 真实 graph 发现）

- 问题：`session-<uuid>` 形式父会话直接取前 8 位得到无意义 `parent-session:session-`（真实受影响：`mem_cfd58ede…`、`mem_efe91a48…`、`mem_b5f20ae8…`）。
- 修复：`sessionId8` 先去 `session-` 前缀再取 8 位（`session-d9ea76db-…` → `d9ea76db`）；对象引用取 `.sessionId/.session_id/.id`；`children:/subagent-session:/parent-session:` 与 source.note 统一使用；失败计数 `fca_status.tagNormalization.failed` + `subagentSessions.counters.idNormalizeFailed` + `relations.counters.idNormalizeFailed`。
- 真实修复：3 条存量记忆 PATCH tags（`parent-session:session-` → `parent-session:d9ea76db`，HTTP 200，证据 `v0.3.1-tag-repair.json`）；v0.3.1 上新写入的 3 条子会话记忆 tags 均为 8 位 hex（见 §12.3，`tagNormalization.failed=0`）。

### 12.5 `fca_memory_context` 上下文恢复工具（真实调用）

真实 Agent 会话（本 teammate）运行 `fca_memory_context({workspace:"FCA",limit:6,turnLimit:3,subagentLimit:3})` 的真实返回（节选）：

```json
{"ok":true,"workspace":{"label":"FCA","cwd":"D:\\FCA","source":"session.header.cwd"},
 "generated_at":"2026-11-12T16:44:54.502Z",
 "counts":{"recent_memories":6,"agent_turn_nodes":3,"subagent_sessions":3,"key_decisions":3},
 "recent_memories":[{"id":"mem_<redacted>","title":"子 Agent 会话 · FCA · 09be92a1",
   "occurred_at":"2026-11-12T16:44:13.898Z","tags":["Agent子会话","DSH会话","parent-memory:mem_63aa5ac5…",…]}, …],
 "subagent_sessions":[… 3 条，含 occurred_at / tags / excerpt …],
 "key_decisions":[{"id":"mem_c49e6620…","title":"unity版不要单独开窗口，要集成软件内显示"}, …],
 "recovery":{"needs_recovery":false,"compacted_at":null,"compaction_count":0}}
```

### 12.6 compaction 恢复注入（真实能力 + 如实限制）

- 真实 Host API（`@deepseek-ai/dsh-system-prompt`）支持 `systemPrompt.section()`（静态注入）与 `systemPrompt.context()`（每次提示组装动态调用，`AssembleContext.agent` 可取会话）；插件 v0.3 注册：
  - section `fca-memory-recovery-instruction`（order 940）：常驻"压缩后/记不清时必须先调用 fca_memory_context"规则 —— **真实出现在本 teammate 会话的提示中（已观测）**；
  - context `fca-memory-recovery-state`（order 941）：监听真实 `compaction/start|prune|summary|end` 事件，`compaction/end` 后渲染压缩次数/时间/摘要开头并提示重读；模型调用 `fca_memory_context`（`tool/call` 事件）后自动清除。
- **真实限制（如实）**：插件自身不触发 compaction；本机在 v0.3.x 安装后尚未发生新的真实压缩事件（`fca_status.compactions.eventsSeen=0`、`recovery.renders=0`），因此 `compaction→提醒` 路径由单测（真实 compaction 事件形状）+ 历史真实压缩会话事件回放覆盖；下一次真实压缩会自动生效。若无插件环境，兜底方案是在项目/代理指令中写明"压缩后必须先调用 fca_memory_context"（插件已自动注入同规则）。

### 12.7 单元测试与清理

- `tools\node.cmd --test tests\unit\plugin\plugin-pure.test.js` → **33/33 PASS**（时间戳/子会话全量聚合/契约 tags/children 独立 tag/嵌套层级 relation/custom 失败回退 derived_from/parent-memory tag/compaction→恢复状态→tool 清除/fca_memory_context 构造/systemPrompt 注册与动态渲染/id8 规范化）。
- 测试噪声清理（真实软删除，`DELETE /api/v1/memory/{id}`，回收站可恢复）：删除前两次父子探针的重复记忆对 4 条（`mem_efe91a48…`、`mem_8f2bf64e…`、`mem_b5f20ae8…`、`mem_146e9c3e…`），保留最终 v0.3.1 验证对与真实 teammate 会话记忆；graph nodes 57→53、memories 50→46（include_deleted 60）。证据 `v0.3.1-noise-cleanup.json`。

