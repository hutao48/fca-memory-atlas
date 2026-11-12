# ADR-005：进程与生命周期 —— 独立 Runtime 服务 + 客户端自动拉起 + SSE 同步

- 状态：已接受（2026-11-12）
- 决策者：Lead（架构）
- 关联：ARCHITECTURE.md §5、PUBLIC_INTERFACE_FREEZE.md §4/§6

## 背景

桌面软件与 DSH 插件必须访问**同一个** FCA Local Runtime 与**同一套**数据；关闭任一界面不得损坏数据；任一客户端都可能先启动。

## 决策

1. Runtime 是独立进程（`fca-runtime serve`），唯一数据权威；默认 `127.0.0.1:17860`，端口/数据目录可配置。
2. 单实例：数据目录级锁文件 + 端口健康检查；第二个实例检测到已运行则直接复用（CLI 报“already running”）。
3. 客户端自动拉起：
   - Desktop 主进程在启动时 `/health` 探测；未运行则按“安装目录定位 → 随包 node → spawn runtime”顺序拉起，状态机 `stopped/starting/running/unhealthy` 在状态栏显示。
   - DSH 插件默认 `autoStartRuntime` 仅当配置允许时尝试拉起；失败则显示“需先启动 Runtime”，**不假装已连接**。
4. 关闭策略：UI 退出默认不杀 Runtime；Runtime 在无客户端连接且 idle 超时后可退出（可配置常驻）。退出前 `PRAGMA wal_checkpoint(TRUNCATE)`。
5. 变更同步：Runtime 用 **SSE**（`GET /api/v1/events/stream`）推送已提交事件；客户端用 `Last-Event-ID` 续传，无法续传时触发全量重同步（`/state`+`/graph`）。SSE 作为 WebSocket 的等效机制（契约允许）。
6. 多客户端并发：DB 层 WAL + 写串行队列；HTTP 层乐观并发（`expected_version`）；事件层幂等键（`client_event_id`）。

## 后果

- 桌面与插件可同时连接、各自启停、数据一致；关闭桌面不影响插件/Agent 使用。
- 需要谨慎处理“谁启动谁负责关闭”的归属，避免误杀；通过 `/system/status.clients` 与桌面设置控制。
- SSE 在代理/休眠下可能断线，客户端必须实现重连与全量重同步（已写入契约）。
