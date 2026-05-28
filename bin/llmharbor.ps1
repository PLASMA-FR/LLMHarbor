# LLMHarbor Windows command line
param(
  [Parameter(Position = 0)]
  [string]$Command = "help"
)

$ErrorActionPreference = "Stop"
$AppName = "LLMHarbor"
$DefaultPort = "3001"

function Get-ProjectRoot {
  if ($env:LLMHARBOR_HOME) { return (Resolve-Path $env:LLMHARBOR_HOME).Path }
  return (Resolve-Path (Join-Path $PSScriptRoot ".." )).Path
}

$ProjectRoot = Get-ProjectRoot
$StateDir = Join-Path $ProjectRoot ".llmharbor"
$PidFile = Join-Path $StateDir "llmharbor.pid"
$LogFile = Join-Path $StateDir "llmharbor.log"

function Fail($Message) {
  Write-Error "Error: $Message"
  exit 1
}

function Require-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { Fail "Missing required command: $Name" }
}

function Get-Port {
  if ($env:PORT) { $PortValue = $env:PORT } else {
    $EnvFile = Join-Path $ProjectRoot ".env"
    if (Test-Path $EnvFile) {
      $Line = Get-Content $EnvFile | Where-Object { $_ -match '^PORT=' } | Select-Object -Last 1
      if ($Line) { $PortValue = ($Line -replace '^PORT=', '') }
    }
    if (-not $PortValue) { $PortValue = $DefaultPort }
  }
  if ($PortValue -notmatch '^[0-9]+$') { Fail "PORT must be numeric: $PortValue" }
  $PortNumber = [int]$PortValue
  if ($PortNumber -lt 1 -or $PortNumber -gt 65535) { Fail "PORT must be between 1 and 65535: $PortValue" }
  return $PortValue
}

function New-EncryptionKey {
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
}

function Ensure-Env {
  Require-Command node
  Push-Location $ProjectRoot
  try {
    if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env" }
    $EnvText = Get-Content ".env" -Raw
    if ($EnvText -notmatch '(?m)^ENCRYPTION_KEY=[0-9a-fA-F]{64}$') {
      $Key = New-EncryptionKey
      if ($EnvText -match '(?m)^ENCRYPTION_KEY=') {
        $EnvText = $EnvText -replace '(?m)^ENCRYPTION_KEY=.*$', "ENCRYPTION_KEY=$Key"
      } else {
        $EnvText = $EnvText.TrimEnd() + "`r`nENCRYPTION_KEY=$Key`r`n"
      }
      Set-Content -Path ".env" -Value $EnvText -NoNewline
      Write-Host "Created a local ENCRYPTION_KEY in .env"
    }
  } finally { Pop-Location }
}

function Test-Running {
  if (-not (Test-Path $PidFile)) { return $false }
  $PidValue = Get-Content $PidFile -Raw
  $PidValue = $PidValue.Trim()
  if (-not $PidValue) { return $false }
  return [bool](Get-Process -Id ([int]$PidValue) -ErrorAction SilentlyContinue)
}

function Install-App {
  Require-Command node
  Require-Command npm
  Ensure-Env
  Push-Location $ProjectRoot
  try {
    npm install
    npm run build
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    Write-Host "$AppName is installed. Run: llmharbor start"
  } finally { Pop-Location }
}

function Start-App {
  Require-Command node
  Require-Command npm
  Ensure-Env
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  if (Test-Running) {
    Write-Host "$AppName is already running with PID $(Get-Content $PidFile)"
    return
  }
  if (-not (Test-Path (Join-Path $ProjectRoot "server/dist/index.js")) -or -not (Test-Path (Join-Path $ProjectRoot "client/dist/index.html"))) {
    Push-Location $ProjectRoot
    try { npm run build } finally { Pop-Location }
  }
  $Port = Get-Port
  Set-Content -Path $LogFile -Value ""
  $Args = "/c set PORT=$Port&& set NODE_ENV=production&& node server/dist/index.js >> `"$LogFile`" 2>&1"
  $Process = Start-Process -FilePath "cmd.exe" -ArgumentList $Args -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru
  Set-Content -Path $PidFile -Value $Process.Id
  Start-Sleep -Seconds 1
  if (-not (Get-Process -Id $Process.Id -ErrorAction SilentlyContinue)) {
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Write-Host "Startup failed. Last logs:"
    if (Test-Path $LogFile) { Get-Content $LogFile -Tail 40 }
    exit 1
  }
  Write-Host "$AppName started on http://localhost:$Port with PID $($Process.Id)"
}

function Stop-App {
  if (-not (Test-Running)) {
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Write-Host "$AppName is not running"
    return
  }
  $PidValue = [int](Get-Content $PidFile -Raw).Trim()
  Stop-Process -Id $PidValue -Force -ErrorAction SilentlyContinue
  Remove-Item $PidFile -ErrorAction SilentlyContinue
  Write-Host "$AppName stopped"
}

function Status-App {
  $Port = Get-Port
  $Url = "http://localhost:$Port/api/ping"
  if (Test-Running) { Write-Host "Process: running, PID $(Get-Content $PidFile)" } else { Write-Host "Process: stopped" }
  try {
    Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 | Out-Null
    Write-Host "Health:  ok ($Url)"
  } catch {
    Write-Host "Health:  unavailable ($Url)"
  }
  Write-Host "Home:    $ProjectRoot"
  Write-Host "Logs:    $LogFile"
}

function Update-App {
  Require-Command git
  $WasRunning = Test-Running
  Push-Location $ProjectRoot
  try { git pull --ff-only } finally { Pop-Location }
  Install-App
  if ($WasRunning) { Stop-App; Start-App }
}

function Open-App {
  $Port = Get-Port
  Start-Process "http://localhost:$Port"
}

function Print-Urls {
  $Port = Get-Port
  Write-Host "Dashboard: http://localhost:$Port"
  Write-Host "API base:  http://localhost:$Port/v1"
  Write-Host "Chat:      http://localhost:$Port/v1/chat/completions"
}

function Doctor {
  foreach ($Cmd in @("git", "node", "npm")) {
    if (Get-Command $Cmd -ErrorAction SilentlyContinue) { Write-Host "ok   $Cmd" } else { Write-Host "miss $Cmd" }
  }
  Write-Host "Home $ProjectRoot"
}

function Help {
  @"
LLMHarbor command line

Usage:
  llmharbor <command>

Commands:
  install   Install npm dependencies, create .env, and build production assets
  dev       Run the API and dashboard in development mode
  start     Start the production server in the background
  stop      Stop the background production server
  restart   Restart the background production server
  status    Show process and health-check status
  logs      Print recent background server logs
  update    Pull latest git changes, rebuild, and restart if already running
  open      Open the dashboard in your browser
  url       Print dashboard and OpenAI-compatible API URLs
  doctor    Check local prerequisites
  help      Show this help
"@
}

switch ($Command.ToLowerInvariant()) {
  "install" { Install-App }
  "dev" { Ensure-Env; Push-Location $ProjectRoot; try { npm run dev } finally { Pop-Location } }
  "start" { Start-App }
  "stop" { Stop-App }
  "restart" { Stop-App; Start-App }
  "status" { Status-App }
  "logs" { if (Test-Path $LogFile) { Get-Content $LogFile -Tail 120 -Wait } else { Write-Host "No log file yet: $LogFile" } }
  "update" { Update-App }
  "open" { Open-App }
  "url" { Print-Urls }
  "doctor" { Doctor }
  default { Help }
}
