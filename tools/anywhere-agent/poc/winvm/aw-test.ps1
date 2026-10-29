#Requires -Version 5.1
<#
.SYNOPSIS
  The client's Windows acceptance run: install, upgrade, launch, uninstall - with evidence.

.DESCRIPTION
  This is what a Windows host does with the installer the release workflow builds, run
  where no human can watch: a KVM guest whose first logon runs this script from the
  unattended media. Every finding goes to COM1 (QEMU writes that to a file on the host)
  and to C:\aw-test.log, so the result is readable from outside the machine.

  It checks the five things the installer doctrine promises (see
  tools/anywhere-agent/DESIGN.md, "Windows:NSIS 每用户安装"):
  a per-user install in the right place, the engine inside it, an Apps & features entry
  with the released version and the commit-count build, an install that upgrades over
  itself, and an uninstall that removes both the files and the registration. It also
  runs the embedded engine's own `version` command and starts the app, because an
  installer that places files nobody can run has not been tested.

  It is deliberately read-only about the network: no fleet credentials, no enrollment.

.NOTES
  Markers: every line starts with `AW-TEST: `; the last line is `AW-TEST: RESULT PASS`
  or `AW-TEST: RESULT FAIL <n> ...`.
#>
$ErrorActionPreference = 'Continue'

$script:Serial = $null
try {
  $script:Serial = New-Object System.IO.Ports.SerialPort('COM1', 115200, 'None', 8, 'One')
  $script:Serial.Open()
} catch {
  # No serial port is not a reason to stop: the logfile carries the same lines.
  $script:Serial = $null
}

function Say {
  param([string]$Line)
  $text = "AW-TEST: $Line"
  if ($script:Serial) {
    try { $script:Serial.WriteLine($text) } catch { }
  }
  try { Add-Content -Path 'C:\aw-test.log' -Value "$(Get-Date -Format 'HH:mm:ss') $text" } catch { }
}

function Note {
  param([bool]$Ok, [string]$What, [string]$Detail = '')
  if ($Ok) {
    Say "ok   $What $Detail".TrimEnd()
  } else {
    $script:Failures += "$What $Detail".TrimEnd()
    Say "FAIL $What $Detail".TrimEnd()
  }
}

$script:Failures = @()
$ProductDir = Join-Path $env:LOCALAPPDATA 'Programs\Anywhere Work'
$ArpKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Anywhere Work'
$AppExe = Join-Path $ProductDir 'Anywhere Work.exe'
$EngineExe = Join-Path $ProductDir 'resources\bin\anywhere-tunnel.exe'
$PayloadShell = Join-Path $ProductDir 'resources\app\shell\main.mjs'
$Uninstaller = Join-Path $ProductDir 'Uninstall.exe'

Say "begin windows=$([Environment]::OSVersion.VersionString) ps=$($PSVersionTable.PSVersion) user=$env:USERNAME elevated=$((New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"
Say "localappdata=$env:LOCALAPPDATA"

# ---------------------------------------------------------------- the media
$media = Get-Volume -FileSystemLabel 'AWUNATTEND' -ErrorAction SilentlyContinue
if (-not $media) {
  Say 'RESULT FAIL 1 unattended media not found'
  exit 1
}
$installer = Get-ChildItem -Path "$($media.DriveLetter):\" -Filter 'Anywhere Work-*.exe' | Select-Object -First 1
if (-not $installer) {
  Say 'RESULT FAIL 1 no installer on the unattended media'
  exit 1
}
Say "installer=$($installer.Name) bytes=$($installer.Length)"

# ---------------------------------------------------------------- install
$install = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
Say "install exit=$($install.ExitCode)"
Note ($install.ExitCode -eq 0) 'installer exited 0' "exit=$($install.ExitCode)"

Start-Sleep -Seconds 3
Note (Test-Path $AppExe) 'app executable installed'
Note (Test-Path $EngineExe) 'engine binary installed'
Note (Test-Path $PayloadShell) 'payload shell installed'
Note (Test-Path (Join-Path $ProductDir 'install-notes.txt')) 'install notes travelled with the install'

# ---------------------------------------------------------------- registration
$arp = Get-ItemProperty -Path $ArpKey -ErrorAction SilentlyContinue
if ($arp) {
  Say "arp name=$($arp.DisplayName) version=$($arp.DisplayVersion) publisher=$($arp.Publisher) icon=$($arp.DisplayIcon)"
  Note ($arp.DisplayVersion -match '^\d+\.\d+\.\d+ \(\d+\)$') 'Apps & features carries version and build' "version=$($arp.DisplayVersion)"
  Note ($arp.UninstallString -eq "`"$Uninstaller`"") 'uninstall string points at the uninstaller' "value=$($arp.UninstallString)"
} else {
  Note $false 'Apps & features entry written'
}

Note (Test-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Anywhere Work.lnk')) 'desktop shortcut created'
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Anywhere Work\Anywhere Work.lnk'
Note (Test-Path $startMenu) 'start menu shortcut created'

# ---------------------------------------------------------------- the engine runs
if (Test-Path $EngineExe) {
  try {
    $answer = ('{"id":1,"cmd":"version"}' | & $EngineExe 2>&1 | Out-String).Trim()
    Say "engine version answer: $answer"
    Note ($answer -match '"version"|"helper"|protocol') 'the embedded engine answers its protocol'
  } catch {
    Note $false 'the embedded engine answers its protocol' "error=$($_.Exception.Message)"
  }
}

# ---------------------------------------------------------------- the app starts
if (Test-Path $AppExe) {
  try {
    $app = Start-Process -FilePath $AppExe -PassThru
    # Bring the window to the front: the host takes its screenshot from QEMU's monitor, and
    # without this the picture can be of whatever else happens to be on top of it.
    try {
      Add-Type -AssemblyName Microsoft.VisualBasic
      [Microsoft.VisualBasic.Interaction]::AppActivate($app.Id) | Out-Null
    } catch {
      Say "could not activate the app window: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 25
    $alive = Get-Process -Id $app.Id -ErrorAction SilentlyContinue
    $window = if ($alive) { $alive.MainWindowTitle } else { '' }
    Say "app pid=$($app.Id) alive=$([bool]$alive) window=`"$window`""
    Note ([bool]$alive) 'the app is still running after 25s'
    Note ($window -ne '') 'the window has a title' "title=`"$window`""
    Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -like "$ProductDir*" } |
      ForEach-Object { Say "app process $($_.ProcessName) pid=$($_.Id)" }
    Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -like "$ProductDir*" } |
      Stop-Process -Force -ErrorAction SilentlyContinue
  } catch {
    Note $false 'the app starts' "error=$($_.Exception.Message)"
  }
}

# ---------------------------------------------------------------- install over itself
$before = (Get-ItemProperty -Path $ArpKey -ErrorAction SilentlyContinue).DisplayVersion
$reinstall = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
Start-Sleep -Seconds 3
$after = (Get-ItemProperty -Path $ArpKey -ErrorAction SilentlyContinue).DisplayVersion
Say "upgrade exit=$($reinstall.ExitCode) version before=$before after=$after"
Note ($reinstall.ExitCode -eq 0) 'reinstalling over an existing install exits 0'
Note (Test-Path $AppExe) 'the app survives an upgrade over itself'
Note ($after -eq $before) 'the registered version is unchanged by a same-version upgrade'

# ---------------------------------------------------------------- uninstall
if (Test-Path $Uninstaller) {
  Start-Process -FilePath $Uninstaller -ArgumentList '/S' -Wait | Out-Null
  $gone = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    if (-not (Test-Path $AppExe)) { $gone = $true; break }
  }
  Say "uninstall removed the app after $($i * 2)s: $gone"
  Note $gone 'uninstall removes the installed files'
  Note (-not (Test-Path $ArpKey)) 'uninstall removes the Apps & features entry'
  Note (-not (Test-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Anywhere Work.lnk'))) 'uninstall removes the desktop shortcut'
  Note (-not (Test-Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Anywhere Work'))) 'uninstall removes the start menu group'
} else {
  Note $false 'uninstaller present'
}

# ---------------------------------------------------------------- verdict
if ($script:Failures.Count -eq 0) {
  Say 'RESULT PASS every assertion held'
} else {
  Say "RESULT FAIL $($script:Failures.Count) $($script:Failures -join ' | ')"
}
if ($script:Serial) { try { $script:Serial.Close() } catch { } }