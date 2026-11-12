# ADR-001：Runtime 采用 Node 24 + 内置 `node:sqlite`，零第三方运行时依赖

- 状态：已接受（2026-11-12）
- 决策者：Lead（架构）
- 关联：ARCHITECTURE.md §3.1、ENVIRONMENT_REPORT.md §2

## 背景

FCA Local Runtime 需要：本地 HTTP API、SQLite、事件日志、备份/恢复、搜索、向量（可选）、文件系统管理。要求能在用户机器上稳定独立运行、可随安装包分发、离线可用、启动快、依赖少。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| **A. Node 24 + 内置模块（选定）** | 本机已验证 Node v24.21 可用、`node:sqlite` 可用；HTTP/加密/压缩/文件系统全内置；与 DSH 插件同语言；可打包为独立 exe（随包 node.exe）；零 npm 运行时依赖，不会因依赖腐坏 | `node:sqlite` 较新，API 面较小（DatabaseSync 同步 API），需自己写路由/校验 |
| B. Python 3.11 + FastAPI + Pydantic | 契约开发体验好，生态成熟 | 需 pip 依赖与 venv/打包（PyInstaller）→ 安装包与运行时更复杂；桌面端若 Electron 则出现双运行时；本机 Python 3.14 与目标 3.11 不一致 |
| C. Go/Rust 单文件服务 | 分发简单 | 本机无 Go/Rust 工具链；开发速度慢于 JS；与插件/桌面生态割裂 |

## 决策

采用 **A**：Runtime 为纯 ESM Node 项目，仅依赖 `node:` 内置模块（`node:http`、`node:sqlite`、`node:crypto`、`node:fs`、`node:zlib`、`node:child_process` 等），不引入第三方运行时依赖。SQLite 使用 `DatabaseSync`（WAL 模式、`busy_timeout`、显式事务）。随安装包分发官方 `node.exe`（v24 x64，≈90MB）作为独立运行时。

## 后果

- 正面：零依赖、可离线、单语言、打包简单、与插件/桌面共享同一 Node 生态。
- 负面：需自建 HTTP 路由/参数校验/错误映射（已在 `src/server` 内聚）；`node:sqlite` 同步 API 需配合写队列避免阻塞事件循环——策略：写操作串行队列 + 事务短小；读操作允许并发但限制大查询。
- 迁移路径：若未来需要更强 ORM/迁移工具，可在保持同一 DB schema 与 HTTP 契约下替换持久层。

## 验证

- `node -e "require('node:sqlite')"` 建表/写入/查询通过（ENVIRONMENT_REPORT.md §2）。
- 所有测试不依赖外网；`runtime/test` 全绿。
