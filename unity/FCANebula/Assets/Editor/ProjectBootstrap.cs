// FCA Memory Atlas — Unity Nebula Renderer (Editor)
// ProjectBootstrap: one-click / batchmode scene bootstrap for the Built-in Render Pipeline.
//
// Batch usage (no URP packages required):
//   Unity.exe -batchmode -quit -projectPath unity/FCANebula \
//     -executeMethod FCANebula.EditorTools.ProjectBootstrap.BootstrapAll -logFile artifacts/unity/bootstrap.log
//
// Creates: Resources/Nebula materials for all four shaders, Assets/Scenes/FCANebula.unity
// (Main Camera + NebulaApp + all runtime components), build-settings entry and the
// PlayerSettings needed for the standalone nebula window.

using System;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace FCANebula.EditorTools
{
    public static class ProjectBootstrap
    {
        public const string ScenePath = "Assets/Scenes/FCANebula.unity";
        public const string ScenesFolder = "Assets/Scenes";
        public const string ResourcesFolder = "Assets/Resources/Nebula";

        [MenuItem("FCA/Bootstrap Nebula Scene (Built-in RP)")]
        public static void BootstrapMenu()
        {
            if (!EditorUtility.DisplayDialog("FCA Nebula",
                "生成/覆盖 Assets/Scenes/FCANebula.unity 场景、材质与 PlayerSettings？\n（不会修改 Runtime 数据）",
                "生成", "取消"))
            {
                return;
            }
            BootstrapAll();
            EditorUtility.DisplayDialog("FCA Nebula", "完成：场景已生成，按 Play 预览星云。", "OK");
        }

        /// <summary>Batchmode entry point. Idempotent.</summary>
        public static void BootstrapAll()
        {
            try
            {
                EnsureFolders();
                EnsureMaterials();
                ConfigurePlayerSettings();
                Scene scene = BuildScene();
                EditorSceneManager.MarkSceneDirty(scene);
                EditorSceneManager.SaveScene(scene, ScenePath);
                EditorBuildSettings.scenes = new EditorBuildSettingsScene[]
                {
                    new EditorBuildSettingsScene(ScenePath, true)
                };
                AssetDatabase.SaveAssets();
                AssetDatabase.Refresh();
                Debug.Log("[FCA] Bootstrap OK · scene=" + ScenePath + " · materials=" + ResourcesFolder);
            }
            catch (Exception ex)
            {
                Debug.LogError("[FCA] Bootstrap FAILED: " + ex);
                if (Application.isBatchMode)
                {
                    EditorApplication.Exit(1);
                }
                else
                {
                    throw;
                }
            }
        }

        public static string ProjectRoot
        {
            get { return Directory.GetParent(Application.dataPath).FullName; }
        }

        public static string RepoRoot
        {
            get
            {
                string projectRoot = ProjectRoot;                 // .../unity/FCANebula
                string unityRoot = Directory.GetParent(projectRoot).FullName;  // .../unity
                return Directory.GetParent(unityRoot).FullName;   // repo root
            }
        }

        public static string ResolveOutputDirectory()
        {
            string overridePath = Environment.GetEnvironmentVariable("FCA_UNITY_OUTPUT");
            if (!string.IsNullOrEmpty(overridePath))
            {
                return Path.GetFullPath(Environment.ExpandEnvironmentVariables(overridePath));
            }
            return Path.Combine(RepoRoot, "artifacts", "unity", "FCANebula");
        }

        public static void EnsureFolders()
        {
            string[] folders = new string[]
            {
                Path.Combine(Application.dataPath, "Scenes"),
                Path.Combine(Application.dataPath, "Resources"),
                Path.Combine(Application.dataPath, "Resources", "Nebula")
            };
            for (int i = 0; i < folders.Length; i++)
            {
                if (!Directory.Exists(folders[i]))
                {
                    Directory.CreateDirectory(folders[i]);
                }
            }
            AssetDatabase.Refresh();
        }

        /// <summary>Create/refresh the material assets that guarantee shaders are included in builds.</summary>
        public static void EnsureMaterials()
        {
            CreateOrUpdateMaterial("Assets/Resources/Nebula/NebulaVolume.mat", "FCA/NebulaVolume");
            CreateOrUpdateMaterial("Assets/Resources/Nebula/NodeStar.mat", "FCA/NodeStar");
            CreateOrUpdateMaterial("Assets/Resources/Nebula/EdgeFilament.mat", "FCA/EdgeFilament");
            CreateOrUpdateMaterial("Assets/Resources/Nebula/NebulaPost.mat", "FCA/NebulaPost");
            AssetDatabase.SaveAssets();
        }

        static void CreateOrUpdateMaterial(string assetPath, string shaderName)
        {
            Shader shader = Shader.Find(shaderName);
            if (shader == null)
            {
                throw new Exception("Shader not found: " + shaderName + " (expected under Assets/Shaders).");
            }
            Material material = AssetDatabase.LoadAssetAtPath<Material>(assetPath);
            if (material == null)
            {
                material = new Material(shader);
                material.name = Path.GetFileNameWithoutExtension(assetPath);
                AssetDatabase.CreateAsset(material, assetPath);
                Debug.Log("[FCA] Created material " + assetPath + " (" + shaderName + ")");
            }
            else if (material.shader == null || material.shader.name != shaderName)
            {
                material.shader = shader;
                EditorUtility.SetDirty(material);
                Debug.Log("[FCA] Updated material shader " + assetPath + " -> " + shaderName);
            }
        }

        public static void ConfigurePlayerSettings()
        {
            PlayerSettings.companyName = "FCA";
            PlayerSettings.productName = "FCA Nebula";
            PlayerSettings.bundleVersion = "0.1.0";
            PlayerSettings.fullScreenMode = FullScreenMode.Windowed;
            PlayerSettings.defaultScreenWidth = 1600;
            PlayerSettings.defaultScreenHeight = 1000;
            PlayerSettings.resizableWindow = true;
            PlayerSettings.runInBackground = true;
            PlayerSettings.visibleInBackground = true;
            PlayerSettings.colorSpace = ColorSpace.Linear;
            PlayerSettings.allowFullscreenSwitch = true;

            QualitySettings.vSyncCount = 0;
            QualitySettings.antiAliasing = 4;

            // Task-20: Unity 6 URP pipeline asset / global volume / camera data.
            URPSetup.ConfigureProject();

            // NOTE: the active build target is intentionally NOT switched here. The bootstrap
            // runs for several platforms (standalone + WebGL); BuildScript manages the target.
            AssetDatabase.SaveAssets();
        }

        static Scene BuildScene()
        {
            Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            GameObject cameraObject = new GameObject("Main Camera");
            cameraObject.tag = "MainCamera";
            Camera camera = cameraObject.AddComponent<Camera>();
            cameraObject.AddComponent<AudioListener>();
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = Color.black;
            camera.nearClipPlane = 0.5f;
            camera.farClipPlane = 5000f;
            camera.fieldOfView = 52f;
            camera.allowHDR = true;
            camera.allowMSAA = false;
            cameraObject.transform.position = new Vector3(0f, -650f, 200f);
            cameraObject.transform.rotation = Quaternion.Euler(14f, 0f, 0f);
            cameraObject.AddComponent<NebulaCameraRig>();
            cameraObject.AddComponent<NebulaFieldRenderer>();
            // Task-20: URP camera data (post-processing + global volume) and HDRP-like volume.
            URPSetup.EnsureCameraData(camera);
            URPSetup.EnsureGlobalVolume();

            GameObject systemObject = new GameObject("FCA Nebula System");
            systemObject.AddComponent<NebulaApp>();
            systemObject.AddComponent<FcaApiClient>();
            systemObject.AddComponent<WorkspaceSpiralLayout>();
            systemObject.AddComponent<NodeRenderer>();
            systemObject.AddComponent<EdgeRenderer>();
            systemObject.AddComponent<UiOverlay>();

            EditorSceneManager.MarkSceneDirty(scene);
            return scene;
        }

        /// <summary>Batchmode entry point: bootstrap if the scene does not exist yet, then verify.</summary>
        public static void EnsureSceneExists()
        {
            if (AssetDatabase.LoadAssetAtPath<SceneAsset>(ScenePath) == null)
            {
                Debug.Log("[FCA] Scene missing, running BootstrapAll first.");
                BootstrapAll();
            }
        }
    }
}
