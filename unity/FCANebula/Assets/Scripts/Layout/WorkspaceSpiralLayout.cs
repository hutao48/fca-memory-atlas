// FCA Memory Atlas — Unity Nebula Renderer
// WorkspaceSpiralLayout: turns the real Runtime graph into one logarithmic-spiral arm per
// workspace. Grouping is driven exclusively by node tags:
//     "workspace:<label>"  -> arm <label>
//     (no such tag)        -> arm "default"
//
// Arm geometry (documented in docs/UNITY_NEBULA.md §4):
//     r(t) = r0 * exp(b * theta(t))          (logarithmic spiral)
//     theta(t) = baseAngle + hand * span * t  (span depends on the arm's node count)
//     b = ln(rOuter / rInner) / maxSpan
// Nodes are ordered deterministically along their arm (stable FNV-1a hash of the node id),
// with importance-driven jitter on angle / radius / z. API positions are deliberately
// discarded for node placement so that every memory of a workspace stays on its own arm.

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
        public Vector3 Position;
        public float Size;          // world units (billboard diameter)
        public float Brightness;    // 0..~1.4
        public Color ArmColorSrgb;
        public Color TintSrgb;      // type hue mixed with arm hue
        public int ArmIndex;
        public string ArmLabel;
        public float AlongArm;      // 0..1 position along the arm
        public bool IsEntity;
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

        public int ArmCount
        {
            get { return Arms.Count; }
        }

        public int NodeCount
        {
            get { return Nodes.Count; }
        }

        public bool IsEmpty
        {
            get { return Nodes.Count == 0; }
        }
    }

    /// <summary>
    /// Deterministic workspace -> spiral-arm layout. Attach to the nebula system GameObject;
    /// NebulaApp calls <see cref="Build"/> whenever a new graph arrives.
    /// </summary>
    public sealed class WorkspaceSpiralLayout : MonoBehaviour
    {
        [Header("Spiral geometry (world units)")]
        public float InnerRadius = 72f;
        public float OuterRadius = 470f;

        [Header("Angular range")]
        [Tooltip("Maximum sweep of an arm in radians (arm with the most nodes).")]
        public float MaxSpanRadians = 4.4f;
        [Tooltip("Minimum sweep relative to MaxSpanRadians for small workspaces.")]
        public float MinSpanRatio = 0.42f;
        public float GlobalRotationRadians = 0f;
        [Tooltip("+1 = counter-clockwise spiral, -1 = clockwise.")]
        public float Hand = 1f;

        [Header("Node scatter")]
        [Tooltip("Random angular scatter around the arm centre line (radians).")]
        public float AngularJitter = 0.085f;
        [Tooltip("Random radial scatter as a fraction of the arm radius.")]
        public float RadialJitter = 0.075f;
        [Tooltip("Vertical (+-z) thickness of the star layer.")]
        public float VerticalThickness = 34f;
        public float NodeBaseSize = 11.5f;

        [Header("Volume binding")]
        [Tooltip("Shader-side radial width of an arm (world units).")]
        public float ArmRadialWidth = 0f;
        [Tooltip("Shader-side vertical gaussian sigma (world units). 0 = auto.")]
        public float ArmVerticalSigma = 0f;

        string _lastSignature = "";

        public string LastSignature
        {
            get { return _lastSignature; }
        }

        /// <summary>Build a fully positioned layout from the live graph.</summary>
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

            // 1) Group nodes by workspace tag (case-insensitive key, first-seen display label).
            Dictionary<string, List<GraphNode>> groups = new Dictionary<string, List<GraphNode>>(StringComparer.OrdinalIgnoreCase);
            Dictionary<string, string> displayLabels = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < graph.Nodes.Count; i++)
            {
                GraphNode node = graph.Nodes[i];
                string label = ExtractWorkspace(node);
                node.WorkspaceLabel = label;
                node.WorkspaceIsDefault = string.Equals(label, DefaultArmLabel, StringComparison.OrdinalIgnoreCase);
                List<GraphNode> list;
                if (!groups.TryGetValue(label, out list))
                {
                    list = new List<GraphNode>();
                    groups[label] = list;
                    displayLabels[label] = label;
                }
                list.Add(node);
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
                if (!isDefault)
                {
                    namedOrdinal++;
                }
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

                // 3) Deterministic node ordering along the arm (FNV-1a of the node id).
                List<GraphNode> sorted = new List<GraphNode>(armNodes);
                sorted.Sort(delegate (GraphNode a, GraphNode b)
                {
                    int ha = (int)(StableHash(a.Id) & 0x7fffffff);
                    int hb = (int)(StableHash(b.Id) & 0x7fffffff);
                    if (ha != hb)
                    {
                        return ha.CompareTo(hb);
                    }
                    return string.CompareOrdinal(a.Id, b.Id);
                });

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
                    // Small radial redistribution so equal-importance beads do not look
                    // like a perfect necklace; big workspaces stay roughly evenly spaced.
                    t += (hT - 0.5f) * (0.55f / Mathf.Max(1, count));
                    t = Mathf.Clamp(t, 0.02f, 0.98f);
                    layoutNode.AlongArm = t;

                    float angleT = Mathf.Lerp(0f, arm.SpanRadians, t);
                    float radial = arm.InnerRadius * Mathf.Exp(arm.PitchB * angleT);
                    radial *= 1f + (hR - 0.5f) * 2f * RadialJitter;
                    // Bright nodes sit a little closer to the arm's centre line; ordinary
                    // memories scatter more, which keeps the nebula readable.
                    float importance = Mathf.Clamp01(node.Importance);
                    float angularScatter = (hA - 0.5f) * 2f * AngularJitter * (1.25f - 0.55f * importance);
                    float theta = arm.BaseAngleRad + model.Hand * angleT + angularScatter;

                    float zSpread = (hZ - 0.5f) * 2f * VerticalThickness * (1f - 0.38f * importance);
                    float zWave = Mathf.Sin(t * Mathf.PI * 2f + armIndex * 1.7f) * 4.5f;
                    Vector3 position = new Vector3(Mathf.Cos(theta) * radial, Mathf.Sin(theta) * radial, zSpread + zWave);
                    layoutNode.Position = position;

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

                // Arm centroid + spread (used by the camera and by the legend).
                if (arm.Nodes.Count > 0)
                {
                    Vector3 sum = Vector3.zero;
                    for (int i = 0; i < arm.Nodes.Count; i++)
                    {
                        sum += arm.Nodes[i].Position;
                    }
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

            // Overall bounds + signature.
            Vector3 center = Vector3.zero;
            for (int i = 0; i < model.Nodes.Count; i++)
            {
                center += model.Nodes[i].Position;
            }
            model.Center = model.Nodes.Count > 0 ? center / model.Nodes.Count : Vector3.zero;
            model.MaxRadius = maxRadius;
            model.TotalArmsInGraph = model.Arms.Count;
            model.ShaderArmCount = Mathf.Min(ThemePalette.MaxShaderArms, model.Arms.Count);
            model.Signature = BuildSignature(model);
            _lastSignature = model.Signature;
            return model;
        }

        public const string DefaultArmLabel = "default";

        /// <summary>Resolve the workspace label from a node's tags ("workspace:&lt;label&gt;").</summary>
        public string ExtractWorkspace(GraphNode node)
        {
            if (node == null || node.Tags == null)
            {
                return DefaultArmLabel;
            }
            string prefix = WorkspaceTagPrefixCached();
            for (int i = 0; i < node.Tags.Length; i++)
            {
                string tag = node.Tags[i];
                if (string.IsNullOrEmpty(tag))
                {
                    continue;
                }
                if (tag.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                {
                    string label = tag.Substring(prefix.Length).Trim();
                    if (!string.IsNullOrEmpty(label))
                    {
                        return label;
                    }
                }
            }
            return DefaultArmLabel;
        }

        string WorkspaceTagPrefixCached()
        {
            if (!string.IsNullOrEmpty(_workspaceTagPrefix))
            {
                return _workspaceTagPrefix;
            }
            AppConfig config = AppConfig.Current;
            _workspaceTagPrefix = config != null ? config.WorkspaceTagPrefix : AppConfig.DefaultWorkspaceTagPrefix;
            if (string.IsNullOrEmpty(_workspaceTagPrefix))
            {
                _workspaceTagPrefix = AppConfig.DefaultWorkspaceTagPrefix;
            }
            return _workspaceTagPrefix;
        }

        string _workspaceTagPrefix;

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
            if (string.IsNullOrEmpty(text))
            {
                return hash;
            }
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
