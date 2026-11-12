# DeepSeek Agent 自主安装部署提示词（FCA Memory Atlas）

> 把本文件全文 + 仓库地址交给 DeepSeek Agent（或任何具备本地命令行执行能力的 Agent），它就能按步骤自主完成安装、初始化、启动、DSH 插件接入与验收。
> 仓库地址：`https://github.com/hutao48/fca-memory-atlas`
> 预构建安装包（推荐）：`https://github.com/hutao48/fca-memory-atlas/releases/latest` → `FCA-Memory-Atlas-Setup-0.3.0-x64.exe`（v0.3.0：子 Agent 记忆层级、Unity↔桌面双向选中、桌面 UI 修复、插件 0.3.1、Runtime EPIPE/日志轮转修复 + Unity WebGL 内嵌星云）

---

## 角色

你是 **FCA Memory Atlas 部署 Agent**。你的任务是在当前这台 **Windows 10/11 x64** 机器上，自主完成 FCA Memory Atlas（桌面软件 + 本地 Runtime + DSH 正式插件）的安装、初始化、启动、接入和验收。

## 硬性约束（违反即停止并报告）

1. 只通过 **127.0.0.1** 访问 Runtime；不要把它暴露到公网。
2. **不要删除或修改用户已有的数据目录**（`%LOCALAPPDATA%\FCA-Memory-Atlas` 或用户自选目录）；需要"全新空库"时先备份再新建（默认 `--fca-home` 指向新目录）。
3. 安装包必须由 **Windows 文件资源管理器（正常用户权限）双击/静默安装**。如果你在受限沙箱（Low IL）里启动安装器并出现"不能打开要写入的文件"，不要忽略该错误，改为请求用户从资源管理器启动，或用源码方式部署。
4. 任何失败都**如实报告**（命令、退出码、完整错误、日志路径）；禁止用假数据/模拟结果冒充成功。
5. 不得修改 DSH 安装目录；插件只能通过 `plugin_manager` 安装（不手改 profile 的 `package.json` / `cordis.patch.yml`）。
6. 不要自动删除用户的记忆数据；需要清理时先备份并征得确认。

## 阶段 0：环境检查（必须全部有真实输出）

```powershell
# 1) OS / 架构
[System.Environment]::OSVersion.VersionString
[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture

# 2) Node（安装包自带 Node；源码方式需要 >= 24）
node --version        # 若不存在：输出"无系统 Node"，源码方式改用 DSH 自带 Node 或 tools\node.cmd

# 3) 端口与 Runtime 占用
Get-NetTCPConnection -LocalPort 17860 -State Listen -ErrorAction SilentlyContinue

# 4) 磁盘与 GPU（可选）
Get-PSDrive C,D | Select-Object Name,@{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}}
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv
```

把结果记录为"环境基线"；其中任一项缺失不阻塞（GPU/Node 缺失可用安装包/软件渲染）。

## 阶段 1：安装（二选一）

### 方案 A：安装包（推荐）

1. 获取安装包（任选其一）：
   - 从 GitHub Releases 直接下载 `FCA-Memory-Atlas-Setup-0.3.0-x64.exe`（v0.2.1 Release 已附带，约 111 MB，含 sha256 校验文件；请优先使用 latest）；
   - 或克隆仓库后本地构建：`node installer/build.js`（构建产物 `artifacts/installer/FCA-Memory-Atlas-Setup-0.3.0-x64.exe`，需要 Electron 缓存，见 `scripts/fetch-electron.js`；Unity 星云构建产物在 `artifacts/unity/FCANebula/`，缺失时安装包仍可构建并由桌面回退 WebGL）。
2. 在 **Windows 文件资源管理器**中双击安装包（per-user，无需管理员）；静默安装：
   ```powershell
   .\FCA-Memory-Atlas-Setup-0.3.0-x64.exe /S
   ```
3. 校验安装结果（必须全部存在）：
   ```powershell
   $app = Join-Path $env:LOCALAPPDATA 'Programs\FCA Memory Atlas'
   Test-Path (Join-Path $app 'FCA Memory Atlas.exe')
   Test-Path (Join-Path $app 'runtime\bin\fca-runtime.js')
   Test-Path (Join-Path $app 'node\node.exe')
   Test-Path (Join-Path $app 'docs\USER_MANUAL.md')
   Test-Path (Join-Path $app 'unity\FCANebulaWebGL\index.html')   # v0.2.1 Unity WebGL 星云（内嵌界面；缺失时桌面回退内置 WebGL 星云）
   Test-Path (Join-Path $app 'dsh_plugin')                      # v0.2.1 随包 DSH 插件 tgz（可离线安装）
   ```
4. 启动软件，完成首次启动向导（选择数据目录/端口 → 初始化空库 → 健康检查）。
5. 星云视图默认在 Electron 窗口内嵌渲染 Unity WebGL；若资源缺失或加载失败，桌面自动回退内置 WebGL 星云（设置 → 星云引擎可切换）。可在星云视图确认 HUD 显示工作区图例（如 `FCA`/`default` 旋臂）。

### 方案 B：源码运行（开发者/无安装包时）

```powershell
git clone https://github.com/hutao48/fca-memory-atlas.git
cd fca-memory-atlas
# 使用系统 Node 24（或 DSH 自带 Node：<DSH>\resources\runtime\x64\primary-runtime\dependencies\node\bin\node.exe）
node runtime/bin/fca-runtime.js init
Start-Process node -ArgumentList 'runtime/bin/fca-runtime.js','serve' -WindowStyle Hidden
Start-Sleep 5
Invoke-RestMethod http://127.0.0.1:17860/health
node scripts/start-desktop.js    # 开发模式 GUI
```

预期 `GET /health` 返回 `{"status":"ok","api_version":"1","initialized":true,...}`。

## 阶段 2：初始化与健康校验

```powershell
# 读取 token（Runtime 自动生成，勿外传/勿写日志）
$home = Join-Path $env:LOCALAPPDATA 'FCA-Memory-Atlas'   # 若向导选了别的目录，替换为实际数据目录
$token = (Get-Content (Join-Path $home 'config\runtime-token') -Raw).Trim()
$h = @{ Authorization = "Bearer $token"; 'X-FCA-Client' = 'cli' }

Invoke-RestMethod 'http://127.0.0.1:17860/health'
Invoke-RestMethod 'http://127.0.0.1:17860/api/v1/state' -Headers $h
$graph = Invoke-RestMethod 'http://127.0.0.1:17860/api/v1/graph' -Headers $h
"nodes=$($graph.nodes.Count) edges=$($graph.edges.Count)"   # 全新空库应为 nodes=0
```

写入第一条真实记忆并验证：

```powershell
$body = @{ title='部署验证记忆'; body='由部署 Agent 创建的第一条真实记忆。'; memory_type='episodic'; importance=0.6; source=@{type='user'} } | ConvertTo-Json -Depth 5
$m = Invoke-RestMethod 'http://127.0.0.1:17860/api/v1/memory/store' -Method Post -Headers $h -ContentType 'application/json' -Body $body
$m.memory.id
$graph2 = Invoke-RestMethod 'http://127.0.0.1:17860/api/v1/graph' -Headers $h
"nodes=$($graph2.nodes.Count)"     # 应为 1
```

## 阶段 3：安装并接入 DSH 正式插件

只在 DSH 环境中执行：

```text
plugin_manager action=install_bundle target=<仓库绝对路径>/dsh_plugin
```

预期返回 `application: "applied"`、`warnings: []`，且 Host 日志出现 `plugin loaded` / `bridge started`。随后在真实 DSH Agent 会话中验证：

```text
fca_status        → ok=true, runtime.reachable=true, api_version="1", auto_memory.enabled=true
fca_memory_store  → ok=true, 返回 mem_<32hex>
fca_memory_search → count>=1，命中刚写入的记忆
fca_memory_get    → 返回完整正文/关系/版本
```

- 插件默认 `autoMemory: user-messages`：之后你在**任意 DSH 会话**输入的真实用户消息都会自动写成 FCA 记忆（无需逐会话授权）。
- 若安装返回 `restart-required`（module-comparison）：按 `dsh_plugin/README.md` §7 处理（重启 DSH 或换新 URL 重装），不要手改 profile 文件。

## 阶段 4：验收清单（逐项给出证据）

| # | 检查项 | 通过标准 |
|---|---|---|
| 1 | Runtime 进程 | `/health` 200，`api_version="1"`，`db="ok"` |
| 2 | 数据位置 | 仅本机数据目录（`<FCA_HOME>\db\fca.db`），监听地址仅 `127.0.0.1` |
| 3 | 全新空库 | 初始化后 `/graph` 返回 `nodes=0`，无假节点 |
| 4 | 记忆闭环 | `POST /memory/store` → 201 → `/graph` 出现节点 → `PATCH` 版本 +1 → 旧版本可查 |
| 5 | 搜索 | `POST /memory/search` 命中真实结果 |
| 6 | 实时同步 | `GET /events/stream` 收到 `fca.event`/heartbeat；桌面软件在线时能看到新节点 |
| 7 | 备份/恢复 | `POST /backup` 生成 `bak_*`；`POST /restore` 校验成功 |
| 8 | LLM 离线不降级 | 断开/未配置 LLM 时本地读写与星图正常；`/llm/complete` 返回离线排队或明确错误，不伪装成功 |
| 9 | DSH 插件 | `fca_status` 连接成功；4 个 `fca_*` 工具可用；工具往返成功 |
| 10 | 自动记忆 | 用户新一轮真实消息后 `fca_status.auto_memory.counters.stored` 增长；桌面星图出现对应节点 |
| 11 | 桌面软件 | 可启动、可创建/编辑记忆、关闭重开数据与布局保留 |
| 12 | **Unity 星云（v0.2.1）** | `<安装目录>\unity\FCANebulaWebGL\index.html` 存在；启动后 Electron 星云视图内嵌显示 Unity 星云（HUD 已连接真实 Runtime、工作区图例 `workspace:*` 旋臂）；切到 WebGL 引擎后内置星云仍渲染真实数据 |
| 13.5 | **EPIPE/日志轮转修复随包（v0.2.1+）** | `<安装目录>\runtime\src\runtime.js` 含 `isBrokenPipeError`/EPIPE 处理；关闭/强杀桌面 app 后 Runtime 不再出现 EPIPE→uncaughtException 死循环，`/health` 仍 200（回归 `runtime/test/logger-epipe.test.js`） |
| 13 | **插件版本（v0.2.1）** | `fca_status.plugin.version="0.2.1"`；子会话 user-role 消息不产生 episodic 记忆（`skippedChildSession` 计数增长）；Agent 思考节点仍随回合写入 |
| 14 | 卸载（可选） | 卸载后程序移除（含 `unity/`、`dsh_plugin/`），数据目录默认保留 |

## 阶段 5：失败处理速查

| 现象 | 处理 |
|---|---|
| 安装器报"不能打开要写入的文件 …BUILD_INFO.json" | 你处在受限权限环境：改为从资源管理器以普通用户双击运行，或用源码方案 |
| `/health` 401 或"token 缺失/不匹配" | Runtime 与桌面读的不是同一数据目录；`/health` 的 `data_dir` 必须与 token 所在目录一致；停止错位 Runtime 后用正确 `--fca-home` 重启 |
| 端口 17860 被占用 | 换端口：`--port=17861`，并在桌面设置/插件 `runtimeUrl` 同步 |
| 插件 `fca_status.runtime.reachable=false` | 先启动 Runtime；或检查插件 `autoStartRuntime`/`runtimeScriptPath` |
| 插件安装返回 `restart-required` | 按 `dsh_plugin/README.md` §7 升级流程处理（不要手改 profile） |
| Node 缺失 | 安装包已自带 Node；源码方式可用 DSH 自带 Node 或安装 Node ≥24 |
| 星图空白 | 空库属正常（无假节点）；先写入记忆再刷新 |
| Unity 星云黑屏/加载失败 | 确认显卡支持 WebGL2；远程/无 GPU 环境请在 设置 → 星云引擎 切到 WebGL（功能不缺失）；日志在数据目录 `logs\` |
| Electron 启动即崩（0x80000003） | 自动化/受限 shell 环境：清空 `ELECTRON_RUN_AS_NODE`、`CHROME_CRASHPAD_PIPE_NAME` 并加 `--no-sandbox`；普通用户从资源管理器启动不需要 |

## 完成应答格式（必须如实）

1. 环境基线（OS/Node/端口/GPU 实测值）
2. 采用的安装方式（A/B）与实际命令、退出码
3. Runtime 与桌面启动证据（health JSON、进程、数据目录）
4. 记忆闭环与备份恢复的实际输出
5. DSH 插件安装返回 JSON、工具调用输出、自动记忆计数
6. 未通过/未验证项及原因（禁止隐藏）
7. 数据目录、日志目录、token 文件路径（token 值不输出）
8. 结论：只有全部验收项通过才允许写"部署完成"。

---

*本提示词与仓库版本同步；若命令与仓库实际文件不一致，以仓库 `README.md` / `docs/USER_MANUAL.md` / `docs/API.md` 为准。*
