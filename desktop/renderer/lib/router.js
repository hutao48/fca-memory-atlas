/**
 * FCA Memory Atlas — 视图路由
 *
 * 契约：lib/contracts.md §2
 *  - 路由 id ↔ desktop/renderer/views/<id>.js
 *  - hash 规范：#view=<id>&<params>，兼容 #<id>
 *  - 视图模块缺失 → 占位骨架；模块加载/挂载异常 → 错误边界
 */

import { el, clear } from './ui.js';

/**
 * 内置路由表。Editor 任务组只需创建对应文件，无需注册。
 * importer 使用动态 import，文件不存在时 catch → 占位骨架。
 */
export const ROUTE_DEFS = [
  { id: 'atlas', title: '星云总览', icon: 'compass', order: 10, group: 'main', importer: () => import('../views/atlas.js'), ownedBy: 'shell' },
  { id: 'timeline', title: '时间线', icon: 'clock', order: 20, group: 'main', file: 'views/timeline.js', importer: () => import('../views/timeline.js'), ownedBy: 'editor' },
  { id: 'relations', title: '关系探索', icon: 'relation', order: 30, group: 'main', file: 'views/relations.js', importer: () => import('../views/relations.js'), ownedBy: 'editor' },
  { id: 'list', title: '记忆列表', icon: 'list', order: 40, group: 'main', file: 'views/list.js', importer: () => import('../views/list.js'), ownedBy: 'editor' },
  { id: 'search', title: '高级搜索', icon: 'search', order: 50, group: 'tools', file: 'views/search.js', importer: () => import('../views/search.js'), ownedBy: 'editor' },
  { id: 'editor', title: '记忆编辑器', icon: 'edit', order: 60, group: 'tools', file: 'views/editor.js', importer: () => import('../views/editor.js'), ownedBy: 'editor', nav: false },
  { id: 'data', title: '数据管理', icon: 'database', order: 70, group: 'tools', file: 'views/data.js', importer: () => import('../views/data.js'), ownedBy: 'editor' },
  { id: 'settings', title: '设置', icon: 'settings', order: 80, group: 'system', file: 'views/settings.js', importer: () => import('../views/settings.js'), ownedBy: 'editor' },
  { id: 'onboarding', title: '首次启动向导', icon: 'sparkles', order: 90, group: 'system', file: 'views/onboarding.js', importer: () => import('../views/onboarding.js'), ownedBy: 'editor', nav: false },
];

const ROUTE_MAP = new Map(ROUTE_DEFS.map((def) => [def.id, def]));

export function getRouteDefs() {
  return ROUTE_DEFS.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
}

export function getRouteDef(id) {
  return ROUTE_MAP.get(id) || null;
}

/** 解析 location.hash → {id, params} */
export function parseHash(hash = window.location.hash) {
  const raw = String(hash || '').replace(/^#/, '').trim();
  if (!raw) return null;
  if (raw.includes('=')) {
    const params = new URLSearchParams(raw);
    const view = params.get('view') || params.get('v');
    if (!view) return null;
    const rest = new URLSearchParams();
    for (const [key, value] of params.entries()) {
      if (key !== 'view' && key !== 'v') rest.append(key, value);
    }
    return { id: view, params: rest };
  }
  const [id, queryString] = raw.split('?');
  return { id: id, params: new URLSearchParams(queryString || '') };
}

export function buildHash(id, params) {
  const search = new URLSearchParams();
  search.set('view', id);
  if (params) {
    if (typeof params === 'string') {
      const extra = new URLSearchParams(params);
      for (const [key, value] of extra.entries()) search.set(key, value);
    } else if (params instanceof URLSearchParams) {
      for (const [key, value] of params.entries()) search.set(key, value);
    } else if (typeof params === 'object') {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
      }
    }
  }
  return `#${search.toString()}`;
}

/**
 * @param {object} options
 * @param {HTMLElement} options.host 视图挂载容器（#view-host）
 * @param {object} options.ctx 视图上下文（api/store/... 由 app.js 注入；router 字段会被覆盖）
 * @param {(info:{id:string,def:object,error?:Error})=>object} options.createPlaceholder
 * @param {(info:{from:string|null,to:string,params:URLSearchParams})=>void} [options.onRouteChange]
 * @param {object} [options.logger]
 */
export function createRouter(options) {
  const host = options.host;
  const ctx = options.ctx;
  const createPlaceholder = options.createPlaceholder;
  const onRouteChange = options.onRouteChange;
  const logger = options.logger || console;
  const listeners = new Set();

  let current = null; // { id, def, module, instance, el, params }

  const router = {
    get current() {
      return current ? current.id : null;
    },
    get params() {
      return current ? current.params : new URLSearchParams();
    },
    get instance() {
      return current ? current.instance : null;
    },
    getRouteDefs,

    navigate(id, params, options2 = {}) {
      const def = ROUTE_MAP.get(id);
      if (!def) {
        logger.warn?.(`[fca-router] 未知视图：${id}`);
        return false;
      }
      const hash = buildHash(id, params);
      if (options2.replace) window.history.replaceState(null, '', hash);
      else window.location.hash = hash;
      if (parseHash(hash) && current && current.id === id && options2.soft !== false) {
        // 同视图参数变化：软更新，避免重建（如 atlas 模式切换）
        handleSameViewParams(id, parseHash(hash).params);
      }
      return true;
    },

    /** 直接加载（初始化用，不触发 hashchange 重复处理） */
    async mount(id, params) {
      return load(id, params);
    },

    onRouteChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    refresh() {
      if (current) return load(current.id, current.params, { force: true });
      return Promise.resolve(false);
    },

    routeInfo() {
      if (!current) return null;
      return { id: current.id, params: current.params, def: current.def };
    },
  };

  function handleSameViewParams(id, params) {
    if (!current || current.id !== id) return;
    current.params = params;
    try {
      if (current.instance && typeof current.instance.handleCommand === 'function') {
        current.instance.handleCommand('route:params', params);
      }
    } catch (error) {
      logger.error?.('[fca-router] route:params 处理异常', error);
    }
    emitRouteChange(current.id, params);
  }

  function emitRouteChange(id, params) {
    const info = { from: current && current.id !== id ? current.id : null, to: id, params };
    for (const cb of Array.from(listeners)) {
      try {
        cb(info);
      } catch (error) {
        logger.error?.('[fca-router] onRouteChange 异常', error);
      }
    }
    if (typeof onRouteChange === 'function') {
      try {
        onRouteChange(info);
      } catch (error) {
        logger.error?.('[fca-router] onRouteChange 异常', error);
      }
    }
  }

  function normalizeParams(params) {
    if (!params) return new URLSearchParams();
    if (params instanceof URLSearchParams) return params;
    if (typeof params === 'string') return new URLSearchParams(params);
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
    }
    return search;
  }

  async function optionalLifecycle(instance, name, ...args) {
    if (!instance || typeof instance[name] !== 'function') return;
    try {
      await instance[name](...args);
    } catch (error) {
      logger.error?.(`[fca-router] 视图 ${name}() 异常`, error);
    }
  }

  async function load(id, params, loadOptions = {}) {
    const def = ROUTE_MAP.get(id) || ROUTE_DEFS[0];
    const normalized = normalizeParams(params);
    if (current) {
      if (!loadOptions.force && current.id === def.id) {
        handleSameViewParams(def.id, normalized);
        return true;
      }
      await unmountCurrent();
    }

    const fromId = current ? current.id : null;
    const viewEl = el('div', { class: `view-root view-${def.id}` });
    viewEl.dataset.view = def.id;
    host.appendChild(viewEl);

    let module = null;
    let instance = null;
    let error = null;
    try {
      module = await def.importer();
    } catch (importError) {
      error = importError;
      if (logger && logger.info) logger.info(`[fca-router] 视图模块不存在，渲染占位骨架：${def.id}`, { message: importError.message });
    }

    if (module && !error) {
      try {
        const factory = module.createView || (typeof module.default === 'function' ? module.default : module.default && module.default.createView);
        if (typeof factory !== 'function') error = new Error(`视图模块 ${def.file || def.id} 未导出 createView(ctx)`);
        else instance = factory(ctx);
      } catch (factoryError) {
        error = factoryError;
      }
    }

    if (instance) {
      try {
        await instance.mount(viewEl);
      } catch (mountError) {
        error = mountError;
        logger.error?.(`[fca-router] 视图挂载异常：${def.id}`, mountError);
      }
    }

    if (error || !instance) {
      try {
        const placeholder = createPlaceholder({ id: def.id, def, error });
        if (placeholder && typeof placeholder.mount === 'function') placeholder.mount(viewEl);
        instance = placeholder;
      } catch (placeholderError) {
        logger.error?.('[fca-router] 占位骨架渲染失败', placeholderError);
        clear(viewEl);
        viewEl.appendChild(
          el('div', { class: 'placeholder-view' }, [
            el('div', { class: 'placeholder-error', text: `视图 ${def.id} 不可用：${error ? error.message : '未知错误'}` }),
          ]),
        );
      }
    }

    current = { id: def.id, def, module, instance, el: viewEl, params: normalized };
    await optionalLifecycle(instance, 'activate');
    emitRouteChange(def.id, normalized);
    return true;
  }

  async function unmountCurrent() {
    if (!current) return;
    const target = current;
    current = null;
    await optionalLifecycle(target.instance, 'deactivate');
    await optionalLifecycle(target.instance, 'unmount');
    try {
      target.el.remove();
    } catch {
      /* ignore */
    }
  }

  async function handleHashChange() {
    const parsed = parseHash();
    if (!parsed) {
      if (!current) await load('atlas', new URLSearchParams());
      return;
    }
    if (current && current.id === parsed.id) {
      handleSameViewParams(parsed.id, parsed.params);
      return;
    }
    await load(parsed.id, parsed.params);
  }

  window.addEventListener('hashchange', handleHashChange);

  return {
    router,
    handleHashChange,
    initialRoute() {
      const parsed = parseHash();
      if (parsed) return { id: parsed.id, params: parsed.params };
      return { id: 'atlas', params: new URLSearchParams() };
    },
    destroy() {
      window.removeEventListener('hashchange', handleHashChange);
      unmountCurrent();
    },
  };
}
