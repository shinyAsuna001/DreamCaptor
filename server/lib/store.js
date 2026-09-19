'use strict';
/**
 * store.js —— JSON 文件存储：串行写队列 + 原子写 + 写前备份 + 损坏回退
 *
 * 四条硬要求：
 *   1) 内存写队列串行化所有写入（杜绝并发覆盖）
 *   2) 原子写：写临时文件 → fsync → renameSync
 *   3) 每次写入前自动备份到 data/backups/，保留最近 N 份
 *   4) 读取带容错：文件损坏 → 回退到最近可用备份并告警
 *
 * 不照抄旧站（旧站是 writeFileSync 直写、无备份、无原子性）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('./env');
const logger = require('./logger');

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 一个 JSON 文件对应一个 JsonStore 实例。 */
class JsonStore {
  /**
   * @param {string} fileName  data/ 下的文件名，如 'content.json'
   * @param {object} options   { defaultValue, keep, pretty }
   */
  constructor(fileName, options = {}) {
    this.fileName = fileName;
    this.filePath = path.join(config.paths.dataDir, fileName);
    this.defaultValue = options.defaultValue === undefined ? null : options.defaultValue;
    this.keep = options.keep || config.limits.storageKeep;
    this.pretty = options.pretty !== false;
    this.cache = undefined;
    this.queue = Promise.resolve();
    this.lastBackup = null;
  }

  /** 同步读取（带容错与备份回退），结果进缓存。 */
  load() {
    fs.mkdirSync(config.paths.dataDir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      this.cache = this.defaultValue;
      this._writeFile(this.cache);
      logger.info(`store: 初始化数据文件 ${this.fileName}`);
      return this.cache;
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      this.cache = JSON.parse(raw);
      this.loadedMtimeMs = this._mtimeMs();
      return this.cache;
    } catch (err) {
      logger.error(`store: ${this.fileName} 解析失败，尝试回退备份`, { error: err.message });
      const recovered = this._recoverFromBackup();
      this.cache = recovered === undefined ? this.defaultValue : recovered;
      this._writeFile(this.cache);
      this.loadedMtimeMs = this._mtimeMs();
      return this.cache;
    }
  }

  _mtimeMs() {
    try { return fs.statSync(this.filePath).mtimeMs; } catch { return 0; }
  }

  /** 取当前值（必要时先 load）。返回的是内部引用，调用方不要直接改。 */
  get() {
    if (this.cache === undefined) this.load();
    else this._reloadIfChangedOnDisk();
    return this.cache;
  }

  /**
   * 有人直接用手编辑 data/*.json 时，自动重新读取（省掉"改完还要重启服务"的坑）。
   * 只比 mtime，代价是一次 statSync；自己写入后会把 mtime 记下来，不会自我触发。
   */
  _reloadIfChangedOnDisk() {
    const mtime = this._mtimeMs();
    if (!mtime || mtime === this.loadedMtimeMs) return false;
    logger.info(`store: 检测到 ${this.fileName} 被外部修改，自动重新载入`);
    this.load();
    return true;
  }

  /**
   * 串行写入：fn(currentValue) 返回新值（或 undefined 表示只做副作用）。
   * 返回 Promise，resolve 为写入后的值。
   */
  update(fn) {
    const run = async () => {
      const current = this.get();
      const next = fn(current);
      const value = next === undefined ? current : next;
      this._backupCurrent();
      this._writeFile(value);
      this.cache = value;
      return value;
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  /** 整体替换（等价于 update(() => value)，但语义更清楚）。 */
  save(value) {
    return this.update(() => value);
  }

  // ------------------------------------------------------------- 内部

  _serialize(value) {
    return this.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  }

  _writeFile(value) {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`);
    const text = this._serialize(value);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);          // 先落盘，再改名 —— rename 才是原子的
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.filePath);
    this.loadedMtimeMs = this._mtimeMs();   // 记下自己写入后的 mtime，避免误判"外部修改"
  }

  _backupCurrent() {
    if (!fs.existsSync(this.filePath)) return null;
    try {
      fs.mkdirSync(config.paths.backupDir, { recursive: true });
      const base = path.basename(this.fileName, '.json');
      const name = `${base}.${timestamp()}.json`;
      const dest = path.join(config.paths.backupDir, name);
      fs.copyFileSync(this.filePath, dest);
      this.lastBackup = name;
      this._pruneBackups(base);
      return name;
    } catch (err) {
      logger.warn(`store: 备份 ${this.fileName} 失败`, { error: err.message });
      return null;
    }
  }

  _backupFiles() {
    const base = path.basename(this.fileName, '.json');
    try {
      return fs.readdirSync(config.paths.backupDir)
        .filter((n) => n.startsWith(`${base}.`) && n.endsWith('.json'))
        .sort()                        // 时间戳格式可字典序排序 = 时间序
        .map((n) => ({ name: n, path: path.join(config.paths.backupDir, n), mtimeMs: fs.statSync(path.join(config.paths.backupDir, n)).mtimeMs }));
    } catch {
      return [];
    }
  }

  _pruneBackups(base) {
    const files = this._backupFiles();
    const excess = files.length - this.keep;
    for (let i = 0; i < excess; i += 1) {
      try { fs.unlinkSync(files[i].path); } catch { /* 忽略 */ }
    }
  }

  _recoverFromBackup() {
    const files = this._backupFiles();
    for (let i = files.length - 1; i >= 0; i -= 1) {
      try {
        const parsed = JSON.parse(fs.readFileSync(files[i].path, 'utf8'));
        logger.warn(`store: ${this.fileName} 已从备份恢复`, { backup: files[i].name });
        return parsed;
      } catch { /* 继续往前找 */ }
    }
    logger.error(`store: ${this.fileName} 无可用备份，使用默认值`);
    return undefined;
  }

  /** 备份列表（新的在前），供后台"一键恢复"用。 */
  listBackups() {
    return this._backupFiles()
      .map((f) => ({
        name: f.name,
        bytes: fs.statSync(f.path).size,
        mtime: new Date(f.mtimeMs).toISOString(),
      }))
      .reverse();
  }

  /** 回滚到指定备份（缺省=最近一份），返回恢复后的值。 */
  async rollback(backupName) {
    const files = this._backupFiles();
    if (!files.length) throw new Error('没有可用备份');
    const target = backupName
      ? files.find((f) => f.name === backupName)
      : files[files.length - 1];
    if (!target) throw new Error(`备份不存在：${backupName}`);
    const value = JSON.parse(fs.readFileSync(target.path, 'utf8'));
    await this.save(value);           // 走正常写入路径（含当前值备份）
    logger.warn(`store: ${this.fileName} 已回滚`, { backup: target.name });
    return value;
  }

  /** 内容指纹（用于 ETag / 变更检测）。 */
  fingerprint() {
    const text = this._serialize(this.get());
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  }
}

module.exports = { JsonStore, timestamp };
