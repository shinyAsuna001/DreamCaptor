'use strict';
/**
 * validate.js —— 输入校验（所有外部输入的唯一入口）
 * 原则：先修剪、再限长、再做白名单，错误信息不含内部细节。
 */

const { config } = require('./env');

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

function fail(message) {
  throw new ValidationError(message);
}

/** 必填字符串 */
function requireString(value, field, { min = 1, max = 200 } = {}) {
  if (typeof value !== 'string') fail(`${field} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length < min) fail(`${field} 不能少于 ${min} 个字符`);
  if (trimmed.length > max) fail(`${field} 不能超过 ${max} 个字符`);
  return trimmed;
}

function optionalString(value, field, opts = {}) {
  if (value === undefined || value === null || value === '') return '';
  return requireString(value, field, { min: 0, ...opts });
}

/** 拒绝控制字符（防注入到日志/终端） */
function stripControl(value) {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function username(value) {
  const name = stripControl(requireString(value, '用户名', {
    min: config.limits.usernameMin,
    max: config.limits.usernameMax,
  }));
  // 允许中英文、数字、下划线与连字符；不允许空格与标点（避免冒充/混淆）
  if (!/^[\w\u4e00-\u9fa5-]+$/u.test(name)) fail('用户名只能包含中文、字母、数字、下划线与连字符');
  return name;
}

function password(value) {
  if (typeof value !== 'string') fail('密码必须是字符串');
  if (value.length < config.limits.passwordMin) fail(`密码至少 ${config.limits.passwordMin} 位`);
  if (value.length > config.limits.passwordMax) fail(`密码不能超过 ${config.limits.passwordMax} 位`);
  return value;                       // 密码不做 trim（空格也是有效字符），但长度受限
}

function commentContent(value) {
  const text = stripControl(requireString(value, '评论内容', { min: 1, max: config.limits.commentMaxLength }));
  return text;
}

function positiveInt(value, field, { min = 1, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    fail(`${field} 必填`);
  }
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) fail(`${field} 必须是数字`);
  if (n < min || n > max) fail(`${field} 必须在 ${min}~${max} 之间`);
  return n;
}

/** 只允许 ASCII 白名单的标识符（用于 id / 路径段） */
function identifier(value, field = 'id', max = 64) {
  const s = requireString(value, field, { min: 1, max });
  if (!/^[A-Za-z0-9._-]+$/.test(s)) fail(`${field} 含非法字符`);
  return s;
}

module.exports = {
  ValidationError,
  fail,
  requireString,
  optionalString,
  stripControl,
  username,
  password,
  commentContent,
  positiveInt,
  identifier,
};
