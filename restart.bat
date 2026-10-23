@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM Process matching must not assume an absolute path: start.bat launches the
REM bridge as `node src/bridge.js` (relative), so a `%~dp0src\bridge.js` pattern
REM never matched and the old bridge survived restart (fixed 2026-10-24).
echo Stopping old guard windows...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -match 'start\.bat' -and $_.CommandLine -notmatch 'restart\.bat' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo Stopping old bridge processes...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'src[\\/]bridge\.js' -and $_.CommandLine -notmatch 'mcp-' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
REM `timeout` breaks when stdin is redirected (e.g. launched from a script);
REM PowerShell sleep works everywhere.
powershell -NoProfile -Command "Start-Sleep -Seconds 2"
del state\bridge.lock 2>nul
start "" cmd /c start.bat
echo Guard window started.
