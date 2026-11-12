/**
 * FCA Memory Atlas — 虚拟列表（固定行高）
 * 用于记忆列表等大列表渲染；只挂载可视区附近的行。
 */

import { el, rafThrottle } from './dom.js';

/**
 * @param {object} options
 * @param {Array} options.items
 * @param {number} [options.itemHeight]
 * @param {number} [options.overscan]
 * @param {(item:any,index:number)=>HTMLElement} options.renderItem
 * @param {(item:any,index:number)=>void} [options.onSelect]
 * @param {number} [options.selectedIndex]
 * @param {string} [options.emptyText]
 * @returns {{el:HTMLElement,setItems:Function,scrollToIndex:Function,destroy:Function,getSelectedIndex:Function}}
 */
export function virtualList(options = {}) {
  const {
    items = [],
    itemHeight = 48,
    overscan = 6,
    renderItem,
    onSelect,
    selectedIndex = -1,
    emptyText = '暂无内容',
  } = options;

  const root = el('div', { class: 'fca-vlist', tabindex: '0' });
  const spacer = el('div', { class: 'fca-vlist__spacer' });
  root.appendChild(spacer);
  const emptyNode = el('div', { class: 'fca-empty' }, [el('div', { class: 'fca-empty__desc', text: emptyText })]);
  emptyNode.style.display = 'none';
  root.appendChild(emptyNode);

  let stateItems = Array.isArray(items) ? items : [];
  let selected = Number.isInteger(selectedIndex) ? selectedIndex : -1;
  /** @type {Map<number, HTMLElement>} */
  const rendered = new Map();
  let destroyed = false;
  let rowNodes = [];

  function updateSelected() {
    for (const [index, node] of rendered) {
      node.classList.toggle('is-selected', index === selected);
    }
  }

  function renderItemAt(index, rowNode) {
    while (rowNode.firstChild) rowNode.removeChild(rowNode.firstChild);
    const item = stateItems[index];
    let content = null;
    try {
      content = renderItem(item, index);
    } catch (error) {
      content = el('div', { class: 'fca-empty__desc', text: `渲染失败：${error.message}` });
    }
    if (content instanceof Node) rowNode.appendChild(content);
    rowNode.dataset.index = String(index);
    rowNode.classList.toggle('is-selected', index === selected);
  }

  function render() {
    if (destroyed) return;
    const total = stateItems.length;
    spacer.style.height = `${total * itemHeight}px`;
    const empty = total === 0;
    emptyNode.style.display = empty ? '' : 'none';
    if (empty) {
      for (const node of rendered.values()) node.remove();
      rendered.clear();
      return;
    }
    const scrollTop = root.scrollTop;
    const viewport = root.clientHeight || 400;
    const start = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
    const end = Math.min(total, Math.ceil((scrollTop + viewport) / itemHeight) + overscan);
    for (const [index, node] of Array.from(rendered.entries())) {
      if (index < start || index >= end) {
        node.remove();
        rendered.delete(index);
      }
    }
    for (let index = start; index < end; index += 1) {
      let node = rendered.get(index);
      if (!node) {
        node = el('div', { class: 'fca-vlist__row', 'data-index': String(index) });
        node.style.top = `${index * itemHeight}px`;
        node.style.height = `${itemHeight}px`;
        node.addEventListener('click', () => {
          selected = index;
          updateSelected();
          if (typeof onSelect === 'function') onSelect(stateItems[index], index);
        });
        spacer.appendChild(node);
        rendered.set(index, node);
        renderItemAt(index, node);
      }
      rowNodes[index] = node;
    }
  }

  const onScroll = rafThrottle(render);
  const onResize = rafThrottle(render);
  root.addEventListener('scroll', onScroll, { passive: true });
  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
  if (resizeObserver) resizeObserver.observe(root);

  function setItems(nextItems, nextSelected) {
    stateItems = Array.isArray(nextItems) ? nextItems : [];
    if (Number.isInteger(nextSelected)) selected = nextSelected;
    for (const node of rendered.values()) node.remove();
    rendered.clear();
    rowNodes = [];
    root.scrollTop = 0;
    render();
  }

  function scrollToIndex(index) {
    const target = Math.max(0, Math.min(stateItems.length - 1, index));
    root.scrollTop = target * itemHeight - root.clientHeight / 2 + itemHeight / 2;
    render();
  }

  function destroy() {
    destroyed = true;
    root.removeEventListener('scroll', onScroll);
    if (resizeObserver) resizeObserver.disconnect();
    root.remove();
  }

  // 首次渲染放到下一帧，确保 clientHeight 已有值
  requestAnimationFrame(render);
  render();

  return {
    el: root,
    setItems,
    scrollToIndex,
    destroy,
    getSelectedIndex: () => selected,
    refresh: render,
    getItems: () => stateItems,
  };
}
