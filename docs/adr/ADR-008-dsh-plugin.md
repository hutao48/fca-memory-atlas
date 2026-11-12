# ADR-008：DSH 集成 —— 真实 Cordis bundle Host 插件，不修改 DSH 核心

- 状态：已接受（2026-11-12）
- 决策者：Lead（架构）
- 关联：ENVIRONMENT_REPORT.md §3、docs/DSH_PLUGIN_ENVIRONMENT_REPORT.md（实现组产出）

## 背景

要求“通过真实、已核实的 DSH 插件 SDK/规范接入”，禁止编造 SDK、禁止修改 DSH 核心程序冒充插件、禁止未验证加载就宣称成功。

## 已核实事实（证据见 ENVIRONMENT_REPORT.md §3）

- DSH 插件体系为 **Cordis bundle**：包内 `package.json.dsh.bundle.patch` 指向 YAML patch，loader 按 bundle 层栈叠加，插入/覆盖插件条目。
- 插件入口：`export function apply(ctx, config)`（可选 `inject`、`Config`）或默认导出 Service 类；资源用 `ctx.effect`/`ctx.on` 注册并在卸载时清理。
- 真实可订阅 Host 事件包括 `session/event`（post-commit 事件流）、`agent/inbox/inserted`、`agent/status`、`tools/execute`/`tools/result`、`system-prompt/*` 等。
- 真实 Host 服务包括 `tools.register`、`systemPrompt.context/section/variables`、`commands.register`、`agents`、`configEditor`、`credentials` 等。
- 本机已装第三方 bundle（`dsh-whale-widget`、`dsh-plugin-ai-design-skills`），安装/加载链路真实可用；安装入口为 `plugin_manager install_bundle`。

## 决策

1. 以**独立 bundle 包**形态交付插件（`dsh_plugin/`），通过 `plugin_manager install_bundle` 安装到当前 profile；不手改 profile 的 `package.json`/`cordis.patch.yml`，不修改 DSH 安装目录。
2. 能力实现只使用**真实存在**的扩展点：事件订阅（事件→Runtime）、工具注册（Agent↔FCA 记忆）、可选 systemPrompt 上下文注入、命令/状态上报。
3. 插件对 Runtime 的连接状态、版本兼容、队列、错误必须如实可见；Runtime 未运行时不显示“已连接”。
4. 插件故障隔离：所有回调 try/catch，失败只记录并上报，不抛出到 DSH 主流程。
5. 交付包含安装验证报告（加载证据、通信测试），任何能力缺失/阻塞须明示，不得包装为完成。

## 后果

- 插件随 DSH profile 生效，重启后仍在；卸载通过 `plugin_manager remove_bundle` 或 `dsh plugin remove`。
- 插件与桌面共享同一 Runtime 与数据，不复制记忆库。
