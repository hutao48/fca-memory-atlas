// FCA Memory Atlas — Unity Nebula Renderer (WebGL)
// WebGLBridge: Unity -> embedding page status bridge (Electron iframe integration).
// Only compiled for WebGL player builds; the standalone player keeps its own window.

#if UNITY_WEBGL && !UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using UnityEngine;

namespace FCANebula
{
    [Serializable]
    public class WebGLStatePayload
    {
        public bool ready;
        public bool connected;
        public bool sample;
        public string state;
        public string runtimeUrl;
        public string quality;
        public int nodes;
        public int edges;
        public int arms;
        public string armSummary;
        public string layout;
        public int view;
        public bool webgl = true;
        // diagnostics (surfaced to the page for acceptance tooling)
        public bool tokenProvided;
        public int initialView;
        public bool volumeMaterialOk;
        public float armCountUniform;
        public float emissionScale;
        public int marchSteps;
        // task-14: geometry alignment + hierarchy state for acceptance tooling
        public int visibleNodes;
        public float alignMeanWidth;
        public float alignP95Width;
        public float alignMaxWidth;
        public int hierarchyParents;
        public int hierarchyChildren;
        public int hierarchyExpandedParents;
        public int hierarchyVisibleChildren;
        public string hierarchyParentId;
        public string hierarchyParentLabel;
        public int hierarchyParentChildCount;
        // task-14: chain layout (same session chain -> same arm, contiguous)
        public int chainCount;
        public int chainMultiNodeCount;
        public int crossWorkspaceChainCount;
        public string chainSignature;
        public bool chainSameArmAll;
        public string chainSummary;
        // selection bridge support
        public string sampleNodeId;
        public string sampleNodeTitle;
        public string selectedNodeId;
        // task-19: chain links + whole-chain highlight diagnostics
        public int chainEdges;
        public int chainPairsExpected;
        public int chainPairsMissing;
        public int relatedPairs;
        public int relatedPairsMissingEdges;
        public string highlightedChainKey;
        public int highlightedChainSize;
        public string sampleChainNodeId;
        public string sampleChainNodeTitle;
        public int sampleChainSize;
    }

    [Serializable]
    public class WebGLSelectionPayload
    {
        public string id;
        public string kind;
        public string title;
        public string memoryType;
        public string arm;
        public float importance;
        public string occurredAt;
        public bool selected;
        public bool clear;
        // task-19: memory-chain membership (backward compatible additive fields)
        public string[] chainIds;
        public int chainSize;
    }

    public static class WebGLBridge
    {
        [DllImport("__Internal")]
        private static extern void FCABridge_PushState(string json);

        [DllImport("__Internal")]
        private static extern void FCABridge_NotifyReady(string json);

        [DllImport("__Internal")]
        private static extern void FCABridge_NotifySelect(string json);

        static int _lastView = -1;
        static string _lastSelectionId = "\u0000"; // sentinel: nothing sent yet

        public static void SetInitialView(int view)
        {
            _lastView = view;
        }

        public static void PushState(AppConfig config, FcaApiClient api, LayoutModel layout)
        {
            WebGLStatePayload payload = new WebGLStatePayload();
            payload.ready = layout != null && layout.NodeCount > 0;
            payload.connected = api != null && api.State == ConnectionState.Online;
            payload.sample = api != null && api.IsSampleData;
            payload.state = api != null ? api.State.ToString() : "Unknown";
            payload.runtimeUrl = api != null ? api.RuntimeUrl : (config != null ? config.RuntimeUrl : "");
            payload.quality = config != null ? QualityProfile.For(config.Quality).Key : "high";
            payload.nodes = layout != null ? layout.NodeCount : 0;
            payload.edges = layout != null && layout.Graph != null ? layout.Graph.Edges.Count : 0;
            payload.arms = layout != null ? layout.Arms.Count : 0;
            payload.armSummary = BuildArmSummary(layout);
            payload.layout = layout != null ? layout.Signature : "";
            payload.view = _lastView;
            FillDiagnostics(payload, config, api);
            string json = JsonUtility.ToJson(payload);
            try
            {
                FCABridge_PushState(json);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[FCA] WebGL bridge push failed: " + ex.Message);
            }
        }

        public static void NotifyReady(AppConfig config, FcaApiClient api, LayoutModel layout)
        {
            WebGLStatePayload payload = new WebGLStatePayload();
            payload.ready = true;
            payload.connected = api != null && api.State == ConnectionState.Online;
            payload.sample = api != null && api.IsSampleData;
            payload.state = api != null ? api.State.ToString() : "Unknown";
            payload.runtimeUrl = api != null ? api.RuntimeUrl : "";
            payload.quality = config != null ? QualityProfile.For(config.Quality).Key : "high";
            payload.nodes = layout != null ? layout.NodeCount : 0;
            payload.edges = layout != null && layout.Graph != null ? layout.Graph.Edges.Count : 0;
            payload.arms = layout != null ? layout.Arms.Count : 0;
            payload.armSummary = BuildArmSummary(layout);
            payload.layout = layout != null ? layout.Signature : "";
            payload.view = _lastView;
            FillDiagnostics(payload, config, api);
            string json = JsonUtility.ToJson(payload);
            try
            {
                FCABridge_NotifyReady(json);
                Debug.Log("[FCA] WebGL bridge ready: " + json);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[FCA] WebGL bridge ready failed: " + ex.Message);
            }
        }

        static void FillDiagnostics(WebGLStatePayload payload, AppConfig config, FcaApiClient api)
        {
            try
            {
                payload.tokenProvided = api != null && api.TokenAvailable;
                payload.initialView = config != null ? config.InitialView : -1;
                NebulaApp app = NebulaApp.Instance;
                if (app != null && app.Nebula != null)
                {
                    Material material = app.Nebula.VolumeMaterial;
                    if (material != null)
                    {
                        payload.volumeMaterialOk = true;
                        payload.armCountUniform = material.GetFloat("_ArmCount");
                        payload.emissionScale = material.GetFloat("_EmissionScale");
                        payload.marchSteps = material.GetInt("_Steps");
                    }
                }
                LayoutModel layout = app != null ? app.CurrentLayout : null;
                if (layout != null)
                {
                    payload.visibleNodes = layout.VisibleNodeCount;
                    payload.alignMeanWidth = layout.AlignMeanWidth;
                    payload.alignP95Width = layout.AlignP95Width;
                    payload.alignMaxWidth = layout.AlignMaxWidth;
                    payload.hierarchyParents = layout.HierarchyParentCount;
                    payload.hierarchyChildren = layout.HierarchyChildCount;
                    if (layout.HierarchyParentIds.Count > 0)
                    {
                        string firstParentId = layout.HierarchyParentIds[0];
                        payload.hierarchyParentId = firstParentId;
                        LayoutNode parent;
                        if (layout.ById.TryGetValue(firstParentId, out parent))
                        {
                            payload.hierarchyParentLabel = parent.Source != null ? parent.Source.DisplayTitle : firstParentId;
                            payload.hierarchyParentChildCount = parent.ChildIds.Count;
                        }
                    }
                }
                if (app != null && app.Hierarchy != null)
                {
                    payload.hierarchyExpandedParents = app.Hierarchy.ExpandedParentCount;
                    payload.hierarchyVisibleChildren = app.Hierarchy.VisibleChildCount;
                }
                if (layout != null)
                {
                    payload.chainCount = layout.ChainCount;
                    payload.chainMultiNodeCount = layout.MultiNodeChainCount;
                    payload.crossWorkspaceChainCount = layout.CrossWorkspaceChainCount;
                    payload.chainSignature = layout.ChainSignature;
                    payload.chainSameArmAll = true;
                    StringBuilder chainSb = new StringBuilder(128);
                    for (int i = 0; i < layout.ChainSummaries.Count; i++)
                    {
                        ChainSummary chain = layout.ChainSummaries[i];
                        if (!chain.SameArm) payload.chainSameArmAll = false;
                        if (chain.NodeCount > 1)
                        {
                            if (chainSb.Length > 0) chainSb.Append(" | ");
                            chainSb.Append(chain.ArmLabel).Append(':').Append(chain.NodeCount);
                        }
                    }
                    payload.chainSummary = chainSb.ToString();
                    // First selectable memory node for the selection bridge acceptance test.
                    for (int i = 0; i < layout.Nodes.Count; i++)
                    {
                        LayoutNode candidate = layout.Nodes[i];
                        if (candidate.IsVisible && !candidate.IsEntity && candidate.Source != null)
                        {
                            payload.sampleNodeId = candidate.Id;
                            payload.sampleNodeTitle = candidate.Source.DisplayTitle;
                            break;
                        }
                    }
                    // First chain member (>1 node) for the task-19 highlight acceptance test.
                    for (int i = 0; i < layout.Nodes.Count; i++)
                    {
                        LayoutNode candidate = layout.Nodes[i];
                        if (candidate.IsVisible && candidate.ChainSize > 1 && candidate.Source != null)
                        {
                            payload.sampleChainNodeId = candidate.Id;
                            payload.sampleChainNodeTitle = candidate.Source.DisplayTitle;
                            payload.sampleChainSize = candidate.ChainSize;
                            break;
                        }
                    }
                }
                if (app != null && app.Edges != null)
                {
                    payload.chainEdges = app.Edges.ChainLinkCount;
                    payload.chainPairsExpected = app.Edges.ChainPairsExpected;
                    payload.chainPairsMissing = app.Edges.ChainPairsMissing;
                    payload.relatedPairs = app.Edges.RelatedPairs;
                    payload.relatedPairsMissingEdges = app.Edges.RelatedPairsMissingEdges;
                }
                if (app != null)
                {
                    payload.highlightedChainKey = app.HighlightedChainKey ?? "";
                    payload.highlightedChainSize = app.HighlightedChainSize;
                }
                if (app != null && app.Nodes != null && app.Nodes.SelectedNode != null)
                {
                    payload.selectedNodeId = app.Nodes.SelectedNode.Id;
                }
            }
            catch (Exception)
            {
                // diagnostics must never break rendering
            }
        }

        static string BuildArmSummary(LayoutModel layout)
        {
            if (layout == null || layout.Arms.Count == 0)
            {
                return "";
            }
            StringBuilder sb = new StringBuilder(128);
            for (int i = 0; i < layout.Arms.Count; i++)
            {
                if (i > 0)
                {
                    sb.Append(" | ");
                }
                LayoutArm arm = layout.Arms[i];
                sb.Append(arm.IsDefault ? "default" : arm.Label).Append(':').Append(arm.NodeCount);
            }
            return sb.ToString();
        }

        /// <summary>
        /// Unity -> page selection event (Electron right-hand detail panel sync).
        /// Null node = cleared selection (payload.clear=true). Repeated ids are suppressed.
        /// </summary>
        public static void NotifySelection(LayoutNode node, LayoutModel layout)
        {
            if (node != null && !node.IsHierarchyChild && string.Equals(node.Id, _lastSelectionId, StringComparison.Ordinal))
            {
                return;
            }
            if (node == null && string.Equals(_lastSelectionId, "", StringComparison.Ordinal))
            {
                return;
            }
            WebGLSelectionPayload payload = new WebGLSelectionPayload();
            if (node == null)
            {
                payload.id = null;
                payload.selected = false;
                payload.clear = true;
                payload.chainIds = new string[0];
                payload.chainSize = 0;
                _lastSelectionId = "";
            }
            else
            {
                payload.id = node.Id;
                payload.kind = node.IsEntity ? "entity" : "memory";
                payload.title = node.Source != null ? node.Source.DisplayTitle : node.Id;
                payload.memoryType = node.Source != null ? node.Source.Type : "";
                payload.arm = node.Source != null && node.Source.WorkspaceIsDefault ? "default" : node.ArmLabel;
                payload.importance = node.Source != null ? node.Source.Importance : 0f;
                payload.occurredAt = node.Source != null ? node.Source.OccurredAt : null;
                payload.selected = true;
                payload.clear = false;
                // task-19: expose chain membership for desktop displays (additive fields).
                List<string> chainIds = null;
                if (layout != null && !string.IsNullOrEmpty(node.ChainKey) && layout.ChainNodeIds.TryGetValue(node.ChainKey, out chainIds))
                {
                    payload.chainIds = chainIds.ToArray();
                    payload.chainSize = node.ChainSize;
                }
                else
                {
                    payload.chainIds = new string[] { node.Id };
                    payload.chainSize = 1;
                }
                _lastSelectionId = node.Id;
            }
            try
            {
                FCABridge_NotifySelect(JsonUtility.ToJson(payload));
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[FCA] WebGL select bridge failed: " + ex.Message);
            }
        }

        /// <summary>
        /// JavaScript -> Unity commands (e.g. Electron toolbar buttons / acceptance tooling).
        /// Supported: "view:0|1|2", "quality:off|low|medium|high|ultra", "refresh",
        /// "labels:0|1", "expand:<nodeId>" (empty/first = first parent), "collapse:<nodeId>",
        /// "toggle:<nodeId>", "togglefirst", "select:<nodeId>".
        /// </summary>
        public static void OnJsCommand(string command)
        {
            if (string.IsNullOrEmpty(command))
            {
                return;
            }
            NebulaApp app = NebulaApp.Instance;
            if (app == null)
            {
                return;
            }
            int colon = command.IndexOf(':');
            string verb = (colon >= 0 ? command.Substring(0, colon) : command).Trim().ToLowerInvariant();
            string arg = colon >= 0 ? command.Substring(colon + 1).Trim() : "";
            switch (verb)
            {
                case "view":
                    int view;
                    if (int.TryParse(arg, NumberStyles.Integer, CultureInfo.InvariantCulture, out view))
                    {
                        app.ApplyWebGLView(view);
                    }
                    break;
                case "quality":
                    app.SetQualityTier(AppConfig.ParseQuality(arg, QualityTier.High));
                    break;
                case "refresh":
                    app.RequestRefresh();
                    break;
                case "labels":
                    if (app.Ui != null)
                    {
                        app.Ui.ShowLabels = arg == "1" || arg == "true";
                    }
                    break;
                case "expand":
                    if (string.IsNullOrEmpty(arg) || arg == "first") app.ExpandFirstParent();
                    else app.ExpandParent(arg);
                    PushState(app.Config, app.Api, app.CurrentLayout);
                    break;
                case "collapse":
                    if (string.IsNullOrEmpty(arg) || arg == "all") app.Hierarchy.CollapseAll();
                    else app.CollapseParent(arg);
                    PushState(app.Config, app.Api, app.CurrentLayout);
                    break;
                case "toggle":
                    if (string.IsNullOrEmpty(arg) || arg == "first") app.ToggleFirstParent();
                    else app.ToggleParent(arg);
                    PushState(app.Config, app.Api, app.CurrentLayout);
                    break;
                case "togglefirst":
                    app.ToggleFirstParent();
                    PushState(app.Config, app.Api, app.CurrentLayout);
                    break;
                case "select":
                    if (app.Nodes != null)
                    {
                        if (string.IsNullOrEmpty(arg) || arg == "clear")
                        {
                            app.Nodes.ClearSelection();
                        }
                        else
                        {
                            LayoutNode node;
                            if (app.CurrentLayout != null && app.CurrentLayout.ById.TryGetValue(arg, out node))
                            {
                                app.Nodes.Select(node, false);
                            }
                        }
                        NotifySelection(app.Nodes.SelectedNode, app.CurrentLayout);
                    }
                    break;
                case "focus":
                    if (!string.IsNullOrEmpty(arg) && app.Nodes != null && app.CameraRig != null)
                    {
                        LayoutNode focusNode;
                        if (app.CurrentLayout != null && app.CurrentLayout.ById.TryGetValue(arg, out focusNode))
                        {
                            app.Nodes.Select(focusNode, false);
                            app.CameraRig.FocusOnNode(focusNode);
                            NotifySelection(focusNode, app.CurrentLayout);
                        }
                    }
                    break;
                case "highlight-chain":
                case "select-chain":
                    // task-19 aliases: selecting a chain member highlights the whole chain.
                    if (app.Nodes != null && !string.IsNullOrEmpty(arg))
                    {
                        LayoutNode chainNode;
                        if (app.CurrentLayout != null && app.CurrentLayout.ById.TryGetValue(arg, out chainNode))
                        {
                            app.Nodes.Select(chainNode, false);
                            NotifySelection(chainNode, app.CurrentLayout);
                        }
                    }
                    break;
                default:
                    Debug.LogWarning("[FCA] Unknown JS command: " + command);
                    break;
            }
        }
    }
}
#endif
