@echo off
chcp 65001 >nul
cd /d "%~dp0..\.."
echo ================================================================
echo  Dream Catcher site - browser verification
echo  Drives your installed Chrome through playwright-core (channel: chrome)
echo  Make sure the dev server is running first:  start.cmd
echo ================================================================
echo.
node tools\verify\browser-check.mjs %*
echo.
echo Done. Report: tools\verify\report.md
echo Shots:  tools\verify\shots\
pause
