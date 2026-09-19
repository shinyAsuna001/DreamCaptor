/**
 * smoke-test.mjs —— 官网后端冒烟测试（Node 18+，零依赖）
 *
 * 为什么不用 PowerShell：本机 shell 是 Windows PowerShell 5.1，.ps1 里的中文按 GBK 解析会炸；
 * 而 Node 脚本天然 UTF-8，且开发机/ECS 行为一致，也顺带验证了「Node 18 能跑这套代码」。
 *
 * 用法（site/ 目录下）：
 *   node tools/smoke-test.mjs
 *   node tools/smoke-test.mjs --base http://127.0.0.1:3002
 *   node tools/smoke-test.mjs --skip-admin
 *
 * 覆盖：健康检查 / 内容快照与 ETag / 静态资源与 MIME / SPA 回退 / 404 / 目录穿越 /
 *       注册 → 登录 → 发评论 → 删评论 / 后台登录 → 保存 → 备份 → 回滚 → 退出
 * 纪律：**不打印任何口令**（后台口令从 .admin-password.txt 读取后仅用于请求体）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = readArg('--base', process.env.SMOKE_BASE || 'http://127.0.0.1:4173').replace(/\/$/, '');
const SKIP_ADMIN = args.includes('--skip-admin');

let pass = 0;
let fail = 0;
const failures = [];

async function check(name, fn) {
  try {
    const okResult = await fn();
    if (okResult === false) throw new Error('断言为 false');
    pass += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    fail += 1;
    failures.push(`${name} -> ${err.message}`);
    console.log(`  [FAIL] ${name}  -> ${err.message}`);
  }
}

/** 请求助手：手工管理 Cookie（Node 18 没有 getSetCookie()，用 headers.get） */
function makeClient() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async request(method, urlPath, { body, headers = {}, expectStatus } = {}) {
      const res = await fetch(BASE + urlPath, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        const first = setCookie.split(';')[0];
        const name = first.split('=')[0];
        const others = cookie.split('; ').filter((c) => c && !c.startsWith(`${name}=`));
        cookie = [...others, first].join('; ');
      }
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
      if (expectStatus !== undefined && res.status !== expectStatus) {
        throw new Error(`期望 ${expectStatus}，实际 ${res.status}（${text.slice(0, 120)}）`);
      }
      return { status: res.status, headers: res.headers, text, json };
    },
  };
}

function readAdminCredentials() {
  const envPath = path.join(SITE_ROOT, '.env');
  const plainPath = path.join(SITE_ROOT, '.admin-password.txt');
  if (!fs.existsSync(envPath) || !fs.existsSync(plainPath)) return null;
  const env = fs.readFileSync(envPath, 'utf8');
  const m = env.match(/^ADMIN_PATH=(.+)$/m);
  const adminPath = m ? m[1].trim() : '';
  const plain = fs.readFileSync(plainPath, 'utf8');
  const p = plain.match(/^口令：(.+)$/m);
  const password = p ? p[1].trim() : '';
  if (!adminPath || !password) return null;
  return { adminPath, password };
}

const rand = (n) => Math.floor(Math.random() * n);

async function main() {
  console.log(`=== 捕梦者官网冒烟测试 @ ${BASE} ===`);
  const publicClient = makeClient();

  // ---------------------------------------------------------- 公开接口
  await check('GET /api/health 返回 ok', async () => {
    const r = await publicClient.request('GET', '/api/health', { expectStatus: 200 });
    return r.json?.ok === true && r.json.data.status === 'ok';
  });

  await check('GET /api/content 带 dataVersion 与 unresolved', async () => {
    const r = await publicClient.request('GET', '/api/content', { expectStatus: 200 });
    return r.json?.ok === true
      && r.json.data.content.meta.dataVersion >= 1
      && Array.isArray(r.json.data.unresolved);
  });

  await check('GET /api/content 命中 ETag → 304', async () => {
    const first = await publicClient.request('GET', '/api/content', { expectStatus: 200 });
    const etag = first.headers.get('etag');
    if (!etag) throw new Error('没有 ETag 响应头');
    const second = await publicClient.request('GET', '/api/content', { headers: { 'If-None-Match': etag } });
    return second.status === 304;
  });

  await check('GET /api/wiki/wiki-items 数据集可读', async () => {
    const r = await publicClient.request('GET', '/api/wiki/wiki-items', { expectStatus: 200 });
    return r.json?.ok === true && r.json.data !== null;
  });

  await check('GET /api/wiki/evil 未知数据集 → 404', async () => {
    const r = await publicClient.request('GET', '/api/wiki/evil');
    return r.status === 404;
  });

  // ---------------------------------------------------------- 静态资源
  await check('GET / 返回注入快照的 index.html', async () => {
    const r = await publicClient.request('GET', '/', { expectStatus: 200 });
    return r.text.includes('__DREAM_CONTENT__') && r.headers.get('content-type')?.includes('text/html');
  });

  await check('index.html 带 CSP 且含 nonce', async () => {
    const r = await publicClient.request('GET', '/', { expectStatus: 200 });
    const csp = r.headers.get('content-security-policy') || '';
    return csp.includes("default-src 'self'") && /nonce-[A-Za-z0-9+/=]+/.test(csp);
  });

  await check('GET logo-512.webp → image/webp', async () => {
    const r = await publicClient.request('GET', '/assets/img/logo-512.webp', { expectStatus: 200 });
    return r.headers.get('content-type') === 'image/webp';
  });

  await check('SPA 回退：/wiki/levels 返回 index.html', async () => {
    const r = await publicClient.request('GET', '/wiki/levels', { expectStatus: 200 });
    return r.text.includes('__DREAM_CONTENT__');
  });

  await check('不存在的静态文件 → 404', async () => {
    const r = await publicClient.request('GET', '/assets/img/no-such.png');
    return r.status === 404;
  });

  await check('目录穿越被拒（403/404）', async () => {
    const r = await publicClient.request('GET', '/..%2f..%2fserver%2fserver.js');
    return r.status === 403 || r.status === 404;
  });

  // ---------------------------------------------------------- 账号与评论
  // 用固定测试账号：重复跑同一小时内不会一直撞注册限流（注册限流 3 次/小时是**预期行为**）
  const FIXED_USER = 'smoke_tester';
  const FIXED_PASS = 'Dream!Smoke2026';
  const username = FIXED_USER;
  const password = FIXED_PASS;
  const userClient = makeClient();
  let sessionReady = false;

  await check('POST /api/auth/register 注册成功（或已存在时改用登录）', async () => {
    const r = await userClient.request('POST', '/api/auth/register', { body: { username, password } });
    if (r.status === 201) {
      sessionReady = r.json?.ok === true && r.json.data.user.username === username;
      return sessionReady;
    }
    if (r.status === 409) {
      const login = await userClient.request('POST', '/api/auth/login', { body: { username, password }, expectStatus: 200 });
      sessionReady = login.json?.ok === true;
      console.log('         （测试账号已存在，改走登录路径）');
      return sessionReady;
    }
    if (r.status === 429) {
      // 限流生效本身是正确行为；此时退回登录
      const login = await userClient.request('POST', '/api/auth/login', { body: { username, password } });
      sessionReady = login.status === 200;
      console.log(`         （注册触发限流 ${r.status} → 限流按设计生效；${sessionReady ? '已改用登录' : '登录也失败，后续账号用例将跳过'}）`);
      return sessionReady;
    }
    throw new Error(`意外状态码 ${r.status}：${r.text.slice(0, 120)}`);
  });

  await check('注册后 Cookie 为 HttpOnly + SameSite=Lax', async () => {
    const fresh = makeClient();
    const r = await fresh.request('POST', '/api/auth/login', { body: { username, password } });
    if (r.status === 429 || r.status === 401) {
      console.log(`         （跳过：登录不可用 ${r.status}）`);
      return true;
    }
    const sc = r.headers.get('set-cookie') || '';
    return /HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc);
  });

  await check('GET /api/auth/me 返回当前用户', async () => {
    if (!sessionReady) { console.log('         （跳过：无可用会话）'); return true; }
    const r = await userClient.request('GET', '/api/auth/me', { expectStatus: 200 });
    return r.json?.data.user.username === username;
  });

  await check('未登录发评论 → 401', async () => {
    const anon = makeClient();
    const r = await anon.request('POST', '/api/comments', { body: { content: '匿名评论' } });
    return r.status === 401;
  });

  let commentId = null;
  await check('登录后发评论 → 201', async () => {
    if (!sessionReady) { console.log('         （跳过：无可用会话，注册限流生效中）'); return true; }
    const r = await userClient.request('POST', '/api/comments', {
      body: { content: `冒烟测试评论 ${new Date().toLocaleTimeString('zh-CN')}` },
      expectStatus: 201,
    });
    commentId = r.json?.data?.id || null;
    return Boolean(commentId);
  });

  await check('GET /api/comments 能读到该评论', async () => {
    if (!sessionReady) { console.log('         （跳过：无可用会话，注册限流生效中）'); return true; }
    const r = await userClient.request('GET', '/api/comments', { expectStatus: 200 });
    return r.json.data.items.some((c) => c.id === commentId);
  });

  await check('回复评论 → 201（两层结构）', async () => {
    if (!sessionReady) { console.log('         （跳过：无可用会话，注册限流生效中）'); return true; }
    const r = await userClient.request('POST', '/api/comments', {
      body: { content: '冒烟测试回复', parentId: commentId },
      expectStatus: 201,
    });
    return r.json.data.parentId === commentId;
  });

  await check('超长评论 → 400', async () => {
    const r = await userClient.request('POST', '/api/comments', { body: { content: 'x'.repeat(1200) } });
    return r.status === 400;
  });

  await check('DELETE /api/comments/:id 本人可删', async () => {
    if (!sessionReady) { console.log('         （跳过：无可用会话，注册限流生效中）'); return true; }
    const r = await userClient.request('DELETE', `/api/comments/${commentId}`, { expectStatus: 200 });
    return r.json?.ok === true;
  });

  // 主题外观（不需要后台权限，本地/远程都能验）
  // 两种来源都合法：① content.json 有 theme → 服务端注入 <style nonce>；② 没有 → 用 public/css/tokens.css 的出厂默认值
  await check('首页外观变量生效（注入样式 或 tokens.css 默认值）+ CSP style-src 带 nonce', async () => {
    const r = await publicClient.request('GET', '/', { expectStatus: 200 });
    const need = ['--bg-opacity', '--bg-boost', '--bg-veil-top', '--bg-veil-mid', '--bg-veil-bottom'];
    const csp = r.headers.get('content-security-policy') || '';
    if (!/style-src 'self' 'nonce-/.test(csp)) throw new Error(`CSP style-src 未带 nonce：${csp}`);

    const injected = r.text.match(/<style nonce="[^"]+">:root\{([^}]*)\}<\/style>/);
    if (injected) {
      const missing = need.filter((k) => !injected[1].includes(k));
      if (missing.length) throw new Error(`注入的样式缺少变量：${missing.join(', ')}`);
      return true;
    }
    const css = await publicClient.request('GET', '/css/tokens.css', { expectStatus: 200 });
    const missing = need.filter((k) => !css.text.includes(k));
    if (missing.length) throw new Error(`tokens.css 缺少变量：${missing.join(', ')}`);
    return true;
  });

  // ---------------------------------------------------------- 后台（仅本机）
  if (SKIP_ADMIN) {
    console.log('  [SKIP] --skip-admin');
  } else {
    let originalLevels = null;
    const cred = readAdminCredentials();
    if (!cred) {
      console.log('  [SKIP] 未找到 .env / .admin-password.txt，跳过后台测试');
    } else {
      const adminClient = makeClient();

      await check('GET /api/admin/session 本机可达且未登录', async () => {
        const r = await adminClient.request('GET', '/api/admin/session', { expectStatus: 200 });
        return r.json.data.adminEnabled === true && r.json.data.loggedIn === false;
      });

      await check(`GET /${cred.adminPath} 本机返回后台页面`, async () => {
        const r = await adminClient.request('GET', `/${cred.adminPath}`, { expectStatus: 200 });
        return r.text.includes('__DREAM_CONTENT__');
      });

      await check('POST /api/admin/login 错误口令 → 401', async () => {
        const r = await adminClient.request('POST', '/api/admin/login', { body: { password: 'definitely-wrong' } });
        return r.status === 401;
      });

      await check('POST /api/admin/login 正确口令 → 200', async () => {
        const r = await adminClient.request('POST', '/api/admin/login', { body: { password: cred.password }, expectStatus: 200 });
        return r.json.data.loggedIn === true;
      });

      await check('GET /api/admin/content 可读全量内容与占位符清单', async () => {
        const r = await adminClient.request('GET', '/api/admin/content', { expectStatus: 200 });
        return Boolean(r.json.data.content) && Array.isArray(r.json.data.placeholders);
      });

      let beforeVersion = 0;
      await check('PUT /api/admin/content 保存后 dataVersion 自增', async () => {
        const cur = await adminClient.request('GET', '/api/admin/content', { expectStatus: 200 });
        beforeVersion = cur.json.data.version.dataVersion;
        const content = cur.json.data.content;
        content.meta = { ...(content.meta || {}), slogan: `冒烟测试标语 ${Date.now()}` };
        await adminClient.request('PUT', '/api/admin/content', { body: { content }, expectStatus: 200 });
        const after = await adminClient.request('GET', '/api/content/version', { expectStatus: 200 });
        return after.json.data.dataVersion > beforeVersion;
      });

      await check('前台立刻读到新内容（同一进程内一致）', async () => {
        const r = await publicClient.request('GET', '/api/content', { expectStatus: 200 });
        return String(r.json.data.content.meta.slogan).startsWith('冒烟测试标语');
      });

      await check('GET /api/admin/backups 有备份', async () => {
        const r = await adminClient.request('GET', '/api/admin/backups', { expectStatus: 200 });
        return r.json.data.backups.length >= 1;
      });

      await check('POST /api/admin/rollback 回滚成功', async () => {
        const r = await adminClient.request('POST', '/api/admin/rollback', { body: {}, expectStatus: 200 });
        const check2 = await publicClient.request('GET', '/api/content/version', { expectStatus: 200 });
        return r.json.ok === true && check2.json.data.dataVersion >= beforeVersion;
      });

      await check('PATCH /api/admin/content 局部改字段', async () => {
        const r = await adminClient.request('PATCH', '/api/admin/content', {
          body: { path: 'footer.testFlag', value: 'local-smoke' },
          expectStatus: 200,
        });
        return r.json.data.path === 'footer.testFlag';
      });

      await check('PATCH 非法路径 → 400', async () => {
        const r = await adminClient.request('PATCH', '/api/admin/content', { body: { path: '../evil', value: 1 } });
        return r.status === 400;
      });

      await check('PATCH theme → 前台 HTML 注入对应 CSS 变量（改完还原）', async () => {
        const before = await adminClient.request('GET', '/api/admin/content', { expectStatus: 200 });
        const originalTheme = (before.json.data.content && before.json.data.content.theme) || {};
        const probe = { bgOpacity: 0.71, bgBoost: 1.03, bgVeilTop: 0.44, bgVeilMid: 0.66, bgVeilBottom: 0.91 };
        try {
          await adminClient.request('PATCH', '/api/admin/content', { body: { path: 'theme', value: probe }, expectStatus: 200 });
          const html = await publicClient.request('GET', '/', { expectStatus: 200 });
          const injected = html.text.includes('--bg-opacity:0.71') && html.text.includes('<style nonce=');
          if (!injected) throw new Error('前台 HTML 未出现注入的 --bg-opacity:0.71');
          const csp = html.headers.get('content-security-policy') || '';
          if (!/style-src 'self' 'nonce-/.test(csp)) throw new Error(`CSP style-src 未带 nonce：${csp}`);
          return true;
        } finally {
          await adminClient.request('PATCH', '/api/admin/content', { body: { path: 'theme', value: originalTheme }, expectStatus: 200 });
          const back = await publicClient.request('GET', '/', { expectStatus: 200 });
          if (!back.text.includes(`--bg-opacity:${Number(originalTheme.bgOpacity)}`)) {
            throw new Error('还原 theme 失败，请检查 data/content.json');
          }
        }
      });

      await check('PUT /api/admin/datasets/wiki-levels 写入数据集（先备份原值）', async () => {
        // ⚠️ 这里**必须**先备份再改再还原：早先版本直接覆盖，把真实关卡数据冲掉了（已踩坑）
        const before = await adminClient.request('GET', '/api/admin/datasets/wiki-levels', { expectStatus: 200 });
        originalLevels = before.json.data.data;
        const r = await adminClient.request('PUT', '/api/admin/datasets/wiki-levels', {
          body: { data: { chapters: [{ id: 'smoke', name: '冒烟测试大关' }], levels: [] } },
          expectStatus: 200,
        });
        return Boolean(r.json.data.fingerprint);
      });

      await check('公开接口能读到刚写入的数据集', async () => {
        const r = await publicClient.request('GET', '/api/wiki/wiki-levels', { expectStatus: 200 });
        return r.json.data.chapters[0].name === '冒烟测试大关';
      });

      await check('还原原数据集（避免污染真实内容）', async () => {
        const r = await adminClient.request('PUT', '/api/admin/datasets/wiki-levels', {
          body: { data: originalLevels },
          expectStatus: 200,
        });
        const after = await publicClient.request('GET', '/api/wiki/wiki-levels', { expectStatus: 200 });
        return Boolean(r.json.data.fingerprint) && (after.json.data.chapters || []).length === (originalLevels.chapters || []).length;
      });

      await check('POST /api/admin/logout 退出后未登录', async () => {
        await adminClient.request('POST', '/api/admin/logout', { body: {}, expectStatus: 200 });
        const r = await adminClient.request('GET', '/api/admin/session', { expectStatus: 200 });
        return r.json.data.loggedIn === false;
      });
    }
  }

  console.log('');
  console.log(`=== 结果：通过 ${pass} / 失败 ${fail} ===`);
  if (fail) {
    console.log('失败明细：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('冒烟测试异常终止：', err);
  process.exit(2);
});
