# FCA Memory Atlas 用户手册（v0.3.0 / Windows x64）

- 产品：FCA Memory Atlas（FCA 认知记忆地图）
- 版本：v0.3.0（桌面/Runtime/安装包 0.3.0；DSH 插件 0.3.1；Runtime API v1）
- 平台：Windows 10/11 x64
- 安装包：`FCA-Memory-Atlas-Setup-0.3.0-x64.exe`（含 Unity WebGL 星云组件 + DSH 插件 0.3.1 tgz）
- 本文档适用于**安装版**（安装包安装后的 `FCA Memory Atlas.exe`）；开发版（源码 + `.cache\electron-dist`）用法见 `README.md` 与 `docs/ARCHITECTURE.md`。

> Alpha 0.1 是内部评估版本：软件按“现状”提供，不承诺数据不丢失。重要的记忆数据请定期使用“数据管理 → 备份”或手动复制数据目录。

---

## 1. 它是什么

FCA Memory Atlas 是运行在你本机上的“认知记忆地图”：

- **记忆库在本地**：所有记忆、关系、标签、布局、身份与认知状态保存在本机 SQLite 数据库，默认 `%LOCALAPPDATA%\FCA-Memory-Atlas`，不上传到任何服务器。
- **星云可视化（v0.3.0 默认 Unity WebGL）**：记忆以星体/星云形式呈现，关系以光丝相连；由 **Unity WebGL 渲染器内嵌在 Electron 窗口**中绘制（工作区旋臂 + Agent 思考节点 + **子 Agent 记忆层级展开**），Unity 不可用时自动回退内置 WebGL 星云。可以缩放、拖拽、切换聚类星域与性能档位。
- **完整编辑能力**：记忆的新建、编辑、软删除/回收站、版本历史与 diff、合并/拆分、批量修改；关系的新建/编辑/删除；时间线与全文/语义/混合搜索。
- **数据管理**：备份/恢复、导出/导入（仅 FCA 格式）、数据库健康检查与 VACUUM、运行日志查看。
- **可选 LLM**：可在设置中配置 DeepSeek / OpenAI 兼容 / 自定义 Provider；本地记忆的读写、检索、可视化**不依赖** LLM。
- **与 DSH 插件共享数据**：配套的 FCA DSH 插件连接同一个本地 Runtime 和同一套数据（插件安装见 `docs/PLUGIN_INTEGRATION_TEST.md`、`docs/DSH_PLUGIN_ENVIRONMENT_REPORT.md`）。

本安装包同时安装三个部分：

| 组件 | 位置 | 说明 |
|---|---|---|
| FCA Memory Atlas 桌面软件 | `<安装目录>\FCA Memory Atlas.exe` | Electron 38 桌面程序 |
| FCA Local Runtime 本地服务 | `<安装目录>\runtime\` | Node 24 本地 HTTP 服务，默认 `127.0.0.1:17860` |
| Node 24 运行时 | `<安装目录>\node\node.exe` | 随包分发，无需系统预装 Node |
| Unity 星云渲染器（v0.3.0） | `<安装目录>\unity\FCANebulaWebGL\index.html` | Unity 2022.3 WebGL 构建，内嵌 Electron 星云视图渲染；缺失/失败自动回退内置 WebGL 星云 |
| DSH 插件安装包（v0.3.0 起附带 0.3.1） | `<安装目录>\dsh_plugin\dsh-plugin-fca-memory-0.3.1.tgz` | 可离线安装到 DSH profile（见 `dsh_plugin/README.md`） |

三者关系：桌面软件启动时按需拉起 Runtime；关闭桌面软件不删除数据；Runtime 也可由命令行/插件独立管理。

## 2. 系统要求

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows 10 / Windows 11 x64（需要 WebGL2 的显卡驱动；无 GPU 时可用软件渲染降级） |
| 磁盘空间 | 安装占用约 500 MB；数据目录按记忆数量增长，另需预留备份空间 |
| 内存 | 建议 8 GB 以上（星云渲染 + SQLite）；16 GB 可开启“极致”画质 |
| 权限 | **无需管理员**：默认安装到当前用户目录（per-user） |
| 端口 | 默认 `17860`（仅回环 `127.0.0.1`，可在设置/首次向导修改） |
| 网络 | 仅在使用云端 LLM 时需要出网；本地记忆功能完全离线可用 |

## 3. 安装

### 3.1 图形界面安装（推荐）

1. 双击 `FCA-Memory-Atlas-Setup-0.1.0-x64.exe`。
2. 在欢迎页确认版本与组件，勾选接受许可声明（内部 Alpha 许可）。
3. 选择安装目录，默认：`%LOCALAPPDATA%\Programs\FCA Memory Atlas`（即 `C:\Users\<你>\AppData\Local\Programs\FCA Memory Atlas`）。**不需要管理员权限，不会写入系统目录。**
4. 点击“安装”，等待文件解压（约 400 MB 未压缩，安装需 1–3 分钟，取决于磁盘速度）。
5. 完成页可选：
   - “启动 FCA Memory Atlas”（默认不勾选）；
   - “打开用户手册（docs\USER_MANUAL.md）”。
6. 安装完成后会创建：
   - 桌面快捷方式 `FCA Memory Atlas`；
   - 开始菜单 `FCA Memory Atlas` 文件夹：程序、使用说明、卸载；
   - “应用和功能（添加/删除程序）”中的 `FCA Memory Atlas (Alpha 0.1.0)` 卸载项。

安装目录结构（用于排错与理解）：

```
<安装目录>\
  FCA Memory Atlas.exe         主程序（Electron）
  Uninstall.exe                卸载器
  BUILD_INFO.json              构建信息（版本/组件/默认路径）
  install-report.ini           本次安装报告（版本、日志路径、默认数据目录）
  resources\app\               桌面应用代码（main 主进程 + renderer 界面）
  resources\docs\              帮助菜单“打开文档目录”使用的文档副本
  docs\                        完整文档（用户手册、已知问题、架构、ADR 等）
  unity\FCANebulaWebGL\        Unity 星云 WebGL 构建（v0.3.0；缺失时桌面回退内置 WebGL）
  dsh_plugin\                  DSH 插件 tgz（0.3.1）+ README（v0.3.0 起随包附带，可离线安装）
  runtime\bin\fca-runtime.js   本地服务入口
  runtime\src\                 本地服务源码
  node\node.exe                随包 Node 24
  LICENSE / LICENSES.chromium.html
```

### 3.2 静默安装（适合批量/自动化）

```powershell
# 默认安装目录（当前用户）
.\FCA-Memory-Atlas-Setup-0.1.0-x64.exe /S

# 自定义安装目录：/D= 必须是最后一个参数，路径不要加引号（NSIS 约定）
.\FCA-Memory-Atlas-Setup-0.1.0-x64.exe /S /D=D:\Apps\FCA-Memory-Atlas

# 查看安装退出码（0=成功；2=程序正在运行；3..7=安装内容缺失，见 install 日志）
$p = Start-Process .\FCA-Memory-Atlas-Setup-0.1.0-x64.exe -ArgumentList '/S','/D=D:\Apps\FCA-Memory-Atlas' -Wait -PassThru
$p.ExitCode
```

- 静默安装不会显示任何向导页；安装完成后快捷方式与卸载登记同样会创建。
- 静默安装**不会**自动启动程序。
- 若安装失败：**先看安装日志** `%TEMP%\fca-install.log`（即 `C:\Users\<你>\AppData\Local\Temp\fca-install.log`）。日志中 `ERROR E1`～`E5` 对应主程序/应用代码/界面/Runtime/Node 缺失。

### 3.3 校验安装包完整性

随安装包发布 `FCA-Memory-Atlas-Setup-0.1.0-x64.sha256.json`（在 `artifacts\installer\` 或发布包旁边）：

```powershell
Get-FileHash .\FCA-Memory-Atlas-Setup-0.1.0-x64.exe -Algorithm SHA256 | Format-List
# 与 .sha256.json 中的 sha256 字段比对（大小写不敏感）
```

### 3.4 安装失败/程序在运行

- 安装器检测到 **FCA Memory Atlas 正在运行**会提示先关闭；静默安装会直接以退出码 2 失败。请先关闭程序（任务栏/托盘）再安装。
- 升级安装（覆盖安装）前建议先在“数据管理 → 备份”创建备份。
- 安装日志：`%TEMP%\fca-install.log`；卸载日志：`%TEMP%\fca-uninstall.log`。

## 4. 首次启动

1. 双击桌面 `FCA Memory Atlas`（或开始菜单 → `FCA Memory Atlas`）。
2. 第一次启动会进入**首次启动向导**（也可随时按 `F1` 或从“帮助 → 首次启动向导”重新打开）：

| 步骤 | 内容 |
|---|---|
| 欢迎 | 说明本地优先与 Alpha 限制 |
| 数据目录 | 选择数据库/备份存放目录，默认 `%LOCALAPPDATA%\FCA-Memory-Atlas`；要求绝对路径 |
| Runtime 端口 | 本地服务端口，默认 `17860`（仅回环监听；端口被占用时可改） |
| 初始化空库 | 创建全新空白数据库（**不导入、不迁移任何旧记忆**） |
| 健康检查 | 校验 Runtime 与数据库可用 |
| 完成 | 保存配置并进入应用 |

3. 第一次进入主界面时若星云为空，这是正常的：**这是一个全新的空记忆库**。点击“新建记忆”（`Ctrl+N` 无默认绑定，使用界面按钮/菜单“文件 → 新建记忆”）或导入 FCA 导出文件开始。

> 首次向导的任何一步失败都会显示具体原因（如端口占用、目录不可写），不会伪造成功。可修正后重试；向导是幂等的。

![首次启动向导](../artifacts/screenshots/desktop-onboarding.png)

## 5. 界面总览

主窗口为三栏专业布局（左导航、中视图、右详情），顶部有顶栏、底部有状态栏。

### 5.1 顶栏

- **全局搜索框**：输入关键字即时检索，回车进入搜索视图，`Ctrl+K` / `Ctrl+F` 聚焦。
- **时间筛选**：按时间范围过滤星图/列表/时间线（支持“全部/自定义范围”）。
- **视图切换**：星云总览、时间线、关系探索、记忆列表、数据管理、设置。
- **撤销 / 重做**（`Ctrl+Z` / `Ctrl+Shift+Z`）。
- **导入 / 导出** 快捷入口。
- **设置**（齿轮）。
- **Runtime 状态指示**：绿=已连接；黄=启动中/异常；红=未连接，可点击查看状态并重启。

### 5.2 底栏

显示：Runtime 状态与版本、数据库状态、节点/关系计数、SSE 实时同步状态、画质档位、应用版本（Alpha 0.1.0）。

### 5.3 左导航

- 视图入口（星云总览 / 时间线 / 关系探索 / 记忆列表 / 数据管理 / 设置）
- 聚类星域、只看收藏
- 记忆分类（记忆类型）、项目、标签、收藏
- “打开数据目录”快捷入口

### 5.4 右详情面板

选中星体/记忆后显示标题、类型、时间、重要性、标签、参与人物、所属项目、正文摘要与关系；提供“在编辑器中打开 / 刷新 / 复制 ID / 星标收藏 / 收起”等操作。

### 5.5 布局

- 左右面板可折叠、可拖拽调整宽度；布局持久化在本地。
- “视图 → 布局预设”：默认布局 / 宽画布 / 专注阅读。
- 双击节点进入编辑器；`F` 适应屏幕，`L` 显示/隐藏图例，`Q` 循环切换画质。

## 6. 星云总览（Atlas）

- **星体/星云/光丝**：每条记忆是一个星体，聚类以体积星云呈现，关系以光丝连接；颜色由聚类/类型/重要性映射，图例可开关。
- **浏览**：滚轮缩放、拖拽平移、点击星体选中并在右栏查看详情；双击打开编辑器。
- **拖动节点**：可拖动星体调整布局，布局写回 Runtime（`POST /layout/nodes`），下次打开保持。
- **聚类星域模式**：把记忆按聚类分组展示（视图菜单/左导航“聚类星域”）。
- **筛选**：按类型、项目、标签、时间、收藏过滤；筛选条件影响星图、列表与搜索的默认范围（以界面提示为准）。
- **画质档位**：`ultra / high / medium / low / off`（极致/高/中/低/关闭特效）。无 GPU 或远程桌面环境建议 `low` 或 `off`。
- **刷新**：`F5` 重新拉取图谱；SSE 会实时推送变更并增量更新。

![星云总览](../artifacts/screenshots/desktop-atlas-demo.png)
![聚类星域](../artifacts/screenshots/desktop-atlas-clusters.png)

### 6.1 Unity 星云渲染（v0.3.0 默认，内嵌界面）

从 v0.2.0 起，星云由 **Unity WebGL 构建**（`<安装目录>\unity\FCANebulaWebGL\`）在 **Electron 星云视图内嵌渲染**（桌面内置本地静态服务，用 iframe 加载 Unity WebGL 播放器）：

- **工作区旋臂**：同一工作区的记忆（标签 `workspace:<名称>`，如 `workspace:FCA`）自动归到同一条对数螺旋旋臂；没有该标签的旧记忆进入 `default` 旋臂（无需迁移）。画面 HUD 显示连接状态、工作区图例与点选详情。
- **Agent 思考节点**：DSH 插件按 Agent 回合自动生成 `Agent思考节点` 记忆（推理要点/工具执行/结论），同样出现在旋臂上。
- **打开/关闭（引擎切换）**：星云工具栏/设置提供 `Unity / WebGL` 引擎切换；Unity 加载失败、WebGL 不可用或被用户切换时，视图自动回退内置 WebGL 星云并给出提示。
- **数据**：Unity WebGL 通过桌面注入的本地 Runtime URL/token 拉取真实图谱数据（默认 3 秒轮询）；不伪造节点。
- **首次加载**：Unity WebGL 需要下载 wasm/data（本地静态服务，无网络依赖），首次进入星云可能有数秒加载；之后由浏览器缓存加速。
- **失败回退**：Unity WebGL 资源缺失、加载失败或显卡不支持 WebGL2 时，桌面自动使用内置 WebGL 星云（功能不缺失）；失败原因显示在状态卡/提示条上。
- **子 Agent 记忆层级（v0.3.0）**：点击父 Agent思考节点（或详情面板「子 Agent 记忆（N）」区块）可展开/收起子 Agent 会话节点；再次点击收起。
- **双向选中同步（v0.3.0）**：Unity 星云中点击记忆节点 → 右侧详情面板自动打开该记忆；在列表/搜索结果中选中记忆 → Unity 星云高亮对应节点。

![Unity 星云（真实 Runtime 数据）](../artifacts/unity/shots-final/screenshot-1-overview.png)
![Unity 星云 · 工作区旋臂](../artifacts/unity/shots-final/screenshot-2-workspace-arm.png)

### 6.2 星云引擎与画质设置

- **设置 → 外观与性能 → 星云引擎**：`Unity`（默认，内嵌 WebGL 播放器）或 `WebGL`（内置回退渲染器）。选择后立即生效并持久化。
- **画质档位**：`ultra / high / medium / low / off`，同时作用于 Unity 与 WebGL 渲染；低配/远程桌面建议 `low` 或 `off`。
- 无 GPU 的机器、远程会话或显卡驱动异常时，推荐手动切到 WebGL。

## 7. 记忆编辑器

打开方式：双击星体/列表行、详情面板“在编辑器中打开”、深链 `#view=editor&id=mem_…`。

可编辑字段：

- 标题（必填，≤500 字符）、正文（Markdown，上限约 100 万字符，支持安全预览）
- 记忆类型：工作 / 情景 / 语义 / 程序 / 自传 / 项目 / 关系 / 情绪
- 发生时间 + 时间精度（精确到时刻 / 精确到日 / 估计 / 未知）
- 来源、可信度（confidence）、重要性（importance，0–1）、显示权重
- 标签、参与人物（实体）、所属项目、情绪
- origin（来源标识）

其他能力：

- **保存前本地校验**；保存时带版本号做乐观并发控制。出现 `VERSION_CONFLICT`（他人/另一窗口修改）时可选择“加载最新”或“覆盖保存”。
- **版本历史**：查看历史版本、字段级 diff（RFC6902）与正文行级 diff、载入历史版本。
- **软删除 / 恢复**：删除进入回收站（列表视图中可恢复）；选择“永久删除”需二次确认。
- **合并 / 拆分**：合并重复记忆、拆分一条记忆（需确认）。
- **草稿恢复**：未保存内容会在本地保留草稿，异常关闭后再次打开可恢复（草稿只是 UI 数据，不代表已入库）。
- **Markdown 预览**：渲染安全子集，防止 XSS。

![记忆详情](../artifacts/screenshots/desktop-atlas-detail.png)

## 8. 关系探索

- 关系是独立数据实体，两端可以是记忆或人物/项目实体。
- **关系类型**（Alpha 0.1 冻结枚举）：先于 / 后于 / 参与 / 共同经历 / 知识关联 / **因果** / 派生自 / 属于项目 / 情绪关联 / 自定义。
- **因果（causal）关系必须填写 evidence（证据/依据）**，否则保存会被拒绝。
- 可设置：confidence（置信度）、source（用户/Agent/系统/外部/模型推断/导入）、directed（是否有向）、weight（权重）。
- 列表支持按节点、关系类型、回收站筛选；从详情面板/星图选中节点后可“从此节点浏览关系”。
- **删除关系不会删除两端对象**（界面会明确提示）。

## 9. 时间线

- 粒度：日 / 周 / 月 / 年。
- 筛选：人物、项目、记忆类型、时间范围（服务端筛选 + 客户端精筛）。
- 时间精度可视化：精确 / 估计 / 缺失分别标记；未知时间不会被伪造到某个时间桶。
- 点击时间桶会选中对应记忆并联动星图；点击记忆打开编辑器。
- **时间段回放**：按时间桶顺序推进并淡入真实记忆（没有虚构历史）。

## 10. 搜索

- 入口：顶栏搜索框、`Ctrl+K` / `Ctrl+F`、左导航“搜索”、深链 `#view=search&q=…`。
- 模式：
  - **全文（fulltext）**：FTS + 中文 bigram 匹配；
  - **语义（semantic）**：本地确定性向量 `local-hash-v1`，不依赖外部模型；
  - **混合（hybrid）**：全文 + 语义融合排序。
- 筛选：时间范围、记忆类型、人物/项目实体、标签；结果高亮、分页、打开编辑器、定位到星图。
- **关系检索**：客户端对关系列表做匹配（Runtime Alpha 0.1 未提供全局关系搜索端点，界面会如实标注）。
- 历史版本搜索在 Alpha 0.1 **不可用**，界面会明确显示“不支持”，不会伪造结果。

## 11. 记忆列表与批量操作

- 全量表格（虚拟滚动，支持大数据量）：标题、类型、发生时间、重要性、权重、版本、更新时间；可排序、多选。
- 筛选：类型、时间、关键字。
- **批量修改**：类型 / 添加标签 / 重要性 / 所属项目 / 软删除；逐条真实 PATCH，带并发校验。
- **回收站**：恢复 / 永久删除（二次确认）。

## 12. 数据管理

“数据管理”视图包含四个标签页：

### 12.1 概览与健康

- Runtime 状态、API 版本、运行时版本、运行时长、数据库是否初始化、数据库状态。
- 数据规模计数（记忆/关系/实体/标签等）、存储信息、GPU 信息（可用时）。
- “完整性检查 / VACUUM”：检查数据库并整理空间。
- “新建空白库”：在数据目录创建全新空库（会明确提示影响；不会静默覆盖）。
- 数据库迁移版本列表（由 Runtime 启动时自动执行迁移，桌面端不直接改库）。

### 12.2 备份 / 恢复

- **创建备份**：Runtime 创建并校验一份完整备份，存放在数据目录 `backups\`。建议在导入、批量修改、升级前备份。
- **备份列表**：显示 ID、时间、大小、备注；可恢复、删除。
- **恢复**：需要两次确认；恢复期间请勿写入；完成后通常需要**重启 Runtime**（界面会提示并可一键重启）。
- 当前数据库在恢复前会自动备份（以 Runtime 实现为准）。
- 命令行等价操作见 §15。

### 12.3 导出 / 导入

- **导出**：格式 JSON（单文件）/ JSONL（逐行）/ ZIP（打包）；范围可选“全部记忆与关系”或“按条件导出（当前筛选 + 时间范围）”；可选包含回收站记忆；通过系统对话框选择保存位置。
- **导入**：**仅支持 FCA Memory Atlas 自身导出的 JSON / JSONL / ZIP 格式**。Alpha 0.1 明确禁止导入旧记忆系统格式，也不做旧库迁移。导入为幂等写操作（重复导入不产生重复记忆，以 Runtime 实现为准）。
- 导入/导出的文件路径由主进程原生对话框选择；文件内容在本地处理。

### 12.4 运行日志

- 查看 Runtime 已脱敏日志（token / API Key 等敏感字段显示为掩码），可按级别筛选，最多展示 300 行。
- “打开日志目录”直接打开 `数据目录\logs\`。

## 13. 设置

“设置”视图包含：

### 13.1 数据目录与 Runtime

- **数据目录**：显示当前生效路径；修改后保存需要**重启应用**（界面会提示）。注意：切换到新目录等于换一个记忆库；旧目录数据不会被删除或迁移，仍保留在原路径。
- **Runtime 端口**：默认 17860，仅回环；修改后需重启应用/Runtime 生效。端口被占用时可用其他端口（1024–65535）。
- **Runtime 状态与控制**：启动 / 停止 / 重启 Runtime、重新检查健康；显示 Runtime URL、数据目录、入口文件、Node 路径、错误信息。
- 真实路径可一键“打开数据目录 / 日志目录 / 配置目录”。

### 13.2 LLM Provider（可选）

- 支持类型：**DeepSeek**（默认 `https://api.deepseek.com` / `deepseek-chat`）、**OpenAI 兼容**（默认 `https://api.openai.com/v1` / `gpt-4o-mini`）、**自定义**。
- 每个 Provider 可配置：名称、类型、Base URL、模型、API Key、启用开关。
- **API Key 安全**：提交后由 Runtime 使用本机主密钥（`数据目录\secrets\master.key`，AES-256-GCM）加密保存到本地数据库；列表与日志中只显示掩码（如 `sk-***abcd`），桌面端不保存明文。
- “测试连接”会真实发起一次模型调用探测；“离线队列”展示因网络/额度失败的请求，可手动重试（Runtime 支持时）。
- LLM 不可用/未配置时，本地记忆的创建、编辑、搜索、关系、时间线、备份全部照常工作。

### 13.3 外观与性能

- 主题：仅深空暗色主题。
- **星云引擎（v0.3.0）**：`Unity`（默认）或 `WebGL`；Unity 不可用时自动回退 WebGL。
- 性能档位（作用于星云渲染）：极致 / 高（默认）/ 中 / 低 / 关闭特效。
- 快捷键提示。

### 13.4 关于 / Alpha 说明

- 版本信息、API 版本、Runtime 版本、数据目录；状态栏显示 `Alpha 0.3.0`（从 `desktop/package.json` 版本派生）；标题栏品牌副标题随版本显示 `Alpha 0.3`；
- “重新运行首次启动向导”；
- 许可与 Alpha 限制说明。

## 14. 数据与文件位置

### 14.1 数据目录（默认 `%LOCALAPPDATA%\FCA-Memory-Atlas`）

```
%LOCALAPPDATA%\FCA-Memory-Atlas\
  desktop-settings.json        桌面设置（数据目录、端口、画质、向导完成标记等）
  desktop-window-state.json    窗口大小/位置
  desktop\                     Electron 用户数据（缓存/会话，可删除，不影响记忆库）
  db\fca.db                    SQLite 主数据库（WAL 模式；运行时伴随 -wal/-shm）
  config\runtime-token         Runtime 访问令牌（每次初始化生成；请勿泄露）
  config\runtime.json          可选 Runtime 配置文件（端口/host/日志级别等）
  logs\                        桌面日志 desktop-YYYYMMDD.log + Runtime 日志
  backups\                     数据库备份
  exports\                     命令行导出默认目录
  events\                      事件 JSONL 审计日志（SSE 同源）
  secrets\master.key           LLM API Key 加密主密钥（仅本机，勿拷贝/泄露）
  runtime.pid / runtime.lock   Runtime 运行标记
```

- **备份 = 复制整个数据目录**（建议关闭程序后复制），或使用“数据管理 → 备份”。恢复时把备份文件放回 `backups\` 再用界面恢复。
- 数据目录可以放在任意本地磁盘（设置/首次向导选择）；不要放在网络共享盘上（SQLite 可靠性差）。
- 多 Windows 用户：每个用户有独立的安装与数据目录（per-user 安装）。

### 14.2 安装目录（默认 `%LOCALAPPDATA%\Programs\FCA Memory Atlas`）

见 §3.1。`BUILD_INFO.json` 记录构建版本、Electron/Node 版本、默认路径；`install-report.ini` 记录本次安装信息。

### 14.3 日志

| 日志 | 位置 | 内容 |
|---|---|---|
| 桌面应用日志 | `数据目录\logs\desktop-YYYYMMDD.log` | JSONL，已脱敏（token/密钥掩码），含启动、Runtime 生命周期、错误、崩溃 |
| Runtime 日志 | `数据目录\logs\` | 服务请求/错误（已脱敏） |
| 事件审计 | `数据目录\events\` | 事件 JSONL 镜像（记忆/关系变更等） |
| 安装日志 | `%TEMP%\fca-install.log` | 安装步骤与错误码（E1–E5） |
| 卸载日志 | `%TEMP%\fca-uninstall.log` | 卸载步骤与结果 |

## 15. 命令行（FCA Local Runtime CLI）

安装目录内自带 Node 与 Runtime，可直接运行（无需系统安装 Node）：

```powershell
$FCA = "$env:LOCALAPPDATA\Programs\FCA Memory Atlas"
$NODE = "$FCA\node\node.exe"
$RT = "$FCA\runtime\bin\fca-runtime.js"

# 版本 / 帮助
& $NODE $RT --help
& $NODE $RT version

# 初始化 / 启动 / 状态 / 健康 / 停止
& $NODE $RT init
& $NODE $RT serve            # 前台启动（Ctrl+C 退出）
& $NODE $RT status
& $NODE $RT health
& $NODE $RT stop

# 备份 / 恢复 / 导出 / 导入
& $NODE $RT backup --note="手动备份"
& $NODE $RT restore <backup_id>
& $NODE $RT export --format=zip --path="D:\backup\fca-export.zip"
& $NODE $RT import "D:\backup\fca-export.zip"

# 演示数据（仅测试用；需先 stop）
& $NODE $RT seed --demo --count=120
& $NODE $RT seed --clear

# 日志 / 迁移
& $NODE $RT logs --level=error --limit=100
& $NODE $RT migrate
```

通用参数：

- `--fca-home=<绝对路径>`：指定数据目录（默认 `%LOCALAPPDATA%\FCA-Memory-Atlas`，环境变量 `FCA_HOME` 优先于默认值）
- `--port=<端口>`、`--host=<主机>`（默认仅允许回环）
- `--json`（默认 JSON 输出）、`--quiet`、`--help`
- 环境变量：`FCA_HOME`、`FCA_PORT`、`FCA_HOST`、`FCA_LOG_LEVEL`、`FCA_SSE_HEARTBEAT_MS`、`FCA_ALLOW_REMOTE`

退出码：`0` 成功；`1` 一般错误；`2` 配置错误；`3` 端口占用。

## 16. 卸载

### 16.1 常规卸载

任选其一：

1. 开始菜单 → `FCA Memory Atlas` → `卸载 FCA Memory Atlas`；
2. Windows 设置 → 应用 → 已安装的应用 → `FCA Memory Atlas (Alpha 0.1.0)` → 卸载；
3. 运行 `<安装目录>\Uninstall.exe`。

卸载过程：

- **不会自动停止本地 Runtime**（设计决定）：卸载器无法知道你是否改用过自定义数据目录，自动执行 `fca-runtime stop` 可能误停其它实例（例如 DSH 插件正在使用的 Runtime）。若检测到默认数据目录存在 `runtime.pid`，会提示你先关闭程序/停止 Runtime。
- 删除程序文件、桌面/开始菜单快捷方式、卸载登记；
- **询问是否删除用户数据目录**（默认“否”= 保留）。保留的数据可用于重装后恢复；
- 若曾在设置/首次向导中改用自定义数据目录，卸载器不会知道该自定义路径，请卸载后手动删除该目录（或保留继续使用）。

> 卸载前建议：先关闭 FCA Memory Atlas；如果本地 Runtime 仍在后台运行（默认关闭窗口不会停止它），请在应用内“设置 → Runtime → 停止 Runtime”，或重启电脑后再卸载。否则 `node\node.exe` 等文件可能因被占用而残留。

### 16.2 静默卸载

```powershell
& "$env:LOCALAPPDATA\Programs\FCA Memory Atlas\Uninstall.exe" /S
# 退出码 0 = 成功；2 = 程序正在运行，卸载中止
```

静默卸载**默认保留**用户数据目录；也**不会自动停止**本地 Runtime（卸载前请自行关闭程序/停止 Runtime，否则文件可能残留）。

### 16.3 手动清理（确定不再需要数据时）
```powershell
# 先确认路径后再删除！以下为用户数据目录（默认位置）
$data = Join-Path $env:LOCALAPPDATA 'FCA-Memory-Atlas'
Get-ChildItem $data   # 确认内容确实是你不再需要的数据
Remove-Item -LiteralPath $data -Recurse -Force
```

> 不要删除 `%LOCALAPPDATA%\FCA-Memory-Atlas` 之外的任何目录，除非你确认那是你自选的数据目录。

## 17. 排错

### 17.1 程序打不开 / 一闪而过

1. 打开桌面应用日志：`%LOCALAPPDATA%\FCA-Memory-Atlas\logs\desktop-YYYYMMDD.log`（JSONL，按时间排序）。
2. 检查安装完整性：安装目录下应存在 `FCA Memory Atlas.exe`、`resources\app\main\main.js`、`resources\app\renderer\index.html`、`runtime\bin\fca-runtime.js`、`node\node.exe`。
3. 若在“de-elevated”调试 shell / 自动化环境中启动 Electron，可能因 Chromium sandbox 与 shell 权限不匹配而失败；此类测试场景可临时加 `--no-sandbox` 参数（**普通用户从桌面/开始菜单启动不需要也不应加**）。
4. 重装覆盖（先备份数据）：安装包可覆盖安装，不会删除数据目录。

### 17.2 界面显示“Runtime 未连接 / 启动失败”

- 点击顶栏 Runtime 状态 → “重启 Runtime”。
- 检查端口是否被占用：

```powershell
Get-NetTCPConnection -LocalPort 17860 -ErrorAction SilentlyContinue
# 或改端口：设置 → Runtime 端口（保存后重启应用）
```

- 查看日志 `数据目录\logs\` 与“数据管理 → 运行日志”。
- 用 CLI 手动验证：

```powershell
$FCA = "$env:LOCALAPPDATA\Programs\FCA Memory Atlas"
& "$FCA\node\node.exe" "$FCA\runtime\bin\fca-runtime.js" status
& "$FCA\node\node.exe" "$FCA\runtime\bin\fca-runtime.js" health
```

- 若提示 API 版本不兼容：说明桌面端与 Runtime 版本不匹配，请使用同一安装包完整重装。

### 17.3 数据目录不可写 / 换目录后“数据没了”

- 数据目录需要当前用户可写；不要选 `C:\Windows`、`Program Files` 等受保护目录。
- 在“设置 → 数据目录”更改目录后必须重启应用；新目录是一个新的（可能空的）库，**旧目录数据仍在原处**。如需迁移，把旧目录内容整体复制到新目录（关闭程序后操作），或重新选择回旧目录。

### 17.4 星云卡顿 / 黑屏 / Unity 窗口无法打开

- 降低画质档位（`Q` 循环，或设置 → 外观与性能 → low/off）。
- **Unity 星云黑屏/加载失败**：确认显卡驱动正常且支持 WebGL2（远程桌面/虚拟机可能不支持）；在“设置 → 外观与性能 → 星云引擎”切到 **WebGL**（内置回退渲染器）。
- **Unity 启动失败**：星云视图状态卡会显示失败原因；详细日志见 `数据目录\logs\`（含 Unity stdout/stderr）。
- 若界面整体白屏，检查日志中 renderer 错误；可用 `Ctrl+Shift+I` 打开开发者工具查看控制台（Alpha 版本允许）。

### 17.5 杀毒软件拦截

- 安装包/`node.exe` 首次运行可能被智能拦截；若 Runtime 无法启动且日志显示 `spawn` 失败，请将安装目录加入杀毒软件信任列表后重试。

### 17.6 LLM 调用失败

- 设置 → LLM Provider → “测试连接”，确认 Base URL / 模型名 / API Key 正确、网络可达。
- 失败请求可能进入离线队列，可手动重试；LLM 失败不影响本地记忆数据。

### 17.7 提交问题需要附上的信息

1. `BUILD_INFO.json`、`install-report.ini` 内容；
2. 应用日志（`数据目录\logs\desktop-*.log`）相关时间段；
3. 界面错误提示中的 trace id（若有）；
4. Windows 版本、显卡型号、画质档位、是否远程桌面。

## 18. 键盘快捷键（Alpha 0.1 实测）

| 快捷键 | 功能 |
|---|---|
| `Ctrl+K` / `Ctrl+F` | 聚焦全局搜索 |
| `Ctrl+Z` | 撤销 |
| `Ctrl+Shift+Z` / `Ctrl+Y` | 重做 |
| `Ctrl+1` | 星云总览 |
| `Ctrl+2` | 聚类星域 |
| `Ctrl+3` | 时间线 |
| `Ctrl+4` | 关系探索 |
| `Ctrl+5` | 记忆列表 |
| `Ctrl+6` | 数据管理 |
| `Ctrl+7` | 设置 |
| `F5` | 刷新图谱 |
| `Delete` / `Backspace` | 删除当前选中记忆（软删除，可撤销） |
| `Esc` | 关闭浮层/取消 |
| `F` | 星图适应屏幕 |
| `L` | 显示/隐藏图例 |
| `Q` | 循环切换画质档位 |
| `F1` | 打开首次启动向导 |
| `Ctrl+Shift+I` | 开发者工具（Alpha 排错用） |
| `Alt+F4` | 退出 |

## 19. 已知问题与限制

见 `docs/KNOWN_ISSUES.md`。v0.3.0 重要限制摘要（含 v0.2 系列）：

- **Unity 星云**依赖可用桌面会话与 GPU/驱动（无 GPU 请用 WebGL 回退）；体积着色器最多同时渲染 8 条旋臂（超出时 HUD 提示，节点仍按正确旋臂分布）；Unity 渲染为 3 秒轮询（无 SSE）；HUD 使用系统字体。
- **安装包与 Unity exe 未签名**：Windows SmartScreen 可能提示“未知发布者”，请校验 SHA256 后运行。
- 旧版既有限制（Alpha 0.1）摘要：

- 不迁移/不导入任何旧记忆系统数据；导入仅支持 FCA 自身导出格式。
- 仅深色主题；仅 Windows x64。
- 语义检索是本地确定性向量（非模型嵌入），效果有限。
- 历史版本搜索不可用。
- 安装包未做代码签名，Windows SmartScreen 可能提示“未知发布者”；这是 Alpha 内部版本的预期现象。

## 20. 相关文档

- `docs/INSTALL_TEST.md` — 安装/启动/卸载实测记录（含证据文件与哈希）
- `docs/KNOWN_ISSUES.md` — 已知问题与限制
- `docs/UNITY_NEBULA.md` — Unity 星云渲染（数据契约/工作区旋臂/构建/集成/回退）
- `docs/ARCHITECTURE.md` / `docs/adr/` — 架构与技术决策（含 ADR-006 安装方案）
- `docs/PUBLIC_INTERFACE_FREEZE.md` — 冻结的数据模型/API/事件/渲染契约
- `docs/ENVIRONMENT_REPORT.md` — 构建与运行环境实测
- `docs/API.md` — Runtime HTTP API（供开发/集成）
- `docs/TEST_REPORT.md` — 测试与性能报告（QA 产出）
- DSH 插件：`docs/PLUGIN_INTEGRATION_TEST.md`、`docs/DSH_PLUGIN_ENVIRONMENT_REPORT.md`、`dsh_plugin/README.md`
