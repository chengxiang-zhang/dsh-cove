#Requires -Version 5.1
<#
.SYNOPSIS
  Anywhere Work private-network client installer for Windows.

.DESCRIPTION
  The macOS and Linux entry is install.sh, served from the same channel. This is its
  Windows sibling: it installs the NetBird client from the channel with its published
  SHA-256 verified, keeps a usable Node (the channel's private runtime when the
  machine has none), installs DSH from npm, and keeps `dsh web` resident so the
  machine answers on its own http://dsh.<machine>.netbird address.

  The channel layout is the one install.sh reads: latest.txt (version),
  management-url.txt, checksums.txt ("<sha256>  <file>") and the netbird archives
  beside them.

  -DryRun prints the plan and changes nothing, which is also how CI exercises this
  script: it has no Windows host of its own in the repository, so every mutating
  step is written to be inspectable before it runs.

.EXAMPLE
  iwr https://anywhere.example.com/install.ps1 -UseBasicParsing | iex

.EXAMPLE
  .\install.ps1 -DryRun -ManagementUrl https://netbird.example.com:443
#>
[CmdletBinding()]
param(
  [string]$Channel = $(if ($env:AW_CHANNEL) { $env:AW_CHANNEL } else { 'https://anywhere.example.com/client' }),
  [string]$ManagementUrl = $env:AW_MANAGEMENT_URL,
  [string]$BinDir = '',
  [string]$Profile = $env:AW_PROFILE,
  [string]$DshPackage = '@deepseek-ai/dsh',
  [switch]$NoDsh,
  [switch]$NoService,
  [switch]$Force,
  [switch]$DryRun,
  [switch]$Uninstall,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$NODE_MIN_MAJOR = 22
$DSH_HOME_DIR = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
if (-not $BinDir) {
  $BinDir = if ($env:AW_BIN_DIR) { $env:AW_BIN_DIR } elseif ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA 'Programs\AnywhereWork\bin'
  } else {
    Join-Path $HOME '.local/bin'
  }
}
$TaskName = 'Anywhere Work DSH host'

function Say { param([string]$Message) Write-Host $Message }

# Runs an external step with a deadline. Neither `netbird up` nor `npm install` promises to
# return: the first retries against an unreachable control plane for as long as it likes, and
# an installer that never comes back is worse than one that says what it could not finish -
# the person can run the same command later, when the network answers.
function Invoke-Bounded {
  param([string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds, [string]$What)
  $log = Join-Path ([System.IO.Path]::GetTempPath()) ("aw-" + [System.IO.Path]::GetFileNameWithoutExtension($FilePath) + ".log")
  $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru -NoNewWindow `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    Warn "$What did not finish within ${TimeoutSeconds}s; stopping it"
    try { $process.Kill() } catch { }
    return 1
  }
  foreach ($file in @($log, "$log.err")) {
    if (Test-Path $file) {
      Get-Content -Path $file -Tail 5 -ErrorAction SilentlyContinue | ForEach-Object { Say "  $_" }
    }
  }
  return $process.ExitCode
}
function Step { param([string]$Message) Write-Host ''; Write-Host "==> $Message" }
function Warn { param([string]$Message) Write-Warning $Message }
function Die { param([string]$Message) Write-Error "error: $Message"; exit 1 }
function Plan { param([string]$Message) if ($DryRun) { Write-Host "    would: $Message" } }

if ($Help) {
  @'
Anywhere Work private-network client installer (Windows)

  -Channel URL          channel base holding the archives and checksums
  -ManagementUrl URL    management endpoint to log into
  -BinDir DIR           install the client binary here (default: %LOCALAPPDATA%\Programs\AnywhereWork\bin)
  -Profile NAME         NetBird profile to use
  -DshPackage NAME      DSH package to install (default: @deepseek-ai/dsh)
  -NoDsh                install the private-network client only, no DSH
  -NoService            do not install the NetBird background service
  -Force                install the channel copy even if the client is already installed
  -DryRun               print the plan, change nothing
  -Uninstall            stop the services, remove the client and the DSH task
  -Help                 this text
'@ | Write-Host
  exit 0
}

# $IsWindows exists only in PowerShell 6 and later. Windows PowerShell 5.1 - the
# powershell.exe a Windows 11 machine runs by default - has no such variable, and with
# Set-StrictMode a read of one is a terminating error rather than $null: that is how this
# script refused to run at all on a real Windows host while its -DryRun passed on pwsh 7.
function Test-IsWindows {
  if (Get-Variable -Name IsWindows -ErrorAction SilentlyContinue) {
    return [bool]$IsWindows
  }
  return ($env:OS -eq 'Windows_NT')
}

function Assert-Windows {
  if (-not (Test-IsWindows)) {
    if (-not $DryRun) { Die 'this installer runs on Windows; use install.sh on macOS and Linux' }
    Warn 'not running on Windows: -DryRun is printing the plan only'
  }
}

function Get-ChannelText {
  param([string]$Name)
  $url = "$Channel/$Name"
  Plan "download $url"
  if ($DryRun) { return '' }
  try {
    return (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 60).Content.Trim()
  } catch {
    Warn "cannot read $url ($($_.Exception.Message))"
    return ''
  }
}

function Get-Sha256 {
  param([string]$Path)
  return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

function Get-WindowsArch {
  # ARM64 Windows is a real target; everything else on this platform is x64. A host
  # without the variable (a -DryRun anywhere else) keeps the plan readable instead of
  # inventing an architecture.
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { return 'arm64' }
  if (-not $env:PROCESSOR_ARCHITECTURE) { return '<arch>' }
  return 'amd64'
}

function Get-NetBirdArchive {
  param([string]$Version)
  # Windows gets the same release layout as the other platforms, archive included:
  # upstream publishes netbird_<version>_windows_<arch>.tar.gz, and ticket 2026-10-21
  # in the release checklist is what confirms bsdtar unpacks it.
  return "netbird_${Version}_windows_$(Get-WindowsArch).tar.gz"
}

function Install-PrivateNode {
  # Node ships a .zip for Windows, not the .tar.gz the other platforms take, so the
  # suffix differs while the verification path is the same one install.sh uses.
  param([string]$NodeBaseUrl = 'https://nodejs.org/dist')
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  Step "installing a private Node (win-$arch)"
  $shasumsUrl = "$NodeBaseUrl/SHASUMS256.txt"
  Plan "download $shasumsUrl, pick the newest node-v*-win-$arch.zip"
  if ($DryRun) { return '' }
  try {
    $shasums = (Invoke-WebRequest -Uri $shasumsUrl -UseBasicParsing -TimeoutSec 60).Content
  } catch {
    Warn "cannot reach $shasumsUrl ($($_.Exception.Message))"
    return ''
  }
  $line = ($shasums -split "`n" | Where-Object { $_ -match "node-v[\d.]+-win-$arch\.zip$" } | Select-Object -Last 1)
  if (-not $line) { Warn "the Node channel publishes no win-$arch archive"; return '' }
  $digest, $file = ($line -split '\s+') | Select-Object -First 2
  $zip = Join-Path ([System.IO.Path]::GetTempPath()) $file
  Invoke-WebRequest -Uri "$NodeBaseUrl/$file" -OutFile $zip -UseBasicParsing -TimeoutSec 600
  $actual = Get-Sha256 $zip
  if ($actual -ne $digest.ToLowerInvariant()) {
    Die "checksum mismatch for $file (expected $digest, got $actual)"
  }
  Say "sha256    $actual (matches the Node release list)"
  $nodeRoot = Join-Path $DSH_HOME_DIR 'node'
  New-Item -ItemType Directory -Force -Path $nodeRoot | Out-Null
  Expand-Archive -Path $zip -DestinationPath $nodeRoot -Force
  $dir = Join-Path $nodeRoot ([System.IO.Path]::GetFileNameWithoutExtension($file))
  return (Join-Path $dir 'node.exe')
}

function Resolve-Node {
  if ($DryRun) { return '<node>' }
  $onPath = Get-Command node -ErrorAction SilentlyContinue
  if ($onPath) {
    $nodePath = $onPath.Source
    $major = [int](((& $nodePath -v) -replace '^v', '') -replace '\..*$', '')
    if ($major -ge $NODE_MIN_MAJOR) { return $nodePath }
    Warn "the Node on PATH is $major; DSH needs $NODE_MIN_MAJOR or newer"
  }
  $private = Get-ChildItem -Path (Join-Path $DSH_HOME_DIR 'node') -Filter node.exe -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($private) { return $private.FullName }
  return ''
}

function Install-Dsh {
  if ($DryRun) {
    Step "installing $DshPackage"
    Plan "look for Node $NODE_MIN_MAJOR or newer, else unpack the Node channel's win-x64 zip under $DSH_HOME_DIR\node"
    Plan "npm install -g $DshPackage"
    Plan "register the DSH logon task"
    return '<dsh.cmd from npm>'
  }
  $node = Resolve-Node
  if (-not $node) {
    $node = Install-PrivateNode
  }
  if (-not $node) {
    Warn "no usable Node $NODE_MIN_MAJOR or newer: install Node from https://nodejs.org and run this installer again"
    return $null
  }
  $npm = Join-Path (Split-Path -Parent $node) 'npm.cmd'
  if (-not (Test-Path $npm)) {
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($npmCommand) { $npm = $npmCommand.Source }
  }
  if (-not (Test-Path $npm)) { Warn "npm is missing beside $node"; return $null }

  Step "installing $DshPackage"
  $installed = Invoke-Bounded -FilePath $npm -Arguments @('install', '-g', $DshPackage) -TimeoutSeconds 600 -What "installing $DshPackage"
  if ($installed -ne 0) { Warn "npm could not install $DshPackage"; return $null }
  $dshCommand = Get-Command dsh.cmd -ErrorAction SilentlyContinue
  if (-not $dshCommand) {
    Warn 'dsh is not on PATH after the npm install; add the npm global prefix to PATH and run this installer again'
    return $null
  }
  return $dshCommand.Source
}

function Register-DshTask {
  param([string]$DshBinary, [string]$TrustedHost)
  # The Windows counterpart of the LaunchAgent and the user systemd unit: a logon
  # task, so `dsh web` comes back after a reboot without an administrator account
  # and without a machine-wide service.
  $action = "`"$DshBinary`" web --host 127.0.0.1 --port 3080 --no-open --trusted-host $TrustedHost"
  Step "keeping DSH resident (logon task: $TaskName)"
  Plan "schtasks /Create /TN `"$TaskName`" /SC ONLOGON /TR $action /F"
  if ($DryRun) { return }
  & schtasks.exe /Create /TN $TaskName /SC ONLOGON /TR $action /F | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Warn "could not register the logon task; run DSH yourself with: $action"
    return
  }
  & schtasks.exe /Run /TN $TaskName | Out-Null
}


function Uninstall-All {
  Step 'removing the private-network client and the DSH host task'
  Plan "schtasks /Delete /TN `"$TaskName`" /F"
  Plan "stop and remove the NetBird service, then delete $BinDir"
  if ($DryRun) { return }

  # Every step here goes through the bounded runner rather than `& ... 2>$null`. Windows
  # PowerShell 5.1 turns a *redirected* native stderr into a terminating error while
  # $ErrorActionPreference is Stop, and `schtasks /Delete` on a machine that never had the
  # task writes to stderr - which is how the uninstall stopped before removing anything. A
  # failure here is also not fatal: what the person came for is the directory going away.
  $netbird = Join-Path $BinDir 'netbird.exe'
  Invoke-Bounded -FilePath 'schtasks.exe' -Arguments @('/Delete', '/TN', $TaskName, '/F') `
    -TimeoutSeconds 30 -What 'removing the DSH logon task' | Out-Null
  if (Test-Path $netbird) {
    Invoke-Bounded -FilePath $netbird -Arguments @('service', 'stop') -TimeoutSeconds 60 -What 'stopping the client service' | Out-Null
    Invoke-Bounded -FilePath $netbird -Arguments @('service', 'uninstall') -TimeoutSeconds 60 -What 'removing the client service' | Out-Null
  }
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    Remove-Item -Recurse -Force -Path $BinDir -ErrorAction SilentlyContinue
    if (-not (Test-Path $BinDir)) {
      return
    }
    Start-Sleep -Milliseconds 500
  }
  Warn "could not remove $BinDir completely; close the client and delete it by hand"
}

Assert-Windows

# Uninstall is answered before anything reaches for the channel: removing what is on this
# machine must not depend on the network that put it there. The acceptance run that found
# this had no network adapter, and -Uninstall failed on "the channel published no
# latest.txt" instead of removing anything.
if ($Uninstall) {
  Uninstall-All
  Step 'done'
  exit 0
}

Step 'resolving the client version'
$version = Get-ChannelText 'latest.txt'
if (-not $version) {
  if ($DryRun) { $version = '<version from latest.txt>' } else { Die "the channel at $Channel published no latest.txt" }
}
if (-not $ManagementUrl) { $ManagementUrl = Get-ChannelText 'management-url.txt' }
if (-not $ManagementUrl -and -not $DryRun) { Die "no management URL: pass -ManagementUrl or publish management-url.txt on the channel" }

$archive = Get-NetBirdArchive $version
Say "channel   $Channel"
Say "platform  windows-$(Get-WindowsArch)"
Say "version   $version"
Say "archive   $archive"
Say "bin dir   $BinDir"



$existing = Join-Path $BinDir 'netbird.exe'
if ((Test-Path $existing) -and -not $Force) {
  Warn "the client is already at $existing; use -Force to replace it with the channel version"
} else {
  Step "downloading $archive"
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString('N'))
  Plan "download $Channel/$archive into $tmp"
  Plan 'verify its sha256 against checksums.txt, then unpack into the bin dir'
  if ($DryRun) {
    Say "    would install into $BinDir"
  } else {
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $checksums = (Invoke-WebRequest -Uri "$Channel/checksums.txt" -UseBasicParsing -TimeoutSec 60).Content
    $line = ($checksums -split "`n" | Where-Object { $_ -match [regex]::Escape($archive) } | Select-Object -First 1)
    if (-not $line) { Die "$archive is not in the channel's checksums.txt" }
    $digest, $file = ($line -split '\s+') | Select-Object -First 2
    $tar = Join-Path $tmp $file
    Invoke-WebRequest -Uri "$Channel/$file" -OutFile $tar -UseBasicParsing -TimeoutSec 600
    $actual = Get-Sha256 $tar
    if ($actual -ne $digest.ToLowerInvariant()) {
      Die "checksum mismatch for $file (expected $digest, got $actual)"
    }
    Say "sha256    $actual (matches the channel)"
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    # bsdtar ships with Windows 10 1803 and later and unpacks a .tar.gz without a
    # second tool; Expand-Archive cannot read one.
    & tar.exe -xzf $tar -C $tmp
    Get-ChildItem -Path $tmp -Filter 'netbird*' -Recurse -File | ForEach-Object {
      Copy-Item $_.FullName -Destination (Join-Path $BinDir $_.Name) -Force
    }
    if (-not (Test-Path (Join-Path $BinDir 'netbird.exe'))) {
      Die "$archive did not contain netbird.exe"
    }
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -notlike "*$BinDir*") {
      Plan "add $BinDir to the user PATH"
      [Environment]::SetEnvironmentVariable('Path', "$userPath;$BinDir", 'User')
    }
  }
}

if (-not $NoService) {
  Step 'installing the NetBird background service'
  Plan "& '$BinDir\netbird.exe' service install; & '$BinDir\netbird.exe' service start"
  if (-not $DryRun) {
    $netbird = Join-Path $BinDir 'netbird.exe'
    # Through the bounded runner for the same reason as the uninstall: a redirected native
    # stderr is a terminating error under StrictMode's sibling, $ErrorActionPreference Stop.
    $installed = Invoke-Bounded -FilePath $netbird -Arguments @('service', 'install') -TimeoutSeconds 60 -What 'installing the client service'
    if ($installed -ne 0) {
      Warn 'the service needs an elevated PowerShell: re-run this script from an administrator prompt, or use the client in this session'
    } else {
      Invoke-Bounded -FilePath $netbird -Arguments @('service', 'start') -TimeoutSeconds 60 -What 'starting the client service' | Out-Null
    }
  }
}

if ($ManagementUrl) {
  Step 'joining the private network'
  $up = @('up', '--management-url', $ManagementUrl)
  if ($Profile) { $up += @('--profile', $Profile) }
  Plan "& '$BinDir\netbird.exe' $($up -join ' ')"
  if (-not $DryRun) {
    $joined = Invoke-Bounded -FilePath (Join-Path $BinDir 'netbird.exe') -Arguments $up -TimeoutSeconds 120 -What 'joining the private network'
    if ($joined -ne 0) {
      Warn "the client has not joined yet; run it yourself when the network is reachable: netbird $($up -join ' ')"
    }
  }
}

if (-not $NoDsh) {
  $dsh = Install-Dsh
  if ($dsh) {
    $label = if ($env:COMPUTERNAME) { ($env:COMPUTERNAME.ToLower() -replace '[^a-z0-9-]', '-') } else { 'localhost' }
    Register-DshTask -DshBinary $dsh -TrustedHost "dsh.$label.netbird"
  }
}

Step 'done'
Say 'open Anywhere Work from the Start menu; the machine appears at'
Say "  http://dsh.$(if ($env:COMPUTERNAME) { $env:COMPUTERNAME.ToLower() } else { 'localhost' }).netbird/"
if ($DryRun) { Say '(dry run: nothing was changed)' }