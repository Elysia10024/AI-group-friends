@echo off
REM One-click installer for the AI group friend (QQ <-> DSH bridge).
REM
REM ASCII-only on purpose: cmd.exe reads .bat with the system ANSI codepage (GBK),
REM so Chinese characters here would be mangled. All Chinese prompts live in
REM scripts\wizard.ps1, which is saved as UTF-8 with BOM.
REM
REM What it does: runs scripts\wizard.ps1, which checks Node.js / DSH / SnowLuma,
REM installs dependencies, asks four questions, writes config.json and starts the bridge.
title AI group friend - installer
cd /d "%~dp0"

echo.
echo   Starting the installer...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\wizard.ps1"

set CODE=%ERRORLEVEL%
echo.
if not "%CODE%"=="0" (
    echo   Installer exited with code %CODE%.
    echo   Check the messages above, then run this file again.
) else (
    echo   Bridge stopped. Close this window when you are done reading.
)
pause
exit /b %CODE%
