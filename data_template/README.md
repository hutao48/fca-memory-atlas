# 数据模板说明（全新记忆库）

FCA Alpha 0.1 **不迁移、不导入任何旧记忆库**。本目录只说明「全新空白记忆库」是如何产生的，**不包含任何记忆数据、旧库文件或样例记忆**。

## 如何得到全新空白数据库

```powershell
# 默认数据目录 %LOCALAPPDATA%\FCA-Memory-Atlas
tools\node.cmd runtime\bin\fca-runtime.js init

# 或指定数据目录（安装版桌面软件也可在首次启动向导里选择）
tools\node.cmd runtime\bin\fca-runtime.js --fca-home="D:\FCA-Data" init
```

`init` 会创建数据目录骨架并初始化一个空的 SQLite 数据库（WAL 模式，`PRAGMA user_version = 1`）：

```
<FCA_HOME>\
├─ config\        runtime.json（可选）与自动生成的 runtime-token（勿提交/外传）
├─ db\fca.db      全新空库（无任何记忆）
├─ events\        事件 JSONL 审计日志（运行时生成）
├─ backups\       备份文件（运行时生成）
├─ exports\       导出文件（运行时生成）
├─ logs\          JSONL 脱敏运行日志（运行时生成）
└─ tmp\           临时文件
```

## 空库的事实

- 初始化后 `GET /api/v1/graph` 返回 `nodes: []`、`edges: []`；桌面软件显示「空白星图」提示，不显示任何伪造节点。
- 数据库 health：`GET /api/v1/db/health` 返回 `initialized: true`、`user_version: 1`。
- 如需演示数据，可显式运行 `tools\node.cmd runtime\bin\fca-runtime.js seed --demo`（数据带 `demo=1` 标记，可 `--clear` 清除；它们会出现在 API/星图中，属于真实数据库记录，不是前端假数据）。

## 旧数据

工作目录 `D:\FCA` 下与 FCA 无关的历史项目/旧文件不属于新系统，本项目不读取、不迁移、不修改、不删除；物理删除旧文件必须另行获得用户明确授权。
