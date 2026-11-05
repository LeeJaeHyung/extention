; 차이비즈 입금 처리 확인 설치 프로그램 (NSIS · 맥에서 makensis 로 생성 · 런타임은 윈도우 jlink 이미지를 그대로 넣는다)
; 설치 위치: %LOCALAPPDATA%\ChibizDepositConfirm (관리자 권한 불필요)
Unicode true
!include "MUI2.nsh"

Name "차이비즈 입금 처리 확인"
OutFile "차이비즈 입금 처리 확인 설치.exe"
InstallDir "$LOCALAPPDATA\ChibizDepositConfirm"
InstallDirRegKey HKCU "Software\ChibizDepositConfirm" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "chibiz"
!ifdef ICONFILE
!define MUI_ICON "${ICONFILE}"
!define MUI_UNICON "${ICONFILE}"
!endif

VIProductVersion "0.1.2.0"
VIAddVersionKey "ProductName" "차이비즈 입금 처리 확인"
VIAddVersionKey "FileDescription" "차이비즈 입금 처리 확인 설치"
VIAddVersionKey "FileVersion" "0.1.2"
VIAddVersionKey "CompanyName" "chibiz"
VIAddVersionKey "LegalCopyright" "chibiz"

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "차이비즈 입금 처리 확인 설치"
!define MUI_WELCOMEPAGE_TEXT "같은 PC 의 입금 에이전트가 가진 통장 입금 가운데 아직 처리되지 않은 것을 보고, 담당자가 [처리]·[취소] 하는 프로그램입니다.$\r$\n$\r$\n자바 런타임이 포함돼 있어 별도 설치가 필요 없습니다. 입금 에이전트(127.0.0.1:18080)가 켜져 있어야 합니다.$\r$\n$\r$\n처리·취소 기록의 처리자는 SuperID(플랫폼 이름)로 남습니다."
!define MUI_FINISHPAGE_RUN "$INSTDIR\ChibizDepositConfirm.exe"
!define MUI_FINISHPAGE_RUN_TEXT "지금 실행"

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
  File "ChibizDepositConfirm.exe"
  File "config.example.json"
  ; 기존 config.json(처리자 아이디) 은 보존
  IfFileExists "$INSTDIR\config.json" keepcfg
    File "/oname=config.json" "config.example.json"
  keepcfg:
  SetOutPath "$INSTDIR\app"
  File "app\chibiz-deposit-confirm.jar"
  SetOutPath "$INSTDIR\runtime"
  File /r "runtime\*.*"
  SetOutPath "$INSTDIR"
  WriteRegStr HKCU "Software\ChibizDepositConfirm" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChibizDepositConfirm" "DisplayName" "차이비즈 입금 처리 확인"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChibizDepositConfirm" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChibizDepositConfirm" "DisplayIcon" "$INSTDIR\ChibizDepositConfirm.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChibizDepositConfirm" "Publisher" "chibiz"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChibizDepositConfirm" "DisplayVersion" "0.1.2"
  CreateDirectory "$SMPROGRAMS\차이비즈"
  CreateShortCut "$SMPROGRAMS\차이비즈\차이비즈 입금 처리 확인.lnk" "$INSTDIR\ChibizDepositConfirm.exe"
  CreateShortCut "$SMPROGRAMS\차이비즈\입금 처리 확인 제거.lnk" "$INSTDIR\Uninstall.exe"
SectionEnd

Section "바탕 화면 바로가기" SEC_DESKTOP
  CreateShortCut "$DESKTOP\차이비즈 입금 처리 확인.lnk" "$INSTDIR\ChibizDepositConfirm.exe"
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_APP} "프로그램 본체 + 자바 런타임 + 기본 설정"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_DESKTOP} "바탕 화면에 실행 아이콘"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  Delete "$DESKTOP\차이비즈 입금 처리 확인.lnk"
  Delete "$SMPROGRAMS\차이비즈\차이비즈 입금 처리 확인.lnk"
  Delete "$SMPROGRAMS\차이비즈\입금 처리 확인 제거.lnk"
  RMDir "$SMPROGRAMS\차이비즈"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\app"
  Delete "$INSTDIR\ChibizDepositConfirm.exe"
  Delete "$INSTDIR\config.example.json"
  Delete "$INSTDIR\Uninstall.exe"
  ; config.json 은 남긴다(처리자 보존)
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChibizDepositConfirm"
  DeleteRegKey HKCU "Software\ChibizDepositConfirm"
SectionEnd
