@echo off
rem FCA pnpm 运行时分派：优先项目 vendor\node\node.exe + DSH 随附 pnpm，
rem 用于插件打包等开发任务；运行时产品不依赖 pnpm。
setlocal
set "FCA_ROOT=%~dp0.."
set "DSH_DEPS=C:\\Users\\<user>\AppData\Local\Programs\DSH NEXT\resources\runtime\x64\primary-runtime\dependencies"
set "PNPM_MJS=%DSH_DEPS%\pnpm\bin\pnpm.mjs"
if exist "%FCA_ROOT%\vendor\node\node.exe" (
  set "NODE_EXE=%FCA_ROOT%\vendor\node\node.exe"
) else (
  set "NODE_EXE=%DSH_DEPS%\node\bin\node.exe"
)
if not exist "%NODE_EXE%" (
  echo [tools\pnpm.cmd] ERROR: 未找到 node.exe 1>&2
  exit /b 127
)
if not exist "%PNPM_MJS%" (
  echo [tools\pnpm.cmd] ERROR: 未找到 pnpm.mjs: %PNPM_MJS% 1>&2
  exit /b 127
)
"%NODE_EXE%" "%PNPM_MJS%" %*
exit /b %ERRORLEVEL%
