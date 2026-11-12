// FCA Memory Atlas — Unity Nebula Renderer
// AppConfig: CLI / environment configuration + quality profiles.
// Pure runtime code (no Editor dependencies) so it compiles in player builds.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using UnityEngine;

namespace FCANebula
{
    public enum QualityTier
    {
        Off = 0,
        Low = 1,
        Medium = 2,
        High = 3,
        Ultra = 4
    }

    /// <summary>Concrete render settings derived from a quality tier.</summary>
    public struct QualityProfile
    {
        public QualityTier Tier;
        public int MarchSteps;
        public int NoiseOctaves;
        public float RenderScale;
        public int BloomIterations;
        public float VolumeIntensity;
        public float NodeScale;
        public float EdgeIntensity;

        public string Key
        {
            get { return Tier.ToString().ToLowerInvariant(); }
        }

        public static QualityProfile For(QualityTier tier)
        {
            QualityProfile p = new QualityProfile();
            p.Tier = tier;
            switch (tier)
            {
                case QualityTier.Off:
                    p.MarchSteps = 0;
                    p.NoiseOctaves = 2;
                    p.RenderScale = 0.5f;
                    p.BloomIterations = 0;
                    p.VolumeIntensity = 0f;
                    p.NodeScale = 1.1f;
                    p.EdgeIntensity = 1.15f;
                    break;
                case QualityTier.Low:
                    p.MarchSteps = 24;
                    p.NoiseOctaves = 2;
                    p.RenderScale = 0.5f;
                    p.BloomIterations = 1;
                    p.VolumeIntensity = 0.75f;
                    p.NodeScale = 0.95f;
                    p.EdgeIntensity = 0.8f;
                    break;
                case QualityTier.Medium:
                    p.MarchSteps = 36;
                    p.NoiseOctaves = 3;
                    p.RenderScale = 0.65f;
                    p.BloomIterations = 2;
                    p.VolumeIntensity = 1.0f;
                    p.NodeScale = 1.0f;
                    p.EdgeIntensity = 0.9f;
                    break;
                case QualityTier.Ultra:
                    p.MarchSteps = 80;
                    p.NoiseOctaves = 4;
                    p.RenderScale = 1.0f;
                    p.BloomIterations = 3;
                    p.VolumeIntensity = 1.3f;
                    p.NodeScale = 1.05f;
                    p.EdgeIntensity = 1.1f;
                    break;
                default: // High
                    p.MarchSteps = 52;
                    p.NoiseOctaves = 3;
                    p.RenderScale = 0.85f;
                    p.BloomIterations = 2;
                    p.VolumeIntensity = 1.15f;
                    p.NodeScale = 1.0f;
                    p.EdgeIntensity = 1.0f;
                    break;
            }
            return p;
        }
    }

    /// <summary>
    /// Resolves runtime options from (lowest to highest precedence):
    /// built-in defaults -> environment variables -> command line arguments.
    /// Contract (docs/UNITY_NEBULA.md):
    ///   FCANebula.exe --runtime-url=http://127.0.0.1:17860 --token-file=&lt;path&gt;
    ///                 --fca-home=&lt;dir&gt; --quality=high
    /// </summary>
    public sealed class AppConfig
    {
        public const string DefaultRuntimeUrl = "http://127.0.0.1:17860";
        public const string DefaultWorkspaceTagPrefix = "workspace:";

        public string RuntimeUrl = DefaultRuntimeUrl;
        public string TokenFile = "";
        public string DirectToken = "";
        public string FcaHome = "";
        public QualityTier Quality = QualityTier.High;
        public float PollSeconds = 3f;
        public bool AllowSample = false;
        public string SamplePath = "";
        public string ScreenshotDir = "";
        public int ScreenshotCount = 0;
        public float ScreenshotDelay = 6f;
        /// <summary>WebGL query "view": -1 = default camera, 0/1/2 = overview/arm/top-down (acceptance shots).</summary>
        public int InitialView = -1;
        public float AutoRotateDegPerSec = 1.2f;
        public bool ShowLabels = true;
        public bool LogRequests = false;
        public string WorkspaceTagPrefix = DefaultWorkspaceTagPrefix;
        /// <summary>True when runtime-url was supplied as a same-origin relative path (WebGL behind Electron's static server).</summary>
        public bool RuntimeUrlIsRelative = false;

        static AppConfig _current;

        /// <summary>Process-wide singleton, resolved once from env + command line.</summary>
        public static AppConfig Current
        {
            get
            {
                if (_current == null)
                {
                    _current = Resolve();
                }
                return _current;
            }
        }

        public bool IsScreenshotMode
        {
            get { return ScreenshotCount > 0; }
        }

        public QualityProfile Profile
        {
            get { return QualityProfile.For(Quality); }
        }

        public static AppConfig Resolve()
        {
            AppConfig cfg = new AppConfig();
#if UNITY_WEBGL && !UNITY_EDITOR
            // WebGL player: configuration comes from the page URL query string
            // (Electron local static server): index.html?runtime-url=...&token=...&quality=high
            cfg.ApplyWebGLQuery();
#else
            cfg.ApplyEnvironment();
            cfg.ApplyCommandLine(Environment.GetCommandLineArgs());
#endif
            cfg.RuntimeUrl = NormalizeUrl(cfg.RuntimeUrl);
            cfg.RuntimeUrlIsRelative = cfg.RuntimeUrl.StartsWith("/", StringComparison.Ordinal);
#if !UNITY_WEBGL || UNITY_EDITOR
            if (string.IsNullOrEmpty(cfg.SamplePath))
            {
                cfg.SamplePath = Path.Combine(Application.streamingAssetsPath, "sample-graph.json");
            }
            cfg.SamplePath = AppPaths.Expand(cfg.SamplePath);
#endif
            if (string.IsNullOrEmpty(cfg.ScreenshotDir))
            {
                cfg.ScreenshotDir = "artifacts/unity";
            }
#if UNITY_WEBGL && !UNITY_EDITOR
            cfg.TokenFile = "";
#else
            if (string.IsNullOrEmpty(cfg.TokenFile))
            {
                cfg.TokenFile = cfg.ResolveTokenFile();
            }
            else
            {
                cfg.TokenFile = AppPaths.Expand(cfg.TokenFile);
            }
#endif
            if (cfg.IsScreenshotMode && Mathf.Approximately(cfg.AutoRotateDegPerSec, 1.2f))
            {
                // Screenshots must be deterministic. Auto-rotation is disabled unless
                // the user explicitly overrides it on the command line.
                cfg.AutoRotateDegPerSec = 0f;
            }
            return cfg;
        }

#if UNITY_WEBGL && !UNITY_EDITOR
        /// <summary>
        /// WebGL configuration contract (Electron embeds the player in an iframe):
        ///   index.html?runtime-url=http://127.0.0.1:17860&token=&lt;bearer&gt;&amp;quality=high&amp;view=0
        /// Optional: poll, labels, auto-rotate, hud, allow-sample, workspace-tag-prefix, api-base.
        /// Runtime-url may be a same-origin path (for example "/api") when a local server proxies it.
        /// </summary>
        void ApplyWebGLQuery()
        {
            string url = Application.absoluteURL;
            if (string.IsNullOrEmpty(url))
            {
                Debug.LogWarning("[FCA] WebGL: Application.absoluteURL 为空，使用默认 Runtime URL。");
                return;
            }
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri))
            {
                Debug.LogWarning("[FCA] WebGL: 无法解析页面 URL: " + url);
                return;
            }
            string query = uri.Query;
            if (string.IsNullOrEmpty(query) || query.Length < 2)
            {
                return;
            }
            bool labelsSpecified = false;
            string[] pairs = query.Substring(1).Split('&');
            for (int i = 0; i < pairs.Length; i++)
            {
                string pair = pairs[i];
                if (string.IsNullOrEmpty(pair))
                {
                    continue;
                }
                int eq = pair.IndexOf('=');
                string key = eq >= 0 ? pair.Substring(0, eq) : pair;
                string value = eq >= 0 ? pair.Substring(eq + 1) : "";
                key = Uri.UnescapeDataString(key).ToLowerInvariant();
                value = Uri.UnescapeDataString(value.Replace("+", "%2B")).Trim();
                switch (key)
                {
                    case "runtime-url":
                    case "runtimeurl":
                    case "url":
                    case "api-base":
                    case "apibase":
                        if (!string.IsNullOrEmpty(value)) RuntimeUrl = value;
                        break;
                    case "token":
                        DirectToken = value;
                        break;
                    case "quality":
                        Quality = ParseQuality(value, Quality);
                        break;
                    case "poll":
                        PollSeconds = ParseFloat(value, PollSeconds);
                        break;
                    case "view":
                    case "preset":
                        InitialView = (int)ParseFloat(value, InitialView);
                        break;
                    case "labels":
                        labelsSpecified = true;
                        ShowLabels = ParseBool(value, ShowLabels);
                        break;
                    case "auto-rotate":
                        AutoRotateDegPerSec = ParseFloat(value, AutoRotateDegPerSec);
                        break;
                    case "allow-sample":
                        AllowSample = ParseBool(value, false);
                        break;
                    case "workspace-tag-prefix":
                        if (!string.IsNullOrEmpty(value)) WorkspaceTagPrefix = value;
                        break;
                    case "hud":
                        // HUD visibility is handled by UiOverlay via this flag.
                        ShowHudFromQuery = ParseBool(value, true);
                        break;
                }
            }
            if (!labelsSpecified)
            {
                // WebGL has no OS font with CJK glyphs; keep node labels off by default
                // (memory titles are Chinese). Electron renders titles in its own HTML shell.
                ShowLabels = false;
            }
            Debug.Log("[FCA] WebGL config: runtime=" + RuntimeUrl + " quality=" + Quality +
                      " view=" + InitialView + " labels=" + ShowLabels + " tokenProvided=" + (!string.IsNullOrEmpty(DirectToken)));
        }
#endif

        /// <summary>WebGL "hud=0" query can hide the in-canvas HUD (Electron draws its own).</summary>
        public bool ShowHudFromQuery = true;

        void ApplyEnvironment()
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            return; // WebGL player has no process environment; see ApplyWebGLQuery.
#else
            RuntimeUrl = GetEnv("FCA_RUNTIME_URL", RuntimeUrl);
            TokenFile = GetEnv("FCA_TOKEN_FILE", TokenFile);
            DirectToken = GetEnv("FCA_TOKEN", DirectToken);
            FcaHome = GetEnv("FCA_HOME", FcaHome);
            WorkspaceTagPrefix = GetEnv("FCA_WORKSPACE_TAG_PREFIX", WorkspaceTagPrefix);
            SamplePath = GetEnv("FCA_SAMPLE_PATH", SamplePath);
            ScreenshotDir = GetEnv("FCA_SCREENSHOT_DIR", ScreenshotDir);

            string q = Environment.GetEnvironmentVariable("FCA_QUALITY");
            if (!string.IsNullOrEmpty(q))
            {
                Quality = ParseQuality(q, Quality);
            }
            PollSeconds = GetEnvFloat("FCA_POLL_SECONDS", PollSeconds);
            AutoRotateDegPerSec = GetEnvFloat("FCA_AUTO_ROTATE", AutoRotateDegPerSec);
            AllowSample = GetEnvBool("FCA_ALLOW_SAMPLE", AllowSample);
            ShowLabels = GetEnvBool("FCA_SHOW_LABELS", ShowLabels);
            LogRequests = GetEnvBool("FCA_LOG", LogRequests);
            ScreenshotCount = (int)GetEnvFloat("FCA_SCREENSHOT_COUNT", ScreenshotCount);
            ScreenshotDelay = GetEnvFloat("FCA_SCREENSHOT_DELAY", ScreenshotDelay);
            if (string.IsNullOrEmpty(WorkspaceTagPrefix))
            {
                WorkspaceTagPrefix = DefaultWorkspaceTagPrefix;
            }
#endif
        }

        void ApplyCommandLine(string[] args)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            return; // WebGL player has no command line; see ApplyWebGLQuery.
#else
            if (args == null)
            {
                return;
            }
            string[] keys = new string[] { "runtime-url", "url", "token-file", "token", "fca-home", "quality", "poll", "allow-sample", "sample", "screenshot-dir", "screenshot-count", "screenshot-delay", "auto-rotate", "labels", "log", "workspace-tag-prefix" };
            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                if (arg == null || !arg.StartsWith("--", StringComparison.Ordinal))
                {
                    continue;
                }
                string key;
                string value = null;
                int eq = arg.IndexOf('=');
                if (eq > 2)
                {
                    key = arg.Substring(2, eq - 2);
                    value = arg.Substring(eq + 1);
                }
                else
                {
                    key = arg.Substring(2);
                    if (i + 1 < args.Length && args[i + 1] != null && !args[i + 1].StartsWith("--", StringComparison.Ordinal))
                    {
                        value = args[i + 1];
                        i++;
                    }
                }
                key = key.ToLowerInvariant();
                if (value != null)
                {
                    value = value.Trim('"');
                }
                if (Array.IndexOf(keys, key) < 0)
                {
                    Debug.LogWarning("[FCA] Unknown command line option --" + key);
                    continue;
                }
                switch (key)
                {
                    case "runtime-url":
                    case "url":
                        if (!string.IsNullOrEmpty(value)) RuntimeUrl = value;
                        break;
                    case "token-file":
                        if (!string.IsNullOrEmpty(value)) TokenFile = AppPaths.Expand(value);
                        break;
                    case "token":
                        DirectToken = value;
                        break;
                    case "fca-home":
                        if (!string.IsNullOrEmpty(value)) FcaHome = AppPaths.Expand(value);
                        break;
                    case "quality":
                        Quality = ParseQuality(value, Quality);
                        break;
                    case "poll":
                        PollSeconds = ParseFloat(value, PollSeconds);
                        break;
                    case "allow-sample":
                        AllowSample = ParseBool(value, true);
                        break;
                    case "sample":
                        AllowSample = true;
                        if (!string.IsNullOrEmpty(value)) SamplePath = AppPaths.Expand(value);
                        break;
                    case "screenshot-dir":
                        if (!string.IsNullOrEmpty(value)) ScreenshotDir = AppPaths.Expand(value);
                        break;
                    case "screenshot-count":
                        ScreenshotCount = Mathf.Max(0, (int)ParseFloat(value, ScreenshotCount));
                        break;
                    case "screenshot-delay":
                        ScreenshotDelay = Mathf.Max(0.5f, ParseFloat(value, ScreenshotDelay));
                        break;
                    case "auto-rotate":
                        AutoRotateDegPerSec = ParseFloat(value, AutoRotateDegPerSec);
                        break;
                    case "labels":
                        ShowLabels = ParseBool(value, true);
                        break;
                    case "log":
                        LogRequests = ParseBool(value, true);
                        break;
                    case "workspace-tag-prefix":
                        if (!string.IsNullOrEmpty(value)) WorkspaceTagPrefix = value;
                        break;
                }
            }
#endif
        }

        /// <summary>
        /// Candidate token file locations, in priority order. The first existing file wins;
        /// if none exists yet the first candidate is returned as the "expected" path so the
        /// UI can show a useful diagnostic.
        /// </summary>
        public List<string> TokenFileCandidates()
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            return new List<string>(); // no filesystem in the WebGL player
#else
            List<string> list = new List<string>(8);
            AddCandidate(list, TokenFile);
            if (!string.IsNullOrEmpty(FcaHome))
            {
                AddCandidate(list, Path.Combine(FcaHome, "config", "runtime-token"));
            }
            AddCandidate(list, CombineEnv("FCA_HOME", "config", "runtime-token"));
            AddCandidate(list, CombineEnv("LOCALAPPDATA", "FCA-Memory-Atlas", "config", "runtime-token"));
            AddCandidate(list, CombineEnv("APPDATA", "FCA-Memory-Atlas", "config", "runtime-token"));
            string fcaDataHome = Environment.GetEnvironmentVariable("FCA_DATA_HOME");
            if (!string.IsNullOrEmpty(fcaDataHome))
            {
                AddCandidate(list, Path.Combine(AppPaths.Expand(fcaDataHome), "config", "runtime-token"));
            }
            AddCandidate(list, Path.Combine(AppPaths.HomeDirectory(), ".fca", "config", "runtime-token"));
            return list;
#endif
        }

        public string ResolveTokenFile()
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            return ""; // token arrives through the page URL query
#else
            List<string> candidates = TokenFileCandidates();
            for (int i = 0; i < candidates.Count; i++)
            {
                if (File.Exists(candidates[i]))
                {
                    return candidates[i];
                }
            }
            return candidates.Count > 0 ? candidates[0] : "";
#endif
        }

        /// <summary>Reads the bearer token from the resolved token file. Never logs the token itself.</summary>
        public bool TryReadToken(out string token, out string error)
        {
            token = null;
            error = null;
            if (!string.IsNullOrEmpty(DirectToken))
            {
                token = DirectToken.Trim();
                return token.Length > 0;
            }
#if UNITY_WEBGL && !UNITY_EDITOR
            error = "WebGL: provide the bearer token via the page URL query (?token=...) injected by Electron.";
            return false;
#else
            string path = ResolveTokenFile();
            if (string.IsNullOrEmpty(path))
            {
                error = "未找到 runtime-token 路径（可用 --token-file 或 --fca-home 指定）";
                return false;
            }
            if (!File.Exists(path))
            {
                error = "token 文件不存在: " + path;
                return false;
            }
            try
            {
                token = File.ReadAllText(path).Trim();
            }
            catch (Exception ex)
            {
                error = "读取 token 失败: " + ex.Message;
                return false;
            }
            if (string.IsNullOrEmpty(token))
            {
                error = "token 文件为空: " + path;
                return false;
            }
            return true;
#endif
        }

        static void AddCandidate(List<string> list, string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return;
            }
            string full = AppPaths.Expand(path);
            if (!list.Contains(full))
            {
                list.Add(full);
            }
        }

        static string CombineEnv(string envName, params string[] parts)
        {
            string root = Environment.GetEnvironmentVariable(envName);
            if (string.IsNullOrEmpty(root))
            {
                return null;
            }
            string path = AppPaths.Expand(root);
            for (int i = 0; i < parts.Length; i++)
            {
                path = Path.Combine(path, parts[i]);
            }
            return path;
        }

        static string GetEnv(string name, string fallback)
        {
            string v = Environment.GetEnvironmentVariable(name);
            return string.IsNullOrEmpty(v) ? fallback : v;
        }

        static float GetEnvFloat(string name, float fallback)
        {
            string v = Environment.GetEnvironmentVariable(name);
            return string.IsNullOrEmpty(v) ? fallback : ParseFloat(v, fallback);
        }

        static int GetEnvInt(string name, int fallback)
        {
            string v = Environment.GetEnvironmentVariable(name);
            return string.IsNullOrEmpty(v) ? fallback : (int)ParseFloat(v, fallback);
        }

        static bool GetEnvBool(string name, bool fallback)
        {
            string v = Environment.GetEnvironmentVariable(name);
            return string.IsNullOrEmpty(v) ? fallback : ParseBool(v, fallback);
        }

        public static string NormalizeUrl(string url)
        {
            string u = string.IsNullOrEmpty(url) ? DefaultRuntimeUrl : url.Trim();
            if (u.StartsWith("/", StringComparison.Ordinal))
            {
                // WebGL + Electron: same-origin relative API base handled by the local server.
                while (u.Length > 1 && u.EndsWith("/", StringComparison.Ordinal))
                {
                    u = u.Substring(0, u.Length - 1);
                }
                return u;
            }
            if (!u.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !u.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                u = "http://" + u;
            }
            while (u.EndsWith("/", StringComparison.Ordinal))
            {
                u = u.Substring(0, u.Length - 1);
            }
            return u;
        }

        public static QualityTier ParseQuality(string value, QualityTier fallback)
        {
            if (string.IsNullOrEmpty(value))
            {
                return fallback;
            }
            switch (value.Trim().ToLowerInvariant())
            {
                case "0":
                case "off":
                case "none":
                    return QualityTier.Off;
                case "1":
                case "low":
                    return QualityTier.Low;
                case "2":
                case "medium":
                case "med":
                    return QualityTier.Medium;
                case "3":
                case "high":
                    return QualityTier.High;
                case "4":
                case "ultra":
                    return QualityTier.Ultra;
                default:
                    Debug.LogWarning("[FCA] Unknown quality '" + value + "', falling back to " + fallback);
                    return fallback;
            }
        }

        static bool ParseBool(string value, bool fallback)
        {
            if (string.IsNullOrEmpty(value))
            {
                return fallback;
            }
            switch (value.Trim().ToLowerInvariant())
            {
                case "1":
                case "true":
                case "yes":
                case "on":
                    return true;
                case "0":
                case "false":
                case "no":
                case "off":
                    return false;
                default:
                    return fallback;
            }
        }

        static float ParseFloat(string value, float fallback)
        {
            float parsed;
            if (!string.IsNullOrEmpty(value) && float.TryParse(value.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out parsed))
            {
                return parsed;
            }
            return fallback;
        }
    }
}
