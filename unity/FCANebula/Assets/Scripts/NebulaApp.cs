// FCA Memory Atlas — Unity Nebula Renderer
// NebulaApp: scene orchestrator. Creates/patches the render rig at runtime, wires the
// API client -> spiral layout -> renderers -> HUD pipeline, and applies quality tiers.
// The scene created by Assets/Editor/ProjectBootstrap.cs is just "Main Camera + this
// component"; everything else is reconstructed in Awake so an empty-scene build still works.

using System;
using UnityEngine;

namespace FCANebula
{
    public sealed class NebulaApp : MonoBehaviour
    {
        public static NebulaApp Instance { get; private set; }

        public AppConfig Config { get; private set; }
        public FcaApiClient Api { get; private set; }
        public WorkspaceSpiralLayout LayoutBuilder { get; private set; }
        public NebulaFieldRenderer Nebula { get; private set; }
        public NodeRenderer Nodes { get; private set; }
        public EdgeRenderer Edges { get; private set; }
        public UiOverlay Ui { get; private set; }
        public NebulaCameraRig CameraRig { get; private set; }
        public HierarchyController Hierarchy { get; private set; }
#if !UNITY_WEBGL || UNITY_EDITOR
        public ScreenshotRunner Screenshots { get; private set; }
#endif

        public GraphModel CurrentGraph { get; private set; }
        public LayoutModel CurrentLayout { get; private set; }
        public string CurrentLayoutSignature = "";
        public event Action<LayoutModel, GraphModel> GraphApplied;

        bool _initialized;
        Camera _camera;
        bool _firstGraphReadyNotified;
        bool _initialViewApplied;

        public string QualityKey
        {
            get
            {
                if (Config == null)
                {
                    return "high";
                }
                return QualityProfile.For(Config.Quality).Key;
            }
        }

        void Awake()
        {
            if (Instance != null && Instance != this)
            {
                Debug.LogWarning("[FCA] 另一个 NebulaApp 已存在；销毁重复实例。");
                Destroy(gameObject);
                return;
            }
            Instance = this;
            Config = AppConfig.Current;
            Application.targetFrameRate = Config.IsScreenshotMode ? 30 : 60;
            QualitySettings.vSyncCount = 0;
            QualitySettings.antiAliasing = 4;
            SetupRig();
            _initialized = true;
        }

        void SetupRig()
        {
            _camera = EnsureCamera();

            NebulaCameraRig rig = _camera.GetComponent<NebulaCameraRig>();
            if (rig == null)
            {
                rig = _camera.gameObject.AddComponent<NebulaCameraRig>();
            }
            CameraRig = rig;
            CameraRig.Initialize(Config, _camera);

            NebulaFieldRenderer field = _camera.GetComponent<NebulaFieldRenderer>();
            if (field == null)
            {
                field = _camera.gameObject.AddComponent<NebulaFieldRenderer>();
            }
            Nebula = field;
            Nebula.Initialize(Config, _camera);
            if (Nebula.VolumeMaterial == null)
            {
                Debug.LogError("[FCA] NebulaVolume shader 缺失：请先用 ProjectBootstrap 创建 Resources/Nebula 材质，或确认 Assets/Shaders 已导入。");
            }

            FcaApiClient api = GetComponent<FcaApiClient>();
            if (api == null)
            {
                api = gameObject.AddComponent<FcaApiClient>();
            }
            Api = api;
            Api.Initialize(Config);
            Api.GraphUpdated += OnGraphUpdated;

            WorkspaceSpiralLayout layout = GetComponent<WorkspaceSpiralLayout>();
            if (layout == null)
            {
                layout = gameObject.AddComponent<WorkspaceSpiralLayout>();
            }
            LayoutBuilder = layout;

            NodeRenderer nodeRenderer = GetComponent<NodeRenderer>();
            if (nodeRenderer == null)
            {
                nodeRenderer = gameObject.AddComponent<NodeRenderer>();
            }
            Nodes = nodeRenderer;
            Nodes.Initialize(Config, _camera);
            Nodes.SelectionChanged += OnNodeSelectionChanged;

            EdgeRenderer edgeRenderer = GetComponent<EdgeRenderer>();
            if (edgeRenderer == null)
            {
                edgeRenderer = gameObject.AddComponent<EdgeRenderer>();
            }
            Edges = edgeRenderer;
            Edges.Initialize(Config, _camera);

            HierarchyController hierarchy = GetComponent<HierarchyController>();
            if (hierarchy == null)
            {
                hierarchy = gameObject.AddComponent<HierarchyController>();
            }
            Hierarchy = hierarchy;
            Hierarchy.Initialize(this);

            UiOverlay ui = GetComponent<UiOverlay>();
            if (ui == null)
            {
                ui = gameObject.AddComponent<UiOverlay>();
            }
            Ui = ui;
            Ui.Initialize(Config, Api, this, Nodes, Edges, CameraRig, Nebula);
            Ui.ShowHud = Config.ShowHudFromQuery;
            CameraRig.SetUiOverlay(Ui);

#if !UNITY_WEBGL || UNITY_EDITOR
            if (Config.IsScreenshotMode)
            {
                ScreenshotRunner runner = GetComponent<ScreenshotRunner>();
                if (runner == null)
                {
                    runner = gameObject.AddComponent<ScreenshotRunner>();
                }
                Screenshots = runner;
                Screenshots.Initialize(Config, this);
            }
#endif

            Api.StartPolling();
            Debug.Log("[FCA] NebulaApp ready · runtime=" + Config.RuntimeUrl + " · quality=" + QualityKey +
                      " · screenshotMode=" + Config.IsScreenshotMode);
        }

        Camera EnsureCamera()
        {
            Camera camera = Camera.main;
            if (camera == null)
            {
#if UNITY_2023_1_OR_NEWER
                Camera[] all = UnityEngine.Object.FindObjectsByType<Camera>(FindObjectsSortMode.None);
#else
                Camera[] all = UnityEngine.Object.FindObjectsOfType<Camera>();
#endif
                if (all != null && all.Length > 0)
                {
                    camera = all[0];
                }
            }
            if (camera == null)
            {
                GameObject cameraObject = new GameObject("Main Camera");
                cameraObject.tag = "MainCamera";
                camera = cameraObject.AddComponent<Camera>();
                cameraObject.AddComponent<AudioListener>();
                camera.transform.position = new Vector3(0f, -620f, 180f);
                camera.transform.rotation = Quaternion.Euler(14f, 0f, 0f);
                Debug.Log("[FCA] 场景中没有相机，已创建 Main Camera。");
            }
            if (!camera.gameObject.CompareTag("MainCamera"))
            {
                camera.gameObject.tag = "MainCamera";
            }
            return camera;
        }

        void OnGraphUpdated(GraphModel graph)
        {
            if (graph == null)
            {
                return;
            }
            try
            {
                LayoutModel layout = LayoutBuilder.Build(graph);
                CurrentGraph = graph;
                CurrentLayout = layout;
                CurrentLayoutSignature = layout.Signature;

                Nebula.ApplyLayout(layout);
                Nodes.SetNodes(layout);
                Edges.SetGraph(layout, graph);
                Hierarchy.OnLayoutApplied(layout);
                CameraRig.FrameLayout(layout);

                if (graph.IsEmpty)
                {
                    Debug.Log("[FCA] 收到空图（真实数据为空）：渲染深空背景 + 空白星图提示，不伪造节点。");
                }
                else
                {
                    Debug.Log("[FCA] 图更新: nodes=" + layout.NodeCount + " edges=" + graph.Edges.Count +
                              " arms=" + layout.Arms.Count + " layout=" + layout.Signature);
                }
                GraphApplied?.Invoke(layout, graph);

                if (Config.InitialView >= 0 && !_initialViewApplied)
                {
                    _initialViewApplied = true;
                    ApplyWebGLView(Config.InitialView);
                }
#if UNITY_WEBGL && !UNITY_EDITOR
                WebGLBridge.PushState(Config, Api, layout);
                if (!_firstGraphReadyNotified && layout.NodeCount > 0)
                {
                    _firstGraphReadyNotified = true;
                    WebGLBridge.NotifyReady(Config, Api, layout);
                }
#else
                _firstGraphReadyNotified = true;
#endif
            }
            catch (Exception ex)
            {
                Debug.LogError("[FCA] 应用图数据失败: " + ex);
            }
        }

        /// <summary>Selection bridge: keep Electron's right-hand detail panel in sync (WebGL only).</summary>
        void OnNodeSelectionChanged(LayoutNode node)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            WebGLBridge.NotifySelection(node, CurrentLayout);
#endif
        }

        /// <summary>Switch quality tier (keys 0-4 in the HUD). Re-applies renderer settings.</summary>
        public void SetQualityTier(QualityTier tier)
        {
            if (Config == null)
            {
                return;
            }
            Config.Quality = tier;
            QualityProfile profile = QualityProfile.For(tier);
            if (Nebula != null)
            {
                Nebula.ApplyQuality(profile);
            }
            if (Nodes != null)
            {
                Nodes.ApplyQuality(profile);
            }
            if (Edges != null)
            {
                Edges.ApplyQuality(profile);
            }
            Debug.Log("[FCA] Quality -> " + profile.Key + " (steps=" + profile.MarchSteps + ", octaves=" + profile.NoiseOctaves + ")");
#if UNITY_WEBGL && !UNITY_EDITOR
            WebGLBridge.PushState(Config, Api, CurrentLayout);
#endif
        }

        /// <summary>
        /// Applies a deterministic camera preset (0 overview / 1 workspace arm / 2 top-down)
        /// and, for arm close-ups, selects the highest-importance memory of the arm.
        /// Used by the WebGL acceptance screenshots and Electron toolbar buttons.
        /// </summary>
        public void ApplyWebGLView(int view)
        {
            if (CameraRig == null || CurrentLayout == null)
            {
                return;
            }
            int clamped = Mathf.Clamp(view, 0, 2);
            if (Nodes != null)
            {
                Nodes.ClearSelection();
            }
            CameraRig.ApplyPreset(clamped, CurrentLayout);
            if (clamped == 1)
            {
                LayoutNode showcase = FindShowcaseNode();
                if (showcase != null && Nodes != null)
                {
                    Nodes.Select(showcase, false);
                }
            }
            Debug.Log("[FCA] WebGL view applied: " + clamped);
#if UNITY_WEBGL && !UNITY_EDITOR
            WebGLBridge.SetInitialView(clamped);
            WebGLBridge.PushState(Config, Api, CurrentLayout);
#endif
        }

        /// <summary>Bridge for JS SendMessage('FCA Nebula System','OnJsCommand', cmd).</summary>
        public void OnJsCommand(string command)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            WebGLBridge.OnJsCommand(command);
#else
            Debug.Log("[FCA] JS command ignored outside WebGL: " + command);
#endif
        }

        public void RequestRefresh()
        {
            if (Api != null)
            {
                Api.RequestRefreshNow();
            }
        }

        // -----------------------------------------------------------------
        // Hierarchy commands (HUD, WebGL JS bridge, Electron toolbar)
        // -----------------------------------------------------------------

        public bool ExpandFirstParent()
        {
            if (Hierarchy == null || CurrentLayout == null) return false;
            for (int i = 0; i < CurrentLayout.Nodes.Count; i++)
            {
                LayoutNode node = CurrentLayout.Nodes[i];
                if (node.IsParent && node.ChildIds.Count > 0)
                {
                    Hierarchy.Expand(node.Id);
                    if (Nodes != null) Nodes.Select(node, false);
                    return true;
                }
            }
            return false;
        }

        public bool ExpandParent(string nodeId)
        {
            if (Hierarchy == null || CurrentLayout == null || string.IsNullOrEmpty(nodeId)) return false;
            LayoutNode node;
            if (!CurrentLayout.ById.TryGetValue(nodeId, out node) || !node.IsParent) return false;
            Hierarchy.Expand(nodeId);
            if (Nodes != null) Nodes.Select(node, false);
            return true;
        }

        public bool CollapseParent(string nodeId)
        {
            if (Hierarchy == null || string.IsNullOrEmpty(nodeId)) return false;
            Hierarchy.Collapse(nodeId);
            return true;
        }

        public bool ToggleParent(string nodeId)
        {
            if (Hierarchy == null || CurrentLayout == null || string.IsNullOrEmpty(nodeId)) return false;
            LayoutNode node;
            if (!CurrentLayout.ById.TryGetValue(nodeId, out node) || !node.IsParent) return false;
            Hierarchy.Toggle(nodeId);
            if (Nodes != null) Nodes.Select(node, false);
            return true;
        }

        public bool ToggleFirstParent()
        {
            if (Hierarchy == null || CurrentLayout == null) return false;
            bool anyExpanded = false;
            for (int i = 0; i < CurrentLayout.Nodes.Count; i++)
            {
                LayoutNode node = CurrentLayout.Nodes[i];
                if (node.IsParent && node.ChildIds.Count > 0 && Hierarchy.IsExpanded(node.Id)) { anyExpanded = true; break; }
            }
            if (anyExpanded)
            {
                Hierarchy.CollapseAll();
                return true;
            }
            return ExpandFirstParent();
        }

        public void FocusNode(string nodeId)
        {
            if (Nodes == null || CameraRig == null || string.IsNullOrEmpty(nodeId))
            {
                return;
            }
            LayoutNode node = Nodes.FindNode(nodeId);
            if (node != null)
            {
                Nodes.Select(node, false);
                CameraRig.FocusOnNode(node);
            }
        }

        /// <summary>Highest-importance node of the biggest workspace arm (used by screenshot mode).</summary>
        public LayoutNode FindShowcaseNode()
        {
            if (CurrentLayout == null || CurrentLayout.Arms.Count == 0)
            {
                return null;
            }
            LayoutArm bestArm = null;
            LayoutArm bestNamedArm = null;
            for (int i = 0; i < CurrentLayout.Arms.Count; i++)
            {
                LayoutArm arm = CurrentLayout.Arms[i];
                if (arm.NodeCount <= 0)
                {
                    continue;
                }
                if (!arm.IsDefault && (bestNamedArm == null || arm.NodeCount > bestNamedArm.NodeCount))
                {
                    bestNamedArm = arm;
                }
                if (bestArm == null || arm.NodeCount > bestArm.NodeCount)
                {
                    bestArm = arm;
                }
            }
            if (bestNamedArm != null)
            {
                bestArm = bestNamedArm; // showcase a real workspace arm (FCA/DSH/...) when present
            }
            if (bestArm == null)
            {
                return null;
            }
            LayoutNode best = null;
            for (int i = 0; i < bestArm.Nodes.Count; i++)
            {
                LayoutNode candidate = bestArm.Nodes[i];
                if (best == null || candidate.Source.Importance > best.Source.Importance)
                {
                    best = candidate;
                }
            }
            return best;
        }

        void OnDestroy()
        {
            if (Nodes != null)
            {
                Nodes.SelectionChanged -= OnNodeSelectionChanged;
            }
            if (Api != null)
            {
                Api.GraphUpdated -= OnGraphUpdated;
                Api.StopPolling();
            }
            if (Instance == this)
            {
                Instance = null;
            }
        }
    }
}
