// FCA Memory Atlas — Nebula Renderer demo page
// Standalone harness: renders a §5 render-contract fixture with the real renderer and exposes the
// legend / layer / mapping information for Desktop integration + QA reproduction.
// ⚠ All data here is TEST FIXTURE (synthetic); production data comes from Runtime GET /api/v1/graph.
import { createNebula } from './index.js';
import { makeScenario, FIXTURE_NOTE } from './fixtures.js';

const params = new URLSearchParams(location.search);
const q = (k, d) => { const v = params.get(k); return v === null ? d : v; };
const num = (k, d) => { const v = parseFloat(params.get(k)); return Number.isFinite(v) ? v : d; };

const scenario = q('scenario', '300');
const quality = q('quality', 'high');
const pipeline = q('pipeline', 'volume');
const ui = q('ui', '1') !== '0';
const seed = Math.round(num('seed', 20261112));
const labels = q('labels', '1') !== '0';

const mappingOverride = {
  nebulaIntensity: num('nebula', 1),
  dustStrength: num('dust', 1),
  relationOpacity: num('edges', 0.85),
  starDensity: num('stars', 1),
  exposure: num('exposure', 1),
  bandIntensity: num('band', 1),
};

const stage = document.getElementById('stage');
stage.style.position = 'fixed';
stage.style.inset = '0';

const nebula = createNebula(stage, {
  quality,
  pipeline,
  labels,
  mapping: mappingOverride,
  angles: { yaw: num('yaw', -0.9), pitch: num('pitch', 0.30) },
  autoFit: true,
  interactive: true,
});

const state = { scenario, quality, pipeline, graph: null };

function loadScenario(name, opts = {}) {
  const graph = makeScenario(name, seed);
  state.scenario = name;
  state.graph = graph;
  nebula.setData(graph);
  if (opts.fit !== false) nebula.fitToContent({ padding: 0.15 });
  document.querySelectorAll('#scenarioBtns button').forEach((b) => b.classList.toggle('on', b.dataset.scenario === name));
  const badge = document.getElementById('fixtureBadge');
  if (badge) badge.textContent = `TEST FIXTURE · 合成数据 · ${graph.nodes.length} 节点 / ${graph.edges.length} 关系`;
  document.title = `FCA Nebula · ${name} · ${state.quality} · ${state.pipeline}`;
  markReadySoon();
}

function markReadySoon() {
  window.__FCA_NEBULA_READY__ = false;
  setTimeout(() => { window.__FCA_NEBULA_READY__ = true; }, 450);
}

/* ---------------------------------- UI ---------------------------------- */
function setUI(visible) {
  for (const id of ['topbar', 'leftPanel', 'rightPanel', 'hintbar']) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !visible);
  }
}
setUI(ui);

function el(tag, css, text) {
  const d = document.createElement(tag);
  if (css) Object.assign(d.style, css);
  if (text != null) d.textContent = text;
  return d;
}

function buildLegend() {
  const legend = nebula.getLegend();
  const hint = document.getElementById('hintSwatches');
  const types = document.getElementById('typeSwatches');
  const rels = document.getElementById('relSwatches');
  if (!hint) return;
  for (const h of legend.colorHints) {
    const row = el('div', { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '10.5px', color: 'var(--text-dim)' });
    const dot = el('i');
    Object.assign(dot.style, { width: '9px', height: '9px', borderRadius: '50%', flex: 'none', background: h.color, boxShadow: `0 0 7px ${h.color}` });
    row.appendChild(dot);
    row.appendChild(el('span', null, h.label + ' · ' + h.key));
    hint.appendChild(row);
  }
  const mem = legend.nodeTypes.filter((t) => t.group === 'memory');
  const ent = legend.nodeTypes.filter((t) => t.group === 'entity');
  for (const t of [...mem, ...ent]) {
    const row = el('div', { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '10.5px', color: 'var(--text-dim)' });
    const dot = el('i');
    Object.assign(dot.style, {
      width: '8px', height: '8px', flex: 'none', background: t.color,
      borderRadius: t.group === 'entity' ? '50%' : '50%',
      boxShadow: t.group === 'entity' ? 'none' : `0 0 6px ${t.color}`,
      border: t.group === 'entity' ? `1px solid ${t.color}` : 'none',
      background: t.group === 'entity' ? 'transparent' : t.color,
    });
    row.appendChild(dot);
    row.appendChild(el('span', null, t.label + (t.group === 'entity' ? '（环）' : '')));
    types.appendChild(row);
  }
  for (const r of legend.relationTypes) {
    const row = el('div', { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10.5px', color: 'var(--text-dim)' });
    const line = el('i');
    Object.assign(line.style, {
      width: '16px', height: '2px', flex: 'none', background: r.color,
      opacity: '0.9', boxShadow: `0 0 6px ${r.color}`,
      borderRadius: '1px',
      borderTop: r.dashed ? `2px dashed ${r.color}` : 'none',
    });
    row.appendChild(line);
    row.appendChild(el('span', null, r.label + (r.flow ? ' · 粒子流' : '')));
    rels.appendChild(row);
  }
  const note = document.getElementById('mappingNote');
  note.innerHTML = `
    <div style="margin-bottom:8px"><b>星云（cluster 驱动）</b>：每个 cluster = 一个各向异性高斯发射核（质心 / 分布 / density），
    色相取 <span class="k">color_hint</span> 并与 dominant_types 混合；域扭曲 FBM 生成丝状气体，高频噪声作为尘埃带吸收背景星光。</div>
    <div style="margin-bottom:8px"><b>节点亮度</b> = (0.22 + 0.78·importance²) · (0.6 + 0.4·display_weight) · (1 + 0.05·√degree)；
    <b>大小</b> = 基础像素 + 9·importance^0.85·√display_weight。实体（人物/项目/地点）用环状轮廓区分，亮度更低。</div>
    <div style="margin-bottom:8px"><b>关系光丝</b>：按 relation_type 分色 / 曲率 / 虚线，粒子流沿 from→to 方向移动；随距离淡出、随 confidence 增亮。</div>
    <div><b>深空背景</b>：4 层不同视差与亮度的程序化星点 + 银河带；带主轴与色调由 cluster 质心 PCA 与主导 hint 计算，不是固定图片。
    ${legend.quality.map((x) => x.label).join(' · ')}</div>
  `;
}

function updateStats() {
  const s = nebula.getStats();
  const box = document.getElementById('statsBox');
  if (box) {
    const row = (k, v) => `<div class="statline"><span>${k}</span><b>${v}</b></div>`;
    box.innerHTML =
      row('节点 / 关系 / 聚类', `${s.rendered_nodes} / ${s.rendered_edges} / ${s.clusters}`) +
      row('FPS', `${s.fps} fps`) +
      row('帧时间 (p95)', `${s.frame_ms} ms (${s.p95_frame_ms} ms)`) +
      row('draw calls', s.draw_calls) +
      row('渲染管线', `${s.pipeline} · ${s.quality}${s.pipeline === 'baked' ? '（烘焙 ' + s.bake_ms + ' ms）' : ''}`) +
      row('分辨率 css/buffer', `${s.resolution ? s.resolution.css.join('×') : '—'} / ${s.resolution ? s.resolution.buffer.join('×') : '—'}`) +
      row('GPU', s.gpu || '—');
    const engine = document.getElementById('engineInfo');
    if (engine) engine.textContent = (s.gpu || 'WebGL2').replace(/^ANGLE \((.*)\)$/, '$1');
  }
  const fps = document.getElementById('fpsBox');
  if (fps) fps.innerHTML = `FPS <b>${s.fps}</b> · ${s.frame_ms}ms · draw ${s.draw_calls}`;
}

function showDetail(id) {
  const box = document.getElementById('detailBox');
  if (!box) return;
  if (!id || !state.graph) { box.classList.remove('show'); return; }
  const node = state.graph.nodes.find((n) => n.id === id);
  if (!node) { box.classList.remove('show'); return; }
  const cluster = (state.graph.clusters || []).find((c) => c.id === node.cluster_id);
  const imp = node.importance ?? 0, dw = node.display_weight ?? 1, deg = node.degree ?? 0;
  const brightness = (0.22 + 0.78 * imp * imp) * (0.62 + 0.38 * Math.min(dw, 1.6)) * (1 + 0.05 * Math.sqrt(deg));
  box.classList.add('show');
  box.innerHTML = `
    <div class="dt">${escapeHtml(node.label || node.id)}</div>
    <div class="dm">
      <div>kind · type: <span>${node.kind} · ${node.type}</span></div>
      <div>id: <span>${escapeHtml(node.id)}</span></div>
      <div>cluster: <span>${cluster ? escapeHtml(cluster.label) : '—'}</span></div>
      <div>importance / display_weight / degree: <span>${imp.toFixed(2)} / ${dw.toFixed(2)} / ${deg}</span></div>
      <div>亮度计算值: <span>${brightness.toFixed(3)}</span>（越重要越亮，普通记忆保持低亮度）</div>
      <div>occurred_at: <span>${node.occurred_at ? String(node.occurred_at).slice(0, 10) : '未知时间'}</span></div>
      <div>tags: <span>${(node.tags || []).join(' / ') || '—'}</span></div>
    </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------------------------- events ---------------------------------- */
nebula.on('node:click', (p) => { showDetail(p.id); });
nebula.on('node:hover', (p) => { if (!p.id) return; });
nebula.on('background:click', () => { showDetail(null); nebula.focusNode(null); });
nebula.on('node:dblclick', (p) => { nebula.focusNode(p.id, { depth: 2 }); showDetail(p.id); });
nebula.on('selection:change', (p) => {
  if (p.ids.length === 1) showDetail(p.ids[0]);
  else if (p.ids.length === 0) showDetail(null);
  const badge = document.getElementById('fixtureBadge');
  if (badge) badge.dataset.selection = String(p.ids.length);
});
nebula.on('node:dragend', (p) => { window.__FCA_LAST_DRAG__ = p; });
nebula.on('node:contextmenu', (p) => { window.__FCA_LAST_CONTEXT__ = p; });
nebula.on('perf', () => { });

/* ---------------------------------- controls ---------------------------------- */
function wireButtons() {
  document.querySelectorAll('#scenarioBtns button').forEach((b) => {
    b.addEventListener('click', () => loadScenario(b.dataset.scenario));
  });
  document.querySelectorAll('#qualityBtns button').forEach((b) => {
    b.addEventListener('click', () => {
      state.quality = b.dataset.quality;
      nebula.setQuality(state.quality);
      document.querySelectorAll('#qualityBtns button').forEach((x) => x.classList.toggle('on', x.dataset.quality === state.quality));
      document.title = `FCA Nebula · ${state.scenario} · ${state.quality} · ${state.pipeline}`;
      markReadySoon();
    });
  });
  document.querySelectorAll('#pipelineBtns button').forEach((b) => {
    b.addEventListener('click', () => {
      state.pipeline = b.dataset.pipeline;
      nebula.setPipeline(state.pipeline);
      document.querySelectorAll('#pipelineBtns button').forEach((x) => x.classList.toggle('on', x.dataset.pipeline === state.pipeline));
      document.title = `FCA Nebula · ${state.scenario} · ${state.quality} · ${state.pipeline}`;
      markReadySoon();
    });
  });
  const bind = (id, key) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.value = String(mappingOverride[key]);
    input.addEventListener('input', () => {
      const patch = {};
      patch[key] = parseFloat(input.value);
      nebula.setMapping(patch);
    });
  };
  bind('mapNebula', 'nebulaIntensity');
  bind('mapDust', 'dustStrength');
  bind('mapEdge', 'relationOpacity');
  bind('mapStars', 'starDensity');
  const fitBtn = document.getElementById('btnFit');
  if (fitBtn) fitBtn.addEventListener('click', () => nebula.fitToContent({ padding: 0.15 }));
  const focusBtn = (depth) => {
    const sel = nebula.getStats().selected;
    let target = sel[0];
    if (!target && state.graph) {
      let best = null, bestScore = -1;
      for (const n of state.graph.nodes) {
        const s = (n.importance || 0) * (1 + 0.05 * (n.degree || 0));
        if (s > bestScore) { bestScore = s; best = n; }
      }
      target = best && best.id;
    }
    if (target) { nebula.select([target]); nebula.focusNode(target, { depth }); showDetail(target); }
  };
  const f1 = document.getElementById('btnFocus1');
  const f2 = document.getElementById('btnFocus2');
  if (f1) f1.addEventListener('click', () => focusBtn(1));
  if (f2) f2.addEventListener('click', () => focusBtn(2));
}

/* ---------------------------------- boot ---------------------------------- */
function markActive() {
  state.quality = q('quality', 'high');
  state.pipeline = q('pipeline', 'volume');
  document.querySelectorAll('#qualityBtns button').forEach((x) => x.classList.toggle('on', x.dataset.quality === state.quality));
  document.querySelectorAll('#pipelineBtns button').forEach((x) => x.classList.toggle('on', x.dataset.pipeline === state.pipeline));
}

buildLegend();
wireButtons();
markActive();
loadScenario(scenario);

let last = 0;
function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  if (now - last > 400) { last = now; updateStats(); }
}
if (ui) tick();
else { const loop = () => { updateStats(); requestAnimationFrame(loop); }; }

// capture / QA hooks
window.__NEBULA_DEMO__ = {
  instance: nebula,
  state,
  loadScenario,
  setQuality: (lvl) => { state.quality = lvl; nebula.setQuality(lvl); markReadySoon(); },
  setPipeline: (p) => { state.pipeline = p; nebula.setPipeline(p); markReadySoon(); },
  applyScenario: (name) => loadScenario(name),
  fit: () => nebula.fitToContent({ padding: 0.15 }),
  focusTop: (depth = 1) => {
    let best = null, bestScore = -1;
    if (state.graph) for (const n of state.graph.nodes) {
      const s = (n.importance || 0) * (1 + 0.05 * (n.degree || 0));
      if (s > bestScore) { bestScore = s; best = n; }
    }
    if (best) { nebula.select([best.id]); nebula.focusNode(best.id, { depth }); showDetail(best.id); }
    return best && best.id;
  },
  stats: () => nebula.getStats(),
  note: FIXTURE_NOTE,
  legend: () => nebula.getLegend(),
};
window.__FCA_NEBULA_READY__ = false;
