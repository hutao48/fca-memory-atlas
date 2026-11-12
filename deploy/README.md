# deploy — AI Agent 自主安装部署

本目录用于把 FCA Memory Atlas 交给 AI Agent（如 DeepSeek）**自主安装/部署**：

| 文件 | 用途 |
|---|---|
| `DEEPSEEK_AGENT_PROMPT.md` | 可直接粘贴给 DeepSeek Agent 的完整部署提示词（环境检查 → 安装 → 初始化 → DSH 插件 → 验收 → 失败处理 → 应答格式） |
| `install-source.ps1` | 源码方式部署引导：定位 Node ≥24、初始化数据目录、启动 Local Runtime、等待 `/health` 并通过，输出 token 路径与下一步 |

## 使用方式（推荐）

1. 把仓库地址 + `deploy/DEEPSEEK_AGENT_PROMPT.md` 全文交给 DeepSeek Agent；
2. Agent 会按提示词逐阶段执行并输出真实证据（命令、退出码、health JSON、记忆闭环、插件状态）；
3. 若使用源码方式，Agent 可直接运行：
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-source.ps1
   ```

## 说明

- `install-source.ps1` 只负责 **Runtime**（本地服务）；桌面 GUI 与 DSH 插件分别按提示词阶段 1/阶段 3 处理。
- 安装包方式（阶段 1 方案 A）需要从 Windows 文件资源管理器以普通用户权限双击运行；在受限沙箱/CI 内启动安装器会被拒绝写注册表或目标目录，这不是安装包缺陷。
- 所有数据默认写入 `%LOCALAPPDATA%\FCA-Memory-Atlas`（可用 `-FcaHome` 覆盖），仅监听 `127.0.0.1`。
