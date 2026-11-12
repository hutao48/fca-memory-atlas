/**
 * FCA Memory Atlas — Toast 通知
 */

import { el } from './dom.js';
import { icon } from './icons.js';

let container = null;

function ensureContainer() {
  if (container && document.contains(container)) return container;
  container = el('div', { class: 'fca-toasts', role: 'status', 'aria-live': 'polite' });
  const root = document.getElementById('overlay-root') || document.body;
  root.appendChild(container);
  return container;
}

const DEFAULT_TITLES = {
  info: '提示',
  success: '完成',
  warn: '注意',
  error: '错误',
};

const DEFAULT_ICONS = {
  info: 'info',
  success: 'check',
  warn: 'alert',
  error: 'alert',
};

/**
 * @param {string} message
 * @param {object} [options] { title, type:'info'|'success'|'warn'|'error', duration, action:{label,onClick} }
 * @returns {{close:Function, el:HTMLElement}}
 */
export function toast(message, options = {}) {
  const { title, type = 'info', duration = 4200, action } = options;
  const host = ensureContainer();
  const node = el('div', { class: `fca-toast fca-toast--${type}` });
  const iconNode = el('span', { class: 'fca-toast__icon' }, [icon(DEFAULT_ICONS[type] || 'info', { size: 16 })]);
  const content = el('div', { class: 'fca-toast__content' }, [
    title || type !== 'info' ? el('div', { class: 'fca-toast__title', text: title || DEFAULT_TITLES[type] }) : null,
    el('div', { class: 'fca-toast__message', text: message }),
  ]);
  if (action && action.label) {
    const actionBtn = el('button', {
      class: 'statusbar__action fca-toast__action',
      type: 'button',
      text: action.label,
    });
    actionBtn.addEventListener('click', () => {
      try {
        if (typeof action.onClick === 'function') action.onClick();
      } finally {
        close();
      }
    });
    content.appendChild(actionBtn);
  }
  const closeBtn = el('button', { class: 'icon-btn icon-btn--xs fca-toast__close', type: 'button', title: '关闭', 'aria-label': '关闭通知' }, [icon('close', { size: 12 })]);
  node.append(iconNode, content, closeBtn);
  host.appendChild(node);
  while (host.children.length > 4) host.firstElementChild.remove();

  let timer = null;
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 160);
  }
  closeBtn.addEventListener('click', close);
  if (duration > 0) timer = setTimeout(close, duration);
  return { close, el: node };
}

export function clearToasts() {
  if (container) while (container.firstChild) container.firstChild.remove();
}
