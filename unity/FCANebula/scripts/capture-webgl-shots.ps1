# FCA Memory Atlas — Unity WebGL acceptance screenshots
# Serves the WebGL build with the bundled Python static server and captures the three
# acceptance views (overview / workspace-arm / top-down) with headless Edge/Chrome.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File unity/FCANebula/scripts/capture-webgl-shots.ps1
#   ... -RuntimeUrl http://127.0.0.1:17860 -TokenFile <FCA_DATA_DIR>\config\runtime-token
#   ... -Port 18080 -Quality low -Viewport 1280x800 -VirtualTimeBudgetMs 60000
#
# Output: artifacts/unity/webgl-shots/ (webgl-view-0..2.png + webgl-shots-manifest.json + logs)
#
# IMPORTANT: the page needs a real WebGL context. Headless Edge uses SwiftShader in software,
# so keep the viewport and quality modest while capturing.

[CmdletBinding()]
param(
    [string]$RuntimeUrl = 'http://127.0.0.1:17860',
    [string]$TokenFile = '',
    [string]$OutDir = '',
    [int]$Port = 18080,
    [ValidateSet('off', 'low', 'medium', 'high', 'ultra')]
    [string]$Quality = 'low',
    [string]$Viewport = '1280x800',
    [int]$VirtualTimeBudgetMs = 60000,
    [string]$EdgePath = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    [switch]$KeepServer
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$WebGLRoot = Join-Path $RepoRoot 'artifacts\unity\FCANebulaWebGL'
$ServeScript = Join-Path $PSScriptRoot 'serve-webgl.py'
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot 'artifacts\unity\webgl-shots' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$LogDir = Join-Path $OutDir 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not (Test-Path (Join-Path $WebGLRoot 'index.html'))) {
    throw "WebGL build missing: $WebGLRoot\index.html. Run BuildScript.BuildWebGL first."
}
if (-not (Test-Path $EdgePath)) {
    throw "Edge/Chrome not found: $EdgePath (pass -EdgePath)"
}

# --- bearer token ---------------------------------------------------------
$candidates = @()
if ($TokenFile) { $candidates += $TokenFile }
if ($env:FCA_HOME) { $candidates += (Join-Path $env:FCA_HOME 'config\runtime-token') }
if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'FCA-Memory-Atlas\config\runtime-token') }
$candidates += (Join-Path $env:LOCALAPPDATA 'FCA-Memory-Atlas\config\runtime-token')
$resolvedTokenFile = $null
foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { $resolvedTokenFile = $candidate; break }
}
if (-not $resolvedTokenFile) {
    throw "runtime-token not found. Pass -TokenFile <path>."
}
$token = (Get-Content $resolvedTokenFile -Raw).Trim()
Write-Host "[shots] token file: $resolvedTokenFile (length $($token.Length))"

# --- static server --------------------------------------------------------
$pythonCandidates = @(
    'C:\Users\<user>\AppData\Local\Programs\Python\Python314\python.exe',
    'python',
    'py'
)
$python = $null
foreach ($candidate in $pythonCandidates) {
    $command = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($command) { $python = $command.Source; break }
    if ((Test-Path $candidate)) { $python = $candidate; break }
}
if (-not $python) {
    throw "Python not found. Install python or start a static server manually (see docs §WebGL)."
}

$serverLog = Join-Path $LogDir 'webgl-server.log'
$serverErr = Join-Path $LogDir 'webgl-server.err.log'
Remove-Item $serverLog, $serverErr -ErrorAction SilentlyContinue
$serverArgs = @('"' + $ServeScript + '"', '--root', ('"' + $WebGLRoot + '"'), '--port', $Port, '--bind', '127.0.0.1')
$server = Start-Process -FilePath $python -ArgumentList ($serverArgs -join ' ') -PassThru -NoNewWindow `
    -RedirectStandardOutput $serverLog -RedirectStandardError $serverErr
Write-Host "[shots] static server pid=$($server.Id) http://127.0.0.1:$Port/"

try {
    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 250
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/index.html" -TimeoutSec 2
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch { }
    }
    if (-not $ready) { throw "static server did not become ready on port $Port (see $serverErr)" }

    $tokenEncoded = [uri]::EscapeDataString($token)
    $runtimeEncoded = [uri]::EscapeDataString($RuntimeUrl)
    $viewportParts = $Viewport -split 'x'
    $viewportWidth = [int]$viewportParts[0]
    $viewportHeight = [int]$viewportParts[1]

    $userDataDir = Join-Path $env:TEMP ('fca-edge-headless-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $edgeCommon = @(
        '--headless=new',
        '--no-sandbox',
        '--no-first-run',
        '--disable-background-networking',
        '--disable-sync',
        '--hide-scrollbars',
        '--mute-audio',
        '--enable-unsafe-swiftshader',
        '--use-angle=swiftshader',
        '--ignore-gpu-blocklist',
        '--enable-webgl',
        "--window-size=$viewportWidth,$viewportHeight",
        "--user-data-dir=$userDataDir"
    )

    function Build-Url([int]$view) {
        return "http://127.0.0.1:$Port/index.html?runtime-url=$runtimeEncoded&token=$tokenEncoded&quality=$Quality&view=$view&auto-rotate=0&labels=1&poll=3"
    }

    function Invoke-Edge([string]$label, [string[]]$arguments, [string]$stdoutPath, [string]$stderrPath) {
        $process = Start-Process -FilePath $EdgePath -ArgumentList ($arguments -join ' ') -PassThru `
            -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -NoNewWindow
        if (-not $process.WaitForExit(240000)) {
            try { $process.Kill() } catch { }
            throw "Edge run '$label' timed out after 240s"
        }
        return $process.ExitCode
    }

    $files = @()
    for ($view = 0; $view -lt 3; $view++) {
        $shotPath = Join-Path $OutDir ("webgl-view-$view.png")
        if (Test-Path $shotPath) { Remove-Item $shotPath -Force }
        $stdout = Join-Path $LogDir ("edge-view-$view.out.log")
        $stderr = Join-Path $LogDir ("edge-view-$view.err.log")
        $arguments = $edgeCommon + @(
            "--virtual-time-budget=$VirtualTimeBudgetMs",
            "--screenshot=$shotPath",
            (Build-Url $view)
        )
        Write-Host "[shots] capturing view=$view -> $shotPath"
        $exit = Invoke-Edge "view-$view" $arguments $stdout $stderr
        if (-not (Test-Path $shotPath)) {
            throw "screenshot missing for view $view (edge exit=$exit, see $stderr)"
        }
        $size = (Get-Item $shotPath).Length
        Write-Host ("[shots]   -> {0:N1} KB" -f ($size / 1KB))
        if ($size -lt 20000) {
            Write-Warning "view $view screenshot is suspiciously small ($size bytes); check $stderr"
        }
        $files += $shotPath
    }

    # --- page state (for the manifest) -------------------------------------------------
    $state = $null
    try {
        $domOut = Join-Path $LogDir 'edge-state.dom.html'
        $domErr = Join-Path $LogDir 'edge-state.err.log'
        $domArgs = $edgeCommon + @("--virtual-time-budget=$VirtualTimeBudgetMs", '--dump-dom', (Build-Url 0))
        Write-Host '[shots] reading page state via --dump-dom'
        Invoke-Edge 'state' $domArgs $domOut $domErr | Out-Null
        if (Test-Path $domOut) {
            $dom = Get-Content $domOut -Raw
            $match = [regex]::Match($dom, '<pre id="fca-state-json"[^>]*>(.*?)</pre>', [System.Text.RegularExpressions.RegexOptions]::Singleline)
            if ($match.Success) {
                $jsonText = [System.Net.WebUtility]::HtmlDecode($match.Groups[1].Value).Trim()
                if ($jsonText) { $state = $jsonText | ConvertFrom-Json }
            }
        }
    }
    catch {
        Write-Warning "could not read page state: $($_.Exception.Message)"
    }
    if (-not $state) { Write-Warning 'page state unavailable; manifest will only contain files/runtime URL.' }

    # --- build info + manifest ---------------------------------------------------------
    $buildInfo = $null
    $buildInfoPath = Join-Path $WebGLRoot 'fca-webgl-build-info.json'
    if (Test-Path $buildInfoPath) { $buildInfo = Get-Content $buildInfoPath -Raw | ConvertFrom-Json }

    $manifest = [ordered]@{
        generated_at = (Get-Date).ToUniversalTime().ToString('o')
        format = 'fca-nebula-webgl-shots/v1'
        runtime_url = $RuntimeUrl
        quality = $Quality
        viewport = "$viewportWidth" + 'x' + "$viewportHeight"
        server_url = "http://127.0.0.1:$Port/index.html"
        token_source = $resolvedTokenFile
        connected = $(if ($state) { [bool]$state.connected } else { $null })
        sample_data = $(if ($state) { [bool]$state.sample } else { $null })
        nodes = $(if ($state) { [int]$state.nodes } else { $null })
        edges = $(if ($state) { [int]$state.edges } else { $null })
        arms = $(if ($state) { [int]$state.arms } else { $null })
        arm_summary = $(if ($state) { [string]$state.armSummary } else { $null })
        layout_signature = $(if ($state) { [string]$state.layout } else { $null })
        view = $(if ($state) { [int]$state.view } else { $null })
        unity_version = $(if ($buildInfo) { [string]$buildInfo.unity_version } else { $null })
        compression = $(if ($buildInfo) { [string]$buildInfo.compression } else { 'disabled' })
        files = $files
        note = 'FCA Nebula WebGL 真实 Runtime 数据截图（headless Edge + SwiftShader；quality 可调）。'
    }
    $manifestPath = Join-Path $OutDir 'webgl-shots-manifest.json'
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestPath -Encoding UTF8
    Write-Host "[shots] manifest: $manifestPath"
    if ($state) {
        Write-Host ("[shots] page state: connected={0} sample={1} nodes={2} edges={3} arms={4} layout={5}" -f $state.connected, $state.sample, $state.nodes, $state.edges, $state.arms, $state.layout)
        if (-not $state.connected) {
            Write-Warning 'page reports connected=false; check Runtime URL/token/CORS'
        }
    }
    Write-Host "[shots] DONE: $($files.Count) screenshots -> $OutDir"
    # SECURITY: the iframe URL contains the bearer token; never leave it in log artifacts.
    if ($token) {
        foreach ($logFile in Get-ChildItem $LogDir -File -ErrorAction SilentlyContinue) {
            try {
                $content = Get-Content $logFile.FullName -Raw
                if ($content -and $content.Contains($token)) {
                    $content.Replace($token, '[REDACTED]') | Set-Content -Path $logFile.FullName -Encoding UTF8
                    Write-Host "[shots] redacted token in $($logFile.Name)"
                }
            } catch { }
        }
    }
}
finally {
    if (-not $KeepServer -and $server -and -not $server.HasExited) {
        try { $server.Kill() } catch { }
        Write-Host '[shots] static server stopped'
    }
    if ($KeepServer) {
        Write-Host "[shots] server kept running: http://127.0.0.1:$Port/index.html (pid $($server.Id))"
    }
}
