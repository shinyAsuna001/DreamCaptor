# =====================================================================
#  deploy-to-ecs.ps1 ---- run ON THE MACHINE YOU DEPLOY FROM.
#
#  Deploys this site to a Windows server that you reach over SSH:
#  pack -> upload -> unpack (code overwrites, data only fills gaps)
#  -> ensure .env -> register an auto-start scheduled task -> start + smoke test.
#
#  Why PowerShell and not Node: some restricted environments forbid a Node
#  child_process with piped stdio from spawning ssh (EPERM), while PowerShell
#  spawns ssh/scp normally. Hence a .ps1 driver.
#
#  Remote snippets are sent with "ssh ... powershell -EncodedCommand <base64>"
#  (a piped script would get a UTF-8 BOM and break the first statement).
#  Remote-side code lives in tools\deploy\ecs-*.ps1 so this file stays simple.
#
#  Safety rules:
#    - DRY RUN by default; nothing is written to the server without -Apply.
#    - Only the files listed in $payload are shipped; source images, logs,
#      backups, .env and local secret files are never uploaded.
#    - The service is stopped before the backup so the snapshot is consistent
#      (use -KeepRunning to skip that, at the cost of possibly locked files).
#    - Previous version is backed up first (zip, or folder copy if a file is locked).
#    - DATA FILES ARE NEVER OVERWRITTEN: content.json / wiki-*.json are only copied
#      when missing; accounts/comments/sessions and data\backups\ are never touched.
#    - Idempotent.
#
#  Configuration (either pass parameters, or create tools\deploy\deploy.local.ps1
#  next to this script - it is gitignored - and set $LocalSshHost / $LocalRemoteRoot):
#    $SshHost     ssh host alias of the server      (e.g. "my-server")
#    $RemoteRoot  deploy root folder on the server  (the site goes to <root>\site)
#
#  Usage:
#    powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy\deploy-to-ecs.ps1
#    ... -PreflightOnly
#    ... -Apply
#    ... -Apply -SkipTask
#    ... -Apply -KeepRunning
#    ... -Apply -SshHost my-server -RemoteRoot D:\sites\DreamCatcher
# =====================================================================
param(
  [switch]$Apply,
  [switch]$SkipTask,
  [switch]$NoBackup,
  [switch]$PreflightOnly,
  [switch]$KeepRunning,
  [string]$SshHost = '',
  [string]$RemoteRoot = '',
  [int]$KeepBackups = 3
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)   # keep BOM out of piped text

# Local, gitignored overrides (see the header): $LocalSshHost / $LocalRemoteRoot
$localConfig = Join-Path $PSScriptRoot 'deploy.local.ps1'
if (Test-Path $localConfig) { . $localConfig }
if (-not $SshHost) { $SshHost = $LocalSshHost }
if (-not $RemoteRoot) { $RemoteRoot = $LocalRemoteRoot }
if (-not $SshHost -or -not $RemoteRoot) {
  throw ('Missing deploy target. Pass -SshHost and -RemoteRoot, or create ' + $localConfig +
         ' containing: $LocalSshHost = ''<ssh alias>'' ; $LocalRemoteRoot = ''<server folder>''')
}

$SiteRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$RemoteSite = Join-Path $RemoteRoot 'site'

function Say([string]$m) { Write-Output $m }
function Step([int]$n, [string]$m) { Write-Output ''; Write-Output ("[" + $n + "] " + $m) }

function Invoke-Remote([string]$script, [switch]$AllowFail) {
  $wrapped = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`r`n`$ErrorActionPreference='Stop'`r`n" + $script
  $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($wrapped))
  $out = ssh -o BatchMode=yes $SshHost ('powershell -NoProfile -EncodedCommand ' + $encoded) 2>&1
  if ($LASTEXITCODE -ne 0 -and -not $AllowFail) { throw ("remote command failed: " + ($out -join " / ")) }
  return ($out | Out-String)
}

function Send-File([string]$local, [string]$remote) {
  scp -o BatchMode=yes $local ($SshHost + ':' + $remote) 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw ("scp failed: " + $local) }
}

$remoteService = "& '$RemoteSite\tools\deploy\ecs-service.ps1'"
$remoteBackup = "& '$RemoteSite\tools\deploy\ecs-backup.ps1' -Keep $KeepBackups"

Say '=== Deploy Dream Catcher site to ECS ==='
Say ("mode        : " + $(if ($Apply) { '** APPLY (writes to the ECS) **' } else { 'dry-run (nothing is written; add -Apply to execute)' }))
Say ("dev project : " + $SiteRoot)
Say ("remote      : " + $SshHost + ':' + $RemoteSite)

# ---------------------------------------------------------------- 1 preflight
Step 1 'Preflight: ssh channel / remote node / disk / port 3002'
$who = (Invoke-Remote 'whoami').Trim()
Say ("  whoami        -> " + $who)
$nodeV = (Invoke-Remote 'node -v').Trim()
Say ("  remote node   -> " + $nodeV)
$freeGb = [math]::Round(([double](Invoke-Remote '(Get-PSDrive C).Free').Trim()) / 1GB, 2)
Say ("  C: free       -> " + $freeGb + " GB")
$busy = (Invoke-Remote "netstat -ano | Select-String 'LISTENING' | Select-String ':3002' | Measure-Object | Select-Object -ExpandProperty Count").Trim()
Say ("  port 3002     -> " + $(if ($busy -eq '0') { 'free' } else { 'IN USE (' + $busy + ' listener) - should be our own site' }))
Say ("  site exists   -> " + (Invoke-Remote ("Test-Path '" + $RemoteSite + "'")).Trim())

if ($PreflightOnly) { Say ''; Say 'preflight only, done.'; exit 0 }

# ---------------------------------------------------------------- 2 stop + backup
Step 2 ('Stop service and back up the previous version (keep last ' + $KeepBackups + ')')
if ($NoBackup) { Say '  skipped (-NoBackup)' }
elseif (-not $Apply) {
  Say ('  would run: ' + $remoteService + ' -Action stop ; ' + $remoteBackup + ' -Action backup')
} else {
  if ($KeepRunning) { Say '  service left running (-KeepRunning)' }
  else {
    $stopOut = Invoke-Remote ($remoteService + ' -Action stop -Port 3002') -AllowFail
    Say ('  stop -> ' + ($stopOut.Trim() -split "`r?`n" | Select-Object -Last 1))
  }
  Say ('  ' + (Invoke-Remote ($remoteBackup + ' -Action backup')).Trim())
}

# ---------------------------------------------------------------- 3 pack
Step 3 'Pack locally (exclude data backups, source images, logs, secrets)'
$payload = @('server', 'public', 'tools', 'README.md', 'start.cmd', 'stop.cmd', '.env.example', '.gitignore')
$seed = @('content.json', 'wiki-levels.json', 'wiki-items.json', 'wiki-classes.json', 'wiki-faq.json', 'wiki-enemies.json', 'wiki-difficulty.json', 'assets.json')
$staging = Join-Path $env:TEMP ('dream-deploy-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $staging | Out-Null
foreach ($item in $payload) {
  $from = Join-Path $SiteRoot $item
  if (Test-Path $from) { Copy-Item $from (Join-Path $staging $item) -Recurse -Force }
  else { Say ('  WARN missing: ' + $item) }
}
# Never ship the local deploy config (it holds this machine's target settings)
$staleLocal = Join-Path $staging 'tools\deploy\deploy.local.ps1'
if (Test-Path $staleLocal) { Remove-Item $staleLocal -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $staging '_seed\data') | Out-Null
foreach ($f in $seed) {
  $from = Join-Path $SiteRoot ('data\' + $f)
  if (Test-Path $from) { Copy-Item $from (Join-Path $staging ('_seed\data\' + $f)) -Force }
}
$zipPath = Join-Path $env:TEMP ('dream-site-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -Force
$sizeMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 2)
Say ('  package: ' + (Split-Path $zipPath -Leaf) + '  (' + $sizeMb + ' MB, ' + (Get-ChildItem $staging -Recurse -File | Measure-Object).Count + ' files)')

# ---------------------------------------------------------------- 4 upload
Step 4 'Upload the package with scp'
$remoteZip = Join-Path $RemoteRoot ('upload-' + (Split-Path $zipPath -Leaf))
if (-not $Apply) { Say ('  would run: scp ' + (Split-Path $zipPath -Leaf) + ' -> ' + $SshHost + ':' + $remoteZip) }
else {
  Invoke-Remote ("New-Item -ItemType Directory -Force -Path '" + $RemoteRoot + "' | Out-Null") | Out-Null
  Send-File $zipPath $remoteZip
  Say ('  uploaded -> ' + $remoteZip)
}

# ---------------------------------------------------------------- 5 unpack
Step 5 'Unpack on the ECS: code and assets overwrite, data only fills the gaps'
$listForRemote = ($payload | ForEach-Object { "'" + $_ + "'" }) -join ','
$unpack = @(
  "New-Item -ItemType Directory -Force -Path '$RemoteSite' | Out-Null",
  "`$tmp = '$RemoteRoot\_unpack'",
  "if (Test-Path `$tmp) { Remove-Item `$tmp -Recurse -Force }",
  "Expand-Archive -Path '$remoteZip' -DestinationPath `$tmp -Force",
  "foreach (`$item in @($listForRemote)) {",
  "  `$src = Join-Path `$tmp `$item",
  "  if (-not (Test-Path `$src)) { continue }",
  "  `$dst = Join-Path '$RemoteSite' `$item",
  "  if (Test-Path `$dst) { Remove-Item `$dst -Recurse -Force }",
  "  Copy-Item `$src `$dst -Recurse -Force",
  "}",
  "New-Item -ItemType Directory -Force -Path '$RemoteSite\data' | Out-Null",
  "`$seeded = 0; `$kept = 0",
  "foreach (`$f in Get-ChildItem (Join-Path `$tmp '_seed\data') -File) {",
  "  `$dst = Join-Path '$RemoteSite\data' `$f.Name",
  "  if (Test-Path `$dst) { `$kept++ } else { Copy-Item `$f.FullName `$dst -Force; `$seeded++ }",
  "}",
  "Remove-Item `$tmp -Recurse -Force",
  "Remove-Item '$remoteZip' -Force",
  "Write-Output ('unpacked: seed data added ' + `$seeded + ', kept existing ' + `$kept)"
) -join "`r`n"
if (-not $Apply) { Say '  would run: Expand-Archive -> overwrite code/assets -> fill only missing data -> cleanup' }
else { Say ('  ' + (Invoke-Remote $unpack).Trim()) }

# ---------------------------------------------------------------- 6 .env
Step 6 'Ensure .env on the ECS (PORT=3002 / HOST=0.0.0.0)'
$envScript = @(
  "`$envFile = '$RemoteSite\.env'",
  "`$utf8 = New-Object System.Text.UTF8Encoding(`$false)",
  "if (-not (Test-Path `$envFile)) {",
  "  `$body = @('NODE_ENV=production','PORT=3002','HOST=0.0.0.0','TRUST_PROXY=0','','ADMIN_PATH=','ADMIN_PASSWORD_HASH=','ADMIN_SESSION_TTL_MS=7200000','ADMIN_MAX_FAILURES=5','ADMIN_LOCKOUT_MS=900000','SESSION_TTL_MS=604800000','MAX_JSON_BODY=1048576') -join [char]13 + [char]10",
  "  [System.IO.File]::WriteAllText(`$envFile, `$body + [char]13 + [char]10, `$utf8)",
  "  Write-Output '.env created (PORT=3002)'",
  "} else {",
  "  `$out = foreach (`$line in ([System.IO.File]::ReadAllText(`$envFile, `$utf8) -split [char]10)) {",
  "    if (`$line -match '^PORT=') { 'PORT=3002' } elseif (`$line -match '^HOST=') { 'HOST=0.0.0.0' } elseif (`$line -match '^NODE_ENV=') { 'NODE_ENV=production' } else { `$line }",
  "  }",
  "  [System.IO.File]::WriteAllText(`$envFile, (`$out -join [char]13 + [char]10), `$utf8)",
  "  Write-Output ('.env patched -> ' + (`$out | Where-Object { `$_ -match '^PORT=' }))",
  "}"
) -join "`r`n"
if (-not $Apply) { Say '  would run: create/patch .env with PORT=3002 (ADMIN_* values are never touched)' }
else { Say ('  ' + (Invoke-Remote $envScript).Trim()) }

# ---------------------------------------------------------------- 7 scheduled task
Step 7 'Register the auto-start scheduled task'
if ($SkipTask) { Say '  skipped (-SkipTask)' }
elseif (-not $Apply) { Say ('  would run: ' + $remoteService + " -Action install-task -SitePath '" + $RemoteSite + "'") }
else { Say ('  ' + (Invoke-Remote ($remoteService + " -Action install-task -SitePath '" + $RemoteSite + "'")).Trim()) }

# ---------------------------------------------------------------- 8 start + smoke
Step 8 'Start the service and run the remote smoke test'
if (-not $Apply) {
  Say '  would run: ecs-service.ps1 -Action restart, then node tools\smoke-test.mjs --base http://127.0.0.1:3002 --skip-admin'
} else {
  Say ('  ' + (Invoke-Remote ($remoteService + " -Action restart -SitePath '" + $RemoteSite + "'") -AllowFail).Trim())
  $smoke = Invoke-Remote ("Set-Location '$RemoteSite'; node tools\smoke-test.mjs --base http://127.0.0.1:3002 --skip-admin") -AllowFail
  $lines = ($smoke -split "`n") | Where-Object { $_ -match '\[PASS\]|\[FAIL\]|===|passed|failed' }
  Say ('  ' + (($lines | Select-Object -Last 8) -join "`n  "))
}

Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue

Say ''
Say '=== done ==='
if (-not $Apply) {
  Say 'This was a dry run. Add -Apply to execute (it stops the service, backs it up, then deploys).'
} else {
  Say 'Deployed. Reminders:'
  Say '  1) keep TCP 3002 open in the Aliyun security group;'
  Say '  2) the admin password lives in site\.admin-password.txt on the ECS.'
}
