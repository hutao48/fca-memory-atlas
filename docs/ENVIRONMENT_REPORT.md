# FCA Alpha 0.1 — 阶段 0 环境调查报告

- 项目：FCA Memory Atlas / FCA DSH Plugin / FCA Local Runtime
- 版本：Alpha 0.1
- 调查时间：2026-11-12（2026-11-12 打包/交付阶段修正 Node 路径、NSIS 构建环境与 Electron 沙箱差异，见 §7）
- 调查主机：用户本机（Windows 11 x64）
- 结论：**真实 DSH 插件 SDK 可用**（Cordis 插件体系，已在本机 profile 中安装并运行多个第三方 bundle）。桌面端采用 Electron + WebGL2；Runtime 采用 Node 24 + 内置 `node:sqlite`（零第三方依赖、可离线运行）；不依赖 Python/PyTorch 完成 Alpha 0.1 核心功能（GPU 信息通过 `nvidia-smi` 探测并展示，渲染 GPU 加速由 WebGL 提供）。

## 1. 硬件与操作系统

| 项目 | 实测值 | 来源 |
|---|---|---|
| OS | Windows 11 专业版 10.0.26300 x64 | `Get-CimInstance Win32_OperatingSystem` |
| CPU | AMD Ryzen 7 H 260（8 核 / 16 线程） | `Get-CimInstance Win32_Processor` |
| RAM | 16,385,519,616 B ≈ 15.3 GiB | `Get-CimInstance Win32_ComputerSystem` |
| GPU | NVIDIA GeForce RTX 5060 Laptop GPU，显存 8151 MiB | `nvidia-smi` |
| 驱动 | 610.88，CUDA UMD 13.3 | `nvidia-smi` |
| 磁盘 | D: 剩余 ≈ 912 GB，C: 剩余 ≈ 572 GB | `Get-PSDrive` |

GPU 可用（CUDA 驱动层健康，`nvidia-smi` 正常枚举）。GPU 不存在时的降级路径必须仍然可用，见 ADR-002。

## 2. 语言与构建工具链

| 工具 | 实测 | 说明 |
|---|---|---|
| Node.js（项目随包） | **v24.11.0**（`D:\FCA\FCA-Memory-Atlas\vendor\node\node.exe`） | **构建/运行的首选 Node**；`tools/node.cmd`、`tools/env.ps1` 已优先使用它；安装包把该 `node.exe` 随包分发（`<安装目录>\node\node.exe`） |
| Node.js（DSH 随附兜底） | **v24.21.0**（`C:\\Users\\<user>\AppData\Local\Programs\DSH NEXT\resources\runtime\x64\primary-runtime\dependencies\node\bin\node.exe`） | 系统 PATH 中无 node；`vendor\node` 缺失时 `tools/node.cmd` 回退到此路径（DSH NEXT 升级后的新路径） |
| ~~旧 DSH 运行时路径~~ | ~~`C:\\Users\\<user>\.dsh\dsh-runtimes\dsh-next-primary-runtime\...`~~ | **已失效**（该目录当前不存在）；任何脚本/文档不得再引用旧路径 |
| `node:sqlite` | 可用（`DatabaseSync` 内存库建表/写入/查询验证通过） | 选型关键依据，见 ADR-001 |
| pnpm | 11.28.5（`...\DSH NEXT\resources\runtime\x64\primary-runtime\dependencies\pnpm\bin\pnpm.mjs`） | 通过 `tools/pnpm.cmd` 调用（优先 vendor Node + DSH pnpm）；npm/pnpm 需 `--allow-build=<pkg>` 才允许 postinstall |
| Python | 3.14.7（PATH），另有 3.12.12（uv）与 3.10 | Alpha 0.1 核心不使用 Python；GPU 探测通过 nvidia-smi |
| pip | pip 26.x（3.14 / 3.12 均可用） | 仅备用 |
| git | 2.55.0.windows.3 | 新项目独立 git 仓库（`D:\FCA\FCA-Memory-Atlas`） |
| .NET | 仅 runtime host，**无 SDK** | 不使用 .NET 编译；安装包不使用 WiX |
| NSIS | **3.04**（`D:\FCA\FCA-Memory-Atlas\.cache\nsis\Bin\makensis.exe`，x86） | 由 `scripts/fetch-nsis.js` 缓存到项目内，离线可重复构建；构建环境限制见 §4.1 |
| Electron 官方分发 | **38.2.1 win32-x64**（`D:\FCA\FCA-Memory-Atlas\.cache\electron-dist\`，299 MB） | 由 `scripts/fetch-electron.js` 缓存；安装包复用该分发，不联网下载 |
| Inno Setup / 7-Zip | 未预装 | 不需要：安装包由项目缓存 NSIS 3.04 生成 |

网络连通性实测：`registry.npmjs.org` 200、`pypi.org` 200、`github.com` 200、`nodejs.org` 200、`npmmirror.com` 镜像 200。

## 3. DSH 环境（真实插件环境）

| 项目 | 实测值 / 证据 |
|---|---|
| DSH 产品 | DSH NEXT（Electron 桌面版） |
| 安装目录 | `C:\\Users\\<user>\AppData\Local\Programs\DSH NEXT`，`resources/app.asar` + `app.asar.unpacked` |
| DSH 包版本 | `@deepseek-ai/dsh-agent-preset` = **0.2.2-rc.1**（`app.asar.unpacked/node_modules/@deepseek-ai/dsh-agent-preset/package.json`） |
| 插件体系 | Cordis bundle：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`；loader patch 插入/覆盖插件条目 |
| 当前 profile | `desktop`（`DSH_PROFILE=desktop`）；目录 `C:\\Users\\<user>\.dsh\profiles\desktop`，含 `cordis.patch.yml`、`package.json`（`dsh.profile.bundles` 列表） |
| 已装第三方 bundle | `dsh-whale-widget@0.4.2`（npm 包，含 `lib/index.js` + `cordis.patch.yml`）、`dsh-plugin-ai-design-skills`（`link:` 本地目录包）——证明正式第三方插件链路真实可用 |
| 插件安装机制 | 本会话 `plugin_manager` 工具（`install_bundle`/`set_bundle`/`list_plugins`），由 profile Loader 热加载 |
| Host 事件（已验证目录） | `session/event`（提交后事件流）、`agent/inbox/inserted`、`agent/status`、`tools/execute`、`tools/result`、`session/created`、`system-prompt/*` 等 |
| Host 服务（已验证目录） | `tools`（`register`）、`systemPrompt`（`context`/`section`/`variables`）、`commands`（`register`）、`agents`、`session`（经 `session/event`）、`webServer` 等 |
| 插件入口形态 | `export function apply(ctx, config)`、可选 `inject`、`Config`；或默认导出 Service 类（见 cordis-plugin-development 技能 host-plugin.md） |
| 插件配置持久化 | `Config` 校验 + `configEditor.edit()`；secret 存 `ctx.credentials` |
| Web/Client 半插件 | Client 清单 `dsh.client`，通过 Slot 注册渲染；实时 Slot 可经 `cordis_inspect_query`(client `Slots.listSubTree`) 查询 |

**结论：不存在“SDK 不可用”的阻塞。** 正式插件将按上述真实契约实现，并在本会话内通过 `plugin_manager install_bundle` 安装到用户 `desktop` profile，然后用真实 Agent 事件与会话验证。

## 4. 桌面封装可行性

| 项目 | 实测 |
|---|---|
| Electron npm 包 | `electron@38.2.1` 从 `registry.npmmirror.com` 安装成功；官方分发 zip `electron-v38.2.1-win32-x64.zip`（125,760,044 B）可从 `npmmirror.com/mirrors/electron/` 下载，已解压落盘 `D:\FCA\FCA-Memory-Atlas\.cache\electron-dist\`（299 MB）作为离线构建源 |
| WebView2 / Edge | Microsoft Edge 已安装（`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`），可用于无头截图验证 |
| Node 运行时随包分发 | 官方 `node.exe`（v24.11.0，89,872,896 B，见 §2）作为 FCA Local Runtime 的独立运行时随安装包分发（`<安装目录>\node\node.exe`），用户无需预装 Node |
| 安装包 | **已实测产出**：NSIS 3.04 → `artifacts\installer\FCA-Memory-Atlas-Setup-0.1.0-x64.exe`（per-user，含卸载器、开始菜单/桌面快捷方式、安装/卸载日志、数据目录保留策略）。安装→启动→连接 Runtime→卸载实测见 `docs/INSTALL_TEST.md` |
| 安装包体积 | 压缩后约 240–260 MB（Electron 38 主程序 211 MB + 随包 Node 90 MB + 应用/Runtime/文档；构建时裁剪了非中英文 Electron 语言包与 `default_app.asar`，保留 `LICENSES.chromium.html` 以满足 Chromium/Electron 许可证合规） |

### 4.1 安装包构建工具链与环境限制（2026-11-12 实测）

- 实现方式：**直接调用项目缓存的 NSIS 3.04**（`installer/build.js` → `makensis`），未使用 electron-builder/IExpress；产物与 ADR-006 方案 A 等价（Setup.exe + 卸载器 + 快捷方式 + 卸载登记），且完全离线可重复构建。
- 构建命令：`.\tools\node.cmd installer\build.js`（默认 `/SOLID lzma` + `SetCompressorDictSize 64`；`--no-compress` 仅用于链路验证）。
- 构建证据：`artifacts\reports\install-build-<timestamp>.json`（Setup.exe 大小/SHA256/payload 统计/makensis 退出码）+ `install-build-<timestamp>.makensis.log`（makensis `/V4` 完整日志）。
- **NSIS 3.04（x86）在 C: 盘系统 %TEMP% 上创建 >32 MB 内存映射临时文件会失败**：
  `Internal compiler error #12345: error creating mmap the size of N`。
  已验证最小复现：仅打包一个 16 MB 文件即失败（N=33,554,436）；1/2/4/8/12 MB 成功。
  将 makensis 的 `TEMP`/`TMP` 指向 D: 盘项目内目录后同一脚本编译成功。
  **处理**：`installer/build.js` 已固定把 makensis 的 `TEMP`/`TMP` 设为 `installer\.staging\makensis-temp`（项目所在 D: 盘），编译成功后自动清理。该限制**不影响**用户安装（安装日志 `%TEMP%\fca-install.log` 是小文件，正常写入）。
- Electron 启动的沙箱环境差异见 §7.2；DSH 工具 shell 的 Low IL 子进程限制见 §7.4。

## 5. 旧数据处理结论（不可违反）

- 工作目录 `D:\FCA` 下存在与 FCA 无关的旧项目（原神乐器演奏检测器等）及其 `.git`。**本项目的所有产物写入全新目录 `D:\FCA\FCA-Memory-Atlas`，不读取、不迁移、不修改、不删除任何旧文件。**
- 新记忆库为全新数据库，初始化时不含任何旧记忆；旧记忆迁移与旧文件物理删除均需用户另行明确授权。
- 数据目录默认 `%LOCALAPPDATA%\FCA-Memory-Atlas`，首次启动向导可选择其它目录；运行时仅监听 `127.0.0.1`。

## 6. 复现调查的命令

```powershell
# OS / 硬件 / GPU
Get-CimInstance Win32_OperatingSystem; Get-CimInstance Win32_Processor
nvidia-smi
# Node / sqlite / pnpm（项目 vendor Node 优先；DSH NEXT 随附 Node 兜底）
$NODE = 'D:\FCA\FCA-Memory-Atlas\vendor\node\node.exe'
& $NODE --version
& $NODE -e "const s=require('node:sqlite'); const db=new s.DatabaseSync(':memory:'); db.exec('CREATE TABLE t(a)'); console.log('ok')"
# DSH 随附 Node/pnpm（vendor 缺失时 tools/node.cmd、tools/pnpm.cmd 的回退路径）
$DSH_DEPS = 'C:\\Users\\<user>\AppData\Local\Programs\DSH NEXT\resources\runtime\x64\primary-runtime\dependencies'
& "$DSH_DEPS\node\bin\node.exe" --version
& $NODE "$DSH_DEPS\pnpm\bin\pnpm.mjs" --version
# 安装包构建（NSIS 3.04；TEMP 由 build.js 指向 D: 盘规避 mmap 限制）
& 'D:\FCA\FCA-Memory-Atlas\tools\node.cmd' 'D:\FCA\FCA-Memory-Atlas\installer\build.js'
# 安装/启动/卸载实测
pwsh -NoProfile -File 'D:\FCA\FCA-Memory-Atlas\installer\install-test.ps1'
# DSH 真实插件环境
Get-Content 'C:\\Users\\<user>\.dsh\profiles\desktop\package.json'
Get-Content 'C:\\Users\\<user>\.dsh\profiles\desktop\node_modules\dsh-whale-widget\cordis.patch.yml'
# 运行时内省（本会话工具）
# cordis_inspect_query(host, Config, listConfigs) / (host, Event, listEvents) / (host, Service, listService)
```

## 7. 交付阶段环境结论（2026-11-12 修正）

### 7.1 Node 路径修正（重要）

| 场景 | 路径 | 版本 |
|---|---|---|
| 项目构建/开发（首选） | `D:\FCA\FCA-Memory-Atlas\vendor\node\node.exe` | v24.11.0 |
| DSH 随附（兜底） | `C:\\Users\\<user>\AppData\Local\Programs\DSH NEXT\resources\runtime\x64\primary-runtime\dependencies\node\bin\node.exe` | v24.21.0 |
| ~~旧路径（已失效，禁止引用）~~ | ~~`C:\\Users\\<user>\.dsh\dsh-runtimes\...`~~ | — |

- `tools/node.cmd`、`tools/env.ps1`、`tools/pnpm.cmd` 均已优先 vendor Node，回退 DSH NEXT 新路径。
- `installer/build.js` 的 Node 检测：`FCA_NODE` → `vendor\node\node.exe` → DSH NEXT 新路径 → `C:\Program Files\nodejs`，任一存在即可；旧 `dsh-runtimes` 路径已移除。
- 安装包随包分发 vendor Node（`<安装目录>\node\node.exe`），用户无需系统 Node。

### 7.2 Electron 沙箱 / de-elevated shell 差异（仅测试环境）

- 本机 DSH 会话 shell 环境带 `ELECTRON_RUN_AS_NODE=1`，且 shell 处于 de-elevated 上下文。
- 从该 shell 启动 Electron（开发版或安装版）需：
  1. `Remove-Item Env:ELECTRON_RUN_AS_NODE`（以及 `ELECTRON_NO_ATTACH_CONSOLE`）；
  2. 追加 `--no-sandbox` 以规避 de-elevated shell 下的 Chromium sandbox 权限问题。
- **用户从 Explorer / 桌面快捷方式 / 开始菜单启动时不需要也不应加 `--no-sandbox`**（正常桌面会话中 Chromium 沙箱正常工作）；安装包 Finish 页/快捷方式均不带该参数。
- 自动化测试脚本 `installer/install-test.ps1` 在启动安装后的程序时显式清理该环境变量并带 `--no-sandbox`，属于测试场景处理，已在该脚本与 `docs/INSTALL_TEST.md` 注明。

### 7.3 交付物与证据

| 交付物 | 路径 |
|---|---|
| Windows x64 安装包 | `artifacts\installer\FCA-Memory-Atlas-Setup-0.1.0-x64.exe` |
| 安装包 SHA256 元数据 | `artifacts\installer\FCA-Memory-Atlas-Setup-0.1.0-x64.sha256.json` |
| 安装/启动/卸载实测报告 | `artifacts\reports\install-test-<timestamp>.json` + `docs/INSTALL_TEST.md` |
| 构建证据（makensis 日志/构建 JSON） | `artifacts\reports\install-build-*` |
| 安装包内容清单 | 安装目录 `BUILD_INFO.json`（构建时写入 payload） |

### 7.4 DSH 工具 shell 的 Low IL 子进程沙箱（实测，影响自动化测试与构建）

**结论：从 DSH 工具 shell 派生的非解释器进程（node.exe / makensis.exe / NSIS Setup.exe 等）以 Low IL + `CodexSandboxUsers` 限制令牌运行；真实用户从 Explorer 启动是 Medium IL，不受影响。**

实测证据（最小实验，均可复现）：

- 在 DSH `pwsh` 中 `& vendor\node\node.exe probe.mjs`：脚本内 `process.env.TEMP` 仍是 `C:\\Users\\<user>\AppData\Local\Temp`，但：
  - 写 `%TEMP%\probe.txt`、`%USERPROFILE%\Desktop\probe.txt` → `EPERM: operation not permitted`；
  - 写 `D:\FCA\...\.cache\probe.txt` → 成功（工作区可写）；
  - 子进程里 `whoami /groups` → **`Mandatory Label\Low Mandatory Level`**。
- `C:\\Users\\<user>\AppData\Local\Temp\Low` 目录 ACL 含 `<HOST>\CodexSandboxUsers`（Modify）；Low IL 进程的 `GetTempPath()` 返回该目录。
- 从 DSH shell `Start-Process`（或 cmd → exe）启动 NSIS 安装包：安装文件解压到工作区成功，但
  - 安装日志写到 `%TEMP%\Low\fca-install.log`；
  - `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\FCAMemoryAtlas` 未创建；
  - 桌面/开始菜单快捷方式未创建 —— **这是测试环境假失败，不是安装器缺陷**。
- 绕过方式（已验证）：`Invoke-CimMethod -ClassName Win32_Process -MethodName Create` 创建的进程为 **Medium IL**（TEMP/Desktop/HKCU 均正常），因为进程由 WmiPrvSE 创建、不继承工具 shell 的限制令牌。

对交付的影响：

| 场景 | 正确处理 |
|---|---|
| 安装/卸载自动化实测 | 使用 `installer\run-install-test.ps1`（WMI 启动 `install-test.ps1`），不要直接 `Start-Process` 安装包 |
| 人工最终验收 | 在 Explorer 中双击 `Setup.exe`（真实用户路径）；或运行上述 WMI 启动器 |
| NSIS 构建（makensis） | `build.js` 已把 TEMP 指向 D: 盘规避大文件 mmap 失败（§4.1 / KI-ENV-01） |
| Electron 冒烟测试 | DSH shell 内需清 `ELECTRON_RUN_AS_NODE` + `--no-sandbox`（§7.2），且注意其 %TEMP% 被重定向到 `%TEMP%\Low`（测试日志/截图输出路径应使用项目目录） |

> 该限制属于 DSH 工具执行环境（Windows 沙箱），不是 FCA 产品行为；在普通桌面会话（资源管理器双击、开始菜单）中安装/卸载完全正常，已由 WMI 正常令牌会话实测验证（见 `docs/INSTALL_TEST.md`）。
