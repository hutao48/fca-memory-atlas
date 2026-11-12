# FCA Nebula · Unity 星云渲染

本目录把 FCA Memory Atlas 的星云图形渲染从 WebGL/Electron 渲染器移植到 **Unity**，并实现用户核心要求：

> **同一工作区的记忆自动归到星云的一条旋臂。**

**集成路径（2026-11-12 用户新要求后）**：Unity 构建为 **WebGL**，由 Electron 主进程起只读本地静态服务、用 iframe 内嵌到软件界面（详见 §6/§11）；Windows standalone 构建保留为**开发/备用**（`FCA_UNITY_STANDALONE=1`，不再作为内嵌主路径）。

| 项 | 值 |
|---|---|
| Unity 版本要求 | **Unity 2022.3 LTS**（实测 `2022.3.62f3c1`），含 **Windows Build Support** + **WebGL Build Support** 模块 |
| 渲染管线 | **Built-in Render Pipeline（3D 模板）**，**不需要 URP/HDRP 包** |
| 语言/运行时 | C# 9 / .NET Standard 2.1；JSON 解析用 Unity 内置 `JsonUtility`（不依赖 `System.Text.Json` 或任何第三方库） |
| 数据源 | 本机 FCA Runtime `GET /api/v1/graph`（Bearer token）+ `GET /api/v1/state` + 点击时 `GET /api/v1/memory/{id}` |
| 主构建产物（Electron 内嵌） | **`artifacts/unity/FCANebulaWebGL/`**（`index.html` + `Build/*.wasm/.data/.framework.js` + TemplateData，约 **24.9 MB**，WebGL2） |
| 开发/备用构建 | `artifacts/unity/FCANebula/FCANebula.exe`（Windows standalone，独立窗口） |
| 验收截图 | standalone：`artifacts/unity/shots-final/`（3 张）；WebGL：`artifacts/unity/webgl-shots/`（3 张 + manifest + 控制台日志） |

---

## 1. 目录结构

```
unity/FCANebula/
├─ Assets/
│  ├─ Scripts/
│  │  ├─ Core/AppConfig.cs              命令行/环境变量配置 + 画质档位
│  │  ├─ Core/AppPaths.cs               仓库根/相对路径解析（Editor 与 Player 通用）
│  │  ├─ Core/ThemePalette.cs           旋臂六色、记忆类型色、关系光丝样式（与 desktop palette.js 对齐）
│  │  ├─ Data/FcaGraphDto.cs            §5 数据契约 DTO + 运行时模型 GraphModel/LayoutModel 输入
│  │  ├─ Data/FcaApiClient.cs           Bearer token、3s 轮询、失败回退链、详情拉取
│  │  ├─ Layout/WorkspaceSpiralLayout.cs workspace:<label> 分组 + 对数螺旋旋臂布局
│  │  ├─ Layout/NebulaCameraRig.cs      绕 Z 轴轨道相机（拖拽/滚轮/预设机位）
│  │  ├─ Render/NebulaFieldRenderer.cs  全屏体积星云 quad + bloom/tonemap 后处理
│  │  ├─ Render/NodeRenderer.cs         星点（单次动态 billboard 网格批绘；大小/亮度 ← importance/display_weight/degree）
│  │  ├─ Render/EdgeRenderer.cs         关系光丝带状网格（按 relation_type 着色/虚线/流光）
│  │  ├─ UI/UiOverlay.cs                IMGUI HUD：连接状态/工作区图例/点选详情/错误横幅
│  │  ├─ WebGL/WebGLBridge.cs           WebGL player：Unity→页面状态/ready 桥 + JS 命令（仅 WebGL 编译）
│  │  ├─ NebulaApp.cs                   场景编排：相机 + 组件装配 + 数据→布局→渲染
│  │  ├─ NebulaBootstrap.cs             空场景运行时兜底（保证 Player 永远有渲染系统）
│  │  └─ ScreenshotRunner.cs            standalone 确定性截图模式（WebGL 下不编译）
│  ├─ Plugins/WebGL/FCABridge.jslib     Unity→JS postMessage（fca-unity-ready / fca-unity-state）+ 画布截图辅助
│  ├─ WebGLTemplates/FCANebula/         自定义 WebGL 页面：全屏 canvas、深色背景、加载层、`window.FCA_NEBULA` 命令 API
│  ├─ Resources/Fonts/NotoSansSC-VF.ttf WebGL 用 CJK 字体（Noto Sans SC，SIL OFL 1.1）；standalone 用系统字体
│  ├─ Shaders/
│  │  ├─ NebulaVolume.shader            程序化体积星云：对数螺旋旋臂 + FBM 域扭曲 + 尘埃 + 背景星场（WebGL target 3.0 分支）
│  │  ├─ NodeStar.shader                additive billboard 星点（顶点色 + UV2 携带选中/悬停/相位）
│  │  ├─ EdgeFilament.shader            additive 关系光丝（宽度衰减 + 流光 + 虚线）
│  │  └─ NebulaPost.shader              bloom 预过滤/分离高斯模糊/合成（ACES、曝光、暗角、颗粒、抖动）
│  ├─ Editor/
│  │  ├─ ProjectBootstrap.cs            批处理：材质/场景/PlayerSettings（Built-in RP）
│  │  └─ BuildScript.cs                 批处理：BuildWindows（standalone）+ BuildWebGL（Electron 内嵌主路径）
│  └─ StreamingAssets/sample-graph.json 脱敏离线样例（仅 Editor 预览/显式 --allow-sample 时使用）
├─ Packages/manifest.json               仅内置模块（无 URP；2022.3 支持的模块列表）
├─ ProjectSettings/ProjectVersion.txt   `m_EditorVersion: 2022.3.62f3c1`
└─ scripts/
   ├─ build.ps1                         一键 bootstrap + Windows standalone 构建（自动发现 Unity、初始化 ProjectSettings）
   ├─ run.ps1                           启动 standalone 星云窗口（开发/备用）
   ├─ capture-screenshots.ps1           standalone 无人值守 3 张真实数据截图 + manifest
   ├─ serve-webgl.py                    WebGL 本地只读静态服务（correct wasm MIME、no-cache、日志脱敏 token）
   ├─ capture-webgl-cdp.mjs             **WebGL 验收截图（CDP，推荐）**：headless Edge 加载真实 WebGL + 等待 ready + 3 机位截图 + manifest/日志
   ├─ capture-webgl-shots.ps1           WebGL 截图备用实现（Edge --virtual-time-budget，无 Node 时用）
   ├─ export-sample.ps1                 从真实 Runtime 导出脱敏样例
   └─ verify-source.ps1                 无 Editor 时的静态自检（括号/语法/JSON/契约/WebGL 桥）
```

`desktop/`、`runtime/`、`dsh_plugin/` 等目录本任务没有任何改动。

---

## 2. 数据契约

### 2.1 `GET /api/v1/graph`（唯一渲染数据来源，见 `docs/PUBLIC_INTERFACE_FREEZE.md` §5）

请求：`Authorization: Bearer <token>`；响应：

```json
{
  "api_version": "1", "layout_version": 17,
  "view": { "center": [0,0,0], "zoom": 1.0, "view_id": null },
  "nodes": [{
    "id": "mem_…", "kind": "memory", "type": "episodic", "label": "…",
    "importance": 0.6, "display_weight": 1.0, "credibility": 0.8,
    "occurred_at": "ISO|null", "degree": 4, "cluster_id": "cluster_3",
    "position": { "x": 1, "y": 2, "z": 3 },
    "pinned": false, "tags": ["workspace:FCA", "…"], "deleted": false,
    "agent_generated": false, "demo": false
  }],
  "edges": [{ "id": "rel_…", "from": "mem_…", "to": "ent_…",
              "relation_type": "belongs_to_project", "weight": 1.0,
              "directed": true, "confidence": 1.0, "label": "属于项目", "deleted": false }],
  "clusters": [{ "id": "cluster_3", "label": "…", "node_ids": ["…"],
                 "centroid": {"x":0,"y":0,"z":0}, "density": 0.62,
                 "dominant_types": ["episodic"],
                 "color_hint": "cyan|blue|violet|magenta|rose|gold|white" }],
  "stats": { "nodes": 0, "edges": 0, "clusters": 0, "generated_at": "ISO" }
}
```

Unity 端处理规则：

- `deleted: true` 的节点**不渲染**；端点节点被过滤/不存在的关系**不渲染**（绝不为了画线补造节点）。
- 空图（`nodes: []`）渲染真实深空背景 + “空白星图”提示，不显示任何假节点。
- 轮询间隔默认 3s（`--poll=<秒>`），失败指数退避（最长 30s）；成功一次后失败会保留上一帧真实数据并在 HUD 顶部显示红色离线条幅，不会伪造数据。
- Runtime 数据不落盘、不写库；Unity 只做 GET（本任务约束）。

### 2.2 `GET /api/v1/state`

首轮拉取成功后再拉一次，用于 HUD 显示 Runtime 计数；失败仅告警，不影响渲染。

### 2.3 `GET /api/v1/memory/{id}`

点击（或截图模式预选）节点时拉取 `{memory:{title, body, tags/tag_names, importance, memory_type, …}, relations, layout, versions_count}`，HUD 显示标题 + 正文前 500 字；拉取失败显示错误原文（“未伪造”），不显示缓存假正文。

### 2.4 鉴权 token

解析顺序（`AppConfig.TokenFileCandidates`）：

1. `--token-file=<path>`
2. `--fca-home=<dir>` → `<dir>/config/runtime-token`
3. 环境变量 `FCA_HOME` → `<FCA_HOME>/config/runtime-token`
4. `%LOCALAPPDATA%\FCA-Memory-Atlas\config\runtime-token`（**默认**）
5. `%APPDATA%\FCA-Memory-Atlas\config\runtime-token`
6. `%FCA_DATA_HOME%\config\runtime-token`
7. `%USERPROFILE%\.fca\config\runtime-token`

- token 文件每轮请求前重新读取 → Runtime 轮换 token 后无需重启；
- `401` 时重读 token 并重试一次；
- HUD 只显示 token 文件路径与是否存在，**不显示 token 内容**。

### 2.5 启动参数（与 Lead 约定一致）

```
FCANebula.exe --runtime-url=http://127.0.0.1:17860 --token-file=<path> --fca-home=<dir> --quality=high
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--runtime-url=` / `--url=` | `http://127.0.0.1:17860` | 自动补 `http://`、去尾部 `/` |
| `--token-file=` | 见 §2.4 | Bearer token 文件 |
| `--fca-home=` | — | 数据目录，token 取 `<dir>/config/runtime-token` |
| `--token=` | — | 直接传 token（仅调试，不推荐） |
| `--quality=` | `high` | `off\|low\|medium\|high\|ultra`（也可在运行时按 0-4 切换） |
| `--poll=` | `3` | 轮询秒数 |
| `--allow-sample` / `--sample=<path>` | 关闭 | 显式允许使用离线样例（否则 Player 绝不使用样例） |
| `--screenshot-dir=` | `artifacts/unity` | 截图输出目录（相对路径按仓库根解析） |
| `--screenshot-count=` | `0` | 1-3，>0 进入无人值守截图模式并退出 |
| `--screenshot-delay=` | `6` | 等数据/画面稳定的秒数 |
| `--auto-rotate=` | `1.2` | 待机自动旋转角度/秒（截图模式默认 0） |
| `--labels=` | `1` | 是否显示节点标签 |
| `--log` | 关闭 | 打印每次请求 |
| `--workspace-tag-prefix=` | `workspace:` | 工作区 tag 前缀 |

对应环境变量：`FCA_RUNTIME_URL`、`FCA_TOKEN_FILE`、`FCA_TOKEN`、`FCA_HOME`、`FCA_QUALITY`、`FCA_POLL_SECONDS`、`FCA_ALLOW_SAMPLE`、`FCA_SAMPLE_PATH`、`FCA_SCREENSHOT_DIR`、`FCA_SCREENSHOT_COUNT`、`FCA_SCREENSHOT_DELAY`、`FCA_AUTO_ROTATE`、`FCA_SHOW_LABELS`、`FCA_WORKSPACE_TAG_PREFIX`、`FCA_LOG`。

命令行优先级高于环境变量。

#### 2.5.1 WebGL Player 的 URL query 契约（Electron 内嵌）

WebGL 无法访问进程环境变量/命令行/文件系统，`AppConfig.ApplyWebGLQuery()`（`#if UNITY_WEBGL && !UNITY_EDITOR`）从 `Application.absoluteURL` 解析：

```
http://127.0.0.1:<Electron 随机端口>/index.html
  ?runtime-url=http://127.0.0.1:17860
  &token=<bearer>            # 仅在本机随机端口 URL 中；不写日志、不入构建产物
  &quality=high              # off|low|medium|high|ultra
  &view=0                    # 可选：0=overview 1=workspace-arm 2=top-down（验收相机机位）
  &poll=2                    # 可选：轮询秒数（默认 3）
  &auto-rotate=0             # 可选：待机自动旋转角度/秒（默认 1.2）
  &labels=0                  # 可选：节点标签默认 0（WebGL 用 CJK 字体；标签较多时建议关闭）
  &hud=1                     # 可选：0 可让 Electron 用自己的 HTML 外壳完全替换 canvas 内 HUD
```

- **runtime-url 支持相对路径**（如 `/` 或 `/api`）：当 Electron 本地静态服务代理 `/api/v1/*` 时使用；默认走 Runtime 直连（Runtime 已启用 `Access-Control-Allow-Origin: *` + OPTIONS，跨源 GET + Authorization 可用）。
- token 缺失时 HUD 显示红色错误横幅且**不伪造数据**；token 由 Electron 注入 iframe URL，Unity 侧只在内存中使用，不做持久化。
- 页面 → Unity 命令（同源 JS）：`window.FCA_NEBULA.setView(1)` / `setQuality('high')` / `refresh()` / `postCommand('labels:1')`（内部 `SendMessage("FCA Nebula System","OnJsCommand",…)`）。
- Unity → 页面事件：`window.__FCA_NEBULA_STATE__` / `window.__FCA_READY__`，以及 `postMessage({type:'fca-unity-ready'|'fca-unity-state', payload})`（详见 §11）。

### 2.6 不伪造原则

| 情况 | 行为 |
|---|---|
| Runtime 在线 | 只渲染 `/api/v1/graph` 返回的真实节点/关系 |
| Runtime 离线（Player） | 深空背景 + 红色错误横幅 + 空图提示；**不使用样例数据** |
| Runtime 离线（Editor） | 允许回退 `StreamingAssets/sample-graph.json`，但 HUD 显示 **SAMPLE 数据 · 非实时** 横幅 |
| 显式 `--allow-sample` | 同上，红色 SAMPLE 横幅 |
| 记忆正文拉取失败 | 显示错误原文，不显示样例正文 |

---

## 3. 工作区 → 旋臂分组

### 3.1 分组规则（tags 唯一依据）

对每个节点扫描 `tags`：

1. 找到第一个形如 **`workspace:<label>`** 的标签（前缀大小写不敏感，`label` 保留原始大小写，trim 后非空）→ 归入该 workspace 旋臂；
2. 没有任何 workspace 标签 → 归入 **`default`** 旋臂（冷白色，图例显示 `default（未分组）`）；
3. 若 `workspace:` 后为空字符串 → 视同无标签 → default；
4. 同一节点多个 workspace 标签时取第一个（Runtime 侧应保证唯一）。

> 关键点：**节点位置不再使用 API 返回的 `position`**。只要标签相同，节点一定被强制放到同一条旋臂上；API 旧坐标/其他渲染器的布局不会影响归臂。

### 3.2 旋臂几何（对数螺旋）

workspace 数量 `N`；命名 workspace 按 Ordinal 排序（default 永远最后）后均分角度：

```
θ0(i) = globalRotation + 2π·i / N                        i = 0..N-1（i 为臂序号）
r(t)  = r0 · exp(b · θ(t))                               t ∈ [0,1] 沿臂参数
θ(t)  = θ0 + hand · span · t                              hand = ±1（螺旋方向）
b     = ln(rOuter / rInner) / maxSpan
span  = lerp(maxSpan · 0.42, maxSpan, sqrt(count/maxCount))   ← θ 范围与节点数相关
```

- `r0`（内半径）= 72 世界单位，`rOuter`（外半径）= 470，`maxSpan` = 4.4 rad（≈252°）；
- 节点少的 workspace 得到更短、更靠内的旋臂；节点最多的 workspace 用满 `maxSpan`；
- 每条臂的内/外半径、pitch、span、径向宽度、垂直厚度都会传给体积着色器，**星云气体与旋臂严格同源**。

**节点沿臂分布**（同一 workspace 内，按节点 id 的 FNV-1a 稳定哈希排序，保证多轮刷新位置稳定）：

```
base_t = (rank + 0.5) / count
t = clamp(base_t + (hash_T - 0.5) · 0.55/count, 0.02, 0.98)      ← 沿臂抖动
r = r0 · exp(b · span · t) · (1 + (hash_R - 0.5) · 2 · 0.075)     ← 径向抖动 ±7.5%
θ = θ0 + hand · span · t + (hash_A - 0.5) · 2 · 0.085 · (1.25 - 0.55·importance)
z = (hash_Z - 0.5) · 2 · 34 · (1 - 0.38·importance) + sin(2πt + i·1.7)·4.5
```

即：**importance 越高 → 角向更贴近臂心线、z 更靠近银盘平面、越大越亮**；普通记忆散布更松。

**节点尺寸/亮度**（与 old WebGL 渲染器语义一致）：

```
size       = 11.5 · (0.55 + 0.95·importance) · (0.70 + 0.30·display_weight) · (1 + 0.018·√degree)
brightness = clamp((0.18 + 0.82·importance²) · (0.65 + 0.35·display_weight), 0.05, 1.5)
显示增益    = 0.90 + 1.50·brightness     ← 节点层实际发射强度（补偿 Built-in 下无重 bloom 链）
```

屏幕投影过小（拉远）时按最小 ~6.5px 放大，保证可见性。节点颜色 = 类型色（memory/entity 类型表）与旋臂色以 35% 混合后再向白色提亮 22%（避免节点与同色旋臂融为一体，例如青蓝 FCA 臂上的星点仍是白亮核心），并再按 importance 提亮：既读出“属于哪条臂”，又保留类型/亮度语义。

### 3.3 配色（图例与 shader 同源，`ThemePalette.cs`）

| 顺序 | 旋臂色 key | sRGB | 用途 |
|---|---|---|---|
| 1 | `cyan` | `#57C9E8` | 命名 workspace 第 1 条 |
| 2 | `blue` | `#4D7FE6` | 第 2 条 |
| 3 | `violet` | `#8A6FE6` | 第 3 条 |
| 4 | `magenta` | `#C25EAE` | 第 4 条 |
| 5 | `rose` | `#DF8899` | 第 5 条 |
| 6 | `gold` | `#E5B46B` | 第 6 条 |
| — | `default` | `#9DB4D8`（冷白偏蓝） | 未分组旋臂，永远固定冷白偏蓝（与命名臂的彩色区分） |
| >6 | 循环 + 色相偏移 0.083·cycle | — | 第 7 条起按六色循环并轻微偏色 |

记忆类型色 / 实体类型色 / 10 种关系样式（颜色、宽度、曲线、虚线、流光）与 `desktop/renderer/nebula/palette.js` 对齐，见 `ThemePalette.cs`。

### 3.4 体积星云如何跟随旋臂（`NebulaVolume.shader`）

对每个 raymarch 采样点 `p`：`r = length(p.xy)`，`θ = atan2(p.y,p.x)`；对每条臂：

```
rel       = wrap(θ - θ0)（hand<0 时取反，wrap 到 [0,2π)）
expected  = r0 · exp(b · rel)                      ← 与布局公式完全一致
radial    = exp(-(r-expected)² / width(rel)²)      ← 臂径向高斯，外段更宽
vertical  = exp(-z² / σz²)                         ← 垂直高斯（σz 由布局参数给出）
edgeFade  = smoothstep(0,0.30,rel) · smoothstep(0,0.55,span-rel)   ← 臂根/臂尖淡出
density  += radial·vertical·edgeFade·intensity·(0.055+0.42·gas)·(0.42+0.95·structure)
emission += armColor·density
```

其中 `structure = smoothstep(0.22, 0.80, fine)`，用中高频 FBM 把平滑的臂打散成气体纤维/团块；transmittance 同时被高频尘埃与气体自遮挡（`extinction = dust + density·0.55`）吸收，避免“白棉球”。

气体由 3D FBM + 域扭曲构成（非“白棉球”）；`fine` 高频噪声形成暗尘埃带（通过 transmittance 吸收）；中心有紧凑暖色核球；再叠加程序化深空星场与银河带背景。

---

## 4. 渲染实现（Built-in RP）

| 层 | 实现 | 文件 |
|---|---|---|
| 深空背景 | 体积 shader 内的方向性背景：渐变 + 银河带 + 两层程序化星点 | `NebulaVolume.shader` |
| 体积星云 | 相机挂载全屏 quad（Background 队列，近平面覆盖），逐像素 raymarch 球体包围盒；`_Steps/_Octaves` 由画质档位驱动 | `NebulaVolume.shader` + `NebulaFieldRenderer.cs` |
| Bloom/合成 | `OnRenderImage`：预过滤（阈值+膝）→ 1/2 分辨率分离高斯（迭代次数随画质）→ 合成（曝光、ACES、暗角、颗粒、抖动） | `NebulaPost.shader` |
| 节点星点 | 每帧把所有节点合并为一个动态 billboard Mesh（4 顶点/节点，一次 additive draw call）；颜色/亮度/选中/悬停/闪烁相位写入顶点色与 TEXCOORD1 | `NodeStar.shader` + `NodeRenderer.cs` |
| 关系光丝 | 全边合并为一个动态 ribbon Mesh（二次贝塞尔弯曲、双面交叉、端点淡出、UV 流光/虚线），additive | `EdgeFilament.shader` + `EdgeRenderer.cs` |
| HUD | IMGUI（零额外包依赖），系统动态中文字体（Microsoft YaHei 等），失败/样例横幅 | `UiOverlay.cs` |
| 相机 | 绕 Z 轴轨道（银盘在 XY 平面），阻尼、滚轮缩放、预设机位（overview/arm-closeup/top-down） | `NebulaCameraRig.cs` |

**为什么不用 OnRenderImage 直接 raymarch**：Built-in RP 的 camera RT 在 D3D 上存在 UV 翻转问题，全屏后处理里做 raymarch 需要处理 `UNITY_UV_STARTS_AT_TOP` 翻转；把 raymarch 放在**相机的 near-plane quad** 上可由顶点位置直接重建世界射线，跨图形 API 稳定，且天然处于所有节点/光丝之后。

### 画质档位

| 档位 | raymarch steps | 噪声 octave | bloom 迭代 | 体积强度 | 说明 |
|---|---|---|---|---|---|
| `off` | 0（仅背景星场） | 2 | 0 | 0 | 保留全部交互、节点、图例、标签 |
| `low` | 24 | 2 | 1 | 0.75 | 低配 GPU |
| `medium` | 36 | 3 | 2 | 1.0 | 平衡 |
| `high` | 52 | 3 | 2 | 1.15 | 默认 |
| `ultra` | 80 | 4 | 3 | 1.3 | 高质量截图/强 GPU |

运行时按 `0/1/2/3/4` 切换；HUD 显示当前档位与 FPS。

### 帧率/性能说明

- 星点与光丝开销与节点/关系数量线性相关；体积 raymarch 为主要成本，与 steps×octaves 成正比；
- 建议 1600×1000 窗口、`high` 档；截图模式使用 `high`（可 `--quality=ultra` 出更高质量的验收图）；
- 无 GPU 的环境（`-nographics`）不运行 Player，只有 Editor 批处理；截图需要真实 GPU 会话。

---

## 5. 构建

### 5.1 前置

1. Unity Hub 安装 **Unity 2022.3 LTS**，并勾选 **Windows Build Support (IL2CPP/Mono)** 与 **WebGL Build Support**（Electron 内嵌主路径需要 WebGL 模块）；
2. 登录并激活 License（batchmode 日志出现 `Successfully updated license` 即可）；
3. 本机 Editor 实测路径：`D:\Unity\Hub\Editor\2022.3.62f3c1\Editor\Unity.exe`；WebGL 模块验证：`Editor\Data\PlaybackEngines\WebGLSupport` 存在。

### 5.2 一键构建（推荐）

```powershell
# Windows PowerShell 5.1（本机）/ PowerShell 7 均可
powershell -NoProfile -ExecutionPolicy Bypass -File unity/FCANebula/scripts/build.ps1
# 或指定 Editor：
powershell -NoProfile -ExecutionPolicy Bypass -File unity/FCANebula/scripts/build.ps1 `
  -UnityPath "D:\Unity\Hub\Editor\2022.3.62f3c1\Editor\Unity.exe"
```

脚本行为：自动发现 Editor → 若缺 `ProjectSettings.asset` 用 `-createProject` 生成并复制默认设置 → 把 `ProjectVersion.txt` 固定为已安装版本 → `-executeMethod ...BootstrapAll` → `-executeMethod ...BuildScript.BuildWindows` → 校验 exe。

> `build.ps1` 当前覆盖 **Windows standalone**（开发/备用）。Electron 内嵌所需的 **WebGL** 构建用 §5.3 的 `BuildWebGL` 命令（同样会自动 bootstrap 材质/场景）。

### 5.3 手动 batchmode 命令（与 Lead 约定一致）

```powershell
$U = 'D:\Unity\Hub\Editor\2022.3.62f3c1\Editor\Unity.exe'
$P = 'D:\FCA\FCA-Memory-Atlas\unity\FCANebula'

# 1) Bootstrap：生成 Resources/Nebula 材质、Assets/Scenes/FCANebula.unity、BuildSettings、PlayerSettings
& $U -batchmode -nographics -quit -projectPath $P `
  -executeMethod FCANebula.EditorTools.ProjectBootstrap.BootstrapAll `
  -logFile 'D:\FCA\_scratch\unity\bootstrap.log'

# 2) 构建 Windows standalone（固定输出 artifacts/unity/FCANebula/FCANebula.exe）
& $U -batchmode -nographics -quit -projectPath $P `
  -executeMethod FCANebula.EditorTools.BuildScript.BuildWindows `
  -logFile 'D:\FCA\_scratch\unity\build.log'

# 3) 构建 WebGL（Electron 内嵌主路径；必须显式 -buildTarget WebGL）
#    输出 artifacts/unity/FCANebulaWebGL/（index.html + Build/*.wasm/*.data/*.framework.js）
& $U -batchmode -nographics -quit -buildTarget WebGL -projectPath $P `
  -executeMethod FCANebula.EditorTools.BuildScript.BuildWebGL `
  -logFile 'D:\FCA\_scratch\unity\webgl-build.log'
# 日志: Build Finished, Result: Success / [FCA] WEBGL BUILD OK: ...\FCANebulaWebGL\index.html
```

WebGL PlayerSettings（`BuildScript.ConfigureWebGLPlayerSettings`）：**compression=Disabled**（Electron 本地静态服务无需 Brotli/Gzip 头与 decompression fallback）、`memorySize=512MB`、`dataCaching=on`、`exceptionSupport=FullWithoutStacktrace`、自定义模板 `PROJECT:FCANebula`、颜色空间 Linear（WebGL2）。构建会先清空 `artifacts/unity/FCANebulaWebGL/` 再输出，并写 `fca-webgl-build-info.json`（版本/压缩/字节数/query 与 bridge 契约）。

### 5.4 产物

**WebGL（Electron 内嵌主路径，约 24.9 MB / 19 files）：**

```
artifacts/unity/FCANebulaWebGL/
├─ index.html                      ← iframe 入口（自定义模板，全屏 canvas + 加载层 + FCA_NEBULA API）
├─ fca-webgl-build-info.json       ← 构建信息 + query/bridge 契约
├─ Build/
│  ├─ FCANebulaWebGL.loader.js
│  ├─ FCANebulaWebGL.framework.js
│  ├─ FCANebulaWebGL.wasm          (~10.6 MB)
│  └─ FCANebulaWebGL.data          (~15.1 MB，含 Noto Sans SC CJK 字体)
├─ StreamingAssets/sample-graph.json
└─ TemplateData/                   ← favicon / loading 进度条皮肤等
```

**Windows standalone（开发/备用）：**

```
artifacts/unity/FCANebula/
├─ FCANebula.exe
├─ FCANebula_Data/                ← Unity 数据（含 StreamingAssets/sample-graph.json）
├─ UnityPlayer.dll
└─ MonoBleedingEdge/
```

### 5.5 Editor 内预览

1. Unity Hub 打开 `unity/FCANebula`；
2. 菜单 **FCA → Bootstrap Nebula Scene (Built-in RP)**（或直接打开 `Assets/Scenes/FCANebula.unity`）；
3. Play：Runtime 若在运行则显示真实数据；若 Runtime 不在，Editor 会回退 `StreamingAssets/sample-graph.json` 并显示 **SAMPLE** 横幅。

### 5.6 常见问题

| 现象 | 处理 |
|---|---|
| `No valid Unity Editor license` | 打开 Unity Hub 登录/激活 License 后重试 |
| 脚本编译错误 | 看 `artifacts/unity/bootstrap.log` 的 `error CS…`；先修 C# 再重跑 |
| 粉色/黑屏材质 | 重新跑 BootstrapAll 生成 `Assets/Resources/Nebula/*.mat`；确认 `Assets/Shaders` 已被导入 |
| `com.unity.modules.accessibility` 报错 | 该模块仅 Unity 6 存在，已从 manifest 移除（2022.3 兼容） |
| exe 没生成 | 看 `artifacts/unity/build.log` 的 `Build FAILED` 行：常见为场景缺失（重跑 BootstrapAll）或 Windows Build Support 未安装 |
| WebGL 构建报 `Build target WebGL is not installed` | Unity Hub 安装 **WebGL Build Support** 模块后重试；确认 `Editor\Data\PlaybackEngines\WebGLSupport` |
| WebGL 构建被拒：`Active build target is ... but WebGL is required` | 必须带 `-buildTarget WebGL` 运行 Unity（脚本无法在 executeMethod 内切换 target） |
| WebGL 页面黑屏/无星云 | 先用 §11.4 的 CDP 脚本查控制台日志；常见为浏览器 WebGL2 不可用或静态服务 MIME 不对（用 `serve-webgl.py`） |
| WebGL 页面加载后无法连接 Runtime | 检查 iframe URL 的 `runtime-url`/`token`；Runtime 需允许跨源（已启用 CORS）；token 缺省时 HUD 会显示红色错误 |

---

## 6. Electron 集成方案（内嵌 Unity WebGL）

> 本节为**实际落地实现**（task-9，桌面端 `desktop/main/unity-embed.js` + `renderer/views/atlas.js`）。
> 方案：Unity 构建为 **WebGL**，由 Electron 主进程在 `127.0.0.1` 随机端口起**只读本地静态服务**，
> atlas 视图用 **iframe 内嵌** Unity 画面（工具栏/侧栏/状态栏仍为 Electron）；不再打开独立 Unity 窗口。
> WebGL2 星云保留为**自动回退**（构建缺失、服务失败、加载超时、用户关闭时无感切换，数据同源）。

### 6.1 模块与数据流

```
desktop/main/main.js
  └─ createUnityEmbed({ logger, settings })                 ← desktop/main/unity-embed.js
       ├─ resolveUnityWebglDir(settings)                    解析构建目录：env → 安装版 → 开发版（含搜索列表）
       ├─ http.createServer(...).listen(0, '127.0.0.1')      只读静态服务（随机端口），MIME / 防目录穿越 / 无目录列表
       ├─ buildEmbedUrl()                                    /index.html?runtime-url=…&token=…&quality=…&poll=2
       ├─ 状态机 idle → starting → running → stopped | error；跟踪 index/js/wasm/data 请求（assetsLoaded）
       └─ stop()/dispose() 关闭服务（主窗口关闭 / 应用退出 / 切换 WebGL 时）
desktop/main/ipc.js
  ├─ fca:unity:status / start / stop / log-tail            （invoke；status.frameUrl 含 token，仅 IPC 传递）
  ├─ fca:unity:status                                      （broadcast：服务/资源加载/错误）
  ├─ fca:unity:open / close                                兼容旧通道（映射到 start/stop；standalone 仅 FCA_UNITY_STANDALONE=1）
  └─ fca:app:info 附带 unity 状态快照（不含 token）
desktop/main/preload.js
  └─ window.fca.unity.{getStatus,start,stop,getLogTail,onStatus}
desktop/renderer/views/atlas.js
  ├─ engine = unity | webgl：Unity 模式隐藏 WebGL canvas，显示 iframe 容器 + 加载/错误覆盖层
  ├─ window 'message' 监听 fca-unity-ready / fca-unity-state（Unity 侧 postMessage；见 §6.5）
  └─ WebGL 模式初始化 nebula/index.js（真实数据渲染），顶部提示“已回退 WebGL”。
```

### 6.2 构建目录解析（按优先级）

| 优先级 | 来源 | 路径 |
|---|---|---|
| 1 | 环境变量 | `%FCA_UNITY_WEBGL_DIR%` |
| 2 | settings（联调/自定义安装） | `settings.unityWebglDir` |
| 3 | 打包版 | `<InstallDir>\unity\FCANebulaWebGL\index.html` |
| 4 | 开发版（固定契约） | `<repo>\artifacts\unity\FCANebulaWebGL\index.html` |
| 5 | 手工构建兜底 | `<repo>\unity\FCANebula\Builds\WebGL\index.html` |

状态卡/日志会列出全部搜索路径与 `✓/✗`，便于定位“为什么没找到构建”。

**自动化验收钩子**：`FCA_UNITY_WEBGL_DISABLE=1` 可在不移走构建产物的情况下模拟“构建缺失 → WebGL 回退”，
用于 Electron 回退链路验收（正常用户环境不会设置该变量）。

### 6.3 本地静态服务与 iframe URL

- 服务只监听 **127.0.0.1**，端口 `0`（系统随机分配，每次启动不同），服务结束即释放；
- 只读：仅 `GET/HEAD`；`..`/URL 编码穿越/绝对路径一律拒绝；不提供目录列表；
- MIME：`.html`、`.js/.mjs`（framework/loader）、`.wasm` → `application/wasm`、`.data/.unityweb` → `application/octet-stream`、
  `.png/.jpg/.svg`、`.css/.json`、`.gz/.br`（Unity 压缩产物可兼容）；
- iframe URL（由主进程生成，renderer 仅拿到 URL 字符串）：
  `http://127.0.0.1:<port>/index.html?runtime-url=<runtimeUrl>&token=<bearer>&quality=<high>&poll=2`
  - `token` 从 `<dataDir>\config\runtime-token` 由**主进程**读取后注入 URL（随机端口 + 不落日志 + 不写 `window` 全局状态）；
  - Unity WebGL 侧从 `Application.absoluteURL` 解析这些参数（`AppConfig.ApplyWebGLQuery()`，见 §2.5）；
  - Runtime 已启用 CORS（`Access-Control-Allow-Origin: *` + OPTIONS），WebGL 页面跨源直接 `GET /api/v1/graph` 轮询真实数据；
- `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`；服务日志只记录路径/大小/端口，不记录查询串。

### 6.4 内嵌 UI 与回退行为（默认）

| 场景 | 行为 |
|---|---|
| 应用启动 + 进入“星云总览”（默认 unity） | 主进程启动静态服务 → atlas 视图 iframe 加载 Unity WebGL → 覆盖层显示“Unity WebGL 加载中…” |
| Unity 点亮真实数据 | Unity 通过 `postMessage(fca-unity-ready)` 通知 → 覆盖层卸载，HUD/引擎 pill 显示“Unity 内嵌 · 实时”与节点/旋臂统计 |
| 构建缺失（index.html 不存在） | 不启动服务；renderer **自动回退 WebGL 星云**，顶部提示「未找到 Unity WebGL 构建（index.html），已使用 WebGL 回退」+「重试 Unity / 日志」 |
| 服务启动失败 / iframe 加载失败 | 回退 WebGL + 错误提示；状态卡提供“重新加载 Unity” |
| 70s 内未 ready | 回退 WebGL + 提示可重试（Unity 仍可能在后台初始化，可点重试） |
| 明确关闭 Unity（引擎菜单/命令） | 停止服务 → 回退 WebGL，并在本次会话记住不再自动启动 |
| 主窗口关闭 / 应用退出 | `unity-embed.dispose()` 关闭静态服务（含 keep-alive 连接清理），不残留监听端口/进程 |
| 切换 `nebulaEngine` | 设置持久化到 desktop settings；切 webgl 停服务并渲染 WebGL，切 unity 重启服务并内嵌 |

### 6.5 Unity → Electron 通信（postMessage）

Unity WebGL 构建内的 `Assets/Plugins/WebGL/FCABridge.jslib` 向嵌入页发送：

- `{type:'fca-unity-ready', payload:{ready, connected, sample, state, runtimeUrl, quality, nodes, edges, arms, armSummary, layout, tokenProvided, volumeMaterialOk, …}}`：首帧真实图数据渲染完成；
- `{type:'fca-unity-state', payload:{同上}}`：运行期状态/统计持续推送（renderer 更新 HUD 的 UNITY 统计、样例数据提示等）。

renderer 校验 `event.source === iframe.contentWindow` 后才处理；不使用 `window.__FCA_*`（跨源不可读）。
若某构建未实现 postMessage，renderer 退化为“静态资源加载完成（index+js+wasm/data）+ 宽限期”启发式卸载覆盖层。

### 6.6 IPC / preload 契约

| 通道 | 类型 | 说明 |
|---|---|---|
| `fca:unity:status` | invoke | 状态快照：`available/state/running/dir/source/port/stats/lastError/tokenAvailable`；`frameUrl` 含 token，只给 renderer |
| `fca:unity:start` | invoke | 启动静态服务；返回 `{ok,status,frameUrl,error,alreadyRunning}`（幂等） |
| `fca:unity:stop` | invoke | 关闭服务（`reason` 记录日志） |
| `fca:unity:log-tail` | invoke | 服务日志（启动/关闭/资源加载/错误；不含 token） |
| `fca:unity:status` | broadcast | 服务状态/资源加载/错误 → 所有 renderer |
| `fca:unity:open` / `close` | invoke | 兼容旧通道（映射 start/stop；standalone 仅开发开关） |

验收钩子 `window.__FCA_APP__`：`getUnityStatus/startUnity/stopUnity/getUnityLogTail/getNebulaEngine/setNebulaEngine`。
`window.__FCA_UNITY_STATUS__` 中的 `frameUrl` 已把 `token` 替换为 `[redacted]`（可安全截图/输出）。

### 6.7 设置项（持久化）

`desktop-settings.json` 新增 `nebulaEngine: 'unity' | 'webgl'`（默认 `unity`）与高级项
`unityWebglDir`（自定义构建目录）。入口：设置弹窗 →「外观与渲染 → 星云渲染引擎」；星云工具栏左侧引擎按钮/下拉菜单；
`fca:app:settings:save` 校验并落盘。Unity 不可用时仍保存 `unity` 意图，但实际引擎为 WebGL（提示条可见），
下次启动/重试自动再尝试 Unity。

### 6.8 日志与排障

- 桌面应用日志：`<dataDir>\logs\desktop-YYYYMMDD.log`，`scope=unity-embed` 记录：静态服务启动（端口/目录/来源/quality/token 是否可用）、
  资源加载完成（index/js/wasm/data 计数与字节）、关闭原因、错误；**不记录 token 与完整 iframe URL**；
- Electron 侧 renderer 日志（`scope=view`）记录引擎切换、postMessage ready（connected/nodes/edges/arms/armSummary）、回退原因；
- 星云工具栏引擎菜单「查看 Unity 内嵌日志…」可查看最近 124 条服务日志与构建目录搜索列表。

### 6.9 安全设计

1. 静态服务仅 `127.0.0.1`、随机端口、只读；拒绝穿越/非 GET；不列目录；响应带 `nosniff`/`no-store`；
2. iframe 跨源（`http://127.0.0.1:<port>` vs `file://` shell），renderer 只能收 `postMessage`，无法被 iframe 读写 DOM/localStorage；
3. 父页面 CSP 仅额外放行 `frame-src http://127.0.0.1:*`，其余保持 `default-src 'self'`、`connect-src 'none'`；
4. **未给 iframe 加 `sandbox` 属性**：实测 Unity 2022 WebGL（10MB wasm / 15MB data）在 Chromium sandboxed iframe 下
   无法可靠初始化（资源加载/编译阶段失败），去掉 sandbox 后稳定运行；风险由 2/3 两条（跨源 + 只读本地服务 + 无导航/弹窗能力）收敛，
   且 iframe 内容完全由本机受信构建提供；
5. token 只在 iframe URL 查询串（本机随机端口）出现；主进程日志、状态广播（供 renderer 记录）、截图验收用的全局状态均不包含明文 token。

### 6.10 打包（可选组件）

- `installer/build.js`：若 `artifacts/unity/FCANebulaWebGL/index.html` 存在，则把整个 `FCANebulaWebGL/` 目录打入 payload →
  安装目录 `unity/FCANebulaWebGL/`；`BUILD_INFO.json` 记录 `optional_components.unity_nebula_webgl{included,path,entry,size_mb}`、
  `checks.unity_renderer_present`、`payload.unity_files/unity_bytes`；
- 构建缺失时只打印 WARN，安装包仍可构建（桌面自动使用 WebGL 回退）；当前最终构建 **19 files / 24.9 MiB**（`FCANebulaWebGL.wasm` 10.6MB + `data` 15.1MB + framework/loader/TemplateData）；
- 旧版 standalone Unity（独立窗口）默认**不打包**；仅 `node installer/build.js --include-standalone-unity` 时附带 `unity/FCANebula/`（开发/回退用）；
- 卸载：NSIS 卸载段 `RMDir /r "$INSTDIR\unity"` 递归清理，不影响用户数据目录；
- 另外提供 `--payload-only`（只生成/校验 payload，不编译 NSIS）用于打包前快速验证。

### 6.11 已知限制

1. **窗口位置/多屏**：内嵌 iframe 随 atlas 区域自适应尺寸，无独立窗口；多显示器无影响；
2. **首次加载耗时**：本机实测 WebGL 首次 ready 约 3–8s（wasm 10.6MB + data 15.1MB，WebGL2 初始化），期间显示加载覆盖层；
3. **跨源命令通道**：Electron 目前不能直接向 iframe 内 Unity 发送 `FCA_NEBULA.postCommand`（跨源），
   视角/画质由 iframe URL 初始参数与 Unity 窗口内交互控制；如需 Electron 工具栏驱动视角，需 Unity 模板增加 postMessage 命令通道（后续增强）；
4. **中文标签**：Unity WebGL 默认 `labels=false`（CJK 字体/性能考虑）；Electron 侧保留图例/映射说明，节点标题待后续以 HTML overlay 提供；
5. **Firewall 提示**：静态服务绑定 127.0.0.1 本不应触发 Windows 防火墙提示；实测本机曾出现一次 Node/Electron 防火墙弹窗（疑为既有 runtime 进程），
   若用户环境出现，选择“允许”或取消均不影响内嵌（服务仍可用）；已记录为发布前需复核项（见 §8/§9 以外的风险清单）。

### 6.12 最终构建实测证据（task-9）

> 构建：Unity 2022.3.62f3c1 · WebGL · compression=disabled · `artifacts/unity/FCANebulaWebGL/`（19 files / 24.9 MiB，build-info 记录 0 errors）
> Runtime：`http://127.0.0.1:17860`（真实数据 `<FCA_DATA_DIR>`，`workspace:FCA` 全部归入同一条 `FCA` 旋臂 + `default` 小臂）

| # | 场景 | 命令 / 方式 | 结果 | 证据 |
|---|---|---|---|---|
| 1 | 真实 Unity WebGL 内嵌截图 | `electron desktop/main/capture.js --fca-home=<FCA_DATA_DIR> --no-runtime --view=atlas --nebula-engine=unity --eval-file=…` | iframe ready：`connected=true / nodes=13 / edges=6 / arms=2 / armSummary=FCA:12 \| default:1`；覆盖层消失；HUD `RENDERER Unity · UNITY13N/2A`；引擎 pill「Unity 内嵌 · 实时」；截图内为 Unity 星云，侧栏/工具栏为 Electron | `artifacts/unity/integration-embedded-real.png` |
| 1b | **真实 app 主窗口** E2E 截图（开发版 `desktop/main/main.js`） | `electron desktop/main/main.js --user-data-dir=… --settings-file=… --fca-home=<FCA_DATA_DIR> --screenshot=artifacts/unity/integration-embedded-app-window.png --screenshot-wait=18000` | 自动启动内嵌服务 → `postMessage fca-unity-ready` → 窗口截图（Electron 壳 + 中央 Unity 画面，Unity HUD `已连接 Runtime · LIVE`）→ `开始退出流程 → 服务已关闭 → 退出完成` | `artifacts/unity/integration-embedded-app-window.png`；日志 `.cache/unity-app-shot.log` |
| 1c | **已安装版 v0.2.0 主窗口** E2E 截图 | 安装 v0.2.0 到 `D:\FCA-Memory-Atlas` 后：`"FCA Memory Atlas.exe" --no-sandbox --user-data-dir=… --settings-file=… --fca-home=<FCA_DATA_DIR> --screenshot=artifacts/unity/integration-embedded-installed.png --screenshot-wait=20000` | 安装版启动日志：`unity-embed … source=install-dir:unity/FCANebulaWebGL · port=11953 · token=ready` → `Unity WebGL 静态资源已加载完成` → `窗口截图已保存（E2E）`；截图为安装版窗口内嵌 Unity（真实数据 21 节点/12 关系/3 旋臂：FCA:14 + 大肥鱼:1 + default:6） | `artifacts/unity/integration-embedded-installed.png`；`<FCA_DATA_DIR>\logs\desktop-20261112.log`（scope=unity-embed / capture） |
| 2 | 开发版 `desktop/main/main.js` 全生命周期 | `electron desktop/main/main.js --user-data-dir=… --settings-file=…`（nebulaEngine=unity, autoStartRuntime=true 采纳外部 Runtime） | 静态服务随机端口启动（日志 `Unity WebGL 内嵌服务已启动 · port=… · token=ready`）→ `Unity WebGL 静态资源已加载完成` → `renderer:view Unity WebGL 已连接真实数据（postMessage fca-unity-ready）`；退出：`main-window-closed → 服务已关闭 → 开始退出流程 → 退出完成` | `.cache/unity-main-test-app.log`（临时日志） |
| 3 | 打包布局（`<InstallDir>/unity/FCANebulaWebGL`）模拟 | 复制 Electron 分发 → `<dir>/resources/app`=当前 desktop，`<dir>/unity/FCANebulaWebGL` 指向最终构建，运行 `FCA Memory Atlas.exe` | `packaged:true`；`unity.source=install-dir:unity/FCANebulaWebGL`；renderer 连上真实 Runtime；Unity `postMessage ready`；退出清理正常 | `.cache/unity-pkg-test-app.log` |
| 4 | 构建缺失 → WebGL 回退 | `FCA_UNITY_WEBGL_DISABLE=1` + `--nebula-engine=unity` | `engine=webgl`，WebGL 星云渲染真实数据（13 节点/6 关系）；提示条「未找到 Unity WebGL 构建（index.html），已使用 WebGL 回退」+ 重试/日志按钮 | `artifacts/unity/integration-embedded-fallback-missing.png` |
| 5 | 占位 WebGL 构建（提前验证服务/iframe 通道） | `FCA_UNITY_WEBGL_DIR=.cache/fake-webgl` | iframe 内占位页面加载、postMessage ready 生效、覆盖层卸载、HUD/引擎 pill 正确；验证完成后删除占位构建 | `artifacts/unity/integration-embedded-placeholder.png` |
| 6 | 静态服务/构建自检脚本 | `node scripts/unity-integration-check.js --fca-home=<FCA_DATA_DIR> --out-dir=artifacts/unity/integration-final` | **PASS**：build_found / server_start / iframe_url / mime_and_size / static_404 / traversal_blocked / build_assets / build_info_ok | `artifacts/unity/integration-final/integration-report.json` |
| 7 | 设置持久化 | 渲染进程 `saveSettings({nebulaEngine:'unity'})` → 重启主进程加载 | `desktop-settings.json` 写入 `"nebulaEngine": "unity"`；主进程启动日志 `应用已启动 { nebulaEngine:'unity', unity.dir:… }` | 临时 settings 文件（`.cache/unity-settings-home`） |
| 8 | payload 阶段（不编译 NSIS） | `node installer/build.js --skip-runtime --allow-incomplete --payload-only` | payload 160 files / 369.7 MiB；**unity webgl 19 files / 24.9 MiB**；`checks.unity_renderer_present=true`、`optional_components.unity_nebula_webgl.included=true` | `installer/.staging/payload`（构建后清理） |

说明：
- 所有截图均为**真实 Electron 窗口 + 真实 Unity WebGL 渲染 + 真实 Runtime 数据**，无合成图；
- 已安装目录 `D:\FCA-Memory-Atlas` 当前为 0.1.1（旧版本，尚未包含内嵌集成）；0.2.0 安装包重建后由 packaging 在隔离目录实测覆盖安装目录路径，
  本表第 3 项已用“打包布局模拟”提前验证 `<InstallDir>/unity/FCANebulaWebGL` 解析、内嵌加载与退出清理；
- Electron 截图矩阵默认仍使用 `--nebula-engine=webgl`（保持历史截图稳定）；验证内嵌时显式传 `--nebula-engine=unity`。

---

## 7. 验收与证据

| 项 | 命令/位置 | 状态 |
|---|---|---|
| 静态自检（括号/语法/JSON/契约/Editor 入口/WebGL 桥） | `powershell -File unity/FCANebula/scripts/verify-source.ps1` | ✅ 通过 |
| Unity **2022.3** 编译（standalone + WebGL 两次构建） | `bootstrap.log` / `build.log` / `webgl-build.log` 无 `error CS` / `Shader error` | ✅ 0 errors |
| Bootstrap 产物 | `Assets/Scenes/FCANebula.unity`、`Assets/Resources/Nebula/*.mat`、`EditorBuildSettings` | ✅ 已生成 |
| **WebGL 构建（Electron 内嵌主路径）** | `artifacts/unity/FCANebulaWebGL/index.html` + `Build/*.js/.wasm/.data`，**19 files / 24.9 MB**，`fca-webgl-build-info.json` 0 errors | ✅ 构建成功（见 §11.3） |
| **WebGL 真实数据截图 ×3** | `artifacts/unity/webgl-shots/webgl-view-{0,1,2}.png` + `webgl-shots-manifest.json` + `logs/` | ✅ 真实 Runtime（见 §11.4） |
| Windows standalone（开发/备用） | `artifacts/unity/FCANebula/FCANebula.exe` | ✅ 构建成功（见 §9） |
| standalone 真实数据截图 ×3 | `artifacts/unity/shots-final/screenshot-{1,2,3}-*.png` + `screenshots-manifest.json` | ✅（见 §9） |
| 脱敏样例 | `artifacts/unity/sample-graph.json`（与 StreamingAssets 同份） | ✅ 已重新导出 |
| token 不落盘 | WebGL manifest / 静态服务日志中 token 已 `[REDACTED]`；构建产物不含 token | ✅ 已扫描验证 |

### 截图说明

**WebGL（Electron 内嵌，`artifacts/unity/webgl-shots/`，1600×1000）**

| 文件 | 机位 | 体现内容 |
|---|---|---|
| `webgl-view-0.png` | overview（az=-90°, el=27°） | 多条 workspace 旋臂（青蓝 FCA / 蓝 / 冷白 default）+ 深空星场 + HUD 图例 |
| `webgl-view-1.png` | workspace-arm 特写 + 预选记忆 | 真实记忆 title/正文详情面板（中文 HUD 由内置 Noto Sans SC 渲染）+ 同臂星点 |
| `webgl-view-2.png` | top-down（el≈84°） | 对数螺旋几何形状、每条臂颜色、关系光丝 |

`webgl-shots-manifest.json` 记录：CDP URL（token 已脱敏）、真实 viewport、Unity 版本、compression、connected/sample、节点/关系/旋臂数、armSummary、layout、WebGL 诊断（tokenProvided / volumeMaterialOk / armCountUniform / emissionScale / marchSteps）、文件列表；`logs/` 含 Unity 控制台日志与浏览器日志（无 token）。

**standalone（`artifacts/unity/shots-final/`，1600×1000）**

| 文件 | 机位 | 体现内容 |
|---|---|---|
| `screenshot-1-overview.png` | overview | 全盘旋臂分布 + 顶部状态/右侧图例 + 节点标签 |
| `screenshot-2-workspace-arm.png` | FCA 旋臂特写 | 点选最高 importance 记忆后的详情面板（真实 title/正文前 500 字） |
| `screenshot-3-top-down.png` | 近俯视 | 对数螺旋几何 + 每条臂颜色 + 关系光丝 |

`screenshots-manifest.json` 记录：生成时间、Runtime URL、画质、是否 SAMPLE、节点/关系/旋臂数、每条臂节点数与颜色 key、文件列表。

---

## 8. 已知限制 / 未验证项

1. **体积着色器最多 8 条旋臂**（`_ArmColors[8]`）：workspace 超过 8 个时，节点仍严格按各自臂分布，但星云体积只渲染前 8 条臂（HUD 显示黄色提示）。如真实 workspace 数长期 >8，可把上限提高到 12（GPU 成本上升）或把最小 workspace 合并为 `other` 臂。
2. **无 SSE，使用轮询**（默认 3s）：满足当前需求；如后续需要秒级实时，可加 `GET /api/v1/events/stream` 订阅（SSE 解析需自写增量 JSON 解析器）。
3. **HUD 使用 IMGUI**：刻意避免 TextMeshPro/uGUI 资源导入与包依赖；中文依赖系统字体（Microsoft YaHei 等），无中文字体的机器会显示方块（功能不受影响）。若后续要做精细 UI，可换成 uGUI/TMP（需保证 Editor 批处理导入 TMP Essentials）。
4. **关系光丝是 CPU 合并 ribbon Mesh**：关系数达到数万级时重建开销上升；当前百级规模无问题。
5. **截图依赖真实 GPU 会话**：`-nographics` 不能运行 Player；截图必须在有桌面/GPU 的会话中运行（本机已验证可行，见 §9）。
6. **位置不使用 Runtime 布局坐标**：这是用户需求（强制按 workspace 归臂）的直接结果；Runtime 的 `position/layout_nodes` 在本渲染器中仅作为背景参考，不参与落点。若未来需要“保留手动拖动位置”，需要新增 `workspace` 约束下的局部松弛算法。
7. **Unity 2022.3 LTS**（非 Unity 6）：本机仅安装 2022.3；代码保持 C# 9/Unity 2022 API 兼容（`JsonUtility`、`UnityWebRequest.Result`），未使用 6000-only API。若升级 Unity 6 LTS，需重新跑 Bootstrap/Build 验证。
8. **构建/截图证据**以本文件 §9 记录为准；如换机器复现，按 §5 重新构建即可。
9. **节点层使用“单次动态 billboard 网格批绘”而非 MPB instancing**：2022.3 standalone 实测 `Graphics.DrawMeshInstanced + MaterialPropertyBlock` 路径不产生像素（HUD/标签正常），改为每帧重建一个星点网格（一次 draw call，4 顶点/节点）后正常；节点数达到数万时每帧重建会有 CPU 开销，届时应切换为 `ComputeBuffer`/`Graphics.DrawProcedural` 方案。
10. **standalone 截图/验收必须可见窗口**：隐藏窗口启动（如 PowerShell `-WindowStyle Hidden`）时 GPU 不呈现，`ScreenCapture` 会得到同 hash 的黑帧；同时截图模式会强制 1600×1000 窗口。
11. **WebGL 需要浏览器 WebGL2**：体积星云 shader 在 WebGL 平台使用 `#pragma target 3.0` 分支（WebGL2/GLSL ES 3.0），并已实测编译通过；WebGL1-only 浏览器不支持（Electron/Chromium 满足）。
12. **WebGL 压缩为 Disabled**：为让 Electron 本地静态服务无需 Brotli/Gzip 头与 decompression fallback；代价是 wasm/data 未压缩（wasm 10.6MB + data 15.1MB，总计 24.9MB），首次加载比 Brotli 慢。若后续发布包需要更小体积，可改 Gzip/Brotli 并让服务端返回正确 `Content-Encoding`。
13. **WebGL 的 token 经 URL query 注入**：WebGL 无文件系统，`?token=` 仅出现在本机 `127.0.0.1:<随机端口>` iframe URL；Unity 侧不写日志/不落盘，截图 manifest 与静态服务日志已对 token 脱敏（`[REDACTED]`）。若 Electron 有本地代理，可用 `runtime-url=/` 相对路径把 token 留在主进程（Unity 支持相对 base）。
14. **WebGL HUD 的中文依赖内置 Noto Sans SC**（`Assets/Resources/Fonts/NotoSansSC-VF.ttf`，SIL OFL 1.1，约 17.7MB，已计入 data）；若移除该字体中文会显示方块。standalone 使用系统字体（Microsoft YaHei 等）。
15. **WebGL 验收截图使用 headless Edge + SwiftShader**（软件 WebGL）以保证可重复：因此画质取 `low`（24 steps）、截图耗时数分钟/次；`medium` 在 1600×1000 软件渲染下会超时。真实 GPU 浏览器可用 `medium/high`。
16. **不要给 Electron iframe 加 `sandbox` 属性**：实测 Unity 2022 WebGL 在 Chromium sandboxed iframe 中无法完成初始化（资源加载/wasm 编译失败），Electron 侧已采用跨源 iframe + 只读本地服务 + CSP 白名单的收敛方案（详见 §6.9，desktop-integration 维护）。

---

## 9. 实测记录（Editor 就绪后）

环境：Windows 11（Asia/Tokyo）；Unity **2022.3.62f3c1**（`D:\Unity\Hub\Editor\2022.3.62f3c1\Editor\Unity.exe`，License 已激活）；Built-in Render Pipeline；GPU 会话可用。

### 9.1 batchmode 命令与结果（exit 0）

```powershell
# 1) Bootstrap：材质/场景/PlayerSettings
& 'D:\Unity\Hub\Editor\2022.3.62f3c1\Editor\Unity.exe' -batchmode -nographics -quit `
  -projectPath 'D:\FCA\FCA-Memory-Atlas\unity\FCANebula' `
  -executeMethod FCANebula.EditorTools.ProjectBootstrap.BootstrapAll `
  -logFile 'D:\FCA\_scratch\unity\bootstrap.log'
# 日志: [FCA] Bootstrap OK · scene=Assets/Scenes/FCANebula.unity · materials=Assets/Resources/Nebula

# 2) 构建 Windows standalone
& 'D:\Unity\Hub\Editor\2022.3.62f3c1\Editor\Unity.exe' -batchmode -nographics -quit `
  -projectPath 'D:\FCA\FCA-Memory-Atlas\unity\FCANebula' `
  -executeMethod FCANebula.EditorTools.BuildScript.BuildWindows `
  -logFile 'D:\FCA\_scratch\unity\build.log'
# 日志: Build Finished, Result: Success / [FCA] BUILD OK: ...\FCANebula.exe (0 errors, 00:00:02.4)
```

- 编译：`Assets/Scripts` + `Assets/Editor` 全部通过 Unity 2022.3 的 C# 9 编译，0 errors；
- 期间修复：`Packages/manifest.json` 中 `com.unity.modules.accessibility` 仅 Unity 6 存在（Lead 已移除）；节点层 instancing→动态网格（见 §9.5）；多轮视觉调参（见 §9.5）。

### 9.2 构建产物

| 项 | 值 |
|---|---|
| 可执行 | `artifacts/unity/FCANebula/FCANebula.exe`（666,624 B ≈ 0.64 MB） |
| 整个 Player 目录 | `artifacts/unity/FCANebula/`（含 `FCANebula_Data/`、`UnityPlayer.dll`、`MonoBleedingEdge/`，共 **67.1 MB**） |
| 构建日志 | `D:\FCA\_scratch\unity\bootstrap.log`、`build.log` |
| 场景/材质 | `unity/FCANebula/Assets/Scenes/FCANebula.unity`、`Assets/Resources/Nebula/*.mat` |
| Electron 集成路径 | **WebGL：`artifacts/unity/FCANebulaWebGL/index.html`**（主路径）；standalone `FCANebula.exe` 为开发/备用 |

### 9.3 最终真实数据截图（`artifacts/unity/shots-final/`）

```powershell
artifacts\unity\FCANebula\FCANebula.exe `
  --runtime-url=http://127.0.0.1:17860 `
  --token-file=<FCA_DATA_DIR>\config\runtime-token --fca-home=<FCA_DATA_DIR> `
  --quality=high --screenshot-dir=artifacts\unity\shots-final --screenshot-count=3 --screenshot-delay=8 `
  -logFile D:\FCA\_scratch\unity\player-final.log
```

| 文件 | 大小 | 内容 |
|---|---|---|
| `screenshot-1-overview.png` | 2,961,030 B | 1600×1000；FCA 青蓝旋臂 + default 冷白小臂 + 暖色核球 + 深空星场 + HUD/图例 |
| `screenshot-2-workspace-arm.png` | 2,916,688 B | FCA 旋臂特写；预选最高 importance 记忆，左侧详情面板显示真实 title / 正文前 500 字 |
| `screenshot-3-top-down.png` | 2,811,195 B | 近俯视；对数螺旋几何、每条臂颜色、关系光丝清晰可见 |
| `screenshots-manifest.json` | 786 B | 见下方 JSON |

```json
{
  "generated_at": "2026-11-12T10:38:21.6514849Z",
  "runtime_url": "http://127.0.0.1:17860",
  "quality": "high",
  "sample_data": false,
  "connected": true,
  "node_count": 10,
  "edge_count": 3,
  "arm_count": 2,
  "arm_summary": "FCA:9(cyan) | default:1(default)",
  "layout_signature": "v1|2|FCA:9|default:1",
  "presets": ["overview", "workspace-arm", "top-down"],
  "note": "真实 FCA Runtime 数据截图。"
}
```

- 数据为**真实 Runtime**（connected=true / sample_data=false）；截图期间 live 库持续写入，manifest 以抓图瞬间为准；
- 早前 `artifacts/unity/shots/`（清理前 12 节点 / FCA:3 + default:9）保留用于对比；
- `[FCA] 图更新: nodes=… arms=2 layout=…` 与截图文件均在 `D:\FCA\_scratch\unity\player-final.log`。

### 9.4 最终 arm 统计与数据侧变化

- Lead 回填 `workspace:FCA` + memory-pipeline v0.2.1 清理后，**8 条真实用户/Agent 记忆全部为 `workspace:FCA`**（Legacy 提示词噪声已软删除，`GET /api/v1/graph` 不再返回）；
- 实体 `FCA 工作区` 当前不带 workspace 标签，依据契约归 **default** 旋臂（1 节点，冷白偏蓝小臂）；若 pipeline 后续也给 entity 打 `workspace:FCA`，default 旋臂会消失；
- 截图批次时 Runtime 又写入 1 条 Agent 思考节点，故 manifest 为 `FCA:9 / default:1`；live 数据持续增长，布局会按新节点增量重算（曲线仍强制同 workspace 同臂）。

### 9.5 渲染验证与调参记录

1. **初版体积过曝**：arm 密度/核心亮度导致白团，已降低 emission 至 0.30×、臂密度系数、增加尘埃+气体自遮挡、收窄径向宽度/垂直厚度 → 最终为暗底彩色星云；
2. **节点不可见**：`Graphics.DrawMeshInstanced + MaterialPropertyBlock` 在 player 中不产生像素（标签/HUD 正常、无报错）；改为每帧合并动态 billboard Mesh（顶点色 + TEXCOORD1 携带选中/悬停/相位）后节点正常显示（详见 §8.9）；
3. 节点亮度增益、最小屏幕像素、标签阈值与防重叠、图例宽度、overview 仰角（17°→27°）与本任务验收截图对应的机位均在最终构建中；
4. 截图模式强制 1600×1000 窗口，且必须可见窗口（§8.10）。

### 9.6 说明

- 本文 §6（Electron 实际实现）与 §10（变更记录）由 desktop-integration 维护，与本记录并行；
- 本构建为 Mono/非 IL2CPP；未做代码混淆。

---

## 10. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-12 | 初始版本：Built-in RP Unity 项目源码/Editor 批处理/文档/脱敏样例；workspace tag → 对数螺旋旋臂；轮询 API + HUD + 截图模式 |
| 2026-11-12 | **Electron 集成（task-9）· 内嵌 Unity WebGL**：按用户新要求从“独立 Unity 窗口”改为 **WebGL 内嵌**——新增 `desktop/main/unity-embed.js`（127.0.0.1 随机端口只读静态服务 + iframe URL + 状态机）、IPC `fca:unity:start/stop/status/log-tail`、preload `window.fca.unity`、atlas iframe 容器/加载覆盖层/引擎切换/自动回退 WebGL、设置项 `nebulaEngine`（默认 unity）+ `unityWebglDir`、`installer/build.js` 可选 payload `unity/FCANebulaWebGL`（默认不打包旧 standalone）、`scripts/unity-integration-check.js` 重写为 WebGL 内嵌自检；§6 重写为内嵌实现 + §6.12 最终构建实测证据。旧 standalone 代码保留为 `FCA_UNITY_STANDALONE=1` 开发开关。 |

---

## 11. WebGL 构建与内嵌契约（unity-renderer 交付）

> 本节是 Unity 侧（unity-renderer）对 WebGL 构建/运行时/验收接口的正式契约；Electron 内嵌实现见 §6（desktop-integration 维护）。

### 11.1 构建命令与结果（2022.3.62f3c1 · WebGL2 · 0 errors）

```powershell
& 'D:\Unity\Hub\Editor\2022.3.62f3c1\Editor\Unity.exe' -batchmode -nographics -quit `
  -buildTarget WebGL -projectPath 'D:\FCA\FCA-Memory-Atlas\unity\FCANebula' `
  -executeMethod FCANebula.EditorTools.BuildScript.BuildWebGL `
  -logFile 'D:\FCA\_scratch\unity\webgl-build.log'
```

- 结果：`Build Finished, Result: Success`、`[FCA] WEBGL BUILD OK: ...\FCANebulaWebGL\index.html`，构建日志约 82 KB（`D:\FCA\_scratch\unity\webgl-build.log`）；
- 产物：**`artifacts/unity/FCANebulaWebGL/`，19 files / 24.9 MB**（`index.html` 7,810 B + `Build/`：wasm 10,643,126 B / data 15,052,954 B / framework.js 345,800 B / loader.js 20,680 B + `TemplateData/` + `StreamingAssets/sample-graph.json`）；
- `fca-webgl-build-info.json`：`unity_version=2022.3.62f3c1`、`compression=disabled`、`memory_size_mb=512`、`data_caching=true`、`exception_support=FullWithoutStacktrace`、`total_errors=0`；
- 自定义页面模板 `Assets/WebGLTemplates/FCANebula/index.html`（全屏 canvas、深色背景、无滚动条、加载层、`window.FCA_NEBULA` API）；
- 验收：`BuildScript.BuildWebGL` 会先清空输出目录再构建，并校验 `index.html` 存在后写 build-info；构建失败时 batchmode 退出码非 0。

### 11.2 运行时接口契约

**URL query（详见 §2.5.1）**

```
index.html?runtime-url=http://127.0.0.1:17860&token=<bearer>&quality=high&view=0&poll=2&auto-rotate=0&labels=0
```

**Unity → 页面（`Assets/Plugins/WebGL/FCABridge.jslib`）**

| 通道 | 内容 |
|---|---|
| `window.__FCA_READY__` | `true` 表示首帧真实图已渲染 |
| `window.__FCA_NEBULA_STATE__` | 当前状态对象（见下） |
| `window.__FCA_NEBULA_UNITY__` | `unityInstance`（Unity loader 返回实例） |
| `window.postMessage` | `{type:'fca-unity-ready', payload}`（一次）；`{type:'fca-unity-state', payload}`（每次状态/图更新） |
| `window` DOM 事件 | `new CustomEvent('fca-unity-ready'/'fca-unity-state', {detail: payload})` |

`payload` 字段（`WebGLBridge.cs`，JSON via `JsonUtility`）：

```json
{
  "ready": true, "connected": true, "sample": false, "state": "Online",
  "runtimeUrl": "http://127.0.0.1:17860", "quality": "low",
  "nodes": 20, "edges": 11, "arms": 3,
  "armSummary": "FCA:13 | 大肥鱼帮我赚钱:1 | default:6",
  "layout": "v1|3|FCA:13|大肥鱼帮我赚钱:1|default:6",
  "view": 0, "webgl": true,
  "tokenProvided": true, "initialView": 0,
  "volumeMaterialOk": true, "armCountUniform": 3,
  "emissionScale": 0.225, "marchSteps": 24
}
```

**页面 → Unity（模板 `window.FCA_NEBULA`）**

| JS API | 说明 |
|---|---|
| `FCA_NEBULA.getState()` | 返回 `__FCA_NEBULA_STATE__`（未 ready 时退化为 `{ready:false}`） |
| `FCA_NEBULA.setView(0|1|2)` | 切换验收/展示机位（overview / workspace-arm / top-down） |
| `FCA_NEBULA.setQuality('high')` | 切换画质档位 |
| `FCA_NEBULA.refresh()` | 立即拉取 Runtime graph |
| `FCA_NEBULA.postCommand('labels:0')` | 通用命令通道（`SendMessage("FCA Nebula System","OnJsCommand",cmd)`） |

**加载/失败状态**：token 缺失或 Runtime 不可达时，HUD 显示红色错误横幅且 `connected=false`（不伪造数据）；`sample` 在 WebGL 恒为 false（WebGL 不读取 StreamingAssets 样例文件）。

### 11.3 验收证据（2026-11-12，真实 Runtime 数据）

| 项 | 证据 |
|---|---|
| 构建 | `D:\FCA\_scratch\unity\webgl-build.log`（Success / 0 errors）；`artifacts/unity/FCANebulaWebGL/fca-webgl-build-info.json` |
| 静态自检 | `unity/FCANebula/scripts/verify-source.ps1` → 通过（含 WebGL 模板/jslib/bridge/字体/服务脚本检查） |
| 真实数据截图 ×3 | `artifacts/unity/webgl-shots/webgl-view-0.png` / `webgl-view-1.png` / `webgl-view-2.png`（1600×966~1000，headless Edge + SwiftShader） |
| manifest | `artifacts/unity/webgl-shots/webgl-shots-manifest.json`：`connected=true`、`sample_data=false`、`nodes=20`、`edges=11`、`arms=3`、`arm_summary="FCA:13 | 大肥鱼帮我赚钱:1 | default:6"`、token=[REDACTED] |
| 控制台/异常日志 | `artifacts/unity/webgl-shots/logs/webgl-console.log`、`webgl-browser-log.log`、`webgl-exceptions.log`（空） |
| token 安全 | manifest URL 与静态服务日志已脱敏；全 `artifacts/unity` 扫描无明文 token |

### 11.4 本机复现/重新验收

```powershell
# 1) 启动只读本地静态服务（token 日志脱敏、wasm MIME 正确）
python unity/FCANebula/scripts/serve-webgl.py --port 18080
# 2) 用 headless Edge + CDP 抓 3 张真实截图（Node >= 22；脚本自己管理 Edge，不需要外部静态服务时也可配合上一步）
node unity/FCANebula/scripts/capture-webgl-cdp.mjs `
  --url "http://127.0.0.1:18080/index.html?runtime-url=http%3A%2F%2F127.0.0.1%3A17860&token=<TOKEN>&quality=low&view=0&auto-rotate=0&labels=0&poll=3" `
  --out artifacts/unity/webgl-shots --width 1600 --height 1000 --timeout 240000 --settle 3000
```

- `<TOKEN>` 从 `%LOCALAPPDATA%\FCA-Memory-Atlas\config\runtime-token`（或 `<FCA_DATA_DIR>\config\runtime-token`）读取；**不要**把带 token 的 URL 写入任何文件/日志；
- 无 Node 时可用备用脚本 `capture-webgl-shots.ps1`（Edge `--virtual-time-budget`），稳定性低于 CDP 版；
- 截图默认 `labels=0`（干净星云）；需要中文节点标签时 `labels=1`（WebGL 内置 Noto Sans SC 可正常显示）。

### 11.5 内嵌注意事项（与 Electron 对齐）

1. **不要给 iframe 加 `sandbox`**（Unity WebGL 在 Chromium sandboxed iframe 中无法初始化；原因与收敛方案见 §6.9）；
2. iframe 的 `src` 为 `http://127.0.0.1:<随机端口>/index.html?...`，页面只读、仅 GET；Unity 侧无本地文件/窗口权限；
3. **token 只放 iframe URL query**，主进程日志/状态广播/截图验收数据均不含明文（Unity 侧已对 manifest/服务日志脱敏）；
4. **画布自适应**：模板 canvas 为 `width/height: 100%`，Unity `matchWebGLToCanvasSize` 打开，跟随 iframe 容器 resize；深色背景无滚动条；
5. **首次加载**：24.9MB 静态资源 + WebGL2 初始化；Electron 覆盖层可等 `fca-unity-ready`（用户实测约 3–8s，含 Runtime 首轮图）；
6. **不支持 WebGL1-only 浏览器**；Electron/Chromium 默认 WebGL2；
7. **性能**：软件渲染（SwiftShader）下 raymarch 较慢（验收用 `quality=low`），真实 GPU 可达 `high`；如嵌入面板很小，可把 `quality` 设为 `medium` 以平衡清晰度/帧率。

### 11.6 与 standalone 的关系

- standalone（`artifacts/unity/FCANebula/FCANebula.exe`）仅作为**开发/备用**：可独立窗口运行、支持 CLI 参数与自动截图（`ScreenshotRunner`），便于脱离 Electron 调渲染参数；
- WebGL 为 **Electron 内嵌主路径**；两者共享同一套场景/布局/着色器代码，区别仅在：配置来源（CLI/token 文件 vs URL query）、HUD 字体（系统字体 vs 内置 Noto）、截图方式（ScreenCapture vs 页面 CDP）、部分平台分支（`#if UNITY_WEBGL`）。

