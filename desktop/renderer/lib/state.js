/**
 * FCA Memory Atlas — 应用状态仓库
 *
 * 契约见 lib/contracts.md §3：
 *  - getState / patch / setState / subscribe / select / selectObj / batch / registerActions / dispatch / resetTo
 *  - patch 支持“顶层浅合并 + 一层嵌套合并”，避免局部 patch 覆盖整个嵌套对象
 *  - 不冻结状态，但调用方必须视为只读
 */

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof Set) && !(value instanceof Map);
}

function mergePatch(base, patch) {
  if (!isPlainObject(patch)) return patch;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = { ...out[key], ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

export function createStore(initialState) {
  let state = initialState;
  const subscribers = new Set();
  /** @type {Map<Symbol, {selector:Function, listener:Function, compare:Function, last:any}>} */
  const selectors = new Map();
  const actionRegistry = new Map();
  let batchDepth = 0;
  let pendingNotify = false;
  let notifyScheduled = false;

  function notify(prevState) {
    if (batchDepth > 0) {
      pendingNotify = true;
      return;
    }
    // 选择器订阅
    for (const [id, entry] of selectors) {
      let nextValue;
      try {
        nextValue = entry.selector(state);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[fca-store] selector error', error);
        selectors.delete(id);
        continue;
      }
      if (!entry.compare(entry.last, nextValue)) {
        entry.last = nextValue;
        try {
          entry.listener(nextValue, entry.previous);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error('[fca-store] selector listener error', error);
        }
        entry.previous = nextValue;
      }
    }
    // 全量订阅
    for (const listener of Array.from(subscribers)) {
      try {
        listener(state, prevState);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[fca-store] subscriber error', error);
      }
    }
  }

  function scheduleNotify(prevState) {
    if (notifyScheduled) return;
    notifyScheduled = true;
    queueMicrotask(() => {
      notifyScheduled = false;
      const prev = pendingPrevState;
      pendingPrevState = null;
      notify(prev);
    });
    pendingPrevState = pendingPrevState || prevState;
  }

  let pendingPrevState = null;

  function commit(nextState, prevState, options = {}) {
    state = nextState;
    if (options.silent) return state;
    if (batchDepth > 0) {
      pendingNotify = true;
      return state;
    }
    notify(prevState);
    return state;
  }

  return {
    getState() {
      return state;
    },

    setState(nextState, options) {
      const prev = state;
      return commit(nextState, prev, options);
    },

    patch(partial, options = {}) {
      const prev = state;
      const next = mergePatch(state, partial);
      state = next;
      if (options.debounce === true) scheduleNotify(prev);
      else commit(next, prev, options);
      return next;
    },

    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },

    select(selector, listener, compare = Object.is) {
      if (typeof selector !== 'function' || typeof listener !== 'function') return () => {};
      const id = Symbol('selector');
      let initial;
      try {
        initial = selector(state);
      } catch {
        initial = undefined;
      }
      selectors.set(id, { selector, listener, compare, last: initial, previous: undefined });
      return () => selectors.delete(id);
    },

    selectObj(selector, listener) {
      return this.select(selector, listener, shallowEqual);
    },

    batch(fn) {
      batchDepth += 1;
      try {
        return fn();
      } finally {
        batchDepth -= 1;
        if (batchDepth === 0 && pendingNotify) {
          pendingNotify = false;
          notify(state);
        }
      }
    },

    registerActions(actionMap) {
      for (const [name, handler] of Object.entries(actionMap || {})) actionRegistry.set(name, handler);
      return this;
    },

    dispatch(actionName, payload) {
      const handler = actionRegistry.get(actionName);
      if (!handler) {
        // eslint-disable-next-line no-console
        console.warn(`[fca-store] 未注册的 action：${actionName}`);
        return undefined;
      }
      return handler(payload, this);
    },

    resetTo(partial) {
      const base = isPlainObject(initialState) ? initialState : {};
      const next = mergePatch(base, partial || {});
      const prev = state;
      return commit(next, prev);
    },

    /** 订阅者/选择器数量（调试用） */
    stats() {
      return { subscribers: subscribers.size, selectors: selectors.size, actions: actionRegistry.size };
    },
  };
}

export { shallowEqual, mergePatch };
