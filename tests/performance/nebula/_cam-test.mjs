// temporary camera sanity check (test scope)
import { Camera } from '../../../desktop/renderer/nebula/camera.js';

const c = new Camera();
c.setAspect(2190 / 1370);
c.fitBounds({ min: [-2200, -1900, -300], max: [1800, 1600, 260] }, 0.14);
c.update(1);
console.log('aspect', c.aspect, 'fov', c.fov, 'eye', c.eye.map((v) => +v.toFixed(1)));
console.log('proj', Array.from(c.proj).map((v) => +v.toFixed(3)));
console.log('view', Array.from(c.view).map((v) => +v.toFixed(3)));
console.log('vp', Array.from(c.viewProj).map((v) => +v.toFixed(3)));
const p = c.project(0, 0, 0, 1602, 1002);
console.log('project origin', p);
