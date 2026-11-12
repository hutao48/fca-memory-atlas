// FCA Memory Atlas — Unity 6 / URP setup (Editor only)
// Creates the URP pipeline asset + universal renderer + global volume profile and wires
// GraphicsSettings / QualitySettings. Also adds URP camera data and the global Volume to the
// generated scene, and disables the Built-in-only custom post path at runtime (see
// NebulaFieldRenderer). Task-20: Built-in RP -> Unity 6 URP WebGL.

using System;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace FCANebula.EditorTools
{
    public static class URPSetup
    {
        public const string SettingsFolder = "Assets/Settings";
        public const string RendererPath = "Assets/Settings/FCANebulaURPRenderer.asset";
        public const string PipelinePath = "Assets/Settings/FCANebulaURP.asset";
        public const string VolumeProfilePath = "Assets/Settings/FCANebulaGlobalVolume.asset";
        public const string PostProcessDataPath =
            "Packages/com.unity.render-pipelines.universal/Runtime/Data/PostProcessData.asset";

        /// <summary>Creates/updates URP assets and assigns them in GraphicsSettings + QualitySettings.</summary>
        public static UniversalRenderPipelineAsset ConfigureProject()
        {
            EnsureFolder();
            UniversalRendererData rendererData = AssetDatabase.LoadAssetAtPath<UniversalRendererData>(RendererPath);
            if (rendererData == null)
            {
                rendererData = ScriptableObject.CreateInstance<UniversalRendererData>();
                rendererData.postProcessData = AssetDatabase.LoadAssetAtPath<PostProcessData>(PostProcessDataPath);
                AssetDatabase.CreateAsset(rendererData, RendererPath);
                ResourceReloader.ReloadAllNullIn(rendererData, UniversalRenderPipelineAsset.packagePath);
            }
            else
            {
                if (rendererData.postProcessData == null)
                {
                    rendererData.postProcessData = AssetDatabase.LoadAssetAtPath<PostProcessData>(PostProcessDataPath);
                    ResourceReloader.ReloadAllNullIn(rendererData, UniversalRenderPipelineAsset.packagePath);
                }
            }

            UniversalRenderPipelineAsset pipeline = AssetDatabase.LoadAssetAtPath<UniversalRenderPipelineAsset>(PipelinePath);
            if (pipeline == null)
            {
                pipeline = UniversalRenderPipelineAsset.Create(rendererData);
                AssetDatabase.CreateAsset(pipeline, PipelinePath);
            }
            ConfigurePipeline(pipeline, rendererData);

            GraphicsSettings.defaultRenderPipeline = pipeline;
            QualitySettings.renderPipeline = pipeline;

            EnsureVolumeProfile();
            EditorUtility.SetDirty(pipeline);
            EditorUtility.SetDirty(rendererData);
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            Debug.Log("[FCA] URP configured: pipeline=" + pipeline.name +
                      " renderer=" + rendererData.name +
                      " hdr=" + pipeline.supportsHDR + " msaa=" + pipeline.msaaSampleCount +
                      " renderScale=" + pipeline.renderScale.ToString("0.00"));
            return pipeline;
        }

        static void ConfigurePipeline(UniversalRenderPipelineAsset pipeline, UniversalRendererData rendererData)
        {
            SerializedObject so = new SerializedObject(pipeline);
            SetBool(so, "m_SupportsHDR", true);
            SetInt(so, "m_MSAA", 4);
            SetFloat(so, "m_RenderScale", 1f);
            SerializedProperty list = so.FindProperty("m_RendererDataList");
            if (list != null)
            {
                if (list.arraySize < 1) list.arraySize = 1;
                list.GetArrayElementAtIndex(0).objectReferenceValue = rendererData;
            }
            SerializedProperty index = so.FindProperty("m_DefaultRendererIndex");
            if (index != null) index.intValue = 0;
            so.ApplyModifiedPropertiesWithoutUndo();
        }

        static void SetBool(SerializedObject so, string name, bool value)
        {
            SerializedProperty p = so.FindProperty(name);
            if (p != null && p.propertyType == SerializedPropertyType.Boolean) p.boolValue = value;
        }

        static void SetInt(SerializedObject so, string name, int value)
        {
            SerializedProperty p = so.FindProperty(name);
            if (p != null && (p.propertyType == SerializedPropertyType.Integer || p.propertyType == SerializedPropertyType.Enum)) p.intValue = value;
        }

        static void SetFloat(SerializedObject so, string name, float value)
        {
            SerializedProperty p = so.FindProperty(name);
            if (p != null && p.propertyType == SerializedPropertyType.Float) p.floatValue = value;
        }

        /// <summary>Global Volume profile: HDRP-like bloom / ACES tonemapping / color / vignette / grain.</summary>
        public static VolumeProfile EnsureVolumeProfile()
        {
            VolumeProfile profile = AssetDatabase.LoadAssetAtPath<VolumeProfile>(VolumeProfilePath);
            if (profile == null)
            {
                profile = ScriptableObject.CreateInstance<VolumeProfile>();
                AssetDatabase.CreateAsset(profile, VolumeProfilePath);
            }

            Bloom bloom = profile.TryGet<Bloom>(out Bloom existingBloom) ? existingBloom : profile.Add<Bloom>(true);
            bloom.active = true;
            bloom.intensity.Override(1.0f);
            bloom.threshold.Override(1.0f);
            bloom.scatter.Override(0.55f);
            bloom.highQualityFiltering.Override(false);

            Tonemapping tone = profile.TryGet<Tonemapping>(out Tonemapping existingTone) ? existingTone : profile.Add<Tonemapping>(true);
            tone.active = true;
            tone.mode.Override(TonemappingMode.ACES);

            ColorAdjustments colors = profile.TryGet<ColorAdjustments>(out ColorAdjustments existingColors) ? existingColors : profile.Add<ColorAdjustments>(true);
            colors.active = true;
            colors.postExposure.Override(0.15f);
            colors.contrast.Override(8f);
            colors.saturation.Override(6f);
            colors.colorFilter.Override(new Color(1f, 0.985f, 0.96f));

            Vignette vignette = profile.TryGet<Vignette>(out Vignette existingVignette) ? existingVignette : profile.Add<Vignette>(true);
            vignette.active = true;
            vignette.intensity.Override(0.20f);
            vignette.smoothness.Override(0.42f);
            vignette.rounded.Override(false);

            FilmGrain grain = profile.TryGet<FilmGrain>(out FilmGrain existingGrain) ? existingGrain : profile.Add<FilmGrain>(true);
            grain.active = true;
            grain.type.Override(FilmGrainLookup.Thin1);
            grain.intensity.Override(0.10f);
            grain.response.Override(0.8f);

            EditorUtility.SetDirty(profile);
            return profile;
        }

        /// <summary>Adds URP camera data to a camera (global volume + post-processing need it).</summary>
        public static UniversalAdditionalCameraData EnsureCameraData(Camera camera)
        {
            if (camera == null) return null;
            UniversalAdditionalCameraData data = camera.GetComponent<UniversalAdditionalCameraData>();
            if (data == null) data = camera.gameObject.AddComponent<UniversalAdditionalCameraData>();
            data.renderPostProcessing = true;
            data.antialiasing = AntialiasingMode.FastApproximateAntialiasing;
            data.renderShadows = false;
            EditorUtility.SetDirty(camera.gameObject);
            return data;
        }

        /// <summary>Creates (or reuses) the global Volume object in the current scene.</summary>
        public static Volume EnsureGlobalVolume()
        {
            Volume volume = UnityEngine.Object.FindObjectOfType<Volume>();
            if (volume == null)
            {
                GameObject volumeObject = new GameObject("Global Volume");
                volume = volumeObject.AddComponent<Volume>();
            }
            volume.isGlobal = true;
            volume.priority = 0f;
            volume.sharedProfile = EnsureVolumeProfile();
            EditorUtility.SetDirty(volume);
            return volume;
        }

        static void EnsureFolder()
        {
            if (!AssetDatabase.IsValidFolder(SettingsFolder))
            {
                AssetDatabase.CreateFolder("Assets", "Settings");
            }
        }
    }
}
