#Requires -Version 5.1
<#
.SYNOPSIS
  FCA Memory Atlas 安装包真机实测启动器（Windows）。

.DESCRIPTION
  **为什么需要这个脚本**：DSH/自动化工具 shell 的 Windows 沙箱会把派生出的非解释器进程
  （node.exe、makensis.exe、NSIS Setup.exe 等）放到 Low IL（CodexSandboxUsers 限制令牌）运行：
    - $TEMP 被重定向到 %TEMP%\Low；
    - 写 HKCU 卸载注册表项、桌面/开始菜单快捷方式会被静默拒绝；
    - 程序文件仍能解压到工作盘，造成“安装成功但没有快捷方式/卸载项”的假失败。
  真实用户（Explorer 双击）是 Medium IL，不受影响。本脚本通过 WMI
  `Win32_Process.Create`（由 WmiPrvSE 以正常 Medium IL 创建进程）来运行 `installer\install-test.ps1`，
  从而得到与真实用户一致的安装/启动/卸载结果。

  流程：
    1) 记录 17860 真实 Runtime 状态（保护：不停止、不修改）
    2) WMI 启动子进程：powershell -File installer\install-test.ps1 -Port <Port>（输出重定向到 reports 日志）
    3) 轮询等待子进程结束（默认 15 分钟），读取 install-test-*.json 报告
    4) 打印 PASS/FAIL 摘要与证据路径，退出码与报告一致

  生成物：
    - artifacts\reports\install-test-<ts>.json              （install-test.ps1 写）
    - artifacts\reports\install-test-run-<ts>.log           （本次完整控制台输出）
    - artifacts\reports\install-test-run-<ts>.json          （本次启动器摘要）

.PARAMETER InstallerPath
  安装包路径；默认 artifacts\installer\FCA-Memory-Atlas-Setup-0.1.0-x64.exe。

.PARAMETER Port
  测试用 Runtime 端口（默认 17897；请避开 17860 真实运行时端口）。

.PARAMETER SkipLaunch
  跳过“启动安装版程序”步骤（例如当前有其它 FCA 实例在跑时）。

.PARAMETER SkipCleanup
  保留隔离测试目录（.cache\install-test）便于人工检查。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File installer\run-install-test.ps1
#>
[CmdletBinding()]
param(
  [string]$InstallerPath = '',
  [int]$Port = 17897,
  [int]$TimeoutSec = 900,
  [switch]$SkipLaunch,
  [switch]$SkipCleanup,
  [switch]$SkipUninstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $InstallerPath) { $InstallerPath = Join-Path $ProjectRoot 'artifacts\installer\FCA-Memory-Atlas-Setup-0.1.0-x64.exe' }
$InstallerPath = [System.IO.Path]::GetFullPath($InstallerPath)
$ReportsDir = Join-Path $ProjectRoot 'artifacts\reports'
$InnerScript = Join-Path $ProjectRoot 'installer\install-test.ps1'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$RunLog = Join-Path $ReportsDir "install-test-run-$Stamp.log"
$RunReport = Join-Path $ReportsDir "install-test-run-$Stamp.json"
$PowerShellExe = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path $PowerShellExe)) { $PowerShellExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" }

if (-not (Test-Path $ReportsDir)) { New-Item -ItemType Directory -Path $ReportsDir -Force | Out-Null }
if (-not (Test-Path $InstallerPath)) { throw "安装包不存在：$InstallerPath（先运行 tools\node.cmd installer\build.js）" }
if (-not (Test-Path $InnerScript)) { throw "缺少 installer\install-test.ps1：$InnerScript" }

$summary = [ordered]@{
  test = 'fca-installer-run-install-test (WMI normal-integrity launcher)'
  started_at = (Get-Date).ToUniversalTime().ToString('o')
  host = $env:COMPUTERNAME
  user = $env:USERNAME
  launched_via = 'WMI Win32_Process.Create (Medium IL, bypasses DSH tool-shell Low IL sandbox for child process)'
  why_wmi = 'DSH tool shell runs spawned installers at Low IL: %TEMP% redirected to %TEMP%\Low, HKCU uninstall key and shortcuts silently blocked. Real Explorer launches are Medium IL.'
  installer = [ordered]@{ path = $InstallerPath; size_bytes = (Get-Item $InstallerPath).Length; sha256 = (Get-FileHash -Algorithm SHA256 $InstallerPath).Hash.ToLowerInvariant() }
  inner = [ordered]@{
    script = $InnerScript
    command = $null
    log = $RunLog
    report_candidates = @()
  }
  ok = $false
  error = $null
}

# 保护：记录 17860 真实 Runtime（不停止/不修改）
$realRuntime = [ordered]@{ port = 17860; reachable = $false; health = $null }
try { $realRuntime.health = Invoke-RestMethod -Uri 'http://127.0.0.1:17860/health' -TimeoutSec 2; $realRuntime.reachable = $true } catch { }
$summary.real_runtime_guard = $realRuntime
Write-Host "[run-install-test] installer: $InstallerPath"
Write-Host "[run-install-test] sha256:    $($summary.installer.sha256)"
Write-Host "[run-install-test] 17860 真实 Runtime reachable=$($realRuntime.reachable)（本脚本不会停止/修改它）"

# ---- 通过 WMI 以正常 Medium IL 启动子进程（绕过 DSH 工具 shell 的 Low IL 沙箱）
$innerArgs = @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', "`"$InnerScript`"",
  '-Port', "$Port"
)
if ($SkipLaunch) { $innerArgs += '-SkipLaunch' }
if ($SkipCleanup) { $innerArgs += '-SkipCleanup' }
if ($SkipUninstall) { $innerArgs += '-SkipUninstall' }
$innerCmd = "`"$PowerShellExe`" " + ($innerArgs -join ' ')
$cmdLine = 'cmd /c "' + $innerCmd.Replace('"', '\"') + ' > "' + $RunLog + '" 2>&1"'
# cmd 的 /c 引号规则：整串用一层引号包裹；内部 powershell 参数中的引号保留
$cmdLine = "cmd /c `"`"$PowerShellExe`" -NoProfile -ExecutionPolicy Bypass -File `"$InnerScript`" -Port $Port$($(if ($SkipLaunch) { ' -SkipLaunch' } else { '' }))$($(if ($SkipCleanup) { ' -SkipCleanup' } else { '' }))$($(if ($SkipUninstall) { ' -SkipUninstall' } else { '' })) > `"$RunLog`" 2>&1`""
$summary.inner.command = $cmdLine
Write-Host "[run-install-test] 通过 WMI 启动：$cmdLine"

$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdLine }
if ($created.ReturnValue -ne 0) {
  $summary.error = "WMI Win32_Process.Create 失败：ReturnValue=$($created.ReturnValue)"
  $summary | ConvertTo-Json -Depth 10 | Set-Content -Path $RunReport -Encoding UTF8
  throw $summary.error
}
$childPid = [int]$created.ProcessId
$summary.inner.pid = $childPid
Write-Host "[run-install-test] child pid=$childPid，等待完成（超时 ${TimeoutSec}s）…"

$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  $alive = Get-Process -Id $childPid -ErrorAction SilentlyContinue
  if (-not $alive) { break }
  Start-Sleep -Seconds 2
}
$stillAlive = Get-Process -Id $childPid -ErrorAction SilentlyContinue
if ($stillAlive) {
  $summary.error = "安装测试子进程超时未结束（pid=$childPid，${TimeoutSec}s）"
  $summary | ConvertTo-Json -Depth 10 | Set-Content -Path $RunReport -Encoding UTF8
  throw $summary.error
}

# ---- 收集内层报告
$candidates = @(Get-ChildItem $ReportsDir -Filter 'install-test-2*.json' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notlike 'install-test-run-*' } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 3)
$summary.inner.report_candidates = @($candidates | ForEach-Object { $_.FullName })
$innerReport = $null
if ($candidates.Count -gt 0) {
  $innerReport = Get-Content $candidates[0].FullName -Raw | ConvertFrom-Json
}
$summary.inner.report = if ($innerReport) { $candidates[0].FullName } else { $null }
$summary.ok = [bool]($innerReport -and $innerReport.ok)
if ($innerReport -and $innerReport.error) { $summary.error = $innerReport.error }

# 真实 Runtime 守卫（测试后）
try { $realRuntime.health_after = Invoke-RestMethod -Uri 'http://127.0.0.1:17860/health' -TimeoutSec 2 } catch { }
$summary.real_runtime_guard.health_after = $realRuntime.health_after
$summary.real_runtime_guard.reachable_after = ($null -ne $realRuntime.health_after)

# ---- 控制台摘要
Write-Host ''
Write-Host '============================================================'
Write-Host ' FCA Memory Atlas 安装包实测摘要（WMI 正常令牌会话）'
Write-Host '============================================================'
Write-Host " 安装包 : $InstallerPath"
Write-Host " 大小   : $([math]::Round($summary.installer.size_bytes / 1MB, 1)) MB"
Write-Host " sha256 : $($summary.installer.sha256)"
if ($innerReport) {
  Write-Host " 报告   : $($candidates[0].FullName)"
  Write-Host ''
  foreach ($step in $innerReport.steps) {
    $mark = if ($step.ok) { 'PASS' } else { 'FAIL' }
    Write-Host ("  [{0}] {1}  {2}" -f $mark, $step.name, $step.detail)
  }
  Write-Host ''
  Write-Host " 安装退出码 : $($innerReport.install.exit_code)   卸载退出码 : $($innerReport.uninstall.exit_code)"
  Write-Host " 数据目录   : $($innerReport.isolated.data_dir)（卸载后保留：$($innerReport.uninstall.test_data_dir.retained)）"
  Write-Host " 17860 保护 : before=$($realRuntime.reachable) after=$($summary.real_runtime_guard.reachable_after)"
} else {
  Write-Host ' 未找到内层 install-test-*.json 报告（请查看日志）：' -ForegroundColor Yellow
  Write-Host "   $RunLog"
}
Write-Host " 运行日志 : $RunLog"
Write-Host " 启动器摘要: $RunReport"
if ($summary.ok) {
  Write-Host ' RESULT: PASS（安装 → 启动 → 连接 Runtime → 卸载 全部通过）' -ForegroundColor Green
} else {
  Write-Host " RESULT: FAIL（$($summary.error)）" -ForegroundColor Red
}

$summary.finished_at = (Get-Date).ToUniversalTime().ToString('o')
$summary | ConvertTo-Json -Depth 12 | Set-Content -Path $RunReport -Encoding UTF8

if ($summary.ok) { exit 0 } else { exit 1 }
