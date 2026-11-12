# FCA Memory Atlas — Unity Nebula Renderer
# Build entry point (Built-in Render Pipeline, no URP packages required).
#
# Usage:
#   pwsh -File unity/FCANebula/scripts/build.ps1
#   pwsh -File unity/FCANebula/scripts/build.ps1 -UnityPath "C:\Program Files\Unity\Hub\Editor\6000.0.58f2\Editor\Unity.exe"
#
# Output (fixed path used by the Electron integration):
#   artifacts/unity/FCANebula/FCANebula.exe
#
# Logs: artifacts/unity/bootstrap.log, artifacts/unity/build.log, artifacts/unity/create-project.log

[CmdletBinding()]
param(
    [string]$UnityPath = "",
    [switch]$SkipBootstrap,
    [switch]$NoBuild,
    [switch]$WebGL
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot                 # unity/FCANebula
$RepoRoot = Split-Path -Parent (Split-Path -Parent $ProjectRoot) # repo root
$LogDir = Join-Path $RepoRoot 'artifacts\unity'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Get-UnityVersion([string]$exePath) {
    $info = (Get-Item $exePath).VersionInfo
    if ($info.ProductVersion -match '^\d{4}\.\d') {
        return ($info.ProductVersion -replace '\s.*$', '')
    }
    $versionDir = Split-Path -Parent (Split-Path -Parent $exePath)
    $leaf = Split-Path -Leaf $versionDir
    if ($leaf -match '^\d{4}\.') {
        return $leaf
    }
    return '6000.0.0f1'
}

function Quote-Arg([string]$value) {
    if ($null -eq $value) { return '""' }
    if ($value -match '\s') { return '"' + $value + '"' }
    return $value
}

function Resolve-UnityEditor {
    if ($UnityPath) {
        if (-not (Test-Path $UnityPath)) { throw "指定的 UnityPath 不存在: $UnityPath" }
        return (Resolve-Path $UnityPath).Path
    }
    if ($env:UNITY_PATH -and (Test-Path $env:UNITY_PATH)) {
        return (Resolve-Path $env:UNITY_PATH).Path
    }
    $candidates = @()
    $hubRoots = @(
        'C:\Program Files\Unity\Hub\Editor',
        'D:\Unity\Hub\Editor',
        'C:\Program Files\Unity\Editor'
    )
    foreach ($hubRoot in $hubRoots) {
        if (-not (Test-Path $hubRoot)) { continue }
        $dirs = Get-ChildItem $hubRoot -Directory -ErrorAction SilentlyContinue | Sort-Object {
            $v = ($_.Name -replace '[a-zA-Z].*$', '')
            try { [version]$v } catch { [version]'0.0' }
        } -Descending
        foreach ($dir in $dirs) {
            $exe = Join-Path $dir.FullName 'Editor\Unity.exe'
            if (Test-Path $exe) { $candidates += $exe }
        }
    }
    $extraRoots = @('C:\Program Files\Unity', 'C:\Program Files (x86)\Unity', 'D:\Unity', 'D:\Program Files\Unity')
    foreach ($root in $extraRoots) {
        if (-not (Test-Path $root)) { continue }
        $found = Get-ChildItem $root -Filter 'Unity.exe' -Recurse -Depth 4 -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notmatch 'Hub\\Editor' } |
            Select-Object -First 1
        if ($found) { $candidates += $found.FullName }
    }
    if ($candidates.Count -eq 0) {
        throw @"
未找到 Unity Editor。请先安装 Unity 6 LTS（Unity Hub -> Installs），然后重新运行本脚本。
也可以显式指定：
  pwsh -File unity/FCANebula/scripts/build.ps1 -UnityPath "C:\Program Files\Unity\Hub\Editor\<版本>\Editor\Unity.exe"
或设置环境变量 UNITY_PATH。
"@
    }
    return $candidates[0]
}

$unity = Resolve-UnityEditor
$editorVersion = Get-UnityVersion $unity
Write-Host "[build] Unity: $unity"
Write-Host "[build] Version: $editorVersion"
Write-Host "[build] Project: $ProjectRoot"
Write-Host "[build] Repo: $RepoRoot"

# ---------------------------------------------------------------------------
# 1) Ensure the Unity project skeleton (ProjectSettings) exists.
#    We create a pristine project in %TEMP% with the installed editor and copy its
#    ProjectSettings over, keeping our checked-in Assets/ and Packages/.
# ---------------------------------------------------------------------------
$projectSettingsAsset = Join-Path $ProjectRoot 'ProjectSettings\ProjectSettings.asset'
if (-not (Test-Path $projectSettingsAsset)) {
    Write-Host '[build] ProjectSettings missing -> creating pristine Unity project in temp...'
    $tempProject = Join-Path $env:TEMP ('fca-unity-init-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $createLog = Join-Path $LogDir 'create-project.log'
    $createArgs = @('-batchmode', '-quit', '-createProject', (Quote-Arg $tempProject), '-logFile', (Quote-Arg $createLog))
    $createProc = Start-Process -FilePath $unity -ArgumentList ($createArgs -join ' ') -Wait -PassThru -NoNewWindow
    $createExit = $createProc.ExitCode
    if ($createExit -ne 0) {
        if (Test-Path $createLog) { Get-Content $createLog -Tail 40 }
        throw "Unity -createProject 失败 (exit $createExit)。日志: $createLog"
    }
    $tempSettings = Join-Path $tempProject 'ProjectSettings\ProjectSettings.asset'
    if (-not (Test-Path $tempSettings)) {
        throw "Unity -createProject 没有生成 ProjectSettings.asset。日志: $createLog"
    }
    $dstSettings = Join-Path $ProjectRoot 'ProjectSettings'
    New-Item -ItemType Directory -Force -Path $dstSettings | Out-Null
    Copy-Item (Join-Path $tempProject 'ProjectSettings\*') $dstSettings -Recurse -Force
    Remove-Item $tempProject -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host '[build] 已复制默认 ProjectSettings（Built-in Render Pipeline，无 URP）。'
}

# Pin ProjectVersion.txt to the installed editor (avoids upgrade dialogs).
$versionFile = Join-Path $ProjectRoot 'ProjectSettings\ProjectVersion.txt'
$lines = @("m_EditorVersion: $editorVersion", "m_EditorVersionWithRevision: $editorVersion (installed)")
[System.IO.File]::WriteAllLines($versionFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[build] ProjectVersion.txt -> $editorVersion"

function Invoke-UnityMethod([string]$name, [string]$method, [string]$BuildTarget = '') {
    $log = Join-Path $LogDir ($name + '.log')
    if (Test-Path $log) { Remove-Item $log -Force -ErrorAction SilentlyContinue }
    Write-Host "[build] $name -> $method ..."
    Write-Host "[build]    log: $log"
    $unityArgs = @('-batchmode', '-quit', '-projectPath', (Quote-Arg $ProjectRoot), '-executeMethod', $method, '-logFile', (Quote-Arg $log))
    if ($BuildTarget) {
        # Unity switches the active build target from the command line before executeMethod;
        # switching inside executeMethod is not supported in batchmode.
        $unityArgs = @('-batchmode', '-quit', '-buildTarget', $BuildTarget, '-projectPath', (Quote-Arg $ProjectRoot), '-executeMethod', $method, '-logFile', (Quote-Arg $log))
    }
    # Unity.exe is a GUI-subsystem executable: PowerShell '&' does not wait for it.
    # Start-Process -Wait is required, otherwise the script would exit while Unity still builds.
    $proc = Start-Process -FilePath $unity -ArgumentList ($unityArgs -join ' ') -Wait -PassThru -NoNewWindow
    $code = $proc.ExitCode
    if ($code -ne 0) {
        if (Test-Path $log) {
            Write-Host '---- last 60 log lines ----'
            Get-Content $log -Tail 60
            Write-Host '---------------------------'
        }
        throw "Unity $name 失败 (exit $code)。完整日志: $log"
    }
    Write-Host "[build] $name OK"
}

# ---------------------------------------------------------------------------
# 2) Bootstrap materials / scene / PlayerSettings, then build the standalone player.
# ---------------------------------------------------------------------------
if (-not $SkipBootstrap) {
    Invoke-UnityMethod 'bootstrap' 'FCANebula.EditorTools.ProjectBootstrap.BootstrapAll'
}
if (-not $NoBuild) {
    if ($WebGL) {
        Invoke-UnityMethod 'webgl-build' 'FCANebula.EditorTools.BuildScript.BuildWebGL' -BuildTarget 'WebGL'
    }
    else {
        Invoke-UnityMethod 'build' 'FCANebula.EditorTools.BuildScript.BuildWindows'
    }
}

if ($WebGL) {
    $webglIndex = Join-Path $RepoRoot 'artifacts\unity\FCANebulaWebGL\index.html'
    if (-not $NoBuild) {
        if (-not (Test-Path $webglIndex)) {
            throw "WebGL 构建结束但未找到: $webglIndex"
        }
        $totalMb = [math]::Round(((Get-ChildItem (Split-Path -Parent $webglIndex) -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 2)
        Write-Host ''
        Write-Host ("[build] WEBGL BUILD OK: {0} (total {1} MB)" -f $webglIndex, $totalMb)
        Write-Host '[build] 下一步：用 unity/FCANebula/scripts/serve-webgl.py 提供本地静态服务，或直接给 Electron 内嵌。'
    }
    else {
        Write-Host '[build] NoBuild 模式：跳过 WebGL 产物检查。'
    }
}
else {
    $exe = Join-Path $RepoRoot 'artifacts\unity\FCANebula\FCANebula.exe'
    if (-not $NoBuild) {
        if (-not (Test-Path $exe)) {
            throw "构建结束但未找到 exe: $exe"
        }
        $sizeMb = (Get-Item $exe).Length / 1MB
        Write-Host ''
        Write-Host ("[build] BUILD OK: {0} ({1:N1} MB)" -f $exe, $sizeMb)
        Write-Host '[build] 下一步：pwsh -File unity/FCANebula/scripts/capture-screenshots.ps1'
    }
    else {
        Write-Host '[build] NoBuild 模式：跳过 exe 检查。'
    }
}
