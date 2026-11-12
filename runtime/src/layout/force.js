// FCA Local Runtime — 确定性力导向布局 force_v1（Barnes-Hut 四叉树近似排斥 + 聚类引力 + 边弹簧）
// 设计约束：同一输入必须产生完全相同的坐标（无 Math.random；种子/哈希确定）。
export const FORCE_ALGORITHM = 'force_v1';
export const WORLD_BOUNDS = Object.freeze({ x_min: -5000, x_max: 5000, y_min: -5000, y_max: 5000, z_min: -800, z_max: 800 });

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function hashOffset(key, spread) {
  const h1 = fnv1a32(`${key}|x`);
  const h2 = fnv1a32(`${key}|y`);
  const h3 = fnv1a32(`${key}|z`);
  return {
    x: ((h1 % 20001) / 10000 - 1) * spread,
    y: ((h2 % 20001) / 10000 - 1) * spread,
    z: ((h3 % 20001) / 10000 - 1) * spread,
  };
}

function idealDistance(n, radius) {
  const area = (2 * radius) * (2 * radius);
  return Math.sqrt(area / Math.max(1, n));
}

function iterationCount(n) {
  if (n <= 300) return 160;
  if (n <= 1000) return 120;
  if (n <= 3000) return 60;
  return 35;
}

// ---------- Barnes-Hut 四叉树（2D） ----------
function buildQuadtree(positions, indices, bounds) {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const half = Math.max((bounds.maxX - bounds.minX) / 2, (bounds.maxY - bounds.minY) / 2, 1e-3);
  const root = { cx, cy, half, mass: 0, comX: 0, comY: 0, body: -1, children: null };

  for (const idx of indices) {
    const x = positions[idx].x;
    const y = positions[idx].y;
    let node = root;
    for (;;) {
      if (node.children === null && node.body === -1) {
        node.body = idx;
        node.mass = 1;
        node.comX = x;
        node.comY = y;
        break;
      }
      if (node.children === null) {
        // 细分叶子
        const bodyIdx = node.body;
        node.body = -1;
        node.children = [null, null, null, null];
        const bx = positions[bodyIdx].x;
        const by = positions[bodyIdx].y;
        const q = quadrant(node, bx, by);
        node.children[q] = {
          cx: node.cx + (q % 2 === 0 ? -node.half / 2 : node.half / 2),
          cy: node.cy + (q < 2 ? -node.half / 2 : node.half / 2),
          half: node.half / 2,
          mass: 1,
          comX: bx,
          comY: by,
          body: bodyIdx,
          children: null,
        };
        node.mass = 1;
        node.comX = bx;
        node.comY = by;
      }
      node.mass += 1;
      node.comX += (x - node.comX) / node.mass;
      node.comY += (y - node.comY) / node.mass;
      const q = quadrant(node, x, y);
      if (node.children[q] === null) {
        node.children[q] = {
          cx: node.cx + (q % 2 === 0 ? -node.half / 2 : node.half / 2),
          cy: node.cy + (q < 2 ? -node.half / 2 : node.half / 2),
          half: node.half / 2,
          mass: 0,
          comX: 0,
          comY: 0,
          body: -1,
          children: null,
        };
      }
      node = node.children[q];
    }
  }
  return root;
}

function quadrant(node, x, y) {
  const east = x >= node.cx ? 1 : 0;
  const south = y >= node.cy ? 1 : 0;
  return east + south * 2;
}

function accumulateRepulsion(node, idx, x, y, k2, theta, out) {
  _accumulate(node, idx, x, y, k2, theta, out);
}

function _accumulate(node, idx, x, y, k2, theta, out) {
  if (!node || node.mass === 0) return;
  if (node.children === null) {
    if (node.body === idx) return;
    let dx = x - node.comX;
    let dy = y - node.comY;
    let dist2 = dx * dx + dy * dy;
    if (dist2 < 1e-4) {
      // 确定性微扰，避免重合点无穷力
      dx = ((node.body + 1) % 7) - 3;
      dy = ((node.body + 2) % 5) - 2;
      dist2 = dx * dx + dy * dy + 1e-3;
    }
    const dist = Math.sqrt(dist2);
    const force = k2 / Math.max(dist, 1e-3);
    out.dx += (dx / dist) * force;
    out.dy += (dy / dist) * force;
    return;
  }
  const dx = x - node.comX;
  const dy = y - node.comY;
  const dist2 = dx * dx + dy * dy;
  const dist = Math.sqrt(dist2) || 1e-3;
  const size = node.half * 2;
  if (size / dist < theta) {
    const force = (k2 * node.mass) / Math.max(dist, 1e-3);
    out.dx += (dx / dist) * force;
    out.dy += (dy / dist) * force;
  } else {
    for (const child of node.children) _accumulate(child, idx, x, y, k2, theta, out);
  }
}

function exactRepulsion(x, y, positions, active, k2, out) {
  for (const other of active) {
    let dx = x - positions[other].x;
    let dy = y - positions[other].y;
    let dist2 = dx * dx + dy * dy;
    if (dist2 < 1e-4) {
      dx = ((other + 1) % 7) - 3;
      dy = ((other + 2) % 5) - 2;
      dist2 = dx * dx + dy * dy + 1e-3;
    }
    const dist = Math.sqrt(dist2);
    const force = k2 / Math.max(dist, 1e-3);
    out.dx += (dx / dist) * force;
    out.dy += (dy / dist) * force;
  }
}

/**
 * 计算确定性布局。
 * @param {{
 *   nodes: Array<{key:string, kind:string, cluster_id:string|undefined, pinned?:boolean, x?:number, y?:number, z?:number}>,
 *   edges: Array<{fromKey:string, toKey:string, weight?:number, confidence?:number}>,
 *   clusters: Array<{id:string}>,
 *   clusterSeparation?: number
 * }} input
 * @returns {Map<string, {x:number,y:number,z:number}>}
 */
export function computeForceLayout({ nodes, edges, clusters, clusterSeparation = 0.8 }) {
  const n = nodes.length;
  const result = new Map();
  if (n === 0) return result;
  const radius = clamp(Math.sqrt(n) * 14, 180, 3600);
  const separation = clamp(Number(clusterSeparation) || 0, 0, 1);
  const k = idealDistance(n, radius);
  const k2 = k * k;
  const sortedNodes = [...nodes].sort((a, b) => a.key.localeCompare(b.key));
  const indexByKey = new Map();
  sortedNodes.forEach((node, i) => indexByKey.set(node.key, i));

  // 聚类中心（黄金角球面，确定性）
  const clusterIds = [...new Set(sortedNodes.map((node) => node.cluster_id ?? `cluster_${node.kind}`))].sort();
  const clusterCenter = new Map();
  const centerRadius = radius * (0.5 + 0.4 * separation);
  clusterIds.forEach((clusterId, i) => {
    const t = (i + 0.5) / Math.max(1, clusterIds.length);
    const y = 1 - 2 * t;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = i * 2.399963229728653;
    clusterCenter.set(clusterId, {
      x: centerRadius * ring * Math.cos(theta),
      y: centerRadius * ring * Math.sin(theta),
      z: centerRadius * 0.18 * y,
    });
  });

  const clusterSize = new Map();
  for (const node of sortedNodes) {
    const cid = node.cluster_id ?? `cluster_${node.kind}`;
    clusterSize.set(cid, (clusterSize.get(cid) ?? 0) + 1);
  }

  const seed = fnv1a32(sortedNodes.map((node) => node.key).join('|')) ^ 0x9e3779b9;
  const rand = mulberry32(seed);
  const positions = sortedNodes.map((node, i) => {
    const cid = node.cluster_id ?? `cluster_${node.kind}`;
    const center = clusterCenter.get(cid);
    if (node.pinned && Number.isFinite(node.x) && Number.isFinite(node.y)) {
      return { x: node.x, y: node.y, z: Number.isFinite(node.z) ? node.z : 0 };
    }
    const size = clusterSize.get(cid) ?? 1;
    const spread = 12 + 9 * Math.sqrt(size);
    const theta = rand() * Math.PI * 2;
    const r = spread * Math.sqrt(rand());
    return { x: center.x + Math.cos(theta) * r, y: center.y + Math.sin(theta) * r, z: 0 };
  });

  const active = sortedNodes.map((node, i) => (node.pinned ? -1 : i)).filter((i) => i >= 0);
  const springs = [];
  for (const edge of edges) {
    const a = indexByKey.get(edge.fromKey);
    const b = indexByKey.get(edge.toKey);
    if (a === undefined || b === undefined || a === b) continue;
    const influence = clamp(Number(edge.confidence ?? 0.5), 0.05, 1) * clamp(Number(edge.weight ?? 1), 0.1, 3);
    springs.push({ a, b, influence });
  }

  const iterations = iterationCount(n);
  const tempStart = radius * 0.12;
  const tempEnd = radius * 0.005;
  const theta = 0.9;

  for (let iter = 0; iter < iterations; iter += 1) {
    const temp = tempStart + ((tempEnd - tempStart) * iter) / Math.max(1, iterations - 1);
    const displacements = sortedNodes.map(() => ({ dx: 0, dy: 0 }));
    // 1) 排斥
    if (n <= 400) {
      for (const i of active) {
        const pos = positions[i];
        exactRepulsion(pos.x, pos.y, positions, active, k2, displacements[i]);
      }
    } else {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const pos of positions) {
        if (pos.x < minX) minX = pos.x;
        if (pos.x > maxX) maxX = pos.x;
        if (pos.y < minY) minY = pos.y;
        if (pos.y > maxY) maxY = pos.y;
      }
      const bounds = { minX, maxX, minY, maxY };
      const tree = buildQuadtree(positions, active, bounds);
      for (const i of active) {
        accumulateRepulsion(tree, i, positions[i].x, positions[i].y, k2, theta, displacements[i]);
      }
    }
    // 2) 边弹簧
    const springStrength = 0.02;
    for (const spring of springs) {
      const pa = positions[spring.a];
      const pb = positions[spring.b];
      let dx = pb.x - pa.x;
      let dy = pb.y - pa.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1e-3;
      const ideal = k * 1.6;
      const force = ((dist - ideal) / dist) * springStrength * spring.influence;
      dx *= force;
      dy *= force;
      if (!sortedNodes[spring.a].pinned) {
        displacements[spring.a].dx += dx;
        displacements[spring.a].dy += dy;
      }
      if (!sortedNodes[spring.b].pinned) {
        displacements[spring.b].dx -= dx;
        displacements[spring.b].dy -= dy;
      }
    }
    // 3) 聚类引力 + 全局中心引力
    const gravity = 0.012 + 0.035 * separation;
    for (const i of active) {
      const node = sortedNodes[i];
      const cid = node.cluster_id ?? `cluster_${node.kind}`;
      const center = clusterCenter.get(cid);
      const pos = positions[i];
      displacements[i].dx += (center.x - pos.x) * gravity;
      displacements[i].dy += (center.y - pos.y) * gravity;
      displacements[i].dx += -pos.x * 0.0015;
      displacements[i].dy += -pos.y * 0.0015;
    }
    // 4) 位移应用（温度限制）
    for (const i of active) {
      const pos = positions[i];
      const { dx, dy } = displacements[i];
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-9) continue;
      const scale = Math.min(1, temp / len);
      pos.x = clamp(pos.x + dx * scale, WORLD_BOUNDS.x_min, WORLD_BOUNDS.x_max);
      pos.y = clamp(pos.y + dy * scale, WORLD_BOUNDS.y_min, WORLD_BOUNDS.y_max);
    }
  }

  // 最终 z 与坐标落盘格式
  sortedNodes.forEach((node, i) => {
    const cid = node.cluster_id ?? `cluster_${node.kind}`;
    const center = clusterCenter.get(cid);
    const pos = positions[i];
    let z;
    if (node.pinned && Number.isFinite(node.z)) {
      z = node.z;
    } else {
      const jitter = hashOffset(node.key, 6 + 0.4 * Math.sqrt(clusterSize.get(cid) ?? 1));
      z = center.z + jitter.z;
    }
    result.set(node.key, {
      x: Math.round(clamp(pos.x, WORLD_BOUNDS.x_min, WORLD_BOUNDS.x_max) * 100) / 100,
      y: Math.round(clamp(pos.y, WORLD_BOUNDS.y_min, WORLD_BOUNDS.y_max) * 100) / 100,
      z: Math.round(clamp(z, WORLD_BOUNDS.z_min, WORLD_BOUNDS.z_max) * 100) / 100,
    });
  });
  return result;
}

/** 供确定性测试使用：基于固定输入的哈希种子。 */
export function layoutSeedFor(keys) {
  return fnv1a32([...keys].sort().join('|')) ^ 0x9e3779b9;
}
