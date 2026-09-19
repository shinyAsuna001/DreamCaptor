'use strict';
/**
 * comments.js —— 评论（登录用户可发、可回复；软删除；后台可隐藏）
 *
 * 数据结构（data/comments.json）：
 *   { comments: [ { id, userId, username, content, parentId, createdAt, deletedAt, hidden, hiddenBy } ] }
 * 纪律：
 *   - 用户内容一律当纯文本处理（前端只走 textContent，服务端只做长度/控制字符校验）
 *   - 回复深度由配置限制（默认 1 层：评论 + 回复）
 */

const crypto = require('crypto');
const { JsonStore } = require('./store');
const { config } = require('./env');
const logger = require('./logger');

const store = new JsonStore('comments.json', { defaultValue: { comments: [] } });

function all() {
  const data = store.get() || { comments: [] };
  return data.comments || [];
}

/** 组装成"评论 + 其回复"的两层结构，仅返回可见评论。 */
function listPublic({ page = 1, pageSize = 20 } = {}) {
  const visible = all().filter((c) => !c.deletedAt && !c.hidden);
  const roots = visible.filter((c) => !c.parentId);
  const total = roots.length;
  const start = Math.max(0, (page - 1) * pageSize);
  const pageRoots = roots.slice().reverse().slice(start, start + pageSize);

  const byParent = new Map();
  for (const c of visible) {
    if (!c.parentId) continue;
    if (!byParent.has(c.parentId)) byParent.set(c.parentId, []);
    byParent.get(c.parentId).push(c);
  }

  const shape = (c) => ({
    id: c.id,
    username: c.username,
    content: c.content,
    createdAt: c.createdAt,
    isReply: Boolean(c.parentId),
    parentId: c.parentId || null,
  });

  return {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    items: pageRoots.map((root) => ({
      ...shape(root),
      replies: (byParent.get(root.id) || []).map(shape),
    })),
  };
}

function adminList({ includeDeleted = true } = {}) {
  return all()
    .slice()
    .reverse()
    .filter((c) => includeDeleted || (!c.deletedAt && !c.hidden))
    .map((c) => ({ ...c }));
}

async function create({ user, content, parentId = null }) {
  let resolvedParent = null;
  if (parentId) {
    const parent = all().find((c) => c.id === parentId);
    if (!parent) {
      const err = new Error('要回复的评论不存在');
      err.statusCode = 404;
      throw err;
    }
    if (parent.deletedAt || parent.hidden) {
      const err = new Error('要回复的评论已被删除');
      err.statusCode = 409;
      throw err;
    }
    // 回复只允许挂在一级评论下（深度 1）
    resolvedParent = parent.parentId ? parent.parentId : parent.id;
    const depth = parent.parentId ? 2 : 1;
    if (depth > 2) {
      const err = new Error('回复层级过深');
      err.statusCode = 400;
      throw err;
    }
  }
  const comment = {
    id: crypto.randomUUID(),
    userId: user.id,
    username: user.username,
    content,
    parentId: resolvedParent,
    createdAt: new Date().toISOString(),
    deletedAt: null,
    hidden: false,
  };
  await store.update((data) => {
    const comments = (data && data.comments) || [];
    comments.push(comment);
    return { ...(data || {}), comments, savedAt: new Date().toISOString() };
  });
  logger.info('comment: 新增', { id: comment.id, reply: Boolean(resolvedParent) });
  return comment;
}

/** 本人或管理员可删；软删除保留审计线索。 */
async function softDelete(id, { actorId, isAdmin }) {
  let target = null;
  await store.update((data) => {
    const comments = (data && data.comments) || [];
    const c = comments.find((x) => x.id === id);
    if (!c) return data;
    if (!isAdmin && c.userId !== actorId) return data;
    c.deletedAt = new Date().toISOString();
    c.deletedBy = isAdmin ? 'admin' : 'self';
    target = c;
    return { ...(data || {}), comments };
  });
  if (!target) {
    const err = new Error('评论不存在或无权删除');
    err.statusCode = 404;
    throw err;
  }
  logger.info('comment: 软删除', { id, byAdmin: Boolean(isAdmin) });
  return target;
}

async function setHidden(id, hidden) {
  let target = null;
  await store.update((data) => {
    const comments = (data && data.comments) || [];
    const c = comments.find((x) => x.id === id);
    if (!c) return data;
    c.hidden = Boolean(hidden);
    c.hiddenAt = hidden ? new Date().toISOString() : null;
    target = c;
    return { ...(data || {}), comments };
  });
  if (!target) {
    const err = new Error('评论不存在');
    err.statusCode = 404;
    throw err;
  }
  return target;
}

function stats() {
  const list = all();
  return {
    total: list.length,
    visible: list.filter((c) => !c.deletedAt && !c.hidden).length,
    deleted: list.filter((c) => c.deletedAt).length,
    hidden: list.filter((c) => c.hidden).length,
  };
}

module.exports = { store, listPublic, adminList, create, softDelete, setHidden, stats };
