# LLMHarbor Windows installer
# Usage:
#   irm https://raw.githubusercontent.com/PLASMA-FR/LLMHarbor/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

$RepoUrl = if ($env:LLMHARBOR_REPO) { $env:LLMHARBOR_REPO } else { "https://github.com/PLASMA-FR/LLMHarbor.git" }
$InstallDir = if ($env:LLMHARBOR_HOME) { $env:LLMHARBOR_HOME } else { Join-Path $env:USERPROFILE ".llmharbor\app" }
$BinDir = if ($env:LLMHARBOR_BIN_DIR) { $env:LLMHARBOR_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "LLMHarbor\bin" }
$CommandPath = Join-Path $BinDir "llmharbor.ps1"
$CmdShimPath = Join-Path $BinDir "llmharbor.cmd"

function Fail($Message) {
  Write-Error "Error: $Message"
  exit 1
}

function Require-Command($Name, $Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    if ($Hint) { Fail "Missing required command: $Name. $Hint" }
    Fail "Missing required command: $Name"
  }
}

Require-Command git "Install Git for Windows: https://git-scm.com/download/win"
Require-Command node "Install Node.js LTS: https://nodejs.org/"
Require-Command npm "Install Node.js LTS: https://nodejs.org/"

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

if (Test-Path (Join-Path $InstallDir ".git")) {
  Write-Host "Updating LLMHarbor in $InstallDir"
  git -C $InstallDir pull --ff-only
} elseif (Test-Path $InstallDir) {
  Fail "$InstallDir already exists but is not a git checkout. Set LLMHARBOR_HOME to another directory."
} else {
  Write-Host "Cloning LLMHarbor into $InstallDir"
  New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir -Parent) | Out-Null
  git clone $RepoUrl $InstallDir
}

Write-Host "Installing dependencies and building production assets"
& (Join-Path $InstallDir "bin\llmharbor.ps1") install

Copy-Item (Join-Path $InstallDir "bin\llmharbor.ps1") $CommandPath -Force
@"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$CommandPath" %*
"@ | Set-Content -Path $CmdShimPath -NoNewline

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not (($UserPath -split ';') -contains $BinDir)) {
  [Environment]::SetEnvironmentVariable("Path", ($UserPath.TrimEnd(';') + ";" + $BinDir), "User")
  $env:Path = $env:Path + ";" + $BinDir
  $PathNote = "Added $BinDir to your user PATH. Open a new terminal if llmharbor is not found."
} else {
  $PathNote = "$BinDir is already on your user PATH."
}

Write-Host ""
Write-Host "LLMHarbor installed."
Write-Host ""
Write-Host "Command:"
Write-Host "  $CmdShimPath"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  llmharbor start"
Write-Host "  llmharbor open"
Write-Host ""
Write-Host $PathNote
