# 自检脚本（tools/verify/）

四层验证，从"能不能跑"到"渲染对不对"逐层加严。全部只用 Node 内置模块，**不需要安装任何测试框架**。

| 层次 | 脚本 | 需要什么 | 主要检查 |
|---|---|---|---|
| 静态 | `static-check.mjs` | Node | 逐文件编译、模块依赖图、DOM id、CSS 类名、素材引用、占位符 |
| 渲染 | `render-test.mjs` | Node（内置 DOM 桩） | 把前端模块真跑一遍，逐路由断言渲染内容 |
| HTTP | `http-check.mjs` | 已启动的站点 | 逐页 200、接口、gzip、首屏体积、图片位清单 |
| 浏览器 | `browser-check.mjs` | Chrome + `playwright-core` | 真实浏览器逐页渲染、控制台错误、截图、交互 |

前两层不需要网络也不需要浏览器，适合每次改完随手跑；后两层需要先把站点跑起来。

## 0. 先把站点跑起来

```bash
node server/server.js          # 默认 http://127.0.0.1:4173
# Windows 也可以双击仓库根目录的 start.cmd
```

端口由 `.env` 的 `PORT` 决定；下面的命令默认连 `http://127.0.0.1:4173`，
可用 `--base` 指向其它地址（例如线上站点）。

## 1. `static-check.mjs` —— 静态检查（不需要网络/浏览器）

```bash
node tools/verify/static-check.mjs
```

- **第 0 项是逐文件编译检查**：只要有一个前端模块有语法错误，静态 `import` 它的入口模块就会整体加载失败，
  页面直接白屏。这里用真正的动态 `import` 编译每个模块，只把 `SyntaxError` 判为失败
  （`node --check` 在某些环境下会漏报）；
- 模块依赖图与导出符号是否被正确引用；
- `index.html` 里的 DOM id 与 JS 引用是否对得上；
- JS 里用到的 class 是否在 CSS 里有定义（警告级，容忍工具类）；
- 素材引用路径是否存在、占位符是否都被用到；
- 服务端注入锚点 `<!--DREAM_CONTENT-->` 是否还在。

## 2. `render-test.mjs` —— 渲染自检（不需要浏览器）

```bash
node tools/verify/render-test.mjs
node tools/verify/render-test.mjs --base http://127.0.0.1:4173
```

在 Node 里用 DOM 桩把前端模块真实执行一遍：启动流程 → 头部导航 → 页脚 → 背景层 →
**逐路由的内容断言**（不是只看长度，而是检查该页该有的文字/卡片确实渲染出来了）→ 中英切换往返。

它不是浏览器，不做布局、样式、图片解码与动画的验证；那部分交给 `browser-check.mjs`。

## 3. `http-check.mjs` —— HTTP 层检查（需要站点已启动）

```bash
node tools/verify/http-check.mjs
node tools/verify/http-check.mjs --base http://127.0.0.1:4173
node tools/verify/http-check.mjs --public          # 线上公开地址的只读检查
```

- 逐页请求，断言 200 + 响应里确实有内容快照 + 记录响应体大小；
- `/api/*` 接口断言 `ok:true`，并打印数据集条数；
- 站点素材（logo / favicon 等）与 `index.html` 引用的全部静态资源可达性（防止 404）；
- gzip 是否真的生效（对比传输字节与解压后字节）；
- 首屏（HTML + CSS + 入口 JS，gzip 后）总体积；
- 关卡/大关的**图片位清单**：共多少个路径、还有多少个尚未放图。

输出：控制台表格 + `tools/verify/http-report.json`。

## 4. `browser-check.mjs` —— 浏览器逐页验证（需要 Chrome）

```bash
node tools/verify/browser-check.mjs
node tools/verify/browser-check.mjs --headed        # 显示浏览器窗口
node tools/verify/browser-check.mjs --only /wiki/items
node tools/verify/browser-check.mjs --base http://127.0.0.1:4173
```

**依赖 `playwright-core`**（只是驱动库，不会下载任何浏览器二进制；浏览器一律用
`channel: 'chrome'` 驱动系统已装的 Chrome）。查找顺序：

1. 环境变量 `PLAYWRIGHT_CORE` 指向的目录；
2. 仓库内 `node_modules/playwright-core`；
3. Node 模块解析（全局或上级目录安装的副本）。

任选一种即可，例如 `npm i -D playwright-core`，或

```powershell
$env:PLAYWRIGHT_CORE = "<某处>\node_modules\playwright-core"
```

它会做：

1. 15 个页面 × 2 个视口（桌面 1920×1080 + 移动 390×844）逐页访问，断言 200 且 `#app` 有实际内容；
2. 全程监听 `console` / `pageerror` / `requestfailed` / 4xx-5xx 响应，收集全部错误；
3. 逐页截图到 `tools/verify/shots/`；
4. 交互校验：中英切换、物品页搜索、关卡图片位占位框数量；
5. 若 `--base` 是本机且存在 `.admin-password.txt`，额外检查维护后台的「外观」面板
   （登录 → 断言 5 个滑块 → 拖动并断言实时预览写进了 `:root` → 恢复默认），**只预览不保存**，不会改动数据；
6. 生成 `tools/verify/report.md`（通过项 / 失败项 / 错误明细 / 截图清单）。

Windows 上可以直接双击 `run-browser-check.cmd`，它会先切到仓库根目录再执行。

## 5. 诊断小工具

`bisect-syntax.mjs <file>`：当某个模块报语法错误、但肉眼找不到位置时，
二分定位"从第几行开始出现该错误"（以报错信息是否变化为判据）。

## 目录与产物

```
tools/verify/
├── static-check.mjs        静态检查（无需浏览器）
├── render-test.mjs         渲染自检（无需浏览器）
├── http-check.mjs          HTTP 层检查
├── browser-check.mjs       浏览器逐页验证
├── run-browser-check.cmd   Windows 双击入口
├── bisect-syntax.mjs       语法错误二分定位
├── http-report.json        HTTP 层报告（运行后生成）
├── report.md / report.json 浏览器验证报告（运行后生成）
└── shots/                  截图（运行后生成：桌面 + 移动两套）
```
