@echo off
rem Naveen Poultry Farm - one-command start for WINDOWS
rem Same behavior as start.sh on Linux: install deps if needed, build the UI
rem if needed, then run the single server that serves API + UI on port 3001.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist node_modules goto setup
if not exist dist goto build
goto run

:nonode
echo [ERROR] Node.js not found. Install Node 24+ from https://nodejs.org and retry.
pause
exit /b 1

:setup
echo [setup] Installing dependencies - first run on this machine...
call npm install --no-audit --no-fund
if not exist dist goto build
goto run

:build
echo [setup] Building the UI - first run...
call npm run build:all
goto run

:run
echo [run] Naveen Farm on http://localhost:3001
node server/index.ts
