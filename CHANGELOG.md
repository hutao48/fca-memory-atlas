# 变更日志（FCA Memory Atlas）

本项目遵循语义化版本：`MAJOR.MINOR.PATCH`。Alpha 阶段允许小版本内调整内部实现，但 `docs/PUBLIC_INTERFACE_FREEZE.md` 的公共契约只能由 Lead 审核后变更并记录于下。

## [0.1.1] — 2026-11-12（Alpha 0.1.1 热修）

### 修复

- **桌面 · 记忆编辑器**：加载已有记忆时调用未定义的 `renderTitleBar()`，触发错误边界显示"无法加载记忆 / renderTitleBar is not defined"。已移除该遗留调用（`desktop/renderer/views/editor.js`），并通过真实已安装应用 + CDP 验证：编辑器正常显示记忆标题与内容、无 console 错误。
- **桌面 · 记忆列表**：`loadData()` 成功后只调用 `applyFilters()` 而未重新 `render()`，body 永久停留在"正在读取记忆列表…"（数据已加载、底部计数正常但表格不出现）。已改为计算筛选结果后整体重渲染（`desktop/renderer/views/list.js`）；同时修复行内标签以数组形式传给 DOM 导致单元格显示 `[object HTMLSpanElement]` 的问题（展开标签子元素）。
- 验证：真实已安装应用（Electron + 真实 Runtime，5 条记忆）通过 CDP 检查——列表渲染 5 行、无错误、无 spinner；编辑器打开已有记忆正常。安装包重构建并发布 v0.1.1（见 Releases/latest）。
- 说明：本热修不改变数据模型 / API / 渲染契约；v0.1.0 Release 保留作为历史版本，请使用 v0.1.1 或更新版本。

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
- **构建脚本 Node 定位**：移除已失效的旧 `C:\\Users\\<user>\.dsh\dsh-runtimes\...` 回退，改为 `FCA_NODE` → `vendor\node\node.exe` → DSH NEXT 新路径 → 系统 Node。
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
