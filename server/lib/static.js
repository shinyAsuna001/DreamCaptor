'use strict';
/**
 * static.js —— 静态资源托管 + SPA 回退 + 内容快照注入
 *
 * 与旧站的区别（不照抄它的缺陷）：
 *   - MIME 表补齐 .webp / .woff2 / .avif / .webmanifest（旧站没有 .webp，会把图当附件下载）
 *   - 路径解析用 path.resolve + 前缀校验，杜绝 ../ 穿越
 *   - HTML 走 no-cache，静态资源走长效缓存（不哈希文件名，所以用 must-revalidate 兜底）
 *   - 注入 window.__DREAM_CONTENT__ 时用 nonce + CSP，不裸奔 innerHTML
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { config } = require('./env');
const { applySecurityHeaders, fail } = require('./http-util');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function contentTypeOf(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/** 解析 public 下的安全绝对路径；越界返回 null。 */
function safeResolve(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  const relative = decoded.replace(/^\/+/, '');
  const full = path.resolve(config.paths.publicDir, relative);
  const rootWithSep = config.paths.publicDir.endsWith(path.sep)
    ? config.paths.publicDir
    : config.paths.publicDir + path.sep;
  if (full !== config.paths.publicDir && !full.startsWith(rootWithSep)) return null;
  return full;
}

function statOrNull(p) {
  try {
    const st = fs.statSync(p);
    return st;
  } catch {
    return null;
  }
}

function isProbablyFileRequest(urlPath) {
  const clean = urlPath.split('?')[0];
  return path.extname(clean) !== '';
}

function cacheHeadersFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return { 'Cache-Control': 'no-cache' };

  // 开发期一律 no-store：否则「改了 js/css 但刷新没变化」——浏览器拿的是缓存里的旧模块，
  // 曾经因此出现过"修好了还是白屏"的假象（缓存里还是坏的那个 wiki.js）。
  if (config.env !== 'production') return { 'Cache-Control': 'no-store' };

  if (ext === '.woff2' || ext === '.woff' || ext === '.ttf' || ext === '.otf') {
    return { 'Cache-Control': 'public, max-age=604800, must-revalidate' };
  }
  if (['.webp', '.avif', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico'].includes(ext)) {
    return { 'Cache-Control': 'public, max-age=86400, must-revalidate' };
  }
  if (['.css', '.js', '.mjs'].includes(ext)) {
    // 生产环境也只用 5 分钟：本站仍在频繁改版，避免用户长时间拿到旧前端
    return { 'Cache-Control': 'public, max-age=300, must-revalidate' };
  }
  return { 'Cache-Control': 'no-cache' };
}

/** 可压缩类型（图片/字体已压缩过，不再压） */
const COMPRESSIBLE = /^(text\/|application\/(json|xml|manifest\+json|javascript)|image\/svg)/;

/** 发送一个已存在的文件（支持 HEAD + gzip；图片/字体跳过压缩） */
function sendFile(req, res, filePath, extraHeaders = {}) {
  const st = statOrNull(filePath);
  if (!st || !st.isFile()) return false;
  applySecurityHeaders(res);
  const contentType = contentTypeOf(filePath);
  const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  const useGzip = acceptsGzip && COMPRESSIBLE.test(contentType) && st.size > 1024;

  const headers = {
    'Content-Type': contentType,
    ...cacheHeadersFor(filePath),
    Vary: 'Accept-Encoding',
    ...(useGzip ? { 'Content-Encoding': 'gzip' } : { 'Content-Length': st.size }),
    ...extraHeaders,
  };
  if (!useGzip) headers['Last-Modified'] = st.mtime.toUTCString();

  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return true; }
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => { try { res.destroy(); } catch { /* noop */ } });
  // 客户端中途断开（刷新/取消预加载）时必须主动销毁读流，否则文件句柄会一直挂着——
  // 表现就是"备份 zip 时提示文件正由另一进程使用"（踩过）。
  const cleanup = () => { if (!stream.destroyed) stream.destroy(); };
  res.on('close', cleanup);
  res.on('error', cleanup);
  if (useGzip) stream.pipe(zlib.createGzip({ level: 6 })).pipe(res);
  else stream.pipe(res);
  return true;
}

/**
 * 把 content.json 里的主题外观值（底图明暗等）注入成 <style> 覆盖 tokens.css 的默认值。
 * 这样作者可以在维护后台直接调，而不需要改代码重新部署（数据文件部署时不会被覆盖）。
 */
function themeStyleTag(content, nonce) {
  const theme = (content && content.theme) || {};
  const vars = [
    ['--bg-opacity', theme.bgOpacity],
    ['--bg-boost', theme.bgBoost],
    ['--bg-veil-top', theme.bgVeilTop],
    ['--bg-veil-mid', theme.bgVeilMid],
    ['--bg-veil-bottom', theme.bgVeilBottom],
  ]
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)))
    .map(([k, v]) => `${k}:${Number(v)}`);
  if (!vars.length) return '';
  return `<style nonce="${nonce}">:root{${vars.join(';')}}</style>`;
}

/**
 * 渲染 index.html 并注入内容快照。
 * 注入方式：把 <!--DREAM_CONTENT--> 占位替换为带 nonce 的 script 标签。
 * CSP 允许 'self' + 本次 nonce，其余一律禁止。
 */
function renderIndexHtml(snapshot, extraEnv = {}) {
  const indexPath = path.join(config.paths.publicDir, 'index.html');
  if (!fs.existsSync(indexPath)) return null;
  let html = fs.readFileSync(indexPath, 'utf8');
  const nonce = crypto.randomBytes(16).toString('base64');
  const payload = JSON.stringify({
    content: snapshot.data,
    version: snapshot.version,
    unresolved: snapshot.unresolved,
    env: {
      name: config.site.name,
      version: config.site.version,
      adminEnabled: Boolean(config.admin.pathSegment),
      // 只有本机打开后台页时才把路径交给前端，公开页面拿不到
      ...extraEnv,
    },
  })
    // 防脚本逃逸：把 < > & 转成 unicode 转义
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  const tag = `<script nonce="${nonce}">window.__DREAM_CONTENT__=${payload};</script>`;
  // 主题外观（底图明暗等）放在样式表之后，才能覆盖 tokens.css 的默认值
  const themeTag = themeStyleTag(snapshot.data, nonce);
  const headInject = themeTag ? `${tag}\n${themeTag}` : tag;
  if (html.includes('<!--DREAM_CONTENT-->')) {
    html = html.replace('<!--DREAM_CONTENT-->', headInject);
  } else if (html.includes('</head>')) {
    html = html.replace('</head>', `${headInject}\n</head>`);
  } else {
    html = headInject + html;
  }
  const csp = [
    "default-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `style-src 'self' 'nonce-${nonce}'`,
    `script-src 'self' 'nonce-${nonce}'`,
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
  return { html, csp, nonce };
}

function serveIndex(req, res, snapshot, extraEnv = {}) {
  const rendered = renderIndexHtml(snapshot, extraEnv);
  if (!rendered) return fail(req, res, 503, 'INDEX_MISSING', '站点前端尚未就绪');
  applySecurityHeaders(res);
  const raw = Buffer.from(rendered.html, 'utf8');
  const useGzip = raw.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  const body = useGzip ? zlib.gzipSync(raw, { level: 6 }) : raw;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    Vary: 'Accept-Encoding',
    ...(useGzip ? { 'Content-Encoding': 'gzip' } : {}),
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': rendered.csp,
  });
  if (req.method === 'HEAD') res.end(); else res.end(body);
  return true;
}

/**
 * 静态分发主入口。返回 true 表示已处理。
 * SPA 规则：无扩展名且非 /api 的 GET → index.html（由前端路由接管）
 */
function serveStatic(req, res, urlPath, snapshot) {
  const target = safeResolve(urlPath);
  if (!target) return fail(req, res, 403, 'FORBIDDEN_PATH', '路径非法');

  const st = statOrNull(target);
  if (st && st.isDirectory()) {
    // 目录请求（含根路径 '/'）必须走 serveIndex，才能注入内容快照与 CSP；
    // 直接 sendFile 会把未注入的裸 index.html 发出去（冒烟测试抓到过这个 bug）。
    const indexInDir = path.join(target, 'index.html');
    if (statOrNull(indexInDir)) return serveIndex(req, res, snapshot);
  }
  if (st && st.isFile()) return sendFile(req, res, target);

  if (!isProbablyFileRequest(urlPath)) return serveIndex(req, res, snapshot);
  return false;   // 明确的文件请求但不存在 → 交给调用方 404
}

module.exports = { MIME, contentTypeOf, safeResolve, serveStatic, serveIndex, sendFile, renderIndexHtml };
