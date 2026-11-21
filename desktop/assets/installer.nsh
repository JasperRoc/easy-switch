; Keep the native Windows wizard accessible, with the application's own artwork.
!define MUI_BGCOLOR "FFFFFF"
!define MUI_TEXTCOLOR "20364B"
!define MUI_INSTFILESPAGE_COLORS "20364B F6F9FC"
!define MUI_HEADERIMAGE_BITMAP_STRETCH AspectFitHeight
!define MUI_WELCOMEFINISHPAGE_BITMAP_STRETCH AspectFitHeight
!define MUI_UNWELCOMEFINISHPAGE_BITMAP_STRETCH AspectFitHeight
!define MUI_WELCOMEPAGE_TITLE "$(EasySwitchWelcome)"
!define MUI_WELCOMEPAGE_TEXT "$(EasySwitchIntroduction)"
!define MUI_FINISHPAGE_TITLE "$(EasySwitchReady)"
!define MUI_FINISHPAGE_TEXT "$(EasySwitchFinish)"
!define MUI_FINISHPAGE_RUN_TEXT "$(EasySwitchLaunch)"

!macro customHeader
  WindowIcon on
  SetFont "Segoe UI" 9
  BrandingText "easy-switch ${VERSION}"
  LangString EasySwitchWelcome 1033 "Welcome to easy-switch"
  LangString EasySwitchWelcome 2052 "欢迎使用 easy-switch"
  LangString EasySwitchIntroduction 1033 "Keep your conversations flowing.$\r$\n$\r$\nManage Codex and Claude Code accounts, APIs and models in one place.$\r$\n$\r$\nSetup will install easy-switch on your computer. Your client connection settings are configured when you launch the app, and restored when you quit."
  LangString EasySwitchIntroduction 2052 "让 AI 会话流畅继续。$\r$\n$\r$\n集中管理 Codex 与 Claude Code 的账号、API 和模型。$\r$\n$\r$\n安装程序将为你安装 easy-switch。启动软件后才会接管客户端连接，退出时恢复原连接设置。"
  LangString EasySwitchReady 1033 "easy-switch is ready"
  LangString EasySwitchReady 2052 "easy-switch 已安装完成"
  LangString EasySwitchFinish 1033 "Launch easy-switch to add your providers and choose a model.$\r$\n$\r$\nClosing its window keeps routing in the system tray. Open the tray menu to switch providers or quit.$\r$\n$\r$\nStart at login is optional and off by default."
  LangString EasySwitchFinish 2052 "启动 easy-switch，添加服务商并选择模型。$\r$\n$\r$\n关闭窗口后，软件会留在系统托盘继续运行。通过托盘菜单切换服务商或退出软件。$\r$\n$\r$\n开机自启动可自行开启，默认关闭。"
  LangString EasySwitchLaunch 1033 "Open easy-switch"
  LangString EasySwitchLaunch 2052 "打开 easy-switch"
!macroend

!macro customWelcomePage
  !insertmacro skipPageIfUpdated
  !insertmacro MUI_PAGE_WELCOME
!macroend

; Check for the app with NSIS's native process plugin on every install and uninstall.
!macro customCheckAppRunning
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $0
  ${While} $0 == 0
    Sleep 1000
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $0
    ${If} $0 == 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY +3
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndWhile}
  ${nsProcess::Unload}
!macroend

; Updates preserve providers. A real uninstall restores routes before erasing data.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    IfFileExists "$INSTDIR\easy-switch.exe" 0 easy_switch_cleaned
    System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
    nsExec::ExecToStack '"$INSTDIR\easy-switch.exe" "$INSTDIR\resources\app.asar\desktop\uninstall-cli.cjs"'
    Pop $0
    Pop $1
    System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "")'
    ${if} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "easy-switch could not restore its client settings. Your recovery data was retained. $1"
      Abort
    ${endif}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "easy-switch"
    easy_switch_cleaned:
  ${endif}
!macroend
