# LLMHarbor Windows command line. Parse the automatic argument array instead
# of PowerShell parameters so Unix-style options such as --host pass through.
$RawArguments = @($args)
$Command = if ($RawArguments.Count -gt 0) { [string]$RawArguments[0] } else { "help" }
$CommandArgs = if ($RawArguments.Count -gt 1) {
  [string[]]$RawArguments[1..($RawArguments.Count - 1)]
} else {
  [string[]]@()
}

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$AppName = "LLMHarbor"
$DefaultPort = "3001"
$DefaultTailscaleDashboardPort = "3002"
$DefaultPublicApiPort = "3001"
$MinimumNodeMessage = "Node.js ^22.12.0 or ^24.0.0"
$script:StartForeground = $false
$script:StartSave = $false
$script:StartOverrides = [ordered]@{}
$script:LockStream = $null
$script:StartupTimeout = 15
$script:PendingStartProcess = $null

function Fail([string]$Message) {
  [Console]::Error.WriteLine("Error: $Message")
  exit 1
}

function Log([string]$Message) {
  [Console]::Error.WriteLine($Message)
}

function Get-ProjectRoot {
  $Candidate = if ($env:LLMHARBOR_HOME) { $env:LLMHARBOR_HOME } else { Join-Path $PSScriptRoot ".." }
  if (-not (Test-Path -LiteralPath $Candidate -PathType Container)) {
    Fail "Project directory not found: $Candidate"
  }
  return (Resolve-Path -LiteralPath $Candidate).Path
}

$ProjectRoot = Get-ProjectRoot
$StateDir = Join-Path $ProjectRoot ".llmharbor"
$PidFile = Join-Path $StateDir "llmharbor.pid"
$PidStartFile = Join-Path $StateDir "llmharbor.pid.start"
$RuntimeConfigFile = Join-Path $StateDir "runtime.json"
$LockFile = Join-Path $StateDir "lifecycle.lock"
$LogFile = Join-Path $StateDir "llmharbor.log"
$ErrorLogFile = Join-Path $StateDir "llmharbor.error.log"
$EnvFile = Join-Path $ProjectRoot ".env"

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Fail "Missing required command: $Name"
  }
}

function Test-SupportedNode {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
  $Version = (& node -p "process.versions.node" 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $Version) { return $false }
  $Parts = $Version.Trim().Split(".")
  if ($Parts.Count -lt 2) { return $false }
  $Major = [int]$Parts[0]
  $Minor = [int]$Parts[1]
  return (($Major -eq 22 -and $Minor -ge 12) -or $Major -eq 24)
}

function Require-SupportedNode {
  Require-Command "node"
  if (-not (Test-SupportedNode)) {
    $Version = (& node -p "process.versions.node" 2>$null)
    if (-not $Version) { $Version = "unknown" }
    Fail "$MinimumNodeMessage is required; found Node.js $Version"
  }
}

function Assert-StartupTimeout {
  $TimeoutText = if ($env:LLMHARBOR_STARTUP_TIMEOUT) { $env:LLMHARBOR_STARTUP_TIMEOUT } else { "15" }
  $Timeout = 0
  if (-not [int]::TryParse($TimeoutText, [ref]$Timeout) -or $Timeout -lt 1 -or $Timeout -gt 300) {
    Fail "LLMHARBOR_STARTUP_TIMEOUT must be between 1 and 300 seconds"
  }
  $script:StartupTimeout = $Timeout
}

function Invoke-Native([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) {
    Fail "$File exited with code $LASTEXITCODE"
  }
}

function Ensure-NoArgs([string]$Name, [string[]]$Arguments) {
  $ActualArguments = @($Arguments | Where-Object { $null -ne $_ })
  if ($ActualArguments.Count -gt 0) {
    Fail "$Name does not accept arguments: $($Arguments -join ' ')"
  }
}

function Ensure-StateDir {
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
}

function Acquire-LifecycleLock {
  if ($script:LockStream) { return }
  Ensure-StateDir

  for ($Attempt = 0; $Attempt -lt 2; $Attempt++) {
    try {
      $script:LockStream = [System.IO.File]::Open(
        $LockFile,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
      )
      $Bytes = [System.Text.Encoding]::ASCII.GetBytes("$PID`r`n")
      $script:LockStream.Write($Bytes, 0, $Bytes.Length)
      $script:LockStream.Flush()
      return
    } catch [System.IO.IOException] {
      if ($Attempt -eq 0) {
        # On Unix an open file may still be unlinked, so never remove a lock
        # merely because CreateNew failed. Check the recorded owner first.
        $OwnerId = 0
        try {
          $OwnerText = (Get-Content -LiteralPath $LockFile -Raw -ErrorAction Stop).Trim()
          if (-not [int]::TryParse($OwnerText, [ref]$OwnerId) -or $OwnerId -le 1) {
            Fail "Lifecycle lock has no valid owner; remove it if no LLMHarbor command is running: $LockFile"
          }
          if (Get-Process -Id $OwnerId -ErrorAction SilentlyContinue) {
            Fail "Another LLMHarbor lifecycle command is running with PID $OwnerId"
          }
        } catch {
          # A live Windows owner opens the file without sharing, so an
          # unreadable lock must also be treated as active rather than stale.
          Fail "Another LLMHarbor lifecycle command is running (lock: $LockFile)"
        }
        try {
          Remove-Item -LiteralPath $LockFile -Force -ErrorAction Stop
        } catch {
          Fail "Could not clear stale lifecycle lock: $LockFile"
        }
      }
    }
  }
  Fail "Another LLMHarbor lifecycle command is running (lock: $LockFile)"
}

function Release-LifecycleLock {
  if ($script:LockStream) {
    $script:LockStream.Dispose()
    $script:LockStream = $null
    Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
  }
}

function Read-EnvValue([string]$Name) {
  if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { return $null }
  $Found = $null
  foreach ($Line in (Get-Content -LiteralPath $EnvFile)) {
    if ($Line.StartsWith("$Name=")) { $Found = $Line.Substring($Name.Length + 1) }
  }
  if ([string]::IsNullOrWhiteSpace($Found)) { return $null }
  if ($Found.Length -ge 2) {
    if (($Found.StartsWith('"') -and $Found.EndsWith('"')) -or ($Found.StartsWith("'") -and $Found.EndsWith("'"))) {
      $Found = $Found.Substring(1, $Found.Length - 2)
    }
  }
  if ([string]::IsNullOrWhiteSpace($Found)) { return $null }
  return $Found
}

function Get-ConfigValue([string]$Name) {
  $ProcessValue = [Environment]::GetEnvironmentVariable($Name, "Process")
  if (-not [string]::IsNullOrWhiteSpace($ProcessValue)) { return $ProcessValue }
  return Read-EnvValue $Name
}

function Get-FirstConfigValue([string]$Fallback, [string[]]$Names) {
  foreach ($Name in $Names) {
    $Value = Get-ConfigValue $Name
    if (-not [string]::IsNullOrWhiteSpace($Value)) { return $Value }
  }
  return $Fallback
}

function Assert-Port([string]$Label, [string]$Value) {
  $Number = 0
  if (-not [int]::TryParse($Value, [ref]$Number)) { Fail "$Label must be numeric: $Value" }
  if ($Number -lt 1 -or $Number -gt 65535) { Fail "$Label must be between 1 and 65535: $Value" }
}

function Assert-Host([string]$Label, [string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { Fail "$Label cannot be empty" }
  if ($Value.Length -gt 253 -or $Value -notmatch '^[A-Za-z0-9._:%-]+$') {
    Fail "$Label contains unsupported characters: $Value"
  }
}

function Get-DashboardPort {
  $Legacy = Get-FirstConfigValue $DefaultPort @("PORT")
  $Value = Get-FirstConfigValue $Legacy @("LLMHARBOR_DASHBOARD_PORT", "DASHBOARD_PORT")
  Assert-Port "LLMHARBOR_DASHBOARD_PORT" $Value
  return $Value
}

function Get-DashboardHost {
  $Legacy = Get-FirstConfigValue "127.0.0.1" @("HOST")
  $Value = Get-FirstConfigValue $Legacy @("LLMHARBOR_DASHBOARD_HOST", "DASHBOARD_HOST")
  Assert-Host "LLMHARBOR_DASHBOARD_HOST" $Value
  return $Value
}

function Get-PublicApiPort {
  $Value = Get-FirstConfigValue $null @("LLMHARBOR_PUBLIC_API_PORT", "PUBLIC_API_PORT", "API_PORT")
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  Assert-Port "LLMHARBOR_PUBLIC_API_PORT" $Value
  return $Value
}

function Get-PublicApiHost {
  $Value = Get-FirstConfigValue "0.0.0.0" @("LLMHARBOR_PUBLIC_API_HOST", "PUBLIC_API_HOST", "API_HOST")
  Assert-Host "LLMHARBOR_PUBLIC_API_HOST" $Value
  return $Value
}

function Get-UrlHost([string]$HostName) {
  if ($HostName -eq "0.0.0.0") { return "localhost" }
  if ($HostName -eq "::") { return "[::1]" }
  if ($HostName.Contains(":") -and -not $HostName.StartsWith("[")) { return "[$HostName]" }
  return $HostName
}

function Get-PublicUrlHost([string]$HostName) {
  if ($HostName -eq "0.0.0.0" -or $HostName -eq "::") { return "<public-ip>" }
  return Get-UrlHost $HostName
}

function Get-DashboardUrl {
  return "http://$(Get-UrlHost (Get-DashboardHost)):$(Get-DashboardPort)"
}

function Get-ApiBaseUrl {
  $Port = Get-PublicApiPort
  if ($Port) { return "http://$(Get-PublicUrlHost (Get-PublicApiHost)):$Port/v1" }
  return "$(Get-DashboardUrl)/v1"
}

function Assert-ListenerConfig {
  $DashboardHost = Get-DashboardHost
  $DashboardPort = Get-DashboardPort
  $PublicPort = Get-PublicApiPort
  if (-not $PublicPort) { return }
  $PublicHost = Get-PublicApiHost
  $Wildcard = @("0.0.0.0", "::")
  if ($DashboardPort -eq $PublicPort -and (
      $DashboardHost -eq $PublicHost -or $Wildcard -contains $DashboardHost -or $Wildcard -contains $PublicHost
    )) {
    Fail "Dashboard and public API listeners overlap on $DashboardPort; choose different ports or non-overlapping bind addresses"
  }
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $Encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $Encoding)
}

function Write-EnvValue([string]$Name, [string]$Value) {
  $Lines = @()
  if (Test-Path -LiteralPath $EnvFile) { $Lines = @(Get-Content -LiteralPath $EnvFile) }
  $Found = $false
  $Output = foreach ($Line in $Lines) {
    if ($Line.StartsWith("$Name=")) {
      $Found = $true
      "$Name=$Value"
    } else {
      $Line
    }
  }
  if (-not $Found) { $Output = @($Output) + "" + "$Name=$Value" }
  Write-Utf8NoBom $EnvFile ((@($Output) -join [Environment]::NewLine) + [Environment]::NewLine)
}

function New-EncryptionKey {
  $Key = (& node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  if ($LASTEXITCODE -ne 0 -or $Key -notmatch '^[0-9a-fA-F]{64}$') {
    Fail "Could not generate an encryption key"
  }
  return $Key.Trim()
}

function Ensure-Env {
  Require-SupportedNode
  if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
    $Template = Join-Path $ProjectRoot ".env.example"
    if (-not (Test-Path -LiteralPath $Template -PathType Leaf)) { Fail "Missing environment template: $Template" }
    Copy-Item -LiteralPath $Template -Destination $EnvFile
  }

  $ConfiguredKey = Read-EnvValue "ENCRYPTION_KEY"
  if ($ConfiguredKey -match '^[0-9a-fA-F]{64}$') { return }
  if ($ConfiguredKey -and $ConfiguredKey -ne "your-64-char-hex-key-here") {
    Fail "Invalid ENCRYPTION_KEY in $EnvFile; expected exactly 64 hexadecimal characters. Refusing to replace it because doing so could make stored credentials unreadable."
  }

  $DatabaseExists = (Test-Path -LiteralPath (Join-Path $ProjectRoot "server\data\llmharbor.db")) -or
    (Test-Path -LiteralPath (Join-Path $ProjectRoot "server\data\freeapi.db"))
  if ($DatabaseExists) {
    Log "Using the existing database-managed encryption key"
    return
  }

  Write-EnvValue "ENCRYPTION_KEY" (New-EncryptionKey)
  Log "Created a local ENCRYPTION_KEY in .env"
}

function Set-StartOverride([string]$Name, [string]$Value) {
  if ($Name -eq "LLMHARBOR_DASHBOARD_HOST" -or $Name -eq "LLMHARBOR_PUBLIC_API_HOST") {
    Assert-Host $Name $Value
  }
  [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
  $script:StartOverrides[$Name] = $Value
}

function Set-StartPortOverride([string]$Name, [string]$Value) {
  Assert-Port $Name $Value
  Set-StartOverride $Name $Value
}

function Get-RequiredOptionValue([string]$Option, [string[]]$Arguments, [int]$Index) {
  if ($Index + 1 -ge $Arguments.Count -or [string]::IsNullOrWhiteSpace($Arguments[$Index + 1]) -or $Arguments[$Index + 1].StartsWith("--")) {
    Fail "$Option requires a value"
  }
  return $Arguments[$Index + 1]
}

function Parse-StartOptions([string[]]$Arguments) {
  $Arguments = @($Arguments | Where-Object { $null -ne $_ })
  $script:StartForeground = $false
  $script:StartSave = $false
  $script:StartOverrides = [ordered]@{}

  for ($Index = 0; $Index -lt $Arguments.Count; $Index++) {
    $Arg = $Arguments[$Index]
    switch -Regex ($Arg) {
      '^--(foreground|fg|no-daemon)$' { $script:StartForeground = $true; continue }
      '^--(background|daemon)$' { $script:StartForeground = $false; continue }
      '^--(host|dashboard-host)$' {
        $Value = Get-RequiredOptionValue $Arg $Arguments $Index
        Set-StartOverride "LLMHARBOR_DASHBOARD_HOST" $Value
        $Index++; continue
      }
      '^--(host|dashboard-host)=(.+)$' { Set-StartOverride "LLMHARBOR_DASHBOARD_HOST" $Matches[2]; continue }
      '^--(port|dashboard-port)$' {
        $Value = Get-RequiredOptionValue $Arg $Arguments $Index
        Set-StartPortOverride "LLMHARBOR_DASHBOARD_PORT" $Value
        $Index++; continue
      }
      '^--(port|dashboard-port)=(.*)$' { Set-StartPortOverride "LLMHARBOR_DASHBOARD_PORT" $Matches[2]; continue }
      '^--(public-api-host|api-host)$' {
        $Value = Get-RequiredOptionValue $Arg $Arguments $Index
        Set-StartOverride "LLMHARBOR_PUBLIC_API_HOST" $Value
        $Index++; continue
      }
      '^--(public-api-host|api-host)=(.+)$' { Set-StartOverride "LLMHARBOR_PUBLIC_API_HOST" $Matches[2]; continue }
      '^--(public-api-port|api-port)$' {
        $Value = Get-RequiredOptionValue $Arg $Arguments $Index
        Set-StartPortOverride "LLMHARBOR_PUBLIC_API_PORT" $Value
        $Index++; continue
      }
      '^--(public-api-port|api-port)=(.*)$' { Set-StartPortOverride "LLMHARBOR_PUBLIC_API_PORT" $Matches[2]; continue }
      '^--split$' {
        if (-not (Get-ConfigValue "LLMHARBOR_PUBLIC_API_PORT")) {
          Set-StartPortOverride "LLMHARBOR_PUBLIC_API_PORT" $DefaultPublicApiPort
        }
        continue
      }
      '^--(trusted-network|dashboard-trusted-network)$' {
        Set-StartOverride "LLMHARBOR_DASHBOARD_TRUSTED_NETWORK" "1"
        continue
      }
      '^--local-control-plane$' {
        Set-StartOverride "LLMHARBOR_DASHBOARD_TRUSTED_NETWORK" "0"
        Set-StartOverride "LLMHARBOR_ALLOW_REMOTE_CONTROL_PLANE" "0"
        continue
      }
      '^--save$' { $script:StartSave = $true; continue }
      '^(-h|--help)$' { Help; exit 0 }
      '^--$' {
        if ($Index + 1 -lt $Arguments.Count) { Fail "Unexpected start argument after --" }
        continue
      }
      default { Fail "Unknown start option: $Arg" }
    }
  }
}

function Save-StartOverrides {
  foreach ($Entry in $script:StartOverrides.GetEnumerator()) {
    Write-EnvValue $Entry.Key $Entry.Value
  }
}

function Read-Pid {
  if (-not (Test-Path -LiteralPath $PidFile -PathType Leaf)) { return $null }
  $Text = (Get-Content -LiteralPath $PidFile -Raw).Trim()
  $Value = 0
  if (-not [int]::TryParse($Text, [ref]$Value) -or $Value -le 1) { return $null }
  return $Value
}

function Get-ProcessStartToken([System.Diagnostics.Process]$Process) {
  $StatPath = "/proc/$($Process.Id)/stat"
  if (Test-Path -LiteralPath $StatPath -PathType Leaf) {
    try {
      $Stat = [System.IO.File]::ReadAllText($StatPath)
      $EndOfName = $Stat.LastIndexOf(") ", [StringComparison]::Ordinal)
      if ($EndOfName -lt 0) { return $null }
      $Fields = $Stat.Substring($EndOfName + 2).Split(
        [char[]]@(' ', "`t"),
        [StringSplitOptions]::RemoveEmptyEntries
      )
      if ($Fields.Count -lt 20 -or $Fields[19] -notmatch '^[0-9]+$') { return $null }
      return "linux:$($Fields[19])"
    } catch { return $null }
  }
  try { return "windows:$($Process.StartTime.ToUniversalTime().Ticks)" } catch { return $null }
}

function Get-LegacyManagedProcess([int]$ProcessId) {
  try {
    $Info = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    if (-not $Info -or -not $Info.CommandLine) { return $null }

    # Older Windows releases recorded the wrapping cmd.exe rather than its
    # node child. Validate both the entrypoint and this installation's
    # absolute log path before adopting the child process.
    if ($Info.Name -match '^cmd\.exe$' -and
        $Info.CommandLine -match 'server[/\\]dist[/\\]index\.js' -and
        $Info.CommandLine.IndexOf($LogFile, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $Children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction Stop)
      foreach ($Child in $Children) {
        if ($Child.Name -match '^node(\.exe)?$' -and $Child.CommandLine -match 'server[/\\]dist[/\\]index\.js') {
          return Get-Process -Id ([int]$Child.ProcessId) -ErrorAction SilentlyContinue
        }
      }
      return $null
    }

    # Only accept a directly recorded legacy node process when its command
    # line contains this canonical project root. This avoids adopting a
    # different LLMHarbor checkout after PID reuse.
    if ($Info.Name -match '^node(\.exe)?$' -and
        $Info.CommandLine -match 'server[/\\]dist[/\\]index\.js' -and
        $Info.CommandLine.IndexOf($ProjectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      return Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    }
    return $null
  } catch {
    return $null
  }
}

function Get-ManagedProcess {
  $ProcessId = Read-Pid
  if (-not $ProcessId) { return $null }
  $Process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $Process) { return $null }

  if (Test-Path -LiteralPath $PidStartFile -PathType Leaf) {
    $Expected = (Get-Content -LiteralPath $PidStartFile -Raw).Trim()
    $Actual = Get-ProcessStartToken $Process
    if (-not $Expected) { return $null }
    if ($Actual -ne $Expected) {
      # Migrate the unprefixed Windows tick token written by earlier releases.
      if ($Actual -eq "windows:$Expected") {
        Write-Utf8NoBom $PidStartFile "$Actual`r`n"
      } else {
        return $null
      }
    }
  } else {
    $LegacyProcess = Get-LegacyManagedProcess $ProcessId
    if (-not $LegacyProcess) { return $null }
    Write-ProcessRecord $LegacyProcess
    return $LegacyProcess
  }
  return $Process
}

function Clear-ProcessRecord {
  Remove-Item -LiteralPath $PidFile, $PidStartFile, $RuntimeConfigFile -Force -ErrorAction SilentlyContinue
}

function Clear-StaleProcessRecord {
  if (-not (Get-ManagedProcess)) { Clear-ProcessRecord }
}

function Stop-PendingStart {
  if (-not $script:PendingStartProcess) { return }
  $Pending = $script:PendingStartProcess
  $script:PendingStartProcess = $null
  try {
    $Pending.Refresh()
    if (-not $Pending.HasExited) {
      Stop-Process -Id $Pending.Id -Force -ErrorAction SilentlyContinue
      try { Wait-Process -Id $Pending.Id -Timeout 5 -ErrorAction SilentlyContinue } catch { }
    }
  } catch { }
  Clear-ProcessRecord
}

function Write-ProcessRecord([System.Diagnostics.Process]$Process) {
  $Token = Get-ProcessStartToken $Process
  if (-not $Token) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    Fail "Could not record the server process identity"
  }
  Ensure-StateDir
  Write-Utf8NoBom $PidStartFile "$Token`r`n"
  Write-Utf8NoBom $PidFile "$($Process.Id)`r`n"
}

function Write-RuntimeConfig {
  $Values = [ordered]@{
    LLMHARBOR_DASHBOARD_HOST = Get-DashboardHost
    LLMHARBOR_DASHBOARD_PORT = Get-DashboardPort
  }
  $PublicPort = Get-PublicApiPort
  if ($PublicPort) {
    $Values["LLMHARBOR_PUBLIC_API_HOST"] = Get-PublicApiHost
    $Values["LLMHARBOR_PUBLIC_API_PORT"] = $PublicPort
  }
  $TrustedNetwork = Get-ConfigValue "LLMHARBOR_DASHBOARD_TRUSTED_NETWORK"
  if ($TrustedNetwork -eq "0" -or $TrustedNetwork -eq "1") {
    $Values["LLMHARBOR_DASHBOARD_TRUSTED_NETWORK"] = $TrustedNetwork
  }
  $RemoteControlPlane = Get-ConfigValue "LLMHARBOR_ALLOW_REMOTE_CONTROL_PLANE"
  if ($RemoteControlPlane -eq "0" -or $RemoteControlPlane -eq "1") {
    $Values["LLMHARBOR_ALLOW_REMOTE_CONTROL_PLANE"] = $RemoteControlPlane
  }
  Write-Utf8NoBom $RuntimeConfigFile (($Values | ConvertTo-Json -Compress) + "`r`n")
}

function Test-RuntimeFieldProcessOverride([string]$RuntimeKey) {
  $Candidates = switch ($RuntimeKey) {
    "LLMHARBOR_DASHBOARD_HOST" { @("LLMHARBOR_DASHBOARD_HOST", "DASHBOARD_HOST", "HOST"); break }
    "LLMHARBOR_DASHBOARD_PORT" { @("LLMHARBOR_DASHBOARD_PORT", "DASHBOARD_PORT", "PORT"); break }
    "LLMHARBOR_PUBLIC_API_HOST" { @("LLMHARBOR_PUBLIC_API_HOST", "PUBLIC_API_HOST", "API_HOST"); break }
    "LLMHARBOR_PUBLIC_API_PORT" { @("LLMHARBOR_PUBLIC_API_PORT", "PUBLIC_API_PORT", "API_PORT"); break }
    default { @($RuntimeKey) }
  }
  $ProcessEnvironment = [Environment]::GetEnvironmentVariables("Process")
  foreach ($Candidate in $Candidates) {
    if ($ProcessEnvironment.Contains($Candidate)) { return $true }
  }
  return $false
}

function Load-RuntimeConfig {
  if (-not (Test-Path -LiteralPath $RuntimeConfigFile -PathType Leaf)) { return }
  try { $Values = Get-Content -LiteralPath $RuntimeConfigFile -Raw | ConvertFrom-Json } catch { return }
  $Allowed = @(
    "LLMHARBOR_DASHBOARD_HOST", "LLMHARBOR_DASHBOARD_PORT",
    "LLMHARBOR_PUBLIC_API_HOST", "LLMHARBOR_PUBLIC_API_PORT",
    "LLMHARBOR_DASHBOARD_TRUSTED_NETWORK", "LLMHARBOR_ALLOW_REMOTE_CONTROL_PLANE"
  )
  foreach ($Property in $Values.PSObject.Properties) {
    if ($Allowed -contains $Property.Name -and -not (Test-RuntimeFieldProcessOverride $Property.Name)) {
      [Environment]::SetEnvironmentVariable($Property.Name, [string]$Property.Value, "Process")
    }
  }
}

function Load-RestartRuntimeConfig {
  if (-not (Test-Path -LiteralPath $RuntimeConfigFile -PathType Leaf) -or
      -not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { return }
  $RuntimeTime = (Get-Item -LiteralPath $RuntimeConfigFile -Force).LastWriteTimeUtc
  $EnvironmentTime = (Get-Item -LiteralPath $EnvFile -Force).LastWriteTimeUtc
  if ($RuntimeTime -le $EnvironmentTime) { return }
  Load-RuntimeConfig
}

function Test-Health([string]$Url) {
  try {
    $PreviousProgress = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  } finally {
    $ProgressPreference = $PreviousProgress
  }
}

function Ensure-ProductionBuild {
  $ServerBuild = Join-Path $ProjectRoot "server\dist\index.js"
  $ClientBuild = Join-Path $ProjectRoot "client\dist\index.html"
  if ((Test-Path -LiteralPath $ServerBuild -PathType Leaf) -and (Test-Path -LiteralPath $ClientBuild -PathType Leaf)) { return }
  Require-Command "npm"
  Log "Production build not found. Building first..."
  Push-Location $ProjectRoot
  try { Invoke-Native "npm" @("run", "build") } finally { Pop-Location }
}

function Install-DependenciesAndBuild {
  Push-Location $ProjectRoot
  try {
    if (Test-Path -LiteralPath (Join-Path $ProjectRoot "package-lock.json")) {
      Invoke-Native "npm" @("ci")
    } else {
      Log "Warning: package-lock.json is missing; falling back to npm install"
      Invoke-Native "npm" @("install")
    }
    Invoke-Native "npm" @("run", "build")
  } finally {
    Pop-Location
  }
}

function Assert-ManagedInstallationIdle {
  $Running = Get-ManagedProcess
  if ($Running) {
    Fail "$AppName is running with PID $($Running.Id). Stop it before installing. Use 'llmharbor update' for a coordinated update."
  }
}

function Assert-InstallationIdle {
  Assert-ManagedInstallationIdle
  if (Test-Health "$(Get-DashboardUrl)/api/ping") {
    Fail "A healthy LLMHarbor listener exists at $(Get-DashboardUrl), but it is not managed by this CLI. Stop it before installing."
  }
}

function Install-App {
  Acquire-LifecycleLock
  Require-SupportedNode
  Require-Command "npm"
  Assert-ManagedInstallationIdle
  Assert-ListenerConfig
  Assert-InstallationIdle
  Ensure-Env
  Assert-ListenerConfig
  Install-DependenciesAndBuild
  Ensure-StateDir
  Write-Host "$AppName is installed. Run: llmharbor start"
}

function Wait-ForStartup([System.Diagnostics.Process]$Process) {
  $Deadline = [DateTime]::UtcNow.AddSeconds($script:StartupTimeout)
  while ([DateTime]::UtcNow -lt $Deadline) {
    $Process.Refresh()
    if ($Process.HasExited) { return $false }
    if (Test-Health "$(Get-DashboardUrl)/api/ping") { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Show-StartupFailureLogs {
  Write-Host "Startup failed. Last logs:"
  if (Test-Path -LiteralPath $LogFile) { Get-Content -LiteralPath $LogFile -Tail 30 }
  if (Test-Path -LiteralPath $ErrorLogFile) { Get-Content -LiteralPath $ErrorLogFile -Tail 30 }
}

function Prepare-Start([string[]]$Arguments, [bool]$ReuseRuntime) {
  $ActualArguments = @($Arguments | Where-Object { $null -ne $_ })
  Parse-StartOptions $Arguments
  Acquire-LifecycleLock
  Require-SupportedNode
  Ensure-Env
  Ensure-StateDir
  if ($ReuseRuntime -and $ActualArguments.Count -eq 0 -and (Get-ManagedProcess)) {
    Load-RestartRuntimeConfig
  }
  Assert-ListenerConfig
  Assert-StartupTimeout
  if ($script:StartSave) { Save-StartOverrides }
}

function Start-Prepared {

  $Existing = Get-ManagedProcess
  if ($Existing) {
    Load-RuntimeConfig
    Write-Host "$AppName is already running with PID $($Existing.Id)"
    return
  }
  Clear-StaleProcessRecord

  if (Test-Health "$(Get-DashboardUrl)/api/ping") {
    Fail "A healthy LLMHarbor listener already exists at $(Get-DashboardUrl), but it is not managed by this CLI"
  }
  Ensure-ProductionBuild

  if ($script:StartForeground) {
    Log "$AppName starting in foreground"
    Print-Urls @()
    Release-LifecycleLock
    $PreviousNodeEnv = $env:NODE_ENV
    $env:NODE_ENV = "production"
    Push-Location $ProjectRoot
    try {
      & node "server/dist/index.js"
      $ExitCode = $LASTEXITCODE
    } finally {
      Pop-Location
      $env:NODE_ENV = $PreviousNodeEnv
    }
    exit $ExitCode
  }

  $NodePath = (Get-Command node).Source
  $PreviousNodeEnv = $env:NODE_ENV
  $env:NODE_ENV = "production"
  try {
    $StartParameters = @{
      FilePath = $NodePath
      ArgumentList = @("server/dist/index.js")
      WorkingDirectory = $ProjectRoot
      RedirectStandardOutput = $LogFile
      RedirectStandardError = $ErrorLogFile
      PassThru = $true
    }
    if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
      $StartParameters["WindowStyle"] = "Hidden"
    }
    $Process = Start-Process @StartParameters
  } finally {
    $env:NODE_ENV = $PreviousNodeEnv
  }

  $script:PendingStartProcess = $Process
  try {
    Write-ProcessRecord $Process
    Write-RuntimeConfig
    if (-not (Wait-ForStartup $Process)) {
      Stop-PendingStart
      Show-StartupFailureLogs
      Fail "$AppName did not become healthy within $($script:StartupTimeout) seconds"
    }
    $script:PendingStartProcess = $null
  } catch {
    Stop-PendingStart
    throw
  }
  Write-Host "$AppName started with PID $($Process.Id)"
  Print-Urls @()
}

function Start-App([string[]]$Arguments) {
  Prepare-Start $Arguments $false
  Start-Prepared
}

function Stop-App([string[]]$Arguments) {
  Ensure-NoArgs "stop" $Arguments
  Acquire-LifecycleLock
  $Process = Get-ManagedProcess
  if (-not $Process) {
    Clear-StaleProcessRecord
    Log "$AppName is not running"
    return
  }
  Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
  try { Wait-Process -Id $Process.Id -Timeout 10 -ErrorAction Stop } catch { }
  if (Get-Process -Id $Process.Id -ErrorAction SilentlyContinue) {
    Fail "Could not stop $AppName process $($Process.Id)"
  }
  Clear-ProcessRecord
  Log "$AppName stopped"
}

function Restart-App([string[]]$Arguments) {
  $ActualArguments = @($Arguments | Where-Object { $null -ne $_ })
  Prepare-Start $ActualArguments $true
  $Existing = Get-ManagedProcess
  if ($Existing) {
    # Finish validation and any missing build before interrupting a healthy
    # service. `restart --help` and invalid options are therefore harmless.
    Ensure-ProductionBuild
    Stop-App @()
  } elseif (Test-Health "$(Get-DashboardUrl)/api/ping") {
    Fail "A healthy LLMHarbor listener exists at $(Get-DashboardUrl), but it is not managed by this CLI"
  }
  Start-Prepared
}

function Status-App([string[]]$Arguments) {
  Ensure-NoArgs "status" $Arguments
  $Process = Get-ManagedProcess
  if ($Process) {
    Load-RuntimeConfig
    Write-Host "Process:   running, PID $($Process.Id) (CLI managed)"
  } else {
    Clear-StaleProcessRecord
    Write-Host "Process:   stopped"
  }

  $Failed = $false
  $Dashboard = Get-DashboardUrl
  if (Test-Health "$Dashboard/api/ping") {
    Write-Host "Dashboard: ok ($Dashboard)"
  } else {
    Write-Host "Dashboard: unavailable ($Dashboard)"
    $Failed = $true
  }

  $PublicPort = Get-PublicApiPort
  if ($PublicPort) {
    $PublicHost = Get-PublicApiHost
    $HealthUrl = "http://$(Get-UrlHost $PublicHost):$PublicPort/api/ping"
    $DisplayUrl = "http://$(Get-PublicUrlHost $PublicHost):$PublicPort/v1"
    if (Test-Health $HealthUrl) {
      Write-Host "Public API: ok ($DisplayUrl)"
    } else {
      Write-Host "Public API: unavailable ($DisplayUrl)"
      $Failed = $true
    }
  } else {
    Write-Host "Public API: same listener ($(Get-ApiBaseUrl))"
  }
  Write-Host "Home:      $ProjectRoot"
  Write-Host "Logs:      $LogFile"
  if ($Failed) { exit 1 }
}

function Show-Logs([string[]]$Arguments) {
  $Arguments = @($Arguments | Where-Object { $null -ne $_ })
  $Follow = $true
  $LinesText = "120"
  for ($Index = 0; $Index -lt $Arguments.Count; $Index++) {
    $Arg = $Arguments[$Index]
    switch -Regex ($Arg) {
      '^(-f|--follow)$' { $Follow = $true; continue }
      '^--no-follow$' { $Follow = $false; continue }
      '^(-n|--lines)$' {
        $LinesText = Get-RequiredOptionValue $Arg $Arguments $Index
        $Index++; continue
      }
      '^--lines=(.*)$' { $LinesText = $Matches[1]; continue }
      '^(-h|--help)$' { Write-Host "Usage: llmharbor logs [--follow|-f] [--lines|-n COUNT]"; return }
      default { Fail "Unknown logs option: $Arg" }
    }
  }
  $Lines = 0
  if (-not [int]::TryParse($LinesText, [ref]$Lines) -or $Lines -lt 0 -or $Lines -gt 100000) {
    Fail "Log line count must be between 0 and 100000: $LinesText"
  }
  Ensure-StateDir
  foreach ($Path in @($LogFile, $ErrorLogFile)) {
    if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType File -Path $Path | Out-Null }
  }
  $Paths = @($LogFile, $ErrorLogFile)
  if ($Follow) { Get-Content -LiteralPath $Paths -Tail $Lines -Wait }
  else { Get-Content -LiteralPath $Paths -Tail $Lines }
}

function Update-App([string[]]$Arguments) {
  Ensure-NoArgs "update" $Arguments
  Acquire-LifecycleLock
  Require-Command "git"
  Require-SupportedNode
  Require-Command "npm"
  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot ".git") -PathType Container)) {
    Fail "$ProjectRoot is not a git checkout; update it through the installation method you used"
  }
  & git -C $ProjectRoot diff --quiet
  if ($LASTEXITCODE -ne 0) { Fail "Tracked files have local changes. Commit or stash them before updating." }
  & git -C $ProjectRoot diff --cached --quiet
  if ($LASTEXITCODE -ne 0) { Fail "Tracked files have staged changes. Commit or stash them before updating." }
  & git -C $ProjectRoot rev-parse --verify '@{upstream}' 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "The current branch has no upstream. Configure one before running 'llmharbor update'." }

  $WasRunning = [bool](Get-ManagedProcess)
  if ($WasRunning) {
    Ensure-Env
    Load-RestartRuntimeConfig
    Assert-ListenerConfig
    Assert-StartupTimeout
  } else {
    Assert-ListenerConfig
    Assert-InstallationIdle
    Ensure-Env
    Assert-ListenerConfig
  }

  # Fetch and validate the update before stopping the service, so network and
  # branch errors cannot cause avoidable downtime.
  Invoke-Native "git" @("-C", $ProjectRoot, "fetch")
  & git -C $ProjectRoot merge-base --is-ancestor HEAD '@{upstream}'
  $HeadIsAncestor = $LASTEXITCODE -eq 0
  & git -C $ProjectRoot merge-base --is-ancestor '@{upstream}' HEAD
  $UpstreamIsAncestor = $LASTEXITCODE -eq 0
  if (-not $HeadIsAncestor -and -not $UpstreamIsAncestor) {
    Fail "The current branch and its upstream have diverged; refusing a non-fast-forward update."
  }

  if ($WasRunning) { Stop-App @() }
  Invoke-Native "git" @("-C", $ProjectRoot, "merge", "--ff-only", '@{upstream}')
  Install-App
  if ($WasRunning) { Start-App @() }
}

function Configure-Tailscale([string[]]$Arguments) {
  $Arguments = @($Arguments | Where-Object { $null -ne $_ })
  $DashboardPort = $DefaultTailscaleDashboardPort
  $PublicPort = $DefaultPublicApiPort
  $Position = 0
  for ($Index = 0; $Index -lt $Arguments.Count; $Index++) {
    $Arg = $Arguments[$Index]
    switch -Regex ($Arg) {
      '^--dashboard-port$' { $DashboardPort = Get-RequiredOptionValue $Arg $Arguments $Index; $Index++; continue }
      '^--dashboard-port=(.*)$' { $DashboardPort = $Matches[1]; continue }
      '^--(public-api-port|api-port)$' { $PublicPort = Get-RequiredOptionValue $Arg $Arguments $Index; $Index++; continue }
      '^--(public-api-port|api-port)=(.*)$' { $PublicPort = $Matches[2]; continue }
      '^(-h|--help)$' {
        Write-Host "Usage: llmharbor tailscale [DASHBOARD_PORT] [PUBLIC_API_PORT]"
        Write-Host "       llmharbor tailscale [--dashboard-port PORT] [--public-api-port PORT]"
        return
      }
      '^--' { Fail "Unknown tailscale option: $Arg" }
      default {
        $Position++
        if ($Position -eq 1) { $DashboardPort = $Arg }
        elseif ($Position -eq 2) { $PublicPort = $Arg }
        else { Fail "tailscale accepts at most two positional ports" }
      }
    }
  }
  Assert-Port "LLMHARBOR_DASHBOARD_PORT" $DashboardPort
  Assert-Port "LLMHARBOR_PUBLIC_API_PORT" $PublicPort
  if ($DashboardPort -eq $PublicPort) { Fail "Dashboard and public API ports must be different in split mode" }
  Acquire-LifecycleLock
  Require-Command "tailscale"

  $Output = (& tailscale ip -4 2>$null)
  if ($LASTEXITCODE -ne 0) { Fail "Could not query Tailscale. Is Tailscale running?" }
  $TailIps = @($Output | Where-Object { $_ })
  if ($TailIps.Count -eq 0) { Fail "Could not detect a Tailscale IPv4 address. Is Tailscale running?" }
  $TailIp = ([string]$TailIps[0]).Trim()
  Assert-Host "LLMHARBOR_DASHBOARD_HOST" $TailIp

  Ensure-Env
  Write-EnvValue "LLMHARBOR_DASHBOARD_HOST" $TailIp
  Write-EnvValue "LLMHARBOR_DASHBOARD_PORT" $DashboardPort
  Write-EnvValue "LLMHARBOR_DASHBOARD_TRUSTED_NETWORK" "1"
  Write-EnvValue "LLMHARBOR_PUBLIC_API_HOST" "0.0.0.0"
  Write-EnvValue "LLMHARBOR_PUBLIC_API_PORT" $PublicPort
  Log "Configured split mode in $EnvFile"
  Log "Dashboard: http://${TailIp}:$DashboardPort"
  Log "Public API: http://<public-ip>:$PublicPort/v1"
  Log "Run: llmharbor restart"
}

function Open-App([string[]]$Arguments) {
  Ensure-NoArgs "open" $Arguments
  if (Get-ManagedProcess) { Load-RuntimeConfig }
  Start-Process (Get-DashboardUrl)
}

function Print-Urls([string[]]$Arguments) {
  Ensure-NoArgs "url" $Arguments
  if (Get-ManagedProcess) { Load-RuntimeConfig }
  $Dashboard = Get-DashboardUrl
  $Api = Get-ApiBaseUrl
  Write-Host "Dashboard: $Dashboard"
  Write-Host "API base:  $Api"
  Write-Host "Chat:      $Api/chat/completions"
  if (Get-PublicApiPort) { Write-Host "Mode:      split (dashboard private, /v1 public)" }
  else { Write-Host "Mode:      single listener" }
}

function Doctor([string[]]$Arguments) {
  Ensure-NoArgs "doctor" $Arguments
  $Failed = $false
  foreach ($Name in @("git", "npm")) {
    $Found = Get-Command $Name -ErrorAction SilentlyContinue
    if ($Found) { Write-Host "ok   ${Name}: $($Found.Source)" }
    else { Write-Host "miss $Name"; $Failed = $true }
  }
  $Node = Get-Command node -ErrorAction SilentlyContinue
  if ($Node -and (Test-SupportedNode)) {
    $Version = (& node -p "process.versions.node")
    Write-Host "ok   node: $($Node.Source) ($Version)"
  } else {
    Write-Host "miss node: need $MinimumNodeMessage"
    $Failed = $true
  }
  if (Test-Path -LiteralPath $EnvFile -PathType Leaf) {
    $ConfiguredKey = Read-EnvValue "ENCRYPTION_KEY"
    if (-not $ConfiguredKey -or $ConfiguredKey -eq "your-64-char-hex-key-here" -or $ConfiguredKey -match '^[0-9a-fA-F]{64}$') {
      Write-Host "ok   .env"
    } else {
      Write-Host "miss .env has an invalid ENCRYPTION_KEY"
      $Failed = $true
    }
  } else {
    Write-Host "miss .env (run: llmharbor install)"
    $Failed = $true
  }
  if ((Test-Path -LiteralPath (Join-Path $ProjectRoot "server\dist\index.js")) -and
      (Test-Path -LiteralPath (Join-Path $ProjectRoot "client\dist\index.html"))) {
    Write-Host "ok   production build"
  } else {
    Write-Host "miss production build (run: llmharbor install)"
    $Failed = $true
  }
  if (Get-ManagedProcess) { Write-Host "ok   supervisor: CLI-managed background process" }
  else { Write-Host "info supervisor: no running managed process" }
  Print-Urls @()
  if ($Failed) { exit 1 }
}

function Help {
  @"
LLMHarbor command line

Usage:
  llmharbor <command> [options]

Commands:
  install       Install npm dependencies, create .env, and build production assets
  dev           Run the API and dashboard in development mode
  start         Start production in the background, or foreground with --foreground
  stop          Stop the CLI-managed background server
  restart       Restart the background server; accepts the same options as start
  status        Show process and health-check status
  logs          Follow server logs (use --no-follow for a snapshot)
  update        Pull latest git changes, rebuild, and restart if already running
  tailscale     Configure dashboard-private/public-API split mode
  open          Open the dashboard in your browser
  url           Print dashboard and OpenAI-compatible API URLs
  doctor        Check local prerequisites
  help          Show this help

Start options:
  --foreground, --fg, --no-daemon
  --host HOST, --dashboard-host HOST
  --port PORT, --dashboard-port PORT
  --public-api-host HOST, --api-host HOST
  --public-api-port PORT, --api-port PORT
  --split
  --trusted-network
  --save

Log options:
  llmharbor logs [--follow|-f] [--lines|-n COUNT]

Environment:
  LLMHARBOR_HOME=C:\path\to\LLMHarbor
"@
}

try {
  switch ($Command.ToLowerInvariant()) {
    "install" { Ensure-NoArgs "install" $CommandArgs; Install-App }
    "dev" {
      Require-SupportedNode
      Require-Command "npm"
      Ensure-Env
      Push-Location $ProjectRoot
      try {
        & npm run dev -- @CommandArgs
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
      } finally { Pop-Location }
    }
    "start" { Start-App $CommandArgs }
    "stop" { Stop-App $CommandArgs }
    "restart" { Restart-App $CommandArgs }
    "status" { Status-App $CommandArgs }
    "logs" { Show-Logs $CommandArgs }
    "update" { Update-App $CommandArgs }
    "tailscale" { Configure-Tailscale $CommandArgs }
    "configure-tailscale" { Configure-Tailscale $CommandArgs }
    "open" { Open-App $CommandArgs }
    "url" { Print-Urls $CommandArgs }
    "urls" { Print-Urls $CommandArgs }
    "doctor" { Doctor $CommandArgs }
    "help" { Ensure-NoArgs "help" $CommandArgs; Help }
    "-h" { Ensure-NoArgs "help" $CommandArgs; Help }
    "--help" { Ensure-NoArgs "help" $CommandArgs; Help }
    default { Help; Fail "Unknown command: $Command" }
  }
} finally {
  Stop-PendingStart
  Release-LifecycleLock
}
