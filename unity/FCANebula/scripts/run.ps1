# FCA Memory Atlas — Unity Nebula Renderer
# Launch the built standalone nebula window (real Runtime data).
#
# Usage:
#   pwsh -File unity/FCANebula/scripts/run.ps1
#   pwsh -File unity/FCANebula/scripts/run.ps1 -Quality ultra -AllowSample
#
# The executable resolves the bearer token automatically from
#   %LOCALAPPDATA%\FCA-Memory-Atlas\config\runtime-token   (default)
#   <fca-home>\config\runtime-token                         (via -FcaHome)
#   --token-file=<path>                                     (via -TokenFile)

[CmdletBinding()]
param(
    [string]$RuntimeUrl = 'http://127.0.0.1:17860',
    [string]$TokenFile = '',
    [string]$FcaHome = '',
    [ValidateSet('off', 'low', 'medium', 'high', 'ultra')]
    [string]$Quality = 'high',
    [switch]$AllowSample,
    [string[]]$Extra = @()
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$exe = Join-Path $RepoRoot 'artifacts\unity\FCANebula\FCANebula.exe'

if (-not (Test-Path $exe)) {
    throw "未找到 $exe。请先运行: pwsh -File unity/FCANebula/scripts/build.ps1"
}

$arguments = @("--runtime-url=$RuntimeUrl", "--quality=$Quality")
if ($TokenFile) { $arguments += "--token-file=$TokenFile" }
if ($FcaHome) { $arguments += "--fca-home=$FcaHome" }
if ($AllowSample) { $arguments += '--allow-sample' }
$arguments += $Extra

Write-Host "[run] $exe"
Write-Host "[run] args: $($arguments -join ' ')"
$quoted = @()
foreach ($argument in $arguments) {
    if ($argument -match '\s') { $quoted += ('"' + $argument + '"') } else { $quoted += $argument }
}
$proc = Start-Process -FilePath $exe -ArgumentList ($quoted -join ' ') -Wait -PassThru -WorkingDirectory (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
exit $proc.ExitCode
