# Runtime 运维脚本

FCA Local Runtime 的初始化、备份、恢复、导出、导入、演示数据等运维操作**全部由 CLI 子命令提供**，不需要额外脚本：

```powershell
# 在本项目根目录执行（Windows 自带 node 不在 PATH 时使用 tools\node.cmd）
tools\node.cmd runtime\bin\fca-runtime.js init
tools\node.cmd runtime\bin\fca-runtime.js serve
tools\node.cmd runtime\bin\fca-runtime.js status
tools\node.cmd runtime\bin\fca-runtime.js stop
tools\node.cmd runtime\bin\fca-runtime.js backup --note="手动备份"
tools\node.cmd runtime\bin\fca-runtime.js restore <backup_id>
tools\node.cmd runtime\bin\fca-runtime.js export --format=json
tools\node.cmd runtime\bin\fca-runtime.js import <path>
tools\node.cmd runtime\bin\fca-runtime.js seed --demo --count=120
tools\node.cmd runtime\bin\fca-runtime.js logs --level=warn --limit=50
tools\node.cmd runtime\bin\fca-runtime.js migrate
tools\node.cmd runtime\bin\fca-runtime.js version
```

安装版桌面软件启动时会自动定位并拉起 Runtime；本目录脚本仅用于开发/运维/排障。API 详细说明见 `docs/API.md`。
