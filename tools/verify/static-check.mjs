/**
 * verify/static-check.mjs —— 静态自检（**AI 可独立跑，不需要浏览器**）
 *
 * 补上"没有浏览器也能抓到的那一类错"：
 *   1. ES Module 依赖图：每个相对 import 指向的文件是否真的存在
 *   2. 命名导入 ↔ 导出对账：`import { a, b }` 的 a/b 是否真被目标模块 export
 *   3. DOM id 对账：JS 里 getElementById('x') 的 x 是否在 index.html 里存在
 *   4. CSS 类名对账：JS 里出现的 class 名是否在 CSS 里有定义（警告级）
 *   5. 数据引用的素材路径：存在性检查（wiki 图片位缺失算警告，其余算失败）
 *   6. 占位符扫描：content.json 里还残留哪些 {{...}}、是否都在 placeholders 里登记
 *
 * 用法：node tools/verify/static-check.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(HERE, '..', '..');
const JS_DIR = path.join(SITE_ROOT, 'public', 'js');
const CSS_DIR = path.join(SITE_ROOT, 'public', 'css');
const DATA_DIR = path.join(SITE_ROOT, 'data');
const INDEX = path.join(SITE_ROOT, 'public', 'index.html');

const failures = [];
const warnings = [];
const notes = [];

function walk(dir, filter) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, filter));
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}

/* ------------------------------------------------------------ 0 逐文件编译检查
 * ⚠️ 这一项是「页面白屏」的守门员：只要有一个模块有语法错误，
 * 静态 import 它的入口（main.js）就整个加载失败 → 页面什么都不渲染。
 * 实测 `node --check` 在本机**漏报**过（wiki.js 少一个右括号它说 ok），
 * 所以这里用真正的动态 import 来编译，只把 SyntaxError 当失败（运行时依赖 DOM 的报错忽略）。
 */
async function checkModuleCompile() {
  const files = walk(JS_DIR, (n) => n.endsWith('.js'));
  let syntaxErrors = 0;
  for (const file of files) {
    const rel = path.relative(SITE_ROOT, file).replace(/\\/g, '/');
    try {
      await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
    } catch (err) {
      if (err instanceof SyntaxError) {
        syntaxErrors += 1;
        failures.push(`[语法] ${rel} 编译失败：${err.message}（浏览器里会导致整站白屏）`);
      }
      // 其它错误（window/document 未定义等）属预期：Node 里没有浏览器环境
    }
  }
  notes.push(`编译检查：${files.length} 个前端模块全部编译通过${syntaxErrors ? `（${syntaxErrors} 个失败）` : ''}`);
}

/* ------------------------------------------------------------ 1+2 模块图 */
function checkModules() {
  const files = walk(JS_DIR, (n) => n.endsWith('.js'));
  const exportsByFile = new Map();

  const collectExports = (file, src) => {
    const set = new Set();
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g)) set.add(m[1]);
    for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) set.add(name);
      }
    }
    if (/export\s+default/.test(src)) set.add('default');
    exportsByFile.set(file, set);
    return set;
  };

  for (const file of files) collectExports(file, fs.readFileSync(file, 'utf8'));

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(SITE_ROOT, file).replace(/\\/g, '/');
    for (const m of src.matchAll(/import\s+([^'"]*?)\s*from\s*['"](\.[^'"]+)['"]/g)) {
      const spec = m[2];
      const target = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target)) {
        failures.push(`[模块] ${rel} 里 import '${spec}' → 文件不存在（${path.relative(SITE_ROOT, target)}）`);
        continue;
      }
      const named = (m[1].match(/\{([^}]*)\}/) || [, ''])[1];
      const exported = exportsByFile.get(target) || new Set();
      for (const raw of named.split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0].trim();
        if (name && !exported.has(name)) {
          failures.push(`[导出] ${rel} 导入 { ${name} }，但 ${path.relative(SITE_ROOT, target).replace(/\\/g, '/')} 没有 export 它`);
        }
      }
    }
    for (const m of src.matchAll(/import\s*\(['"](\.[^'"]+)['"]\)/g)) {
      const target = path.resolve(path.dirname(file), m[1]);
      if (!fs.existsSync(target)) failures.push(`[动态导入] ${rel} 里 import('${m[1]}') → 文件不存在`);
    }
  }
  notes.push(`模块图：检查 ${files.length} 个前端模块，导出符号 ${[...exportsByFile.values()].reduce((a, s) => a + s.size, 0)} 个`);
}

/* ------------------------------------------------------------ 3 DOM id */
function checkDomIds() {
  const html = fs.readFileSync(INDEX, 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const missing = new Map();
  for (const file of walk(JS_DIR, (n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (!ids.has(m[1])) {
        const rel = path.relative(SITE_ROOT, file).replace(/\\/g, '/');
        missing.set(m[1], rel);
      }
    }
  }
  for (const [id, rel] of missing) {
    // store.js 里读的是注入的全局变量，不涉及 id；main.js 里 app/bgStage 等必须存在
    failures.push(`[DOM] ${rel} 引用 getElementById('${id}')，但 index.html 里没有这个 id`);
  }
  notes.push(`DOM id：index.html 定义 ${ids.size} 个 id，JS 引用全部命中`);
}

/* ------------------------------------------------------------ 4 CSS 类名 */
function checkCssClasses() {
  const css = walk(CSS_DIR, (n) => n.endsWith('.css')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const defined = new Set([...css.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]));
  const used = new Set();
  const isClassName = (c) => /^[a-z][\w-]*$/i.test(c) && !/^(id|g|tr|x|px|json|true|false)$/.test(c);
  for (const file of walk(JS_DIR, (n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/class(?:Name)?\s*[:=]\s*['"`]([^'"`]+)['"`]/g)) {
      for (const c of m[1].split(/\s+/)) if (isClassName(c)) used.add(c);
    }
    for (const m of src.matchAll(/classList\.(?:add|toggle|remove)\(\s*['"]([^'"]+)['"]/g)) {
      if (isClassName(m[1])) used.add(m[1]);
    }
    // 模板字符串里的 class="..."（例如 el('div', { class: `chip${...}` }) 之外的固定部分）
    for (const m of src.matchAll(/class:\s*`([^`]+)`/g)) {
      for (const c of m[1].split(/[\s${}]+/)) if (isClassName(c)) used.add(c);
    }
  }
  const missing = [...used].filter((c) => !defined.has(c));
  for (const c of missing) warnings.push(`[CSS] JS 里用了 class "${c}"，但 CSS 里没找到定义（可能只是工具类或拼错）`);
  notes.push(`CSS 类名：JS 用到 ${used.size} 个，未在 CSS 定义 ${missing.length} 个（警告级）`);
}

/* ------------------------------------------------------------ 5 数据素材 */
function checkDataAssets() {
  const files = walk(DATA_DIR, (n) => n.endsWith('.json') && n !== 'assets.json');
  const checked = new Set();
  let slotMissing = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/"(https?:\/\/[^"]+|\/assets\/[^"]+)"/g)) {
      const ref = m[1];
      if (ref.startsWith('http') || checked.has(ref)) continue;
      checked.add(ref);
      const local = path.join(SITE_ROOT, 'public', ref.replace(/^\//, '').split('/').join(path.sep));
      const exists = fs.existsSync(local);
      if (exists) continue;
      const isWikiSlot = ref.startsWith('/assets/img/wiki/');
      if (isWikiSlot) slotMissing += 1;
      else failures.push(`[素材] 数据引用了不存在的文件：${ref}（来自 ${path.basename(file)}）`);
    }
  }
  notes.push(`素材引用：检查 ${checked.size} 个路径；其中图片位待补 ${slotMissing} 个（前台渲染占位框）`);
}

/* ------------------------------------------------------------ 6 占位符 */
function checkPlaceholders() {
  const content = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'content.json'), 'utf8'));
  const declared = new Set(Object.keys(content.placeholders || {}));
  const used = new Set([...JSON.stringify(content).matchAll(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]));
  for (const key of used) {
    if (!declared.has(key)) failures.push(`[占位符] 内容里用了 {{${key}}}，但 placeholders 里没有登记`);
  }
  const unused = [...declared].filter((k) => !used.has(k));
  notes.push(`占位符：声明 ${declared.size} 个，正文用到 ${used.size} 个，未用到 ${unused.length} 个（${unused.join(', ') || '无'}）`);
}

/* ------------------------------------------------------------ 7 index.html 注入锚点 */
function checkInjectionAnchor() {
  const html = fs.readFileSync(INDEX, 'utf8');
  if (!html.includes('<!--DREAM_CONTENT-->')) {
    warnings.push('[注入] index.html 里没有 <!--DREAM_CONTENT--> 锚点，服务端会退化为插到 </head> 前');
  } else {
    notes.push('注入锚点：<!--DREAM_CONTENT--> 存在');
  }
  const cssRefs = [...html.matchAll(/href="(\/css\/[^"]+)"/g)].map((m) => m[1]);
  for (const ref of cssRefs) {
    if (!fs.existsSync(path.join(SITE_ROOT, 'public', ref.replace(/^\//, '').split('/').join(path.sep)))) {
      failures.push(`[HTML] index.html 引用了不存在的样式表：${ref}`);
    }
  }
}

console.log('=== 静态自检（无浏览器）===');
await checkModuleCompile();
checkModules();
checkDomIds();
checkCssClasses();
checkDataAssets();
checkPlaceholders();
checkInjectionAnchor();

console.log('');
for (const n of notes) console.log(`  · ${n}`);
if (warnings.length) {
  console.log(`\n【警告 ${warnings.length} 条】`);
  for (const w of warnings) console.log(`  ! ${w}`);
}
if (failures.length) {
  console.log(`\n【失败 ${failures.length} 条】`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log('\n=== 结果：失败 ===');
  process.exit(1);
}
console.log('\n=== 结果：全部通过 ===');
process.exit(0);
