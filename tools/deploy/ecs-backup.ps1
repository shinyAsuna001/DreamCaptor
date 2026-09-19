# =====================================================================
#  ecs-backup.ps1 ---- run ON THE SERVER.  Backup / list / rollback the SITE ONLY.
#
#  Scope guard: every path stays inside -Root (the project folder that holds site\).
#  Nothing outside it is ever read, written, moved or deleted.
#
#  Actions:
#    -Action backup                 zip the current site -> DreamCatcher.bak-<stamp>.zip (keep 3)
#                                   falls back to a folder copy if a file is locked
#    -Action list                   list existing backups
#    -Action rollback -Name x       restore code+assets from a backup (data\ is preserved)
#    -Action restore-data -Name x   restore ONLY data\ from a backup
#
#  ASCII only: Windows PowerShell 5.1 parses .ps1 with the system ANSI codepage.
# =====================================================================
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('backup', 'list', 'rollback', 'restore-data')]
  [string]$Action,

  # Default: the project folder one level above this script's site root
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path,
  [string]$Name = '',
  [int]$Keep = 3
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$SitePath = Join-Path $Root 'site'
if (-not $SitePath.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'refusing to work outside the project root'
}

function Get-Backups {
  Get-ChildItem $Root -Filter 'DreamCatcher.bak-*' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
}

function New-Backup {
  if (-not (Test-Path $SitePath)) { throw ('site path not found: ' + $SitePath) }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $zip = Join-Path $Root ('DreamCatcher.bak-' + $stamp + '.zip')
  $ok = $true
  try {
    Compress-Archive -Path (Join-Path $SitePath '*') -DestinationPath $zip -Force -ErrorAction Stop
  } catch {
    $ok = $false
    $msg = [string]$_.Exception.Message
    Write-Output ('  Compress-Archive failed: ' + $msg.Split([char]10)[0])
  }
  if ($ok -and (Test-Path $zip)) {
    $mb = [math]::Round((Get-Item $zip).Length / 1MB, 2)
    Write-Output ('backup: ' + $zip + '  (' + $mb + ' MB)')
  } else {
    # fallback: copy file by file, skipping whatever is locked
    $dir = Join-Path $Root ('DreamCatcher.bak-' + $stamp)
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $skipped = @()
    foreach ($f in Get-ChildItem $SitePath -Recurse -File) {
      $rel = $f.FullName.Substring($SitePath.Length).TrimStart('\')
      $dst = Join-Path $dir $rel
      New-Item -ItemType Directory -Force -Path (Split-Path $dst -Parent) | Out-Null
      try { Copy-Item $f.FullName $dst -Force -ErrorAction Stop } catch { $skipped += $rel }
    }
    Write-Output ('backup (folder mode): ' + $dir + '   skipped ' + $skipped.Count + ' locked file(s)')
    foreach ($s in $skipped) { Write-Output ('    skipped: ' + $s) }
  }
  $old = Get-Backups | Select-Object -Skip $Keep
  foreach ($f in $old) { Remove-Item $f.FullName -Recurse -Force; Write-Output ('pruned: ' + $f.Name) }
}

function Resolve-Backup([string]$n) {
  if (-not $n) { throw '-Name is required (see -Action list)' }
  $p = Join-Path $Root $n
  if (-not (Test-Path $p)) { throw ('backup not found: ' + $p) }
  return $p
}

function Expand-Backup([string]$path, [string]$tmp) {
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  if ((Get-Item $path).PSIsContainer) {
    Copy-Item $path $tmp -Recurse -Force
  } else {
    Expand-Archive -Path $path -DestinationPath $tmp -Force
  }
  return $tmp
}

switch ($Action) {
  'backup' { New-Backup }

  'list' {
    $items = Get-Backups
    if (-not $items) { Write-Output ('no backups found under ' + $Root); exit 0 }
    foreach ($f in $items) {
      $size = if ($f.PSIsContainer) { '<folder>' } else { ([math]::Round($f.Length / 1MB, 2)).ToString() + ' MB' }
      Write-Output ($f.Name + '   ' + $size + '   ' + $f.LastWriteTime)
    }
  }

  'rollback' {
    $src = Resolve-Backup $Name
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $pre = Join-Path $Root ('DreamCatcher.prerollback-' + $stamp)
    if (Test-Path $SitePath) {
      New-Item -ItemType Directory -Force -Path $pre | Out-Null
      $locked = 0
      foreach ($f in Get-ChildItem $SitePath -Recurse -File) {
        $rel = $f.FullName.Substring($SitePath.Length).TrimStart('\')
        $dst = Join-Path $pre $rel
        New-Item -ItemType Directory -Force -Path (Split-Path $dst -Parent) | Out-Null
        try { Copy-Item $f.FullName $dst -Force -ErrorAction Stop } catch { $locked++ }
      }
      Write-Output ('current state saved to: ' + $pre + ' (locked files skipped: ' + $locked + ')')
    }
    $tmp = Join-Path $Root '_rollback_tmp'
    Expand-Backup $src $tmp | Out-Null
    foreach ($item in @('server', 'public', 'tools', 'README.md', 'start.cmd', 'stop.cmd', '.env.example', '.gitignore')) {
      $s = Join-Path $tmp $item
      if (-not (Test-Path $s)) { continue }
      $d = Join-Path $SitePath $item
      if (Test-Path $d) { Remove-Item $d -Recurse -Force }
      Copy-Item $s $d -Recurse -Force
    }
    Remove-Item $tmp -Recurse -Force
    Write-Output 'rollback done (data\ was preserved). Restart to apply:'
    Write-Output '  powershell -File tools\deploy\ecs-service.ps1 -Action restart'
  }

  'restore-data' {
    $src = Resolve-Backup $Name
    $tmp = Join-Path $Root '_restore_tmp'
    Expand-Backup $src $tmp | Out-Null
    $srcData = Join-Path $tmp 'data'
    if (-not (Test-Path $srcData)) { throw 'this backup has no data\ directory' }
    Copy-Item (Join-Path $srcData '*') (Join-Path $SitePath 'data') -Recurse -Force
    Remove-Item $tmp -Recurse -Force
    Write-Output 'data restored. Restart to apply:'
    Write-Output '  powershell -File tools\deploy\ecs-service.ps1 -Action restart'
  }
}
