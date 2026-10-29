#Requires -Version 5.1
<#
.SYNOPSIS
  Acceptance for the fleet installer (tools/dsh-netbird/client/install.ps1) inside the
  same Windows guest the app installer is accepted in.

.DESCRIPTION
  The guest has no network adapter on purpose, so the channel is served from this machine
  with HttpListener over the files the unattended media carries. That is not a shortcut
  around the installer's logic - it is the logic: read latest.txt, fetch the archive,
  verify the digest that checksums.txt publishes, unpack, install the binary, extend PATH,
  register the service, and refuse a channel whose bytes do not match the digest.

  Two channels are served: a good one and a copy whose archive has been altered while
  checksums.txt still carries the original digest. The second run must fail closed, which
  is the assertion that matters most - a channel that cannot be verified is a channel that
  must not install anything.

.NOTES
  Markers match the app acceptance: every line starts with `AW-TEST: `, and the last line
  is `AW-TEST: RESULT PASS` or `AW-TEST: RESULT FAIL <n> ...`.
#>
$ErrorActionPreference = 'Continue'

$script:Serial = $null
try {
  $script:Serial = New-Object System.IO.Ports.SerialPort('COM1', 115200, 'None', 8, 'One')
  $script:Serial.Open()
} catch {
  $script:Serial = $null
}

function Say {
  param([string]$Line)
  $text = "AW-TEST: $Line"
  if ($script:Serial) {
    try { $script:Serial.WriteLine($text) } catch { }
  }
  try { Add-Content -Path 'C:\aw-test-fleet.log' -Value "$(Get-Date -Format 'HH:mm:ss') $text" } catch { }
}

$script:Failures = @()
function Note {
  param([bool]$Ok, [string]$What, [string]$Detail = '')
  if ($Ok) {
    Say "ok   $What $Detail".TrimEnd()
  } else {
    $script:Failures += "$What $Detail".TrimEnd()
    Say "FAIL $What $Detail".TrimEnd()
  }
}

function Start-Channel {
  # The channel runs in its own process, not as a job: this script is executed from the
  # answer file's first-logon command, and the job infrastructure is not dependable there.
  param([string]$Root, [int]$Port, [string]$Log)
  $serve = Join-Path $PSScriptRoot 'serve-channel.ps1'
  $process = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $serve, '-Root', $Root, '-Port', $Port) `
    -PassThru -NoNewWindow -RedirectStandardOutput $Log -RedirectStandardError "$Log.err"
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/latest.txt" -UseBasicParsing -TimeoutSec 3
      if ($probe.Content.Trim() -eq '0.78.1') { return $process }
    } catch { }
  }
  return $process
}

function Run-Installer {
  # Bounded: an installer that hangs would otherwise hang the acceptance with it, and a run
  # that never reports is a run nobody can act on.
  param([string[]]$Arguments)
  $script = Join-Path $PSScriptRoot 'install.ps1'
  $log = Join-Path $env:TEMP 'aw-fleet-run.log'
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script) + $Arguments
  $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -PassThru -NoNewWindow `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  if (-not $process.WaitForExit(300000)) {
    try { $process.Kill() } catch { }
    return [pscustomobject]@{ Output = 'the installer did not finish within 300s'; ExitCode = 124 }
  }
  $lines = @()
  foreach ($file in @($log, "$log.err")) {
    if (Test-Path $file) { $lines += Get-Content -Path $file -ErrorAction SilentlyContinue }
  }
  return [pscustomobject]@{ Output = ($lines -join "`n"); ExitCode = $process.ExitCode }
}

Say "begin fleet-installer acceptance windows=$([Environment]::OSVersion.VersionString) user=$env:USERNAME"

# ---------------------------------------------------------------- the media
$installerScript = Join-Path $PSScriptRoot 'install.ps1'
$archive = Get-ChildItem $PSScriptRoot -Filter 'netbird_*_windows_amd64.tar.gz' | Select-Object -First 1
if (-not (Test-Path $installerScript) -or -not $archive) {
  Say 'RESULT FAIL 1 the media does not carry install.ps1 and a netbird archive'
  exit 1
}
$digest = (Get-FileHash -Algorithm SHA256 -Path $archive.FullName).Hash.ToLowerInvariant()
Say "media archive=$($archive.Name) bytes=$($archive.Length)"
Say "media digest=$digest"

# ---------------------------------------------------------------- channels
$good = Join-Path $env:TEMP 'aw-channel-good'
$bad = Join-Path $env:TEMP 'aw-channel-bad'
foreach ($dir in @($good, $bad)) {
  Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}
'0.78.1' | Set-Content -Path (Join-Path $good 'latest.txt') -NoNewline
'http://127.0.0.1:9/' | Set-Content -Path (Join-Path $good 'management-url.txt') -NoNewline
"$digest  $($archive.Name)" | Set-Content -Path (Join-Path $good 'checksums.txt')
Copy-Item $archive.FullName (Join-Path $good $archive.Name)

Copy-Item (Join-Path $good 'latest.txt') $bad
Copy-Item (Join-Path $good 'management-url.txt') $bad
Copy-Item (Join-Path $good 'checksums.txt') $bad
# The altered copy keeps the same name and a different payload: the digest in
# checksums.txt can no longer match it.
$bytes = [System.IO.File]::ReadAllBytes($archive.FullName)
$bytes[1024] = $bytes[1024] -bxor 0xFF
[System.IO.File]::WriteAllBytes((Join-Path $bad $archive.Name), $bytes)
Say "bad channel archive altered at byte 1024; same published digest"

$goodServer = Start-Channel -Root $good -Port 8181 -Log (Join-Path $env:TEMP 'aw-channel-good.log')
$badServer = Start-Channel -Root $bad -Port 8182 -Log (Join-Path $env:TEMP 'aw-channel-bad.log')
foreach ($check in @(@{Port = 8181; What = 'the good channel serves the version' }, @{Port = 8182; What = 'the bad channel serves the same version' })) {
  try {
    $content = (Invoke-WebRequest -Uri "http://127.0.0.1:$($check.Port)/latest.txt" -UseBasicParsing -TimeoutSec 5).Content.Trim()
  } catch {
    $content = ''
  }
  Note ($content -eq '0.78.1') $check.What "answered=$content"
}

# ---------------------------------------------------------------- install
$binDir = Join-Path $env:LOCALAPPDATA 'aw-fleet-bin'
Remove-Item -Recurse -Force $binDir -ErrorAction SilentlyContinue
$install = Run-Installer @('-Channel', 'http://127.0.0.1:8181', '-BinDir', $binDir, '-NoDsh', '-NoService')
Say "install output tail: $((($install.Output -split "`n" | Where-Object { $_ -match 'AW|sha256|error|warning|done|install' } | Select-Object -Last 4) -join ' / '))"
$binary = Join-Path $binDir 'netbird.exe'
Note (Test-Path $binary) 'the client binary is installed' "path=$binary"
Note (Test-Path (Join-Path $binDir 'netbird.exe')) 'and keeps its Windows name'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
Note ($userPath -like "*$binDir*") 'the bin directory is on the user PATH'
if (Test-Path $binary) {
  $installed = (Get-Item $binary).Length
  $expected = (& "$env:SystemRoot\System32\tar.exe" -tzf $archive.FullName | Select-String 'netbird.exe$' | Select-Object -First 1) -ne $null
  Note ($installed -gt 1000000) 'the installed binary has a plausible size' "bytes=$installed"
  Note $expected 'the archive really contains netbird.exe'
}

# ---------------------------------------------------------------- verify refused
$before = if (Test-Path $binary) { (Get-Item $binary).Length } else { 0 }
$badRun = Run-Installer @('-Channel', 'http://127.0.0.1:8182', '-BinDir', $binDir, '-NoDsh', '-NoService', '-Force')
$mismatch = $badRun.Output -match 'checksum mismatch'
Say "bad channel exit=$($badRun.ExitCode) mismatch=$mismatch"
Note $mismatch 'a channel whose bytes do not match its digest is refused'
$after = if (Test-Path $binary) { (Get-Item $binary).Length } else { 0 }
Note ($after -eq $before) 'and the installed binary is left untouched' "before=$before after=$after"

# ---------------------------------------------------------------- the service
$serviceRun = Run-Installer @('-Channel', 'http://127.0.0.1:8181', '-BinDir', $binDir, '-NoDsh', '-Force')
Start-Sleep -Seconds 5
$service = Get-Service -Name 'NetBird' -ErrorAction SilentlyContinue
Say "service run exit=$($serviceRun.ExitCode) service=$($service.Status)"
Note ($null -ne $service) 'the service is registered when the installer is not told to skip it'

# ---------------------------------------------------------------- uninstall
$uninstall = Run-Installer @('-BinDir', $binDir, '-Uninstall')
Start-Sleep -Seconds 3
Say "uninstall output tail: $((($uninstall.Output -split "`n" | Select-Object -Last 3) -join ' / '))"
Note (-not (Test-Path $binDir)) 'uninstall removes the bin directory'

foreach ($server in @($goodServer, $badServer)) {
  if ($server) { try { $server.Kill() } catch { } }
}

if ($script:Failures.Count -eq 0) {
  Say 'RESULT PASS every assertion held'
} else {
  Say "RESULT FAIL $($script:Failures.Count) $($script:Failures -join ' | ')"
}
if ($script:Serial) { try { $script:Serial.Close() } catch { } }