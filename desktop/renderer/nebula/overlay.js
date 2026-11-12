// FCA Memory Atlas — Nebula Renderer
// DOM overlay: node labels (LOD + collision avoidance), cluster names, empty-library state.
// Labels live above the WebGL canvas so no amount of bloom/volume can ever reduce their readability.
export class Overlay {
  constructor(container) {
    this.container = container;
    this.root = document.createElement('div');
    this.root.className = 'fca-nebula-overlay';
    Object.assign(this.root.style, {
      position: 'absolute', inset: '0', overflow: 'hidden', pointerEvents: 'none',
      fontFamily: '"Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif',
      zIndex: '2',
    });
    this.labelLayer = document.createElement('div');
    Object.assign(this.labelLayer.style, { position: 'absolute', inset: '0' });
    this.clusterLayer = document.createElement('div');
    Object.assign(this.clusterLayer.style, { position: 'absolute', inset: '0' });
    this.emptyLayer = document.createElement('div');
    Object.assign(this.emptyLayer.style, {
      position: 'absolute', inset: '0', display: 'none', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', textAlign: 'center', pointerEvents: 'none',
    });
    this.emptyLayer.innerHTML = `
      <div style="font-size:11px;letter-spacing:.42em;text-transform:uppercase;color:rgba(150,180,220,.52);margin-bottom:18px">FCA · Memory Atlas</div>
      <div style="font-size:32px;font-weight:250;letter-spacing:.10em;color:#dbe7fb;margin-bottom:14px">空白星图</div>
      <div style="max-width:560px;font-size:13px;line-height:2;color:rgba(170,195,228,.66)">
        深空背景是真实渲染的天文星空；这里还没有任何记忆节点。<br>
        当 Runtime 返回 mem_* / ent_* 节点后，星云、尘埃与关系光丝将全部由 clusters 与 edges 数据生成。
      </div>
      <div style="margin-top:26px;font-size:10px;letter-spacing:.28em;text-transform:uppercase;color:rgba(120,150,190,.45)">NO DATA · NOT A PLACEHOLDER IMAGE</div>`;
    this.root.appendChild(this.clusterLayer);
    this.root.appendChild(this.emptyLayer);
    this.root.appendChild(this.labelLayer);
    container.appendChild(this.root);
    this._labels = new Map(); // key -> {el, ...}
    this._clusters = new Map();
    this._clock = 0;
  }

  /** labels: [{key, text, x, y, alpha, color, weight, kind}] in CSS px */
  updateLabels(labels) {
    let n = 0;
    for (const L of labels) {
      let rec = this._labels.get(L.key);
      if (!rec) {
        const el = document.createElement('div');
        Object.assign(el.style, {
          position: 'absolute', left: '0', top: '0', whiteSpace: 'nowrap',
          willChange: 'transform', pointerEvents: 'none', transition: 'opacity .18s linear',
        });
        this.labelLayer.appendChild(el);
        rec = { el };
        this._labels.set(L.key, rec);
      }
      const el = rec.el;
      const base = L.kind === 'entity' ? 10 : 10.5;
      const size = L.kind === 'selected' ? base + 1.2 : base;
      el.textContent = L.text;
      el.style.transform = `translate3d(${Math.round(L.x)}px, ${Math.round(L.y)}px, 0)`;
      el.style.fontSize = size.toFixed(1) + 'px';
      el.style.fontWeight = L.weight >= 0.72 ? '500' : '400';
      el.style.letterSpacing = '0.045em';
      el.style.color = L.color;
      el.style.opacity = String(L.alpha);
      el.style.textShadow = '0 1px 3px rgba(0,4,10,.95), 0 0 12px rgba(2,8,18,.85)';
      el.style.display = '';
      rec.used = true;
      n++;
    }
    for (const [key, rec] of this._labels) {
      if (!rec.used) {
        rec.el.style.display = 'none';
        if (++rec.idle > 4) { rec.el.remove(); this._labels.delete(key); }
      } else rec.used = false;
    }
    return n;
  }

  /** clusters: [{key,text,x,y,alpha,color}] */
  updateClusterLabels(labels) {
    let n = 0;
    for (const L of labels) {
      let rec = this._clusters.get(L.key);
      if (!rec) {
        const el = document.createElement('div');
        Object.assign(el.style, {
          position: 'absolute', left: '0', top: '0', whiteSpace: 'nowrap', pointerEvents: 'none',
          fontSize: '9.5px', letterSpacing: '0.30em', textTransform: 'uppercase',
          transition: 'opacity .25s linear',
        });
        this.clusterLayer.appendChild(el);
        rec = { el };
        this._clusters.set(L.key, rec);
      }
      const el = rec.el;
      el.textContent = L.text;
      el.style.transform = `translate3d(${Math.round(L.x)}px, ${Math.round(L.y)}px, 0)`;
      el.style.color = L.color;
      el.style.opacity = String(L.alpha);
      el.style.textShadow = '0 1px 4px rgba(0,4,12,.95), 0 0 18px rgba(2,8,18,.9)';
      el.style.display = '';
      rec.used = true;
      n++;
    }
    for (const [key, rec] of this._clusters) {
      if (!rec.used) { rec.el.style.display = 'none'; }
      rec.used = false;
    }
    return n;
  }

  setEmpty(visible) {
    this.emptyLayer.style.display = visible ? 'flex' : 'none';
  }

  setVisible(v) {
    this.root.style.display = v ? '' : 'none';
  }

  dispose() {
    this.root.remove();
    this._labels.clear();
    this._clusters.clear();
  }
}
