@echo off
setlocal
cd /d "%~dp0"
for /d %%D in ("%~dp0.tools\node-v24*-win-x64") do if exist "%%~D\node.exe" set "PATH=%%~D;%PATH%"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 LTS, then run npm start.
  exit /b 1
)
call npm.cmd start
