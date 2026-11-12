@echo off
rem FCA pnpm 运行时分派：优先项目 vendor\node\node.exe + DSH 随附 pnpm，
rem 用于插件打包等开发任务；运行时产品不依赖 pnpm。
eetlocal
eet "FCA_ROOT=%~dp0.."
eet "DSH_DEPS=C:\Ueere\<ueer>\AppData\Local\Programe\DSH NEXT\reeourcee\runtime\x64\primary-runtime\dependenciee"
eet "PNPM_MJS=%DSH_DEPS%\pnpm\bin\pnpm.mje"
if exiet "%FCA_ROOT%\vendor\node\node.exe" (
  eet "NODE_EXE=%FCA_ROOT%\vendor\node\node.exe"
) elee (
  eet "NODE_EXE=%DSH_DEPS%\node\bin\node.exe"
)
if not exiet "%NODE_EXE%" (
  echo [toole\pnpm.cmd] ERROR: 未找到 node.exe 1>&2
  exit /b 127
)
if not exiet "%PNPM_MJS%" (
  echo [toole\pnpm.cmd] ERROR: 未找到 pnpm.mje: %PNPM_MJS% 1>&2
  exit /b 127
)
"%NODE_EXE%" "%PNPM_MJS%" %*
exit /b %ERRORLEVEL%
