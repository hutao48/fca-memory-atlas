#Requires -Version 5.1
<#
.SYNOPSIS
  FCA Memory Atlas v0.3.0 安装/文件/安装版 Runtime/卸载 最小可靠验证（无 GUI、无报告序列化依赖）。

.DESCRIPTION
  在 DSH 工具 shell（Low IL 沙箱）内也可稳定运行的口径：
    1) 校验安装包 SHA256 与 .sha256.json 一致；
    2) NSIS 静默安装到隔离目录（/S /D=<Root>\app，per-user）；
    3) 校验关键文件：主程序/resources/app（含 unity-embed.js）/runtime/bin+src/node/
       unity/FCANebulaWebGL（index.html + Build/*.wasm/*.data/*.loader.js/*.framework.js）/
       dsh_plugin/dsh-plugin-fca-memory-<pluginVersion>.tgz / docs / BUILD_INFO(version=<productVersion>) / install-report.ini；
    3b) v0.3.0 产品 UI 修复/新功能随包检查（文件存在 + 内容断言）：
       renderer/lib/{hierarchy.js,unity-selection.js,detail-panel.js}、renderer/views/relations.js、
       index.html 顶栏常驻 btn-toggle-left/right、关系详情关系层级标记、Unity 双向选中桥接标记；
    4) 用安装目录内 node.exe + runtime 源码在隔离数据目录做真实 Runtime 冒烟：
       init → serve → /health → /graph → 写一条记忆 → shutdown；
    5) 静默卸载；校验程序目录移除、测试数据目录保留、17860 真实 Runtime 未受干扰。
  证据：artifacts/reports/install-verify-<timestamp>.json（UTF-8 无 BOM）+ 控制台 PASS/FAIL。
  说明：HKCU 卸载项/桌面快捷方式在本机 DSH 工具 shell 的 Low IL 下会被静默丢弃（测试环境限制，
  非产品缺陷）；该两项仅作信息记录，不计入 PASS 判定。真实用户/正常会话由 Explorer 双击路径覆盖。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File installer\verify-installed.ps1
#>
[CmdletBinding()]
param(
  [string]$InstallerPath = '',
  [string]$Root = '',
  [int]$Port = 17897,
  [switch]$KeepInstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Root) { $Root = Join-Path $ProjectRoot '.cache\v030-install-verify' }
$Root = [System.IO.Path]::GetFullPath($Root)
$InstallDir = Join-Path $Root 'app'
$DataDir = Join-Path $Root 'data'
$ReportsDir = Join-Path $ProjectRoot 'artifacts\reports'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$ReportPath = Join-Path $ReportsDir "install-verify-$Stamp.json"
$DefaultDataDir = Join-Path $env:LOCALAPPDATA 'FCA-Memory-Atlas'
$InstallLog = Join-Path $env:TEMP 'fca-install.log'
$UninstallLog = Join-Path $env:TEMP 'fca-uninstall.log'

if (-not $InstallerPath) {
  $cands = @(Get-ChildItem (Join-Path $ProjectRoot 'artifacts\installer') -Filter 'FCA-Memory-Atlas-Setup-*-x64.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'Setup-(\d+\.\d+\.\d+)-x64\.exe$' } |
    Sort-Object { [version]($_.Name -replace '.*Setup-(\d+\.\d+\.\d+)-x64\.exe$','$1') } -Descending)
  if ($cands.Count -gt 0) { $InstallerPath = $cands[0].FullName } else { throw '未找到 artifacts\installer\FCA-Memory-Atlas-Setup-*-x64.exe' }
}
$InstallerPath = [System.IO.Path]::GetFullPath($InstallerPath)

$report = [ordered]@{
  suite = 'install-verify'
  started_at = (Get-Date).ToUniversalTime().ToString('o')
  host = $env:COMPUTERNAME
  installer = [ordered]@{ path = $InstallerPath; size_bytes = $null; sha256 = $null; expected_sha256 = $null; sha256_ok = $null }
  isolated = [ordered]@{ root = $Root; install_dir = $InstallDir; data_dir = $DataDir; port = $Port }
  steps = @()
  results = [ordered]@{}
  info_only = [ordered]@{}
  ok = $false
  error = $null
}

function Add-Step([string]$Name, [bool]$Ok, $Detail) {
  $report.steps += [ordered]@{ name = $Name; ok = $Ok; at = (Get-Date).ToUniversalTime().ToString('o'); detail = $Detail }
  $tag = if ($Ok) { 'PASS' } else { 'FAIL' }
  Write-Host "[install-verify] $tag $Name" -ForegroundColor $(if ($Ok) { 'Green' } else { 'Red' })
  if ($Detail) { Write-Host "              $Detail" }
}
function Save-Report {
  if (-not (Test-Path $ReportsDir)) { New-Item -ItemType Directory -Path $ReportsDir -Force | Out-Null }
  $report.finished_at = (Get-Date).ToUniversalTime().ToString('o')
  $json = $report | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($ReportPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "[install-verify] report: $ReportPath"
}
function Start-ExeWaitDirect {
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
function Remove-SafeDir([string]$Path) {
  $full = [System.IO.Path]::GetFullPath($Path)
  $isRoot = $full.Equals($Root, [System.StringComparison]::OrdinalIgnoreCase)
  $inside = $full.StartsWith($Root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
  if (-not ($isRoot -or $inside)) { throw "拒绝删除测试根目录外路径：$full" }
  if (Test-Path $full) { Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue }
}
function Read-JsonFile([string]$Path) {
  return ([System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json)
}

trap {
  $report.error = [ordered]@{ message = $_.Exception.Message; stack = $_.ScriptStackTrace }
  Add-Step 'unhandled-error' $false $_.Exception.Message
  $report.ok = $false
  try { Save-Report } catch { }
  exit 1
}

Write-Host "[install-verify] installer: $InstallerPath"
# ---------- 0. 环境守卫（不干扰真实 Runtime / 正在运行的 app）
$realHealth = $null
try { $realHealth = Invoke-RestMethod 'http://127.0.0.1:17860/health' -TimeoutSec 2 } catch { }
$report.info_only.real_runtime_17860 = [ordered]@{ reachable_before = ($null -ne $realHealth); pid = $(if ($realHealth) { $realHealth.pid } else { $null }); data_dir = $(if ($realHealth) { $realHealth.data_dir } else { $null }) }
Write-Host "[install-verify] 17860 real runtime reachable=$($null -ne $realHealth) (不停止/不修改)"

$existingApps = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'FCA Memory Atlas' })
$report.info_only.existing_app_instances = @($existingApps | ForEach-Object { [ordered]@{ id = $_.Id; start = $_.StartTime.ToString('o') } })
if ($existingApps.Count -gt 0) { Add-Step 'no-running-fca-app' $false "检测到 $($existingApps.Count) 个 FCA Memory Atlas 实例（安装器会拒绝安装）；请先关闭后重跑" } else { Add-Step 'no-running-fca-app' $true '无正在运行的 FCA 实例' }

Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $Root -Force | Out-Null
Remove-Item $InstallLog,$UninstallLog -Force -ErrorAction SilentlyContinue

$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FCAMemoryAtlas'
if (Test-Path $uninstallKey) { Remove-Item -Path $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue }

# ---------- 1. hash
$report.installer.size_bytes = (Get-Item $InstallerPath).Length
$report.installer.sha256 = (Get-FileHash -Algorithm SHA256 $InstallerPath).Hash.ToLowerInvariant()
$shaMetaPath = $InstallerPath -replace '\.exe$', '.sha256.json'
if (Test-Path $shaMetaPath) {
  $meta = Get-Content $shaMetaPath -Raw | ConvertFrom-Json
  $report.installer.expected_sha256 = $meta.sha256
  $report.installer.sha256_ok = ([string]$meta.sha256 -eq $report.installer.sha256)
}
Add-Step 'installer-sha256-matches-metadata' ([bool]$report.installer.sha256_ok) "actual=$($report.installer.sha256) expected=$($report.installer.expected_sha256)"

# ---------- 2. silent install
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$installExit = Start-ExeWaitDirect -FilePath $InstallerPath -Arguments @('/S', "/D=$InstallDir") -WorkingDirectory $Root
$sw.Stop()
$report.results.install = [ordered]@{ command = "`"$InstallerPath`" /S /D=$InstallDir"; method = 'CreateProcess (UseShellExecute=false)'; exit_code = $installExit; elapsed_seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
Add-Step 'silent-install-exit-0' ($installExit -eq 0) "exit=$installExit elapsed=$($report.results.install.elapsed_seconds)s"

# ---------- 3. installed files
$required = @(
  'FCA Memory Atlas.exe', 'Uninstall.exe', 'BUILD_INFO.json', 'LICENSE', 'LICENSES.chromium.html', 'install-report.ini',
  'resources\app\package.json', 'resources\app\main\main.js', 'resources\app\main\preload.js', 'resources\app\main\ipc.js',
  'resources\app\main\runtime-manager.js', 'resources\app\main\settings.js', 'resources\app\main\paths.js',
  'resources\app\main\unity-viewer.js', 'resources\app\main\unity-embed.js',
  'resources\app\renderer\index.html', 'resources\app\renderer\app.js', 'resources\app\renderer\views\atlas.js',
  'resources\app\renderer\styles\tokens.css', 'resources\app\renderer\nebula\index.js',
  'runtime\bin\fca-runtime.js', 'runtime\src\runtime.js', 'runtime\src\services.js', 'runtime\src\server\index.js',
  'runtime\src\api\routes\llm.js', 'node\node.exe',
  'unity\FCANebulaWebGL\index.html',
  'docs\USER_MANUAL.md', 'docs\KNOWN_ISSUES.md', 'docs\INSTALL_TEST.md', 'docs\UNITY_NEBULA.md', 'docs\FINAL_ACCEPTANCE.md',
  'docs\adr\ADR-006-installer.md', 'README.md', 'CHANGELOG.md'
)
$missing = @()
foreach ($rel in $required) { if (-not (Test-Path -LiteralPath (Join-Path $InstallDir $rel))) { $missing += $rel } }
$report.results.installed_files = [ordered]@{ checked = $required.Count; missing = $missing }
Add-Step 'installed-files-complete' ($missing.Count -eq 0) $(if ($missing.Count) { 'missing: ' + ($missing -join ', ') } else { "$($required.Count) 个关键文件齐全" })

# Unity WebGL payload
$unityDir = Join-Path $InstallDir 'unity\FCANebulaWebGL'
$unityBuild = Join-Path $unityDir 'Build'
$unity = [ordered]@{
  index_html = Test-Path -LiteralPath (Join-Path $unityDir 'index.html')
  wasm = @(Get-ChildItem -LiteralPath $unityBuild -Filter '*.wasm' -ErrorAction SilentlyContinue).Count
  data = @(Get-ChildItem -LiteralPath $unityBuild -Filter '*.data' -ErrorAction SilentlyContinue).Count
  loader = @(Get-ChildItem -LiteralPath $unityBuild -Filter '*.loader.js' -ErrorAction SilentlyContinue).Count
  framework = @(Get-ChildItem -LiteralPath $unityBuild -Filter '*.framework.js' -ErrorAction SilentlyContinue).Count
  bytes = $(if (Test-Path -LiteralPath $unityDir) { (Get-ChildItem -LiteralPath $unityDir -Recurse -File | Measure-Object Length -Sum).Sum } else { 0 })
}
$report.results.unity_webgl = $unity
# EPIPE 稳定性修复（v0.2.1）：安装包内 runtime 源码必须包含修复标记
$runtimeSrcFile = Join-Path $InstallDir 'runtime\src\runtime.js'
$loggingFile = Join-Path $InstallDir 'runtime\src\logging\index.js'
$runtimeSrcText = if (Test-Path $runtimeSrcFile) { [System.IO.File]::ReadAllText($runtimeSrcFile) } else { '' }
$loggingText = if (Test-Path $loggingFile) { [System.IO.File]::ReadAllText($loggingFile) } else { '' }
$epipe = [ordered]@{ runtime_isBrokenPipeError = ($runtimeSrcText -match 'isBrokenPipeError'); runtime_epipe_handler = ($runtimeSrcText -match 'EPIPE'); logging_consoleBroken = ($loggingText -match 'consoleBroken') }
$report.results.epipe_fix = $epipe
Add-Step 'epipe-fix-in-payload' ($epipe.runtime_isBrokenPipeError -and $epipe.runtime_epipe_handler -and $epipe.logging_consoleBroken) "runtime.js isBrokenPipeError=$($epipe.runtime_isBrokenPipeError) EPIPE=$($epipe.runtime_epipe_handler) logging.consoleBroken=$($epipe.logging_consoleBroken)"
Add-Step 'unity-webgl-payload-installed' ($unity.index_html -and $unity.wasm -gt 0 -and $unity.data -gt 0 -and $unity.loader -gt 0 -and $unity.framework -gt 0 -and $unity.bytes -gt 10MB) "index=$($unity.index_html) wasm=$($unity.wasm) data=$($unity.data) loader=$($unity.loader) framework=$($unity.framework) size=$([math]::Round($unity.bytes/1MB,1))MB"

# v0.3.0 Unity WebGL 新构建随包检查（体积/文件断言，防止旧构建进入安装包）
$unityWasmItem = Get-ChildItem -LiteralPath $unityBuild -Filter '*.wasm' -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 1
$unityFrameworkItem = Get-ChildItem -LiteralPath $unityBuild -Filter '*.framework.js' -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 1
$unityIndexItem = Get-Item -LiteralPath (Join-Path $unityDir 'index.html') -ErrorAction SilentlyContinue
$indexTitleOk = $false
if ($unityIndexItem) { $indexTitleOk = ([System.IO.File]::ReadAllText($unityIndexItem.FullName) -match 'FCA Nebula') }
$unityV030 = [ordered]@{
  index_bytes = $(if ($unityIndexItem) { $unityIndexItem.Length } else { 0 })
  wasm_bytes = $(if ($unityWasmItem) { $unityWasmItem.Length } else { 0 })
  framework_bytes = $(if ($unityFrameworkItem) { $unityFrameworkItem.Length } else { 0 })
  index_has_unity_title = $indexTitleOk
}
$report.results.unity_webgl_v030 = $unityV030
Add-Step 'unity-webgl-build-v030' ($unityV030.index_bytes -gt 8000 -and $unityV030.wasm_bytes -gt 10MB -and $unityV030.framework_bytes -gt 300KB -and $unityV030.index_has_unity_title) "index=$($unityV030.index_bytes)B wasm=$([math]::Round($unityV030.wasm_bytes/1MB,1))MB framework=$([math]::Round($unityV030.framework_bytes/1KB,1))KB title=$($unityV030.index_has_unity_title)"

# v0.3.0 产品 UI 修复/新功能随包检查（文件存在 + 内容断言）
$appRenderer = Join-Path $InstallDir 'resources\app\renderer'
function Get-PayloadText([string]$rel) {
  $p = Join-Path $InstallDir $rel
  if (Test-Path -LiteralPath $p) { return [System.IO.File]::ReadAllText($p) }
  return ''
}
$indexHtmlText = Get-PayloadText 'resources\app\renderer\index.html'
$detailPanelText = Get-PayloadText 'resources\app\renderer\lib\detail-panel.js'
$unitySelectionText = Get-PayloadText 'resources\app\renderer\lib\unity-selection.js'
$hierarchyText = Get-PayloadText 'resources\app\renderer\lib\hierarchy.js'
$relationsText = Get-PayloadText 'resources\app\renderer\views\relations.js'
$atlasText = Get-PayloadText 'resources\app\renderer\views\atlas.js'
$ui = [ordered]@{
  unity_selection_module = Test-Path -LiteralPath (Join-Path $appRenderer 'lib\unity-selection.js')
  hierarchy_module = Test-Path -LiteralPath (Join-Path $appRenderer 'lib\hierarchy.js')
  detail_panel = Test-Path -LiteralPath (Join-Path $appRenderer 'lib\detail-panel.js')
  toggle_buttons = ($indexHtmlText -match 'btn-toggle-left' -and $indexHtmlText -match 'btn-toggle-right')
  relation_detail_marker = ($relationsText -match 'relation-detail')
  relation_hierarchy_marker = ($relationsText -match 'relation-detail-hierarchy')
  hierarchy_section_marker = ($detailPanelText -match 'detail__hierarchy')
  unity_select_bridge = ($unitySelectionText -match 'fca-unity-select')
  atlas_select_handler = ($atlasText -match 'UNITY_SELECT_MESSAGE')
  hierarchy_child_tag = ($hierarchyText -match 'subagent-session:')
}
$report.results.ui_fixes = $ui
$uiOk = $ui.unity_selection_module -and $ui.hierarchy_module -and $ui.detail_panel -and $ui.toggle_buttons -and $ui.relation_detail_marker -and $ui.relation_hierarchy_marker -and $ui.hierarchy_section_marker -and $ui.unity_select_bridge -and $ui.atlas_select_handler -and $ui.hierarchy_child_tag
Add-Step 'ui-fixes-in-payload' $uiOk "modules=$($ui.unity_selection_module -and $ui.hierarchy_module -and $ui.detail_panel) toggle=$($ui.toggle_buttons) relationDetail=$($ui.relation_detail_marker) relationHierarchy=$($ui.relation_hierarchy_marker) hierarchySection=$($ui.hierarchy_section_marker) unitySelect=$($ui.unity_select_bridge) atlasHandler=$($ui.atlas_select_handler) childTag=$($ui.hierarchy_child_tag)"

# DSH plugin tgz
$pluginDir = Join-Path $InstallDir 'dsh_plugin'
$pluginTgz = @(Get-ChildItem -LiteralPath $pluginDir -Filter 'dsh-plugin-fca-memory-*.tgz' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1)
$report.results.dsh_plugin = [ordered]@{ dir = $pluginDir; tgz = $(if ($pluginTgz.Count) { $pluginTgz[0].Name } else { $null }); bytes = $(if ($pluginTgz.Count) { $pluginTgz[0].Length } else { 0 }); readme = Test-Path -LiteralPath (Join-Path $pluginDir 'README.md') }
Add-Step 'dsh-plugin-tgz-installed' ($pluginTgz.Count -gt 0 -and $pluginTgz[0].Length -gt 10KB) "tgz=$($report.results.dsh_plugin.tgz) size=$($report.results.dsh_plugin.bytes)B"

# BUILD_INFO / install-report
$buildInfo = Read-JsonFile (Join-Path $InstallDir 'BUILD_INFO.json')
$expectedVersion = if ($meta) { [string]$meta.version } else { '0.2.0' }
$report.results.build_info = [ordered]@{ version = $buildInfo.version; built_at = $buildInfo.built_at; unity_included = [bool]($buildInfo.optional_components -and $buildInfo.optional_components.unity_nebula_webgl -and $buildInfo.optional_components.unity_nebula_webgl.included); dsh_plugin_included = [bool]($buildInfo.optional_components -and $buildInfo.optional_components.dsh_plugin -and $buildInfo.optional_components.dsh_plugin.included); checks = $buildInfo.checks }
Add-Step 'build-info-version' ([string]$buildInfo.version -eq $expectedVersion) "version=$($buildInfo.version) built_at=$($buildInfo.built_at) unity=$($report.results.build_info.unity_included) dsh_plugin=$($report.results.build_info.dsh_plugin_included) unity_renderer_present=$($buildInfo.checks.unity_renderer_present)"

# DSH 插件版本随包一致：BUILD_INFO.optional_components.dsh_plugin.version 必须与安装目录 tgz 文件名匹配
$expectedPlugin = if ($buildInfo.optional_components -and $buildInfo.optional_components.dsh_plugin) { [string]$buildInfo.optional_components.dsh_plugin.version } else { $null }
$pluginVersionMatch = ($expectedPlugin -and $report.results.dsh_plugin.tgz -eq "dsh-plugin-fca-memory-$expectedPlugin.tgz")
$report.results.dsh_plugin.expected_version = $expectedPlugin
$report.results.dsh_plugin.version_match = [bool]$pluginVersionMatch
Add-Step 'dsh-plugin-version-match' ([bool]$pluginVersionMatch) "expected=$expectedPlugin installed=$($report.results.dsh_plugin.tgz)"

$iniRaw = [System.IO.File]::ReadAllText((Join-Path $InstallDir 'install-report.ini'))
$unityIni = if ($iniRaw -match 'unity_nebula_webgl=([^\r\n]+)') { $Matches[1].Trim() } else { $null }
$pluginIni = if ($iniRaw -match 'dsh_plugin=([^\r\n]+)') { $Matches[1].Trim() } else { $null }
$report.results.install_report = [ordered]@{ unity_nebula_webgl = $unityIni; dsh_plugin = $pluginIni }
Add-Step 'install-report-ini' ($unityIni -and $unityIni -like '*FCANebulaWebGL\index.html*' -and $pluginIni -and $pluginIni -like '*.tgz*') "unity=$unityIni dsh_plugin=$pluginIni"

# install log（正常路径；Low IL 沙箱会重定向到 %TEMP%\Low）
$logUsed = $null
foreach ($c in @($InstallLog, (Join-Path (Join-Path $env:TEMP 'Low') 'fca-install.log'))) { if (Test-Path $c) { $logUsed = $c; break } }
$logTail = if ($logUsed) { (Get-Content $logUsed -Tail 60) -join "`n" } else { $null }
$report.results.install_log = [ordered]@{ path = $logUsed; success_marker = ($logTail -match 'installation completed successfully') }
Add-Step 'install-log-success-marker' ([bool]$report.results.install_log.success_marker) "log=$logUsed"

# ---------- 4. installed runtime smoke
$nodeExe = Join-Path $InstallDir 'node\node.exe'
$entry = Join-Path $InstallDir 'runtime\bin\fca-runtime.js'
$smoke = [ordered]@{ init = $null; serve = $false; health = $null; graph = $null; stored = $null; shutdown = $null; ok = $false; error = $null }
$serveProc = $null
try {
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $initOut = (& $nodeExe $entry init "--fca-home=$DataDir" '--quiet' 2>$null | Out-String) } finally { $ErrorActionPreference = $prevEap }
  try { $smoke.init = ($initOut | ConvertFrom-Json) } catch { $smoke.init = ($initOut | Out-String).Trim() }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $nodeExe
  $psi.Arguments = "`"$entry`" serve --fca-home=`"$DataDir`" --port=$Port --quiet"
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $serveProc = [System.Diagnostics.Process]::Start($psi)
  [void]$serveProc.BeginOutputReadLine()
  [void]$serveProc.BeginErrorReadLine()

  $deadline = (Get-Date).AddSeconds(60)
  $health = $null
  while ((Get-Date) -lt $deadline) {
    try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2; break } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $health) { throw "Runtime 健康检查超时（http://127.0.0.1:$Port/health）" }
  $smoke.serve = $true
  $smoke.health = $health
  $token = ([System.IO.File]::ReadAllText((Join-Path $DataDir 'config\runtime-token'))).Trim()
  $headers = @{ Authorization = "Bearer $token"; 'X-FCA-Client' = 'test'; 'Content-Type' = 'application/json' }
  $graph = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/graph" -Headers $headers -TimeoutSec 10
  $smoke.graph = [ordered]@{ nodes = @($graph.nodes).Count; edges = @($graph.edges).Count }
  $body = @{ title = '安装版 Runtime 冒烟记忆'; body = '由 installer/verify-installed.ps1 通过安装目录内 node.exe + runtime 写入。'; memory_type = 'episodic'; importance = 0.5 } | ConvertTo-Json -Depth 5
  $stored = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/memory/store" -Method Post -Headers $headers -Body $body -TimeoutSec 10
  $storedMemory = if ($stored.memory) { $stored.memory } else { $stored }
  $smoke.stored = [ordered]@{ id = $storedMemory.id; title = $storedMemory.title }
  $graph2 = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/graph" -Headers $headers -TimeoutSec 10
  $smoke.graph_after_store = [ordered]@{ nodes = @($graph2.nodes).Count; edges = @($graph2.edges).Count }
  $smoke.shutdown = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/shutdown" -Method Post -Headers $headers -Body '{}' -TimeoutSec 5
  $smoke.ok = ($smoke.graph_after_store.nodes -ge 1) -and [bool]$smoke.stored.id -and [bool]$smoke.shutdown
} catch {
  $errMsg = $_.Exception.Message
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $errMsg = "$errMsg | $($_.ErrorDetails.Message)" }
  $smoke.error = $errMsg
} finally {
  try { if ($serveProc -and -not $serveProc.HasExited) { Stop-Process -Id $serveProc.Id -Force -ErrorAction SilentlyContinue } } catch { }
  try { if (Test-Path $nodeExe) { $ErrorActionPreference='Continue'; & $nodeExe $entry stop "--fca-home=$DataDir" '--quiet' 2>$null | Out-Null } } catch { }
}
$report.results.installed_runtime_smoke = $smoke
Add-Step 'installed-runtime-smoke' $smoke.ok "init/serve=$($smoke.serve) health=$($smoke.health.status) graph_before=$($smoke.graph.nodes) stored=$($smoke.stored.id) graph_after=$($smoke.graph_after_store.nodes) shutdown=$([bool]$smoke.shutdown) error=$($smoke.error)"

# ---------- 5. uninstall
$beforeTestData = Test-Path (Join-Path $DataDir 'db\fca.db')
$un = Join-Path $InstallDir 'Uninstall.exe'
if (-not (Test-Path $un)) { throw "卸载器不存在：$un" }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$uninstallExit = Start-ExeWaitDirect -FilePath $un -Arguments @('/S') -WorkingDirectory $Root
$sw.Stop()
$report.results.uninstall = [ordered]@{ command = "`"$un`" /S"; method = 'CreateProcess (UseShellExecute=false)'; exit_code = $uninstallExit; elapsed_seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
Add-Step 'silent-uninstall-exit-0' ($uninstallExit -eq 0) "exit=$uninstallExit"
Start-Sleep -Milliseconds 800
$remaining = @(Get-ChildItem $InstallDir -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 10 | ForEach-Object { $_.FullName.Substring($InstallDir.Length + 1) })
$report.results.uninstall.remaining_files = $remaining
$report.results.install_dir_removed = (-not (Test-Path $InstallDir)) -and $remaining.Count -eq 0
Add-Step 'install-dir-removed' $report.results.install_dir_removed "exists=$(Test-Path $InstallDir) remaining=$($remaining -join ',')"

$report.results.test_data_dir = [ordered]@{ path = $DataDir; db_before_uninstall = $beforeTestData; retained_after = (Test-Path (Join-Path $DataDir 'db\fca.db')) }
Add-Step 'test-data-dir-kept-by-policy' $report.results.test_data_dir.retained_after "隔离数据目录保留（卸载器默认保留用户数据）：$DataDir"

$realAfter = $null
try { $realAfter = Invoke-RestMethod 'http://127.0.0.1:17860/health' -TimeoutSec 2 } catch { }
$report.info_only.real_runtime_17860.reachable_after = ($null -ne $realAfter)
if ($report.info_only.real_runtime_17860.reachable_before) {
  Add-Step 'real-runtime-17860-undisturbed' ($null -ne $realAfter) "17860 before=True after=$($null -ne $realAfter)（安装/卸载未停止真实 Runtime）"
} else {
  Add-Step 'real-runtime-17860-undisturbed' $true '17860 测试前未运行'
}

# 环境限制项（仅记录，不计 PASS）：HKCU/快捷方式在 Low IL 下不可写
$report.info_only.low_il_limits = [ordered]@{
  hkcu_uninstall_key_exists = (Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FCAMemoryAtlas')
  desktop_shortcut_exists = (Test-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'FCA Memory Atlas.lnk'))
  note = 'DSH 工具 shell 的 Low IL 沙箱会静默丢弃 HKCU/快捷方式写入；真实用户 Explorer 双击路径不受影响（见 docs/INSTALL_TEST.md §6 与 docs/ENVIRONMENT_REPORT.md §7.4）'
}
$unlogUsed = $null
foreach ($c in @($UninstallLog, (Join-Path (Join-Path $env:TEMP 'Low') 'fca-uninstall.log'))) { if (Test-Path $c) { $unlogUsed = $c; break } }
$unlogTail = if ($unlogUsed) { (Get-Content $unlogUsed -Tail 60) -join "`n" } else { $null }
$report.results.uninstall_log = [ordered]@{ path = $unlogUsed; success_marker = ($unlogTail -match 'uninstall completed') }
Add-Step 'uninstall-log-success-marker' ([bool]$report.results.uninstall_log.success_marker) "log=$unlogUsed"

# ---------- 6. cleanup
if ($KeepInstall) {
  Add-Step 'cleanup' $true '(kept by -KeepInstall)'
} else {
  Remove-SafeDir $Root
  Add-Step 'cleanup' (-not (Test-Path $Root)) "removed $Root（隔离测试目录；用户真实数据目录未触碰）"
}

$report.ok = (@($report.steps | Where-Object { -not $_.ok }).Count -eq 0)
Save-Report
Write-Host ''
if ($report.ok) {
  Write-Host '[install-verify] RESULT: PASS（安装 → 文件/Unity WebGL/插件 → 安装版 Runtime 冒烟 → 卸载）' -ForegroundColor Green
  exit 0
} else {
  $failed = @($report.steps | Where-Object { -not $_.ok } | ForEach-Object { $_.name }) -join ', '
  Write-Host "[install-verify] RESULT: FAIL（$failed）" -ForegroundColor Red
  exit 1
}
