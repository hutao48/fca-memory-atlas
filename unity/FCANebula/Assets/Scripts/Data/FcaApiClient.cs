// FCA Memory Atlas — Unity Nebula Renderer
// FcaApiClient: reads GET /api/v1/graph + /api/v1/state from the local FCA Runtime with a
// Bearer token, polls on an interval, and fetches memory detail for the inspector panel.
// No fabricated data: sample data is only ever used in an explicitly marked sample mode.

using System;
using System.Collections;
using System.Globalization;
using System.IO;
using UnityEngine;
using UnityEngine.Networking;

namespace FCANebula
{
    public enum ConnectionState
    {
        Initializing = 0,
        Connecting = 1,
        Online = 2,
        Sample = 3,
        Offline = 4
    }

    public sealed class FcaApiClient : MonoBehaviour
    {
        public event Action<GraphModel> GraphUpdated;
        public event Action<ConnectionState, string> StatusChanged;
        public event Action<FcaStateDto> StateUpdated;

        AppConfig _config;
        bool _running;
        bool _initialized;
        string _token;
        string _tokenError;
        bool _tokenLoaded;
        string _tokenFileResolved;
        ConnectionState _state = ConnectionState.Initializing;
        string _statusMessage = "启动中";
        string _lastError;
        float _lastSuccessRealtime = -1f;
        int _consecutiveFailures;
        bool _refreshRequested;
        bool _sampleLoaded;
        bool _stateFetched;
        Coroutine _pollCoroutine;

        public ConnectionState State { get { return _state; } }
        public string StatusMessage { get { return _statusMessage; } }
        public string LastError { get { return _lastError; } }
        public bool HasGraph { get; private set; }
        public bool IsSampleData { get; private set; }
        public GraphModel LatestGraph { get; private set; }
        public FcaStateDto CurrentState { get; private set; }
        public int ConsecutiveFailures { get { return _consecutiveFailures; } }
        public int SuccessfulUpdates { get; private set; }
        public string RuntimeUrl { get { return _config != null ? _config.RuntimeUrl : AppConfig.DefaultRuntimeUrl; } }
        public bool TokenAvailable { get { return _tokenLoaded; } }
        public string TokenError { get { return _tokenError; } }

        public string TokenFileResolved
        {
            get
            {
                if (_config == null)
                {
                    return "";
                }
                if (!string.IsNullOrEmpty(_tokenFileResolved))
                {
                    return _tokenFileResolved;
                }
                _tokenFileResolved = _config.ResolveTokenFile();
                return _tokenFileResolved;
            }
        }

        public float SecondsSinceSuccess
        {
            get
            {
                if (_lastSuccessRealtime < 0f)
                {
                    return -1f;
                }
                return Mathf.Max(0f, Time.realtimeSinceStartup - _lastSuccessRealtime);
            }
        }

        public void Initialize(AppConfig config)
        {
            if (_initialized)
            {
                return;
            }
            _config = config;
            if (_config == null)
            {
                _config = AppConfig.Current;
            }
            _initialized = true;
            ReloadToken();
            Debug.Log("[FCA] API client: runtime=" + _config.RuntimeUrl + " token=" + MaskPath(TokenFileResolved) + " poll=" + _config.PollSeconds.ToString("0.0", CultureInfo.InvariantCulture) + "s quality=" + _config.Profile.Key);
        }

        public void StartPolling()
        {
            if (!_initialized)
            {
                Initialize(AppConfig.Current);
            }
            if (_running)
            {
                return;
            }
            _running = true;
            _pollCoroutine = StartCoroutine(PollLoop());
        }

        public void StopPolling()
        {
            _running = false;
            if (_pollCoroutine != null)
            {
                StopCoroutine(_pollCoroutine);
                _pollCoroutine = null;
            }
        }

        /// <summary>Ask the poll loop to refresh as soon as possible (keyboard R).</summary>
        public void RequestRefreshNow()
        {
            _refreshRequested = true;
        }

        public void ReloadToken()
        {
            _tokenLoaded = false;
            _token = null;
            _tokenError = null;
            _tokenFileResolved = null;
            if (_config == null)
            {
                _tokenError = "配置未初始化";
                return;
            }
            if (!string.IsNullOrEmpty(_config.DirectToken))
            {
                _token = _config.DirectToken.Trim();
                _tokenLoaded = _token.Length > 0;
                if (!_tokenLoaded)
                {
                    _tokenError = "--token 为空";
                }
                return;
            }
#if UNITY_WEBGL && !UNITY_EDITOR
            _tokenError = "WebGL: token 需由页面 URL query 提供（Electron 注入 ?token=...）";
            return;
#else
            string path = _config.ResolveTokenFile();
            _tokenFileResolved = path;
            if (string.IsNullOrEmpty(path))
            {
                _tokenError = "未找到 runtime-token 路径";
                return;
            }
            try
            {
                if (!File.Exists(path))
                {
                    _tokenError = "token 文件不存在: " + path;
                    return;
                }
                string raw = File.ReadAllText(path).Trim();
                if (string.IsNullOrEmpty(raw))
                {
                    _tokenError = "token 文件为空: " + path;
                    return;
                }
                _token = raw;
                _tokenLoaded = true;
            }
            catch (Exception ex)
            {
                _tokenError = "读取 token 失败: " + ex.Message;
            }
#endif
        }

        // -----------------------------------------------------------------
        // Polling
        // -----------------------------------------------------------------

        IEnumerator PollLoop()
        {
            while (_running)
            {
                yield return FetchGraphRoutine();

                if (_consecutiveFailures == 0)
                {
                    if (!_stateFetched)
                    {
                        yield return FetchStateRoutine();
                    }
                    float wait = Mathf.Max(0.5f, _config.PollSeconds);
                    yield return WaitWithRefresh(wait);
                }
                else
                {
                    float backoff = Mathf.Min(30f, Mathf.Max(_config.PollSeconds, Mathf.Pow(2f, Mathf.Min(_consecutiveFailures, 4))));
                    yield return WaitWithRefresh(backoff);
                }
            }
        }

        IEnumerator WaitWithRefresh(float seconds)
        {
            float remaining = seconds;
            while (_running && remaining > 0f)
            {
                if (_refreshRequested)
                {
                    break;
                }
                yield return null;
                remaining -= Time.unscaledDeltaTime;
            }
        }

        IEnumerator FetchGraphRoutine()
        {
            string url = _config.RuntimeUrl + "/api/v1/graph";
            string raw = null;
            string error = null;

            if (!EnsureToken(out error))
            {
                HandleGraphFailure(error);
                yield break;
            }

            for (int attempt = 0; attempt < 2; attempt++)
            {
                if (_config.LogRequests)
                {
                    Debug.Log("[FCA] GET " + url + (attempt > 0 ? " (token retry)" : ""));
                }
                UnityWebRequest request = UnityWebRequest.Get(url);
                request.timeout = 20;
                request.SetRequestHeader("Authorization", "Bearer " + _token);
                request.SetRequestHeader("Accept", "application/json");
                yield return request.SendWebRequest();

                bool unauthorized = request.responseCode == 401;
                if (request.result == UnityWebRequest.Result.Success)
                {
                    raw = request.downloadHandler.text;
                    request.Dispose();
                    break;
                }

                error = DescribeFailure(request);
                request.Dispose();

                if (unauthorized && attempt == 0)
                {
                    // Token may have rotated on disk; reload and retry once.
                    ReloadToken();
                    if (!EnsureToken(out error))
                    {
                        break;
                    }
                    continue;
                }
                break;
            }

            if (string.IsNullOrEmpty(raw))
            {
                HandleGraphFailure(error);
                yield break;
            }

            FcaGraphDto dto;
            try
            {
                dto = JsonUtility.FromJson<FcaGraphDto>(raw);
            }
            catch (Exception ex)
            {
                HandleGraphFailure("graph JSON 解析失败: " + ex.Message);
                yield break;
            }
            if (dto == null || dto.nodes == null)
            {
                HandleGraphFailure("graph 响应缺少 nodes 字段");
                yield break;
            }

            GraphModel model;
            try
            {
                model = GraphModel.FromDto(dto);
            }
            catch (Exception ex)
            {
                HandleGraphFailure("graph 数据转换失败: " + ex.Message);
                yield break;
            }

            bool wasSample = IsSampleData;
            LatestGraph = model;
            HasGraph = true;
            IsSampleData = false;
            _consecutiveFailures = 0;
            _lastSuccessRealtime = Time.realtimeSinceStartup;
            SuccessfulUpdates++;
            _lastError = null;
            SetState(ConnectionState.Online, "已连接 Runtime");
            if (wasSample)
            {
                Debug.Log("[FCA] Live graph replaced offline sample data.");
            }
            GraphUpdated?.Invoke(model);
        }

        IEnumerator FetchStateRoutine()
        {
            string error;
            if (!EnsureToken(out error))
            {
                yield break;
            }
            string url = _config.RuntimeUrl + "/api/v1/state";
            UnityWebRequest request = UnityWebRequest.Get(url);
            request.timeout = 10;
            request.SetRequestHeader("Authorization", "Bearer " + _token);
            request.SetRequestHeader("Accept", "application/json");
            yield return request.SendWebRequest();
            if (request.result != UnityWebRequest.Result.Success)
            {
                string failure = DescribeFailure(request);
                request.Dispose();
                Debug.LogWarning("[FCA] GET /api/v1/state 失败: " + failure);
                yield break;
            }
            string raw = request.downloadHandler.text;
            request.Dispose();
            try
            {
                FcaStateDto state = JsonUtility.FromJson<FcaStateDto>(raw);
                if (state != null)
                {
                    CurrentState = state;
                    _stateFetched = true;
                    StateUpdated?.Invoke(state);
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[FCA] state JSON 解析失败: " + ex.Message);
            }
        }

        void HandleGraphFailure(string error)
        {
            _consecutiveFailures++;
            _lastError = string.IsNullOrEmpty(error) ? "未知错误" : error;
            Debug.LogWarning("[FCA] graph 拉取失败 (#" + _consecutiveFailures + "): " + _lastError);

            if (!HasGraph && CanUseSample())
            {
                if (TryLoadSample(_lastError))
                {
                    return;
                }
            }
            SetState(ConnectionState.Offline, _lastError);
        }

        bool CanUseSample()
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            return false; // WebGL cannot read StreamingAssets JSON synchronously
#else
            // Standalone builds only fall back to sample data when explicitly allowed.
            // The Editor also allows it so the scene can be previewed without a Runtime,
            // but the HUD always shows a red SAMPLE banner in that case.
            return _config != null && (_config.AllowSample || Application.isEditor);
#endif
        }

        bool TryLoadSample(string reason)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            return false;
#else
            if (_sampleLoaded)
            {
                return false;
            }
            if (string.IsNullOrEmpty(_config.SamplePath) || !File.Exists(_config.SamplePath))
            {
                return false;
            }
            try
            {
                string raw = File.ReadAllText(_config.SamplePath);
                FcaGraphDto dto = JsonUtility.FromJson<FcaGraphDto>(raw);
                if (dto == null || dto.nodes == null)
                {
                    return false;
                }
                GraphModel model = GraphModel.FromDto(dto);
                _sampleLoaded = true;
                LatestGraph = model;
                HasGraph = true;
                IsSampleData = true;
                _tokenError = string.IsNullOrEmpty(_tokenError) ? reason : _tokenError;
                Debug.LogWarning("[FCA] 使用离线样例数据 (SAMPLE, 非实时): " + _config.SamplePath + " | 原因: " + reason);
                SetState(ConnectionState.Sample, "SAMPLE 数据 · 非实时（" + reason + "）");
                GraphUpdated?.Invoke(model);
                return true;
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[FCA] 读取样例数据失败: " + ex.Message);
                return false;
            }
#endif
        }

        // -----------------------------------------------------------------
        // Memory detail (click-through inspector)
        // -----------------------------------------------------------------

        public void FetchMemory(string memoryId, Action<MemoryInfo> onSuccess, Action<string> onError)
        {
            if (string.IsNullOrEmpty(memoryId))
            {
                if (onError != null)
                {
                    onError("节点 id 为空");
                }
                return;
            }
            if (_config == null)
            {
                if (onError != null)
                {
                    onError("API 未初始化");
                }
                return;
            }
            StartCoroutine(FetchMemoryRoutine(memoryId, onSuccess, onError));
        }

        IEnumerator FetchMemoryRoutine(string memoryId, Action<MemoryInfo> onSuccess, Action<string> onError)
        {
            string error;
            if (!EnsureToken(out error))
            {
                if (onError != null)
                {
                    onError(error);
                }
                yield break;
            }
            string url = _config.RuntimeUrl + "/api/v1/memory/" + Uri.EscapeDataString(memoryId);
            UnityWebRequest request = UnityWebRequest.Get(url);
            request.timeout = 15;
            request.SetRequestHeader("Authorization", "Bearer " + _token);
            request.SetRequestHeader("Accept", "application/json");
            yield return request.SendWebRequest();
            if (request.result != UnityWebRequest.Result.Success)
            {
                string failure = DescribeFailure(request);
                request.Dispose();
                if (onError != null)
                {
                    onError(failure);
                }
                yield break;
            }
            string raw = request.downloadHandler.text;
            request.Dispose();
            FcaMemoryDetailDto dto;
            try
            {
                dto = JsonUtility.FromJson<FcaMemoryDetailDto>(raw);
            }
            catch (Exception ex)
            {
                if (onError != null)
                {
                    onError("记忆详情解析失败: " + ex.Message);
                }
                yield break;
            }
            MemoryInfo info = MemoryInfo.FromDetailDto(dto);
            if (info == null)
            {
                if (onError != null)
                {
                    onError("记忆详情为空");
                }
                yield break;
            }
            if (onSuccess != null)
            {
                onSuccess(info);
            }
        }

        // -----------------------------------------------------------------
        // Helpers
        // -----------------------------------------------------------------

        bool EnsureToken(out string error)
        {
            error = null;
            if (!_tokenLoaded || string.IsNullOrEmpty(_token))
            {
                ReloadToken();
            }
            if (_tokenLoaded && !string.IsNullOrEmpty(_token))
            {
                return true;
            }
            error = string.IsNullOrEmpty(_tokenError) ? "未找到 Bearer token" : _tokenError;
            return false;
        }

        void SetState(ConnectionState state, string message)
        {
            bool changed = _state != state || !string.Equals(_statusMessage, message, StringComparison.Ordinal);
            _state = state;
            _statusMessage = string.IsNullOrEmpty(message) ? state.ToString() : message;
            if (changed)
            {
                StatusChanged?.Invoke(_state, _statusMessage);
            }
        }

        static string DescribeFailure(UnityWebRequest request)
        {
            if (request == null)
            {
                return "请求为空";
            }
            if (request.responseCode > 0)
            {
                return "HTTP " + request.responseCode.ToString(CultureInfo.InvariantCulture) + (string.IsNullOrEmpty(request.error) ? "" : " · " + request.error);
            }
            if (request.result == UnityWebRequest.Result.ConnectionError)
            {
                return "无法连接 Runtime: " + request.error;
            }
            return string.IsNullOrEmpty(request.error) ? "请求失败" : request.error;
        }

        void OnDestroy()
        {
            StopPolling();
        }

        static string MaskPath(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return "(未找到)";
            }
            if (path.Length <= 12)
            {
                return path;
            }
            return "…" + path.Substring(path.Length - 12);
        }
    }
}
