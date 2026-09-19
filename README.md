# 《捕梦者：崩坏的梦境》官方网站

《捕梦者：崩坏的梦境》是一张 **Minecraft Java 1.20.4 纯原版肉鸽地图**（三大层九张主题关卡、每局随机构筑、
支持多人联机）。本仓库是它的官方网站源码。

技术选型：**原生 HTML / CSS / ES Module 前端 + Node.js 内置模块后端，零第三方依赖、零构建步骤**。
改完文件刷新页面即生效，不需要打包、不需要 `npm install`。

## 功能

- **页面**：首页、地图介绍、百科（关卡 / 物品 / 职业与天赋 / 敌人 / 难度）、Q&A、下载、社区、赞助、制作组、留言板
- **中英双语**：文案写在数据里（`{"zh": "…", "en": "…"}`），英文缺失时自动回退中文
- **数据驱动**：百科条目全部来自 `data/*.json`，加内容不用改代码
- **维护后台**：占位符集中填、外观（底图明暗等）可视化调节、站点内容与图鉴数据在线编辑、备份与一键回滚、评论管理
- **默认安全**：后台仅限本机访问、口令只存 scrypt 哈希、会话令牌只存 sha256、写入原子化并自动备份

## 环境要求

| 用途 | 需要 |
|---|---|
| 运行站点 | Node.js 18 或更高（只用内置模块）；浏览器需支持 ES Module |
| 图片素材管线（可选） | Python 3 + Pillow |
| 字体子集化（可选） | Python 3 + fontTools（带 brotli 时输出 woff2） |
| 浏览器逐页验证（可选） | 本机已安装 Chrome + `playwright-core` 模块 |

## 快速开始

```bash
git clone <本仓库地址>
cd <仓库目录>

# 可选：生成维护后台的随机访问路径与口令（不生成也可以，此时后台整体关闭）
node tools/reset-admin-password.js

# 启动，默认监听 127.0.0.1:4173
node server/server.js
```

Windows 上也可以直接双击 `start.cmd` 启动、`stop.cmd` 停止（按端口结束进程）。

站点内容、百科数据集都是随仓库一起提供的：`data/content.json`、`data/wiki-*.json`。
首次运行会在 `data/` 下自动生成运行期文件（账号、会话、评论、备份），并写入 `logs/` 日志。

## 配置

复制 `.env.example` 为 `.env`，按需修改。`.env` 已在 `.gitignore` 中，不会被提交。

| 变量 | 默认 | 说明 |
|---|---|---|
| `NODE_ENV` | `development` | `production` 下静态资源带缓存头；非 production 一律 `no-store`，便于改完刷新即生效 |
| `PORT` / `HOST` | `4173` / `0.0.0.0` | 监听端口与地址；`HOST=127.0.0.1` 时仅本机可访问 |
| `TRUST_PROXY` | `0` | 仅在 Nginx / Caddy 等反向代理之后才设为 `1`（否则不要信任 `X-Forwarded-For`） |
| `ADMIN_PATH` | 空 | 维护后台的随机访问路径段；**留空 = 后台整体禁用并返回 404** |
| `ADMIN_PASSWORD_HASH` | 空 | 管理员口令的 scrypt 哈希，由 `tools/reset-admin-password.js` 生成，不存明文 |
| `ADMIN_SESSION_TTL_MS` | `7200000` | 后台会话有效期（2 小时） |
| `ADMIN_MAX_FAILURES` / `ADMIN_LOCKOUT_MS` | `5` / `900000` | 连续失败次数上限与锁定时长 |
| `SESSION_TTL_MS` | `604800000` | 普通用户会话有效期（7 天） |
| `MAX_JSON_BODY` | `1048576` | 请求体上限（1 MB） |
| `DATA_DIR` | 空 | 数据目录；留空即仓库内的 `data/` |

## 目录结构

```
server/            后端（Node 内置模块，CommonJS）
  server.js        入口：HTTP 服务、路由、优雅退出
  lib/             env / logger / store / validate / ratelimit / auth /
                   content / comments / datasets / admin / static / http-util / api
public/            前端静态资源（零构建）
  index.html       单壳页面：业务文案不写死在 HTML 里，由服务端注入内容快照
  css/ js/ assets/ 样式、ES Module 视图、图片与字体
data/              站点内容与百科数据：content.json、wiki-*.json、assets.json
tools/             素材管线、测试与部署脚本
```

运行期还会在本地生成这些文件，都属于本机数据，不进版本库：

```
data/backups/      写入前的自动备份（每个数据文件保留最近 10 份）
data/accounts.json 注册用户
data/sessions.json 会话令牌（只存 sha256）
data/comments.json 留言与回复
logs/              按天滚动的运行日志
```

## 维护后台

维护后台**只对 `127.0.0.1` 开放**：以 `localhost` 之外的任何地址访问都会得到 404（不暴露后台是否存在）。
线上使用需要在服务器本机（远程桌面）打开，或通过 SSH 端口转发把远端端口映射到本机。

启用步骤：

```bash
# 1) 生成随机路径与口令；口令明文写在本机 .admin-password.txt（该文件不进版本库）
node tools/reset-admin-password.js

# 2) 脚本会把 ADMIN_PATH / ADMIN_PASSWORD_HASH 写进 .env（也可手动填入）

# 3) 打开 http://127.0.0.1:<PORT>/<ADMIN_PATH>
```

后台面板：**占位符**（一处填、全站替换）｜**外观**（底图不透明度、亮度增益、上中下压暗，拖动实时预览）｜
**站点内容 JSON**｜**百科数据集**｜**备份与回滚**｜**评论管理**。

页面上的「配图准备中」占位框来自数据里尚未填写的图片路径；把图片放进 `public/assets/img/` 对应路径后，
前台自动显示，无需改代码。

## 数据与写入安全

- 所有写操作走同一条路径：**串行队列 → 写前备份 → 临时文件 → `fsync` → `rename`**，
  避免并发覆盖和半截文件；
- `data/backups/` 保留最近 10 份，后台可一键恢复上一版本；
- 读取带容错：JSON 损坏时自动回退到最近可用备份，并写入告警日志。

## 安全说明

- 口令一律 `scrypt` + 随机盐，不存明文；会话令牌服务端只存 `sha256`；
- 后台：随机路径 + 仅回环地址 + 失败锁定 + 频率限制；
- 公开接口有频率限制；发表评论需要登录；请求体大小与路径穿越均有校验；
- 本项目默认以 HTTP 提供服务，未内置 TLS。生产环境建议放在反向代理之后并启用 HTTPS；
  站点未启用 TLS 时 Cookie 不能带 `Secure`。

## 工具

| 路径 | 用途 |
|---|---|
| `tools/smoke-test.mjs` | 端到端冒烟测试：前台接口、评论、后台读写与回滚，跑完自动还原被改动的数据 |
| `tools/verify/` | 四层自检：静态检查、渲染测试、HTTP 检查、浏览器逐页验证（见该目录 README） |
| `tools/reset-admin-password.js` | 生成后台随机路径与口令哈希 |
| `tools/build_assets.py` | 图片素材管线：源图 → WebP 三档（1920 / 1280 / 640）+ LQIP 模糊占位，输出清单 `data/assets.json`，并强制校验总体积预算 |
| `tools/build_fonts.py` | 字体子集化：定重 + 按站点用字裁剪，输出到 `public/assets/fonts/` |
| `tools/build_wiki_*.py` | 由官方文档生成百科数据集（物品 / 职业与天赋 / 常见问题） |
| `tools/deploy/` | Windows 服务器上的部署、服务管理与备份回滚脚本（见该目录 README） |

素材与百科生成脚本读取的是本机的原始文档与截图，属于内容维护工具；只运行站点本身不需要 Python。

## 部署

`tools/deploy/` 是一套面向 **Windows 服务器**（通过 SSH 访问）的部署脚本：
打包 → 上传 → 解包（代码与素材覆盖、`data/` 只在缺失时补种）→ 写 `.env` → 注册开机自启计划任务
→ 启动并执行远程冒烟测试。

脚本默认是**演练模式**，不加 `-Apply` 不会写任何远程文件。详见 `tools/deploy/README.md`。

## 关于

《捕梦者：崩坏的梦境》地图本体、美术与文案版权归制作组所有；本仓库为官网源码。
