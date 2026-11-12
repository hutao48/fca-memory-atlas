// FCA Local Runtime — 极简路由表（支持 :param、405 Allow、raw SSE、鉴权/DB 中间件开关）
export class Router {
  constructor() {
    /** @type {Array<object>} */
    this.routes = [];
  }

  add(method, pattern, handler, options = {}) {
    const segments = pattern
      .split('/')
      .filter((s) => s.length > 0)
      .map((segment) => (segment.startsWith(':') ? { type: 'param', name: segment.slice(1) } : { type: 'literal', value: segment }));
    this.routes.push({
      method: String(method).toUpperCase(),
      pattern,
      segments,
      handler,
      raw: Boolean(options.raw),
      auth: options.auth !== false,
      requiresDb: options.requiresDb !== false,
      allowQueryToken: Boolean(options.allowQueryToken),
      description: options.description ?? '',
    });
    return this;
  }

  get(...args) {
    return this.add('GET', ...args);
  }

  post(...args) {
    return this.add('POST', ...args);
  }

  patch(...args) {
    return this.add('PATCH', ...args);
  }

  delete(...args) {
    return this.add('DELETE', ...args);
  }

  /**
   * @param {string} method
   * @param {string} pathname 已解码的路径
   * @returns {{route?:object, params?:object, methodNotAllowed?:true, allowed?:string[]}|null}
   */
  match(method, pathname) {
    const wanted = String(method).toUpperCase() === 'HEAD' ? 'GET' : String(method).toUpperCase();
    const parts = pathname.split('/').filter((s) => s.length > 0);
    let found = null;
    const allowed = new Set();
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const segment = route.segments[i];
        if (segment.type === 'literal') {
          if (segment.value !== parts[i]) {
            ok = false;
            break;
          }
        } else {
          params[segment.name] = parts[i];
        }
      }
      if (!ok) continue;
      if (route.method === wanted) {
        found = { route, params };
        break;
      }
      allowed.add(route.method);
    }
    if (found) return found;
    if (allowed.size > 0) return { methodNotAllowed: true, allowed: [...allowed].sort() };
    return null;
  }

  /** 已注册端点清单（用于 docs/RUNTIME_API 导出与自检）。 */
  list() {
    return this.routes.map((route) => ({
      method: route.method,
      path: route.pattern,
      auth: route.auth,
      requires_db: route.requiresDb,
      raw: route.raw,
      description: route.description,
    }));
  }
}
