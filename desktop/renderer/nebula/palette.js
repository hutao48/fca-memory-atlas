// FCA Memory Atlas — Nebula Renderer
// Astronomical color system + semantic mapping tables (single source for renderer + legend).
// Colors are authored as sRGB hex and converted to linear light before upload to GLSL (HDR pipeline).

export const COLOR_HINTS = {
  cyan:    { hex: '#57c9e8', label: '青蓝' },
  blue:    { hex: '#4d7fe6', label: '深蓝' },
  violet:  { hex: '#8a6fe6', label: '紫罗兰' },
  magenta: { hex: '#c25eae', label: '洋红' },
  rose:    { hex: '#df8899', label: '玫瑰' },
  gold:    { hex: '#e5b46b', label: '暗金' },
  white:   { hex: '#ccd8ec', label: '冷白' },
};

export const MEMORY_TYPES = {
  working:          { hex: '#d6e4ff', label: '工作记忆' },
  episodic:         { hex: '#8fb8ee', label: '情景记忆' },
  semantic:         { hex: '#77d3e2', label: '语义记忆' },
  procedural:       { hex: '#7ed0c0', label: '程序记忆' },
  autobiographical: { hex: '#ad9dea', label: '自传记忆' },
  project:          { hex: '#e8c98a', label: '项目' },
  relational:       { hex: '#dd93bf', label: '关系记忆' },
  emotional:        { hex: '#e8a2ab', label: '情感记忆' },
};

export const ENTITY_TYPES = {
  person:       { hex: '#e4ddc9', label: '人物' },
  project:      { hex: '#d8bf8a', label: '项目实体' },
  place:        { hex: '#93c6d6', label: '地点' },
  concept:      { hex: '#b3aada', label: '概念' },
  organization: { hex: '#c9b7a0', label: '组织' },
  other:        { hex: '#b9c4d6', label: '其它实体' },
};

export const RELATION_STYLES = {
  temporal_before:  { hex: '#8fa6d2', label: '此前', dash: 0.0, flow: 0.18, width: 0.9, curve: 0.10 },
  temporal_after:   { hex: '#8fa6d2', label: '此后', dash: 0.0, flow: 0.18, width: 0.9, curve: 0.10 },
  participates_in:  { hex: '#7ecbe0', label: '参与', dash: 0.0, flow: 0.30, width: 1.0, curve: 0.16 },
  shared_experience:{ hex: '#ae9be8', label: '共同经历', dash: 0.0, flow: 0.30, width: 1.0, curve: 0.20 },
  knowledge_link:   { hex: '#8bb0de', label: '知识关联', dash: 0.5, flow: 0.14, width: 0.8, curve: 0.12 },
  causal:           { hex: '#dfb982', label: '因果', dash: 0.0, flow: 0.26, width: 1.05, curve: 0.18 },
  derived_from:     { hex: '#86d6c6', label: '派生自', dash: 0.35, flow: 0.20, width: 0.85, curve: 0.14 },
  belongs_to_project:{ hex: '#d4bd8c', label: '属于项目', dash: 0.0, flow: 0.22, width: 0.95, curve: 0.14 },
  emotional_link:   { hex: '#e39ab6', label: '情感连接', dash: 0.0, flow: 0.34, width: 1.0, curve: 0.22 },
  custom:           { hex: '#c0cad8', label: '自定义', dash: 0.2, flow: 0.15, width: 0.9, curve: 0.12 },
};

export const QUALITY_LEVELS = ['ultra', 'high', 'medium', 'low', 'off'];

/** sRGB hex -> linear [r,g,b] ∈ [0,1]. */
export function hexToLinear(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const toLin = (c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return [toLin((n >> 16) & 255), toLin((n >> 8) & 255), toLin(n & 255)];
}

export function hexToLinearScaled(hex, scale = 1) {
  const c = hexToLinear(hex);
  return [c[0] * scale, c[1] * scale, c[2] * scale];
}

/** Default mapping parameters exposed to Desktop UI (opaque JSON, renderer interprets). */
export function defaultMapping() {
  return {
    // node layer
    nodeSize: 1.0,
    nodeBrightness: 1.0,
    nodeMinPixel: 1.5,
    // nebula volume
    nebulaIntensity: 1.3,
    nebulaSaturation: 1.12,
    dustStrength: 1.55,
    gasScale: 1.2,
    // relations
    relationOpacity: 0.22,
    relationFlow: 1.0,
    relationWidth: 0.58,
    // deep space background
    starDensity: 0.9,
    bandIntensity: 0.62,
    // post
    exposure: 0.86,
    bloom: 0.55,
    grain: 1.0,
    vignette: 1.0,
    chromaticAberration: 1.0,
    // semantic override (optional): { episodic: '#hex' } etc.
    typeColors: {},
    hintColors: {},
    relationColors: {},
  };
}

export function mergeMapping(base, patch) {
  const out = { ...base };
  for (const k in patch || {}) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = { ...base[k], ...v };
    } else out[k] = v;
  }
  return out;
}

/** Resolve node tint (linear rgb triple) from node kind/type and mapping overrides. */
export function nodeTypeColor(node, mapping) {
  const table = node.kind === 'entity' ? ENTITY_TYPES : MEMORY_TYPES;
  const key = node.type && table[node.type] ? node.type : 'episodic';
  const over = (mapping && mapping.typeColors && mapping.typeColors[key]) || table[key].hex;
  return hexToLinear(over);
}

export function hintColor(hint, mapping) {
  const key = COLOR_HINTS[hint] ? hint : 'blue';
  const over = (mapping && mapping.hintColors && mapping.hintColors[key]) || COLOR_HINTS[key].hex;
  return hexToLinear(over);
}

/**
 * Legend metadata consumed by Desktop/demo "图例/图层/映射说明" UI.
 * Purely descriptive; renderer owns visual implementation.
 */
export function buildLegend(mapping) {
  const m = mapping || defaultMapping();
  return {
    colorHints: Object.entries(COLOR_HINTS).map(([key, v]) => ({
      key, label: v.label, color: v.hex, meaning: '聚类 color_hint（星云发射主色）',
    })),
    nodeTypes: [
      ...Object.entries(MEMORY_TYPES).map(([key, v]) => ({ key, label: v.label, color: v.hex, group: 'memory' })),
      ...Object.entries(ENTITY_TYPES).map(([key, v]) => ({ key, label: v.label, color: v.hex, group: 'entity' })),
    ],
    relationTypes: Object.entries(RELATION_STYLES).map(([key, v]) => ({
      key, label: v.label, color: v.hex, dashed: v.dash > 0, flow: v.flow > 0.2,
    })),
    size: {
      formula: '节点大小 = clamp(基础像素 × √(display_weight) × (0.55 + 0.9×importance) × (1 + 0.03×√degree))',
      note: 'importance 越高越亮/越大；普通记忆保持低亮度小尺寸。',
    },
    brightness: {
      formula: '亮度 = (0.22 + 0.78×importance²) × (0.6 + 0.4×display_weight)',
      note: '只有重要记忆点亮，避免“满屏亮球”；实体节点偏冷、亮度更低。',
    },
    nebula: {
      formula: '每个 cluster = 一个各向异性高斯发射核（质心/distribution），强度 ∝ density；FBM 结构噪声 + 高频尘埃吸收',
      note: `当前星云强度 ${m.nebulaIntensity.toFixed(2)}、尘埃 ${m.dustStrength.toFixed(2)}、气体尺度 ${m.gasScale.toFixed(2)}`,
    },
    background: {
      formula: '深空星点/银河带方向由 cluster 分布 PCA 主轴决定；星点密度与图规模、cluster density 相关',
      note: `星点密度 ${m.starDensity.toFixed(2)}、银河带 ${m.bandIntensity.toFixed(2)}`,
    },
    layers: [
      { key: 'background', label: '深空背景（星点 / 银河带 / 星系）' },
      { key: 'nebula', label: '体积星云（cluster 发射 + 尘埃）' },
      { key: 'foreground', label: '前景气体薄雾' },
      { key: 'relations', label: '关系光丝 / 粒子流' },
      { key: 'nodes', label: '星体节点（记忆 / 实体）' },
      { key: 'labels', label: '标签（LOD）' },
      { key: 'clusterLabels', label: '聚类名称' },
    ],
    quality: [
      { key: 'ultra', label: 'ultra · 全效果（128 步体积）' },
      { key: 'high', label: 'high · 默认（96 步）' },
      { key: 'medium', label: 'medium · 平衡（64 步，半分辨率）' },
      { key: 'low', label: 'low · 低配（40 步，降分辨率）' },
      { key: 'off', label: 'off · 关闭特效（保留全部交互与标签）' },
    ],
  };
}
