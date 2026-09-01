param(
  [string]$Voice = 'zh-CN-XiaoxiaoNeural',
  [string]$Rate = '+45%'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ArtifactRoot = Join-Path $RepoRoot 'artifacts\video-v2'
$DefinitionPath = Join-Path $ArtifactRoot 'VIDEO_V2_VOICE_SEGMENTS.json'
if (-not (Test-Path -LiteralPath $DefinitionPath -PathType Leaf)) { throw "VIDEO_V2_VOICE_SEGMENTS_MISSING:$DefinitionPath" }
$Definition = Get-Content -Raw -LiteralPath $DefinitionPath | ConvertFrom-Json
$VoiceRoot = Join-Path $ArtifactRoot 'voice'
$VenvRoot = Join-Path $ArtifactRoot '.edge-tts-venv'
$Python = Join-Path $VenvRoot 'Scripts\python.exe'
New-Item -ItemType Directory -Force -Path $VoiceRoot | Out-Null
if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
  py -3 -m venv $VenvRoot
  if ($LASTEXITCODE -ne 0) { throw "VIDEO_V2_TTS_VENV_FAILED:$LASTEXITCODE" }
  & $Python -m pip install --disable-pip-version-check --quiet 'edge-tts==7.2.8'
  if ($LASTEXITCODE -ne 0) { throw "VIDEO_V2_TTS_INSTALL_FAILED:$LASTEXITCODE" }
}

$ManifestSegments = @()
foreach ($Segment in @($Definition.segments)) {
  $Output = Join-Path $VoiceRoot ([string]$Segment.file)
  & $Python -m edge_tts --voice $Voice --rate=$Rate --text ([string]$Segment.text) --write-media $Output
  if ($LASTEXITCODE -ne 0) { throw "VIDEO_V2_TTS_SEGMENT_FAILED:$($Segment.index):$LASTEXITCODE" }
  if (-not (Test-Path -LiteralPath $Output -PathType Leaf) -or (Get-Item -LiteralPath $Output).Length -eq 0) { throw "VIDEO_V2_TTS_SEGMENT_EMPTY:$($Segment.index)" }
  $ManifestSegments += [ordered]@{ index = $Segment.index; file = $Segment.file; offsetMs = $Segment.offsetMs; endMs = $Segment.endMs; text = $Segment.text }
}

$Manifest = [ordered]@{
  kind = 'ONLINE_NEURAL_TTS_DRAFT'
  generator = 'edge-tts@7.2.8'
  voice = $Voice
  rate = $Rate
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  segments = $ManifestSegments
}
$Manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $VoiceRoot 'manifest.json') -Encoding utf8
Write-Output "VIDEO_V2_TTS_DRAFT_SEGMENTS=$($ManifestSegments.Count)"
