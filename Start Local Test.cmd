@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or newer, then run this file again.
  pause
  exit /b 1
)

start "Popup Ticket Runner - Local Server" cmd /k "cd /d ""%~dp0"" ^&^& npm run ui"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4317/"
endlocal
