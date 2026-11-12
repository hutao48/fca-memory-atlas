// FCA Memory Atlas — Nebula Renderer
// Star/entity node layer (instanced billboards) + relation layer (camera-facing ribbons with
// flowing particles). Both layers are driven exclusively by §5 graph nodes/edges.
import { Program, createVAO, buffer } from './glutil.js';
import { hexToLinear } from './palette.js';
import { NODE_VS, NODE_FS, FLAT_NODE_FS, EDGE_VS, EDGE_FS, FLAT_EDGE_FS } from './shaders.js';

const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);

export class NodePass {
  constructor(gl) {
    this.gl = gl;
    this.prog3d = new Program(gl, NODE_VS, NODE_FS, 'nodes-hdr');
    this.progFlat = new Program(gl, NODE_VS, FLAT_NODE_FS, 'nodes-flat');
    this.quadBuf = buffer(gl, QUAD, gl.STATIC_DRAW);
    this.posBuf = gl.createBuffer();
    this.dataBuf = gl.createBuffer();
    this.colorBuf = gl.createBuffer();
    this.count = 0;
    this.capacity = 0;
    this._buildVAO();
  }

  _buildVAO() {
    const gl = this.gl;
    this.vao = createVAO(gl, [
      { buffer: this.quadBuf, loc: 0, size: 2, divisor: 0 },
      { buffer: this.posBuf, loc: 1, size: 3, divisor: 1 },
      { buffer: this.dataBuf, loc: 2, size: 4, divisor: 1 },
      { buffer: this.colorBuf, loc: 3, size: 3, divisor: 1 },
    ]);
  }

  /** nodes: [{position:{x,y,z}, sizeWorld, brightness, flags, seed, color:[r,g,b] linear}] */
  setNodes(nodes) {
    const gl = this.gl;
    this.count = nodes.length;
    const n = nodes.length;
    if (!n) return;
    const pos = new Float32Array(n * 3);
    const data = new Float32Array(n * 4);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      const p = node.pos || node.position;
      pos[i * 3] = p.x;
      pos[i * 3 + 1] = p.y;
      pos[i * 3 + 2] = p.z;
      data[i * 4] = node.sizeWorld;
      data[i * 4 + 1] = node.brightness;
      data[i * 4 + 2] = node.flags;
      data[i * 4 + 3] = node.seed;
      const cc = node.color || node.baseColor;
      col[i * 3] = cc[0];
      col[i * 3 + 1] = cc[1];
      col[i * 3 + 2] = cc[2];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dataBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, col, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.capacity = n;
    this._pos = pos;
  }

  /** Per-node state refresh (brightness + flags) without touching colors/positions. */
  updateData(states) {
    const gl = this.gl;
    if (!states.length) return;
    if (!this._data || this._data.length !== states.length * 4) {
      this._data = new Float32Array(states.length * 4);
    }
    for (let i = 0; i < states.length; i++) {
      this._data[i * 4] = states[i].sizeWorld;
      this._data[i * 4 + 1] = states[i].brightness;
      this._data[i * 4 + 2] = states[i].flags;
      this._data[i * 4 + 3] = states[i].seed;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dataBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._data);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  setColors(colors) {
    const gl = this.gl;
    if (!colors.length) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  updatePositions(nodes, indices) {
    const gl = this.gl;
    if (!this._pos) return;
    for (const i of indices) {
      const p = nodes[i].pos || nodes[i].position;
      this._pos[i * 3] = p.x;
      this._pos[i * 3 + 1] = p.y;
      this._pos[i * 3 + 2] = p.z;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._pos);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  draw(camera, viewport, uniforms, flat = false) {
    const gl = this.gl;
    if (!this.count) return 0;
    const prog = flat ? this.progFlat : this.prog3d;
    prog.use();
    prog.setAll({
      uViewProj: camera.viewProj,
      uViewport: [viewport.w, viewport.h],
      uProjScaleY: camera.proj[5],
      uTime: uniforms.time,
      uFocusDim: uniforms.focusDim ?? 0.18,
      uMinPixel: uniforms.minPixel,
      uNodeSize: uniforms.nodeSize,
      uEntityScale: 0.85,
    });
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count);
    gl.bindVertexArray(null);
    return 1;
  }

  dispose() {
    const gl = this.gl;
    this.prog3d.dispose(); this.progFlat.dispose();
    gl.deleteBuffer(this.quadBuf); gl.deleteBuffer(this.posBuf);
    gl.deleteBuffer(this.dataBuf); gl.deleteBuffer(this.colorBuf);
    gl.deleteVertexArray(this.vao);
  }
}

/* ================================================================== *
 * Relation ribbons
 * ================================================================== */
const FLOATS_PER_VERTEX = 14; // pos3 + tan3 + meta3 + color3 + params2

export class EdgePass {
  constructor(gl) {
    this.gl = gl;
    this.prog3d = new Program(gl, EDGE_VS, EDGE_FS, 'edges-hdr');
    this.progFlat = new Program(gl, EDGE_VS, FLAT_EDGE_FS, 'edges-flat');
    this.samples = 12;
    this.count = 0;
    this.vertBuf = null;
    this.indexBuf = null;
    this.vao = null;
    this.meta = []; // per rendered edge: {start, verts, samples, data}
    this.visibleEdges = 0;
  }

  /**
   * @param edges graph edges
   * @param nodeIndex Map id -> {position, kind, type}
   * @param opts {samples, styles, mapping, hidden:Set, dimmed:Set, selected:Set}
   */
  build(edges, nodeIndex, opts) {
    const gl = this.gl;
    const samples = opts.samples || 12;
    this.samples = samples;
    const styles = opts.styles;
    const mapping = opts.mapping;
    const hidden = opts.hidden || null;
    const dimmed = opts.dimmed || null;

    const visible = [];
    for (let e = 0; e < edges.length; e++) {
      const edge = edges[e];
      if (edge.deleted) continue;
      const a = nodeIndex.get(edge.from);
      const b = nodeIndex.get(edge.to);
      if (!a || !b) continue;
      if (hidden && (hidden.has(edge.from) || hidden.has(edge.to))) continue;
      visible.push(e);
    }
    this.visibleEdges = visible.length;
    this.count = visible.length;
    this.meta = [];
    if (!visible.length) { this.indexCount = 0; return; }

    const vertsPerEdge = samples * 2;
    const floats = visible.length * vertsPerEdge * FLOATS_PER_VERTEX;
    if (!this._verts || this._verts.length < floats) this._verts = new Float32Array(floats);
    const arr = this._verts;
    arr.fill(0, 0, floats);
    let vOff = 0;

    for (const ei of visible) {
      const edge = edges[ei];
      const a = nodeIndex.get(edge.from);
      const b = nodeIndex.get(edge.to);
      const style = styles[edge.relation_type] || styles.custom;
      const seed = rand01(ei * 7919 + 13);
      const edgeDim = dimmed && (dimmed.has(edge.from) || dimmed.has(edge.to));
      const color = mapping && mapping.relationColors && mapping.relationColors[edge.relation_type]
        ? hexToLinear(mapping.relationColors[edge.relation_type])
        : hexToLinear(style.hex);
      const alpha = Math.min(1, (0.34 + 0.5 * (edge.weight ?? 1) * (edge.confidence ?? 1)) * (edgeDim ? 0.12 : 1));
      const record = {
        edgeIndex: ei,
        start: vOff,
        vertexCount: vertsPerEdge,
        samples,
        from: edge.from,
        to: edge.to,
        color,
        alpha,
        dash: style.dash,
        curve: style.curve,
        seed,
        zBulge: edge.relation_type === 'temporal_before' || edge.relation_type === 'temporal_after' ? 1 : 0,
      };
      writeEdgeVertices(arr, vOff, record, a.position, b.position);
      vOff += vertsPerEdge;
      this.meta.push(record);
    }

    // index buffer for the ribbon quads
    const idxCount = visible.length * (samples - 1) * 6;
    if (!this._idx || this._idx.length < idxCount) this._idx = new Uint32Array(idxCount);
    let io = 0, base = 0;
    for (let e = 0; e < visible.length; e++) {
      for (let s = 0; s < samples - 1; s++) {
        const a0 = base + s * 2, a1 = a0 + 1, b0 = a0 + 2, b1 = a0 + 3;
        this._idx[io++] = a0; this._idx[io++] = a1; this._idx[io++] = b1;
        this._idx[io++] = a0; this._idx[io++] = b1; this._idx[io++] = b0;
      }
      base += vertsPerEdge;
    }
    this.indexCount = idxCount;
    this._upload(arr.subarray(0, vOff * FLOATS_PER_VERTEX), this._idx.subarray(0, idxCount));
  }

  _upload(verts, indices) {
    const gl = this.gl;
    if (!this.vertBuf) {
      this.vertBuf = gl.createBuffer();
      this.indexBuf = gl.createBuffer();
      this.vao = createVAO(gl, [
        { buffer: this.vertBuf, loc: 0, size: 3, stride: FLOATS_PER_VERTEX * 4, offset: 0 },
        { buffer: this.vertBuf, loc: 1, size: 3, stride: FLOATS_PER_VERTEX * 4, offset: 12 },
        { buffer: this.vertBuf, loc: 2, size: 3, stride: FLOATS_PER_VERTEX * 4, offset: 24 },
        { buffer: this.vertBuf, loc: 3, size: 3, stride: FLOATS_PER_VERTEX * 4, offset: 36 },
        { buffer: this.vertBuf, loc: 4, size: 2, stride: FLOATS_PER_VERTEX * 4, offset: 48 },
      ]);
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuf);
      gl.bindVertexArray(null);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  }

  /** Re-generate the vertex spans of specific edges (used while dragging nodes). */
  updateEdges(edgeIdxList, positions) {
    const gl = this.gl;
    if (!this.vertBuf || !this._verts) return;
    let dirtyMin = Infinity, dirtyMax = 0;
    for (const ei of edgeIdxList) {
      const rec = this.meta.find((m) => m.edgeIndex === ei);
      if (!rec) continue;
      const pa = positions.get(rec.from), pb = positions.get(rec.to);
      if (!pa || !pb) continue;
      const before = rec.start;
      writeEdgeVertices(this._verts, rec.start, rec, pa, pb);
      dirtyMin = Math.min(dirtyMin, before);
      dirtyMax = Math.max(dirtyMax, rec.start + rec.vertexCount);
    }
    if (dirtyMin === Infinity) return;
    const startFloat = dirtyMin * FLOATS_PER_VERTEX;
    const endFloat = dirtyMax * FLOATS_PER_VERTEX;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, startFloat * 4, this._verts.subarray(startFloat, endFloat));
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  draw(camera, viewport, uniforms, flat = false) {
    const gl = this.gl;
    if (!this.indexCount) return 0;
    const prog = flat ? this.progFlat : this.prog3d;
    prog.use();
    prog.setAll({
      uViewProj: camera.viewProj,
      uViewport: [viewport.w, viewport.h],
      uWidthPx: (flat ? 0.85 : 1.15) * uniforms.edgeWidth,
      uTime: uniforms.time,
      uOpacity: uniforms.edgeOpacity,
      uFlow: uniforms.flow,
      uBright: uniforms.edgeBright ?? 1,
    });
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    return 1;
  }

  dispose() {
    const gl = this.gl;
    this.prog3d.dispose(); this.progFlat.dispose();
    if (this.vertBuf) gl.deleteBuffer(this.vertBuf);
    if (this.indexBuf) gl.deleteBuffer(this.indexBuf);
    if (this.vao) gl.deleteVertexArray(this.vao);
  }
}

/** Writes samples*2 vertices for one quadratic-bezier relation ribbon into `arr` at vertex offset. */
function writeEdgeVertices(arr, vOff, rec, pa, pb) {
  const p0x = pa.x, p0y = pa.y, p0z = pa.z;
  const p2x = pb.x, p2y = pb.y, p2z = pb.z;
  let dx = p2x - p0x, dy = p2y - p0y, dz = p2z - p0z;
  const len = Math.hypot(dx, dy, dz) || 1;
  const ux = dx / len, uy = dy / len, uz = dz / len;
  // perpendicular in the galactic plane (fallback: screen-ish up for vertical pairs)
  let px = -uy, py = ux, pz = 0;
  let plen = Math.hypot(px, py, pz);
  if (plen < 0.02) { px = 1; py = 0; pz = 0; plen = 1; }
  px /= plen; py /= plen; pz /= plen;
  const sign = rec.seed > 0.5 ? 1 : -1;
  const bulge = len * rec.curve * (0.55 + 0.9 * rec.seed) * sign;
  const zB = rec.zBulge ? len * (0.12 + 0.12 * rec.seed) : 0;
  const c1x = (p0x + p2x) * 0.5 + px * bulge;
  const c1y = (p0y + p2y) * 0.5 + py * bulge;
  const c1z = (p0z + p2z) * 0.5 + pz * bulge + zB;

  const n = rec.samples;
  const vp = FLOATS_PER_VERTEX;
  for (let s = 0; s < n; s++) {
    const t = s / (n - 1);
    const it = 1 - t;
    const x = it * it * p0x + 2 * it * t * c1x + t * t * p2x;
    const y = it * it * p0y + 2 * it * t * c1y + t * t * p2y;
    const z = it * it * p0z + 2 * it * t * c1z + t * t * p2z;
    let tx = 2 * it * (c1x - p0x) + 2 * t * (p2x - c1x);
    let ty = 2 * it * (c1y - p0y) + 2 * t * (p2y - c1y);
    let tz = 2 * it * (c1z - p0z) + 2 * t * (p2z - c1z);
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    for (let side = 0; side < 2; side++) {
      const o = (vOff + s * 2 + side) * vp;
      const sMul = side === 0 ? -1 : 1;
      arr[o] = x; arr[o + 1] = y; arr[o + 2] = z;
      arr[o + 3] = tx; arr[o + 4] = ty; arr[o + 5] = tz;
      arr[o + 6] = t; arr[o + 7] = sMul; arr[o + 8] = rec.seed;
      arr[o + 9] = rec.color[0]; arr[o + 10] = rec.color[1]; arr[o + 11] = rec.color[2];
      arr[o + 12] = rec.alpha; arr[o + 13] = rec.dash;
    }
  }
}

/** deterministic [0,1) rand from int */
export function rand01(n) {
  let x = (n ^ 0x9e3779b9) >>> 0;
  x ^= x << 13; x >>>= 0;
  x ^= x >> 17; x ^= x << 5; x >>>= 0;
  return x / 4294967296;
}


