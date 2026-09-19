/**
 * verify/render-test.mjs —— 前端渲染自检（**在 Node 里跑真实视图代码，不需要浏览器**）
 *
 * 为什么需要它："页面白屏"这类运行时错误（某个模块语法错了、某个视图渲染时抛异常）
 * 静态检查抓不到，而它只有在浏览器里才会暴露。这里用一套最小 DOM 桩
 * 把这 12 个前端模块**真的执行一遍**，断言每个路由都能渲染出内容，
 * 并把抛出的异常原样报出来——不用等打开浏览器才发现白屏。
 *
 * 覆盖：boot 流程 → 头部/页脚/背景挂载 → 全部 15 个路由渲染 → 语言切换重渲染 → 数据集加载。
 *
 * 局限（明确写出来，避免误判）：
 *   - 不是浏览器：不做布局/样式/图片解码/真实动画的验证 → 视觉部分仍要用 browser-check.mjs
 *   - 选择器只实现 tag / .class / [attr] / [attr="v"] / 逗号组合
 *
 * 用法：node tools/verify/render-test.mjs [--base http://127.0.0.1:4173]
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const readArg = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = readArg('--base', process.env.SITE_BASE || 'http://127.0.0.1:4173').replace(/\/$/, '');

/* ================================================================ 最小 DOM 桩 */

class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...names) { for (const n of names) if (n) this.set.add(n); this.el._className = [...this.set].join(' '); }
  remove(...names) { for (const n of names) this.set.delete(n); this.el._className = [...this.set].join(' '); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name); else this.set.delete(name);
    this.el._className = [...this.set].join(' ');
    return on;
  }
  contains(name) { return this.set.has(name); }
  toString() { return [...this.set].join(' '); }
}

class DomNode {
  constructor(name = '#node') {
    this.nodeName = name;
    this.childNodes = [];
    this.parentNode = null;
  }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  appendChild(child) {
    if (child && child.nodeName === '#fragment') {
      for (const c of [...child.childNodes]) this.appendChild(c);
      child.childNodes = [];
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'string' ? new TextNode(n) : n); }
  prepend(...nodes) { for (const n of nodes.reverse()) this.insertBefore(typeof n === 'string' ? new TextNode(n) : n, this.childNodes[0] || null); }
  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(node); else this.childNodes.splice(i, 0, node);
    return node;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  replaceChildren(...nodes) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes.filter((n) => n !== null && n !== undefined));
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  after(node) { if (this.parentNode) { const i = this.parentNode.childNodes.indexOf(this); this.parentNode.childNodes.splice(i + 1, 0, node); node.parentNode = this.parentNode; } }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  set textContent(v) { this.replaceChildren(new TextNode(String(v))); }
  get innerText() { return this.textContent; }
  /* 选择器：tag / .class / #id / [attr] / [attr="v"] / 逗号组合 */
  _matches(selector) {
    return selector.split(',').map((s) => s.trim()).filter(Boolean).some((sel) => this._matchOne(sel));
  }
  _matchOne(sel) {
    const parts = sel.match(/^([a-zA-Z#*][\w-]*)?((?:\.[\w-]+|\[[^\]]+\]|#[\w-]+)*)$/);
    if (!parts) return false;
    const [, tag, rest] = parts;
    if (tag && tag !== '*' && this.nodeName.toLowerCase() !== tag.toLowerCase()) return false;
    const tokens = (rest || '').match(/\.[\w-]+|\[[^\]]+\]|#[\w-]+/g) || [];
    for (const t of tokens) {
      if (t.startsWith('.')) { if (!this.classList.contains(t.slice(1))) return false; }
      else if (t.startsWith('#')) { if (this.attributes.id !== t.slice(1)) return false; }
      else {
        const m = t.slice(1, -1).match(/^([\w-]+)(?:=["']?([^"'\]]*)["']?)?$/);
        if (!m) return false;
        const [, name, value] = m;
        if (!(name in this.attributes)) return false;
        if (value !== undefined && String(this.attributes[name]) !== value) return false;
      }
    }
    return true;
  }
  _walk(out) { for (const c of this.childNodes) { if (c.nodeType === 1) { out.push(c); c._walk(out); } } return out; }
  contains(node) {
    let n = node;
    while (n) { if (n === this) return true; n = n.parentNode; }
    return false;
  }
  querySelectorAll(sel) { return this._walk([]).filter((el) => el._matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) { let n = this; while (n && n.nodeType === 1) { if (n._matches(sel)) return n; n = n.parentNode; } return null; }
  matches(sel) { return this._matches(sel); }
}

class TextNode extends DomNode {
  constructor(data) { super('#text'); this.nodeType = 3; this.data = String(data); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class Element extends DomNode {
  constructor(tag) {
    super(String(tag).toUpperCase());
    this.nodeType = 1;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.classList = new ClassList(this);
    this.value = '';
    this.disabled = false;
    this._className = '';
  }
  set className(v) { this.attributes.class = String(v); this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); this._className = String(v); }
  get className() { return this.attributes.class || ''; }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'class') this.className = v;
    if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
  }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; if (k === 'class') this.className = ''; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { if (this.listeners[type]) this.listeners[type] = this.listeners[type].filter((f) => f !== fn); }
  dispatch(type, event = {}) {
    const ev = { type, target: this, preventDefault() {}, stopPropagation() {}, ...event };
    for (const fn of this.listeners[type] || []) fn(ev);
    return ev;
  }
  focus() {}
  get tagName() { return this.nodeName; }
}

function buildDocument() {
  const html = new Element('html');
  html.lang = 'zh-CN';
  const head = new Element('head');
  const body = new Element('body');
  const add = (parent, tag, id, cls) => {
    const e = new Element(tag);
    if (id) e.setAttribute('id', id);
    if (cls) e.setAttribute('class', cls);
    parent.appendChild(e);
    return e;
  };
  const header = add(body, 'header', 'siteHeader');
  const inner = add(header, 'div', null, 'shell header-inner');
  add(inner, 'span', 'brandText');
  add(inner, 'button', 'navToggle');
  const nav = add(inner, 'nav', 'siteNav');
  add(nav, 'ul', 'navList');
  add(inner, 'button', 'langToggle');
  add(inner, 'span', 'langNow');
  add(inner, 'span', 'langAlt');
  add(inner, 'span', 'userArea');
  add(header, 'div', 'scrollProgress');
  add(body, 'div', 'bgStage');
  add(body, 'main', 'app');
  add(body, 'footer', 'siteFooter');
  add(body, 'div', 'toastStack');
  html.appendChild(head);
  html.appendChild(body);

  const document = {
    nodeType: 9,
    documentElement: html,
    head,
    body,
    title: '',
    createElement: (t) => new Element(t),
    createTextNode: (t) => new TextNode(t),
    createDocumentFragment: () => new DomNode('#fragment'),
    getElementById: (id) => html._walk([]).find((el) => el.attributes.id === id) || null,
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
    addEventListener() {},
    removeEventListener() {},
  };
  return document;
}

function installGlobals() {
  const document = buildDocument();
  const location = {
    pathname: '/', search: '', hash: '', href: `${BASE}/`, origin: BASE,
  };
  const store = new Map();
  const listeners = {};
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  const history = {
    pushState(_s, _t, url) { if (url) location.pathname = String(url).split('?')[0]; },
    replaceState(_s, _t, url) { if (url) location.pathname = String(url).split('?')[0]; },
  };
  const IO = class {
    constructor(cb) { this.cb = cb; }
    observe(el) { try { this.cb([{ isIntersecting: true, target: el }], this); } catch { /* noop */ } }
    unobserve() {} disconnect() {} takeRecords() { return []; }
  };
  const win = {
    __DREAM_CONTENT__: null,
    location,
    history,
    localStorage,
    document,
    innerWidth: 1440,
    innerHeight: 900,
    scrollY: 0,
    scrollTo() {},
    matchMedia: () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn); },
    dispatch(type, event = {}) { for (const fn of listeners[type] || []) fn({ type, preventDefault() {}, stopPropagation() {}, ...event }); },
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    setTimeout, clearTimeout, setInterval, clearInterval,
    navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node-render-test' },
    performance: { now: () => Date.now() },
    matchMediaQuery: null,
    IntersectionObserver: IO,
    confirm: () => true,
    alert: () => {},
  };
  // fetch：把相对路径补成绝对地址
  const realFetch = globalThis.fetch;
  win.fetch = (input, init) => realFetch(typeof input === 'string' && input.startsWith('/') ? BASE + input : input, init);

  globalThis.window = win;
  // Node 26 里 navigator / fetch 等是只读 getter，直接赋值会抛 TypeError → 统一用 defineProperty
  const defineGlobal = (name, value) => {
    try {
      Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: true });
    } catch {
      try { globalThis[name] = value; } catch { /* 实在不行就算了 */ }
    }
  };
  defineGlobal('document', document);
  defineGlobal('Node', DomNode);        // dom.js 里用 `child instanceof Node` 判断，必须提供
  defineGlobal('Element', Element);
  defineGlobal('location', location);
  defineGlobal('history', history);
  defineGlobal('localStorage', localStorage);
  defineGlobal('IntersectionObserver', IO);
  defineGlobal('requestAnimationFrame', win.requestAnimationFrame);
  defineGlobal('cancelAnimationFrame', win.cancelAnimationFrame);
  defineGlobal('matchMedia', win.matchMedia);
  defineGlobal('navigator', win.navigator);
  defineGlobal('fetch', win.fetch);
  defineGlobal('confirm', win.confirm);
  return { window: win, document, location };
}

/* ================================================================ 跑测试 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`=== 前端渲染自检（Node + DOM 桩）@ ${BASE} ===`);

  // 1) 先拿服务端注入的内容快照（等价于浏览器里的 window.__DREAM_CONTENT__）
  const res = await fetch(`${BASE}/api/content`);
  const payload = await res.json();
  if (!payload || !payload.ok) throw new Error('无法从服务端取得内容快照，服务起来了吗？');

  const env = installGlobals();
  env.window.__DREAM_CONTENT__ = {
    content: payload.data.content,
    version: payload.data.version,
    unresolved: payload.data.unresolved,
    env: { name: 'test', version: '0', adminEnabled: false },
  };

  const failures = [];
  const captured = [];
  const origError = console.error;
  console.error = (...a) => { captured.push(a.map(String).join(' ')); };

  // 2) 真的加载前端入口
  const mainUrl = pathToFileURL(path.join(SITE_ROOT, 'public', 'js', 'main.js')).href;
  await import(mainUrl);
  await sleep(1200);

  const app = env.document.getElementById('app');
  const renderInfo = (label) => {
    const text = app ? app.textContent.trim() : '';
    return { label, len: text.length, head: text.slice(0, 60).replace(/\s+/g, ' ') };
  };

  const check = (label, ok, detail = '') => {
    if (ok) console.log(`  [PASS] ${label}${detail ? `  ${detail}` : ''}`);
    else { console.log(`  [FAIL] ${label}  ${detail}`); failures.push(`${label} ${detail}`); }
  };

  // 3) 首页
  const home = renderInfo('/');
  check('首页渲染出内容', home.len > 200, `长度 ${home.len}：「${home.head}…」`);

  // 3b) 首页数字由百科数据加算（新增关卡/职业后会自动跟着变）
  await sleep(1600);   // 等数据集加载 + 数字滚动动画跑完
  const statValues = env.document.querySelectorAll('.stat').map((n) => n.textContent.replace(/\s+/g, ' ').trim());
  const statText = statValues.join(' | ');
  check('首页数字渲染出 6 项', statValues.length === 6, `${statValues.length} 项`);
  check('关卡/职业等数字来自百科加算（应出现 3 大关 / 9 关卡 / 11 职业 / 88 天赋）',
    /大关/.test(statText) && /9/.test(statText) && /11/.test(statText) && /88/.test(statText),
    statText.slice(0, 200));

  // 4) 头部导航（DOM 桩不支持后代选择器，直接用 textContent 判断）
  const navList = env.document.getElementById('navList');
  const navText = navList ? navList.textContent : '';
  check('头部导航渲染出全部条目', /首页/.test(navText) && /百科/.test(navText) && /下载/.test(navText), `「${navText.slice(0, 50)}…」`);
  check('导航链接数量正确', navList && navList.childNodes.length >= 9, `${navList ? navList.childNodes.length : 0} 条`);
  const footer = env.document.getElementById('siteFooter');
  check('页脚渲染出备案信息', footer && footer.textContent.includes('浙ICP备'), footer ? `长度 ${footer.textContent.length}` : '无页脚');
  // 页脚作者行：配了 footer.authorUrl 时必须是可点链接
  const authorLink = footer ? footer.querySelectorAll('a').map((a) => a.getAttribute('href') || '').filter((h) => h.includes('shinyasuna.top:3000')) : [];
  check('页脚作者行是指向个人页的链接', authorLink.length === 1, `找到 ${authorLink.length} 个指向 3000 的链接`);
  const bgStage = env.document.getElementById('bgStage');
  const bgCount = bgStage ? bgStage.querySelectorAll('.bg-layer').length : 0;
  check('背景层已挂载', bgCount >= 1, `${bgCount} 层`);

  // 5) 逐个路由：断言「该页自己的内容」渲染出来了（而不是只测长度）
  const routes = [
    ['/intro', '地图介绍', ['配置要求', '1.20.4']],
    ['/wiki', '百科目录', ['关卡', '物品', '职业']],
    ['/wiki/levels', '关卡', ['最浅层', '树林', '畸变']],
    ['/wiki/items', '物品', ['等阶', '猎手']],
    ['/wiki/classes', '职业与天赋', ['医生', '医药充裕', '决斗家']],
    ['/wiki/enemies', '敌人（空态）', ['整理中']],
    ['/wiki/difficulty', '难度（空态）', ['整理中']],
    ['/faq', 'Q&A', ['地图怎么下载', 'restart_all']],
    ['/download', '下载', ['安装步骤', '网盘下载', 'pan.quark.cn']],
    ['/community', '社区', ['1080211664', '魔改版']],
    ['/sponsor', '赞助', ['爱发电']],
    ['/about', '制作组', ['弱智苦力怕', '海潮Seatide']],
    ['/login', '登录', ['密码', '用户名']],
    ['/comments', '留言板', ['留言']],
    ['/no-such-page', '404', ['不存在']],
  ];
  for (const [routePath, label, expects] of routes) {
    captured.length = 0;
    try {
      // 模拟浏览器前进/后退：先改 location，再派发 popstate（直接调 navigate 会因为
      // "路径没变" 而提前 return，测不到真实渲染）
      env.location.pathname = routePath;
      env.window.dispatch('popstate');
    } catch (err) {
      failures.push(`${label} 导航抛错：${err.message}`);
      console.log(`  [FAIL] ${label} 导航抛错：${err.message}`);
      continue;
    }
    await sleep(routePath.startsWith('/wiki/') || routePath === '/faq' || routePath === '/comments' ? 900 : 400);
    const info = renderInfo(routePath);
    const errText = captured.length ? captured[0].slice(0, 200) : '';
    const full = app ? app.textContent : '';
    const missing = expects.filter((w) => !full.includes(w));
    check(`${label}（${routePath}）`, missing.length === 0 && !errText,
      `长度 ${info.len}${missing.length ? `  缺少：${missing.join('、')}` : ''}${errText ? `  console.error: ${errText}` : ''}`);
  }

  // 6) 交互：关卡「三大层 → 关卡条目 → 详情弹窗」
  env.location.pathname = '/wiki/levels';
  env.window.dispatch('popstate');
  await sleep(1100);
  let chapters = app.querySelectorAll('.chapter-card');
  check('关卡页先展示三大层卡片', chapters.length === 3, `${chapters.length} 张`);
  if (chapters.length) {
    chapters[0].dispatch('click');
    await sleep(350);
    const rows = app.querySelectorAll('.level-row');
    check('点大层后出现该层的关卡条目', rows.length === 3, `${rows.length} 条`);
    if (rows.length) {
      rows[0].dispatch('click');
      await sleep(250);
      const modals = env.document.body.querySelectorAll('.modal-root');
      const text = modals.length ? modals[0].textContent : '';
      check('点关卡条目弹出详情弹窗（含背景故事）', modals.length === 1 && text.includes('树林') && text.length > 60, `弹窗 ${modals.length} 个，文本长度 ${text.length}`);
      const closeBtn = modals.length ? modals[0].querySelector('.modal-close') : null;
      if (closeBtn) { closeBtn.dispatch('click'); await sleep(400); }
      check('弹窗可关闭', env.document.body.querySelectorAll('.modal-root').length === 0, '');
    }
    // 返回三大层：曾经因为二次渲染的元素带着 opacity:0 而"变空"，这里专门守住
    // （DOM 桩不支持后代选择器，所以先取 .breadcrumb 再取它的 button）
    const crumb = app.querySelector('.breadcrumb');
    const backBtn = crumb ? crumb.querySelectorAll('button')[0] : null;
    check('关卡详情页有「返回三大层」按钮', Boolean(backBtn), backBtn ? backBtn.textContent : '没找到');
    if (backBtn) {
      backBtn.dispatch('click');
      await sleep(300);
      const backChapters = app.querySelectorAll('.chapter-card');
      const visible = backChapters.filter((n) => n.classList.contains('is-visible') || n.parentNode.classList.contains('is-visible'));
      check('点返回三大层后重新出现 3 张层卡且可见', backChapters.length === 3 && visible.length === 3,
        `${backChapters.length} 张，其中已标可见 ${visible.length} 张`);
      check('返回后内容不是空的', app.textContent.trim().length > 60, `长度 ${app.textContent.trim().length}`);
    }
  }

  // 7) 交互：物品卡片弹窗
  env.location.pathname = '/wiki/items';
  env.window.dispatch('popstate');
  await sleep(1100);
  const itemCards = app.querySelectorAll('.item-card');
  check('物品页渲染出卡片', itemCards.length > 0, `${itemCards.length} 张`);
  if (itemCards.length) {
    const firstName = itemCards[0].textContent.slice(0, 6);
    itemCards[0].dispatch('click');
    await sleep(250);
    const modals = env.document.body.querySelectorAll('.modal-root');
    const text = modals.length ? modals[0].textContent : '';
    check('点物品卡片弹出详情弹窗', modals.length === 1 && text.includes(firstName.slice(0, 3)), `「${firstName}」→ 弹窗 ${modals.length} 个`);
    const closeBtn = modals.length ? modals[0].querySelector('.modal-close') : null;
    if (closeBtn) { closeBtn.dispatch('click'); await sleep(150); }
  }

  // 8) 交互：职业卡片弹窗（含 8 条天赋）
  env.location.pathname = '/wiki/classes';
  env.window.dispatch('popstate');
  await sleep(1000);
  const classCards = app.querySelectorAll('.class-card');
  check('职业页渲染出职业卡', classCards.length === 11, `${classCards.length} 张`);
  if (classCards.length) {
    classCards[0].dispatch('click');
    await sleep(250);
    const modals = env.document.body.querySelectorAll('.modal-root');
    const text = modals.length ? modals[0].textContent : '';
    const talentCount = modals.length ? modals[0].querySelectorAll('.talent-name').length : 0;
    check('点职业卡弹出天赋列表', modals.length === 1 && talentCount === 8, `天赋 ${talentCount} 条`);
    check('天赋弹窗不再重复罗列数字变量', !/数值\d*\s*\d/.test(text), '');
    const closeBtn = modals.length ? modals[0].querySelector('.modal-close') : null;
    if (closeBtn) { closeBtn.dispatch('click'); await sleep(150); }
  }

  // 9) 布局细节回归：页面标题必须套在居中容器里（曾经漏了 shell → 标题贴到屏幕最左边）
  env.location.pathname = '/comments';
  env.window.dispatch('popstate');
  await sleep(500);
  const head = app.querySelector('.page-head');
  const headHasShell = head ? (head.classList.contains('shell') || head.classList.contains('shell-narrow')) : false;
  check('留言板页面标题有居中容器（不贴左边缘）', Boolean(head) && headHasShell,
    head ? `class="${head.getAttribute('class')}"` : '没找到 .page-head');

  // 10) 语言切换
  captured.length = 0;
  const { toggleLang, getLang } = await import(pathToFileURL(path.join(SITE_ROOT, 'public', 'js', 'store.js')).href);
  env.location.pathname = '/';
  env.window.dispatch('popstate');
  await sleep(500);
  toggleLang();
  await sleep(900);
  const enNavText = (env.document.getElementById('navList') || { textContent: '' }).textContent;
  check('切到英文后导航变英文', getLang() === 'en' && /Home/.test(enNavText) && /Codex/.test(enNavText), `lang=${getLang()} 导航=${enNavText.slice(0, 60)}`);
  toggleLang();
  await sleep(600);
  const zhNavText = (env.document.getElementById('navList') || { textContent: '' }).textContent;
  check('切回中文后导航恢复', getLang() === 'zh' && /首页/.test(zhNavText), `导航=${zhNavText.slice(0, 40)}`);

  console.error = origError;

  console.log('');
  if (failures.length) {
    console.log(`=== 结果：失败 ${failures.length} 项 ===`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    console.log('');
    console.log('提示：这类失败通常是运行时错误（浏览器里就是白屏）。上面 console.error 的内容即报错原文。');
    process.exit(1);
  }
  console.log('=== 结果：全部通过 ===');
  process.exit(0);
}

main().catch((err) => {
  console.log('');
  console.log('=== 结果：前端渲染自检异常终止 ===');
  console.log(String(err && err.stack ? err.stack : err).slice(0, 2000));
  process.exit(2);
});
