@echo off
cd /d "%~dp0"
title chibiz deposit agent - make exe (jpackage)
echo [1/2] build (mvnw, JavaFX windows natives)
call mvnw.cmd -q -DskipTests clean package
if errorlevel 1 ( echo [FAILED] build error & pause & exit /b 1 )
echo [2/2] jpackage - bundle java runtime into an exe folder (JDK 17+ jpackage)
if exist dist rmdir /s /q dist
jpackage --type app-image --name "ChibizDepositAgent" --dest dist ^
  --input target --main-jar chibiz-deposit-agent.jar --main-class kr.chibiz.depositagent.Launcher ^
  --java-options "-Dfile.encoding=UTF-8" --java-options "-Dagent.home=$APPDIR\.." ^
  --app-version 0.2.0 --vendor "chibiz" --description "chibiz deposit agent" --win-console false
if errorlevel 1 ( echo [FAILED] jpackage error - check JDK 17+ and PATH & pause & exit /b 1 )
copy /y config.example.json "dist\ChibizDepositAgent\" >nul
if exist config.json copy /y config.json "dist\ChibizDepositAgent\" >nul
echo.
echo [DONE] dist\ChibizDepositAgent\ChibizDepositAgent.exe
echo        fill config.json next to the exe and run it. Put a shortcut in Startup.
pause
