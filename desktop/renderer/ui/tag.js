/**
 * FCA Memory Atlas — 标签 / 徽章 / 键盘提示
 */

import { el } from './dom.js';
import { icon } from './icons.js';

const TONES = new Set(['neutral', 'cyan', 'blue', 'violet', 'magenta', 'rose', 'gold', 'green']);

export function tag(options = {}) {
  const { label, tone = 'neutral', icon: iconName, onRemove, onClick, active = false, title } = options;
  const classes = ['fca-tag', `fca-tag--${TONES.has(tone) ? tone : 'neutral'}`];
  if (active) classes.push('fca-tag--active');
  if (onClick) classes.push('fca-tag--clickable');
  const node = el('span', { class: classes.join(' '), title: title || (typeof label === 'string' ? label : undefined) }, [
    iconName ? icon(iconName, { size: 12 }) : null,
    el('span', { class: 'fca-tag__label fca-truncate', text: label }),
  ]);
  if (onClick) node.addEventListener('click', onClick);
  if (onRemove) {
    const removeBtn = el('button', { class: 'fca-tag__remove', type: 'button', title: '移除', 'aria-label': '移除标签' }, [icon('close', { size: 10 })]);
    removeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      onRemove(event);
    });
    node.appendChild(removeBtn);
  }
  return node;
}

export function badge(options = {}) {
  const { label, tone = 'neutral', icon: iconName } = options;
  const toneClass = tone === 'accent' ? 'fca-badge--accent' : tone === 'gold' ? 'fca-badge--gold' : tone === 'danger' ? 'fca-badge--danger' : tone === 'green' ? 'fca-badge--green' : '';
  return el('span', { class: `fca-badge ${toneClass}`.trim() }, [iconName ? icon(iconName, { size: 11 }) : null, label ? el('span', { text: label }) : null]);
}

export function kbd(keys) {
  return el('span', { class: 'fca-kbd', text: keys });
}

export function statusDot(state) {
  const node = el('span', { class: 'status-dot' });
  node.dataset.state = state || 'stopped';
  return node;
}
