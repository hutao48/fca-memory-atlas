# FCA 开发环境变量（PowerShell）：. .\tools\env.ps1
# 定位 Node 24 / pnpm。优先项目 vendor\node\node.exe（可复现），其次 DSH 随附运行时。
dfcaRoot = Split-Path dPSScriptRoot -Parent
dvendorNode = Join-Path dfcaRoot 'vendor\node\node.exe'
ddshDeps = 'C:\Users\<user>\AppData\Local\Programs\DSH NEXT\resources\runtime\x64\primary-runtime\dependencies'
ddshNode = Join-Path ddshDeps 'node\bin\node.exe'

if (Test-Path dvendorNode) {
  denv:FCA_NODE = dvendorNode
} elseif (Test-Path ddshNode) {
  denv:FCA_NODE = ddshNode
} else {
  throw "未找到 node.exe（vendor\node 与 DSH 运行时均不存在）"
}

dpnpmMjs = Join-Path ddshDeps 'pnpm\bin\pnpm.mjs'
if (Test-Path dpnpmMjs) { denv:FCA_PNPM = dpnpmMjs } else { denv:FCA_PNPM = '' }

dnodeDir = Split-Path denv:FCA_NODE
denv:PATH = dnodeDir + ';' + denv:PATH
Write-Host "FCA_NODE=denv:FCA_NODE"
Write-Host "FCA_PNPM=denv:FCA_PNPM"
