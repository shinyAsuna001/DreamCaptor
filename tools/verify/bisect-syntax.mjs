/**
 * 诊断脚本：二分定位语法错误（用「报错信息是否变化」作为判据，规避截断本身造成的解析失败）
 * 用法：node tools/verify/bisect-syntax.mjs public/js/main.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const rel = process.argv[2];
if (!rel) { console.error('用法：node tools/verify/bisect-syntax.mjs <file>'); process.exit(2); }
const file = path.resolve(rel);
const source = fs.readFileSync(file, 'utf8');
const lines = source.split(/\r?\n/);

async function errorOf(text, tag) {
  const tmp = path.join(os.tmpdir(), `bisect-${process.pid}-${tag}.mjs`);
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    await import(pathToFileURL(tmp).href + `?t=${tag}`);
    fs.unlinkSync(tmp);
    return null;                       // 竟然能加载（例如只到某一行就结束）
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { name: err.name, message: err.message, syntax: err instanceof SyntaxError };
  }
}

const full = await errorOf(source, 'full');
if (!full || !full.syntax) {
  console.log(`完整文件没有语法错误：${JSON.stringify(full)}`);
  process.exit(0);
}
console.log(`完整文件报错：${full.message}`);
const target = full.message;

// 二分：找"最小的行数 n 使得报错信息仍是原始那条"
let lo = 1;
let hi = lines.length;
let found = -1;
while (lo <= hi) {
  const mid = Math.floor((lo + hi) / 2);
  const prefix = `${lines.slice(0, mid).join('\n')}\n`;
  const e = await errorOf(prefix, `p${mid}`);
  const same = e && e.syntax && e.message === target;
  if (same) { found = mid; hi = mid - 1; } else { lo = mid + 1; }
}

if (found < 0) {
  console.log('二分未找到（报错可能来自多个位置或 import 链）');
  process.exit(1);
}
console.log(`首个触发该错误的位置：第 ${found} 行`);
for (let i = Math.max(0, found - 6); i < Math.min(lines.length, found + 4); i += 1) {
  console.log(`${String(i + 1).padStart(4)}${i + 1 === found ? ' >>' : '   '} ${lines[i]}`);
}
