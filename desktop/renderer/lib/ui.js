/**
 * FCA Memory Atlas — UI 组件库重导出
 * 视图统一从 `../lib/ui.js` 引入：`import { ui } from '../lib/ui.js';`
 * 同时为 `router.js` 等基础模块提供常用 DOM 助手命名导出。
 */
import { ui } from '../ui/index.js';

export { ui as default, ui };

export const el = ui.el;
export const svgEl = ui.svgEl;
export const frag = ui.frag;
export const clear = ui.clear;
export const mount = ui.mount;
export const on = ui.on;
