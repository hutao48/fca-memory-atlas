// FCA Memory Atlas — Nebula Renderer
// HDR post-processing: mip-chain bloom (bright pass -> downsample chain -> tent upsample),
// ACES filmic tonemap, photographic grade, vignette, chromatic aberration, film grain, dither.
import { Fullscreen, createFBO, disposeFBO } from './glutil.js';
import { BRIGHT_FS, DOWN_FS, UP_FS, COMPOSITE_FS } from './shaders.js';

export class Post {
  constructor(gl, hdr = true) {
    this.gl = gl;
    this.hdr = hdr;
    this.fmt = hdr
      ? { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.LINEAR }
      : { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: gl.LINEAR };
    this.bright = new Fullscreen(gl, BRIGHT_FS, 'post-bright');
    this.down = new Fullscreen(gl, DOWN_FS, 'post-down');
    this.up = new Fullscreen(gl, UP_FS, 'post-up');
    this.composite = new Fullscreen(gl, COMPOSITE_FS, 'post-composite');
    this.scene = null;
    this.mips = [];
    this.levels = 5;
  }

  resize(w, h, levels) {
    const gl = this.gl;
    w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    if (!this.scene || this.scene.w !== w || this.scene.h !== h) {
      if (this.scene) disposeFBO(gl, this.scene);
      this.scene = createFBO(gl, w, h, this.fmt);
    }
    this.levels = Math.max(1, levels | 0);
    const need = [];
    let mw = Math.max(2, Math.round(w / 2)), mh = Math.max(2, Math.round(h / 2));
    for (let i = 0; i < this.levels; i++) {
      need.push([Math.max(2, mw), Math.max(2, mh)]);
      mw = Math.max(2, Math.round(mw / 2));
      mh = Math.max(2, Math.round(mh / 2));
    }
    // grow/shrink mip list
    while (this.mips.length < need.length) this.mips.push(null);
    while (this.mips.length > need.length) disposeFBO(gl, this.mips.pop());
    for (let i = 0; i < need.length; i++) {
      const [mwv, mhv] = need[i];
      if (!this.mips[i] || this.mips[i].w !== mwv || this.mips[i].h !== mhv) {
        if (this.mips[i]) disposeFBO(gl, this.mips[i]);
        this.mips[i] = createFBO(gl, mwv, mhv, this.fmt);
      }
    }
    return this.scene;
  }

  /** Render bloom + composite scene to the default framebuffer (or target). */
  render({ exposure = 1, bloomStrength = 1, vignette = 1, grain = 1, ca = 1, time = 0, target = null }) {
    const gl = this.gl;
    if (!this.scene) return;
    const canvas = gl.canvas;
    // 1) bright pass into mip0
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mips[0].fbo);
    gl.viewport(0, 0, this.mips[0].w, this.mips[0].h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
    this.bright.draw({ uScene: 0, uThreshold: 0.65, uKnee: 0.55 });

    // 2) downsample chain
    for (let i = 1; i < this.mips.length; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.mips[i].fbo);
      gl.viewport(0, 0, this.mips[i].w, this.mips[i].h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.mips[i - 1].tex);
      this.down.draw({ uTex: 0, uTexel: [1 / this.mips[i - 1].w, 1 / this.mips[i - 1].h] });
    }

    // 3) tent upsample, additive accumulation
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = this.mips.length - 1; i > 0; i--) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.mips[i - 1].fbo);
      gl.viewport(0, 0, this.mips[i - 1].w, this.mips[i - 1].h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.mips[i].tex);
      this.up.draw({ uTex: 0, uTexel: [1 / this.mips[i].w, 1 / this.mips[i].h], uRadius: 1.0 });
    }
    gl.disable(gl.BLEND);

    // 4) composite to canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.w : canvas.width, target ? target.h : canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.mips[0].tex);
    this.composite.draw({
      uScene: 0, uBloom: 1,
      uResolution: [target ? target.w : canvas.width, target ? target.h : canvas.height],
      uExposure: exposure,
      uBloomStrength: bloomStrength,
      uVignette: vignette,
      uGrain: grain,
      uCA: ca,
      uTime: time,
      uDither: 1.0,
      uGradeShadow: [0.006, 0.012, 0.026],
    });
    gl.activeTexture(gl.TEXTURE0);
  }

  dispose() {
    const gl = this.gl;
    if (this.scene) disposeFBO(gl, this.scene);
    for (const m of this.mips) disposeFBO(gl, m);
    this.bright.dispose(); this.down.dispose(); this.up.dispose(); this.composite.dispose();
  }
}
