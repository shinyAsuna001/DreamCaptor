'use strict';
/**
 * admin.js —— 维护后台：仅 127.0.0.1 + 管理员口令（scrypt）+ 失败锁定 + 备份/回滚
 *
 * 红线（后台相关）：
 *   - 非本机访问后台路径或后台 API → **一律 404**（不暴露"这里有个后台"）
 *   - 管理员口令只存 scrypt 哈希（.env），不回显、不写日志
 *   - 未登录 401；连续失败 N 次锁定
 *   - 写入原子 + 自动备份 + 一键回滚
 */

const crypto = require('crypto');
const { config, isAdminEnabled } = require('./env');
const { verifyPassword, buildSetCookie, clearCookie, parseCookies, sha256, newToken } = require('./auth');
const { adminGuard } = require('./ratelimit');
const { isLoopback, clientIp } = require('./http-util');
const contentStore = require('./content');
const logger = require('./logger');

const ADMIN_SESSION_COOKIE = config.session.adminCookieName;
const adminSessions = new Map();      // tokenHash -> { createdAt, expiresAt }

function adminPathSegment() {
  return config.admin.pathSegment;
}

/** 请求是否命中后台路径（/m-xxxx/*） */
function isAdminPath(urlPath) {
  const seg = adminPathSegment();
  if (!seg) return false;
  return urlPath === `/${seg}` || urlPath.startsWith(`/${seg}/`);
}

/** 后台的一切访问必须同时满足：本机 + 后台路径。否则调用方一律返回 404。 */
function canReachAdmin(req) {
  if (!isAdminEnabled()) return false;
  return isLoopback(req);
}

function issueSession() {
  const token = newToken();
  adminSessions.set(sha256(token), {
    createdAt: Date.now(),
    expiresAt: Date.now() + config.admin.sessionTtlMs,
  });
  return token;
}

function currentSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[ADMIN_SESSION_COOKIE];
  if (!token) return null;
  const hash = sha256(token);
  const rec = adminSessions.get(hash);
  if (!rec) return null;
  if (rec.expiresAt <= Date.now()) {
    adminSessions.delete(hash);
    return null;
  }
  return rec;
}

function isLoggedIn(req) {
  return Boolean(currentSession(req));
}

function pruneSessions() {
  const now = Date.now();
  for (const [hash, rec] of adminSessions) if (rec.expiresAt <= now) adminSessions.delete(hash);
}

function setCookieHeader(token) {
  return buildSetCookie(ADMIN_SESSION_COOKIE, token, { maxAgeMs: config.admin.sessionTtlMs });
}

function logoutCookieHeader() {
  return clearCookie(ADMIN_SESSION_COOKIE);
}

/** 口令校验（含失败锁定） */
async function login(req, password) {
  const ip = clientIp(req);
  const lock = adminGuard.isLocked(ip);
  if (lock.locked) {
    const err = new Error('尝试次数过多，请稍后再试');
    err.statusCode = 429;
    err.retryAfterMs = lock.remainingMs;
    throw err;
  }
  if (!isAdminEnabled()) {
    const err = new Error('后台未启用');
    err.statusCode = 404;
    throw err;
  }
  const okPassword = await verifyPassword(password, config.admin.passwordHash);
  if (!okPassword) {
    const res = adminGuard.recordFailure(ip);
    logger.warn('admin: 登录失败', { ip });
    const err = new Error(res.locked ? '尝试次数过多，账号已临时锁定' : '口令错误');
    err.statusCode = res.locked ? 429 : 401;
    throw err;
  }
  adminGuard.clear(ip);
  const token = issueSession();
  logger.info('admin: 登录成功', { ip });
  return token;
}

function logout(req) {
  const cookies = parseCookies(req);
  const token = cookies[ADMIN_SESSION_COOKIE];
  if (token) adminSessions.delete(sha256(token));
}

/** 备份列表（content.json 等数据文件的备份都在同一个目录） */
function listBackups() {
  const stores = [contentStore.store];
  const out = [];
  for (const s of stores) {
    for (const b of s.listBackups()) {
      out.push({ target: s.fileName, ...b });
    }
  }
  return out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

/** 一键恢复上一版本（或指定备份） */
async function rollback({ backupName } = {}) {
  const value = await contentStore.store.rollback(backupName);
  return { restored: backupName || 'latest', dataVersion: (value.meta && value.meta.dataVersion) || null };
}

module.exports = {
  adminPathSegment,
  isAdminPath,
  canReachAdmin,
  isLoggedIn,
  login,
  logout,
  setCookieHeader,
  logoutCookieHeader,
  listBackups,
  rollback,
  pruneSessions,
  ADMIN_SESSION_COOKIE,
};
