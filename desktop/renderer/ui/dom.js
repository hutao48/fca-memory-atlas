/**
 * FCA Memory Atlas — DOM 创建工具
 * 零依赖；所有 UI 组件基于这里构建。
 */

const DIRECT_PROPS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected', 'readOnly', 'multiple', 'indeterminate']);

function applyAttrs(node, attrs) {
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class' || key === 'className') {
      const classes = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
      if (classes) node.className = classes;
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'html') {
      node.innerHTML = String(value);
    } else if (key === 'style') {
      if (typeof value === 'string') node.setAttribute('style', value);
      else Object.assign(node.style, value);
    } else if (key === 'dataset') {
      for (const [dataKey, dataValue] of Object.entries(value)) {
        if (dataValue !== undefined && dataValue !== null) node.dataset[dataKey] = String(dataValue);
      }
    } else if (key === 'on' && typeof value === 'object') {
      for (const [eventName, handler] of Object.entries(value)) {
        if (typeof handler === 'function') node.addEventListener(eventName, handler);
      }
    } else if (key.startsWith('on') && key.length > 2 && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'ref' && typeof value === 'function') {
      value(node);
    } else if (DIRECT_PROPS.has(key)) {
      node[key] = value;
    } else if (key === 'ariaLabel') {
      node.setAttribute('aria-label', String(value));
    } else if (key === 'role' || key.startsWith('aria-') || key === 'tabindex' || key === 'data-') {
      node.setAttribute(key, String(value));
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
}

function appendChild(node, child) {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const item of child) appendChild(node, item);
  } else if (child instanceof Node) {
    node.appendChild(child);
  } else {
    node.appendChild(document.createTextNode(String(child)));
  }
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  appendChild(node, children);
  return node;
}

export function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null) continue;
    node.setAttribute(key, String(value));
  }
  if (children) {
    for (const child of Array.isArray(children) ? children : [children]) {
      if (child instanceof Node) node.appendChild(child);
    }
  }
  return node;
}

export function frag(...children) {
  const fragment = document.createDocumentFragment();
  for (const child of children) appendChild(fragment, child);
  return fragment;
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(parent, ...children) {
  clear(parent);
  appendChild(parent, children);
  return parent;
}

export function text(value) {
  return document.createTextNode(value == null ? '' : String(value));
}

export function on(target, eventName, handler, options) {
  target.addEventListener(eventName, handler, options);
  return () => target.removeEventListener(eventName, handler, options);
}

/** 等待下一帧（截图/布局稳定用） */
export function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** 等待两帧 */
export function twoFrames() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

/** 点击外部关闭（返回解除函数） */
export function onOutsideClick(node, handler, options = {}) {
  const listener = (event) => {
    if (!(event.target instanceof Node)) return;
    if (node.contains(event.target)) return;
    handler(event);
  };
  document.addEventListener('pointerdown', listener, true);
  if (options.escape !== false) {
    document.addEventListener('keydown', escapeListener, true);
  }
  function escapeListener(event) {
    if (event.key === 'Escape') handler(event);
  }
  return () => {
    document.removeEventListener('pointerdown', listener, true);
    document.removeEventListener('keydown', escapeListener, true);
  };
}

/** 防抖 */
export function debounce(fn, wait = 200) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}

/** 节流（requestAnimationFrame） */
export function rafThrottle(fn) {
  let scheduled = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn(...lastArgs);
    });
  };
}
