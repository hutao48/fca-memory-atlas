# FCA Memory Atlas — v0.2.0

FCA（Fish Cognitive Architecture）的本地认知基础设施实现，交付三个可运行产品：

| 产品 | 说明 | 目录 / 交付物 |
|---|---|---|
| **FCA Memory Atlas** | 可安装的 Windows x64 桌面软件（Electron 38 + **Unity 星云渲染**，内置 WebGL 回退） | `desktop/`；安装包 `artifacts/installer/FCA-Memory-Atlas-Setup-0.2.0-x64.exe` |
| **FCA Local Runtime** | 本地认知服务（127.0.0.1:17860，SQLite，零第三方运行时依赖） | `runtime/`；随安装包分发（含随包 Node 24） |
| **FCA DSH Plugin** | 正式 DSH Cordis 插件 v0.2.1（安装到 DSH profile，连接同一 Runtime） | `dsh_plugin/`；产物 `artifacts/plugin/dsh-plugin-fca-memory-0.2.1.tgz` |
| **FCA Nebula（Unity WebGL）** | Unity 2022.3 WebGL 星云渲染器（工作区旋臂 + Agent 思考节点可视化），**内嵌 Electron 界面**（本地静态服务 + iframe） | `unity/FCANebula/`（源码含 standalone/WebGL 构建脚本）；随安装包分发到 `<安装目录>\unity\FCANebulaWebGL\`，构建产物 `artifacts/unity/FCANebulaWebGL/` |

三者共享同一个 FCA Local Runtime 和同一套数据；任一 UI 关闭不影响数据完整性。LLM 通过 API Gateway 调用，模型可替换；本地记忆的读写不依赖任何 LLM。

v0.2.0 重点：**星云渲染迁移到 Unity WebGL 并内嵌 Electron 界面（默认引擎，失败自动回退内置 WebGL 星云）**；同一工作区的记忆自动归到星云的**一条旋臂**（`workspace:<label>` 标签驱动，旧记忆无需迁移）；DSH 插件把每个 Agent 回合聚合为一条 **Agent 思考节点**记忆（推理/工具/结论，脱敏后入库）；插件 v0.2.1 过滤子会话 user-role 消息并清理历史噪声。详见 `CHANGELOG.md` 与 `docs/UNITY_NEBULA.md`。

## 快速开始（安装版，推荐）

1. 双击 `artifacts/installer/FCA-Memory-Atlas-Setup-0.2.0-x64.exe`（per-user 安装，无需管理员）。
2. 按向导安装（默认目录 `%LOCALAPPDATA%\Programs\FCA Memory Atlas`），完成后可从桌面/开始菜单启动。
3. 首次启动进入**首次启动向导**：选择数据目录（默认 `%LOCALAPPDATA%\FCA-Memory-Atlas`）→ 端口（默认 17860）→ 初始化空库 → 健康检查 → 完成。
4. 星云视图默认在 Electron 窗口内嵌渲染 **Unity WebGL**（本地静态服务 + iframe）；可在“设置 → 星云引擎”切换 `Unity / WebGL`，Unity 资源缺失或启动失败时自动回退内置 WebGL 星云。
5. 详细用户手册：`docs/USER_MANUAL.md`（安装版内也有 `<安装目录>\docs\USER_MANUAL.md` 和开始菜单“使用说明”）。

静默安装 / 自定义目录：

```powershell
# 默认目录静默安装
.\FCA-Memory-Atlas-Setup-0.2.0-x64.exe /S
# 自定义目录（/D= 必须是最后一个参数，路径不要加引号）
.\FCA-Memory-Atlas-Setup-0.2.0-x64.exe /S /D=D:\Apps\FCA-Memory-Atlas
# 安装日志：%TEMP%\fca-install.log；静默卸载：<安装目录>\Uninstall.exe /S（默认保留用户数据）
```

安装包校验：同目录 `FCA-Memory-Atlas-Setup-0.2.0-x64.sha256.json`（`Get-FileHash -Algorithm SHA256` 比对）。

当前交付包（2026-11-12 v0.2.0 终版构建；安装/卸载实测记录见 `docs/INSTALL_TEST.md`）：

| 项目 | 值 |
|---|---|
| 文件 | `artifacts/installer/FCA-Memory-Atlas-Setup-0.2.0-x64.exe` |
| 大小 | 111.2 MB（116,599,178 B） |
| SHA256 | `b84a656d810431a3923191caf3dcab2604d2508008c6d606a1d2aac01098c10c` |
| 版本 / API | 0.2.0 / v1 |
| 构建时间 | 2026-11-12T11:12:16.813Z |
| payload | 231 文件 / 388,322,796 B（desktop 72、runtime 69、docs 21、unity WebGL 19 / 24.9 MiB、dsh_plugin 2 / 50 KiB）（desktop / runtime / docs / **unity** / vendor node） |
| 构建证据 | ``artifacts/reports/install-build-2026-11-12T11-50-47-010Z.json` + 同名 `.makensis.log`` + 同名 `.makensis.log` |

> Unity 星云组件为可选 payload：构建时 `artifacts/unity/FCANebulaWebGL/index.html` 存在则打包到 `<安装目录>\unity\FCANebulaWebGL\`，并在 `BUILD_INFO.json` / `install-report.ini` 记录；缺失时桌面自动回退内置 WebGL 星云。standalone 版（`artifacts/unity/FCANebula`）默认不随安装包分发（开发/备用）。

## 快速开始（开发）

本机 PATH 无 node，使用项目封装脚本（优先 `vendor\node\node.exe`，v24.11.0）：

```powershell
# 环境（可选）：. .\tools\env.ps1
.\tools\node.cmd --version
.\tools\node.cmd runtime\bin\fca-runtime.js init
.\tools\node.cmd runtime\bin\fca-runtime.js serve
# 另开终端启动桌面（自动拉起/连接 Runtime；默认拉起 Unity 星云）
.\tools\node.cmd scripts\start-desktop.js
# 仅验证 Unity 集成（路径解析 + 真实 Runtime 截图）：
.\tools\node.cmd scripts\unity-integration-check.js --resolve-only
.\tools\node.cmd scripts\unity-integration-check.js
```

> 本机 DSH 会话 shell 启动 Electron 需要先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`（并清理 `CHROME_CRASHPAD_PIPE_NAME`）；de-elevated 测试 shell 另需 `--no-sandbox`（用户从 Explorer/快捷方式启动不需要）。详见 `docs/ENVIRONMENT_REPORT.md` §7.2 与 `docs/UNITY_NEBULA.md` §6.7。

## 构建与验证命令

```powershell
# 运行单元/集成/e2e 测试（QA 套件）
.\tools\node.cmd scripts\run-tests.js
# 契约/交付自检
.\tools\node.cmd scripts\verify.js
# 构建 Windows x64 安装包（输出 artifacts\installer\FCA-Memory-Atlas-Setup-<version>-x64.exe；含 Unity 组件）
.\tools\node.cmd installer\build.js
# 安装包真机安装 → 启动 → 连接 Runtime → 卸载 自动化实测（WMI 正常令牌会话；写 artifacts\reports\install-test-*.json）
powershell -NoProfile -ExecutionPolicy Bypass -File installer\run-install-test.ps1
# 截图/录屏采集（开发）
.\tools\node.cmd scripts\capture.js
```

构建注意（本机环境级限制）：

- NSIS 3.04（x86）在 C: 盘系统 `%TEMP%` 下创建 >32MB 内存映射临时文件会失败；`installer/build.js` 已自动把 makensis 的 `TEMP/TMP` 指向 `installer\.staging\makensis-temp`（D: 盘）规避，详见 `docs/ENVIRONMENT_REPORT.md` §4.1。
- **DSH 工具 shell 的子进程运行在 Low IL 沙箱**：直接在该 shell 里 `Start-Process` 安装包会导致 `%TEMP%` 重定向、注册表/快捷方式写入被静默拒绝（假失败）。安装/卸载测试必须用 `installer\run-install-test.ps1`（WMI 正常令牌）或真实用户双击；详见 `docs/ENVIRONMENT_REPORT.md` §7.4。

## 交付物清单（v0.2.0）

| 交付物 | 路径 |
|---|---|
| Windows x64 安装包（NSIS，per-user，含卸载器；含 Unity 星云） | `artifacts/installer/FCA-Memory-Atlas-Setup-0.2.0-x64.exe` |
| 安装包 SHA256/体积元数据 | `artifacts/installer/FCA-Memory-Atlas-Setup-0.2.0-x64.sha256.json` |
| 构建证据（makensis 日志 + 构建 JSON） | `artifacts/reports/install-build-*` |
| 安装/启动/卸载实测报告 | `docs/INSTALL_TEST.md` + `artifacts/reports/install-test-*.json` |
| 用户手册 | `docs/USER_MANUAL.md` |
| 已知问题 | `docs/KNOWN_ISSUES.md` |
| Unity 星云说明 | `docs/UNITY_NEBULA.md` + `artifacts/unity/shots-final/`（真实 Runtime 截图 ×3 + manifest）+ 桌面内嵌联调截图 `artifacts/unity/integration-*.png` |
| DSH 插件包（v0.2.1） | `artifacts/plugin/dsh-plugin-fca-memory-0.2.1.tgz` |
| 插件验证证据 | `docs/PLUGIN_INTEGRATION_TEST.md`、`artifacts/plugin/v0.2-*.json` |
| 测试与性能报告（QA） | `docs/TEST_REPORT.md` + `artifacts/reports/` |
| 截图证据 | `artifacts/screenshots/`（桌面 `final-*.png`）+ `artifacts/unity/shots/`（Unity 星云） |
| 录屏 | `artifacts/recordings/` |

## 文档

- `docs/USER_MANUAL.md` — 用户手册（安装/首启向导/星图/Unity 星云/编辑/关系/时间线/搜索/数据管理/备份恢复/LLM/卸载/排错）
- `docs/UNITY_NEBULA.md` — Unity 星云渲染：数据契约、工作区旋臂、构建（standalone/WebGL）、Electron 内嵌集成与回退、已知限制
- `docs/KNOWN_ISSUES.md` — 已知问题与限制（含 QA 安全测试结论与 v0.2.0 新增项）
- `docs/INSTALL_TEST.md` — 安装包真机安装/启动/卸载实测记录与证据
- `docs/FINAL_ACCEPTANCE.md` — v0.2.0 最终验收报告
- `docs/ENVIRONMENT_REPORT.md` — 环境调查与交付阶段修正（Node 路径/NSIS 构建限制/Electron 沙箱差异）
- `docs/PUBLIC_INTERFACE_FREEZE.md` — 冻结的数据模型 / API / 事件 / 渲染契约（并行开发唯一契约）
- `docs/API.md` — Runtime HTTP API 文档
- `docs/ARCHITECTURE.md` — 架构与 ADR 技术决策（含 ADR-006 安装方案、ADR-007 LLM Gateway、ADR-008 DSH 插件）
- `docs/TEST_REPORT.md` — 测试与性能报告（QA 产出）
- `docs/DSH_PLUGIN_ENVIRONMENT_REPORT.md` — DSH 插件环境报告（真实 SDK 证据）
- `docs/PLUGIN_INTEGRATION_TEST.md` — DSH 插件真实安装与端到端验证（T1–T17，含 v0.2 自动记忆/思考节点）
- `deploy/DEEPSEEK_AGENT_PROMPT.md` — 可交给 Agent 自主执行的安装部署提示词
- `CHANGELOG.md` — 变更日志

## 目录结构

```
FCA-Memory-Atlas/
  artifacts/          交付物（installer/ 安装包、plugin/ 插件包、unity/ Unity 构建与截图、screenshots/ 桌面截图、reports/ 测试与构建证据）
  config/             运行配置模板
  data_template/      空白数据模板
  desktop/            桌面应用（Electron main + renderer；入口 main/main.js；unity-viewer.js 负责 Unity 生命周期与回退）
  docs/               全部文档 + docs/adr/
  dsh_plugin/         DSH 正式插件（Cordis bundle；workspace 归属 + Agent 思考节点自动记忆）
  installer/          安装包构建脚本（build.js / installer.nsi / install-test.ps1 / run-install-test.ps1 / LICENSE.txt）
  runtime/            FCA Local Runtime（bin/ + src/；Node 标准库实现）
  scripts/            开发脚本（fetch-*、start-desktop、capture、record、verify、bench、run-tests、unity-integration-check）
  tests/              QA 测试套件（unit / integration / e2e / performance / install）
  tools/              node.cmd / pnpm.cmd / env.ps1（本机 PATH 无 node）
  unity/FCANebula/    Unity 2022.3 工程源码（C# 脚本 / shader / 场景 / standalone/WebGL 构建脚本）
  vendor/             vendor/node/node.exe（随包 Node 24.11）
```

## 原则

1. **本地优先**：记忆、关系、布局、身份与认知状态保存在本机；默认只监听 127.0.0.1。
2. **模型可替换**：LLM 经 Provider 接口调用；更换模型不丢数据；API Key 本地 AES-256-GCM 加密存储。
3. **全新记忆库**：不迁移、不导入旧记忆库。
4. **真实可用**：无 Mock 冒充、无假数据、无空实现；失败路径显式报错（含 trace id/日志路径）；Unity 失败自动回退 WebGL 而不是白屏。
5. **可追溯**：记忆/关系变更记录来源、时间、版本与操作主体；Agent 思考节点保留回合/工作区来源。
6. **数据安全**：备份/恢复/导出/审计完备；卸载默认保留用户数据并明确提示。

## 版本

- **v0.2.0（2026-11-12）**：Unity 星云渲染（默认，WebGL 回退）、工作区旋臂、Agent 思考节点、DSH 插件 v0.2.1、安装包含 Unity 组件；文档与验收报告更新。详见 `CHANGELOG.md`。
- v0.1.1（2026-11-12）：桌面 UI 热修（编辑器/记忆列表）。
- v0.1.0（2026-11-12）：Alpha 0.1 三件套首次交付（桌面 + Runtime + DSH 插件 + NSIS 安装包）。
