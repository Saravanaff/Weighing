@echo off
rem =====================================================================
rem  Naveen Poultry Farm - SINGLE-FILE kiosk launcher (WINDOWS)
rem
rem  One file does the whole kiosk, in order:
rem    1. server  (installs deps / builds the UI on first run, serves :3001)
rem    2. keyboard lock (blocks Win key, Alt+Tab, Alt+F4, ... )
rem    3. fullscreen browser (--kiosk at http://localhost:3001)
rem
rem  Usage, from wherever this file lives (repo root, e.g. E:\Weighing):
rem    kiosk.bat              start everything now
rem    kiosk.bat --install    auto-start everything at Windows login (once)
rem    kiosk.bat --uninstall  remove the auto-start again
rem    kiosk.bat --stop       leave the kiosk (browser + lock), keep server up
rem
rem  Staff keys: Ctrl+Alt+A switches admin/staff, Ctrl+Alt+Shift+F12 exits.
rem =====================================================================

if /i "%~1"=="--install" goto install
if /i "%~1"=="--uninstall" goto uninstall
if /i "%~1"=="--stop" goto stop
if not "%~1"=="" goto usage
goto main

:main
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node 24+ from https://nodejs.org and retry.
  pause
  exit /b 1
)

if not exist node_modules (
  echo [setup] Installing dependencies - first run on this machine...
  call npm install --no-audit --no-fund
)
if not exist dist (
  echo [setup] Building the UI - first run...
  call npm run build:all
)

rem Start the server only if it is not already answering, so running this
rem twice - or alongside start.bat - never spawns a second server.
call :probe
if not errorlevel 1 goto serverup
echo [run] Starting server on http://localhost:3001 ...
start "Naveen Farms server" /min node server/index.ts
set /a TRIES=0
:waitloop
call :probe
if not errorlevel 1 goto serverup
set /a TRIES+=1
if %TRIES% GEQ 45 (
  echo [ERROR] Server did not answer in time. See the "Naveen Farms server" window.
  pause
  exit /b 1
)
timeout /t 2 /nobreak >nul
goto waitloop
:serverup
echo [run] Server is up.

rem Keyboard lock (same locker scripts\kiosk-start.bat uses).
rem Exit combo for staff: Ctrl+Alt+Shift+F12.
where pythonw >nul 2>nul
if errorlevel 1 (
  echo [WARN] Python not found - kiosk opens WITHOUT the keyboard lock. Install Python to lock Win/Alt+Tab/Alt+F4.
) else (
  start "" /min pythonw "%~dp0scripts\kiosk-lock.py"
  echo [run] Keyboard lock started.
)

rem Fullscreen browser in a dedicated profile: without it, an already-running
rem Chrome/Edge swallows the launch and ignores --kiosk.
rem The kiosk boots into the staff terminal (same as the Linux kiosk.sh);
rem the admin portal stays one Ctrl+Alt+A away.
set URL=http://localhost:3001/staff/
set KIOSK_PROFILE=%TEMP%\naveen-kiosk-profile
set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
set CHROME_X86=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
set EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe

if exist "%CHROME%" (
  start "" "%CHROME%" --kiosk --user-data-dir="%KIOSK_PROFILE%" --no-first-run --disable-session-crashed-bubble --disable-features=Translate %URL%
) else if exist "%CHROME_X86%" (
  start "" "%CHROME_X86%" --kiosk --user-data-dir="%KIOSK_PROFILE%" --no-first-run --disable-session-crashed-bubble --disable-features=Translate %URL%
) else if exist "%EDGE%" (
  start "" "%EDGE%" --kiosk %URL% --edge-kiosk-type=fullscreen --user-data-dir="%KIOSK_PROFILE%" --no-first-run --disable-session-crashed-bubble
) else (
  echo [ERROR] No Chrome or Edge found - open %URL% manually.
  pause
  exit /b 1
)
echo [kiosk] Terminal is up. Exit with Ctrl+Alt+Shift+F12.
exit /b 0

rem -- true (errorlevel 0) when the server answers /api/health.
:probe
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing http://localhost:3001/api/health -TimeoutSec 2).StatusCode } catch { exit 1 }" >nul 2>nul
exit /b

:install
cd /d "%~dp0"
set LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Naveen Farms Kiosk.lnk
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=New-Object -ComObject WScript.Shell; $sc=$s.CreateShortcut('%LNK%'); $sc.TargetPath='%~f0'; $sc.WorkingDirectory='%CD%'; $sc.Description='Naveen Poultry Farm kiosk (server + lock + fullscreen browser)'; $sc.Save()"
if errorlevel 1 (
  echo [ERROR] Could not write the startup shortcut.
  pause
  exit /b 1
)
echo [install] Auto-start registered:
echo [install]   %LNK%
echo [install] The kiosk launches by itself at every login. Starting it now...
echo.
goto main

:uninstall
set LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Naveen Farms Kiosk.lnk
if exist "%LNK%" (
  del "%LNK%"
  echo [uninstall] Auto-start removed.
) else (
  echo [uninstall] Nothing installed - no startup shortcut found.
)
exit /b 0

:stop
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'python' -and $_.CommandLine -match 'kiosk-lock' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'chrome|msedge' -and $_.CommandLine -match 'naveen-kiosk-profile' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo [stop] Kiosk stopped - keyboard and desktop restored. Server keeps running.
exit /b 0

:usage
echo Usage: %~nx0 [--install ^| --uninstall ^| --stop]
exit /b 1
