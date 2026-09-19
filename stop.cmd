@echo off
REM ---------------------------------------------------------------
REM  Stop the local dev server: kill whatever listens on port 4173.
REM  ASCII-only on purpose (cmd.exe reads .cmd as ANSI/GBK).
REM ---------------------------------------------------------------
setlocal enabledelayedexpansion
set PORT=4173
set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
  echo [stop] killing PID %%a on port %PORT%
  taskkill /PID %%a /T /F >nul 2>&1
  set FOUND=1
)
if "!FOUND!"=="0" echo [stop] nothing is listening on port %PORT%
endlocal
