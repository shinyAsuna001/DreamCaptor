/**
 * verify/http-check.mjs —— HTTP 层自检（**AI 自己跑，不需要浏览器**）
 *
 * 用 Node 内置 http 直接请求各页面，断言状态码、内容快照与响应体大小。
 * 额外做的（仍属 HTTP 层，不碰浏览器）：
 *   - 静态资源可达性：把 index.html 里引用的 css/js/图片逐个请求
 *   - gzip 是否生效（比较传输字节与解压后字节）
 *   - 前端「图片位」承诺的路径列表（哪些已放图、哪些待用户补）
 *   - 每页 HTML 是否注入了内容快照、响应体大小
 *
 * 用法：
 *   node tools/verify/http-check.mjs                       # 默认 http://127.0.0.1:4173
 *   node tools/verify/http-check.mjs --base http://127.0.0.1:3002
 * 输出：控制台表格 + tools/verify/http-report.json
 */

import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(HERE, '..', '..');
const REPORT = path.join(HERE, 'http-report.json');

const args = process.argv.slice(2);
const readArg = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = readArg('--base', 'http://127.0.0.1:4173').replace(/\/$/, '');
// --public：目标是公网地址（线上冒烟）。此时后台接口"应当"返回 404（仅本机可访问），
// 这不是失败，而是预期，所以单列出来判断。
const PUBLIC = args.includes('--public');
const url = new URL(BASE);

const PAGES = [
  ['/', '首页'],
  ['/intro', '地图介绍'],
  ['/wiki', '百科目录'],
  ['/wiki/levels', '百科·关卡'],
  ['/wiki/items', '百科·物品'],
  ['/wiki/classes', '百科·职业与天赋'],
  ['/wiki/enemies', '百科·敌人（空态）'],
  ['/wiki/difficulty', '百科·难度（空态）'],
  ['/faq', 'Q&A'],
  ['/download', '下载'],
  ['/community', '社区'],
  ['/sponsor', '赞助'],
  ['/about', '制作组'],
  ['/login', '登录'],
  ['/comments', '留言板'],
];

const APIS = [
  ['/api/health', '健康检查'],
  ['/api/content', '内容快照'],
  ['/api/content/version', '内容版本'],
  ['/api/wiki/wiki-levels', '关卡数据'],
  ['/api/wiki/wiki-items', '物品数据'],
  ['/api/wiki/wiki-classes', '职业数据'],
  ['/api/wiki/wiki-faq', 'FAQ 数据'],
  ['/api/comments', '评论列表'],
  ['/api/admin/session', '后台会话（本机）'],
];

/** 期望存在的站点素材（缺图会被记为 warn 而不是 fail，因为图片位本来就是留给用户的） */
const EXPECTED_ASSETS = [
  '/assets/img/logo-512.webp',
  '/assets/img/logo-256.webp',
  '/assets/img/favicon-64.png',
  '/assets/img/apple-touch-180.png',
  '/assets/img/wiki/bow-damage-table.webp',
];

function fetchRaw(pathname, { acceptGzip = true } = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      host: url.hostname,
      port: url.port || 80,
      path: pathname,
      method: 'GET',
      headers: { 'Accept-Encoding': acceptGzip ? 'gzip' : 'identity', 'User-Agent': 'dream-http-check/1.0' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        let decoded = body;
        if (res.headers['content-encoding'] === 'gzip') {
          try { decoded = zlib.gunzipSync(body); } catch { decoded = body; }
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          bytes: body.length,
          decodedBytes: decoded.length,
          text: decoded.slice(0, 400000).toString('utf8'),
        });
      });
    });
    req.on('error', (err) => resolve({ status: 0, error: err.message, bytes: 0, decodedBytes: 0, text: '', headers: {} }));
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

function kb(n) { return `${(n / 1024).toFixed(1)} KB`; }

async function main() {
  const report = { base: BASE, at: new Date().toISOString(), pages: [], apis: [], assets: [], gzip: [], notes: [] };
  let fail = 0;
  let warn = 0;

  console.log(`=== HTTP 层自检 @ ${BASE} ===\n`);
  console.log('【页面】');
  console.log('  状态  页面                     传输      解压后    注入快照');
  for (const [p, label] of PAGES) {
    const r = await fetchRaw(p);
    const injected = r.text.includes('__DREAM_CONTENT__');
    const ok = r.status === 200 && injected && r.decodedBytes > 2000;
    if (!ok) fail += 1;
    report.pages.push({ path: p, label, status: r.status, bytes: r.bytes, decodedBytes: r.decodedBytes, injected, ok });
    console.log(`  ${ok ? '✓' : '✗'} ${String(r.status).padEnd(4)} ${label.padEnd(22)} ${kb(r.bytes).padStart(9)} ${kb(r.decodedBytes).padStart(10)}   ${injected ? 'yes' : 'NO'}`);
  }

  console.log('\n【API】');
  for (const [p, label] of APIS) {
    const r = await fetchRaw(p);
    const isAdminProbe = p === '/api/admin/session';
    let ok = r.status === 200;
    let extra = '';
    if (isAdminProbe && PUBLIC) {
      // 公网访问后台接口必须是 404（仅 127.0.0.1 可访问）
      ok = r.status === 404;
      extra = ok ? '公网访问后台 → 404（正确，仅本机可访问）' : '⚠️ 公网竟能访问后台！';
    }
    try {
      if (!(isAdminProbe && PUBLIC)) {
        const j = JSON.parse(r.text);
        ok = ok && j.ok !== false;
        if (p === '/api/content') extra = `dataVersion=${j.data.content.meta.dataVersion} unresolved=${(j.data.unresolved || []).length}`;
        else if (p.startsWith('/api/wiki/')) {
          const d = j.data || {};
          const counts = ['chapters', 'levels', 'items', 'classes', 'sections', 'groups'].filter((k) => Array.isArray(d[k])).map((k) => `${k}=${d[k].length}`);
          extra = counts.join(' ');
        } else if (p === '/api/comments') extra = `total=${j.data.total}`;
      }
    } catch { if (!(isAdminProbe && PUBLIC)) { ok = false; extra = 'JSON 解析失败'; } }
    if (!ok) fail += 1;
    report.apis.push({ path: p, label, status: r.status, bytes: r.bytes, ok, extra });
    console.log(`  ${ok ? '✓' : '✗'} ${String(r.status).padEnd(4)} ${label.padEnd(20)} ${kb(r.bytes).padStart(9)}  ${extra}`);
  }

  console.log('\n【站点素材】');
  for (const a of EXPECTED_ASSETS) {
    const r = await fetchRaw(a, { acceptGzip: false });
    const ok = r.status === 200;
    if (!ok) warn += 1;
    report.assets.push({ path: a, status: r.status, bytes: r.bytes, ok });
    console.log(`  ${ok ? '✓' : '!'} ${String(r.status).padEnd(4)} ${a.padEnd(44)} ${kb(r.bytes).padStart(9)}`);
  }

  console.log('\n【前端引用的静态资源可达性】');
  const indexHtml = (await fetchRaw('/')).text;
  const refs = [...indexHtml.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((m) => m[1]);
  const unique = [...new Set(refs)].filter((r) => !r.startsWith('/api'));
  for (const ref of unique) {
    const r = await fetchRaw(ref, { acceptGzip: false });
    const ok = r.status === 200;
    if (!ok) fail += 1;
    report.assets.push({ path: ref, status: r.status, bytes: r.bytes, ok, from: 'index.html' });
    console.log(`  ${ok ? '✓' : '✗'} ${String(r.status).padEnd(4)} ${ref.padEnd(44)} ${kb(r.bytes).padStart(9)}`);
  }

  console.log('\n【gzip】');
  for (const p of ['/', '/js/main.js', '/css/base.css', '/api/content']) {
    const gz = await fetchRaw(p, { acceptGzip: true });
    const raw = await fetchRaw(p, { acceptGzip: false });
    const ratio = raw.bytes ? ((1 - gz.bytes / raw.bytes) * 100).toFixed(0) : '0';
    const ok = gz.bytes <= raw.bytes;
    report.gzip.push({ path: p, gzipBytes: gz.bytes, rawBytes: raw.bytes, savedPercent: Number(ratio) });
    console.log(`  ${ok ? '✓' : '!'} ${p.padEnd(16)} 传输 ${kb(gz.bytes).padStart(9)}  原始 ${kb(raw.bytes).padStart(9)}  省 ${ratio}%`);
  }

  /* 首屏体积估算：HTML + 5 个 CSS + 入口 JS（不含按需加载的视图） */
  const firstPaint = ['/', '/css/tokens.css', '/css/base.css', '/css/components.css', '/css/pages.css', '/css/motion.css', '/js/main.js'];
  let total = 0;
  for (const p of firstPaint) {
    const r = await fetchRaw(p, { acceptGzip: true });
    total += r.bytes;
  }
  const html = await fetchRaw('/', { acceptGzip: true });
  report.notes.push(`首屏（HTML+CSS+入口JS，gzip 后）合计约 ${kb(total)}（其中 HTML ${kb(html.bytes)}）`);

  /* 待用户补的图片位清单 */
  const slots = JSON.parse(fs.readFileSync(path.join(SITE_ROOT, 'data', 'wiki-levels.json'), 'utf8'));
  const missingSlots = [];
  for (const c of slots.chapters || []) missingSlots.push(c.image);
  for (const l of slots.levels || []) missingSlots.push(l.image);
  for (const s of missingSlots.filter(Boolean)) {
    const r = await fetchRaw(s, { acceptGzip: false });
    report.assets.push({ path: s, status: r.status, bytes: r.bytes, ok: r.status === 200, slot: true });
  }
  const missing = report.assets.filter((a) => a.slot && !a.ok).length;
  report.notes.push(`关卡图片位：共 ${missingSlots.length} 个，其中 ${missing} 个还没放图（前台显示虚线占位框）`);
  console.log(`\n【图片位】关卡/大关共 ${missingSlots.length} 个路径，其中 ${missing} 个待补（前台渲染占位框）`);

  console.log(`\n=== 结果：页面/接口/资源失败 ${fail} 项，素材缺失(警告) ${warn} 项 ===`);
  console.log('备注：' + report.notes.join('；'));
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8');
  console.log(`报告已写入：${REPORT}`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('自检脚本异常：', err); process.exit(2); });
