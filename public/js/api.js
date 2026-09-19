/**
 * api.js —— 后端接口封装（统一 { ok, data, error } 语义）
 */

async function request(method, path, body, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      signal: controller.signal,
    });
    const text = await res.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    if (!res.ok || !payload || payload.ok === false) {
      const message = (payload && payload.error && payload.error.message) || `请求失败（${res.status}）`;
      const err = new Error(message);
      err.status = res.status;
      err.code = payload && payload.error ? payload.error.code : 'HTTP_ERROR';
      throw err;
    }
    return payload.data;
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('请求超时');
      e.code = 'TIMEOUT';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  /* 会话 */
  me: () => request('GET', '/api/auth/me'),
  register: (username, password) => request('POST', '/api/auth/register', { username, password }),
  login: (username, password) => request('POST', '/api/auth/login', { username, password }),
  logout: () => request('POST', '/api/auth/logout', {}),

  /* 评论 */
  comments: (page = 1, pageSize = 20) => request('GET', `/api/comments?page=${page}&pageSize=${pageSize}`),
  createComment: (content, parentId = null) => request('POST', '/api/comments', { content, parentId }),
  deleteComment: (id) => request('DELETE', `/api/comments/${encodeURIComponent(id)}`),

  /* 数据集 */
  dataset: (name) => request('GET', `/api/wiki/${encodeURIComponent(name)}`),

  /* 后台（仅本机） */
  adminSession: () => request('GET', '/api/admin/session'),
  adminLogin: (password) => request('POST', '/api/admin/login', { password }),
  adminLogout: () => request('POST', '/api/admin/logout', {}),
  adminContent: () => request('GET', '/api/admin/content'),
  adminSaveContent: (content) => request('PUT', '/api/admin/content', { content }),
  adminPatch: (path, value) => request('PATCH', '/api/admin/content', { path, value }),
  adminSetPlaceholders: (updates) => request('POST', '/api/admin/placeholders', { updates }),
  adminDataset: (name) => request('GET', `/api/admin/datasets/${encodeURIComponent(name)}`),
  adminSaveDataset: (name, data) => request('PUT', `/api/admin/datasets/${encodeURIComponent(name)}`, { data }),
  adminBackups: () => request('GET', '/api/admin/backups'),
  adminRollback: (backupName) => request('POST', '/api/admin/rollback', backupName ? { backupName } : {}),
  adminComments: () => request('GET', '/api/admin/comments'),
  adminHideComment: (id, hidden) => request('POST', `/api/admin/comments/${encodeURIComponent(id)}/hide`, { hidden }),
  adminDeleteComment: (id) => request('DELETE', `/api/admin/comments/${encodeURIComponent(id)}`),
};
