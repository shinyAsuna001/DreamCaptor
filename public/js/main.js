/**
 * main.js —— 入口：装配头部/页脚/背景，注册路由，启动
 */
import { route, startRouter, interceptLinks, navigate } from './router.js';
import { revealOnScroll, el, append, clear, toast } from './dom.js';
import {
  getContent, getEnv, subscribe, toggleLang, setUser, getLang,
} from './store.js';
import { renderHeader, renderFooter, mountBackdrop } from './components.js';
import { api } from './api.js';

import { renderHome } from './views/home.js';
import { renderIntro } from './views/intro.js';
import { renderWiki } from './views/wiki.js';
import {
  renderFaq, renderDownload, renderCommunity, renderSponsor, renderAbout, renderLogin, renderNotFound,
} from './views/pages.js';
import { renderComments } from './views/comments.js';
import { renderAdmin } from './views/admin.js';

const app = document.getElementById('app');
const env = getEnv();

/* ------------------------------------------------------------------ 全局交互 */
function wireHeader() {
  const header = document.getElementById('siteHeader');
  const progress = document.getElementById('scrollProgress');
  const navToggle = document.getElementById('navToggle');
  const nav = document.getElementById('siteNav');

  const onScroll = () => {
    const y = window.scrollY || document.documentElement.scrollTop;
    if (header) header.classList.toggle('is-scrolled', y > 12);
    if (progress) {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      progress.style.width = `${max > 0 ? Math.min(100, (y / max) * 100) : 0}%`;
    }
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  if (navToggle && nav) {
    navToggle.addEventListener('click', () => {
      const open = nav.classList.toggle('is-open');
      navToggle.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', (event) => {
      if (event.target.closest('a')) {
        nav.classList.remove('is-open');
        navToggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  const langToggle = document.getElementById('langToggle');
  if (langToggle) langToggle.addEventListener('click', () => toggleLang());

  // 快捷键：g 首页 / w 百科 / f Q&A / d 下载
  window.addEventListener('keydown', (event) => {
    if (event.target.matches('input, textarea, select') || event.metaKey || event.ctrlKey || event.altKey) return;
    const map = { g: '/', w: '/wiki', f: '/faq', d: '/download' };
    const path = map[event.key.toLowerCase()];
    if (path) navigate(path);
  });

  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('is-hidden', document.hidden);
  });
}

/* ------------------------------------------------------------------ 路由 */
function registerRoutes() {
  route('/', (a) => renderHome(a), { title: 'home' });
  route('/intro', (a) => renderIntro(a));
  route('/wiki', (a) => renderWiki(a, {}));
  route('/wiki/:page', (a, params) => renderWiki(a, params));
  route('/faq', (a) => renderFaq(a));
  route('/download', (a) => renderDownload(a));
  route('/community', (a) => renderCommunity(a));
  route('/sponsor', (a) => renderSponsor(a));
  route('/about', (a) => renderAbout(a));
  route('/login', (a) => renderLogin(a));
  route('/comments', (a) => renderComments(a));
  if (env.adminPath) route(env.adminPath, (a) => renderAdmin(a));
}

let currentPath = '/';

async function render(target, path) {
  currentPath = path;
  const content = getContent();
  const meta = content.meta || {};
  // 路由变化时同步刷新头部：否则导航高亮会一直停在首页
  renderHeader();
  const titles = {
    '/': t(meta.siteName),
    '/intro': t((content.intro || {}).title),
    '/wiki': t((content.wiki || {}).title),
    '/faq': t((content.faq || {}).title),
    '/download': t((content.downloads || {}).title),
    '/community': t((content.community || {}).title),
    '/sponsor': t((content.sponsor || {}).title),
    '/about': t((content.credits || {}).title),
    '/login': getLang() === 'zh' ? '登录' : 'Sign in',
    '/comments': t((content.comments || {}).title),
  };
  const base = `${meta.siteName && meta.siteName.zh ? meta.siteName.zh : '捕梦者'} · 官网`;
  document.title = path === '/' ? base : `${titles[path] || (content.wiki && content.wiki.pages || []).find((p) => path.startsWith(p.path))?.label?.zh || '页面'} · ${base}`;

  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });

  if (!target.route) return renderNotFound(app);
  const stopReveal = await target.route.view(app, target.params);
  const extraReveal = revealOnScroll(app);
  return () => {
    if (typeof stopReveal === 'function') stopReveal();
    extraReveal();
  };
}

function t(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return value[getLang()] || value.zh || value.en || '';
}

/* ------------------------------------------------------------------ 启动失败时给出可读诊断（开发期） */
function renderFatal(title, err) {
  const stack = err && err.stack ? String(err.stack) : String(err || '');
  const box = document.createElement('section');
  box.className = 'shell';
  box.style.padding = '6rem 1rem 3rem';
  const h = document.createElement('h2');
  h.textContent = title;
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = '这一条是给开发看的诊断信息（正式上线前会去掉）。请把下面的文字发给 AI。';
  const pre = document.createElement('pre');
  pre.style.whiteSpace = 'pre-wrap';
  pre.textContent = stack;
  box.append(h, p, pre);
  const host = document.getElementById('app');
  if (host) host.replaceChildren(box);
  console.error('[dream] 启动失败', err);
}

window.addEventListener('error', (event) => {
  const host = document.getElementById('app');
  if (host && !host.textContent.trim()) renderFatal('页面脚本报错', event.error || event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  const host = document.getElementById('app');
  if (host && !host.textContent.trim()) renderFatal('页面异步任务报错', event.reason);
});

/* ------------------------------------------------------------------ 启动 */
async function boot() {
  renderHeader();
  renderFooter();
  const stopBackdrop = mountBackdrop();
  wireHeader();
  interceptLinks();
  registerRoutes();

  // 首次拉取登录态（不阻塞渲染）
  api.me().then((data) => setUser(data.user)).catch(() => setUser(null));

  // 语言切换 → 重渲染头部/页脚/当前页
  subscribe(() => {
    renderHeader();
    renderFooter();
    import('./router.js').then(({ match }) => {
      const m = match(window.location.pathname);
      if (m) render(m, window.location.pathname);
    });
  });

  startRouter({ resolve: null, render });
  console.info('[dream] 站点就绪', { path: currentPath, admin: Boolean(env.adminPath) });
  void stopBackdrop;
  void toast;
  void el;
  void append;
  void clear;
}

boot().catch((err) => renderFatal('站点启动失败', err));
