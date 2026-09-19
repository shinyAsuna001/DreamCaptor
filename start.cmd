@echo off
REM ---------------------------------------------------------------
REM  Dream Catcher site - local dev server (dev machine)
REM  NOTE: this file is intentionally ASCII-only.
REM        cmd.exe reads .cmd files with the system ANSI codepage (GBK on
REM        this machine), so UTF-8 Chinese comments break parsing.
REM ---------------------------------------------------------------
cd /d "%~dp0"
echo [start] %CD%
echo [start] http://127.0.0.1:4173/
echo [start] press Ctrl+C to stop
echo.
node server\server.js
echo.
echo [exit] server stopped, code=%ERRORLEVEL%
pause
