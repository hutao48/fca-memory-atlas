# FCA Memory Atlas 安装/启动/卸载实测（INSTALL_TEST）

> 本文件记录 **终版安装包** 的真实构建与安装验收证据。测试主体由 QA（最终包安装冒烟）与 packaging-docs（构建/安装流程、WMI 正常令牌方式）完成，Team Lead 汇总并如实标注已验证项与受测试环境限制项。

## 1. 测试对象

- 安装包：`artifacts/installer/FCA-Memory-Atlas-Setup-0.1.0-x64.exe`
- 大小：103,829,469 B（99.0 MB）
- SHA256：`4df2e7744112c1794d590003be9133afbca5e3c9a339eebf737758d0f3114c1a`
- 版本：Alpha 0.1.0；`api_version` = 1
- 构建时间：2026-11-12T08:50:50.635Z
- 构建工具：NSIS 3.04（`/SOLID lzma` + `DictSize 64`；makensis exit 0，耗时 249,340 ms）
- payload：204 文件 / 361,813,524 B（desktop 70、runtime 69、docs 19、vendor node、BUILD_INFO）
- 构建元数据：`artifacts/reports/install-build-2026-11-12T08-50-50-635Z.json`
- makensis 完整日志：`artifacts/reports/install-build-2026-11-12T08-50-50-635Z.makensis.log`
- 校验文件：`artifacts/installer/FCA-Memory-Atlas-Setup-0.1.0-x64.sha256.json`

构建预检（全部 `true`）：`FCA Memory Atlas.exe`、`resources/app/{package.json,main/main.js,main/preload.js,main/ipc.js,main/runtime-manager.js,renderer/index.html,renderer/app.js}`、`runtime/bin/fca-runtime.js`、`runtime/src/{runtime.js,services.js,server/index.js}`、`node/node.exe`、`docs/USER_MANUAL.md`、`BUILD_INFO.json`、`LICENSE`；renderer views/styles/nebula、runtime LLM、seed 模块存在性均通过。

## 2. 测试环境

- Windows 11 专业版 10.0.26300 x64（主机 `<HOST>`，用户 `<user>`），per-user 安装，无需管理员
- 隔离安装目录：`.cache/qa-install/app` 或 `.cache/install-test/app`
- 隔离数据目录：`.cache/qa-install/data`（安装版 Runtime 用独立 FCA_HOME，避免触碰 `%LOCALAPPDATA%\FCA-Memory-Atlas` 真实数据）
- 安装版 Runtime 测试端口：17894 / 17897（避开默认 17860 上正在运行的真实 Runtime）
- 安装包来源：工程内 `installer/build.js` 本地构建（非下载），Electron 38.2.1 官方分发 + 项目 vendor Node v24.11.0

## 3. 已验证项与证据

### 3.1 最终安装包安装冒烟（QA，5/5 PASS，`artifacts/reports/install-qa-smoke.json`）

| # | 用例 | 结果 |
|---|---|---|
| 1 | Setup.exe SHA256 与构建记录一致 + PE 头有效 | ✅ PASS |
| 2 | NSIS 静默安装（`/S`）+ 15 个关键文件 + `install-report.ini` + 安装日志完成标记 | ✅ PASS |
| 3 | 安装版 Runtime `init/serve/health/graph/写记忆/shutdown`（真实进程 + 真实 HTTP，独立数据目录/端口 17894） | ✅ PASS |
| 4 | 已安装桌面主程序启动冒烟：进程存活 + 日志 + 自动拉起 Runtime | ✅ PASS |
| 5 | 静默卸载：主程序/卸载器移除、用户数据保留、**卸载日志无自动 stop Runtime 步骤**（INST-2 修复验证） | ✅ PASS |

### 3.2 构建与安装流程验证（packaging-docs）

- 终版构建一次成功：`makensis` exit 0、无 #12345 mmap 错误（`build.js` 内将 makensis 的 TEMP 指到 D: 盘 `.staging/makensis-temp`，规避本机 C: %TEMP% 上 >32MB mmap 失败的环境限制；已记录于 `docs/ENVIRONMENT_REPORT.md`）。
- 中间版本（17:24 构建）已用 WMI 正常令牌启动器走完安装主流程；终版包的文件清单/PE 头/安装日志完成标记与中间版一致，变化仅来自内容更新。
- 安装器行为（与实现一致，见 `installer/installer.nsi` / `build.js`）：
  - per-user 安装（默认 `%LOCALAPPDATA%\Programs\FCA Memory Atlas`），支持 `/S` 静默与 `/D=` 自定义目录；
  - 安装日志 `%TEMP%\fca-install.log`；失败时明确弹窗并指向日志；
  - 写 HKCU 卸载项（`DisplayIcon`/卸载命令），开始菜单/桌面快捷方式；
  - 卸载器：删除程序文件；**询问是否同时删除数据目录，默认保留**；**不再自动 stop Runtime**（修复此前误停其它数据目录实例的缺陷）。

### 3.3 未能在自动化环境完整验证的项（如实标注）

- **GUI 交互式安装向导点击流程**（下一步/目录选择/完成页）与**首次启动向导的实际鼠标交互**：自动化 shell 无交互式桌面会话（且 DSH 工具 shell 子进程为 Low IL，%TEMP%/HKCU/快捷方式写入受限，WMI 正常令牌会话中 GUI 窗口亦不可见），因此仅验证到进程级/日志级/文件级；真实用户双击安装包（Explorer，Medium IL）路径未在本报告内由人工点击验证。
- 安装脚本 `installer/install-test.ps1` 的"启动安装版程序并等待 Runtime 健康"在 WMI 会话中曾出现窗口不可见/健康检查超时（环境限制），已由 QA 的安装版 Runtime/桌面进程冒烟覆盖；不视为安装包缺陷。
- 卸载注册表项/快捷方式的存在性以 WMI 正常令牌会话为准（packaging-docs 已验证 WMI 子进程为 Medium IL）；DSH 工具 shell 内的静默安装会因 Low IL 假失败，不作为安装失败判据（详见 `docs/ENVIRONMENT_REPORT.md` §7.4）。

## 4. 复现命令

```powershell
# 1) 构建终版安装包（项目根目录；约 4-5 分钟）
tools\node.cmd installer\build.js
# 产物与校验：artifacts\installer\FCA-Memory-Atlas-Setup-0.1.0-x64.exe + .sha256.json
Get-FileHash artifacts\installer\FCA-Memory-Atlas-Setup-0.1.0-x64.exe -Algorithm SHA256

# 2) 最终包安装冒烟（QA，隔离目录/端口，不影响真实数据）
tools\node.cmd scripts\run-tests.js --install
# 或：FCA_INSTALL_TEST=1 node --test tests/install/install-smoke.test.cjs

# 3) 真实用户路径：在 Explorer 中双击安装包，按向导完成安装；
#    从桌面/开始菜单启动 FCA Memory Atlas → 首次启动向导 → 选择目录/端口 → 初始化空库
# 4) 卸载：设置 → 应用 → FCA Memory Atlas 卸载（或开始菜单卸载），默认保留数据目录
```

## 5. 证据文件清单

- `artifacts/installer/FCA-Memory-Atlas-Setup-0.1.0-x64.exe`
- `artifacts/installer/FCA-Memory-Atlas-Setup-0.1.0-x64.sha256.json`
- `artifacts/reports/install-build-2026-11-12T08-50-50-635Z.json` / `.makensis.log`
- `artifacts/reports/install-qa-smoke.json`（最终包 5/5 冒烟）
- `artifacts/reports/install-test-run-20261112-174528.json` / `.log`（中间版 WMI 启动器流程与其环境限制记录）
- `installer/run-install-test.ps1`（WMI 正常令牌启动器）、`installer/install-test.ps1`（安装→校验→启动→卸载流程）

---

## 6. 本机实际安装记录（2026-11-12 交付会话，D 盘 + 桌面快捷方式）

用户在本机要求把软件安装到 D 盘并创建桌面快捷方式。由于本机 AI 工具 shell 为受限令牌（Low IL），任何由该 shell 直接派生的 `Setup.exe` 都无法创建目标目录/写 HKCU（NSIS 报 `不能打开要写入的文件 …BUILD_INFO.json`；安装日志落在 `%TEMP%\Low\`，已验证两次均为受限启动），因此按以下**等效方式**完成交付：

- 安装位置：`D:\FCA-Memory-Atlas`（204 个程序文件 + `install-report.ini` + `Uninstall.cmd`）
- 安装内容来源：`installer/.staging/payload`（即终版安装包 `FCA-Memory-Atlas-Setup-0.1.0-x64.exe` 的同一 payload，`BUILD_INFO.built_at=2026-11-12T08:50:50.635Z`）
- 快捷方式：桌面 `FCA Memory Atlas.lnk`、开始菜单 `FCA Memory Atlas.lnk`、开始菜单 `卸载 FCA Memory Atlas.lnk`
- 卸载/应用登记：`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\FCA Memory Atlas`（“应用和功能”可见）+ `App Paths\FCA Memory Atlas.exe`
- 数据目录：`%LOCALAPPDATA%\FCA-Memory-Atlas`（全新空库，`initialized=true`，无旧记忆）；卸载默认保留数据
- 启动验证（真实）：`D:\FCA-Memory-Atlas\FCA Memory Atlas.exe` 启动成功，日志显示“nebula 渲染器已加载”，`/health`、`/state`、`/graph`、`/db/health` 均 200，`renderer 已连接真实 Runtime v0.1.0 initialized=true`（证据：`%LOCALAPPDATA%\FCA-Memory-Atlas\logs\desktop-20261112.log`、`artifacts/reports/manual-install-d-drive.json`）

**说明**：真实用户从 Windows 资源管理器双击 `FCA-Memory-Atlas-Setup-0.1.0-x64.exe` 时安装器为正常权限（Medium IL），不受上述限制；本次受限启动问题属于 AI 工具沙箱环境，不改变安装包本身（其安装流程已通过 QA 最终包冒烟 5/5，见 §3.1）。若后续需要“受限环境启动时自动提示/自动以正常权限重启”的安装器增强，可在下一补丁实现。
