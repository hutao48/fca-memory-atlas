// FCA Memory Atlas — Nebula Renderer
// createNebula(container, options) -> instance   (interface frozen in docs/PUBLIC_INTERFACE_FREEZE.md §5)
//
// 方案 A (default): data-driven volumetric nebula — half-resolution raymarch with one anisotropic
//   emission kernel per cluster + domain-warped FBM gas + high-frequency dust absorption, instanced
//   star billboards for nodes, camera-facing particle filaments for relations, HDR bloom + ACES post.
// 方案 B (setPipeline('baked')): same data sources, but the gas field is baked once on the CPU into an
//   RGBA16F texture and drawn as a flat world plane (no volume parallax, no depth dust).
//
// Everything renders from the §5 render contract (nodes/edges/clusters/stats). No external assets.
import { Camera } from './camera.js';
import { Fullscreen, createFBO, resizeFBO, disposeFBO, hashString, clamp, mulberry32 } from './glutil.js';
import { BackgroundPass } from './background.js';
import { VolumePass } from './volume.js';
import { BakedNebula } from './baked.js';
import { Post } from './post.js';
import { NodePass, EdgePass } from './marks.js';
import { Overlay } from './overlay.js';
import { FLAT_BG_FS } from './shaders.js';
import {
  defaultMapping, mergeMapping, buildLegend, RELATION_STYLES, COLOR_HINTS,
  MEMORY_TYPES, ENTITY_TYPES, nodeTypeColor, hintColor, hexToLinear,
} from './palette.js';

const QUALITY = {
  ultra:  { dprCap: 2.0, renderScale: 1.0, maxPixels: 6.0e6, volumeScale: 0.62, steps: 112, bloomLevels: 6, labelBudget: 28, clusterLabels: true, post: true },
  high:   { dprCap: 1.75, renderScale: 1.0, maxPixels: 4.4e6, volumeScale: 0.50, steps: 88, bloomLevels: 5, labelBudget: 12, clusterLabels: true, post: true },
  medium: { dprCap: 1.5, renderScale: 0.92, maxPixels: 3.0e6, volumeScale: 0.42, steps: 64, bloomLevels: 4, labelBudget: 13, clusterLabels: true, post: true },
  low:    { dprCap: 1.25, renderScale: 0.8, maxPixels: 1.8e6, volumeScale: 0.32, steps: 40, bloomLevels: 3, labelBudget: 8, clusterLabels: false, post: true },
  off:    { dprCap: 1.5, renderScale: 1.0, maxPixels: 3.0e6, volumeScale: 0, steps: 0, bloomLevels: 0, labelBudget: 24, clusterLabels: true, post: false },
};

const CSS_FONT = '"Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif';

export function createNebula(container, options = {}) {
  return new Nebula(container, options);
}

class Nebula {
  constructor(container, options = {}) {
    if (typeof container === 'string') container = document.querySelector(container);
    if (!container || !container.nodeType) throw new Error('[nebula] container element required');
    this.container = container;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    this.options = options || {};
    this.mapping = mergeMapping(defaultMapping(), options.mapping || {});
    this.quality = QUALITY[options.quality] ? options.quality : 'high';
    this.qcfg = QUALITY[this.quality];
    this._pipeline = options.pipeline === 'baked' ? 'baked' : 'volume';
    this._labelMode = options.labels === false ? 'off' : 'auto';
    this._layers = {
      background: true,
      nebula: !options.layers || options.layers.nebula !== false,
      edges: !options.layers || options.layers.edges !== false,
      labels: !options.layers || options.layers.labels !== false,
    };
    this._showClusterLabels = options.clusterLabels === true;
    this._interactive = options.interactive !== false;
    this._handlers = new Map();
    this._time = 0;
    this._lastFrame = 0;
    this._frameTimes = [];
    this._drawCalls = 0;
    this._perf = { fps: 0, frame_ms: 0, p95_frame_ms: 0, draw_calls: 0 };
    this._lastPerfEmit = 0;
    this._lastViewEmit = 0;
    this._lastOverlay = 0;
    this._labelsDirty = true;
    this._projKey = '';
    this._proj = new Float32Array(0);
    this._posVersion = 0;
    this._timeStart = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    this._frames = 0;
    this._destroyed = false;
    this._contextLost = false;

    // data / interaction state
    this.graph = { api_version: '1', nodes: [], edges: [], clusters: [], stats: { nodes: 0, edges: 0, clusters: 0 } };
    this._dataSet = false;
    this.nodeRecords = [];
    this.nodeIndex = new Map();
    this._positionsMap = new Map();
    this.clusterPrepared = [];
    this.emitters = [];
    this.graphBounds = { min: [-5000, -5000, -500], max: [5000, 5000, 500] };
    this.selected = new Set();
    this.hoveredId = null;
    this._focus = { id: null, depth: 0, set: null };
    this.filters = { types: [], tags: [], projects: [], timeRange: null };
    this._filteredSet = new Set();
    this._adjacency = new Map();
    this._edgeIndexByNode = new Map();
    this._projectMap = new Map();
    this._drag = null;
    this._boxEl = null;
    this._onViewChange = null;

    // GL
    this.gl = null;
    this.hdr = false;
    this._fallback = false;
    this.camera = new Camera();
    this._initGL();
    if (this.gl) {
      this.background = new BackgroundPass(this.gl);
      this.volume = new VolumePass(this.gl);
      this.nodePass = new NodePass(this.gl);
      this.edgePass = new EdgePass(this.gl);
      this.post = new Post(this.gl, this.hdr);
      this.baked = new BakedNebula(this.gl, this.hdr);
      this._flatBg = new Fullscreen(this.gl, FLAT_BG_FS, 'flat-bg');
      this.scene = null;
      this._resize();
      this._bindInput();
      this._observeResize();
      this._raf = requestAnimationFrame(this._loop);
    }
    this.overlay = new Overlay(container);
    this.overlay.setVisible(true);

    // additive desktop/debug hooks (Lead capture verification uses these)
    const self = this;
    try {
      globalThis.__FCA_NEBULA_STATS__ = function () { return self.getStats(); };
      globalThis.__FCA_NEBULA__ = this;
    } catch (_) { /* non-browser context */ }
  }

  /* ---------------------------------------------------------------- *
   * GL init / sizing
   * ---------------------------------------------------------------- */
  _initGL() {
    const canvas = document.createElement('canvas');
    canvas.className = 'fca-nebula-canvas';
    Object.assign(canvas.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      display: 'block', zIndex: '1', background: '#04060d',
    });
    this.container.appendChild(canvas);
    this.canvas = canvas;
    let gl = null;
    try {
      gl = canvas.getContext('webgl2', {
        antialias: false, alpha: false, depth: false, stencil: false,
        preserveDrawingBuffer: false, powerPreference: 'high-performance',
      });
    } catch (e) { gl = null; }
    if (!gl) {
      this._fallback = true;
      const msg = document.createElement('div');
      Object.assign(msg.style, {
        position: 'absolute', inset: '0', display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#b9cbe6', font: '13px/1.9 ' + CSS_FONT, padding: '24px', textAlign: 'center',
        background: 'radial-gradient(ellipse at 50% 40%, #0b1220 0%, #04060d 70%)',
      });
      msg.textContent = '此环境不支持 WebGL2，星云渲染不可用。桌面端会显示降级提示。';
      this.container.appendChild(msg);
      this._fallbackEl = msg;
      return;
    }
    this.gl = gl;
    const colorFloat = !!gl.getExtension('EXT_color_buffer_float');
    const linFloat = !!gl.getExtension('OES_texture_float_linear');
    gl.getExtension('EXT_float_blend');
    this.hdr = colorFloat && linFloat;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this._contextLost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this._contextLost = false; this._resize(true); });
  }

  _observeResize() {
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => { this._resize(); });
      this._ro.observe(this.container);
    }
    this._onWinResize = () => this._resize();
    window.addEventListener('resize', this._onWinResize);
  }

  _resize(force = false) {
    if (!this.gl) return;
    const q = this.qcfg;
    const cssW = Math.max(2, this.container.clientWidth || this.container.getBoundingClientRect().width || 1600);
    const cssH = Math.max(2, this.container.clientHeight || this.container.getBoundingClientRect().height || 1000);
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    let scale = Math.min(dpr, q.dprCap) * q.renderScale;
    let bufW = Math.max(2, Math.round(cssW * scale));
    let bufH = Math.max(2, Math.round(cssH * scale));
    if (bufW * bufH > q.maxPixels) {
      const f = Math.sqrt(q.maxPixels / (bufW * bufH));
      bufW = Math.max(2, Math.round(bufW * f));
      bufH = Math.max(2, Math.round(bufH * f));
    }
    if (!force && this._buf && this._buf.w === bufW && this._buf.h === bufH && this.viewport && this.viewport.w === cssW && this.viewport.h === cssH) return;
    this.viewport = { w: cssW, h: cssH };
    this._buf = { w: bufW, h: bufH };
    this.canvas.width = bufW;
    this.canvas.height = bufH;
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.pixelScale = bufW / cssW;
    this.camera.setAspect(bufW, bufH);
    if (q.post) {
      // HDR scene target is owned by the post pipeline (single source of truth for composite input)
      this.post.resize(bufW, bufH, q.bloomLevels);
      this.scene = this.post.scene;
    } else {
      this.scene = null;
    }
    this.volume.volumeScale = q.volumeScale;
    this.volume.steps = q.steps;
    if (q.volumeScale > 0 && this.scene) this.volume.resize(bufW, bufH);
    this._projKey = '';
    this._labelsDirty = true;
  }

  /* ---------------------------------------------------------------- *
   * Data intake
   * ---------------------------------------------------------------- */
  setData(graph) {
    if (!graph || !Array.isArray(graph.nodes)) graph = { api_version: '1', nodes: [], edges: [], clusters: [], stats: { nodes: 0, edges: 0, clusters: 0 } };
    this.graph = graph;
    this._dataSet = true;
    const nodes = graph.nodes.filter((n) => n && !n.deleted && n.position);
    const edges = (graph.edges || []).filter((e) => e && !e.deleted);

    // bounds + records
    const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    const records = [];
    const index = new Map();
    const positions = new Map();
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const isEntity = n.kind === 'entity';
      const base = nodeTypeColor(n, this.mapping);
      // photographic grade: type color pulled slightly toward cool starlight (no plastic saturation)
      const color = mix3(base, isEntity ? [0.72, 0.78, 0.92] : [0.80, 0.86, 1.0], isEntity ? 0.42 : 0.24);
      const imp = clamp(num(n.importance, 0.2), 0, 1);
      const dw = clamp(num(n.display_weight, 1), 0, 2);
      const deg = Math.sqrt(Math.max(0, num(n.degree, 0)));
      const seed = (hashString(String(n.id)) % 10000) / 10000;
      // 星体亮度/大小：真实天文摄影里绝大多数恒星很暗，只有少数亮星抢眼。
      // importance 决定“是否点亮”，degree 只做轻微加成；显示倍数（display_weight）控制整体可见度。
      const pxBase = isEntity ? 2.2 : 1.9;
      const sizePx = (pxBase + 6.6 * Math.pow(imp, 1.05) * (0.72 + 0.5 * Math.sqrt(Math.max(0.1, dw))) * (1 + 0.03 * deg)) * (isEntity ? 0.78 : 1);
      const brightness = (0.08 + 0.92 * Math.pow(imp, 1.9)) * (0.52 + 0.48 * Math.min(dw, 1.8)) * (1 + 0.04 * deg) * (isEntity ? 0.46 : 1);
      const pos = { x: num(n.position.x, 0), y: num(n.position.y, 0), z: num(n.position.z, 0) };
      const rec = {
        index: i,
        id: String(n.id), kind: n.kind === 'entity' ? 'entity' : 'memory', type: n.type || 'episodic',
        label: String(n.label ?? n.title ?? n.id ?? '').slice(0, 80),
        importance: imp, displayWeight: dw, degree: num(n.degree, 0),
        clusterId: n.cluster_id || null, tags: Array.isArray(n.tags) ? n.tags : [],
        occurredAt: n.occurred_at ? Date.parse(n.occurred_at) : null,
        pos, baseColor: color, baseBrightness: brightness, sizePx, seed,
        flags: 0, isEntity,
      };
      records.push(rec);
      index.set(rec.id, rec);
      positions.set(rec.id, pos);
      bounds.min[0] = Math.min(bounds.min[0], pos.x); bounds.min[1] = Math.min(bounds.min[1], pos.y); bounds.min[2] = Math.min(bounds.min[2], pos.z);
      bounds.max[0] = Math.max(bounds.max[0], pos.x); bounds.max[1] = Math.max(bounds.max[1], pos.y); bounds.max[2] = Math.max(bounds.max[2], pos.z);
    }
    if (!nodes.length) bounds.min = [-3200, -3200, -400], bounds.max = [3200, 3200, 400];
    this.nodeRecords = records;
    this.nodeIndex = index;
    this._positionsMap = positions;
    this.graphBounds = bounds;
    for (const n of nodes) { bounds.min[0] = Math.min(bounds.min[0], n.position.x); bounds.max[0] = Math.max(bounds.max[0], n.position.x); }

    // world size: calibrated so that at fit view the node is `sizePx` CSS px on a 1000px-tall viewport
    const fitRadius = Math.max(2200, 0.5 * Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]));
    for (const rec of records) {
      rec.sizeWorld = rec.sizePx * fitRadius * 0.00256;
      rec.sizeWorld = Math.max(rec.sizeWorld, fitRadius * 0.0009);
    }

    // adjacency, project mapping
    this._adjacency = new Map();
    this._edgeIndexByNode = new Map();
    this._projectMap = new Map();
    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      if (!e.from || !e.to) continue;
      if (!this._adjacency.has(e.from)) this._adjacency.set(e.from, new Set());
      if (!this._adjacency.has(e.to)) this._adjacency.set(e.to, new Set());
      this._adjacency.get(e.from).add(e.to);
      this._adjacency.get(e.to).add(e.from);
      if (!this._edgeIndexByNode.has(e.from)) this._edgeIndexByNode.set(e.from, []);
      if (!this._edgeIndexByNode.has(e.to)) this._edgeIndexByNode.set(e.to, []);
      this._edgeIndexByNode.get(e.from).push(ei);
      this._edgeIndexByNode.get(e.to).push(ei);
      if (e.relation_type === 'belongs_to_project') {
        const proj = index.get(e.from)?.kind === 'entity' ? e.from : e.to;
        const mem = proj === e.from ? e.to : e.from;
        if (!this._projectMap.has(mem)) this._projectMap.set(mem, new Set());
        this._projectMap.get(mem).add(proj);
      }
    }

    // clusters -> renderer-ready emitters
    this._prepareClusters(graph.clusters || [], fitRadius);

    // camera framing
    if (nodes.length) {
      const view = graph.view;
      if (this._dataSet && this.options.autoFit !== false) {
        this.camera.fitBounds(bounds, Number.isFinite(this.options.fitPadding) ? this.options.fitPadding : 0.02);
        if (view && Array.isArray(view.center) && Number.isFinite(view.zoom) && Math.abs(view.zoom - 1) > 0.01) {
          this.camera.setTarget(view.center[0] || 0, view.center[1] || 0, view.center[2] || 0, true);
          this.camera.setZoom(view.zoom, true);
        }
      }
    } else {
      this.camera.fitBounds(bounds, 0.14);
    }
    if (this.options.angles) {
      this.camera.setAngles(num(this.options.angles.yaw, -0.9), num(this.options.angles.pitch, 0.30));
    }
    this.camera.update(1);
    this._posVersion++;
    this._projKey = '';

    // layers
    this.nodePass.setNodes(records);
    this.background.configure(this.emitters, hashString(String((graph.stats && graph.stats.generated_at) || '') + nodes.length));
    const zPad = Math.max(1400, (bounds.max[2] - bounds.min[2]) * 2 + 1000);
    const box = {
      min: [bounds.min[0] - (bounds.max[0] - bounds.min[0]) * 0.16 - 300,
        bounds.min[1] - (bounds.max[1] - bounds.min[1]) * 0.16 - 300,
        -zPad],
      max: [bounds.max[0] + (bounds.max[0] - bounds.min[0]) * 0.16 + 300,
        bounds.max[1] + (bounds.max[1] - bounds.min[1]) * 0.16 + 300,
        zPad],
    };
    this.volumeBox = box;
    this.volume.setClusters(this.emitters, box, scale3(this.background.tintA, 1.25));
    this._filteredSet = this._computeFilteredSet();
    this._rebuildEdges();
    this._refreshStates();
    this._bakedKey = '';
    this._labelsDirty = true;
    this.overlay.setEmpty(!nodes.length && this.options.emptyOverlay !== false);
    this._dataVersion = (this._dataVersion || 0) + 1;
  }

  _prepareClusters(clusters, fitRadius) {
    const count = Math.max(1, this.nodeRecords.length);
    const prepared = [];
    const colorById = new Map();
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i] || {};
      const ids = Array.isArray(c.node_ids) ? c.node_ids : [];
      const members = [];
      for (const id of ids) { const rec = this.nodeIndex.get(id); if (rec) members.push(rec); }
      let cx = num(c.centroid && c.centroid.x, 0), cy = num(c.centroid && c.centroid.y, 0), cz = num(c.centroid && c.centroid.z, 0);
      if (members.length) {
        let sx = 0, sy = 0, sz = 0, sw = 0;
        for (const m of members) { const w = 0.4 + m.importance; sx += m.pos.x * w; sy += m.pos.y * w; sz += m.pos.z * w; sw += w; }
        cx = sx / sw; cy = sy / sw; cz = sz / sw;
      }
      const density = clamp(num(c.density, 0.5), 0.05, 1);
      const hint = c.color_hint || 'blue';
      const hintLin = hintColor(hint, this.mapping);
      const domType = Array.isArray(c.dominant_types) && c.dominant_types[0];
      const domTable = MEMORY_TYPES[domType] ? MEMORY_TYPES[domType] : null;
      const domLin = domTable ? hexToLinear(domTable.hex) : hintLin;
      let color = mix3(hintLin, domLin, 0.30);
      color = mix3(color, [0.6, 0.7, 0.9], 0.10);
      const id = c.id || 'cluster_' + i;
      colorById.set(id, color);
      prepared.push({
        id,
        label: String(c.label || c.id || ''),
        centroid: { x: cx, y: cy, z: cz },
        count: members.length,
        density,
        linearColor: color,
        seed: (hashString(String(c.id || i)) % 1000) / 1000,
        _hintHex: (COLOR_HINTS[hint] || COLOR_HINTS.blue).hex,
        hint,
        labelPos: null,
      });
    }

    // ------------------------------------------------------------------
    // 气体发射核：按真实节点的空间密度做确定性 k-means 分区（KDE 近似），
    // 每个密集区 = 一团各向异性气体云。这样星云形状来自“节点密度 + clusters 颜色”，
    // 而不是把语义聚类质心强行叠在一起（那会变成一坨过曝白球）。
    // ------------------------------------------------------------------
    const recs = this.nodeRecords;
    const minR = Math.max(60, fitRadius * 0.022);
    const maxR = Math.max(minR * 3.2, fitRadius * 0.55);
    const emitters = [];
    if (recs.length) {
      const k = clamp(Math.round(Math.sqrt(recs.length) * 1.35), 6, 28);
      const centers = [];
      // 确定性最远点初始化：从最重要节点开始，依次选择距已有中心最远的节点
      const seedRec = recs.reduce((a, b) => (b.importance > a.importance || (b.importance === a.importance && b.id < a.id) ? b : a), recs[0]);
      centers.push({ x: seedRec.pos.x, y: seedRec.pos.y, z: seedRec.pos.z });
      while (centers.length < k) {
        let far = null;
        let farD = -1;
        for (const r of recs) {
          let dmin = Infinity;
          for (const c of centers) {
            const dx = r.pos.x - c.x, dy = r.pos.y - c.y;
            const d = dx * dx + dy * dy;
            if (d < dmin) dmin = d;
          }
          const w = 0.5 + r.importance;
          const score = dmin * w;
          if (score > farD) { farD = score; far = r; }
        }
        if (!far) break;
        centers.push({ x: far.pos.x, y: far.pos.y, z: far.pos.z });
      }
      let assign = new Array(recs.length).fill(0);
      for (let iter = 0; iter < 12; iter += 1) {
        assign = recs.map((r) => {
          let bi = 0;
          let bd = Infinity;
          for (let ci = 0; ci < centers.length; ci += 1) {
            const c = centers[ci];
            const dx = r.pos.x - c.x, dy = r.pos.y - c.y;
            const d = dx * dx + dy * dy;
            if (d < bd) { bd = d; bi = ci; }
          }
          return bi;
        });
        const sums = centers.map(() => ({ x: 0, y: 0, z: 0, w: 0 }));
        for (let ri = 0; ri < recs.length; ri += 1) {
          const r = recs[ri];
          const s = sums[assign[ri]];
          const w = 0.3 + r.importance;
          s.x += r.pos.x * w; s.y += r.pos.y * w; s.z += r.pos.z * w; s.w += w;
        }
        for (let ci = 0; ci < centers.length; ci += 1) {
          const s = sums[ci];
          if (s.w > 0) { centers[ci].x = s.x / s.w; centers[ci].y = s.y / s.w; centers[ci].z = s.z / s.w; }
        }
      }
      const regions = centers.map(() => ({ members: [], w: 0, sx: 0, sy: 0, sz: 0, cx: 0, cy: 0, cz: 0 }));
      for (let ri = 0; ri < recs.length; ri += 1) {
        const r = recs[ri];
        const g = regions[assign[ri]];
        const w = 0.3 + r.importance;
        g.members.push(ri);
        g.w += w;
        g.sx += r.pos.x * w; g.sy += r.pos.y * w; g.sz += r.pos.z * w;
      }
      for (let ci = 0; ci < regions.length; ci += 1) {
        const g = regions[ci];
        if (!g.members.length) continue;
        const cx = g.sx / g.w, cy = g.sy / g.w, cz = g.sz / g.w;
        let vx = 0, vy = 0, vz = 0;
        const color = [0, 0, 0];
        let colorW = 0;
        const clusterWeight = new Map();
        for (const ri of g.members) {
          const r = recs[ri];
          const w = 0.3 + r.importance;
          vx += (r.pos.x - cx) ** 2 * w;
          vy += (r.pos.y - cy) ** 2 * w;
          vz += (r.pos.z - cz) ** 2 * w;
          if (r.clusterId) clusterWeight.set(r.clusterId, (clusterWeight.get(r.clusterId) || 0) + w);
          const col = colorById.get(r.clusterId) || r.baseColor;
          color[0] += col[0] * w; color[1] += col[1] * w; color[2] += col[2] * w;
          colorW += w;
        }
        // 区域颜色：以主导聚类（而不是所有成员平均）为准，保住色相差异，避免全部混成冷蓝灰
        const ranked = [...clusterWeight.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
        let regionColor = null;
        if (ranked.length) {
          const c0 = colorById.get(ranked[0][0]) || null;
          const c1 = ranked[1] ? colorById.get(ranked[1][0]) || null : null;
          if (c0) {
            regionColor = c1 ? mix3(c0, c1, 0.28) : c0;
          }
        }
        if (!regionColor && colorW > 0) regionColor = [color[0] / colorW, color[1] / colorW, color[2] / colorW];
        if (!regionColor) regionColor = [0.35, 0.45, 0.68];
        // 提高色度（深空发射线是有颜色的，不能是灰白雾）
        const luma = regionColor[0] * 0.3 + regionColor[1] * 0.55 + regionColor[2] * 0.15;
        regionColor = regionColor.map((v) => Math.max(0, luma + (v - luma) * 1.55));
        const rmsX = Math.sqrt(vx / g.w), rmsY = Math.sqrt(vy / g.w), rmsZ = Math.sqrt(vz / g.w);
        const sigX = clamp(rmsX * 1.28 + minR * 0.7, minR * 1.4, maxR);
        const sigY = clamp(rmsY * 1.28 + minR * 0.7, minR * 1.4, maxR);
        const sigZ = clamp(rmsZ * 1.3 + minR * 1.4, minR * 1.6, maxR * 1.2);
        const share = g.members.length / Math.max(1, recs.length);
        const intensity = 0.22 + 0.40 * Math.pow(share, 0.5);
        // 体积星云需要前后层次：给每个气体核一个确定性深度偏移（节点坐标仍严格来自 Runtime）。
        // 正面气体遮挡后景、后景气体被前景尘埃吸收 → 真实深空的纵深感与视差。
        const zJitter = ((hashString('z:' + ci + ':' + Math.round(cx) + ':' + Math.round(cy)) % 2000) / 1000 - 1)
          * Math.min(520, Math.max(140, fitRadius * 0.16));
        const zc = cz + zJitter;
        emitters.push({
          id: 'region_' + ci,
          centroid: { x: cx, y: cy, z: zc },
          invScale: [1 / sigX, 1 / sigY, 1 / sigZ],
          sigma: [sigX, sigY, sigZ],
          intensity,
          density: clamp(g.members.length / (recs.length * 0.12), 0.15, 1),
          count: g.members.length,
          linearColor: mix3(regionColor, [0.52, 0.62, 0.86], 0.06),
          seed: (hashString('region:' + ci + ':' + Math.round(cx) + ':' + Math.round(cy)) % 1000) / 1000,
          memberIndexes: g.members,
        });
      }
      // 每个语义聚类在“成员最多的密度区”上标注名称（聚类模式标签使用）
      const regionOfCluster = new Map();
      for (let ci = 0; ci < prepared.length; ci += 1) regionOfCluster.set(prepared[ci].id, new Map());
      for (let ri = 0; ri < emitters.length; ri += 1) {
        for (const mi of emitters[ri].memberIndexes) {
          const cid = recs[mi].clusterId;
          if (!cid) continue;
          const counts = regionOfCluster.get(cid);
          if (!counts) continue;
          counts.set(ri, (counts.get(ri) || 0) + 1);
        }
      }
      for (const c of prepared) {
        const counts = regionOfCluster.get(c.id);
        if (!counts || counts.size === 0) { c.labelPos = c.centroid; continue; }
        let bestRi = -1;
        let bestCount = -1;
        for (const [ri, n] of counts) {
          if (n > bestCount || (n === bestCount && ri < bestRi)) { bestCount = n; bestRi = ri; }
        }
        c.labelPos = bestRi >= 0 ? emitters[bestRi].centroid : c.centroid;
      }
      // 外围弥散气体：以整张图的包围盒中心为一个超大低强度发射核，
      // 让星云气体延伸到节点云之外（真实星云比嵌入的星团更大），边缘被画幅裁切。
      const gb = this.graphBounds;
      const gcx = (gb.min[0] + gb.max[0]) / 2;
      const gcy = (gb.min[1] + gb.max[1]) / 2;
      const gcz = (gb.min[2] + gb.max[2]) / 2;
      let ambColor = [0, 0, 0];
      let ambW = 0;
      for (const c of prepared) {
        const w = Math.max(1, c.count);
        ambColor[0] += c.linearColor[0] * w; ambColor[1] += c.linearColor[1] * w; ambColor[2] += c.linearColor[2] * w;
        ambW += w;
      }
      if (ambW > 0) ambColor = [ambColor[0] / ambW, ambColor[1] / ambW, ambColor[2] / ambW];
      emitters.push({
        id: 'ambient',
        centroid: { x: gcx, y: gcy, z: gcz - fitRadius * 0.38 },
        invScale: [1 / (fitRadius * 0.9), 1 / (fitRadius * 0.9), 1 / (fitRadius * 0.45)],
        sigma: [fitRadius * 0.9, fitRadius * 0.9, fitRadius * 0.45],
        intensity: 0.030,
        density: 0.05,
        count: 0,
        linearColor: mix3(ambColor, [0.38, 0.50, 0.78], 0.35),
        seed: 0.5,
        memberIndexes: [],
        ambient: true,
      });
      emitters.sort((a, b) => b.intensity * Math.sqrt(b.count + 1) - a.intensity * Math.sqrt(a.count + 1));
    }
    prepared.sort((a, b) => b.count - a.count || String(a.id).localeCompare(String(b.id)));
    this.clusterPrepared = prepared;
    this.emitters = emitters;
  }

  _computeFilteredSet() {
    const f = this.filters;
    const out = new Set();
    const active = (f.types && f.types.length) || (f.tags && f.tags.length) || (f.projects && f.projects.length) || (f.timeRange && f.timeRange.length === 2);
    if (!active) return out;
    for (const rec of this.nodeRecords) {
      let ok = true;
      if (f.types && f.types.length && rec.kind === 'memory' && !f.types.includes(rec.type)) ok = false;
      if (ok && f.tags && f.tags.length) {
        ok = f.tags.some((t) => rec.tags.includes(t));
      }
      if (ok && f.projects && f.projects.length) {
        const linked = this._projectMap.get(rec.id);
        const labelOk = f.projects.some((p) => rec.tags.includes(p) || (linked && [...linked].some((pid) => this.nodeIndex.get(pid)?.label === p || pid === p)));
        if (!labelOk) ok = false;
      }
      if (ok && f.timeRange && f.timeRange.length === 2) {
        const t0 = parseTime(f.timeRange[0]), t1 = parseTime(f.timeRange[1]);
        if (rec.occurredAt == null) ok = false;
        else ok = rec.occurredAt >= t0 && rec.occurredAt <= t1;
      }
      if (!ok) out.add(rec.id);
    }
    return out;
  }

  _rebuildEdges() {
    const dimmed = this._focus.set ? new Set() : null;
    if (dimmed) {
      for (const rec of this.nodeRecords) if (!this._focus.set.has(rec.id)) dimmed.add(rec.id);
    }
    const edgeNodeIndex = new Map();
    for (const rec of this.nodeRecords) edgeNodeIndex.set(rec.id, { position: rec.pos, kind: rec.kind, type: rec.type });
    const samples = this.nodeRecords.length > 6000 ? 9 : 12;
    this.edgePass.build(this.graph.edges || [], edgeNodeIndex, {
      samples,
      styles: RELATION_STYLES,
      mapping: this.mapping,
      hidden: this._filteredSet.size ? this._filteredSet : null,
      dimmed,
    });
    this._edgeCount = this.edgePass.visibleEdges;
  }

  _refreshStates() {
    const states = new Array(this.nodeRecords.length);
    const focusSet = this._focus.set;
    for (let i = 0; i < this.nodeRecords.length; i++) {
      const rec = this.nodeRecords[i];
      let flags = 0;
      const sel = this.selected.has(rec.id);
      const hov = this.hoveredId === rec.id;
      if (sel) flags |= 1;
      if (hov) flags |= 2;
      let dimmed = false;
      if (focusSet) {
        if (focusSet.has(rec.id)) flags |= 4;
        else { flags |= 8; dimmed = true; }
      }
      if (this._filteredSet.has(rec.id)) { flags |= 8; dimmed = true; }
      if (rec.isEntity) flags |= 16;
      let brightness = rec.baseBrightness * this.mapping.nodeBrightness;
      if (sel) brightness *= 1.16;
      else if (hov) brightness *= 1.22;
      states[i] = { sizeWorld: rec.sizeWorld, brightness, flags, seed: rec.seed };
    }
    this.nodePass.updateData(states);
  }

  /* ---------------------------------------------------------------- *
   * Public API (frozen signatures)
   * ---------------------------------------------------------------- */
  setMapping(mapping) {
    this.mapping = mergeMapping(this.mapping, mapping || {});
    // recolour nodes
    for (const rec of this.nodeRecords) {
      const n = { kind: rec.kind, type: rec.type };
      const base = nodeTypeColor(n, this.mapping);
      rec.baseColor = mix3(base, rec.isEntity ? [0.72, 0.78, 0.92] : [0.80, 0.86, 1.0], rec.isEntity ? 0.42 : 0.24);
    }
    if (this.gl) {
      const colors = new Float32Array(this.nodeRecords.length * 3);
      for (let i = 0; i < this.nodeRecords.length; i++) {
        colors[i * 3] = this.nodeRecords[i].baseColor[0];
        colors[i * 3 + 1] = this.nodeRecords[i].baseColor[1];
        colors[i * 3 + 2] = this.nodeRecords[i].baseColor[2];
      }
      this.nodePass.setColors(colors);
      this._prepareClusters(this.graph.clusters || [], this.camera.fit.radius);
      this.volume.setClusters(this.emitters, this.volumeBox, scale3(this.background.tintA, 1.25));
      this.background.configure(this.emitters, hashString('mapping' + this.nodeRecords.length));
      this._rebuildEdges();
      this._refreshStates();
      this._bakedKey = '';
    }
    return this;
  }

  setQuality(level) {
    const lv = QUALITY[level] ? level : 'high';
    this.quality = lv;
    this.qcfg = QUALITY[lv];
    if (this.gl) {
      this.volume.enabled = this.qcfg.volumeScale > 0;
      this.volume.volumeScale = this.qcfg.volumeScale;
      this.volume.steps = this.qcfg.steps;
      this._resize(true);
      this._lastOverlay = 0;
    }
    this._emit('quality:change', { quality: lv, post: this.qcfg.post, pipeline: this._pipeline });
    return this;
  }

  setView(view = {}) {
    if (!this.gl) return this;
    if (view.center) {
      const c = Array.isArray(view.center) ? view.center : [view.center.x, view.center.y, view.center.z];
      this.camera.setTarget(num(c[0], 0), num(c[1], 0), num(c[2], 0));
    }
    if (Number.isFinite(view.zoom)) this.camera.setZoom(view.zoom);
    this._emitViewChange(true);
    return this;
  }

  getView() {
    return { center: [this.camera.target[0], this.camera.target[1], this.camera.target[2]], zoom: +this.camera.zoom.toFixed(4) };
  }

  fitToContent(opts = {}) {
    if (!this.gl) return this;
    const padding = Number.isFinite(opts.padding) ? opts.padding : 0.15;
    this.camera.fitToContent(padding);
    this._emitViewChange(true);
    return this;
  }

  focusNode(id, opts = {}) {
    const depth = clamp(num(opts.depth, 1) | 0, 1, 3);
    if (!id || !this.nodeIndex.has(String(id))) {
      this._focus = { id: null, depth: 0, set: null };
    } else {
      const root = String(id);
      const set = new Set([root]);
      let frontier = [root];
      for (let d = 0; d < depth; d++) {
        const next = [];
        for (const cur of frontier) {
          const nb = this._adjacency.get(cur);
          if (!nb) continue;
          for (const v of nb) if (!set.has(v)) { set.add(v); next.push(v); }
        }
        frontier = next;
      }
      this._focus = { id: root, depth, set };
    }
    if (this.gl) { this._rebuildEdges(); this._refreshStates(); }
    this._labelsDirty = true;
    this._emit('focus:change', { id: this._focus.id, depth: this._focus.depth, count: this._focus.set ? this._focus.set.size : 0 });
    return this;
  }

  select(ids) {
    const next = new Set();
    const arr = Array.isArray(ids) ? ids : ids == null ? [] : [ids];
    for (const id of arr) {
      const s = String(id);
      if (this.nodeIndex.has(s)) next.add(s);
    }
    const changed = next.size !== this.selected.size || [...next].some((id) => !this.selected.has(id));
    this.selected = next;
    if (this.gl) this._refreshStates();
    this._labelsDirty = true;
    if (changed) this._emit('selection:change', { ids: [...this.selected] });
    return this;
  }

  setFilters(filters = {}) {
    this.filters = {
      types: Array.isArray(filters.types) ? filters.types : [],
      tags: Array.isArray(filters.tags) ? filters.tags : [],
      projects: Array.isArray(filters.projects) ? filters.projects : [],
      timeRange: Array.isArray(filters.timeRange) && filters.timeRange.length === 2 ? filters.timeRange : null,
    };
    if (this.gl) {
      this._filteredSet = this._computeFilteredSet();
      this._rebuildEdges();
      this._refreshStates();
    }
    this._labelsDirty = true;
    this._emit('filters:change', { filters: { ...this.filters }, hidden: this._filteredSet.size });
    return this;
  }

  on(event, handler) {
    if (typeof handler !== 'function') return () => {};
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const set = this._handlers.get(event);
    if (set) set.delete(handler);
    return this;
  }

  getStats() {
    const pads = (this._perf.p95_frame_ms || 0).toFixed(2);
    return {
      // frozen contract fields
      fps: Math.round(this._perf.fps * 10) / 10,
      frame_ms: Math.round(this._perf.frame_ms * 100) / 100,
      draw_calls: this._perf.draw_calls,
      // additive diagnostics
      p95_frame_ms: Number(pads),
      nodes: this.graph.stats ? this.graph.stats.nodes : this.nodeRecords.length,
      rendered_nodes: this.nodeRecords.length,
      edges: this.graph.stats ? this.graph.stats.edges : 0,
      rendered_edges: this._edgeCount || 0,
      clusters: this.clusterPrepared.length,
      quality: this.quality,
      pipeline: this.qcfg.post ? this._pipeline : 'off',
      webgl2: !!this.gl,
      hdr: this.hdr,
      gpu: this.gpu || null,
      resolution: this._buf ? { css: [this.viewport.w, this.viewport.h], buffer: [this._buf.w, this._buf.h], volume: this.volume && this.volume.fbo ? [this.volume.fbo.w, this.volume.fbo.h] : null } : null,
      camera: { center: [this.camera.target[0], this.camera.target[1], this.camera.target[2]], zoom: this.camera.zoom },
      selected: [...this.selected],
      focus: this._focus.id,
      labels: this._labelCount || 0,
      bake_ms: this.baked ? Math.round(this.baked.bakeMs * 10) / 10 : 0,
      frames: this._frames,
      context_lost: this._contextLost,
    };
  }

  getMapping() { return JSON.parse(JSON.stringify(this.mapping)); }

  getLegend() { return buildLegend(this.mapping); }

  /** additive: plan A / plan B switch (comparison + low-cost mode). */
  setPipeline(pipeline) {
    const p = pipeline === 'baked' ? 'baked' : 'volume';
    this._pipeline = p;
    if (p === 'baked') this._ensureBaked();
    this._emit('pipeline:change', { pipeline: p });
    return this;
  }

  getPipeline() { return this._pipeline; }

  /** additive: layer toggles (Desktop 图例/图层 UI 调用；未知键安全忽略) */
  setLayers(layers = {}) {
    this._layers = {
      background: this._layers.background !== false,
      nebula: layers.nebula !== undefined ? Boolean(layers.nebula) : this._layers.nebula,
      edges: layers.edges !== undefined ? Boolean(layers.edges) : this._layers.edges,
      labels: layers.labels !== undefined ? Boolean(layers.labels) : this._layers.labels,
    };
    this._labelMode = this._layers.labels ? 'auto' : 'off';
    this._labelsDirty = true;
    this._emit('layers:change', { ...this._layers });
    return this;
  }

  getLayers() { return { ...this._layers }; }

  /** additive: 聚类名称只在聚类模式/高倍时出现，避免总览时标签堆叠。 */
  setClusterLabels(enabled) {
    this._showClusterLabels = Boolean(enabled);
    this._labelsDirty = true;
    return this;
  }

  /** additive: hide/show labels programmatically */
  setLabels(enabled) {
    this._layers.labels = Boolean(enabled);
    this._labelMode = enabled ? 'auto' : 'off';
    this._labelsDirty = true;
    return this;
  }

  screenshotDataUrl() {
    if (!this.gl) return null;
    try {
      this._render(this._time);
      return this.canvas.toDataURL('image/png');
    } catch (e) { return null; }
  }

  destroy() {
    this._destroyed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._ro) this._ro.disconnect();
    if (this._onWinResize) window.removeEventListener('resize', this._onWinResize);
    this._unbindInput();
    if (this.gl) {
      try {
        this.background.dispose(); this.volume.dispose(); this.nodePass.dispose();
        this.edgePass.dispose(); this.post.dispose(); this.baked.dispose();
        disposeFBO(this.gl, this.scene);
        const lose = this.gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      } catch (e) { /* ignore */ }
    }
    if (this.overlay) this.overlay.dispose();
    if (this._boxEl) this._boxEl.remove();
    if (this.canvas) this.canvas.remove();
    if (this._fallbackEl) this._fallbackEl.remove();
    this._handlers.clear();
    try {
      if (globalThis.__FCA_NEBULA__ === this) { delete globalThis.__FCA_NEBULA__; delete globalThis.__FCA_NEBULA_STATS__; }
    } catch (e) { /* ignore */ }
  }

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */
  _loop = (now) => {
    if (this._destroyed) return;
    this._raf = requestAnimationFrame(this._loop);
    const time = now / 1000;
    const dt = this._lastFrame ? Math.min(0.1, time - this._lastFrame) : 1 / 60;
    this._lastFrame = time;
    this._time = time;
    if (this._fallback) return;
    this.camera.update(dt);
    if (this._contextLost) return;
    this._render(time);
    this._updateOverlay(time);
    this._trackPerf(now);
    this._frames++;
  };

  _render(time) {
    const gl = this.gl;
    if (!gl) return;
    if (this.qcfg.post && !this.scene) return;
    this._drawCalls = 0;
    const timeU = time - this._timeStart;
    if (this.qcfg.post) {
      const scene = this.scene;
      gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fbo);
      gl.viewport(0, 0, scene.w, scene.h);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.background.draw(scene, {
        camera: this.camera, mapping: this.mapping, time: timeU, quality: this.quality,
        target: scene,
      });
      this._drawCalls++;
      if (this._layers.nebula) {
        if (this._pipeline === 'baked') {
          this._ensureBaked();
          if (this.baked.ready) { this.baked.draw(scene, this.camera, {}); this._drawCalls++; }
        } else if (this.qcfg.volumeScale > 0) {
          this.volume.render(scene, this.camera, { time: timeU, mapping: this.mapping });
          this._drawCalls += 2;
        }
      }
      // node + relation layers (additive, always in front of the gas for data legibility)
      gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fbo);
      gl.viewport(0, 0, scene.w, scene.h);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.nodePass.draw(this.camera, { w: scene.w, h: scene.h }, {
        time: timeU, minPixel: this.mapping.nodeMinPixel * (scene.h / Math.max(1, this.viewport.h)),
        nodeSize: 1, focusDim: 0.16,
      }, false);
      this._drawCalls++;
      if (this._layers.edges) {
        this.edgePass.draw(this.camera, { w: scene.w, h: scene.h }, {
          time: timeU,
          edgeWidth: this.mapping.relationWidth * (scene.h / Math.max(1, this.viewport.h)),
          edgeOpacity: this.mapping.relationOpacity * (this._focus.set ? 1.15 : 0.82),
          flow: this.mapping.relationFlow,
        }, false);
        this._drawCalls++;
      }
      gl.disable(gl.BLEND);
      this.post.render({
        exposure: this.mapping.exposure,
        bloomStrength: this.mapping.bloom * 0.62,
        vignette: this.mapping.vignette,
        grain: this.mapping.grain,
        ca: this.mapping.chromaticAberration,
        time: timeU,
      });
      this._drawCalls += 2 + this.qcfg.bloomLevels * 2;
    } else {
      // ---- off quality: sketch/blueprint path — all interactions & labels preserved ----
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.disable(gl.BLEND);
      gl.clearColor(0.012, 0.018, 0.03, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this._flatBg.draw({
        uResolution: [this.canvas.width, this.canvas.height],
        uBandNormal: this.background.band,
        uStarDensity: this.mapping.starDensity,
        uStarSeed: this.background.starSeed,
        uTintA: this.background.tintA,
      });
      this._drawCalls++;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.nodePass.draw(this.camera, { w: this.canvas.width, h: this.canvas.height }, {
        time: timeU, minPixel: this.mapping.nodeMinPixel, nodeSize: 1, focusDim: 0.22,
      }, true);
      this._drawCalls++;
      if (this._layers.edges) {
        this.edgePass.draw(this.camera, { w: this.canvas.width, h: this.canvas.height }, {
          time: timeU,
          edgeWidth: this.mapping.relationWidth * (this.canvas.height / Math.max(1, this.viewport.h)) * 0.9,
          edgeOpacity: Math.min(1, this.mapping.relationOpacity * 1.6),
          flow: this.mapping.relationFlow,
        }, true);
        this._drawCalls++;
      }
      gl.disable(gl.BLEND);
    }
  }

  _ensureBaked() {
    if (this.baked.ready || !this.gl) return;
    const key = (this._dataVersion || 0) + ':' + JSON.stringify([this.mapping.nebulaIntensity, this.mapping.dustStrength, this.mapping.gasScale, this.mapping.nebulaSaturation]);
    if (this._bakedKey === key) return;
    this._bakedKey = key;
    this.baked.bake(this.emitters, this.graphBounds, this.mapping);
    this._emit('bake', { bake_ms: this.baked.bakeMs });
  }

  /* ---------------------------------------------------------------- *
   * Projection / picking / labels
   * ---------------------------------------------------------------- */
  _updateProjection() {
    const key = this.camera.version + ':' + this._posVersion + ':' + this.viewport.w + 'x' + this.viewport.h;
    if (this._projKey === key) return this._proj;
    const n = this.nodeRecords.length;
    if (this._proj.length !== n * 4) this._proj = new Float32Array(n * 4);
    const proj = this._proj;
    const vp = this.camera.viewProj;
    const w = this.viewport.w, h = this.viewport.h;
    const f = this.camera.proj[5];
    const v0 = vp[0], v1 = vp[1], v2 = vp[2], v3 = vp[3];
    const v4 = vp[4], v5 = vp[5], v6 = vp[6], v7 = vp[7];
    const v8 = vp[8], v9 = vp[9], v10 = vp[10], v11 = vp[11];
    const v12 = vp[12], v13 = vp[13], v14 = vp[14], v15 = vp[15];
    for (let i = 0; i < n; i++) {
      const p = this.nodeRecords[i].pos;
      const x = p.x, y = p.y, z = p.z;
      const cw = v3 * x + v7 * y + v11 * z + v15;
      if (cw <= 1) { proj[i * 4 + 3] = 0; continue; }
      const cx = v0 * x + v4 * y + v8 * z + v12;
      const cy = v1 * x + v5 * y + v9 * z + v13;
      proj[i * 4] = (cx / cw * 0.5 + 0.5) * w;
      proj[i * 4 + 1] = (1 - (cy / cw * 0.5 + 0.5)) * h;
      proj[i * 4 + 2] = Math.max(1.2, this.nodeRecords[i].sizeWorld * f * 0.5 * h / cw);
      proj[i * 4 + 3] = 1;
    }
    this._projKey = key;
    return proj;
  }

  _pick(cssX, cssY) {
    if (!this.gl) return null;
    const proj = this._updateProjection();
    let best = null, bestScore = Infinity;
    for (let i = 0; i < this.nodeRecords.length; i++) {
      if (!proj[i * 4 + 3]) continue;
      const rec = this.nodeRecords[i];
      const dx = proj[i * 4] - cssX, dy = proj[i * 4 + 1] - cssY;
      const r = Math.max(8, proj[i * 4 + 2] * 0.7 + 5);
      const d2 = dx * dx + dy * dy;
      if (d2 > r * r) continue;
      const score = d2 / (r * r) - rec.importance * 0.4;
      if (score < bestScore) { bestScore = score; best = rec; }
    }
    return best;
  }

  _worldOnPlane(cssX, cssY, point, normal) {
    const w = this.viewport.w, h = this.viewport.h;
    const nx = (cssX / w) * 2 - 1;
    const ny = 1 - (cssY / h) * 2;
    const rd = this.camera.rayFromNDC(nx, ny);
    const ro = this.camera.eye;
    const denom = rd[0] * normal[0] + rd[1] * normal[1] + rd[2] * normal[2];
    if (Math.abs(denom) < 1e-5) return { x: point.x, y: point.y, z: point.z };
    const t = ((point.x - ro[0]) * normal[0] + (point.y - ro[1]) * normal[1] + (point.z - ro[2]) * normal[2]) / denom;
    return { x: ro[0] + rd[0] * t, y: ro[1] + rd[1] * t, z: ro[2] + rd[2] * t };
  }

  _updateOverlay(time) {
    if (!this.overlay) return;
    if (time - this._lastOverlay < 0.09 && !this._labelsDirty) return;
    this._lastOverlay = time;
    this._labelsDirty = false;
    if (!this.gl || !this._dataSet || this.nodeRecords.length === 0) {
      this.overlay.updateLabels([]);
      this.overlay.updateClusterLabels([]);
      this._labelCount = 0;
      return;
    }
    const q = this.qcfg;
    const labels = [];
    const clusterLabels = [];
    if (this._labelMode !== 'off') {
      const proj = this._updateProjection();
      const w = this.viewport.w, h = this.viewport.h;
      const budget = Math.max(8, q.labelBudget);
      const zoom = this.camera.zoom;
      const focusSet = this._focus.set;
      const cand = [];
      for (let i = 0; i < this.nodeRecords.length; i++) {
        if (!proj[i * 4 + 3]) continue;
        const rec = this.nodeRecords[i];
        if (this._filteredSet.has(rec.id)) continue;
        const x = proj[i * 4], y = proj[i * 4 + 1], px = proj[i * 4 + 2];
        if (x < -80 || x > w + 80 || y < -40 || y > h + 40) continue;
        const isSel = this.selected.has(rec.id);
        const isHover = this.hoveredId === rec.id;
        const dim = focusSet && !focusSet.has(rec.id);
        let score = rec.importance * (1 + Math.min(0.7, 0.06 * rec.degree)) + Math.log10(1 + px) * 0.22 + Math.log2(Math.max(1, zoom)) * 0.16;
        if (dim) score *= 0.28;
        if (isHover || (isSel && this.selected.size <= 2)) score += 100;
        else if (isSel) score += 0.4;
        if (rec.isEntity) score -= 0.12;
        // 标签预算留给“重要节点 + 选中/悬停 + 聚焦邻域”，普通记忆不占标签
        if (score < 0.52 && !isSel && !isHover) continue;
        cand.push({ rec, x, y, px, score, isSel, isHover });
      }
      cand.sort((a, b) => b.score - a.score);
      const rects = [];
      const measureCache = new Map();
      const measure = (text, fs) => {
        const cacheKey = fs + '|' + text;
        if (measureCache.has(cacheKey)) return measureCache.get(cacheKey);
        let wpx = 0;
        // CJK ≈ 1em, latin ≈ 0.56em
        for (const ch of text) wpx += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? fs : fs * 0.56;
        measureCache.set(cacheKey, wpx);
        return wpx;
      };
      for (const c of cand) {
        // 多选（如聚类模式选中整个星团）时不逐个强制标签，否则中心会糊成一片
        const forced = c.isHover || (c.isSel && this.selected.size <= 2);
        if (!forced && labels.length >= budget) break;
        const fs = 10.5;
        const text = c.rec.label.length > 34 ? c.rec.label.slice(0, 33) + '…' : c.rec.label;
        const tw = measure(text, fs) + 6;
        const lx = clamp(c.x + Math.max(7, c.px * 0.45), 6, w - tw - 6);
        const ly = clamp(c.y - Math.max(7, c.px * 0.5) - 7, 14, h - 8);
        const rect = { x: lx - 5, y: ly - 12, w: tw + 10, h: 19 };
        let collide = false;
        for (const r of rects) {
          if (rect.x < r.x + r.w && rect.x + rect.w > r.x && rect.y < r.y + r.h && rect.y + rect.h > r.y) { collide = true; break; }
        }
        if (collide && !forced) continue;
        rects.push(rect);
        labels.push({
          key: 'n:' + c.rec.id, text, x: lx, y: ly,
          alpha: c.isHover ? 0.98 : c.isSel ? 0.95 : c.rec.importance > 0.6 ? 0.88 : 0.72,
          color: c.isSel ? '#9fe4ff' : c.isHover ? '#ffffff' : c.rec.isEntity ? 'rgba(228,224,205,.84)' : 'rgba(206,222,244,.82)',
          weight: c.rec.importance,
          kind: c.isSel ? 'selected' : c.rec.isEntity ? 'entity' : 'node',
        });
      }
      if (q.clusterLabels && this._showClusterLabels && zoom >= 0.5 && zoom <= 6.0 && this.clusterPrepared.length) {
        // 聚类名称：只显示成员最多的前 8 个，并做标签碰撞检测；总览模式不显示（避免标签堆叠）。
        const cs = [...this.clusterPrepared]
          .filter((c) => c && c.count > 0)
          .sort((a, b) => (b.count || 0) - (a.count || 0))
          .slice(0, 8);
        for (const c of cs) {
          const anchor = c.labelPos || c.centroid;
          const p = this.camera.project(anchor.x, anchor.y, anchor.z, w, h);
          if (!p.visible || p.x < 20 || p.x > w - 20 || p.y < 20 || p.y > h - 8) continue;
          const text = (c.label || '').toUpperCase().slice(0, 26);
          if (!text) continue;
          const tw = measure(text, 9.5) + 14;
          const lx = clamp(p.x - tw * 0.5, 6, w - tw - 6);
          const ly = clamp(p.y + 24, 18, h - 10);
          const rect = { x: lx - 4, y: ly - 11, w: tw + 8, h: 15 };
          let collide = false;
          for (const r of rects) {
            if (rect.x < r.x + r.w && rect.x + rect.w > r.x && rect.y < r.y + r.h && rect.y + rect.h > r.y) { collide = true; break; }
          }
          if (collide) continue;
          rects.push(rect);
          clusterLabels.push({
            key: 'c:' + c.id, text, x: lx, y: ly,
            alpha: 0.30 + c.density * 0.20,
            color: hexToCss(c._hintHex, 0.75),
          });
        }
      }
    }
    const shown = this.overlay.updateLabels(labels);
    this.overlay.updateClusterLabels(clusterLabels);
    this._labelCount = shown + clusterLabels.length;
  }

  _trackPerf(now) {
    if (this._lastFrameTs) {
      const dt = now - this._lastFrameTs;
      if (dt > 0 && dt < 500) this._frameTimes.push(dt);
      if (this._frameTimes.length > 120) this._frameTimes.shift();
    }
    this._lastFrameTs = now;
    if (this._frameTimes.length >= 8) {
      const arr = this._frameTimes;
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      const sorted = [...arr].sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
      this._perf = { fps: avg > 0 ? 1000 / avg : 0, frame_ms: avg, p95_frame_ms: p95, draw_calls: this._drawCalls };
      if (now - this._lastPerfEmit > 500) {
        this._lastPerfEmit = now;
        this._emit('perf', {
          fps: Math.round(this._perf.fps * 10) / 10,
          frame_ms: Math.round(this._perf.frame_ms * 100) / 100,
          draw_calls: this._perf.draw_calls,
          p95_frame_ms: Math.round(this._perf.p95_frame_ms * 100) / 100,
          nodes: this.nodeRecords.length,
          quality: this.quality,
        });
      }
    }
    if (this._cameraViewDirty !== false && now - this._lastViewEmit > 160) {
      this._lastViewEmit = now;
      this._emitViewChange(false);
    }
  }

  _emitViewChange(force) {
    const view = { center: [this.camera.target[0], this.camera.target[1], this.camera.target[2]], zoom: +this.camera.zoom.toFixed(4) };
    if (!force) {
      if (this._lastView && Math.abs(this._lastView.zoom - view.zoom) < 1e-4 &&
        Math.hypot(this._lastView.center[0] - view.center[0], this._lastView.center[1] - view.center[1], this._lastView.center[2] - view.center[2]) < 0.5) return;
    }
    this._lastView = view;
    this._emit('view:change', view);
  }

  _emit(name, payload) {
    const set = this._handlers.get(name);
    if (set) for (const fn of [...set]) { try { fn(payload); } catch (e) { console.error('[nebula] handler error', name, e); } }
    if (name !== 'perf' && name !== 'view:change') this._labelsDirty = true;
  }

  /* ---------------------------------------------------------------- *
   * Interaction
   * ---------------------------------------------------------------- */
  _bindInput() {
    if (!this._interactive) return;
    const el = this.canvas;
    this._boxEl = document.createElement('div');
    Object.assign(this._boxEl.style, {
      position: 'absolute', display: 'none', pointerEvents: 'none', zIndex: '3',
      border: '1px solid rgba(140,200,255,.55)', background: 'rgba(90,160,255,.08)',
      borderRadius: '1px',
    });
    this.container.appendChild(this._boxEl);
    this._pointer = { down: false, mode: 'none', startX: 0, startY: 0, lastX: 0, lastY: 0, moved: 0, hit: null, dragSet: null, planePoint: null, planeNormal: null, startPositions: null };
    this._hoverRaf = 0;
    this._onPointerDown = (e) => this._pointerDown(e);
    this._onPointerMove = (e) => this._pointerMove(e);
    this._onPointerUp = (e) => this._pointerUp(e);
    this._onWheel = (e) => this._wheel(e);
    this._onDblClick = (e) => this._dblClick(e);
    this._onContextMenu = (e) => this._contextMenu(e);
    el.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove, { passive: true });
    window.addEventListener('pointerup', this._onPointerUp);
    el.addEventListener('wheel', this._onWheel, { passive: false });
    el.addEventListener('dblclick', this._onDblClick);
    el.addEventListener('contextmenu', this._onContextMenu);
    el.style.cursor = 'grab';
  }

  _unbindInput() {
    if (!this.canvas) return;
    const el = this.canvas;
    if (this._onPointerDown) el.removeEventListener('pointerdown', this._onPointerDown);
    if (this._onPointerMove) window.removeEventListener('pointermove', this._onPointerMove);
    if (this._onPointerUp) window.removeEventListener('pointerup', this._onPointerUp);
    if (this._onWheel) el.removeEventListener('wheel', this._onWheel);
    if (this._onDblClick) el.removeEventListener('dblclick', this._onDblClick);
    if (this._onContextMenu) el.removeEventListener('contextmenu', this._onContextMenu);
  }

  _localPos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _pointerDown(e) {
    if (!this.gl || e.button === 2) return;
    const p = this._localPos(e);
    const hit = this._pick(p.x, p.y);
    const P = this._pointer;
    P.down = true; P.mode = 'none'; P.startX = p.x; P.startY = p.y; P.lastX = p.x; P.lastY = p.y; P.moved = 0; P.hit = hit;
    const additive = e.ctrlKey || e.metaKey;
    if (hit) {
      if (additive) {
        const next = new Set(this.selected);
        if (next.has(hit.id)) next.delete(hit.id); else next.add(hit.id);
        this._applySelection(next);
        P.mode = 'select-only';
        return;
      }
      if (!this.selected.has(hit.id)) this._applySelection(new Set([hit.id]));
      P.mode = 'node';
      P.dragSet = [...this.selected].filter((id) => this.nodeIndex.has(id));
      if (!P.dragSet.includes(hit.id)) P.dragSet = [hit.id];
      P.startPositions = new Map();
      for (const id of P.dragSet) {
        const rec = this.nodeIndex.get(id);
        P.startPositions.set(id, { x: rec.pos.x, y: rec.pos.y, z: rec.pos.z });
      }
      const forward = [this.camera.eye[0] - this.camera.target[0], this.camera.eye[1] - this.camera.target[1], this.camera.eye[2] - this.camera.target[2]];
      const fl = Math.hypot(forward[0], forward[1], forward[2]) || 1;
      P.planeNormal = [forward[0] / fl, forward[1] / fl, forward[2] / fl];
      P.planePoint = { ...this.nodeIndex.get(hit.id).pos };
      P.planeStart = this._worldOnPlane(p.x, p.y, P.planePoint, P.planeNormal);
      e.preventDefault();
    } else if (e.shiftKey) {
      P.mode = 'box';
      this._boxEl.style.display = 'block';
      this._updateBox(p.x, p.y, p.x, p.y);
    } else {
      P.mode = 'pan';
      this.canvas.style.cursor = 'grabbing';
    }
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  }

  _pointerMove(e) {
    if (!this.gl) return;
    const p = this._localPos(e);
    const P = this._pointer;
    if (!P.down) {
      this._scheduleHover(p);
      return;
    }
    const dx = p.x - P.lastX, dy = p.y - P.lastY;
    P.moved += Math.abs(dx) + Math.abs(dy);
    P.lastX = p.x; P.lastY = p.y;
    if (P.mode === 'pan') {
      this.camera.panScreen(dx, dy, this.viewport.h);
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    if (P.mode === 'box') {
      this._updateBox(P.startX, P.startY, p.x, p.y);
      return;
    }
    if (P.mode === 'node' && P.planePoint) {
      const now = this._worldOnPlane(p.x, p.y, P.planePoint, P.planeNormal);
      const ddx = now.x - P.planeStart.x, ddy = now.y - P.planeStart.y, ddz = now.z - P.planeStart.z;
      for (const id of P.dragSet) {
        const rec = this.nodeIndex.get(id);
        const s = P.startPositions.get(id);
        rec.pos.x = s.x + ddx; rec.pos.y = s.y + ddy; rec.pos.z = s.z + ddz;
      }
      this._posVersion++;
      this._projKey = '';
      this.nodePass.updatePositions(this.nodeRecords, P.dragSet.map((id) => this.nodeIndex.get(id).index));
      const incident = new Set();
      for (const id of P.dragSet) {
        const list = this._edgeIndexByNode.get(id);
        if (list) for (const ei of list) incident.add(ei);
      }
      this.edgePass.updateEdges([...incident], this._positionsMap);
      this._labelsDirty = true;
    }
  }

  _updateBox(x0, y0, x1, y1) {
    const x = Math.min(x0, x1), y = Math.min(y0, y1);
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    Object.assign(this._boxEl.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  }

  _pointerUp(e) {
    if (!this.gl) return;
    const P = this._pointer;
    if (!P.down) return;
    const p = this._localPos(e);
    P.down = false;
    this.canvas.style.cursor = 'grab';
    if (P.mode === 'node') {
      const moved = P.moved > 3;
      if (moved) {
        for (const id of P.dragSet) {
          const rec = this.nodeIndex.get(id);
          this._emit('node:dragend', { id, position: { x: round2(rec.pos.x), y: round2(rec.pos.y), z: round2(rec.pos.z) } });
        }
        this._emit('layout:changed', { positions: P.dragSet.map((id) => ({ id, position: { ...this.nodeIndex.get(id).pos } })) });
      }
    } else if (P.mode === 'box') {
      this._boxEl.style.display = 'none';
      const x0 = Math.min(P.startX, p.x), x1 = Math.max(P.startX, p.x);
      const y0 = Math.min(P.startY, p.y), y1 = Math.max(P.startY, p.y);
      if (x1 - x0 > 4 && y1 - y0 > 4) {
        const proj = this._updateProjection();
        const ids = [];
        for (let i = 0; i < this.nodeRecords.length; i++) {
          if (!proj[i * 4 + 3]) continue;
          if (proj[i * 4] >= x0 && proj[i * 4] <= x1 && proj[i * 4 + 1] >= y0 && proj[i * 4 + 1] <= y1) ids.push(this.nodeRecords[i].id);
        }
        const next = new Set();
        for (const id of ids) next.add(id);
        this._applySelection(next);
      }
    } else if (P.mode === 'pan') {
      if (P.moved < 4) {
        const hit = this._pick(p.x, p.y);
        if (!hit) {
          this._emit('background:click', { x: p.x, y: p.y });
          if (!(e.ctrlKey || e.metaKey) && this.selected.size) this._applySelection(new Set());
        } else {
          this._applySelection(new Set([hit.id]));
          this._emit('node:click', { id: hit.id });
        }
      }
    } else if (P.mode === 'select-only') {
      // ctrl-click already applied selection on pointerdown
    }
    P.mode = 'none';
    P.hit = null;
    this._labelsDirty = true;
  }

  _applySelection(nextSet) {
    const changed = nextSet.size !== this.selected.size || [...nextSet].some((id) => !this.selected.has(id));
    this.selected = nextSet;
    this._refreshStates();
    this._labelsDirty = true;
    if (changed) this._emit('selection:change', { ids: [...this.selected] });
    if (changed && nextSet.size === 1) this._emit('node:click', { id: [...nextSet][0] });
  }

  _scheduleHover(p) {
    if (this._hoverRaf) return;
    this._hoverX = p.x; this._hoverY = p.y;
    this._hoverRaf = requestAnimationFrame(() => {
      this._hoverRaf = 0;
      const hit = this._pick(this._hoverX, this._hoverY);
      const id = hit ? hit.id : null;
      if (id !== this.hoveredId) {
        this.hoveredId = id;
        this._refreshStates();
        this._labelsDirty = true;
        this._emit('node:hover', { id });
        this.canvas.style.cursor = id ? 'pointer' : 'grab';
      }
    });
  }

  _wheel(e) {
    if (!this.gl) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0011);
    this.camera.setZoom(this.camera.zoom * factor);
    this._emitViewChange(true);
  }

  _dblClick(e) {
    if (!this.gl) return;
    const p = this._localPos(e);
    const hit = this._pick(p.x, p.y);
    if (hit) this._emit('node:dblclick', { id: hit.id });
  }

  _contextMenu(e) {
    if (!this.gl) return;
    const p = this._localPos(e);
    const hit = this._pick(p.x, p.y);
    if (hit) {
      e.preventDefault();
      this._emit('node:contextmenu', { id: hit.id, x: e.clientX, y: e.clientY });
    } else {
      this._emit('background:contextmenu', { x: e.clientX, y: e.clientY });
    }
  }
}

/* ---------------- helpers ---------------- */
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function round2(v) { return Math.round(v * 100) / 100; }
function mix3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function scale3(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }
function parseTime(v) {
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}
function hexToCss(hex, alpha) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
