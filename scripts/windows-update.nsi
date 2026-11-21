Unicode True
Name "easy-switch update helper"
OutFile "${UPDATE_HELPER}"
RequestExecutionLevel user
SilentInstall silent
SetCompressor /SOLID lzma

!include LogicLib.nsh
!include FileFunc.nsh

Var currentApp
Var installer
Var token
Var failure

Section
  SetOutPath "$EXEDIR"
  ReadINIStr $currentApp "$EXEDIR\windows-install.ini" "update" "current"
  ReadINIStr $installer "$EXEDIR\windows-install.ini" "update" "installer"
  ReadINIStr $token "$EXEDIR\windows-install.ini" "update" "token"
  ReadINIStr $0 "$EXEDIR\windows-install.ini" "update" "parent"
  ReadINIStr $1 "$EXEDIR\windows-install.ini" "update" "version"
  StrCpy $failure "The Windows update files are unavailable. Download the update again."
  ${If} $token == ""
  ${OrIf} $1 == ""
  ${OrIfNot} ${FileExists} "$currentApp"
  ${OrIfNot} ${FileExists} "$installer"
    Goto failed
  ${EndIf}

  ; Retain the process handle before asking the running application to quit.
  StrCpy $failure "The Windows update helper could not prepare to close easy-switch."
  System::Call 'kernel32::OpenProcess(i 0x100000, i 0, i r0) p.r2'
  StrCmp $2 0 failed
  ClearErrors
  FileOpen $3 "$EXEDIR\helper-ready.txt" w
  IfErrors closeParent
  FileWrite $3 "$token"
  FileClose $3
  IfErrors closeParent
  System::Call 'kernel32::WaitForSingleObject(p r2, i 60000) i.r4'
  System::Call 'kernel32::CloseHandle(p r2)'
  StrCpy $failure "The previous application did not exit. Close easy-switch before retrying the update."
  StrCmp $4 0 0 failed

  ; /D= must be the final argument and the directory must be unquoted for NSIS.
  ${GetParent} "$currentApp" $5
  ClearErrors
  ExecWait '"$installer" /S --updated /D=$5' $0
  ${If} ${Errors}
    StrCpy $failure "The Windows installer could not start. Run the downloaded installer manually."
    Goto restartOld
  ${EndIf}
  ${If} $0 != 0
    StrCpy $failure "The Windows installer failed (exit code $0). Run the downloaded installer manually."
    Goto restartOld
  ${EndIf}
  ${GetFileVersion} "$currentApp" $0
  StrCpy $1 "$1."
  StrLen $4 $1
  StrCpy $0 $0 $4
  ${If} $0 != $1
    StrCpy $failure "The Windows installer did not replace this copy of easy-switch. Run the downloaded installer manually in the existing installation folder."
    Goto restartOld
  ${EndIf}

  SetOutPath "$5"
  ClearErrors
  Exec '"$currentApp" --updated'
  ${If} ${Errors}
    StrCpy $failure "The updated Windows application could not start."
    Goto failed
  ${EndIf}
  StrCpy $0 300
  waitForApp:
    ClearErrors
    FileOpen $3 "$EXEDIR\app-ready.txt" r
    ${IfNot} ${Errors}
      FileRead $3 $4
      FileClose $3
      ${If} $4 == $token
        Delete "$installer"
        Delete "$EXEDIR\pending.json"
        Goto complete
      ${EndIf}
    ${EndIf}
    Sleep 200
    IntOp $0 $0 - 1
    IntCmp $0 0 0 waitForApp waitForApp
  StrCpy $failure "The updated Windows application did not confirm startup. Reopen easy-switch to see the update error."
  Goto failed

  closeParent:
    System::Call 'kernel32::CloseHandle(p r2)'
    Goto failed
  restartOld:
    Call writeFailure
    ${If} ${FileExists} "$currentApp"
      SetOutPath "$5"
      Exec '"$currentApp"'
    ${EndIf}
    Goto failedCleanup
  failed:
    Call writeFailure
  failedCleanup:
    Delete "$EXEDIR\pending.json"
    SetErrorLevel 1
  complete:
    Delete "$EXEDIR\helper-ready.txt"
    Delete "$EXEDIR\app-ready.txt"
    Delete "$EXEDIR\windows-install.ini"
SectionEnd

Function writeFailure
  ClearErrors
  FileOpen $3 "$EXEDIR\last-error.txt" w
  IfErrors done
  FileWrite $3 "$failure"
  FileClose $3
  done:
FunctionEnd
