/**
 * FCA Memory Atlas — 轻量事件总线
 * 契约见 lib/contracts.md §5：on / off / once / emit / onAny。
 * 单个监听器抛错不会影响其它监听器。
 */

export function createEmitter(options = {}) {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  /** @type {Set<Function>} */
  const anyListeners = new Set();
  const onError = typeof options.onError === 'function' ? options.onError : null;
  let emitted = 0;

  function safeCall(handler, payload, eventName) {
    try {
      handler(payload, eventName);
    } catch (error) {
      if (onError) {
        try {
          onError(error, eventName);
        } catch {
          /* ignore */
        }
      } else {
        // eslint-disable-next-line no-console
        console.error(`[fca-events] listener error on "${eventName}":`, error);
      }
    }
  }

  return {
    on(eventName, handler) {
      if (typeof handler !== 'function') return () => {};
      if (!listeners.has(eventName)) listeners.set(eventName, new Set());
      listeners.get(eventName).add(handler);
      return () => this.off(eventName, handler);
    },

    once(eventName, handler) {
      if (typeof handler !== 'function') return () => {};
      const wrapper = (payload) => {
        this.off(eventName, wrapper);
        safeCall(handler, payload, eventName);
      };
      return this.on(eventName, wrapper);
    },

    off(eventName, handler) {
      const set = listeners.get(eventName);
      if (!set) return;
      if (handler) set.delete(handler);
      else set.clear();
      if (set.size === 0) listeners.delete(eventName);
    },

    onAny(handler) {
      if (typeof handler !== 'function') return () => {};
      anyListeners.add(handler);
      return () => anyListeners.delete(handler);
    },

    emit(eventName, payload) {
      emitted += 1;
      const set = listeners.get(eventName);
      if (set) {
        for (const handler of Array.from(set)) safeCall(handler, payload, eventName);
      }
      for (const handler of Array.from(anyListeners)) safeCall(handler, payload, eventName);
      return emitted;
    },

    listenerCount(eventName) {
      return (listeners.get(eventName) || { size: 0 }).size;
    },

    clear() {
      listeners.clear();
      anyListeners.clear();
    },
  };
}

/** 全局单例（app.js 注入 ctx.events；调试句柄也引用它） */
export const bus = createEmitter({
  onError(error, eventName) {
    // eslint-disable-next-line no-console
    console.error(`[fca-events] handler error on "${eventName}"`, error);
  },
});
