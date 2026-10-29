; 차이비즈 입금 에이전트 설치 프로그램 (NSIS · 맥에서 makensis 로 생성)
; 설치 위치: %LOCALAPPDATA%\ChibizDepositAgent (관리자 권한 불필요 · config.json 을 같은 폴더에 둬야 하므로 Program Files 는 피함)
Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"

Name "차이비즈 입금 에이전트"
OutFile "차이비즈 입금 에이전트 설치.exe"
InstallDir "$LOCALAPPDATA\ChibizDepositAgent"
InstallDirRegKey HKCU "Software\ChibizDepositAgent" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "chibiz"
!ifdef ICONFILE
!define MUI_ICON "${ICONFILE}"
!define MUI_UNICON "${ICONFILE}"
!endif

VIProductVersion "0.2.0.0"
VIAddVersionKey "ProductName" "차이비즈 입금 에이전트"
VIAddVersionKey "FileDescription" "차이비즈 입금 에이전트 설치"
VIAddVersionKey "FileVersion" "0.2.0"
VIAddVersionKey "CompanyName" "chibiz"
VIAddVersionKey "LegalCopyright" "chibiz"

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "차이비즈 입금 에이전트 설치"
!define MUI_WELCOMEPAGE_TEXT "하나은행 빠른조회에서 수집한 입금 내역을 이 PC 의 MySQL 에 저장하고, 사이트 신청 큐와 대조하는 프로그램입니다.$\r$\n$\r$\n자바 런타임이 포함돼 있어 별도 설치가 필요 없습니다. MySQL(root / 1234567)은 미리 설치돼 있어야 합니다.$\r$\n$\r$\n설치 후 크롬에 «차이비즈 입금 수집» 익스텐션을 로드하고 빠른조회 화면에서 [실행]을 누르면 수집이 시작됩니다."
!define MUI_FINISHPAGE_RUN "$INSTDIR\ChibizDepositAgent.exe"
!define MUI_FINISHPAGE_RUN_TEXT "지금 실행"
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\config.json"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "config.json 열기(DB 비밀번호·MCP 토큰·계좌 이름)"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Korean"

Section "프로그램 (필수)" SEC_APP
  SectionIn RO
  SetOutPath "$INSTDIR"
  File "ChibizDepositAgent.exe"
  File "config.example.json"
  ; 기존 config.json 은 보존. 없으면 기본 설정(중판·G9NOW 계좌 라벨 포함)으로 시작
  IfFileExists "$INSTDIR\config.json" keepcfg
    File "/oname=config.json" "config.json"
  keepcfg:
  SetOutPath "$INSTDIR\app"
  File "app\chibiz-deposit-agent.jar"
  SetOutPath "$INSTDIR\runtime"
  File /r "runtime\*.*"
  SetOutPath "$INSTDIR"
  WriteRegStr HKCU "Software\ChibizDepositAgent" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChibizDepositAgent" "DisplayName" "차이비즈 입금 에이전트"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChibizDepositAgent" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChibizDepositAgent" "DisplayIcon" "$INSTDIR\ChibizDepositAgent.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChibizDepositAgent" "Publisher" "chibiz"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChibizDepositAgent" "DisplayVersion" "0.2.0"
  CreateDirectory "$SMPROGRAMS\차이비즈"
  CreateShortCut "$SMPROGRAMS\차이비즈\차이비즈 입금 에이전트.lnk" "$INSTDIR\ChibizDepositAgent.exe"
  CreateShortCut "$SMPROGRAMS\차이비즈\설정 파일(config.json).lnk" "notepad.exe" '"$INSTDIR\config.json"'
  CreateShortCut "$SMPROGRAMS\차이비즈\제거.lnk" "$INSTDIR\Uninstall.exe"
SectionEnd

Section "바탕 화면 바로가기" SEC_DESKTOP
  CreateShortCut "$DESKTOP\차이비즈 입금 에이전트.lnk" "$INSTDIR\ChibizDepositAgent.exe"
SectionEnd

Section "윈도우 시작 시 자동 실행" SEC_STARTUP
  CreateShortCut "$SMSTARTUP\차이비즈 입금 에이전트.lnk" "$INSTDIR\ChibizDepositAgent.exe"
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_APP} "에이전트 본체 + 자바 런타임 + 기본 설정"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_DESKTOP} "바탕 화면에 실행 아이콘"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_STARTUP} "PC 를 켜면 자동으로 에이전트가 뜨게 함(30일 연속 수집용)"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  Delete "$SMSTARTUP\차이비즈 입금 에이전트.lnk"
  Delete "$DESKTOP\차이비즈 입금 에이전트.lnk"
  Delete "$SMPROGRAMS\차이비즈\차이비즈 입금 에이전트.lnk"
  Delete "$SMPROGRAMS\차이비즈\설정 파일(config.json).lnk"
  Delete "$SMPROGRAMS\차이비즈\제거.lnk"
  RMDir "$SMPROGRAMS\차이비즈"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\app"
  Delete "$INSTDIR\ChibizDepositAgent.exe"
  Delete "$INSTDIR\config.example.json"
  Delete "$INSTDIR\Uninstall.exe"
  ; config.json · agent.log 는 남긴다(설정·기록 보존). 폴더가 비면 지움
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChibizDepositAgent"
  DeleteRegKey HKCU "Software\ChibizDepositAgent"
SectionEnd
