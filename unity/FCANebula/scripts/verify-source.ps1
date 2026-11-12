# FCA Memory Atlas — Unity Nebula Renderer
# Static self-check for the Unity project (used while no Unity Editor is available):
#   - required files present
#   - C# / Shader brace + paren balance (string/comment aware)
#   - no C# 10+ syntax that Unity 6's C# 9 compiler would reject
#   - no URP/HDRP references (project is Built-in Render Pipeline)
#   - JSON validity (manifest + sample graph)
#   - sample graph contains workspace:<label> tags for arm grouping
#   - workspace shader uniforms / editor entry points exist
#
# Usage: pwsh -File unity/FCANebula/scripts/verify-source.ps1
# Exit code 0 = all checks passed.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent (Split-Path -Parent $ProjectRoot)
$failures = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]
$checks = 0

function Fail([string]$message) {
    $script:failures.Add($message)
    Write-Host "[FAIL] $message" -ForegroundColor Red
}
function Warn([string]$message) {
    $script:warnings.Add($message)
    Write-Host "[WARN] $message" -ForegroundColor Yellow
}
function Ok([string]$message) {
    $script:checks++
    Write-Host "[ ok ] $message" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 1) Required files
# ---------------------------------------------------------------------------
$required = @(
    'Assets\Scripts\Core\AppConfig.cs',
    'Assets\Scripts\Core\AppPaths.cs',
    'Assets\Scripts\Core\ThemePalette.cs',
    'Assets\Scripts\Data\FcaGraphDto.cs',
    'Assets\Scripts\Data\FcaApiClient.cs',
    'Assets\Scripts\Layout\WorkspaceSpiralLayout.cs',
    'Assets\Scripts\Layout\NebulaCameraRig.cs',
    'Assets\Scripts\Render\NebulaFieldRenderer.cs',
    'Assets\Scripts\Render\NodeRenderer.cs',
    'Assets\Scripts\Render\EdgeRenderer.cs',
    'Assets\Scripts\UI\UiOverlay.cs',
    'Assets\Scripts\NebulaApp.cs',
    'Assets\Scripts\NebulaBootstrap.cs',
    'Assets\Scripts\ScreenshotRunner.cs',
    'Assets\Shaders\NebulaVolume.shader',
    'Assets\Shaders\NodeStar.shader',
    'Assets\Shaders\EdgeFilament.shader',
    'Assets\Shaders\NebulaPost.shader',
    'Assets\Editor\ProjectBootstrap.cs',
    'Assets\Editor\BuildScript.cs',
    'Assets\Plugins\WebGL\FCABridge.jslib',
    'Assets\Scripts\WebGL\WebGLBridge.cs',
    'Assets\WebGLTemplates\FCANebula\index.html',
    'Assets\Resources\Fonts\NotoSansSC-VF.ttf',
    'Assets\StreamingAssets\sample-graph.json',
    'Packages\manifest.json',
    'ProjectSettings\ProjectVersion.txt',
    'scripts\build.ps1',
    'scripts\run.ps1',
    'scripts\capture-screenshots.ps1',
    'scripts\serve-webgl.py',
    'scripts\capture-webgl-cdp.mjs',
    'scripts\capture-webgl-shots.ps1',
    'scripts\export-sample.ps1'
)
$missing = @()
foreach ($relative in $required) {
    $full = Join-Path $ProjectRoot $relative
    if (-not (Test-Path $full)) {
        $missing += $relative
        Fail "缺少文件: $relative"
    }
}
if ($missing.Count -eq 0) { Ok "文件清单完整（$($required.Count) 个）" }

# ---------------------------------------------------------------------------
# 2) Source scannner: balance braces/parens/brackets outside strings & comments
# ---------------------------------------------------------------------------
function Test-Balance([string]$path) {
    $text = [System.IO.File]::ReadAllText($path)
    $brace = 0; $paren = 0; $bracket = 0
    $inString = $false; $inChar = $false; $inLineComment = $false; $inBlockComment = $false
    $verbatim = $false; $escaped = $false
    $line = 1
    for ($i = 0; $i -lt $text.Length; $i++) {
        $c = $text[$i]
        $n = if ($i + 1 -lt $text.Length) { $text[$i + 1] } else { [char]0 }
        if ($c -eq "`n") { $line++ }
        if ($inLineComment) {
            if ($c -eq "`n") { $inLineComment = $false }
            continue
        }
        if ($inBlockComment) {
            if ($c -eq '*' -and $n -eq '/') { $inBlockComment = $false; $i++ }
            continue
        }
        if ($inString) {
            if ($verbatim) {
                if ($c -eq '"' -and $n -eq '"') { $i++; continue }
                if ($c -eq '"') { $inString = $false; $verbatim = $false }
                continue
            }
            if ($escaped) { $escaped = $false; continue }
            if ($c -eq '\') { $escaped = $true; continue }
            if ($c -eq '"') { $inString = $false }
            continue
        }
        if ($inChar) {
            if ($escaped) { $escaped = $false; continue }
            if ($c -eq '\') { $escaped = $true; continue }
            if ($c -eq "'") { $inChar = $false }
            continue
        }
        if ($c -eq '/' -and $n -eq '/') { $inLineComment = $true; $i++; continue }
        if ($c -eq '/' -and $n -eq '*') { $inBlockComment = $true; $i++; continue }
        if ($c -eq '@' -and $n -eq '"') { $inString = $true; $verbatim = $true; $i++; continue }
        if ($c -eq '"') { $inString = $true; continue }
        if ($c -eq "'") { $inChar = $true; continue }
        switch ($c) {
            '{' { $brace++ }
            '}' { $brace-- }
            '(' { $paren++ }
            ')' { $paren-- }
            '[' { $bracket++ }
            ']' { $bracket-- }
        }
        if ($brace -lt 0 -or $paren -lt 0 -or $bracket -lt 0) {
            return "第 $line 行出现多余的 } / ) / ]"
        }
    }
    if ($brace -ne 0) { return "花括号不平衡（剩余 $brace）" }
    if ($paren -ne 0) { return "圆括号不平衡（剩余 $paren）" }
    if ($bracket -ne 0) { return "方括号不平衡（剩余 $bracket）" }
    if ($inString) { return '存在未闭合的字符串' }
    return $null
}

$csFiles = Get-ChildItem (Join-Path $ProjectRoot 'Assets') -Filter '*.cs' -Recurse
$shaderFiles = Get-ChildItem (Join-Path $ProjectRoot 'Assets') -Filter '*.shader' -Recurse
$psFiles = Get-ChildItem (Join-Path $ProjectRoot 'scripts') -Filter '*.ps1'
$bad = 0
foreach ($file in $csFiles) {
    $problem = Test-Balance $file.FullName
    if ($problem) { $bad++; Fail "括号不平衡: $($file.Name) -> $problem" }
}
if ($bad -eq 0) { Ok "C# 文件括号/字符串平衡（$($csFiles.Count) 个文件，共 $((($csFiles | Get-Content | Measure-Object -Line).Lines)) 行）" }

# ---------------------------------------------------------------------------
# 3) C# 10+ syntax that a Unity 6 (C# 9) compiler rejects
# ---------------------------------------------------------------------------
$bannedPatterns = @(
    @{ Name = 'file-scoped namespace'; Pattern = '(?m)^\s*namespace\s+[\w\.]+\s*;\s*$' },
    @{ Name = 'global using'; Pattern = '(?m)^\s*global\s+using\s' },
    @{ Name = 'file-local type'; Pattern = '\bfile\s+(sealed\s+|static\s+|abstract\s+)?(class|struct|record|interface|enum)\s' },
    @{ Name = 'record type'; Pattern = '\brecord\s+(class|struct|\w+\s*\()' },
    @{ Name = 'required member'; Pattern = '\brequired\s+[A-Za-z_][A-Za-z0-9_<>,\.\?\[\]]*\s+[A-Za-z_][A-Za-z0-9_]*\s*[\{=]' },
    @{ Name = 'raw string literal'; Pattern = '"""' }
)
$syntaxFailures = 0
foreach ($file in $csFiles) {
    $content = [System.IO.File]::ReadAllText($file.FullName)
    foreach ($rule in $bannedPatterns) {
        if ($content -match $rule.Pattern) {
            $syntaxFailures++
            Fail "疑似 C# 10+ 语法（Unity 6 编译器不支持）: $($file.Name) -> $($rule.Name)"
        }
    }
}
if ($syntaxFailures -eq 0) { Ok '无 C# 10+ 语法（file-scoped namespace / record / raw string 等）' }

# ---------------------------------------------------------------------------
# 4) Built-in RP: no URP/HDRP references
# ---------------------------------------------------------------------------
$pipelineHits = Select-String -Path ($csFiles + $shaderFiles).FullName -Pattern 'Universal\s*RenderPipeline|UnityEngine\.Rendering\.Universal|HDRenderPipeline|ScriptableRenderPipeline' -AllMatches -ErrorAction SilentlyContinue
if ($pipelineHits) {
    Fail "发现 SRP（URP/HDRP）引用，但本项目固定 Built-in RP: $($pipelineHits[0].Path):$($pipelineHits[0].LineNumber)"
}
else {
    Ok '无 URP/HDRP 依赖（Built-in Render Pipeline）'
}

# ---------------------------------------------------------------------------
# 5) Shader checks
# ---------------------------------------------------------------------------
$volumeShader = Get-Content (Join-Path $ProjectRoot 'Assets\Shaders\NebulaVolume.shader') -Raw
if ($volumeShader -notmatch '_ArmColors\s*\[\s*MAX_ARMS\s*\]') { Fail 'NebulaVolume.shader 缺少 _ArmColors[MAX_ARMS] 数组' } else { Ok 'NebulaVolume: 旋臂 uniform 数组存在' }
if ($volumeShader -notmatch 'exp\(pitch\s*\*\s*rel\)') { Fail 'NebulaVolume.shader 缺少对数螺旋 r = r0*exp(b*theta) 公式' } else { Ok 'NebulaVolume: 对数螺旋密度公式存在' }
if ($volumeShader -notmatch 'fbm\(') { Fail 'NebulaVolume.shader 缺少 fbm 噪声' } else { Ok 'NebulaVolume: fbm 体积噪声存在' }
$cgOpen = ([regex]::Matches($volumeShader, 'CGPROGRAM')).Count
$cgClose = ([regex]::Matches($volumeShader, 'ENDCG')).Count
if ($cgOpen -ne $cgClose) { Fail "NebulaVolume.shader CGPROGRAM/ENDCG 不匹配 ($cgOpen/$cgClose)" } else { Ok 'NebulaVolume: CGPROGRAM/ENDCG 配对' }
foreach ($file in $shaderFiles) {
    $content = [System.IO.File]::ReadAllText($file.FullName)
    $open = ([regex]::Matches($content, 'CGPROGRAM')).Count
    $close = ([regex]::Matches($content, 'ENDCG')).Count
    if ($open -ne $close) { Fail "$($file.Name): CGPROGRAM/ENDCG 不匹配 ($open/$close)" }
    if ($content -notmatch '#pragma\s+target') { Warn "$($file.Name): 没有 #pragma target" }
    $problem = Test-Balance $file.FullName
    if ($problem) { Fail "Shader 括号不平衡: $($file.Name) -> $problem" }
}
if (($failures | Where-Object { $_ -like '*CGPROGRAM*' }).Count -eq 0) { Ok '全部 Shader: CGPROGRAM/ENDCG 配对且括号平衡' }

# ---------------------------------------------------------------------------
# 6) JSON validity
# ---------------------------------------------------------------------------
$jsonFiles = @(
    (Join-Path $ProjectRoot 'Packages\manifest.json'),
    (Join-Path $ProjectRoot 'Assets\StreamingAssets\sample-graph.json')
)
foreach ($jsonFile in $jsonFiles) {
    if (-not (Test-Path $jsonFile)) { continue }
    try {
        $parsed = Get-Content $jsonFile -Raw | ConvertFrom-Json
        Ok "JSON 有效: $(Split-Path -Leaf $jsonFile)"
    }
    catch {
        Fail "JSON 解析失败: $jsonFile -> $($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------------------
# 7) Sample graph must contain workspace tags for arm grouping
# ---------------------------------------------------------------------------
$samplePath = Join-Path $ProjectRoot 'Assets\StreamingAssets\sample-graph.json'
$artifactSample = Join-Path $RepoRoot 'artifacts\unity\sample-graph.json'
if (Test-Path $samplePath) {
    $sample = Get-Content $samplePath -Raw | ConvertFrom-Json
    $workspaceTags = @()
    $defaultNodes = 0
    foreach ($node in @($sample.nodes)) {
        $hasWorkspace = $false
        foreach ($tag in @($node.tags)) {
            if ($tag -match '^workspace:(.+)$') {
                $hasWorkspace = $true
                if ($workspaceTags -notcontains $matches[1]) { $workspaceTags += $matches[1] }
            }
        }
        if (-not $hasWorkspace) { $defaultNodes++ }
    }
    if ($workspaceTags.Count -ge 1) {
        Ok "样例数据包含 $($workspaceTags.Count) 个 workspace 分组: $($workspaceTags -join ', ')"
    }
    else {
        Fail "样例数据没有任何 workspace:<label> 标签，无法演示工作区旋臂"
    }
    Ok "样例数据节点数: $(@($sample.nodes).Count)（其中 $defaultNodes 个归 default 旋臂）"
    if ($defaultNodes -eq 0) {
        Warn '样例数据没有 default 旋臂节点；若真实数据中存在无 workspace 标签的节点（如 entity），预览将缺少 default 臂示例。'
    }
    if (Test-Path $artifactSample) {
        $artifactHash = (Get-FileHash $artifactSample).Hash
        $streamHash = (Get-FileHash $samplePath).Hash
        if ($artifactHash -ne $streamHash) { Warn 'artifacts/unity/sample-graph.json 与 StreamingAssets 版本不一致（重新运行 export-sample.ps1）' } else { Ok 'artifacts 与 StreamingAssets 的 sample-graph.json 一致' }
    }
}

# ---------------------------------------------------------------------------
# 8) Editor entry points & workspace grouping implementation
# ---------------------------------------------------------------------------
$bootstrap = Get-Content (Join-Path $ProjectRoot 'Assets\Editor\ProjectBootstrap.cs') -Raw
$build = Get-Content (Join-Path $ProjectRoot 'Assets\Editor\BuildScript.cs') -Raw
if ($bootstrap -notmatch 'static\s+void\s+BootstrapAll') { Fail 'ProjectBootstrap.BootstrapAll 缺失' } else { Ok 'Editor 入口: ProjectBootstrap.BootstrapAll' }
if ($build -notmatch 'static\s+void\s+BuildWindows') { Fail 'BuildScript.BuildWindows 缺失' } else { Ok 'Editor 入口: BuildScript.BuildWindows' }
if ($build -notmatch 'static\s+void\s+BuildWebGL') { Fail 'BuildScript.BuildWebGL 缺失' } else { Ok 'Editor 入口: BuildScript.BuildWebGL（WebGL 内嵌主路径）' }
if ($build -notmatch 'FCANebulaWebGL') { Fail 'BuildScript 未固定 WebGL 输出目录 artifacts/unity/FCANebulaWebGL' } else { Ok 'WebGL 输出目录 artifacts/unity/FCANebulaWebGL 已固定' }
if ($build -notmatch 'WebGLCompressionFormat\.Disabled') { Fail 'WebGL 构建未将 compressionFormat 设为 Disabled' } else { Ok 'WebGL compression=Disabled（本地静态服务零配置）' }
if ($build -notmatch 'PROJECT:FCANebula') { Fail 'WebGL 未指定自定义模板 PROJECT:FCANebula' } else { Ok 'WebGL 自定义模板 PROJECT:FCANebula 已配置' }
if ($build -notmatch 'WebGL\.memorySize') { Fail 'WebGL 未配置 memorySize' } else { Ok 'WebGL memorySize 已配置（512MB）' }

$layout = Get-Content (Join-Path $ProjectRoot 'Assets\Scripts\Layout\WorkspaceSpiralLayout.cs') -Raw
if ($layout -notmatch 'workspace:') { Fail 'WorkspaceSpiralLayout 未按 workspace: 前缀解析 tag' } else { Ok '旋臂分组读取 workspace:<label> tag' }
if ($layout -notmatch 'DefaultArmLabel') { Fail 'WorkspaceSpiralLayout 缺少 default 旋臂处理' } else { Ok '无 workspace tag 的节点归 default 旋臂' }

# ---------------------------------------------------------------------------
# 8.1) WebGL deliverable contract (query parsing / bridge / template / font)
# ---------------------------------------------------------------------------
$appConfig = Get-Content (Join-Path $ProjectRoot 'Assets\Scripts\Core\AppConfig.cs') -Raw
if ($appConfig -notmatch 'Application\.absoluteURL') { Fail 'AppConfig 未从 Application.absoluteURL 读取 WebGL query' } else { Ok 'WebGL: 从 Application.absoluteURL 解析 runtime-url/token/quality/view' }
if ($appConfig -notmatch 'ApplyWebGLQuery') { Fail 'AppConfig 缺少 ApplyWebGLQuery' } else { Ok 'WebGL: ApplyWebGLQuery 已实现' }
if ($appConfig -notmatch '#if\s+UNITY_WEBGL') { Fail 'AppConfig 缺少 UNITY_WEBGL 平台分支（token 文件逻辑未隔离）' } else { Ok 'WebGL: 平台分支已隔离（保留 standalone token 文件逻辑）' }

$bridge = Get-Content (Join-Path $ProjectRoot 'Assets\Scripts\WebGL\WebGLBridge.cs') -Raw
if ($bridge -notmatch 'FCABridge_NotifyReady') { Fail 'WebGLBridge 缺少 FCABridge_NotifyReady 调用' } else { Ok 'WebGL bridge: ready 通知 (fca-unity-ready)' }
if ($bridge -notmatch 'FCABridge_PushState') { Fail 'WebGLBridge 缺少 FCABridge_PushState 调用' } else { Ok 'WebGL bridge: 状态推送 (fca-unity-state)' }

$jslib = Get-Content (Join-Path $ProjectRoot 'Assets\Plugins\WebGL\FCABridge.jslib') -Raw
if ($jslib -notmatch "postMessage") { Fail 'FCABridge.jslib 未 postMessage 到父页面' } else { Ok 'FCABridge.jslib: postMessage 到嵌入页' }
if ($jslib -notmatch 'fca-unity-ready') { Fail 'FCABridge.jslib 未发送 fca-unity-ready' } else { Ok 'FCABridge.jslib: fca-unity-ready/fca-unity-state 事件契约存在' }

$template = Get-Content (Join-Path $ProjectRoot 'Assets\WebGLTemplates\FCANebula\index.html') -Raw
if ($template -notmatch 'width:\s*100%') { Fail 'WebGL 模板 canvas 未铺满容器' } else { Ok 'WebGL 模板: canvas 100% 自适应 iframe' }
if ($template -match 'sandbox=') { Warn 'WebGL 模板包含 sandbox 属性（Unity WebGL 在 sandboxed iframe 下无法初始化，不应添加）' } else { Ok 'WebGL 模板: 无 sandbox 属性（符合实测结论）' }
if ($template -notmatch 'FCA_NEBULA') { Fail 'WebGL 模板缺少 window.FCA_NEBULA 命令 API' } else { Ok 'WebGL 模板: window.FCA_NEBULA 命令 API 已暴露' }

$fontPath = Join-Path $ProjectRoot 'Assets\Resources\Fonts\NotoSansSC-VF.ttf'
if (Test-Path $fontPath) {
    $fontSize = (Get-Item $fontPath).Length
    if ($fontSize -lt 1MB) { Fail "WebGL CJK 字体异常小: $fontSize bytes" } else { Ok ("WebGL: 内置 CJK 字体 Noto Sans SC ({0:N1} MB, SIL OFL 1.1)" -f ($fontSize / 1MB)) }
}

# Token must never be persisted in WebGL artifacts/logs (URL query). Detect bearer-like tokens.
# Only text artifacts are scanned (binary player payloads contain unrelated "token=" byte runs).
$artifactRoot = Join-Path $RepoRoot 'artifacts\unity'
if (Test-Path $artifactRoot) {
    $textExtensions = @('.json', '.log', '.txt', '.md', '.html', '.htm', '.js', '.mjs', '.ps1', '.cs', '.shader', '.yml', '.yaml', '.xml')
    $tokenLeak = Get-ChildItem $artifactRoot -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $textExtensions -contains $_.Extension.ToLowerInvariant() -and $_.Length -lt 50MB } |
        Select-String -Pattern 'token=[A-Za-z0-9]{20,}' -List -ErrorAction SilentlyContinue
    if ($tokenLeak) {
        Fail ("发现疑似明文 token（WebGL URL query）: " + (($tokenLeak | ForEach-Object { $_.Path }) -join '; '))
    }
    else {
        Ok 'token 安全: artifacts/unity 文本产物中无明文 token（WebGL 截图/日志/构建信息已脱敏）'
    }
}

# ---------------------------------------------------------------------------
# 9) PowerShell scripts parse check (AST parse without executing)
# ---------------------------------------------------------------------------
$psErrors = 0
foreach ($file in $psFiles) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors -and $errors.Count -gt 0) {
        $psErrors++
        Fail "PowerShell 语法错误: $($file.Name) -> $($errors[0].Message)"
    }
}
if ($psErrors -eq 0) { Ok "PowerShell 脚本语法有效（$($psFiles.Count) 个）" }

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host ("=== verify-source: {0} 项通过, {1} 项警告, {2} 项失败 ===" -f $checks, $warnings.Count, $failures.Count)
if ($warnings.Count -gt 0) {
    Write-Host '警告:'
    foreach ($w in $warnings) { Write-Host "  - $w" -ForegroundColor Yellow }
}
if ($failures.Count -gt 0) {
    Write-Host '失败:'
    foreach ($f in $failures) { Write-Host "  - $f" -ForegroundColor Red }
    exit 1
}
Write-Host '静态自检全部通过（已由 Unity 2022.3 batchmode 编译/构建验证，见 docs/UNITY_NEBULA.md §9）。'
exit 0
