param(
  [switch]$SkipServices
)

$ErrorActionPreference = "Stop"
$DockerExe = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
$DockerDesktopExe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

function Ensure-Admin {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
    Write-Host "此脚本需要管理员权限，正在尝试提权..."
    $arguments = @("-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    if ($SkipServices) { $arguments += "-SkipServices" }
    Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList $arguments -Verb RunAs
    exit
  }
}

function Test-PathTool {
  param([string]$Path, [string]$Label)
  if (-not (Test-Path $Path)) {
    throw "$Label 未找到：$Path"
  }
}

function Ensure-WindowsContainerHost {
  $requiredFeatures = @(
    "Microsoft-Windows-Subsystem-Linux",
    "VirtualMachinePlatform"
  )
  $restartRequired = $false

  foreach ($featureName in $requiredFeatures) {
    $feature = Get-WindowsOptionalFeature -Online -FeatureName $featureName
    if ($feature.State -ne "Enabled") {
      Write-Host "启用 Windows 功能：$featureName"
      $result = Enable-WindowsOptionalFeature -Online -FeatureName $featureName -All -NoRestart
      $restartRequired = $restartRequired -or $result.RestartNeeded
    }
  }

  $virtualizationEnabled = @(Get-CimInstance Win32_Processor | Where-Object { $_.VirtualizationFirmwareEnabled }).Count -gt 0
  if (-not $virtualizationEnabled) {
    throw "CPU 虚拟化尚未在 BIOS/UEFI 中启用；Docker Desktop 的 Linux engine 无法启动。"
  }

  if ($restartRequired) {
    Write-Host "Windows 容器前置功能已启用。必须重启 Windows 后再次运行 pnpm infra:bootstrap。"
    exit 3010
  }

  & "$env:WINDIR\System32\wsl.exe" --status *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "安装 WSL2 运行时（不安装额外 Linux 发行版）..."
    & "$env:WINDIR\System32\wsl.exe" --install --no-distribution
    if ($LASTEXITCODE -ne 0) {
      throw "WSL2 运行时安装失败。"
    }
    & "$env:WINDIR\System32\wsl.exe" --status *> $null
    if ($LASTEXITCODE -ne 0) {
      Write-Host "WSL2 运行时已安装，必须重启 Windows 后再次运行 pnpm infra:bootstrap。"
      exit 3010
    }
  }
}

function Test-DockerEngine {
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $DockerExe
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.ArgumentList.Add("version")
  $startInfo.ArgumentList.Add("--format")
  $startInfo.ArgumentList.Add("{{.Server.Version}}")

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    [void]$process.Start()
    if (-not $process.WaitForExit(5000)) {
      $process.Kill($true)
      return $false
    }
    return $process.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($process.StandardOutput.ReadToEnd())
  } finally {
    $process.Dispose()
  }
}

function Require-ComposeServices {
  if ($SkipServices) {
    Write-Host "已传入 -SkipServices，跳过容器启动步骤。"
    return
  }

  Set-Location $RepoRoot
  if (-not (Test-Path "docker-compose.yml")) {
    throw "docker-compose.yml 不存在：$RepoRoot"
  }

  Write-Host "启动基础设施：PostgreSQL / Redis / MinIO..."
  & $DockerExe compose -f "docker-compose.yml" up -d --wait --wait-timeout 180
  if ($LASTEXITCODE -ne 0) {
    throw "docker compose up 失败。请检查 Docker 引擎状态与 docker-compose.yml。"
  }

  Write-Host "等待服务状态..."
  & $DockerExe compose -f "docker-compose.yml" ps
}

Write-Host "=== Docker 基础设施一键脚本 ==="
Ensure-Admin

Test-PathTool -Path $DockerExe -Label "Docker CLI"
Test-PathTool -Path $DockerDesktopExe -Label "Docker Desktop"
Ensure-WindowsContainerHost

# 优先用 docker exe 临时调用，避免 PATH 干扰
& "$env:WINDIR\System32\where.exe" docker 2>$null | Out-Null

$dockerService = Get-Service -Name "com.docker.service" -ErrorAction SilentlyContinue
if ($dockerService -and $dockerService.Status -ne "Running") {
  Write-Host "启动 Docker Desktop 系统服务..."
  Start-Service -Name "com.docker.service"
}

Write-Host "启动 Docker Desktop（若未运行）..."
if (-not (Get-Process -Name "Docker Desktop" -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath $DockerDesktopExe | Out-Null
}

Write-Host "检查 dockerDesktopLinuxEngine 可达性..."
$maxTry = 24
for ($i = 1; $i -le $maxTry; $i++) {
  if (Test-DockerEngine) {
    Write-Host "Docker engine 已可用（第 $i 次）"
    break
  } else {
    Write-Host "等待 Docker engine：第 $i/$maxTry 次..."
    Start-Sleep -Seconds 5
    if ($i -eq $maxTry) {
      throw "Docker engine 未可用。请先在 Docker Desktop 里确认 WSL2 后端/Hyper-V 已启动，必要时重启电脑。"
    }
  }
}

if (Test-Path "$RepoRoot/.env") {
  Write-Host ".env 已检测到，继续使用仓库配置"
}

Require-ComposeServices

Write-Host "执行数据库初始化..."
Set-Location $RepoRoot
$env:Path += ";C:\Program Files\Docker\Docker\resources\bin"
pnpm db:deploy
if ($LASTEXITCODE -ne 0) {
  throw "Prisma migration deploy 失败。"
}

Write-Host "环境打通完成。可继续执行："
Write-Host "pnpm typecheck"
Write-Host "pnpm test:unit"
Write-Host "pnpm test:integration"
Write-Host "RUN_REAL_INFRA_INTEGRATION=1 pnpm test:integration"
