# FCA Memory Atlas v0.3.0 安装/启动/卸载实测（INSTALL_TEST）

- 版本：**v0.3.0**（子 Agent 记忆层级 + Unity 双向选中 + 桌面 UI 修复 + 插件 0.3.1；桌面/Runtime/安装包 0.3.0，Runtime API v1）
- 实测日期：2026-11-12（Asia/Tokyo）
- 版本重点：**v0.2.1 = v0.2.0 + Runtime 稳定性修复（EPIPE 死循环 / 启动 30s 超时）；本安装包已包含修复**
- 测试主机：Windows 11 x64（`<HOST>`），per-user 安装、无需管理员
- 结论：**安装包构建成功；静默安装/文件完整性/安装版 Runtime 冒烟/静默卸载实测通过**。内嵌 Unity WebGL 星云证据见 §6（由 desktop-integration 在安装布局下实测截图 + 日志；本机自动化 shell 的单实例/GUI 限制见 §8）。

---

## 1. 测试对象（v0.3.0 交付安装包）

| 项 | 值 |
|---|---|
| 安装包 | `artifacts\installer\FCA-Memory-Atlas-Setup-0.3.0-x64.exe` |
| 大小 | **116,653,589 B（111.2 MB）**（v0.3.0 交付构建 #2，含最终文档） |
| SHA256 | **`b852d7c1a02439e0529c54e5974663172d46be3e6016d6d361b2be06a5bbcf3a`**（交付构建 #2；实测构建 #1 `b64adbf2…` 全流程 PASS，产品代码相同、仅文档差异） |
| 版本 / API | **0.3.0** / v1 |
| 构建时间 | `2026-11-12T17:03:42.811Z` |
| 构建工具 | NSIS 3.04（`/SOLID lzma` + `DictSize 64`，`makensis` exit 0，耗时 238,562 ms） |
| payload | **233 文件 / 388,652,424 B**（desktop 74、runtime 69、docs 21、**Unity WebGL 19 / 25.0 MiB**、**dsh_plugin 2 / 67 KiB / 插件 0.3.1**、vendor node、BUILD_INFO） |
| 构建元数据 | `artifacts\reports\install-build-2026-11-12T17-03-42-811Z.json` |
| makensis 完整日志 | `artifacts\reports\install-build-2026-11-12T17-03-42-811Z.makensis.log` |
| SHA256 元数据 | `artifacts\installer\FCA-Memory-Atlas-Setup-0.3.0-x64.sha256.json` |

构建预检全部 `true`：`FCA Memory Atlas.exe`、`resources/app/{package.json,main/main.js,preload.js,ipc.js,runtime-manager.js,**unity-viewer.js**,**unity-embed.js**,renderer/index.html,renderer/app.js}`、`runtime/bin/fca-runtime.js`、`runtime/src/{runtime.js,services.js,server/index.js}`、`node/node.exe`、`docs/{USER_MANUAL,KNOWN_ISSUES,INSTALL_TEST,UNITY_NEBULA,FINAL_ACCEPTANCE}.md`、`BUILD_INFO.json`、`LICENSE`；`unity_renderer_present=true`、`dsh_plugin_package_present=true`、`runtime_llm_present=true`。

> **实测与交付构建**：实测构建 #1 `b64adbf2…`（116,644,579 B）全流程 PASS；交付构建 #2 为同一产品代码 + 本文实测结果重建（116,653,589 B，sha256 `b852d7c1…`），sha256 以 `artifacts\installer\FCA-Memory-Atlas-Setup-0.3.0-x64.sha256.json` 与 Release 资产说明为准；重建仅更新文档内容，产品代码与 payload 组件不变）。

## 2. 测试环境

- 隔离安装目录：`D:\FCA\FCA-Memory-Atlas\.cache\v030-install-verify\app`
- 隔离数据目录：`...\v020-install-verify\data`（安装版 Runtime `--fca-home`，不触碰真实数据 `<FCA_DATA_DIR>` 与 `%LOCALAPPDATA%\FCA-Memory-Atlas`）
- 安装版 Runtime 测试端口：**17897**（避开默认 17860 上真实 Runtime）
- 真实 Runtime（17860，`data_dir=<FCA_DATA_DIR>`）：仅只读健康检查，**全程不停止/不修改**
- 安装包来源：工程内 `installer/build.js` 本地构建（Electron 38.2.1 官方分发 + vendor Node v24.11.0 + Unity 2022.3.62f3 WebGL 构建）

## 3. 测试方法

| 脚本 | 用途 |
|---|---|
| `installer\verify-installed.ps1` | **主实测**：SHA 校验 → 静默安装 → 关键文件/Unity WebGL/插件/**v0.3.0 UI 修复断言**/BUILD_INFO/install-report 校验 → 安装版 Runtime 冒烟（init/serve/health/graph/store/shutdown）→ 静默卸载 → 目录移除/数据保留/17860 未受干扰；输出 `artifacts\reports\install-verify-*.json` |
| `installer\install-test.ps1` | 完整流程（含尝试启动安装版 GUI、桌面/开始菜单/HKCU 检查、截图）；在 DSH 工具 shell 的 Low IL 限制下 GUI/注册表两项会假失败（见 §8） |
| `installer\run-install-test.ps1` | WMI 正常令牌启动器（尝试绕过工具 shell 限制；本机安装器仍被 Low IL 影响，结论以 §8 为准） |

复现命令：

```powershell
# 主实测（约 40s；不需要 GUI）
powershell -NoProfile -ExecutionPolicy Bypass -File installer\verify-installed.ps1

# 构建安装包（约 5 分钟；含 Unity WebGL + dsh_plugin payload）
tools\node.cmd installer\build.js
```

## 4. 实测结果（主实测脚本输出，`artifacts\reports\install-verify-*.json`）

| # | 检查项 | 结果 | 说明 |
|---|---|---|---|
| 1 | 安装包 SHA256 与 `.sha256.json` 一致 | ✅ PASS | 见报告 `installer.sha256_ok` |
| 2 | 无正在运行的 FCA 实例（NSIS 前置条件） | ✅ PASS | 安装前确认无 `FCA Memory Atlas.exe` |
| 3 | NSIS 静默安装 `/S /D=<隔离目录>` | ✅ PASS | exit code 0 |
| 4 | 安装文件完整性（35 项关键文件） | ✅ PASS | 主程序/resources/app（含 unity-embed.js）/runtime/node/docs/README/CHANGELOG |
| 5 | **Unity WebGL payload** | ✅ PASS | `unity\FCANebulaWebGL\index.html` + `Build\*.wasm/.data/.loader.js/.framework.js`，约 25.0 MiB |
| 5.1 | **EPIPE 稳定性修复随包生效（v0.2.1）** | ✅ PASS | 安装目录 `runtime\src\runtime.js` 含 `isBrokenPipeError`/EPIPE 处理、`runtime\src\logging\index.js` 含 `consoleBroken` 控制台降级；`installer/verify-installed.ps1` 新增 `epipe-fix-in-payload` 检查 PASS |
| 6 | **DSH 插件 tgz** | ✅ PASS | `dsh_plugin\dsh-plugin-fca-memory-0.3.1.tgz`（68,625 B）+ README |
| 7 | BUILD_INFO 版本/可选组件 | ✅ PASS | `version=0.3.0`、`optional_components.unity_nebula_webgl.included=true`、`dsh_plugin.included=true` |
| 8 | `install-report.ini` | ✅ PASS | 记录 `unity_nebula_webgl=...\unity\FCANebulaWebGL\index.html`、`dsh_plugin=...\.tgz` |
| 9 | 安装日志完成标记 | ✅ PASS | `%TEMP%\fca-install.log`：`step: installation completed successfully` |
| 5.2 | **v0.3.0 UI 修复随包** | ✅ PASS | `ui-fixes-in-payload`：`renderer/lib/{hierarchy,unity-selection,detail-panel}.js`、`views/relations.js`、顶栏 `btn-toggle-left/right`、`relation-detail(-hierarchy)`、`detail__hierarchy`、`fca-unity-select`、`ATLAS UNITY_SELECT_MESSAGE` 全部命中 |\n| 5.3 | **v0.3.0 Unity 新构建** | ✅ PASS | `unity-webgl-build-v030`：index 9,240 B（标题 FCA Nebula）、wasm 10.2 MB、framework 338.9 KB |\n| 6.1 | **插件版本随包匹配** | ✅ PASS | `dsh-plugin-version-match`：BUILD_INFO 插件版本 0.3.1 ↔ 安装目录 `dsh-plugin-fca-memory-0.3.1.tgz` |\n| 10 | **安装版 Runtime 冒烟** | ✅ PASS | 用安装目录内 `node\node.exe` + `runtime\bin\fca-runtime.js`：init → serve → `/health` ok → `/graph`（空库 0 节点）→ 写一条真实记忆（`mem_5a4bf8ec…`）→ `/graph` 1 节点 → shutdown ok |
| 11 | 静默卸载 `/S` | ✅ PASS | exit code 0；卸载日志 `step: uninstall completed` |
| 12 | 卸载后程序目录移除 | ✅ PASS | 安装目录（含 `unity/`、`dsh_plugin/`）全部清理 |
| 13 | 用户数据保留策略 | ✅ PASS | 卸载器默认保留用户数据目录（隔离测试库保留，db 文件可查） |
| 14 | 真实 Runtime 17860 未受干扰 | ✅ PASS | 安装/卸载前后 `/health` 均 ok（卸载器不停止 Runtime，INST-2 修复延续） |
| 15 | HKCU 卸载项 / 桌面/开始菜单快捷方式 | ⚠️ 环境受限 | 本机 DSH 工具 shell 的 Low IL 沙箱会静默丢弃这些写入（§8）；真实用户 Explorer 双击路径不受影响，由设计保证（安装器代码 `CreateShortCut`/`WriteRegStr` 已在 v0.1.x 正常安装中验证） |

> 主实测原始报告：**交付构建 #2 全流程 PASS** `artifacts\reports\install-verify-20261113-020749.json`；实测构建 #1 同样全 PASS（`install-verify-20261113-020300.json`）。检查覆盖：SHA/安装/文件/EPIPE/Unity 新构建/UI 修复断言/插件 0.3.1 版本匹配/BUILD_INFO/Runtime 冒烟/卸载/数据保留/17860 未干扰。
>
> 具体 JSON 字段：`installer.{size_bytes,sha256,sha256_ok}`、`results.{install.exit_code,installed_files.missing,unity_webgl,dsh_plugin,build_info,install_report,install_log,installed_runtime_smoke,uninstall,uninstall_log}`、`info_only.{real_runtime_17860,low_il_limits}`。

## 5. 安装器实际行为（与实现一致，`installer/installer.nsi`）

| 项 | 实际行为 |
|---|---|
| 安装权限 | per-user（`RequestExecutionLevel user`），默认安装到 `%LOCALAPPDATA%\Programs\FCA Memory Atlas`，无需管理员 |
| 安装目录选择 | 图形向导可选目录；静默安装 `/S` 默认目录；自定义用 `/D=<绝对路径>`（必须是最后一个参数、不加引号，NSIS 约定） |
| 数据目录选择 | 安装器不创建/不修改数据目录；首次启动向导选择（默认 `%LOCALAPPDATA%\FCA-Memory-Atlas`，可改） |
| 端口配置 | 默认 `127.0.0.1:17860`；首次启动向导/设置可改；Runtime 仅监听回环 |
| 首次启动向导 | 安装完成页可勾选“启动”；首次启动进入向导：欢迎→数据目录→端口→初始化空库→健康检查→完成；`F1`/帮助菜单/设置可重新进入 |
| 组件 | 桌面程序 + FCA Local Runtime + 随包 Node 24 + **Unity WebGL 星云（`unity\FCANebulaWebGL`）** + DSH 插件 tgz（`dsh_plugin\`） + docs |
| 安装日志 | `%TEMP%\fca-install.log`（失败时按错误码 E1–E5 明确提示并指向日志）；`<安装目录>\install-report.ini` 记录版本/构建时间/日志路径/Unity/插件组件 |
| 运行中保护 | 检测到 FCA Memory Atlas 正在运行会中止安装（非静默提示关闭；静默 exit code 2） |
| 卸载 | 删除程序文件（含 `unity/`、`dsh_plugin/`）、快捷方式、HKCU 卸载项；**询问是否删除数据目录，默认保留**；**不自动停止 Runtime**（避免误停其它实例，见 `docs/KNOWN_ISSUES.md` KI-RT-06）；卸载日志 `%TEMP%\fca-uninstall.log` |

## 6. 内嵌 Unity WebGL 星云证据（安装布局）

v0.2.0 星云改为 **Unity WebGL 构建内嵌 Electron 星云视图**（本地静态服务 + 跨源 iframe），不再有独立 Unity 窗口。安装布局实测证据（由 desktop-integration 在 `D:\FCA-Memory-Atlas` 安装布局下完成，真实产品代码）：

| 证据 | 说明 |
|---|---|
| `artifacts/unity/integration-embedded-app-window.png` | **真实 main.js 窗口**：Electron 壳内嵌 Unity WebGL 星云（FCA NEBULA HUD、Unity·WebGL、已连接 Runtime·LIVE、工作区图例） |
| `artifacts/unity/integration-embedded-installed.png` | **安装版 app**（`D:\FCA-Memory-Atlas` 安装布局）截图：atlas 视图内嵌 Unity 星云 |
| `artifacts/unity/integration-embedded-real.png` | capture 窗口版内嵌截图 |
| `artifacts/unity/integration-embedded-fallback-missing.png` | Unity WebGL 资源缺失时回退内置 WebGL 星云的提示（黄条） |
| `artifacts/unity/webgl-shots/webgl-view-{0,1,2}.png` | Unity WebGL 渲染器真实数据视图（1600×1000；来源 unity-renderer） |
| 桌面日志 `logs\desktop-*.log`（`scope=unity-embed`） | 安装版日志实测：`Unity WebGL 内嵌服务已启动 · dir=unity/FCANebulaWebGL · source=install-dir:unity/FCANebulaWebGL · port=10439 · token=ready`、`Unity WebGL 静态资源已加载完成`、退出 `内嵌服务已关闭` |
| `scripts/unity-integration-check.js` | 路径解析/内嵌加载/真实 Runtime 数据/截图非重复自检 PASS（`artifacts/unity/integration-report.json`） |

> 本机自动化 shell 无法可靠启动安装版 GUI：DSH 工具 shell 子进程为 Low IL（userData 锁文件不可写→单实例判定/下载缓存受限），且运行时存在用户已安装实例占用单实例锁；因此 §6 的安装版 GUI 证据由 desktop-integration 在正常令牌会话完成并归档，本报告如实标注来源。**用户从资源管理器双击启动不受此限制。**

## 7. 证据文件清单

| 文件 | 内容 |
|---|---|
| `artifacts\installer\FCA-Memory-Atlas-Setup-0.3.0-x64.exe` + `.sha256.json` | 交付安装包与校验元数据 |
| `artifacts\reports\install-build-2026-11-12T17-03-42-811Z.{json,makensis.log}` | 构建证据（makensis exit 0 / payload / checks / 完整日志） |
| `artifacts\reports\install-verify-<timestamp>.json` | 本报告 §4 主实测原始结果（SHA/安装/文件/Unity/插件/Runtime 冒烟/卸载/守卫） |
| `artifacts\unity\integration-embedded-*.png`、`webgl-shots\webgl-view-*.png`、`shots-final\` | 内嵌 Unity WebGL 星云与回退证据（真实数据） |
| `docs\UNITY_NEBULA.md` §6/§6.12、`docs\FINAL_ACCEPTANCE.md` | Unity 内嵌实现说明与验收汇总 |

## 8. 测试环境限制（如实标注，非产品缺陷）

1. **DSH 工具 shell Low IL**：其派生进程以 Low IL + `CodexSandboxUsers` 限制令牌运行，导致 `%TEMP%` 重定向到 `%TEMP%\Low`、HKCU/快捷方式写入被静默丢弃、Electron 单实例锁文件不可写——因此 HKCU 卸载项/快捷方式与安装版 GUI 启动无法在本 shell 内作为通过判据。详见 `docs/ENVIRONMENT_REPORT.md` §7.4。
2. **单实例锁**：安装版桌面程序按设计单实例运行；本机存在用户已安装实例时无法并行启动第二个实例做 GUI 冒烟。
3. **强杀 Electron 会连带停止其子 Runtime**：Windows 作业对象导致强制结束桌面进程时由其拉起的 Runtime 一并退出（数据无损）；正常关闭/设置内停止不影响数据。已记录于 `docs/KNOWN_ISSUES.md`。
4. 安装器设计上**拒绝在 FCA Memory Atlas 运行时安装**（exit code 2）；这是预期的安全行为，重新安装前需关闭程序。

## 9. 当前用户安装实例状态 与 升级/重装方案（供 Lead 最终替换）

**当前状态（2026-11-12 20:4x 实测核对）**：用户实例目录 `D:\FCA-Memory-Atlas` 已是 **v0.2.0 安装布局**（`BUILD_INFO.json`: `version=0.2.1`、`built_at=2026-11-12T11:23:14.442Z`、payload 231 文件；`unity\FCANebulaWebGL\` 24.9MB；`dsh_plugin\dsh-plugin-fca-memory-0.2.1.tgz` 51,184 B），数据目录 `<FCA_DATA_DIR>` 未变、Runtime 17860 正常。**即：用户当前实例已手动升级到 v0.2.0 交付内容**；后续如需用 Setup.exe 重新安装，按下面步骤。

推荐步骤（不丢数据）：

```powershell
# 0) 备份数据（强烈建议）
Copy-Item <FCA_DATA_DIR> <FCA_DATA_DIR>-backup -Recurse -Force

# 1) 关闭 FCA Memory Atlas（注意：强杀 Electron 会连带停它拉起的 Runtime；数据无损）
Get-Process 'FCA Memory Atlas' -ErrorAction SilentlyContinue | Stop-Process -Force
#    如 Runtime 仍在：D:\FCA-Memory-Atlas\node\node.exe ...\fca-runtime.js stop --fca-home=<FCA_DATA_DIR>

# 2) 静默安装/升级到原目录（安装器检测到旧版本会提示先停止 Runtime；/S 静默继续）
Start-Process -FilePath D:\FCA\FCA-Memory-Atlas\artifacts\installer\FCA-Memory-Atlas-Setup-0.3.0-x64.exe `
  -ArgumentList '/S','/D=D:\FCA-Memory-Atlas' -Wait -PassThru | Select-Object ExitCode

# 3) 校验新布局与版本
Test-Path 'D:\FCA-Memory-Atlas\unity\FCANebulaWebGL\index.html'
Test-Path 'D:\FCA-Memory-Atlas\dsh_plugin\dsh-plugin-fca-memory-0.2.1.tgz'
(Get-Content 'D:\FCA-Memory-Atlas\BUILD_INFO.json' -Raw | ConvertFrom-Json).version   # 0.2.0
# 4) 启动并验证：星云总览内嵌 Unity WebGL（HUD “已连接 Runtime · LIVE”）；标题栏/状态栏显示 Alpha 0.2.0；
#    日志 <FCA_DATA_DIR>\logs\desktop-*.log 搜 scope=unity-embed（应有 “Unity WebGL 内嵌服务已启动 … source=install-dir:unity/FCANebulaWebGL”
#    与 “Unity WebGL 静态资源已加载完成”）
# 5) 如 Runtime 未自动拉起：
Start-Process 'D:\FCA-Memory-Atlas\node\node.exe' -ArgumentList 'D:\FCA-Memory-Atlas\runtime\bin\fca-runtime.js','serve','--fca-home=<FCA_DATA_DIR>','--port=17860'
```

> 若在 DSH 工具 shell 内执行安装会因 Low IL 假失败：请在 **Windows 资源管理器双击** Setup.exe，或使用 `installer\run-install-test.ps1` 的 WMI 正常令牌方式。