# ADR-004：数据架构 —— SQLite 主存 + JSONL 事件镜像 + 独立布局表 + 可选向量索引

- 状态：已接受（2026-11-12）
- 决策者：Lead（架构）
- 关联：PUBLIC_INTERFACE_FREEZE.md §3-§6、ARCHITECTURE.md §4

## 背景

FMA（FCA Memory Architecture）要求明确区分：记忆内容、记忆关系、星图布局、UI 状态、神经网络状态、人格/身份数据、当前认知状态；并支持来源/时间/版本/操作主体可追溯、软删回收、备份恢复、全文/语义检索。

## 决策

数据目录内：

1. **SQLite（WAL）为主存**：`memories`、`memory_versions`、`entities`、`relations`、`relation_versions`、`tags`、`memory_tags`、`identity`、`cognition_state`、`events`、`event_queue`、`layout_nodes`、`layout_views`、`settings`、`schema_migrations`、`llm_providers`、`audit_log`。
2. **JSONL 事件镜像**：每条已提交事件同时追加到 `events/events-YYYY-MM.jsonl`（追加写、按行 JSON、可审计、可外部处理）；SQLite `events` 表用于查询/补发/幂等。
3. **布局独立**：`layout_nodes` 只存坐标/缩放/固定/聚类归属；**移动星体不触碰记忆正文与关系**。命名视图存 `layout_views`。
4. **向量索引可选**：Alpha 0.1 用确定性本地哈希 embedding（`local-hash-v1`）+ 余弦相似度，存储在常规表；不引入外部模型依赖、不作为基础读写依赖。未来可替换为本地向量模型/独立索引文件。
5. **版本与审计**：每次写操作产生 `memory_versions`/`relation_versions` 快照 + RFC6902 diff + actor；`audit_log` 记录请求主体/IP/追踪 ID（脱敏）。
6. **迁移**：`schema_migrations` + `PRAGMA user_version`；迁移前自动备份；启动做 `integrity_check`。
7. **备份**：`VACUUM INTO` 生成一致性快照 + 元数据 JSON（schema 版本、计数、校验和）；恢复前校验，失败不覆盖现有库。

## 后果

- 单一数据权威，桌面/插件只经 API 访问；旧记忆库不迁移、不读取、不物理删除（需用户另行授权）。
- 事件双写带来少量额外 IO；采用批量/异步追加 + 崩溃后可修复（SQLite 为权威，JSONL 可重建）。
- 布局与内容分离保证“移动星体不改变语义关系”的验收要求。
