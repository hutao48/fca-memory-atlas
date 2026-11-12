// FCA Memory Atlas — Nebula Renderer
// GLSL ES 3.00 shader sources. All visual layers are data-driven:
//  · volume nebula  : cluster emitters (centroid + anisotropic scale + color_hint) + FBM structure + dust
//  · background     : procedural deep-space star fields, galactic band oriented from cluster PCA, faint galaxies
//  · node layer     : instanced billboards, size/brightness from importance / display_weight / degree
//  · relation layer : camera-facing ribbon filaments with flowing particles, styled by relation_type
//  · post           : HDR mip-chain bloom, ACES tonemap, vignette, chromatic aberration, film grain, dither
// No external assets, no textures fetched: everything is computed from the §5 render contract data.

/* ================================================================== *
 * Shared GLSL snippets
 * ================================================================== */
const COMMON_NOISE = `
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
float fbm3(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s / 0.875;
}
float fbm4(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.02 + vec3(5.3, 1.3, 8.7); a *= 0.5; }
  return s / 0.9375;
}
float fbm5(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.01 + vec3(3.1, 7.7, 2.3); a *= 0.5; }
  return s / 0.96875;
}
float ign(vec2 pix) { // interleaved gradient noise (stable dither / raymarch jitter)
  return fract(52.9829189 * fract(dot(pix, vec2(0.06711056, 0.00583715))));
}
vec3 srgbToLinear(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }
`;

/* ================================================================== *
 * Background: procedural deep space (fullscreen)
 * ================================================================== */
export const BG_FS = `#version 300 es
precision highp float;
${COMMON_NOISE}
out vec4 oColor;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec3 uFwd;        // camera forward
uniform vec3 uBandNormal; // galactic band normal (from cluster PCA, computed on CPU)
uniform vec3 uTintA;      // dominant cool gas tint (linear)
uniform vec3 uTintB;      // accent tint (linear)
uniform float uTime;
uniform float uBandIntensity;
uniform float uStarDensity;
uniform float uStarSeed;
uniform float uYaw;
uniform float uPitch;
uniform vec2 uResolution;

vec3 rotateZ(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x - s * v.y, s * v.x + c * v.y, v.z); }

vec3 starColor(float h) {
  vec3 cold = vec3(0.62, 0.78, 1.00);
  vec3 neutral = vec3(1.00, 0.97, 0.92);
  vec3 warm = vec3(1.00, 0.76, 0.52);
  return h < 0.55 ? mix(cold, neutral, h / 0.55) : mix(neutral, warm, (h - 0.55) / 0.45);
}

// Layered procedural star field on the celestial sphere (cube-face grid).
// PSF is kept strictly inside the grid cell (gaussian core + tiny halo) so stars never clip into
// visible squares. Large halos / diffraction spikes are handled by the bright-star point pass.
vec3 starLayer(vec3 dir, float cells, float density, float brightScale, float sizeScale, float parallax, float seed) {
  vec3 d = rotateZ(dir, uYaw * parallax * 0.55);
  d.z += sin(uPitch * parallax) * 0.22;
  d = normalize(d);
  vec3 a = abs(d);
  float face;
  vec2 uv;
  if (a.x >= a.y && a.x >= a.z) { face = d.x > 0.0 ? 0.0 : 1.0; uv = d.yz / a.x; }
  else if (a.y >= a.z) { face = d.y > 0.0 ? 2.0 : 3.0; uv = d.zx / a.y; }
  else { face = d.z > 0.0 ? 4.0 : 5.0; uv = d.xy / a.z; }
  vec2 g = (uv * 0.5 + 0.5) * cells;
  vec2 id = floor(g);
  vec2 f = fract(g);
  vec3 acc = vec3(0.0);
  for (int k = 0; k < 2; k++) {
    vec2 cell = id + vec2(float(k) * 19.7 + face * 7.31 + seed, face * 3.17 + seed * 0.71);
    float h = hash12(cell);
    if (h > density) continue;
    vec2 jit = vec2(hash12(cell + 11.3), hash12(cell + 27.9));
    float r = length(f - (0.22 + 0.56 * jit));
    float b = pow(hash12(cell + 5.7), 4.0); // power law: rare bright stars
    float sz = sizeScale * (0.010 + 0.030 * b);
    float core = exp(-r * r / (sz * sz) * 1.25);
    float halo = exp(-r * r / (sz * sz * 7.0)) * 0.10;
    vec3 col = starColor(hash12(cell + 3.3));
    acc += col * (core + halo) * brightScale * (0.22 + 0.78 * b);
  }
  return acc;
}

vec3 galaxy(vec3 dir) { // a few faint elliptical smudges near the band
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    vec3 c = normalize(hash33(vec3(float(i) * 31.7 + uStarSeed, 7.1, 3.3)) * 2.0 - 1.0);
    vec3 up = normalize(cross(c, vec3(0.0, 0.0, 1.0)));
    vec3 rt = cross(up, c);
    vec2 p = vec2(dot(dir, rt), dot(dir, up));
    float ang = hash12(vec2(float(i), uStarSeed)) * 3.14;
    vec2 pr = vec2(p.x * cos(ang) - p.y * sin(ang), p.x * sin(ang) + p.y * cos(ang));
    float d = dot(pr * pr, vec2(1.0, 5.5));
    float sm = exp(-d * 9000.0) * 0.55 + exp(-d * 1400.0) * 0.10;
    float arms = 0.6 + 0.4 * sin(atan(pr.y, pr.x) * 2.0 + 0.7);
    acc += vec3(0.62, 0.60, 0.78) * sm * arms * 0.05;
  }
  return acc;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 ndc = uv * 2.0 - 1.0;
  vec4 pa = uInvViewProj * vec4(ndc, -1.0, 1.0);
  vec4 pb = uInvViewProj * vec4(ndc, 1.0, 1.0);
  vec3 dir = normalize(pb.xyz / pb.w - pa.xyz / pa.w);
  vec3 col = vec3(0.0);

  // --- faint diffuse galactic glow: large scale, oriented by cluster PCA band normal -------------
  float bd = dot(dir, uBandNormal);
  float band = exp(-bd * bd * 22.0);
  vec3 warp = vec3(fbm3(dir * 2.4 + 3.1), fbm3(dir * 2.4 + 17.7), fbm3(dir * 2.4 + 29.3)) - 0.5;
  float clouds = fbm5(dir * 3.6 + warp * 1.6 + 5.3);
  float lanes = fbm4(dir * 9.0 + warp * 2.2 + 11.7);
  float bandMask = smoothstep(0.28, 0.78, clouds * 0.62 + lanes * 0.38) * band;
  vec3 bandCol = mix(uTintA * 0.55, uTintB, 0.45 + 0.55 * bd);
  col += bandCol * bandMask * (0.32 + 0.9 * lanes) * uBandIntensity * 0.9;
  // softer halo so the band is not a hard stripe
  col += uTintA * band * 0.030 * uBandIntensity;
  // broad dark dust lanes cutting through the band
  float dust = smoothstep(0.52, 0.86, fbm4(dir * 12.0 + 31.0));
  col *= 1.0 - dust * band * 0.32;

  // --- deep-space star layers (3 parallax depths, tight PSF; bright hero stars are a point pass) --
  float dens = uStarDensity;
  col += starLayer(dir, 340.0, 0.38 * dens, 0.22, 0.75, 0.0, uStarSeed);
  col += starLayer(dir, 190.0, 0.30 * dens, 0.48, 0.92, 0.05, uStarSeed + 13.0);
  col += starLayer(dir, 104.0, 0.22 * dens, 0.95, 1.05, 0.12, uStarSeed + 27.0);
  col += galaxy(dir) * 0.7;
  // subtle atmospheric darkening toward the poles (keeps the eye on the disk)
  col *= 0.86 + 0.14 * smoothstep(-0.9, 0.4, dir.z);

  oColor = vec4(max(col, vec3(0.0)), 1.0);
}`;

/* ================================================================== *
 * Volume nebula raymarch (方案 A)
 * ================================================================== */
export const VOLUME_FS = `#version 300 es
precision highp float;
${COMMON_NOISE}
out vec4 oColor;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform vec4 uClA[32];      // xyz centroid (world), w = emission intensity
uniform vec4 uClB[32];      // xyz = 1/sigma (anisotropic), w = seed 0..1
uniform vec3 uClColor[32];  // linear emission color (already palette-mapped)
uniform int uClCount;
uniform float uTime;
uniform float uIntensity;
uniform float uDust;
uniform float uSaturation;
uniform vec3 uHaze;         // ambient gas tint (linear)
uniform vec2 uResolution;
uniform float uGasScale;
uniform int uSteps;
uniform float uDustGain;
uniform float uEmissionGain;

float sstep(float a, float b, float x) { return smoothstep(a, b, x); }

bool boxIntersect(vec3 ro, vec3 rd, out float t0, out float t1) {
  vec3 inv = 1.0 / rd;
  vec3 tA = (uBoxMin - ro) * inv;
  vec3 tB = (uBoxMax - ro) * inv;
  vec3 tmin = min(tA, tB);
  vec3 tmax = max(tA, tB);
  t0 = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
  t1 = min(min(tmax.x, tmax.y), tmax.z);
  return t1 > t0;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 ndc = uv * 2.0 - 1.0;
  vec4 pa = uInvViewProj * vec4(ndc, -1.0, 1.0);
  vec4 pb = uInvViewProj * vec4(ndc, 1.0, 1.0);
  vec3 ro = pa.xyz / pa.w;
  vec3 rd = normalize(pb.xyz / pb.w - ro);

  float t0, t1;
  if (!boxIntersect(ro, rd, t0, t1)) { oColor = vec4(0.0); return; }
  float span = t1 - t0;
  float ds = span / float(uSteps);
  float jitter = ign(gl_FragCoord.xy + fract(uTime * 0.37) * 71.0);

  float T = 1.0;             // transmittance
  vec3 C = vec3(0.0);        // accumulated premultiplied emission
  float scale = 0.0011 * max(0.2, uGasScale);

  for (int i = 0; i < uSteps; i++) {
    float t = t0 + ds * (float(i) + jitter);
    vec3 p = ro + rd * t;
    vec3 q = p * scale;

    // domain-warped FBM gives wispy, filamentary gas structure (not a blob)
    vec3 warp = vec3(fbm3(q * 1.7 + vec3(2.1, 7.3, 1.1)),
                     fbm3(q * 1.7 + vec3(9.7, 3.1, 6.2)),
                     fbm3(q * 1.7 + vec3(5.3, 1.7, 11.3))) - 0.5;
    float large = fbm5(q * 1.15 + warp * 1.25 + uTime * 0.0025);
    float fil = fbm4(q * 3.4 + warp * 1.8 + vec3(7.1));
    float detail = fbm3(q * 8.6 + warp * 2.4 + vec3(3.3));
    // 气体结构：高对比度的丝状/团块，暗缝明显（这是深空星云的关键质感）
    float gasShape = sstep(0.44, 0.74, large * 0.60 + fil * 0.40);
    float gas = (0.12 + 1.10 * gasShape) * (0.42 + 0.95 * sstep(0.34, 0.74, fil)) * (0.58 + 0.62 * detail);
    gas = clamp(gas, 0.0, 1.8);

    // cluster emission kernels: each cluster is one anisotropic gaussian + shared filament field
    float densRaw = 0.0;
    float emitW = 0.0;
    vec3 emit = vec3(0.0);
    for (int c = 0; c < 32; c++) {
      if (c >= uClCount) break;
      vec3 d = (p - uClA[c].xyz) * uClB[c].xyz;
      float q2 = dot(d, d);
      if (q2 > 6.0) continue;
      float g = exp(-q2 * 0.85) * uClA[c].w;
      densRaw += g;
      // 颜色用 g² 加权：重叠处保住最近星团的色相，而不是平均成灰白色
      float gw = g * g;
      emit += uClColor[c] * gw;
      emitW += gw;
    }
    if (densRaw <= 0.006) continue;

    // 柔和压缩：多个星团核重叠时不再线性叠加成过曝白斑（真实星云是光学厚 + 自吸收的）
    float dens = densRaw / (1.0 + 1.35 * densRaw);

    // knots / bright rims inside the gas
    float knot = sstep(0.56, 0.94, fbm4(q * 11.0 + warp * 3.0 + vec3(17.0)));
    float density = dens * gas * (0.42 + 1.0 * knot);

    vec3 emitCol = emit / max(emitW, 1e-4); // density²-weighted hue
    emitCol = mix(vec3(dot(emitCol, vec3(0.30, 0.55, 0.15))), emitCol, uSaturation);
    emitCol = mix(emitCol, uHaze, 0.10);

    // emission (HDR, feeds bloom)：强度压低但保持可见，让尘埃带和暗区真正可见
    float eGain = uEmissionGain * 0.022;
    C += emitCol * density * eGain * ds * T;

    // extinction: 稀薄气体几乎透明；尘埃带（高频噪声）才是吸光主体 → 形成暗带与层次
    float dustField = sstep(0.50, 0.88, fbm4(q * 6.8 + warp * 2.4 + vec3(23.0)));
    float dustLane = dustField * (0.30 + 0.95 * gas);
    float sigma = density * 0.00006 * uIntensity + dustLane * 0.0042 * uDust * uDustGain;
    float att = exp(-sigma * ds);
    T *= att;
    if (T < 0.008) break;
  }

  float alpha = clamp(1.0 - T, 0.0, 1.0);
  oColor = vec4(clamp(C, 0.0, 48.0), alpha);
}`;

/* ================================================================== *
 * Node layer: instanced billboards (stars)
 * ================================================================== */
export const NODE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aQuad;    // -1..1 quad
layout(location = 1) in vec3 aPos;     // world position
layout(location = 2) in vec4 aData;    // x=world size, y=brightness, z=state flags, w=seed
layout(location = 3) in vec3 aColor;   // linear rgb
uniform mat4 uViewProj;
uniform vec2 uViewport;
uniform float uProjScaleY;  // proj[5]
uniform float uNodeSize;
uniform float uMinPixel;
uniform float uTime;
out vec2 vUV;
out vec3 vColor;
out vec4 vData;
out float vPx;
void main() {
  vec4 clip = uViewProj * vec4(aPos, 1.0);
  if (clip.w <= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float px = aData.x * uNodeSize * uProjScaleY * 0.5 * uViewport.y / clip.w;
  px = max(px, uMinPixel * (0.75 + 0.5 * aData.y));
  // gentle twinkle for very bright stars only (subtle, not a game effect)
  float tw = 1.0 + 0.035 * sin(uTime * 0.9 + aData.w * 31.4) * aData.y;
  vPx = px * tw;
  vec2 off = aQuad * vPx * 2.0 / uViewport;
  clip.xy += off * clip.w;
  gl_Position = clip;
  vUV = aQuad;
  vColor = aColor;
  vData = aData;
}`;

export const NODE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
in vec3 vColor;
in vec4 vData;
in float vPx;
out vec4 oColor;
uniform float uTime;
uniform float uFocusDim;
uniform float uEntityScale;
void main() {
  float r = length(vUV);
  if (r > 1.0) discard;
  float brightness = vData.y;
  float flags = vData.z;
  bool selected = mod(flags, 2.0) > 0.5;
  bool hovered = mod(floor(flags / 2.0), 2.0) > 0.5;
  bool focused = mod(floor(flags / 4.0), 2.0) > 0.5;
  bool dimmed = mod(floor(flags / 8.0), 2.0) > 0.5;
  bool isEntity = mod(floor(flags / 16.0), 2.0) > 0.5;
  float dim = dimmed ? uFocusDim : 1.0;

  // core + tight halo + broad halo (photographic star profile)
  float core = exp(-r * r * 26.0);
  float halo = exp(-r * r * 4.2) * 0.22;
  float wide = exp(-r * 2.1) * 0.05;
  // diffraction spikes for the brightest stars only
  float spike = 0.0;
  if (brightness > 0.55) {
    float sx = exp(-abs(vUV.x) * 90.0) * exp(-abs(vUV.y) * 6.5);
    float sy = exp(-abs(vUV.y) * 90.0) * exp(-abs(vUV.x) * 6.5);
    spike = (sx + sy) * 0.22 * smoothstep(0.55, 1.35, brightness);
  }
  // entity nodes: thin ring instead of a plain ball -> visually distinct from memory stars
  float ring = 0.0;
  if (isEntity) {
    ring = (smoothstep(0.46, 0.56, r) - smoothstep(0.64, 0.74, r)) * 0.52;
    core *= uEntityScale;
  }

  vec3 col = vColor * (core * 1.15 + halo + wide + spike + ring) * brightness * dim;
  // state highlights (still photographic: cool white / cyan rings, no neon fill)
  if (selected) {
    float sr = (smoothstep(0.84, 0.90, r) - smoothstep(0.97, 1.0, r)) * 0.9;
    col += vec3(0.42, 0.80, 1.0) * sr * (0.55 + 0.45 * brightness) * 1.5;
  }
  if (hovered) {
    float hr = (smoothstep(0.70, 0.76, r) - smoothstep(0.85, 0.91, r)) * 0.8;
    col += vec3(0.86, 0.92, 1.0) * hr;
  }
  if (focused) {
    col += vColor * exp(-r * r * 3.0) * 0.25;
  }
  oColor = vec4(max(col, vec3(0.0)), 1.0);
}`;

/* ================================================================== *
 * Relation layer: camera-facing ribbons + flowing particles
 * ================================================================== */
export const EDGE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aTan;   // world-space tangent (unit)
layout(location = 2) in vec3 aMeta;  // x = t along curve, y = side (-1/+1), z = seed
layout(location = 3) in vec3 aColor; // linear rgb
layout(location = 4) in vec2 aParams; // x = base alpha, y = style flags (dash)
uniform mat4 uViewProj;
uniform vec2 uViewport;
uniform float uWidthPx;
uniform float uTime;
out float vT;
out float vSide;
out float vSeed;
out vec3 vColor;
out float vAlpha;
out float vDash;
void main() {
  vec4 c0 = uViewProj * vec4(aPos, 1.0);
  vec4 c1 = uViewProj * vec4(aPos + aTan * 6.0, 1.0);
  if (c0.w <= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 n0 = c0.xy / c0.w;
  vec2 n1 = c1.xy / c1.w;
  vec2 dirPx = normalize(vec2((n1.x - n0.x) * uViewport.x, (n1.y - n0.y) * uViewport.y) + vec2(1e-5, 0.0));
  vec2 nrm = vec2(-dirPx.y, dirPx.x);
  float w = uWidthPx * (0.7 + 0.6 * aParams.x);
  c0.xy += nrm * aMeta.y * w * 2.0 / uViewport * c0.w;
  gl_Position = c0;
  vT = aMeta.x;
  vSide = aMeta.y;
  vSeed = aMeta.z;
  vColor = aColor;
  vAlpha = aParams.x;
  vDash = aParams.y;
}`;

export const EDGE_FS = `#version 300 es
precision highp float;
in float vT;
in float vSide;
in float vSeed;
in vec3 vColor;
in float vAlpha;
in float vDash;
out vec4 oColor;
uniform float uTime;
uniform float uOpacity;
uniform float uFlow;
uniform float uBright;
void main() {
  float edge = 1.0 - abs(vSide);
  float core = pow(edge, 1.6) * 0.42;         // soft filament cross-section
  float phase = fract(vT * 0.85 + vSeed * 1.37 - uTime * 0.055 * uFlow);
  float pulse = exp(-pow((vT - phase) * 5.5, 2.0));       // flowing particle head
  float pulse2 = exp(-pow((fract(vT - phase + 0.33) - 0.5) * 9.0, 2.0)) * 0.35;
  float dash = 1.0;
  if (vDash > 0.05) dash = 0.45 + 0.55 * step(0.48, fract(vT * (7.0 + vDash * 8.0) + vSeed * 13.0));
  float a = (core + (pulse + pulse2) * 0.75) * clamp(vAlpha, 0.0, 1.0) * uOpacity * dash * uBright;
  oColor = vec4(vColor * a, a);
}`;

/* ================================================================== *
 * Plan B: baked nebula texture (CPU precomputed) + background/billboards
 * ================================================================== */
export const BAKED_FS = `#version 300 es
precision highp float;
out vec4 oColor;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec3 uCenter;   // world center of baked plane
uniform vec2 uExtent;   // half extents x,y
uniform float uZ;
uniform float uOpacity;
void main() {
  // world -> plane uv via screen projection is done on CPU; this pass samples a flat gas plane
  vec4 c = texture(uTex, vUV);
  oColor = vec4(c.rgb * uOpacity, c.a * uOpacity);
}`;

export const BAKED_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aUV;
uniform mat4 uViewProj;
uniform vec3 uCenter;
uniform vec2 uExtent;
uniform float uZ;
out vec2 vUV;
void main() {
  vUV = aUV * 0.5 + 0.5;
  vec3 p = uCenter + vec3(aUV.x * uExtent.x, aUV.y * uExtent.y, uZ);
  gl_Position = uViewProj * vec4(p, 1.0);
}`;

/* ================================================================== *
 * Flat (off quality) variants — sketch-like but fully readable
 * ================================================================== */
export const FLAT_NODE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
in vec3 vColor;
in vec4 vData;
in float vPx;
out vec4 oColor;
uniform float uFocusDim;
void main() {
  float r = length(vUV);
  if (r > 1.0) discard;
  float flags = vData.z;
  bool selected = mod(flags, 2.0) > 0.5;
  bool hovered = mod(floor(flags / 2.0), 2.0) > 0.5;
  bool dimmed = mod(floor(flags / 8.0), 2.0) > 0.5;
  bool isEntity = mod(floor(flags / 16.0), 2.0) > 0.5;
  float a = 1.0 - smoothstep(0.72, 1.0, r);
  vec3 col = mix(vColor, vec3(0.85, 0.92, 1.0), 0.18) * (0.55 + 0.45 * vData.y);
  if (isEntity) { col = mix(col, vec3(0.80, 0.86, 1.0), 0.4); a *= 0.8; }
  if (dimmed) a *= 0.18;
  if (hovered) { a = max(a, 0.9); }
  vec3 outCol = col * a;
  if (selected) {
    float ring = (smoothstep(0.62, 0.72, r) - smoothstep(0.88, 1.0, r));
    outCol += vec3(0.35, 0.78, 1.0) * ring;
    a = max(a, ring);
  }
  outCol = pow(clamp(outCol, 0.0, 1.0), vec3(1.0 / 2.2));
  oColor = vec4(outCol, clamp(a, 0.0, 1.0));
}`;

export const FLAT_EDGE_FS = `#version 300 es
precision highp float;
in float vT;
in float vSide;
in float vSeed;
in vec3 vColor;
in float vAlpha;
in float vDash;
out vec4 oColor;
uniform float uOpacity;
void main() {
  float edge = 1.0 - abs(vSide);
  float a = smoothstep(0.0, 0.5, edge) * vAlpha * uOpacity;
  vec3 c = pow(clamp(vColor, 0.0, 1.0), vec3(1.0 / 2.2)) * a;
  oColor = vec4(c, a);
}`;

export const FLAT_BG_FS = `#version 300 es
precision highp float;
${COMMON_NOISE}
out vec4 oColor;
uniform vec2 uResolution;
uniform vec3 uBandNormal;
uniform float uStarDensity;
uniform float uStarSeed;
uniform vec3 uTintA;
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 ndc = uv * 2.0 - 1.0;
  vec3 col = mix(vec3(0.010, 0.016, 0.028), vec3(0.016, 0.024, 0.042), uv.y);
  vec3 dir = normalize(vec3(ndc.x * 0.9, ndc.y * 0.6 + 0.15, 0.8));
  // faint diagonal band hint so orientation still reads in off mode
  float bd = dot(dir, uBandNormal);
  col += uTintA * exp(-bd * bd * 26.0) * 0.012;
  // sparse, very dim stars: enough to feel like space, never competing with nodes
  vec2 g = uv * uResolution / 14.0;
  vec2 grid = floor(g);
  float h = hash12(grid + uStarSeed);
  if (h > 0.965 * uStarDensity) {
    vec2 jit = vec2(hash12(grid + 7.31), hash12(grid + 13.97));
    vec2 f = fract(g) - jit;
    float s = exp(-dot(f, f) * 90.0) * 0.16;
    col += vec3(0.66, 0.76, 0.92) * s;
  }
  oColor = vec4(col, 1.0);
}`;

/* ================================================================== *
 * Post-processing
 * ================================================================== */
export const PASSTHROUGH_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 oColor;
uniform sampler2D uTex;
uniform float uOpacity;
void main() {
  vec4 c = texture(uTex, vUV);
  oColor = c * uOpacity;
}`;

/* ================================================================== *
 * Bright background stars: sprite points (clean gaussian halo + diffraction spikes)
 * Rendered on a camera-attached celestial sphere, so they never clip against the
 * procedural cube-grid cells used by the faint star layers.
 * ================================================================== */
export const BRIGHT_STAR_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aDir;
layout(location = 1) in vec4 aData; // x = size in CSS px, y = brightness, z = temp [-1,1], w = seed
uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform float uRadius;
uniform float uPixelRatio;
out vec3 vColor;
out float vBright;
out float vSeed;
void main() {
  vec3 world = uCamPos + normalize(aDir) * uRadius;
  gl_Position = uViewProj * vec4(world, 1.0);
  gl_PointSize = clamp(aData.x * uPixelRatio, 1.0, 96.0);
  vec3 cold = vec3(0.62, 0.78, 1.0);
  vec3 neutral = vec3(1.0, 0.97, 0.92);
  vec3 warm = vec3(1.0, 0.74, 0.5);
  vColor = aData.z < 0.0 ? mix(cold, neutral, 1.0 + aData.z) : mix(neutral, warm, aData.z);
  vBright = aData.y;
  vSeed = aData.w;
}`;

export const BRIGHT_STAR_FS = `#version 300 es
precision highp float;
in vec3 vColor;
in float vBright;
in float vSeed;
out vec4 oColor;
void main() {
  vec2 pc = gl_PointCoord * 2.0 - 1.0;
  float r = length(pc);
  if (r > 1.0) discard;
  float core = exp(-r * r * 10.0);
  float halo = exp(-r * r * 2.4) * 0.16 + exp(-r * 3.0) * 0.025;
  float ang = vSeed * 6.2831853;
  float ca = cos(ang), sa = sin(ang);
  vec2 rot = vec2(ca * pc.x - sa * pc.y, sa * pc.x + ca * pc.y);
  float spikeStr = smoothstep(0.7, 1.8, vBright);
  float spike = (exp(-abs(rot.x) * 34.0) * exp(-abs(rot.y) * 4.5)
               + exp(-abs(rot.y) * 34.0) * exp(-abs(rot.x) * 4.5)) * 0.24 * spikeStr;
  vec3 col = vColor * (core * 1.05 + halo + spike) * vBright;
  oColor = vec4(col, 1.0);
}`;

export const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 oColor;
uniform sampler2D uScene;
uniform float uThreshold;
uniform float uKnee;
void main() {
  vec3 c = texture(uScene, vUV).rgb;
  float lum = max(c.r, max(c.g, c.b));
  float w = smoothstep(uThreshold, uThreshold + uKnee, lum);
  oColor = vec4(c * w, 1.0);
}`;

export const DOWN_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 oColor;
uniform sampler2D uTex;
uniform vec2 uTexel;
void main() {
  vec3 sum = vec3(0.0);
  vec2 t = uTexel;
  sum += texture(uTex, vUV).rgb * 0.25;
  sum += texture(uTex, vUV + vec2(-t.x, -t.y)).rgb * 0.125;
  sum += texture(uTex, vUV + vec2(t.x, -t.y)).rgb * 0.125;
  sum += texture(uTex, vUV + vec2(-t.x, t.y)).rgb * 0.125;
  sum += texture(uTex, vUV + vec2(t.x, t.y)).rgb * 0.125;
  sum += texture(uTex, vUV + vec2(-2.0 * t.x, 0.0)).rgb * 0.0625;
  sum += texture(uTex, vUV + vec2(2.0 * t.x, 0.0)).rgb * 0.0625;
  sum += texture(uTex, vUV + vec2(0.0, -2.0 * t.y)).rgb * 0.0625;
  sum += texture(uTex, vUV + vec2(0.0, 2.0 * t.y)).rgb * 0.0625;
  oColor = vec4(sum, 1.0);
}`;

export const UP_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 oColor;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uRadius;
void main() {
  vec3 sum = vec3(0.0);
  vec2 t = uTexel * uRadius;
  sum += texture(uTex, vUV + vec2(-t.x, -t.y)).rgb * 1.0;
  sum += texture(uTex, vUV + vec2(0.0, -t.y)).rgb * 2.0;
  sum += texture(uTex, vUV + vec2(t.x, -t.y)).rgb * 1.0;
  sum += texture(uTex, vUV + vec2(-t.x, 0.0)).rgb * 2.0;
  sum += texture(uTex, vUV).rgb * 4.0;
  sum += texture(uTex, vUV + vec2(t.x, 0.0)).rgb * 2.0;
  sum += texture(uTex, vUV + vec2(-t.x, t.y)).rgb * 1.0;
  sum += texture(uTex, vUV + vec2(0.0, t.y)).rgb * 2.0;
  sum += texture(uTex, vUV + vec2(t.x, t.y)).rgb * 1.0;
  oColor = vec4(sum / 16.0, 1.0);
}`;

export const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 oColor;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uResolution;
uniform float uExposure;
uniform float uBloomStrength;
uniform float uVignette;
uniform float uGrain;
uniform float uCA;
uniform float uTime;
uniform float uDither;
uniform vec3 uGradeShadow;

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec2 uv = vUV;
  vec2 centered = uv - 0.5;
  float rad = dot(centered, centered);

  // slight chromatic aberration toward the frame edges (lens realism)
  vec2 caOff = centered * rad * 0.0016 * uCA;
  vec3 scene;
  scene.r = texture(uScene, uv + caOff).r;
  scene.g = texture(uScene, uv).g;
  scene.b = texture(uScene, uv - caOff).b;

  vec3 bloom = texture(uBloom, uv).rgb;
  vec3 col = scene + bloom * uBloomStrength;
  col *= uExposure;
  col = aces(col);

  // photographic grade: cool shadows, very slight highlight desaturation
  col = col * (1.0 - uGradeShadow) + uGradeShadow;
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(lum * 0.96 + 0.02, lum, lum * 1.04 + 0.01), 0.10);

  // vignette (natural lens falloff, not a harsh overlay)
  float vig = smoothstep(0.95, 0.28, length(centered) * 1.35);
  col *= mix(1.0, 0.55 + 0.45 * vig, uVignette);

  // film grain (luminance weighted, fine)
  float g = hash12(gl_FragCoord.xy + fract(uTime * 7.0) * 913.0) - 0.5;
  col += g * 0.020 * uGrain * (0.6 + 0.4 * (1.0 - lum));

  // dithering removes 8-bit banding in the dark gradients
  float d = hash12(gl_FragCoord.xy * 1.31 + 17.0) - 0.5;
  col += d * uDither / 255.0;

  // linear -> sRGB
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  oColor = vec4(col, 1.0);
}`;
