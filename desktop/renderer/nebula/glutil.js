// FCA Memory Atlas — Nebula Renderer
// Minimal WebGL2 helpers + 4x4 matrix math. Zero dependencies.
// Part of desktop/renderer/nebula (Nebula task group). Contract frozen in docs/PUBLIC_INTERFACE_FREEZE.md §5.

/* ------------------------------------------------------------------ *
 * 4x4 / 3x3 matrix math (column-major, same layout as GLSL)
 * ------------------------------------------------------------------ */
export const mat4 = {
  create() {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  },
  perspective(out, fovyRad, aspect, near, far) {
    const f = 1 / Math.tan(fovyRad / 2);
    const nf = 1 / (near - far);
    out.fill(0);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) * nf;
    out[11] = -1;
    out[14] = 2 * far * near * nf;
    return out;
  },
  lookAt(out, eye, center, up) {
    let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
    let len = Math.hypot(zx, zy, zz) || 1;
    zx /= len; zy /= len; zz /= len;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    len = Math.hypot(xx, xy, xz) || 1;
    xx /= len; xy /= len; xz /= len;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
    out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    out[15] = 1;
    return out;
  },
  multiply(out, a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] =
          a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    out.set(o);
    return out;
  },
  invert(out, a) {
    const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = a;
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10,
      b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11,
      b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12,
      b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30,
      b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31,
      b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return out.set(mat4.create()), out;
    det = 1 / det;
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
  },
  transformPoint(out, m, x, y, z, w = 1) {
    const iw = 1 / (m[3] * x + m[7] * y + m[11] * z + m[15] * w || 1e-9);
    out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12] * w) * iw;
    out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13] * w) * iw;
    out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14] * w) * iw;
    return out;
  },
};

/* ------------------------------------------------------------------ *
 * GL program wrapper with cached uniform locations
 * ------------------------------------------------------------------ */
export class Program {
  constructor(gl, vsSource, fsSource, name = 'program') {
    this.gl = gl;
    this.name = name;
    this.vs = compileShader(gl, gl.VERTEX_SHADER, vsSource, name + ':vs');
    this.fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource, name + ':fs');
    const p = gl.createProgram();
    gl.attachShader(p, this.vs);
    gl.attachShader(p, this.fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      throw new Error(`[nebula] link failed (${name}): ${log}`);
    }
    this.program = p;
    this.loc = Object.create(null);
    this.types = Object.create(null);
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      if (!info) continue;
      const base = info.name.replace(/\[0\]$/, '');
      this.loc[base] = gl.getUniformLocation(p, info.name);
      this.types[base] = { type: info.type, size: info.size };
    }
  }
  use() { this.gl.useProgram(this.program); return this; }
  u(name) { return this.loc[name] ?? null; }
  set(name, v) {
    const gl = this.gl, loc = this.loc[name];
    if (!loc) return this;
    const t = this.types[name]?.type;
    switch (t) {
      case gl.FLOAT: gl.uniform1f(loc, v); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(loc, v); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(loc, v); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(loc, v); break;
      case gl.INT: case gl.BOOL: case gl.SAMPLER_2D: gl.uniform1i(loc, v); break;
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(loc, false, v); break;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(loc, false, v); break;
      default:
        if (typeof v === 'number') gl.uniform1f(loc, v);
    }
    return this;
  }
  setAll(obj) { for (const k in obj) this.set(k, obj[k]); return this; }
  dispose() {
    const gl = this.gl;
    gl.deleteShader(this.vs); gl.deleteShader(this.fs); gl.deleteProgram(this.program);
  }
}

function compileShader(gl, type, src, label) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const lines = src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
    throw new Error(`[nebula] shader compile failed (${label}):\n${log}\n--- source ---\n${lines}`);
  }
  return s;
}

/* ------------------------------------------------------------------ *
 * Fullscreen triangle (no vertex buffers needed: gl_VertexID from empty VAO)
 * ------------------------------------------------------------------ */
const FS_VS = `#version 300 es
out vec2 vUV;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); // (0,0) (2,0) (0,2)
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export class Fullscreen {
  constructor(gl, fsSource, name = 'fullscreen') {
    this.gl = gl;
    this.prog = new Program(gl, FS_VS, fsSource, name);
    this.vao = gl.createVertexArray();
  }
  /** Draw fullscreen triangle; caller binds FBO beforehand. */
  draw(uniforms) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    this.prog.use();
    if (uniforms) this.prog.setAll(uniforms);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
  dispose() { this.gl.deleteVertexArray(this.vao); this.prog.dispose(); }
}

/* ------------------------------------------------------------------ *
 * Textures / FBOs
 * ------------------------------------------------------------------ */
export function createTex(gl, w, h, { internal = gl.RGBA16F, format = gl.RGBA, type = gl.HALF_FLOAT, filter = gl.LINEAR, wrap = gl.CLAMP_TO_EDGE } = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, Math.max(1, w), Math.max(1, h), 0, format, type, null);
  return { tex, w: Math.max(1, w), h: Math.max(1, h), internal, format, type, filter };
}

export function createFBO(gl, w, h, opts = {}) {
  const tex = createTex(gl, w, h, opts);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.tex, 0);
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`[nebula] FBO incomplete (${w}x${h}): 0x${st.toString(16)}`);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex: tex.tex, w: tex.w, h: tex.h, opts };
}

export function resizeFBO(gl, fbo, w, h, opts) {
  if (!fbo) return createFBO(gl, w, h, opts || {});
  if (fbo.w === w && fbo.h === h) return fbo;
  gl.deleteTexture(fbo.tex);
  gl.deleteFramebuffer(fbo.fbo);
  return createFBO(gl, w, h, opts || fbo.opts || {});
}

export function disposeFBO(gl, fbo) {
  if (!fbo) return;
  gl.deleteTexture(fbo.tex);
  gl.deleteFramebuffer(fbo.fbo);
}

export function createVAO(gl, attribs) {
  // attribs: [{buffer, loc, size, type, normalized, stride, offset, divisor}]
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  for (const a of attribs) {
    gl.bindBuffer(gl.ARRAY_BUFFER, a.buffer);
    gl.enableVertexAttribArray(a.loc);
    gl.vertexAttribPointer(a.loc, a.size, a.type || gl.FLOAT, !!a.normalized, a.stride || 0, a.offset || 0);
    if (a.divisor) gl.vertexAttribDivisor(a.loc, a.divisor);
  }
  gl.bindVertexArray(null);
  return vao;
}

export function buffer(gl, data, usage = gl.DYNAMIC_DRAW) {
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, data, usage);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  return b;
}

/* ------------------------------------------------------------------ *
 * deterministic PRNG (mulberry32) + derived helpers
 * ------------------------------------------------------------------ */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable hash of a string -> 32-bit unsigned. */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** gaussian sample (Box-Muller) with provided rand(). */
export function gaussian(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
