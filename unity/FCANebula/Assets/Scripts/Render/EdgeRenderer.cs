// FCA Memory Atlas — Unity Nebula Renderer (Built-in Render Pipeline)
// EdgeRenderer: relation light-filaments built as one dynamic ribbon mesh. Each edge becomes
// a curved ribbon (quadratic bezier, double-sided by crossing two quads) with additive
// blending, a travelling pulse and relation_type driven colour/dash/flow.

using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

namespace FCANebula
{
    public sealed class EdgeRenderer : MonoBehaviour
    {
        AppConfig _config;
        QualityProfile _profile;
        LayoutModel _layout;
        bool _initialized;

        GameObject _meshObject;
        MeshFilter _meshFilter;
        MeshRenderer _meshRenderer;
        Mesh _mesh;
        Material _material;

        public int EdgeCount { get; private set; }

        public void Initialize(AppConfig config, Camera camera)
        {
            if (_initialized)
            {
                return;
            }
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
            if (_meshRenderer != null)
            {
                _meshRenderer.sharedMaterial = _material;
            }
        }

        public void ApplyQuality(QualityProfile profile)
        {
            _profile = profile;
            if (_material != null)
            {
                _material.SetFloat("_Intensity", 0.55f * Mathf.Clamp(profile.EdgeIntensity, 0.2f, 2f));
            }
        }

        public void SetGraph(LayoutModel layout, GraphModel graph)
        {
            _layout = layout;
            if (!_initialized || _mesh == null)
            {
                return;
            }
            _mesh.Clear();
            EdgeCount = 0;
            if (layout == null || graph == null || graph.Edges.Count == 0)
            {
                if (_meshRenderer != null)
                {
                    _meshRenderer.enabled = false;
                }
                return;
            }

            List<Vector3> vertices = new List<Vector3>(graph.Edges.Count * 48);
            List<Color> colors = new List<Color>(graph.Edges.Count * 24);
            List<Vector2> uvs = new List<Vector2>(graph.Edges.Count * 24);
            List<Vector2> uvs2 = new List<Vector2>(graph.Edges.Count * 24);
            List<int> triangles = new List<int>(graph.Edges.Count * 72);

            float scale = Mathf.Clamp(layout.MaxRadius / 470f, 0.55f, 2.2f);

            for (int e = 0; e < graph.Edges.Count; e++)
            {
                GraphEdge edge = graph.Edges[e];
                LayoutNode from;
                LayoutNode to;
                if (!layout.ById.TryGetValue(edge.From, out from) || !layout.ById.TryGetValue(edge.To, out to))
                {
                    continue;
                }
                RelationStyle style = ThemePalette.Relation(edge.RelationType);
                Color color = ThemePalette.ToShader(style.Color);
                float opacity = Mathf.Clamp(0.34f + 0.42f * edge.Confidence + 0.18f * (0.5f * Mathf.Clamp01(edge.Weight * 0.5f)), 0.22f, 0.95f);
                float width = Mathf.Max(0.8f, style.Width * 2.4f * scale) * (0.8f + 0.25f * Mathf.Clamp01(edge.Weight * 0.5f));
                AddEdgeRibbon(vertices, colors, uvs, uvs2, triangles, from.Position, to.Position, color, opacity, width, style, e);
                EdgeCount++;
            }

            if (vertices.Count == 0)
            {
                if (_meshRenderer != null)
                {
                    _meshRenderer.enabled = false;
                }
                return;
            }
            _mesh.SetVertices(vertices);
            _mesh.SetColors(colors);
            _mesh.SetUVs(0, uvs);
            _mesh.SetUVs(1, uvs2);
            _mesh.SetTriangles(triangles, 0);
            _mesh.RecalculateBounds();
            _mesh.bounds = new Bounds(Vector3.zero, Vector3.one * 100000f);
            if (_meshRenderer != null)
            {
                _meshRenderer.enabled = true;
            }
        }

        void AddEdgeRibbon(List<Vector3> vertices, List<Color> colors, List<Vector2> uvs, List<Vector2> uvs2,
                           List<int> triangles, Vector3 start, Vector3 end, Color color, float opacity, float width,
                           RelationStyle style, int edgeSeed)
        {
            Vector3 delta = end - start;
            float length = delta.magnitude;
            if (length < 0.5f)
            {
                return;
            }
            Vector3 direction = delta / length;
            Vector3 flat = new Vector3(-direction.y, direction.x, 0f);
            if (flat.sqrMagnitude < 0.0001f)
            {
                flat = new Vector3(1f, 0f, 0f);
            }
            flat.Normalize();
            float seed = WorkspaceSpiralLayout.Hash01("edge" + edgeSeed.ToString(), 0x7F4A7C15u);
            float bendSign = seed > 0.5f ? 1f : -1f;
            float bend = Mathf.Min(length * 0.32f, length * style.Curve * 3.2f + 8f) * bendSign;
            Vector3 control = (start + end) * 0.5f + flat * bend + new Vector3(0f, 0f, (seed - 0.5f) * 22f);

            // Two perpendicular ribbons per edge so filaments stay visible from any orbit angle.
            AddRibbonQuad(vertices, colors, uvs, uvs2, triangles, start, control, end, flat, color, opacity, width, style);
            Vector3 side2 = Vector3.Cross(direction, flat);
            if (side2.sqrMagnitude > 0.0001f)
            {
                AddRibbonQuad(vertices, colors, uvs, uvs2, triangles, start, control, end, side2.normalized, color, opacity * 0.55f, width * 0.8f, style);
            }
        }

        void AddRibbonQuad(List<Vector3> vertices, List<Color> colors, List<Vector2> uvs, List<Vector2> uvs2,
                           List<int> triangles, Vector3 start, Vector3 control, Vector3 end, Vector3 side,
                           Color color, float opacity, float width, RelationStyle style)
        {
            const int segments = 12;
            int baseIndex = vertices.Count;
            for (int i = 0; i <= segments; i++)
            {
                float t = (float)i / segments;
                float oneMinusT = 1f - t;
                Vector3 center = oneMinusT * oneMinusT * start + 2f * oneMinusT * t * control + t * t * end;
                Vector3 tangent = (2f * oneMinusT * (control - start) + 2f * t * (end - control)).normalized;
                Vector3 across = Vector3.Cross(tangent, side);
                if (across.sqrMagnitude < 0.0001f)
                {
                    across = side;
                }
                across = Vector3.Cross(tangent, across).normalized;
                float taper = Mathf.Sin(Mathf.Clamp01(t) * Mathf.PI) * 0.65f + 0.35f;
                float endFade = Mathf.SmoothStep(0f, 1f, Mathf.Clamp01(t * 6f)) * Mathf.SmoothStep(0f, 1f, Mathf.Clamp01((1f - t) * 6f));
                float alpha = opacity * endFade;
                Vector3 a = center - across * width * 0.5f * taper;
                Vector3 b = center + across * width * 0.5f * taper;
                vertices.Add(a);
                vertices.Add(b);
                colors.Add(new Color(color.r, color.g, color.b, alpha));
                colors.Add(new Color(color.r, color.g, color.b, alpha));
                uvs.Add(new Vector2(t, 0f));
                uvs.Add(new Vector2(t, 1f));
                uvs2.Add(new Vector2(style.Dash, style.Flow));
                uvs2.Add(new Vector2(style.Dash, style.Flow));
            }
            for (int i = 0; i < segments; i++)
            {
                int i0 = baseIndex + i * 2;
                int i1 = i0 + 1;
                int i2 = i0 + 2;
                int i3 = i0 + 3;
                triangles.Add(i0);
                triangles.Add(i2);
                triangles.Add(i1);
                triangles.Add(i1);
                triangles.Add(i2);
                triangles.Add(i3);
            }
        }

        void OnDestroy()
        {
            if (_meshObject != null)
            {
                Destroy(_meshObject);
            }
            if (_mesh != null)
            {
                Destroy(_mesh);
            }
            if (_material != null)
            {
                Destroy(_material);
            }
        }
    }
}
