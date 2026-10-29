#Requires -Version 5.1
<#
.SYNOPSIS
  The guest's whole acceptance run: the app installer, then the fleet installer.

.DESCRIPTION
  Windows applies an answer file at install time, so the way to run another acceptance
  script on an already-installed guest is to install it once with this entry point. Both
  scripts report over COM1 with `AW-TEST:` lines; this one ends the transcript with a
  single `AW-TEST: ALL-RESULTS` line so the host's supervisor knows the whole run is over
  rather than stopping at the first verdict.
#>
$ErrorActionPreference = 'Continue'

function Run-One {
  # Bounded: a script that hangs must become a reported outcome, not a run that never ends.
  param([string]$Name, [int]$TimeoutSeconds = 900)
  $script = Join-Path $PSScriptRoot $Name
  if (-not (Test-Path $script)) {
    Write-Host "AW-TEST: missing $Name on the media"
    return 'missing'
  }
  $log = Join-Path $env:TEMP ("aw-run-" + [System.IO.Path]::GetFileNameWithoutExtension($Name) + ".log")
  $process = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script) `
    -PassThru -NoNewWindow -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    try { $process.Kill() } catch { }
    Write-Host "AW-TEST: $Name did not finish within ${TimeoutSeconds}s"
    return 'timed-out'
  }
  return 'ran'
}

Run-One 'aw-test.ps1' | Out-Null
Run-One 'aw-test-fleet.ps1' | Out-Null

$app = 'unknown'
$fleet = 'unknown'
try {
  $appLine = Select-String -Path 'C:\aw-test.log' -Pattern 'AW-TEST: RESULT ' -ErrorAction SilentlyContinue |
    Select-Object -Last 1
  if ($appLine) { $app = $appLine.Line -replace '^.*AW-TEST: RESULT ', '' }
} catch { }
try {
  $fleetLine = Select-String -Path 'C:\aw-test-fleet.log' -Pattern 'AW-TEST: RESULT ' -ErrorAction SilentlyContinue |
    Select-Object -Last 1
  if ($fleetLine) { $fleet = $fleetLine.Line -replace '^.*AW-TEST: RESULT ', '' }
} catch { }

$text = "AW-TEST: ALL-RESULTS app=[$app] fleet=[$fleet]"
try {
  $port = New-Object System.IO.Ports.SerialPort('COM1', 115200, 'None', 8, 'One')
  $port.Open()
  $port.WriteLine($text)
  $port.Close()
} catch { }
Add-Content -Path 'C:\aw-test-all.log' -Value $text