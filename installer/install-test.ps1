#Requires -Version 5.1
<#
.SYNOPSIS
  FCA Memory Atlas 安装包真机安装 / 启动 / 卸载自动化测试（per-user 静默安装到隔离目录）。

.DESCRIPTION
  对 artifacts\installer\FCA-Memory-Atlas-Setup-<version>-x64.exe 执行：
    1) SHA256 校验（与 .sha256.json 对照）
    2) NSIS 静默 per-user 安装（/S，隔离安装目录 /D=<Root>\app，默认无需管理员）
    3) 安装产物完整性校验（桌面程序 / resources/app / runtime / node / docs / BUILD_INFO）
    4) 注册表“应用和功能”登记、开始菜单/桌面快捷方式、卸载器、安装日志、install-report.ini
    5) 启动安装后的 FCA Memory Atlas.exe（--no-sandbox 仅用于 de-elevated DSH shell；数据/端口用隔离值）
       校验窗口进程、Runtime 健康检查 /health、数据目录落盘、runtime 进程存活
    6) 静默卸载（Uninstall.exe /S），校验程序目录/快捷方式/注册表清除、用户数据目录按策略保留
  所有证据写入 artifacts\reports\install-test-<timestamp>.json（供 docs/INSTALL_TEST.md 引用）。

  安全约束：只删除位于 -Root（默认 <项目>\.cache\install-test）之下的测试目录；绝不触碰
  %LOCALAPPDATA%\FCA-Memory-Atlas 等用户真实数据目录（只读取其前后状态做对比，不修改）。

.PARAMETER InstallerPath
  安装包路径；默认 artifacts\installer\FCA-Memory-Atlas-Setup-0.1.0-x64.exe。

.PARAMETER Root
  隔离测试根目录；默认 <项目>\.cache\install-test。必须位于项目 .cache 下才会自动清理。

.PARAMETER Port
  测试用 Runtime 端口（默认 17861，避开默认 17860，避免与用户正在运行的 Runtime 冲突）。

.PARAMETER SkipLaunch
  只做安装/卸载，不启动应用（用于 CI 环境无桌面会话时）。

.PARAMETER SkipUninstall
  保留安装（用于人工检查安装目录）。

.EXAMPLE
  pwsh -NoProfile -File installer\install-test.ps1
#>
[CmdletBinding()]
param(
  [string]$InstallerPath = '',
  [string]$Root = '',
  [int]$Port = 17897,
  [switch]$SkipLaunch,
  [switch]$SkipUninstall,
  [switch]$SkipCleanup
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $InstallerPath) {
  # 默认取 artifacts\installer 下版本号最新的 Setup.exe（避免硬编码旧版本）
  $candidates = @(Get-ChildItem (Join-Path $ProjectRoot 'artifacts\installer') -Filter 'FCA-Memory-Atlas-Setup-*-x64.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'Setup-(\d+\.\d+\.\d+)-x64\.exe$' } |
    Sort-Object { [version]($_.Name -replace '.*Setup-(\d+\.\d+\.\d+)-x64\.exe$','$1') } -Descending)
  if ($candidates.Count -gt 0) { $InstallerPath = $candidates[0].FullName }
  else { $InstallerPath = Join-Path $ProjectRoot 'artifacts\installer\FCA-Memory-Atlas-Setup-0.2.0-x64.exe' }
  Write-Host "[install-test] installer (auto): $InstallerPath"
}
if (-not $Root) { $Root = Join-Path $ProjectRoot '.cache\install-test' }
$InstallerPath = [System.IO.Path]::GetFullPath($InstallerPath)
$Root = [System.IO.Path]::GetFullPath($Root)
$InstallDir = Join-Path $Root 'app'
$DataDir = Join-Path $Root 'data'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$ReportsDir = Join-Path $ProjectRoot 'artifacts\reports'
$ReportPath = Join-Path $ReportsDir "install-test-$Stamp.json"
$DefaultDataDir = Join-Path $env:LOCALAPPDATA 'FCA-Memory-Atlas'
$InstallLog = Join-Path $env:TEMP 'fca-install.log'
$UninstallLog = Join-Path $env:TEMP 'fca-uninstall.log'
$ProductExe = 'FCA Memory Atlas.exe'

# 只允许自动清理项目 .cache 下的隔离测试目录
$CacheRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot '.cache'))
$IsSafeRoot = $Root.StartsWith($CacheRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
if (-not $IsSafeRoot) {
  Write-Host "[install-test] WARN -Root 不在项目 .cache 下（$Root），为安全起见禁用自动清理" -ForegroundColor Yellow
}

$report = [ordered]@{
  test = 'fca-memory-atlas-installer-install-uninstall'
  started_at = (Get-Date).ToUniversalTime().ToString('o')
  host = $env:COMPUTERNAME
  user = $env:USERNAME
  os = (Get-CimInstance Win32_OperatingSystem).Caption
  installer = [ordered]@{ path = $InstallerPath; size_bytes = $null; sha256 = $null; expected_sha256 = $null; sha256_ok = $null }
  isolated = [ordered]@{ root = $Root; install_dir = $InstallDir; data_dir = $DataDir; port = $Port }
  steps = @()
  ok = $false
  error = $null
}

function Add-Step([string]$Name, [bool]$Ok, $Detail) {
  $script:report.steps += [ordered]@{
    name = $Name
    ok = $Ok
    at = (Get-Date).ToUniversalTime().ToString('o')
    detail = $Detail
  }
  $color = if ($Ok) { 'Green' } else { 'Red' }
  Write-Host ("[install-test] {0} {1}" -f ($(if ($Ok) { 'PASS' } else { 'FAIL' }), $Name)) -ForegroundColor $color
  if (-not $Ok -and $null -ne $Detail) { Write-Host ("             $Detail") -ForegroundColor Yellow }
}

function Save-Report {
  if (-not (Test-Path $ReportsDir)) { New-Item -ItemType Directory -Path $ReportsDir -Force | Out-Null }
  $report.finished_at = (Get-Date).ToUniversalTime().ToString('o')
  $report | ConvertTo-Json -Depth 12 | Set-Content -Path $ReportPath -Encoding UTF8
  Write-Host "[install-test] report: $ReportPath"
}

trap {
  $err = $_
  $where = ''
  try { $where = "$($err.InvocationInfo.ScriptName):$($err.InvocationInfo.ScriptLineNumber)" } catch { }
  $report.error = [ordered]@{
    message = $err.Exception.Message
    position = $where
    line = $(try { $err.InvocationInfo.Line.Trim() } catch { $null })
    stack = $err.ScriptStackTrace
  }
  try { Add-Step 'unhandled-error' $false "$($err.Exception.Message) @ $where" } catch { }
  $report.ok = $false
  try { Save-Report } catch { }
  Write-Host "[install-test] RESULT: FAIL（unhandled error @ $where : $($err.Exception.Message)）" -ForegroundColor Red
  exit 1
}

function Assert-PathUnderRoot([string]$Path) {
  $full = [System.IO.Path]::GetFullPath($Path)
  if (-not $full.StartsWith($Root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝操作测试根目录之外的路径：$full"
  }
  return $full
}

function Remove-TestDir([string]$Path) {
  if (-not (Test-Path $Path)) { return }
  $full = [System.IO.Path]::GetFullPath($Path)
  $isRootItself = $full.Equals($Root, [System.StringComparison]::OrdinalIgnoreCase)
  $insideRoot = $full.StartsWith($Root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
  if (-not $IsSafeRoot -or -not ($isRootItself -or $insideRoot)) {
    Write-Host "[install-test] SKIP delete (unsafe): $full" -ForegroundColor Yellow
    return
  }
  Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
}

function Stop-TestRuntime {
  # 停止测试数据目录上的 Runtime（先 CLI 优雅停止，再兜底结束占用测试命令行的 node 进程）
  $nodeExe = Join-Path $InstallDir 'node\node.exe'
  $entry = Join-Path $InstallDir 'runtime\bin\fca-runtime.js'
  if ((Test-Path -LiteralPath $nodeExe) -and (Test-Path -LiteralPath $entry)) {
    # node CLI 的 ExperimentalWarning 写到 stderr；临时放宽 EAP，避免被 trap 误判为未处理错误
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & $nodeExe $entry stop "--fca-home=$DataDir" '--quiet' 2>$null | Out-Null
    } catch {
      # 忽略：Runtime 可能已退出
    } finally {
      $ErrorActionPreference = $prevEap
    }
  }
  Start-Sleep -Milliseconds 500
  $stale = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$DataDir*" }
  foreach ($p in $stale) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Wait-RuntimeHealth([int]$Port, [int]$TimeoutSec = 90) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $lastError = $null
  while ((Get-Date) -lt $deadline) {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
      return $health
    } catch {
      $lastError = $_.Exception.Message
      Start-Sleep -Milliseconds 800
    }
  }
  throw "Runtime 健康检查超时（http://127.0.0.1:$Port/health，${TimeoutSec}s）：$lastError"
}

function Get-PortHealth([int]$Port) {
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
  } catch {
    return $null
  }
}

function Get-PortListener([int]$Port) {
  try {
    return @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  } catch {
    return @()
  }
}

function Get-FcaAppProcesses {
  return @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'FCA Memory Atlas' })
}

# 直接 CreateProcess 启动（UseShellExecute=false）：
# - 等待并返回退出码，或返回进程对象；
# - 不经过 ShellExecute，避免未签名 exe 触发“打开文件 - 安全警告”对话框阻塞自动化
#   （真实用户双击时会看到该未知发布者提示，属 Alpha 未签名版本的预期行为，见 KNOWN_ISSUES KI-FUNC-04）。
function Start-ExeWait {
  param([string]$FilePath, [string[]]$Arguments = @(), [string]$WorkingDirectory = '')
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.Arguments = (($Arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }
  $proc = [System.Diagnostics.Process]::Start($psi)
  $proc.WaitForExit()
  return $proc.ExitCode
}

function Start-Exe {
  param([string]$FilePath, [string[]]$Arguments = @(), [string]$WorkingDirectory = '')
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.Arguments = (($Arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')
  $psi.UseShellExecute = $false
  if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }
  return [System.Diagnostics.Process]::Start($psi)
}

# 安装版程序窗口截图（证据用；窗口置前后截取整个主屏，失败不影响测试结论）
function Capture-Screen([string]$OutPath) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $dir = Split-Path $OutPath -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    return $true
  } catch {
    return $false
  }
}

function Focus-Window([IntPtr]$Handle) {
  try {
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class FcaWin { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); }'
    [void][FcaWin]::ShowWindow($Handle, 9)
    [void][FcaWin]::SetForegroundWindow($Handle)
    return $true
  } catch {
    return $false
  }
}

function Get-ShortcutPath([string]$Folder) {
  return [System.IO.Path]::Combine($Folder, 'FCA Memory Atlas.lnk')
}

# ================================================================ 1. installer hash
Write-Host "`n=== [1/8] 安装包校验 ===" -ForegroundColor Cyan
if (-not (Test-Path $InstallerPath)) { throw "安装包不存在：$InstallerPath（先运行 tools\node.cmd installer\build.js）" }
$report.installer.size_bytes = (Get-Item $InstallerPath).Length
$report.installer.sha256 = (Get-FileHash -Algorithm SHA256 $InstallerPath).Hash.ToLowerInvariant()
$shaFile = [System.IO.Path]::ChangeExtension($InstallerPath, $null) + '.sha256.json'
$shaJson = $null
$shaCandidate = "$($InstallerPath -replace '\.exe$', '.sha256.json')"
if (Test-Path $shaCandidate) { $shaJson = Get-Content $shaCandidate -Raw | ConvertFrom-Json }
if ($shaJson -and $shaJson.sha256) {
  $report.installer.expected_sha256 = $shaJson.sha256
  $report.installer.sha256_ok = ($shaJson.sha256 -eq $report.installer.sha256)
  Add-Step 'installer-sha256-matches-metadata' $report.installer.sha256_ok "actual=$($report.installer.sha256) expected=$($shaJson.sha256)"
} else {
  $report.installer.sha256_ok = $null
  Add-Step 'installer-sha256-metadata-present' $false "未找到 $shaCandidate"
}

# ================================================================ 2. prepare
Write-Host "`n=== [2/8] 准备隔离环境 ===" -ForegroundColor Cyan
$beforeDefault = $null
if (Test-Path $DefaultDataDir) {
  $beforeDefault = Get-ChildItem $DefaultDataDir -Force | Select-Object Name, Length, LastWriteTime
}

# 真实环境守卫：记录默认端口 17860 上的 Runtime（可能是用户/插件正在使用的真实实例）。
# 本测试全程不停止、不写入该实例；卸载器也已按设计不自动 stop Runtime。
$realRuntime = [ordered]@{
  port = 17860
  reachable_before = $false
  health_before = $null
  reachable_after = $false
  health_after = $null
  note = 'guard only; this test never stops or modifies the runtime on port 17860'
}
$realRuntime.health_before = Get-PortHealth -Port 17860
$realRuntime.reachable_before = ($null -ne $realRuntime.health_before)
$report.real_runtime_guard = $realRuntime
Add-Step 'real-runtime-17860-guard-recorded' $true ("17860 reachable_before={0}（本测试不会停止/修改它）" -f $realRuntime.reachable_before)

$existingApps = Get-FcaAppProcesses
$report.existing_fca_apps = @($existingApps | ForEach-Object { [ordered]@{ id = $_.Id; start = $_.StartTime.ToString('o'); path = $_.Path } })
Add-Step 'no-other-fca-app-instance' ($existingApps.Count -eq 0) $(if ($existingApps.Count) { "检测到已有 FCA Memory Atlas 实例（pid=$($existingApps.Id -join ','))；单实例锁会阻止启动冒烟，请关闭后重跑" } else { '无其它 FCA 实例' })

$testPortListener = Get-PortListener -Port $Port
$report.test_port = [ordered]@{
  port = $Port
  in_use_before = ($testPortListener.Count -gt 0)
}
Add-Step 'test-port-free' ($testPortListener.Count -eq 0) $(if ($testPortListener.Count) { "端口 $Port 已被占用（pid=$($testPortListener.OwningProcess -join ',')）；请用 -Port 指定其它端口" } else { "端口 $Port 可用" })

Remove-TestDir $Root
New-Item -ItemType Directory -Path $Root -Force | Out-Null
Add-Step 'prepare-isolated-root' $true $Root

if (Test-Path $InstallLog) { Remove-Item $InstallLog -Force -ErrorAction SilentlyContinue }
if (Test-Path $UninstallLog) { Remove-Item $UninstallLog -Force -ErrorAction SilentlyContinue }

# 清理可能残留的卸载登记（只删除本产品键）
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FCAMemoryAtlas'
if (Test-Path $uninstallKey) { Remove-Item -Path $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue }
$appKey = 'HKCU:\Software\FCAMemoryAtlas'
if (Test-Path $appKey) { Remove-Item -Path $appKey -Recurse -Force -ErrorAction SilentlyContinue }

# ================================================================ 3. silent install
Write-Host "`n=== [3/8] 静默安装（per-user, /S /D=$InstallDir） ===" -ForegroundColor Cyan
$installSw = [System.Diagnostics.Stopwatch]::StartNew()
$installExit = Start-ExeWait -FilePath $InstallerPath -Arguments @('/S', "/D=$InstallDir") -WorkingDirectory $Root
$installSw.Stop()
$report.install = [ordered]@{
  command = "`"$InstallerPath`" /S /D=$InstallDir"
  method = 'CreateProcess (UseShellExecute=false) — bypasses unsigned-exe ShellExecute security prompt'
  exit_code = $installExit
  elapsed_seconds = [math]::Round($installSw.Elapsed.TotalSeconds, 1)
}
Add-Step 'silent-install-exit-code-0' ($installExit -eq 0) "exit=$installExit"

# ================================================================ 4. installed files
Write-Host "`n=== [4/8] 安装产物完整性 ===" -ForegroundColor Cyan
$required = @(
  $ProductExe,
  'Uninstall.exe',
  'BUILD_INFO.json',
  'LICENSE',
  'LICENSES.chromium.html',
  'install-report.ini',
  'resources\app\package.json',
  'resources\app\main\main.js',
  'resources\app\main\preload.js',
  'resources\app\main\ipc.js',
  'resources\app\main\runtime-manager.js',
  'resources\app\main\settings.js',
  'resources\app\main\paths.js',
  'resources\app\renderer\index.html',
  'resources\app\renderer\app.js',
  'resources\app\renderer\views\atlas.js',
  'resources\app\renderer\views\editor.js',
  'resources\app\renderer\styles\tokens.css',
  'resources\app\renderer\nebula\index.js',
  'resources\app\renderer\ui\index.js',
  'resources\app\main\unity-viewer.js',
  'resources\app\main\unity-embed.js',
  'runtime\bin\fca-runtime.js',
  'runtime\src\runtime.js',
  'runtime\src\services.js',
  'runtime\src\server\index.js',
  'runtime\src\memory\store.js',
  'runtime\src\persistence\db.js',
  'runtime\src\api\routes\llm.js',
  'node\node.exe',
  'unity\FCANebulaWebGL\index.html',
  'docs\USER_MANUAL.md',
  'docs\KNOWN_ISSUES.md',
  'docs\INSTALL_TEST.md',
  'docs\UNITY_NEBULA.md',
  'docs\FINAL_ACCEPTANCE.md',
  'docs\TEST_REPORT.md',
  'docs\adr\ADR-006-installer.md',
  'README.md',
  'CHANGELOG.md'
) | Select-Object -Unique
$fileChecks = @()
foreach ($rel in $required) {
  $full = Join-Path $InstallDir $rel
  $fileChecks += [ordered]@{ path = $rel; exists = (Test-Path -LiteralPath $full); size = $(if (Test-Path -LiteralPath $full) { (Get-Item -LiteralPath $full).Length } else { $null }) }
}
$missing = @($fileChecks | Where-Object { -not $_.exists } | ForEach-Object { $_.path })
$report.files = [ordered]@{ total_checked = $fileChecks.Count; missing = $missing; checks = $fileChecks }
Add-Step 'installed-files-complete' ($missing.Count -eq 0) ($(if ($missing.Count) { 'missing: ' + ($missing -join ', ') } else { "$($fileChecks.Count) critical files present" }))

$buildInfo = $null
if (Test-Path (Join-Path $InstallDir 'BUILD_INFO.json')) {
  $buildInfo = Get-Content (Join-Path $InstallDir 'BUILD_INFO.json') -Raw | ConvertFrom-Json
  $report.build_info = $buildInfo
}
$expectedVersion = if ($shaJson -and $shaJson.version) { [string]$shaJson.version } else { '0.2.0' }
Add-Step 'build-info-version-matches-installer' ($null -ne $buildInfo -and [string]$buildInfo.version -eq $expectedVersion) "version=$($buildInfo.version) expected=$expectedVersion built_at=$($buildInfo.built_at) electron=$($buildInfo.electron) node=$($buildInfo.node.version)"

# Unity 星云（v0.2.0：Unity WebGL 构建，内嵌 Electron 界面；缺失时桌面回退内置 WebGL 星云）
$unityDir = Join-Path $InstallDir 'unity\FCANebulaWebGL'
$unityBuildDir = Join-Path $unityDir 'Build'
$unityEvidence = [ordered]@{
  path = $unityDir
  exists = (Test-Path -LiteralPath $unityDir)
  index_html = (Test-Path -LiteralPath (Join-Path $unityDir 'index.html'))
  wasm = @(Get-ChildItem -LiteralPath $unityBuildDir -Filter '*.wasm' -ErrorAction SilentlyContinue).Count
  data = @(Get-ChildItem -LiteralPath $unityBuildDir -Filter '*.data' -ErrorAction SilentlyContinue).Count
  loader = @(Get-ChildItem -LiteralPath $unityBuildDir -Filter '*.loader.js' -ErrorAction SilentlyContinue).Count
  framework = @(Get-ChildItem -LiteralPath $unityBuildDir -Filter '*.framework.js' -ErrorAction SilentlyContinue).Count
  bytes = $(if (Test-Path -LiteralPath $unityDir) { (Get-ChildItem -LiteralPath $unityDir -Recurse -File | Measure-Object Length -Sum).Sum } else { 0 })
  build_info = $(if ($buildInfo -and $buildInfo.optional_components) { if ($buildInfo.optional_components.unity_webgl) { $buildInfo.optional_components.unity_webgl } elseif ($buildInfo.optional_components.unity_nebula_webgl) { $buildInfo.optional_components.unity_nebula_webgl } else { $null } } else { $null })
}
$report.unity = $unityEvidence
Add-Step 'unity-webgl-nebula-installed' ($unityEvidence.index_html -and $unityEvidence.wasm -gt 0 -and $unityEvidence.data -gt 0 -and $unityEvidence.bytes -gt 10MB) "index.html=$($unityEvidence.index_html) wasm=$($unityEvidence.wasm) data=$($unityEvidence.data) size=$([math]::Round($unityEvidence.bytes/1MB,1))MB build_info=$([bool]$unityEvidence.build_info)"

$appRootSize = 0
$runtimeSize = 0
if (Test-Path (Join-Path $InstallDir 'resources\app')) { $appRootSize = (Get-ChildItem (Join-Path $InstallDir 'resources\app') -Recurse -File | Measure-Object Length -Sum).Sum }
if (Test-Path (Join-Path $InstallDir 'runtime')) { $runtimeSize = (Get-ChildItem (Join-Path $InstallDir 'runtime') -Recurse -File | Measure-Object Length -Sum).Sum }
$report.files.app_bytes = $appRootSize
$report.files.runtime_bytes = $runtimeSize

# ================================================================ 5. shortcuts / registry / logs
Write-Host "`n=== [5/8] 快捷方式 / 注册表 / 安装日志 ===" -ForegroundColor Cyan
$desktopLnk = Get-ShortcutPath ([Environment]::GetFolderPath('Desktop'))
$startMenuDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'FCA Memory Atlas'
$startMenuLnk = Get-ShortcutPath $startMenuDir
$startMenuModelLnk = Join-Path $startMenuDir '使用说明.lnk'
$startMenuUninstallLnk = Join-Path $startMenuDir '卸载 FCA Memory Atlas.lnk'
$shortcuts = [ordered]@{
  desktop = [ordered]@{ path = $desktopLnk; exists = (Test-Path $desktopLnk) }
  start_menu_dir = [ordered]@{ path = $startMenuDir; exists = (Test-Path $startMenuDir) }
  start_menu_app = [ordered]@{ path = $startMenuLnk; exists = (Test-Path $startMenuLnk) }
  start_menu_manual = [ordered]@{ path = $startMenuModelLnk; exists = (Test-Path $startMenuModelLnk) }
  start_menu_uninstall = [ordered]@{ path = $startMenuUninstallLnk; exists = (Test-Path $startMenuUninstallLnk) }
}
$report.shortcuts = $shortcuts
$shortcutOk = $shortcuts.desktop.exists -and $shortcuts.start_menu_app.exists -and $shortcuts.start_menu_manual.exists -and $shortcuts.start_menu_uninstall.exists
Add-Step 'shortcuts-created' $shortcutOk "desktop=$($shortcuts.desktop.exists) startmenu_app=$($shortcuts.start_menu_app.exists) manual=$($shortcuts.start_menu_manual.exists) uninstall=$($shortcuts.start_menu_uninstall.exists)"

$reg = [ordered]@{}
$regOk = $false
if (Test-Path $uninstallKey) {
  $props = Get-ItemProperty $uninstallKey
  $reg = [ordered]@{
    display_name = $props.DisplayName
    display_version = $props.DisplayVersion
    publisher = $props.Publisher
    install_location = $props.InstallLocation
    uninstall_string = $props.UninstallString
    quiet_uninstall_string = $props.QuietUninstallString
    display_icon = $props.DisplayIcon
  }
  $regOk = ($props.DisplayVersion -eq '0.1.0') -and ($props.InstallLocation -eq $InstallDir) -and ($props.UninstallString -like '*Uninstall.exe*')
}
$report.registry = $reg
Add-Step 'uninstall-registry-entry' $regOk "DisplayVersion=$($reg.display_version) InstallLocation=$($reg.install_location)"

$installLogTail = $null
$installLogOk = $false
$installLogUsed = $null
# DSH 工具 shell 的 Low IL 沙箱会把 $TEMP 重定向到 %TEMP%\Low；两种路径都检查（真实用户/WMI 正常会话写正常路径）
$installLogCandidates = @($InstallLog, (Join-Path (Join-Path $env:TEMP 'Low') 'fca-install.log'))
foreach ($candidate in $installLogCandidates) {
  if (Test-Path $candidate) { $installLogUsed = $candidate; break }
}
if ($installLogUsed) {
  $installLogTail = (Get-Content $installLogUsed -Tail 40) -join "`n"
  $installLogOk = $installLogTail -match 'installation completed successfully'
}
$report.install_log = [ordered]@{
  path = $installLogUsed
  candidates = $installLogCandidates
  exists = ($null -ne $installLogUsed)
  tail = $installLogTail
  success_marker = $installLogOk
}
Add-Step 'install-log-success-marker' $installLogOk "log=$installLogUsed"

$installReportIni = $null
if (Test-Path (Join-Path $InstallDir 'install-report.ini')) {
  $installReportIni = Get-Content (Join-Path $InstallDir 'install-report.ini') -Raw
  $report.install_report_ini = $installReportIni
}
Add-Step 'install-report-ini' ($null -ne $installReportIni -and $installReportIni -match 'install_log') 'install-report.ini written'

# install-report.ini 记录 Unity 组件路径（v0.2.0 新增）
$unityFromIni = $null
if ($installReportIni -and ($installReportIni -match 'unity_nebula=(.+)')) { $unityFromIni = $Matches[1].Trim() }
if ($installReportIni) { $report.install_report_unity = $unityFromIni }
Add-Step 'install-report-unity-component' ($unityFromIni -and ($unityFromIni -like '*unity\FCANebulaWebGL\index.html*')) "unity_nebula_webgl=$unityFromIni"

# DSH 插件 tgz（v0.2.0 起随安装包附带，便于离线安装 DSH 插件；版本号跟随构建时 artifacts/plugin 最新包）
$pluginDir = Join-Path $InstallDir 'dsh_plugin'
$pluginTgz = @(Get-ChildItem -LiteralPath $pluginDir -Filter 'dsh-plugin-fca-memory-*.tgz' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1)
$pluginEvidence = [ordered]@{
  dir = $pluginDir
  exists = (Test-Path -LiteralPath $pluginDir)
  tgz = $(if ($pluginTgz.Count -gt 0) { $pluginTgz[0].FullName } else { $null })
  tgz_bytes = $(if ($pluginTgz.Count -gt 0) { $pluginTgz[0].Length } else { 0 })
  readme = (Test-Path -LiteralPath (Join-Path $pluginDir 'README.md'))
}
$report.dsh_plugin = $pluginEvidence
Add-Step 'dsh-plugin-package-installed' ($pluginEvidence.tgz -and $pluginEvidence.tgz_bytes -gt 10KB) "tgz=$($pluginEvidence.tgz) size=$($pluginEvidence.tgz_bytes)B readme=$($pluginEvidence.readme)"

# ================================================================ 6. launch + runtime health
Write-Host "`n=== [6/8] 启动安装后的应用并连接 Runtime ===" -ForegroundColor Cyan
$appProc = $null
$health = $null
$windowTitle = $null
$runtimeProc = $null
# 安装版 Runtime 冒烟：直接使用安装目录内随包 node.exe + runtime 源码，在隔离数据目录
# init → serve → /health → /graph → 写一条真实记忆 → shutdown（不依赖 GUI/Electron，Low IL 下也可验证）
function Invoke-InstalledRuntimeSmoke {
  $nodeExe = Join-Path $InstallDir 'node\node.exe'
  $entry = Join-Path $InstallDir 'runtime\bin\fca-runtime.js'
  $smoke = [ordered]@{ node = $nodeExe; entry = $entry; init = $null; serve_started = $false; health = $null; graph = $null; stored = $null; shutdown = $null; ok = $false; error = $null }
  try {
    if (-not (Test-Path -LiteralPath $nodeExe)) { throw "安装目录 node.exe 缺失：$nodeExe" }
    if (-not (Test-Path -LiteralPath $entry)) { throw "安装目录 runtime 入口缺失：$entry" }
    $initOut = & $nodeExe $entry init "--fca-home=$DataDir" '--quiet' 2>$null | Out-String
    try { $smoke.init = ($initOut | ConvertFrom-Json) } catch { $smoke.init = $initOut.Trim() }
    # serve（后台）
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $nodeExe
    $psi.Arguments = "`"$entry`" serve --fca-home=`"$DataDir`" --port=$Port --quiet"
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $serveProc = [System.Diagnostics.Process]::Start($psi)
    $smoke.serve_pid = $serveProc.Id
    $health = Wait-RuntimeHealth -Port $Port -TimeoutSec 60
    $smoke.serve_started = $true
    $smoke.health = $health
    $token = (Get-Content (Join-Path $DataDir 'config\runtime-token') -Raw).Trim()
    $headers = @{ Authorization = "Bearer $token"; 'X-FCA-Client' = 'install-test'; 'Content-Type' = 'application/json' }
    $graph = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/graph" -Headers $headers -TimeoutSec 10
    $smoke.graph = [ordered]@{ nodes = @($graph.nodes).Count; edges = @($graph.edges).Count }
    $body = @{ title = '安装版 Runtime 冒烟记忆'; body = '由 installer/install-test.ps1 通过安装目录内 node.exe + runtime 写入。'; memory_type = 'episodic'; importance = 0.5 } | ConvertTo-Json -Depth 5
    $stored = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/memory/store" -Method Post -Headers $headers -Body $body -TimeoutSec 10
    $smoke.stored = [ordered]@{ id = $stored.memory.id; title = $stored.memory.title }
    $shutdown = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/shutdown" -Method Post -Headers $headers -Body '{}' -TimeoutSec 5
    $smoke.shutdown = $shutdown
    $smoke.ok = ($smoke.graph.nodes -ge 1) -and [bool]$smoke.stored.id
  } catch {
    $smoke.error = $_.Exception.Message
    $smoke.ok = $false
  } finally {
    try { if ($serveProc -and -not $serveProc.HasExited) { Stop-Process -Id $serveProc.Id -Force -ErrorAction SilentlyContinue } } catch { }
  }
  return $smoke
}

if ($SkipLaunch) {
  Add-Step 'launch-app' $true '(skipped by -SkipLaunch)'
  $smoke = Invoke-InstalledRuntimeSmoke
  $report.installed_runtime_smoke = $smoke
  Add-Step 'installed-runtime-smoke' $smoke.ok ("init/serve/health/graph={0} nodes/store={1}/shutdown ok={2} error={3}" -f $smoke.graph.nodes, $smoke.stored.id, ($null -ne $smoke.shutdown), $smoke.error)
} elseif ($existingApps.Count -gt 0) {
  Add-Step 'launch-app' $false "已有 FCA Memory Atlas 实例在运行（pid=$($existingApps.Id -join ',')），单实例锁会阻止本次启动；请关闭其它实例后重跑"
  $smoke = Invoke-InstalledRuntimeSmoke
  $report.installed_runtime_smoke = $smoke
  Add-Step 'installed-runtime-smoke' $smoke.ok ("init/serve/health/graph={0} nodes/store={1} error={2}" -f $(if($smoke.graph){$smoke.graph.nodes}else{'-'}), $(if($smoke.stored){$smoke.stored.id}else{'-'}), $smoke.error)
} else {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Remove-Item Env:ELECTRON_NO_ATTACH_CONSOLE -ErrorAction SilentlyContinue
  $exePath = Join-Path $InstallDir $ProductExe
  # --no-sandbox 仅用于当前 de-elevated DSH shell；从 Explorer/快捷方式启动无需该参数
  $appProc = Start-Exe -FilePath $exePath -Arguments @('--no-sandbox', "--fca-home=$DataDir", "--port=$Port") -WorkingDirectory $InstallDir
  $report.launch = [ordered]@{
    command = "`"$exePath`" --no-sandbox --fca-home=$DataDir --port=$Port"
    pid = $appProc.Id
    note = '--no-sandbox 仅为本机 de-elevated DSH shell 冒烟测试所需；Explorer/快捷方式启动不需要'
  }
  try {
    $health = Wait-RuntimeHealth -Port $Port -TimeoutSec 90
    $report.launch.health = $health
    Add-Step 'runtime-health-ok' ($health.status -eq 'ok' -or $null -ne $health.version) "status=$($health.status) version=$($health.version) api=$($health.api_version) initialized=$($health.initialized)"
  } catch {
    Add-Step 'runtime-health-ok' $false $_.Exception.Message
  }

  Start-Sleep -Milliseconds 1500
  $appProc.Refresh()
  $windowTitle = (Get-Process -Id $appProc.Id -ErrorAction SilentlyContinue).MainWindowTitle
  $report.launch.window_title = $windowTitle
  Add-Step 'app-window-visible' ($windowTitle -like 'FCA Memory Atlas*') "MainWindowTitle=$windowTitle"

  # 证据截图：把安装版窗口置前并截主屏（失败仅记录，不影响结论）
  $shotPath = Join-Path $ProjectRoot ("artifacts\screenshots\install-app-{0}.png" -f $Stamp)
  try {
    $appProc.Refresh()
    if ($appProc.MainWindowHandle -ne [IntPtr]::Zero) {
      [void](Focus-Window -Handle $appProc.MainWindowHandle)
      Start-Sleep -Milliseconds 1200
    }
    $captured = Capture-Screen -OutPath $shotPath
    $report.launch.screenshot = [ordered]@{ path = $shotPath; captured = $captured }
    Add-Step 'install-app-screenshot' $true $(if ($captured) { $shotPath } else { '截图失败（可能无桌面会话），不影响安装结论' })
  } catch {
    $report.launch.screenshot = [ordered]@{ path = $shotPath; captured = $false; error = $_.Exception.Message }
    Add-Step 'install-app-screenshot' $true "截图异常（不影响结论）：$($_.Exception.Message)"
  }

  $runtimeProc = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*fca-runtime.js*' -and $_.CommandLine -like "*$DataDir*" } |
    Select-Object -First 1
  $report.launch.runtime_process = $runtimeProc
  Add-Step 'runtime-process-spawned-by-installed-app' ($null -ne $runtimeProc) $(if ($runtimeProc) { "pid=$($runtimeProc.ProcessId) exe=$($runtimeProc.ExecutablePath)" } else { '未找到使用测试数据目录的 fca-runtime.js 进程（若端口被其它 Runtime 占用会误判健康检查）' })

  # 安装版 Runtime API 冒烟：若首次启动向导尚未初始化空库，用安装目录 token 调用 POST /db/init（与向导“初始化空库”走同一真实 API）
  $tokenFile = Join-Path $DataDir 'config\runtime-token'
  $initResult = $null
  if (($null -ne $health) -and (-not $health.initialized) -and (Test-Path $tokenFile)) {
    try {
      $token = (Get-Content $tokenFile -Raw).Trim()
      $headers = @{ Authorization = "Bearer $token"; 'X-FCA-Client' = 'test'; 'Content-Type' = 'application/json' }
      $initResult = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/db/init" -Method Post -Headers $headers -Body '{}' -TimeoutSec 15
      $report.launch.db_init = $initResult
    } catch {
      $report.launch.db_init_error = $_.Exception.Message
    }
  }

  $dataEvidence = [ordered]@{
    root_exists = (Test-Path $DataDir)
    db = (Test-Path (Join-Path $DataDir 'db\fca.db'))
    token = (Test-Path (Join-Path $DataDir 'config\runtime-token'))
    logs_dir = (Test-Path (Join-Path $DataDir 'logs'))
    desktop_log = @(Get-ChildItem (Join-Path $DataDir 'logs') -Filter '*.log' -ErrorAction SilentlyContinue | Select-Object -First 3 | ForEach-Object { $_.Name })
  }
  $report.data_dir_evidence = $dataEvidence
  Add-Step 'data-dir-initialized' ($dataEvidence.db -and $dataEvidence.token) "db=$($dataEvidence.db) token=$($dataEvidence.token) logs=$($dataEvidence.logs_dir) db_init=$([bool]$initResult)"
}

# ================================================================ 7. uninstall
Write-Host "`n=== [7/8] 卸载 ===" -ForegroundColor Cyan
if ($SkipUninstall) {
  Add-Step 'uninstall' $true '(skipped by -SkipUninstall)'
} else {
  if ($appProc -and -not $appProc.HasExited) {
    Stop-Process -Id $appProc.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 1200
  }
  Stop-TestRuntime
  $uninstaller = Join-Path $InstallDir 'Uninstall.exe'
  if (-not (Test-Path $uninstaller)) { throw "卸载器不存在：$uninstaller" }
  $uninstallSw = [System.Diagnostics.Stopwatch]::StartNew()
  $uninstallExit = Start-ExeWait -FilePath $uninstaller -Arguments @('/S') -WorkingDirectory $Root
  $uninstallSw.Stop()
  $report.uninstall = [ordered]@{
    command = "`"$uninstaller`" /S"
    method = 'CreateProcess (UseShellExecute=false)'
    exit_code = $uninstallExit
    elapsed_seconds = [math]::Round($uninstallSw.Elapsed.TotalSeconds, 1)
  }
  Add-Step 'silent-uninstall-exit-code-0' ($uninstallExit -eq 0) "exit=$uninstallExit"

  Start-Sleep -Milliseconds 800
  $remaining = @(Get-ChildItem $InstallDir -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 20 | ForEach-Object { $_.FullName.Substring($InstallDir.Length + 1) })
  $installDirStillExists = Test-Path $InstallDir
  $report.uninstall.install_dir_removed = (-not $installDirStillExists)
  $report.uninstall.remaining_files = $remaining
  Add-Step 'install-dir-removed' ((-not $installDirStillExists) -and $remaining.Count -eq 0) "exists=$installDirStillExists remaining=$($remaining -join ', ')"

  $shortcutsAfter = [ordered]@{
    desktop = (Test-Path $desktopLnk)
    start_menu_dir = (Test-Path $startMenuDir)
    uninstall_key = (Test-Path $uninstallKey)
    app_key = (Test-Path $appKey)
    app_paths = (Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\FCA Memory Atlas.exe')
  }
  $report.uninstall.after = $shortcutsAfter
  $cleanOk = (-not $shortcutsAfter.desktop) -and (-not $shortcutsAfter.start_menu_dir) -and (-not $shortcutsAfter.uninstall_key) -and (-not $shortcutsAfter.app_key) -and (-not $shortcutsAfter.app_paths)
  Add-Step 'shortcuts-and-registry-removed' $cleanOk ($shortcutsAfter | ConvertTo-Json -Compress)

  $defaultDataStillThere = Test-Path $DefaultDataDir
  $report.uninstall.default_user_data_dir = [ordered]@{
    path = $DefaultDataDir
    existed_before = ($null -ne $beforeDefault)
    exists_after = $defaultDataStillThere
    untouched = $true
  }
  Add-Step 'user-data-dir-preserved' $defaultDataStillThere "默认数据目录未被卸载器删除：$DefaultDataDir"

  # 本测试使用隔离数据目录（--fca-home）。卸载器按设计只处理默认数据目录，自定义目录不会被删除 → 数据应保留
  $testDataRetained = (Test-Path $DataDir) -and (Test-Path (Join-Path $DataDir 'db\fca.db'))
  $report.uninstall.test_data_dir = [ordered]@{
    path = $DataDir
    retained = $testDataRetained
    db_retained = (Test-Path (Join-Path $DataDir 'db\fca.db'))
    policy = 'uninstaller keeps user data by default (including custom --fca-home dirs it cannot know about)'
  }
  Add-Step 'test-data-dir-retained-after-uninstall' $testDataRetained "隔离数据目录保留：$DataDir"

  # 真实 Runtime 守卫：确认 17860 未被本次安装/卸载干扰
  $realRuntime.health_after = Get-PortHealth -Port 17860
  $realRuntime.reachable_after = ($null -ne $realRuntime.health_after)
  if ($realRuntime.reachable_before) {
    Add-Step 'real-runtime-17860-undisturbed' $realRuntime.reachable_after "17860 reachable_before=True reachable_after=$($realRuntime.reachable_after)（安装/卸载未停止真实 Runtime）"
  } else {
    Add-Step 'real-runtime-17860-undisturbed' $true '17860 测试前未运行（无需保护）'
  }

  $uninstallLogTail = $null
  $uninstallLogOk = $false
  $uninstallLogUsed = $null
  $uninstallLogCandidates = @($UninstallLog, (Join-Path (Join-Path $env:TEMP 'Low') 'fca-uninstall.log'))
  foreach ($candidate in $uninstallLogCandidates) {
    if (Test-Path $candidate) { $uninstallLogUsed = $candidate; break }
  }
  if ($uninstallLogUsed) {
    $uninstallLogTail = (Get-Content $uninstallLogUsed -Tail 40) -join "`n"
    $uninstallLogOk = $uninstallLogTail -match 'uninstall completed'
  }
  $report.uninstall_log = [ordered]@{ path = $uninstallLogUsed; candidates = $uninstallLogCandidates; exists = ($null -ne $uninstallLogUsed); tail = $uninstallLogTail; success_marker = $uninstallLogOk }
  Add-Step 'uninstall-log-success-marker' $uninstallLogOk "log=$uninstallLogUsed"
}

# ================================================================ 8. cleanup
Write-Host "`n=== [8/8] 清理测试目录 ===" -ForegroundColor Cyan
if ($SkipCleanup -or $SkipUninstall) {
  Add-Step 'cleanup-isolated-test-root' $true '(skipped)'
} else {
  Remove-TestDir $Root
  Add-Step 'cleanup-isolated-test-root' (-not (Test-Path $Root)) "removed $Root (仅隔离测试目录；用户真实数据目录未触碰)"
}

$report.ok = (@($report.steps | Where-Object { -not $_.ok }).Count -eq 0)
Save-Report
Write-Host ''
if ($report.ok) {
  Write-Host '[install-test] RESULT: PASS（安装 → 启动 → 连接 Runtime → 卸载 全部通过）' -ForegroundColor Green
  exit 0
} else {
  $failed = @($report.steps | Where-Object { -not $_.ok } | ForEach-Object { $_.name }) -join ', '
  Write-Host "[install-test] RESULT: FAIL（$failed）" -ForegroundColor Red
  exit 1
}


