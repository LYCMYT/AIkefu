param(
  [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $RepoRoot 'artifacts\demo\voiceover'
}

$ResolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
$AllowedRoot = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot 'artifacts\demo'))
if (-not $ResolvedOutput.StartsWith($AllowedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "VOICEOVER_OUTPUT_OUTSIDE_ARTIFACTS: $ResolvedOutput"
}

New-Item -ItemType Directory -Force -Path $ResolvedOutput | Out-Null
Add-Type -AssemblyName System.Speech

$Segments = @(
  [pscustomobject]@{
    OffsetMs = 500
    Text = '这是 AIkefu，多租户电商 AI 客服与可靠回复编排系统。演示使用合成数据和 MockDouyin，不接入真实电商平台。'
  },
  [pscustomobject]@{
    OffsetMs = 15000
    Text = '统一工作台把会话、消息、AI 状态和业务上下文放在同一界面。没有会话时保持清晰空态，需要的订单、记忆、证据和追踪信息按需展开。'
  },
  [pscustomobject]@{
    OffsetMs = 30000
    Text = '买家模拟器发送三条连续咨询。真实后端先提交消息，再在短窗口内聚合成一个用户轮次，减少重复规划。商品和订单卡也使用同一条持久消息链，而不是前端假状态。'
  },
  [pscustomobject]@{
    OffsetMs = 57000
    Text = '回到工作台，可以看到店铺知识与偏远地区政策支撑的回复。高风险、证据不足或人工接管时，系统不会越权自动发送。人工最终回复仍经过发送守卫、发件箱和回执投影。'
  },
  [pscustomobject]@{
    OffsetMs = 86000
    Text = '运营总览只显示当前工作空间的真实快照。没有数据时明确显示零值或空态，不使用虚构增长曲线填充页面。'
  },
  [pscustomobject]@{
    OffsetMs = 103000
    Text = '每家店铺拥有独立的 AI 总开关。关闭后，未发送任务、草稿、发件箱和定时消息立即失效；已经开始但没有确认的发送进入不确定状态，禁止自动重试。'
  },
  [pscustomobject]@{
    OffsetMs = 122000
    Text = '商品学习和知识治理区分正式、候选、冲突与学习任务。动态库存和订单状态不写入静态知识；最终回答保存证据快照，方便复核当时依据。'
  },
  [pscustomobject]@{
    OffsetMs = 143000
    Text = '工作流支持版本化图编排、运行恢复和人工审批。高风险动作必须形成提案并重新校验业务对象，模型不能直接执行退款等真实动作。'
  },
  [pscustomobject]@{
    OffsetMs = 161000
    Text = '场景实验室提供八个可重复验收场景，覆盖连续消息、跨店隔离、动态事实、澄清、人工接管和崩溃恢复。AIkefu 的重点，是让每一次 AI 回复都可追踪、可降级、可恢复。'
  }
)

$VoiceName = 'Microsoft Huihui Desktop'
$InstalledVoices = @()
$Probe = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
  $InstalledVoices = @($Probe.GetInstalledVoices() | Where-Object Enabled | ForEach-Object { $_.VoiceInfo.Name })
} finally {
  $Probe.Dispose()
}

if ($InstalledVoices -notcontains $VoiceName) {
  $VoiceName = $InstalledVoices | Where-Object { $_ -match 'Huihui|Yaoyao|Kangkang' } | Select-Object -First 1
}
if ([string]::IsNullOrWhiteSpace($VoiceName)) {
  throw 'CHINESE_SAPI_VOICE_NOT_FOUND'
}

$ManifestSegments = @()
for ($Index = 0; $Index -lt $Segments.Count; $Index += 1) {
  $Segment = $Segments[$Index]
  $FileName = 'segment-{0:D2}.wav' -f ($Index + 1)
  $FilePath = Join-Path $ResolvedOutput $FileName
  $Synthesizer = [System.Speech.Synthesis.SpeechSynthesizer]::new()
  try {
    $Synthesizer.SelectVoice($VoiceName)
    $Synthesizer.Rate = 1
    $Synthesizer.Volume = 100
    $Synthesizer.SetOutputToWaveFile($FilePath)
    $Synthesizer.Speak($Segment.Text)
  } finally {
    $Synthesizer.Dispose()
  }
  $ManifestSegments += [pscustomobject]@{
    offsetMs = $Segment.OffsetMs
    file = $FileName
    text = $Segment.Text
  }
}

$Manifest = [pscustomobject]@{
  voice = $VoiceName
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  segments = $ManifestSegments
}
$ManifestPath = Join-Path $ResolvedOutput 'manifest.json'
$Manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8

Write-Output "VOICEOVER_MANIFEST=$ManifestPath"
Write-Output "VOICEOVER_SEGMENTS=$($Segments.Count)"
Write-Output "VOICEOVER_VOICE=$VoiceName"
