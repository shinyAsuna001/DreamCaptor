'use strict';
/**
 * api.js —— 所有 /api 路由（公开 + 账号 + 评论 + 百科数据集 + 后台）
 *
 * 约定：
 *   - 统一返回 { ok, data } / { ok:false, error:{ code, message } }
 *   - 所有外部输入过 validate；所有用户内容当纯文本
 *   - 后台接口**非本机一律 404**（不暴露存在）
 */

const { config, isAdminEnabled } = require('./env');
const {
  ok, created, fail, readJsonBody, clientIp, isSameOrigin, isLoopback,
} = require('./http-util');
const { limiter, loginGuard } = require('./ratelimit');
const validate = require('./validate');
const logger = require('./logger');
const contentStore = require('./content');
const comments = require('./comments');
const datasets = require('./datasets');
const admin = require('./admin');
const { parseCookies, buildSetCookie, clearCookie, verifyPassword, SessionManager, Accounts } = require('./auth');
const { JsonStore } = require('./store');

const sessions = new SessionManager(new JsonStore('sessions.json', { defaultValue: { sessions: [] } }));
const accounts = new Accounts(new JsonStore('accounts.json', { defaultValue: { accounts: [] } }));

// ------------------------------------------------------------------ 会话助手

function currentUser(req) {
  const cookies = parseCookies(req);
  const token = cookies[config.session.cookieName];
  const session = sessions.verify(token);
  if (!session) return null;
  const account = accounts.findById(session.userId);
  return account || null;
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) {
    fail(req, res, 401, 'UNAUTHORIZED', '请先登录');
    return null;
  }
  return user;
}

function enforceRate(res, action, req) {
  const ip = clientIp(req);
  const result = limiter.hit(action, ip);
  if (!result.allowed) {
    const seconds = Math.ceil((result.retryAfterMs || 60000) / 1000);
    fail(req, res, 429, 'RATE_LIMITED', `操作过于频繁，请 ${seconds} 秒后再试`, { 'Retry-After': String(seconds) });
    return false;
  }
  return true;
}

function requireSameOrigin(req, res) {
  if (!isSameOrigin(req)) {
    fail(req, res, 403, 'CROSS_ORIGIN', '拒绝跨站请求');
    return false;
  }
  return true;
}

// ------------------------------------------------------------------ 公开

const routes = [];
function route(method, pattern, handler, opts = {}) {
  routes.push({ method, pattern, handler, opts });
}

route('GET', /^\/api\/health$/, async (req, res) => {
  ok(req, res, {
    status: 'ok',
    server: config.site.name,
    version: config.site.version,
    env: config.env,
    uptimeSec: Math.round(process.uptime()),
    time: new Date().toISOString(),
  });
});

route('GET', /^\/api\/content$/, async (req, res) => {
  const snapshot = contentStore.buildSnapshot();
  const tag = contentStore.etag();
  if (req.headers['if-none-match'] === tag) {
    res.writeHead(304, { ETag: tag, 'Cache-Control': 'public, max-age=60' });
    return res.end();
  }
  ok(req, res, {
    content: snapshot.data,
    version: snapshot.version,
    unresolved: snapshot.unresolved,
  }, { ETag: tag, 'Cache-Control': 'public, max-age=60' });
});

route('GET', /^\/api\/content\/version$/, async (req, res) => {
  ok(req, res, contentStore.versionOf());
});

route('GET', /^\/api\/wiki\/([a-z-]+)$/, async (req, res, m) => {
  const name = m[1];
  const result = datasets.readPublic(name);
  if (!result) return fail(req, res, 404, 'NOT_FOUND', '数据集不存在');
  const tag = `W/"${name}-${result.fingerprint}"`;
  if (req.headers['if-none-match'] === tag) {
    res.writeHead(304, { ETag: tag, 'Cache-Control': 'public, max-age=300' });
    return res.end();
  }
  ok(req, res, result.data, { ETag: tag, 'Cache-Control': 'public, max-age=300' });
});

// ------------------------------------------------------------------ 账号

route('POST', /^\/api\/auth\/register$/, async (req, res) => {
  if (!requireSameOrigin(req, res)) return;
  if (!enforceRate(res, 'auth:register', req)) return;
  const body = await readJsonBody(req);
  const username = validate.username(body.username);
  const password = validate.password(body.password);

  if (accounts.findByName(username)) return fail(req, res, 409, 'USERNAME_TAKEN', '该用户名已被占用');

  const account = await accounts.create({ username, password, ip: clientIp(req) });
  const token = await sessions.create(account.id);
  res.setHeader('Set-Cookie', buildSetCookie(config.session.cookieName, token, { maxAgeMs: config.session.ttlMs }));
  logger.info('auth: 注册成功', { username });
  return created(req, res, { user: Accounts.publicView(account) });
});

route('POST', /^\/api\/auth\/login$/, async (req, res) => {
  if (!requireSameOrigin(req, res)) return;
  const ip = clientIp(req);
  const lock = loginGuard.isLocked(ip);
  if (lock.locked) {
    const seconds = Math.ceil(lock.remainingMs / 1000);
    return fail(req, res, 429, 'LOCKED', `失败次数过多，请 ${seconds} 秒后再试`, { 'Retry-After': String(seconds) });
  }
  if (!enforceRate(res, 'auth:login', req)) return;
  const body = await readJsonBody(req);
  const username = validate.requireString(body.username, '用户名', { min: 1, max: 64 });
  const password = typeof body.password === 'string' ? body.password : '';

  const account = accounts.findByName(username);
  const passOk = account ? await verifyPassword(password, account.passwordHash) : false;
  if (!passOk) {
    loginGuard.recordFailure(ip);
    logger.warn('auth: 登录失败', { username });
    return fail(req, res, 401, 'BAD_CREDENTIALS', '用户名或密码错误');
  }
  loginGuard.clear(ip);
  const token = await sessions.create(account.id);
  res.setHeader('Set-Cookie', buildSetCookie(config.session.cookieName, token, { maxAgeMs: config.session.ttlMs }));
  logger.info('auth: 登录成功', { username });
  return ok(req, res, { user: Accounts.publicView(account) });
});

route('POST', /^\/api\/auth\/logout$/, async (req, res) => {
  if (!requireSameOrigin(req, res)) return;
  const cookies = parseCookies(req);
  const token = cookies[config.session.cookieName];
  await sessions.destroy(token);
  res.setHeader('Set-Cookie', clearCookie(config.session.cookieName));
  return ok(req, res, { loggedOut: true });
});

route('GET', /^\/api\/auth\/me$/, async (req, res) => {
  const user = currentUser(req);
  ok(req, res, { user: Accounts.publicView(user) });
});

// ------------------------------------------------------------------ 评论

route('GET', /^\/api\/comments$/, async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const page = validate.positiveInt(url.searchParams.get('page'), 'page', { min: 1, max: 10000, fallback: 1 });
  const pageSize = validate.positiveInt(url.searchParams.get('pageSize'), 'pageSize', { min: 1, max: 50, fallback: 20 });
  ok(req, res, comments.listPublic({ page, pageSize }));
});

route('POST', /^\/api\/comments$/, async (req, res) => {
  if (!requireSameOrigin(req, res)) return;
  const user = requireUser(req, res);
  if (!user) return;
  if (!enforceRate(res, 'comment:create', req)) return;
  const body = await readJsonBody(req);
  const content = validate.commentContent(body.content);
  const parentId = body.parentId ? validate.identifier(body.parentId, 'parentId') : null;
  const comment = await comments.create({ user: Accounts.publicView(user), content, parentId });
  return created(req, res, {
    id: comment.id, username: comment.username, content: comment.content,
    createdAt: comment.createdAt, parentId: comment.parentId,
  });
});

route('DELETE', /^\/api\/comments\/([A-Za-z0-9-]+)$/, async (req, res, m) => {
  if (!requireSameOrigin(req, res)) return;
  const user = requireUser(req, res);
  if (!user) return;
  const isAdminUser = user.role === 'admin';
  await comments.softDelete(m[1], { actorId: user.id, isAdmin: isAdminUser });
  return ok(req, res, { deleted: true });
});

// ------------------------------------------------------------------ 后台

function adminGuardResponse(req, res) {
  if (!isAdminEnabled()) { fail(req, res, 404, 'NOT_FOUND', '未找到'); return false; }
  if (!isLoopback(req)) { fail(req, res, 404, 'NOT_FOUND', '未找到'); return false; }
  return true;
}

function requireAdminSession(req, res) {
  if (!adminGuardResponse(req, res)) return false;
  if (!admin.isLoggedIn(req)) { fail(req, res, 401, 'ADMIN_UNAUTHORIZED', '请先登录维护后台'); return false; }
  return true;
}

route('GET', /^\/api\/admin\/session$/, async (req, res) => {
  if (!adminGuardResponse(req, res)) return;
  ok(req, res, { adminEnabled: true, loggedIn: admin.isLoggedIn(req), sessionCount: sessions.count() });
});

route('POST', /^\/api\/admin\/login$/, async (req, res) => {
  if (!adminGuardResponse(req, res)) return;
  if (!enforceRate(res, 'admin:login', req)) return;
  const body = await readJsonBody(req);
  const password = typeof body.password === 'string' ? body.password : '';
  const token = await admin.login(req, password);
  res.setHeader('Set-Cookie', admin.setCookieHeader(token));
  return ok(req, res, { loggedIn: true });
});

route('POST', /^\/api\/admin\/logout$/, async (req, res) => {
  if (!adminGuardResponse(req, res)) return;
  admin.logout(req);
  res.setHeader('Set-Cookie', admin.logoutCookieHeader());
  return ok(req, res, { loggedIn: false });
});

route('GET', /^\/api\/admin\/content$/, async (req, res) => {
  if (!requireAdminSession(req, res)) return;
  const raw = contentStore.store.get();
  ok(req, res, {
    content: raw,
    version: contentStore.versionOf(),
    placeholders: contentStore.summarizePlaceholders((raw && raw.placeholders) || {}),
    datasets: datasets.summary(),
    comments: comments.stats(),
  });
});

route('PUT', /^\/api\/admin\/content$/, async (req, res) => {
  if (!requireAdminSession(req, res)) return;
  const body = await readJsonBody(req);
  if (!body.content || typeof body.content !== 'object') return fail(req, res, 400, 'BAD_BODY', '缺少 content 对象');
  const saved = await contentStore.saveContent(body.content);
  return ok(req, res, { dataVersion: saved.meta.dataVersion });
});

route('PATCH', /^\/api\/admin\/content$/, async (req, res) => {
  if (!requireAdminSession(req, res)) return;
  const body = await readJsonBody(req);
  const pathText = validate.requireString(body.path, 'path', { min: 1, max: 200 });
  const segments = pathText.split('.').filter(Boolean);
  if (!segments.length || segments.some((s) => !/^[A-Za-z0-9_-]+$/.test(s))) {
    return fail(req, res, 400, 'BAD_PATH', 'path 只允许字母数字下划线连字符与点');
  }
  const saved = await contentStore.patchContent(segments, body.value);
  return ok(req, res, { dataVersion: saved.meta.dataVersion, path: pathText });
});

route('POST', /^\/api\/admin\/placeholders$/, async (req, res) => {
  if (!requireAdminSession(req, res)) return;
  const body = await readJsonBody(req);
  if (!body.updates || typeof body.updates !== 'object') return fail(req, res, 400, 'BAD_BODY', '缺少 updates 对象');
  const saved = await contentStore.setPlaceholders(body.updates);
  return ok(req, res, { dataVersion: saved.meta.dataVersion });
});

route('GET', /^\/api\/admin\/datasets\/([a-z-]+)$/, async (req, res, m) => {
  if (!requireAdminSession(req, res)) return;
  const result = datasets.readPublic(m[1]);
  if (!result) return fail(req, res, 404, 'NOT_FOUND', '数据集不存在');
  return ok(req, res, { name: m[1], data: result.data });
});

route('PUT', /^\/api\/admin\/datasets\/([a-z-]+)$/, async (req, res, m) => {
  if (!requireAdminSession(req, res)) return;
  const body = await readJsonBody(req);
  if (!body.data || typeof body.data !== 'object') return fail(req, res, 400, 'BAD_BODY', '缺少 data 对象');
  const result = await datasets.write(m[1], body.data);
  return ok(req, res, { name: m[1], fingerprint: result.fingerprint });
});

route('GET', /^\/api\/admin\/backups$/, async (req, res) => {
  if (!requireAdminSession(req, res)) return;
  ok(req, res, { backups: admin.listBackups() });
});

route('POST', /^\/api\/admin\/rollback$/, async (req, res) => {
  if (!requireAdminSession(req, res)) return;
  const body = await readJsonBody(req);
  const backupName = body.backupName ? validate.identifier(body.backupName, 'backupName', 128) : undefined;
  const result = await admin.rollback({ backupName });
  return ok(req, res, result);
});

route('GET', /^\/api\/admin\/comments$/, async (req, res) => {
  if (!requireAdminSession(req, res)) return;
  ok(req, res, { stats: comments.stats(), items: comments.adminList() });
});

route('POST', /^\/api\/admin\/comments\/([A-Za-z0-9-]+)\/hide$/, async (req, res, m) => {
  if (!requireAdminSession(req, res)) return;
  const body = await readJsonBody(req);
  const item = await comments.setHidden(m[1], body.hidden !== false);
  return ok(req, res, { id: item.id, hidden: item.hidden });
});

route('DELETE', /^\/api\/admin\/comments\/([A-Za-z0-9-]+)$/, async (req, res, m) => {
  if (!requireAdminSession(req, res)) return;
  await comments.softDelete(m[1], { actorId: null, isAdmin: true });
  return ok(req, res, { deleted: true });
});

// ------------------------------------------------------------------ 分发

/** 返回 true 表示已处理（含"已回复 404/405"的情况）。 */
async function handleApi(req, res) {
  const urlPath = req.url.split('?')[0];

  if (!urlPath.startsWith('/api/')) return false;

  // 兜底限流：防脚本扫接口
  const ip = clientIp(req);
  const general = limiter.hit('api:general', ip);
  if (!general.allowed) {
    fail(req, res, 429, 'RATE_LIMITED', '请求过于频繁');
    return true;
  }

  const matches = routes.filter((r) => r.pattern.test(urlPath));
  if (!matches.length) {
    fail(req, res, 404, 'API_NOT_FOUND', '接口不存在');
    return true;
  }
  const allowed = matches.filter((r) => r.method === req.method);
  if (!allowed.length) {
    fail(req, res, 405, 'METHOD_NOT_ALLOWED', '方法不允许', { Allow: [...new Set(matches.map((r) => r.method))].join(', ') });
    return true;
  }

  const target = allowed[0];
  const m = target.pattern.exec(urlPath);
  try {
    await target.handler(req, res, m);
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) logger.error('api: 未处理异常', { path: urlPath, error: err.message });
    else logger.warn('api: 业务异常', { path: urlPath, error: err.message });
    if (!res.headersSent) {
      fail(req, res, status, status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST', status >= 500 ? '服务器内部错误' : err.message);
    }
  }
  return true;
}

module.exports = { handleApi, currentUser, sessions, accounts };
