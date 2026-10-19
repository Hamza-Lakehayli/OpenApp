@echo off
title agentlink service installer
rem One-time setup: builds the app and registers AgentLink to start hidden
rem at every logon (via the Startup folder - no admin needed).

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo  npm/node was not found. Install Node.js from https://nodejs.org first.
  pause
  exit /b 1
)

echo  Building the app (one time)...
cd client
if not exist node_modules call npm install --no-audit --no-fund
call npm run build:single
cd ..

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"

echo  Creating the hidden startup shortcut...
rem The repo vbs resolves its own folder, so a copied copy would point at the
rem Startup folder itself. Instead write a one-line trampoline that launches the
rem repo copy at its real (baked-in) path.
> "%STARTUP%\agentlink-bg.vbs" echo CreateObject("WScript.Shell"^).Run "wscript.exe ""%~dp0agentlink-bg.vbs""", 0, False

echo  Starting it now...
wscript.exe "%STARTUP%\agentlink-bg.vbs"

timeout /t 4 /nobreak >nul
echo.
echo  Done. AgentLink now starts hidden at every logon (logs to client\agentlink.log).
echo  The phone pairing persists - just reopen your bookmark. To remove the auto-start:
echo    del "%STARTUP%\agentlink-bg.vbs"
echo.
pause
