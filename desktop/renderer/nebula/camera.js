// FCA Memory Atlas — Nebula Renderer
// Orbit camera + projection helpers. World is Z-up: layout x,y ∈ [-5000,5000], z ∈ [-800,800].
import { mat4, clamp, lerp } from './glutil.js';

export class Camera {
  constructor() {
    this.target = [0, 0, 0];
    this.targetGoal = [0, 0, 0];
    this.distance = 12000;
    this.distanceGoal = 12000;
    this.yaw = -0.95;
    this.pitch = 0.52; // radians above the galactic plane（扁平布局下略微俯视才能看到星云展开）
    this.fov = (42 * Math.PI) / 180;
    this.near = 10;
    this.far = 120000;
    this.aspect = 1;
    this.eye = [0, 0, 0];
    this.view = mat4.create();
    this.proj = mat4.create();
    this.viewProj = mat4.create();
    this.invViewProj = mat4.create();
    this._dirty = true;
    this.version = 0;
    this.fit = { center: [0, 0, 0], radius: 3200, distance: 12000 };
  }

  /** Snap camera to fit bounds. padding: extra margin fraction, 0 = tight fit. */
  fitBounds(bounds, padding = 0.15) {
    const cx = (bounds.min[0] + bounds.max[0]) / 2;
    const cy = (bounds.min[1] + bounds.max[1]) / 2;
    const cz = (bounds.min[2] + bounds.max[2]) / 2;
    const dx = bounds.max[0] - bounds.min[0];
    const dy = bounds.max[1] - bounds.min[1];
    const dz = bounds.max[2] - bounds.min[2];
    const radius = Math.max(2200, 0.5 * Math.hypot(dx, dy, dz));
    const fitDistance = (radius * 1.28) / Math.tan(this.fov / 2);
    this.fit = { center: [cx, cy, cz], radius, distance: fitDistance };
    this.target = [cx, cy, cz];
    this.targetGoal = [...this.target];
    const dist = fitDistance * (1.0 + Math.max(0, padding));
    this.distance = dist;
    this.distanceGoal = dist;
    this.markDirty();
  }

  setAspect(w, h) {
    this.aspect = h === undefined ? Math.max(0.01, w) : Math.max(0.01, w / Math.max(1, h));
    this.markDirty();
  }

  setTarget(x, y, z, immediate = false) {
    this.targetGoal = [x, y, z];
    if (immediate) this.target = [x, y, z];
    this.markDirty();
  }

  setZoom(zoom, immediate = false) {
    const z = clamp(Number(zoom) || 1, 0.02, 60);
    const dist = clamp(this.fit.distance / z, 120, 90000);
    this.distanceGoal = dist;
    if (immediate) this.distance = dist;
    this.markDirty();
  }

  /** Fit entire content into view (Desktop "适应屏幕" control). */
  fitToContent(padding = 0) {
    const dist = this.fit.distance * (1.0 + Math.max(0, padding));
    this.targetGoal = [...this.fit.center];
    this.distanceGoal = clamp(dist, 120, 90000);
    this.markDirty();
  }

  get zoom() {
    return this.fit.distance / this.distance;
  }

  panScreen(dxPx, dyPx, viewportH) {
    // Move target along camera right/up so the scene follows the pointer.
    const wpp = (2 * this.distance * Math.tan(this.fov / 2)) / Math.max(1, viewportH);
    const eye = this.eye;
    let rx = this.target[0] - eye[0], ry = this.target[1] - eye[1], rz = this.target[2] - eye[2];
    const len = Math.hypot(rx, ry, rz) || 1;
    rx /= len; ry /= len; rz /= len;
    // right = normalize(cross(forward, upZ))
    const rlen = Math.hypot(ry, -rx) || 1;
    const right = [ry / rlen, -rx / rlen, 0];
    // up = cross(right, forward)
    const up = [
      right[1] * rz - right[2] * ry,
      right[2] * rx - right[0] * rz,
      right[0] * ry - right[1] * rx,
    ];
    this.targetGoal = [
      this.targetGoal[0] - right[0] * dxPx * wpp + up[0] * dyPx * wpp,
      this.targetGoal[1] - right[1] * dxPx * wpp + up[1] * dyPx * wpp,
      this.targetGoal[2] - right[2] * dxPx * wpp + up[2] * dyPx * wpp,
    ];
    this.markDirty();
    return wpp;
  }

  orbit(dxPx, dyPx) {
    this.yaw += dxPx * 0.005;
    this.pitch = clamp(this.pitch + dyPx * 0.004, -1.25, 1.35);
    this.markDirty();
  }

  markDirty() { this._dirty = true; }

  update(dt) {
    // Critically-damped-ish smoothing; instant when dt large (first frame).
    const k = 1 - Math.exp(-Math.min(0.25, dt) * 8.0);
    let changed = false;
    for (let i = 0; i < 3; i++) {
      const d = this.targetGoal[i] - this.target[i];
      if (Math.abs(d) > 0.01) { this.target[i] += d * k; changed = true; }
    }
    const dd = this.distanceGoal - this.distance;
    if (Math.abs(dd) > 0.01) { this.distance += dd * k; changed = true; }
    if (changed) this.markDirty();
    this._recompute();
  }

  setAngles(yaw, pitch) { this.yaw = yaw; this.pitch = clamp(pitch, -1.25, 1.35); this.markDirty(); }

  _recompute() {
    if (!this._dirty) return;
    this._dirty = false;
    this.version++;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.eye = [
      this.target[0] + this.distance * cp * Math.cos(this.yaw),
      this.target[1] + this.distance * cp * Math.sin(this.yaw),
      this.target[2] + this.distance * sp,
    ];
    mat4.lookAt(this.view, this.eye, this.target, [0, 0, 1]);
    mat4.perspective(this.proj, this.fov, this.aspect, this.near, this.far);
    mat4.multiply(this.viewProj, this.proj, this.view);
    mat4.invert(this.invViewProj, this.viewProj);
    this.rayDir = null;
  }

  /** World-space ray direction for normalized screen coords (x,y ∈ [-1,1], y up). */
  rayFromNDC(nx, ny) {
    const a = [nx, ny, -1], b = [nx, ny, 1];
    const pa = mat4.transformPoint([0, 0, 0], this.invViewProj, a[0], a[1], a[2]);
    const pb = mat4.transformPoint([0, 0, 0], this.invViewProj, b[0], b[1], b[2]);
    const d = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    return [d[0] / len, d[1] / len, d[2] / len];
  }

  /** Project world point to CSS pixel coordinates. Returns {x, y, w} (w = clip w > 0 in front). */
  project(x, y, z, width, height) {
    const m = this.viewProj;
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    if (cw <= 1e-6) return { x: 0, y: 0, w: cw, visible: false };
    return {
      x: (cx / cw * 0.5 + 0.5) * width,
      y: (1 - (cy / cw * 0.5 + 0.5)) * height,
      w: cw,
      visible: true,
    };
  }

  /** Pixel size of one world unit at given world position (approx, CSS px). */
  pixelScaleAt(worldPos, height) {
    const cz = this.view[2] * worldPos[0] + this.view[6] * worldPos[1] + this.view[10] * worldPos[2] + this.view[14];
    const depth = Math.max(200, Math.abs(cz));
    return (height * 0.5) / (Math.tan(this.fov / 2) * depth);
  }
}

export { clamp, lerp };
