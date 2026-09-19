#!/usr/bin/env node
'use strict';
/**
 * reset-admin-password.js —— 设置维护后台口令（本地/目标机都跑这个）
 *
 * 安全设计：
 *   - 只把 **scrypt 哈希** 写进 .env；明文口令只在控制台显示一次
 *   - 默认**不打印**口令，而是写进 .admin-password.txt（已被 .gitignore 忽略），
 *     这样口令不会经过任何人的对话记录，你自己打开文件看即可
 *   - 同时确保 .env 里有随机 ADMIN_PATH（不用 /admin 这种可猜路径）
 *
 * 用法（在 site/ 目录下执行）：
 *   node tools/reset-admin-password.js                 # 生成随机强口令
 *   node tools/reset-admin-password.js --print         # 生成并把口令打到控制台
 *   node tools/reset-admin-password.js --password "自定义口令"   # 用你指定的口令
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SITE_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(SITE_ROOT, '.env');
const ENV_EXAMPLE = path.join(SITE_ROOT, '.env.example');
const PLAIN_PATH = path.join(SITE_ROOT, '.admin-password.txt');
const serverLib = path.join(SITE_ROOT, 'server', 'lib');

const { hashPassword } = require(path.join(serverLib, 'auth.js'));

function randomPassword(len = 20) {
  // 去掉易混字符（0/O/1/l/I），方便手输
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len * 2);
  let out = '';
  for (let i = 0; out.length < len && i < bytes.length; i += 1) {
    const v = bytes[i];
    if (v < 256 - (256 % alphabet.length)) out += alphabet[v % alphabet.length];
  }
  return out;
}

function randomAdminPath() {
  return `m-${crypto.randomBytes(5).toString('hex')}`;
}

function readEnv() {
  const from = fs.existsSync(ENV_PATH) ? ENV_PATH : ENV_EXAMPLE;
  return fs.existsSync(from) ? fs.readFileSync(from, 'utf8') : '';
}

function setEnvValue(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  return `${text.replace(/\s*$/, '')}\n${line}\n`;
}

function parseArgs(argv) {
  const out = { print: false, password: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--print') out.print = true;
    else if (argv[i] === '--password') { out.password = argv[i + 1]; i += 1; }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const password = args.password || randomPassword(20);
  if (password.length < 8) {
    console.error('口令至少 8 位');
    process.exit(1);
  }

  let env = readEnv();
  if (!env.trim()) {
    console.error(`找不到 .env 模板：${ENV_EXAMPLE}`);
    process.exit(1);
  }

  // 每次重置都换一个后台路径（减少被扫的风险）
  const adminPath = randomAdminPath();
  env = setEnvValue(env, 'ADMIN_PATH', adminPath);
  env = setEnvValue(env, 'ADMIN_PASSWORD_HASH', await hashPassword(password));
  if (!/^PORT=/m.test(env)) env = setEnvValue(env, 'PORT', '4173');
  fs.writeFileSync(ENV_PATH, env, { encoding: 'utf8', mode: 0o600 });

  fs.writeFileSync(PLAIN_PATH, [
    '# 本文件由 tools/reset-admin-password.js 生成，已被 .gitignore 忽略',
    '# 用途：维护后台登录口令（明文，仅本机可读）',
    `# 生成时间：${new Date().toISOString()}`,
    '# 确认记住后，建议删除本文件。',
    '',
    `后台路径：/${adminPath}`,
    `口令：${password}`,
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });

  console.log('已更新 .env（只写入 scrypt 哈希，不含明文）');
  console.log(`后台路径：/${adminPath}`);
  console.log(`明文口令已写入：${PLAIN_PATH}`);
  if (args.print) console.log(`口令：${password}`);
  console.log('');
  console.log('提示：重启服务后生效；记牢后建议删除 .admin-password.txt。');
}

main().catch((err) => {
  console.error('失败：', err.message);
  process.exit(1);
});
