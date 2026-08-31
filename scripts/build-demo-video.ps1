param(
  [string]$Source = '',
  [string]$Output = ''
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$DemoRoot = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot 'artifacts\demo'))
if ([string]::IsNullOrWhiteSpace($Source)) {
  $Source = Join-Path $DemoRoot 'aikefu-3min-demo-source.webm'
}
if ([string]::IsNullOrWhiteSpace($Output)) {
  $Output = Join-Path $DemoRoot 'aikefu-3min-demo.mp4'
}

$ResolvedSource = [System.IO.Path]::GetFullPath($Source)
$ResolvedOutput = [System.IO.Path]::GetFullPath($Output)
if (-not $ResolvedSource.StartsWith($DemoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "DEMO_SOURCE_OUTSIDE_ARTIFACTS: $ResolvedSource"
}
if (-not $ResolvedOutput.StartsWith($DemoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "DEMO_OUTPUT_OUTSIDE_ARTIFACTS: $ResolvedOutput"
}
if (-not (Test-Path -LiteralPath $ResolvedSource -PathType Leaf)) {
  throw "DEMO_SOURCE_NOT_FOUND: $ResolvedSource"
}

$Ffmpeg = (Get-Command ffmpeg -ErrorAction Stop).Source
$Ffprobe = (Get-Command ffprobe -ErrorAction Stop).Source
$VoiceoverRoot = Join-Path $DemoRoot 'voiceover'
& pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'generate-demo-voiceover.ps1') -OutputDirectory $VoiceoverRoot
if ($LASTEXITCODE -ne 0) {
  throw "VOICEOVER_GENERATION_FAILED: $LASTEXITCODE"
}

$ManifestPath = Join-Path $VoiceoverRoot 'manifest.json'
$Manifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
if (@($Manifest.segments).Count -eq 0) {
  throw 'VOICEOVER_MANIFEST_EMPTY'
}

for ($Index = 0; $Index -lt @($Manifest.segments).Count; $Index += 1) {
  $Segment = $Manifest.segments[$Index]
  $SegmentPath = Join-Path $VoiceoverRoot $Segment.file
  $SegmentDuration = [double](& $Ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 -- $SegmentPath)
  $SegmentEnd = ([double]$Segment.offsetMs / 1000) + $SegmentDuration
  $NextStart = if ($Index -lt @($Manifest.segments).Count - 1) {
    [double]$Manifest.segments[$Index + 1].offsetMs / 1000
  } else {
    180.0
  }
  if ($SegmentEnd -gt $NextStart) {
    throw "VOICEOVER_SEGMENT_OVERLAP: $($Segment.file) ends at $SegmentEnd, next starts at $NextStart"
  }
}

$FfmpegArguments = @('-hide_banner', '-loglevel', 'error', '-y', '-i', $ResolvedSource)
foreach ($Segment in $Manifest.segments) {
  $SegmentPath = Join-Path $VoiceoverRoot $Segment.file
  if (-not (Test-Path -LiteralPath $SegmentPath -PathType Leaf)) {
    throw "VOICEOVER_SEGMENT_NOT_FOUND: $SegmentPath"
  }
  $FfmpegArguments += @('-i', $SegmentPath)
}
$FfmpegArguments += @('-f', 'lavfi', '-t', '180', '-i', 'anullsrc=r=48000:cl=mono')

$Filters = @()
$AudioLabels = @()
for ($Index = 0; $Index -lt @($Manifest.segments).Count; $Index += 1) {
  $InputIndex = $Index + 1
  $Label = "voice$InputIndex"
  $Delay = [int]$Manifest.segments[$Index].offsetMs
  $Filters += "[${InputIndex}:a]aresample=48000,adelay=delays=$Delay`:all=1[$Label]"
  $AudioLabels += "[$Label]"
}
$SilenceInputIndex = @($Manifest.segments).Count + 1
$MixInputCount = @($Manifest.segments).Count + 1
$Filters += "[${SilenceInputIndex}:a]atrim=duration=180[silence]"
$Filters += "[silence]$($AudioLabels -join '')amix=inputs=$MixInputCount`:duration=longest`:normalize=0,alimiter=limit=0.95,atrim=duration=180[aout]"

$TemporaryOutput = Join-Path $DemoRoot 'aikefu-3min-demo.tmp.mp4'
$FfmpegArguments += @(
  '-filter_complex', ($Filters -join ';'),
  '-map', '0:v:0',
  '-map', '[aout]',
  '-t', '180',
  '-c:v', 'libx264',
  '-preset', 'medium',
  '-crf', '21',
  '-pix_fmt', 'yuv420p',
  '-r', '25',
  '-c:a', 'aac',
  '-b:a', '128k',
  '-movflags', '+faststart',
  $TemporaryOutput
)

& $Ffmpeg @FfmpegArguments
if ($LASTEXITCODE -ne 0) {
  throw "FFMPEG_BUILD_FAILED: $LASTEXITCODE"
}
Move-Item -Force -LiteralPath $TemporaryOutput -Destination $ResolvedOutput

$ProbeJson = & $Ffprobe -v error -show_entries 'format=duration:stream=codec_type,codec_name,width,height,channels' -of json -- $ResolvedOutput
if ($LASTEXITCODE -ne 0) {
  throw "FFPROBE_FAILED: $LASTEXITCODE"
}
$Probe = $ProbeJson | ConvertFrom-Json
$Duration = [double]$Probe.format.duration
$VideoStream = $Probe.streams | Where-Object codec_type -eq 'video' | Select-Object -First 1
$AudioStream = $Probe.streams | Where-Object codec_type -eq 'audio' | Select-Object -First 1

if ([math]::Abs($Duration - 180.0) -gt 0.2) {
  throw "DEMO_DURATION_INVALID: $Duration"
}
if ($VideoStream.codec_name -ne 'h264' -or $VideoStream.width -ne 1440 -or $VideoStream.height -ne 900) {
  throw "DEMO_VIDEO_STREAM_INVALID: $($VideoStream | ConvertTo-Json -Compress)"
}
if ($AudioStream.codec_name -ne 'aac') {
  throw "DEMO_AUDIO_STREAM_INVALID: $($AudioStream | ConvertTo-Json -Compress)"
}

$CoverPath = Join-Path $DemoRoot 'aikefu-3min-demo-cover.png'
& $Ffmpeg -hide_banner -loglevel error -y -ss 3 -i $ResolvedOutput -frames:v 1 $CoverPath
if ($LASTEXITCODE -ne 0) {
  throw "DEMO_COVER_FAILED: $LASTEXITCODE"
}

Write-Output "DEMO_VIDEO=$ResolvedOutput"
Write-Output "DEMO_COVER=$CoverPath"
Write-Output "DEMO_DURATION=$Duration"
Write-Output "DEMO_VIDEO_CODEC=$($VideoStream.codec_name)"
Write-Output "DEMO_AUDIO_CODEC=$($AudioStream.codec_name)"
Write-Output "DEMO_RESOLUTION=$($VideoStream.width)x$($VideoStream.height)"
