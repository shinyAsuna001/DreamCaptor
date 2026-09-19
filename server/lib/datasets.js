'use strict';
/**
 * datasets.js —— 百科数据集注册表
 *
 * 为什么单独放：用户要求「百科都别写死」，而"全部物品信息"这类数据集
 * 体量可能上百 KB —— 塞进 content.json 会让首屏注入的 HTML 变大。
 * 因此：
 *   content.json        站点结构 + 小体量文案（首屏注入）
 *   data/wiki-*.json    百科数据集（按需拉取，带 ETag 缓存）
 *
 * 白名单机制：只允许下面这些名字，杜绝路径穿越读任意文件。
 */

const { JsonStore } = require('./store');

const DATASETS = {
  'wiki-levels': { file: 'wiki-levels.json', label: '关卡', defaultValue: { chapters: [], levels: [] } },
  'wiki-items': { file: 'wiki-items.json', label: '物品', defaultValue: { items: [], qualities: [], pools: [] } },
  'wiki-classes': { file: 'wiki-classes.json', label: '职业与天赋', defaultValue: { classes: [] } },
  'wiki-enemies': { file: 'wiki-enemies.json', label: '敌人', defaultValue: { groups: [], items: [] } },
  'wiki-difficulty': { file: 'wiki-difficulty.json', label: '难度', defaultValue: { sections: [] } },
  'wiki-faq': { file: 'wiki-faq.json', label: '常见问题', defaultValue: { sections: [] } },
};

const stores = new Map();

function storeOf(name) {
  if (!Object.prototype.hasOwnProperty.call(DATASETS, name)) return null;
  if (!stores.has(name)) {
    const meta = DATASETS[name];
    stores.set(name, new JsonStore(meta.file, { defaultValue: meta.defaultValue }));
  }
  return stores.get(name);
}

function metaOf(name) {
  return Object.prototype.hasOwnProperty.call(DATASETS, name) ? DATASETS[name] : null;
}

function listNames() {
  return Object.keys(DATASETS);
}

/** 公开读取：返回数据 + 指纹（供 ETag） */
function readPublic(name) {
  const store = storeOf(name);
  if (!store) return null;
  return { data: store.get(), fingerprint: store.fingerprint() };
}

/** 后台整体保存 */
async function write(name, value) {
  const store = storeOf(name);
  if (!store) {
    const err = new Error(`未知数据集：${name}`);
    err.statusCode = 404;
    throw err;
  }
  await store.save(value);
  return { fingerprint: store.fingerprint() };
}

function summary() {
  return listNames().map((name) => {
    const store = storeOf(name);
    const data = store.get();
    const count = Array.isArray(data && (data.items || data.levels || data.classes || data.groups || data.sections))
      ? (data.items || data.levels || data.classes || data.groups || data.sections).length
      : null;
    return { name, label: DATASETS[name].label, count, fingerprint: store.fingerprint() };
  });
}

module.exports = { DATASETS, storeOf, metaOf, listNames, readPublic, write, summary };
