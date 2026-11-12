# FCA Memory Atlas — Renderer 模块契约（v1.0，Alpha 0.1）

> **文档地位**：本文件由 Desktop Shell（desktop-shell）定义，是 Desktop Editor 任务组与 Desktop Shell 之间的**模块级协作契约**。
> 上游契约只有一个：`docs/PUBLIC_INTERFACE_FREEZE.md`（API / 数据 / 渲染 / 事件，冻结，只能由 Lead 修改）。
> 本文件只约束 **renderer 内部模块边界**；与上游契约冲突时以上游契约优先。
> 变更规则：**只允许向后兼容新增**（新增可选导出/可选字段/新事件名/新 ctx 能力）。破坏性变更必须经 Lead 批准并更新本文件版本号。
> 模块契约版本：`1.0`；应用版本：`0.1.0`；对应 API：`/api/v1`。

---

## 0. 技术栈与硬约束（不可违反）

| 项 | 规定 |
|---|---|
| 运行环境 | Electron 38（Windows x64），渲染进程为 Chromium |
| 主进程 | CommonJS（`desktop/package.json` **不得**设置 `"type": "module"`） |
| 渲染进程 | 原生 ESM，`<script type="module" src="./app.js">`，**零构建步骤** |
| 前端框架 | **零框架依赖**（不引入 React/Vue/构建工具）；允许自写轻量响应式 store/组件 |
| 网络访问 | 渲染进程**不直接 fetch Runtime**；通过 `window.fca.net`（主进程 IPC）访问 `http://127.0.0.1:<port>`，避免 CORS 并让 token 只留在主进程 |
| 安全 | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、preload 只暴露白名单；renderer 不读取文件系统 |
| 持久化 | renderer 侧只允许 `localStorage`（UI 偏好）；业务数据一律走 Runtime API |
| 禁止 | 伪造运行数据、硬编码假记忆、用设计稿/合成图替代真实截图、修改 `docs/PUBLIC_INTERFACE_FREEZE.md` |

**本机环境坑**：所有 shell 默认带 `ELECTRON_RUN_AS_NODE=1`，启动 Electron 前必须 `Remove-Item Env:ELECTRON_RUN_AS_NODE`，否则 `electron.exe` 只当 Node 运行。

---

## 1. 目录、文件所有权与启动

```
desktop/
├─ package.json                     # Shell 组（@fca/desktop, main: main/main.js）
├─ main/                            # Shell 组（主进程）
│  ├─ main.js                       # 应用入口：单实例/窗口/菜单/IPC/崩溃处理
│  ├─ preload.js                    # contextBridge 白名单（window.fca）
│  ├─ capture.js                    # 截图入口（Electron 入口，非生产窗口逻辑）
│  ├─ runtime-manager.js            # Runtime 生命周期状态机
│  ├─ net-client.js                 # 主进程 HTTP/SSE 客户端（Bearer 注入）
│  ├─ settings.js / paths.js / logger.js / window-state.js / menu.js / ipc.js
├─ renderer/
│  ├─ index.html                    # Shell 组（唯一 HTML 入口，含 CSP）
│  ├─ app.js                        # Shell 组（引导/路由/三栏外壳/快捷键）
│  ├─ styles/                       # Shell 组（tokens/base/layout/components/atlas/...）
│  ├─ lib/                          # Shell 组（api/state/events/actions/router/format/contracts.md）
│  │  └─ contracts.md               # 本文件
│  ├─ ui/                           # Shell 组（基础组件库，见 §6）
│  ├─ views/atlas.js                # Shell 组（星云画布页，唯一由 Shell 实现的业务视图）
│  ├─ views/{editor,timeline,search,list,relations,data,settings,onboarding}.js
│  │                                # ← Desktop Editor 任务组实现（本 Shell 只提供路由契约 + 占位骨架）
│  └─ nebula/**                     # ← Nebula 任务组实现（WebGL2 渲染器，见 §7）
```

**启动方式（真实命令）**：

```powershell
# 开发启动（Windows PowerShell，必须清除 ELECTRON_RUN_AS_NODE）
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& 'D:\FCA\FCA-Memory-Atlas\.cache\electron-dist\electron.exe' 'D:\FCA\FCA-Memory-Atlas\desktop'

# 截图（产出 artifacts/screenshots/desktop-*.png）
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& 'D:\FCA\FCA-Memory-Atlas\.cache\electron-dist\electron.exe' 'D:\FCA\FCA-Memory-Atlas\desktop\main\capture.js' `
  --view=atlas --scenario=demo --out=artifacts/screenshots/desktop-atlas-demo.png --size=1600x1000
```

`package.json` 里同样提供 `npm start` / `npm run capture` 脚本（脚本内部同样清空 `ELECTRON_RUN_AS_NODE`）。

---

## 2. 视图注册契约（Desktop Editor 必读）

### 2.1 视图槽位

Shell 在 `desktop/renderer/views/` 下按**固定文件名**发现视图，无需任何注册代码：

| 路由 id | 文件（Editor 组实现） | 说明 |
|---|---|---|
| `atlas` | `views/atlas.js`（**Shell 已实现**，Editor 不要改） | 星云画布总览/聚类 |
| `timeline` | `views/timeline.js` | 时间线 |
| `relations` | `views/relations.js` | 关系探索 |
| `list` | `views/list.js` | 记忆列表/表格 |
| `search` | `views/search.js` | 搜索（高级检索） |
| `editor` | `views/editor.js` | 记忆编辑器（可由详情面板/上下文菜单打开，支持 `?id=mem_…` 深链参数） |
| `data` | `views/data.js` | 数据管理（备份/恢复/导入/导出） |
| `settings` | `views/settings.js` | 设置页 |
| `onboarding` | `views/onboarding.js` | 首次启动向导（Shell 已内置引导弹窗；Editor 可改为整页接管） |

> 文件不存在时 Shell 自动渲染“占位骨架”（含当前视图 id、预期文件路径、契约链接），**不会报错白屏**。
> 视图模块加载/挂载抛错时 Shell 捕获并显示错误边界（含错误信息与重试按钮），不会影响外壳。

### 2.2 视图模块导出

每个视图模块必须导出一个工厂（named export `createView`，或 default 导出）：

```js
// desktop/renderer/views/timeline.js
export const meta = {
  id: 'timeline',            // 必填，须与文件名一致
  title: '时间线',           // 左侧导航/顶栏显示名
  icon: 'clock',             // ui/icon.js 中的图标名
  order: 30,                 // 导航排序（数值越小越靠前）
  nav: true,                 // 是否出现在左侧导航（默认 true）
  shortcut: 'g t',           // 可选：提示用（Shell 只保证内置快捷键，见 §9）
};

export function createView(ctx) {
  return {
    mount(container) {},     // 必填：同步构建 DOM 并挂到 container（不要返回 Promise）
    unmount() {},            // 必填：解绑监听、销毁 nebula 实例等
    activate() {},           // 可选：视图变为前台时调用
    deactivate() {},         // 可选：视图切到后台时调用
    handleCommand(command, payload) {}, // 可选：接收菜单/快捷键/程序化命令，返回 true 表示已处理
    resize(width, height) {},// 可选：内容区尺寸变化（ResizeObserver 触发，已节流）
    getSnapshot() {},        // 可选：切走时保存可序列化视图状态（由 Shell 存内存，不做业务持久化）
  };
}
```

**允许的写法**：`createView(ctx)` 内可用 `ctx.api` / `ctx.store` / `ctx.events` / `ctx.ui` / `ctx.toast` / `ctx.dialogs` / `ctx.router` / `ctx.detail` / `ctx.status` / `ctx.commands` / `ctx.format` / `ctx.log` / `ctx.shell`。

**禁止**：
- 不要直接 `fetch('http://127.0.0.1:17860/...')`（CORS/token 问题）——用 `ctx.api`。
- 不要 `require()` / 读文件系统 / 开 Node 集成（渲染进程没有）。
- 不要写 `index.html`、`app.js`、`styles/**`、`lib/**`、`ui/**`（这些是 Shell 所有权）；视图自带样式的唯一方式是**在视图文件内创建 `<style>` 标签并在 `unmount()` 移除**，或使用 `styles/` 已有的类与 CSS 变量（推荐）。
- 不要修改 `views/atlas.js` 或 `desktop/renderer/nebula/**`。
- 不要在模块顶层执行副作用（例如立即请求 API）；一切在 `mount()`/`activate()` 内做。
- 不要跨视图直接改 DOM；通过 `ctx.router.navigate()` / `ctx.detail.show()` / CustomEvent 总线协作。

### 2.3 路由与深链

- 路由 id 来自 URL hash，规范格式：`#view=<id>`，参数用 `&` 分隔：
  `#view=atlas`、`#view=timeline`、`#view=editor&id=mem_xxx`、`#view=search&q=关键词`。
  同时兼容旧式 `#<id>`（如 `#timeline`），内部统一归一化为 `#view=<id>`。
- 程序化导航：`ctx.router.navigate('editor', { id: 'mem_…' })` → hash 更新为 `#view=editor&id=mem_…`。
- 视图参数读取：`ctx.router.params`（URLSearchParams 对象，随路由变化更新；在 `activate()` 中读取）。
- 初始路由优先级：URL hash > `localStorage['fca.ui.lastView']` > `atlas`。
- 外部工具（capture.js / e2e）可直接 `file:///…/index.html#view=timeline` 打开指定视图，无需点击。
- 菜单/快捷键命令通过 `handleCommand('view:refresh')` 等下发；Editor 视图只需处理自己关心的命令，其余忽略。

### 2.4 视图 ctx 接口（完整签名）

```js
ctx = {
  api,        // FcaApi 实例，见 §4
  store,      // 应用 store，见 §3
  events,     // 事件总线 Emitter，见 §5
  ui,         // UI 组件库（所有组件均为普通函数，返回 HTMLElement/对象），见 §6
  toast(message, opts),        // 等价 ctx.ui.toast(...)；opts.type = info|success|warn|error
  dialogs: {
    confirm({title, message, confirmLabel, cancelLabel, danger}) -> Promise<boolean>,
    alert({title, message, detail}) -> Promise<void>,
    prompt(...)?,              // 可选扩展，暂不提供
  },
  router: { navigate(id, params?), current, params, onRouteChange(cb) -> off },
  detail: {
    show({ title, subtitle, content /* HTMLElement | (host)=>void */, actions, tabs? }), // 右侧详情面板
    clear(),
    isOpen(), setOpen(bool), setWidth(px)?,
  },
  status: {
    set(id, { label, tone, title? }),   // 自定义底部状态栏片段（id 命名空间建议 'editor.xxx'）
    remove(id),
  },
  commands: {
    execute(cmd),   // { id, label, do(), undo(), coalesceKey? } → 执行并入撤销栈
    canUndo(), canRedo(), undo(), redo(), clear(),
  },
  format: { date, datetime, relativeTime, number, percent, memoryTypeLabel, entityKindLabel, relationTypeLabel },
  log: { info, warn, error },  // 写入主进程桌面日志（会脱敏），也输出 devtools console
  shell: {
    setTitle(text),             // 顶栏中央上下文标题（可选）
    focusSearch(),              // 聚焦顶栏搜索
    openView('editor', params),
    showOnboarding(),           // 重新打开首次启动向导
    openSettingsDialog(),
  },
};
```

> Editor 视图对 `ctx` 只做**读取调用**，不要替换字段。

---

## 3. 应用状态 store（`lib/state.js`）

轻量响应式 store（无依赖）。Shell 在 `app.js` 创建单例并注入 ctx。**Editor 视图通过 selector 订阅，不要整树重渲染**。

### 3.1 Store API

```js
store.getState()                        // 返回只读快照（不要直接改）
store.patch(partial, opts?)             // 浅合并顶层 + 一层嵌套合并；返回新状态
   // opts: { silent?: boolean, persist?: 'localStorage-key' | false }
store.setState(nextState)               // 整体替换（谨慎）
store.subscribe(listener)               // listener(state, prevState) → unsubscribe
store.select(selectorFn, listener)      // listener(value, prevValue) → unsubscribe；selector 结果用 Object.is 比较
store.selectObj(selectorFn, listener)   // 浅比较对象/数组结果
store.batch(fn)                         // 合并一次通知（fn 内多次 patch）
store.dispatch(actionName, payload)     // 交给 actions 注册表（Editor 一般不用）
store.registerActions(actionMap)        // Shell/Editor 可注册具名 action（Editor 不必须）
store.resetTo(partial)                  // 重置为初始值 + partial
```

Store 会以 300ms 节流把 `ui`/`filters`/`app.lastView` 写入 `localStorage`（key 见 §3.3），**不得依赖 store 持久化保存业务数据**。

### 3.2 State 形状（v1，Editor 可读取，禁止写入未定义字段）

```js
{
  app: {
    ready: false,                 // Shell 完成首次挂载
    view: 'atlas',                // 当前路由 id
    previousView: null,
    title: 'FCA Memory Atlas',
    version: { app: '0.1.0', electron: '38.x', node: '24.x', chrome: '140.x' },
    dataDir: 'C:\\Users\\…\\FCA-Memory-Atlas',
    logDir: '…\\logs',
    isFirstRun: true,
    captureMode: false,           // 由 ?capture=1 或 Electron capture 入口设置
    fatalError: null,             // {message}
  },
  settings: {                     // 来自主进程 desktop-settings.json（只读，写入用 ctx.api 之外的 bridge；见 §4.6）
    dataDir, port, runtimeUrl, autoStartRuntime, closeRuntimeOnExit,
    quality: 'high', onboardingCompleted: false, devFixtures: false,
  },
  runtime: {                      // 主进程 Runtime 状态机广播
    state: 'stopped',             // stopped|starting|running|unhealthy|incompatible|stopping|error
    url: 'http://127.0.0.1:17860',
    version: null, apiVersion: null, uptimeMs: 0,
    initialized: null,            // 数据库是否已初始化（来自 /health）
    ownedByDesktop: false,        // Runtime 是否由本桌面启动
    clients: null,                // 若 /system/status 提供
    lastError: null,              // {code, message, hint}
    checkedAt: null,
  },
  connection: {
    sse: 'idle',                  // idle|connecting|connected|reconnecting|offline
    sseAttempts: 0,
    lastEventSeq: 0,
    lastEventAt: null,
    lastSyncAt: null,
    syncState: 'idle',            // idle|syncing|error
    syncError: null,
    lagEvents: 0,                 // 自上次全量同步以来收到的事件数
  },
  graph: {
    status: 'idle',               // idle|loading|ready|error
    data: null,                   // Graph 对象，结构 = PUBLIC_INTERFACE_FREEZE §5（nodes/edges/clusters/stats/layout_version/view）
    stats: { nodes: 0, edges: 0, clusters: 0, generated_at: null },
    layoutVersion: 0,
    loadedAt: null,
    error: null,
    source: 'runtime',            // runtime | dev-fixture（dev fixture 仅开发期存在，UI 必须标注）
  },
  selection: {
    ids: [], primaryId: null, hoverId: null,
    focusNodeId: null, focusDepth: 1,   // nebula focusNode
    lastSelectedId: null,
  },
  filters: {
    types: [],                    // memory_type 数组
    tags: [],                     // tag id 数组
    projects: [],                 // entity id 数组
    timeRange: { preset: 'all', from: null, to: null },  // preset: all|today|week|month|year|quarter|custom
    query: '',
    includeDeleted: false,
    onlyFavorites: false,         // 收藏（本地 localStorage 收藏集合）
    favorites: new Set(),         // 收藏 node id（localStorage 恢复；Set 只读使用，写入用 actions）
  },
  ui: {
    theme: 'dark',
    quality: 'high',              // ultra|high|medium|low|off（nebula 性能档位）
    left: { width: 264, collapsed: false, section: 'all' },
    right: { width: 340, collapsed: false, tab: 'detail' },
    legendOpen: true,
    overlays: { labels: true, nebula: true, edges: true },
    toasts: [],
    dialog: null,                 // {id, kind}
    paletteOpen: false,
    statusbarSegments: {},        // 扩展状态栏片段
  },
  runtimeDetails: {               // 供状态栏/设置页使用的低频数据
    health: null, dbHealth: null, systemStatus: null, lastPolledAt: null, pollError: null,
  },
  onboarding: { open: false, step: 1, dataDir: null, port: 17860, busy: false, error: null, runtimeStartError: null },
  detail: {
    status: 'idle',               // idle|loading|ready|error
    memory: null,                 // Memory 完整对象（GET /memory/{id}.memory）
    relations: [], versionsCount: 0, layout: null,
    related: null,                // 可选：关系解析后的节点摘要
    error: null,
    targetId: null,
  },
  search: {
    status: 'idle', query: '', results: [], tookMs: 0, error: null, open: false,
  },
  notifications: [],              // {id, level, message, at}（状态栏/日志用）
}
```

**视图私有状态不要塞进全局 store**：Editor 视图自己用局部变量 + DOM；确需跨视图共享时在 `ctx.events` 上定义命名空间事件，或向 Shell 申请新增 store 槽位（向后兼容新增，需告知 Lead）。

### 3.3 localStorage 键（由 Shell 统一管理，Editor 可读写自己的键）

| key | 内容 |
|---|---|
| `fca.ui.layout.v1` | `{left:{width,collapsed}, right:{width,collapsed}, legendOpen}` |
| `fca.ui.lastView` | 上次视图 id |
| `fca.ui.quality` | 性能档位 |
| `fca.ui.favorites` | `["mem_…"]` 收藏节点 id 数组 |
| `fca.ui.filters` | 筛选状态（types/tags/projects/timeRange） |
| `fca.ui.sidebarSections` | 左侧导航折叠状态 |

Editor 视图自定义键请使用 `fca.<view>.*` 前缀。

---

## 4. API 客户端（`lib/api.js`）

`api` 是 Runtime HTTP API 的唯一入口。**完整映射 `docs/PUBLIC_INTERFACE_FREEZE.md` §4 全部端点**。所有方法返回 Promise，失败抛 `FcaApiError`。

### 4.1 通用约定

```js
class FcaApiError extends Error {
  code;          // 'VERSION_CONFLICT' | 'NOT_FOUND' | 'NETWORK_ERROR' | 'TIMEOUT' | …（见契约 §7）
  httpStatus;    // number|null
  details;       // object
  traceId;       // trc_…
  userMessage;   // 已本地化的中文提示（可直接 toast）
  retryable;     // boolean
}
```

- **鉴权**：Bearer token 由主进程从 `<FCA_HOME>\config\runtime-token` 读取并自动注入，renderer 永不接触 token。
- **追踪**：每次请求自动生成 `X-FCA-Trace-Id: trc_<32hex>`（`crypto.randomUUID` 派生）；响应 trace id 见 `err.traceId`。
- **客户端头**：`X-FCA-Client: desktop`。
- **超时**：默认 15s；`health/state` 8s；`graph` 30s；`search/timeline` 20s；`backup/export/import` 120s。
- **重试**：幂等 GET + 网络错误/`429`/`5xx` 最多 2 次指数退避（250ms→750ms + 抖动）；非幂等写操作不自动重试（除非显式 `{retry:true}`）。
- **错误提示**：`ERROR_MESSAGES[code]` 中文映射表（见 §4.5），`api.userMessage(err)` 返回中文提示。
- **API 版本**：首次健康检查校验 `api_version === '1'`；不匹配抛 `INCOMPATIBLE`，外壳进入 `runtime.incompatible` 状态，**不得降级冒充成功**。

### 4.2 端点方法（Editor 可直接使用）

```js
api.health()                              // GET /health（免认证，8s）
api.getState()                            // GET /api/v1/state
api.getGraph({include_deleted=false}={})  // GET /api/v1/graph
api.getTimeline({from,to,granularity,filters,limit})
api.getSystemStatus()
api.getDbHealth(); api.getMigrations(); api.vacuumDb()
api.getLogs({level,limit,since})
api.shutdown()
api.submitEvent(event)                    // POST /api/v1/event

api.storeMemory(payload)                  // POST /memory/store
api.getMemory(id, {version}?)             // GET /memory/{id}
api.patchMemory(id, payload)              // PATCH /memory/{id}（payload 含 expected_version）
api.deleteMemory(id, {hard,confirm}={})   // DELETE /memory/{id}
api.restoreMemory(id)                     // POST /memory/{id}/restore
api.mergeMemories(id, {source_ids, target_id, strategy})
api.splitMemory(id, {parts})
api.getVersions(id, {limit,before_version})
api.getDiff(id, {from,to})
api.searchMemory({query, mode='fulltext', filters, limit, cursor, include_deleted})

api.listRelations({node_kind,node_id,relation_type,include_deleted})
api.createRelation(payload); api.patchRelation(id,payload); api.deleteRelation(id)

api.listEntities({limit,cursor,kind,q}); api.createEntity(payload)
api.getEntity(id); api.patchEntity(id,payload); api.deleteEntity(id)

api.getIdentity(); api.updateIdentity(payload)
api.getCognition(); api.updateCognition(payload)

api.getLayoutNodes({node_kind})           // GET /layout/nodes
api.saveLayoutNodes(updates)              // POST /layout/nodes {updates:[{node_kind,node_id,x,y,z,pinned}]}
api.recomputeLayout({algorithm='force_v1', cluster_separation=0.8})
api.resetLayout()
api.listLayoutViews(); api.saveLayoutView(payload); api.deleteLayoutView(id)

api.createBackup(); api.listBackups(); api.restoreBackup(backup_id); api.deleteBackup(id)
api.exportData({format,filters,path}); api.importData(payload)
api.initDb()                              // POST /db/init（幂等）

api.listLlmProviders(); api.createLlmProvider(payload); api.updateLlmProvider(id,payload); api.deleteLlmProvider(id)
api.llmComplete(payload); api.getLlmQueue(); api.retryLlmQueue(id)
```

### 4.3 搜索 / 筛选辅助（Editor 常用）

筛选对象统一形状（与 `filters` store 对齐，传给 API 时由 `api.buildFilters(filtersState)` 归一化）：

```js
filters = {
  types: ['episodic'],
  tags: ['tag_…'],                 // tag id
  projects: ['ent_…'],
  timeRange: { from: 'ISO|null', to: 'ISO|null' },
  include_deleted: false,
  // 可选扩展：favorites: ['mem_…']（仅本地筛选，不发 API，由视图自己过滤）
}
```

`api.applyGraphFilters(graph, filtersState, favoritesSet)`：纯函数，返回过滤后的 graph（用于星云层客户端筛选；关系两端被过滤时删边）。**空库/空结果返回空数组，不伪造节点**。

### 4.4 SSE 事件订阅

```js
const sub = api.events.subscribe({
  onEvent(evt) {},          // evt = 契约 §6 事件对象
  onStatus({state, attempts, error}) {}, // 'connected' | 'reconnecting' | 'offline'
  onResync({reason, graph, state}) {},   // 断线补发失败/序号缺口 → 已自动全量重同步
});
sub.close();
api.events.addEventListener(typeOr'*', handler)  // 轻量监听；返回 off 函数（Editor 用这个即可）
```

- 自动断线重连（1s→2s→4s→8s→15s 封顶 + 抖动）；用 `Last-Event-ID` 续传。
- 心跳 15s；>40s 无任何帧视为假死 → 主动重连。
- 若服务端无法补发（连接重新建立后序号缺口、或重连 3 次进入 offline）→ 自动全量重同步（GET /state + /graph），并触发 `onResync`；Shell 随后 `events.emit('api:resync', {reason})`。
- SSE 原始事件同时由 Shell 广播到总线：`ctx.events.on('sse:<event.type>', handler)`，例如 `sse:memory.created`。
- **Editor 视图必须容忍事件乱序/重复**（按 subject id 幂等更新）。

### 4.5 错误码 → 中文提示（`ERROR_MESSAGES`，完整表）

| code | 提示 |
|---|---|
| `BAD_REQUEST` | 请求格式错误（客户端缺陷，请反馈 trace id） |
| `VALIDATION_FAILED` | 字段校验失败：{details.fields} |
| `UNAUTHORIZED` | 认证失败：Runtime token 缺失或不匹配，请检查数据目录 config/runtime-token |
| `FORBIDDEN` | 已拒绝：Runtime 仅允许本机回环访问 |
| `NOT_FOUND` | 对象不存在或已被删除 |
| `METHOD_NOT_ALLOWED` | 接口方法不支持（Runtime 版本不匹配？） |
| `CONFLICT` | 操作冲突，请刷新后重试 |
| `VERSION_CONFLICT` | 该记忆已被其他客户端修改（当前版本 {details.current_version}），请刷新后重试 |
| `DUPLICATE` | 幂等键重复：{details.existing_id} |
| `GONE` | 对象已永久删除 |
| `PAYLOAD_TOO_LARGE` | 内容超过大小限制 |
| `UNSUPPORTED_MEDIA_TYPE` | 内容类型不支持 |
| `RATE_LIMITED` | 请求过于频繁，请稍后重试 |
| `INTERNAL` | Runtime 内部错误（trace id：{trace_id}） |
| `NOT_INITIALIZED` | 数据库尚未初始化，请先完成初始化向导 |
| `DATABASE_ERROR` | 数据库错误，请尝试备份并重启 Runtime |
| `BACKUP_FAILED` | 备份失败 |
| `RESTORE_FAILED` | 恢复失败，数据库未被修改 |
| `IMPORT_FAILED` | 导入失败：{message} |
| `LLM_NOT_CONFIGURED` | 未配置 LLM Provider（本地功能不受影响） |
| `LLM_UNAVAILABLE` | LLM 服务不可达（本地功能不受影响） |
| `SHUTTING_DOWN` | Runtime 正在关闭 |
| `NETWORK_ERROR` | 无法连接 Runtime（{url}），请确认运行时已启动 |
| `TIMEOUT` | Runtime 响应超时 |
| `INCOMPATIBLE` | Runtime API 版本不兼容（需要 API v1） |
| `CANCELLED` | 请求已取消 |
| `UNKNOWN` | 未知错误 |

### 4.6 主进程桥（`window.fca`，preload 暴露）

Renderer 只能通过以下白名单访问系统能力（Editor 视图通常不需要直接用它，用 `ctx.api`/`ctx.dialogs` 即可；设置相关的核心配置写入请走 `ctx.shell.openSettingsDialog()` 或如下接口）：

```js
window.fca = {
  isElectron: true, bridgeVersion: '1.0',
  app: { getInfo(), getSettings(), saveSettings(patch), onSettingsChanged(cb)->off,
         relaunch(), quit(), log(level,msg,meta?), openPath('data'|'logs'|'backups'|'db'|'runtime') },
  runtime: { getStatus(), start(opts?), stop(), restart(), checkHealth(), onStatus(cb)->off },
  net: { request(req), streamStart(opts), streamStop(), onStreamEvent(cb)->off },
  dialog: { selectDirectory(opts), openFile(opts), saveFile(opts), messageBox(opts), confirm(opts) },
  window: { minimize(), toggleMaximize(), close(), isMaximized(), onMaximizeChange(cb)->off },
  menu: { onCommand(cb)->off },
};
```

---

## 5. 事件总线（`lib/events.js`）

极小 Emitter（`on/off/once/emit/onAny`），Shell 单例注入 `ctx.events`。约定事件名（Editor **只能新增自己命名空间的事件**）：

| 事件 | payload | 触发方 |
|---|---|---|
| `app:ready` | `{info}` | Shell |
| `view:changed` | `{from,to,params}` | router |
| `runtime:status` | RuntimeStatus | Shell（主进程广播转发） |
| `graph:loading` / `graph:loaded` / `graph:error` | `{graph}`/`{error}` | Shell |
| `selection:change` | `{ids, primaryId}` | Shell |
| `node:hover` | `{id}` | atlas |
| `filters:change` | filters | Shell |
| `quality:change` | `{level}` | Shell |
| `api:resync` | `{reason}` | api |
| `sse:event` | `{event, seq}` | Shell |
| `sse:status` | `{state}` | Shell |
| `toast` | `{message,type}` | ui |
| `command:execute` | `{id}` | commands |
| `menu:command` | `{command,payload}` | 主进程菜单转发 |
| `detail:changed` | `{targetId,status}` | Shell |
| `editor:*` / `<view>:*` | 自定义 | Editor 视图（命名空间） |

`ctx.events.emit()` 内单个 handler 抛错会被捕获并记录，不影响其它监听者。

---

## 6. UI 组件库（`desktop/renderer/ui/`，`import { ui } from './lib/ui.js'` 或 `ctx.ui`）

所有组件为**普通函数**（无虚拟 DOM），返回原生 DOM 元素或带方法的对象；样式由 `styles/components.css` 提供，使用 CSS 变量（见 §8）。签名稳定，Editor 可依赖。

```js
ui.el(tag, attrs?, children?)              // 通用创建器：attrs 支持 class/style/dataset/on<Event>/html/文本子节点
ui.frag(...children)
ui.clear(node)

ui.button({ label, icon, variant:'primary'|'secondary'|'ghost'|'danger', size:'sm'|'md',
            disabled, title, loading, kbd, onClick(event) }) -> HTMLButtonElement
ui.iconButton({ icon, label, variant?, size?, active?, disabled?, onClick }) -> HTMLButtonElement
ui.input({ value, placeholder, type='text', icon, ariaLabel, disabled, onInput, onChange, onKeydown }) -> HTMLInputElement
ui.textarea({ value, placeholder, rows=5, onInput }) -> HTMLTextAreaElement
ui.select({ options:[{value,label,disabled?}], value, onChange, ariaLabel, size }) -> HTMLSelectElement
ui.checkbox({ label, checked, onChange }) -> HTMLElement
ui.switch({ label, checked, onChange }) -> HTMLElement
ui.numberInput({ value, min, max, step, onChange }) -> HTMLInputElement
ui.tag({ label, tone:'neutral'|'cyan'|'violet'|'gold'|'rose'|'green'|'blue', icon, onRemove, onClick }) -> HTMLElement
ui.badge({ label, tone }) -> HTMLElement
ui.kbd('Ctrl+K') -> HTMLElement
ui.spinner({ label }) -> HTMLElement
ui.progress({ value, max=100, tone }) -> HTMLElement
ui.section({ title, subtitle, actions:[HTMLElement], collapsible, defaultOpen, content:HTMLElement|fn }) -> HTMLElement
ui.emptyState({ icon, title, description, actions:[{label,variant,onClick}] }) -> HTMLElement
ui.dialog({ title, subtitle, content:HTMLElement, actions:[{label,variant,onClick(close),closeOnClick?}],
            width=520, dismissible=true, onClose }) -> { el, close(), setBusy(bool) }
ui.confirm({ title, message, detail, confirmLabel='确认', cancelLabel='取消', danger }) -> Promise<boolean>
ui.toast(message, { title, type:'info'|'success'|'warn'|'error', duration=4200, action? }) -> {close}
ui.contextMenu({ x, y, items:[{ label, icon, shortcut, danger, disabled, separator, onClick }] }) -> {close}
ui.dropdown({ anchor, items, align:'left'|'right' }) -> {close}   // 下拉菜单（顶栏更多操作）
ui.virtualList({ items, itemHeight=48, renderItem(item,index)->HTMLElement, overscan=6,
                 onSelect(item,index), selectedIndex, emptyText }) -> { el, setItems, scrollToIndex, destroy }
ui.tooltip(target, text) -> { destroy() }   // 悬停提示（延迟 400ms）
ui.tabs({ tabs:[{id,label,icon?}], active, onChange }) -> { el, setActive(id) }
ui.splitPanel({ ... })?                     // Shell 内部使用，不对外承诺
ui.icon(name, { size=18, className }) -> SVGElement   // 图标名见 ui/icons.js（含：search, chevron-down, chevron-right,
  // plus, minus, fit, layers, legend, settings, refresh, play, stop, trash, edit, save, undo, redo, import, export,
  // database, clock, list, relation, pin, filter, close, check, alert, info, folder, file, shield, sparkles,
  // zoom-in, zoom-out, maximize, star, star-filled, eye, eye-off, panel-left, panel-right, more, copy, external,
  // activity, brain, compass, tag, back, forward, grid, map, home, download, upload, restore, merge, split, history)
```

**组件用法示例（Editor 参考）**：

```js
import { ui } from '../lib/ui.js';
// 在 createView(ctx) 中：
const list = ctx.ui.virtualList({
  items: rows, itemHeight: 56,
  renderItem: (m) => ctx.ui.el('div', { class: 'fca-list-row', on: { click: () => ctx.router.navigate('editor', { id: m.id }) } }, [
    ctx.ui.el('div', { class: 'fca-list-row__title', text: m.title }),
    ctx.ui.el('div', { class: 'fca-list-row__meta', text: ctx.format.datetime(m.occurred_at) }),
  ]),
  onSelect: (m) => ctx.detail.show({ title: m.title, content: () => renderDetail(m) }),
});
container.append(list.el);
```

**样式规则**：优先组合现有 class（`fca-panel`、`fca-toolbar`、`fca-list-row`、`fca-form-field`、`fca-muted`、`fca-scroll` 等）；需要私有样式时在视图文件内 `<style>` + `.view-timeline` 前缀，并在 `unmount` 移除。

---

## 7. Nebula 渲染器使用契约（`desktop/renderer/nebula/index.js`）

接口见 `docs/PUBLIC_INTERFACE_FREEZE.md` §5（冻结）。Shell 的 `views/atlas.js` 是**唯一**调用方；Editor 的关系探索视图如需嵌入可视化可复用同一接口，但**不要**修改 nebula 文件。

```js
import { createNebula } from '../nebula/index.js';
const instance = createNebula(containerEl, {
  quality: 'high',              // ultra|high|medium|low|off
  background: 'deep-space',     // 由 renderer 实现
  labels: true,
  // 其它选项以 nebula 组文档为准；Shell 只传这些稳定项
});
instance.setData(graph);        // Graph 原始数据（契约 §5），空 graph 渲染空深空 + 由 Desktop 叠加提示
instance.setMapping(mapping);   // 视觉映射参数（见下，可选调用；未知字段忽略）
instance.setQuality('medium');
instance.setView({ center: [0,0,0], zoom: 1.0 });
instance.focusNode(id, { depth: 1 });
instance.select(ids);
instance.setFilters({ types, tags, projects, timeRange });  // 客户端筛选提示；数据过滤以 setData 为准
instance.on('node:click', ({ id }) => {});
instance.on('node:dblclick', ({ id }) => {});
instance.on('node:hover', ({ id }) => {});
instance.on('node:dragend', ({ id, position }) => {});  // position {x,y,z} → Shell POST /layout/nodes
instance.on('background:click', () => {});
instance.on('selection:change', ({ ids }) => {});
instance.on('perf', ({ fps, frame_ms, draw_calls }) => {});
instance.getStats();             // {fps, frame_ms, draw_calls, nodes|nodeCount, …}
instance.screenshotDataUrl();
instance.destroy();
```

**Desktop 传入的 mapping（建议形状；Nebula 可忽略未知键）**：

```js
{
  node: { sizeFromImportance: true, sizeFromDegree: true, brightnessFromDisplayWeight: true },
  cluster: { colorHints: { cyan:'#7fd8e8', blue:'#6f9fe8', violet:'#a08cf0', magenta:'#d47fd0', rose:'#e88f9f', gold:'#d8b978', white:'#dfe8f2' } },
  relation: { types: { /** relation_type → {color, style} */ } },
  labels: { enabled: true, minZoom: 0.55 },
  background: { starDensity: 1.0, galaxyBand: true },
}
```

**向后兼容扩展（Nebula 可选实现，Desktop 特性检测）**：
`instance.getView() -> {center, zoom}`、`instance.fitToContent({padding})`、`instance.setQuality` 返回实际档位。
Shell 在 `atlas.js` 中**特性检测**这些方法；不存在时自动降级（不影响主流程）。Shell 不依赖任何未冻结的新接口。

**Dev 兜底**：nebula 模块未就绪时，Shell 使用 `lib/dev/` 下的 dev-only stub（同样接口，绘制占位深空 + 明确 DOM 标注「开发夹具」）；该目录与引用在最终交付前**删除**，生产代码只加载真实 `../nebula/index.js`。

---

## 8. 设计令牌与样式约定（`styles/tokens.css`）

深色专业深空基调，**禁止企业数据大屏/霓虹风**。Editor 视图必须使用以下 CSS 变量（不得硬编码颜色）：

```css
--fca-bg-0: #070b12;        /* 最底层/窗口背景 */
--fca-bg-1: #0a1019;        /* 内容区 */
--fca-bg-2: #0e1622;        /* 面板 */
--fca-bg-3: #131d2c;        /* 悬浮/输入 */
--fca-bg-4: #1a2637;        /* 激活/hover */
--fca-border: #1e2b3d;      /* 常规描边 */
--fca-border-strong: #2c3d54;
--fca-text: #dbe6f2;        /* 主文本 */
--fca-text-dim: #9fb0c4;    /* 次要 */
--fca-text-muted: #6b7f96;  /* 弱化 */
--fca-accent: #7fb8d9;      /* 冷青强调（克制使用） */
--fca-accent-strong: #a8d6ef;
--fca-accent-soft: rgba(127,184,217,.14);
--fca-gold: #d8b978;        /* 强调/重要 */
--fca-rose: #e08f9f;
--fca-green: #7fc8a9;
--fca-violet: #a08cf0;
--fca-danger: #e07070;
--fca-radius-sm: 4px; --fca-radius: 6px; --fca-radius-lg: 10px;
--fca-space-1: 4px; --fca-space-2: 8px; --fca-space-3: 12px; --fca-space-4: 16px; --fca-space-5: 24px; --fca-space-6: 32px;
--fca-font-ui: 'Segoe UI Variable Text','Segoe UI','Microsoft YaHei UI',system-ui,sans-serif;
--fca-font-mono: 'Cascadia Mono','Consolas',monospace;
--fca-text-xs: 11px; --fca-text-sm: 12px; --fca-text-md: 13px; --fca-text-lg: 15px; --fca-text-xl: 19px;
--fca-shadow-panel: 0 8px 28px rgba(0,0,0,.45);
--fca-dur-fast: 120ms; --fca-dur: 180ms; --fca-ease: cubic-bezier(.2,.7,.2,1);
```

CSS 命名空间：Shell 用 `fca-`；视图文件用 `view-<id>-`；禁止全局元素选择器（`body`/`*` 除外由 base.css 管）。

---

## 9. 快捷键（Shell 注册，视图可通过 handleCommand 接收）

| 键 | 行为 | 下发命令 |
|---|---|---|
| `Ctrl+K` / `Ctrl+F` | 聚焦顶栏搜索 | — |
| `Ctrl+Z` | 撤销 | `edit:undo` |
| `Ctrl+Shift+Z` / `Ctrl+Y` | 重做 | `edit:redo` |
| `Delete` | 删除选中的记忆（软删，带确认+可撤销） | `edit:delete-selection` |
| `F` | 适应屏幕（atlas） | `view:fit` |
| `L` | 图例开关（atlas） | `view:toggle-legend` |
| `Q` | 循环性能档位（atlas） | `view:cycle-quality` |
| `Esc` | 关闭浮层 / 清除选择 | `esc` |
| `F5` | 重新加载图谱 | `view:refresh` |
| `Ctrl+1..6` | 切换视图 | `view:switch` |

输入框聚焦时除 `Esc`/`Ctrl+K` 外不触发单键快捷键。视图通过 `handleCommand` 可拦截自己关心的命令（返回 true）。

---

## 10. 数据来源与真实数据原则

1. 星图数据**唯一来源**：`GET /api/v1/graph`（经 `api.getGraph()`）。空库必须渲染真实深空背景 + “空白星图”提示，**不得显示任何假节点**。
2. 开发夹具（dev-only）：`lib/dev/fixtures.js` 只在 Runtime 未就绪且显式开启（`?dev=1` 或 settings.devFixtures=true）时使用，UI 必须显示醒目标注「开发夹具数据（dev-only）」；该目录不出现在最终生产交付中。
3. 详情/关系/版本必须来自 API 真实响应；无法获取时显示错误态与 trace id，不展示缓存假数据。
4. 所有“未实现”的入口必须显式标注「Alpha 0.1 未实现」或指向 Editor 视图占位，不得静默失败。

---

## 11. 测试与验收挂钩（供 QA / Editor 自测）

- **稳定验收钩子**（Lead/QA/capture 依赖，保持不删）：
  ```js
  window.__FCA_APP__ = {
    getState(),                 // 当前 store 快照
    navigate(view, params?),    // 切换视图（等同于 hash 导航）
    openMemory(id),             // 打开记忆（详情面板 + atlas 聚焦；Editor 视图存在时可用 navigate('editor',{id})）
    setQuality(level),          // ultra|high|medium|low|off
    setFilters(filters),        // 合并筛选并刷新
    refreshGraph(),             // 重新 GET /graph
    getGraph(),                 // 当前 graph 数据（null 表示尚未加载）
    getNebulaStats(),           // 转发 nebula getStats()（无实例则 null）
    openOnboarding(),           // 打开首次启动向导
    openSettings(),             // 打开核心设置弹窗
    version: { app, electron, node, chrome },
    ready: Promise,             // Shell 首次挂载完成
  };
  ```
  注意 `navigate('timeline')` 在 Editor 视图文件不存在时进入占位骨架（不报错）。
- 应用完成首次挂载后 `window.__FCA_READY__ = true`；致命错误时 `window.__FCA_FATAL__ = { message }` 并显示错误页（capture 仍可截图）。
- 兼容调试句柄：`window.fcaApp = { store, api, router, events, ui, version, ready }`（只读使用）。
- capture 入口等待 `window.__FCA_READY__`；`?capture=1` 会开启截图模式（禁用自动弹窗动画、固定视口、不自动创建 Runtime）。
- 每次渲染进程错误（`window.onerror` / `unhandledrejection`）→ 主进程日志 + 状态栏通知；QA 可 grep `desktop-*.log` 中 `"level":"error"`。
- Editor 视图验收基线：模块存在即被路由加载；`mount/unmount` 可重复调用 100 次无泄漏（视自己负责）；`unmount()` 后不残留全局事件监听；不因 Runtime 断开而崩溃（显示错误/空态）。

---

## 12. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| 1.0 | 2026-11-12 | 首版：视图注册、store 形状、API 客户端、事件、UI kit、nebula 使用、快捷键、设计令牌、dev 数据策略 |
