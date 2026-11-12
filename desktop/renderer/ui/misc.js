/**
 * FCA Memory Atlas — 其它基础组件（分区 / 空状态 / 载入 / 标签页 / 提示）
 */

import { el, onOutsideClick } from './dom.js';
import { icon } from './icons.js';

export function section(options = {}) {
  const { title, subtitle, actions = [], content, collapsible = false, defaultOpen = true, className = '' } = options;
  const body = el('div', { class: 'fca-section__body' });
  if (content instanceof Node) body.appendChild(content);
  else if (typeof content === 'function') {
    const result = content();
    if (result instanceof Node) body.appendChild(result);
  }
  const header = el('div', { class: 'fca-section__header' }, [
    el('div', { class: 'fca-grow' }, [
      el('div', { class: 'fca-section__title', text: title || '' }),
      subtitle ? el('div', { class: 'fca-section__subtitle', text: subtitle }) : null,
    ]),
    actions.length ? el('div', { class: 'fca-section__actions' }, actions) : null,
  ]);
  const root = el('div', { class: `fca-section ${className}`.trim() }, [header, body]);
  if (collapsible) {
    let open = Boolean(defaultOpen);
    if (!open) body.style.display = 'none';
    header.style.cursor = 'pointer';
    header.addEventListener('click', () => {
      open = !open;
      body.style.display = open ? '' : 'none';
    });
  }
  root.body = body;
  return root;
}

export function emptyState(options = {}) {
  const { icon: iconName = 'sparkles', title = '', description = '', actions = [] } = options;
  const root = el('div', { class: 'fca-empty' }, [
    iconName ? el('div', { class: 'fca-empty__icon' }, [icon(iconName, { size: 22 })]) : null,
    title ? el('div', { class: 'fca-empty__title', text: title }) : null,
    description ? el('div', { class: 'fca-empty__desc', text: description }) : null,
    actions.length ? el('div', { class: 'fca-empty__actions' }, actions) : null,
  ]);
  return root;
}

export function spinner(options = {}) {
  const { label = '' } = options;
  return el('div', { class: 'fca-spinner' }, [el('span', { class: 'fca-spinner__ring' }), label ? el('span', { text: label }) : null]);
}

export function progress(options = {}) {
  const { value = 0, max = 100, className = '' } = options;
  const pct = Math.max(0, Math.min(1, max > 0 ? value / max : 0)) * 100;
  const bar = el('div', { class: 'fca-progress__bar', style: { width: `${pct}%` } });
  const root = el('div', { class: `fca-progress ${className}`.trim(), role: 'progressbar', 'aria-valuenow': String(value), 'aria-valuemax': String(max) }, [bar]);
  root.setValue = (nextValue, nextMax = max) => {
    const nextPct = Math.max(0, Math.min(1, nextMax > 0 ? nextValue / nextMax : 0)) * 100;
    bar.style.width = `${nextPct}%`;
    root.setAttribute('aria-valuenow', String(nextValue));
  };
  return root;
}

export function tabs(options = {}) {
  const { tabs: tabsList = [], active, onChange } = options;
  const root = el('div', { class: 'fca-tabs', role: 'tablist' });
  let current = active || (tabsList[0] && tabsList[0].id);
  for (const tab of tabsList) {
    const node = el('button', {
      class: `fca-tabs__tab${tab.id === current ? ' is-active' : ''}`,
      type: 'button',
      role: 'tab',
      'aria-selected': tab.id === current ? 'true' : 'false',
      'data-tab': tab.id,
    }, [tab.icon ? icon(tab.icon, { size: 13 }) : null, tab.label]);
    node.addEventListener('click', () => {
      if (current === tab.id) return;
      current = tab.id;
      for (const child of root.children) {
        const isActive = child.dataset.tab === current;
        child.classList.toggle('is-active', isActive);
        child.setAttribute('aria-selected', isActive ? 'true' : 'false');
      }
      if (typeof onChange === 'function') onChange(current);
    });
    root.appendChild(node);
  }
  root.setActive = (id) => {
    if (current === id) return;
    current = id;
    for (const child of root.children) {
      const isActive = child.dataset.tab === id;
      child.classList.toggle('is-active', isActive);
      child.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
  };
  root.getActive = () => current;
  return root;
}

let tooltipNode = null;

export function tooltip(target, message, options = {}) {
  const { delay = 420 } = options;
  if (!target || !message) return { destroy() {} };
  let timer = null;
  let currentNode = null;
  let removeOutside = null;

  const show = () => {
    if (currentNode || !document.contains(target)) return;
    currentNode = el('div', { class: 'fca-tooltip', text: message });
    document.body.appendChild(currentNode);
    const rect = target.getBoundingClientRect();
    const tipRect = currentNode.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    let top = rect.bottom + 7;
    if (top + tipRect.height > window.innerHeight - 8) top = rect.top - tipRect.height - 7;
    left = Math.max(8, Math.min(window.innerWidth - tipRect.width - 8, left));
    currentNode.style.left = `${left}px`;
    currentNode.style.top = `${top}px`;
    removeOutside = onOutsideClick(target, hide, { escape: false });
  };
  const hide = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (removeOutside) {
      removeOutside();
      removeOutside = null;
    }
    if (currentNode) {
      currentNode.remove();
      currentNode = null;
    }
  };
  const onEnter = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(show, delay);
  };
  const onLeave = () => hide();
  target.addEventListener('mouseenter', onEnter);
  target.addEventListener('mouseleave', onLeave);
  target.addEventListener('mousedown', hide);
  return {
    destroy() {
      hide();
      target.removeEventListener('mouseenter', onEnter);
      target.removeEventListener('mouseleave', onLeave);
      target.removeEventListener('mousedown', hide);
    },
  };
}

export function divider() {
  return el('div', { class: 'fca-divider' });
}
