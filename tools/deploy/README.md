# 部署脚本（tools/deploy/）

面向 **Windows 服务器**（通过 SSH 访问）的部署、服务管理与备份回滚脚本。

> 三个 `.ps1` 都是**纯 ASCII**：Windows PowerShell 5.1 读取 `.ps1` 用的是系统 ANSI 代码页
> （中文系统上是 GBK），UTF-8 中文注释会导致整篇解析失败，所以说明文字都写在这里。
> 所有脚本默认是**演练模式**，不加 `-Apply` 不会写任何远程文件。

## 0. 准备

- 本机：PowerShell 5.1+ 与 OpenSSH 客户端（`ssh` / `scp` 可用）；
- 服务器：Windows，已安装 Node.js 18+，可通过 SSH 登录；
- 站点目录可以放在服务器任意路径，由 `-RemoteRoot` 指定（站点会落在 `<RemoteRoot>\site`）。

**配置部署目标**（二选一）：

1. 在 `tools/deploy/` 下新建 `deploy.local.ps1`（该文件名已在 `.gitignore` 中，不会被提交）：

   ```powershell
   $LocalSshHost    = 'my-server'                  # ~/.ssh/config 里的主机别名
   $LocalRemoteRoot = 'C:\sites\DreamCatcher'      # 服务器上的部署根目录，站点会落在 <root>\site
   ```

2. 或者每次在命令行上给：`-SshHost my-server -RemoteRoot C:\sites\DreamCatcher`。

`tools/deploy/` 里如果**没有** `deploy.local.ps1`，也没有传参数，脚本会直接报错并提示怎么配。

## 1. 一键部署：`deploy-to-ecs.ps1`（在本机执行）

```powershell
# ① 只读预检：连通性 / 远程 Node 版本 / 磁盘 / 端口占用 / 目标目录是否存在
powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy\deploy-to-ecs.ps1 -PreflightOnly

# ② 演练：打印将要执行的全部动作，不写任何东西
powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy\deploy-to-ecs.ps1

# ③ 真正执行
powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy\deploy-to-ecs.ps1 -Apply
```

参数：`-Apply`（真正写入）、`-PreflightOnly`（只预检）、`-SkipTask`（不动计划任务）、
`-NoBackup`（跳过备份）、`-KeepRunning`（不停服务直接部署，可能遇到被占用文件）、
`-KeepBackups <n>`（保留几份旧版本备份，默认 3）。

八个步骤（幂等，可重复执行）：

| # | 动作 | 说明 |
|---|---|---|
| 1 | 预检 | `whoami` / `node -v` / 磁盘剩余 / 端口占用 / 目标目录是否存在 |
| 2 | 备份上一版 | 调 `ecs-backup.ps1` 打包当前线上版本，只保留最近 `-KeepBackups` 份 |
| 3 | 本地打包 | 只收 `server/ public/ tools/ README.md start.cmd stop.cmd .env.example .gitignore`；**排除** `assets-source/ logs/ data/backups/ .env .admin-password.txt` 与本机部署配置 |
| 4 | 上传 | `scp` 单个 zip 到服务器临时路径 |
| 5 | 解包 | 代码与素材**覆盖**；`data/*.json` **只在服务器上不存在时才放** |
| 6 | `.env` | 不存在则从模板生成并写入端口；已存在**保持原样**（不覆盖口令哈希） |
| 7 | 计划任务 | 调 `ecs-service.ps1 -Action install-task`（开机自启，与 SSH 登录解耦） |
| 8 | 启动 + 远程冒烟 | 重启服务后跑 `smoke-test.mjs --base http://127.0.0.1:<端口> --skip-admin` |

部署过程中不会修改服务器防火墙，也不会碰站点目录以外的文件。

## 2. 服务管理：`ecs-service.ps1`（在服务器上执行，通常通过 ssh 调）

```powershell
# 注册 / 注销开机自启计划任务（默认任务名 DreamCatcherSite，-TaskName 可改）
powershell -NoProfile -File tools\deploy\ecs-service.ps1 -Action install-task
powershell -NoProfile -File tools\deploy\ecs-service.ps1 -Action uninstall-task

# 日常
... -Action status      # Node 版本 / 端口监听 / 计划任务状态 / 数据文件数 / 磁盘 / 健康探活
... -Action start | stop | restart
... -Action logs        # 打印最新日志最后 30 行
... -Action smoke       # 跑后端冒烟测试（跳过需要口令的后台部分）
```

`-SitePath` 默认取本脚本所在位置的仓库根目录（`tools\deploy\` 往上两级），
所以把仓库放到哪里都能直接用；`-Port` 默认 3002。

## 3. 备份与回滚：`ecs-backup.ps1`（在服务器上执行）

```powershell
... -Action backup                              # 打包当前版本 → DreamCatcher.bak-<时间戳>.zip（默认留 3 份）
... -Action list                                # 列出所有备份
... -Action rollback -Name DreamCatcher.bak-20260101-101530.zip    # 回滚代码与素材（data\ 保留）
... -Action restore-data -Name <zip>            # 只恢复 data\（内容 / 评论 / 账号）
```

- `-Root` 默认取仓库根目录的上一级（备份 zip 就放在那里），所有路径都被限制在 `-Root` 之内；
- **回滚语义**：`rollback` 只替换 `server/ public/ tools/` 等代码与素材，**保留 `data/`**，
  因此回滚不会丢掉上线后新增的评论与账号；回滚前会把当前状态另存为
  `DreamCatcher.prerollback-<时间戳>.zip`；
- 打包失败（例如文件被占用）时会自动退化为逐文件复制，并列出锁住的文件。

## 4. 手工回滚（三条命令）

在服务器上（远程桌面或 ssh）：

```powershell
cd <仓库目录>
powershell -File tools\deploy\ecs-backup.ps1 -Action list
powershell -File tools\deploy\ecs-backup.ps1 -Action rollback -Name <上一步选中的 zip>
powershell -File tools\deploy\ecs-service.ps1 -Action restart
```

彻底移除这台机器上的站点：

```powershell
powershell -File tools\deploy\ecs-service.ps1 -Action uninstall-task
Remove-Item <仓库目录的上一级> -Recurse -Force     # 确认只删本项目目录后再执行
```

## 5. 服务器侧需要人工处理的事

1. **放行对外端口**：在云厂商安全组（或服务器防火墙）里放行站点监听的 TCP 端口，
   否则公网访问不到；如果前面挂了 Nginx / Caddy，则把 `.env` 的 `TRUST_PROXY` 设为 `1`；
2. **设置维护后台口令**：在服务器上执行

   ```powershell
   cd <仓库目录>
   node tools/reset-admin-password.js
   ```

   它会生成随机后台路径与口令，并把哈希写进 `.env`；口令明文只留在本机 `.admin-password.txt`（不进版本库）。

## 6. 踩坑备忘

| 现象 | 原因 | 处理 |
|---|---|---|
| `.ps1` 整篇解析失败 | PowerShell 5.1 按系统 ANSI 代码页读脚本，UTF-8 中文注释被当成乱码 | 部署脚本一律纯 ASCII，中文说明写在 README |
| `.cmd` 报 `'…' 不是内部或外部命令` | 同上，批处理同样按 ANSI 读 | `.cmd` 也保持纯 ASCII |
| 远程命令开头被塞了 BOM 导致第一条语句报错 | 通过管道把脚本喂给远程 `powershell` 会被加 BOM | 改用 `powershell -NoProfile -EncodedCommand <base64>` |
| 改了 js/css，刷新页面没变化 | 浏览器复用了缓存的前端模块 | 开发模式（`NODE_ENV` 非 production）静态资源已是 `no-store`；生产环境是 5 分钟缓存，稍等或强制刷新 |
| 备份打包时报文件被占用 | 服务仍在运行，读取中的文件无法压缩 | 部署脚本默认先停服务再备份；也可手动 `-Action stop` |
