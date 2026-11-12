// FCA Memory Atlas — Unity Nebula Renderer
// NebulaCameraRig: orbit camera around the galaxy disc. The galaxy lies in the XY plane
// (spiral arms, z = vertical star/dust layer), so the orbit uses a polar frame around +Z.

using UnityEngine;

namespace FCANebula
{
    [RequireComponent(typeof(Camera))]
    public sealed class NebulaCameraRig : MonoBehaviour
    {
        public float MinElevationDeg = -72f;
        public float MaxElevationDeg = 86f;
        public float MinDistance = 120f;
        public float MaxDistance = 2600f;
        public float OrbitSensitivity = 0.22f;
        public float ZoomSensitivity = 0.12f;
        public float Damping = 9f;

        Camera _camera;
        UiOverlay _ui;
        bool _initialized;
        bool _blockInput;

        Vector3 _target = Vector3.zero;
        float _azimuthDeg = -90f;
        float _elevationDeg = 17f;
        float _distance = 820f;

        float _targetAzimuthDeg = -90f;
        float _targetElevationDeg = 17f;
        float _targetDistance = 820f;
        Vector3 _targetTarget = Vector3.zero;

        bool _dragging;
        Vector3 _lastMouse;

        float _autoRotateDegPerSec = 1.2f;

        public Camera Camera { get { return _camera; } }
        public Vector3 FocusPoint { get { return _target; } }

        public void Initialize(AppConfig config, Camera camera)
        {
            _camera = camera != null ? camera : GetComponent<Camera>();
            _initialized = true;
            _autoRotateDegPerSec = config != null ? config.AutoRotateDegPerSec : 0f;
            if (_camera != null)
            {
                _camera.clearFlags = CameraClearFlags.SolidColor;
                _camera.backgroundColor = Color.black;
                _camera.nearClipPlane = 0.5f;
                _camera.farClipPlane = 5000f;
                _camera.fieldOfView = 52f;
                _camera.allowHDR = true;
                _camera.allowMSAA = false;
            }
        }

        public void SetUiOverlay(UiOverlay ui)
        {
            _ui = ui;
        }

        public void SetBlockInput(bool blocked)
        {
            _blockInput = blocked;
            if (blocked)
            {
                _dragging = false;
            }
        }

        public void SetAutoRotate(float degreesPerSecond)
        {
            _autoRotateDegPerSec = degreesPerSecond;
        }

        void Update()
        {
            if (!_initialized || _camera == null)
            {
                return;
            }
            HandleInput();
            if (Mathf.Abs(_autoRotateDegPerSec) > 0.0001f && !_dragging && !_blockInput)
            {
                _targetAzimuthDeg += _autoRotateDegPerSec * Time.unscaledDeltaTime;
            }
            float k = 1f - Mathf.Exp(-Damping * Time.unscaledDeltaTime);
            _azimuthDeg = Mathf.Lerp(_azimuthDeg, _targetAzimuthDeg, k);
            _elevationDeg = Mathf.Lerp(_elevationDeg, _targetElevationDeg, k);
            _distance = Mathf.Lerp(_distance, _targetDistance, k);
            _target = Vector3.Lerp(_target, _targetTarget, k);
            ApplyTransform();
        }

        void HandleInput()
        {
            if (_blockInput)
            {
                return;
            }
            bool overUi = _ui != null && _ui.PointerOverUi;
            Vector3 mouse = Input.mousePosition;

            if (Input.GetMouseButtonDown(0) && !overUi)
            {
                _dragging = true;
                _lastMouse = mouse;
            }
            if (Input.GetMouseButtonUp(0))
            {
                _dragging = false;
            }
            if (_dragging)
            {
                Vector3 delta = mouse - _lastMouse;
                _lastMouse = mouse;
                if (Mathf.Abs(delta.x) > 0.01f || Mathf.Abs(delta.y) > 0.01f)
                {
                    _targetAzimuthDeg -= delta.x * OrbitSensitivity;
                    _targetElevationDeg = Mathf.Clamp(_targetElevationDeg + delta.y * OrbitSensitivity * 0.8f, MinElevationDeg, MaxElevationDeg);
                }
            }

            if (!overUi && !_camera.orthographic)
            {
                float scroll = Input.GetAxis("Mouse ScrollWheel");
                if (Mathf.Abs(scroll) > 0.0001f)
                {
                    _targetDistance = Mathf.Clamp(_targetDistance * (1f - scroll * ZoomSensitivity * 10f), MinDistance, MaxDistance);
                }
            }
        }

        void ApplyTransform()
        {
            float az = _azimuthDeg * Mathf.Deg2Rad;
            float el = _elevationDeg * Mathf.Deg2Rad;
            float cosEl = Mathf.Cos(el);
            Vector3 offset = new Vector3(Mathf.Cos(az) * cosEl, Mathf.Sin(az) * cosEl, Mathf.Sin(el)) * _distance;
            Vector3 position = _target + offset;
            Vector3 forward = (_target - position).normalized;
            // Up vector = tangent of the orbit towards +elevation. This keeps the galaxy disc
            // horizontal for every azimuth and stays valid at near top-down elevations.
            Vector3 up = new Vector3(-Mathf.Sin(el) * Mathf.Cos(az), -Mathf.Sin(el) * Mathf.Sin(az), Mathf.Cos(el));
            if (up.sqrMagnitude < 0.0001f)
            {
                up = Vector3.forward;
            }
            _camera.transform.position = position;
            _camera.transform.rotation = Quaternion.LookRotation(forward, up.normalized);
        }

        /// <summary>Frame the whole spiral disc after a graph update.</summary>
        public void FrameLayout(LayoutModel layout)
        {
            if (layout == null)
            {
                return;
            }
            _targetTarget = Vector3.zero;
            if (_lastFramedSignature == layout.Signature)
            {
                return; // same workspace set: keep the user's current view
            }
            _lastFramedSignature = layout.Signature;
            float radius = Mathf.Max(180f, layout.MaxRadius);
            _targetDistance = Mathf.Clamp(radius * 1.8f, 380f, MaxDistance);
            _targetElevationDeg = 27f;
        }

        string _lastFramedSignature;

        /// <summary>Instant camera pose for deterministic screenshots. Preset 0..2.</summary>
        public void ApplyPreset(int index, LayoutModel layout)
        {
            if (_camera == null)
            {
                return;
            }
            float radius = layout != null ? Mathf.Max(180f, layout.MaxRadius) : 500f;
            _targetTarget = Vector3.zero;
            switch (index)
            {
                case 1:
                    {
                        LayoutArm arm = null;
                        LayoutArm namedArm = null;
                        if (layout != null)
                        {
                            for (int i = 0; i < layout.Arms.Count; i++)
                            {
                                LayoutArm candidate = layout.Arms[i];
                                if (candidate.NodeCount <= 0)
                                {
                                    continue;
                                }
                                if (!candidate.IsDefault && (namedArm == null || candidate.NodeCount > namedArm.NodeCount))
                                {
                                    namedArm = candidate;
                                }
                                if (arm == null || candidate.NodeCount > arm.NodeCount)
                                {
                                    arm = candidate;
                                }
                            }
                        }
                        if (namedArm != null)
                        {
                            arm = namedArm; // showcase a real workspace arm, not the catch-all
                        }
                        if (arm != null)
                        {
                            _targetTarget = new Vector3(arm.Centroid.x * 0.65f, arm.Centroid.y * 0.65f, 0f);
                            float centroidAngle = Mathf.Atan2(arm.Centroid.y, arm.Centroid.x) * Mathf.Rad2Deg;
                            _targetAzimuthDeg = centroidAngle - 38f;
                            _targetElevationDeg = 30f;
                            _targetDistance = Mathf.Clamp(arm.Spread * 2.1f + 210f, 240f, 850f);
                        }
                        break;
                    }
                case 2:
                    _targetAzimuthDeg = -90f;
                    _targetElevationDeg = 84f;
                    _targetDistance = Mathf.Clamp(radius * 1.95f, 420f, MaxDistance);
                    break;
                default:
                    _targetAzimuthDeg = -90f;
                    _targetElevationDeg = 27f;
                    _targetDistance = Mathf.Clamp(radius * 1.8f, 380f, MaxDistance);
                    break;
            }
            _azimuthDeg = _targetAzimuthDeg;
            _elevationDeg = _targetElevationDeg;
            _distance = _targetDistance;
            _target = _targetTarget;
            ApplyTransform();
        }

        /// <summary>Fly to a node (double click / F key).</summary>
        public void FocusOnNode(LayoutNode node)
        {
            if (node == null)
            {
                return;
            }
            _targetTarget = node.Position;
            _targetDistance = Mathf.Clamp(_targetDistance * 0.55f, MinDistance, 620f);
        }

        public void ResetView()
        {
            _targetTarget = Vector3.zero;
            _targetAzimuthDeg = -90f;
            _targetElevationDeg = 17f;
            _targetDistance = 820f;
        }
    }
}
