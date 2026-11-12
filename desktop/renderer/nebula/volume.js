// FCA Memory Atlas — Nebula Renderer
// 方案 A core: data-driven volumetric nebula raymarch at reduced resolution + anisotropic upsample.
// Every cluster becomes one emission kernel (centroid + anisotropic gaussian + color_hint hue);
// FBM domain-warp gives the filamentary structure, high-frequency noise carves dust lanes.
import { Fullscreen, createFBO, resizeFBO, disposeFBO } from './glutil.js';
import { VOLUME_FS, PASSTHROUGH_FS } from './shaders.js';

export const MAX_VOLUME_CLUSTERS = 32;

export class VolumePass {
  constructor(gl) {
    this.gl = gl;
    this.fsVolume = new Fullscreen(gl, VOLUME_FS, 'volume-raymarch');
    this.fsComposite = new Fullscreen(gl, PASSTHROUGH_FS, 'volume-composite');
    this.fbo = null;
    this.enabled = true;
    this.clusterCount = 0;
    this.clA = new Float32Array(MAX_VOLUME_CLUSTERS * 4);
    this.clB = new Float32Array(MAX_VOLUME_CLUSTERS * 4);
    this.clC = new Float32Array(MAX_VOLUME_CLUSTERS * 3);
    this.boxMin = [-5000, -5000, -800];
    this.boxMax = [5000, 5000, 800];
    this.haze = [0.05, 0.10, 0.18];
    this.emissionGain = 1.0;
    this.dustGain = 1.0;
    this.steps = 88;
    this.volumeScale = 0.5;
  }

  resize(sceneW, sceneH) {
    const gl = this.gl;
    const w = Math.max(64, Math.round(sceneW * this.volumeScale));
    const h = Math.max(64, Math.round(sceneH * this.volumeScale));
    this.fbo = resizeFBO(gl, this.fbo, w, h);
    return this.fbo;
  }

  /** Pack cluster emitters from preprocessed clusters: {centroid, invScale[3], intensity, linearColor}. */
  setClusters(clusters, box, haze) {
    this.clusterCount = Math.min(clusters.length, MAX_VOLUME_CLUSTERS);
    for (let i = 0; i < this.clusterCount; i++) {
      const c = clusters[i];
      this.clA[i * 4 + 0] = c.centroid.x;
      this.clA[i * 4 + 1] = c.centroid.y;
      this.clA[i * 4 + 2] = c.centroid.z;
      this.clA[i * 4 + 3] = c.intensity;
      this.clB[i * 4 + 0] = c.invScale[0];
      this.clB[i * 4 + 1] = c.invScale[1];
      this.clB[i * 4 + 2] = c.invScale[2];
      this.clB[i * 4 + 3] = c.seed;
      this.clC[i * 3 + 0] = c.linearColor[0];
      this.clC[i * 3 + 1] = c.linearColor[1];
      this.clC[i * 3 + 2] = c.linearColor[2];
    }
    if (box) { this.boxMin = box.min; this.boxMax = box.max; }
    if (haze) this.haze = haze;
  }

  /** Render volume into its half-res target, then composite premultiplied over the scene target. */
  render(sceneTarget, camera, opts) {
    const gl = this.gl;
    if (!this.enabled || this.clusterCount === 0) return;
    if (!this.fbo) this.resize(sceneTarget.w, sceneTarget.h);
    const fbo = this.fbo;

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
    gl.viewport(0, 0, fbo.w, fbo.h);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    this.fsVolume.draw({
      uInvViewProj: camera.invViewProj,
      uCamPos: camera.eye,
      uBoxMin: this.boxMin,
      uBoxMax: this.boxMax,
      uClA: this.clA,
      uClB: this.clB,
      uClColor: this.clC,
      uClCount: this.clusterCount,
      uTime: opts.time,
      uIntensity: opts.mapping.nebulaIntensity,
      uDust: opts.mapping.dustStrength,
      uSaturation: opts.mapping.nebulaSaturation,
      uHaze: this.haze,
      uResolution: [fbo.w, fbo.h],
      uGasScale: opts.mapping.gasScale,
      uSteps: this.steps,
      uDustGain: this.dustGain,
      uEmissionGain: this.emissionGain,
    });

    // composite premultiplied emission over background: out = vol + dst*(1 - alpha)
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneTarget.fbo);
    gl.viewport(0, 0, sceneTarget.w, sceneTarget.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fbo.tex);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.fsComposite.draw({ uTex: 0, uOpacity: 1 });
    gl.disable(gl.BLEND);
  }

  dispose() {
    disposeFBO(this.gl, this.fbo);
    this.fsVolume.dispose();
    this.fsComposite.dispose();
  }
}
