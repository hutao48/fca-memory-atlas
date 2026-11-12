// FCA Memory Atlas — Unity 6 / URP Nebula Renderer
// NebulaFieldRenderer: renders the procedural volumetric nebula on a camera-attached
// fullscreen quad (Background queue). The custom bloom/tonemap OnRenderImage post chain is
// Built-in-only: it is disabled automatically when a Scriptable Render Pipeline (URP) is
// active — task-20 replaces it with URP Volume post-processing (Bloom/ACES/Color/Vignette).
//
// Why a quad and not OnRenderImage raymarch? A camera-child quad gives stable world-ray
// reconstruction on every graphics API (D3D/OpenGL) without RT flip gymnastics; the
// raymarch itself is identical. The quad covers the near plane and is drawn before any
// star/edge geometry, so it always sits visually behind the nodes.

using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

namespace FCANebula
{
    [RequireComponent(typeof(Camera))]
    public sealed class NebulaFieldRenderer : MonoBehaviour
    {
        public float Exposure = 1.2f;
        public float BloomIntensity = 0.46f;
        public float Vignette = 0.85f;
        public float Grain = 0.012f;
        public bool BloomEnabled = true;

        const int MaxShaderArms = ThemePalette.MaxShaderArms;

        Camera _camera;
        AppConfig _config;
        QualityProfile _profile;
        LayoutModel _layout;
        bool _initialized;

        GameObject _quadObject;
        Mesh _quadMesh;
        MeshRenderer _quadRenderer;
        Material _volumeMaterial;
        Material _postMaterial;

        readonly Vector4[] _armColors = new Vector4[MaxShaderArms];
        readonly Vector4[] _armParams = new Vector4[MaxShaderArms];
        readonly Vector4[] _armShape = new Vector4[MaxShaderArms];
        readonly Vector3[] _quadVertices = new Vector3[4];

        public QualityProfile Profile { get { return _profile; } }
        public Material VolumeMaterial { get { return _volumeMaterial; } }
        public bool IsInitialized { get { return _initialized; } }

        public void Initialize(AppConfig config, Camera camera)
        {
            if (_initialized)
            {
                return;
            }
            _config = config;
            _camera = camera != null ? camera : GetComponent<Camera>();
            _profile = config != null ? config.Profile : QualityProfile.For(QualityTier.High);

            CreateMaterials();
            CreateQuad();

            _initialized = true;
            ApplyQuality(_profile);
            if (_layout != null)
            {
                ApplyLayout(_layout);
            }
        }

        void CreateMaterials()
        {
            Material volumeBase = Resources.Load<Material>("Nebula/NebulaVolume");
            if (volumeBase != null && volumeBase.shader != null)
            {
                _volumeMaterial = new Material(volumeBase.shader);
            }
            else
            {
                Shader volumeShader = Shader.Find("FCA/NebulaVolume");
                if (volumeShader != null)
                {
                    _volumeMaterial = new Material(volumeShader);
                }
            }
            if (_volumeMaterial != null)
            {
                _volumeMaterial.name = "FCA NebulaVolume (Runtime)";
                // Background queue: drawn right after camera clear, before stars/edges.
                _volumeMaterial.renderQueue = (int)RenderQueue.Background;
            }
            else
            {
                Debug.LogError("[FCA] Shader 'FCA/NebulaVolume' not found. Nebula volume will be missing. " +
                               "Ensure Assets/Resources/Nebula/NebulaVolume.mat exists (run ProjectBootstrap).");
            }

            Material postBase = Resources.Load<Material>("Nebula/NebulaPost");
            if (postBase != null && postBase.shader != null)
            {
                _postMaterial = new Material(postBase.shader);
            }
            else
            {
                Shader postShader = Shader.Find("FCA/NebulaPost");
                if (postShader != null)
                {
                    _postMaterial = new Material(postShader);
                }
            }
            if (_postMaterial != null)
            {
                _postMaterial.name = "FCA NebulaPost (Runtime)";
            }
            else
            {
                Debug.LogError("[FCA] Shader 'FCA/NebulaPost' not found. Post-processing disabled.");
            }
        }

        void CreateQuad()
        {
            if (_camera == null || _volumeMaterial == null)
            {
                return;
            }
            _quadObject = new GameObject("FCA Nebula Volume Quad");
            _quadObject.hideFlags = HideFlags.DontSave;
            _quadObject.transform.SetParent(_camera.transform, false);
            _quadObject.layer = 0;

            MeshFilter filter = _quadObject.AddComponent<MeshFilter>();
            _quadMesh = new Mesh();
            _quadMesh.name = "FCA Fullscreen Nebula Quad";
            _quadMesh.MarkDynamic();
            _quadMesh.vertices = new Vector3[4];
            _quadMesh.uv = new Vector2[]
            {
                new Vector2(0f, 0f),
                new Vector2(1f, 0f),
                new Vector2(1f, 1f),
                new Vector2(0f, 1f)
            };
            _quadMesh.triangles = new int[] { 0, 1, 2, 0, 2, 3 };
            _quadMesh.bounds = new Bounds(Vector3.zero, Vector3.one * 100000f);
            filter.sharedMesh = _quadMesh;

            _quadRenderer = _quadObject.AddComponent<MeshRenderer>();
            _quadRenderer.sharedMaterial = _volumeMaterial;
            _quadRenderer.shadowCastingMode = ShadowCastingMode.Off;
            _quadRenderer.receiveShadows = false;
            _quadRenderer.lightProbeUsage = LightProbeUsage.Off;
            _quadRenderer.reflectionProbeUsage = ReflectionProbeUsage.Off;
            _quadRenderer.motionVectorGenerationMode = MotionVectorGenerationMode.ForceNoMotion;

            UpdateQuadGeometry();
        }

        void UpdateQuadGeometry()
        {
            if (_quadMesh == null || _camera == null)
            {
                return;
            }
            float z = Mathf.Max(0.05f, _camera.nearClipPlane * 1.1f);
            float halfHeight = Mathf.Tan(_camera.fieldOfView * 0.5f * Mathf.Deg2Rad) * z;
            float halfWidth = halfHeight * Mathf.Max(0.25f, _camera.aspect);
            _quadVertices[0] = new Vector3(-halfWidth, -halfHeight, z);
            _quadVertices[1] = new Vector3(halfWidth, -halfHeight, z);
            _quadVertices[2] = new Vector3(halfWidth, halfHeight, z);
            _quadVertices[3] = new Vector3(-halfWidth, halfHeight, z);
            _quadMesh.vertices = _quadVertices;
            _quadMesh.bounds = new Bounds(Vector3.zero, Vector3.one * 100000f);
        }

        public void ApplyLayout(LayoutModel layout)
        {
            _layout = layout;
            if (_volumeMaterial == null)
            {
                return;
            }
            float radius = layout != null ? Mathf.Max(220f, layout.MaxRadius) : 520f;
            int armCount = layout != null ? Mathf.Min(layout.Arms.Count, MaxShaderArms) : 0;
            float volumeRadius = radius * 1.22f + 70f;

            for (int i = 0; i < MaxShaderArms; i++)
            {
                if (layout != null && i < armCount)
                {
                    LayoutArm arm = layout.Arms[i];
                    Color c = ThemePalette.ToShader(arm.ColorSrgb);
                    _armColors[i] = new Vector4(c.r, c.g, c.b, 1f);
                    _armParams[i] = new Vector4(arm.BaseAngleRad, arm.InnerRadius, arm.PitchB, arm.SpanRadians);
                    float phase = WorkspaceSpiralLayout.Hash01(arm.Label, 0x51ED270Bu);
                    _armShape[i] = new Vector4(arm.RadialWidth, arm.VerticalSigma, arm.Intensity, phase);
                }
                else
                {
                    _armColors[i] = Vector4.zero;
                    _armParams[i] = new Vector4(0f, 1f, 0.4f, 0f);
                    _armShape[i] = Vector4.zero;
                }
            }
            _volumeMaterial.SetVectorArray("_ArmColors", _armColors);
            _volumeMaterial.SetVectorArray("_ArmParams", _armParams);
            _volumeMaterial.SetVectorArray("_ArmShape", _armShape);
            _volumeMaterial.SetFloat("_ArmCount", armCount);
            _volumeMaterial.SetFloat("_SpiralHand", layout != null ? layout.Hand : 1f);
            _volumeMaterial.SetFloat("_VolumeRadius", volumeRadius);
            _volumeMaterial.SetFloat("_NoiseScale", 3.2f / volumeRadius);
            _volumeMaterial.SetFloat("_NoiseScale2", 8.8f / volumeRadius);
            _volumeMaterial.SetFloat("_CoreRadius", Mathf.Max(30f, radius * 0.075f));
            _volumeMaterial.SetFloat("_CoreGlow", 0.55f);
            _volumeMaterial.SetFloat("_Absorption", 1.9f);
            _volumeMaterial.SetFloat("_HaloStrength", 0.55f);
            _volumeMaterial.SetColor("_CoreColor", ThemePalette.ToShader(ThemePalette.CoreColor));
            _volumeMaterial.SetColor("_SpaceColor", ThemePalette.ToShader(ThemePalette.SpaceColor));
            _volumeMaterial.SetColor("_SkyTint", ThemePalette.ToShader(ThemePalette.SkyTint));

            if (armCount < (layout != null ? layout.Arms.Count : 0))
            {
                Debug.LogWarning("[FCA] " + layout.Arms.Count + " workspace arms but the volume shader supports " +
                                 MaxShaderArms + "; nebula volume renders the first " + MaxShaderArms +
                                 " arms (nodes still follow their own arms).");
            }
        }

        public void ApplyQuality(QualityProfile profile)
        {
            _profile = profile;
            if (_volumeMaterial != null)
            {
                _volumeMaterial.SetInt("_Steps", profile.MarchSteps);
                _volumeMaterial.SetInt("_Octaves", profile.NoiseOctaves);
                _volumeMaterial.SetFloat("_VolumeEnabled", 1f);
                _volumeMaterial.SetFloat("_EmissionScale", profile.VolumeIntensity * 0.30f);
                _volumeMaterial.SetFloat("_DustStrength", 1.15f * Mathf.Lerp(0.7f, 1.15f, Mathf.InverseLerp(0f, 1.3f, profile.VolumeIntensity)));
                _volumeMaterial.SetFloat("_StarDensity", 1f);
                _volumeMaterial.SetFloat("_BandIntensity", 0.55f);
            }
            BloomIntensity = 0.58f * Mathf.Lerp(0.65f, 1.1f, Mathf.InverseLerp(0f, 1.3f, profile.VolumeIntensity));
        }

        public void SetBloomEnabled(bool enabled)
        {
            BloomEnabled = enabled;
        }

        void OnPreCull()
        {
            if (_initialized && _camera != null)
            {
                UpdateQuadGeometry();
            }
        }

        void LateUpdate()
        {
            // SRP (URP) does not call OnPreCull, so keep the near-plane quad in sync here too.
            if (_initialized && _camera != null)
            {
                UpdateQuadGeometry();
            }
        }

        void OnRenderImage(RenderTexture source, RenderTexture destination)
        {
            // Task-20: URP handles post-processing via Volume; never run the Built-in-only
            // OnRenderImage chain when an SRP is active (otherwise it would be ignored anyway).
            if (GraphicsSettings.currentRenderPipeline != null)
            {
                Graphics.Blit(source, destination);
                return;
            }
            if (!_initialized || _postMaterial == null)
            {
                Graphics.Blit(source, destination);
                return;
            }

            UpdatePostUniforms();

            if (!BloomEnabled || _profile.BloomIterations <= 0)
            {
                _postMaterial.SetTexture("_BloomTex", Texture2D.blackTexture);
                Graphics.Blit(source, destination, _postMaterial, 3);
                return;
            }

            int width = Mathf.Max(2, source.width / 2);
            int height = Mathf.Max(2, source.height / 2);
            RenderTextureFormat format = RenderTextureFormat.DefaultHDR;
#if UNITY_WEBGL && !UNITY_EDITOR
            // WebGL2 does not guarantee half-float color attachments on every GPU/driver;
            // an LDR bloom chain is used instead so post-processing never fails to allocate.
            format = RenderTextureFormat.ARGB32;
#endif
            RenderTexture prefiltered = RenderTexture.GetTemporary(width, height, 0, format, RenderTextureReadWrite.Linear);
            RenderTexture pingA = RenderTexture.GetTemporary(width, height, 0, format, RenderTextureReadWrite.Linear);
            RenderTexture pingB = RenderTexture.GetTemporary(width, height, 0, format, RenderTextureReadWrite.Linear);

            Graphics.Blit(source, prefiltered, _postMaterial, 0);
            RenderTexture current = prefiltered;
            int iterations = Mathf.Clamp(_profile.BloomIterations, 1, 4);
            for (int i = 0; i < iterations; i++)
            {
                Graphics.Blit(current, pingA, _postMaterial, 1);
                Graphics.Blit(pingA, pingB, _postMaterial, 2);
                current = pingB;
            }
            _postMaterial.SetTexture("_BloomTex", current);
            Graphics.Blit(source, destination, _postMaterial, 3);

            RenderTexture.ReleaseTemporary(prefiltered);
            RenderTexture.ReleaseTemporary(pingA);
            RenderTexture.ReleaseTemporary(pingB);
        }

        void UpdatePostUniforms()
        {
            if (_postMaterial == null)
            {
                return;
            }
            _postMaterial.SetFloat("_Threshold", 0.55f);
            _postMaterial.SetFloat("_Knee", 0.32f);
            _postMaterial.SetFloat("_BloomIntensity", BloomIntensity);
            _postMaterial.SetFloat("_Exposure", Exposure);
            _postMaterial.SetFloat("_Vignette", Vignette);
            _postMaterial.SetFloat("_Grain", Grain);
        }

        void OnDestroy()
        {
            if (_quadObject != null)
            {
                Destroy(_quadObject);
            }
            if (_quadMesh != null)
            {
                Destroy(_quadMesh);
            }
            if (_volumeMaterial != null)
            {
                Destroy(_volumeMaterial);
            }
            if (_postMaterial != null)
            {
                Destroy(_postMaterial);
            }
        }
    }
}
