// FCA Memory Atlas — Unity Nebula Renderer
// ScreenshotRunner: deterministic, unattended screenshot mode for CI / acceptance:
//   FCANebula.exe --screenshot-dir=artifacts/unity --screenshot-count=3 --quality=high
// Captures the live Runtime graph (overview, workspace-arm close-up with the click-through
// inspector, top-down), writes a manifest and quits. Used to produce the 3 real-data
// acceptance screenshots without any manual window interaction.
//
// Standalone/Editor only: the WebGL player is screenshotted from the embedding page instead.

#if !UNITY_WEBGL || UNITY_EDITOR
using System;
using System.Collections;
using System.IO;
using UnityEngine;

namespace FCANebula
{
    [Serializable]
    public class ScreenshotManifest
    {
        public string generated_at;
        public string runtime_url;
        public string quality;
        public bool sample_data;
        public bool connected;
        public int node_count;
        public int edge_count;
        public int arm_count;
        public string arm_summary;
        public string layout_signature;
        public string[] files;
        public string[] presets;
        public string note;
    }

    public sealed class ScreenshotRunner : MonoBehaviour
    {
        static readonly string[] PresetKeys = new string[] { "overview", "workspace-arm", "top-down" };

        AppConfig _config;
        NebulaApp _app;
        bool _running;

        public string LastError { get; private set; }
        public string[] CapturedFiles { get; private set; }

        public void Initialize(AppConfig config, NebulaApp app)
        {
            if (_running)
            {
                return;
            }
            _config = config;
            _app = app;
            _running = true;
            StartCoroutine(Run());
        }

        IEnumerator Run()
        {
            LastError = null;
            string outputDirectory = AppPaths.Resolve(_config.ScreenshotDir);
            try
            {
                Directory.CreateDirectory(outputDirectory);
            }
            catch (Exception ex)
            {
                LastError = "无法创建截图目录: " + ex.Message;
                Debug.LogError("[FCA] " + LastError);
            }

            if (_app.CameraRig != null)
            {
                _app.CameraRig.SetBlockInput(true);
                _app.CameraRig.SetAutoRotate(0f);
            }
            ApplyWindowResolution();
            yield return new WaitForSecondsRealtime(1.0f);

            // 1) Wait for the first real graph (or give up and document the failure state).
            float deadline = Time.realtimeSinceStartup + Mathf.Max(15f, _config.ScreenshotDelay + 40f);
            while (Time.realtimeSinceStartup < deadline)
            {
                if (_app.CurrentGraph != null && _app.CurrentLayout != null)
                {
                    break;
                }
                yield return null;
            }

            if (_app.CurrentGraph == null || _app.CurrentLayout == null)
            {
                Debug.LogWarning("[FCA] 截图模式：等待 Runtime 图数据超时，抓取离线状态截图（不伪造数据）。");
                yield return new WaitForSecondsRealtime(1.0f);
                string offlinePath = Path.Combine(outputDirectory, "screenshot-offline-state.png");
                yield return Capture(offlinePath);
                WriteManifest(outputDirectory, offlinePath);
                Finish();
                yield break;
            }

            // Let the camera damping / layout settle and the HUD fetch its state.
            yield return new WaitForSecondsRealtime(Mathf.Max(0.6f, _config.ScreenshotDelay * 0.5f));

            // 2) Prepare the "workspace arm close-up" showcase: highest-importance memory of
            //    the largest workspace arm, with the real memory body fetched by the HUD.
            if (_config.ScreenshotCount >= 2)
            {
                LayoutNode showcase = _app.FindShowcaseNode();
                if (showcase != null && _app.Nodes != null)
                {
                    _app.Nodes.Select(showcase, false);
                    yield return new WaitForSecondsRealtime(1.6f);
                }
            }

            // 3) Capture the requested deterministic presets.
            int captureCount = Mathf.Clamp(_config.ScreenshotCount, 1, 3);
            string[] files = new string[captureCount];
            for (int i = 0; i < captureCount; i++)
            {
                if (_app.CameraRig != null)
                {
                    _app.CameraRig.ApplyPreset(i, _app.CurrentLayout);
                }
                yield return null;
                yield return null;
                yield return new WaitForSecondsRealtime(0.35f);
                string presetKey = i < PresetKeys.Length ? PresetKeys[i] : "view-" + i;
                string file = Path.Combine(outputDirectory, "screenshot-" + (i + 1) + "-" + presetKey + ".png");
                yield return Capture(file);
                files[i] = file;
            }
            CapturedFiles = files;
            WriteManifest(outputDirectory, null);
            Finish();
        }

        void ApplyWindowResolution()
        {
#if !UNITY_EDITOR
            // Deterministic acceptance screenshots: always 1600x1000 windowed.
            Screen.SetResolution(1600, 1000, FullScreenMode.Windowed);
#endif
        }

        IEnumerator Capture(string absolutePath)
        {
            string directory = Path.GetDirectoryName(absolutePath);
            if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
            {
                Directory.CreateDirectory(directory);
            }
            if (File.Exists(absolutePath))
            {
                try
                {
                    File.Delete(absolutePath);
                }
                catch (Exception)
                {
                    // Ignore; a stale file will be overwritten by the player.
                }
            }
            ScreenCapture.CaptureScreenshot(absolutePath, 1);
            float start = Time.realtimeSinceStartup;
            while (!File.Exists(absolutePath) && Time.realtimeSinceStartup - start < 12f)
            {
                yield return null;
            }
            if (!File.Exists(absolutePath))
            {
                LastError = "截图未生成: " + absolutePath;
                Debug.LogError("[FCA] " + LastError);
            }
            else
            {
                Debug.Log("[FCA] 截图已保存: " + absolutePath + " (" + new FileInfo(absolutePath).Length + " bytes)");
            }
        }

        void WriteManifest(string outputDirectory, string offlineFile)
        {
            ScreenshotManifest manifest = new ScreenshotManifest();
            manifest.generated_at = DateTime.UtcNow.ToString("o");
            manifest.runtime_url = _app.Api != null ? _app.Api.RuntimeUrl : _config.RuntimeUrl;
            manifest.quality = _app.QualityKey;
            manifest.sample_data = _app.Api != null && _app.Api.IsSampleData;
            manifest.connected = _app.Api != null && _app.Api.State == ConnectionState.Online;
            LayoutModel layout = _app.CurrentLayout;
            GraphModel graph = _app.CurrentGraph;
            manifest.node_count = layout != null ? layout.NodeCount : 0;
            manifest.edge_count = graph != null ? graph.Edges.Count : 0;
            manifest.arm_count = layout != null ? layout.Arms.Count : 0;
            manifest.layout_signature = layout != null ? layout.Signature : "";
            manifest.arm_summary = BuildArmSummary(layout);
            manifest.files = offlineFile != null ? new string[] { offlineFile } : (CapturedFiles ?? new string[0]);
            manifest.presets = PresetKeys;
            manifest.note = offlineFile != null
                ? "Runtime 不可用，仅抓取了离线/错误状态（未伪造数据）。"
                : (manifest.sample_data
                    ? "SAMPLE 离线样例数据（非实时）。"
                    : "真实 FCA Runtime 数据截图。");
            try
            {
                string path = Path.Combine(outputDirectory, "screenshots-manifest.json");
                File.WriteAllText(path, JsonUtility.ToJson(manifest, true));
                Debug.Log("[FCA] 截图清单: " + path);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[FCA] 写入截图清单失败: " + ex.Message);
            }
        }

        static string BuildArmSummary(LayoutModel layout)
        {
            if (layout == null || layout.Arms.Count == 0)
            {
                return "";
            }
            string summary = "";
            for (int i = 0; i < layout.Arms.Count; i++)
            {
                LayoutArm arm = layout.Arms[i];
                if (i > 0)
                {
                    summary += " | ";
                }
                summary += (arm.IsDefault ? "default" : arm.Label) + ":" + arm.NodeCount + "(" + arm.ColorKey + ")";
            }
            return summary;
        }

        void Finish()
        {
            if (_config == null)
            {
                return;
            }
            StartCoroutine(QuitSoon());
        }

        IEnumerator QuitSoon()
        {
            yield return new WaitForSecondsRealtime(0.8f);
#if UNITY_EDITOR
            UnityEditor.EditorApplication.isPlaying = false;
#else
            Application.Quit(0);
#endif
        }
    }
}
#endif
