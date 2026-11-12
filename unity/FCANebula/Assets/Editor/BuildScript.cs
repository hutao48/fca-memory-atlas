// FCA Memory Atlas — Unity Nebula Renderer (Editor)
// BuildScript: batchmode builds for both targets.
//
// 1) Windows standalone (development / fallback, separate window):
//      Unity.exe -batchmode -quit -projectPath unity/FCANebula \
//        -executeMethod FCANebula.EditorTools.BuildScript.BuildWindows \
//        -logFile artifacts/unity/build.log
//    -> artifacts/unity/FCANebula/FCANebula.exe
//
// 2) WebGL (primary integration path: Electron embeds it in an iframe via a local server):
//      Unity.exe -batchmode -quit -buildTarget WebGL -projectPath unity/FCANebula \
//        -executeMethod FCANebula.EditorTools.BuildScript.BuildWebGL \
//        -logFile D:\FCA\_scratch\unity\webgl-build.log
//    -> artifacts/unity/FCANebulaWebGL/index.html + Build/*.js/.wasm/.data
//
// WebGL player settings: compression Disabled (no server MIME/header surprises for the
// Electron local static server), 512MB memory, data caching on, exceptions on.
// Runtime URL / bearer token are passed through the page query string, see docs §11.

using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;
using UnityEngine.Rendering;

namespace FCANebula.EditorTools
{
    public static class BuildScript
    {
        public const string WebGLOutputRelative = "artifacts/unity/FCANebulaWebGL";

        [MenuItem("FCA/Build Windows x64 (artifacts/unity/FCANebula)")]
        public static void BuildWindowsMenu()
        {
            if (!BuildWindowsInternal())
            {
                EditorUtility.DisplayDialog("FCA Nebula", "Windows 构建失败，详见 Console。", "OK");
            }
        }

        [MenuItem("FCA/Build WebGL (artifacts/unity/FCANebulaWebGL)")]
        public static void BuildWebGLMenu()
        {
            if (!BuildWebGLInternal())
            {
                EditorUtility.DisplayDialog("FCA Nebula", "WebGL 构建失败，详见 Console。", "OK");
            }
        }

        /// <summary>Batchmode entry point for the Windows standalone player.</summary>
        public static void BuildWindows()
        {
            bool success = BuildWindowsInternal();
            if (!success && Application.isBatchMode)
            {
                EditorApplication.Exit(1);
            }
        }

        /// <summary>Batchmode entry point for the WebGL player (pass -buildTarget WebGL).</summary>
        public static void BuildWebGL()
        {
            bool success = BuildWebGLInternal();
            if (!success && Application.isBatchMode)
            {
                EditorApplication.Exit(1);
            }
        }

        // -----------------------------------------------------------------
        // Windows standalone
        // -----------------------------------------------------------------

        static bool BuildWindowsInternal()
        {
            try
            {
                ProjectBootstrap.EnsureFolders();
                ProjectBootstrap.EnsureMaterials();
                ConfigureCommonPlayerSettings();
                ProjectBootstrap.EnsureSceneExists();

                if (!EnsureBuildTarget(BuildTarget.StandaloneWindows64))
                {
                    return false;
                }
                if (AssetDatabase.LoadAssetAtPath<SceneAsset>(ProjectBootstrap.ScenePath) == null)
                {
                    Debug.LogError("[FCA] Build aborted: scene " + ProjectBootstrap.ScenePath + " is missing.");
                    return false;
                }
                EditorBuildSettings.scenes = new EditorBuildSettingsScene[]
                {
                    new EditorBuildSettingsScene(ProjectBootstrap.ScenePath, true)
                };

                string outputDirectory = ProjectBootstrap.ResolveOutputDirectory();
                Directory.CreateDirectory(outputDirectory);
                string executablePath = Path.Combine(outputDirectory, "FCANebula.exe");

                BuildPlayerOptions options = new BuildPlayerOptions();
                options.scenes = new string[] { ProjectBootstrap.ScenePath };
                options.locationPathName = executablePath;
                options.target = BuildTarget.StandaloneWindows64;
                options.options = BuildOptions.None;

                Debug.Log("[FCA] Building Windows standalone -> " + executablePath);
                BuildReport report = BuildPipeline.BuildPlayer(options);
                if (report == null)
                {
                    Debug.LogError("[FCA] BuildPlayer returned null report.");
                    return false;
                }
                BuildSummary summary = report.summary;
                if (summary.result != BuildResult.Succeeded)
                {
                    Debug.LogError("[FCA] Windows build FAILED: result=" + summary.result +
                                   " errors=" + summary.totalErrors + " (" + (summary.totalSize / (1024 * 1024)) + " MB, " + summary.totalTime + ")");
                    return false;
                }
                if (!File.Exists(executablePath))
                {
                    Debug.LogError("[FCA] Build reported success but exe is missing: " + executablePath);
                    return false;
                }
                FileInfo info = new FileInfo(executablePath);
                Debug.Log("[FCA] WINDOWS BUILD OK: " + executablePath + " (" + (info.Length / (1024 * 1024)) + " MB, " +
                          summary.totalErrors + " errors, " + summary.totalTime + ")");
                return true;
            }
            catch (Exception ex)
            {
                Debug.LogError("[FCA] Windows build exception: " + ex);
                return false;
            }
        }

        // -----------------------------------------------------------------
        // WebGL
        // -----------------------------------------------------------------

        static bool BuildWebGLInternal()
        {
            try
            {
                ProjectBootstrap.EnsureFolders();
                ProjectBootstrap.EnsureMaterials();
                ConfigureCommonPlayerSettings();
                ConfigureWebGLPlayerSettings();
                // Task-20: Unity 6 URP — create/assign pipeline assets before building.
                URPSetup.ConfigureProject();
                ProjectBootstrap.EnsureSceneExists();

                if (!EnsureBuildTarget(BuildTarget.WebGL))
                {
                    return false;
                }
                if (AssetDatabase.LoadAssetAtPath<SceneAsset>(ProjectBootstrap.ScenePath) == null)
                {
                    Debug.LogError("[FCA] WebGL build aborted: scene " + ProjectBootstrap.ScenePath + " is missing.");
                    return false;
                }
                EditorBuildSettings.scenes = new EditorBuildSettingsScene[]
                {
                    new EditorBuildSettingsScene(ProjectBootstrap.ScenePath, true)
                };

                string outputDirectory = Path.Combine(ProjectBootstrap.RepoRoot, WebGLOutputRelative);
                if (Directory.Exists(outputDirectory))
                {
                    // Clean stale Build/ files so the Electron payload is deterministic.
                    Directory.Delete(outputDirectory, true);
                }
                Directory.CreateDirectory(outputDirectory);

                BuildPlayerOptions options = new BuildPlayerOptions();
                options.scenes = new string[] { ProjectBootstrap.ScenePath };
                options.locationPathName = outputDirectory;
                options.target = BuildTarget.WebGL;
                options.options = BuildOptions.None;

                Debug.Log("[FCA] Building WebGL -> " + outputDirectory);
                BuildReport report = BuildPipeline.BuildPlayer(options);
                if (report == null)
                {
                    Debug.LogError("[FCA] WebGL BuildPlayer returned null report.");
                    return false;
                }
                BuildSummary summary = report.summary;
                if (summary.result != BuildResult.Succeeded)
                {
                    Debug.LogError("[FCA] WebGL build FAILED: result=" + summary.result +
                                   " errors=" + summary.totalErrors + " (" + (summary.totalSize / (1024 * 1024)) + " MB, " + summary.totalTime + ")");
                    return false;
                }
                string indexPath = Path.Combine(outputDirectory, "index.html");
                if (!File.Exists(indexPath))
                {
                    Debug.LogError("[FCA] WebGL build reported success but index.html is missing: " + indexPath);
                    return false;
                }
                long totalBytes = MeasureDirectory(outputDirectory);
                WriteWebGLBuildInfo(outputDirectory, summary, totalBytes);
                Debug.Log("[FCA] WEBGL BUILD OK: " + indexPath + " (total " + (totalBytes / (1024 * 1024)) + " MB, " +
                          summary.totalErrors + " errors, " + summary.totalTime + ")");
                return true;
            }
            catch (Exception ex)
            {
                Debug.LogError("[FCA] WebGL build exception: " + ex);
                return false;
            }
        }

        static void ConfigureWebGLPlayerSettings()
        {
            // Compression: Disabled keeps the Electron local static server dead simple
            // (no Content-Encoding / .br / .gz MIME handling, no decompression fallback JS).
            PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Disabled;
#if !UNITY_6000_0_OR_NEWER
            PlayerSettings.WebGL.memorySize = 512; // removed in Unity 6 (automatic WebGL memory)
#endif
            PlayerSettings.WebGL.dataCaching = true;
            PlayerSettings.WebGL.exceptionSupport = WebGLExceptionSupport.FullWithoutStacktrace;
            PlayerSettings.WebGL.template = "PROJECT:FCANebula";
            // WebGL2 only feature used by the volume shader / linear color space.
            PlayerSettings.colorSpace = ColorSpace.Linear;
            PlayerSettings.defaultWebScreenWidth = 1600;
            PlayerSettings.defaultWebScreenHeight = 1000;
            Debug.Log("[FCA] WebGL settings: compression=Disabled memory=512MB dataCaching=on exceptions=on template=PROJECT:FCANebula");
        }

        static void WriteWebGLBuildInfo(string outputDirectory, BuildSummary summary, long totalBytes)
        {
            try
            {
                WebGLBuildInfo info = new WebGLBuildInfo();
                info.unity_version = Application.unityVersion;
                info.built_at_utc = DateTime.UtcNow.ToString("o");
                info.compression = "disabled";
                info.memory_size_mb = 512;
                info.data_caching = true;
                info.exception_support = "FullWithoutStacktrace";
                info.template = "PROJECT:FCANebula";
                info.total_bytes = totalBytes;
                info.total_errors = summary.totalErrors;
                info.scene = ProjectBootstrap.ScenePath;
                info.query_contract =
                    "index.html?runtime-url=<http://127.0.0.1:17860|/relative-base>&token=<bearer>&quality=high&view=0|1|2&poll=3&auto-rotate=0&labels=0";
                info.bridge_contract =
                    "Unity -> page: window.__FCA_NEBULA_STATE__, window.__FCA_READY__, window.__FCA_NEBULA_SELECTED__, window message types fca-unity-ready/fca-unity-state/fca-unity-select; " +
                    "page -> Unity: FCA_NEBULA.postCommand('view:0|1|2'|'quality:high'|'refresh'|'labels:0|1'|'select:<nodeId>'|'select:clear'|'focus:<nodeId>'|'highlight-chain:<nodeId>'|'select-chain:<nodeId>'|'expand:<nodeId>'|'collapse:<nodeId>'), " +
                    "and cross-origin parent message {type:'fca-unity-command',command} with {type:'fca-unity-command-ack',command,ok}.";
                // task-19 packaging assertions: machine-readable chain/highlight feature flags.
                // task-20: v0.4.0 = Unity 6 + URP WebGL.
                info.features = new string[] { "urp", "chain-links", "chain-same-arm", "chain-highlight", "hierarchy-fold", "selection-bridge" };
                info.urp = true;
                info.chain_links = true;
                info.chain_same_arm = true;
                info.chain_highlight = true;
                info.hierarchy_fold = true;
                info.selection_bridge = true;
                info.render_pipeline = "urp";
                RenderPipelineAsset pipeline = GraphicsSettings.defaultRenderPipeline;
                info.urp_asset = pipeline != null ? pipeline.name : "";
                info.note =
                    "Runtime JSON is fetched directly from the FCA Runtime over HTTP (CORS enabled). The bearer token is injected into the iframe URL by Electron and is never written to disk/logs.";
                File.WriteAllText(Path.Combine(outputDirectory, "fca-webgl-build-info.json"), JsonUtility.ToJson(info, true));
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[FCA] Failed to write WebGL build info: " + ex.Message);
            }
        }

        static long MeasureDirectory(string directory)
        {
            long total = 0;
            try
            {
                string[] files = Directory.GetFiles(directory, "*", SearchOption.AllDirectories);
                for (int i = 0; i < files.Length; i++)
                {
                    total += new FileInfo(files[i]).Length;
                }
            }
            catch (Exception)
            {
                // measurement only
            }
            return total;
        }

        // -----------------------------------------------------------------
        // Shared helpers
        // -----------------------------------------------------------------

        static void ConfigureCommonPlayerSettings()
        {
            PlayerSettings.companyName = "FCA";
            PlayerSettings.productName = "FCA Nebula";
            PlayerSettings.bundleVersion = "0.1.0";
            PlayerSettings.fullScreenMode = FullScreenMode.Windowed;
            PlayerSettings.defaultScreenWidth = 1600;
            PlayerSettings.defaultScreenHeight = 1000;
            PlayerSettings.resizableWindow = true;
            PlayerSettings.runInBackground = true;
            PlayerSettings.colorSpace = ColorSpace.Linear;
            QualitySettings.vSyncCount = 0;
            QualitySettings.antiAliasing = 4;
            AssetDatabase.SaveAssets();
        }

        /// <summary>
        /// The active build target must already match. In batchmode Unity switches it through
        /// the "-buildTarget &lt;target&gt;" command line argument before running executeMethod;
        /// switching here while scripts execute is not supported.
        /// </summary>
        static bool EnsureBuildTarget(BuildTarget target)
        {
            if (EditorUserBuildSettings.activeBuildTarget == target)
            {
                return true;
            }
            if (Application.isBatchMode)
            {
                Debug.LogError("[FCA] Active build target is " + EditorUserBuildSettings.activeBuildTarget +
                               " but " + target + " is required. Re-run Unity with '-buildTarget " + TargetArgument(target) + "'.");
                return false;
            }
            bool switched = EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroupFor(target), target);
            if (!switched)
            {
                Debug.LogError("[FCA] Failed to switch build target to " + target + ".");
            }
            return switched;
        }

        static string TargetArgument(BuildTarget target)
        {
            switch (target)
            {
                case BuildTarget.WebGL:
                    return "WebGL";
                case BuildTarget.StandaloneWindows64:
                    return "Win64";
                default:
                    return target.ToString();
            }
        }

        static BuildTargetGroup BuildTargetGroupFor(BuildTarget target)
        {
            switch (target)
            {
                case BuildTarget.WebGL:
                    return BuildTargetGroup.WebGL;
                case BuildTarget.StandaloneWindows64:
                    return BuildTargetGroup.Standalone;
                default:
                    return BuildTargetGroup.Standalone;
            }
        }

        [Serializable]
        public class WebGLBuildInfo
        {
            public string unity_version;
            public string built_at_utc;
            public string compression;
            public int memory_size_mb;
            public bool data_caching;
            public string exception_support;
            public string template;
            public long total_bytes;
            public int total_errors;
            public string scene;
            public string query_contract;
            public string bridge_contract;
            // task-19: machine-readable feature markers (installer/verify-installed.ps1 asserts these)
            public string[] features;
            public bool urp;
            public bool chain_links;
            public bool chain_same_arm;
            public bool chain_highlight;
            public bool hierarchy_fold;
            public bool selection_bridge;
            // task-20: Unity 6 URP build metadata
            public string render_pipeline;
            public string urp_asset;
            public string note;
        }
    }
}
