@echo off
rem Kiosk launcher for WINDOWS - opens the weighing terminal fullscreen.
rem Put a shortcut to this file in shell:startup to auto-launch at login
rem (the Windows equivalent of the systemd unit in scripts/kiosk-start.sh).
rem
rem Make sure start.bat is running first (or add it to shell:startup too).

set URL=http://localhost:3001

rem Prefer Chrome, fall back to Edge (both are Chromium --kiosk capable).
set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
set CHROME_X86=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
set EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe

if exist "%CHROME%" (
    start "" "%CHROME%" --kiosk %URL%
) else if exist "%CHROME_X86%" (
    start "" "%CHROME_X86%" --kiosk %URL%
) else if exist "%EDGE%" (
    start "" "%EDGE%" --kiosk %URL% --edge-kiosk-type=fullscreen
) else (
    echo [ERROR] No Chrome or Edge found - open %URL% manually.
)
