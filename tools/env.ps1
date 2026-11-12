# FCA 开发环境变量（PowerShell）：. .\tools\env.ps1
# 定位 Node 24 / pnpm。优先项目 vendor\node\node.exe（可复现），其次 DSH 随附运行时。
$fcaRoot = Split-Path $PSScriptRoot -Parent
$vendorNode = Join-Path $fcaRoot 'vendor\node\node.exe'
$dshDeps = 'C:\\Users\\<user>\AppData\Local\Programs\DSH NEXT\resources\runtime\x64\primary-runtime\dependencies'
$dshNode = Join-Path $dshDeps 'node\bin\node.exe'

if (Test-Path $vendorNode) {
  $env:FCA_NODE = $vendorNode
} elseif (Test-Path $dshNode) {
  $env:FCA_NODE = $dshNode
} else {
  throw "未找到 node.exe（vendor\node 与 DSH 运行时均不存在）"
}

$pnpmMjs = Join-Path $dshDeps 'pnpm\bin\pnpm.mjs'
if (Test-Path $pnpmMjs) { $env:FCA_PNPM = $pnpmMjs } else { $env:FCA_PNPM = '' }

$nodeDir = Split-Path $env:FCA_NODE
$env:PATH = $nodeDir + ';' + $env:PATH
Write-Host "FCA_NODE=$env:FCA_NODE"
Write-Host "FCA_PNPM=$env:FCA_PNPM"
