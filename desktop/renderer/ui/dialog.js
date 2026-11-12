/**
 * FCA Memory Atlas — 对话框 / 确认框
 */

import { el } from './dom.js';
import { icon } from './icons.js';
import { button, iconButton } from './button.js';

function overlayRoot() {
  return document.getElementById('overlay-root') || document.body;
}

const openDialogs = new Set();

function focusables(root) {
  return Array.from(
    root.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'),
  ).filter((node) => node.offsetParent !== null || node === document.activeElement);
}

/**
 * 打开一个对话框。
 * @param {object} options { title, subtitle, content:HTMLElement|fn, actions, width, dismissible, onClose, className, footerLeft }
 * @returns {{el:HTMLElement, backdrop:HTMLElement, close:Function, setBusy:Function, update:Function}}
 */
export function dialog(options = {}) {
  const {
    title = '',
    subtitle = '',
    content = null,
    actions = [],
    width = 520,
    dismissible = true,
    onClose,
    className = '',
    footerLeft = null,
    bodyClassName = '',
  } = options;

  const previousActive = document.activeElement;
  const backdrop = el('div', { class: 'overlay-backdrop' });
  const dlg = el('div', {
    class: `fca-dialog ${className}`.trim(),
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title || '对话框',
    tabindex: '-1',
    style: { width: typeof width === 'number' ? `${width}px` : String(width) },
  });

  const header = el('div', { class: 'fca-dialog__header' }, [
    el('div', { class: 'fca-grow' }, [
      title ? el('div', { class: 'fca-dialog__title', text: title }) : null,
      subtitle ? el('div', { class: 'fca-dialog__subtitle', text: subtitle }) : null,
    ]),
    dismissible ? iconButton({ icon: 'close', label: '关闭', size: 'sm', onClick: () => close('dismiss') }) : null,
  ]);

  const body = el('div', { class: `fca-dialog__body ${bodyClassName}`.trim() });
  if (content instanceof Node) body.appendChild(content);
  else if (typeof content === 'function') {
    const rendered = content();
    if (rendered instanceof Node) body.appendChild(rendered);
  }

  const footer = actions.length
    ? el('div', { class: 'fca-dialog__footer' }, [
        footerLeft || null,
        ...actions.map((action) => {
          const btn = button({
            label: action.label,
            variant: action.variant || 'secondary',
            icon: action.icon,
            size: action.size || 'md',
            disabled: action.disabled,
            title: action.title,
            onClick: async (event) => {
              if (!action.onClick) {
                close('action');
                return;
              }
              let result;
              try {
                result = action.onClick(close, btn, event);
              } catch (error) {
                console.error('[fca-dialog] action error', error);
                return;
              }
              if (result && typeof result.then === 'function') {
                try {
                  await result;
                } catch (error) {
                  console.error('[fca-dialog] async action error', error);
                  return;
                }
              }
              if (action.closeOnClick !== false && result !== false) close('action');
            },
          });
          return btn;
        }),
      ])
    : null;

  dlg.appendChild(header);
  dlg.appendChild(body);
  if (footer) dlg.appendChild(footer);
  overlayRoot().appendChild(backdrop);
  overlayRoot().appendChild(dlg);
  openDialogs.add(dlg);

  let closed = false;
  function close(reason = 'close') {
    if (closed) return;
    closed = true;
    openDialogs.delete(dlg);
    document.removeEventListener('keydown', onKeydown, true);
    backdrop.remove();
    dlg.remove();
    if (previousActive && typeof previousActive.focus === 'function' && document.contains(previousActive)) {
      try {
        previousActive.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }
    if (typeof onClose === 'function') onClose(reason);
  }

  function onKeydown(event) {
    if (event.key === 'Escape' && dismissible) {
      event.stopPropagation();
      close('escape');
      return;
    }
    if (event.key === 'Tab') {
      const nodes = focusables(dlg);
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }
  document.addEventListener('keydown', onKeydown, true);
  if (dismissible) backdrop.addEventListener('click', () => close('backdrop'));

  requestAnimationFrame(() => {
    const autoFocus = dlg.querySelector('[autofocus]');
    const candidates = focusables(dlg);
    const primary = dlg.querySelector('.fca-dialog__footer .btn--primary');
    (autoFocus || primary || candidates[0] || dlg).focus({ preventScroll: true });
  });

  return {
    el: dlg,
    backdrop,
    body,
    footer,
    close,
    setBusy(busy) {
      dlg.classList.toggle('is-busy', Boolean(busy));
    },
    update(partial) {
      if (partial.title !== undefined) {
        const titleNode = dlg.querySelector('.fca-dialog__title');
        if (titleNode) titleNode.textContent = partial.title;
      }
    },
  };
}

/**
 * 确认框 → Promise<boolean>
 */
export function confirm(options = {}) {
  const { title = '请确认', message = '', detail = '', confirmLabel = '确认', cancelLabel = '取消', danger = false } = options;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const content = el('div', {}, [
      el('div', { style: { fontSize: '13px', lineHeight: '1.7', color: 'var(--fca-text-dim)' }, text: message }),
      detail ? el('div', { style: { marginTop: '8px', fontSize: '12px', lineHeight: '1.7', color: 'var(--fca-text-faint)' }, text: detail }) : null,
    ]);
    const d = dialog({
      title,
      content,
      width: 440,
      onClose: () => settle(false),
      actions: [
        {
          label: cancelLabel,
          variant: 'ghost',
          closeOnClick: false,
          onClick: () => {
            settle(false);
            d.close('cancel');
          },
        },
        {
          label: confirmLabel,
          variant: danger ? 'danger' : 'primary',
          closeOnClick: false,
          onClick: () => {
            settle(true);
            d.close('confirm');
          },
        },
      ],
    });
  });
}

/** 简单提示框 */
export function alertDialog(options = {}) {
  const { title = '提示', message = '', detail = '' } = options;
  return new Promise((resolve) => {
    const d = dialog({
      title,
      content: el('div', {}, [
        el('div', { style: { fontSize: '13px', lineHeight: '1.7', color: 'var(--fca-text-dim)' }, text: message }),
        detail ? el('pre', { style: { marginTop: '10px', whiteSpace: 'pre-wrap', fontSize: '11px', color: 'var(--fca-text-faint)' }, text: detail }) : null,
      ]),
      width: 480,
      onClose: () => resolve(undefined),
      actions: [{ label: '关闭', variant: 'secondary' }],
    });
    void d;
  });
}

/** 当前已打开的对话框数量（截图时等待用） */
export function dialogCount() {
  return openDialogs.size;
}
