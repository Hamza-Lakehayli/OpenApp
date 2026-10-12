@echo off
title agentlink
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

if not exist node_modules (
  echo.
  echo  First run - installing dependencies ^(one time^)...
  echo.
  call npm install --no-audit --no-fund
)

call npm run agentlink

echo.
echo  agentlink stopped.
pause
