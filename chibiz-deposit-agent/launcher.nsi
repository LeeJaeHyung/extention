; 차이비즈 입금 에이전트 — 실행 런처(exe). 설치 폴더의 runtime\bin\javaw.exe 로 app\chibiz-deposit-agent.jar 를 띄운다(콘솔 창 없음).
Unicode true
Name "ChibizDepositAgent"
OutFile "ChibizDepositAgent.exe"
SilentInstall silent
RequestExecutionLevel user
!ifdef ICONFILE
Icon "${ICONFILE}"
!endif
VIProductVersion "0.2.0.0"
VIAddVersionKey "ProductName" "차이비즈 입금 에이전트"
VIAddVersionKey "FileDescription" "차이비즈 입금 에이전트"
VIAddVersionKey "FileVersion" "0.2.0"
VIAddVersionKey "CompanyName" "chibiz"
VIAddVersionKey "LegalCopyright" "chibiz"

Section
  SetOutPath "$EXEDIR"
  ; 이미 떠 있는지 확인(창 제목)
  FindWindow $0 "" "차이비즈 입금 에이전트"
  StrCmp $0 0 run
    MessageBox MB_OK|MB_ICONINFORMATION "차이비즈 입금 에이전트가 이미 실행 중입니다."
    Quit
  run:
  Exec '"$EXEDIR\runtime\bin\javaw.exe" -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 "-Dagent.home=$EXEDIR" -jar "$EXEDIR\app\chibiz-deposit-agent.jar"'
SectionEnd
