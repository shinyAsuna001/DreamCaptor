# =====================================================================
#  ecs-service.ps1 ---- run ON THE SERVER (via ssh, or RDP)
#
#  Manages the Dream Catcher site as a Windows Scheduled Task:
#    -Action install-task      register "DreamCatcherSite" (trigger: AtStartup, restart on failure)
#    -Action uninstall-task    remove it
#    -Action start | stop | restart | status | logs | smoke
#
#  ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 with the system
#  ANSI codepage (GBK on a Chinese Windows) and UTF-8 Chinese comments break parsing.
#
#  The site is self-contained: it never modifies the Windows firewall and never
#  touches files outside -SitePath.
#
#  Example (SitePath defaults to the repository root this script sits in):
#    powershell -NoProfile -ExecutionPolicy Bypass -File ecs-service.ps1 -Action status
# =====================================================================
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('install-task', 'uninstall-task', 'start', 'stop', 'restart', 'status', 'logs', 'smoke')]
  [string]$Action,

  # Default: two levels up from tools\deploy\ = the site root this script belongs to
  [string]$SitePath = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$TaskName = 'DreamCatcherSite',
  [int]$Port = 3002,
  [int]$LogTail = 30
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Get-NodePath {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $fallback = 'C:\Program Files\nodejs\node.exe'
  if (Test-Path $fallback) { return $fallback }
  throw 'node.exe not found'
}

function Get-Listener {
  $lines = netstat -ano | Select-String "LISTENING" | Select-String (":" + $Port)
  if (-not $lines) { return $null }
  $parts = ($lines[0].Line -split '\s+') | Where-Object { $_ -ne '' }
  return [int]$parts[-1]
}

function Show-Status {
  $node = Get-NodePath
  Write-Output ("node        : " + $node)
  Write-Output ("node -v     : " + (& $node -v))
  Write-Output ("site path   : " + $SitePath)
  Write-Output ("port        : " + $Port)
  $listenerPid = Get-Listener
  if ($listenerPid) { Write-Output ("listening   : yes (PID " + $listenerPid + ")") } else { Write-Output "listening   : no" }
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) { Write-Output ("task        : " + $task.TaskName + " / " + $task.State) } else { Write-Output "task        : not registered" }
  if (Test-Path (Join-Path $SitePath 'data')) {
    $dataCount = (Get-ChildItem (Join-Path $SitePath 'data') -File | Measure-Object).Count
    Write-Output ("data files  : " + $dataCount)
  }
  $free = (Get-PSDrive C).Free
  Write-Output ("C: free     : " + [math]::Round($free / 1GB, 2) + " GB")
  try {
    $r = Invoke-WebRequest -Uri ("http://127.0.0.1:" + $Port + "/api/health") -UseBasicParsing -TimeoutSec 5
    Write-Output ("health      : " + $r.StatusCode + " " + $r.Content)
  } catch {
    Write-Output ("health      : FAILED - " + $_.Exception.Message)
  }
}

switch ($Action) {
  'install-task' {
    $node = Get-NodePath
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
      Write-Output ("task already exists, updating: " + $TaskName)
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    # NOTE: do NOT name this $action -- PowerShell variable names are case-insensitive,
    # so $action would overwrite the script's own -Action parameter and blow up the
    # ValidateSet ("MSFT_TaskExecAction is not a valid value for Action"). Cost me one deploy.
    $taskAction = New-ScheduledTaskAction -Execute $node -Argument 'server\server.js' -WorkingDirectory $SitePath
    $taskTrigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
      -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $taskTrigger -Settings $settings -Principal $principal `
      -Description 'Dream Catcher official site (port 3002) - independent from the other services' | Out-Null
    Write-Output ("registered task: " + $TaskName + "  (trigger=AtStartup, runs-as=SYSTEM)")
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 3
    Show-Status
  }

  'uninstall-task' {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $existing) { Write-Output 'task not registered, nothing to do'; exit 0 }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output ("removed task: " + $TaskName)
  }

  'start' {
    $listenerPid = Get-Listener
    if ($listenerPid) { Write-Output ("already listening on " + $Port + " (PID " + $listenerPid + "), nothing to do"); exit 0 }
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
      Start-ScheduledTask -TaskName $TaskName
      Write-Output ("started via scheduled task: " + $TaskName)
    } else {
      $node = Get-NodePath
      Start-Process -FilePath $node -ArgumentList 'server\server.js' -WorkingDirectory $SitePath -WindowStyle Hidden
      Write-Output 'started as a detached process (no scheduled task registered)'
    }
    Start-Sleep -Seconds 3
    if (Get-Listener) { Write-Output "OK: listening" } else { Write-Output "WARN: still not listening, check logs" }
  }

  'stop' {
    $listenerPid = Get-Listener
    if (-not $listenerPid) { Write-Output ("nothing listening on " + $Port); exit 0 }
    Stop-Process -Id $listenerPid -Force
    Write-Output ("stopped PID " + $listenerPid + " on port " + $Port)
  }

  'restart' {
    & $PSCommandPath -Action stop -SitePath $SitePath -TaskName $TaskName -Port $Port
    Start-Sleep -Seconds 2
    & $PSCommandPath -Action start -SitePath $SitePath -TaskName $TaskName -Port $Port
  }

  'status' { Show-Status }

  'logs' {
    $logDir = Join-Path $SitePath 'logs'
    if (-not (Test-Path $logDir)) { Write-Output 'no logs yet'; exit 0 }
    $latest = Get-ChildItem $logDir -Filter 'app-*.log' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latest) { Write-Output 'no log files'; exit 0 }
    Write-Output ("--- " + $latest.FullName + " (last " + $LogTail + " lines) ---")
    Get-Content $latest.FullName -Tail $LogTail
  }

  'smoke' {
    Push-Location $SitePath
    try {
      & (Get-NodePath) 'tools\smoke-test.mjs' ('--base', ('http://127.0.0.1:' + $Port)) '--skip-admin'
    } finally {
      Pop-Location
    }
  }
}
