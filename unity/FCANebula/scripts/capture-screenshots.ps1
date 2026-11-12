# FCA Memory Atlas — Unity Nebula Renderer
# Unattended screenshot capture from the built standalone player, using the REAL FCA Runtime
# graph (GET /api/v1/graph). Produces the 3 acceptance screenshots + a manifest, then quits.
#
# Usage:
#   pwsh -File unity/FCANebula/scripts/capture-screenshots.ps1
#   pwsh -File unity/FCANebula/scripts/capture-screenshots.ps1 -Quality high -Count 3 -Delay 8
#
# Output default: artifacts/unity/
#   screenshot-1-overview.png
#   screenshot-2-workspace-arm.png
#   screenshot-3-top-down.png
#   screenshots-manifest.json

[CmdletBinding()]
param(
    [string]$RuntimeUrl = 'http://127.0.0.1:17860',
    [string]$TokenFile = '',
    [string]$FcaHome = '',
    [ValidateSet('off', 'low', 'medium', 'high', 'ultra')]
    [string]$Quality = 'high',
    [string]$OutDir = '',
    [ValidateRange(1, 3)]
    [int]$Count = 3,
    [int]$Delay = 8,
    [switch]$AllowSample
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$exe = Join-Path $RepoRoot 'artifacts\unity\FCANebula\FCANebula.exe'
if (-not (Test-Path $exe)) {
    throw "未找到 $exe。请先运行: pwsh -File unity/FCANebula/scripts/build.ps1"
}
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot 'artifacts\unity' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$arguments = @(
    "--runtime-url=$RuntimeUrl",
    "--quality=$Quality",
    "--screenshot-dir=$OutDir",
    "--screenshot-count=$Count",
    "--screenshot-delay=$Delay"
)
if ($TokenFile) { $arguments += "--token-file=$TokenFile" }
if ($FcaHome) { $arguments += "--fca-home=$FcaHome" }
if ($AllowSample) { $arguments += '--allow-sample' }

Write-Host "[capture] $exe"
Write-Host "[capture] args: $($arguments -join ' ')"
$quoted = @()
foreach ($argument in $arguments) {
    if ($argument -match '\s') { $quoted += ('"' + $argument + '"') } else { $quoted += $argument }
}
# Unity player is a GUI-subsystem executable: Start-Process -Wait is required.
$proc = Start-Process -FilePath $exe -ArgumentList ($quoted -join ' ') -Wait -PassThru -WorkingDirectory $RepoRoot
$exitCode = $proc.ExitCode
if ($exitCode -ne 0) {
    throw "截图进程退出码 $exitCode（log 见 Unity player log）"
}

$expected = @(
    'screenshot-1-overview.png',
    'screenshot-2-workspace-arm.png',
    'screenshot-3-top-down.png'
)
$found = @()
foreach ($name in $expected) {
    $path = Join-Path $OutDir $name
    if (Test-Path $path) {
        $found += $path
        $sizeKb = [math]::Round((Get-Item $path).Length / 1KB, 1)
        Write-Host ("[capture] OK: {0} ({1} KB)" -f $path, $sizeKb)
    }
}
$offline = Join-Path $OutDir 'screenshot-offline-state.png'
if (Test-Path $offline) {
    Write-Warning "Runtime 不可用：只生成了离线状态截图 $offline（未伪造数据）"
}

$manifest = Join-Path $OutDir 'screenshots-manifest.json'
if (Test-Path $manifest) {
    Write-Host "[capture] manifest: $manifest"
    Get-Content $manifest -Raw
}
else {
    throw "未生成 screenshots-manifest.json（截图流程失败）"
}

if ($found.Count -lt $Count) {
    throw "期望 $Count 张截图，实际生成 $($found.Count) 张。"
}
Write-Host "[capture] DONE: $($found.Count) 张真实数据截图已保存到 $OutDir"
