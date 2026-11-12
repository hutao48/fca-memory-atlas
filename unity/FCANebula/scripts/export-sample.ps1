# FCA Memory Atlas — Unity Nebula Renderer
# Export a desensitized graph sample from the live FCA Runtime for offline Editor preview.
#
#   pwsh -File unity/FCANebula/scripts/export-sample.ps1
#
# The sample keeps the real graph structure (node count / importance / clusters) but:
#   - memory titles are replaced with generic "示例记忆 #NN"
#   - tags are reduced to workspace tags (synthetic workspace grouping when the live data
#     has no workspace:<label> tags yet) plus a generic marker
#   - clusters labels are anonymized
# It is written to:
#   unity/FCANebula/Assets/StreamingAssets/sample-graph.json
#   artifacts/unity/sample-graph.json
#
# IMPORTANT: this is static preview data. The runtime app only shows it when explicitly
# allowed (--allow-sample) or when running inside the Unity Editor, and always with a
# visible SAMPLE banner. Live failures are never silently replaced by this data.

[CmdletBinding()]
param(
    [string]$RuntimeUrl = 'http://127.0.0.1:17860',
    [string]$TokenFile = '',
    [string]$FcaHome = ''
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent (Split-Path -Parent $ProjectRoot)
$OutArtifact = Join-Path $RepoRoot 'artifacts\unity\sample-graph.json'
$OutStreaming = Join-Path $ProjectRoot 'Assets\StreamingAssets\sample-graph.json'

function Resolve-Token {
    $candidates = @()
    if ($TokenFile) { $candidates += $TokenFile }
    if ($FcaHome) { $candidates += (Join-Path $FcaHome 'config\runtime-token') }
    if ($env:FCA_HOME) { $candidates += (Join-Path $env:FCA_HOME 'config\runtime-token') }
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'FCA-Memory-Atlas\config\runtime-token') }
    if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA 'FCA-Memory-Atlas\config\runtime-token') }
    if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE '.fca\config\runtime-token') }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) {
            return (Get-Content $candidate -Raw).Trim()
        }
    }
    throw @"
未找到 runtime-token。请确认 FCA Runtime 正在运行，或显式指定：
  -TokenFile <path>  或  -FcaHome <dir>
候选路径:
$($candidates -join "`n")
"@
}

$token = Resolve-Token
$headers = @{ Authorization = "Bearer $token"; Accept = 'application/json' }
$graphUri = "$($RuntimeUrl.TrimEnd('/'))/api/v1/graph"

Write-Host "[sample] GET $graphUri"
try {
    $graph = Invoke-RestMethod -Uri $graphUri -Headers $headers -TimeoutSec 30 -Method Get
}
catch {
    throw "无法从 Runtime 拉取 graph（不会伪造样本数据）: $($_.Exception.Message)"
}
if (-not $graph -or -not $graph.nodes) {
    throw 'graph 响应缺少 nodes 字段'
}

function Get-WorkspaceLabel($node) {
    foreach ($tag in @($node.tags)) {
        if ($tag -match '^workspace:(.+)$') { return $matches[1] }
    }
    # Entity nodes deliberately stay on the default arm in the sample so the offline preview
    # also demonstrates the "no workspace tag -> default arm" behaviour.
    if ($node.kind -eq 'entity') { return $null }
    # Synthetic grouping for pre-workspace-tag data, derived from real tags/titles.
    $label = [string]$node.label
    $tags = @($node.tags)
    if ($label -match 'FCA|星云|unity|Unity') { return 'FCA' }
    if ($tags -contains 'DeepSeek' -or $tags -contains '个人偏好') { return 'personal' }
    if ($tags -contains 'DSH自动记忆' -or $tags -contains 'DSH用户消息') { return 'DSH' }
    return $null
}

$nodesOut = New-Object System.Collections.Generic.List[object]
$workspaceCounts = @{}
$workspaceNodeIds = @{}
$index = 0
foreach ($node in @($graph.nodes)) {
    $index++
    $workspace = Get-WorkspaceLabel $node
    $tags = @()
    if ($workspace) {
        $tags += "workspace:$workspace"
        if (-not $workspaceCounts.ContainsKey($workspace)) { $workspaceCounts[$workspace] = 0 }
        $workspaceCounts[$workspace]++
        if (-not $workspaceNodeIds.ContainsKey($workspace)) { $workspaceNodeIds[$workspace] = New-Object System.Collections.Generic.List[string] }
        $workspaceNodeIds[$workspace].Add($node.id)
    }
    $tags += 'sample-data'

    $nodesOut.Add([ordered]@{
        id              = $node.id
        kind            = $(if ($node.kind) { $node.kind } else { 'memory' })
        type            = $(if ($node.type) { $node.type } else { 'episodic' })
        label           = ('示例记忆 #{0:00}' -f $index)
        importance      = [double]$node.importance
        display_weight  = [double]$node.display_weight
        credibility     = [double]$node.credibility
        occurred_at     = $null
        degree          = [int]$node.degree
        cluster_id      = $node.cluster_id
        position        = [ordered]@{ x = [double]$node.position.x; y = [double]$node.position.y; z = [double]$node.position.z }
        pinned          = $false
        tags            = $tags
        tag_ids         = @()
        deleted         = $false
        agent_generated = [bool]$node.agent_generated
        demo            = $false
    })
}

$edgesOut = New-Object System.Collections.Generic.List[object]
$nodeIdSet = @{}
foreach ($n in $nodesOut) { $nodeIdSet[[string]$n['id']] = $true }
foreach ($edge in @($graph.edges)) {
    if (-not $edge) { continue }
    if (-not $nodeIdSet.ContainsKey([string]$edge.from) -or -not $nodeIdSet.ContainsKey([string]$edge.to)) { continue }
    $edgesOut.Add([ordered]@{
        id            = $edge.id
        from          = $edge.from
        to            = $edge.to
        relation_type = $(if ($edge.relation_type) { $edge.relation_type } else { 'custom' })
        weight        = [double]$edge.weight
        directed      = [bool]$edge.directed
        confidence    = [double]$edge.confidence
        label         = $edge.label
        deleted       = $false
    })
}

$clustersOut = New-Object System.Collections.Generic.List[object]
$clusterIndex = 0
foreach ($cluster in @($graph.clusters)) {
    if (-not $cluster) { continue }
    $clusterIndex++
    $ids = @()
    foreach ($id in @($cluster.node_ids)) { if ($nodeIdSet.ContainsKey([string]$id)) { $ids += [string]$id } }
    if ($ids.Count -eq 0) { continue }
    $clustersOut.Add([ordered]@{
        id             = $cluster.id
        label          = ('示例聚类 #{0:00}' -f $clusterIndex)
        node_ids       = $ids
        centroid       = [ordered]@{ x = [double]$cluster.centroid.x; y = [double]$cluster.centroid.y; z = [double]$cluster.centroid.z }
        density        = [double]$cluster.density
        dominant_types = @($cluster.dominant_types)
        color_hint     = $(if ($cluster.color_hint) { $cluster.color_hint } else { 'blue' })
    })
}

$now = (Get-Date).ToUniversalTime().ToString('o')
$sample = [ordered]@{
    api_version    = '1'
    layout_version = [int]$graph.layout_version
    view           = [ordered]@{ center = @(0, 0, 0); zoom = 1.0; view_id = $null }
    nodes          = $nodesOut
    edges          = $edgesOut
    clusters       = $clustersOut
    stats          = [ordered]@{
        nodes        = $nodesOut.Count
        edges        = $edgesOut.Count
        clusters     = $clustersOut.Count
        generated_at = $now
    }
    _sample        = $true
    _sample_note   = '离线预览样本：标题/标签/聚类名已脱敏；用于 Unity Editor 无 Runtime 时预览旋臂布局。'
    _sample_source = $graphUri
    _sample_generated_at = $now
    _workspace_summary = [ordered]@{}
}
foreach ($key in ($workspaceCounts.Keys | Sort-Object)) {
    $sample._workspace_summary[$key] = $workspaceCounts[$key]
}

$json = $sample | ConvertTo-Json -Depth 100
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutArtifact) | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutStreaming) | Out-Null
[System.IO.File]::WriteAllText($OutArtifact, $json, $utf8NoBom)
[System.IO.File]::WriteAllText($OutStreaming, $json, $utf8NoBom)

Write-Host "[sample] nodes=$($nodesOut.Count) edges=$($edgesOut.Count) clusters=$($clustersOut.Count)"
Write-Host "[sample] workspace arms:"
foreach ($key in ($workspaceCounts.Keys | Sort-Object)) {
    Write-Host ("  - {0}: {1}" -f $key, $workspaceCounts[$key])
}
Write-Host "[sample] wrote $OutArtifact"
Write-Host "[sample] wrote $OutStreaming"
