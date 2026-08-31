param(
  [string]$RecordingDirectory = ''
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($RecordingDirectory)) {
  $RecordingDirectory = Join-Path $RepoRoot 'artifacts\recording'
}
$RecordingRoot = [System.IO.Path]::GetFullPath($RecordingDirectory)
$AllowedRoot = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot 'artifacts\recording'))
$RelativeRecordingRoot = [System.IO.Path]::GetRelativePath($AllowedRoot, $RecordingRoot)
$ParentPrefix = "..$([System.IO.Path]::DirectorySeparatorChar)"
if (
  [System.IO.Path]::IsPathRooted($RelativeRecordingRoot) -or
  $RelativeRecordingRoot -eq '..' -or
  $RelativeRecordingRoot.StartsWith($ParentPrefix, [System.StringComparison]::Ordinal)
) {
  throw "RECORDING_OUTPUT_OUTSIDE_ARTIFACTS:$RecordingRoot"
}

$RecordingManifestPath = Join-Path $RecordingRoot 'recording-manifest.json'
if (-not (Test-Path -LiteralPath $RecordingManifestPath -PathType Leaf)) {
  throw "RECORDING_MANIFEST_NOT_FOUND:$RecordingManifestPath"
}
$ManifestOutput = @(& node (Join-Path $PSScriptRoot 'recording-manifest.mjs') $RecordingManifestPath 2>&1)
$ManifestExitCode = $LASTEXITCODE
if ($ManifestExitCode -ne 0) {
  throw "RECORDING_MANIFEST_VALIDATION_FAILED:$($ManifestOutput -join ' ')"
}
$RecordingManifest = ($ManifestOutput -join "`n") | ConvertFrom-Json

$Ffmpeg = (Get-Command ffmpeg -ErrorAction Stop).Source
$Ffprobe = (Get-Command ffprobe -ErrorAction Stop).Source
$EditRoot = Join-Path $RecordingRoot 'edit'
$VoiceRoot = Join-Path $RecordingRoot 'voice'
New-Item -ItemType Directory -Force -Path $EditRoot | Out-Null

# Assets and TTS may mention a real provider only when the validated recorder
# manifest says so.
$ProviderLabel = '离线确定性Provider'
if ($RecordingManifest.provider -eq 'DeepSeek') { $ProviderLabel = 'DeepSeek' }
$env:SHOWCASE_PROVIDER_LABEL = $ProviderLabel

& node (Join-Path $PSScriptRoot 'write-recording-editorial-assets.mjs')
if ($LASTEXITCODE -ne 0) { throw "RECORDING_EDITORIAL_ASSETS_FAILED:$LASTEXITCODE" }
& pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'generate-showcase-voiceover.ps1')
if ($LASTEXITCODE -ne 0) { throw "SHOWCASE_VOICEOVER_FAILED:$LASTEXITCODE" }

$TimelineJson = & node -e "import('./scripts/recording-timeline.mjs').then(m=>process.stdout.write(JSON.stringify(m.SHOWCASE_VIDEO_TIMELINE)))"
if ($LASTEXITCODE -ne 0) { throw "RECORDING_TIMELINE_FAILED:$LASTEXITCODE" }
$Timeline = @($TimelineJson | ConvertFrom-Json)
$ChapterFiles = @()
$Invariant = [System.Globalization.CultureInfo]::InvariantCulture
$CommonFilter = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=#eef2f8,setsar=1'

for ($Index = 0; $Index -lt $Timeline.Count; $Index += 1) {
  $Chapter = $Timeline[$Index]
  $BoundaryTransition = 0.0
  if ($Index -lt $Timeline.Count - 1) {
    $NextChapter = $Timeline[$Index + 1]
    $BoundaryTransition = [double]$NextChapter.transition.duration
    if ([math]::Abs($BoundaryTransition - 0.2) -gt 0.001) { throw "RECORDING_TRANSITION_INVALID:$($Chapter.id)" }
  }
  # Add the overlap to every source except the last one. xfade consumes that
  # overlap, while the editorial chapter clock remains exactly 180 seconds.
  $Target = ([double]$Chapter.end - [double]$Chapter.start) + $BoundaryTransition
  $TargetText = $Target.ToString('0.###', $Invariant)
  $Source = Join-Path $RecordingRoot $Chapter.source
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "RECORDING_SOURCE_NOT_FOUND:$Source" }
  if ((Get-Item -LiteralPath $Source).Length -eq 0) { throw "RECORDING_SOURCE_EMPTY:$Source" }
  $ChapterFile = Join-Path $EditRoot ('chapter-{0:D2}-{1}.mp4' -f ($Index + 1), $Chapter.id)
  if ([System.IO.Path]::GetExtension($Source).ToLowerInvariant() -eq '.png') {
    # A very slow zoom gives still evidence a small amount of motion, avoiding
    # an accidental long static hold while keeping the screenshot readable.
    $StillFilter = "$CommonFilter,zoompan=z='min(zoom+0.0004,1.04)':d=1:s=1920x1080:fps=30"
    & $Ffmpeg -hide_banner -loglevel error -y -loop 1 -framerate 30 -i $Source -t $TargetText -vf $StillFilter -an -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -r 30 $ChapterFile
  } else {
    $Actual = [double](& $Ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 -- $Source)
    if ($Actual -le 0) { throw "RECORDING_SOURCE_DURATION_INVALID:$Source" }
    $PadDuration = 0.0
    if ($Actual -gt $Target) {
      # Preserve the complete evidence by speeding the natural clip up. Keep
      # ordinary browser evidence at or below the 1.25x recording contract. Live Scenario Lab is an overview
      # assembled from eight completed runs, so it may use up to 4x. If even
      # that bounded speed cannot fit the complete source, stop rather than
      # letting -t truncate the eighth result or the final 8/8 evidence.
      $MaxSpeed = if ($Chapter.liveCapture) { 4.0 } else { 1.25 }
      $RequiredSpeed = $Actual / $Target
      if ($RequiredSpeed -gt $MaxSpeed) {
        throw "RECORDING_SOURCE_TOO_LONG:$($Chapter.id):actual=$([math]::Round($Actual, 3)):target=$([math]::Round($Target, 3)):max-speed=$MaxSpeed:requires-recut"
      }
      $Speed = $RequiredSpeed
      $PtsRatio = (1.0 / $Speed).ToString('0.########', $Invariant)
    } else {
      # A short clip stays at natural speed. Only a tiny encoder rounding gap
      # may be padded; a larger gap is a recording failure, not a reason to
      # manufacture a static hold in the edit.
      $Shortfall = $Target - $Actual
      if ($Shortfall -gt 0.2) {
        throw "RECORDING_SOURCE_TOO_SHORT:$($Chapter.id):actual=$([math]::Round($Actual, 3)):target=$([math]::Round($Target, 3)):requires-recapture"
      }
      $PtsRatio = '1'
      $PadDuration = [math]::Round([math]::Max(0.0, $Shortfall), 3)
    }
    $PlaybackFilter = "$CommonFilter,setpts=$PtsRatio*PTS"
    if ($PadDuration -gt 0) {
      $PadText = $PadDuration.ToString('0.###', $Invariant)
      $PlaybackFilter += ",tpad=stop_mode=clone:stop_duration=$PadText"
    }
    $PlaybackFilter += ',fps=30'
    & $Ffmpeg -hide_banner -loglevel error -y -i $Source -t $TargetText -vf $PlaybackFilter -an -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -r 30 $ChapterFile
  }
  if ($LASTEXITCODE -ne 0) { throw "RECORDING_CHAPTER_BUILD_FAILED:$($Chapter.id):$LASTEXITCODE" }
  $ChapterFiles += $ChapterFile
}

# Join with short fades. Each chapter source has the next boundary's 200ms
# overlap, so the chained filter's last frame lands on exactly 180 seconds.
$VideoInputs = @()
$VideoFilters = @()
for ($Index = 0; $Index -lt $ChapterFiles.Count; $Index += 1) {
  $VideoInputs += @('-i', $ChapterFiles[$Index])
  if ($Index -eq 0) {
    $VideoFilters += "[0:v]setpts=PTS-STARTPTS,format=yuv420p[v0]"
  } else {
    $Offset = ([double]$Timeline[$Index].start).ToString('0.###', $Invariant)
    $PreviousLabel = "v$($Index - 1)"
    $CurrentLabel = "v$Index"
    $VideoFilters += "[$PreviousLabel][$Index`:v]xfade=transition=fade:duration=0.2:offset=$Offset,format=yuv420p[$CurrentLabel]"
  }
}
$NoVoice = Join-Path $RecordingRoot 'AIkefu-demo-3min-no-voice.mp4'
$TimelineVideoArguments = @('-hide_banner', '-loglevel', 'error', '-y') + $VideoInputs + @(
  '-filter_complex', ($VideoFilters -join ';'),
  '-map', "[v$($ChapterFiles.Count - 1)]",
  '-t', '180', '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
  '-movflags', '+faststart', $NoVoice
)
& $Ffmpeg @TimelineVideoArguments
if ($LASTEXITCODE -ne 0) { throw "RECORDING_TIMELINE_BUILD_FAILED:$LASTEXITCODE" }

$ManifestPath = Join-Path $VoiceRoot 'manifest.json'
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw "SHOWCASE_VOICE_MANIFEST_NOT_FOUND:$ManifestPath" }
$VoiceManifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
$VoiceSegments = @($VoiceManifest.segments)
$Srt = Join-Path $RecordingRoot 'AIkefu-demo-subtitles.srt'
if (-not (Test-Path -LiteralPath $Srt -PathType Leaf)) { throw "SHOWCASE_SUBTITLES_NOT_FOUND:$Srt" }
$Voiced = Join-Path $RecordingRoot 'AIkefu-demo-3min-cn.mp4'
$Arguments = @('-hide_banner', '-loglevel', 'error', '-y', '-i', $NoVoice)
foreach ($Segment in $VoiceSegments) {
  $SegmentPath = Join-Path $VoiceRoot $Segment.file
  if (-not (Test-Path -LiteralPath $SegmentPath -PathType Leaf)) { throw "SHOWCASE_VOICE_SEGMENT_NOT_FOUND:$SegmentPath" }
  $Arguments += @('-i', $SegmentPath)
}
$Arguments += @('-f', 'lavfi', '-t', '180', '-i', 'anullsrc=r=48000:cl=stereo')

$Filters = @()
$Labels = @()
for ($Index = 0; $Index -lt $VoiceSegments.Count; $Index += 1) {
  $InputIndex = $Index + 1
  $Delay = [int]$VoiceSegments[$Index].offsetMs
  $Label = "voice$InputIndex"
  $Filters += "[${InputIndex}:a]aresample=48000,adelay=delays=$Delay`:all=1[$Label]"
  $Labels += "[$Label]"
}
$SilenceInput = $VoiceSegments.Count + 1
$MixCount = $VoiceSegments.Count + 1
$Filters += "[${SilenceInput}:a]atrim=duration=180[silence]"
$Filters += "[silence]$($Labels -join '')amix=inputs=$MixCount`:duration=longest`:normalize=0,alimiter=limit=0.95,atrim=duration=180[aout]"

# Render the same SRT as a visible, bottom-safe two-line subtitle layer. The
# external SRT uses the same source of truth. The MP4 intentionally carries no
# soft subtitle track because several players auto-enable the only mov_text
# stream and would display duplicate subtitles over the burned-in text.
$SubtitleFilterPath = $Srt.Replace('\', '/').Replace(':', '\:').Replace("'", "\\'")
$SubtitleStyle = 'FontName=Microsoft YaHei,FontSize=12,Alignment=2,MarginL=24,MarginR=24,MarginV=24,Outline=1,WrapStyle=2'
$Filters += "[0:v]subtitles='$SubtitleFilterPath':force_style='$SubtitleStyle'[vout]"
$Arguments += @(
  '-filter_complex', ($Filters -join ';'),
  '-map', '[vout]', '-map', '[aout]',
  '-t', '180', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
  '-c:a', 'aac', '-b:a', '160k',
  '-movflags', '+faststart', $Voiced
)
& $Ffmpeg @Arguments
if ($LASTEXITCODE -ne 0) { throw "SHOWCASE_VIDEO_MUX_FAILED:$LASTEXITCODE" }

$Canonical = Join-Path $RecordingRoot 'aikefu-3min-demo.mp4'
Copy-Item -Force -LiteralPath $Voiced -Destination $Canonical
$Thumbnail = Join-Path $RecordingRoot 'AIkefu-demo-thumbnail.png'
& $Ffmpeg -hide_banner -loglevel error -y -ss 4 -i $Voiced -frames:v 1 $Thumbnail
if ($LASTEXITCODE -ne 0) { throw "SHOWCASE_THUMBNAIL_FAILED:$LASTEXITCODE" }

# Encode a no-hard-subtitle control from the exact same no-voice generation,
# using the same H.264 parameters as the final output. This prevents normal
# re-encoding drift from being mistaken for subtitle pixels.
$SubtitleControl = Join-Path $EditRoot 'subtitle-control.mp4'
& $Ffmpeg -hide_banner -loglevel error -y -i $NoVoice -t 180 -vf 'format=yuv420p' -an -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -r 30 -movflags +faststart $SubtitleControl
if ($LASTEXITCODE -ne 0) { throw "SHOWCASE_SUBTITLE_CONTROL_FAILED:$LASTEXITCODE" }

function Get-PixelDiffYavg {
  param(
    [Parameter(Mandatory = $true)][string]$BurnedPath,
    [Parameter(Mandatory = $true)][string]$ControlPath,
    [Parameter(Mandatory = $true)][string]$TimeText,
    [Parameter(Mandatory = $true)][int]$CropY
  )
  $Filter = "[0:v]trim=duration=0.04,setpts=PTS-STARTPTS,crop=1920:300:0:$CropY[burned];" +
    "[1:v]trim=duration=0.04,setpts=PTS-STARTPTS,crop=1920:300:0:$CropY[control];" +
    '[burned][control]blend=all_mode=difference:shortest=1,format=gray,signalstats,metadata=print[diff]'
  $Output = @(& $Ffmpeg -hide_banner -loglevel info -y -ss $TimeText -i $BurnedPath -ss $TimeText -i $ControlPath -filter_complex $Filter -map '[diff]' -frames:v 1 -f null NUL 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "SHOWCASE_HARD_SUBTITLE_PIXEL_CHECK_FAILED:$TimeText`:$CropY`:$LASTEXITCODE" }
  $YavgLine = $Output | Where-Object { $_ -match 'lavfi\.signalstats\.YAVG=' } | Select-Object -Last 1
  if (-not $YavgLine) { throw "SHOWCASE_HARD_SUBTITLE_PIXEL_STATS_MISSING:$TimeText`:$CropY" }
  $YavgMatch = [regex]::Match([string]$YavgLine, 'YAVG=([0-9]+(?:\.[0-9]+)?)')
  if (-not $YavgMatch.Success) { throw "SHOWCASE_HARD_SUBTITLE_PIXEL_STATS_INVALID:$TimeText`:$CropY" }
  return [double]::Parse($YavgMatch.Groups[1].Value, $Invariant)
}

# Pixel-level smoke check: compare the burned and no-subtitle frames in the
# bottom safe area at several active cues. A whole-frame hash is intentionally
# not used because the final video is re-encoded and therefore differs even
# when the subtitle layer is missing.
$SubtitleCheckTimes = @(3, 118, 155.5, 176.5)
$SubtitlePixelDiffThreshold = 0.25
$SubtitlePixelEvidence = @()
foreach ($CheckTime in $SubtitleCheckTimes) {
  $CheckText = ([double]$CheckTime).ToString('0.###', $Invariant)
  $BottomYavg = Get-PixelDiffYavg -BurnedPath $Voiced -ControlPath $SubtitleControl -TimeText $CheckText -CropY 780
  $TopYavg = Get-PixelDiffYavg -BurnedPath $Voiced -ControlPath $SubtitleControl -TimeText $CheckText -CropY 0
  if ($BottomYavg -lt $SubtitlePixelDiffThreshold -or $BottomYavg -le [math]::Max($SubtitlePixelDiffThreshold, $TopYavg * 2.0)) {
    throw "SHOWCASE_HARD_SUBTITLE_NOT_VISIBLE:$CheckText`:bottom=$BottomYavg`:top=$TopYavg`:threshold=$SubtitlePixelDiffThreshold"
  }
  $SubtitlePixelEvidence += "t=$CheckText bottom=$([math]::Round($BottomYavg, 3)) top=$([math]::Round($TopYavg, 3))"
}

$Probe = (& $Ffprobe -v error -show_entries 'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,channels:stream_disposition=default' -of json -- $Voiced) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "SHOWCASE_PROBE_FAILED:$LASTEXITCODE" }
$Duration = [double]$Probe.format.duration
$VideoStream = $Probe.streams | Where-Object codec_type -eq 'video' | Select-Object -First 1
$AudioStream = $Probe.streams | Where-Object codec_type -eq 'audio' | Select-Object -First 1
$SubtitleStream = $Probe.streams | Where-Object codec_type -eq 'subtitle' | Select-Object -First 1
if ([math]::Abs($Duration - 180) -gt 0.2) { throw "SHOWCASE_DURATION_INVALID:$Duration" }
if ($VideoStream.codec_name -ne 'h264' -or $VideoStream.width -ne 1920 -or $VideoStream.height -ne 1080 -or $VideoStream.avg_frame_rate -ne '30/1') {
  throw "SHOWCASE_VIDEO_STREAM_INVALID:$($VideoStream | ConvertTo-Json -Compress)"
}
if ($AudioStream.codec_name -ne 'aac') { throw "SHOWCASE_AUDIO_STREAM_INVALID:$($AudioStream | ConvertTo-Json -Compress)" }
if ($SubtitleStream) { throw "SHOWCASE_UNEXPECTED_SOFT_SUBTITLE_STREAM:$($SubtitleStream | ConvertTo-Json -Compress)" }

$Hashes = Get-FileHash -Algorithm SHA256 -LiteralPath $Voiced, $Canonical, $NoVoice, $SubtitleControl, $Thumbnail, $Srt, $RecordingManifestPath
$EvidenceLines = @(
  '# AIkefu Recording Evidence', '',
  "- Generated: $((Get-Date).ToUniversalTime().ToString('o'))",
  "- Source route: $($env:SHOWCASE_BASE_URL ?? 'http://127.0.0.1:5173')/showcase?recording=1",
  '- Runtime: real API/Web, isolated Showcase Workspace, PostgreSQL/Redis/MinIO, MockDouyin',
  "- Narration: $($VoiceManifest.voice), rate $($VoiceManifest.rate), online edge-tts $($VoiceManifest.generator)",
  '- Editorial clock: 180 seconds; intro 5 seconds; closing 8 seconds; chapter fades 0.2 seconds',
  '- Scenario coverage: SC01–SC06 plus live Scenario Lab 8-case overview and Developer Trace',
  "- Duration: $Duration seconds", '- Resolution: 1920x1080', '- Frame rate: 30 fps',
  '- Video: H.264 with hard-burned Chinese subtitles', '- Audio: AAC', '- External subtitles: SRT from the same subtitle source; no duplicate-prone soft track',
  '- Subtitle safe area: bottom alignment, 96px side margins, 84px bottom margin, WrapStyle=2, max two lines',
  "- Hard subtitle pixel check: same-generation subtitle-control bottom safe-area YAVG difference threshold $SubtitlePixelDiffThreshold; $($SubtitlePixelEvidence -join '; ')",
  '- Boundaries: synthetic data, MockDouyin, image Pipeline Fixture, no real refund action', '',
  '## SHA256', ''
)
foreach ($Hash in $Hashes) { $EvidenceLines += "- $([System.IO.Path]::GetFileName($Hash.Path)): ``$($Hash.Hash)``" }
$EvidenceLines | Set-Content -LiteralPath (Join-Path $RecordingRoot 'RECORDING_EVIDENCE.md') -Encoding UTF8

Write-Output "SHOWCASE_VIDEO=$Voiced"
Write-Output "SHOWCASE_VIDEO_CANONICAL=$Canonical"
Write-Output "SHOWCASE_VIDEO_NO_VOICE=$NoVoice"
Write-Output "SHOWCASE_THUMBNAIL=$Thumbnail"
Write-Output "SHOWCASE_SUBTITLES=$Srt"
Write-Output "SHOWCASE_DURATION=$Duration"
Write-Output "SHOWCASE_RESOLUTION=$($VideoStream.width)x$($VideoStream.height)"
Write-Output "SHOWCASE_FPS=$($VideoStream.avg_frame_rate)"
Write-Output "SHOWCASE_SUBTITLE_PIXEL_CHECK=$($SubtitlePixelEvidence -join '; ')"
