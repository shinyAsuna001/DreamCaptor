'use strict';
/**
 * ratelimit.js —— 内存限流 + 失败锁定（零依赖，定时清理）
 *
 * 两类能力：
 *   RateLimiter  滑动窗口计数（按 IP + 动作）
 *   FailureGuard 连续失败锁定（登录 / 后台登录）
 * 内存 Map + 定时清理，进程重启即清零 —— 本站量级足够，且不引入 Redis。
 */

class RateLimiter {
  /**
   * @param {object} rules  { action: { limit, windowMs } }
   */
  constructor(rules = {}) {
    this.rules = rules;
    this.buckets = new Map();   // key -> { count, resetAt }
    this.timer = setInterval(() => this.cleanup(), 60 * 1000);
    if (this.timer.unref) this.timer.unref();   // 不阻止进程退出
  }

  /**
   * 记一次访问。超限返回 { allowed:false, retryAfterMs }。
   */
  hit(action, ip) {
    const rule = this.rules[action];
    if (!rule) return { allowed: true, remaining: Infinity };
    const key = `${action}|${ip}`;
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + rule.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > rule.limit) {
      return { allowed: false, retryAfterMs: bucket.resetAt - now, remaining: 0 };
    }
    return { allowed: true, remaining: rule.limit - bucket.count };
  }

  /** 只查询不计数（用于路由前置判断） */
  peek(action, ip) {
    const rule = this.rules[action];
    if (!rule) return { allowed: true };
    const bucket = this.buckets.get(`${action}|${ip}`);
    const now = Date.now();
    if (bucket && bucket.resetAt > now && bucket.count > rule.limit) {
      return { allowed: false, retryAfterMs: bucket.resetAt - now };
    }
    return { allowed: true };
  }

  cleanup() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  stop() {
    clearInterval(this.timer);
  }
}

class FailureGuard {
  /**
   * @param {object} options { maxFailures, lockoutMs }
   */
  constructor({ maxFailures = 5, lockoutMs = 15 * 60 * 1000 } = {}) {
    this.maxFailures = maxFailures;
    this.lockoutMs = lockoutMs;
    this.entries = new Map();   // key -> { failures, lockedUntil }
    this.timer = setInterval(() => this.cleanup(), 60 * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  isLocked(key) {
    const e = this.entries.get(key);
    if (!e) return { locked: false, remainingMs: 0 };
    if (e.lockedUntil && e.lockedUntil > Date.now()) {
      return { locked: true, remainingMs: e.lockedUntil - Date.now() };
    }
    return { locked: false, remainingMs: 0 };
  }

  recordFailure(key) {
    const e = this.entries.get(key) || { failures: 0, lockedUntil: 0 };
    e.failures += 1;
    if (e.failures >= this.maxFailures) {
      e.lockedUntil = Date.now() + this.lockoutMs;
      e.failures = 0;                       // 锁定后计数归零，锁定期满重新计数
    }
    this.entries.set(key, e);
    return { locked: e.lockedUntil > Date.now(), remainingMs: Math.max(0, e.lockedUntil - Date.now()) };
  }

  clear(key) {
    this.entries.delete(key);
  }

  cleanup() {
    const now = Date.now();
    for (const [key, e] of this.entries) {
      if ((!e.lockedUntil || e.lockedUntil <= now) && e.failures === 0) this.entries.delete(key);
    }
  }

  stop() {
    clearInterval(this.timer);
  }
}

/** 统一规则表：同一 IP 每分钟最多 N 次 */
const limiter = new RateLimiter({
  'auth:register': { limit: 3, windowMs: 60 * 60 * 1000 },   // 注册：3 次/小时
  'auth:login': { limit: 10, windowMs: 10 * 60 * 1000 },     // 登录：10 次/10 分钟
  'comment:create': { limit: 6, windowMs: 5 * 60 * 1000 },   // 评论：6 条/5 分钟
  'admin:login': { limit: 10, windowMs: 15 * 60 * 1000 },
  'content:read': { limit: 240, windowMs: 60 * 1000 },
  'api:general': { limit: 300, windowMs: 60 * 1000 },
});

const loginGuard = new FailureGuard({ maxFailures: 8, lockoutMs: 15 * 60 * 1000 });
const adminGuard = new FailureGuard({ maxFailures: 5, lockoutMs: 15 * 60 * 1000 });

module.exports = { RateLimiter, FailureGuard, limiter, loginGuard, adminGuard };
