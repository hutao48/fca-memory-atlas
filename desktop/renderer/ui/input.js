/**
 * FCA Memory Atlas — 表单控件
 */

import { el } from './dom.js';
import { icon } from './icons.js';

export function input(options = {}) {
  const { value = '', placeholder = '', type = 'text', icon: iconName, ariaLabel, disabled = false, id, onInput, onChange, onKeydown, className = '', spellcheck = false } = options;
  const node = el('input', {
    class: `fca-input${className ? ` ${className}` : ''}`,
    type,
    placeholder,
    value,
    disabled,
    spellcheck,
    autocomplete: 'off',
    'aria-label': ariaLabel || placeholder || undefined,
    id,
  });
  if (onInput) node.addEventListener('input', onInput);
  if (onChange) node.addEventListener('change', onChange);
  if (onKeydown) node.addEventListener('keydown', onKeydown);
  node.getValue = () => node.value;
  node.setValue = (v) => {
    node.value = v == null ? '' : String(v);
  };
  if (!iconName) return node;
  return el('div', { class: 'fca-input-wrap' }, [el('span', { class: 'fca-input-wrap__icon' }, [icon(iconName, { size: 15 })]), node]);
}

export function textarea(options = {}) {
  const { value = '', placeholder = '', rows = 5, onInput, onChange, ariaLabel, className = '' } = options;
  const node = el('textarea', {
    class: `fca-textarea${className ? ` ${className}` : ''}`,
    rows,
    placeholder,
    spellcheck: false,
    'aria-label': ariaLabel || placeholder || undefined,
  });
  node.value = value;
  if (onInput) node.addEventListener('input', onInput);
  if (onChange) node.addEventListener('change', onChange);
  node.getValue = () => node.value;
  node.setValue = (v) => {
    node.value = v == null ? '' : String(v);
  };
  return node;
}

export function select(options = {}) {
  const { options: items = [], value, onChange, ariaLabel, className = '', size = 'md' } = options;
  const node = el('select', {
    class: size === 'mini' ? 'mini-select' : `fca-select${className ? ` ${className}` : ''}`,
    'aria-label': ariaLabel,
  });
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = item.value;
    opt.textContent = item.label;
    if (item.disabled) opt.disabled = true;
    node.appendChild(opt);
  }
  if (value !== undefined && value !== null) node.value = String(value);
  if (onChange) node.addEventListener('change', () => onChange(node.value, node));
  node.getValue = () => node.value;
  node.setOptions = (nextItems, nextValue) => {
    while (node.firstChild) node.removeChild(node.firstChild);
    for (const item of nextItems) {
      const opt = document.createElement('option');
      opt.value = item.value;
      opt.textContent = item.label;
      if (item.disabled) opt.disabled = true;
      node.appendChild(opt);
    }
    if (nextValue !== undefined) node.value = String(nextValue);
  };
  node.setValue = (v) => {
    node.value = v == null ? '' : String(v);
  };
  return node;
}

export function checkbox(options = {}) {
  const { label = '', checked = false, onChange, disabled = false } = options;
  const id = `fca-cb-${Math.random().toString(36).slice(2, 9)}`;
  const box = el('input', { type: 'checkbox', id, disabled });
  box.checked = Boolean(checked);
  if (onChange) {
    box.addEventListener('change', () => onChange(box.checked));
  }
  const wrapper = el('label', { class: 'fca-checkbox', for: id }, [box, el('span', { text: label })]);
  wrapper.input = box;
  wrapper.setChecked = (v) => {
    box.checked = Boolean(v);
  };
  return wrapper;
}

export function switchControl(options = {}) {
  const { label = '', checked = false, onChange, disabled = false, hint } = options;
  const id = `fca-sw-${Math.random().toString(36).slice(2, 9)}`;
  const box = el('input', { type: 'checkbox', id, disabled });
  box.checked = Boolean(checked);
  if (onChange) box.addEventListener('change', () => onChange(box.checked));
  const track = el('span', { class: 'fca-switch__track' }, [el('span', { class: 'fca-switch__thumb' })]);
  const wrapper = el('label', { class: 'fca-switch', for: id }, [
    el('span', { class: 'fca-grow' }, [el('span', { text: label }), hint ? el('div', { class: 'fca-form-field__hint', text: hint }) : null]),
    box,
    track,
  ]);
  wrapper.input = box;
  wrapper.setChecked = (v) => {
    box.checked = Boolean(v);
  };
  return wrapper;
}

export function numberInput(options = {}) {
  const { value = 0, min, max, step = 1, onChange, ariaLabel, width = '110px' } = options;
  const node = el('input', {
    class: 'fca-input',
    type: 'number',
    value: String(value),
    min,
    max,
    step,
    style: { width },
    'aria-label': ariaLabel,
  });
  if (onChange) {
    node.addEventListener('change', () => {
      const n = Number(node.value);
      onChange(Number.isFinite(n) ? n : null, node);
    });
  }
  node.getValue = () => Number(node.value);
  return node;
}

/** 一行标签 + 控件 + 提示的设置行 */
export function formField(options = {}) {
  const { label, hint, control, error } = options;
  return el('div', { class: 'fca-form-field' }, [
    label ? el('label', { class: 'fca-form-field__label', text: label }) : null,
    control,
    hint ? el('div', { class: 'fca-form-field__hint', text: hint }) : null,
    error ? el('div', { class: 'fca-form-field__error', text: error }) : null,
  ]);
}
