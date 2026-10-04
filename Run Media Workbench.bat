@echo off
setlocal
cd /d "%~dp0"

if not exist node_modules\electron\dist\electron.exe (
  echo Installing dependencies...
  call npm ci --ignore-scripts || goto :fail
  call node node_modules\electron\install.js || goto :fail
)
if not exist .tools\node.exe (
  echo Setting up tools...
  call npm run tools:setup || goto :fail
)

echo Building latest version...
call npm run build || goto :fail

echo Starting Media Workbench...
start "" /b node_modules\electron\dist\electron.exe apps\desktop\main.cjs
exit /b 0

:fail
echo.
echo Failed. See the messages above.
pause
exit /b 1
