@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 차이비즈 입금 에이전트
where java >nul 2>nul
if errorlevel 1 (
  echo [오류] java 를 찾을 수 없습니다. JDK 17 이상을 설치하고 PATH 에 넣거나, 새 명령 프롬프트에서 다시 실행하세요.
  pause
  exit /b 1
)
java -version 2>&1 | findstr /i "version"
if not exist config.json (
  echo [안내] config.example.json 을 복사해 config.json 을 만들고 DB 비밀번호·mcp.token 을 넣은 뒤 다시 실행하세요.
  pause
  exit /b 1
)
:loop
echo [시작] %date% %time%
java -Dfile.encoding=UTF-8 -Dagent.home="%~dp0." -jar chibiz-deposit-agent.jar
set RC=%errorlevel%
echo [종료 코드 %RC%] %date% %time%
if not "%RC%"=="0" (
  echo [비정상 종료] 위 메시지와 agent.log 를 확인하세요. 10초 뒤 다시 시작합니다. 멈추려면 이 창을 닫으세요.
  timeout /t 10 >nul
  goto loop
)
echo [종료] 창에서 닫기를 눌러 정상 종료했습니다. 아무 키나 누르면 이 창이 닫힙니다.
pause >nul
