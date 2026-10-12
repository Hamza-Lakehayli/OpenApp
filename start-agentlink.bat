@echo off
title agentlink - keep this window open
rem Double-clickable launcher: cd to the app, install once if needed, run.

cd /d "%~dp0client"

where npm >nul 2>nul
if errorlevel 1 (
  echo.
  echo  npm was not found. Install Node.js from https://nodejs.org first,
  echo  then run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo  This window IS the app - keep it open. Close it (or press Ctrl+C)
echo  to stop agentlink. The phone QR appears here once ngrok starts.
echo.

if not exist node_modules (
  echo  First run - installing dependencies ^(one time^)...
  echo.
  call npm install --no-audit --no-fund
)

call npm run agentlink

echo.
echo  agentlink stopped. You can close this window.
pause
