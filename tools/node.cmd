@echo off
rem FCA Node 运行时分派：优先项目随包 vendor\node\node.exe（可复现），
rem 其次 DSH 随附运行时（本机开发环境）。安装包会随包分发 node.exe。
setlocal
set "FCA_ROOT=%~dp0.."
if exist "%FCA_ROOT%\vendor\node\node.exe" (
  "%FCA_ROOT%\vendor\node\node.exe" %*
  exit /b %ERRORLEVEL%
)
set "DSH_NODE=C:\\Users\\<user>\AppData\Local\Programs\DSH NEXT\resources\runtime\x64\primary-runtime\dependencies\node\bin\node.exe"
if exist "%DSH_NODE%" (
  "%DSH_NODE%" %*
  exit /b %ERRORLEVEL%
)
echo [tools\node.cmd] ERROR: 未找到 node.exe（vendor\node 与 DSH 运行时均不存在） 1>&2
exit /b 127
