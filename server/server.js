'use strict';
/**
 * server.js —— 《捕梦者：崩坏的梦境》官网 HTTP 服务（Node 内置模块，零 npm 依赖）
 *
 * 工程模式沿用目标机既有样板 `server_fixed.js`（单文件 http 服务 + 手写路由 + 静态托管 + MIME 表），
 * 但**修掉它的全部已知缺陷**：明文密码 → scrypt；无原子写 → 串行队列 + 原子写 + 备份；
 * 无限流 → 内存限流 + 失败锁定；MIME 缺 .webp/.woff2 → 补齐；相对路径依赖 cwd → 全部绝对路径。
 *
 * 运行：
 *   开发机   npm 不需要，直接 `node server/server.js`（默认 127.0.0.1:4173，见 .env）
 *   目标机   ECS 上由计划任务拉起，监听 3002（.env 里配 PORT=3002）
 */

const http = require('http');
const { config, ensureRuntimeDirs, isAdminEnabled } = require('./lib/env');
const logger = require('./lib/logger');
const { applySecurityHeaders, fail, clientIp } = require('./lib/http-util');
const { serveStatic, serveIndex } = require('./lib/static');
const contentStore = require('./lib/content');
const admin = require('./lib/admin');
const { handleApi } = require('./lib/api');
const { limiter, loginGuard, adminGuard } = require('./lib/ratelimit');

ensureRuntimeDirs();

const startedAt = Date.now();

function requestLogger(req, res) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const urlPath = req.url.split('?')[0];
    logger.access(`${req.method} ${urlPath} ${res.statusCode}`, {
      ip: clientIp(req),
      status: res.statusCode,
      ms: Math.round(ms),
    });
  });
}

const server = http.createServer(async (req, res) => {
  requestLogger(req, res);
  applySecurityHeaders(res);

  const urlPath = req.url.split('?')[0];

  // 只接受 GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) {
    return fail(req, res, 405, 'METHOD_NOT_ALLOWED', '方法不允许');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { Allow: 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS' });
    return res.end();
  }

  try {
    // 1) 维护后台页面：仅本机可达；非本机一律 404（连"存在"都不暴露）
    if (admin.isAdminPath(urlPath)) {
      if (!admin.canReachAdmin(req)) return fail(req, res, 404, 'NOT_FOUND', '未找到');
      if (req.method === 'GET' || req.method === 'HEAD') {
        // 只在本机打开后台页时把后台路径注入前端环境（公开页面拿不到这个值）
        return serveIndex(req, res, contentStore.buildSnapshot(), { adminPath: `/${config.admin.pathSegment}` });
      }
      return fail(req, res, 405, 'METHOD_NOT_ALLOWED', '方法不允许');
    }

    // 2) API
    if (urlPath.startsWith('/api/')) {
      const handled = await handleApi(req, res);
      if (handled) return undefined;
    }

    // 3) 静态资源 / SPA
    if (req.method === 'GET' || req.method === 'HEAD') {
      const snapshot = contentStore.buildSnapshot();
      const handled = serveStatic(req, res, urlPath, snapshot);
      if (handled) return undefined;
      return fail(req, res, 404, 'NOT_FOUND', '资源不存在');
    }

    return fail(req, res, 404, 'NOT_FOUND', '未找到');
  } catch (err) {
    logger.error('server: 未捕获异常', { path: urlPath, error: err.message, stack: err.stack });
    if (!res.headersSent) fail(req, res, 500, 'INTERNAL_ERROR', '服务器内部错误');
    return undefined;
  }
});

// ------------------------------------------------------------------ 启动与收尾

function printBanner() {
  const { host, port } = config;
  const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
  logger.info('==============================================');
  logger.info(` ${config.site.name} 官网服务已启动`);
  logger.info(` 环境      : ${config.env}`);
  logger.info(` 监听      : ${host}:${port}`);
  logger.info(` 本地访问  : http://${shown}:${port}/`);
  if (!isAdminEnabled()) {
    logger.warn(' 维护后台  : 未启用（.env 里缺 ADMIN_PATH / ADMIN_PASSWORD_HASH）');
  } else {
    logger.info(` 维护后台  : http://127.0.0.1:${port}/${config.admin.pathSegment}  （仅本机可访问）`);
  }
  logger.info(` 数据目录  : ${config.paths.dataDir}`);
  logger.info('==============================================');
}

const maintenanceTimer = setInterval(() => {
  limiter.cleanup();
  loginGuard.cleanup();
  adminGuard.cleanup();
  admin.pruneSessions();
  logger.pruneOldLogs();
}, 10 * 60 * 1000);
if (maintenanceTimer.unref) maintenanceTimer.unref();

server.listen(config.port, config.host, () => {
  printBanner();
  logger.info('server: listening', { port: config.port, host: config.host, pid: process.pid });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`端口 ${config.port} 已被占用：可能服务已经在运行。先执行 stop.cmd（或改 .env 里的 PORT），不要重复启动。`);
  } else {
    logger.error('server: 启动/运行失败', { error: err.message, code: err.code });
  }
  process.exitCode = 1;
});

function shutdown(signal) {
  logger.info(`server: 收到 ${signal}，开始优雅关闭`);
  server.close(() => {
    limiter.stop();
    loginGuard.stop();
    adminGuard.stop();
    logger.info('server: 已关闭');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error('server: unhandledRejection', { reason: String(reason) });
});

module.exports = { server, startedAt };
