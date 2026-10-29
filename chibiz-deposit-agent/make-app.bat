@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 차이비즈 입금 에이전트 — 설치형(exe) 만들기
echo [1/2] 빌드 (mvnw · JavaFX 윈도우 네이티브 포함)
call mvnw.cmd -q -DskipTests clean package
if errorlevel 1 ( echo [실패] 빌드 오류 & pause & exit /b 1 )
echo [2/2] jpackage — 자바 런타임을 통째로 묶은 실행 폴더 생성 (JDK 17+ 의 jpackage 사용)
if exist dist rmdir /s /q dist
jpackage --type app-image --name "차이비즈 입금 에이전트" --dest dist ^
  --input target --main-jar chibiz-deposit-agent.jar --main-class kr.chibiz.depositagent.Launcher ^
  --java-options "-Dfile.encoding=UTF-8" --java-options "-Dagent.home=$APPDIR\.." ^
  --app-version 0.2.0 --vendor "chibiz" --description "하나은행 입금 수집·신청 큐 대조 에이전트" --win-console false
if errorlevel 1 ( echo [실패] jpackage 오류 — JDK 17 이상인지, PATH 에 jpackage 가 있는지 확인 & pause & exit /b 1 )
copy /y config.example.json "dist\차이비즈 입금 에이전트\" >nul
if exist config.json copy /y config.json "dist\차이비즈 입금 에이전트\" >nul
echo.
echo [완료] dist\차이비즈 입금 에이전트\차이비즈 입금 에이전트.exe
echo        같은 폴더의 config.json 을 채우고 exe 를 실행하세요. 시작프로그램에는 이 exe 바로가기를 넣으면 됩니다.
echo        (설치 프로그램 .msi 가 필요하면 WiX 설치 후 --type msi 로 바꾸세요)
pause
