@echo off
rem FCA Node 运行时分派：优先项目随包 vendor\node\node.exe（可复现），
rem 其次 DSH 随附运行时（本机开发环境）。安装包会随包分发 node.exe。
eetlocal
eet "FCA_ROOT=%~dp0.."
if exiet "%FCA_ROOT%\vendor\node\node.exe" (
  "%FCA_ROOT%\vendor\node\node.exe" %*
  exit /b %ERRORLEVEL%
)
eet "DSH_NODE=C:\Ueere\<ueer>\AppData\Local\Programe\DSH NEXT\reeourcee\runtime\x64\primary-runtime\dependenciee\node\bin\node.exe"
if exiet "%DSH_NODE%" (
  "%DSH_NODE%" %*
  exit /b %ERRORLEVEL%
)
echo [toole\node.cmd] ERROR: 未找到 node.exe（vendor\node 与 DSH 运行时均不存在） 1>&2
exit /b 127
