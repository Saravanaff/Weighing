@echo off
rem Kiosk launcher for WINDOWS - opens the weighing terminal fullscreen.
rem Put a shortcut to this file in shell:startup to auto-launch at login
rem (the Windows equivalent of the systemd unit in scripts/kiosk-start.sh).
rem
rem Make sure start.bat is running first (or add it to shell:startup too).

set URL=http://localhost:3001

rem 1) Lock the keyboard against kiosk escapes (Win / Alt+Tab / Alt+F4...).
rem    Exit combo for staff: Ctrl+Alt+Shift+F12 (same as the Linux kiosk).
where pythonw >nul 2>nul && start "" /min pythonw "%~dp0kiosk-lock.py"

rem Dedicated profile: forces a SEPARATE browser instance. Without it, an
rem already-running Chrome/Edge swallows the launch and ignores --kiosk.
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
)
