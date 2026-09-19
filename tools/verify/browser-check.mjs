/**
 * verify/browser-check.mjs —— 浏览器端逐页验证（需要本机已安装 Chrome）
 *
 * 与 http-check.mjs 的分工：那一层只发 HTTP 请求，检查不了布局、样式、图片解码与动画终态；
 * 这一层用真实浏览器逐页打开、截图并断言，用来确认"页面确实渲染出来了"而不只是"返回 200"。
 *
 * 前置依赖：`playwright-core`（**只是驱动库，不会下载任何浏览器二进制**）。
 * 查找顺序：环境变量 `PLAYWRIGHT_CORE` → 仓库内 `node_modules/playwright-core` →
 * Node 模块解析（全局或上级目录安装的副本）。浏览器一律用 `channel: 'chrome'`
 * 驱动系统已装的 Chrome，因此不需要 `npx playwright install`。
 *
 * 它做什么：
 *   1. 逐页访问，断言 HTTP 200；
 *   2. 挂 console / pageerror / requestfailed / 4xx-5xx 响应，收集全部错误；
 *   3. 桌面 1920×1080 + 移动 390×844 各截一遍，存到 tools/verify/shots/；
 *   4. 交互校验：中英切换、物品页搜索、关卡图片位占位框；
 *   5. 断言每页 #app 有实际内容（避免"白屏但 200"）；
 *   6. 生成 tools/verify/report.md（通过项 / 失败项 / 错误明细 / 截图清单）。
 *
 * 用法（在仓库目录下）：
 *   node tools\verify\browser-check.mjs
 *   node tools\verify\browser-check.mjs --base http://127.0.0.1:4173
 *   node tools\verify\browser-check.mjs --headed        # 显示浏览器窗口
 *   node tools\verify\browser-check.mjs --only /wiki/items
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(HERE, '..', '..');
const SHOT_DIR = path.join(HERE, 'shots');
const REPORT_MD = path.join(HERE, 'report.md');
const REPORT_JSON = path.join(HERE, 'report.json');

/** 依次尝试：显式指定 → 仓库内安装 → Node 模块解析 */
function findPlaywrightCore() {
  const explicit = [
    process.env.PLAYWRIGHT_CORE,
    path.join(SITE_ROOT, 'node_modules', 'playwright-core'),
  ].filter(Boolean);
  for (const p of explicit) {
    try { if (fs.existsSync(p)) return p; } catch { /* 忽略 */ }
  }
  try {
    return path.dirname(require.resolve('playwright-core/package.json', { paths: [SITE_ROOT, HERE] }));
  } catch { /* 未安装 */ }
  return null;
}

const PW_PATH = findPlaywrightCore();

const args = process.argv.slice(2);
const readArg = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = readArg('--base', process.env.SITE_BASE || 'http://127.0.0.1:4173').replace(/\/$/, '');
const HEADED = args.includes('--headed');
const ONLY = readArg('--only', null);

const ROUTES = [
  { path: '/', name: '01-home', expect: ['捕梦者'] },
  { path: '/intro', name: '02-intro', expect: ['配置要求'] },
  { path: '/wiki', name: '03-wiki', expect: ['关卡'] },
  { path: '/wiki/levels', name: '04-wiki-levels', expect: ['最浅层', '树林'] },
  { path: '/wiki/items', name: '05-wiki-items', expect: ['等阶'] },
  { path: '/wiki/classes', name: '06-wiki-classes', expect: ['医生'] },
  { path: '/wiki/enemies', name: '07-wiki-enemies', expect: ['整理中'] },
  { path: '/wiki/difficulty', name: '08-wiki-difficulty', expect: ['整理中'] },
  { path: '/faq', name: '09-faq', expect: ['地图怎么下载'] },
  { path: '/download', name: '10-download', expect: ['安装步骤'] },
  { path: '/community', name: '11-community', expect: ['1080211664'] },
  { path: '/sponsor', name: '12-sponsor', expect: ['爱发电'] },
  { path: '/about', name: '13-about', expect: ['弱智苦力怕'] },
  { path: '/login', name: '14-login', expect: ['登录'] },
  { path: '/comments', name: '15-comments', expect: ['留言'] },
];

const VIEWPORTS = [
  { id: 'desktop', width: 1920, height: 1080 },
  { id: 'mobile', width: 390, height: 844 },
];

function adminPath() {
  try {
    const env = fs.readFileSync(path.join(SITE_ROOT, '.env'), 'utf8');
    const m = env.match(/^ADMIN_PATH=(.+)$/m);
    return m ? `/${m[1].trim()}` : null;
  } catch { return null; }
}

/** 后台口令（只在本机、且本机存在明文口令文件时可用；不会打印到任何输出里） */
function adminPassword() {
  try {
    const plain = fs.readFileSync(path.join(SITE_ROOT, '.admin-password.txt'), 'utf8');
    const m = plain.match(/^口令：(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

const isLocalBase = () => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(BASE);

async function main() {
  if (!PW_PATH) {
    console.error([
      '找不到 playwright-core（浏览器驱动库，不会下载浏览器二进制）。',
      '任选一种方式让它可被找到：',
      '  1) 在仓库内安装：npm i -D playwright-core',
      '  2) 设置环境变量指向已有的副本：',
      '     PowerShell:  $env:PLAYWRIGHT_CORE = "<path>\\node_modules\\playwright-core"',
      '     cmd:         set PLAYWRIGHT_CORE=<path>\\node_modules\\playwright-core',
      '  3) 全局安装：npm i -g playwright-core（随后本脚本会用 Node 模块解析找到它）',
    ].join('\n'));
    process.exit(2);
  }
  const { chromium } = require(PW_PATH);

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  // 清掉上一轮截图，避免把旧图当新结果
  for (const f of fs.readdirSync(SHOT_DIR)) {
    if (f.endsWith('.png')) fs.unlinkSync(path.join(SHOT_DIR, f));
  }

  console.log(`=== 浏览器验证 @ ${BASE} ===`);
  console.log('用 channel: "chrome" 驱动系统 Chrome（不下载任何浏览器二进制）');

  const browser = await chromium.launch({ channel: 'chrome', headless: !HEADED });
  const results = [];
  const shots = [];

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      locale: 'zh-CN',
    });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    const badResponses = [];

    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('requestfailed', (req) => failedRequests.push(`${req.url()} — ${req.failure()?.errorText || ''}`));
    page.on('response', (res) => { if (res.status() >= 400) badResponses.push(`${res.status()} ${res.url()}`); });

    const routes = ONLY ? ROUTES.filter((r) => r.path === ONLY) : ROUTES;
    for (const route of routes) {
      consoleErrors.length = 0; pageErrors.length = 0; failedRequests.length = 0; badResponses.length = 0;
      const t0 = Date.now();
      const issues = [];
      let status = 0;
      let text = '';
      try {
        const res = await page.goto(BASE + route.path, { waitUntil: 'domcontentloaded', timeout: 20000 });
        status = res ? res.status() : 0;
        await page.waitForFunction(() => {
          const app = document.getElementById('app');
          return app && app.textContent.trim().length > 40;
        }, { timeout: 8000 }).catch(() => issues.push('8s 内 #app 没有内容（可能白屏）'));
        await page.waitForTimeout(route.path.startsWith('/wiki/') ? 900 : 350);
        text = await page.locator('#app').innerText().catch(() => '');
      } catch (err) {
        issues.push(`导航失败：${err.message}`);
      }
      const missing = (route.expect || []).filter((w) => !text.includes(w));
      if (status !== 200) issues.push(`HTTP ${status}`);
      if (missing.length) issues.push(`缺少预期文案：${missing.join('、')}`);
      if (consoleErrors.length) issues.push(`console.error×${consoleErrors.length}`);
      if (pageErrors.length) issues.push(`pageerror×${pageErrors.length}`);
      if (badResponses.length) issues.push(`4xx/5xx×${badResponses.length}`);
      if (failedRequests.length) issues.push(`请求失败×${failedRequests.length}`);

      const shot = path.join(SHOT_DIR, `${route.name}-${vp.id}.png`);
      await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
      shots.push(path.relative(SITE_ROOT, shot).replace(/\\/g, '/'));

      results.push({
        viewport: vp.id, path: route.path, name: route.name, status,
        ms: Date.now() - t0, ok: issues.length === 0, issues,
        detail: { missing, consoleErrors: [...consoleErrors], pageErrors: [...pageErrors], badResponses: [...badResponses], failedRequests: [...failedRequests] },
      });
      console.log(`  ${issues.length === 0 ? '[PASS]' : '[FAIL]'} ${vp.id.padEnd(8)} ${route.path.padEnd(18)} ${String(Date.now() - t0).padStart(5)}ms ${issues.join(' | ')}`);
    }

    /* ---------------- 交互校验（只在桌面端做一次） ---------------- */
    if (vp.id === 'desktop') {
      // 语言切换
      try {
        await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(400);
        await page.click('#langToggle');
        await page.waitForTimeout(600);
        const lang = await page.getAttribute('html', 'lang');
        const nav = await page.locator('#navList').innerText().catch(() => '');
        const okLang = lang === 'en' && /Home|About|Codex/.test(nav);
        await page.screenshot({ path: path.join(SHOT_DIR, '90-home-english.png') });
        shots.push('tools/verify/shots/90-home-english.png');
        results.push({ viewport: 'desktop', path: '/ (语言切换)', name: '90-lang-toggle', status: 200, ms: 0, ok: okLang, issues: okLang ? [] : [`切换后 html lang=${lang}，导航=${nav.replace(/\n/g, '/')}`], detail: {} });
        console.log(`  ${okLang ? '[PASS]' : '[FAIL]'} desktop  语言切换中→英`);
        await page.click('#langToggle');
        await page.waitForTimeout(400);
      } catch (err) {
        results.push({ viewport: 'desktop', path: '/ (语言切换)', name: '90-lang-toggle', status: 0, ms: 0, ok: false, issues: [err.message], detail: {} });
        console.log(`  [FAIL] desktop  语言切换：${err.message}`);
      }

      // 物品页搜索
      try {
        await page.goto(BASE + '/wiki/items', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1400);
        const before = await page.locator('.item-card').count();
        await page.fill('input[type="search"]', '猎');
        await page.waitForTimeout(600);
        const after = await page.locator('.item-card').count();
        const count = await page.locator('.result-count').innerText().catch(() => '');
        const okSearch = before > 0 && after > 0 && after <= before;
        await page.screenshot({ path: path.join(SHOT_DIR, '91-items-search.png') });
        shots.push('tools/verify/shots/91-items-search.png');
        results.push({ viewport: 'desktop', path: '/wiki/items (搜索)', name: '91-items-search', status: 200, ms: 0, ok: okSearch, issues: okSearch ? [] : [`${before} → ${after}（${count}）`], detail: {} });
        console.log(`  ${okSearch ? '[PASS]' : '[FAIL]'} desktop  物品搜索（${before} → ${after}）`);
        await page.fill('input[type="search"]', '');
      } catch (err) {
        results.push({ viewport: 'desktop', path: '/wiki/items (搜索)', name: '91-items-search', status: 0, ms: 0, ok: false, issues: [err.message], detail: {} });
        console.log(`  [FAIL] desktop  物品搜索：${err.message}`);
      }

      // 关卡图片位占位框
      try {
        await page.goto(BASE + '/wiki/levels', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);
        const slots = await page.locator('.slot-missing').count();
        await page.screenshot({ path: path.join(SHOT_DIR, '92-levels-slots.png') });
        shots.push('tools/verify/shots/92-levels-slots.png');
        console.log(`  [INFO] desktop  关卡图片位占位框：${slots} 个（放了图之后这个数字会下降）`);
        results.push({ viewport: 'desktop', path: '/wiki/levels (图片位)', name: '92-levels-slots', status: 200, ms: 0, ok: true, issues: [], detail: { slots } });
      } catch (err) { /* 忽略 */ }

      // 后台页（仅本机）
      const ap = adminPath();
      if (ap) {
        try {
          await page.goto(BASE + ap, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(700);
          const hasLogin = await page.locator('.admin-login').count();
          await page.screenshot({ path: path.join(SHOT_DIR, '93-admin-login.png') });
          shots.push('tools/verify/shots/93-admin-login.png');
          results.push({ viewport: 'desktop', path: ap, name: '93-admin-login', status: 200, ms: 0, ok: hasLogin > 0, issues: hasLogin ? [] : ['后台登录表单没渲染出来'], detail: {} });
          console.log(`  ${hasLogin ? '[PASS]' : '[FAIL]'} desktop  后台登录页（仅本机）`);
        } catch (err) {
          results.push({ viewport: 'desktop', path: ap, name: '93-admin-login', status: 0, ms: 0, ok: false, issues: [err.message], detail: {} });
        }

        // 登录后台 → 外观面板（滑块实时预览）。**只预览、不保存**，不会改动线上任何数据。
        const pw = adminPassword();
        if (isLocalBase() && pw) {
          try {
            await page.goto(BASE + ap, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(500);
            if (await page.locator('.admin-login input[type="password"]').count()) {
              await page.fill('.admin-login input[type="password"]', pw);
              await page.click('.admin-login button[type="submit"]');
              await page.waitForTimeout(1200);
            }
            await page.click('.admin-tabs .chip[data-tab="theme"]');
            await page.waitForTimeout(500);
            const sliders = await page.locator('.theme-row input[type="range"]').count();
            if (sliders !== 5) throw new Error(`外观面板应有 5 个滑块，实际 ${sliders}`);

            // 拖第一个滑块（底图不透明度）到 0.5，断言实时预览写进了 :root
            await page.locator('.theme-row input[type="range"]').first().evaluate((node) => {
              node.value = '0.5';
              node.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await page.waitForTimeout(200);
            const previewed = await page.evaluate(() => document.documentElement.style.getPropertyValue('--bg-opacity').trim());
            if (previewed !== '0.5') throw new Error(`实时预览未生效：--bg-opacity = "${previewed}"`);

            // 点「恢复出厂默认」应把第一格填回 0.78（同样只是填表，不保存）
            await page.click('.admin-panel button:has-text("恢复出厂默认")');
            await page.waitForTimeout(200);
            const restored = await page.locator('.theme-row input[type="range"]').first().inputValue();
            if (Number(restored).toFixed(2) !== '0.78') throw new Error(`恢复出厂默认没生效：第一个滑块 = ${restored}`);

            await page.screenshot({ path: path.join(SHOT_DIR, '94-admin-theme.png') });
            shots.push('tools/verify/shots/94-admin-theme.png');
            results.push({ viewport: 'desktop', path: `${ap} (外观)`, name: '94-admin-theme', status: 200, ms: 0, ok: true, issues: [], detail: { sliders, previewed } });
            console.log(`  [PASS] desktop  后台「外观」面板（${sliders} 个滑块，实时预览 --bg-opacity=${previewed}）`);

            // 收尾：退出登录，避免留下会话
            await page.click('button:has-text("退出后台")').catch(() => {});
            await page.waitForTimeout(400);
          } catch (err) {
            results.push({ viewport: 'desktop', path: `${ap} (外观)`, name: '94-admin-theme', status: 0, ms: 0, ok: false, issues: [err.message], detail: {} });
            console.log(`  [FAIL] desktop  后台「外观」面板：${err.message}`);
          }
        } else {
          console.log(`  [INFO] desktop  跳过后台「外观」面板交互检查（${isLocalBase() ? '缺 .admin-password.txt' : '非本机地址'}）`);
        }
      }
    }

    await context.close();
  }

  await browser.close();

  /* ---------------- 报告 ---------------- */
  const failed = results.filter((r) => !r.ok);
  const lines = [];
  lines.push('# 本地浏览器验证报告');
  lines.push('');
  lines.push(`- 时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push(`- 地址：${BASE}`);
  lines.push(`- 浏览器：系统 Chrome（playwright-core channel: "chrome"，未下载任何浏览器二进制）`);
  lines.push(`- 视口：桌面 1920×1080 + 移动 390×844`);
  lines.push('');
  lines.push(`## 结果：通过 ${results.length - failed.length} / 失败 ${failed.length}`);
  lines.push('');
  lines.push('| 视口 | 页面 | 状态码 | 耗时 | 结果 |');
  lines.push('|---|---|---|---|---|');
  for (const r of results) {
    lines.push(`| ${r.viewport} | \`${r.path}\` | ${r.status || '—'} | ${r.ms}ms | ${r.ok ? '✅' : '❌'} |`);
  }
  lines.push('');
  if (failed.length) {
    lines.push('## 失败明细');
    lines.push('');
    for (const r of failed) {
      lines.push(`### ${r.viewport} ${r.path}`);
      for (const i of r.issues) lines.push(`- ${i}`);
      const d = r.detail || {};
      for (const key of ['consoleErrors', 'pageErrors', 'badResponses', 'failedRequests']) {
        if ((d[key] || []).length) {
          lines.push(`- ${key}：`);
          for (const v of d[key].slice(0, 10)) lines.push(`  - \`${v}\``);
        }
      }
      lines.push('');
    }
  } else {
    lines.push('## 失败明细');
    lines.push('');
    lines.push('无。');
    lines.push('');
  }
  const slotInfo = results.find((r) => r.name === '92-levels-slots');
  lines.push('## 已知情况');
  lines.push('');
  lines.push(`- 关卡/大关图片位占位框：${slotInfo && slotInfo.detail ? slotInfo.detail.slots : '—'} 个（把图放进对应路径后会自动显示）`);
  lines.push('- 图片位路径清单见 `_design/要你补的图片与文字.md`');
  lines.push('');
  lines.push('## 截图清单（tools/verify/shots/）');
  lines.push('');
  for (const s of shots) lines.push(`- \`${s}\``);
  lines.push('');
  lines.push('> 把这份 report.md 和 shots 目录一起交给 AI，AI 会用 read_image 逐张看图确认排版与素材。');
  lines.push('');
  fs.writeFileSync(REPORT_MD, lines.join('\n'), 'utf8');
  fs.writeFileSync(REPORT_JSON, JSON.stringify({ base: BASE, at: new Date().toISOString(), results, shots }, null, 2), 'utf8');

  console.log('');
  console.log(`=== 结果：通过 ${results.length - failed.length} / 失败 ${failed.length} ===`);
  console.log(`报告：${REPORT_MD}`);
  console.log(`截图：${SHOT_DIR}`);
  console.log('请把 report.md 与 shots 目录交给 AI 读图确认。');
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('验证脚本异常：', err);
  process.exit(2);
});
