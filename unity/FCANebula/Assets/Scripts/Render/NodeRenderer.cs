// FCA Memory Atlas — Unity Nebula Renderer (Built-in Render Pipeline)
// NodeRenderer: all nodes are batched into ONE dynamic billboard mesh per frame (4 vertices
// per node). Per-node size follows importance/display_weight/degree, brightness follows the
// same mapping, and colour mixes the memory type hue with the workspace arm hue.
// Selection/hover state and twinkle phase are baked into vertex streams (TEXCOORD1), so the
// whole layer is a single additive draw call — no per-node GameObjects, no MPB instancing.

using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

namespace FCANebula
{
    public sealed class NodeRenderer : MonoBehaviour
    {
        Camera _camera;
        AppConfig _config;
        QualityProfile _profile;
        LayoutModel _layout;
        bool _initialized;

        GameObject _meshObject;
        MeshFilter _meshFilter;
        MeshRenderer _meshRenderer;
        Mesh _mesh;
        Material _material;

        // Scratch buffers (rebuilt every frame; camera rotation changes the billboard basis).
        readonly List<Vector3> _vertexList = new List<Vector3>(4096);
        readonly List<Color> _colorList = new List<Color>(4096);
        readonly List<Vector2> _uvList = new List<Vector2>(4096);
        readonly List<Vector2> _extraList = new List<Vector2>(4096);
        int[] _triangles;
        int _vertexCount;

        public LayoutNode HoveredNode { get; private set; }
        public LayoutNode SelectedNode { get; private set; }
        public int RenderNodeCount { get { return _layout != null ? _layout.NodeCount : 0; } }
        public event Action<LayoutNode> SelectionChanged;

        public void Initialize(AppConfig config, Camera camera)
        {
            if (_initialized)
            {
                return;
            }
            _config = config;
            _camera = camera != null ? camera : Camera.main;
            _profile = config != null ? config.Profile : QualityProfile.For(QualityTier.High);
            CreateObject();
            CreateMaterial();
            _initialized = true;
        }

        void CreateObject()
        {
            _meshObject = new GameObject("FCA Node Starfield");
            _meshObject.hideFlags = HideFlags.DontSave;
            _meshObject.transform.SetParent(transform, false);
            _meshFilter = _meshObject.AddComponent<MeshFilter>();
            _meshRenderer = _meshObject.AddComponent<MeshRenderer>();
            _mesh = new Mesh();
            _mesh.name = "FCA Node Starfield";
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
            Material baseMaterial = Resources.Load<Material>("Nebula/NodeStar");
            Shader shader = (baseMaterial != null && baseMaterial.shader != null) ? baseMaterial.shader : Shader.Find("FCA/NodeStar");
            if (shader != null)
            {
                _material = new Material(shader);
                _material.name = "FCA NodeStar (Runtime)";
                _material.SetFloat("_Intensity", 1.0f);
            }
            if (_material == null)
            {
                Debug.LogError("[FCA] Shader 'FCA/NodeStar' not found. Nodes will not be rendered.");
            }
            if (_meshRenderer != null)
            {
                _meshRenderer.sharedMaterial = _material;
            }
        }

        public void SetNodes(LayoutModel layout)
        {
            _layout = layout;
            if (SelectedNode != null)
            {
                LayoutNode remapped = null;
                if (layout != null && layout.ById.TryGetValue(SelectedNode.Id, out remapped))
                {
                    SelectedNode = remapped;
                }
                else
                {
                    SelectedNode = null;
                    SelectionChanged?.Invoke(null);
                }
            }
            HoveredNode = null;
        }

        public void ApplyQuality(QualityProfile profile)
        {
            _profile = profile;
        }

        void LateUpdate()
        {
            if (!_initialized || _camera == null || _material == null || _layout == null || _layout.NodeCount == 0)
            {
                if (_meshRenderer != null)
                {
                    _meshRenderer.enabled = false;
                }
                return;
            }
            BuildMesh();
        }

        void BuildMesh()
        {
            int count = _layout.NodeCount;
            _vertexList.Clear();
            _colorList.Clear();
            _uvList.Clear();
            _extraList.Clear();

            Quaternion billboard = _camera.transform.rotation;
            Vector3 cameraPosition = _camera.transform.position;
            Vector3 cameraRight = billboard * Vector3.right;
            Vector3 cameraUp = billboard * Vector3.up;
            float minWorldSizeFactor = 0f;
            if (Screen.height > 0)
            {
                minWorldSizeFactor = Mathf.Tan(_camera.fieldOfView * 0.5f * Mathf.Deg2Rad) * 2f * (6.5f / Screen.height);
            }
            float nodeScale = _profile.NodeScale;

            Vector3 bufferMin = new Vector3(float.MaxValue, float.MaxValue, float.MaxValue);
            Vector3 bufferMax = new Vector3(float.MinValue, float.MinValue, float.MinValue);

            for (int i = 0; i < count; i++)
            {
                LayoutNode node = _layout.Nodes[i];
                float distance = Vector3.Distance(cameraPosition, node.Position);
                float worldSize = node.Size * nodeScale;
                if (minWorldSizeFactor > 0f)
                {
                    worldSize = Mathf.Max(worldSize, distance * minWorldSizeFactor);
                }
                float half = worldSize * 0.5f;
                Vector3 center = node.Position;
                Vector3 right = cameraRight * half;
                Vector3 up = cameraUp * half;

                bool isSelected = SelectedNode != null && ReferenceEquals(SelectedNode, node);
                bool isHovered = HoveredNode != null && ReferenceEquals(HoveredNode, node);
                float brightness = (0.90f + 1.5f * node.Brightness) * (isSelected ? 1.25f : 1f);
                Color tint = ThemePalette.ToShader(node.TintSrgb);
                // Vertex colour alpha carries the deterministic twinkle phase.
                float phase = WorkspaceSpiralLayout.Hash01(node.Id, 0xA511E9B3u);
                Color vertexColor = new Color(tint.r * brightness, tint.g * brightness, tint.b * brightness, phase);
                Vector2 extra = new Vector2(isSelected ? 1f : 0f, isHovered ? 1f : 0f);

                _vertexList.Add(center - right - up);
                _vertexList.Add(center + right - up);
                _vertexList.Add(center + right + up);
                _vertexList.Add(center - right + up);
                _colorList.Add(vertexColor);
                _colorList.Add(vertexColor);
                _colorList.Add(vertexColor);
                _colorList.Add(vertexColor);
                _uvList.Add(new Vector2(0f, 0f));
                _uvList.Add(new Vector2(1f, 0f));
                _uvList.Add(new Vector2(1f, 1f));
                _uvList.Add(new Vector2(0f, 1f));
                _extraList.Add(extra);
                _extraList.Add(extra);
                _extraList.Add(extra);
                _extraList.Add(extra);

                bufferMin = Vector3.Min(bufferMin, center - right - up);
                bufferMax = Vector3.Max(bufferMax, center + right + up);
            }

            _vertexCount = _vertexList.Count;
            _mesh.Clear();
            _mesh.SetVertices(_vertexList);
            _mesh.SetColors(_colorList);
            _mesh.SetUVs(0, _uvList);
            _mesh.SetUVs(1, _extraList);

            int quadCount = _vertexCount / 4;
            if (_triangles == null || _triangles.Length != quadCount * 6)
            {
                _triangles = new int[quadCount * 6];
            }
            for (int q = 0; q < quadCount; q++)
            {
                int v = q * 4;
                int t = q * 6;
                _triangles[t] = v;
                _triangles[t + 1] = v + 2;
                _triangles[t + 2] = v + 1;
                _triangles[t + 3] = v;
                _triangles[t + 4] = v + 3;
                _triangles[t + 5] = v + 2;
            }
            _mesh.SetTriangles(_triangles, 0, false);
            _mesh.bounds = new Bounds((bufferMin + bufferMax) * 0.5f, (bufferMax - bufferMin) + Vector3.one * 10f);
            if (_meshRenderer != null)
            {
                _meshRenderer.enabled = true;
            }
        }

        /// <summary>Screen-space picking (mouse) for hover / click-through selection.</summary>
        public LayoutNode Pick(Vector2 screenPosition)
        {
            if (!_initialized || _camera == null || _layout == null)
            {
                return null;
            }
            LayoutNode best = null;
            float bestDistance = float.MaxValue;
            for (int i = 0; i < _layout.Nodes.Count; i++)
            {
                LayoutNode node = _layout.Nodes[i];
                Vector3 projected = _camera.WorldToScreenPoint(node.Position);
                if (projected.z <= 0f)
                {
                    continue;
                }
                Vector2 delta = new Vector2(projected.x, projected.y) - screenPosition;
                float distance = delta.magnitude;
                float worldDistance = Vector3.Distance(_camera.transform.position, node.Position);
                float pixels = node.Size * Screen.height / Mathf.Max(1f, 2f * worldDistance * Mathf.Tan(_camera.fieldOfView * 0.5f * Mathf.Deg2Rad));
                float radius = Mathf.Max(10f, pixels * 0.95f);
                if (distance <= radius && distance < bestDistance)
                {
                    bestDistance = distance;
                    best = node;
                }
            }
            return best;
        }

        public void SetHovered(LayoutNode node)
        {
            HoveredNode = node;
        }

        public void Select(LayoutNode node, bool focusCamera)
        {
            if (node != null && _layout != null && !_layout.ById.ContainsKey(node.Id))
            {
                node = null;
            }
            bool changed = !ReferenceEquals(SelectedNode, node);
            SelectedNode = node;
            if (changed)
            {
                SelectionChanged?.Invoke(node);
            }
        }

        public void SelectById(string id)
        {
            LayoutNode node = null;
            if (!string.IsNullOrEmpty(id) && _layout != null)
            {
                _layout.ById.TryGetValue(id, out node);
            }
            Select(node, false);
        }

        public void ClearSelection()
        {
            Select(null, false);
        }

        public LayoutNode FindNode(string id)
        {
            LayoutNode node;
            if (_layout != null && !string.IsNullOrEmpty(id) && _layout.ById.TryGetValue(id, out node))
            {
                return node;
            }
            return null;
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
