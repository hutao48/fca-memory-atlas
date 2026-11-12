/**
 * FCA Memory Atlas — 撤销/重做命令栈
 * 契约：lib/contracts.md §2.4 ctx.commands
 *
 * 命令：{ id, label, do(), undo(), coalesceKey?, coalesceWindowMs? }
 *  - execute 时先执行 do()，成功才入栈
 *  - 同类命令（coalesceKey 相同且在时间窗内）合并为一步
 */

export function createCommandStack(options = {}) {
  const limit = options.limit || 100;
  const changeListeners = new Set();
  if (typeof options.onChange === 'function') changeListeners.add(options.onChange);
  const logger = options.logger || console;

  /** @type {Array<{id,label,coalesceKey,at,do,undo}>} */
  let undoStack = [];
  let redoStack = [];
  let busy = false;
  let lastExecutedAt = 0;

  function snapshot() {
    return {
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
      undoLabel: undoStack.length ? undoStack[undoStack.length - 1].label : null,
      redoLabel: redoStack.length ? redoStack[redoStack.length - 1].label : null,
      undoCount: undoStack.length,
      redoCount: redoStack.length,
      busy,
    };
  }

  function notify() {
    const snap = snapshot();
    for (const listener of Array.from(changeListeners)) {
      try {
        listener(snap);
      } catch (error) {
        logger.error?.('[fca-commands] onChange 异常', error);
      }
    }
  }

  async function execute(command) {
    if (!command || typeof command.do !== 'function') throw new Error('命令必须包含 do()');
    if (busy) {
      logger.warn?.('[fca-commands] 命令栈忙，忽略新命令');
      return false;
    }
    busy = true;
    try {
      await command.do();
      const now = Date.now();
      const coalesceKey = command.coalesceKey;
      const windowMs = command.coalesceWindowMs || 1200;
      const top = undoStack[undoStack.length - 1];
      if (coalesceKey && top && top.coalesceKey === coalesceKey && now - lastExecutedAt <= windowMs) {
        // 合并：保留最早的 undo（即原状态），最新执行状态已经生效
        top.at = now;
        if (command.undo) top.undo = command.undo;
        top.label = command.label || top.label;
      } else {
        undoStack.push({ ...command, at: now });
        if (undoStack.length > limit) undoStack.shift();
      }
      redoStack = [];
      lastExecutedAt = now;
      notify();
      return true;
    } catch (error) {
      logger.error?.('[fca-commands] 命令执行失败', error);
      throw error;
    } finally {
      busy = false;
      notify();
    }
  }

  async function undo() {
    if (busy) return false;
    const command = undoStack.pop();
    if (!command || typeof command.undo !== 'function') {
      if (command) redoStack.push(command);
      notify();
      return false;
    }
    busy = true;
    try {
      await command.undo();
      redoStack.push(command);
      notify();
      return true;
    } catch (error) {
      logger.error?.('[fca-commands] 撤销失败', error);
      undoStack.push(command);
      notify();
      return false;
    } finally {
      busy = false;
      notify();
    }
  }

  async function redo() {
    if (busy) return false;
    const command = redoStack.pop();
    if (!command || typeof command.do !== 'function') {
      if (command) undoStack.push(command);
      notify();
      return false;
    }
    busy = true;
    try {
      await command.do();
      undoStack.push(command);
      notify();
      return true;
    } catch (error) {
      logger.error?.('[fca-commands] 重做失败', error);
      redoStack.push(command);
      notify();
      return false;
    } finally {
      busy = false;
      notify();
    }
  }

  function clear() {
    undoStack = [];
    redoStack = [];
    notify();
  }

  return {
    execute,
    undo,
    redo,
    clear,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    getSnapshot: snapshot,
    onChange(handler) {
      if (typeof handler !== 'function') return () => {};
      changeListeners.add(handler);
      return () => changeListeners.delete(handler);
    },
  };
}
