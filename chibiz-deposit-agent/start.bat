@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 차이비즈 입금 에이전트
if not exist target\chibiz-deposit-agent.jar (
  echo [안내] 아직 빌드되지 않았습니다. build.bat 를 먼저 실행하세요.
  pause
  exit /b 1
)
:loop
echo [시작] %date% %time%
java -Dfile.encoding=UTF-8 -Dagent.home="%~dp0." -jar target\chibiz-deposit-agent.jar
if errorlevel 1 (
  echo [비정상 종료] 10초 뒤 다시 시작합니다. 멈추려면 이 창을 닫으세요.
  timeout /t 10 >nul
  goto loop
)
echo [종료] 창에서 닫기를 눌러 정상 종료했습니다.
