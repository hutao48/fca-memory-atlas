// FCA Memory Atlas — Unity Nebula Renderer (WebGL)
// WebGLBridge: Unity -> embedding page status bridge (Electron iframe integration).
// Only compiled for WebGL player builds; the standalone player keeps its own window.

#if UNITY_WEBGL && !UNITY_EDITOR
using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using UnityEngine;

namespace FCANebula
{
    [Serializable]
    public class WebGLStatePayload
    {
        public bool ready;
        public bool connected;
        public bool sample;
        public string state;
        public string runtimeUrl;
        public string quality;
        public int nodes;
        public int edges;
        public int arms;
        public string armSummary;
        public string layout;
        public int view;
        public bool webgl = true;
        // diagnostics (surfaced to the page for acceptance tooling)
        public bool tokenProvided;
        public int initialView;
        public bool volumeMaterialOk;
        public float armCountUniform;
        public float emissionScale;
        public int marchSteps;
    }

    public static class WebGLBridge
    {
        [DllImport("__Internal")]
        private static extern void FCABridge_PushState(string json);

        [DllImport("__Internal")]
        private static extern void FCABridge_NotifyReady(string json);

        static int _lastView = -1;

        public static void SetInitialView(int view)
        {
            _lastView = view;
        }

        public static void PushState(AppConfig config, FcaApiClient api, LayoutModel layout)
        {
            WebGLStatePayload payload = new WebGLStatePayload();
            payload.ready = layout != null && layout.NodeCount > 0;
            payload.connected = api != null && api.State == ConnectionState.Online;
            payload.sample = api != null && api.IsSampleData;
            payload.state = api != null ? api.State.ToString() : "Unknown";
            payload.runtimeUrl = api != null ? api.RuntimeUrl : (config != null ? config.RuntimeUrl : "");
            payload.quality = config != null ? QualityProfile.For(config.Quality).Key : "high";
            payload.nodes = layout != null ? layout.NodeCount : 0;
            payload.edges = layout != null && layout.Graph != null ? layout.Graph.Edges.Count : 0;
            payload.arms = layout != null ? layout.Arms.Count : 0;
            payload.armSummary = BuildArmSummary(layout);
            payload.layout = layout != null ? layout.Signature : "";
            payload.view = _lastView;
            FillDiagnostics(payload, config, api);
            string json = JsonUtility.ToJson(payload);
            try
            {
                FCABridge_PushState(json);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[FCA] WebGL bridge push failed: " + ex.Message);
            }
        }

        public static void NotifyReady(AppConfig config, FcaApiClient api, LayoutModel layout)
        {
            WebGLStatePayload payload = new WebGLStatePayload();
            payload.ready = true;
            payload.connected = api != null && api.State == ConnectionState.Online;
            payload.sample = api != null && api.IsSampleData;
            payload.state = api != null ? api.State.ToString() : "Unknown";
            payload.runtimeUrl = api != null ? api.RuntimeUrl : "";
            payload.quality = config != null ? QualityProfile.For(config.Quality).Key : "high";
            payload.nodes = layout != null ? layout.NodeCount : 0;
            payload.edges = layout != null && layout.Graph != null ? layout.Graph.Edges.Count : 0;
            payload.arms = layout != null ? layout.Arms.Count : 0;
            payload.armSummary = BuildArmSummary(layout);
            payload.layout = layout != null ? layout.Signature : "";
            payload.view = _lastView;
            FillDiagnostics(payload, config, api);
            string json = JsonUtility.ToJson(payload);
            try
            {
                FCABridge_NotifyReady(json);
                Debug.Log("[FCA] WebGL bridge ready: " + json);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[FCA] WebGL bridge ready failed: " + ex.Message);
            }
        }

        static void FillDiagnostics(WebGLStatePayload payload, AppConfig config, FcaApiClient api)
        {
            try
            {
                payload.tokenProvided = api != null && api.TokenAvailable;
                payload.initialView = config != null ? config.InitialView : -1;
                NebulaApp app = NebulaApp.Instance;
                if (app != null && app.Nebula != null)
                {
                    Material material = app.Nebula.VolumeMaterial;
                    if (material != null)
                    {
                        payload.volumeMaterialOk = true;
                        payload.armCountUniform = material.GetFloat("_ArmCount");
                        payload.emissionScale = material.GetFloat("_EmissionScale");
                        payload.marchSteps = material.GetInt("_Steps");
                    }
                }
            }
            catch (Exception)
            {
                // diagnostics must never break rendering
            }
        }

        static string BuildArmSummary(LayoutModel layout)
        {
            if (layout == null || layout.Arms.Count == 0)
            {
                return "";
            }
            StringBuilder sb = new StringBuilder(128);
            for (int i = 0; i < layout.Arms.Count; i++)
            {
                if (i > 0)
                {
                    sb.Append(" | ");
                }
                LayoutArm arm = layout.Arms[i];
                sb.Append(arm.IsDefault ? "default" : arm.Label).Append(':').Append(arm.NodeCount);
            }
            return sb.ToString();
        }

        /// <summary>
        /// JavaScript -> Unity commands (e.g. Electron toolbar buttons).
        /// Supported: "view:0|1|2", "quality:off|low|medium|high|ultra", "refresh", "labels:0|1".
        /// </summary>
        public static void OnJsCommand(string command)
        {
            if (string.IsNullOrEmpty(command))
            {
                return;
            }
            NebulaApp app = NebulaApp.Instance;
            if (app == null)
            {
                return;
            }
            int colon = command.IndexOf(':');
            string verb = (colon >= 0 ? command.Substring(0, colon) : command).Trim().ToLowerInvariant();
            string arg = colon >= 0 ? command.Substring(colon + 1).Trim() : "";
            switch (verb)
            {
                case "view":
                    int view;
                    if (int.TryParse(arg, NumberStyles.Integer, CultureInfo.InvariantCulture, out view))
                    {
                        app.ApplyWebGLView(view);
                    }
                    break;
                case "quality":
                    app.SetQualityTier(AppConfig.ParseQuality(arg, QualityTier.High));
                    break;
                case "refresh":
                    app.RequestRefresh();
                    break;
                case "labels":
                    if (app.Ui != null)
                    {
                        app.Ui.ShowLabels = arg == "1" || arg == "true";
                    }
                    break;
                default:
                    Debug.LogWarning("[FCA] Unknown JS command: " + command);
                    break;
            }
        }
    }
}
#endif
