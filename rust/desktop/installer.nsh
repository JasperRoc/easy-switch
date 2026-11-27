!define MUI_BGCOLOR "FFFFFF"
!define MUI_TEXTCOLOR "20364B"
!define MUI_HEADERIMAGE_BITMAP_STRETCH AspectFitHeight
!define MUI_WELCOMEFINISHPAGE_BITMAP_STRETCH AspectFitHeight

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    nsExec::ExecToStack '"$INSTDIR\fluid.exe" --uninstall-data'
    Pop $R8
    Pop $R7
    ${If} $R8 != 0
      SetErrorLevel 2
      Abort "Quit fluid and retry uninstalling. Your recovery data has been kept."
    ${EndIf}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "fluid"
    StrCpy $DeleteAppDataCheckboxState 1
  ${EndIf}
!macroend
