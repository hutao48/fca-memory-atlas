/**
 * ⚠️ DEV-ONLY — Nebula 渲染器开发期 stub（不属于生产代码，最终交付前删除）
 *
 * 用途：nebula-renderer 任务组的 desktop/renderer/nebula/index.js 尚未就绪时，
 *       Shell 的 atlas 视图仍可运行、可截图、可验证交互链路。
 *
 * 实现与冻结接口 docs/PUBLIC_INTERFACE_FREEZE.md §5 完全一致（仅精简绘制）。
 * 最终交付前：真实 nebula 模块存在时自动使用真实模块；本文件与 lib/dev/ 一起删除。
 */

const CLUSTER_COLORS = {
  cyan: '#7fd8e8',
  blue: '#6f9fe8',
  violet: '#a08cf0',
  magenta: '#d47fd0',
  rose: '#e08f9f',
  gold: '#d8b978',
  white: '#dfe8f2',
};

export function createNebula(container, options = {}) {
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.setAttribute('aria-label', '星云画布（开发期占位渲染，DEV-ONLY）');
  container.appendChild(canvas);
  const ctx2d = canvas.getContext('2d');

  let graph = { nodes: [], edges: [], clusters: [] };
  let quality = options.quality || 'high';
  let camera = { center: [0, 0, 0], zoom: 1 };
  let selected = new Set();
  let focused = null;
  let hovered = null;
  let mapping = {};
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  const handlers = new Map();
  let raf = null;
  let lastFrameAt = performance.now();
  let frameCount = 0;
  let fps = 60;
  let destroyed = false;
  let colorByNode = new Map();
  let clusterMap = new Map();

  function emit(name, payload) {
    const set = handlers.get(name);
    if (set) {
      for (const handler of Array.from(set)) {
        try {
          handler(payload);
        } catch (error) {
          console.error('[dev-nebula] handler error', error);
        }
      }
    }
  }

  function on(name, handler) {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name).add(handler);
    return () => handlers.get(name)?.delete(handler);
  }

  function resize() {
    const rect = container.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    canvas.style.width = '100%';
    canvas.style.height = '100%';
  }

  function worldToScreen(position) {
    const rect = container.getBoundingClientRect();
    const cx = camera.center[0] || 0;
    const cy = camera.center[1] || 0;
    const scale = camera.zoom;
    return {
      x: rect.width / 2 + (position.x - cx) * scale,
      y: rect.height / 2 + (position.y - cy) * scale,
    };
  }

  function screenToWorld(x, y) {
    const rect = container.getBoundingClientRect();
    return {
      x: (x - rect.width / 2) / camera.zoom + (camera.center[0] || 0),
      y: (y - rect.height / 2) / camera.zoom + (camera.center[1] || 0),
      z: 0,
    };
  }

  function rebuildIndex() {
    colorByNode = new Map();
    clusterMap = new Map((graph.clusters || []).map((c) => [c.id, c]));
    for (const node of graph.nodes || []) {
      const cluster = node.cluster_id ? clusterMap.get(node.cluster_id) : null;
      const hint = cluster ? cluster.color_hint : 'white';
      colorByNode.set(node.id, CLUSTER_COLORS[hint] || CLUSTER_COLORS.white);
    }
  }

  function drawBackground(width, height, time) {
    const grad = ctx2d.createRadialGradient(width * 0.5, height * 0.46, 0, width * 0.5, height * 0.46, Math.max(width, height) * 0.72);
    grad.addColorStop(0, '#0a1424');
    grad.addColorStop(0.45, '#060b14');
    grad.addColorStop(1, '#02040a');
    ctx2d.fillStyle = grad;
    ctx2d.fillRect(0, 0, width, height);

    // 静态星点（开发期占位；真实星云由 nebula 组实现）
    const seed = 12345;
    let state = seed;
    const rand = () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    ctx2d.save();
    for (let i = 0; i < 420; i += 1) {
      const x = rand() * width;
      const y = rand() * height;
      const r = rand() * 1.1 + 0.2;
      const alpha = 0.12 + rand() * 0.6;
      ctx2d.globalAlpha = alpha;
      ctx2d.fillStyle = rand() > 0.8 ? '#cfe4f5' : '#93a9c4';
      ctx2d.beginPath();
      ctx2d.arc(x, y, r, 0, Math.PI * 2);
      ctx2d.fill();
    }
    ctx2d.restore();

    // 银河带
    ctx2d.save();
    ctx2d.translate(width * 0.5, height * 0.5);
    ctx2d.rotate((-24 * Math.PI) / 180);
    const band = ctx2d.createLinearGradient(0, -height * 0.16, 0, height * 0.16);
    band.addColorStop(0, 'rgba(80,120,170,0)');
    band.addColorStop(0.5, 'rgba(90,130,180,0.075)');
    band.addColorStop(1, 'rgba(80,120,170,0)');
    ctx2d.fillStyle = band;
    ctx2d.fillRect(-width, -height * 0.16, width * 2, height * 0.32);
    ctx2d.restore();
    void time;
  }

  function drawClusterNebulae(width, height) {
    for (const cluster of graph.clusters || []) {
      const center = worldToScreen({
        x: cluster.centroid ? cluster.centroid.x : 0,
        y: cluster.centroid ? cluster.centroid.y : 0,
      });
      const count = (cluster.node_ids || []).length;
      const radius = Math.max(60, Math.min(width, height) * 0.16) * (0.6 + count * 0.045) * camera.zoom;
      const color = CLUSTER_COLORS[cluster.color_hint] || CLUSTER_COLORS.white;
      const grad = ctx2d.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius);
      grad.addColorStop(0, hexToRgba(color, 0.14 + (cluster.density || 0.5) * 0.1));
      grad.addColorStop(0.45, hexToRgba(color, 0.05));
      grad.addColorStop(1, hexToRgba(color, 0));
      ctx2d.fillStyle = grad;
      ctx2d.beginPath();
      ctx2d.arc(center.x, center.y, radius, 0, Math.PI * 2);
      ctx2d.fill();
    }
  }

  function hexToRgba(hex, alpha) {
    const value = hex.replace('#', '');
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function drawEdges(width, height) {
    if (!graph.edges || quality === 'off') {
      if (quality !== 'off') return;
    }
    ctx2d.save();
    ctx2d.lineWidth = 0.7;
    for (const edge of graph.edges || []) {
      const from = (graph.nodes || []).find((n) => n.id === edge.from);
      const to = (graph.nodes || []).find((n) => n.id === edge.to);
      if (!from || !to) continue;
      const a = worldToScreen(from.position);
      const b = worldToScreen(to.position);
      if ((a.x < -50 && b.x < -50) || (a.x > width + 50 && b.x > width + 50)) continue;
      if ((a.y < -50 && b.y < -50) || (a.y > height + 50 && b.y > height + 50)) continue;
      const involved = selected.has(edge.from) || selected.has(edge.to);
      const alpha = involved ? 0.5 : 0.12;
      ctx2d.strokeStyle = involved ? 'rgba(168,214,239,0.55)' : `rgba(140,170,200,${alpha})`;
      ctx2d.beginPath();
      const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.06;
      const my = (a.y + b.y) / 2 - (b.x - a.x) * 0.06;
      ctx2d.moveTo(a.x, a.y);
      ctx2d.quadraticCurveTo(mx, my, b.x, b.y);
      ctx2d.stroke();
    }
    ctx2d.restore();
  }

  function drawNodes(width, height) {
    const nodes = graph.nodes || [];
    for (const node of nodes) {
      const screen = worldToScreen(node.position || { x: 0, y: 0 });
      if (screen.x < -40 || screen.x > width + 40 || screen.y < -40 || screen.y > height + 40) continue;
      const baseSize = node.kind === 'entity' ? 3.2 : 4.2;
      const importance = Number(node.importance) || 0.4;
      const weight = Number(node.display_weight) || 1;
      const degree = Number(node.degree) || 0;
      const size = (baseSize + importance * 4.2 + Math.min(degree, 8) * 0.5) * (0.8 + weight * 0.25) * Math.min(1.6, camera.zoom);
      const color = colorByNode.get(node.id) || CLUSTER_COLORS.white;
      const isSelected = selected.has(node.id);
      const isHovered = hovered === node.id;
      const isFocused = focused === node.id;

      if (quality !== 'off') {
        const glowRadius = size * (isSelected || isHovered ? 7 : 4.5);
        const glow = ctx2d.createRadialGradient(screen.x, screen.y, 0, screen.x, screen.y, glowRadius);
        glow.addColorStop(0, hexToRgba(color, isSelected ? 0.55 : isHovered ? 0.42 : 0.26));
        glow.addColorStop(0.45, hexToRgba(color, 0.1));
        glow.addColorStop(1, hexToRgba(color, 0));
        ctx2d.fillStyle = glow;
        ctx2d.beginPath();
        ctx2d.arc(screen.x, screen.y, glowRadius, 0, Math.PI * 2);
        ctx2d.fill();
      } else {
        ctx2d.strokeStyle = hexToRgba(color, 0.8);
        ctx2d.lineWidth = 1;
        ctx2d.beginPath();
        ctx2d.arc(screen.x, screen.y, Math.max(2.4, size * 0.5), 0, Math.PI * 2);
        ctx2d.stroke();
      }

      ctx2d.fillStyle = color;
      ctx2d.globalAlpha = isFocused || isSelected ? 1 : 0.88;
      ctx2d.beginPath();
      ctx2d.arc(screen.x, screen.y, Math.max(1.6, size * 0.42), 0, Math.PI * 2);
      ctx2d.fill();
      ctx2d.globalAlpha = 1;

      if (isSelected || isHovered) {
        ctx2d.strokeStyle = 'rgba(214,236,250,0.7)';
        ctx2d.lineWidth = 1;
        ctx2d.beginPath();
        ctx2d.arc(screen.x, screen.y, Math.max(6, size * 1.4), 0, Math.PI * 2);
        ctx2d.stroke();
      }

      // 标签（仅高倍率/选中）
      if (node.kind === 'entity' && (camera.zoom > 1.1 || isSelected) && quality !== 'off') {
        ctx2d.font = '11px "Segoe UI", "Microsoft YaHei UI", sans-serif';
        ctx2d.fillStyle = 'rgba(200,215,232,0.72)';
        ctx2d.fillText(String(node.label || '').slice(0, 16), screen.x + Math.max(6, size), screen.y - 6);
      }
    }
  }

  function drawClusterLabels(width, height) {
    if (camera.zoom < 0.32 || quality === 'off') return;
    ctx2d.font = '11px "Segoe UI", "Microsoft YaHei UI", sans-serif';
    for (const cluster of graph.clusters || []) {
      if (!cluster.centroid) continue;
      const screen = worldToScreen(cluster.centroid);
      if (screen.x < 0 || screen.x > width || screen.y < 0 || screen.y > height) continue;
      const color = CLUSTER_COLORS[cluster.color_hint] || CLUSTER_COLORS.white;
      ctx2d.fillStyle = hexToRgba(color, 0.75);
      ctx2d.textAlign = 'center';
      ctx2d.fillText(`${cluster.label || cluster.id} · ${(cluster.node_ids || []).length}`, screen.x, screen.y - Math.max(50, Math.min(width, height) * 0.11) * 0.6);
      ctx2d.textAlign = 'start';
    }
  }

  function draw() {
    if (destroyed) return;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    const now = performance.now();
    frameCount += 1;
    if (now - lastFrameAt > 500) {
      fps = Math.round((frameCount * 1000) / (now - lastFrameAt));
      frameCount = 0;
      lastFrameAt = now;
      emit('perf', { fps, frame_ms: Math.round(1000 / Math.max(1, fps)), draw_calls: 1 + (graph.edges || []).length });
    }
    drawBackground(width, height, now / 1000);
    drawClusterNebulae(width, height);
    drawEdges(width, height);
    drawNodes(width, height);
    drawClusterLabels(width, height);
    raf = requestAnimationFrame(draw);
  }

  // 交互
  let dragging = false;
  let dragStart = null;
  let cameraStart = null;

  function pickNode(event) {
    const rect = container.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let best = null;
    let bestDist = 18;
    for (const node of graph.nodes || []) {
      const screen = worldToScreen(node.position || { x: 0, y: 0 });
      const dist = Math.hypot(screen.x - x, screen.y - y);
      if (dist < bestDist) {
        bestDist = dist;
        best = node;
      }
    }
    return best;
  }

  const onPointerDown = (event) => {
    const node = pickNode(event);
    if (node) {
      const ids = event.shiftKey ? [...selected, node.id] : [node.id];
      selected = new Set(ids);
      emit('node:click', { id: node.id, position: node.position });
      emit('selection:change', { ids: [...selected] });
      return;
    }
    dragging = true;
    dragStart = { x: event.clientX, y: event.clientY };
    cameraStart = { center: [...camera.center] };
  };
  const onPointerMove = (event) => {
    if (dragging && dragStart) {
      const dx = event.clientX - dragStart.x;
      const dy = event.clientY - dragStart.y;
      camera.center = [cameraStart.center[0] - dx / camera.zoom, cameraStart.center[1] - dy / camera.zoom, 0];
      return;
    }
    const node = pickNode(event);
    if ((node && node.id) !== hovered) {
      hovered = node ? node.id : null;
      emit('node:hover', { id: hovered });
    }
  };
  const onPointerUp = (event) => {
    if (dragging && dragStart) {
      const dx = event.clientX - dragStart.x;
      const dy = event.clientY - dragStart.y;
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) {
        selected = new Set();
        emit('background:click', {});
        emit('selection:change', { ids: [] });
      }
    }
    dragging = false;
    dragStart = null;
  };
  const onWheel = (event) => {
    event.preventDefault();
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    camera.zoom = Math.max(0.08, Math.min(6, camera.zoom * factor));
  };
  const onDblClick = (event) => {
    const node = pickNode(event);
    if (node) emit('node:dblclick', { id: node.id });
  };
  const onContextMenu = (event) => {
    const node = pickNode(event);
    if (!node) return;
    event.preventDefault();
    emit('node:contextmenu', { id: node.id, x: event.clientX, y: event.clientY });
  };

  container.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  container.addEventListener('wheel', onWheel, { passive: false });
  container.addEventListener('dblclick', onDblClick);
  container.addEventListener('contextmenu', onContextMenu);

  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(container);
  resize();
  raf = requestAnimationFrame(draw);

  return {
    __devStub: true,
    setData(nextGraph) {
      graph = nextGraph && Array.isArray(nextGraph.nodes) ? nextGraph : { nodes: [], edges: [], clusters: [] };
      rebuildIndex();
    },
    setMapping(nextMapping) {
      mapping = { ...mapping, ...(nextMapping || {}) };
    },
    setQuality(level) {
      quality = ['ultra', 'high', 'medium', 'low', 'off'].includes(level) ? level : 'high';
      return quality;
    },
    setView(view) {
      if (!view) return;
      if (Array.isArray(view.center)) camera.center = [...view.center];
      if (Number.isFinite(view.zoom)) camera.zoom = Math.max(0.05, view.zoom);
    },
    getView() {
      return { center: [...camera.center], zoom: camera.zoom };
    },
    focusNode(id, opts = {}) {
      focused = id;
      const node = (graph.nodes || []).find((n) => n.id === id);
      if (node && node.position) camera.center = [node.position.x, node.position.y, 0];
      selected = new Set([id]);
      emit('selection:change', { ids: [id], depth: opts.depth || 1 });
    },
    select(ids) {
      selected = new Set(ids || []);
    },
    setFilters() {
      /* dev stub：客户端筛选由 atlas 视图在 setData 前完成 */
    },
    on,
    getStats() {
      return {
        fps,
        frame_ms: Math.round(1000 / Math.max(1, fps)),
        draw_calls: 2 + (graph.edges || []).length,
        nodes: (graph.nodes || []).length,
        quality,
        dev_stub: true,
      };
    },
    screenshotDataUrl() {
      return canvas.toDataURL('image/png');
    },
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      container.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('dblclick', onDblClick);
      container.removeEventListener('contextmenu', onContextMenu);
      canvas.remove();
    },
  };
}

export default { createNebula };
