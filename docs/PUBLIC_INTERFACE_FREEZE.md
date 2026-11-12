# FCA Alpha 0.1 — 公共接口冻结（v1.0）

> 本文件是并行开发的**唯一契约**。任何 Agent 不得私自修改；变更只能由主 Agent（Lead）审核后修改本文件并通知各任务组。
> 冻结项：数据模型、ID 规则、API Schema、事件格式、错误码、渲染数据契约、目录结构、版本兼容策略。

## 0. 顶层常量

| 常量 | 值 |
|---|---|
| `FCA_API_VERSION` | `"1"` |
| `FCA_PRODUCT_VERSION` | `"0.1.0"` |
| 默认 Runtime 地址 | `http://127.0.0.1:17860` |
| 默认数据目录 `FCA_HOME` | `%LOCALAPPDATA%\FCA-Memory-Atlas` |
| 默认数据库 | `<FCA_HOME>\db\fca.db`（SQLite，WAL） |
| 事件日志 | `<FCA_HOME>\events\events-YYYY-MM.jsonl` |
| 备份目录 | `<FCA_HOME>\backups\` |
| 日志目录 | `<FCA_HOME>\logs\runtime-YYYYMMDD.log`（JSONL） |
| 认证 | `Authorization: Bearer <token>`；token 文件 `<FCA_HOME>\config\runtime-token` |
| 客户端标识头 | `X-FCA-Client: desktop \| dsh-plugin \| cli \| test` |
| 追踪头 | 请求可带 `X-FCA-Trace-Id`，否则服务端生成；响应必回 `X-FCA-Trace-Id`，错误体含 `trace_id` |
| 内容类型 | `application/json; charset=utf-8` |

## 1. ID 规则（不可变）

格式：`<prefix>_<32 位小写 hex>`（16 随机字节，`crypto.randomBytes(16).toString('hex')`）。客户端不得自造 ID；服务端生成。

| 前缀 | 对象 |
|---|---|
| `mem_` | 记忆 |
| `ent_` | 实体（人物/项目/地点/概念/组织） |
| `rel_` | 关系 |
| `evt_` | 事件 |
| `ver_` | 版本记录 |
| `tag_` | 标签 |
| `lay_` | 布局节点记录（内部）/ 视图 `view_` |
| `bak_` | 备份 |
| `trc_` | 追踪 ID |

## 2. 枚举（不可变，可扩展用 `custom`）

```
memory_type        = working | episodic | semantic | procedural | autobiographical | project | relational | emotional
entity_kind        = person | project | place | concept | organization | other
occurred_precision = exact | day | month | year | approximate | unknown      # approximate=估计时间，unknown=缺失时间
source_type        = user | agent | system | external | inference | import  # inference=未验证模型推断
origin             = user | agent | revised                               # 手动创建 / Agent 自动生成 / 人工修订
actor_kind         = user | agent | system | plugin
client_kind        = desktop | dsh-plugin | cli | test
relation_type      = temporal_before | temporal_after | participates_in | shared_experience | knowledge_link |
                     causal | derived_from | belongs_to_project | emotional_link | custom
change_kind        = create | update | merge | split | restore | delete | import
node_kind          = memory | entity
```

## 3. 数据模型

### 3.1 Memory

```json
{
  "id": "mem_…",
  "title": "string (<=500)",
  "body": "string (<=1_000_000)",
  "memory_type": "episodic",
  "occurred_at": "2026-11-12T10:00:00.000Z | null",
  "occurred_precision": "exact",
  "occurred_end_at": "ISO | null",
  "source": { "type": "user", "ref": "string|null", "note": "string|null" },
  "credibility": 0.8,              // 0..1
  "importance": 0.6,              // 0..1
  "display_weight": 1.0,           // 0..2，星体亮度倍率
  "tags": ["tag_…", "…"],         // 标签 ID；响应同含 tag_names
  "participants": [{ "entity_id": "ent_…", "name": "张三", "role": "participant" }],
  "project": { "entity_id": "ent_…", "name": "项目A" } | null,
  "emotion": { "valence": 0.2, "arousal": 0.5, "label": "平静" } | null,
  "origin": "user",
  "created_at": "ISO", "updated_at": "ISO",
  "version": 3,
  "deleted_at": null,
  "agent_generated": false,
  "created_by": { "kind": "user", "id": "local" },
  "updated_by": { "kind": "agent", "id": "dsh-plugin" }
}
```

写入（`POST /memory/store`）接受 `title, body, memory_type, occurred_at?, occurred_precision?, occurred_end_at?, source?, credibility?, importance?, display_weight?, tags? (names 或 ids), participants? (name 或 entity_id), project? (name 或 entity_id), emotion?, origin?`；服务端解析/创建实体与标签。`PATCH` 接受同样字段子集 + `expected_version`。

### 3.2 Entity

```json
{ "id": "ent_…", "kind": "person", "name": "张三", "description": "", "aliases": [],
  "metadata": {}, "created_at": "ISO", "updated_at": "ISO", "version": 1, "deleted_at": null }
```

### 3.3 Relation（独立数据实体）

```json
{
  "id": "rel_…",
  "from": { "kind": "entity", "id": "ent_…" },
  "to":   { "kind": "memory", "id": "mem_…" },
  "relation_type": "participates_in",
  "directed": true,
  "label": "参与",
  "evidence": "用户手动建立 | 来源引用",
  "confidence": 0.9,
  "source": { "type": "user", "ref": null, "note": null },
  "weight": 1.0,
  "created_at": "ISO", "updated_at": "ISO", "version": 1, "deleted_at": null
}
```

删除关系默认**不删除**两端对象。

### 3.4 Version / 历史

- 每次创建/修改/合并/拆分/恢复/软删都写入 `memory_versions`：`{ver_id, memory_id, version, change_kind, snapshot (完整 Memory JSON), diff (RFC6902), actor, source_event_id, created_at}`。
- `GET /memory/{id}/versions` 默认返回最近 100 条（可 `?limit=&before_version=`）。
- 软删除保留全部历史；硬删除（需 `confirm=true` 且仅限用户显式授权）写墓碑事件。

### 3.5 Layout（与记忆语义分离）

- 显式布局表：`layout_nodes(node_kind, node_id, x, y, z, pinned, cluster_id, updated_at)`；`layout_views(view_id, name, is_default, camera_json, layer_config_json, created_at)`
- 移动星体只写布局表，**不得**修改记忆正文/关系。
- 坐标系：世界单位，`x,y ∈ [-5000,5000]`，`z ∈ [-800,800]`。布局由 Runtime 计算并持久化。

### 3.6 Identity / Cognition

```json
// GET /api/v1/identity
{ "identity_id": "idn_…", "display_name": "…", "summary": "…", "values": [], "preferences": {},
  "boundaries": [], "version": 2, "updated_at": "ISO" }
// GET /api/v1/cognition
{ "focus": "…", "attention_targets": ["mem_…"], "working_memory": ["mem_…"],
  "mood": { "valence": 0.1, "arousal": 0.4, "label": "…" }, "mode": "idle",
  "note": "模拟状态，不代表主观感受", "updated_at": "ISO" }
```

## 4. HTTP API（`/api/v1`，除 `/health` 外均需 Bearer token）

分页统一：请求 `?limit=`（默认 50，上限 500）+ `?cursor=`；响应 `{ "items": [...], "next_cursor": "string|null", "total": 0 }`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 免认证。`{status:"ok"\|"degraded", version, api_version, uptime_ms, initialized, db:"ok"}` |
| GET | `/api/v1/state` | 身份、认知、计数、同步状态、能力清单；含 `catalogs:{tags:[{id,name,count}], projects:[{entity_id,name,count}]}` |
| POST | `/api/v1/event` | 提交事件（插件/桌面/CLI）。`client_event_id` 幂等 |
| GET | `/api/v1/memories` | 列表查询：`limit,cursor,q,memory_type,tags,project,participant,from,to,include_deleted,only_deleted,sort`（sort: updated_at\|created_at\|occurred_at\|importance\|title，`-` 前缀降序）→ `{items:[Memory], next_cursor, total}`（v1.1 增量，Desktop 列表视图依赖） |
| GET | `/api/v1/tags` | 标签目录 `{items:[{id,name,count,created_at}]}`，可选 `?q=`（v1.1 增量） |
| POST | `/api/v1/memory/store` | 新建记忆 → Memory |
| POST | `/api/v1/memory/search` | `{query, mode:"fulltext"\|"semantic"\|"hybrid", filters:{...}, limit, cursor, include_deleted}` → `{items:[{memory, score, highlights}], next_cursor, took_ms}` |
| GET | `/api/v1/memory/{id}` | `?version=` 取历史版本 → `{memory, relations:[], layout, versions_count}` |
| PATCH | `/api/v1/memory/{id}` | 乐观并发：body 含 `expected_version`；冲突 409 `VERSION_CONFLICT` |
| DELETE | `/api/v1/memory/{id}` | 默认软删（`?hard=true&confirm=true` 仅限显式授权） |
| POST | `/api/v1/memory/{id}/restore` | 回收站恢复 |
| POST | `/api/v1/memory/{id}/merge` | `{source_ids:[], target_id, strategy:"keep_target"\|"prepend_sources"}` |
| POST | `/api/v1/memory/{id}/split` | `{parts:[{title, body, memory_type?, ...}]}` → 新记忆列表 |
| GET | `/api/v1/memory/{id}/versions` | 版本历史 |
| GET | `/api/v1/memory/{id}/diff?from=&to=` | 版本差异（RFC6902） |
| POST | `/api/v1/relations` | 新建关系 |
| PATCH | `/api/v1/relations/{id}` | 修改（乐观并发） |
| DELETE | `/api/v1/relations/{id}` | 软删关系（不删两端） |
| GET | `/api/v1/relations` | `?node_kind=&node_id=&relation_type=&include_deleted=` |
| GET/POST | `/api/v1/entities` | 列表 / 新建 |
| GET/PATCH/DELETE | `/api/v1/entities/{id}` | 详情 / 修改 / 软删 |
| GET/POST | `/api/v1/identity` | 读取 / 更新（版本化） |
| GET/POST | `/api/v1/cognition` | 读取 / 更新 |
| GET | `/api/v1/timeline` | `?from=&to=&granularity=day\|week\|month\|year&participants=&projects=&tags=&memory_types=` → `{buckets:[{key,label,count,node_ids:[],present_types}], items:[MemoryRef], range}` |
| GET | `/api/v1/graph` | 见 §5 渲染数据契约；支持同 timeline 的 `participants/projects/tags/memory_types/from/to` 过滤参数 |
| GET/POST | `/api/v1/layout/nodes` | 读 / 批量保存坐标（`{updates:[{node_kind,node_id,x,y,z,pinned}]}`） |
| POST | `/api/v1/layout/recompute` | 自动布局（`{algorithm:"force_v1", cluster_separation:0.8}`） |
| POST | `/api/v1/layout/reset` | 恢复布局（清空手动坐标并重算） |
| GET/POST | `/api/v1/layout/views` | 命名视图（相机/图层配置） |
| DELETE | `/api/v1/layout/views/{id}` | 删除视图 |
| GET | `/api/v1/system/status` | 数据库/存储/GPU/LLM/客户端/错误统计 |
| POST | `/api/v1/backup` | 创建备份 → `{backup_id, path, size, created_at}` |
| GET | `/api/v1/backups` | 备份列表 |
| POST | `/api/v1/restore` | `{backup_id}` → 校验+恢复（需重启 Runtime 时返回 `requires_restart:true`） |
| DELETE | `/api/v1/backups/{id}` | 删除备份（显式确认） |
| POST | `/api/v1/export` | `{format:"json"\|"jsonl"\|"zip", filters?, path?}` → 文件路径 |
| POST | `/api/v1/import` | 导入 **FCA 自身导出格式**（禁止旧记忆系统格式；不迁移旧库） |
| POST | `/api/v1/db/init` | 首次初始化空库（幂等） |
| GET | `/api/v1/db/health` | 完整性检查 `PRAGMA integrity_check` + 计数 + 体积 |
| GET | `/api/v1/db/migrations` | 迁移版本 |
| POST | `/api/v1/db/vacuum` | 压缩 |
| GET | `/api/v1/logs` | `?level=&limit=&since=` 已脱敏日志尾部 |
| POST | `/api/v1/shutdown` | 本地客户端/CLI 关闭 Runtime |
| GET/POST/PATCH/DELETE | `/api/v1/llm/providers` | LLM Provider 配置（Key 掩码返回） |
| POST | `/api/v1/llm/complete` | 检索最小记忆上下文后调用 LLM；离线 → `202 {queued:true, queue_id}` |
| GET | `/api/v1/llm/queue` | 未处理请求队列 |
| POST | `/api/v1/llm/queue/{id}/retry` | 重试 |
| GET | `/api/v1/events/stream` | **SSE** 变更推送（见 §6） |

## 5. 渲染数据契约（星云 Renderer 输入，唯一来源）

`GET /api/v1/graph` 响应：

```json
{
  "api_version": "1",
  "layout_version": 17,
  "view": { "center": [0,0,0], "zoom": 1.0, "view_id": "view_…|null" },
  "nodes": [{
    "id": "mem_…", "kind": "memory", "type": "episodic", "label": "…",
    "importance": 0.6, "display_weight": 1.0, "credibility": 0.8,
    "occurred_at": "ISO|null", "degree": 4, "cluster_id": "cluster_3",
    "position": { "x": 123.4, "y": -50.2, "z": 12.0 },
    "pinned": false, "tags": ["…"], "deleted": false, "agent_generated": false
  }],
  "edges": [{
    "id": "rel_…", "from": "mem_…", "to": "ent_…", "relation_type": "participates_in",
    "weight": 1.0, "directed": true, "confidence": 0.9, "label": "参与", "deleted": false
  }],
  "clusters": [{
    "id": "cluster_3", "label": "2026 春季 · 项目A", "node_ids": ["…"],
    "centroid": { "x": 0, "y": 0, "z": 0 }, "density": 0.62,
    "dominant_types": ["episodic"], "color_hint": "cyan|blue|violet|magenta|rose|gold|white"
  }],
  "stats": { "nodes": 0, "edges": 0, "clusters": 0, "generated_at": "ISO" }
}
```

Renderer 要求（视觉验收核心，见 prompt 第三节/第十二节）：
1. **不得**自行伪造节点/关系；空库时渲染真实深空背景 + “空白星图”提示，不显示假节点。
2. 星云密度/颜色/尘埃由 `clusters` 与节点密度驱动；关系光丝来自 `edges`；亮度/大小来自 `importance/display_weight/degree`。
3. 提供图例、图层控制、映射说明 UI（由 Desktop 实现，Renderer 暴露映射参数）。
4. 位置以 Runtime 布局为准；用户拖拽时本地松弛动画 + 通过 `POST /layout/nodes` 持久化。
5. 性能档位：`ultra | high | medium | low | off`；**off 档必须保留全部交互与可读性**。

Renderer 模块接口（Desktop 与 Nebula 任务组之间冻结）：
```js
// desktop/renderer/nebula/index.js
export function createNebula(container, options) -> instance
// instance: setData(graph), setMapping(mapping), setQuality(level), setView({center,zoom}),
//           focusNode(id, {depth:1|2}), select(ids), setFilters({types,tags,projects,timeRange}),
//           on(event, handler), destroy(), getStats(), screenshotDataUrl()
// events: 'node:click' {id}, 'node:dblclick', 'node:hover', 'node:dragend' {id, position},
//         'background:click', 'selection:change' {ids}, 'perf' {fps, frame_ms, draw_calls}
```

## 6. 事件格式 v1（HTTP + JSONL + SSE 同一格式）

```json
{
  "schema_version": "1.0",
  "id": "evt_…",
  "seq": 12345,
  "type": "memory.created",
  "ts": "2026-11-12T10:00:00.000Z",
  "actor": { "kind": "user", "id": "local", "display": "用户" },
  "source": { "kind": "desktop", "id": "desktop-main", "version": "0.1.0" },
  "subject": { "kind": "memory", "id": "mem_…" },
  "payload": { "…": "…" },
  "trace_id": "trc_…",
  "client_event_id": "外部幂等键|null"
}
```

事件类型（前缀即 subject 类型）：
`memory.created|updated|deleted|restored|merged|split|imported`、
`relation.created|updated|deleted`、`entity.created|updated|deleted`、
`layout.updated|recomputed|view.saved`、
`identity.updated`、`cognition.updated`、
`backup.created|deleted`、`restore.completed`、
`db.initialized|migrated|vacuumed`、
`llm.request.queued|sent|failed|completed`、
`agent.event_received`（DSH 事件进入 FCA 的审计事件）、
`system.started|stopped|client.connected|client.disconnected|error`。

SSE 帧：`event: fca.event` / `id: <seq>` / `data: <Event JSON>`；每 15s `event: heartbeat`。断线重连用 `Last-Event-ID` 补发；补发不可用时客户端须全量重同步（`/graph`+`/state`）。

## 7. 错误码

统一错误体：

```json
{ "error": { "code": "VERSION_CONFLICT", "message": "人类可读信息", "details": {}, "trace_id": "trc_…" } }
```

| code | HTTP | 含义 |
|---|---|---|
| BAD_REQUEST | 400 | 请求格式错误 |
| VALIDATION_FAILED | 422 | 字段校验失败（details.fields） |
| UNAUTHORIZED | 401 | 缺失/错误 token |
| FORBIDDEN | 403 | 非回环地址或权限拒绝 |
| NOT_FOUND | 404 | 对象不存在 |
| METHOD_NOT_ALLOWED | 405 | 方法不支持 |
| CONFLICT | 409 | 一般冲突 |
| VERSION_CONFLICT | 409 | 乐观并发冲突（details.current_version） |
| DUPLICATE | 409 | 幂等键重复（details.existing_id） |
| GONE | 410 | 已硬删除 |
| PAYLOAD_TOO_LARGE | 413 | 超限 |
| UNSUPPORTED_MEDIA_TYPE | 415 | Content-Type 不符 |
| RATE_LIMITED | 429 | 限流 |
| INTERNAL | 500 | 未预期错误 |
| NOT_INITIALIZED | 503 | 数据库未初始化 |
| DATABASE_ERROR | 503 | SQLite 错误 |
| BACKUP_FAILED | 500 | 备份失败 |
| RESTORE_FAILED | 500 | 恢复失败 |
| IMPORT_FAILED | 422 | 导入失败 |
| LLM_NOT_CONFIGURED | 409 | 未配置 Provider |
| LLM_UNAVAILABLE | 503 | API 不可达（本地功能不受影响） |
| SHUTTING_DOWN | 503 | 正在关闭 |

## 8. 版本兼容策略

- Runtime 版本 `MAJOR.MINOR.PATCH`；API 主版本 `/api/v1`。
- `GET /health.api_version` = `"1"`；插件/桌面启动时校验 `api_version === "1"`，否则进入“不兼容”状态并明确提示，不得降级冒充成功。
- 数据库 `PRAGMA user_version` = schema 版本；启动时按 `schema_migrations` 顺序迁移，迁移前自动备份。
- 插件清单记录 `engines.fcaRuntime: ">=0.1.0 <0.2.0"`。
- 事件 `schema_version` 向后兼容：新增字段可忽略，不得改字段语义。

## 9. 目录结构（冻结）

```
D:\FCA\FCA-Memory-Atlas\
├─ docs\                 架构/ADR/接口冻结/环境报告/用户手册/测试报告/插件环境报告
├─ runtime\              FCA Local Runtime（Node 24，零第三方运行时依赖，node:sqlite）
│  ├─ bin\fca-runtime.js  CLI: serve|init|status|stop|backup|restore|export|import|health
│  ├─ src\{server,config,api,core,events,memory,identity,cognition,llm,security,persistence,layout}\
│  └─ test\              node:test 单元/集成测试
├─ desktop\              Electron 桌面应用
│  ├─ main\              主进程：窗口/菜单/IPC/Runtime 管理/日志/原生对话框
│  └─ renderer\          UI + WebGL2 星云：{app.js,index.html,nebula\,ui\,views\,styles\,lib\}
├─ dsh_plugin\           正式 DSH Cordis bundle（package.json dsh.bundle.patch + cordis.patch.yml + main.js 入口，实现模块在 src\）
├─ scripts\              开发/构建/打包/基准脚本
├─ tests\                unit|integration|e2e|performance|security
├─ installer\            安装包构建（NSIS/electron-builder 或 IExpress 兜底）
├─ config\               配置样例
├─ data_template\        空库模板说明（不包含任何旧记忆）
├─ tools\                node.cmd / pnpm.cmd / env.ps1（本机工具链封装）
├─ artifacts\            screenshots/ reports/（验收材料）
├─ vendor\               离线依赖缓存（如需）
└─ README.md CHANGELOG.md
```

## 10. 并行写入域（避免冲突）

| 任务组 | 允许写入路径 |
|---|---|
| Lead | `docs\**`、根配置、`scripts\**`、`installer\**`、`tests\e2e\**`、最终集成 |
| Runtime | `runtime\**`（除 `runtime\src\llm\**`）、`tests\unit\runtime\**`、`tests\integration\runtime\**` |
| LLM Gateway | `runtime\src\llm\**`、`runtime\src\config\llm*`（若需）、`tests\unit\llm\**` |
| Nebula | `desktop\renderer\nebula\**`、`tests\performance\nebula\**`、`docs\NEBULA_RENDERER.md` |
| Desktop Shell | `desktop\main\**`、`desktop\package.json`、`desktop\renderer\index.html`、`renderer\app.js`、`renderer\lib\**`、`renderer\ui\**`、`renderer\styles\**`、`renderer\views\atlas.js` |
| Desktop Editor | `desktop\renderer\views\{editor,timeline,search,list,relations,data,settings,onboarding}.js`（其余视图文件） |
| DSH Plugin | `dsh_plugin\**`、`docs\DSH_PLUGIN_ENVIRONMENT_REPORT.md` |
| QA/Release | `tests\**`（除上述已分配）、`docs\TEST_REPORT.md`、`artifacts\**` |
