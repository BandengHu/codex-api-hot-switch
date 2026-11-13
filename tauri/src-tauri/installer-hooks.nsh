!include "LogicLib.nsh"

!define SWITCHGATE_CLEANUP_SCRIPT "$PLUGINSDIR\switchgate-installer-cleanup.ps1"
!define SWITCHGATE_CLEANUP_SOURCE "{{INSTALLER_CLEANUP_SOURCE}}"
!define SWITCHGATE_POWERSHELL "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"

!macro SWITCHGATE_STOP_INSTALL_PROCESSES
  SetOutPath "$PLUGINSDIR"
  File "/oname=switchgate-installer-cleanup.ps1" "${SWITCHGATE_CLEANUP_SOURCE}"
  SetOutPath "$INSTDIR"

  DetailPrint "正在关闭占用 Codex SwitchGate 安装目录的进程..."
  nsExec::ExecToStack '"${SWITCHGATE_POWERSHELL}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${SWITCHGATE_CLEANUP_SCRIPT}" -InstallDir "$INSTDIR"'
  Pop $0
  Pop $1

  ${If} $0 != "0"
    ${If} $1 == ""
      StrCpy $1 "仍有关联进程未退出，或无法读取进程列表。"
    ${EndIf}
    MessageBox MB_ICONSTOP|MB_OK "无法关闭占用安装目录的进程，安装已停止。$\r$\n$\r$\n$1$\r$\n$\r$\n请关闭 Codex、DeepSeek Harness 后重试。"
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro SWITCHGATE_STOP_INSTALL_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro SWITCHGATE_STOP_INSTALL_PROCESSES
!macroend
