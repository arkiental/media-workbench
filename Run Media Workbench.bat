@echo off
setlocal
cd /d "%~dp0"

if not exist node_modules\ (
  echo Installing dependencies...
  call npm ci --ignore-scripts || goto :fail
)
set "MW_LAUNCH_NODE=node"
if exist .tools\node.exe set "MW_LAUNCH_NODE=%~dp0.tools\node.exe"
call "%MW_LAUNCH_NODE%" scripts\prepare-launch.mjs || goto :fail

echo Starting Media Workbench...
set ELECTRON_RUN_AS_NODE=
start "" /b node_modules\electron\dist\electron.exe apps\desktop\main.cjs
exit /b 0

:fail
echo.
echo Failed. See the messages above.
pause
exit /b 1
