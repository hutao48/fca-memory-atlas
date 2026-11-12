/**
 * FCA Memory Atlas — 上下文菜单 / 下拉菜单
 */

import { el } from './dom.js';
import { icon } from './icons.js';

function overlayRoot() {
  return document.getElementById('overlay-root') || document.body;
}

function buildMenu(items) {
  const menu = el('div', { class: 'fca-menu', role: 'menu' });
  for (const item of items) {
    if (!item) continue;
    if (item.separator) {
      menu.appendChild(el('div', { class: 'fca-menu__separator', role: 'separator' }));
      continue;
    }
    if (item.header) {
      menu.appendChild(el('div', { class: 'fca-menu__header', text: item.header }));
      continue;
    }
    const node = el('button', {
      class: `fca-menu__item${item.danger ? ' fca-menu__item--danger' : ''}`,
      type: 'button',
      role: 'menuitem',
      disabled: Boolean(item.disabled),
      title: item.title || undefined,
    }, [
      item.icon ? icon(item.icon, { size: 14 }) : null,
      el('span', { class: 'fca-menu__label', text: item.label }),
      item.shortcut ? el('span', { class: 'fca-menu__shortcut', text: item.shortcut }) : null,
    ]);
    node.addEventListener('click', () => {
      closeMenu();
      if (typeof item.onClick === 'function') item.onClick();
    });
    menu.appendChild(node);
  }
  return menu;
}

let activeMenu = null;
let activeCleanup = null;

function closeMenu() {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
  if (activeCleanup) {
    activeCleanup();
    activeCleanup = null;
  }
}

function clampPosition(x, y, menu) {
  const rect = menu.getBoundingClientRect();
  const margin = 8;
  let left = x;
  let top = y;
  if (left + rect.width > window.innerWidth - margin) left = window.innerWidth - rect.width - margin;
  if (top + rect.height > window.innerHeight - margin) top = window.innerHeight - rect.height - margin;
  return { left: Math.max(margin, left), top: Math.max(margin, top) };
}

function attachAutoClose(menu) {
  const onPointerDown = (event) => {
    if (event.target instanceof Node && menu.contains(event.target)) return;
    closeMenu();
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeMenu();
    }
  };
  const onBlur = () => closeMenu();
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', onBlur);
  activeCleanup = () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', onBlur);
  };
}

/**
 * 打开上下文菜单
 * @param {{x:number,y:number,items:Array}} options
 * @returns {{close:Function, el:HTMLElement}}
 */
export function contextMenu(options = {}) {
  closeMenu();
  const { x = 0, y = 0, items = [] } = options;
  const menu = buildMenu(items);
  overlayRoot().appendChild(menu);
  const pos = clampPosition(x, y, menu);
  menu.style.left = `${pos.left}px`;
  menu.style.top = `${pos.top}px`;
  activeMenu = menu;
  attachAutoClose(menu);
  return { close: closeMenu, el: menu };
}

/**
 * 锚定下拉菜单（按钮/图标下方）
 * @param {{anchor:HTMLElement, items:Array, align:'left'|'right', offsetY:number}} options
 */
export function dropdown(options = {}) {
  const { anchor, items = [], align = 'left' } = options;
  if (!anchor) return { close: closeMenu };
  const rect = anchor.getBoundingClientRect();
  closeMenu();
  const menu = buildMenu(items);
  overlayRoot().appendChild(menu);
  const menuRect = menu.getBoundingClientRect();
  let left = align === 'right' ? rect.right - menuRect.width : rect.left;
  let top = rect.bottom + 6;
  if (left + menuRect.width > window.innerWidth - 8) left = window.innerWidth - menuRect.width - 8;
  if (top + menuRect.height > window.innerHeight - 8) top = rect.top - menuRect.height - 6;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  activeMenu = menu;
  attachAutoClose(menu);
  return { close: closeMenu, el: menu };
}

export { closeMenu as closeAnyMenu };
