!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

# electron-builder compiles the uninstaller and installer in separate passes.
# These variables are only used by the uninstaller callbacks below.
!ifdef BUILD_UNINSTALLER
  Var RemoveWorkspace
  Var RemoveWorkspaceCheckbox
!endif

!macro customUnInit
  StrCpy $RemoveWorkspace ${BST_UNCHECKED}
  ${GetParameters} $R0
  ClearErrors
  # Do not reuse the builder's broader --delete-app-data cleanup option.
  ${GetOptions} $R0 "--delete-electron-workspace" $R1
  ${IfNot} ${Errors}
    StrCpy $RemoveWorkspace ${BST_CHECKED}
  ${EndIf}
!macroend

!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.WorkspaceOptions un.WorkspaceOptionsLeave

# Defer function compilation until the builder has registered StdUtils plugins
# and loaded MUI2. Custom includes can precede that async-generated header.
Function un.WorkspaceOptions
  ${If} ${isUpdated}
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${If} $LANGUAGE == 2052
    !insertmacro MUI_HEADER_TEXT "项目数据" "默认保留项目、素材和恢复记录。"
    ${NSD_CreateCheckbox} 0 10u 100% 30u "同时删除本机项目数据（无法撤销）"
  ${Else}
    !insertmacro MUI_HEADER_TEXT "Project data" "Projects, media and recovery records are retained by default."
    ${NSD_CreateCheckbox} 0 10u 100% 30u "Also delete this user's project data (cannot be undone)"
  ${EndIf}
  Pop $RemoveWorkspaceCheckbox
  ${NSD_SetState} $RemoveWorkspaceCheckbox $RemoveWorkspace
  nsDialogs::Show
FunctionEnd

Function un.WorkspaceOptionsLeave
  ${NSD_GetState} $RemoveWorkspaceCheckbox $RemoveWorkspace
FunctionEnd
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
  ${AndIf} $RemoveWorkspace == ${BST_CHECKED}
    SetShellVarContext current
    RMDir /r "$APPDATA\VideoQuickly-Electron"
  ${EndIf}
!macroend
