// temporary matrix sanity check (test scope)
import { mat4 } from '../../../desktop/renderer/nebula/glutil.js';

const vp = mat4.create(), proj = mat4.create(), view = mat4.create(), inv = mat4.create();
mat4.perspective(proj, 42 * Math.PI / 180, 1.6, 10, 120000);
mat4.lookAt(view, [0, -16000, 5000], [0, 0, 0], [0, 0, 1]);
mat4.multiply(vp, proj, view);
mat4.invert(inv, vp);
console.log('proj', Array.from(proj).map((v) => +v.toFixed(3)));
console.log('view', Array.from(view).map((v) => +v.toFixed(3)));
function toNdc(p) {
  const m = vp;
  const cw = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [
    (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / cw,
    (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / cw,
    (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]) / cw,
    cw,
  ];
}
for (const p of [[0, 0, 0], [1000, 0, 0], [0, 3000, 0], [5000, 5000, 500]]) {
  const ndc = toNdc(p);
  // unproject ndc at w=1
  const out = mat4.transformPoint([0, 0, 0], inv, ndc[0], ndc[1], ndc[2]);
  console.log('p', JSON.stringify(p), 'ndc', ndc.map((v) => +v.toFixed(3)), 'unproj', out.map((v) => +v.toFixed(1)));
}
const a = mat4.transformPoint([0, 0, 0], inv, 0, 0, -1);
const b = mat4.transformPoint([0, 0, 0], inv, 0, 0, 1);
console.log('ray center near/far', a.map((v) => +v.toFixed(1)), b.map((v) => +v.toFixed(1)));

