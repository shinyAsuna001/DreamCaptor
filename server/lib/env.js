'use strict';
/**
 * env.js —— 路径与配置（零依赖，Node 18 兼容）
 *
 * 设计要点：
 *  - 所有路径基于 __dirname 绝对化，**不依赖 cwd**（旧站 server_fixed.js 用 './users.json'
 *    这种相对路径，换工作目录就崩 —— 这里不重蹈覆辙）。
 *  - .env 只做极简 KEY=VALUE 解析，不引第三方 dotenv。
 *  - 敏感值（管理员哈希）只从 .env 读，代码里不留默认明文。
 */

const fs = require('fs');
const path = require('path');

const LIB_DIR = __dirname;                              // site/server/lib
const SERVER_DIR = path.resolve(LIB_DIR, '..');         // site/server
const SITE_ROOT = path.resolve(SERVER_DIR, '..');       // site
const ENV_PATH = path.join(SITE_ROOT, '.env');

/** 极简 .env 解析：已存在的真实环境变量优先，不被文件覆盖。 */
function loadEnvFile(file = ENV_PATH) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(SITE_ROOT, 'data');
const PUBLIC_DIR = path.join(SITE_ROOT, 'public');
const LOG_DIR = path.join(SITE_ROOT, 'logs');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const config = {
  env: process.env.NODE_ENV || 'development',
  host: process.env.HOST || '0.0.0.0',
  port: Number.parseInt(process.env.PORT || '4173', 10),
  trustProxy: process.env.TRUST_PROXY === '1',

  paths: {
    siteRoot: SITE_ROOT,
    serverDir: SERVER_DIR,
    publicDir: PUBLIC_DIR,
    dataDir: DATA_DIR,
    backupDir: BACKUP_DIR,
    logDir: LOG_DIR,
    envPath: ENV_PATH,
  },

  site: {
    name: '捕梦者：崩坏的梦境',
    version: '1.0.0',
  },

  admin: {
    // 后台路径：随机串，几乎不可能被猜到；缺省禁用后台（不设就返回 404）
    pathSegment: (process.env.ADMIN_PATH || '').trim(),
    passwordHash: (process.env.ADMIN_PASSWORD_HASH || '').trim(),
    sessionTtlMs: Number.parseInt(process.env.ADMIN_SESSION_TTL_MS || String(2 * 60 * 60 * 1000), 10),
    maxFailures: Number.parseInt(process.env.ADMIN_MAX_FAILURES || '5', 10),
    lockoutMs: Number.parseInt(process.env.ADMIN_LOCKOUT_MS || String(15 * 60 * 1000), 10),
  },

  session: {
    cookieName: 'dream_sid',
    adminCookieName: 'dream_asid',
    ttlMs: Number.parseInt(process.env.SESSION_TTL_MS || String(7 * 24 * 60 * 60 * 1000), 10),
  },

  limits: {
    jsonBodyBytes: Number.parseInt(process.env.MAX_JSON_BODY || String(1024 * 1024), 10), // 后台整体保存内容需要余量
    commentMaxLength: 1000,
    usernameMin: 3,
    usernameMax: 16,
    passwordMin: 8,
    passwordMax: 128,
    storageKeep: 10,          // 每个数据文件保留最近 10 份备份
    logKeepDays: 7,
  },

  security: {
    // http 明文环境下不能加 Secure（已知取舍，接上 HTTPS 后应改为 Secure）
    cookieSecure: false,
    sameSite: 'Lax',
  },
};

function ensureRuntimeDirs() {
  for (const dir of [config.paths.dataDir, config.paths.backupDir, config.paths.logDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isAdminEnabled() {
  return Boolean(config.admin.pathSegment && config.admin.passwordHash);
}

module.exports = { config, loadEnvFile, ensureRuntimeDirs, isAdminEnabled };
