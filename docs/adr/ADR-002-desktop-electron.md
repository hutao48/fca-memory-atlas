# ADR-002：桌面软件采用 Electron 38 + 原生 ESM Renderer，无前端构建步骤

- 状态：已接受（2026-11-12）
- 决策者：Lead（架构）
- 关联：ARCHITECTURE.md §3.2、ENVIRONMENT_REPORT.md §4

## 背景

交付物要求“原生桌面应用或可靠的桌面应用封装”“可安装、可启动、可卸载”，并需要 WebGL 星云渲染。系统无 Rust/.NET SDK，Python 打包路径复杂。

## 备选方案

| 方案 | 评估 |
|---|---|
| **A. Electron 38 + 原生 ESM（选定）** | 真实 Windows 桌面应用；Chromium 提供稳定 WebGL2/GPU 加速；与 DSH 同技术栈；apt 资源可复用本机已缓存 Electron；可 electron-builder 打 NSIS 安装包；无前端构建步骤=调试简单、无工具链依赖 |
| B. Tauri | 体积小，但本机 **无 Rust 工具链**，需安装 MSVC/Rust，构建链重 |
| C. pywebview + PyInstaller | Python 打包 + WebView2 依赖；双语言；安装包构造复杂 |
| D. WinUI/WPF + WebView2 | 本机 **无 .NET SDK**；XAML 学习成本与并行开发协调成本高 |
| E. 纯网页/本地服务器 | 明确违反“不是网页原型”的验收要求 |

## 决策

采用 **A**：Electron 38（项目 `.cache/electron-dist`，打包时由 electron-builder 提供正式分发），主进程 CommonJS，渲染进程原生 ESM + `<script type="module">`，零前端框架依赖（自研轻量 store/组件）。窗口安全设置：`contextIsolation=true`、`nodeIntegration=false`、preload 白名单 IPC。

## 后果

- 正面：真实桌面软件、GPU 渲染成熟、打包路径明确（NSIS 安装/卸载）、与 DSH 插件/运行时同为 JS 技术栈、调试成本低。
- 负面：安装包体积较大（Electron + Node 运行时约 300MB 级）；需注意 Electron 与系统 node 的 `ELECTRON_RUN_AS_NODE` 环境差异（已记录为环境坑）。
- 验收：安装包、卸载器、启动/关闭、窗口状态恢复、真实截图全部在真机验证。
