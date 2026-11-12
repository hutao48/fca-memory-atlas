// FCA Memory Atlas — Unity Nebula Renderer (Built-in Render Pipeline)
// EdgeRenderer: relation light-filaments built as one dynamic ribbon mesh.
//
// Task-14 geometry fix: filaments follow the SAME logarithmic spiral geometry as the volume
// nebula and the node layout instead of arbitrary bezier curves:
//   * same-arm edge  -> samples the arm's log-spiral centre line between the two nodes
//   * cross-arm edge -> runs inward along the source arm, arcs around the core at a small
//                       radius, then runs outward along the target arm; rendered very dim
//   * hierarchy link -> parent -> child sub-agent filament, dashed gold
// Two crossed ribbons per path keep the filament visible from any camera orbit.

using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

namespace FCANebula
{
    public sealed class HierarchyLink
    {
        public string ParentId;
        public string ChildId;
    }

    public sealed class EdgeRenderer : MonoBehaviour
    {
        AppConfig _config;
        QualityProfile _profile;
        LayoutModel _layout;
        GraphModel _graph;
        bool _initialized;

        GameObject _meshObject;
        MeshFilter _meshFilter;
        MeshRenderer _meshRenderer;
        Mesh _mesh;
        Material _material;

        readonly List<HierarchyLink> _hierarchyLinks = new List<HierarchyLink>();

        public int EdgeCount { get; private set; }
        public int CrossArmEdgeCount { get; private set; }
        public int HierarchyLinkCount { get; private set; }

        public void Initialize(AppConfig config, Camera camera)
        {
            if (_initialized) return;
            _config = config;
            _profile = config != null ? config.Profile : QualityProfile.For(QualityTier.High);
            CreateObject();
            CreateMaterial();
            _initialized = true;
            ApplyQuality(_profile);
        }

        void CreateObject()
        {
            _meshObject = new GameObject("FCA Relation Filaments");
            _meshObject.hideFlags = HideFlags.DontSave;
            _meshObject.transform.SetParent(transform, false);
            _meshFilter = _meshObject.AddComponent<MeshFilter>();
            _meshRenderer = _meshObject.AddComponent<MeshRenderer>();
            _mesh = new Mesh();
            _mesh.name = "FCA Edge Filaments";
            _mesh.MarkDynamic();
            _mesh.indexFormat = IndexFormat.UInt32;
            _meshFilter.sharedMesh = _mesh;
            _meshRenderer.shadowCastingMode = ShadowCastingMode.Off;
            _meshRenderer.receiveShadows = false;
            _meshRenderer.lightProbeUsage = LightProbeUsage.Off;
            _meshRenderer.reflectionProbeUsage = ReflectionProbeUsage.Off;
            _meshRenderer.motionVectorGenerationMode = MotionVectorGenerationMode.ForceNoMotion;
            _meshRenderer.enabled = false;
        }

        void CreateMaterial()
        {
            Material baseMaterial = Resources.Load<Material>("Nebula/EdgeFilament");
            Shader shader = (baseMaterial != null && baseMaterial.shader != null) ? baseMaterial.shader : Shader.Find("FCA/EdgeFilament");
            if (shader != null)
            {
                _material = new Material(shader);
                _material.name = "FCA EdgeFilament (Runtime)";
            }
            if (_material == null)
            {
                Debug.LogError("[FCA] Shader 'FCA/EdgeFilament' not found. Relation filaments will not be rendered.");
            }
            if (_meshRenderer != null) _meshRenderer.sharedMaterial = _material;
        }

        public void ApplyQuality(QualityProfile profile)
        {
            _profile = profile;
            if (_material != null)
            {
                // Task-14: ordinary relations are much dimmer than before; only highlighted
                // relation types (flow / confidence) pop.
                _material.SetFloat("_Intensity", 0.32f * Mathf.Clamp(profile.EdgeIntensity, 0.2f, 2f));
            }
        }

        public void SetGraph(LayoutModel layout, GraphModel graph)
        {
            _layout = layout;
            _graph = graph;
            Rebuild();
        }

        /// <summary>Parent -> child sub-agent filaments (expanded hierarchy).</summary>
        public void SetHierarchyLinks(List<HierarchyLink> links)
        {
            _hierarchyLinks.Clear();
            if (links != null)
            {
                for (int i = 0; i < links.Count; i++)
                {
                    if (links[i] != null) _hierarchyLinks.Add(links[i]);
                }
            }
            Rebuild();
        }

        public void Rebuild()
        {
            if (!_initialized || _mesh == null) return;
            _mesh.Clear();
            EdgeCount = 0;
            CrossArmEdgeCount = 0;
            HierarchyLinkCount = 0;
            if (_layout == null)
            {
                if (_meshRenderer != null) _meshRenderer.enabled = false;
                return;
            }

            List<Vector3> vertices = new List<Vector3>(4096);
            List<Color> colors = new List<Color>(2048);
            List<Vector2> uvs = new List<Vector2>(2048);
            List<Vector2> uvs2 = new List<Vector2>(2048);
            List<int> triangles = new List<int>(8192);
            List<Vector3> path = new List<Vector3>(32);

            if (_graph != null)
            {
                for (int e = 0; e < _graph.Edges.Count; e++)
                {
                    GraphEdge edge = _graph.Edges[e];
                    LayoutNode from;
                    LayoutNode to;
                    if (!_layout.ById.TryGetValue(edge.From, out from) || !_layout.ById.TryGetValue(edge.To, out to)) continue;
                    if (!IsRenderable(from) || !IsRenderable(to)) continue;
                    RelationStyle style = ThemePalette.Relation(edge.RelationType);
                    Color styleColor = ThemePalette.ToShader(style.Color);
                    float opacity = Mathf.Clamp(0.20f + 0.30f * edge.Confidence + 0.10f * Mathf.Clamp01(edge.Weight * 0.5f), 0.12f, 0.55f);
                    float width = Mathf.Max(0.6f, style.Width * 1.7f) * (0.85f + 0.2f * Mathf.Clamp01(edge.Weight * 0.5f));

                    path.Clear();
                    bool crossArm = from.ArmIndex != to.ArmIndex;
                    if (!crossArm && from.ArmIndex >= 0 && from.ArmIndex < _layout.Arms.Count)
                    {
                        BuildSameArmPath(_layout.Arms[from.ArmIndex], from, to, path);
                    }
                    else
                    {
                        BuildCrossArmPath(from, to, path);
                        styleColor = Color.Lerp(styleColor, ThemePalette.ToShader(ThemePalette.CrossArmColorSrgb()), 0.55f);
                        opacity *= 0.30f;      // cross-arm links must not dominate the image
                        width *= 0.75f;
                        CrossArmEdgeCount++;
                    }
                    AddRibbonPath(vertices, colors, uvs, uvs2, triangles, path, styleColor, opacity, width, style);
                    EdgeCount++;
                }
            }

            // Hierarchy filaments (dashed gold, drawn on top of ordinary relations).
            if (_layout != null && _hierarchyLinks.Count > 0)
            {
                RelationStyle linkStyle = ThemePalette.Relation("custom");
                linkStyle.Dash = 0.85f;
                linkStyle.Flow = 0.45f;
                linkStyle.Width = 0.9f;
                Color gold = ThemePalette.ToShader(ThemePalette.HierarchyGoldSrgb());
                for (int i = 0; i < _hierarchyLinks.Count; i++)
                {
                    HierarchyLink link = _hierarchyLinks[i];
                    LayoutNode parent;
                    LayoutNode child;
                    if (!_layout.ById.TryGetValue(link.ParentId, out parent) || !_layout.ById.TryGetValue(link.ChildId, out child)) continue;
                    if (!IsRenderable(parent) || !IsRenderable(child)) continue;
                    BuildHierarchyPath(parent, child, path);
                    AddRibbonPath(vertices, colors, uvs, uvs2, triangles, path, gold, 0.75f, 1.9f, linkStyle);
                    HierarchyLinkCount++;
                }
            }

            if (vertices.Count == 0)
            {
                if (_meshRenderer != null) _meshRenderer.enabled = false;
                return;
            }
            _mesh.SetVertices(vertices);
            _mesh.SetColors(colors);
            _mesh.SetUVs(0, uvs);
            _mesh.SetUVs(1, uvs2);
            _mesh.SetTriangles(triangles, 0);
            _mesh.RecalculateBounds();
            _mesh.bounds = new Bounds(Vector3.zero, Vector3.one * 100000f);
            if (_meshRenderer != null) _meshRenderer.enabled = true;
        }

        static bool IsRenderable(LayoutNode node)
        {
            return node != null && node.IsVisible && node.VisualVisibility > 0.15f;
        }

        // -------------------------------------------------------------
        // Path builders (spiral geometry, shared with the volume shader)
        // -------------------------------------------------------------

        void BuildSameArmPath(LayoutArm arm, LayoutNode from, LayoutNode to, List<Vector3> path)
        {
            float relA = arm.SpanRadians * Mathf.Clamp01(from.AlongArm);
            float relB = arm.SpanRadians * Mathf.Clamp01(to.AlongArm);
            float zA = from.Position.z;
            float zB = to.Position.z;
            int segments = Mathf.Clamp(Mathf.CeilToInt(Mathf.Abs(relB - relA) / 0.16f) + 2, 6, 28);
            path.Add(from.Position);
            for (int i = 1; i < segments; i++)
            {
                float t = (float)i / segments;
                float rel = Mathf.Lerp(relA, relB, t);
                Vector3 centre = WorkspaceSpiralLayout.ArmPoint(arm, _layout, rel);
                centre.z = Mathf.Lerp(zA, zB, t) * 0.55f;
                path.Add(centre);
            }
            path.Add(to.Position);
        }

        void BuildCrossArmPath(LayoutNode from, LayoutNode to, List<Vector3> path)
        {
            LayoutArm armA = _layout.Arms[Mathf.Clamp(from.ArmIndex, 0, _layout.Arms.Count - 1)];
            LayoutArm armB = _layout.Arms[Mathf.Clamp(to.ArmIndex, 0, _layout.Arms.Count - 1)];
            float relA = armA.SpanRadians * Mathf.Clamp01(from.AlongArm);
            float relB = armB.SpanRadians * Mathf.Clamp01(to.AlongArm);

            List<Vector3> controls = new List<Vector3>(12);
            controls.Add(from.Position);
            Vector3 aMid = WorkspaceSpiralLayout.ArmPoint(armA, _layout, relA * 0.55f);
            controls.Add(new Vector3(aMid.x, aMid.y, from.Position.z * 0.5f));
            Vector3 aBase = WorkspaceSpiralLayout.ArmPoint(armA, _layout, armA.SpanRadians * 0.10f);
            controls.Add(new Vector3(aBase.x, aBase.y, 0f));

            // Arc around the core: shorter angular direction between the two arm base angles.
            float angleA = armA.BaseAngleRad + _layout.Hand * armA.SpanRadians * 0.10f;
            float angleB = armB.BaseAngleRad + _layout.Hand * armB.SpanRadians * 0.10f;
            float delta = Mathf.DeltaAngle(angleA * Mathf.Rad2Deg, angleB * Mathf.Rad2Deg) * Mathf.Deg2Rad;
            float arcRadius = Mathf.Max(WorkspaceSpiralLayout.ArmRadiusAt(armA.InnerRadius, armA.PitchB, armA.SpanRadians * 0.10f), _layout.MaxRadius * 0.10f);
            const int arcSteps = 8;
            for (int i = 1; i <= arcSteps; i++)
            {
                float a = angleA + delta * ((float)i / (arcSteps + 1));
                float z = Mathf.Sin((float)i / (arcSteps + 1) * Mathf.PI) * 2.5f;
                controls.Add(new Vector3(Mathf.Cos(a) * arcRadius, Mathf.Sin(a) * arcRadius, z));
            }

            Vector3 bBase = WorkspaceSpiralLayout.ArmPoint(armB, _layout, armB.SpanRadians * 0.10f);
            controls.Add(new Vector3(bBase.x, bBase.y, 0f));
            Vector3 bMid = WorkspaceSpiralLayout.ArmPoint(armB, _layout, relB * 0.55f);
            controls.Add(new Vector3(bMid.x, bMid.y, to.Position.z * 0.5f));
            controls.Add(to.Position);

            SmoothPath(controls, 26, path);
        }

        void BuildHierarchyPath(LayoutNode parent, LayoutNode child, List<Vector3> path)
        {
            Vector3 a = parent.Position;
            Vector3 b = child.Position;
            Vector3 delta = b - a;
            Vector3 side = Vector3.Cross(delta.normalized, Vector3.forward);
            if (side.sqrMagnitude < 0.0001f) side = Vector3.right;
            side.Normalize();
            Vector3 mid = (a + b) * 0.5f + side * Mathf.Min(18f, delta.magnitude * 0.22f) + Vector3.forward * 6f;
            List<Vector3> controls = new List<Vector3>(3);
            controls.Add(a);
            controls.Add(mid);
            controls.Add(b);
            SmoothPath(controls, 14, path);
        }

        static void SmoothPath(List<Vector3> controls, int samples, List<Vector3> outPath)
        {
            outPath.Clear();
            if (controls.Count == 0) return;
            if (controls.Count == 1) { outPath.Add(controls[0]); return; }
            if (controls.Count == 2)
            {
                for (int i = 0; i <= samples; i++)
                {
                    outPath.Add(Vector3.Lerp(controls[0], controls[1], (float)i / samples));
                }
                return;
            }
            // Catmull-Rom through the control points
            for (int i = 0; i <= samples; i++)
            {
                float globalT = (float)i / samples * (controls.Count - 1);
                int seg = Mathf.Clamp(Mathf.FloorToInt(globalT), 0, controls.Count - 2);
                float t = globalT - seg;
                Vector3 p0 = controls[Mathf.Max(0, seg - 1)];
                Vector3 p1 = controls[seg];
                Vector3 p2 = controls[Mathf.Min(controls.Count - 1, seg + 1)];
                Vector3 p3 = controls[Mathf.Min(controls.Count - 1, seg + 2)];
                outPath.Add(CatmullRom(p0, p1, p2, p3, t));
            }
        }

        static Vector3 CatmullRom(Vector3 p0, Vector3 p1, Vector3 p2, Vector3 p3, float t)
        {
            float t2 = t * t;
            float t3 = t2 * t;
            return 0.5f * ((2f * p1) + (-p0 + p2) * t + (2f * p0 - 5f * p1 + 4f * p2 - p3) * t2 + (-p0 + 3f * p1 - 3f * p2 + p3) * t3);
        }

        // -------------------------------------------------------------
        // Ribbon meshing
        // -------------------------------------------------------------

        void AddRibbonPath(List<Vector3> vertices, List<Color> colors, List<Vector2> uvs, List<Vector2> uvs2,
            List<int> triangles, List<Vector3> path, Color color, float opacity, float width, RelationStyle style)
        {
            if (path == null || path.Count < 2) return;
            AddRibbonStrip(vertices, colors, uvs, uvs2, triangles, path, Vector3.forward, color, opacity, width, style);
            AddRibbonStrip(vertices, colors, uvs, uvs2, triangles, path, Vector3.up, color, opacity * 0.55f, width * 0.8f, style);
        }

        void AddRibbonStrip(List<Vector3> vertices, List<Color> colors, List<Vector2> uvs, List<Vector2> uvs2,
            List<int> triangles, List<Vector3> path, Vector3 sideRef, Color color, float opacity, float width, RelationStyle style)
        {
            int baseIndex = vertices.Count;
            int count = path.Count;
            float totalLength = 0f;
            for (int i = 1; i < count; i++) totalLength += Vector3.Distance(path[i - 1], path[i]);
            if (totalLength < 0.5f) return;

            for (int i = 0; i < count; i++)
            {
                Vector3 tangent;
                if (i == 0) tangent = path[1] - path[0];
                else if (i == count - 1) tangent = path[count - 1] - path[count - 2];
                else tangent = path[i + 1] - path[i - 1];
                if (tangent.sqrMagnitude < 0.000001f) tangent = Vector3.right;
                tangent.Normalize();
                Vector3 across = Vector3.Cross(tangent, sideRef);
                if (across.sqrMagnitude < 0.0001f) across = Vector3.Cross(tangent, Vector3.right);
                if (across.sqrMagnitude < 0.0001f) across = Vector3.up;
                across.Normalize();

                float t = count <= 1 ? 0f : (float)i / (count - 1);
                float taper = Mathf.Sin(Mathf.Clamp01(t) * Mathf.PI) * 0.65f + 0.35f;
                float endFade = Mathf.SmoothStep(0f, 1f, Mathf.Clamp01(t * 8f)) * Mathf.SmoothStep(0f, 1f, Mathf.Clamp01((1f - t) * 8f));
                float alpha = opacity * endFade;
                Vector3 a = path[i] - across * width * 0.5f * taper;
                Vector3 b = path[i] + across * width * 0.5f * taper;
                vertices.Add(a);
                vertices.Add(b);
                colors.Add(new Color(color.r, color.g, color.b, alpha));
                colors.Add(new Color(color.r, color.g, color.b, alpha));
                uvs.Add(new Vector2(t, 0f));
                uvs.Add(new Vector2(t, 1f));
                uvs2.Add(new Vector2(style.Dash, style.Flow));
                uvs2.Add(new Vector2(style.Dash, style.Flow));
            }
            for (int i = 0; i < count - 1; i++)
            {
                int i0 = baseIndex + i * 2;
                int i1 = i0 + 1;
                int i2 = i0 + 2;
                int i3 = i0 + 3;
                triangles.Add(i0); triangles.Add(i2); triangles.Add(i1);
                triangles.Add(i1); triangles.Add(i2); triangles.Add(i3);
            }
        }

        void OnDestroy()
        {
            if (_meshObject != null) Destroy(_meshObject);
            if (_mesh != null) Destroy(_mesh);
            if (_material != null) Destroy(_material);
        }
    }
}
