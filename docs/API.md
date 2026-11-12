# FCA Local Runtime — HTTP API 文档（Alpha 0.1）

- API 主版本：`/api/v1`（`GET /health` 免认证）
- 版本：`FCA_PRODUCT_VERSION = 0.1.0`，`FCA_API_VERSION = "1"`
- 默认地址：`http://127.0.0.1:17860`
- 运行方式与配置见 `docs/USER_MANUAL.md`、`config/README.md`
- 完整冻结契约（数据结构/枚举/渲染契约/错误码）见 `docs/PUBLIC_INTERFACE_FREEZE.md`

## 1. 认证与通用约定

| 约定 | 说明 |
|---|---|
| 认证 | `Authorization: Bearer <token>`；token 文件 `<FCA_HOME>/config/runtime-token`（Runtime 首次启动自动生成，权限受限） |
| 客户端标识 | `X-FCA-Client: desktop \| dsh-plugin \| cli \| test`（用于访问日志/系统状态统计） |
| 追踪 | 可带 `X-FCA-Trace-Id`；响应必回 `X-FCA-Trace-Id`，错误体含 `trace_id` |
| 内容类型 | 请求/响应 `application/json; charset=utf-8` |
| 分页 | 列表端点支持 `?limit=`（默认 50，上限 500）+ `?cursor=`；响应 `{items:[...], next_cursor, total}` |
| 时间 | ISO 8601 UTC（毫秒），例如 `2026-11-12T10:00:00.000Z` |
| ID | `<prefix>_<32位小写hex>`，如 `mem_`、`ent_`、`rel_`、`evt_`、`bak_`；由服务端生成 |

统一错误体：

```json
{"error":{"code":"VERSION_CONFLICT","message":"版本冲突：数据已被其它操作修改","details":{"current_version":2},"trace_id":"trc_…"}}
```

错误码与 HTTP 状态映射（完整表见冻结文档 §7）：`BAD_REQUEST 400`、`VALIDATION_FAILED 422`、`UNAUTHORIZED 401`、`FORBIDDEN 403`、`NOT_FOUND 404`、`VERSION_CONFLICT 409`、`DUPLICATE 409`、`PAYLOAD_TOO_LARGE 413`、`INTERNAL 500`、`NOT_INITIALIZED 503`、`DATABASE_ERROR 503`、`BACKUP_FAILED 500`、`RESTORE_FAILED 500`、`IMPORT_FAILED 422`、`LLM_NOT_CONFIGURED 409`、`LLM_UNAVAILABLE 503`、`SHUTTING_DOWN 503`。

## 2. 健康与状态

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 免认证。`{status:"ok"\|"degraded", version, product_version, api_version:"1", uptime_ms, initialized, db:"ok", pid, shutting_down}` |
| GET | `/api/v1/state` | 身份/认知摘要、计数、同步状态、能力清单、`catalogs:{tags,projects}` |
| GET | `/api/v1/system/status` | 数据库/存储/GPU（`nvidia-smi` 探测）/LLM 队列/客户端/错误统计 |
| GET | `/api/v1/db/health` | `PRAGMA integrity_check` + 计数 + 体积 + 迁移版本 |
| POST | `/api/v1/db/init` | 初始化空库（幂等）。桌面端首次启动、安装后首次运行使用 |
| GET | `/api/v1/db/migrations` | 迁移版本列表 |
| POST | `/api/v1/db/vacuum` | 压缩数据库 |
| GET | `/api/v1/logs` | `?level=&limit=&since=` 已脱敏日志尾部（不含 token/Key/正文） |
| POST | `/api/v1/shutdown` | 优雅关闭 Runtime（完成 WAL checkpoint 后退出） |

## 3. 记忆（Memories）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/memory/store` | 新建记忆。关键字段：`title, body, memory_type, occurred_at?, occurred_precision?, source?, credibility?, importance?, display_weight?, tags? (名称或ID), participants? (name 或 entity_id), project?, emotion?, origin?` → 完整 Memory |
| POST | `/api/v1/memory/search` | `{query, mode:"fulltext"\|"semantic"\|"hybrid", filters?, limit?, cursor?, include_deleted?}` → `{items:[{memory, score, highlights, matched_by}], next_cursor, total, took_ms, mode, engine}` |
| GET | `/api/v1/memories` | 列表/筛选：`limit,cursor,q,memory_type,tags,project,participant,from,to,include_deleted,only_deleted,sort` |
| GET | `/api/v1/memory/{id}` | `?version=` 读取历史版本 → `{memory, relations:[], layout, versions_count}` |
| PATCH | `/api/v1/memory/{id}` | 修改（必须带 `expected_version`）；冲突返回 `409 VERSION_CONFLICT` + `details.current_version` |
| DELETE | `/api/v1/memory/{id}` | 默认软删除（回收站）；`?hard=true&confirm=true` 仅限用户显式授权 |
| POST | `/api/v1/memory/{id}/restore` | 从回收站恢复 |
| POST | `/api/v1/memory/{id}/merge` | `{source_ids:[], target_id, strategy:"keep_target"\|"prepend_sources"}` |
| POST | `/api/v1/memory/{id}/split` | `{parts:[{title, body, memory_type?, ...}]}` |
| GET | `/api/v1/memory/{id}/versions` | 版本历史（默认最近 100 条，`?limit=&before_version=`） |
| GET | `/api/v1/memory/{id}/diff?from=&to=` | 版本差异（RFC6902） |

记忆类型枚举：`working | episodic | semantic | procedural | autobiographical | project | relational | emotional`。
每条记忆必含来源（`source.type`: `user|agent|system|external|inference|import`）、时间精度、可信度、重要性、版本、创建者/修改者；模型推断（`source.type=inference`）不得自动变成确定事实。

## 4. 关系 / 实体 / 标签

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/relations` | `{from:{kind,id}, to:{kind,id}, relation_type, directed?, label?, evidence?, confidence?, weight?}` |
| GET | `/api/v1/relations` | `?node_kind=&node_id=&relation_type=&include_deleted=` |
| PATCH | `/api/v1/relations/{id}` | 修改（乐观并发） |
| DELETE | `/api/v1/relations/{id}` | 软删关系，**不删除两端记忆/实体** |
| GET/POST | `/api/v1/entities` | 列表 / 新建 `{kind, name, description?, aliases?}` |
| GET/PATCH/DELETE | `/api/v1/entities/{id}` | 详情 / 修改 / 软删 |
| GET | `/api/v1/tags` | 标签目录 `{items:[{id,name,count,created_at}]}`，`?q=` 过滤 |

关系类型枚举：`temporal_before | temporal_after | participates_in | shared_experience | knowledge_link | causal | derived_from | belongs_to_project | emotional_link | custom`。

## 5. 时间线 / 星图 / 布局

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/timeline` | `?from=&to=&granularity=day\|week\|month\|year&participants=&projects=&tags=&memory_types=` → `{buckets:[{key,label,count,node_ids,present_types}], items, range}` |
| GET | `/api/v1/graph` | 星图渲染数据（冻结契约 §5）。支持与服务端筛选同 timeline。**空库返回空 nodes/edges，不伪造节点** |
| GET/POST | `/api/v1/layout/nodes` | 读 / 批量保存坐标 `{updates:[{node_kind,node_id,x,y,z,pinned}]}`（只写布局，不改记忆语义） |
| POST | `/api/v1/layout/recompute` | 自动布局 `{algorithm:"force_v1", cluster_separation:0.8}` |
| POST | `/api/v1/layout/reset` | 恢复布局（清空手动坐标并重算） |
| GET/POST | `/api/v1/layout/views` | 命名视图（相机/图层配置） |
| DELETE | `/api/v1/layout/views/{id}` | 删除视图 |

## 6. 身份 / 认知

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/v1/identity` | 读取 / 更新身份（版本化）；更换 LLM 不影响该数据 |
| GET/POST | `/api/v1/cognition` | 读取 / 更新认知模拟状态（响应明确标注「模拟状态，不代表主观感受」） |

## 7. 事件与 SSE 实时推送

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/event` | 提交事件（插件/桌面/CLI）。`client_event_id` 幂等去重；事件写入 SQLite + JSONL 审计镜像 |
| GET | `/api/v1/events/stream` | SSE：`event: fca.event` / `id: <seq>` / `data: <Event JSON>`；每 15s `event: heartbeat`；断线用 `Last-Event-ID` 补发 |

事件类型（前缀即 subject 类型，完整清单见冻结文档 §6）：`memory.created|updated|deleted|restored|merged|split|imported`、`relation.*`、`entity.*`、`layout.*`、`backup.created`、`restore.completed`、`agent.event_received`、`system.started` 等。

## 8. 备份 / 恢复 / 导入 / 导出

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/backup` | 创建备份（VACUUM INTO + sha256 + 完整性校验）→ `{backup_id, path, size, created_at}` |
| GET | `/api/v1/backups` | 备份列表 |
| POST | `/api/v1/restore` | `{backup_id}` → 校验后恢复；需要重启时返回 `requires_restart: true` |
| DELETE | `/api/v1/backups/{id}` | 删除备份（显式确认） |
| POST | `/api/v1/export` | `{format:"json"\|"jsonl"\|"zip", filters?, path?}` → 文件路径；格式为 FCA 自身导出格式 |
| POST | `/api/v1/import` | 导入 FCA 自身导出的 JSON/JSONL/ZIP；**禁止导入旧记忆系统格式** |

## 9. LLM Gateway（本地优先，模型可替换）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST/PATCH/DELETE | `/api/v1/llm/providers` | Provider 配置（DeepSeek / OpenAI-compatible / 自定义）；响应中 API Key 永远掩码 |
| POST | `/api/v1/llm/complete` | 先本地检索、筛选「最小必要记忆上下文」后调用 LLM；离线 / 未配置时返回 `202 {queued:true, queue_id}`（入队），**不伪装成功** |
| GET | `/api/v1/llm/queue` | 未处理请求队列（pending/sent/failed/completed） |
| POST | `/api/v1/llm/queue/{id}/retry` | 重试队列请求 |

约束：API Key 加密保存于本机（AES-256-GCM），不硬编码、不写入普通日志；默认**不上传**全量记忆库/事件日志/关系图谱/神经网络权重。

## 10. 调用示例（PowerShell）

```powershell
$base = 'http://127.0.0.1:17860'
$token = Get-Content "$env:LOCALAPPDATA\FCA-Memory-Atlas\config\runtime-token" -Raw
$h = @{ Authorization = "Bearer $($token.Trim())"; 'X-FCA-Client' = 'cli' }

# 健康检查（免认证）
Invoke-RestMethod "$base/health"

# 新建一条记忆
$body = @{
  title = '第一条记忆'; body = '由 API 创建'; memory_type = 'episodic'
  occurred_at = (Get-Date).ToUniversalTime().ToString('o'); source = @{ type = 'user' }
  importance = 0.6
} | ConvertTo-Json -Depth 6
Invoke-RestMethod "$base/api/v1/memory/store" -Method Post -Headers $h -ContentType 'application/json' -Body $body

# 全文检索
Invoke-RestMethod "$base/api/v1/memory/search" -Method Post -Headers $h -ContentType 'application/json' -Body (@{query='记忆';mode='fulltext';limit=10} | ConvertTo-Json)

# 星图数据（渲染契约）
Invoke-RestMethod "$base/api/v1/graph" -Headers $h
```

> 桌面软件与 DSH 插件都通过同一套 API 访问**同一个** Runtime 与**同一套**数据，不复制记忆库。
