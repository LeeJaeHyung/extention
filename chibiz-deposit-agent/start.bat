@echo off
cd /d "%~dp0"
title chibiz deposit agent
where java >nul 2>nul
if errorlevel 1 (
  echo [ERROR] java not found. Install JDK 21 and add it to PATH, then open a NEW command prompt.
  pause
  exit /b 1
)
java -version 2>&1 | findstr /i "version"
if not exist config.json (
  echo [INFO] config.json not found. Copy config.example.json to config.json and fill db.password / mcp.token.
  pause
  exit /b 1
)
:loop
echo [START] %date% %time%
java -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dagent.home="%~dp0." -jar chibiz-deposit-agent.jar
set RC=%errorlevel%
echo [EXIT CODE %RC%] %date% %time%
if not "%RC%"=="0" (
  echo [ABNORMAL EXIT] see messages above or agent.log. Restarting in 10 seconds. Close this window to stop.
  timeout /t 10 >nul
  goto loop
)
echo [STOPPED] closed from the window. Press any key to close this console.
pause >nul
