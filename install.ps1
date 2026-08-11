# LLMHarbor Windows installer
# Usage:
#   irm https://raw.githubusercontent.com/PLASMA-FR/LLMHarbor/main/install.ps1 | iex

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$RepoUrl = if ($env:LLMHARBOR_REPO) { $env:LLMHARBOR_REPO } else { "https://github.com/PLASMA-FR/LLMHarbor.git" }
$InstallDir = if ($env:LLMHARBOR_HOME) { $env:LLMHARBOR_HOME } else { Join-Path $env:USERPROFILE ".llmharbor\app" }
$BinDir = if ($env:LLMHARBOR_BIN_DIR) { $env:LLMHARBOR_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "LLMHarbor\bin" }
$CommandPath = Join-Path $BinDir "llmharbor.ps1"
$CmdShimPath = Join-Path $BinDir "llmharbor.cmd"
$MinimumNodeMessage = "Node.js ^22.12.0 or ^24.0.0"

function Fail([string]$Message) {
  [Console]::Error.WriteLine("Error: $Message")
  exit 1
}

function Require-Command([string]$Name, [string]$Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    if ($Hint) { Fail "Missing required command: $Name. $Hint" }
    Fail "Missing required command: $Name"
  }
}

function Invoke-Native([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { Fail "$File exited with code $LASTEXITCODE" }
}

function Test-SupportedNode {
  $Version = (& node -p "process.versions.node" 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $Version) { return $false }
  $Parts = $Version.Trim().Split(".")
  if ($Parts.Count -lt 2) { return $false }
  $Major = [int]$Parts[0]
  $Minor = [int]$Parts[1]
  return (($Major -eq 22 -and $Minor -ge 12) -or $Major -eq 24)
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $Encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $Encoding)
}

function Write-ManagedShim([string]$Path, [string]$Content) {
  $Directory = Split-Path $Path -Parent
  $TemporaryPath = Join-Path $Directory ".llmharbor-shim-$PID-$([Guid]::NewGuid().ToString('N')).tmp"
  try {
    Write-Utf8NoBom $TemporaryPath $Content
    Move-Item -LiteralPath $TemporaryPath -Destination $Path -Force
  } finally {
    Remove-Item -LiteralPath $TemporaryPath -Force -ErrorAction SilentlyContinue
  }
}

function Test-PathEntry([string]$PathValue, [string]$Entry) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) { return $false }
  foreach ($Candidate in $PathValue.Split(';')) {
    if ([string]::Equals($Candidate.TrimEnd('\'), $Entry.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

function Get-CanonicalPath([string]$PathValue) {
  if (Test-Path -LiteralPath $PathValue) { return (Resolve-Path -LiteralPath $PathValue).Path }
  return [System.IO.Path]::GetFullPath($PathValue)
}

function Assert-ExistingInstallIdle([string]$Root) {
  $PidPath = Join-Path $Root ".llmharbor\llmharbor.pid"
  if (-not (Test-Path -LiteralPath $PidPath -PathType Leaf)) { return }
  $PidText = (Get-Content -LiteralPath $PidPath -Raw).Trim()
  $ProcessId = 0
  if ([int]::TryParse($PidText, [ref]$ProcessId) -and $ProcessId -gt 1 -and
      (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
    Fail "LLMHarbor is running with PID $ProcessId. Stop it before rerunning the installer."
  }
}

function Test-ManagedPowerShellShim([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $true }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $Item = Get-Item -LiteralPath $Path -Force
  if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  $Content = Get-Content -LiteralPath $Path -Raw
  return $Content -match '(?m)^# LLMHarbor (Windows command line|managed command shim)'
}

function Test-ManagedCmdShim([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $true }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $Item = Get-Item -LiteralPath $Path -Force
  if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  $Content = Get-Content -LiteralPath $Path -Raw
  return $Content -match '(?im)^(?:rem LLMHarbor managed command shim\r?\n)?@echo off' -and
    $Content -match '(?i)powershell\.exe.+llmharbor\.ps1'
}

Require-Command "git" "Install Git for Windows: https://git-scm.com/download/win"
Require-Command "node" "Install Node.js LTS: https://nodejs.org/"
Require-Command "npm" "Install Node.js LTS: https://nodejs.org/"
if (-not (Test-SupportedNode)) {
  $Version = (& node -p "process.versions.node" 2>$null)
  if (-not $Version) { $Version = "unknown" }
  Fail "$MinimumNodeMessage is required; found Node.js $Version"
}

$InstallDir = Get-CanonicalPath $InstallDir
$BinDir = Get-CanonicalPath $BinDir
$CommandPath = Join-Path $BinDir "llmharbor.ps1"
$CmdShimPath = Join-Path $BinDir "llmharbor.cmd"
$ProspectiveInstalledCli = Join-Path $InstallDir "bin\llmharbor.ps1"
if ([string]::Equals(
    [System.IO.Path]::GetFullPath($CommandPath),
    [System.IO.Path]::GetFullPath($ProspectiveInstalledCli),
    [StringComparison]::OrdinalIgnoreCase)) {
  Fail "Command directory cannot be the repository's bin directory; it would overwrite the installed CLI: $CommandPath"
}
if (-not (Test-ManagedPowerShellShim $CommandPath)) {
  Fail "$CommandPath already exists and is not an LLMHarbor-managed command; refusing to update or overwrite it"
}
if (-not (Test-ManagedCmdShim $CmdShimPath)) {
  Fail "$CmdShimPath already exists and is not an LLMHarbor-managed command; refusing to update or overwrite it"
}

if (Test-Path -LiteralPath (Join-Path $InstallDir ".git") -PathType Container) {
  $InstallDir = (Resolve-Path -LiteralPath $InstallDir).Path
  Assert-ExistingInstallIdle $InstallDir
  $InstalledCli = Join-Path $InstallDir "bin\llmharbor.ps1"
  if (-not (Test-Path -LiteralPath $InstalledCli -PathType Leaf)) { Fail "Installed CLI is missing: $InstalledCli" }
  Write-Host "Updating LLMHarbor through its lifecycle-aware CLI in $InstallDir"
  $PreviousHome = $env:LLMHARBOR_HOME
  $env:LLMHARBOR_HOME = $InstallDir
  try {
    & $InstalledCli update
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  } finally {
    $env:LLMHARBOR_HOME = $PreviousHome
  }
} elseif (Test-Path -LiteralPath $InstallDir) {
  Fail "$InstallDir already exists but is not a git checkout. Set LLMHARBOR_HOME to another directory."
} else {
  Write-Host "Cloning LLMHarbor into $InstallDir"
  $ParentDir = Split-Path $InstallDir -Parent
  if (-not $ParentDir) { Fail "Install directory must have a parent directory: $InstallDir" }
  New-Item -ItemType Directory -Force -Path $ParentDir | Out-Null
  Invoke-Native "git" @("clone", "--", $RepoUrl, $InstallDir)
  $InstallDir = (Resolve-Path -LiteralPath $InstallDir).Path
  $InstalledCli = Join-Path $InstallDir "bin\llmharbor.ps1"
  if (-not (Test-Path -LiteralPath $InstalledCli -PathType Leaf)) { Fail "Installed CLI is missing: $InstalledCli" }
  Write-Host "Installing dependencies and building production assets"
  $PreviousHome = $env:LLMHARBOR_HOME
  $env:LLMHARBOR_HOME = $InstallDir
  try {
    & $InstalledCli install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  } finally {
    $env:LLMHARBOR_HOME = $PreviousHome
  }
}

# Keep the PATH entry as a tiny wrapper instead of copying the implementation.
# Updates then take effect immediately and project-root discovery stays correct.
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$BinDir = (Resolve-Path -LiteralPath $BinDir).Path
$CommandPath = Join-Path $BinDir "llmharbor.ps1"
$CmdShimPath = Join-Path $BinDir "llmharbor.cmd"
$InstalledCli = (Resolve-Path -LiteralPath (Join-Path $InstallDir "bin\llmharbor.ps1")).Path
if ([string]::Equals(
    [System.IO.Path]::GetFullPath($CommandPath),
    [System.IO.Path]::GetFullPath($InstalledCli),
    [StringComparison]::OrdinalIgnoreCase)) {
  Fail "Command directory cannot be the repository's bin directory; it would overwrite the installed CLI: $CommandPath"
}
if (-not (Test-ManagedPowerShellShim $CommandPath)) {
  Fail "$CommandPath already exists and is not an LLMHarbor-managed command; refusing to overwrite it"
}
if (-not (Test-ManagedCmdShim $CmdShimPath)) {
  Fail "$CmdShimPath already exists and is not an LLMHarbor-managed command; refusing to overwrite it"
}
$EscapedInstallDir = $InstallDir.Replace("'", "''")
$EscapedInstalledCli = $InstalledCli.Replace("'", "''")
$PowerShellShim = @"
# LLMHarbor managed command shim
if (-not `$env:LLMHARBOR_HOME) { `$env:LLMHARBOR_HOME = '$EscapedInstallDir' }
& '$EscapedInstalledCli' @args
if (`$?) { exit 0 } else { exit 1 }
"@
Write-ManagedShim $CommandPath ($PowerShellShim + "`r`n")

$CmdShim = "rem LLMHarbor managed command shim`r`n@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0llmharbor.ps1`" %*`r`n"
Write-ManagedShim $CmdShimPath $CmdShim

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not (Test-PathEntry $UserPath $BinDir)) {
  $NewUserPath = if ([string]::IsNullOrWhiteSpace($UserPath)) { $BinDir } else { $UserPath.TrimEnd(';') + ";" + $BinDir }
  [Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")
  $ProcessPath = [Environment]::GetEnvironmentVariable("PATH", "Process")
  if (-not (Test-PathEntry $ProcessPath $BinDir)) {
    $NewProcessPath = if ([string]::IsNullOrWhiteSpace($ProcessPath)) { $BinDir } else { $ProcessPath.TrimEnd(';') + ";" + $BinDir }
    [Environment]::SetEnvironmentVariable("PATH", $NewProcessPath, "Process")
  }
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
