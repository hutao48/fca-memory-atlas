# ⚠️ DEV-ONLY 开发夹具目录（不属于生产交付）

本目录只在 **Runtime 未就绪 / Nebula 渲染器未就绪** 的开发阶段使用，用于让桌面外壳与
Editor 视图可以先并行开发、可运行、可截图。

**最终交付前必须删除整个 `desktop/renderer/lib/dev/` 目录，并移除生产代码中的引用**
（`lib/dev/*` → 真实 `../nebula/index.js` 与真实 Runtime API）。

| 文件 | 用途 | 生产替代 |
|---|---|---|
| `fixtures.js` | 符合 `docs/PUBLIC_INTERFACE_FREEZE.md §5` 的演示 graph（20+ 节点） | `GET /api/v1/graph` 真实数据 |
| `nebula-stub.js` | 冻结 `createNebula` 接口的 2D 占位实现 | `desktop/renderer/nebula/index.js`（nebula-renderer 组） |

加载条件（任一）：
- URL 带 `?dev=1` / `?scenario=dev`；
- `desktop-settings.json` 中 `devFixtures: true`。

启用时 UI 顶部必须显示「开发夹具数据（DEV-ONLY）」横幅，禁止作为验收证据。
