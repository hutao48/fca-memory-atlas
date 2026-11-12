// FCA Memory Atlas — Nebula Renderer
// 方案 B (comparison pipeline): CPU-precomputed 2D nebula texture + background star field + glow nodes.
// The gas field is baked once from the same cluster emitters on the CPU (RGBA16F upload), then drawn as
// a flat world plane. It is intentionally *flat*: that difference (no volume parallax / no depth dust)
// is what the A/B comparison in docs/NEBULA_RENDERER.md measures.
import { Program, createVAO, buffer } from './glutil.js';
import { hexToLinear } from './palette.js';
import { BAKED_VS, BAKED_FS } from './shaders.js';

const TEX_W = 768, TEX_H = 768;

/** fast 2D value noise (CPU analogue of the GPU fbm used by the volume pass) */
function hash2(ix, iy) {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let fx = x - xi, fy = y - yi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  const ab = a + (b - a) * fx, cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}
function fbm2(x, y, oct) {
  let s = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise2(x, y); n += a;
    x = x * 2.03 + 5.3; y = y * 2.02 + 1.7; a *= 0.5;
  }
  return s / n;
}

export class BakedNebula {
  constructor(gl, hdr) {
    this.gl = gl;
    this.hdr = hdr;
    this.prog = new Program(gl, BAKED_VS, BAKED_FS, 'baked-plane');
    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    this.quadBuf = buffer(gl, quad, gl.STATIC_DRAW);
    this.vao = createVAO(gl, [{ buffer: this.quadBuf, loc: 0, size: 2, divisor: 0 }]);
    this.tex = null;
    this.pixels = null;
    this.bakeMs = 0;
    this.plane = null;
    this.ready = false;
  }

  /** Bake the flat gas texture for the given clusters. Returns bake time in ms. (CPU cost is real: reported.) */
  bake(clusters, bounds, mapping) {
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    if (!clusters || clusters.length === 0) {
      this.ready = false;
      this.bakeMs = 0;
      return 0;
    }
    const pad = 0.06;
    const dx = Math.max(800, bounds.max[0] - bounds.min[0]);
    const dy = Math.max(800, bounds.max[1] - bounds.min[1]);
    const cx = (bounds.min[0] + bounds.max[0]) / 2;
    const cy = (bounds.min[1] + bounds.max[1]) / 2;
    const ex = (dx * (1 + pad)) / 2, ey = (dy * (1 + pad)) / 2;
    this.plane = { center: [cx, cy, 0], extent: [ex, ey], z: 0 };
    const W = TEX_W, H = TEX_H;
    if (!this.pixels) this.pixels = new Float32Array(W * H * 4);
    const px = this.pixels;
    px.fill(0);
    const scale = 1 / Math.max(ex, ey);
    const gasScale = mapping.gasScale || 1;
    const cl = clusters.map((c) => ({
      x: c.centroid.x, y: c.centroid.y,
      ix: c.invScale[0], iy: c.invScale[1],
      inten: c.intensity,
      color: hexToLinear(c._hintHex || '#4d7fe6'),
      sx: 1 / Math.max(1e-5, c.invScale[0]), sy: 1 / Math.max(1e-5, c.invScale[1]),
    }));
    const worldX = new Float32Array(W);
    for (let i = 0; i < W; i++) worldX[i] = cx - ex + (2 * ex * (i + 0.5)) / W;

    for (let j = 0; j < H; j++) {
      const wy = cy - ey + (2 * ey * (j + 0.5)) / H;
      for (let i = 0; i < W; i++) {
        const wx = worldX[i];
        const nx = wx * scale, ny = wy * scale;
        // cluster emission field with per-cluster bounds rejection (matches volume pass kernels)
        let dens = 0;
        let cr = 0, cg = 0, cb = 0;
        for (let k = 0; k < cl.length; k++) {
          const c = cl[k];
          const ddx = (wx - c.x) * c.ix, ddy = (wy - c.y) * c.iy;
          const q2 = ddx * ddx + ddy * ddy;
          if (q2 > 7.0) continue;
          const g = Math.exp(-q2 * 0.72) * c.inten;
          dens += g;
          cr += c.color[0] * g; cg += c.color[1] * g; cb += c.color[2] * g;
        }
        if (dens <= 0.001) continue;
        // domain-warped fbm structure (2 octaves fewer than GPU: this is the cheap plan B)
        const w1 = fbm2(nx * 0.9 + 2.1, ny * 0.9 + 7.3, 3) - 0.5;
        const w2 = fbm2(nx * 0.9 + 9.7, ny * 0.9 + 3.1, 3) - 0.5;
        const large = fbm2(nx * 1.35 + w1 * 0.9, ny * 1.35 + w2 * 0.9, 4);
        const fil = fbm2(nx * 3.1 + w1 * 1.2, ny * 3.1 + w2 * 1.2, 3);
        let gas = smoothstep(0.34, 0.80, large * 0.66 + fil * 0.34) * gasScale;
        gas *= 0.45 + 0.85 * smoothstep(0.30, 0.78, fil);
        const dust = smoothstep(0.48, 0.86, fbm2(nx * 6.0 + w1, ny * 6.0 + w2, 3));
        const emitScale = 0.16 * (mapping.nebulaIntensity || 1);
        const r = (cr / dens) * dens * gas * emitScale;
        const g = (cg / dens) * dens * gas * emitScale;
        const b = (cb / dens) * dens * gas * emitScale;
        const alpha = Math.min(0.96, (1 - Math.exp(-dens * gas * 1.35)) + dust * 0.12);
        const dustMul = 1 - dust * 0.42 * (mapping.dustStrength || 1);
        const o = (j * W + i) * 4;
        px[o] = r * dustMul;
        px[o + 1] = g * dustMul;
        px[o + 2] = b * dustMul;
        px[o + 3] = alpha;
      }
    }
    this._upload(W, H);
    this.ready = true;
    this.bakeMs = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
    return this.bakeMs;
  }

  _upload(W, H) {
    const gl = this.gl;
    if (!this.tex) this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.hdr) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, W, H, 0, gl.RGBA, gl.FLOAT, this.pixels);
    } else {
      // clamp to LDR fallback
      const ldr = new Uint8Array(W * H * 4);
      for (let i = 0; i < ldr.length; i++) ldr[i] = Math.max(0, Math.min(255, Math.round(this.pixels[i] * 255)));
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, ldr);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  draw(sceneTarget, camera, opts) {
    if (!this.ready || !this.tex) return 0;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneTarget.fbo);
    gl.viewport(0, 0, sceneTarget.w, sceneTarget.h);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    this.prog.use();
    this.prog.setAll({
      uViewProj: camera.viewProj,
      uCenter: this.plane.center,
      uExtent: this.plane.extent,
      uZ: this.plane.z,
      uTex: 0,
      uOpacity: 1,
    });
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    return 1;
  }

  dispose() {
    const gl = this.gl;
    this.prog.dispose();
    gl.deleteBuffer(this.quadBuf);
    gl.deleteVertexArray(this.vao);
    if (this.tex) gl.deleteTexture(this.tex);
  }
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
