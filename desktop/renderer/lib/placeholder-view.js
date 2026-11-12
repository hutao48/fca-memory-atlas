/**
 * FCA Memory Atlas — 视图占位骨架
 * Editor 任务组的视图文件缺失/加载失败时由 router 调用。
 * 明确标注“Alpha 0.1 未实现（Editor 任务组）”，不做任何伪造功能。
 */

import { ui } from './ui.js';
import { icon } from '../ui/icons.js';

const el = ui.el;

const OWNER_LABEL = {
  editor: 'Desktop Editor 任务组',
  shell: 'Desktop Shell 任务组',
};

const EXPECTED_EXPORTS = `export const meta = { id, title, icon, order };
export function createView(ctx) {
  return {
    mount(container) {},     // 必填
    unmount() {},            // 必填
    activate() {}, deactivate() {},
    handleCommand(command, payload) {},
    resize(width, height) {},
  };
}`;

/**
 * @param {object} info {id, def, error?}
 * @returns {{mount:Function, unmount:Function}}
 */
export function createPlaceholder(info) {
  const { id, def, error } = info || {};
  let root = null;
  return {
    mount(container) {
      root = el('div', { class: 'placeholder-view' });
      const filePath = (def && def.file) || `views/${id}.js`;
      const owner = (def && OWNER_LABEL[def.ownedBy]) || 'Desktop Editor 任务组';
      const isError = Boolean(error);
      root.appendChild(
        el('div', { class: 'placeholder-view__head' }, [
          el('div', { class: 'placeholder-view__icon' }, [icon((def && def.icon) || 'sparkles', { size: 20 })]),
          el('div', { class: 'fca-grow' }, [
            el('div', { class: 'placeholder-view__title', text: (def && def.title) || id || '视图' }),
            el('div', { class: 'placeholder-view__desc', text: `${isError ? '视图加载失败' : '该视图尚未实现'} — 由 ${owner} 负责` }),
          ]),
          el('div', { class: 'placeholder-view__badge' }, [
            el('span', { class: isError ? 'fca-badge fca-badge--danger' : 'fca-badge fca-badge--accent', text: isError ? '加载失败' : 'Alpha 0.1 未实现' }),
          ]),
        ]),
      );

      if (isError) {
        root.appendChild(
          el('div', { class: 'placeholder-error' }, [
            el('div', { text: `视图模块加载/挂载失败：${error.message}` }),
            error.stack ? el('pre', { text: String(error.stack).slice(0, 2400) }) : null,
          ]),
        );
      }

      root.appendChild(
        el('div', { class: 'placeholder-view__grid' }, [
          el('div', { class: 'placeholder-card' }, [
            el('div', { class: 'placeholder-card__title' }, [icon('file', { size: 14 }), '预期文件']),
            el('div', { class: 'placeholder-card__body' }, [
              el('code', { text: `desktop/renderer/${filePath}` }),
              el('div', { style: { marginTop: '6px' }, text: '创建该文件并导出 createView(ctx) 后，刷新应用即可自动加载（无需注册）。' }),
            ]),
          ]),
          el('div', { class: 'placeholder-card' }, [
            el('div', { class: 'placeholder-card__title' }, [icon('terminal', { size: 14 }), '模块契约']),
            el('div', { class: 'placeholder-card__body' }, [
              el('div', { text: '完整契约见 ' }),
              el('code', { text: 'desktop/renderer/lib/contracts.md' }),
              el('div', { style: { marginTop: '6px' }, text: '必须实现 mount/unmount；可选用 activate/deactivate/handleCommand/resize/getSnapshot。' }),
            ]),
          ]),
          el('div', { class: 'placeholder-card' }, [
            el('div', { class: 'placeholder-card__title' }, [icon('activity', { size: 14 }), '当前数据状态']),
            el('div', { class: 'placeholder-card__body', text: '星云总览、详情面板、顶部搜索、状态栏、Runtime 连接均已可用。此视图可复用 ctx.api / ctx.store / ctx.ui / ctx.detail 读取真实数据。' }),
          ]),
        ]),
      );

      const preview = el('div', { class: 'placeholder-card' }, [
        el('div', { class: 'placeholder-card__title' }, [icon('code', { size: 14 }), '导出签名示例']),
        el('pre', {
          style: { margin: '0', overflowX: 'auto', fontFamily: 'var(--fca-font-mono)', fontSize: '11px', lineHeight: '1.65', color: 'var(--fca-text-faint)', userSelect: 'text' },
          text: EXPECTED_EXPORTS,
        }),
      ]);
      root.appendChild(preview);
      container.appendChild(root);
    },
    unmount() {
      if (root) root.remove();
      root = null;
    },
  };
}
