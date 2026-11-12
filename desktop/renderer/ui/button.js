/**
 * FCA Memory Atlas — 按钮组件
 */

import { el } from './dom.js';
import { icon } from './icons.js';

const VARIANTS = new Set(['primary', 'secondary', 'ghost', 'danger']);

/**
 * @param {object} options
 * @param {string} [options.label]
 * @param {string} [options.icon]
 * @param {'primary'|'secondary'|'ghost'|'danger'} [options.variant]
 * @param {'md'|'sm'} [options.size]
 * @param {boolean} [options.disabled]
 * @param {boolean} [options.loading]
 * @param {string} [options.title]
 * @param {string} [options.kbd]
 * @param {string} [options.className]
 * @param {(event:MouseEvent)=>void} [options.onClick]
 * @returns {HTMLButtonElement}
 */
export function button(options = {}) {
  const {
    label,
    icon: iconName,
    variant = 'secondary',
    size = 'md',
    disabled = false,
    loading = false,
    title,
    kbd,
    className = '',
    onClick,
    type = 'button',
    ariaLabel,
  } = options;
  const classes = ['btn', `btn--${VARIANTS.has(variant) ? variant : 'secondary'}`];
  if (size === 'sm') classes.push('btn--sm');
  if (className) classes.push(className);
  const btn = el('button', {
    class: classes.join(' '),
    type,
    title: title || (typeof label === 'string' ? label : undefined),
    'aria-label': ariaLabel || (typeof label === 'string' ? label : undefined),
    disabled: disabled || loading,
  });
  if (loading) btn.appendChild(el('span', { class: 'btn__spinner' }));
  else if (iconName) btn.appendChild(icon(iconName, { size: size === 'sm' ? 14 : 16 }));
  if (label) btn.appendChild(el('span', { class: 'btn__label', text: label }));
  if (kbd) btn.appendChild(el('span', { class: 'btn__kbd', text: kbd }));
  if (typeof onClick === 'function') {
    btn.addEventListener('click', (event) => {
      if (btn.disabled) return;
      onClick(event);
    });
  }
  btn.setLoading = (value) => {
    if (value) {
      btn.disabled = true;
      btn.dataset.loading = '1';
    } else {
      btn.disabled = false;
      delete btn.dataset.loading;
    }
  };
  return btn;
}

/**
 * 图标按钮
 * @returns {HTMLButtonElement}
 */
export function iconButton(options = {}) {
  const { icon: iconName, label, variant = 'ghost', size = 'md', active = false, disabled = false, title, onClick, className = '' } = options;
  const classes = ['icon-btn'];
  if (size === 'sm') classes.push('icon-btn--sm');
  if (size === 'xs') classes.push('icon-btn--xs');
  if (variant === 'active' || active) classes.push('is-active');
  if (className) classes.push(className);
  const btn = el('button', {
    class: classes.join(' '),
    type: 'button',
    title: title || label,
    'aria-label': label || title || iconName,
    disabled,
  });
  if (iconName) btn.appendChild(icon(iconName, { size: size === 'sm' ? 15 : size === 'xs' ? 13 : 17 }));
  if (typeof onClick === 'function') btn.addEventListener('click', onClick);
  return btn;
}
