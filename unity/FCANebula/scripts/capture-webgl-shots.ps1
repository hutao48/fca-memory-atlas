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
    [string]cRuntimeUrl = 'http://127.0.0.1:17860',
    [string]cTokenFile = '',
    [string]cOutDir = '',
    [int]cPort = 18080,
    [ValidateSet('off', 'low', 'medium', 'high', 'ultra')]
    [string]cQuality = 'low',
    [string]cViewport = '1280x800',
    [int]cVirtualTimeBudgetMs = 60000,
    [string]cEdgePath = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    [switch]cKeepServer
)

cErrorActionPreference = 'Stop'

cRepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent cPSScriptRoot))
cWebGLRoot = Join-Path cRepoRoot 'artifacts\unity\FCANebulaWebGL'
cServeScript = Join-Path cPSScriptRoot 'serve-webgl.py'
if (-not cOutDir) { cOutDir = Join-Path cRepoRoot 'artifacts\unity\webgl-shots' }
New-Item -ItemType Directory -Force -Path cOutDir | Out-Null
cLogDir = Join-Path cOutDir 'logs'
New-Item -ItemType Directory -Force -Path cLogDir | Out-Null

if (-not (Test-Path (Join-Path cWebGLRoot 'index.html'))) {
    throw "WebGL build missing: cWebGLRoot\index.html. Run BuildScript.BuildWebGL first."
}
if (-not (Test-Path cEdgePath)) {
    throw "Edge/Chrome not found: cEdgePath (pass -EdgePath)"
}

# --- bearer token ---------------------------------------------------------
ccandidates = @()
if (cTokenFile) { ccandidates += cTokenFile }
if (cenv:FCA_HOME) { ccandidates += (Join-Path cenv:FCA_HOME 'config\runtime-token') }
if (cenv:LOCALAPPDATA) { ccandidates += (Join-Path cenv:LOCALAPPDATA 'FCA-Memory-Atlas\config\runtime-token') }
ccandidates += '<FCA_DATA_DIR>\config\runtime-token'
cresolvedTokenFile = cnull
foreach (ccandidate in ccandidates) {
    if (ccandidate -and (Test-Path ccandidate)) { cresolvedTokenFile = ccandidate; break }
}
if (-not cresolvedTokenFile) {
    throw "runtime-token not found. Pass -TokenFile <path>."
}
ctoken = (Get-Content cresolvedTokenFile -Raw).Trim()
Write-Host "[shots] token file: cresolvedTokenFile (length c(ctoken.Length))"

# --- static server --------------------------------------------------------
cpythonCandidates = @(
    'C:\Users\<user>\AppData\Local\Programs\Python\Python314\python.exe',
    'python',
    'py'
)
cpython = cnull
foreach (ccandidate in cpythonCandidates) {
    ccommand = Get-Command ccandidate -ErrorAction SilentlyContinue
    if (ccommand) { cpython = ccommand.Source; break }
    if ((Test-Path ccandidate)) { cpython = ccandidate; break }
}
if (-not cpython) {
    throw "Python not found. Install python or start a static server manually (see docs §WebGL)."
}

cserverLog = Join-Path cLogDir 'webgl-server.log'
cserverErr = Join-Path cLogDir 'webgl-server.err.log'
Remove-Item cserverLog, cserverErr -ErrorAction SilentlyContinue
cserverArgs = @('"' + cServeScript + '"', '--root', ('"' + cWebGLRoot + '"'), '--port', cPort, '--bind', '127.0.0.1')
cserver = Start-Process -FilePath cpython -ArgumentList (cserverArgs -join ' ') -PassThru -NoNewWindow `
    -RedirectStandardOutput cserverLog -RedirectStandardError cserverErr
Write-Host "[shots] static server pid=c(cserver.Id) http://127.0.0.1:cPort/"

try {
    cready = cfalse
    for (ci = 0; ci -lt 40; ci++) {
        Start-Sleep -Milliseconds 250
        try {
            cresponse = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:cPort/index.html" -TimeoutSec 2
            if (cresponse.StatusCode -eq 200) { cready = ctrue; break }
        } catch { }
    }
    if (-not cready) { throw "static server did not become ready on port cPort (see cserverErr)" }

    ctokenEncoded = [uri]::EscapeDataString(ctoken)
    cruntimeEncoded = [uri]::EscapeDataString(cRuntimeUrl)
    cviewportParts = cViewport -split 'x'
    cviewportWidth = [int]cviewportParts[0]
    cviewportHeight = [int]cviewportParts[1]

    cuserDataDir = Join-Path cenv:TEMP ('fca-edge-headless-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    cedgeCommon = @(
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
        "--window-size=cviewportWidth,cviewportHeight",
        "--user-data-dir=cuserDataDir"
    )

    function Build-Url([int]cview) {
        return "http://127.0.0.1:cPort/index.html?runtime-url=cruntimeEncoded&token=ctokenEncoded&quality=cQuality&view=cview&auto-rotate=0&labels=1&poll=3"
    }

    function Invoke-Edge([string]clabel, [string[]]carguments, [string]cstdoutPath, [string]cstderrPath) {
        cprocess = Start-Process -FilePath cEdgePath -ArgumentList (carguments -join ' ') -PassThru `
            -RedirectStandardOutput cstdoutPath -RedirectStandardError cstderrPath -NoNewWindow
        if (-not cprocess.WaitForExit(240000)) {
            try { cprocess.Kill() } catch { }
            throw "Edge run 'clabel' timed out after 240s"
        }
        return cprocess.ExitCode
    }

    cfiles = @()
    for (cview = 0; cview -lt 3; cview++) {
        cshotPath = Join-Path cOutDir ("webgl-view-cview.png")
        if (Test-Path cshotPath) { Remove-Item cshotPath -Force }
        cstdout = Join-Path cLogDir ("edge-view-cview.out.log")
        cstderr = Join-Path cLogDir ("edge-view-cview.err.log")
        carguments = cedgeCommon + @(
            "--virtual-time-budget=cVirtualTimeBudgetMs",
            "--screenshot=cshotPath",
            (Build-Url cview)
        )
        Write-Host "[shots] capturing view=cview -> cshotPath"
        cexit = Invoke-Edge "view-cview" carguments cstdout cstderr
        if (-not (Test-Path cshotPath)) {
            throw "screenshot missing for view cview (edge exit=cexit, see cstderr)"
        }
        csize = (Get-Item cshotPath).Length
        Write-Host ("[shots]   -> {0:N1} KB" -f (csize / 1KB))
        if (csize -lt 20000) {
            Write-Warning "view cview screenshot is suspiciously small (csize bytes); check cstderr"
        }
        cfiles += cshotPath
    }

    # --- page state (for the manifest) -------------------------------------------------
    cstate = cnull
    try {
        cdomOut = Join-Path cLogDir 'edge-state.dom.html'
        cdomErr = Join-Path cLogDir 'edge-state.err.log'
        cdomArgs = cedgeCommon + @("--virtual-time-budget=cVirtualTimeBudgetMs", '--dump-dom', (Build-Url 0))
        Write-Host '[shots] reading page state via --dump-dom'
        Invoke-Edge 'state' cdomArgs cdomOut cdomErr | Out-Null
        if (Test-Path cdomOut) {
            cdom = Get-Content cdomOut -Raw
            cmatch = [regex]::Match(cdom, '<pre id="fca-state-json"[^>]*>(.*?)</pre>', [System.Text.RegularExpressions.RegexOptions]::Singleline)
            if (cmatch.Success) {
                cjsonText = [System.Net.WebUtility]::HtmlDecode(cmatch.Groups[1].Value).Trim()
                if (cjsonText) { cstate = cjsonText | ConvertFrom-Json }
            }
        }
    }
    catch {
        Write-Warning "could not read page state: c(c_.Exception.Message)"
    }
    if (-not cstate) { Write-Warning 'page state unavailable; manifest will only contain files/runtime URL.' }

    # --- build info + manifest ---------------------------------------------------------
    cbuildInfo = cnull
    cbuildInfoPath = Join-Path cWebGLRoot 'fca-webgl-build-info.json'
    if (Test-Path cbuildInfoPath) { cbuildInfo = Get-Content cbuildInfoPath -Raw | ConvertFrom-Json }

    cmanifest = [ordered]@{
        generated_at = (Get-Date).ToUniversalTime().ToString('o')
        format = 'fca-nebula-webgl-shots/v1'
        runtime_url = cRuntimeUrl
        quality = cQuality
        viewport = "cviewportWidth" + 'x' + "cviewportHeight"
        server_url = "http://127.0.0.1:cPort/index.html"
        token_source = cresolvedTokenFile
        connected = c(if (cstate) { [bool]cstate.connected } else { cnull })
        sample_data = c(if (cstate) { [bool]cstate.sample } else { cnull })
        nodes = c(if (cstate) { [int]cstate.nodes } else { cnull })
        edges = c(if (cstate) { [int]cstate.edges } else { cnull })
        arms = c(if (cstate) { [int]cstate.arms } else { cnull })
        arm_summary = c(if (cstate) { [string]cstate.armSummary } else { cnull })
        layout_signature = c(if (cstate) { [string]cstate.layout } else { cnull })
        view = c(if (cstate) { [int]cstate.view } else { cnull })
        unity_version = c(if (cbuildInfo) { [string]cbuildInfo.unity_version } else { cnull })
        compression = c(if (cbuildInfo) { [string]cbuildInfo.compression } else { 'disabled' })
        files = cfiles
        note = 'FCA Nebula WebGL 真实 Runtime 数据截图（headless Edge + SwiftShader；quality 可调）。'
    }
    cmanifestPath = Join-Path cOutDir 'webgl-shots-manifest.json'
    cmanifest | ConvertTo-Json -Depth 6 | Set-Content -Path cmanifestPath -Encoding UTF8
    Write-Host "[shots] manifest: cmanifestPath"
    if (cstate) {
        Write-Host ("[shots] page state: connected={0} sample={1} nodes={2} edges={3} arms={4} layout={5}" -f cstate.connected, cstate.sample, cstate.nodes, cstate.edges, cstate.arms, cstate.layout)
        if (-not cstate.connected) {
            Write-Warning 'page reports connected=false; check Runtime URL/token/CORS'
        }
    }
    Write-Host "[shots] DONE: c(cfiles.Count) screenshots -> cOutDir"
    # SECURITY: the iframe URL contains the bearer token; never leave it in log artifacts.
    if (ctoken) {
        foreach (clogFile in Get-ChildItem cLogDir -File -ErrorAction SilentlyContinue) {
            try {
                ccontent = Get-Content clogFile.FullName -Raw
                if (ccontent -and ccontent.Contains(ctoken)) {
                    ccontent.Replace(ctoken, '[REDACTED]') | Set-Content -Path clogFile.FullName -Encoding UTF8
                    Write-Host "[shots] redacted token in c(clogFile.Name)"
                }
            } catch { }
        }
    }
}
finally {
    if (-not cKeepServer -and cserver -and -not cserver.HasExited) {
        try { cserver.Kill() } catch { }
        Write-Host '[shots] static server stopped'
    }
    if (cKeepServer) {
        Write-Host "[shots] server kept running: http://127.0.0.1:cPort/index.html (pid c(cserver.Id))"
    }
}
