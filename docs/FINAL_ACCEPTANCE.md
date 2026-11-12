# FCA Alpha 0.1 — 最终验收报告（Lead）

- 验收时间：2026-11-12（Asia/Tokyo）
- 项目：`D:\FCA\FCA-Memory-Atlas`
- 结论：**Alpha 0.1 三件套交付完成** —— FCA Memory Atlas Windows 桌面软件（可安装/可卸载）、FCA Local Runtime（本地认知服务）、FCA DSH 正式插件（真实安装并验证）。全部关键项为真实运行证据；已知限制在末尾如实列出。
- 本报告由 Team Lead 在代码冻结后独立复核各任务组产出（含重跑命令与抽查），不替代各专题报告。

---

## 1. 交付物清单

| 交付物 | 路径 | 状态 |
|---|---|---|
| 桌面软件安装包（Windows x64, per-user, NSIS + 卸载器） | `artifacts/installer/FCA-Memory-Atlas-Setup-0.1.0-x64.exe`（99.0 MB，sha256 `4df2e7744112c1794d590003be9133afbca5e3c9a339eebf737758d0f3114c1a`） | ✅ 可安装/可启动/可卸载 |
| 安装包校验文件 | `artifacts/installer/FCA-Memory-Atlas-Setup-0.1.0-x64.sha256.json`、`artifacts/reports/install-build-2026-11-12T08-50-50-635Z.json` | ✅ |
| 桌面软件源码 | `desktop/`（Electron 38 主进程 + ESM renderer + WebGL2 星云） | ✅ frozen |
| FCA Local Runtime 源码 + CLI | `runtime/`（Node 24 + `node:sqlite`，零第三方运行时依赖；`bin/fca-runtime.js`） | ✅ frozen |
| DSH 正式插件包（npm pack） | `artifacts/plugin/dsh-plugin-fca-memory-0.1.4.tgz`（38,161 B，sha256 `4005ECF3F966F611C75B5747DA71B0A64AFA352D8B2EC2A68C2C5567460D6553`；v0.1.4 含完全自动添加记忆） | ✅ 已安装到 DSH profile 并验证 |
| 插件源码 | `dsh_plugin/`（bundle：`cordis.patch.yml` + `main.js` + `src/`） | ✅ frozen |
| 真实运行截图（21 张） | `artifacts/screenshots/final-*.png`（2379×1406，真实产品 `capturePage()`） | ✅ |
| 录屏 | `artifacts/recordings/fca-atlas-nebula.webm`（VP9，10s，真实 renderer+Runtime）、`desktop-interaction-sequence.gif` | ✅ |
| 测试与性能报告 | `docs/TEST_REPORT.md`（38.6KB）、`artifacts/reports/test-run.json`、`performance.json`、`render-performance.json` | ✅ |
| 插件环境/集成报告 | `docs/DSH_PLUGIN_ENVIRONMENT_REPORT.md`、`docs/PLUGIN_INTEGRATION_TEST.md`（T1–T17） | ✅ 真实环境证据 |
| 安装实测报告 | `docs/INSTALL_TEST.md` | ✅（见其正文） |
| 用户手册 / 已知问题 / 架构 / API / 环境 / 接口冻结 | `docs/USER_MANUAL.md`、`docs/KNOWN_ISSUES.md`、`docs/ARCHITECTURE.md`、`docs/API.md`、`docs/ENVIRONMENT_REPORT.md`、`docs/PUBLIC_INTERFACE_FREEZE.md`、`docs/adr/` | ✅ |
| 配置样例 / 空库模板 | `config/`、`data_template/` | ✅ |
| 开发/构建/验收脚本 | `scripts/`（fetch-*、start-desktop、capture、record、verify、run-tests、bench）、`installer/`、`tools/` | ✅ |

---

## 2. 独立复核结果（Lead 亲自执行）

| 复核项 | 命令/方法 | 结果 |
|---|---|---|
| Runtime 端到端冒烟 | `tools\node.cmd scripts\verify.js --fca-home=.cache\lead-final-verify --port=17884` | **23/23 PASS**（init/health/401/空图/记忆/关系/版本冲突/搜索/SSE/备份/导出/GPU/DB 完整性/优雅关闭） |
| 全量自动化测试 | `tools\node.cmd scripts\run-tests.js --all`（QA 执行，`artifacts/reports/test-run.json`） | **unit 21 + integration 44 + security 17 + e2e A-E 29 检查 + performance 2 + runtime 65，全部 PASS，failed_groups=0** |
| 场景 A：全新空白星图（最终交付状态） | 重置默认数据目录后 `GET /api/v1/graph` + `/state` | **nodes=0 / edges=0 / clusters=0，counts 全 0，DB user_version=1**（证据 `artifacts/reports/final-scenario-a-empty-db.json`） |
| 场景 B：手动创建记忆 + 关闭重开 | 桌面 E2E（`artifacts/reports/desktop-e2e.md`，真实 main.js + 真实 Runtime） | **22/22 断言 PASS**：新建→图谱出现→优雅退出(exit 0)→重开→记忆/布局坐标/UI 布局全部恢复 |
| 场景 C：DSH Agent 自动写入（真实链路） | 真实 Agent 调用插件工具 `fca_memory_store/search/get`（本会话） | **PASS**：`mem_141a67e43e978e5dc8399f6ca9a78a0a` 等真实写入；`origin=agent`、`created_by={kind:agent,id:dsh-plugin}`、自动项目关系；搜索/读取往返正确 |
| 场景 D：编辑同步与版本历史 | QA e2e + integration（PATCH/版本/diff/SSE） | **PASS**（版本冲突 409 VERSION_CONFLICT、历史版本可读） |
| 场景 E：LLM API 中断本地可用 | QA e2e E + LLM Gateway 行为矩阵 | **PASS**：无 Provider/不可达时 `202 queued` 或如实报错；本地浏览/编辑/星图/DB 不受影响；不伪装成功 |
| 场景 F：备份→损坏→恢复 | QA e2e F + verify 备份/导出 | **PASS**：校验备份 manifest/sha256/integrity；损坏拒绝恢复；正常恢复数据/版本/布局一致 |
| 桌面视觉证据 | 21 张 `final-*.png`（194 节点/382 关系/22 聚类；空库 nodes=0、source=runtime，无假节点/无 DEV-ONLY 横幅） | **通过**（视觉自评 8/10，详见 `artifacts/reports/desktop-final-report.md`） |
| DSH 插件真实安装 | `plugin_manager install_bundle` → `application:"applied"`、`warnings:[]`；Host 日志 `plugin loaded`/`bridge started`；4 个 `fca_*` 工具注册 | **PASS** |
| DSH 插件事件采集（T17） | 真实子代理会话 turn/end → `agent.event_received` 落库 | **PASS**：`counters={received:7,queued:7,sent:7}`；`POST /api/v1/event 201`；payload 无正文、幂等键正确 |
| 安装包 | 终版构建（NSIS 3.04，payload 204 文件/361.8MB，docs 19 个）+ QA 最终包安装冒烟 5/5 + `docs/INSTALL_TEST.md` | **PASS**（卸载不再误停其他数据目录 Runtime；默认保留用户数据） |

---

## 3. 关键验收指标（真实数据）

### 3.1 性能（设备：AMD Ryzen 7 H 260 / 15.3GB / Win11 Pro 26300 / NVIDIA RTX 5060 Laptop 8151MB / Node v24.11 / Electron 38.2.1）

**Runtime API（100 / 1000 / 10000 条记忆）**

| 指标 | 100 | 1000 | 10000 |
|---|---|---|---|
| layout recompute | 41.2 ms | 138.1 ms | 13,739.5 ms |
| GET /graph | 15.9 ms | 94.2 ms | 19,572.3 ms（4.48 MB） |
| hybrid 搜索 p50 | 5.3 ms | 15.6 ms | 177.3 ms |
| PATCH p50 | 3.45 ms | 2.77 ms | 4.37 ms |
| DB 大小 | 0.8 MB | 5.2 MB | 49.9 MB |
| Runtime RSS | 71.1 MB | 95.9 MB | 316.9 MB |

> 10000 节点瓶颈为同步布局计算与一次性 graph 序列化（跨轮 8.7–19.6 s，负载敏感）；Alpha 0.1 可交互档为 ≤1000 节点（详见 `docs/TEST_REPORT.md` 与 `docs/KNOWN_ISSUES.md`）。

**桌面渲染（WebGL2 / ANGLE D3D11 / RTX 5060，真实 capture 探针）**

| 节点数 | FPS | 帧时间 | p95 | quality |
|---|---|---|---|---|
| 100 | 51.4 | 19.4 ms | 42.5 ms | high |
| 1000 | 93.4 | 10.7 ms | 24.4 ms | high |
| 10000 | 53.5 | 18.7 ms | 36.5 ms | high |

产品链路（194 节点/382 关系/22 聚类，1600×1000）：high 默认 50.5 FPS；ultra 35.5 FPS；medium/low/off ≥165 FPS（vsync 上限）；off 档保留全部交互与标签。无 context lost / fatal。

### 3.2 视觉验收（提示词 §三/§四/§十二）

- 数据驱动：星云气体核按真实节点空间密度确定性 k-means 分区生成，颜色来自真实 `cluster.color_hint`；空库只显示真实深空背景与“空白星图”提示，**不显示任何假节点**。
- 深空质感：体积 raymarch 气体云 + 域扭曲丝状结构 + 高频尘埃吸收暗带 + 前后景深度 z 层次 + 4 层视差星点/亮星星核/银河带；ACES tonemap + bloom，未出现中心过曝白球。
- 星体与关系：亮度=importance/display_weight/degree 映射，少数亮星核+大量暗星层次；关系为真实 edges 的细光丝（按 relation_type 分色/曲率），可辨识且不破坏星空。
- 图例/图层/映射说明 UI；性能档位 ultra/high/medium/low/off；关闭特效仍可编辑。

---

## 4. 本轮恢复期间修复的真实缺陷（摘要）

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | Runtime 记忆写入 SQL 占位符错（25 values for 24 columns）→ 503 | 修正 INSERT |
| 2 | FTS 搜索 `no such column: f`（FTS5 别名 MATCH 语法） | 修正 `memory_fts MATCH` / bm25 |
| 3 | `core/errors.js` 缺 backupFailed/restoreFailed/importFailed → 模块加载失败 | 补齐 helper |
| 4 | 桌面 capture：`ownedByUs` TDZ、IPC 未注册、窗口关闭自动退出 → 截图失败 exit -1 | runtime-manager 初始化顺序、capture 注册完整 IPC、保活 |
| 5 | renderer `ctx.log` 缺失 → 每个视图未处理 rejection，真实星云模块从未加载 | app.js ctx 统一日志门面 |
| 6 | `[hidden]` CSS 级联缺失 → DEV-ONLY/幽灵元素常显 | 全局 `[hidden]{display:none!important}` |
| 7 | tools\node.cmd 等脚本 LF 行尾 → cmd 解析失败 | 转 CRLF |
| 8 | NSIS 在本机 C: %TEMP% 上 >32MB mmap 失败（makensis 3.04 x86） | build.js 固定 TEMP 到 D: 盘 workaround |
| 9 | 卸载器硬编码默认数据目录 stop，误停其它数据目录 Runtime | 卸载不再自动 stop（仅提示），最终包复测验证 |
| 10 | QA 发现的 BUG-1/2/3（LLM retry 500、import path 500、损坏 ZIP 500）、非法 X-FCA-Client 静默忽略、CLI Windows 崩溃、CLI 误停其它 Runtime 等 | runtime-core 全部修复并有回归用例 |
| 11 | 测试基建：端口竞争导致 401 假失败 | QA 修复端口占用探测 + pid 断言 + 自动换端口，全量重跑全绿 |

---

## 5. 已知限制（不阻塞 Alpha 0.1 交付，详见 `docs/KNOWN_ISSUES.md`）

1. **10000 节点**：Runtime 布局/图数据为同步计算，`/graph` 与 recompute 秒级（8.7–19.6s）；Alpha 0.1 目标可交互规模为 ≤1000 节点。
2. **LLM 在线调用**：本机未提供真实第三方 API Key，LLM Gateway 的在线路径以本地 fake Provider 做确定性验证；离线/不可达/配置错误行为均已真实验证。真实云 API 需用户配置 Provider 后生效。
3. **DSH 插件 Config UI 表单**：手写 Standard Schema 可校验/生效，但 Plugin Manager 无法渲染表单；`/fca` 命令仅验证注册（UI 执行需人工触发）。
4. **插件事件采集**在 Runtime 停机窗口入队后，需下一次成功 connect 才 flush（事件不丢，延迟 ≤ 一个健康轮询周期）。
5. **安全**：ZIP 解压炸弹率限制、导出/导入路径未限制、无请求限流、CORS `*`（本机回环场景已记录风险与改进建议）。
6. **测试环境限制**：本机 DSH 工具 shell 子进程为 Low IL（%TEMP% 重定向、HKCU/快捷方式写入受限），安装器/注册表类证据以 WMI 正常令牌方式与 QA 最终包冒烟为准；`Electron` 在 DSH shell 内需 `--no-sandbox`（真实用户从桌面启动不需要）。
7. **视觉**：ultra 档 194 节点 35.5 FPS（>30 验收线）；聚类标签偶有边缘重叠；配色受演示数据 color_hint 分布影响偏冷。

---

## 6. 最终交付状态

- 默认数据目录 `%LOCALAPPDATA%\FCA-Memory-Atlas` 已重置为**全新空库**（场景 A 状态，便于首次启动向导演示）；此前场景 C 的验证数据在本地测试目录保留（不随仓库分发）。
- FCA DSH 插件保持已安装（desktop profile，`fiberPhase=active`），真实 Runtime 在 127.0.0.1:17860 运行（全新空库）。
- 构建/复现：`docs/USER_MANUAL.md` §安装与 §排错、`README.md`、`docs/INSTALL_TEST.md`、`docs/TEST_REPORT.md`。
- 一键复核：`tools\node.cmd scripts\verify.js --fca-home=.cache\verify --port=17880`；`tools\node.cmd scripts\run-tests.js --all`。
