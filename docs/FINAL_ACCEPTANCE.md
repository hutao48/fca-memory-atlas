# FCA Memory Atlas v0.4.0 — 最终验收报告（含 v0.3.0 全部交付）

- 验收时间：2026-11-12（Asia/Tokyo）
- 项目：`D:\FCA\FCA-Memory-Atlas`
- 版本：**v0.4.0**（桌面/Runtime/安装包 0.4.0；DSH 插件 **0.3.1**；Runtime API v1 未变）
- 结论：**v0.4.0 交付完成** —— 子 Agent 记忆层级展开、Unity↔桌面双向选中、桌面 UI 修复（关系详情/侧栏常驻开关/层级面板）、Unity 星云几何修复与布局冻结、插件 v0.3.1（时间戳/子 Agent 全量记忆/上下文恢复）；在 v0.2.x 基础上累积 Runtime EPIPE/日志轮转修复；v0.2.0 在 v0.1.x 三件套基础上完成「星云渲染迁移 Unity（默认引擎 + WebGL 自动回退）」「同一工作区记忆归入星云同一旋臂」「Agent 思考节点自动记忆」「DSH 插件 0.2.1」「安装包 0.2.0（含 Unity 组件）」。
- 说明：本报告为 v0.3.0 验收汇总（含 v0.2.x 全部交付）；v0.1.0 的历史验收细节见本文档“v0.1.0 归档”章节与 `CHANGELOG.md`。所有关键项均引用真实运行/构建证据（路径见各节），失败与限制如实列出。

---

## 1. 交付物清单（v0.4.0）

| 交付物 | 路径 | 状态 |
|---|---|---|
| 桌面软件安装包（Windows x64，per-user，NSIS + 卸载器，含 Unity 星云） | `artifacts/installer/FCA-Memory-Atlas-Setup-0.4.0-x64.exe`（v0.4.0 **构建 #3 含许可证变更**：123,618,233 B（117.9 MiB），sha256 `a391ce0715253c96c14ee51d5bc0ef66b9fe8a9d506d3a15fd4c5ee60e64bd7c`；Unity 6 + URP WebGL payload 63.0 MiB） | ✅ 构建/安装/卸载实测通过 |
| 安装包校验与构建证据 | `artifacts/installer/FCA-Memory-Atlas-Setup-0.4.0-x64.sha256.json`、`artifacts/reports/install-build-*.json`、同名 `.makensis.log` | ✅ |
| 桌面软件源码 | `desktop/`（Electron 38 主进程 + ESM renderer + Unity 集成 `main/unity-embed.js`/`unity-viewer.js` + WebGL 回退；**v0.2.1 起 Runtime 启动失败快速失败；v0.3.0 含关系详情/侧栏开关/层级 UI/Unity 双向选中**） | ✅ |
| FCA Local Runtime | `runtime/`（Node 24 + `node:sqlite`，零第三方运行时依赖；API v1 未变） | ✅ |
| **Unity 星云（WebGL，内嵌 Electron）** | `artifacts/unity/FCANebulaWebGL/`（Unity 2022.3 WebGL 构建：`index.html` + `Build/*.wasm/*.data/*.loader.js/*.framework.js` + `TemplateData/`） | ✅ 随安装包分发到 `<InstallDir>\unity\FCANebulaWebGL\`；桌面星云视图内嵌渲染 |
| Unity 星云源码/工程 | `unity/FCANebula/`（Unity 2022.3.62f3，Built-in RP；含 standalone 与 WebGL 构建脚本） | ✅ |
| Unity 星云真实数据截图 | `artifacts/unity/shots-final/`（3 张 + `screenshots-manifest.json`）；桌面内嵌联调截图 `artifacts/unity/integration-*.png` | ✅ 真实 Runtime（非样例） |
| 桌面集成证据 | `artifacts/unity/integration-report.json`、`integration-unity-card-idle.png`、`integration-fallback-missing-exe.png`、`integration-webgl-baseline.png`、`integration-electron-unity-running.png` | ✅ |
| DSH 正式插件包 | `artifacts/plugin/dsh-plugin-fca-memory-0.3.1.tgz`（51,184 B，sha256 `ED799DC1D2F186DF862D34D42A88FAEC1CFD905C12D2BDE9EC91054537937403`） | ✅ 真实安装到 desktop profile 并验证 |
| 插件验证/清理证据 | `artifacts/plugin/v0.3.0-evidence.json`、`v0.3.1-install-log.json`、`v0.3.1-tag-repair.json`、`v0.3.1-noise-cleanup.json`；v0.2.x 证据保留 | ✅ |
| 安装实测报告 | `docs/INSTALL_TEST.md` + `artifacts/reports/install-test-*.json` | ✅ |
| 用户手册 / 已知问题 / 架构 / API / 环境 / 接口冻结 / Unity 说明 | `docs/USER_MANUAL.md`、`docs/KNOWN_ISSUES.md`、`docs/ARCHITECTURE.md`、`docs/API.md`、`docs/ENVIRONMENT_REPORT.md`、`docs/PUBLIC_INTERFACE_FREEZE.md`、`docs/UNITY_NEBULA.md`、`docs/adr/` | ✅ |
| 测试与性能报告 | `docs/TEST_REPORT.md`、`artifacts/reports/test-run.json`、`performance.json`、`render-performance.json`、`security.json` | ✅（Runtime 0.1.0 测试基线；v0.2 增量见 §3） |
| 桌面截图 / 录屏 | `artifacts/screenshots/final-*.png`、`artifacts/recordings/` | ✅ |
| Agent 自主部署提示词 | `deploy/DEEPSEEK_AGENT_PROMPT.md`（v0.2.0 安装包/Unity 组件） | ✅ |

---

## 2. 需求完成情况（v0.2.0 用户核心要求）

| # | 要求 | 交付方式 | 证据 |
|---|---|---|---|
| 1 | **星云图形渲染改用 Unity（内嵌界面）** | Unity 2022.3 **WebGL** 构建 + Electron 本地静态服务 + iframe 内嵌；桌面默认 `nebulaEngine=unity`，失败自动回退内置 WebGL 星云 | `docs/UNITY_NEBULA.md` §6；`artifacts/unity/integration-report.json`；`integration-*.png` |
| 2 | **同一工作区记忆自动归到星云一条旋臂** | 插件给自动记忆打 `workspace:<label>` 标签；Unity 按标签分组到对数螺旋旋臂（无标签进 `default` 臂，旧记忆无需迁移） | `docs/UNITY_NEBULA.md` §3；`artifacts/unity/screenshots-manifest.json`（`arm_summary`）；真实库记忆 tags |
| 3 | **不只用户输入，还含 Agent 思考重要节点** | 插件 v0.2 `autoMemoryAgentNodes=summary`：按 `session:turn` 聚合 reasoning + tool/call + tool/result + 结论为 **1 条 Agent 思考节点记忆**（脱敏、去重、限流） | `artifacts/plugin/v0.2-verification.json`（真实 Runtime 中 `Agent 思考节点 · 第 1/2 回合`）；`docs/PLUGIN_INTEGRATION_TEST.md` §10 |
| 4 | **可安装/可启动/可卸载的软件交付 + 文档** | 安装包 0.2.0（含 Unity 组件、per-user、卸载器、数据保留策略）；README/CHANGELOG/用户手册/安装实测/已知问题/验收报告 | `docs/INSTALL_TEST.md`；`artifacts/installer/*.sha256.json`；本报告 §3 |

---

## 3. 关键验收证据（真实数据）

### 3.1 安装包构建与安装/卸载

- 构建：`tools\node.cmd installer\build.js`，NSIS 3.04，`makensis` exit 0；payload 含 desktop/runtime/docs/vendor node/**Unity WebGL**/**dsh_plugin tgz**；构建元数据 `artifacts/reports/install-build-*.json`，完整日志 `*.makensis.log`。
- 安装/卸载实测：`installer/verify-installed.ps1` → **全部 PASS**（SHA 校验、静默安装 exit 0、35 关键文件、Unity WebGL payload 25.0MB、dsh_plugin 0.3.1 tgz（68,625 B）、v0.3.0 UI 修复断言、BUILD_INFO 0.2.0、install-report、安装日志、**安装版 Runtime 冒烟** init/serve/health/graph/store/shutdown、卸载 exit 0、目录清理、数据保留、17860 未受干扰）。原始报告 `artifacts/reports/install-verify-20261112-204510.json`；详见 `docs/INSTALL_TEST.md`。
- 安装器行为（v0.2.0）：per-user 安装（默认 `%LOCALAPPDATA%\Programs\FCA Memory Atlas`）；支持 `/S` 静默与 `/D=` 自定义目录；安装日志 `%TEMP%\fca-install.log`；HKCU 卸载项 + 桌面/开始菜单快捷方式；**卸载不自动停止 Runtime、默认保留用户数据**（INST-2 修复延续）；v0.2.0 卸载新增清理 `unity/`、`dsh_plugin/`。

### 3.2 Unity 星云（真实 Runtime 数据）

- 截图：`artifacts/unity/shots-final/screenshot-{1-overview,2-workspace-arm,3-top-down}.png` + `screenshots-manifest.json`（`sample_data=false`、`connected=true`、node/edge/arm 统计、每臂节点数与颜色）。
- 集成：`scripts\unity-integration-check.js` 验证 WebGL 资源路径解析（开发/打包/缺失）、内嵌 iframe 加载/真实 Runtime 数据、截图非重复、manifest 一致；`artifacts/unity/integration-report.json` PASS。
- 回退：Unity WebGL 资源缺失/加载失败/用户切换时，桌面自动回退内置 WebGL 星云（`integration-fallback-*.png`、`integration-webgl-baseline.png`）。

### 3.3 DSH 插件 v0.3.1

- 真实安装：`plugin_manager` 安装 `dsh-plugin-fca-memory-0.3.1.tgz` 到 desktop profile（安装日志 `artifacts/plugin/v0.2-install-log.json`）。
- 自动记忆 + 工作区归属 + 时间戳/子 Agent 全量：真实会话产生带 `workspace:FCA` / `Agent思考节点` / `Agent子会话` 标签、`occurred_at` 精确时间的记忆；`fca_status` 返回 `plugin.version=0.3.1`、`auto_memory.agentNodes.mode=summary`（`v0.2-verification.json`）。
- 子会话过滤/历史噪声清理：`v0.2.1-cleanup-evidence.json` 记录 3 条 teammate 启动提示词被软删除（图节点 12→9，`include_deleted` 可查），后续子会话 user-role 消息不再采集。
- 兼容性：`engines.fcaRuntime = ">=0.1.0 <0.2.0"` 与 Runtime 0.1.0 兼容。

### 3.4 回归测试

- Runtime/API 未变更：沿用 v0.1.0 测试基线（`docs/TEST_REPORT.md`、`artifacts/reports/test-run.json`），Runtime 65/65 + verify 23/23（Lead 复核）。
- 插件单测：`tests/unit/plugin/plugin-pure.test.js`（21 项，workspace/session-scope/Agent 节点聚合/脱敏/去重/限流）全部通过。
- 桌面/集成：`artifacts/reports/desktop-*.md`、`e2e-scenarios.json`（v0.1.1 基线）；Unity 集成 `artifacts/unity/integration-report.json`。

---

### 3.5 v0.2.1 Runtime 稳定性修复（EPIPE 死循环 / 启动超时）验证

- **P0 问题**：强杀 FCA 桌面 app 后，其子 Runtime 继承的 stdout/stderr 管道关闭 → logger 写 stderr 触发未监听的异步 `EPIPE` → `uncaughtException` → handler 再次写日志 → 无限 EPIPE 循环占满事件循环 → `/health` 超时；随后 app 自动重启 Runtime 又遇 `PORT_IN_USE`，最终 30s 启动超时、界面 Runtime 未连接。
- **修复**：`runtime/src/runtime.js` 进程级监听 stdout/stderr `'error'` 并忽略 EPIPE（READY 写入保护、`isBrokenPipeError`）；`runtime/src/logging/index.js` 控制台首次断开后永久降级为仅 JSONL 文件日志（`consoleBroken`）；`desktop/main/runtime-manager.js` 子进程已退出且 state=error 时立即失败，不再空等 30s。
- **验证证据**：
  - 回归单测 `runtime/test/logger-epipe.test.js` **3/3 PASS**；
  - 真实复现脚本 `.cache/audit/verify-epipe-fix.mjs`：关闭子进程管道后连续 6 次 `/health` 均 200（2–3ms）、0 条 EPIPE/uncaughtException；
  - `scripts/verify.js` **23/23 PASS**；
  - 本机 `D:\FCA-Memory-Atlas` 手工热修后：Runtime pid 3828 healthy、app 已连接、Unity WebGL 32 nodes/22 edges/4 arms；
  - **安装包随包验证**：`installer/verify-installed.ps1` 新增 `epipe-fix-in-payload` 检查 PASS（安装目录 `runtime/src/runtime.js` 含 `isBrokenPipeError`/EPIPE 处理、`logging/index.js` 含 `consoleBroken`）；安装实测同时验证「正常关闭 app 后 Runtime 仍健康」（17860 before/after=True）。
- 已知问题状态：`docs/KNOWN_ISSUES.md` KI-FIX-01 已标“已修复（保留记录）”。
### 3.6 v0.3.0 新功能与 UI 修复验证

| 项 | 结果 | 证据 |
|---|---|---|
| 子 Agent 记忆层级（Unity） | ✅ 真实数据展开/收起 | `artifacts/unity/webgl-shots/webgl-hierarchy-{before,after}.png` + `webgl-shots-manifest.json` |
| 子 Agent 记忆层级（桌面详情/关系视图） | ✅ 折叠区块/层级标记 | `artifacts/reports/desktop-ui/after-hierarchy-parent-expanded.png`、`after-relations-hierarchy.png` |
| Unity ↔ Electron 双向选中 | ✅ 8/8 真实联调 | `artifacts/reports/desktop-ui/after-real-bidirectional-sync.png`、`after-sync-report.json` |
| 关系详情修复 | ✅ 不再报 `append` 错误/无 `[object Object]`，端点可跳转 | `after-relation-detail.png`（修复前见 `before-relation-detail-error.png`）、`after-fix-report.json` |
| 左右栏常驻开关 | ✅ 顶栏 `btn-toggle-left/right`（Ctrl+B/Ctrl+J），收起后可重新展开 | `after-panels-collapsed-with-toggles.png`（修复前见 `before-panels-collapsed-no-entry.png`） |
| 桌面单测 | ✅ 35/35 PASS | `tests/unit/desktop/`（含 `hierarchy.test.js`、`unity-selection.test.js`） |
| Unity 几何/布局冻结 | ✅ 布局 signature v1、链同臂 true、0 errors；对齐统计 mean 0.482 / p95 0.862（max 1.197 来自冻结 jitter） | `artifacts/unity/shots-final/task14-evidence.json`、`artifacts/unity/FCANebulaWebGL/fca-webgl-build-info.json`（built_at 2026-11-12T16:57:30Z） |
| 插件 0.3.1 能力 | ✅ occurred_at 时间戳 / 子 Agent 全量记忆 / 父子关系 / `fca_memory_context` | `artifacts/plugin/v0.3.0-evidence.json`、`v0.3.1-install-log.json`、`v0.3.1-tag-repair.json`、`v0.3.1-noise-cleanup.json` |
| 安装包随包断言 | ✅ `ui-fixes-in-payload` / `unity-webgl-build-v030` / `dsh-plugin-version-match` 全 PASS | `artifacts/reports/install-verify-20261113-020300.json` |
### 3.7 v0.4.0 新功能验证（Unity 6 + URP / 记忆链 / 整链高亮）

| 项 | 结果 | 证据 |
|---|---|---|
| Unity 6 + URP WebGL 构建 | ✅ `unity_version=6000.0.23f1`、`render_pipeline=urp`、`urp_asset=FCANebulaURP`、`total_errors=0` | `artifacts/unity/FCANebulaWebGL/fca-webgl-build-info.json`、`artifacts/reports/install-verify-20261113-033307.json`（`unity-6-urp` PASS） |
| 关联记忆节点可见连线 / 同链同旋臂 | ✅ `features` 含 `chain-links`/`chain-same-arm`；manifest `chainSameArmAll=true`、`chain_pairs_missing=0` | `artifacts/unity/webgl-shots/webgl-chain-closeup.png`、`webgl-shots-manifest.json`、`artifacts/unity/shots-final/v040-evidence.json` |
| 单击节点高亮整条记忆链 | ✅ 整链高亮 + HUD；`chain-highlight` 标记 | `artifacts/unity/webgl-shots/webgl-chain-highlight.png` |
| 子 Agent 层级展开（保留） | ✅ hierarchy before/after | `webgl-hierarchy-{before,after}.png` |
| 桌面 v0.4.0 联调 | ✅ 11/11 PASS（Unity→桌面双向选中/清空同步） | `artifacts/reports/desktop-ui/v040-sync-report.json`、`v040-unity-to-electron.png`、`v040-bidirectional.png`、`v040-clear-sync.png` |
| 插件 0.3.1 能力（保留） | ✅ occurred_at / 子 Agent 全量 / 父子关系 / `fca_memory_context` | `artifacts/plugin/v0.3.0-evidence.json` 等 |
| 体积变化记录 | ✅ Unity 组件 25→63 MiB（URP），安装包 111→118 MiB；安装/卸载/CI 时间相应增加 | `docs/INSTALL_TEST.md` §1/§4、`artifacts/installer/*.sha256.json` |
### 3.8 v0.4.0 许可证变更（源码可见 · 非商用 · 禁止二次修改分发）

- **产品许可**：v0.4.0 起仓库与安装包采用《FCA Memory Atlas 源码可见许可协议（非商用 · 禁止二次修改分发）》（`LICENSE`，4,113 B）。允许个人非商业查看/学习/本机运行官方版/本机个人修改；**禁止任何商业用途、禁止分发、禁止二次修改后分发/公开（含公开 fork、镜像、安装包、容器等）**。v0.4.0 之前版本仍适用其发布时的 MIT。
- **安装包 payload**：根 `LICENSE` = 产品许可；`LICENSE-THIRD-PARTY.txt` = Electron(MIT)/Node.js(MIT)/Unity+URP/Noto 字体等第三方许可汇总；`LICENSES.chromium.html` = Chromium 第三方 notices；`BUILD_INFO.json.license` 记录文件与类型；`install-report.ini` 记录 `license`/`license_type`/`third_party_license`。
- **验证**：构建期断言 `product_license_noncommercial` / `product_license_not_mit` / `third_party_license_present` / `chromium_notices_present`；安装期 `license-in-payload`（安装目录 `LICENSE` 含“非商用/禁止二次修改分发”且非 MIT、第三方许可含 Electron MIT、Chromium notices 存在）。
- **GitHub**：public repo `LICENSE`/README/仓库描述已更新为非商用/源码可见（`license=NOASSERTION/Other`，非 MIT）；Release v0.4.0 说明显著标注许可证限制并链接 `/blob/main/LICENSE`。
## 4. 版本一致性

| 组件 | 版本 |
|---|---|
| root `package.json` / `desktop/package.json` | 0.2.0 |
| Windows 安装包 | 0.2.0（`FCA-Memory-Atlas-Setup-0.4.0-x64.exe`） |
| FCA Local Runtime / HTTP API | 0.1.0 / v1（未变） |
| DSH 插件 | **0.3.1** |
| 许可证 | 源码可见·非商用·禁止二次修改分发（v0.4.0 起；历史版本 MIT） |
| Unity 星云 | 2022.3.62f3 WebGL 构建（随安装包分发到 `unity/FCANebulaWebGL`） |
| 桌面 UI 版本显示 | 标题栏 `Alpha 0.2` / 状态栏 `Alpha 0.2.0`（`paths.js` 从 `desktop/package.json` 派生，Lead 修复 `8864424`，已含在最终包） |

---

## 5. 已知限制与风险（不阻塞 v0.2.0 交付）

完整清单见 `docs/KNOWN_ISSUES.md`；v0.2.0 相关摘要：

1. **内嵌 Unity WebGL 依赖 WebGL2/GPU 能力**：浏览器/Electron 环境需 WebGL2（无 GPU 时回退内置 WebGL 星云）；首次加载 wasm/data 体积较大（数秒）。
2. **体积着色器最多同时渲染 8 条旋臂**：超过 8 个 workspace 时节点仍按正确旋臂分布，星云体积只绘制前 8 条（HUD 提示）。
3. **Unity WebGL 数据刷新为轮询**：数据通过注入的 Runtime URL/token 拉取（默认 3s 轮询；后续可加 SSE）。
4. **HUD 为 IMGUI + 系统字体**：无中文字体环境显示方块（功能不受影响）。
5. **安装包未做代码签名**：SmartScreen 可能提示未知发布者；Unity WebGL 资源同样未签名。请校验 SHA256。
6. **测试环境限制**（不影响真实用户）：DSH 工具 shell 子进程为 Low IL，安装器/快捷方式/注册表断言需用正常令牌会话/真实双击；macOS/Linux 不提供。
7. **DSH 插件历史噪声已软删除**：3 条 teammate 提示词記憶保留在回收站（`include_deleted` 可见），可按需硬删除。
8. **桌面 v0.1.x 既有已知问题**：见 `docs/KNOWN_ISSUES.md`（自定义数据目录菜单打开默认目录、语义检索效果有限、无自动更新等）。

---

## 6. 最终交付状态（v0.3.0）

- **可安装**：✅ 安装包 0.3.0 构建成功，隔离目录静默安装/卸载实测通过（详见 `docs/INSTALL_TEST.md`）。
- **可启动**：✅ 桌面主程序 + 安装版 Runtime + Unity 星云渲染（含 WebGL 回退）。
- **可卸载**：✅ 程序/快捷方式/卸载项清理；用户数据默认保留并提示。
- **可追溯**：✅ 构建/安装/插件/Unity 证据均落盘（`artifacts/reports/`、`artifacts/unity/`、`artifacts/plugin/`）。
- **待 Lead 执行**：git 提交/GitHub 推送/Release 资产上传（清单见交付消息；本机 `git push` TLS 不稳定，Lead 使用 GitHub API）。

---

## 7. v0.1.0 归档（历史验收要点）

- v0.1.0 交付：桌面软件（Electron + WebGL2 星云）、Local Runtime、DSH 插件 v0.1.4；NSIS 安装包（99.0 MB，sha256 `4df2e774…f3114c1a`）——安装/启动/卸载实测通过。
- v0.1.1 热修：编辑器加载崩溃、记忆列表不刷新、列表标签渲染。
- v0.1.0 详细验收指标（性能/视觉/修复缺陷）保留在 git 历史 `docs/FINAL_ACCEPTANCE.md` 旧版本与 `CHANGELOG.md`；v0.2.0 在此基础上增量交付，未回退既有能力。
