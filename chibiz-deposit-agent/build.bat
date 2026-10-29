@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 차이비즈 입금 에이전트 빌드
echo [빌드] JDK 17+ 가 필요합니다. Maven 은 mvnw 가 내려받습니다.
call mvnw.cmd -q -DskipTests package
if errorlevel 1 (
  echo [실패] 위 오류를 확인하세요.
  pause
  exit /b 1
)
echo [완료] target\chibiz-deposit-agent.jar
pause
