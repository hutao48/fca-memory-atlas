# FCA Memory Atlas 已知问题与限制（Alpha 0.1）

- 版本：Alpha 0.1.0
- 更新：2026-11-12
- 适用范围：安装版桌面软件（`FCA-Memory-Atlas-Setup-0.1.0-x64.exe`）+ 随包 FCA Local Runtime
- 来源：交付实测（`docs/INSTALL_TEST.md`、`artifacts/reports/install-*.json`）+ QA 自动化测试（`docs/TEST_REPORT.md`、`artifacts/reports/security.json` 等）。

级别说明：**高**=影响可用性/数据安全；**中**=影响部分功能或体验；**低**=边界问题；**信息**=设计限制/契约未覆盖，Alpha 0.1 接受。

> Alpha 0.1 为内部评估版本。下列问题除特别标注“已修复”外均**未修复**；使用前请阅读“规避方式”。

---

## A. 安全与健壮性（QA 实测，未修复）

### KI-SEC-01 [中] ZIP 导入无解压体积上限（压缩炸弹）

- **现象**：`POST /api/v1/import` 处理 ZIP 时，Runtime 会完整解压。实测一个约 70 KB 的合法 ZIP（store/deflate、manifest 合法）可解压出 64 MB（压缩比 ~1000:1），请求 559 ms 完成且服务仍健康。
- **影响**：持 token 的本地调用方（或误操作）可用 1 MB 上传触发 GB 级解压，造成内存/CPU 峰值，可能拖慢桌面端。
- **前提**：需要 `127.0.0.1` + Bearer token（本地信任边界内）。
- **规避**：只导入自己导出的可信文件；不要导入来源不明的 ZIP。桌面端导入前确认文件来源。
- **建议修复**：`readZip` 增加单条目/总解压字节上限（如 ≤256 MB）、条目数上限、流式 inflate 校验或导入前压缩比检查。

### KI-SEC-02 [低] 导出/导入 `path` 未限制在导出目录内

- **现象**：`POST /api/v1/export` 的 `path` 支持相对路径 `..\x.json` 与绝对路径，可写到 `FCA_HOME\exports` 之外；`import` 同理可读取任意 FCA 格式文件。
- **影响**：持 token 的本地调用方可在当前用户权限范围内写任意位置。属本地可信 API 的信任边界内问题，故评级低。
- **规避**：桌面端导出/导入使用系统文件对话框（用户显式选择路径）；不调用来源不明的脚本。
- **建议修复**：路径白名单（限制在 `exports/` 或 `tmp/` 内）、拒绝绝对路径与 `..`，或在文档/契约中明确“本地可信 API”。

### KI-SEC-03 [信息] CORS 允许任意 Origin

- **现象**：Runtime 响应包含 `Access-Control-Allow-Origin: *`（含 `Authorization` 允许头）。
- **影响**：若恶意网页已获得 token（token 在本地文件，需先能读本地文件），可跨站调用。实际风险低。
- **建议修复**：Origin 白名单，或仅放行 `file://`/空 Origin。

### KI-SEC-04 [信息] 未实现限流 `RATE_LIMITED(429)`

- **现象**：契约 §7 定义 `RATE_LIMITED` 错误码，但 Runtime 没有速率限制。
- **影响**：仅回环 + token 模型下影响低；异常客户端可能造成忙等。
- **建议修复**：对重请求端点（import/export/backup/search）加基础限流。

### KI-SEC-05 [低] `X-FCA-Client` 不是安全边界

- **现象**：`X-FCA-Client` 只是客户端标识，`shutdown` 的白名单（cli/desktop/test）可被任意本地调用方自称。
- **影响**：本地进程可冒充客户端关闭 Runtime。属信任边界内问题（runtime-core 已在代码注释/报告中注明）。
- **规避**：不要把 Runtime 端口暴露到公网；不要使用 `FCA_ALLOW_REMOTE=1`。

### KI-SEC-06 [信息] 软删除记忆的 `GET /memory/{id}` 仍返回 200

- **现象**：已软删除记忆（`deleted_at` 非空）仍可被按 ID 读取，供回收站详情使用。
- **影响**：契约未明确该语义，属“契约未覆盖项”；桌面端回收站依赖该行为。
- **建议**：契约下一版明确“软删除可见性”语义。

### KI-SEC-07 [信息] 标签/人物筛选字段语义

- **现象**：`GET /api/v1/tags?q=` 按标签名前缀/包含匹配；`GET /api/v1/memories?participant=` 按**实体 ID**（不是人物姓名）；契约未细化。
- **影响**：集成方（Desktop/插件/第三方）需按 ID 传参，按姓名传会搜不到。
- **建议**：契约下一版补充字段语义说明；集成方以 `docs/API.md` §3/§4 为准。

---

## B. 功能与体验（未修复）

### KI-FUNC-01 [中] 自定义数据目录时，菜单“打开数据目录/打开日志目录”打开的是默认目录

- **现象**：“文件 → 打开数据目录 / 打开日志目录”固定使用默认路径 `%LOCALAPPDATA%\FCA-Memory-Atlas`，不使用“设置 → 数据目录”里自定义的路径；设置页里的“打开数据目录/日志目录/配置目录”按钮是正确的。
- **影响**：改了数据目录的用户从菜单打开会看到空目录/旧目录，误以为数据丢失。
- **规避**：使用“设置 → 数据目录与 Runtime”卡片里的“打开数据目录 / 打开日志目录”；数据仍在自定义路径下，未丢失。

### KI-FUNC-02 [中] 修改数据目录后不会迁移数据

- **现象**：设置中修改数据目录并重启应用后，应用指向新目录（可能是空库）；旧目录数据原地保留，不做迁移。
- **影响**：用户可能误以为“数据没了”。
- **规避**：关闭程序后把旧数据目录整体复制到新路径，或在向导/设置中改回旧路径。操作前先备份。

### KI-FUNC-03 [低] 卸载器只提示默认数据目录；自定义数据目录需手动清理

- **现象**：卸载时“是否删除本地记忆数据”针对默认目录 `%LOCALAPPDATA%\FCA-Memory-Atlas`；若用户曾改到自定义目录，卸载器不知道、也不会删除。
- **规避**：卸载后按 `docs/USER_MANUAL.md` §16.2 手动清理你自选的数据目录。

### KI-FUNC-04 [低] 安装包未做代码签名

- **现象**：Windows SmartScreen 可能提示“未知发布者/已阻止”；安装包与 exe 无数字签名。
- **影响**：首次安装需要人工点击“仍要运行”。这是 Alpha 内部版本预期。
- **规避**：从可信渠道获取安装包，按 §3.3 校验 SHA256。

### KI-FUNC-05 [低] 桌面程序图标/文件属性为 Electron 默认

- **现象**：`FCA Memory Atlas.exe` 的图标与“属性 → 详细信息”中的部分字段仍是 Electron 默认（构建环境无 rcedit/签名工具）；应用窗口与开始菜单名称正确。
- **影响**：观感问题，不影响功能。
- **规避**：无（后续版本用 rcedit 写入产品图标/版本资源）。

### KI-FUNC-06 [低] 仅简体中文 UI、仅深色主题、仅 Windows x64

- **现象**：界面文案为简体中文；Alpha 0.1 只有“深空暗色”主题；无 macOS/Linux 安装包。
- **影响**：非目标平台/语言用户不可用。

### KI-FUNC-07 [低] 无自动更新、无崩溃上报

- **现象**：Alpha 0.1 不支持自动更新/增量升级；错误只写本地日志，不上传。
- **规避**：升级时使用新安装包覆盖安装（先备份数据）。排错时按 `docs/USER_MANUAL.md` §17.7 提供本地日志。

### KI-FUNC-08 [低] 记忆列表“按条件导出”范围受当前桌面筛选影响

- **现象**：数据管理 → 导出选择“按条件导出（当前桌面筛选 + 时间范围）”时，实际范围与当前视图筛选/时间条件相关；切换视图后范围可能变化。
- **规避**：需要全量时选择“全部记忆与关系”；导出前确认界面提示的范围。

### KI-FUNC-09 [低] 语义检索为本地确定性向量，效果有限

- **现象**：`semantic` 模式使用本地 `local-hash-v1` 向量（不依赖外部模型），同义/近义召回能力弱于真实嵌入模型。
- **影响**：语义搜索可能漏召回；全文/混合模式可用。
- **建议**：后续版本接入可替换的嵌入 Provider。

### KI-FUNC-10 [低] 历史版本搜索不可用

- **现象**：搜索视图的“历史版本搜索”端点 Runtime 未提供，界面明确标注不可用（不伪造结果）。
- **规避**：在记忆编辑器 → 版本历史中查看历史版本。

### KI-FUNC-11 [信息] 首次启动为全新空库，不导入/不迁移旧记忆

- **现象**：按设计，初始化只创建空库；导入仅支持 FCA 自身导出的 JSON/JSONL/ZIP。
- **影响**：旧记忆系统数据无法直接导入（产品约束，不是缺陷）。详见 `docs/ENVIRONMENT_REPORT.md` §5。

---

## C. Runtime / 数据（限制与边界）

### KI-RT-01 [信息] 软删除/回收站语义

- 软删除记忆仍保留在数据库中（带 `deleted_at`），列表视图默认过滤；“永久删除”才会真正删除。回收站是数据安全设计的一部分。

### KI-RT-02 [信息] 默认退出策略：关闭桌面不关闭 Runtime

- 默认 `closeRuntimeOnExit=false`：关闭桌面后，由它拉起的 Runtime 可能继续运行（供 DSH 插件/其它客户端继续使用）；重启电脑或显式停止后结束。
- 影响：卸载/升级安装时安装器会先尝试优雅停止 Runtime。
- 如需退出即停：设置文件 `desktop-settings.json` 中 `closeRuntimeOnExit: true`（高级选项，界面暂未暴露）。

### KI-RT-03 [信息] 数据目录建议放在本地 NTFS 盘

- SQLite 在网络共享盘/同步盘（OneDrive 等）上可能出现锁与损坏风险；不要把数据目录放到网络盘或云同步目录。

### KI-RT-04 [信息] LLM 未配置时 Agent 相关能力不可用

- 本地记忆读写、编辑、检索、关系、时间线、备份不依赖 LLM；但依赖 LLM 的 Agent 对话能力需要先在“设置 → LLM Provider”配置可用 Provider（Key 本地 AES-256-GCM 加密存储，日志/响应掩码）。
- LLM 调用失败不会写坏记忆数据；失败请求可能进入离线队列（可重试）。

### KI-RT-05 [信息] Beta 前的单实例策略

- 桌面端为单实例：重复启动会聚焦已有窗口而非开新窗口；这是预期行为。

### KI-RT-06 [信息] 卸载器/升级安装不会自动停止 Runtime（设计行为，不是缺陷）

- **行为**：`Uninstall.exe` 与升级安装**不会执行** `fca-runtime stop`。检测到默认数据目录存在 `runtime.pid` 时，非静默卸载会提示“请先关闭 FCA Memory Atlas / 停止 Runtime”，静默卸载只写日志并继续。
- **原因**：安装包编译期只知道默认数据目录；用户可能改用自定义数据目录，或本机存在其它环境的 Runtime（例如 DSH 插件自动拉起的实例）。自动 stop 会误停不属于本安装的 Runtime（Alpha 0.1 开发期实际发生过一次误停真实 17860 实例，数据无损但中断链路）。
- **用户操作**：卸载/升级前先关闭程序；若 Runtime 在后台运行，在应用内“设置 → Runtime → 停止 Runtime”或重启电脑。否则 `node\node.exe` 可能因占用而残留，卸载后手动删除 `<安装目录>\node` 即可。
- **历史**：早期构建（`built_at=2026-11-12T08:24:59Z` 的中间包）存在“卸载器固定 stop 默认数据目录 Runtime”的问题，已在后续构建移除；最终交付包为修正版。

---

## D. 构建与测试环境（仅影响开发/构建，不影响已安装用户）

### KI-ENV-01 [信息] makensis 3.04 在系统 %TEMP% 下创建 >32MB mmap 失败（本机环境限制）

- **现象**：`makensis.exe` 在默认 `C:\Users\<user>\AppData\Local\Temp` 上编译大文件时立即失败：
  `Internal compiler error #12345: error creating mmap the size of N`（N > 约 32MB；最小 16MB 文件即可复现）。
  将 TEMP/TMP 指向 D: 盘目录后同一脚本编译成功。
- **根因**：本机 C: 盘 %TEMP% 上的大内存映射创建受限（与 payload/脚本逻辑无关；最小用例可复现；DSH 工具 shell 下 makensis 进程本身运行在 Low IL 沙箱，见 KI-ENV-04，属同一限制体系）。
- **处理**：`installer/build.js` 已固定把 makensis 的 TEMP/TMP 指向 `installer\.staging\makensis-temp`（项目所在 D: 盘），编译后自动清理。该限制记录于 `docs/ENVIRONMENT_REPORT.md` §4.1。
- **影响范围**：仅构建机；用户安装不受影响（安装日志继续写 `%TEMP%\fca-install.log`，文件小，正常）。

### KI-ENV-02 [信息] 本机 DSH shell 中启动 Electron 需清理环境变量并加 `--no-sandbox`

- **现象**：DSH 会话 shell 继承 `ELECTRON_RUN_AS_NODE=1`，且 shell 处于 de-elevated 环境；直接启动 Electron 会异常或报沙箱错误。
- **处理**：自动化测试脚本会 `Remove-Item Env:ELECTRON_RUN_AS_NODE` 并带 `--no-sandbox` 启动（仅测试用）。
- **用户正常使用（Explorer/快捷方式启动）不需要也不应加 `--no-sandbox`。**

### KI-ENV-03 [信息] 旧 DSH 运行时 Node 路径已失效

- 环境报告早期引用的 `C:\\Users\\<user>\.dsh\dsh-runtimes\...\node.exe` 在 DSH NEXT 升级后不存在；当前实际 Node 路径见 `docs/ENVIRONMENT_REPORT.md` §2。`installer/build.js` 已改用 `vendor\node\node.exe` 优先、DSH NEXT 新路径兜底。

### KI-ENV-04 [信息] DSH 工具 shell 的子进程以 Low IL 运行，安装器测试会假失败（测试环境限制）

- **现象**（最小实验复现）：从 DSH 工具 shell（`pwsh`/`cmd`）派生的 node.exe、makensis.exe、NSIS `Setup.exe` 等非解释器进程以 **Low IL + `CodexSandboxUsers` 限制令牌**运行：
  - `$TEMP` 被重定向为 `%TEMP%\Low`（安装日志因此写到 `...\Temp\Low\fca-install.log`）；
  - 写 HKCU 卸载注册表项、桌面/开始菜单快捷方式被**静默拒绝**；
  - 写工作区盘（D:\FCA）正常 → 程序文件能解压，造成“安装成功但没有快捷方式/卸载项”的假失败。
- **影响**：从 DSH shell 直接运行的安装/卸载测试不能作为安装器缺陷证据；真实用户从 Explorer 双击是 Medium IL，不受影响。
- **处理**：
  - 安装/卸载实测使用 `installer/run-install-test.ps1`：通过 `Invoke-CimMethod Win32_Process.Create` 以正常 Medium IL 启动 `install-test.ps1`（WmiPrvSE 创建进程，绕过工具 shell 的限制令牌）。
  - 最终验收必须用真实用户路径（双击安装包）或上述 WMI 启动器；**不要在 DSH pwsh 里直接 `Start-Process` 安装包**。
  - 本限制也解释/关联 KI-ENV-01（makensis 在 C: %TEMP% 大 mmap 失败）。
- **取证**：`Get-ChildItem Env:` 显示 `TEMP` 正常，但子进程 `whoami /groups` 显示 `Mandatory Label\Low Mandatory Level`；`%TEMP%\Low` 目录 ACL 含 `CodexSandboxUsers`。

---

## E. 测试发现的缺陷状态（QA 跟进）

| 编号 | 级别 | 现象 | 状态 |
|---|---|---|---|
| BUG-1 | 高 | `POST /api/v1/llm/queue/{id}/retry` 返回 500（`queue.getRow` 缺失） | **已修复**（runtime-core；QA 真实 HTTP 复测 202/成功路径通过） |
| BUG-2 | 低 | `import {"path":123}` 返回 500 | **已修复**为 `400 BAD_REQUEST`（QA 复测通过） |
| BUG-3 | 低-中 | 导入损坏 ZIP 返回 500 `INTERNAL`，应为 `422 IMPORT_FAILED` | **已修复**（runtime-core：改为 422 `IMPORT_FAILED`；QA 复测通过，`artifacts/reports/security.json`） |
| INST-2 | 中 | 卸载器/升级安装固定执行 `fca-runtime stop --fca-home=%LOCALAPPDATA%\FCA-Memory-Atlas`，会误停用户真实 Runtime/其它实例（QA 实测误停 17860 真实实例，数据无损） | **已修复**（最终包移除自动 stop，改为提示用户自行停止；见 KI-RT-06） |

缺陷详细证据见 `docs/TEST_REPORT.md` “发现缺陷”与“已知限制”章节、`artifacts/reports/security.json`。

---

## F. 契约未覆盖项（Alpha 0.1 记录，供下一版）

1. 软删除记忆 `GET /memory/{id}` 的可见性语义（当前返回 200 + `deleted_at`）。
2. `tags?q=` 与 `memories?participant=` 的字段语义（当前分别为标签名匹配、实体 ID）。
3. `X-FCA-Client` 的定位：客户端标识，不是鉴权/安全边界。
4. 导入 ZIP 的资源上限（见 KI-SEC-01）。

---

## G. DSH 插件 · 自动记忆（v0.1.4 新增能力的边界）

| 编号 | 级别 | 内容 | 说明/规避 |
|---|---|---|---|
| KI-PLUGIN-01 | 信息 | 自动记忆保存的是**用户消息原文级**记录，不做 LLM 摘要或事实抽取 | 标题取消息首行（≤80 字），正文截断到 `autoMemoryMaxChars`（默认 2000 字）；如需更精炼记忆，可由 Agent 显式调用 `fca_memory_store` |
| KI-PLUGIN-02 | 信息 | 默认 `autoMemory: user-messages` 只采集**真实用户消息**（`source.kind==="user"`） | Host 注入的 runtime-context / skill-catalog / time-context / 后台任务通知 / Agent 消息转发 / 审批通知不会入库；无需在每个会话里下"记住"指令，也不需要逐会话授权 |
| KI-PLUGIN-03 | 信息 | 自动记忆只**新增**，不改写/删除已有记忆 | 修正/删除请在桌面软件执行，或调用 Runtime API 的 PATCH/DELETE；避免自动流程误覆盖 |
| KI-PLUGIN-04 | 信息 | 自动记忆有去重与限流：同一 `session:seq:role` 只记一次，正文哈希 1 小时内只记一次；每小时上限 `autoMemoryMaxPerHour`（默认 120） | 超限时 `fca_status.auto_memory.counters.skippedRate` 增加；不会无限写入 |
| KI-PLUGIN-05 | 信息 | 消息中的敏感内容会先按内置/扩展规则脱敏再写入；数据只写入本机 `127.0.0.1` 的 FCA Runtime | 不希望自动保存时把 `autoMemory` 设为 `off` 并更新插件配置 |
| KI-PLUGIN-06 | 低 | 从解包目录安装插件时，`autoStartRuntime` 依赖插件包相邻的 `../runtime/bin/fca-runtime.js` | 若目录不相邻，请设置 `runtimeScriptPath`（本机验收用 junction 使默认路径可用） |

---

## H. 如何反馈问题

请附：`BUILD_INFO.json`、`install-report.ini`、`数据目录\logs\desktop-*.log` 相关时间段、界面 trace id、Windows 版本与显卡/画质设置。反馈到项目 Lead（Alpha 阶段无公开 Issue 系统）。
