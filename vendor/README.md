# vendor/ — 本目录存放构建时可下载的二进制依赖（不提交到 git）

由下列脚本自动下载到本目录：

| 路径 | 来源 | 用途 |
|---|---|---|
| `vendor/node/node.exe` | `node scripts/fetch-node.js`（nodejs.org / npmmirror，固定 v24.11.0） | 安装包随包 Node 运行时，用于运行 FCA Local Runtime |
| `.cache/electron-dist/` | `node scripts/fetch-electron.js`（固定 Electron 38.2.1，npmmirror 镜像） | 桌面软件运行时 + 截图/验证工具 |
| `.cache/nsis/` | `node scripts/fetch-nsis.js`（npmmirror 镜像 electron-builder-binaries） | 编译 Windows 安装包（NSIS 3.04） |

这些二进制不进入源码仓库；构建脚本会在缺失时自动下载（本机已实测可用）。
