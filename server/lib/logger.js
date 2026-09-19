'use strict';
/**
 * logger.js —— 极简日志 + 按天轮转 + 过期清理（零依赖）
 *
 * 纪律：绝不把密码、令牌、Cookie 原文写进日志。
 */

const fs = require('fs');
const path = require('path');
const { config } = require('./env');

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 单文件 5MB 上限，避免日志占满磁盘

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function logFilePath() {
  return path.join(config.paths.logDir, `app-${today()}.log`);
}

/** 遮蔽敏感字段：任何键名命中黑名单的值都不落盘。 */
const SENSITIVE_KEY = /pass|token|secret|cookie|authorization|hash|salt/i;
function scrub(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

function rotateIfNeeded(file) {
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_FILE_BYTES) fs.renameSync(file, `${file}.${Date.now()}`);
  } catch { /* 文件不存在即无需轮转 */ }
}

function write(level, message, meta) {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    message,
    ...(meta ? { meta: scrub(meta) } : {}),
  });
  const file = logFilePath();
  try {
    rotateIfNeeded(file);
    fs.appendFileSync(file, `${line}\n`, 'utf8');
  } catch { /* 日志失败不能影响主流程 */ }
  if (level === 'error' || config.env !== 'production') {
    const sink = level === 'error' ? console.error : console.log;
    sink(`[${level}] ${message}`);
  }
}

/** 清理超过 logKeepDays 的日志文件。 */
function pruneOldLogs() {
  try {
    const cutoff = Date.now() - config.limits.logKeepDays * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(config.paths.logDir)) {
      const full = path.join(config.paths.logDir, name);
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    }
  } catch { /* 忽略 */ }
}

module.exports = {
  info: (m, meta) => write('info', m, meta),
  warn: (m, meta) => write('warn', m, meta),
  error: (m, meta) => write('error', m, meta),
  access: (m, meta) => write('access', m, meta),
  pruneOldLogs,
};
