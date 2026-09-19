/**
 * 个人页（3000）作品区/导航的「期望状态」补丁器 —— 幂等，可反复执行
 *
 * 期望状态（作者 2026-09-17 确认）：
 *   ✅ 顶部导航栏**只保留「首页 / 作品」两栏**（不要「捕梦者」入口）
 *   ✅ 作品区保留第 5 张卡：《捕梦者：崩坏的梦境》官方网站 → http://shinyasuna.top:3002/
 *   ✅ script.js 词典里补上这张卡需要的键（中英各一份），并清掉不再使用的 nav_dreamcatcher 键
 *
 * 不会碰的东西：style.css、登录/注册模态框、评论逻辑、其余 4 张作品卡、任何服务配置。
 *
 * 用法：node tools/deploy/patch-personal-page.mjs <源目录> <输出目录>
 *   <源目录> 里需有从 ECS 取回的 index.html / script.js
 */
import fs from 'node:fs';
import path from 'node:path';

const [srcDir, outDir] = process.argv.slice(2);
if (!srcDir || !outDir) {
  console.error('用法：node patch-personal-page.mjs <源目录> <输出目录>');
  process.exit(2);
}

const SITE_URL = 'http://shinyasuna.top:3002/';
const NAV_KEY = 'nav_dreamcatcher';

const CARD_LINES = [
  '',
  '                  <!-- 作品卡片 5：捕梦者官网（由 tools/deploy/patch-personal-page.mjs 维护） -->',
  '                  <article class="work-card">',
  '                      <div class="work-image">',
  '                          <img src="img/projects/DreamCatcher/icon.png" alt="捕梦者官网预览">',
  '                      </div>',
  '                      <div class="work-info">',
  '                          <h3 class="work-title">《捕梦者：崩坏的梦境》官方网站</h3>',
  '                          <p class="work-description" data-lang-key="work5_desc">',
  '                              Minecraft 1.20.4 纯原版大型肉鸽地图的官方网站，含关卡与道具图鉴、职业天赋、Q&amp;A、社区与留言板',
  '                          </p>',
  '                          <div class="work-tags">',
  '                              <span class="work-tag" data-lang-key="tag_map">地图</span>',
  '                              <span class="work-tag" data-lang-key="tag_website">官网</span>',
  '                              <span class="work-tag" data-lang-key="tag_version_1204">1.20.4</span>',
  '                              <span class="work-tag" data-lang-key="tag_collaborative">仅参与开发</span>',
  '                          </div>',
  `                          <a href="${SITE_URL}" class="work-link" target="_blank" rel="noopener noreferrer">`,
  '                              <span data-lang-key="view_project">查看项目</span>',
  '                              <span class="work-link-arrow">→</span>',
  '                          </a>',
  '                      </div>',
  '                  </article>',
];

const run = [];

/* ------------------------------------------------------------------ index.html */
function patchHtml(html) {
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  let out = html;
  const lines = out.split(/\r?\n/);

  // 1) 移除导航栏里的「捕梦者」（只删包含 nav_dreamcatcher 的那一行）
  const before = lines.length;
  const kept = lines.filter((line) => !(line.includes(`data-lang-key="${NAV_KEY}"`) && line.includes('<a ')));
  if (kept.length !== before) {
    run.push(`index.html：删除导航项「捕梦者」（${before - kept.length} 行）`);
    out = kept.join(eol);
  } else {
    run.push('index.html：导航栏已经是「首页 / 作品」两栏，无需改动');
  }

  // 2) 确保存在作品卡片 5
  if (!out.includes('作品卡片 5')) {
    const commentMark = '<!-- 评论区域 -->';
    const commentAt = out.indexOf(commentMark);
    if (commentAt < 0) throw new Error('找不到「评论区域」标记，已中止');
    const lastArticle = out.lastIndexOf('</article>', commentAt);
    if (lastArticle < 0) throw new Error('找不到作品卡的 </article>，已中止');
    const insertAt = out.indexOf('\n', lastArticle) + 1;
    out = `${out.slice(0, insertAt)}${CARD_LINES.join(eol)}${eol}${out.slice(insertAt)}`;
    run.push('index.html：新增作品卡片 5（捕梦者官网）');
  } else {
    // 已存在则只校准链接地址
    const stale = /href="http:\/\/shinyasuna\.top:3002\/?"/.test(out);
    out = out.replace(/<a href="http:\/\/shinyasuna\.top:3002\/?[^"]*" class="work-link"/g, `<a href="${SITE_URL}" class="work-link"`);
    run.push(`index.html：作品卡片 5 已存在${stale ? '，已校准链接地址' : ''}`);
  }
  return out;
}

/* ------------------------------------------------------------------ script.js */
const DICT_ADD = {
  zh: [
    ['work5_desc', 'Minecraft 1.20.4 纯原版大型肉鸽地图的官方网站，含关卡与道具图鉴、职业天赋、Q&A、社区与留言板'],
    ['tag_website', '官网'],
    ['tag_version_1204', '1.20.4'],
  ],
  en: [
    ['work5_desc', 'Official site of a large vanilla roguelike map for Minecraft 1.20.4: codex, classes, Q&A, community and comments'],
    ['tag_website', 'Website'],
    ['tag_version_1204', '1.20.4'],
  ],
};

function patchScript(js) {
  const eol = js.includes('\r\n') ? '\r\n' : '\n';
  let out = js;

  // 1) 清掉不再使用的 nav_dreamcatcher 词典键
  const beforeLines = out.split(/\r?\n/).length;
  out = out.split(/\r?\n/).filter((line) => !line.trim().startsWith(`${NAV_KEY}:`)).join(eol);
  const removed = beforeLines - out.split(/\r?\n/).length;
  run.push(removed ? `script.js：删除 ${removed} 处 nav_dreamcatcher 词典键` : 'script.js：无 nav_dreamcatcher 键');

  // 2) 补上作品卡 5 需要的词典键（缺哪个补哪个）
  //    ⚠️ 必须按语言分块判断：中英两个词典里键名相同，全局搜索会把"zh 已有"误判成"en 也有"
  const zhAt = out.indexOf('zh: {');
  const enAt = out.indexOf('en: {', zhAt >= 0 ? zhAt : 0);
  if (zhAt < 0 || enAt < 0 || enAt <= zhAt) throw new Error('script.js 里找不到 zh/en 两个词典块，已中止');
  const blocks = { zh: out.slice(zhAt, enAt), en: out.slice(enAt) };

  for (const [lang, entries] of Object.entries(DICT_ADD)) {
    const anchor = lang === 'zh' ? 'nav_works: "作品",' : 'nav_works: "Works",';
    if (!out.includes(anchor)) throw new Error(`script.js 找不到 ${lang} 词典锚点：${anchor}`);
    const block = blocks[lang];
    const missing = entries.filter(([key]) => !new RegExp(`(^|\\n)\\s*${key}\\s*:`).test(block));
    if (!missing.length) { run.push(`script.js：${lang} 词典键已齐`); continue; }
    const injected = missing.map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`).join(eol);
    out = out.replace(anchor, `${anchor}${eol}${injected}`);
    run.push(`script.js：${lang} 词典补 ${missing.length} 个键（${missing.map(([k]) => k).join(', ')}）`);
    // 补完后同步刷新分块，避免同一轮里重复判断
    const zhAt2 = out.indexOf('zh: {');
    const enAt2 = out.indexOf('en: {', zhAt2);
    blocks.zh = out.slice(zhAt2, enAt2);
    blocks.en = out.slice(enAt2);
  }
  return out;
}

const html = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(srcDir, 'script.js'), 'utf8');
const newHtml = patchHtml(html);
const newJs = patchScript(js);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), newHtml, 'utf8');
fs.writeFileSync(path.join(outDir, 'script.js'), newJs, 'utf8');

const stats = (s) => ({
  bytes: Buffer.byteLength(s, 'utf8'),
  navItems: (s.match(/<a href="#[a-z]+" class="nav-link/g) || []).length,
  workCards: (s.match(/<article class="work-card">/g) || []).length,
  siteLinks: (s.match(/shinyasuna\.top:3002/g) || []).length,
});

console.log('改动明细：');
for (const line of run) console.log('  · ' + line);
console.log('');
console.log('index.html  ', JSON.stringify(stats(html)), '→', JSON.stringify(stats(newHtml)));
console.log('script.js   ', Buffer.byteLength(js, 'utf8'), '→', Buffer.byteLength(newJs, 'utf8'), 'bytes');
console.log('输出目录：', outDir);
