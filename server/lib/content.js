'use strict';
/**
 * content.js —— 站点内容（content.json）+ 占位符解析 + 版本指纹
 *
 * 规则：
 *   - 一切可改信息集中在 content.json，前端所有页面从它渲染
 *   - 占位符 {{KEY}} 在 placeholders 里集中管理；填了即全站自动替换
 *   - 未填的占位符**不能变成空白**，要能被前端识别并渲染成"待补充"样式
 */

const { JsonStore } = require('./store');
const logger = require('./logger');

const PLACEHOLDER_RE = /\{\{\s*([A-Z0-9_]+)\s*\}\}/g;

const store = new JsonStore('content.json', { defaultValue: null });

/** 默认骨架：仅结构，不含任何业务文案（文案由数据提供） */
function defaultContent() {
  return {
    meta: {
      schemaVersion: 1,
      dataVersion: 1,
      updatedAt: new Date().toISOString(),
      siteName: '捕梦者：崩坏的梦境',
      siteNameEn: 'Dream Catcher',
      slogan: '{{SLOGAN}}',
      numbersBasis: '1.4.04',
      pkgVersion: '1.4.04',
      mcVersion: '1.20.4',
    },
    placeholders: {},
    nav: [],
    hero: { titleArt: '/assets/img/logo-512.webp', backgrounds: [], cta: [] },
    stats: [],
    sections: {},
    downloads: { enabled: true, items: [] },
    community: {},
    sponsor: {},
    credits: [],
    faq: [],
    comments: { enabled: true, requireLogin: true, maxLength: 1000, replyDepth: 1, pageSize: 20 },
    footer: {},
  };
}

function ensureLoaded() {
  if (store.get() == null) {
    store.save(defaultContent()).catch((err) => logger.error('content: 初始化失败', { error: err.message }));
    return defaultContent();
  }
  return store.get();
}

/** 把 placeholders 里的值套进任意结构；同时收集未解析的键。 */
function resolvePlaceholders(value, placeholders, unresolved) {
  if (typeof value === 'string') {
    if (!value.includes('{{')) return value;
    return value.replace(PLACEHOLDER_RE, (match, key) => {
      const entry = placeholders ? placeholders[key] : undefined;
      const filled = entry && typeof entry === 'object' ? entry.value : entry;
      if (filled === undefined || filled === null || String(filled).trim() === '') {
        unresolved.add(key);
        return '';             // 前端 null 化后渲染"待补充"，不留 {{}} 原文
      }
      return String(filled);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolvePlaceholders(v, placeholders, unresolved));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolvePlaceholders(v, placeholders, unresolved);
    return out;
  }
  return value;
}

/**
 * 取前端可用的内容快照：
 *   { data: <占位符已替换>, raw 未暴露, version, unresolved: [KEY...] }
 * 同时把未解析的键替换成 null，前端据此显示"待补充"而非空白。
 */
function buildSnapshot() {
  const content = ensureLoaded();
  const unresolved = new Set();
  const resolved = resolvePlaceholders(content, content.placeholders || {}, unresolved);
  return {
    data: resolved,
    version: versionOf(),
    unresolved: [...unresolved].sort(),
    placeholders: summarizePlaceholders(content.placeholders || {}),
  };
}

function versionOf() {
  const content = ensureLoaded();
  return {
    dataVersion: (content.meta && content.meta.dataVersion) || 1,
    fingerprint: store.fingerprint(),
    updatedAt: (content.meta && content.meta.updatedAt) || null,
  };
}

function etag() {
  const v = versionOf();
  return `W/"c${v.dataVersion}-${v.fingerprint}"`;
}

function summarizePlaceholders(placeholders) {
  return Object.entries(placeholders).map(([key, entry]) => {
    const value = entry && typeof entry === 'object' ? entry.value : entry;
    return {
      key,
      filled: value !== undefined && value !== null && String(value).trim() !== '',
      group: (entry && entry.group) || '未分组',
      hint: (entry && entry.hint) || '',
      // 后台可编辑，故返回当前值；公开快照里由调用方决定是否包含
      value: value === undefined ? '' : String(value),
    };
  });
}

/** 后台：整体保存（原子写 + 自动备份 + dataVersion 自增） */
async function saveContent(nextContent, { bumpVersion = true } = {}) {
  const current = ensureLoaded();
  const merged = {
    ...current,
    ...nextContent,
    meta: {
      ...(current.meta || {}),
      ...((nextContent && nextContent.meta) || {}),
      dataVersion: ((current.meta && current.meta.dataVersion) || 1) + (bumpVersion ? 1 : 0),
      updatedAt: new Date().toISOString(),
    },
  };
  await store.update(() => merged);
  logger.info('content: 已保存', { dataVersion: merged.meta.dataVersion });
  return merged;
}

/** 后台：局部更新（按点分路径写单个字段，路径白名单由调用方校验） */
async function patchContent(pathSegments, value) {
  const current = ensureLoaded();
  const clone = JSON.parse(JSON.stringify(current));
  let node = clone;
  for (let i = 0; i < pathSegments.length - 1; i += 1) {
    const key = pathSegments[i];
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key];
  }
  node[pathSegments[pathSegments.length - 1]] = value;
  return saveContent(clone);
}

/** 后台：批量填占位符（一处填、全站替换） */
async function setPlaceholders(updates) {
  const current = ensureLoaded();
  const placeholders = { ...(current.placeholders || {}) };
  for (const [key, value] of Object.entries(updates || {})) {
    const prev = placeholders[key];
    placeholders[key] = typeof prev === 'object' && prev !== null
      ? { ...prev, value: value === undefined || value === null ? '' : String(value) }
      : { value: value === undefined || value === null ? '' : String(value) };
  }
  return saveContent({ ...current, placeholders });
}

module.exports = {
  store,
  defaultContent,
  buildSnapshot,
  versionOf,
  etag,
  saveContent,
  patchContent,
  setPlaceholders,
  summarizePlaceholders,
};
