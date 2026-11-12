# DSH 插件集成测试报告（FCA Memory Atlas · Product B）

- 插件：`dsh-plugin-fca-memory@0.1.4`（源码 `D:\FCA\FCA-Memory-Atlas\dsh_plugin`，交付包 `artifacts/plugin/dsh-plugin-fca-memory-0.1.4.tgz`；v0.1.4 新增完全自动记忆 `autoMemory` 与恢复后立即 flush）
- 被测环境（本次全部为真实组件，不含 stub）：
  - DSH NEXT `dsh-desktop-next 2.0.22-next`，profile `desktop`（`C:\\Users\\<user>\.dsh\profiles\desktop`）
  - 真实 FCA Local Runtime `0.1.0`（`D:\FCA\FCA-Memory-Atlas\runtime\bin\fca-runtime.js`），`http://127.0.0.1:17860`
  - 真实数据目录 `%LOCALAPPDATA%\FCA-Memory-Atlas`（`C:\\Users\\<user>\AppData\Local\FCA-Memory-Atlas`），SQLite `db\fca.db`
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
| T6 | 真实 Agent 调用 `fca_memory_store` | 同上（真实 Runtime） | ✅ 返回 `mem_e9fce187752fbcf65a7906c9691c38a2`；另一次由 Lead 真实会话写入 `mem_141a67e43e978e5dc8399f6ca9a78a0a` |
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
    "logPath": "C:\\\\Users\\\\<user>\\.dsh\\profiles\\desktop\\.plugin-manager\\logs\\operation-g0OjQP\\pnpm.log"
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

### 3.1 Host 日志（`C:\\Users\\<user>\.dsh\logs\desktop-next.log`）

```
2026-11-12T08:24:02.481Z [info] plugin loaded {"runtimeUrl":"http://127.0.0.1:17860/","schema":"standard-schema","capturePolicy":"turn-summaries"} [host.kernel.fca-memory-bridge] log {"hostTime":1794471842480,"hostSequence":3,"pluginId":"include:fca-memory-bridge"}
2026-11-12T08:24:03.021Z [info] bridge started {"runtimeUrl":"http://127.0.0.1:17860/","connected":true,"phase":"connected","capturePolicy":"turn-summaries","injectContext":false} [host.kernel.fca-memory-bridge] log {"hostTime":1794471843021,"hostSequence":4,"pluginId":"include:fca-memory-bridge"}
```

同内容也出现在 `desktop-next-2026-11-12.0.jsonl`（`source:"host.kernel.fca-memory-bridge"`、`level:"info"`）。

### 3.2 新代码确实在运行（Node 探测链修复的运行时证据）

`fca_status` 返回（节选）：

```json
"local": {
  "fcaHome": "C:\\\\Users\\\\<user>\\AppData\\Local\\FCA-Memory-Atlas",
  "fcaHomeExists": true,
  "tokenPath": "C:\\\\Users\\\\<user>\\AppData\\Local\\FCA-Memory-Atlas\\config\\runtime-token",
  "tokenPresent": true,
  "runtimeScriptPath": "D:\\FCA\\FCA-Memory-Atlas\\runtime\\bin\\fca-runtime.js",
  "runtimeScriptPresent": true,
  "nodePath": "C:\\\\Users\\\\<user>\\AppData\\Local\\Programs\\DSH NEXT\\resources\\runtime\\x64\\primary-runtime\\dependencies\\node\\bin\\node.exe",
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

`cordis_inspect_query(host, Tool, listTools)` 返回的工具列表中出现且仅出现这 4 个 `fca_*` 工具（`C:\\Users\\<user>\AppData\Local\Temp\dsh-spill-…\…cordis_inspect_query.txt` 行 386/449/515/536）：

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
      "memory":{ "id":"mem_e9fce187752fbcf65a7906c9691c38a2", "title":"FCA 插件真实链路验证：DSH Agent 写入",
                 "memory_type":"episodic", "importance":0.8, "tags":["dsh-plugin","e2e","真实链路"],
                 "version":1, "deleted":false },
      "runtime":{ "url":"http://127.0.0.1:17860", "version":"0.1.0", "api_version":"1" } }

fca_memory_search(query:"FCA-PLUGIN-E2E 真实链路 插件验证", mode:"hybrid", limit:5)
  → { "ok":true, "count":2, "took_ms":1.17,
      "items":[ {id:"mem_e9fce187752fbcf65a7906c9691c38a2", score:1, excerpt:"…"},
                {id:"mem_141a67e43e978e5dc8399f6ca9a78a0a", score:0.20839, excerpt:"…"} ] }

fca_memory_get(id:"mem_e9fce187752fbcf65a7906c9691c38a2")
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

真实 Runtime 自身访问日志 `C:\\Users\\<user>\AppData\Local\FCA-Memory-Atlas\logs\runtime-20261112.log`（节选，`user_agent:"node"` 即插件 Host 内 `fetch` 发起的真实请求；`user_agent` 为 Windows PowerShell 的是测试者的旁路探针）：

```
08:24:02.551Z GET    /health                     200 client=dsh-plugin trace=trc_8b1df1181822a63ab8907db27deee098 bytes=158
08:24:11.327Z POST   /api/v1/memory/store        201 client=dsh-plugin trace=trc_db1b246a7aa59debfdd73933a4d1da45 bytes=1600
08:24:11.662Z POST   /api/v1/memory/store        201 client=dsh-plugin trace=trc_bfd720bbdb7792cd7500ca7441e6eb44 bytes=1226
08:24:13.726Z POST   /api/v1/memory/search       200 client=dsh-plugin trace=trc_5626740ceae3a35b3ae53e61917fd863 bytes=4485
08:24:13.728Z GET    /api/v1/memory/mem_141a67e…200 client=dsh-plugin trace=trc_ec4b22c62c5b734390dc8a9b8a34a0c0 bytes=2186
08:24:14.681Z POST   /api/v1/memory/search       200 client=dsh-plugin trace=trc_b4c3fdf34fb96308292315a775f44a27 bytes=3900
08:24:14.682Z GET    /api/v1/memory/mem_e9fce18…200 client=dsh-plugin trace=trc_10a3d5feb0621c3d73c99e7803274f39 bytes=1812
08:24:32.481Z GET    /health                     200 client=dsh-plugin trace=trc_69e6efb91ae1c6904749e285340ae54c bytes=158
08:25:02.481Z GET    /health                     200 client=dsh-plugin trace=trc_e4c5ec6e912cc3311f6adb1500e4ecad bytes=159
08:25:32.481Z GET    /health                     200 client=dsh-plugin trace=trc_b1f0388a69b39e1dd52ed4cd03419630 bytes=159
08:26:02.481Z GET    /health                     200 client=dsh-plugin trace=trc_41b1e6b65755d4fec0ad63f9a64ec7c6 bytes=159
08:26:32.480Z GET    /health                     200 client=dsh-plugin trace=trc_8046ad4bdbeacd86061c812b7b61b8d9 bytes=159
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

- 早期用 PowerShell 变量 `$home` 撞上只读变量 `$HOME`，stub 曾在 `C:\\Users\\<user>\` 下创建 `config/ logs/ events/ db/`；已核对创建时间与内容后按绝对路径删除。本次验证前该数据目录已由 Runtime 重新 `init`（真实 `db\fca.db`、schema_version=1、token 64 位）。

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
  "data_dir": "C:\\\\Users\\\\<user>\\AppData\\Local\\FCA-Memory-Atlas",
  "db_path": "C:\\\\Users\\\\<user>\\AppData\\Local\\FCA-Memory-Atlas\\db\\fca.db",
  "token_path": "C:\\\\Users\\\\<user>\\AppData\\Local\\FCA-Memory-Atlas\\config\\runtime-token",
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
- 另有一条由 Lead 真实会话写入的 `mem_141a67e43e978e5dc8399f6ca9a78a0a`（场景 C 证据），同样 `created_by={kind:"agent",id:"dsh-plugin"}`。

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
 "subject":{"kind":"memory","id":"mem_e9fce187752fbcf65a7906c9691c38a2"},
 "payload":{"memory_id":"mem_e9fce187752fbcf65a7906c9691c38a2","title":"FCA 插件真实链路验证：DSH Agent 写入", …},
 "trace_id":"trc_bfd720bbdb7792cd7500ca7441e6eb44","client_event_id":null,"seq":7}
```

### 7.5 验证数据的清理

- 测试者用 Windows PowerShell 旁路探针写入的乱码记忆 `mem_cb340f8a37fc02b2cbdda32db0a18194`（标题 `????:?? Runtime ????`，PowerShell 管道编码问题）已通过真实 API **软删除**：
  - `DELETE /api/v1/memory/mem_cb340f8a37fc02b2cbdda32db0a18194` → `200`，返回 `version:2`、`deleted_at:"2026-11-12T08:25:34.795Z"`；
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
      "trace_id":"trc_2adbf41782efa35bb595f059f42ff3a0",
      "client_event_id":"dsh:a9e94d45-…:22:turn/end","seq":15}
     ```
     → `payload` 仅含 `dsh.event/seq/session_id` + `turn` + `reason`，**无任何消息正文**（turn-summaries 策略）；`client_event_id` 幂等键形状符合契约。
  4. **Runtime HTTP 访问日志**（`<FCA_HOME>\logs\runtime-20261112.log`）：
     ```json
     {"ts":"2026-11-12T08:37:32.549Z","level":"info","msg":"http.request","kind":"access",
      "method":"POST","path":"/api/v1/event","status":201,"ms":3,
      "trace_id":"trc_9ecb880f7365ce0c5548d05b4f5fd02a","client":"dsh-plugin","ip":"127.0.0.1",
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
  "node": "C:\\\\Users\\\\<user>\\AppData\\Local\\Programs\\DSH NEXT\\resources\\runtime\\x64\\primary-runtime\\dependencies\\node\\bin\\node.exe",
  "node_source": "dsh-runtime",
  "script": "D:\\FCA\\FCA-Memory-Atlas\\runtime\\bin\\fca-runtime.js",
  "pid": 9984, "error": null }
```

- Runtime 自身日志佐证：`{"ts":"2026-11-12T08:35:52.918Z","level":"info","msg":"FCA Local Runtime 已启动","url":"http://127.0.0.1:17860","pid":9984,"data_dir":"C:\\\\Users\\\\<user>\\AppData\\Local\\FCA-Memory-Atlas","initialized":true}`；随后 `GET /health` → 200。
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
- `GET /api/v1/graph`：nodes 由 1 → 7，其中自动生成节点 `mem_12bf435c7d38c7c020db77c1ea6325c1` 标题即为该消息首行；全部是真实数据库记录（可在桌面星图看到）。
- 同批还发现：`runtime-context`、`skill-catalog`、`time-context`、`tool-jobs`、`agent-message` 等 **Host 注入的 user-role 消息被误采集**（共 5 条噪声），已定位并修复。

**B. 过滤与收尾修复（v0.1.3/v0.1.4）**

- 修复：`src/auto-memory.js` 增加 `source.kind === 'user'` 门禁（仅真实用户消息）；`src/bridge.js` 自动拉起 Runtime 成功后立即 flush 审计事件与自动记忆队列；版本 `PLUGIN_VERSION` 0.1.4。
- 单元测试（`node --test tests/unit/plugin/plugin-pure.test.js`）：**14/14 PASS**，新增覆盖：自动记忆标题/正文/来源/标签/类型、短消息/重复/助手消息跳过、脱敏、`all` 模式、每时限流、`off` 模式、**只采集真实用户消息（6 类 Host 注入消息全部 skippedNonText）**。
- 已安装 v0.1.4 到 desktop profile（`plugin_manager install_bundle`：`application:"applied"`，`version:"0.1.4"`）；`fca_status` 显示 `phase=connected`、`auto_memory.mode=user-messages/enabled=true`、`runtime.reachable=true`。
- 数据清理：v0.1.2 产生的 6 条测试/噪声自动记忆已软删除（保留 `mem_<redacted-id> · 示例偏好记忆`）。

**C. 待 confirm（如实标注）**

- v0.1.4 安装发生在本次交付会话进行中；其"真实 UI 用户消息 → 自动写入"的最终确认需**用户下一次在任意 DSH 会话中输入消息**后复查 `fca_status.auto_memory.counters.stored` 与桌面星图节点（插件监听 Host 根作用域，跨会话事件可达性已由 A 证明）。这属于观测时点问题，不是未实现功能。

### 10.3 配置与关闭

`cordis.patch.yml` 交付默认：`autoMemory: user-messages`、`autoMemoryMaxPerHour: 120`、`autoMemoryMaxChars: 2000`、`autoMemoryMemoryType: episodic`、`autoMemoryTags: [DSH自动记忆]`。把 `autoMemory` 改为 `off` 并重新安装/更新插件即可关闭自动写入。
