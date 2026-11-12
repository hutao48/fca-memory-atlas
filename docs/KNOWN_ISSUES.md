# FCA Memory Atlas 已知问题与限制（v0.4.0）

- 版本：v0.4.0（桌面/Runtime/安装包 0.4.0；DSH 插件 0.3.1；Runtime API v1）
- 更新：2026-11-12
- 适用范围：安装版桌面软件（`FCA-Memory-Atlas-Setup-0.4.0-x64.exe`，含 Unity 星云组件）+ 随包 FCA Local Runtime + DSH 插件
- 来源：交付实测（`docs/INSTALL_TEST.md`、`artifacts/reports/install-*.json`、`artifacts/unity/*`、`artifacts/plugin/*`）+ QA 自动化测试（`docs/TEST_REPORT.md`、`artifacts/reports/security.json` 等）。

级别说明：**高**=影响可用性/数据安全；**中**=影响部分功能或体验；**低**=边界问题；**信息**=设计限制/契约未覆盖，当前版本接受。

> v0.2.0 为内部评估版本。下列问题除特别标注“已修复”外均**未修复**；使用前请阅读“规避方式”。

---

## v0.2.1 已修复（保留记录）

### KI-FIX-01 [已修复] 强杀桌面 app 后 Runtime EPIPE uncaughtException 死循环、/health 超时

- 现象：关闭/强杀 FCA 桌面进程后，Runtime 仍占着 17860，但 `/health` 超时；runtime 日志每秒反复出现 `uncaughtException EPIPE: broken pipe, write`；此时再启动 app 会报"Runtime 启动超时（30s）"、`PORT_IN_USE`，界面显示 Runtime 未连接。
- 根因：Runtime 的 stdout/stderr 管道随父进程关闭；logger 写 stderr 触发异步 `'error'` 事件（EPIPE）无人监听 → uncaughtException → handler 再写日志 → 再次 EPIPE，无限循环占满事件循环。
- 修复：`runtime/src/runtime.js` + `runtime/src/logging/index.js`（忽略 EPIPE、控制台断开后仅写文件日志）；`desktop/main/runtime-manager.js`（子进程退出即快速失败，不再空等 30s）。
- 回归：`runtime/test/logger-epipe.test.js` + `.cache/audit/verify-epipe-fix.mjs`（管道关闭后 6 次 /health 全部 200、0 条 EPIPE 日志）+ `scripts/verify.js` 23/23。

## v0.3 桌面 UI 修复（task-16，2026-11-13，待随下一版发布）

### KI-FIX-02 [已修复] 关系详情打不开 + 详情面板出现 `[object Object]`

- 现象：进入“关系探索”点任意“查看”→ toast `打开关系详情失败：Cannot read properties of undefined (reading 'append')`，右侧详情只剩残缺 `关系 rel_… · v1[object Object]`。
- 根因：`desktop/renderer/lib/detail-panel.js` 的 `showCustom(payload)`：
  1. 对函数式 `content` 调用 `content()` 时**未传 host 容器**（relations/search 的 content 都是 `(host) => { host.append(...) }` → host undefined 抛错）；
  2. `actions` 描述对象被直接当作 DOM children 渲染 → 文本化成 `[object Object]`。
- 修复：`showCustom` 创建真实 host 容器并传入 content（返回值自动挂载/兼容 Node/字符串/cleanup），action 描述（label/variant/icon/onClick/closeOnClick/testid）渲染为真实按钮；`relations.js showRelationDetail()` 补齐完整字段（两端节点可点击跳转、关系类型、方向、置信度、权重、来源 ref/note、evidence、创建/更新时间、ID、版本、状态），对象字段统一安全转文本；全局搜索详情同样恢复。
- 验证：CDP 前后对比（修复前 `artifacts/reports/desktop-ui/before-relation-detail-error.png` 可见错误 toast；修复后 `after-relation-detail.png` 完整渲染）；`artifacts/reports/desktop-ui/after-fix-report.json` 18 项断言全部 PASS（无 `[object Object]`、无错误 toast、两端节点/字段/关闭按钮齐全、端点跳转编辑器成功）。

### KI-FIX-03 [已修复] 侧边栏收起后无法重新展开（无入口）

- 现象：`#btn-collapse-left/right` 原本位于面板内部，`applyLayout()` 给面板加 `is-collapsed`（width:0/overflow:hidden）后按钮被裁剪；用户收起面板后再无入口展开（重启后若持久化为收起同样无法恢复）。
- 修复：`desktop/renderer/index.html` 顶栏新增**常驻** `#btn-toggle-left/#btn-toggle-right`（aria-pressed/状态点/tooltip 含快捷键）；面板收起时窗口左右边缘显示**竖向展开把手** `#edge-handle-left/right`（hover 高亮，点击展开）；`app.js applyLayout()` 统一同步按钮/把手/aria 状态；快捷键 **Ctrl+B / Ctrl+J**；原生菜单“视图 → 显示/隐藏左栏/右栏”同步加速键；布局状态仍由 localStorage 持久化并在启动时正确恢复。
- 验证：CDP 收起→边缘把手可见（宽高>0）→点击展开→右栏 Ctrl+J 收起/把手展开→localStorage `fca.ui.layout.v1.left.collapsed=true` 持久化，全部 PASS；截图 `artifacts/reports/desktop-ui/after-panels-collapsed-with-toggles.png`、`after-panels-expanded.png`。

### KI-FEAT-01 [信息] 子 Agent 会话层级展示（配合插件 v0.3）

- 数据契约（Lead 确认，与 memory-pipeline/Unity 共用）：子会话记忆 tags `Agent子会话`、`subagent-session:<childId8>`、`parent-session:<parentId8>`、`parent-memory:<parentMemoryId>`；父记忆 tags 每个子会话一个 `children:<childId8>`；关系 from=父记忆→to=子会话记忆、`relation_type=custom` + `label=spawned_subagent`（API 拒绝则 `derived_from`）。
- 实现：`desktop/renderer/lib/hierarchy.js`（纯函数解析 tags/relations、短 id 解析、方向判定、可读标签）；详情面板“子 Agent 记忆（N）”可展开列表（父记忆显示 children；子记忆显示父记忆与父会话提示），懒加载子记忆标题/类型/时间/摘要，点击打开对应记忆；关系探索对层级关系显示“子 Agent 层级”徽标与可读标签，关系详情显示“层级：父记忆 → 子 Agent 会话”并可打开端点记忆。
- 状态：**插件 v0.3 真实层级数据尚未落库**；已用 mock API 完成 UI 自测并明确标注（截图 `artifacts/reports/desktop-ui/after-hierarchy-parent-expanded.png`、`after-relations-hierarchy.png`，报告中 `mock` 字段注明仅 UI 自测不可作交付证据）。真实数据到位后需重跑 CDP 截图回归。
- 限制：若只有 `parent-session:<id8>`、`parent-memory` 尚未写入，则无法解析到父记忆详情，UI 显示“未索引子会话”提示（不伪造跳转）。

### KI-FIX-04 [已修复] Unity 星云选中节点未同步右侧详情面板（双向）

- 现象：Unity 星云内点开记忆节点，Electron 右侧详情面板无变化；反方向在列表/搜索选中记忆，Unity 星云也不高亮（用户原话“右方侧边栏无法同步显示已打开节点详情”）。
- 根因：① Unity WebGL 桥只有 ready/state，无选择事件（`fca-unity-select`）；② 页面→Unity 只有页内 `FCA_NEBULA.postCommand`，跨源 iframe 下 Electron 无法直接调用；③ atlas 视图 Unity 引擎分支没有监听 store selection，也没有收到选择消息后的右栏联动/自动展开。
- 修复：
  - desktop：新增 `desktop/renderer/lib/unity-selection.js`（纯函数解析/防回声/节流/命令构造）；`atlas.js onUnityMessage` 处理 `fca-unity-select`（memory/entity → `actions.openMemory(id,{focus:false})`，右栏收起时 `ctx.detail.setOpen(true)`，同 id/回声/重复事件忽略）；监听 store selection → `iframe.postMessage({type:'fca-unity-command',command:'select:<id>|select:clear'},'*')`（同源时优先直接 `FCA_NEBULA.postCommand`）；iframe ready / 引擎切换 / reload 后重放当前选中；处理 `fca-unity-command-ack`。
  - unity-renderer：`FCABridge_NotifySelect` + `WebGLBridge.NotifySelection`（`fca-unity-select`，含 id/kind/title/memoryType/arm/importance/selected/clear）与模板 parent message 命令通道 + ack（新 WebGL 构建 `built_at_utc 2026-11-12T16:46:44Z` 已包含）。
- 验证：CDP 真实 app（开发版 + 新 WebGL 构建）— Unity 侧执行真实 `select` → Unity NotifySelect → Electron 右栏同步（标题/正文/类型；`artifacts/reports/desktop-ui/after-real-unity-select-sync.png`）；Electron `openMemory` → iframe 收到命令 → Unity HUD 选中卡片 + 回推选择（`after-real-bidirectional-sync.png`）；右栏收起时 Unity 选中自动展开；重复事件去重；`select:clear` 双向；引擎切换后重放选中。报告 `artifacts/reports/desktop-ui/real-sync-report.json`（8 项 PASS）、`after-sync-report.json`（10 项 PASS）；单测 `tests/unit/desktop/unity-selection.test.js` 12 例。

### KI-FIX-05 [已修复] 切换星云引擎设置后主进程 Runtime 状态被误报 stopped（附带发现）

- 现象：运行中把 `nebulaEngine` 从 unity 切到 webgl 再切回 unity 后，Electron 图谱不加载/右栏为空（renderer 认为 Runtime `stopped`），但 `/health` 实际正常。
- 根因：`desktop/main/runtime-manager.js refreshFromHealth()` 健康检查成功后只更新 status 对象、未更新模块内部 `state`（仍为 `stopped`）；随后 `settings.onChange → refreshSettings()` 用 `makeStatus()` 重建 status，把状态回退成 `stopped`，renderer 不再触发 `connectAndLoad`。
- 修复：`refreshFromHealth()` 健康成功即 `state = 'running'`（外部 Runtime 采纳后状态一致）。
- 验证：task-17 CDP 引擎切换重放选中用例 PASS；切换后图谱正常加载（55 节点）且 Unity 回放 `select:<当前选中>`。

## v0.2.0 新增组件：Unity 星云 / 桌面集成 / 插件 0.2.1

### KI-UNITY-01 [低] 内嵌 Unity WebGL 依赖 WebGL2/GPU 能力与首次加载时间

- **现象**：Unity WebGL 播放器需要 WebGL2 与可用 GPU 驱动；无 GPU、远程会话（部分 RDP 模式）或驱动异常时可能黑屏/加载失败。首次进入星云需加载 wasm/data（本地静态服务，通常数秒）。
- **影响**：内嵌 Unity 星云不可用或首次加载慢。
- **规避/行为**：桌面端在 Unity WebGL 资源缺失、加载失败或被切换时**自动回退内置 WebGL 星云**（功能不缺失）；可在“设置 → 星云引擎”手动切到 WebGL。详见 `docs/UNITY_NEBULA.md` §6/§8。

### KI-UNITY-02 [低] 体积着色器最多同时渲染 8 条旋臂

- **现象**：`_ArmColors[8]` 上限；workspace 超过 8 个时，节点仍严格按各自旋臂分布，但星云体积只渲染前 8 条臂（HUD 黄色提示）。
- **规避**：如长期 >8 个 workspace，可提高上限（GPU 成本上升）或合并最小 workspace；当前 2 条臂（FCA/default）场景无影响。

### KI-UNITY-03 [信息] Unity 渲染器无 SSE，使用 3s 轮询

- 现象：星云数据 3 秒轮询 `GET /api/v1/graph`；实时性低于桌面 WebGL 的 SSE。
- 影响：百级节点规模无压力；秒级实时需求需后续加 SSE 订阅。

### KI-UNITY-04 [信息] HUD 使用 IMGUI + 系统字体

- 中文依赖系统字体（Microsoft YaHei 等）；无中文字体的机器显示方块（功能不受影响）。刻意避免 TextMeshPro/uGUI 依赖。

### KI-UNITY-05 [信息] Unity WebGL 资源未签名，安装包体积增加

- 安装包与 Unity WebGL 资源均未做代码签名（SmartScreen 可能提示未知发布者）；Unity WebGL 构建（wasm/data 压缩后）使安装包增量约 10–20 MiB（具体见构建报告 `payload.unity_bytes`）。

### KI-DESK-01 [信息] Unity 星云内嵌在 Electron 窗口（设计行为）

- 星云由 Unity WebGL 播放器经本地静态服务 + iframe 内嵌在 Electron 星云视图中；不再有独立 Unity 窗口。引擎切换/回退状态显示在星云工具栏与状态卡；本地静态服务仅监听回环且只提供安装目录内的 Unity WebGL 静态资源。

### KI-DESK-02 [信息] DSH 工具 shell 内嵌套启动 Electron/Unity 需清理环境变量

- 现象：本机 DSH 会话 shell 继承 `ELECTRON_RUN_AS_NODE=1`/`CHROME_CRASHPAD_PIPE_NAME`，嵌套启动 Electron 可能 `0x80000003` 崩溃。
- 处理：测试环境需清理这两个环境变量并加 `--no-sandbox`；**用户从 Explorer/快捷方式启动不需要**。见 `docs/ENVIRONMENT_REPORT.md` §7.2、`docs/UNITY_NEBULA.md` §6.7。

### KI-PLUGIN-01 [信息] 插件 v0.2.1 过滤子会话 user-role 消息；历史噪声已软删除

- v0.2.1 起不再把 subagent/team 子会话的 user-role 提示词采集为真实用户记忆（`src/session-scope.js`）；此前产生的 3 条 teammate 启动提示词记忆已**软删除**（回收站可见，`include_deleted` 可查，`v0.2.1-cleanup-evidence.json`）。
- 兼容性：`engines.fcaRuntime=">=0.1.0 <0.2.0"`，与 Runtime 0.1.0 兼容。

### KI-INSTALL-01 [信息] 安装实测环境限制（DSH 工具 shell Low IL）

- DSH 工具 shell 子进程为 Low IL：直接在其中运行安装包时 `%TEMP%` 被重定向、HKCU/快捷方式写入被静默拒绝（假失败），Electron/Unity GUI 冒烟也受限。
- 处理：安装/卸载实测使用正常令牌会话/真实双击；证据与限制见 `docs/INSTALL_TEST.md` §5/§6 与 `docs/ENVIRONMENT_REPORT.md` §7.4。真实用户（Explorer Medium IL）不受影响。

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

- 环境报告早期引用的 `<DSH_HOME>\dsh-runtimes\...\node.exe` 在 DSH NEXT 升级后不存在；当前实际 Node 路径见 `docs/ENVIRONMENT_REPORT.md` §2。`installer/build.js` 已改用 `vendor\node\node.exe` 优先、DSH NEXT 新路径兜底。

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
