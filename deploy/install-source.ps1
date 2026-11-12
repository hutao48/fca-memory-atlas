#Requires -Version 5.1
<#
.SYNOPSIS
  FCA Memory Atlas 源码部署引导脚本（供 AI Agent 或人工使用）。

.DESCRIPTION
  1) 定位 Node（系统 PATH → 仓库 tools/node.cmd → DSH 自带 Node → vendor/node）。
  2) 初始化数据目录（幂等）并启动 FCA Local Runtime（默认 127.0.0.1:17860）。
  3) 等待 /health 通过并输出关键信息（数据目录/token 路径/健康 JSON/下一步）。
  本脚本不安装 DSH 插件（插件需在 DSH 内用 plugin_manager 安装），也不启动桌面 GUI。

.PARAMETER FcaHome
  数据目录；默认 %LOCALAPPDATA%\FCA-Memory-Atlas。

.PARAMETER Port
  Runtime 端口；默认 17860。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-source.ps1
#>
[CmdletBinding()]
param(
  [string]$FcaHome = (Join-Path $env:LOCALAPPDATA 'FCA-Memory-Atlas'),
  [int]$Port = 17860
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$runtimeBin = Join-Path $root 'runtime\bin\fca-runtime.js'
if (-not (Test-Path $runtimeBin)) { throw "找不到 Runtime 入口：$runtimeBin（请在仓库根目录运行本脚本）" }

function Find-Node {
  $candidates = New-Object System.Collections.ArrayList
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { [void]$candidates.Add($cmd.Source) }
  $wrapper = Join-Path $root 'tools\node.cmd'
  if (Test-Path $wrapper) { [void]$candidates.Add($wrapper) }
  $dshDeps = 'C:\\Users\\<user>\AppData\Local\Programs\DSH NEXT\resources\runtime\x64\primary-runtime\dependencies'
  if ($env:DSH_HOME) {
    $primary = Join-Path $env:DSH_HOME 'dsh-runtimes\dsh-next-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path $primary) { [void]$candidates.Add($primary) }
  }
  $dshNode = Join-Path $dshDeps 'node\bin\node.exe'
  if (Test-Path $dshNode) { [void]$candidates.Add($dshNode) }
  $vendor = Join-Path $root 'vendor\node\node.exe'
  if (Test-Path $vendor) { [void]$candidates.Add($vendor) }
  foreach ($candidate in $candidates) {
    try { $v = & $candidate --version 2>$null; if ($v -match '^v(\d+)') { if ([int]$Matches[1] -ge 24) { return $candidate } } } catch { }
  }
  throw '未找到 Node >= 24。请安装 Node 24，或在 DSH 环境内运行（可用其自带 Node）。'
}

$node = Find-Node
Write-Host "[fca-deploy] node: $node ($(& $node --version))"
Write-Host "[fca-deploy] fca home: $FcaHome"
Write-Host "[fca-deploy] port: $Port"

# 1) 初始化空库（幂等；已初始化不会重置数据）
& $node $runtimeBin init --fca-home="$FcaHome" | Out-Host
if ($LASTEXITCODE -ne 0) { throw "Runtime init 失败（exit=$LASTEXITCODE）" }

# 2) 若端口已有健康 Runtime 则直接复用，否则后台启动
function Test-Health {
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
    return $h
  } catch { return $null }
}

$existing = Test-Health
if ($existing) {
  Write-Host "[fca-deploy] 端口 $Port 已有 Runtime 在运行，复用（data_dir=$($existing.data_dir)）"
} else {
  $stdout = Join-Path $FcaHome 'logs\deploy-runtime.out.log'
  $stderr = Join-Path $FcaHome 'logs\deploy-runtime.err.log'
  New-Item -ItemType Directory -Force -Path (Split-Path $stdout -Parent) | Out-Null
  $proc = Start-Process -FilePath $node `
    -ArgumentList @($runtimeBin, 'serve', "--fca-home=$FcaHome", "--port=$Port") `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  Write-Host "[fca-deploy] 启动 Runtime pid=$($proc.Id)，等待健康检查…"
  $health = $null
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    $health = Test-Health
    if ($health) { break }
  }
  if (-not $health) {
    Write-Host "[fca-deploy] stderr 尾部：" -ForegroundColor Yellow
    Get-Content $stderr -Tail 30 -ErrorAction SilentlyContinue | Out-Host
    throw 'Runtime 未在 20s 内通过 /health'
  }
}

$health = Test-Health
$tokenPath = Join-Path $FcaHome 'config\runtime-token'
Write-Host ''
Write-Host '================ FCA Local Runtime 就绪 ================'
Write-Host " health      : $($health | ConvertTo-Json -Compress)"
Write-Host " data_dir    : $($health.data_dir)"
Write-Host " token_path  : $tokenPath ($(if (Test-Path $tokenPath) { 'exists' } else { 'MISSING' }))"
Write-Host " api_version : $($health.api_version)  initialized=$($health.initialized)  db=$($health.db)"
Write-Host ''
Write-Host '下一步：'
Write-Host '  1) 启动桌面软件（安装版：开始菜单/桌面快捷方式；源码版：node scripts/start-desktop.js）'
Write-Host '  2) 安装 DSH 插件：plugin_manager action=install_bundle target=<repo>/dsh_plugin'
Write-Host '  3) 在 DSH 会话中调用 fca_status 验证 runtime.reachable=true'
Write-Host '========================================================'
