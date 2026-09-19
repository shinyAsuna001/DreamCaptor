/**
 * router.js —— History API 路由（零依赖）
 *
 * 路由表：{ pattern: /^\/wiki\/(?<page>levels)$/, view, title }
 * 匹配到的命名捕获会作为 params 传给 view。
 * 视图返回一个 cleanup 函数（可选），路由切换时调用。
 */

const routes = [];
let currentCleanup = null;
let onNavigate = () => {};

function compile(path) {
  // '/wiki/:page' → /^\/wiki\/(?<page>[^/]+)$/
  const names = [];
  const source = path
    .replace(/\/$/, '')
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        names.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { re: new RegExp(`^${source || ''}/?$`), names };
}

export function route(path, view, meta = {}) {
  const { re, names } = compile(path);
  routes.push({ path, re, names, view, meta });
}

export function match(pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  for (const r of routes) {
    const m = r.re.exec(clean);
    if (!m) continue;
    const params = {};
    r.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
    return { route: r, params };
  }
  return null;
}

export function linkPath(path) {
  return path;
}

export function currentPath() {
  return window.location.pathname;
}

export function navigate(path, { replace = false, state = null } = {}) {
  if (path === window.location.pathname + window.location.search) return;
  if (replace) window.history.replaceState(state, '', path);
  else window.history.pushState(state, '', path);
  onNavigate();
}

export function setNavigateHandler(fn) {
  onNavigate = fn;
}

/** 接管站内 <a data-link> 的点击 */
export function interceptLinks(root = document) {
  root.addEventListener('click', (event) => {
    const anchor = event.target.closest && event.target.closest('a[data-link]');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('#') || anchor.target === '_blank') return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(href);
  });
}

export function startRouter({ resolve, render }) {
  const run = async () => {
    const path = window.location.pathname;
    const found = match(path);
    if (currentCleanup) {
      try { currentCleanup(); } catch (err) { console.error('[router] cleanup 失败', err); }
      currentCleanup = null;
    }
    const target = found || { route: null, params: {} };
    const result = await render(target, path);
    if (typeof result === 'function') currentCleanup = result;
  };
  setNavigateHandler(() => { run(); });
  window.addEventListener('popstate', () => run());
  run();
  void resolve;
}
