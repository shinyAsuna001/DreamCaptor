'use strict';
/**
 * auth.js —— 账号密码（scrypt + 随机盐）与会话
 *
 * 安全约定：
 *   - 密码**只存 scrypt 哈希 + 随机盐**，绝不明文（旧站是明文，这里不重蹈）
 *   - 会话令牌 32 字节随机；**服务端只存令牌的 sha256**，窃取 sessions.json 也无法冒用
 *   - Cookie：HttpOnly + SameSite=Lax + Path=/；http 明文环境不能加 Secure（已知取舍）
 *   - 口令比较一律用 timingSafeEqual，避免时序侧信道
 */

const crypto = require('crypto');
const { config } = require('./env');

// scrypt 参数：Node 默认 maxmem 下 N=16384 可用；内存约 16MB/次，登录频率低，够安全
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, saltBytes: 16 };

function scryptAsync(password, salt, params = SCRYPT) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p }, (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });
}

/** 生成可存储的哈希字符串：scrypt$N$r$p$saltHex$hashHex */
async function hashPassword(password) {
  const salt = crypto.randomBytes(SCRYPT.saltBytes);
  const key = await scryptAsync(password, salt);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('hex'), key.toString('hex')].join('$');
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(password, salt, {
    N: Number(n), r: Number(r), p: Number(p), keylen: expected.length, saltBytes: salt.length,
  });
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Cookie 头解析（只做最小实现，够用且无依赖） */
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function buildSetCookie(name, value, { maxAgeMs, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `SameSite=${config.security.sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (config.security.cookieSecure) parts.push('Secure');
  if (maxAgeMs !== undefined) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  return parts.join('; ');
}

function clearCookie(name) {
  return buildSetCookie(name, '', { maxAgeMs: 0 });
}

/** 会话管理：内存索引 + 持久化到 sessions.json（只存 hash） */
class SessionManager {
  /**
   * @param {import('./store').JsonStore} store sessions.json 存储
   */
  constructor(store) {
    this.store = store;
    this.byHash = new Map();      // tokenHash -> { userId, expiresAt, createdAt }
    this.bootstrap();
  }

  bootstrap() {
    const data = this.store.get() || { sessions: [] };
    const now = Date.now();
    for (const s of data.sessions || []) {
      if (s.expiresAt > now) this.byHash.set(s.tokenHash, s);
    }
    this.prune();
  }

  /** 建立会话并返回明文令牌（只在此刻存在，服务端不留存） */
  async create(userId, ttlMs = config.session.ttlMs) {
    const token = newToken();
    const tokenHash = sha256(token);
    const rec = { tokenHash, userId, createdAt: Date.now(), expiresAt: Date.now() + ttlMs };
    this.byHash.set(tokenHash, rec);
    await this.persist();
    return token;
  }

  /** 校验令牌 → 返回 { userId } 或 null */
  verify(token) {
    if (!token || typeof token !== 'string' || token.length < 20) return null;
    const rec = this.byHash.get(sha256(token));
    if (!rec) return null;
    if (rec.expiresAt <= Date.now()) {
      this.byHash.delete(sha256(token));
      return null;
    }
    return { userId: rec.userId, expiresAt: rec.expiresAt };
  }

  async destroy(token) {
    if (!token) return;
    if (this.byHash.delete(sha256(token))) await this.persist();
  }

  async destroyAllForUser(userId) {
    let changed = false;
    for (const [hash, rec] of this.byHash) {
      if (rec.userId === userId) { this.byHash.delete(hash); changed = true; }
    }
    if (changed) await this.persist();
  }

  prune() {
    const now = Date.now();
    let changed = false;
    for (const [hash, rec] of this.byHash) {
      if (rec.expiresAt <= now) { this.byHash.delete(hash); changed = true; }
    }
    if (changed) this.persist().catch(() => {});
    return changed;
  }

  persist() {
    const sessions = [...this.byHash.values()];
    return this.store.save({ sessions, savedAt: new Date().toISOString() });
  }

  count() {
    return this.byHash.size;
  }
}

/** 账号仓库：accounts.json（与旧站 users.json 完全无关，绝不读取旧文件） */
class Accounts {
  constructor(store) {
    this.store = store;
  }

  all() {
    return (this.store.get() || { accounts: [] }).accounts;
  }

  findByName(name) {
    const lower = String(name).toLowerCase();
    return this.all().find((a) => a.username.toLowerCase() === lower) || null;
  }

  findById(id) {
    return this.all().find((a) => a.id === id) || null;
  }

  async create({ username, password, ip }) {
    const passwordHash = await hashPassword(password);
    const account = {
      id: crypto.randomUUID(),
      username,
      passwordHash,
      createdAt: new Date().toISOString(),
      createdIp: ip || null,
      role: 'user',
    };
    await this.store.update((data) => {
      const accounts = (data && data.accounts) || [];
      accounts.push(account);
      return { ...(data || {}), accounts, savedAt: new Date().toISOString() };
    });
    return account;
  }

  /** 对外输出时永远剥掉哈希 */
  static publicView(account) {
    if (!account) return null;
    return { id: account.id, username: account.username, createdAt: account.createdAt, role: account.role };
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  sha256,
  newToken,
  parseCookies,
  buildSetCookie,
  clearCookie,
  SessionManager,
  Accounts,
  SCRYPT,
};
