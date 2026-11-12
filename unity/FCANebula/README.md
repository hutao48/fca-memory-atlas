# FCA Nebula (Unity)

把 FCA Memory Atlas 的星云图形渲染迁移到 Unity。用户核心需求：**同一工作区的记忆自动归到星云的一条旋臂** —— 按节点 tags 中的 `workspace:<label>` 分组，每个 workspace 一条对数螺旋臂，无标签归 `default` 臂；图例显示每条臂颜色/名称/节点数。

**集成路径**：Unity 构建为 **WebGL**，由 Electron 本地静态服务 + iframe 内嵌到软件界面（主路径，见 docs §6/§11）；Windows standalone 构建保留为开发/备用。

- 引擎：**Unity 2022.3 LTS**（本机 `2022.3.62f3c1`），**Built-in Render Pipeline**，无 URP/HDRP/第三方包（WebGL 需 WebGL Build Support 模块）
- 数据：真实 FCA Runtime `GET /api/v1/graph`（Bearer token）+ 轮询刷新；失败不伪造
- 主产物：**`artifacts/unity/FCANebulaWebGL/`**（`index.html` + `Build/*.wasm/.data`，约 24.9 MB）；开发用 standalone：`artifacts/unity/FCANebula/FCANebula.exe`
- 完整文档：**[docs/UNITY_NEBULA.md](../../docs/UNITY_NEBULA.md)**（数据契约/旋臂公式/配色/构建/WebGL 内嵌契约/Electron 实现/限制）

## 快速开始

```powershell
# 1) WebGL 构建（Electron 内嵌主路径；需 Unity WebGL Build Support 模块）
& 'D:\Unity\Hub\Editor\2022.3.62f3c1\Editor\Unity.exe' -batchmode -nographics -quit `
  -buildTarget WebGL -projectPath unity/FCANebula `
  -executeMethod FCANebula.EditorTools.BuildScript.BuildWebGL `
  -logFile D:\FCA\_scratch\unity\webgl-build.log
# 或：powershell -File unity/FCANebula/scripts/build.ps1 -WebGL

# 2) 本地静态服务验证 / Electron 内嵌
#    index.html + URL query 参数见 docs §2.5.1/§11.2
python unity/FCANebula/scripts/serve-webgl.py --port 18080
#    http://127.0.0.1:18080/index.html?runtime-url=http%3A%2F%2F127.0.0.1%3A17860&token=<TOKEN>&quality=high

# 3) WebGL 验收截图（headless Edge + CDP；输出 3 张真实数据图 + manifest + 日志）
node unity/FCANebula/scripts/capture-webgl-cdp.mjs `
  --url "http://127.0.0.1:18080/index.html?runtime-url=http%3A%2F%2F127.0.0.1%3A17860&token=<TOKEN>&quality=low&view=0&auto-rotate=0&labels=0" `
  --out artifacts/unity/webgl-shots --width 1600 --height 1000

# 4) 静态自检（结构/语法/JSON/契约/WebGL 桥/token 安全）
powershell -NoProfile -ExecutionPolicy Bypass -File unity/FCANebula/scripts/verify-source.ps1

# 5) （开发/备用）Windows standalone 构建 + 独立窗口运行 + 截图
powershell -NoProfile -ExecutionPolicy Bypass -File unity/FCANebula/scripts/build.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File unity/FCANebula/scripts/run.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File unity/FCANebula/scripts/capture-screenshots.ps1
```

standalone 启动参数：`FCANebula.exe --runtime-url=http://127.0.0.1:17860 --token-file=<path> --fca-home=<dir> --quality=high`。

## Editor 内预览

Unity Hub 打开本目录 → 菜单 **FCA → Bootstrap Nebula Scene (Built-in RP)** → 打开 `Assets/Scenes/FCANebula.unity` → Play。
Runtime 不在线时 Editor 会回退 `Assets/StreamingAssets/sample-graph.json` 并显示 **SAMPLE** 横幅。

## 目录

- `Assets/Scripts/` — 数据/布局/渲染/HUD 运行时脚本（含 `Scripts/WebGL/WebGLBridge.cs`）
- `Assets/Plugins/WebGL/FCABridge.jslib` — Unity↔页面 postMessage 桥（fca-unity-ready / fca-unity-state）
- `Assets/WebGLTemplates/FCANebula/` — 自定义 WebGL 页面模板（全屏 canvas、`window.FCA_NEBULA` API）
- `Assets/Resources/Fonts/NotoSansSC-VF.ttf` — WebGL 中文 HUD 字体（SIL OFL 1.1）
- `Assets/Shaders/` — 体积星云、星点、关系光丝、bloom 后处理
- `Assets/Editor/` — `ProjectBootstrap`（场景/材质/PlayerSettings）、`BuildScript`（`BuildWindows` + `BuildWebGL`）
- `scripts/` — 构建/运行/截图（standalone + WebGL CDP）/样例导出/静态自检/本地静态服务

## 注意

- 本目录首次用 Unity 打开会生成 `Library/`、`*.meta`、`*.csproj/.sln`（已加入 `.gitignore`）。
- WebGL 构建产物约 24.9 MB（wasm 10.6MB + data 15.1MB，compression=Disabled）；重跑构建会清空 `artifacts/unity/FCANebulaWebGL/`。
- **token 安全**：WebGL 的 token 只放在本机 iframe URL query 中；Unity 不落盘，截图 manifest/静态服务日志已脱敏（`[REDACTED]`）。
- **不要给 iframe 加 `sandbox`**（Unity WebGL 无法在 sandboxed iframe 初始化，详见 docs §6.9）。
- Runtime 仅 GET，不写库；构建/运行不重启 DSH、不操作 17860 端口。
