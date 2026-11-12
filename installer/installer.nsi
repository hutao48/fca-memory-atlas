; FCA Memory Atlas — NSIS installer (Alpha 0.1)
; 由 installer/build.js 调用：
;   makensis /V2 /INPUTCHARSET UTF8 /DVERSION= /DPRODUCTVERSION= /DPAYLOAD= /DOUTFILE= /DCOMPRESS= /DBUILT_AT= /DAPIVERSION= installer.nsi
;
; 特性：
;  - per-user 安装（RequestExecutionLevel user，无需管理员；默认 $LOCALAPPDATA\Programs\FCA Memory Atlas）
;  - 支持安装目录选择与静默安装 /S；自定义目录用最后一个参数 /D=<绝对路径>（NSIS 约定，路径不能加引号）
;  - 桌面 / 开始菜单快捷方式、开始菜单卸载项、标准“应用和功能”卸载登记
;  - 安装日志 %TEMP%\fca-install.log、卸载日志 %TEMP%\fca-uninstall.log、安装报告 <InstallDir>\install-report.ini
;  - 安装失败/文件缺失时给出明确错误码与日志路径（静默安装同样写日志并返回非 0 退出码）
;  - 卸载：先尝试优雅停止随包 Runtime；用户数据目录默认保留（提示是否删除，默认“否”）

Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!ifndef VERSION
  !define VERSION "0.1.0"
!endif
!ifndef PRODUCTVERSION
  !define PRODUCTVERSION "${VERSION}"
!endif
!ifndef APIVERSION
  !define APIVERSION "1"
!endif
!ifndef BUILT_AT
  !define BUILT_AT "unknown"
!endif
!ifndef COMPRESS
  !define COMPRESS 1
!endif
!if ${COMPRESS} == 1
  ; 先设置压缩器，再设置字典大小（顺序反了会触发 “compressor is not set to LZMA” 警告）
  SetCompressor /SOLID lzma
  SetCompressorDictSize 64
!else
  SetCompress off
!endif

!define PRODUCT_NAME "FCA Memory Atlas"
!define PRODUCT_PUBLISHER "FCA Project"
!define PRODUCT_VERSION "${PRODUCTVERSION}"
!define PRODUCT_ID "FCAMemoryAtlas"
!define PRODUCT_EXE "FCA Memory Atlas.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_ID}"
!define APP_KEY "Software\${PRODUCT_ID}"
!define DATA_DIR "$LOCALAPPDATA\FCA-Memory-Atlas"
!define RUNTIME_PORT "17860"
!define INSTALL_LOG "$TEMP\fca-install.log"
!define UNINSTALL_LOG "$TEMP\fca-uninstall.log"
!define HELP_DIR "$SMPROGRAMS\${PRODUCT_NAME}"

Name "${PRODUCT_NAME} ${PRODUCT_VERSION}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
InstallDirRegKey HKCU "${APP_KEY}" "InstallLocation"
RequestExecutionLevel user
BrandingText "${PRODUCT_NAME} ${PRODUCT_VERSION} (Alpha)"
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "CompanyName" "${PRODUCT_PUBLISHER}"
VIAddVersionKey /LANG=1033 "FileDescription" "${PRODUCT_NAME} Setup"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Alpha 0.1 — FCA Project"
VIAddVersionKey /LANG=1033 "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "Comments" "Local-first cognitive memory atlas. Built ${BUILT_AT}. API v${APIVERSION}."

!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "启动 ${PRODUCT_NAME}"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\docs\USER_MANUAL.md"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "打开用户手册（docs\USER_MANUAL.md）"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!define MUI_LICENSEPAGE_CHECKBOX
!define MUI_LICENSEPAGE_CHECKBOX_TEXT "我已阅读并接受许可声明（本软件为内部 Alpha 版本，按“现状”提供）"
!define MUI_WELCOMEPAGE_TITLE "欢迎安装 ${PRODUCT_NAME} ${PRODUCT_VERSION}"
!define MUI_WELCOMEPAGE_TEXT "FCA Memory Atlas 是本地优先的认知记忆基础设施：星云式记忆可视化、记忆/关系编辑、时间线、搜索、备份恢复。$\r$\n$\r$\n本安装包同时安装：$\r$\n  • FCA Memory Atlas 桌面软件（Electron 38，Windows x64）$\r$\n  • FCA Local Runtime 本地服务（默认 127.0.0.1:${RUNTIME_PORT}）$\r$\n  • 随包 Node 24 运行时（无需系统预装 Node）$\r$\n$\r$\n安装目录默认在用户目录下，无需管理员权限。$\r$\n数据目录默认：${DATA_DIR}（可在首次启动向导/设置中更改）。$\r$\n安装日志：${INSTALL_LOG}。$\r$\n$\r$\n首次启动会创建全新的本地记忆库（不导入任何旧数据）。"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${PAYLOAD}\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

; ---------------------------------------------------------------- vars/helpers
Var /GLOBAL LOGFILE
Var /GLOBAL RUNNING
Var /GLOBAL INSTALL_OK
Var /GLOBAL DATA_CHOICE

Function .onInit
  StrCpy $INSTALL_OK "0"
  StrCpy $RUNNING "0"
  ${If} ${Silent}
    StrCpy $RUNNING "1"
  ${EndIf}
  StrCpy $LOGFILE "${INSTALL_LOG}"
  ClearErrors
  FileOpen $9 "$LOGFILE" w
  ${If} ${Errors}
    StrCpy $LOGFILE ""
    DetailPrint "WARN: 无法写入安装日志 ${INSTALL_LOG}"
  ${Else}
    FileWrite $9 "FCA Memory Atlas ${PRODUCT_VERSION} installer started$\r$\n"
    FileWrite $9 "built_at=${BUILT_AT} api_version=v${APIVERSION}$\r$\n"
    FileWrite $9 "cmdline=$CMDLINE$\r$\n"
    FileWrite $9 "silent=$RUNNING$\r$\n"
    FileWrite $9 "default_install_dir=$LOCALAPPDATA\Programs\${PRODUCT_NAME}$\r$\n"
    FileClose $9
  ${EndIf}
FunctionEnd

Function WriteLog
  Exch $0
  ${If} $LOGFILE != ""
    ClearErrors
    FileOpen $9 "$LOGFILE" a
    ${IfNot} ${Errors}
      FileWrite $9 "$0$\r$\n"
      FileClose $9
    ${EndIf}
  ${EndIf}
  DetailPrint "$0"
  Pop $0
FunctionEnd

; 正在运行的桌面进程检测（窗口标题形如 "FCA Memory Atlas — Alpha 0.1.0"）
Function CheckRunning
  StrCpy $RUNNING "0"
  FindWindow $0 "" "${PRODUCT_NAME}*"
  ${If} $0 != 0
    StrCpy $RUNNING "1"
  ${Else}
    FindWindow $0 "" "*${PRODUCT_NAME}*"
    ${If} $0 != 0
      StrCpy $RUNNING "1"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function .onVerifyInstDir
  ; 拒绝根目录 / 系统目录，避免误装；其余可写目录允许
  ${If} $INSTDIR == "C:\"
  ${OrIf} $INSTDIR == "C:\Windows"
  ${OrIf} $INSTDIR == "$WINDIR"
  ${OrIf} $INSTDIR == "$PROGRAMFILES"
  ${OrIf} $INSTDIR == "$PROGRAMFILES64"
    Abort
  ${EndIf}
FunctionEnd

Function .onInstFailed
  Push "ERROR: installation failed (see ${INSTALL_LOG})"
  Call WriteLog
FunctionEnd

; ---------------------------------------------------------------- install
Section "FCA Memory Atlas (required)" SecMain
  SectionIn RO
  SetShellVarContext current
  SetOutPath "$INSTDIR"

  Push "step: preflight (install_dir=$INSTDIR, silent=$RUNNING)"
  Call WriteLog

  ; 升级安装：安装器**不自动停止**任何 Runtime（避免误停其它数据目录/其它实例的 Runtime）。
  ; 仅提示用户自行停止；静默安装只记录日志，然后继续（文件被占用时安装会失败并写日志）。
  ${If} ${FileExists} "$INSTDIR\node\node.exe"
  ${AndIf} ${FileExists} "$INSTDIR\runtime\bin\fca-runtime.js"
    Push "step: existing installation detected (upgrade); runtime is NOT auto-stopped by design"
    Call WriteLog
    ${IfNot} ${Silent}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "检测到已安装的旧版本。升级会覆盖程序文件。$\r$\n$\r$\n如果 FCA Memory Atlas 或本地 Runtime 正在运行，请先关闭程序；若 Runtime 仍在后台运行，请在应用内“设置 → Runtime → 停止 Runtime”，或重启电脑后再安装。否则可能因文件被占用而安装失败。$\r$\n$\r$\n点击“确定”继续安装，点“取消”退出。" /SD IDOK IDCANCEL upgrade_abort
    ${EndIf}
    Goto upgrade_continue
    upgrade_abort:
      Push "ERROR: user cancelled upgrade because runtime may be running"
      Call WriteLog
      SetErrorLevel 2
      Abort
    upgrade_continue:
  ${EndIf}

  Call CheckRunning
  ${If} $RUNNING == "1"
    MessageBox MB_ICONSTOP|MB_OK "FCA Memory Atlas 正在运行。请先关闭它（包括托盘/后台窗口），然后点击“确定”继续安装。$\r$\n$\r$\n安装日志：${INSTALL_LOG}" /SD IDOK
    Call CheckRunning
    ${If} $RUNNING == "1"
      Push "ERROR: FCA Memory Atlas is running; installation aborted (exit code 2)"
      Call WriteLog
      SetErrorLevel 2
      Abort
    ${EndIf}
  ${EndIf}

  Push "step: extracting application files to $INSTDIR"
  Call WriteLog
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}\*.*"
  Push "step: files extracted"
  Call WriteLog

  ; ---- 关键文件校验（失败给出明确错误与日志路径）
  Push "step: verifying critical files"
  Call WriteLog
  ${IfNot} ${FileExists} "$INSTDIR\${PRODUCT_EXE}"
    MessageBox MB_ICONSTOP|MB_OK "安装失败：主程序 ${PRODUCT_EXE} 未生成。$\r$\n$\r$\n错误码 E1（主程序缺失）。$\r$\n安装日志：${INSTALL_LOG}" /SD IDOK
    Push "ERROR E1: main executable missing: $INSTDIR\${PRODUCT_EXE}"
    Call WriteLog
    SetErrorLevel 3
    Abort
  ${EndIf}
  ${IfNot} ${FileExists} "$INSTDIR\resources\app\main\main.js"
    MessageBox MB_ICONSTOP|MB_OK "安装失败：应用代码 resources\app\main\main.js 缺失。$\r$\n$\r$\n错误码 E2（应用代码不完整）。$\r$\n安装日志：${INSTALL_LOG}" /SD IDOK
    Push "ERROR E2: resources/app/main/main.js missing"
    Call WriteLog
    SetErrorLevel 4
    Abort
  ${EndIf}
  ${IfNot} ${FileExists} "$INSTDIR\resources\app\renderer\index.html"
    MessageBox MB_ICONSTOP|MB_OK "安装失败：界面文件 resources\app\renderer\index.html 缺失。$\r$\n$\r$\n错误码 E3（界面资源不完整）。$\r$\n安装日志：${INSTALL_LOG}" /SD IDOK
    Push "ERROR E3: resources/app/renderer/index.html missing"
    Call WriteLog
    SetErrorLevel 5
    Abort
  ${EndIf}
  ${IfNot} ${FileExists} "$INSTDIR\runtime\bin\fca-runtime.js"
    MessageBox MB_ICONSTOP|MB_OK "安装失败：本地服务入口 runtime\bin\fca-runtime.js 缺失。$\r$\n$\r$\n错误码 E4（Runtime 不完整）。$\r$\n安装日志：${INSTALL_LOG}" /SD IDOK
    Push "ERROR E4: runtime/bin/fca-runtime.js missing"
    Call WriteLog
    SetErrorLevel 6
    Abort
  ${EndIf}
  ${IfNot} ${FileExists} "$INSTDIR\node\node.exe"
    MessageBox MB_ICONSTOP|MB_OK "安装失败：随包 Node 运行时 node\node.exe 缺失。$\r$\n$\r$\n错误码 E5（Node 运行时缺失）。$\r$\n安装日志：${INSTALL_LOG}" /SD IDOK
    Push "ERROR E5: node/node.exe missing"
    Call WriteLog
    SetErrorLevel 7
    Abort
  ${EndIf}
  ${IfNot} ${FileExists} "$INSTDIR\docs\USER_MANUAL.md"
    Push "WARN: docs/USER_MANUAL.md missing (help shortcut may be broken)"
    Call WriteLog
  ${EndIf}
  Push "step: critical files OK"
  Call WriteLog

  ; ---- 快捷方式
  Push "step: creating shortcuts"
  Call WriteLog
  CreateDirectory "${HELP_DIR}"
  CreateShortCut "${HELP_DIR}\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_EXE}" "" "$INSTDIR\${PRODUCT_EXE}" 0
  ${If} ${FileExists} "$INSTDIR\docs\USER_MANUAL.md"
    CreateShortCut "${HELP_DIR}\使用说明.lnk" "$INSTDIR\docs\USER_MANUAL.md"
  ${EndIf}
  CreateShortCut "${HELP_DIR}\卸载 ${PRODUCT_NAME}.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_EXE}" "" "$INSTDIR\${PRODUCT_EXE}" 0

  ; ---- 卸载器 + “应用和功能”登记
  Push "step: writing uninstaller and registry entries"
  Call WriteLog
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${PRODUCT_NAME} (Alpha ${PRODUCT_VERSION})"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${PRODUCT_EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  WriteRegStr HKCU "${UNINST_KEY}" "HelpLink" "$INSTDIR\docs\USER_MANUAL.md"

  WriteRegStr HKCU "${APP_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${APP_KEY}" "Version" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${APP_KEY}" "ApiVersion" "${APIVERSION}"
  WriteRegStr HKCU "${APP_KEY}" "DataDir" "${DATA_DIR}"
  WriteRegStr HKCU "${APP_KEY}" "RuntimeUrl" "http://127.0.0.1:${RUNTIME_PORT}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${PRODUCT_EXE}" "" "$INSTDIR\${PRODUCT_EXE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${PRODUCT_EXE}" "Path" "$INSTDIR"

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"

  ; ---- 安装报告（供支持排错；含版本、构建时间、日志路径、数据策略）
  WriteINIStr "$INSTDIR\install-report.ini" "install" "product" "${PRODUCT_NAME}"
  WriteINIStr "$INSTDIR\install-report.ini" "install" "version" "${PRODUCT_VERSION}"
  WriteINIStr "$INSTDIR\install-report.ini" "install" "api_version" "${APIVERSION}"
  WriteINIStr "$INSTDIR\install-report.ini" "install" "built_at" "${BUILT_AT}"
  WriteINIStr "$INSTDIR\install-report.ini" "install" "install_dir" "$INSTDIR"
  WriteINIStr "$INSTDIR\install-report.ini" "install" "install_log" "${INSTALL_LOG}"
  WriteINIStr "$INSTDIR\install-report.ini" "install" "uninstall_log" "${UNINSTALL_LOG}"
  WriteINIStr "$INSTDIR\install-report.ini" "install" "default_data_dir" "${DATA_DIR}"
  WriteINIStr "$INSTDIR\install-report.ini" "install" "runtime_url" "http://127.0.0.1:${RUNTIME_PORT}"
  WriteINIStr "$INSTDIR\install-report.ini" "install" "uninstaller" "$INSTDIR\Uninstall.exe"
  WriteINIStr "$INSTDIR\install-report.ini" "install" "data_policy" "uninstall keeps data dir by default; prompt asks before deletion"

  StrCpy $INSTALL_OK "1"
  Push "step: installation completed successfully"
  Call WriteLog
SectionEnd

; ---------------------------------------------------------------- uninstall
Function un.onInit
  StrCpy $RUNNING "0"
  ${If} ${Silent}
    StrCpy $RUNNING "1"
  ${EndIf}
  ClearErrors
  FileOpen $9 "${UNINSTALL_LOG}" a
  ${IfNot} ${Errors}
    FileWrite $9 "FCA Memory Atlas uninstaller started (silent=$RUNNING)$\r$\n"
    FileClose $9
  ${EndIf}
FunctionEnd

Function un.WriteLog
  Exch $0
  ClearErrors
  FileOpen $9 "${UNINSTALL_LOG}" a
  ${IfNot} ${Errors}
    FileWrite $9 "$0$\r$\n"
    FileClose $9
  ${EndIf}
  DetailPrint "$0"
  Pop $0
FunctionEnd

Function un.CheckRunning
  StrCpy $RUNNING "0"
  FindWindow $0 "" "${PRODUCT_NAME}*"
  ${If} $0 != 0
    StrCpy $RUNNING "1"
  ${Else}
    FindWindow $0 "" "*${PRODUCT_NAME}*"
    ${If} $0 != 0
      StrCpy $RUNNING "1"
    ${EndIf}
  ${EndIf}
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  Push "step: uninstall preflight (install_dir=$INSTDIR)"
  Call un.WriteLog

  Call un.CheckRunning
  ${If} $RUNNING == "1"
    MessageBox MB_ICONSTOP|MB_OK "FCA Memory Atlas 正在运行。请先关闭它，然后点击“确定”继续卸载。$\r$\n$\r$\n卸载日志：${UNINSTALL_LOG}" /SD IDOK
    Call un.CheckRunning
    ${If} $RUNNING == "1"
      Push "ERROR: FCA Memory Atlas is running; uninstall aborted"
      Call un.WriteLog
      SetErrorLevel 2
      Abort
    ${EndIf}
  ${EndIf}

  ; 设计决定（Alpha 0.1）：卸载器**不自动停止 Runtime**。
  ; 原因：卸载器只知道默认数据目录，无法知道用户是否改用自定义数据目录；自动执行
  ; `fca-runtime stop` 会误停其它实例（例如 DSH 插件正在使用、或其它开发环境的 Runtime）。
  ; 检测到默认数据目录的 runtime.pid 时仅提示用户先停止（静默卸载只记录日志并继续）。
  ${If} ${FileExists} "${DATA_DIR}\runtime.pid"
  ${OrIf} ${FileExists} "$INSTDIR\runtime.pid"
    Push "step: runtime.pid detected; uninstaller does NOT stop runtime automatically (by design)"
    Call un.WriteLog
    ${IfNot} ${Silent}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "检测到本地 Runtime 可能仍在运行。$\r$\n$\r$\n卸载器不会自动停止 Runtime（避免影响其它数据目录/其它实例）。请先关闭 FCA Memory Atlas，并在应用内“设置 → Runtime → 停止 Runtime”；如有其它程序（如 DSH 插件）正在使用本地 Runtime，请一并处理。否则程序文件可能因占用而残留。$\r$\n$\r$\n点击“确定”继续卸载，点“取消”退出。" /SD IDOK IDCANCEL uninst_abort
    ${EndIf}
    Goto uninst_continue
    uninst_abort:
      Push "ERROR: user cancelled uninstall because runtime may be running"
      Call un.WriteLog
      SetErrorLevel 2
      Abort
    uninst_continue:
  ${Else}
    Push "step: no runtime.pid in default data dir; uninstaller does NOT stop runtime automatically (by design)"
    Call un.WriteLog
  ${EndIf}

  Push "step: removing shortcuts"
  Call un.WriteLog
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  Delete "${HELP_DIR}\${PRODUCT_NAME}.lnk"
  Delete "${HELP_DIR}\使用说明.lnk"
  Delete "${HELP_DIR}\卸载 ${PRODUCT_NAME}.lnk"
  RMDir "${HELP_DIR}"

  Push "step: removing application files"
  Call un.WriteLog
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\docs"
  RMDir /r "$INSTDIR\data_template"
  Delete "$INSTDIR\${PRODUCT_EXE}"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\*.html"
  Delete "$INSTDIR\*.txt"
  Delete "$INSTDIR\*.md"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\LICENSES.chromium.html"
  Delete "$INSTDIR\version"
  Delete "$INSTDIR\install-report.ini"
  Delete "$INSTDIR\Uninstall.exe"

  Push "step: removing registry entries"
  Call un.WriteLog
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "${APP_KEY}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${PRODUCT_EXE}"

  ; ---- 用户数据策略：默认保留；仅显式确认时删除
  StrCpy $DATA_CHOICE "keep"
  ${IfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除本地记忆数据？$\r$\n$\r$\n${DATA_DIR}$\r$\n（库文件、日志、备份、桌面设置）$\r$\n$\r$\n默认保留（选择“否”保留数据，便于重装后恢复）。$\r$\n若你曾在设置/首次向导中改用自定义数据目录，请卸载后手动删除该目录。" /SD IDNO IDNO keep_data
      StrCpy $DATA_CHOICE "delete"
    keep_data:
  ${EndIf}

  ${If} $DATA_CHOICE == "delete"
    Push "step: deleting user data dir ${DATA_DIR} (user confirmed)"
    Call un.WriteLog
    RMDir /r "${DATA_DIR}"
  ${Else}
    Push "step: user data dir kept by policy: ${DATA_DIR}"
    Call un.WriteLog
  ${EndIf}

  Push "step: cleanup install dir"
  Call un.WriteLog
  RMDir "$INSTDIR"
  Push "step: uninstall completed"
  Call un.WriteLog
SectionEnd
