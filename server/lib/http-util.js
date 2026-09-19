'use strict';
/**
 * http-util.js —— HTTP 小工具：响应、请求体、客户端 IP、安全响应头
 * 统一响应体：{ ok, data } / { ok:false, error:{ code, message } }
 */

const zlib = require('zlib');
const { config } = require('./env');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
};

function applySecurityHeaders(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

/** 判断是否值得 gzip（小于 1KB 压了反而变大） */
function shouldGzip(req, size) {
  return size > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
}

function sendJson(req, res, statusCode, payload, extraHeaders = {}) {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const useGzip = shouldGzip(req, raw.length);
  const body = useGzip ? zlib.gzipSync(raw, { level: 6 }) : raw;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    Vary: 'Accept-Encoding',
    ...(useGzip ? { 'Content-Encoding': 'gzip' } : {}),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function ok(req, res, data, extraHeaders) {
  sendJson(req, res, 200, { ok: true, data: data === undefined ? null : data }, extraHeaders);
}

function created(req, res, data) {
  sendJson(req, res, 201, { ok: true, data: data === undefined ? null : data });
}

function fail(req, res, statusCode, code, message, extraHeaders) {
  sendJson(req, res, statusCode, { ok: false, error: { code, message } }, extraHeaders);
}

/** 读取并解析 JSON 请求体，带体积上限；非法 JSON 抛错由上层转 400。 */
function readJsonBody(req, maxBytes = config.limits.jsonBodyBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error('请求体过大');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text.trim() ? JSON.parse(text) : {});
      } catch {
        const err = new Error('请求体不是合法 JSON');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** 客户端 IP：默认取 socket；只有显式开启 TRUST_PROXY 才信 X-Forwarded-For。 */
function clientIp(req) {
  if (config.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  }
  const addr = (req.socket && req.socket.remoteAddress) || '';
  return addr.replace(/^::ffff:/, '');
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** 是否来自本机（维护后台只允许本机访问） */
function isLoopback(req) {
  return LOOPBACK.has(clientIp(req));
}

/** 同源校验：写操作拒绝跨站表单/脚本提交（无 HTTPS 环境下的 CSRF 兜底） */
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                     // 同源 fetch 通常不带 Origin 的同站请求由 SameSite 兜底
  try {
    const o = new URL(origin);
    const host = req.headers.host || '';
    return o.host === host;
  } catch {
    return false;
  }
}

module.exports = {
  SECURITY_HEADERS,
  applySecurityHeaders,
  sendJson,
  ok,
  created,
  fail,
  readJsonBody,
  clientIp,
  isLoopback,
  isSameOrigin,
};
