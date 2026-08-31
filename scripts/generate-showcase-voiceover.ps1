param(
  [string]$Voice = 'zh-CN-XiaoxiaoNeural',
  [string]$Rate = '+50%'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$RecordingRoot = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot 'artifacts\recording'))
$VoiceRoot = Join-Path $RecordingRoot 'voice'
$VenvRoot = Join-Path $RecordingRoot '.edge-tts-venv'
$Python = Join-Path $VenvRoot 'Scripts\python.exe'
$Ffprobe = (Get-Command ffprobe -ErrorAction Stop).Source

New-Item -ItemType Directory -Force -Path $RecordingRoot, $VoiceRoot | Out-Null
if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
  & py -m venv $VenvRoot
  if ($LASTEXITCODE -ne 0) { throw "EDGE_TTS_VENV_FAILED:$LASTEXITCODE" }
}

& $Python -m pip install --disable-pip-version-check --quiet 'edge-tts==7.2.8'
if ($LASTEXITCODE -ne 0) { throw "EDGE_TTS_INSTALL_FAILED:$LASTEXITCODE" }

$ProviderLabel = if ($env:SHOWCASE_PROVIDER_LABEL -eq 'DeepSeek') { 'DeepSeek' } else { '离线确定性Provider' }
$env:SHOWCASE_PROVIDER_LABEL = $ProviderLabel
$PlanJson = & node -e "import('./scripts/recording-timeline.mjs').then(m=>process.stdout.write(JSON.stringify(m.resolveVoiceoverSegments(process.env.SHOWCASE_PROVIDER_LABEL))))"
if ($LASTEXITCODE -ne 0) { throw "VOICEOVER_PLAN_FAILED:$LASTEXITCODE" }
$Segments = $PlanJson | ConvertFrom-Json
$ManifestSegments = @()
$TtsMaxAttempts = 3

for ($Index = 0; $Index -lt @($Segments).Count; $Index += 1) {
  $Segment = $Segments[$Index]
  $FileName = 'segment-{0:D2}.mp3' -f ($Index + 1)
  $FilePath = Join-Path $VoiceRoot $FileName
  $TtsSucceeded = $false
  for ($Attempt = 1; $Attempt -le $TtsMaxAttempts; $Attempt += 1) {
    & $Python -m edge_tts --voice $Voice --rate=$Rate --text $Segment.text --write-media $FilePath
    if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $FilePath -PathType Leaf) -and (Get-Item -LiteralPath $FilePath).Length -gt 0) {
      $TtsSucceeded = $true
      break
    }
    if ($Attempt -lt $TtsMaxAttempts) { Start-Sleep -Milliseconds 750 }
  }
  if (-not $TtsSucceeded) { throw "EDGE_TTS_SEGMENT_FAILED:$($Index + 1):attempts=$TtsMaxAttempts" }
  $Duration = [double](& $Ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 -- $FilePath)
  $Available = [double]$Segment.subtitleEnd - [double]$Segment.offset
  if ($Duration -gt $Available) {
    throw "VOICEOVER_SEGMENT_TOO_LONG:$($Index + 1):duration=$Duration`:available=$Available"
  }
  $ManifestSegments += [pscustomobject]@{
    chapter = $Segment.chapter
    offsetMs = [int]([double]$Segment.offset * 1000)
    subtitleEnd = [double]$Segment.subtitleEnd
    duration = $Duration
    file = $FileName
    text = $Segment.text
  }
}

$Manifest = [pscustomobject]@{
  generator = 'edge-tts@7.2.8'
  voice = $Voice
  rate = $Rate
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  segments = $ManifestSegments
}
$ManifestPath = Join-Path $VoiceRoot 'manifest.json'
$Manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8

Write-Output "SHOWCASE_VOICE_MANIFEST=$ManifestPath"
Write-Output "SHOWCASE_VOICE=$Voice"
Write-Output "SHOWCASE_VOICE_RATE=$Rate"
Write-Output "SHOWCASE_VOICE_SEGMENTS=$(@($Segments).Count)"
