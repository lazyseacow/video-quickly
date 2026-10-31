!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

Var RemoveWorkspace
Var RemoveWorkspaceCheckbox

!macro customUnInit
  StrCpy $RemoveWorkspace ${BST_UNCHECKED}
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${IfNot} ${Errors}
    StrCpy $RemoveWorkspace ${BST_CHECKED}
  ${EndIf}
!macroend

!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.WorkspaceOptions un.WorkspaceOptionsLeave
!macroend

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

!macro customUnInstall
  ${IfNot} ${isUpdated}
  ${AndIf} $RemoveWorkspace == ${BST_CHECKED}
    SetShellVarContext current
    RMDir /r "$APPDATA\VideoQuickly-Electron"
    RMDir /r "$LOCALAPPDATA\VideoQuickly-Electron"
  ${EndIf}
!macroend
