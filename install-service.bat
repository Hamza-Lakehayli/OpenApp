@echo off
title agentlink service installer
rem Registers agentlink as a Windows scheduled task that starts hidden at
rem logon, restarts on failure, and auto-starts an OpenCode service.

net session >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Right-click this file and choose "Run as administrator" -
  echo  registering the startup task needs admin rights once.
  echo.
  pause
  exit /b 1
)

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

echo  Registering the AgentLink startup task...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '\"%~dp0agentlink-bg.vbs\"';" ^
  "$trigger = New-ScheduledTaskTrigger -AtLogon;" ^
  "$settings = New-ScheduledTaskSettingsSet -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;" ^
  "Register-ScheduledTask -TaskName 'AgentLink' -Action $action -Trigger $trigger -Settings $settings -Force"

echo  Creating the hidden startup wrapper...
> "%~dp0agentlink-bg.vbs" (
  echo Set sh = CreateObject^("WScript.Shell"^)
  echo sh.Run "cmd /c cd /d ""%~dp0client"" && npm run agentlink", 0, False
)

echo  Starting it now...
wscript.exe "%~dp0agentlink-bg.vbs"

timeout /t 5 /nobreak >nul
echo.
echo  Done. AgentLink now starts hidden at every logon and restarts on
echo  failure. The phone pairing persists - just reopen your bookmark.
echo  To remove: schtasks /delete /tn AgentLink /f
echo.
pause
