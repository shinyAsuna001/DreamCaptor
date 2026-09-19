/**
 * store.js —— 内容与语言状态（零依赖）
 *
 * 内容来源：服务端注入的 window.__DREAM_CONTENT__（首屏零请求）
 * 语言：localStorage 记忆，切换后重渲染当前路由
 * 数据集：按需拉取（带 ETag），缓存进内存
 */

const boot = window.__DREAM_CONTENT__ || { content: {}, version: null, unresolved: [], env: {} };

const LANG_KEY = 'dream:lang';
const LANGS = ['zh', 'en'];

const state = {
  content: boot.content || {},
  version: boot.version || null,
  unresolved: Array.isArray(boot.unresolved) ? boot.unresolved : [],
  env: boot.env || {},
  lang: readLang(),
  user: null,
  datasets: new Map(),
  listeners: new Set(),
};

function readLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (LANGS.includes(saved)) return saved;
  } catch { /* 隐私模式忽略 */ }
  return 'zh';
}

/**
 * 取多语言文本。
 * 支持：字符串 | { zh, en } | 数组（递归）
 * 规则：目标语言为空 → 回退中文 → 再回退英文
 */
export function t(value, lang = state.lang) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => t(v, lang)).filter(Boolean).join(' / ');
  if (typeof value === 'object') {
    const direct = value[lang];
    if (typeof direct === 'string' && direct.trim()) return direct;
    const zh = value.zh;
    if (typeof zh === 'string' && zh.trim()) return zh;
    const en = value.en;
    if (typeof en === 'string' && en.trim()) return en;
    return '';
  }
  return String(value);
}

/** 是否缺该语言的翻译（后台统计与前台小标记用） */
export function isMissingTranslation(value, lang = state.lang) {
  if (lang === 'zh' || typeof value !== 'object' || value === null) return false;
  return !(typeof value[lang] === 'string' && value[lang].trim());
}

export function getLang() {
  return state.lang;
}

export function getContent() {
  return state.content;
}

export function getEnv() {
  return state.env;
}

export function getVersion() {
  return state.version;
}

export function getUnresolved() {
  return state.unresolved;
}

export function getUser() {
  return state.user;
}

export function setUser(user) {
  state.user = user || null;
  emit();
}

export function setLang(lang) {
  if (!LANGS.includes(lang) || lang === state.lang) return;
  state.lang = lang;
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* 忽略 */ }
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  emit();
}

export function toggleLang() {
  setLang(state.lang === 'zh' ? 'en' : 'zh');
}

export function subscribe(fn) {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}

function emit() {
  for (const fn of state.listeners) {
    try { fn(state); } catch (err) { console.error('[store] listener 失败', err); }
  }
}

/** 服务端内容更新后刷新（后台保存后用） */
export async function refreshContent() {
  const res = await fetch('/api/content', { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const body = await res.json();
  if (!body || !body.ok) return null;
  state.content = body.data.content;
  state.version = body.data.version;
  state.unresolved = body.data.unresolved || [];
  state.datasets.clear();
  emit();
  return body.data;
}

/**
 * 取百科数据集（带 ETag 缓存）。返回 { data, fromCache }。
 */
export async function getDataset(name) {
  const cached = state.datasets.get(name);
  if (cached) return cached;
  const res = await fetch(`/api/wiki/${name}`, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !body.ok) {
    const err = new Error(`数据集 ${name} 加载失败`);
    err.status = res.status;
    throw err;
  }
  const entry = { data: body.data, etag: res.headers.get('etag') || '' };
  state.datasets.set(name, entry);
  return entry;
}

/** 便捷：按 content.wiki.pages 里的 dataset 名取数据 */
export async function getWikiDataset(name) {
  const entry = await getDataset(name);
  return entry.data;
}

/**
 * 首页数字「由百科数据加算」：content.stats 里带 derive 的条目，值从数据集实时算出来。
 * 这样以后新增关卡/职业/道具，只需要维护百科页，首页数字自动跟着变。
 */
function evalStatExpr(expr, data) {
  switch (expr) {
    case 'chapters.length': return (data.chapters || []).length;
    case 'levels.length': return (data.levels || []).length;
    case 'items.length': return (data.items || []).length;
    case 'classes.length': return (data.classes || []).length;
    case 'classes.talents.total': return (data.classes || []).reduce((n, c) => n + ((c.talents || []).length), 0);
    default: return null;
  }
}

/** 解析全部 stats，返回与输入等长的数组（每项多一个 value） */
export async function resolveStats(stats = []) {
  const out = [];
  for (const stat of stats) {
    if (!stat || !stat.derive) { out.push({ ...stat }); continue; }
    try {
      const data = await getWikiDataset(stat.derive.dataset);
      const value = evalStatExpr(stat.derive.expr, data);
      out.push({ ...stat, value: typeof value === 'number' ? value : (stat.fallback ?? null), derived: true });
    } catch {
      out.push({ ...stat, value: stat.fallback ?? null, derived: false });
    }
  }
  return out;
}

document.documentElement.lang = state.lang === 'en' ? 'en' : 'zh-CN';
