// FCA Memory Atlas — Nebula Renderer
// Deep-space background: procedural faint star fields (3 parallax depths), bright hero stars as
// clean sprite points (gaussian halo + diffraction spikes), galactic band + dust lanes, faint galaxies.
// Orientation & tints are derived from the graph clusters (PCA band normal + dominant color hints).
import { Fullscreen, Program, createVAO, buffer, mulberry32 } from './glutil.js';
import { BG_FS, BRIGHT_STAR_VS, BRIGHT_STAR_FS } from './shaders.js';

const MAX_BRIGHT_STARS = 220;
const STAR_RADIUS = 60000;

export class BackgroundPass {
  constructor(gl) {
    this.gl = gl;
    this.fs = new Fullscreen(gl, BG_FS, 'background');
    this.starProg = new Program(gl, BRIGHT_STAR_VS, BRIGHT_STAR_FS, 'bright-stars');
    this.starDirBuf = gl.createBuffer();
    this.starDataBuf = gl.createBuffer();
    this.starCount = 0;
    this.starVAO = createVAO(gl, [
      { buffer: this.starDirBuf, loc: 0, size: 3 },
      { buffer: this.starDataBuf, loc: 1, size: 4 },
    ]);
    this.starSeed = 1;
    this.band = [0.31, -0.26, 0.914];
    this.tintA = [0.05, 0.13, 0.22];
    this.tintB = [0.16, 0.12, 0.22];
  }

  /** Derive band orientation & tints from cluster set + graph hash (data-driven, deterministic). */
  configure(clusters, seed) {
    this.starSeed = 1 + (seed % 9973) * 0.0137;
    this._buildStars(seed >>> 0);
    if (!clusters || clusters.length === 0) {
      this.band = [0.31, -0.26, 0.914];
      this.tintA = [0.045, 0.10, 0.20];
      this.tintB = [0.14, 0.10, 0.19];
      return;
    }
    // weighted covariance of cluster centroids -> normal of best-fit plane = galactic band normal
    let sx = 0, sy = 0, sz = 0, sw = 0;
    for (const c of clusters) {
      const w = 0.25 + c.density * Math.sqrt(c.count ?? (c.node_ids ? c.node_ids.length : 1));
      sx += c.centroid.x * w; sy += c.centroid.y * w; sz += c.centroid.z * w; sw += w;
    }
    const cx = sx / sw, cy = sy / sw, cz = sz / sw;
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (const c of clusters) {
      const w = 0.25 + c.density * Math.sqrt(c.count ?? (c.node_ids ? c.node_ids.length : 1));
      const dx = c.centroid.x - cx, dy = c.centroid.y - cy, dz = c.centroid.z - cz;
      xx += dx * dx * w; xy += dx * dy * w; xz += dx * dz * w;
      yy += dy * dy * w; yz += dy * dz * w; zz += dz * dz * w;
    }
    const tr = xx + yy + zz;
    const m = [tr - xx, -xy, -xz, -xy, tr - yy, -yz, -xz, -yz, tr - zz];
    let v = [0.15, 0.12, 1.0];
    for (let i = 0; i < 24; i++) {
      const nx = m[0] * v[0] + m[1] * v[1] + m[2] * v[2];
      const ny = m[3] * v[0] + m[4] * v[1] + m[5] * v[2];
      const nz = m[6] * v[0] + m[7] * v[1] + m[8] * v[2];
      const len = Math.hypot(nx, ny, nz) || 1;
      v = [nx / len, ny / len, nz / len];
    }
    if (Math.abs(v[2]) < 0.35) v[2] = Math.sign(v[2] || 1) * 0.35;
    const n = Math.hypot(v[0], v[1], v[2]) || 1;
    this.band = [v[0] / n, v[1] / n, v[2] / n];
    // tints: dominant cluster hue (cool) + strongest different hue (accent)
    const sorted = [...clusters].sort((a, b) => (b.count || 0) - (a.count || 0));
    const hueOf = (c) => c.linearColor || [0.08, 0.14, 0.24];
    this.tintA = scale(hueOf(sorted[0]), 0.65);
    let best = sorted[1] || sorted[0];
    let bestScore = -1;
    for (const c of sorted.slice(1, 5)) {
      const a = hueOf(sorted[0]), b2 = hueOf(c);
      const d = Math.abs(a[0] - b2[0]) + Math.abs(a[2] - b2[2]) + Math.abs(a[1] - b2[1]);
      if (d > bestScore) { bestScore = d; best = c; }
    }
    this.tintB = scale(hueOf(best), 0.8);
  }

  _buildStars(seed) {
    const rand = mulberry32((seed ^ 0x9e3779b9) >>> 0);
    const dirs = new Float32Array(MAX_BRIGHT_STARS * 3);
    const data = new Float32Array(MAX_BRIGHT_STARS * 4);
    let n = 0;
    for (let i = 0; i < MAX_BRIGHT_STARS; i++) {
      const z = rand() * 2 - 1;
      const phi = rand() * Math.PI * 2;
      const rr = Math.sqrt(Math.max(0, 1 - z * z));
      dirs[i * 3] = Math.cos(phi) * rr;
      dirs[i * 3 + 1] = Math.sin(phi) * rr;
      dirs[i * 3 + 2] = z;
      const u = rand();
      // long-tail magnitude distribution: many faint, few hero stars
      let size, bright;
      if (u < 0.62) { size = 1.0 + rand() * 1.4; bright = 0.10 + rand() * 0.22; }
      else if (u < 0.88) { size = 2.0 + rand() * 2.2; bright = 0.35 + rand() * 0.5; }
      else if (u < 0.98) { size = 3.4 + rand() * 3.4; bright = 0.9 + rand() * 0.8; }
      else { size = 6.0 + rand() * 6.0; bright = 1.8 + rand() * 1.8; }
      // bias hero stars toward the galactic band so they sit inside the nebula
      if (u > 0.88) {
        const bd = dot3(dirs, i, this.band);
        const keep = 0.35 + 0.65 * Math.exp(-bd * bd * 5.0);
        bright *= 0.5 + keep;
      }
      data[i * 4] = size;
      data[i * 4 + 1] = bright;
      data[i * 4 + 2] = rand() * 2 - 1;
      data[i * 4 + 3] = rand();
      n++;
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.starDirBuf);
    gl.bufferData(gl.ARRAY_BUFFER, dirs, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.starDataBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.starCount = n;
  }

  draw(target, { camera, mapping, time, quality, width, height, pixelRatio = 1 }) {
    const gl = this.gl;
    const tw = target ? target.w : width;
    const th = target ? target.h : height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, tw, th);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    this.fs.draw({
      uInvViewProj: camera.invViewProj,
      uCamPos: camera.eye,
      uBandNormal: this.band,
      uTintA: this.tintA,
      uTintB: this.tintB,
      uTime: time,
      uBandIntensity: mapping.bandIntensity * (quality === 'off' ? 0 : 1),
      uStarDensity: mapping.starDensity,
      uStarSeed: this.starSeed,
      uYaw: camera.yaw,
      uPitch: camera.pitch,
      uResolution: [tw, th],
    });
  }

  /** Bright hero stars (additive sprite points; drawn after the faint star field). */
  drawBrightStars(target, { camera, mapping, pixelRatio = 1, count = MAX_BRIGHT_STARS }) {
    if (!this.starCount) return 0;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.w : gl.canvas.width, target ? target.h : gl.canvas.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.starProg.use();
    this.starProg.setAll({
      uViewProj: camera.viewProj,
      uCamPos: camera.eye,
      uRadius: STAR_RADIUS,
      uPixelRatio: pixelRatio,
    });
    gl.bindVertexArray(this.starVAO);
    const n = Math.min(this.starCount, Math.max(0, count), Math.min(MAX_BRIGHT_STARS, mapping.starDensity > 0 ? MAX_BRIGHT_STARS : 0));
    gl.drawArrays(gl.POINTS, 0, n);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    return 1;
  }

  dispose() {
    const gl = this.gl;
    this.fs.dispose(); this.starProg.dispose();
    gl.deleteBuffer(this.starDirBuf); gl.deleteBuffer(this.starDataBuf);
    gl.deleteVertexArray(this.starVAO);
  }
}

function scale(c, k) { return [c[0] * k, c[1] * k, c[2] * k]; }
function dot3(arr, i, v) { return arr[i * 3] * v[0] + arr[i * 3 + 1] * v[1] + arr[i * 3 + 2] * v[2]; }
