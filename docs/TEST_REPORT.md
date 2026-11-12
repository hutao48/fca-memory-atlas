# FCA Alpha 0.1 — 自动化测试报告（QA）

> 项目：FCA Memory Atlas（FCA Local Runtime 0.1.0 / API v1 + Electron 桌面软件 0.1.0 + DSH 正式插件 0.1.0）
> 报告版本：v1.0（QA：qa-tests） · 生成时间：见文末"报告元数据" · 对应冻结契约：`docs/PUBLIC_INTERFACE_FREEZE.md` v1.0
>
> **数据真实性声明**：本报告内所有通过/失败统计、延迟、FPS、内存、DB 大小、错误码、截图，均来自本机真实运行
> （真实 Node 24 子进程 + 真实 HTTP + 真实 SQLite WAL + 真实 Electron WebGL2 窗口）。测试不使用 Mock，性能数字不经过
> 手工"调参"或编造；未覆盖/未执行项在 §12 如实列出。所有测试数据目录隔离在 `.cache/qa-*`，未写入/删除用户真实数据。
> 每次运行的真实机器可读证据见 `artifacts/reports/*.json`（integration-*.json / security.json / e2e-scenarios.json /
> performance.json / render-performance.json / test-run.json 等）。

---

## 1. 结论摘要

| 维度 | 结果 |
|---|---|
| 自动化测试分层 | ✅ unit / integration / e2e / security / performance / install 六层 + Runtime 自带测试组（依赖）全部建立并可一键运行 |
| QA 自建套件用例数 | unit 21 项、integration 44 项、security 17 项、e2e 5 场景 29 项检查、performance 3 数据规模（API）+ 3 数据规模（渲染）、install 5 项 |
| 通过率（最终全量运行） | **`scripts/run-tests.js --all`：7 分组全部 PASS，failed_groups=0**（`generated_at=2026-11-12T08:52:43Z`）：unit 21/21、integration 44/44、security 17/17、e2e 5 场景 29/29、performance 2/2（API+渲染 100/1000/10000）、runtime（依赖组）65/65；install 组该次按设计 SKIP，另对**最终安装包**（sha256 `4df2e774…`，built_at 08:50:50Z，99.0MB）真实安装/卸载冒烟 **5/5 PASS**（`artifacts/reports/install-qa-smoke.json`） |
| 契约覆盖率 | Runtime 实际注册 60 个 HTTP 路由，**59/60 有真实 HTTP 断言**（仅 `/api/v1/health` 别名与 `/health` 同实现未单独断言） |
| 发现并修复的产品缺陷 | 3 个（BUG-1 高 / BUG-2 低 / BUG-3 低-中）全部由 owner 修复，QA 真实 HTTP 复测通过；另 1 个客户端头校验偏差（DEV-1）已修；安装器 INST-2 已由 packaging-docs 在 `installer.nsi` 修复（卸载不再自动 stop），最终包复测记录见 §11 |
| 未修复/已知限制 | ZIP 解压无上限（medium）、路径未限制（low）、CORS `*`、无速率限制等，见 §10/§11 与 `docs/KNOWN_ISSUES.md` |
| 主要性能风险 | 10000 节点下 `GET /graph` 14.3-19.6s / 4.48MB、`POST /layout/recompute` 8.7-13.7s，桌面首屏大库加载不可接受；需在产品中标注容量/优化（§9） |
| QA 发布意见 | **有条件通过**：核心功能/安全门禁（除已知限制）与安装冒烟通过；放行前需 ①packaging-docs 用最终安装包完成 WMI 安装/卸载实测并在 `docs/INSTALL_TEST.md` 落证；②Lead 与 owner 对 `docs/KNOWN_ISSUES.md` 已知限制签字接受。desktop-app 最终 renderer 已冻结并由 QA 重跑 E2E（29/29） |

---

## 2. 测试环境（真实设备）

| 项目 | 实测值 | 来源 |
|---|---|---|
| CPU | AMD Ryzen 7 H 260 w/ Radeon 780M Graphics，8 核 / 16 线程 | `Win32_Processor` |
| 内存 | 15.3 GB 可用物理内存（16 GB 机型） | `Win32_ComputerSystem` |
| 操作系统 | Microsoft Windows 11 专业版，Build 26300 | `Win32_OperatingSystem` |
| GPU | NVIDIA GeForce RTX 5060 Laptop GPU，8151 MB，驱动 610.88 | Runtime `/api/v1/system/status` 的 `nvidia-smi` 真实探测 |
| 桌面渲染 | Electron 38.2.1（`.cache/electron-dist/electron.exe` 211,136,512B），ANGLE/D3D11，WebGL2 + HDR，pipeline=volume | capture stdout 的 `nebula.gpu` 字段 |
| Node | v24.11.0（vendored `vendor/node/node.exe`，含 `node:sqlite`） | `node --version` |
| 磁盘 | D: 可用 910.6 GB（测试数据目录所在盘） | `Get-PSDrive D` |
| 网络/隔离 | 全部 HTTP 走 `127.0.0.1`；测试端口固定 17880-17895（避开 17860 插件 / 17861 桌面）；隔离 `FCA_HOME=.cache/qa-home/qa-*` | 测试代码 `tests/e2e/lib/runtime.cjs` |
| 版本 | Runtime 0.1.0 / API v1 / 桌面 0.1.0 / 插件 0.1.0 | `/health`、`/state`、构建元数据 |

> 测试期间 5 个 teammate 并行工作（Runtime/桌面/插件/打包/QA）；渲染 FPS 会受其它 Electron 实例与系统负载影响，
> 本报告数字为当时真实读数，并在 §9 标注测量方法，不宣称是"极限最优值"。

---

## 3. 测试套件结构与一键运行

| 分组 | 目录 / 文件 | 用例数 | 真实起什么 |
|---|---|---|---|
| unit | `tests/unit/**` | 21 | 真实模块导入：desktop editor 视图纯函数、DSH 插件纯函数（logger/config/capture） |
| integration | `tests/integration/api-core.test.cjs`、`api-ops.test.cjs` | 44 | 真实 Runtime 子进程 + 真实 HTTP（隔离 FCA_HOME） |
| e2e | `tests/e2e/scenarios.test.cjs` | 5 场景 / 29 检查 | 真实 Runtime + 重启持久化 + 真实 Electron 渲染截图 |
| security | `tests/security/security.test.cjs` | 17 | 真实 Runtime + 真实 HTTP 攻击面用例（含 ZIP 炸弹、路径、并发） |
| performance | `tests/performance/api-perf.test.cjs`、`render-perf.test.cjs` | 3 + 3 数据规模 | 真实 API 建 100/1000/10000 条记忆；真实 Electron 渲染性能探针 |
| install | `tests/install/install-smoke.test.cjs` | 5 | 真实 NSIS 静默安装/卸载 + 安装版 Runtime/桌面启动冒烟 |
| runtime（依赖，owner=runtime-core） | `runtime/test/**` | 65 | Runtime owner 自带套件；QA 统一入口纳入并串行执行 |

### 命令（本机无 PATH node，统一用 `tools\node.cmd` 或 `vendor\node\node.exe`）

```powershell
Set-Location D:\FCA\FCA-Memory-Atlas

# 全部分组（QA 推荐入口；结果写 artifacts/reports/test-run.json）
tools\node.cmd scripts\run-tests.js --all

# 分组
tools\node.cmd scripts\run-tests.js --unit
tools\node.cmd scripts\run-tests.js --integration
tools\node.cmd scripts\run-tests.js --security
tools\node.cmd scripts\run-tests.js --e2e            # 需 Electron + 桌面会话
tools\node.cmd scripts\run-tests.js --performance    # 需 Electron（渲染段）
tools\node.cmd scripts\run-tests.js --runtime        # 自动加 --test-concurrency=1

# 安装冒烟（等 packaging-docs 最终包；隔离目录，守卫不误停真实实例）
$env:FCA_INSTALL_TEST='1'; tools\node.cmd --test tests\install\install-smoke.test.cjs

# 单套件直跑（等价）
tools\node.cmd --test tests\integration\api-core.test.cjs
tools\node.cmd --test tests\security\security.test.cjs
```

> `scripts/run-tests.js` 由 QA 扩展为 7 个分组（新增 security/performance/install + runtime 串行参数），
> 自动收集 `*.test.{js,mjs,cjs}`，超时保护（e2e 25min / performance 30min / install 20min 等），并输出
> `artifacts/reports/test-run.json`。`--list` 可预览执行计划。

---

## 4. 最终执行结果汇总（真实统计）

以下为各套件真实运行的统计（完整清单见对应 JSON；全量运行结果以 `artifacts/reports/test-run.json` 为准）：

**最终全量回归（代码冻结后，干净环境）**：`tools\node.cmd scripts\run-tests.js --all` → **7 个分组全部 PASS，failed_groups=0**
（`generated_at=2026-11-12T08:52:43Z`）。分组合计：unit 21/21、integration 44/44、e2e 5 场景 29/29 检查、
security 17/17、performance 2/2 文件（100/1000/10000 节点 API+渲染）、runtime 65/65；install 组在该次运行中因未设置
`FCA_INSTALL_TEST=1` 按设计 SKIP（安装证据见下方单独运行与 packaging-docs 最终包复测）。各分组真实耗时：
unit 0.2s / integration 1.9s / e2e 15.3s / security 3.4s / performance 116.3s / runtime 17.4s。

| 套件 | 运行命令 | 结果 | 耗时（实测） | 证据 JSON |
|---|---|---|---|---|
| 全量（--all） | `tools\node.cmd scripts\run-tests.js --all` | **ALL PASS / 0 失败分组** | 见上 | `artifacts/reports/test-run.json` |
| unit | `--test tests/unit/...`（经 `run-tests.js --unit`） | **21/21 PASS** | ~0.2s | — |
| integration-core | `node --test tests/integration/api-core.test.cjs` | **25/25 PASS** | ~1.3s | `artifacts/reports/integration-core.json` |
| integration-ops | `node --test tests/integration/api-ops.test.cjs` | **19/19 PASS** | ~1.6s | `artifacts/reports/integration-ops.json` |
| security | `node --test tests/security/security.test.cjs` | **17/17 PASS** | ~3.3s | `artifacts/reports/security.json` |
| e2e A/B/D/E/F | `node --test tests/e2e/scenarios.test.cjs` | **5 场景 / 29 检查全部 PASS**（最终 renderer 版本复跑） | ~15.3s（含 2 次 Electron 截图） | `artifacts/reports/e2e-scenarios.json/.md` |
| performance（API） | `node --test tests/performance/api-perf.test.cjs` | **3/3 规模完成（100/1000/10000 节点）** | 全量组内合计 116.3s（API+渲染，串行） | `artifacts/reports/performance.json` |
| performance（渲染） | `node --test tests/performance/render-perf.test.cjs` | **3/3 规模完成（100/1000/10000 节点）** | 同上 | `artifacts/reports/render-performance.json` |
| install（**最终安装包**） | `FCA_INSTALL_TEST=1 node --test tests/install/install-smoke.test.cjs` | **5/5 PASS** | ~14.6s | `artifacts/reports/install-qa-smoke.json` + `.cache/qa-install-final.log`；安装包 sha256 `4df2e7744112c1794d590003be9133afbca5e3c9a339eebf737758d0f3114c1a`（99.0MB，built_at 2026-11-12T08:50:50Z） |
| runtime（依赖组，runtime-core owner） | `node scripts\run-tests.js --runtime`（串行） | **65/65 PASS** | ~17.4s | `artifacts/reports/test-run.json` |

**说明**：`integration-ops` 从 18 项增至 19 项（新增"真实本地 HTTP 上游 LLM complete/queue retry 成功路径"）；
`api-core` 为 25 项（`GET /memory/{id}?version=` 与 `GET /relations/{id}` 断言并入现有用例）。
**历史失败说明**：2026-11-12T08:48Z 曾出现 integration 401，经定位为 QA 测试基建的端口竞争缺陷
（Windows SO_REUSEADDR 下 bind 探测误判 + pid 一致性校验缺失），**非产品回归**；已修复并使 QA 套件每次启动都校验
`/health.pid == 子进程 pid`、冲突自动换端口重试（见 §11 TEST-2）。修复后并发直跑 integration 44/44、全量 `--all` 全绿。

---

## 5. 契约覆盖矩阵（Runtime HTTP API）

Runtime 实际注册 **60 个路由**（`runtime/src/api/routes/*` 54 条 + `runtime/src/llm/routes.js` 7 条，覆盖旧 LLM 兜底 7 条）。QA 断言来源：`I`=integration、`S`=security、`E`=e2e、`P`=performance。

| 端点组 | 路由数 | 覆盖 | 主要验证点 |
|---|---|---|---|
| `/health`、`/api/v1/health` | 2 | I（`/health`） | 免认证、`status/version/api_version/initialized/db`、degraded 状态（E2E-F） |
| `/api/v1/state` | 1 | I/E | identity/cognition/counts/catalogs/capabilities/sync 与真实计数一致；注入后无污染 |
| `/api/v1/event` | 1 | I/S | 事件信封字段、`client_event_id` 幂等（含 10 并发）、payload 上限、非法 actor |
| `/api/v1/events/stream` | 1 | I | SSE 首帧 heartbeat/fca.ready、`fca.event`/id=seq、250ms 心跳（测试环境变量）、`Last-Event-ID` 补发、`types` 过滤、无 token 拒绝、query token |
| `/api/v1/memory/store` | 1 | I/S | 完整字段创建、标签/实体/项目/情绪归一、422 字段校验矩阵、413/415/400 |
| `/api/v1/memory/search` | 1 | I | fulltext/semantic/hybrid 三模式、filters、took_ms、无结果 |
| `/api/v1/memories` | 1 | I | q/类型/标签/参与者(ID)/项目/时间/sort/cursor 分页/include_deleted/only_deleted |
| `/api/v1/memory/{id}` GET/PATCH/DELETE | 3 | I/S/E | 详情 relations/layout/versions_count；`?version=` 历史快照；乐观并发 409；软删/硬删 403/410；并发 12 PATCH 仅 1 成功 |
| `/api/v1/memory/{id}/restore` | 1 | I | 回收站恢复 |
| `/api/v1/memory/{id}/merge`、`/split` | 2 | I | prepend_sources 合并+源软删；split 生成多条新记忆；非法参数 422 |
| `/api/v1/memory/{id}/versions`、`/diff` | 2 | I/E | 版本快照/change_kind/diff RFC6902；重启后仍可追溯（E2E-D） |
| `/api/v1/tags` | 1 | I | 目录 id/name/count、`?q=` |
| `/api/v1/entities`（列表/新建/详情/PATCH/DELETE） | 5 | I | 创建/列表过滤/详情/乐观并发/重复 409 DUPLICATE/软删 |
| `/api/v1/relations`（列表/详情/新建/PATCH/DELETE） | 5 | I | 独立关系实体、过滤查询、乐观并发、软删不删两端 |
| `/api/v1/identity`、`/cognition` | 4 | I | 版本化更新（stale 409）、mode 枚举校验、模拟状态标注 |
| `/api/v1/timeline` | 1 | I/E | day/month 分桶、items/range、非法 granularity 422 |
| `/api/v1/graph` | 1 | I/E/P | 渲染契约全字段、坐标边界 [-5000,5000]/[-800,800]、边端点合法性、clusters/color_hint/stats、filters、10k 节点真实加载 |
| `/api/v1/layout/nodes`、`/recompute`、`/reset`、`/views` | 7 | I/E | 坐标持久化、pinned 在 recompute 后保留、reset 清除手动坐标、命名视图 CRUD、非法 node_kind 422 |
| `/api/v1/system/status` | 1 | I | DB/存储/GPU/LLM/客户端/错误统计/内存；记录真实 RTX 5060 |
| `/api/v1/backup`、`/backups`、`/restore`、`DELETE /backups/{id}` | 4 | I/E/S | 创建+sha256+manifest 落盘、列表 valid/checksum_ok、损坏备份拒绝 RESTORE_FAILED、删除需 confirm、restore 往返+DB 损坏恢复（E2E-F）、backup_id 无路径穿越 |
| `/api/v1/export`、`/import` | 2 | I/S | json/jsonl/zip 三格式真实写盘与计数、filters、导入自身格式 ID 重映射、旧格式 422、损坏 ZIP/缺 manifest 422、zip-slip 不落盘、解压炸弹风险实测 |
| `/api/v1/db/init`、`/health`、`/migrations`、`/vacuum` | 4 | I/E | 幂等 init、integrity_check ok、迁移记录、vacuum |
| `/api/v1/logs` | 1 | I/S | 脱敏日志尾部、token/api_key 不落日志（接口+磁盘双查） |
| `/api/v1/shutdown` | 1 | I/S | dsh-plugin 403；cli 优雅关闭→子进程 exit 0→/health 不可达；仅关闭本测试实例端口 |
| `/api/v1/llm/providers`（CRUD） | 4 | I | Key 加密落库+掩码返回（`sk-***-…`）、重复 409、PATCH 改 base_url、删除 |
| `/api/v1/llm/complete`、`/queue`、`/queue/{id}/retry` | 3 | I/E | 未配置/不可达→202 queued（不伪造输出）；本地 stub 上游→200 真实文本+usage；retry 不可达 202 / 改配置后 200 completed；离线队列持久化；本地读写不受影响 |

**未覆盖的 1 条**：`GET /api/v1/health`（`/health` 别名，同 handler 同实现，未单独断言）。

---

## 6. 单元测试（21 项，真实模块导入）

| 文件 | 数量 | 覆盖内容 |
|---|---|---|
| `tests/unit/desktop/editor.test.js` | 13 | editor 视图导出契约、草稿校验（标题/时间/数值/标签/人物/情绪/结束时间）、payload 归一、日期时间转换、Markdown 渲染、**XSS 变体**（script/img/svg/onerror/javascript:/JaVaScRiPt:/data:/vbscript:/引号注入）、行级 diff（LCS）、RFC6902 摘要、memoryToDraft 往返 |
| `tests/unit/plugin/plugin-pure.test.js` | 8 | DSH 插件纯函数：`createRedactor`（Bearer/sk-*/Authorization/secret 字段/自定义模式/非法正则 warn）、`safeJson`（截断/循环引用）、`eventTypesForPolicy`（off→full 映射、返回副本）、`normalizeConfig`（默认值、URL 校验、策略枚举、1MB/5000 上限裁剪、类型严格回退）、契约常量（PLUGIN_VERSION/CLIENT_ID/DEFAULT_RUNTIME_URL） |

> 交接说明：原 `editor.test.js` 的 XSS 用例曾失败（断言 `!html.includes('javascript:')`）。
> QA 判定为**测试断言过严而非产品 XSS**：`renderMarkdown` 先整体 HTML 转义，链接仅允许 `https?://`，
> `javascript:` 文本会作为纯文本保留（无 `<a href>`、无事件属性），不可执行。已把断言改为"危险标签/危险 href/事件属性"
> 的安全语义断言，并新增 8 种 XSS 变体防回归。

---

## 7. 集成测试（44 项，真实 Runtime 子进程 + 真实 HTTP）

- 隔离：每个套件独立 `FCA_HOME=.cache/qa-home/qa-integration-*`、固定端口优先 17880-17895、启动后校验
  `/health.pid == 子进程 pid`，拒绝复用非本次启动的 Runtime（防止误连/误关其它实例）。
- 覆盖：见 §5 矩阵；关键深度用例：
  - 乐观并发：`PATCH expected_version` 正确递增；过期版本 409 `VERSION_CONFLICT` + `details.current_version`；12 并发仅 1 成功。
  - 版本/历史：`versions` 快照+diff、`?version=` 历史读取、非法版本 422。
  - 备份/恢复：真实 SQLite `VACUUM INTO`、sha256/manifest、损坏备份被校验拒绝（500 RESTORE_FAILED）、恢复往返数据回到备份时点、`requires_restart:false`。
  - 导出/导入：json/jsonl/zip 三格式真实文件与计数一致、导入自身格式 ID 重映射、旧记忆系统格式拒绝 422。
  - SSE：首帧 heartbeat/fca.ready、250ms 心跳、`Last-Event-ID` 补发、`types` 过滤。
  - 错误码矩阵：400 BAD_REQUEST / 401 UNAUTHORIZED / 403 FORBIDDEN / 404 NOT_FOUND / 405 METHOD_NOT_ALLOWED / 409 VERSION_CONFLICT+DUPLICATE / 410 GONE / 413 PAYLOAD_TOO_LARGE / 415 UNSUPPORTED_MEDIA_TYPE / 422 VALIDATION_FAILED / 500/503（E2E-F 的 DATABASE_ERROR）均按契约真实命中。
  - LLM Gateway：Provider Key 加密落库+掩码；不可达→202 入队（offline:true, 无伪造文本）；本地 stub OpenAI-compatible 上游→200 `text/usage/model`；queue→retry 成功 200 completed。
  - 系统：`system/status` 真实 `nvidia-smi` GPU 探测（RTX 5060 / 8151MB / 610.88）。

---

## 8. E2E 验收场景 A/B/D/E/F（真实 Runtime + 真实 Electron 截图）

权威数据：`artifacts/reports/e2e-scenarios.json` + [e2e-scenarios.md](../artifacts/reports/e2e-scenarios.md)（29/29 检查通过）。

| 场景 | 验收要求 | 实测结果 | 证据 |
|---|---|---|---|
| **A 空库无假数据** | 全新 FCA_HOME：无任何节点/实体/演示数据；UI 空态不得显示假节点 | `graph.nodes=0 edges=0 clusters=0`；`counts.memories/entities/relations/demo=0`；`catalogs.tags=[]`；UI 截图 `source=runtime`、`nodes=0`、"空白星图"提示、无 fatal、FPS=165（frame 6.06ms, p95 6.2ms） | [qa-e2e-A-empty.png](../artifacts/reports/e2e/qa-e2e-A-empty.png)（3,025,140B，capture 4.0s，exit=0） |
| **B 手动创建人物/经历/关系 → 重启持久化+布局** | 手动建立人物/经历/关系；拖动星体保存布局；重启后数据与布局恢复 | 创建 person+place+经历记忆+关系；保存 pinned 坐标 (120.5,-340.25,12.5)；重启后 memory/entity/relation 全恢复、pinned 坐标一致、`layout_version` 持久；UI 截图 `source=runtime`、`nodes=4 edges=3 clusters=2`、FPS=61.1（frame 16.36ms, p95 30.4ms，负载敏感见 §9.2）、无 fatal | [qa-e2e-B-atlas.png](../artifacts/reports/e2e/qa-e2e-B-atlas.png)（3,354,944B，capture 4.9s） |
| **D 编辑同步+版本历史** | 编辑实时同步（SSE）+ 版本历史/diff + 重启后可追溯 | PATCH v1→v2；SSE 实时收到 `memory.updated`（subject=该记忆, seq=5）；versions v2:update/v1:create；diff(1→2) 含 `/title` `/importance`；重启后版本仍 2 条且当前为编辑后内容 | `e2e-scenarios.json` 场景 D |
| **E LLM API 断开本地可读写** | LLM 不可达时本地功能不受影响，不伪造输出 | Provider 指向死端口；`/llm/complete`→202 `queued:true/offline:true/reason=provider_unavailable` 且无 text；离线期间读/写/搜索/布局全部成功；重启后离线队列与本地记忆持久、继续可写 | `e2e-scenarios.json` 场景 E |
| **F 备份→损坏→恢复** | 备份后模拟数据库损坏，恢复校验成功 | 备份 sha256/manifest 校验；写坏 `db/fca.db`（删 WAL/SHM）；损坏期 `/health=degraded(db=error)`、业务端点 503 DATABASE_ERROR（不返回假数据）；`POST /restore`→200 restored、无需重启；备份时点记忆存在、备份后新增消失、`db/health ok` | `e2e-scenarios.json` 场景 F |

> 复用 desktop-app 的视觉验收截图（同一真实 Runtime 数据，194 节点/382 关系/22 聚类，source=runtime）：
> `artifacts/screenshots/final-atlas-overview.png`、`final-atlas-clusters.png`、`final-atlas-detail.png`、
> `final-atlas-focus.png`、`final-atlas-legend.png`、`final-atlas-quality-off.png`；
> 空库独立证据 `artifacts/screenshots/final-atlas-empty.png`（nodes=0，无假数据）。

---

## 9. 性能测试（真实数据，非编造）

### 9.1 Runtime API（100 / 1000 / 10000 节点；数据经公开 API 真实创建，SQLite WAL）

| 规模 | 建数据耗时 | layout recompute（HTTP / runtime took） | GET /graph（HTTP / 载荷 / 边） | 搜索 p50（fulltext / hybrid） | 搜索 p95（hybrid） | PATCH p50 / p95 | 列表50 p50 | /state | DB 大小 | Runtime RSS |
|---|---|---|---|---|---|---|---|---|---|---|
| 100 | 0.31s | 41.2ms / 37.7ms | 15.9ms / 0.05MB / 7 | 3.5ms / 5.3ms | 20.1ms | 3.5ms / 10.7ms | 6.1ms | 3.0ms | 0.8MB | 71.1MB |
| 1000 | 2.48s | 138.1ms / 135.8ms | 94.2ms / 0.45MB / 70 | 5.9ms / 15.6ms | 19.8ms | 2.8ms / 6.4ms | 6.3ms | 2.0ms | 5.2MB | 95.9MB |
| 10000 | 27.6s | **13,739.5ms / 13,731.2ms** | **19,572.3ms / 4.48MB / 700** | 57.6ms / **177.3ms** | **532.0ms（负载尖峰）** | 4.4ms / 7.3ms | 28.7ms | 57.5ms | 49.9MB | 316.9MB |

（以上为**最终全量回归**（代码冻结后）实测；建数据累计 ~30.4s；测试脚本 `tests/performance/api-perf.test.cjs`，
结果 `artifacts/reports/performance.json`。**负载敏感/跨轮区间**：本机 5 个 teammate 并行，10000 节点三轮实测
layout 8.7s→13.7s、GET /graph 14.3s→19.6s、hybrid 搜索 p50 127→177ms、/state 16.9→57.5ms、RSS 275→317MB；
两种读数均为真实值，报告取最终一轮并在正文标注区间，不取"最优值"。）

**瓶颈分析（真实观测）**
1. **`GET /graph` 是 10000 节点的首要瓶颈**：14.3-19.6s（随机器负载波动）、4.48MB JSON（含 9 聚类/700 关系/10002 节点坐标与标签）。桌面首屏同步会阻塞十余秒，用户感知为"大库打不开"。建议：图数据分页/LOD（viewport 内请求）、客户端增量 sync（事件驱动）、压缩（gzip/二进制）、聚类质心预计算缓存。
2. **布局重算 8.7-13.7s @10000**：force_v1 为同步 HTTP 请求，期间其他请求排队。建议：放到 worker 线程/后台任务 + 进度事件，或改为分批增量布局；桌面只在用户显式点击"自动布局"时触发。
3. 搜索 hybrid p50 127-177ms @10000（语义哈希 + FTS5 组合），负载尖峰下 p95 可达 532ms；可接受但已接近交互阈值，建议候选集分层/缓存与耗时监控。
4. 写入（PATCH）延迟稳定在 ~2.8-4.4ms（不随规模恶化），SQLite WAL + 事务设计良好；`/state` 在 10k 节点/高负载下 16.9-57.5ms。
5. 内存 275-317MB / DB 49.9-51.5MB @10000 节点，资源占用健康（占 16GB 机器 ~2%）。
6. 说明：测试数据为合成均匀分布（每 1/20 带参与者、每 1/10 带标签），真实用户的聚类/标签分布可能不同；该结果为"给定实现、给定数据"的真实测量，不保证普适。

### 9.2 桌面渲染（真实 Electron 38.2.1 + WebGL2 + ANGLE/D3D11，RTX 5060 Laptop）

| 节点规模 | 图谱节点/边 | FPS（capture 会话读数） | 平均帧时间 | p95 帧时间 | draw calls | 渲染节点/边 | 画质 | 截图 |
|---|---|---|---|---|---|---|---|---|
| 100 | 102 / 4 | 51.4 | 19.44ms | 42.5ms | 17 | 102 / 4 | high | [render-100.png](../artifacts/reports/perf/render-100.png) |
| 1000 | 1002 / 40 | 93.4 | 10.71ms | 24.4ms | 17 | 1002 / 40 | high | [render-1000.png](../artifacts/reports/perf/render-1000.png) |
| 10000 | 10002 / 700 | 53.5 | 18.69ms | 36.5ms | 17 | 10002 / 700 | high | [render-10000.png](../artifacts/reports/perf/render-10000.png) |

**测量方法（重要，避免误读）**：FPS/帧时间来自桌面真实全局 `window.__FCA_APP__.getNebulaStats()`（Renderer 暴露的性能探针），
由 `desktop/main/capture.js` 在等待图谱落定后读取并随截图一起输出。读数是 **capture 会话内累计平均**（含 Electron 启动/着色器编译/首屏加载阶段），
因此 100/1000 节点的数字会被启动阶段拉低；10000 节点由于等待图谱落定时间更长，稳态帧占比较高。
**负载敏感性/跨轮区间**：同一代码三轮实测 100 节点 FPS 51.4-98.5、1000 节点 52.1-93.4、10000 节点 53.5-115.1
（并行 teammate 的 Electron/CPU 负载与 capture 启动阶段占比不同）；该指标只作"渲染可用性/稳定性"判断，不是跑分基准。
交叉验证：desktop-app 单独的 194 节点 capture 实测 FPS 71-118 / frame 8.5-14ms。
结论：在当前 GPU 上，全部三档规模均保持 `quality=high`、17 draw calls、无 WebGL context lost、无 fatal；
渲染层未见随规模崩溃/明显劣化，真正的大库瓶颈在 Runtime `/graph`（§9.1），而非 GPU 绘制。

---

## 10. 安全测试（17 项）与风险清单

`artifacts/reports/security.json`（17/17 通过）。所有用例针对真实 Runtime 的 HTTP 攻击面，非静态扫描。

| 类别 | 用例 | 结果 |
|---|---|---|
| 认证 | 10 个受保护端点无 token/错误 token → 401；`/health` 免认证；query token 仅 SSE 允许；SSE 无 token 拒绝 | PASS |
| Token | token 文件 64 hex；不出现在 `/health`、`/state` 响应 | PASS |
| 回环 | 配置层拒绝监听非回环地址（`--host=0.0.0.0` 无 allow-remote → 启动失败）；仅监听 127.0.0.1，LAN IP 不可达 | PASS |
| 路径穿越 | 导出/导入相对 `..` 可逃逸 exportsDir、绝对路径可用（行为记录→风险 SEC-PATH）；backup_id 无穿越（404） | PASS（风险已记录） |
| ZIP | 非 ZIP/缺 manifest/非法格式 → 422 IMPORT_FAILED；zip-slip 条目不解压落盘；64MB 解压炸弹被完整解压（风险） | PASS（风险已记录） |
| 并发 | 12 并发同版本 PATCH → 1×200 + 11×409；10 并发同 `client_event_id` → 1×201 + 9×200 duplicate 同 ID | PASS |
| 权限 | 硬删除仅限 user 角色：dsh-plugin 客户端 403，cli 允许 | PASS |
| 输入健壮性 | 事件 payload >256KB → 422；缺 type → 400/422；`__proto__` 注入不污染全局；异常 URI（`%2e%2e`、`%00`、编码反斜杠）不产生 500 | PASS |
| CORS | OPTIONS/普通响应 `Access-Control-Allow-Origin: *`（含 Authorization 允许头） | PASS（风险已记录） |
| 日志脱敏 | 接口日志+磁盘日志均无 runtime token / LLM api_key / 未脱敏 Bearer / SSE query token | PASS |
| 限流 | 30 次错误 token 均 401，未实现 RATE_LIMITED(429) | PASS（记录为缺失能力） |

**风险项（已同步 `docs/KNOWN_ISSUES.md`）**

| ID | 等级 | 描述 | 缓解/建议 |
|---|---|---|---|
| SEC-ZIP-BOMB | **medium** | ZIP 导入无解压上限：实测 ~70KB 合法 ZIP 被完整解压 64MB（≈1000:1，559ms），可构造 GB 级内存/CPU 放大 | readZip 限制单条目/总解压字节与条目数、检测压缩比；Alpha 0.1 至少文档标注 |
| SEC-PATH | low | `/export`、`/import` 的 `path` 未限制在 `FCA_HOME/exports`（可写/读任意本机路径，需回环+Bearer token） | 路径白名单/禁 `..` 与绝对路径，或文档明确"本地可信 API" |
| SEC-CORS | info | CORS 允许任意 Origin；token 在本地文件，浏览器未持有则风险低 | Origin 白名单 |
| SEC-NO-RATE-LIMIT | info | 未实现 429 限流 | Loopback+token 模型下可接受，文档标注 |
| CLIENT-KIND | info | `X-FCA-Client` 仅客户端标识不是安全边界（真实边界=仅回环+Bearer token；shutdown 白名单可被本地调用方自称） | 已在 Runtime 注释/KNOWN_ISSUES 明确 |

---

## 11. 发现缺陷与修复验证

> 全部缺陷均为真实运行复现，最小复现命令/脚本随附；修复后由 QA 以真实 HTTP 复测。状态=截至本报告生成时。

| ID | 等级 | 现象 | 最小复现 | 状态 / QA 复测 |
|---|---|---|---|---|
| **BUG-1** | 高 | `POST /api/v1/llm/queue/{id}/retry` 必 500 `INTERNAL: queue.getRow is not a function`（`runtime/src/llm/routes.js:442` 调用 queue 未导出方法） | `.cache/qa-tools/llm-probe.cjs`：provider(死端口)→complete 202→retry → 500 | **已修复**（runtime-core 导出 getRow + errors details）。QA 复测：retry 仍不可达→202 queued；改 base_url 到本地 stub 上游后 retry→200 `completed:true/text`（integration-ops 19/19） |
| **BUG-2** | 低 | `POST /api/v1/import {"path":123}` 返回 500 INTERNAL（`path.isAbsolute` 类型错误未归一化），契约要求 400 BAD_REQUEST | `curl`-等价：`POST /import {"path":123}` | **已修复**（import/export path 类型校验）。QA 复测：400 BAD_REQUEST（integration-ops） |
| **BUG-3** | 低-中 | 导入结构损坏 ZIP（非 ZIP / 缺 EOCD / 中央目录损坏）返回 500 INTERNAL，契约要求 422 IMPORT_FAILED；ZIP 内 JSON 解析失败同样 500 | 写 `<FCA_HOME>\exports\garbage.zip`（ASCII 文本）→ `POST /import {"path":...}` → 500 | **已修复**（readZipSafe/parseJsonSafe → 422，事务前解析不写数据）。QA 复测：security 17/17，损坏 ZIP/JSON → 422 |
| **DEV-1** | 低 | 非法 `X-FCA-Client`（如 `evil-client`）被静默忽略按 cli 处理（`normalizeClientKind()` 定义了但未调用） | `GET /api/v1/state` + `X-FCA-Client: evil-client` → 200 | **已修复**（启用 normalizeClientKind）。QA 复测：400 BAD_REQUEST；合法值 desktop/dsh-plugin/cli/test 仍 200 |
| **ENV-1** | 中（环境） | `tools/node.cmd` 被写成 LF 行尾+非 ASCII 注释，cmd.exe 解析失败（文档中的标准命令不可用） | `cmd /c "tools\node.cmd --version"` → 多条 `not recognized` | **已修复**（Lead 转 CRLF）。QA 复测：输出 `v24.11.0` |
| **ENV-2** | 中（构建环境） | NSIS 3.04（x86）在系统 `%TEMP%`（C 盘）编译 >32MB 大文件时触发 `Internal compiler error #12345: error creating mmap`；默认临时目录编译必失败 | `makensis` 使用系统 TEMP 编译 Electron 211MB 主程序 → 立即失败 | **已修复**（`installer/build.js` 将 TEMP/TMP 指向项目内 `.cache`/staging 目录，已产出 Setup.exe）。QA 侧记录为构建环境事实，非产品缺陷 |
| **TEST-1** | 低（测试基建） | runtime-core 自带 `runtime/test` 10 个文件并行运行时 4 例失败（CLI 子进程用例对默认端口/临时目录有串行假设），串行后全绿；runtime-core 后续又修复了 1 条负载敏感断言 | `node --test runtime/test`（默认并发）4 fail；`--test-concurrency=1` 全过 | **已规避**：`scripts/run-tests.js` 对 runtime 组固定 `--test-concurrency=1`；最终全量运行 runtime **65/65 PASS** |
| **TEST-2** | 中（测试基建） | 08:48Z 一次全量运行中 integration 多用例 401 UNAUTHORIZED（token 不匹配）、integration-ops total=0。根因：多测试文件并发时抢到同一端口；Windows 下 Node 监听默认 SO_REUSEADDR 语义使"bind→close"空闲探测漏判，serve 子进程 EADDRINUSE 退出后 health 探测命中"别人"的 Runtime（token 不同 → 401），且 pid 一致性校验缺失 | 并发直跑两个 integration 文件即可复现（401 批量失败） | **已修复（QA 测试代码）**：端口分配叠加 `/health` 探测跳过被占用端口；启动后强制 `/health.pid === 子进程 pid`，冲突自动换端口重试（≤3 次）。验证：并发直跑 integration 44/44，全量 `--all` 全绿。**非产品回归** |
| **INST-2** | 中（产品） | NSIS 卸载器/安装器内置 `fca-runtime stop --fca-home="%LOCALAPPDATA%\FCA-Memory-Atlas"` 使用**编译期固定默认数据目录**，不是用户实际 dataDir。QA 在隔离目录安装/卸载时，卸载器读取真实 pid 文件并把用户真实 Runtime(17860) 停掉（实测 08:36:18Z, client=cli，干扰 DSH 插件采集验证；数据未损坏） | 隔离目录静默安装→`Uninstall.exe /S`→观察真实 17860 实例被 shutdown | **已修复（产品侧）**：packaging-docs 已修改 `installer/installer.nsi` —— 卸载器与升级安装均**不再自动 stop Runtime**（检测到 pid 只提示、由桌面 closeRuntimeOnExit 负责）。**QA 在最终包复测**：卸载日志无 "stopping bundled runtime" 步骤（仅 `uninstall completed` / `policy: ...`）；最终包安装/卸载冒烟 5/5 PASS，且测试期间真实 17860 未运行、未触发任何 stop。负向验证（"真实 17860 正在运行时卸载也不误停"）受隔离约束不能直接对着真实数据目录构造，结合 `installer.nsi` 静态审查与 packaging-docs WMI 实测报告共同证明；若后续有带真实实例的验收窗口可再实测一次 |
| **INST-3** | info（环境） | 从 DSH 工具 shell 直接 spawn NSIS 时进程运行在 Low IL + CodexSandboxUsers：`%TEMP%` 重定向到 `%TEMP%\Low`、HKCU/快捷方式写入被静默丢弃；卸载日志可能出现交错/截断 | DSH pwsh → node → Setup.exe；观察 `%TEMP%\Low\fca-install.log`、HKCU 无卸载项 | **环境限制，非产品缺陷**：正式安装证据以 packaging-docs 的 WMI（Medium IL）实测报告为准；QA 安装用例不据此断言注册表/快捷方式 |

---

## 12. 未覆盖项与限制（如实列出）

1. **真实云端 LLM API 未测**：无 DeepSeek/OpenAI API Key。已覆盖：离线/不可达→202 入队不伪造输出、本地 stub OpenAI-compatible 上游→200 真实文本+usage、queue retry 成功/失败路径；**未覆盖**真实云端网络/鉴权/速率/长上下文表现。
2. **DSH 插件最终安装与端到端采集**：由 dsh-plugin owner 负责（`docs/PLUGIN_INTEGRATION_TEST.md` / `docs/DSH_PLUGIN_ENVIRONMENT_REPORT.md`）；QA 只覆盖插件纯函数单测（脱敏/采集策略/配置校验）。本次 QA 未重复执行插件在 Harness 内的真实安装采集（避免并行冲突）。
3. **安装/卸载最终证据**：QA 已在**最终安装包**（sha256 `4df2e774…`，built_at 2026-11-12T08:50:50Z，99.0MB，docs 齐全）上完成真实静默安装→校验→安装版 Runtime 冒烟→已安装桌面启动→静默卸载，**5/5 PASS**（`artifacts/reports/install-qa-smoke.json`）。环境限制：QA 从 DSH 工具 shell 启动 NSIS 为 Low IL，`%TEMP%` 重定向、HKCU 卸载项/快捷方式写入被沙箱静默丢弃，因此**注册表/开始菜单/桌面快捷方式**的完整证据以 packaging-docs 的 WMI（Medium IL）实测报告与 `docs/INSTALL_TEST.md` 为准；QA 不据此断言注册表/快捷方式。
4. **视觉质量主观性**：已用真实渲染截图 + 探针（FPS/帧时间/draw calls/quality/context lost）验证"真实渲染、无假数据、性能可用"；**未做**像素级视觉回归（无基线图 diff）、未做多分辨率/DPI 缩放/色盲/暗色主题对比度等 UI 可用性专项测试。
5. **长时间稳定性**：未做 soak test（小时级运行/内存泄漏/事件日志长期滚动/WAL checkpoint 压力）；仅做了 10000 节点单轮压力与重启持久化。
6. **故障注入范围有限**：已覆盖 DB 文件损坏、备份损坏、LLM 网络不可达；**未覆盖**磁盘满、写权限拒绝、进程被强杀时 WAL 恢复、迁移失败回滚、备份 restore 回滚失败分支、schema 版本高于当前拒绝路径。
7. **并发/多客户端**：覆盖 HTTP 层并发 PATCH/事件幂等；**未覆盖**真实"桌面 UI + DSH 插件 + CLI 同时写"的长时竞争，以及多窗口桌面实例。
8. **平台**：仅 Windows 11 x64（Electron/NSIS 均为 Windows 产物）；无 Linux/macOS 验证。
9. **安装包签名**：未验证 Authenticode 签名/篡改检测（Alpha 内部版本，安装包 sha256 已校验）。
10. **代码覆盖率**：未接入 c8/istanbul 的语句/分支覆盖率统计；覆盖率以"契约端点/场景清单"衡量（§5）。
11. **rate-limit / ZIP 炸弹 / 路径限制**：见 §10 风险；当前实现不阻断，属已知限制而非通过项。
12. **测试环境噪声**：5 个 teammate 并行、其它 Electron/Runtime 实例可能运行；render FPS 为 capture 会话读数（方法见 §9.2），非隔离基准台架。

---

## 13. 产物索引与复现

| 产物 | 路径 |
|---|---|
| 测试入口（全组） | `scripts/run-tests.js`（`--all/--list/--unit/--integration/--e2e/--security/--performance/--install/--runtime`） |
| 单元测试 | `tests/unit/desktop/editor.test.js`、`tests/unit/plugin/plugin-pure.test.js` |
| 集成测试 | `tests/integration/api-core.test.cjs`、`tests/integration/api-ops.test.cjs` |
| E2E 测试 | `tests/e2e/scenarios.test.cjs`（+ `tests/e2e/lib/{common,runtime,capture}.cjs`） |
| 安全测试 | `tests/security/security.test.cjs`（+ `tests/lib/zip-build.cjs` 构造 ZIP） |
| 性能测试 | `tests/performance/api-perf.test.cjs`、`tests/performance/render-perf.test.cjs` |
| 安装测试 | `tests/install/install-smoke.test.cjs`（`FCA_INSTALL_TEST=1` 启用） |
| 机器可读报告 | `artifacts/reports/{test-run,integration-core,integration-ops,security,e2e-scenarios,performance,render-performance}.json` + `e2e-scenarios.md`；安装证据 `artifacts/reports/install-qa-smoke.json`、`artifacts/reports/install-build-2026-11-12T08-50-50-635Z.json`、`.cache/qa-install-final.log` |
| E2E/渲染截图 | `artifacts/reports/e2e/qa-e2e-A-empty.png`、`qa-e2e-B-atlas.png`；`artifacts/reports/perf/render-{100,1000,10000}.png`；视觉验收 `artifacts/screenshots/final-*.png` |
| 已知问题 | `docs/KNOWN_ISSUES.md`（含 KI-SEC-01..07、BUG 状态、INST-2/INST-3 环境与产品限制） |
| 复现隔离数据 | `.cache/qa-home/qa-*`（Runtime/集成/E2E/渲染数据集）、`.cache/qa-tools/llm-probe.cjs`（BUG-1 最小复现） |

**环境限制说明**：本机无 PATH node；所有命令使用 `tools\node.cmd`（vendor Node v24.11.0，已由 Lead 修复 CRLF）。
Electron 测试必须清除 `ELECTRON_RUN_AS_NODE` 并添加 `--no-sandbox`；本报告中的 capture 均按此执行。

---

### 报告元数据

- 生成者：QA（qa-tests）
- 生成方式：真实命令运行后汇总 `artifacts/reports/*.json` + 终端输出 + 真实截图；不手工编造数据
- 报告生成时间：2026-11-12 17:59（Asia/Tokyo）；对应最终全量回归 generated_at=2026-11-12T08:52:43Z 与最终安装包 built_at=2026-11-12T08:50:50Z
- 关联冻结契约：`docs/PUBLIC_INTERFACE_FREEZE.md` v1.0
- 关联文档：`docs/KNOWN_ISSUES.md`、`docs/ENVIRONMENT_REPORT.md`、`docs/PLUGIN_INTEGRATION_TEST.md`、`docs/USER_MANUAL.md`
