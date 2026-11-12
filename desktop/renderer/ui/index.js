/**
 * FCA Memory Atlas — UI 组件库统一出口
 * 契约：renderer/lib/contracts.md §6
 */

import * as DOM from './dom.js';
import * as Icons from './icons.js';
import * as Buttons from './button.js';
import * as Inputs from './input.js';
import * as Tags from './tag.js';
import * as Dialogs from './dialog.js';
import * as Toasts from './toast.js';
import * as Menus from './context-menu.js';
import * as VirtualList from './virtual-list.js';
import * as Misc from './misc.js';

export const ui = {
  // DOM
  el: DOM.el,
  svgEl: DOM.svgEl,
  frag: DOM.frag,
  clear: DOM.clear,
  mount: DOM.mount,
  on: DOM.on,
  nextFrame: DOM.nextFrame,
  twoFrames: DOM.twoFrames,
  outsideClick: DOM.onOutsideClick,
  debounce: DOM.debounce,
  rafThrottle: DOM.rafThrottle,
  // 图标
  icon: Icons.icon,
  iconNames: Icons.iconNames,
  // 按钮
  button: Buttons.button,
  iconButton: Buttons.iconButton,
  // 表单
  input: Inputs.input,
  textarea: Inputs.textarea,
  select: Inputs.select,
  checkbox: Inputs.checkbox,
  switch: Inputs.switchControl,
  numberInput: Inputs.numberInput,
  formField: Inputs.formField,
  // 标签
  tag: Tags.tag,
  badge: Tags.badge,
  kbd: Tags.kbd,
  statusDot: Tags.statusDot,
  // 弹层
  dialog: Dialogs.dialog,
  confirm: Dialogs.confirm,
  alert: Dialogs.alertDialog,
  dialogCount: Dialogs.dialogCount,
  toast: Toasts.toast,
  clearToasts: Toasts.clearToasts,
  contextMenu: Menus.contextMenu,
  dropdown: Menus.dropdown,
  closeAnyMenu: Menus.closeAnyMenu,
  // 列表
  virtualList: VirtualList.virtualList,
  // 其它
  section: Misc.section,
  emptyState: Misc.emptyState,
  spinner: Misc.spinner,
  progress: Misc.progress,
  tabs: Misc.tabs,
  tooltip: Misc.tooltip,
  divider: Misc.divider,
};

export default ui;
