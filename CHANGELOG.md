# 变更日志（FCA Memory Atlas）

本项目遵循语义化版本：`MAJOR.MINOR.PATCH`。Alpha 阶段允许小版本内调整内部实现，但 `docs/PUBLIC_INTERFACE_FREEZE.md` 的公共契约只能由 Lead 审核后变更并记录于下。

## [0.2.1] — 2026-11-12（Runtime 稳定性修复：EPIPE 死循环 / 启动超时）

### 修复

- **Runtime：父进程崩溃后 EPIPE 导致 uncaughtException 死循环、/health 超时（严重）**
  - 根因：桌面 app 被强杀后，其子 Runtime 继承的 stdout/stderr 管道关闭；`logger` 对 stderr 的写入异步触发 `EPIPE` 的 `'error'` 事件，而 Runtime 未监听该事件 → `uncaughtException` → handler 再次 `logger.error` 写 stderr → 再次 EPIPE，形成无限刷屏循环，事件循环被占满，HTTP `/health` 超时；app 随后自动重启 Runtime 又遇到 `PORT_IN_USE`，进入 30s 启动超时，界面显示 Runtime 未连接。
  - 修复：`runtime/src/runtime.js` 在进程级监听 `process.stdout/stderr` 的 `'error'` 事件并忽略 EPIPE（READY 行写入加保护）；`uncaughtException` handler 对 EPIPE/管道关闭类错误直接忽略、不再调用 logger（`isBrokenPipeError`）；`runtime/src/logging/index.js` 在首次控制台错误后永久关闭 stderr 输出（仅保留 JSONL 文件日志），Runtime 继续对外服务。
  - 验证：新增回归测试 `runtime/test/logger-epipe.test.js`（3 项 PASS）；真实复现脚本 `.cache/audit/verify-epipe-fix.mjs` 模拟父进程死亡（关闭子进程管道）后连续 6 次 `/health` 均 200（2-3ms），日志 0 条 EPIPE/uncaughtException；`scripts/verify.js` 23/23 PASS。
- **桌面：Runtime 子进程退出/端口占用时白等 30s 才失败（体验）**
  - 根因：`waitForHealthy` 只判断 `ownedByUs === false` 的退出；自家 spawn 的子进程因 `PORT_IN_USE` 退出时状态已是 error，却仍循环到 30s 超时。
  - 修复：`desktop/main/runtime-manager.js` 在子进程已退出且状态为 error 时立即抛出真实错误（含 PORT_IN_USE 日志提示），不再空等超时。
- 本机已部署修复到 `D:\FCA-Memory-Atlas`（runtime + desktop main），重启后 Runtime healthy、app 已连接；安装包/Release v0.2.1 由 packaging 重新构建发布。

## [0.2.0] — 2026-11-12（Unity 星云 + 工作区旋臂 + 插件 0.2.1）

### 新增

- **Unity 星云渲染器（可选组件，默认启用）**：独立 Windows standalone（Unity 2022.3.62f3，Built-in RP，无需 URP/HDRP），随安装包分发到 `<安装目录>\unity\FCANebula\`。
  - 数据源为真实 Runtime `GET /api/v1/graph`（Bearer token）+ `/state` + 点击 `/memory/{id}`，3s 轮询、失败回退链；不伪造数据。
  - **工作区旋臂**：按 `workspace:<label>` 标签把同一工作区记忆归到同一条对数螺旋旋臂；无标签记忆进 `default` 臂（旧记忆无需迁移）；体积星云 shader 跟随旋臂着色（FCA/DSH/工作区图例同源）。
  - 体积星云（FBM 域扭曲 + 尘埃 + 背景星场）、GPU instancing 星点、关系光丝 ribbon、IMGUI HUD（连接状态/工作区图例/点选详情/错误横幅）。
  - 无人值守截图模式（overview / workspace-arm / top-down）产出真实数据截图与 `screenshots-manifest.json`。
- **桌面端 Unity 集成（默认 Unity，失败自动回退 WebGL）**：设置项 `nebulaEngine`（`unity` | `webgl`，默认 `unity`）；星云视图显示 Unity 状态卡（打开/关闭/运行状态/失败原因），Unity exe 缺失、启动失败或被用户关闭时自动回退内置 WebGL 星云（功能不缺失）；`desktop/main/unity-viewer.js` 负责进程生命周期与状态 IPC。
- **DSH 插件 v0.2.1**：过滤子会话 user-role 消息（避免 teammate/子代理提示词被当作真实用户记忆），清理 3 条历史噪声记忆；`src/session-scope.js` 统一定义会话作用域；`engines.fcaRuntime` 仍为 `>=0.1.0 <0.2.0`（与 Runtime 0.1.0 兼容）。详见 `CHANGELOG.md` 插件 0.2.1 条目与 `docs/PLUGIN_INTEGRATION_TEST.md`。
- **安装包 v0.2.0**：payload 增加 `unity/FCANebula`（可选组件，构建时存在则打包并在 `BUILD_INFO.json`/`install-report.ini` 记录；缺失时 WARN 不阻塞，桌面回退 WebGL）；卸载器递归清理 `unity/` 与 `dsh_plugin/`；安装实测覆盖 Unity 组件存在性。产物 `artifacts/installer/FCA-Memory-Atlas-Setup-0.2.0-x64.exe`。
- **文档**：`docs/UNITY_NEBULA.md`（Unity 渲染/数据契约/构建/Electron 集成/回退/限制）、`docs/FINAL_ACCEPTANCE.md`（v0.2.0 验收）、`docs/INSTALL_TEST.md`（0.2.0 实测）、README/CHANGELOG 更新；`deploy/DEEPSEEK_AGENT_PROMPT.md` 更新安装包版本与 Unity 组件说明。

### 变更

- 桌面默认星云引擎从 WebGL2 切换为 Unity standalone（保留 WebGL 回退）；WebGL 渲染器继续保留为回退与无 GPU/无 Unity 场景的保障。
- 版本号统一：root `package.json`、`desktop/package.json` = **0.2.0**；插件 = **0.2.1**；Runtime/API 保持 0.1.0 / v1（接口未变）。
- 安装包体积由 v0.1.x 约 99 MB 增至 v0.2.0（Unity 组件压缩后增量约 20–25 MiB，最终值见构建报告 `payload.unity_bytes` 与 `artifacts/installer/FCA-Memory-Atlas-Setup-0.2.0-x64.sha256.json`）。

### 修复

- 插件：子会话（subagent/team）的 user-role 提示词不再被采集为真实用户记忆；清理本地测试库 3 条 teammate 提示词噪声记忆（软删除）。
- 安装器：卸载新增清理 `unity/`、`dsh_plugin/` 目录；`install-report.ini`/`BUILD_INFO.json` 记录 Unity 可选组件信息。

- **产品版本显示**：修复 v0.2.0 仍显示 `Alpha 0.1.0` 的问题——`desktop/main/paths.js` 的 `PRODUCT_VERSION` 改为从 `desktop/package.json` 的 `version` 派生（回退 `0.2.0`）；标题栏显示 `Alpha 0.2`、状态栏显示 `Alpha 0.2.0`（Lead 提交 `8864424`，最终安装包已包含）。
### 已知限制（v0.2.0 新增）

- Unity standalone 需要可用的桌面会话与 GPU/驱动（无 GPU 时回退 WebGL）；体积着色器最多同时渲染 8 条旋臂（超出时 HUD 提示，节点仍按正确旋臂分布）。
- Unity 渲染器无 SSE，使用 3s 轮询；HUD 使用 IMGUI + 系统字体（无中文字体环境显示方块，功能不受影响）。
- DSH 工具 shell 内嵌套启动 Electron/Unity 需 `--no-sandbox` 并清理 `ELECTRON_RUN_AS_NODE`/`CHROME_CRASHPAD_PIPE_NAME`（仅测试环境；用户从 Explorer 启动不需要）。
- 其余既有已知问题见 `docs/KNOWN_ISSUES.md`。

---
## [DSH 插件 0.2.1] — 2026-11-12（子会话 user-role 消息过滤 + 噪声清理）

- **问题**：v0.2.0 后 Runtime 出现 3 条标题为 teammate 启动提示词的 episodic 记忆。真实会话日志确认根因：subagent/teammate 的 spawn prompt 由 Host 以普通 `user/message`（`data.source.kind="user"`）下发，而旧过滤只检查 `source.kind`；真实 DSH `SessionHeader` 明确带 `parentSession` / `origin:"subagent"` / `delegationDepth` 可区分根会话与子会话。
- **修复**：新增 `dsh_plugin/src/session-scope.js`（`describeSessionScope`：`parentSession`（兼容 `parentSessionId`）存在、或 `delegationDepth>0`、或 `origin==="subagent"` → child；无 lineage 字段的 fork/seeded 人类会话仍为 root，不误杀真实用户消息）。`auto-memory.js` 的 user 消息自动记忆只对 **root 人类会话**生效，child 会话的 user 消息计入新计数器 `skippedChildSession`（debug 日志带 `reason`）；**Agent 思考节点（turn/end 聚合）对子会话保持采集**。`fca_status.auto_memory` 新增 `sessions{root,child,policy}` 与 `counters.skippedChildSession`。
- **真实回归（T20）**：v0.2.1 安装后启动真实 workflow 子代理会话 `6d4ba096…`（header `parentSession`/`origin:"subagent"`/`delegationDepth:2`），其 spawn prompt（`user/message`+`source.kind=user`）**未产生 episodic 记忆**；`skippedChildSession=5, captured=0`；该子会话 Agent 节点按设计仍写入（测试残留已软删）。证据 `artifacts/plugin/v0.2.1-child-filter-evidence.json`。
- **清理**：3 条 teammate 提示词噪声记忆（desktop-integration `mem_4359445…`、memory-pipeline `mem_1004e99…`、unity-renderer `mem_9b90878…`）经真实 Runtime `DELETE /api/v1/memory/{id}` **软删除**（回收站可恢复）；`/api/v1/graph` 节点 12→9、`/api/v1/memories` total 11→8，graph 与默认列表均不再出现；`include_deleted=true` 仍可检出。证据 `artifacts/plugin/v0.2.1-cleanup-evidence.json`。
- **交付**：插件版本 `0.2.1`，交付包 `artifacts/plugin/dsh-plugin-fca-memory-0.2.1.tgz`（51,184 B，20 文件，SHA256 `ED799DC1D2F186DF862D34D42A88FAEC1CFD905C12D2BDE9EC91054537937403`）；tgz 解包到新目录 `.cache/plugin-relink-v021/package` 后 remove+install（`application:"applied"`，version 0.2.1，未重启 DSH）；Host 日志 `10:34:51.555Z plugin loaded`；`engines.fcaRuntime` 仍 `>=0.1.0 <0.2.0`。证据 `artifacts/plugin/v0.2.1-install-log.json`。
- **测试**：`tests/unit/plugin/plugin-pure.test.js` 扩至 **24 个用例全部通过**（新增 session-scope 真实 header 形状判定/回退、子会话 user 消息过滤 + `skippedChildSession`、子会话 Agent 思考节点仍采集、根会话真实用户消息不受影响）。

---
## [DSH 插件 0.2.0] — 2026-11-12（工作区归属 + Agent 思考节点自动记忆）

- **工作区归属（`workspace:<label>`）**：自动记忆从真实 DSH `Session` 的 `session.header.cwd`（回退 `session.cwd` / `session.meta.cwd` / `process.cwd()`）推断工作区，取 basename 作为标签（如 `D:\FCA` → `workspace:FCA`）。每条自动记忆的 `tags` 追加 `workspace:<label>`、`source.note` 记录完整 cwd、`project` 设为 `<label> 工作区`（Runtime 自动建项目实体）——桌面/Unity 星云按该标签把同一工作区的记忆归到一条旋臂；旧记忆无需迁移（无标签归默认旋臂）。
- **Agent 思考节点（用户选择"更全"）**：新增 `autoMemoryAgentNodes`（`off` / `summary`，交付 bundle 默认 `summary`）。按 `session:turn` 缓冲 `assistant/message` 的 reasoning/text、`tool/call`（工具名+脱敏参数摘要）、`tool/result`（成功/失败+脱敏结果摘要），在 `turn/end` 聚合为 **1 条** `procedural` 记忆：title=`Agent 思考节点 · 第 N 回合`，body 分三节 `【关键推理】`（前 ≤1500 字）/`【工具执行】`（最多 8 条，名称+参数摘要+结果摘要）/`【结论】`（最后 assistant 文本前 ≤800 字）；tags=`Agent思考节点`+`workspace:<label>`+`DSH会话`；importance 0.55；`source.note` 记录会话前缀+回合+工作区+cwd；同 session+turn 去重、空回合跳过、独立每小时限流、正文上限 12000 字；推理/参数/结果/结论全部先脱敏再截断。
- **配置**：新增 `autoMemoryAgentNodes`、`autoMemoryAgentMaxToolNodes`、`autoMemoryAgentReasoningChars`、`autoMemoryAgentConclusionChars`、`autoMemoryAgentToolArgChars`、`autoMemoryAgentToolResultChars`、`autoMemoryAgentMaxChars`、`autoMemoryAgentMaxPerHour`；默认值保持向后兼容（`autoMemoryAgentNodes` 默认 `off`，bundle 的 `cordis.patch.yml` 默认 `summary`）。`fca_status` 新增 `auto_memory.workspace{last,known}` 与 `auto_memory.agentNodes{...counters}`。
- **交付**：插件版本 `0.2.0`；交付包 `artifacts/plugin/dsh-plugin-fca-memory-0.2.0.tgz`；真实安装到 desktop profile（Host 日志 `plugin loaded` 且 `autoMemoryAgentNodes: "summary"`，`fca_status.plugin.version=0.2.0`）；真实 Runtime 中出现带 `workspace:FCA` / `Agent思考节点` 标签的记忆（见 `docs/PLUGIN_INTEGRATION_TEST.md` §10）。
- **测试**：`tests/unit/plugin/plugin-pure.test.js` 扩至 21 个用例（workspace 推断优先级/回退、消息记忆 workspace 标签与 project、Agent 节点聚合分节/脱敏/工具条数截断/失败结果/去重/限流/off 模式），全部通过。

## [0.1.1] — 2026-11-12（Alpha 0.1.1 热修）

- 修复桌面端记忆编辑器加载已有记忆时调用未定义 `renderTitleBar()` 崩溃（"无法加载记忆"）。
- 修复记忆列表加载完成后不重渲染、永久停留在"正在读取记忆列表…"。
- 修复列表行标签渲染成 `[object HTMLSpanElement]`。
- 安装包版本升至 0.1.1 并重新构建（GitHub Release 同步）；真实已安装应用经 CDP 验证：列表 5 行正常渲染、编辑器打开记忆正常、无 console 错误。
## [0.1.0] — 2026-11-12（Alpha 0.1）

### 新增

- **FCA Memory Atlas 桌面软件**（Windows x64，Electron 38.2.1）
  - 星云式记忆可视化（WebGL2 数据驱动体积星云 + 星体 + 关系光丝，性能档位 ultra/high/medium/low/off）
  - 三栏专业布局、面板可调、布局预设、布局持久化、快捷键
  - 记忆详情/编辑、关系编辑、时间线、搜索（全文/语义/混合）、列表、数据管理、设置、首次启动向导
  - 版本历史、diff、冲突检测（VERSION_CONFLICT）、软删除/回收站、合并/拆分、批量修改
  - 备份/恢复/导入/导出/数据库健康检查（VACUUM）/运行日志查看
  - LLM Provider 配置（DeepSeek / OpenAI 兼容 / 自定义；API Key 本地 AES-256-GCM 加密、界面/日志掩码）
- **FCA Local Runtime**（Node 24，零第三方运行时依赖，SQLite WAL）
  - 完整本地 HTTP API（`/api/v1`）、Bearer 认证、仅回环监听、追踪 ID、统一错误码
  - SSE 实时变更推送（Last-Event-ID 补发 + 心跳）、事件 JSONL 审计镜像
  - 记忆/关系/实体/标签/身份/认知状态数据模型与版本历史
  - 确定性力导向布局（force_v1）+ 聚类输出 + 命名视图
  - 全文（FTS/中文 bigram）与本地语义（local-hash-v1）检索
  - 备份/恢复/导出/导入/迁移/完整性检查
  - LLM Gateway（Provider 抽象：DeepSeek / OpenAI-compatible / 自定义；最小上下文；离线队列；Key 本地加密）
- **FCA DSH 正式插件**（Cordis bundle，真实安装到 desktop profile）
  - DSH 会话事件采集（策略化、脱敏、幂等、有界队列与重试）
  - Agent 工具：`fca_memory_search` / `fca_memory_store` / `fca_memory_get` / `fca_status`
  - 可选 systemPrompt 记忆上下文注入、`/fca` 状态命令、Runtime 自动拉起
  - 与桌面软件共享同一 Runtime 与同一套数据（不复制记忆库）
- **工程与交付**
  - **Windows x64 安装包**：`artifacts/installer/FCA-Memory-Atlas-Setup-0.1.0-x64.exe`
    - NSIS 3.04，per-user 安装（无需管理员）、自定义安装目录（`/D=`）、静默安装 `/S`
    - 桌面/开始菜单快捷方式、开始菜单卸载项、“应用和功能”卸载登记
    - 开始页/许可页/安装目录/完成页（可启动程序、打开用户手册）
    - 安装日志 `%TEMP%\fca-install.log`（失败错误码 E1–E5）、卸载日志 `%TEMP%\fca-uninstall.log`、安装目录 `install-report.ini`
    - 应用内“首次启动向导”入口（F1/帮助菜单/设置）
    - 数据目录默认 `%LOCALAPPDATA%\FCA-Memory-Atlas`（向导/设置可改）；端口默认 17860（可改）
    - 卸载/升级**不会自动停止 Runtime**（避免误停自定义数据目录或其它实例的 Runtime）；检测到 `runtime.pid` 时提示用户先关闭程序/停止 Runtime；**用户数据目录默认保留**（显式确认才删除）；自定义数据目录需手动清理（文档说明）
    - 随包 Node 24（v24.11.0）+ Runtime 源码，无需用户预装 Node
    - payload 裁剪：仅保留 zh-CN/zh-TW/en-US/en-GB 语言包、删除未使用的 `default_app.asar`；保留 `LICENSES.chromium.html`（许可证合规）
    - 安装包 SHA256 元数据 + 构建证据（makensis `/V4` 日志、构建 JSON）
  - **安装/启动/卸载真机实测**（隔离目录 + WMI 正常令牌会话）：静默安装 → 文件/快捷方式/注册表/日志校验 → 启动安装版连接 Runtime（健康检查/初始化/数据落盘）→ 静默卸载 → 校验程序移除、数据目录保留。见 `docs/INSTALL_TEST.md`、`artifacts/reports/install-test-*.json`
    - 提供 `installer/run-install-test.ps1`（WMI 启动器）+ `installer/install-test.ps1`（实测脚本）可复现；规避 DSH 工具 shell 的 Low IL 沙箱假失败（见 `docs/ENVIRONMENT_REPORT.md` §7.4）
  - **交付文档**：`docs/USER_MANUAL.md`（安装/首启向导/星图/编辑/关系/时间线/搜索/数据管理/备份恢复/LLM/CLI/卸载/排错/快捷键）、`docs/KNOWN_ISSUES.md`、`docs/INSTALL_TEST.md`、`docs/ENVIRONMENT_REPORT.md`（Node 路径/NSIS 构建限制/Electron 沙箱差异修正）、`README.md`、本 CHANGELOG
  - 单元/集成/e2e/性能/安全测试；真机截图与性能报告；用户手册与测试报告

### 修复

- **NSIS 构建（环境级）**：makensis 3.04（x86）在 C: 盘系统 `%TEMP%` 下创建 >32MB mmap 临时文件失败（`Internal compiler error #12345: error creating mmap`，最小 16MB 文件即可复现）。`installer/build.js` 将 makensis 的 `TEMP/TMP` 指向项目内 D: 盘 staging 目录，编译成功；同时修正 `SetCompressorDictSize` 必须先于 `SetCompressor` 的告警。
- **卸载器误停 Runtime（INST-2）**：早期构建的卸载/升级流程固定执行 `fca-runtime stop --fca-home=%LOCALAPPDATA%\FCA-Memory-Atlas`，会误停用户真实 Runtime/其它实例（实测误停 17860 上被 DSH 插件使用的实例，数据无损但链路中断）。最终构建**移除自动 stop**：仅在检测到 `runtime.pid` 时提示用户自行关闭程序/停止 Runtime；`docs/KNOWN_ISSUES.md` KI-RT-06 记录为明确设计行为。
- **LLM Gateway**：`POST /api/v1/llm/queue/{id}/retry` 因 `queue.getRow` 缺失返回 500（QA 发现，已修复并真实 HTTP 复测）。
- **导入参数校验**：`import {"path":123}` 由 500 改为 `400 BAD_REQUEST`。
- **导入损坏 ZIP**：由 500 `INTERNAL` 改为 `422 IMPORT_FAILED`（QA BUG-3，已真实 HTTP 复测）。
- **客户端标识校验**：非法 `X-FCA-Client` 由静默忽略改为 `400 BAD_REQUEST`（DEV-1）。
- **DSH 插件 v0.1.2 → v0.1.4（完全自动添加记忆）**：新增 `autoMemory`（`off` / `user-messages` / `all`），交付默认 `user-messages` —— 你在**任意 DSH 会话**中输入的**真实用户消息**会自动写成真实 FCA 记忆并实时出现在桌面星图（`origin=agent`、带会话来源、版本可追溯）；仅采 `source.kind === "user"` 的消息，Host 注入的 runtime-context / skill-catalog / time-context / 后台任务 / Agent 转发等 user-role 消息全部过滤；复用密钥脱敏、按会话+seq 与正文哈希去重、每小时硬限流、离线排队重试；自动拉起 Runtime 成功后立即 flush 队列（修复 v0.1.2 延迟）。交付包更新为 `artifacts/plugin/dsh-plugin-fca-memory-0.1.4.tgz`（38,161 B，17 文件，sha256 `4005ECF3…`），并已真实安装到 desktop profile。
- **CLI 归属安全**：CLI `stop` 增加 `/health.data_dir` 归属校验，拒绝误停其它数据目录的 Runtime；新增双 Runtime 回归用例。
- **构建脚本 Node 定位**：移除已失效的旧 `<DSH_HOME>\dsh-runtimes\...` 回退，改为 `FCA_NODE` → `vendor\node\node.exe` → DSH NEXT 新路径 → 系统 Node。
- **安装内容完整性**：`installer/build.js` 现在强制校验 desktop（main+renderer 全部视图/样式/nebula）、runtime（bin+src）、随包 node、docs、LICENSE 等关键文件；缺失即构建失败（交付构建不允许 `--allow-incomplete`）。

### 接口变更记录

- v1.0（冻结）：数据模型 / API / 事件 / 错误码 / 渲染契约。
- v1.1（增量，Lead 批准）：新增 `GET /api/v1/memories`、`GET /api/v1/tags`；`/timeline` 与 `/graph` 增加 `participants/projects/tags/memory_types/from/to` 服务端筛选；`/state` 增加 `catalogs`。

### 已知限制

见 `docs/KNOWN_ISSUES.md`（随版本更新）。Alpha 0.1 摘要：不迁移旧数据、仅 FCA 导出格式可导入、无代码签名（SmartScreen 可能提示）、仅 Windows x64/简体中文/深色主题、语义检索为本地确定性向量、历史版本搜索不可用、ZIP 导入无解压上限（KI-SEC-01）等。

### 未修复问题（交付时记录）

- 自定义数据目录时菜单“打开数据目录/日志目录”仍打开默认目录（KI-FUNC-01，规避：用设置页按钮）。
- 10000 节点下 Runtime 布局/图数据为同步计算（秒级），Alpha 0.1 可交互规模为 ≤1000 节点（KI-PERF-01）。
- 安全风险项：ZIP 导入无解压上限（KI-SEC-01）、导出/导入路径未限制（KI-SEC-02）、无限流（KI-SEC-03）、CORS `*`（KI-SEC-04）。均为本机回环场景记录项，详见 `docs/KNOWN_ISSUES.md`。
