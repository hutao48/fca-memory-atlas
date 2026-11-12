// FCA Memory Atlas — Unity Nebula Renderer
// UiOverlay: dependency-free IMGUI HUD (no TextMeshPro/uGUI package needed):
//   - connection status / runtime URL / token state / last update
//   - workspace arm legend (colour + label + node count)
//   - click-through memory inspector (title + body excerpt, fetched from Runtime)
//   - hover tooltip, node labels, keyboard shortcuts, SAMPLE / error banners.
// IMGUI is used deliberately so the Unity project needs zero extra packages and the
// batchmode-built player always has a HUD.

using System;
using System.Collections.Generic;
using UnityEngine;

namespace FCANebula
{
    public sealed class UiOverlay : MonoBehaviour
    {
        AppConfig _config;
        FcaApiClient _api;
        NodeRenderer _nodes;
        EdgeRenderer _edges;
        NebulaCameraRig _cameraRig;
        NebulaFieldRenderer _nebula;
        NebulaApp _app;
        bool _initialized;

        // UI state
        public bool ShowHud = true;
        public bool ShowLabels = true;
        bool _pointerOverUi;
        Texture2D _white;
        Font _uiFont;
        bool _stylesReady;
        GUIStyle _titleStyle;
        GUIStyle _subtitleStyle;
        GUIStyle _labelStyle;
        GUIStyle _smallStyle;
        GUIStyle _wrapStyle;
        GUIStyle _monoStyle;
        readonly List<Rect> _panelRects = new List<Rect>(8);

        // selection / detail state
        string _detailForId;
        MemoryInfo _detail;
        string _detailError;
        bool _detailLoading;
        bool _detailIsEntity;

        // input state
        Vector2 _mouseDownPosition;
        bool _mouseDown;
        bool _mouseOverUiAtDown;
        float _lastClickTime;
        string _lastClickNodeId;

        // stats
        float _smoothedDeltaTime = 0.016f;
        float _fps;

        public bool PointerOverUi
        {
            get { return _pointerOverUi; }
        }

        public void Initialize(AppConfig config, FcaApiClient api, NebulaApp app, NodeRenderer nodes,
                               EdgeRenderer edges, NebulaCameraRig cameraRig, NebulaFieldRenderer nebula)
        {
            if (_initialized)
            {
                return;
            }
            _config = config;
            _api = api;
            _app = app;
            _nodes = nodes;
            _edges = edges;
            _cameraRig = cameraRig;
            _nebula = nebula;
            ShowLabels = config == null || config.ShowLabels;

            _white = new Texture2D(1, 1, TextureFormat.RGBA32, false);
            _white.SetPixel(0, 0, Color.white);
            _white.Apply();
            _white.hideFlags = HideFlags.DontSave;

            if (_nodes != null)
            {
                _nodes.SelectionChanged += OnSelectionChanged;
            }
            _initialized = true;
            Debug.Log("[FCA] HUD ready (IMGUI, dynamic OS font: " + (CreateFont() != null ? "yes" : "fallback") + ")");
        }

        Font CreateFont()
        {
            if (_uiFont != null)
            {
                return _uiFont;
            }
#if UNITY_WEBGL && !UNITY_EDITOR
            // WebGL has no OS font access: use the bundled Noto Sans SC (SIL OFL 1.1)
            // so Chinese HUD / memory titles render in the embedded player.
            _uiFont = Resources.Load<Font>("Fonts/NotoSansSC-VF");
            if (_uiFont == null)
            {
                Debug.LogWarning("[FCA] WebGL: bundled CJK font Assets/Resources/Fonts/NotoSansSC-VF.ttf not found; Chinese text may not render.");
            }
            return _uiFont;
#else
            try
            {
                _uiFont = Font.CreateDynamicFontFromOSFont(new string[]
                {
                    "Microsoft YaHei UI", "Microsoft YaHei", "SimHei", "SimSun", "Noto Sans CJK SC", "Segoe UI", "Arial"
                }, 16);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[FCA] 无法创建系统中文字体，HUD 中文可能显示为方块: " + ex.Message);
                _uiFont = null;
            }
            return _uiFont;
#endif
        }

        void EnsureStyles()
        {
            if (_stylesReady)
            {
                return;
            }
            Font font = CreateFont();
            _titleStyle = new GUIStyle(GUI.skin.label);
            _titleStyle.fontSize = 18;
            _titleStyle.fontStyle = FontStyle.Bold;
            _titleStyle.richText = false;
            _subtitleStyle = new GUIStyle(GUI.skin.label);
            _subtitleStyle.fontSize = 11;
            _labelStyle = new GUIStyle(GUI.skin.label);
            _labelStyle.fontSize = 12;
            _smallStyle = new GUIStyle(GUI.skin.label);
            _smallStyle.fontSize = 10;
            _wrapStyle = new GUIStyle(GUI.skin.label);
            _wrapStyle.fontSize = 12;
            _wrapStyle.wordWrap = true;
            _monoStyle = new GUIStyle(GUI.skin.label);
            _monoStyle.fontSize = 11;
            if (font != null)
            {
                _titleStyle.font = font;
                _subtitleStyle.font = font;
                _labelStyle.font = font;
                _smallStyle.font = font;
                _wrapStyle.font = font;
                _monoStyle.font = font;
            }
            _stylesReady = true;
        }

        void OnSelectionChanged(LayoutNode node)
        {
            FetchDetail(node);
        }

        void FetchDetail(LayoutNode node)
        {
            _detail = null;
            _detailError = null;
            _detailForId = node != null ? node.Id : null;
            _detailLoading = false;
            _detailIsEntity = node != null && node.IsEntity;
            if (node == null || _api == null)
            {
                return;
            }
            if (node.IsEntity)
            {
                return; // entities are not memories -> no body to fetch
            }
            _detailLoading = true;
            string requestedId = node.Id;
            _api.FetchMemory(requestedId,
                delegate (MemoryInfo info)
                {
                    if (_detailForId == requestedId)
                    {
                        _detail = info;
                        _detailLoading = false;
                        _detailError = null;
                    }
                },
                delegate (string error)
                {
                    if (_detailForId == requestedId)
                    {
                        _detailLoading = false;
                        _detailError = error;
                    }
                });
        }

        void Update()
        {
            if (!_initialized)
            {
                return;
            }
            _smoothedDeltaTime = Mathf.Lerp(_smoothedDeltaTime, Mathf.Max(0.0001f, Time.unscaledDeltaTime), 0.08f);
            _fps = 1f / Mathf.Max(0.0001f, _smoothedDeltaTime);

            UpdatePointerState();
            UpdateHover();
            HandleSelectionInput();
            HandleKeyboard();
        }

        void UpdatePointerState()
        {
            Vector2 guiMouse = new Vector2(Input.mousePosition.x, Screen.height - Input.mousePosition.y);
            bool over = false;
            for (int i = 0; i < _panelRects.Count; i++)
            {
                if (_panelRects[i].Contains(guiMouse))
                {
                    over = true;
                    break;
                }
            }
            _pointerOverUi = over;
        }

        void UpdateHover()
        {
            if (_nodes == null)
            {
                return;
            }
            if (_pointerOverUi || !ShowHud)
            {
                _nodes.SetHovered(null);
                return;
            }
            _nodes.SetHovered(_nodes.Pick(Input.mousePosition));
        }

        void HandleSelectionInput()
        {
            if (_nodes == null || !ShowHud)
            {
                return;
            }
            if (Input.GetMouseButtonDown(0))
            {
                _mouseDown = true;
                _mouseDownPosition = Input.mousePosition;
                _mouseOverUiAtDown = _pointerOverUi;
            }
            if (Input.GetMouseButtonUp(0) && _mouseDown)
            {
                _mouseDown = false;
                Vector2 delta = (Vector2)Input.mousePosition - _mouseDownPosition;
                if (_mouseOverUiAtDown || delta.magnitude > 6f)
                {
                    return; // was a camera drag or a UI click
                }
                LayoutNode hit = _nodes.Pick(Input.mousePosition);
                if (hit != null)
                {
                    bool isDoubleClick = _lastClickNodeId == hit.Id && Time.unscaledTime - _lastClickTime < 0.35f;
                    _lastClickNodeId = hit.Id;
                    _lastClickTime = Time.unscaledTime;
                    _nodes.Select(hit, false);
                    if (isDoubleClick && _cameraRig != null)
                    {
                        _cameraRig.FocusOnNode(hit);
                    }
                }
                else
                {
                    _nodes.ClearSelection();
                }
            }
        }

        void HandleKeyboard()
        {
            if (Input.GetKeyDown(KeyCode.H))
            {
                ShowHud = !ShowHud;
            }
            if (Input.GetKeyDown(KeyCode.L))
            {
                ShowLabels = !ShowLabels;
            }
            if (Input.GetKeyDown(KeyCode.R) && _api != null)
            {
                _api.RequestRefreshNow();
            }
            if (Input.GetKeyDown(KeyCode.Escape) && _nodes != null)
            {
                _nodes.ClearSelection();
            }
            if (Input.GetKeyDown(KeyCode.F) && _nodes != null && _nodes.SelectedNode != null && _cameraRig != null)
            {
                _cameraRig.FocusOnNode(_nodes.SelectedNode);
            }
            if (Input.GetKeyDown(KeyCode.Alpha0))
            {
                SetQuality(QualityTier.Off);
            }
            if (Input.GetKeyDown(KeyCode.Alpha1))
            {
                SetQuality(QualityTier.Low);
            }
            if (Input.GetKeyDown(KeyCode.Alpha2))
            {
                SetQuality(QualityTier.Medium);
            }
            if (Input.GetKeyDown(KeyCode.Alpha3))
            {
                SetQuality(QualityTier.High);
            }
            if (Input.GetKeyDown(KeyCode.Alpha4))
            {
                SetQuality(QualityTier.Ultra);
            }
            if (Input.GetKeyDown(KeyCode.X) && _nebula != null)
            {
                _nebula.SetBloomEnabled(!_nebula.BloomEnabled);
            }
        }

        void SetQuality(QualityTier tier)
        {
            if (_app != null)
            {
                _app.SetQualityTier(tier);
            }
        }

        // -----------------------------------------------------------------
        // IMGUI drawing
        // -----------------------------------------------------------------

        void OnGUI()
        {
            if (!_initialized)
            {
                return;
            }
            EnsureStyles();
            _panelRects.Clear();
            if (!ShowHud)
            {
                return;
            }
            DrawStatusPanel();
            DrawLegendPanel();
            DrawSelectedPanel();
            DrawBanners();
            DrawNodeLabels();
            DrawHoverTooltip();
            DrawControlHints();
            DrawEmptyState();
        }

        void DrawStatusPanel()
        {
            float width = 330f;
            Rect rect = new Rect(14f, 14f, width, 168f);
            AddPanel(rect, new Color(0.015f, 0.025f, 0.055f, 0.72f), new Color(0.30f, 0.62f, 0.86f, 0.55f));

            GUILayout.BeginArea(new Rect(rect.x + 12f, rect.y + 9f, rect.width - 24f, rect.height - 18f));
            GUILayout.BeginHorizontal();
            ColorCircle(new Color(0.42f, 0.82f, 0.95f, 1f), 8f);
            GUILayout.Label("FCA NEBULA", _titleStyle);
            GUILayout.FlexibleSpace();
#if UNITY_WEBGL && !UNITY_EDITOR
            GUILayout.Label("Unity · WebGL", _smallStyle);
#else
            GUILayout.Label("Unity · Built-in", _smallStyle);
#endif
            GUILayout.EndHorizontal();
            GUILayout.Label("工作区旋臂星云 · 真实 Runtime 数据", _subtitleStyle);

            Color stateColor;
            string stateText = StateText(out stateColor);
            GUILayout.BeginHorizontal();
            ColorCircle(stateColor, 7f);
            GUILayout.Label(stateText, _labelStyle);
            GUILayout.EndHorizontal();

            if (_api != null)
            {
                GUILayout.Label("Runtime " + _api.RuntimeUrl, _monoStyle);
#if UNITY_WEBGL && !UNITY_EDITOR
                string tokenText = _api.TokenAvailable ? "token ✓ (page URL query)" : "token ✕ (URL query missing)";
#else
                string tokenText = _api.TokenAvailable ? "token ✓ " + ShortPath(_api.TokenFileResolved) : "token ✕ " + (_api.TokenError ?? "未找到");
#endif
                GUILayout.Label(tokenText, _smallStyle);
                float age = _api.SecondsSinceSuccess;
                string ageText = age < 0f ? "尚未成功拉取" : "上次更新 " + age.ToString("0.0") + "s 前 · 第 " + _api.SuccessfulUpdates + " 次";
                GUILayout.Label(ageText, _smallStyle);
            }

            LayoutModel layout = _app != null ? _app.CurrentLayout : null;
            GraphModel graph = _app != null ? _app.CurrentGraph : null;
            int nodeCount = layout != null ? layout.NodeCount : (graph != null ? graph.Nodes.Count : 0);
            int edgeCount = _edges != null ? _edges.EdgeCount : (graph != null ? graph.Edges.Count : 0);
            int armCount = layout != null ? layout.Arms.Count : 0;
            GUILayout.Label("节点 " + nodeCount + " · 关系 " + edgeCount + " · 旋臂 " + armCount +
                            " · 画质 " + (_app != null ? _app.QualityKey : "high"), _smallStyle);
            if (_app != null && _app.CurrentLayoutSignature.Length > 0)
            {
                GUILayout.Label("布局 " + _app.CurrentLayoutSignature + " · FPS " + _fps.ToString("0"), _smallStyle);
            }
            GUILayout.EndArea();
        }

        string StateText(out Color color)
        {
            color = ThemePalette.UiDim;
            if (_api == null)
            {
                return "初始化中";
            }
            switch (_api.State)
            {
                case ConnectionState.Online:
                    color = ThemePalette.UiOk;
                    return "已连接 Runtime · LIVE";
                case ConnectionState.Sample:
                    color = ThemePalette.UiWarn;
                    return "SAMPLE 数据 · 非实时";
                case ConnectionState.Offline:
                    color = ThemePalette.UiError;
                    return "离线 · " + Trim(_api.LastError, 60);
                case ConnectionState.Connecting:
                    color = ThemePalette.UiWarn;
                    return "连接中…";
                default:
                    return "启动中…";
            }
        }

        void DrawLegendPanel()
        {
            LayoutModel layout = _app != null ? _app.CurrentLayout : null;
            if (layout == null || layout.Arms.Count == 0)
            {
                return;
            }
            int visibleArms = Mathf.Min(layout.Arms.Count, 8);
            float rowHeight = 21f;
            float height = 40f + visibleArms * rowHeight + 26f;
            float width = 296f;
            Rect rect = new Rect(Screen.width - width - 14f, 14f, width, height);
            AddPanel(rect, new Color(0.015f, 0.025f, 0.055f, 0.72f), new Color(0.30f, 0.62f, 0.86f, 0.55f));
            GUILayout.BeginArea(new Rect(rect.x + 12f, rect.y + 8f, rect.width - 24f, rect.height - 16f));
            GUILayout.Label("工作区 · 旋臂图例", _labelStyle);
            GUILayout.Label("每一条旋臂 = 一个 workspace:<label>", _smallStyle);
            for (int i = 0; i < visibleArms; i++)
            {
                LayoutArm arm = layout.Arms[i];
                GUILayout.BeginHorizontal();
                ColorCircle(arm.ColorSrgb, 8f);
                string name = arm.IsDefault ? "default（未分组）" : (arm.ColorKey + " · " + arm.Label);
                GUILayout.Label(name + " · " + arm.NodeCount, _labelStyle);
                GUILayout.EndHorizontal();
            }
            if (layout.Arms.Count > visibleArms)
            {
                GUILayout.Label("⚠ " + (layout.Arms.Count - visibleArms) + " 条旋臂超出体积着色器上限（节点仍在各自臂上）", _smallStyle);
            }
            GUILayout.EndArea();
        }

        void DrawSelectedPanel()
        {
            LayoutNode selected = _nodes != null ? _nodes.SelectedNode : null;
            if (selected == null)
            {
                return;
            }
            float width = Mathf.Min(470f, Screen.width * 0.42f);
            float height = 300f;
            Rect rect = new Rect(14f, Screen.height - height - 14f, width, height);
            AddPanel(rect, new Color(0.02f, 0.03f, 0.065f, 0.82f), new Color(0.45f, 0.72f, 0.95f, 0.65f));
            GUILayout.BeginArea(new Rect(rect.x + 12f, rect.y + 9f, rect.width - 24f, rect.height - 18f));
            GraphNode source = selected.Source;
            GUILayout.Label(Trim(source.DisplayTitle, 120), _titleStyle);
            GUILayout.Label(TypeLabel(source) + " · 旋臂 " + (selected.Source.WorkspaceIsDefault ? "default" : selected.ArmLabel) +
                            " · importance " + source.Importance.ToString("0.00") +
                            " · degree " + source.Degree, _smallStyle);

            if (source.Tags != null && source.Tags.Length > 0)
            {
                GUILayout.Label("标签: " + Trim(string.Join(" · ", source.Tags), 100), _smallStyle);
            }

            GUILayout.Space(3f);
            if (_detailIsEntity)
            {
                GUILayout.Label("实体节点", _labelStyle);
                GUILayout.Label("实体没有记忆正文；关系光丝展示它与其他节点的连接。", _smallStyle);
            }
            else if (_detailLoading)
            {
                GUILayout.Label("正在从 Runtime 拉取正文…", _labelStyle);
            }
            else if (!string.IsNullOrEmpty(_detailError))
            {
                GUILayout.Label("✕ 正文加载失败（未伪造）: " + Trim(_detailError, 160), _wrapStyle);
            }
            else if (_detail != null)
            {
                GUILayout.Label(_detail.Title, _labelStyle);
                string body = _detail.BodyExcerpt(500);
                GUILayout.Label(string.IsNullOrEmpty(body) ? "（记忆正文为空）" : body, _wrapStyle);
            }
            else
            {
                GUILayout.Label("等待正文…", _smallStyle);
            }

            GUILayout.FlexibleSpace();
            GUILayout.Label("Esc 取消选择 · F 聚焦 · 双击节点聚焦", _smallStyle);
            GUILayout.EndArea();
        }

        void DrawBanners()
        {
            if (_api == null)
            {
                return;
            }
            string message = null;
            Color color = ThemePalette.UiError;
            if (_api.State == ConnectionState.Sample)
            {
                message = "SAMPLE 数据 · 离线样例（非实时）。未连接 " + _api.RuntimeUrl;
                color = ThemePalette.UiWarn;
            }
            else if (_api.State == ConnectionState.Offline)
            {
                message = "Runtime 离线: " + Trim(_api.LastError, 180) + "  ·  按 R 重试";
                color = ThemePalette.UiError;
            }
            else if (_api.State != ConnectionState.Online && !_api.HasGraph)
            {
                message = "正在连接 " + _api.RuntimeUrl + " …";
                color = ThemePalette.UiWarn;
            }
            if (string.IsNullOrEmpty(message))
            {
                return;
            }
            float width = Mathf.Min(Screen.width - 40f, 860f);
            Rect rect = new Rect((Screen.width - width) * 0.5f, 12f, width, 30f);
            AddPanel(rect, new Color(color.r * 0.25f, color.g * 0.20f, color.b * 0.20f, 0.85f), color, 1.5f);
            GUI.color = color;
            GUI.Label(new Rect(rect.x + 10f, rect.y + 6f, rect.width - 20f, 20f), message, _labelStyle);
            GUI.color = Color.white;
        }

        void DrawEmptyState()
        {
            if (_api == null || _app == null || !_api.HasGraph)
            {
                return;
            }
            LayoutModel layout = _app.CurrentLayout;
            if (layout != null && layout.NodeCount > 0)
            {
                return;
            }
            float width = 420f;
            Rect rect = new Rect((Screen.width - width) * 0.5f, Screen.height * 0.44f, width, 70f);
            AddPanel(rect, new Color(0f, 0f, 0f, 0.45f), new Color(0.4f, 0.55f, 0.7f, 0.35f));
            GUI.color = ThemePalette.UiText;
            GUI.Label(new Rect(rect.x + 14f, rect.y + 10f, rect.width - 28f, 26f), "空白星图 · Runtime 暂无记忆", _titleStyle);
            GUI.color = ThemePalette.UiDim;
            GUI.Label(new Rect(rect.x + 14f, rect.y + 38f, rect.width - 28f, 20f), "等待真实数据写入后自动刷新（不伪造节点）", _smallStyle);
            GUI.color = Color.white;
        }

        void DrawControlHints()
        {
            string text = "拖拽旋转 · 滚轮缩放 · 左键点选 · R 刷新 · L 标签 · 1-4 画质 · 0 关特效 · F 聚焦 · Esc 取消 · H 隐藏 HUD";
            float width = Mathf.Min(Screen.width - 28f, 900f);
            Rect rect = new Rect(Screen.width - width - 14f, Screen.height - 30f, width, 20f);
            GUI.color = new Color(0.55f, 0.68f, 0.85f, 0.75f);
            GUI.Label(rect, text, _smallStyle);
            GUI.color = Color.white;
        }

        void DrawNodeLabels()
        {
            if (!ShowLabels || _nodes == null || _cameraRig == null)
            {
                return;
            }
            LayoutModel layout = _app != null ? _app.CurrentLayout : null;
            if (layout == null || layout.NodeCount == 0)
            {
                return;
            }
            LayoutNode selected = _nodes.SelectedNode;
            LayoutNode hovered = _nodes.HoveredNode;
            List<LayoutNode> candidates = new List<LayoutNode>(18);
            if (selected != null)
            {
                candidates.Add(selected);
            }
            if (hovered != null && !ReferenceEquals(hovered, selected))
            {
                candidates.Add(hovered);
            }
            // A handful of the brightest memories get labels; the rest are discovered on hover.
            for (int i = 0; i < layout.Nodes.Count && candidates.Count < 12; i++)
            {
                LayoutNode node = layout.Nodes[i];
                if (ReferenceEquals(node, selected) || ReferenceEquals(node, hovered))
                {
                    continue;
                }
                if (node.Brightness >= 0.30f && node.Source.Importance >= 0.40f)
                {
                    candidates.Add(node);
                }
            }
            Camera camera = _cameraRig.Camera;
            if (camera == null)
            {
                return;
            }
            List<Rect> occupied = new List<Rect>(candidates.Count);
            for (int i = 0; i < candidates.Count; i++)
            {
                LayoutNode node = candidates[i];
                Vector3 projected = camera.WorldToScreenPoint(node.Position);
                if (projected.z <= 0f)
                {
                    continue;
                }
                float x = projected.x + 8f;
                float y = Screen.height - projected.y - 8f;
                if (x < 0f || x > Screen.width - 60f || y < 0f || y > Screen.height - 20f)
                {
                    continue;
                }
                string text = Trim(node.Source.DisplayTitle, 46);
                bool selectedNode = ReferenceEquals(node, selected);
                float estimatedWidth = Mathf.Min(360f, text.Length * 7.2f + 10f);
                Rect labelRect = new Rect(x, y, estimatedWidth, 16f);
                bool overlapped = false;
                for (int k = 0; k < occupied.Count; k++)
                {
                    Rect padded = occupied[k];
                    padded.xMin -= 4f;
                    padded.yMin -= 2f;
                    padded.xMax += 4f;
                    padded.yMax += 2f;
                    if (padded.Overlaps(labelRect))
                    {
                        overlapped = true;
                        break;
                    }
                }
                if (overlapped && !(i == 0 || (i == 1 && hovered != null && ReferenceEquals(candidates[i], hovered))))
                {
                    continue; // never hide the selected/hovered labels
                }
                occupied.Add(labelRect);
                GUI.color = new Color(0f, 0f, 0f, 0.72f);
                GUI.Label(new Rect(x + 1f, y + 1f, 380f, 18f), text, _smallStyle);
                GUI.color = selectedNode ? ThemePalette.UiText : new Color(0.62f, 0.74f, 0.92f, 0.9f);
                GUI.Label(new Rect(x, y, 380f, 18f), text, _smallStyle);
            }
            GUI.color = Color.white;
        }

        void DrawHoverTooltip()
        {
            if (_nodes == null || _nodes.HoveredNode == null || _nodes.HoveredNode == _nodes.SelectedNode)
            {
                return;
            }
            LayoutNode node = _nodes.HoveredNode;
            Vector2 mouse = new Vector2(Input.mousePosition.x, Screen.height - Input.mousePosition.y);
            string title = Trim(node.Source.DisplayTitle, 70);
            string meta = (node.IsEntity ? "实体" : "记忆") + " · " + node.Source.Type + " · workspace " +
                          (node.Source.WorkspaceIsDefault ? "default" : node.ArmLabel);
            float width = 330f;
            Rect rect = new Rect(mouse.x + 16f, mouse.y + 14f, width, 46f);
            if (rect.x + rect.width > Screen.width)
            {
                rect.x = Screen.width - rect.width - 8f;
            }
            if (rect.y + rect.height > Screen.height)
            {
                rect.y = Screen.height - rect.height - 8f;
            }
            AddPanel(rect, new Color(0.02f, 0.035f, 0.07f, 0.9f), new Color(0.4f, 0.65f, 0.9f, 0.55f));
            GUI.color = ThemePalette.UiText;
            GUI.Label(new Rect(rect.x + 9f, rect.y + 5f, rect.width - 18f, 18f), title, _labelStyle);
            GUI.color = ThemePalette.UiDim;
            GUI.Label(new Rect(rect.x + 9f, rect.y + 25f, rect.width - 18f, 16f), meta, _smallStyle);
            GUI.color = Color.white;
        }

        // -----------------------------------------------------------------
        // small helpers
        // -----------------------------------------------------------------

        void AddPanel(Rect rect, Color background, Color border, float borderWidth = 1f)
        {
            GUI.color = background;
            GUI.DrawTexture(rect, _white);
            GUI.color = border;
            GUI.DrawTexture(new Rect(rect.x, rect.y, rect.width, borderWidth), _white);
            GUI.DrawTexture(new Rect(rect.x, rect.yMax - borderWidth, rect.width, borderWidth), _white);
            GUI.DrawTexture(new Rect(rect.x, rect.y, borderWidth, rect.height), _white);
            GUI.DrawTexture(new Rect(rect.xMax - borderWidth, rect.y, borderWidth, rect.height), _white);
            GUI.color = Color.white;
            _panelRects.Add(rect);
        }

        void ColorCircle(Color color, float radius)
        {
            GUIStyle style = new GUIStyle(GUI.skin.label);
            style.fixedWidth = radius * 2f + 6f;
            style.fixedHeight = radius * 2f;
            style.normal.textColor = color;
            style.alignment = TextAnchor.MiddleCenter;
            GUILayout.Label("●", style);
        }

        static string TypeLabel(GraphNode node)
        {
            if (node == null)
            {
                return "";
            }
            if (node.IsEntity)
            {
                return "实体 · " + node.Type;
            }
            switch (node.Type)
            {
                case "working": return "工作记忆";
                case "episodic": return "情景记忆";
                case "semantic": return "语义记忆";
                case "procedural": return "程序记忆";
                case "autobiographical": return "自传记忆";
                case "project": return "项目记忆";
                case "relational": return "关系记忆";
                case "emotional": return "情感记忆";
                default: return "记忆 · " + node.Type;
            }
        }

        static string Trim(string text, int max)
        {
            if (string.IsNullOrEmpty(text))
            {
                return "";
            }
            string flat = text.Replace('\n', ' ').Replace('\r', ' ').Trim();
            if (flat.Length <= max)
            {
                return flat;
            }
            return flat.Substring(0, max) + "…";
        }

        static string ShortPath(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return "(未找到)";
            }
            if (path.Length <= 42)
            {
                return path;
            }
            return "…" + path.Substring(path.Length - 40);
        }

        void OnDestroy()
        {
            if (_nodes != null)
            {
                _nodes.SelectionChanged -= OnSelectionChanged;
            }
            if (_white != null)
            {
                Destroy(_white);
            }
            if (_uiFont != null)
            {
                Destroy(_uiFont);
            }
        }
    }
}
