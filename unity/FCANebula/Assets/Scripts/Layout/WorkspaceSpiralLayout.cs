// FCA Memory Atlas — Unity Nebula Renderer
// WorkspaceSpiralLayout: turns the real Runtime graph into one logarithmic-spiral arm per
// workspace. Grouping is driven exclusively by node tags:
//     "workspace:<label>"  -> arm <label>
//     (no such tag)        -> arm "default"
//
// ============================================================================
// LAYOUT IS FROZEN (user requirement 2026-11-13): the arm assignment/order/colour,
// node sorting, theta/radius/jitter/z formulas and serialized parameters below are the
// pre-task-14 implementation and MUST NOT be changed for visual fixes. Task-14 only adds:
//   * read-only alignment diagnostics (no position change)
//   * an ADDITIVE folded sub-agent layer: child nodes keep their frozen layout position in
//     BasePosition, are hidden by default and are re-positioned around their parent only
//     while expanded (HierarchyController) - parent/other nodes never move.
// The shader-side geometry alignment fix lives in NebulaVolume.shader (rel unwrap), not here.
// ============================================================================
//
// Arm geometry (unchanged, shared with the volume shader):
//     r(t) = r0 * exp(b * theta(t))          (logarithmic spiral)
//     theta(t) = baseAngle + hand * span * t  (span depends on the arm's node count)
//     b = ln(rOuter / rInner) / maxSpan
//     armWidth(t) = radialWidth0 * (0.65 + 0.55 * t)   (gaussian sigma in the shader)

using System;
using System.Collections.Generic;
using System.Text;
using UnityEngine;

namespace FCANebula
{
    public sealed class LayoutNode
    {
        public GraphNode Source;
        public string Id;
        public Vector3 Position;          // frozen layout position (target while expanded)
        public Vector3 VisualPosition;    // interpolated position used by the renderer
        public float VisualVisibility = 1f;
        public bool IsVisible = true;
        public Vector3 BasePosition;      // frozen layout position (diagnostics / collapse target)
        public float Size;
        public float Brightness;
        public Color ArmColorSrgb;
        public Color TintSrgb;
        public int ArmIndex;
        public string ArmLabel;
        public float AlongArm;
        public bool IsEntity;

        // additive hierarchy layer
        public bool IsHierarchyChild;
        public bool IsParent;
        public string ParentId;
        public readonly List<string> ChildIds = new List<string>();
        public bool IsExpanded;

        // additive chain layer (task-19: visible chain links / whole-chain highlight)
        public string ChainKey;
        public int ChainSize = 1;

        // read-only alignment diagnostics (offset from the frozen arm centre line)
        public float RadialOffset;
        public float TangentialOffset;
        public float ZOffset;
        public float WidthNow;
    }

    public sealed class LayoutArm
    {
        public string Label;
        public string ColorKey;
        public bool IsDefault;
        public Color ColorSrgb;
        public int NamedOrdinal;
        public int NodeCount;
        public float BaseAngleRad;
        public float InnerRadius;
        public float OuterRadius;
        public float SpanRadians;
        public float PitchB;
        public float RadialWidth;
        public float VerticalSigma;
        public float Intensity;
        public Vector3 Centroid;
        public float Spread;
        public List<LayoutNode> Nodes = new List<LayoutNode>();
    }

    public sealed class LayoutModel
    {
        public GraphModel Graph;
        public readonly List<LayoutNode> Nodes = new List<LayoutNode>();
        public readonly List<LayoutArm> Arms = new List<LayoutArm>();
        public readonly Dictionary<string, LayoutNode> ById = new Dictionary<string, LayoutNode>(StringComparer.Ordinal);
        public float MaxRadius = 100f;
        public Vector3 Center = Vector3.zero;
        public float Hand = 1f;
        public int ShaderArmCount;
        public int TotalArmsInGraph;
        public string Signature = "";

        // additive hierarchy summary
        public int HierarchyParentCount;
        public int HierarchyChildCount;
        public int HierarchyUnmatchedChildren;
        public readonly List<string> HierarchyParentIds = new List<string>();

        // read-only geometry diagnostics (node -> frozen arm centre line, in arm-width units)
        public int AlignSampleCount;
        public float AlignMeanWidth;
        public float AlignP95Width;
        public float AlignMaxWidth;
        public float AlignMeanZSigma;

        // chain layout (task-14: same session/parent-child chain -> same arm, contiguous)
        public int ChainCount;
        public int MultiNodeChainCount;
        public int CrossWorkspaceChainCount;
        public string ChainSignature = "";
        public readonly List<ChainSummary> ChainSummaries = new List<ChainSummary>();
        // chain membership lookup (task-19 chain links + whole-chain highlight + selection payload)
        public readonly Dictionary<string, List<string>> ChainNodeIds = new Dictionary<string, List<string>>(System.StringComparer.Ordinal);
        public readonly Dictionary<string, string> ChainOfNode = new Dictionary<string, string>(System.StringComparer.Ordinal);

        public int ArmCount { get { return Arms.Count; } }
        public int NodeCount { get { return Nodes.Count; } }
        public int VisibleNodeCount
        {
            get
            {
                int n = 0;
                for (int i = 0; i < Nodes.Count; i++) if (Nodes[i].IsVisible) n++;
                return n;
            }
        }
        public bool IsEmpty { get { return Nodes.Count == 0; } }
    }

    /// <summary>Parent/child mapping resolved from relations + tags (v0.3 contract).</summary>
    public sealed class HierarchyMap
    {
        public readonly Dictionary<string, string> ParentOfChild = new Dictionary<string, string>(StringComparer.Ordinal);
        public readonly Dictionary<string, List<string>> ChildrenOfParent = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        public readonly Dictionary<string, string> ChildSessionOf = new Dictionary<string, string>(StringComparer.Ordinal);
        public int UnmatchedChildren;
        public int ParentCount { get { return ChildrenOfParent.Count; } }
    }

    /// <summary>A session/parent-child chain: all nodes must share one workspace arm.</summary>
    public sealed class ChainInfo
    {
        public string Key;
        public string Workspace;
        public string ParentId;
        public readonly List<GraphNode> Nodes = new List<GraphNode>();
    }

    public sealed class ChainMap
    {
        public readonly List<ChainInfo> Chains = new List<ChainInfo>();
        public readonly Dictionary<string, string> ChainOfNode = new Dictionary<string, string>(StringComparer.Ordinal);
        public int MultiNodeChainCount;
        public int CrossWorkspaceChainCount;
    }

    /// <summary>Read-only per-chain summary for validation/manifest (same-arm assertion).</summary>
    public sealed class ChainSummary
    {
        public string Key;
        public string Workspace;
        public string ArmLabel;
        public int NodeCount;
        public bool SameArm;
        public string ParentId;
    }

    public sealed class WorkspaceSpiralLayout : MonoBehaviour
    {
        // -----------------------------------------------------------------
        // FROZEN parameters (pre-task-14 values; do not change - user requirement)
        // -----------------------------------------------------------------
        [Header("Spiral geometry (world units) - FROZEN")]
        public float InnerRadius = 72f;
        public float OuterRadius = 470f;

        [Header("Angular range - FROZEN")]
        public float MaxSpanRadians = 4.4f;
        public float MinSpanRatio = 0.42f;
        public float GlobalRotationRadians = 0f;
        public float Hand = 1f;

        [Header("Node scatter - FROZEN")]
        public float AngularJitter = 0.085f;
        public float RadialJitter = 0.075f;
        public float VerticalThickness = 34f;
        public float NodeBaseSize = 11.5f;

        [Header("Volume binding - FROZEN")]
        public float ArmRadialWidth = 0f;
        public float ArmVerticalSigma = 0f;

        string _lastSignature = "";

        public string LastSignature { get { return _lastSignature; } }

        // Shared geometry helpers used by the shader-aligned edge renderer / hierarchy layer.
        public static float ArmWidthAt(float radialWidth0, float tNorm)
        {
            return radialWidth0 * (0.65f + 0.55f * Mathf.Clamp01(tNorm));
        }

        public static float ArmRadiusAt(float innerRadius, float pitchB, float rel)
        {
            return innerRadius * Mathf.Exp(pitchB * rel);
        }

        /// <summary>3D centre-line point of an arm at rel (edges follow this, layout is frozen).</summary>
        public static Vector3 ArmPoint(LayoutArm arm, LayoutModel model, float rel)
        {
            float angle = arm.BaseAngleRad + model.Hand * rel;
            float radius = ArmRadiusAt(arm.InnerRadius, arm.PitchB, rel);
            return new Vector3(Mathf.Cos(angle) * radius, Mathf.Sin(angle) * radius, 0f);
        }

        /// <summary>Build the FROZEN arm + node layout, then attach the additive hierarchy layer.</summary>
        public LayoutModel Build(GraphModel graph)
        {
            LayoutModel model = new LayoutModel();
            model.Graph = graph;
            model.Hand = Mathf.Approximately(Hand, 0f) ? 1f : Mathf.Sign(Hand);
            if (graph == null || graph.Nodes.Count == 0)
            {
                model.Signature = "empty";
                _lastSignature = model.Signature;
                return model;
            }

            // 1) CHAIN-AWARE grouping (task-14): nodes are first merged into session/parent-child
            //    chains (union-find), each chain votes one primary workspace, and every chain is
            //    kept contiguous along that workspace arm. Arm geometry parameters stay frozen.
            for (int i = 0; i < graph.Nodes.Count; i++)
            {
                GraphNode labeled = graph.Nodes[i];
                string workspaceLabel = ExtractWorkspace(labeled);
                labeled.WorkspaceLabel = workspaceLabel;
                labeled.WorkspaceIsDefault = string.Equals(workspaceLabel, DefaultArmLabel, StringComparison.OrdinalIgnoreCase);
            }
            HierarchyMap hierarchyForChains = ResolveHierarchy(graph);
            ChainMap chainMap = BuildChains(graph, hierarchyForChains);
            model.ChainCount = chainMap.Chains.Count;
            model.MultiNodeChainCount = chainMap.MultiNodeChainCount;
            model.CrossWorkspaceChainCount = chainMap.CrossWorkspaceChainCount;

            Dictionary<string, List<GraphNode>> groups = new Dictionary<string, List<GraphNode>>(StringComparer.OrdinalIgnoreCase);
            // Per-workspace ordered node list: chains sorted by deterministic hash, nodes inside a
            // chain ordered chronologically with the parent centred inside its contiguous block.
            Dictionary<string, List<ChainInfo>> chainsByWorkspace = new Dictionary<string, List<ChainInfo>>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < chainMap.Chains.Count; i++)
            {
                ChainInfo chain = chainMap.Chains[i];
                string workspace = string.IsNullOrEmpty(chain.Workspace) ? DefaultArmLabel : chain.Workspace;
                List<ChainInfo> list;
                if (!chainsByWorkspace.TryGetValue(workspace, out list))
                {
                    list = new List<ChainInfo>();
                    chainsByWorkspace[workspace] = list;
                }
                list.Add(chain);
            }
            foreach (KeyValuePair<string, List<ChainInfo>> workspacePair in chainsByWorkspace)
            {
                List<ChainInfo> chains = workspacePair.Value;
                chains.Sort(delegate (ChainInfo a, ChainInfo b)
                {
                    uint ha = StableHash(a.Key);
                    uint hb = StableHash(b.Key);
                    if (ha != hb) return ha.CompareTo(hb);
                    return string.CompareOrdinal(a.Key, b.Key);
                });
                List<GraphNode> orderedNodes = new List<GraphNode>();
                for (int c = 0; c < chains.Count; c++)
                {
                    orderedNodes.AddRange(OrderChainNodes(chains[c]));
                }
                groups[workspacePair.Key] = orderedNodes;
            }
            if (groups.Count == 0)
            {
                groups[DefaultArmLabel] = new List<GraphNode>(graph.Nodes);
            }

            // 2) Deterministic arm order: named workspaces sorted, catch-all "default" last.
            List<string> ordered = new List<string>();
            foreach (string key in groups.Keys)
            {
                if (!string.Equals(key, DefaultArmLabel, StringComparison.OrdinalIgnoreCase))
                {
                    ordered.Add(key);
                }
            }
            ordered.Sort(StringComparer.OrdinalIgnoreCase);
            if (groups.ContainsKey(DefaultArmLabel))
            {
                ordered.Add(DefaultArmLabel);
            }

            int armCount = Mathf.Max(1, ordered.Count);
            int maxNodes = 1;
            for (int i = 0; i < ordered.Count; i++)
            {
                maxNodes = Mathf.Max(maxNodes, groups[ordered[i]].Count);
            }

            float pitchB = Mathf.Log(Mathf.Max(1.01f, OuterRadius) / Mathf.Max(1f, InnerRadius)) / Mathf.Max(0.1f, MaxSpanRadians);
            float maxRadius = OuterRadius;
            int namedOrdinal = 0;

            for (int armIndex = 0; armIndex < ordered.Count; armIndex++)
            {
                string label = ordered[armIndex];
                List<GraphNode> armNodes = groups[label];
                bool isDefault = string.Equals(label, DefaultArmLabel, StringComparison.OrdinalIgnoreCase);

                LayoutArm arm = new LayoutArm();
                arm.Label = isDefault ? "default" : label;
                arm.IsDefault = isDefault;
                arm.NodeCount = armNodes.Count;
                arm.NamedOrdinal = isDefault ? -1 : namedOrdinal;
                arm.ColorSrgb = ThemePalette.ArmColor(isDefault, namedOrdinal);
                arm.ColorKey = ThemePalette.ArmColorKey(isDefault, namedOrdinal);
                if (!isDefault) namedOrdinal++;
                arm.BaseAngleRad = GlobalRotationRadians + (Mathf.PI * 2f * armIndex) / armCount;
                arm.InnerRadius = InnerRadius;
                arm.PitchB = pitchB;
                float countRatio = Mathf.Clamp01((float)armNodes.Count / maxNodes);
                arm.SpanRadians = Mathf.Lerp(MaxSpanRadians * MinSpanRatio, MaxSpanRadians, Mathf.Sqrt(countRatio));
                arm.OuterRadius = InnerRadius * Mathf.Exp(pitchB * arm.SpanRadians);
                arm.RadialWidth = ArmRadialWidth > 0f ? ArmRadialWidth : Mathf.Clamp(InnerRadius * 0.16f + arm.OuterRadius * 0.038f, 15f, 40f);
                arm.VerticalSigma = ArmVerticalSigma > 0f ? ArmVerticalSigma : Mathf.Max(26f, VerticalThickness * 0.85f);
                arm.Intensity = 0.72f + 0.38f * countRatio;
                maxRadius = Mathf.Max(maxRadius, arm.OuterRadius);

                // Node order inside the arm comes from the chain-contiguous ordering above.
                List<GraphNode> sorted = armNodes;
                int count = sorted.Count;
                for (int rank = 0; rank < count; rank++)
                {
                    GraphNode node = sorted[rank];
                    LayoutNode layoutNode = new LayoutNode();
                    layoutNode.Source = node;
                    layoutNode.Id = node.Id;
                    layoutNode.ArmIndex = armIndex;
                    layoutNode.ArmLabel = arm.Label;
                    layoutNode.ArmColorSrgb = arm.ColorSrgb;
                    layoutNode.IsEntity = node.IsEntity;

                    float hT = Hash01(node.Id, 0x9E3779B9u);
                    float hR = Hash01(node.Id, 0x85EBCA6Bu);
                    float hA = Hash01(node.Id, 0xC2B2AE35u);
                    float hZ = Hash01(node.Id, 0x27D4EB2Fu);

                    float t = count <= 1 ? 0.62f : (rank + 0.5f) / count;
                    t += (hT - 0.5f) * (0.55f / Mathf.Max(1, count));
                    t = Mathf.Clamp(t, 0.02f, 0.98f);
                    layoutNode.AlongArm = t;

                    float angleT = Mathf.Lerp(0f, arm.SpanRadians, t);
                    float radial = arm.InnerRadius * Mathf.Exp(arm.PitchB * angleT);
                    radial *= 1f + (hR - 0.5f) * 2f * RadialJitter;
                    float importance = Mathf.Clamp01(node.Importance);
                    float angularScatter = (hA - 0.5f) * 2f * AngularJitter * (1.25f - 0.55f * importance);
                    float theta = arm.BaseAngleRad + model.Hand * angleT + angularScatter;

                    float zSpread = (hZ - 0.5f) * 2f * VerticalThickness * (1f - 0.38f * importance);
                    float zWave = Mathf.Sin(t * Mathf.PI * 2f + armIndex * 1.7f) * 4.5f;
                    Vector3 position = new Vector3(Mathf.Cos(theta) * radial, Mathf.Sin(theta) * radial, zSpread + zWave);
                    layoutNode.Position = position;
                    layoutNode.BasePosition = position;
                    layoutNode.VisualPosition = position;
                    layoutNode.VisualVisibility = 1f;

                    float size = NodeBaseSize
                        * (0.55f + 0.95f * importance)
                        * (0.70f + 0.30f * node.DisplayWeight)
                        * (1f + 0.018f * Mathf.Sqrt(node.Degree));
                    layoutNode.Size = Mathf.Max(1.6f, size);
                    layoutNode.Brightness = Mathf.Clamp((0.18f + 0.82f * importance * importance) * (0.65f + 0.35f * node.DisplayWeight), 0.05f, 1.5f);
                    layoutNode.TintSrgb = ThemePalette.NodeTint(arm.ColorSrgb, node.IsEntity, node.Type);

                    arm.Nodes.Add(layoutNode);
                    model.Nodes.Add(layoutNode);
                    model.ById[node.Id] = layoutNode;
                }

                if (arm.Nodes.Count > 0)
                {
                    Vector3 sum = Vector3.zero;
                    for (int i = 0; i < arm.Nodes.Count; i++) sum += arm.Nodes[i].Position;
                    arm.Centroid = sum / arm.Nodes.Count;
                    float spread = 0f;
                    for (int i = 0; i < arm.Nodes.Count; i++)
                    {
                        spread = Mathf.Max(spread, Vector3.Distance(arm.Centroid, arm.Nodes[i].Position));
                    }
                    arm.Spread = spread;
                }
                model.Arms.Add(arm);
            }

            Vector3 center = Vector3.zero;
            for (int i = 0; i < model.Nodes.Count; i++) center += model.Nodes[i].Position;
            model.Center = model.Nodes.Count > 0 ? center / model.Nodes.Count : Vector3.zero;
            model.MaxRadius = maxRadius;
            model.TotalArmsInGraph = model.Arms.Count;
            model.ShaderArmCount = Mathf.Min(ThemePalette.MaxShaderArms, model.Arms.Count);

            // FROZEN signature format (unchanged) - used to prove layout did not change.
            model.Signature = BuildSignature(model);
            _lastSignature = model.Signature;

            // -----------------------------------------------------------------
            // ADDITIVE layer: fold sub-agent children (does NOT move any parent/primary node)
            // -----------------------------------------------------------------
            HierarchyMap hierarchy = ResolveHierarchy(graph);
            model.HierarchyParentCount = hierarchy.ParentCount;
            model.HierarchyUnmatchedChildren = hierarchy.UnmatchedChildren;
            foreach (string parentId in hierarchy.ChildrenOfParent.Keys) model.HierarchyParentIds.Add(parentId);
            model.HierarchyParentIds.Sort(StringComparer.Ordinal);
            model.HierarchyChildCount = 0;

            for (int i = 0; i < model.Nodes.Count; i++)
            {
                LayoutNode child = model.Nodes[i];
                string parentId;
                if (!hierarchy.ParentOfChild.TryGetValue(child.Id, out parentId)) continue;
                LayoutNode parent;
                if (!model.ById.TryGetValue(parentId, out parent) || ReferenceEquals(parent, child)) continue;

                child.IsHierarchyChild = true;
                child.ParentId = parentId;
                child.IsVisible = false;
                child.VisualVisibility = 0f;
                // The frozen position is kept in BasePosition for diagnostics; the node is
                // hidden and its target position is its parent (fan is applied on expand).
                child.BasePosition = child.Position;
                child.Position = parent.Position;
                child.VisualPosition = parent.Position;
                child.ArmIndex = parent.ArmIndex;
                child.ArmLabel = parent.ArmLabel;
                child.ArmColorSrgb = parent.ArmColorSrgb;
                child.AlongArm = parent.AlongArm;
                child.TintSrgb = Color.Lerp(parent.TintSrgb, ThemePalette.HierarchyGoldSrgb(), 0.45f);
                if (!parent.ChildIds.Contains(child.Id)) parent.ChildIds.Add(child.Id);
                model.HierarchyChildCount++;
            }
            for (int i = 0; i < model.Nodes.Count; i++)
            {
                LayoutNode node = model.Nodes[i];
                if (!node.IsHierarchyChild && node.ChildIds.Count > 0) node.IsParent = true;
            }

            // -----------------------------------------------------------------
            // Read-only alignment diagnostics (proves shader/edge alignment, no layout change)
            // -----------------------------------------------------------------
            List<float> alignSamples = new List<float>(model.Nodes.Count);
            List<float> zSamples = new List<float>(model.Nodes.Count);
            for (int i = 0; i < model.Nodes.Count; i++)
            {
                LayoutNode node = model.Nodes[i];
                if (node.IsHierarchyChild) continue;
                if (node.ArmIndex < 0 || node.ArmIndex >= model.Arms.Count) continue;
                LayoutArm arm = model.Arms[node.ArmIndex];
                float rel = arm.SpanRadians * Mathf.Clamp01(node.AlongArm);
                float expectedRadius = ArmRadiusAt(arm.InnerRadius, arm.PitchB, rel);
                float radius = new Vector2(node.Position.x, node.Position.y).magnitude;
                float radialOffset = radius - expectedRadius;
                float nodeTheta = Mathf.Atan2(node.Position.y, node.Position.x);
                float centreTheta = arm.BaseAngleRad + model.Hand * rel;
                float dTheta = Mathf.DeltaAngle(centreTheta * Mathf.Rad2Deg, nodeTheta * Mathf.Rad2Deg) * Mathf.Deg2Rad;
                float tangentialOffset = radius * dTheta;
                float widthNow = ArmWidthAt(arm.RadialWidth, node.AlongArm);
                node.WidthNow = widthNow;
                node.RadialOffset = radialOffset;
                node.TangentialOffset = tangentialOffset;
                node.ZOffset = node.Position.z;
                float perpendicular = Mathf.Sqrt(radialOffset * radialOffset + tangentialOffset * tangentialOffset);
                alignSamples.Add(perpendicular / Mathf.Max(widthNow, 0.01f));
                zSamples.Add(Mathf.Abs(node.Position.z) / Mathf.Max(arm.VerticalSigma, 0.01f));
            }
            if (alignSamples.Count > 0)
            {
                alignSamples.Sort();
                float sum = 0f;
                for (int i = 0; i < alignSamples.Count; i++) sum += alignSamples[i];
                model.AlignSampleCount = alignSamples.Count;
                model.AlignMeanWidth = sum / alignSamples.Count;
                model.AlignMaxWidth = alignSamples[alignSamples.Count - 1];
                int p95 = Mathf.Clamp(Mathf.RoundToInt(alignSamples.Count * 0.95f) - 1, 0, alignSamples.Count - 1);
                model.AlignP95Width = alignSamples[p95];
                float zSum = 0f;
                for (int i = 0; i < zSamples.Count; i++) zSum += zSamples[i];
                model.AlignMeanZSigma = zSum / zSamples.Count;
            }

            // Chain summaries (read-only validation: every chain is on exactly one arm).
            BuildChainSummaries(model, chainMap);

            // Chain membership maps (task-19): needed by EdgeRenderer chain links,
            // NodeRenderer whole-chain highlight and the fca-unity-select payload.
            for (int c = 0; c < chainMap.Chains.Count; c++)
            {
                ChainInfo chain = chainMap.Chains[c];
                List<string> ids = new List<string>(chain.Nodes.Count);
                for (int i = 0; i < chain.Nodes.Count; i++) ids.Add(chain.Nodes[i].Id);
                model.ChainNodeIds[chain.Key] = ids;
                for (int i = 0; i < ids.Count; i++) model.ChainOfNode[ids[i]] = chain.Key;
            }
            for (int i = 0; i < model.Nodes.Count; i++)
            {
                LayoutNode node = model.Nodes[i];
                string chainKey;
                List<string> chainIds;
                if (model.ChainOfNode.TryGetValue(node.Id, out chainKey) && model.ChainNodeIds.TryGetValue(chainKey, out chainIds))
                {
                    node.ChainKey = chainKey;
                    node.ChainSize = chainIds.Count;
                }
                else
                {
                    node.ChainKey = node.Id;
                    node.ChainSize = 1;
                }
            }
            return model;
        }

        // -----------------------------------------------------------------
        // Session / parent-child chains (task-14)
        // -----------------------------------------------------------------
        static ChainMap BuildChains(GraphModel graph, HierarchyMap hierarchy)
        {
            ChainMap map = new ChainMap();
            int n = graph.Nodes.Count;
            if (n == 0) return map;
            int[] uf = new int[n];
            for (int i = 0; i < n; i++) uf[i] = i;
            Dictionary<string, int> indexById = new Dictionary<string, int>(StringComparer.Ordinal);
            Dictionary<string, int> childSessionToIndex = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            Dictionary<string, List<int>> tokenToIndices = new Dictionary<string, List<int>>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < n; i++)
            {
                GraphNode node = graph.Nodes[i];
                indexById[node.Id] = i;
                if (node.Tags == null) continue;
                for (int t = 0; t < node.Tags.Length; t++)
                {
                    string tag = node.Tags[t];
                    if (string.IsNullOrEmpty(tag)) continue;
                    string token = null;
                    if (tag.StartsWith("subagent-session:", StringComparison.OrdinalIgnoreCase)) token = tag.Substring("subagent-session:".Length);
                    else if (tag.StartsWith("parent-session:", StringComparison.OrdinalIgnoreCase)) token = tag.Substring("parent-session:".Length);
                    else if (tag.StartsWith("session:", StringComparison.OrdinalIgnoreCase)) token = tag.Substring("session:".Length);
                    else if (tag.StartsWith("agent-session:", StringComparison.OrdinalIgnoreCase)) token = tag.Substring("agent-session:".Length);
                    else if (tag.StartsWith("session-id:", StringComparison.OrdinalIgnoreCase)) token = tag.Substring("session-id:".Length);
                    if (string.IsNullOrEmpty(token)) continue;
                    token = token.Trim();
                    if (token.Length < 4 || token == "session-" || token == "session") continue; // known v0.3 bug value
                    List<int> owners;
                    if (!tokenToIndices.TryGetValue(token, out owners))
                    {
                        owners = new List<int>();
                        tokenToIndices[token] = owners;
                    }
                    owners.Add(i);
                    if (tag.StartsWith("subagent-session:", StringComparison.OrdinalIgnoreCase))
                    {
                        childSessionToIndex[token] = i;
                    }
                }
            }

            // (a) same session token => same chain
            foreach (KeyValuePair<string, List<int>> pair in tokenToIndices)
            {
                List<int> owners = pair.Value;
                for (int i = 1; i < owners.Count; i++) Union(uf, owners[0], owners[i]);
            }
            // (b) relations spawned_subagent / derived_from
            for (int e = 0; e < graph.Edges.Count; e++)
            {
                GraphEdge edge = graph.Edges[e];
                if (!IsParentRelation(edge)) continue;
                int a, b;
                if (indexById.TryGetValue(edge.From, out a) && indexById.TryGetValue(edge.To, out b)) Union(uf, a, b);
            }
            // (c) parent-memory:<memId> tag
            for (int i = 0; i < n; i++)
            {
                GraphNode node = graph.Nodes[i];
                string parentId = GetTagValue(node, "parent-memory:");
                int parentIndex;
                if (!string.IsNullOrEmpty(parentId) && indexById.TryGetValue(parentId, out parentIndex)) Union(uf, i, parentIndex);
            }
            // (d) children:<childId8> tags => union parent with matching subagent-session node
            for (int i = 0; i < n; i++)
            {
                GraphNode node = graph.Nodes[i];
                List<string> children = GetTagValues(node, "children:");
                for (int c = 0; c < children.Count; c++)
                {
                    int childIndex;
                    if (childSessionToIndex.TryGetValue(children[c], out childIndex)) Union(uf, i, childIndex);
                    else
                    {
                        foreach (KeyValuePair<string, int> pair in childSessionToIndex)
                        {
                            if (MatchesKey(pair.Key, children[c])) { Union(uf, i, pair.Value); break; }
                        }
                    }
                }
            }

            // Build chain records.
            Dictionary<int, List<int>> members = new Dictionary<int, List<int>>();
            for (int i = 0; i < n; i++)
            {
                int root = Find(uf, i);
                List<int> list;
                if (!members.TryGetValue(root, out list))
                {
                    list = new List<int>();
                    members[root] = list;
                }
                list.Add(i);
            }
            foreach (KeyValuePair<int, List<int>> pair in members)
            {
                ChainInfo chain = new ChainInfo();
                List<GraphNode> nodes = new List<GraphNode>();
                for (int i = 0; i < pair.Value.Count; i++) nodes.Add(graph.Nodes[pair.Value[i]]);
                nodes.Sort(delegate (GraphNode a, GraphNode b)
                {
                    int c = string.CompareOrdinal(a.OccurredAt ?? "", b.OccurredAt ?? "");
                    if (c != 0) return c;
                    return string.CompareOrdinal(a.Id, b.Id);
                });
                chain.Nodes.AddRange(nodes);

                // parent candidate inside the chain (deterministic)
                string parentId = null;
                for (int i = 0; i < nodes.Count; i++)
                {
                    if (hierarchy != null && hierarchy.ChildrenOfParent.ContainsKey(nodes[i].Id))
                    {
                        parentId = nodes[i].Id;
                        break;
                    }
                }
                chain.ParentId = parentId;
                chain.Key = !string.IsNullOrEmpty(parentId) ? parentId : nodes[0].Id;

                // workspace majority vote; ties -> parent label, then earliest node label
                Dictionary<string, int> votes = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                int distinctWorkspaces = 0;
                for (int i = 0; i < nodes.Count; i++)
                {
                    string label = string.IsNullOrEmpty(nodes[i].WorkspaceLabel) ? DefaultArmLabel : nodes[i].WorkspaceLabel;
                    int count;
                    votes.TryGetValue(label, out count);
                    votes[label] = count + 1;
                    if (count == 0) distinctWorkspaces++;
                }
                if (distinctWorkspaces > 1) map.CrossWorkspaceChainCount++;
                string winner = null;
                int bestVotes = -1;
                foreach (KeyValuePair<string, int> vote in votes)
                {
                    if (vote.Value > bestVotes || (vote.Value == bestVotes && string.CompareOrdinal(vote.Key, winner ?? "") < 0))
                    {
                        bestVotes = vote.Value;
                        winner = vote.Key;
                    }
                }
                if (!string.IsNullOrEmpty(parentId))
                {
                    int parentVotes;
                    if (votes.TryGetValue(graph.NodeIndex[parentId].WorkspaceLabel, out parentVotes) && parentVotes == bestVotes)
                    {
                        winner = graph.NodeIndex[parentId].WorkspaceLabel;
                    }
                }
                chain.Workspace = winner;
                if (nodes.Count > 1) map.MultiNodeChainCount++;
                map.Chains.Add(chain);
                for (int i = 0; i < nodes.Count; i++) map.ChainOfNode[nodes[i].Id] = chain.Key;
            }
            return map;
        }

        static List<GraphNode> OrderChainNodes(ChainInfo chain)
        {
            List<GraphNode> ordered = new List<GraphNode>(chain.Nodes);
            if (!string.IsNullOrEmpty(chain.ParentId))
            {
                int index = ordered.FindIndex(delegate (GraphNode n) { return n.Id == chain.ParentId; });
                if (index >= 0 && ordered.Count > 2)
                {
                    GraphNode parent = ordered[index];
                    ordered.RemoveAt(index);
                    ordered.Insert(Mathf.Clamp(ordered.Count / 2, 0, ordered.Count), parent);
                }
            }
            return ordered;
        }

        static void BuildChainSummaries(LayoutModel model, ChainMap chainMap)
        {
            if (model == null || chainMap == null) return;
            StringBuilder sb = new StringBuilder(256);
            sb.Append("c1|");
            sb.Append(chainMap.Chains.Count).Append('|');
            for (int c = 0; c < chainMap.Chains.Count; c++)
            {
                ChainInfo chain = chainMap.Chains[c];
                ChainSummary summary = new ChainSummary();
                summary.Key = chain.Key;
                summary.Workspace = chain.Workspace;
                summary.ParentId = chain.ParentId;
                summary.NodeCount = chain.Nodes.Count;
                int armIndex = -2;
                bool sameArm = true;
                for (int i = 0; i < chain.Nodes.Count; i++)
                {
                    LayoutNode layoutNode;
                    if (!model.ById.TryGetValue(chain.Nodes[i].Id, out layoutNode)) continue;
                    if (armIndex == -2) armIndex = layoutNode.ArmIndex;
                    else if (layoutNode.ArmIndex != armIndex) sameArm = false;
                }
                summary.SameArm = sameArm;
                summary.ArmLabel = armIndex >= 0 && armIndex < model.Arms.Count ? model.Arms[armIndex].Label : "?";
                model.ChainSummaries.Add(summary);
                sb.Append(chain.Key).Append(':').Append(summary.ArmLabel).Append(':').Append(summary.NodeCount).Append(';');
            }
            model.ChainSignature = "c1|" + chainMap.Chains.Count + "|" + StableHash(sb.ToString()).ToString("x8");
        }

        static int Find(int[] uf, int x)
        {
            while (uf[x] != x)
            {
                uf[x] = uf[uf[x]];
                x = uf[x];
            }
            return x;
        }

        static void Union(int[] uf, int a, int b)
        {
            int ra = Find(uf, a);
            int rb = Find(uf, b);
            if (ra != rb) uf[rb] = ra;
        }

        public const string DefaultArmLabel = "default";

        /// <summary>Resolve the workspace label from a node's tags ("workspace:&lt;label&gt;").</summary>
        public string ExtractWorkspace(GraphNode node)
        {
            if (node == null || node.Tags == null) return DefaultArmLabel;
            string prefix = WorkspaceTagPrefixCached();
            for (int i = 0; i < node.Tags.Length; i++)
            {
                string tag = node.Tags[i];
                if (string.IsNullOrEmpty(tag)) continue;
                if (tag.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                {
                    string label = tag.Substring(prefix.Length).Trim();
                    if (!string.IsNullOrEmpty(label)) return label;
                }
            }
            return DefaultArmLabel;
        }

        // -----------------------------------------------------------------
        // Hierarchy resolution (v0.3 contract; relations > tags)
        // -----------------------------------------------------------------
        public static HierarchyMap ResolveHierarchy(GraphModel graph)
        {
            HierarchyMap map = new HierarchyMap();
            if (graph == null) return map;
            Dictionary<string, GraphNode> byId = graph.NodeIndex;
            Dictionary<string, GraphNode> sessionOwner = new Dictionary<string, GraphNode>(StringComparer.OrdinalIgnoreCase);
            Dictionary<string, GraphNode> childBySession = new Dictionary<string, GraphNode>(StringComparer.OrdinalIgnoreCase);
            Dictionary<string, List<string>> parentChildrenTag = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            Dictionary<string, string> parentSessionOfChild = new Dictionary<string, string>(StringComparer.Ordinal);
            Dictionary<string, string> directParentOfChild = new Dictionary<string, string>(StringComparer.Ordinal);
            List<GraphNode> candidates = new List<GraphNode>();

            for (int i = 0; i < graph.Nodes.Count; i++)
            {
                GraphNode node = graph.Nodes[i];
                string childSession = GetTagValue(node, "subagent-session:");
                if (!string.IsNullOrEmpty(childSession))
                {
                    candidates.Add(node);
                    childBySession[childSession] = node;
                }
                string parentSession = GetTagValue(node, "parent-session:");
                if (!string.IsNullOrEmpty(parentSession)) parentSessionOfChild[node.Id] = parentSession;
                string directParent = GetTagValue(node, "parent-memory:");
                if (!string.IsNullOrEmpty(directParent)) directParentOfChild[node.Id] = directParent;
                RegisterSessionTags(node, sessionOwner);
                List<string> children = GetTagValues(node, "children:");
                if (children.Count > 0) parentChildrenTag[node.Id] = children;
            }

            // 1) relations (highest priority)
            ApplyRelationParents(graph, byId, childBySession, parentSessionOfChild, directParentOfChild, map);
            // 2) parent-memory tag
            for (int i = 0; i < graph.Nodes.Count; i++)
            {
                GraphNode child = graph.Nodes[i];
                if (map.ParentOfChild.ContainsKey(child.Id)) continue;
                string parentId;
                if (!directParentOfChild.TryGetValue(child.Id, out parentId)) continue;
                if (byId.ContainsKey(parentId) && !string.Equals(parentId, child.Id, StringComparison.Ordinal))
                {
                    map.ParentOfChild[child.Id] = parentId;
                }
            }
            // 3) children:<childId8> tags / parent session tags
            foreach (KeyValuePair<string, List<string>> pair in parentChildrenTag)
            {
                GraphNode parent = byId.ContainsKey(pair.Key) ? byId[pair.Key] : null;
                if (parent == null) continue;
                for (int i = 0; i < pair.Value.Count; i++)
                {
                    string childKey = pair.Value[i].Trim();
                    if (string.IsNullOrEmpty(childKey)) continue;
                    GraphNode child = FindChildBySession(childBySession, childKey);
                    if (child != null && !string.Equals(child.Id, parent.Id, StringComparison.Ordinal) && !map.ParentOfChild.ContainsKey(child.Id))
                    {
                        map.ParentOfChild[child.Id] = parent.Id;
                    }
                }
            }
            for (int i = 0; i < candidates.Count; i++)
            {
                GraphNode child = candidates[i];
                if (map.ParentOfChild.ContainsKey(child.Id)) continue;
                string parentSession;
                if (parentSessionOfChild.TryGetValue(child.Id, out parentSession))
                {
                    GraphNode parent = FindOwner(sessionOwner, parentSession);
                    if (parent != null && !string.Equals(parent.Id, child.Id, StringComparison.Ordinal))
                    {
                        map.ParentOfChild[child.Id] = parent.Id;
                    }
                }
            }

            // 4) children lists (drop parents that no longer exist)
            foreach (GraphNode child in candidates)
            {
                string parentId;
                if (!map.ParentOfChild.TryGetValue(child.Id, out parentId))
                {
                    map.UnmatchedChildren++;
                    continue;
                }
                if (!byId.ContainsKey(parentId)) continue;
                List<string> list;
                if (!map.ChildrenOfParent.TryGetValue(parentId, out list))
                {
                    list = new List<string>();
                    map.ChildrenOfParent[parentId] = list;
                }
                list.Add(child.Id);
            }
            foreach (KeyValuePair<string, List<string>> pair in map.ChildrenOfParent) pair.Value.Sort(StringComparer.Ordinal);
            return map;
        }

        static void ApplyRelationParents(GraphModel graph, Dictionary<string, GraphNode> byId,
            Dictionary<string, GraphNode> childBySession, Dictionary<string, string> parentSessionOfChild,
            Dictionary<string, string> directParentOfChild, HierarchyMap map)
        {
            if (graph == null || graph.Edges.Count == 0) return;
            for (int i = 0; i < graph.Edges.Count; i++)
            {
                GraphEdge edge = graph.Edges[i];
                if (string.IsNullOrEmpty(edge.From) || string.IsNullOrEmpty(edge.To)) continue;
                GraphNode from = byId.ContainsKey(edge.From) ? byId[edge.From] : null;
                GraphNode to = byId.ContainsKey(edge.To) ? byId[edge.To] : null;
                if (from == null || to == null || from.IsEntity || to.IsEntity) continue;
                bool fromChild = IsChildCandidate(from, childBySession, parentSessionOfChild, directParentOfChild);
                bool toChild = IsChildCandidate(to, childBySession, parentSessionOfChild, directParentOfChild);
                bool qualified = IsParentRelation(edge);
                if (toChild && !fromChild)
                {
                    if (qualified || !map.ParentOfChild.ContainsKey(to.Id)) map.ParentOfChild[to.Id] = from.Id;
                }
                else if (fromChild && !toChild)
                {
                    if (qualified || !map.ParentOfChild.ContainsKey(from.Id)) map.ParentOfChild[from.Id] = to.Id;
                }
            }
        }

        static bool IsParentRelation(GraphEdge edge)
        {
            if (edge == null) return false;
            if (string.Equals(edge.RelationType, "derived_from", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(edge.RelationType, "custom", StringComparison.OrdinalIgnoreCase))
            {
                string label = edge.Label ?? "";
                if (label.IndexOf("spawned_subagent", StringComparison.OrdinalIgnoreCase) >= 0) return true;
                if (label.IndexOf("subagent", StringComparison.OrdinalIgnoreCase) >= 0) return true;
                if (label.IndexOf("parent", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            }
            return false;
        }

        static bool IsChildCandidate(GraphNode node, Dictionary<string, GraphNode> childBySession,
            Dictionary<string, string> parentSessionOfChild, Dictionary<string, string> directParentOfChild)
        {
            if (node == null) return false;
            if (childBySession.ContainsValue(node)) return true;
            if (parentSessionOfChild.ContainsKey(node.Id)) return true;
            if (directParentOfChild.ContainsKey(node.Id)) return true;
            return false;
        }

        static void RegisterSessionTags(GraphNode node, Dictionary<string, GraphNode> sessionOwner)
        {
            if (node.Tags == null) return;
            for (int i = 0; i < node.Tags.Length; i++)
            {
                string tag = node.Tags[i];
                if (string.IsNullOrEmpty(tag)) continue;
                string value = null;
                if (tag.StartsWith("session:", StringComparison.OrdinalIgnoreCase)) value = tag.Substring("session:".Length);
                else if (tag.StartsWith("agent-session:", StringComparison.OrdinalIgnoreCase)) value = tag.Substring("agent-session:".Length);
                else if (tag.StartsWith("session-id:", StringComparison.OrdinalIgnoreCase)) value = tag.Substring("session-id:".Length);
                if (!string.IsNullOrEmpty(value)) sessionOwner[value.Trim()] = node;
            }
        }

        static GraphNode FindOwner(Dictionary<string, GraphNode> sessionOwner, string sessionKey)
        {
            GraphNode node;
            if (sessionOwner.TryGetValue(sessionKey, out node)) return node;
            foreach (KeyValuePair<string, GraphNode> pair in sessionOwner)
            {
                if (MatchesKey(pair.Key, sessionKey)) return pair.Value;
            }
            return null;
        }

        static GraphNode FindChildBySession(Dictionary<string, GraphNode> childBySession, string key)
        {
            GraphNode node;
            if (childBySession.TryGetValue(key, out node)) return node;
            foreach (KeyValuePair<string, GraphNode> pair in childBySession)
            {
                if (MatchesKey(pair.Key, key)) return pair.Value;
            }
            return null;
        }

        static bool MatchesKey(string full, string candidate)
        {
            if (string.IsNullOrEmpty(full) || string.IsNullOrEmpty(candidate)) return false;
            if (string.Equals(full, candidate, StringComparison.OrdinalIgnoreCase)) return true;
            return full.StartsWith(candidate, StringComparison.OrdinalIgnoreCase)
                || candidate.StartsWith(full, StringComparison.OrdinalIgnoreCase);
        }

        static string GetTagValue(GraphNode node, string prefix)
        {
            if (node == null || node.Tags == null) return null;
            for (int i = 0; i < node.Tags.Length; i++)
            {
                string tag = node.Tags[i];
                if (!string.IsNullOrEmpty(tag) && tag.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                {
                    string value = tag.Substring(prefix.Length).Trim();
                    if (!string.IsNullOrEmpty(value)) return value;
                }
            }
            return null;
        }

        static List<string> GetTagValues(GraphNode node, string prefix)
        {
            List<string> values = new List<string>();
            if (node == null || node.Tags == null) return values;
            for (int i = 0; i < node.Tags.Length; i++)
            {
                string tag = node.Tags[i];
                if (string.IsNullOrEmpty(tag) || !tag.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
                string raw = tag.Substring(prefix.Length);
                if (string.IsNullOrEmpty(raw)) continue;
                string[] parts = raw.Split(new char[] { ',', ';', '|', ' ' }, StringSplitOptions.RemoveEmptyEntries);
                for (int p = 0; p < parts.Length; p++)
                {
                    string value = parts[p].Trim();
                    if (!string.IsNullOrEmpty(value)) values.Add(value);
                }
            }
            return values;
        }

        string WorkspaceTagPrefixCached()
        {
            if (!string.IsNullOrEmpty(_workspaceTagPrefix)) return _workspaceTagPrefix;
            AppConfig config = AppConfig.Current;
            _workspaceTagPrefix = config != null ? config.WorkspaceTagPrefix : AppConfig.DefaultWorkspaceTagPrefix;
            if (string.IsNullOrEmpty(_workspaceTagPrefix)) _workspaceTagPrefix = AppConfig.DefaultWorkspaceTagPrefix;
            return _workspaceTagPrefix;
        }

        string _workspaceTagPrefix;

        // FROZEN signature format: "v1|armCount|label:count|..." (unchanged).
        static string BuildSignature(LayoutModel model)
        {
            StringBuilder sb = new StringBuilder(128);
            sb.Append("v1|");
            sb.Append(model.Arms.Count.ToString());
            for (int i = 0; i < model.Arms.Count; i++)
            {
                sb.Append('|').Append(model.Arms[i].Label).Append(':').Append(model.Arms[i].NodeCount);
            }
            return sb.ToString();
        }

        // -----------------------------------------------------------------
        // Deterministic hashing (stable across machines / runs)
        // -----------------------------------------------------------------

        public static uint StableHash(string text)
        {
            uint hash = 2166136261u;
            if (string.IsNullOrEmpty(text)) return hash;
            for (int i = 0; i < text.Length; i++)
            {
                hash ^= text[i];
                hash *= 16777619u;
            }
            return hash;
        }

        public static float Hash01(string text, uint salt)
        {
            uint hash = StableHash(text) ^ salt;
            hash ^= hash >> 16;
            hash *= 2246822519u;
            hash ^= hash >> 13;
            hash *= 3266489917u;
            hash ^= hash >> 16;
            return (hash & 0x00FFFFFFu) / 16777215f;
        }
    }
}
