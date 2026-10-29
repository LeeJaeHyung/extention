@echo off
cd /d "%~dp0"
title chibiz deposit agent build
echo [BUILD] needs JDK 17+. Maven is downloaded by mvnw.
call mvnw.cmd -q -DskipTests package
if errorlevel 1 (
  echo [FAILED] see errors above.
  pause
  exit /b 1
)
echo [DONE] target\chibiz-deposit-agent.jar
pause
