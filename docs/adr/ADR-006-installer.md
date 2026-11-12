# ADR-006：安装与分发 —— electron-builder/NSIS 优先，IExpress 兜底；Node 运行时随包

- 状态：已接受（2026-11-12）
- 决策者：Lead（架构/发布）
- 关联：ENVIRONMENT_REPORT.md §4

## 背景

必须交付“可安装软件包 + 可运行程序 + 启动/关闭/卸载方式 + 数据/日志目录选择 + 端口配置 + 首次启动向导”。本机未预装 Inno Setup / NSIS / 7-Zip，无 .NET SDK、无 Rust。

## 评估

| 方案 | 可行性 | 结论 |
|---|---|---|
| electron-builder + NSIS（自动下载 NSIS 工具链） | npm 包与 GitHub 均可访问（实测 200）；标准 Setup.exe + 卸载器 + 快捷方式 + 注册表 | **首选** |
| IExpress（Windows 自带自解压） | 无需额外工具；可包 exe/脚本；但需自行写安装/卸载脚本与注册表项 | **兜底** |
| WiX/MSI | 需 .NET SDK / WiX 工具 | 不可行（无 SDK） |
| 绿色 ZIP | 不满足“安装包 + 卸载方式”要求 | 不可单独交付 |

## 决策

1. 用 **electron-builder + NSIS** 生成 `FCA-Memory-Atlas-Setup-0.1.0-x64.exe`（含桌面快捷方式、开始菜单、卸载器、安装目录选择、per-user 安装）。
2. 安装包内包含：桌面应用（Electron 打包）、FCA Local Runtime（JS + 随包官方 `node.exe` v24 x64）、CLI/工具、空白数据模板、文档与许可证。
3. Runtime 由桌面按需拉起；卸载器停止 Runtime 进程并保留用户数据目录（提示用户是否删除数据；默认保留）。
4. 若 electron-builder 在构建时无法下载 NSIS 工具链，则用 **IExpress** 生成自解压安装器 + 独立卸载脚本 `Uninstall-FCA.cmd`，同样登记添加/卸载项；两种产物都必须在真机做“安装→启动→关闭→卸载”实测并记录。
5. 版本信息：`package.json version`、安装包文件名、`/health.version`、卸载项显示版本一致。

## 后果

- 安装包较大（Electron + Node ≈ 300MB），符合本地优先桌面软件的预期。
- 需在构建脚本中固定 Electron 缓存路径（`.cache/electron-dist`）以支持离线重复构建。
- 安装失败必须写明确错误日志（`%TEMP%\fca-install.log` 与安装器日志）。
