# Windows acceptance in a KVM guest

The release workflow builds the Windows installer on a `windows-2025` runner and asserts
the install / upgrade / uninstall path there (`desktop-release.yml`, job
`windows-installer`). This directory is the same acceptance for a machine that has no
Windows host of its own: an unattended Windows guest on a Linux box with KVM, driven from
the outside through QEMU's serial port.

It exists because "the installer builds" and "the installer installs" are different
claims, and the second one needs a Windows kernel. Everything here changes nothing about
the product; it is how the product is exercised.

## What is in here

| File | Purpose |
| --- | --- |
| `autounattend.xml` | Unattended Windows: TPM/Secure Boot/RAM checks bypassed for a VM that has none of them, a local administrator, auto-logon, and a first-logon command that runs the test from the unattended media. No network adapter is attached on purpose. |
| `aw-test.ps1` | The acceptance run: silent install, layout and Apps & features assertions, the embedded engine's `version` command, launching the app and checking its window, installing over itself, then uninstalling and checking that both the files and the registration are gone. |
| `README.md` | This file. |

Every line the script reports starts with `AW-TEST: ` and goes to COM1 (which QEMU writes
to a file on the host) and to `C:\aw-test.log`. The last line is `AW-TEST: RESULT PASS` or
`AW-TEST: RESULT FAIL <n> ...`.

## Running it

On a host with `/dev/kvm`, `qemu-system-x86_64`, `wget`/`curl` and `genisoimage`:

The two things that are not obvious, both learned by running it:

- **Boot the guest with UEFI firmware.** The unattended layout is GPT (EFI system
  partition, MSR, primary), which is what a real Windows 11 machine has; Windows Setup
  booted in legacy BIOS mode refuses it with "Windows 11 can't be installed on disk 0
  partition 3". OVMF (`/usr/share/OVMF/OVMF_CODE_4M.fd` plus a writable copy of
  `OVMF_VARS_4M.fd`) fixes it.
- **Press a key while the installer's own prompt is up.** A Windows ISO prints "Press any
  key to boot from CD or DVD" and falls through to network boot if nobody answers, so
  `press-key.py` sends a keypress every two seconds for the first minute over the monitor
  (`sendkey spc`). A headless run without this lands in the UEFI shell.
- **Do not start QEMU with `-no-reboot`.** Setup restarts the machine twice to finish, and
  that flag turns the first restart into a shutdown. `supervise.sh` is the rest: it
  starts the guest from the CD, then from the disk, and stops when the verdict arrives.
- **The screenshot needs the window, not the Start menu.** A fresh unattended Windows can
  leave the Start menu open over the app, and Escape only reaches the focused window - the
  console running the acceptance script. `capture-app-window.py` toggles it away with the
  Windows key before shooting, and the acceptance script activates the app window first.

## The fleet installer, too

`aw-test-fleet.ps1` accepts `tools/dsh-netbird/client/install.ps1` in the same guest, with
the channel served from inside the machine (the guest has no network adapter). It is the
run that caught the script's PowerShell-6 assumption: the guest executes it with Windows
PowerShell 5.1, where `$IsWindows` does not exist, and `Set-StrictMode` turns reading it
into a terminating error - so the installer died inside its own platform check while a
`-DryRun` on pwsh 7 passed. `scripts/dsh-netbird-install-ps1.test.mjs` keeps that shape
from coming back; this run is what proves the rest.

```sh
# 1. Windows 11 Enterprise evaluation (about 5 GiB, public Microsoft link)
curl -fL -o win11.iso 'https://go.microsoft.com/fwlink/?linkid=2289031'

# 2. the installer under test, built by the packager
node tools/anywhere-agent/scripts/package-windows.mjs \
  --runtime <extracted electron-v*-win32-x64> \
  --helper <anywhere-tunnel.exe> \
  --version 0.4.6 --build "$(git rev-list --count HEAD)" \
  --icon <app-icon.ico> --out build
makensis build/*.nsi

# 3. the unattended media: the answer file, the test and the installer, labelled so the
#    first-logon command can find it whatever drive letter Windows gives it
mkdir unattend && cp autounattend.xml aw-test.ps1 build/*.exe unattend/
genisoimage -quiet -o aw-unattend.iso -V AWUNATTEND -J -R unattend

# 4. boot it and let the supervisor carry it through setup's reboots
sh supervise.sh &
# ...which runs run-vm.sh (the QEMU command line), press-key.py (the CD boot prompt) and
# stops as soon as the acceptance script has reported. The guest's console is a serial
# file and its monitor is a socket, so the verdict and a desktop screenshot both come out
# of the host: `echo 'screendump screen.ppm' | socat - UNIX-CONNECT:mon.sock`.

# 5. read the verdict (Windows takes 15-30 minutes to install, then runs the test)
cat aw-test.txt
```

(The install itself needs no input: the answer file wipes the disk, creates the layout,
installs the Enterprise evaluation image and runs the test at first logon. It writes
`AW-TEST:` lines to COM1 from that point on, which is why the serial file is empty until
Windows is up.)

A screenshot of the guest's desktop can be taken from the monitor socket while it runs
(`echo 'screendump screen.ppm' | socat - UNIX-CONNECT:mon.sock`), which is how the app
window is captured as evidence rather than inferred from a process list.

## What it can and cannot show

It shows: the installer places a per-user install, registers it with the released version
and the commit-count build, upgrades over itself, the engine binary runs, the app starts
and opens a window, and the uninstall removes everything it created.

It does not show: joining the fleet. The guest has no network adapter and no enrollment
credentials, so the overlay, the service catalogue and the sign-in path are out of scope
here - they need the fleet's own setup key and are exercised against the real control
plane.

## Runs

| Date | Artefact under test | Result |
| --- | --- | --- |
| 2026-10-23 | `Anywhere Work-0.4.6-83.exe` | FAIL 1 of 21: `UninstallString` registered without quotes, so a path with a space in it is a command line Windows has to guess at. Fixed in the packager. |
| 2026-10-23 | `Anywhere Work-0.4.6-86.exe` | PASS: per-user install, Apps & features carries `0.4.6 (86)`, the embedded engine answered its protocol (`netbird v0.78.1`, `helper 0.1.1`, `protocol 1`), the app ran for 25s with the window titled "Anywhere Work", reinstalling over itself exited 0 with the version unchanged, and the uninstall removed the files, the registration and both shortcuts. |
| 2026-10-23 | `install.ps1` (fleet installer) | Four runs: FAIL 5 (a PowerShell-6 assumption killed it before it downloaded anything) -> FAIL 1 (the join had no deadline, so the run sat on an unreachable control plane) -> FAIL 1 (uninstall read the channel first, and `schtasks`' stderr aborted it) -> **PASS**: binary installed and on PATH, a channel whose bytes do not match its digest refused with the installed binary left untouched, the service registered, and the uninstall removing the directory. |
| 2026-10-23 | both acceptances in one run | `AW-TEST: ALL-RESULTS app=[PASS every assertion held] fleet=[PASS every assertion held]` |

The fleet runs are the reason `install.ps1` is different today: every one of its four
failures was invisible to a `-DryRun` on PowerShell 7, because they were Windows PowerShell
5.1 behaviours (`$IsWindows` does not exist there; a redirected native stderr is a
terminating error under `$ErrorActionPreference = Stop`) or a hang nothing bounded. Each
now has a static gate in `scripts/dsh-netbird-install-ps1.test.mjs` as well as this run.

Both runs were on Windows 11 (10.0.26100) in the guest described above; the transcript of
the second is what `grep 'AW-TEST:' serial.log` prints, and `capture-app-window.py` saves
the desktop while the app is up. What neither run shows is joining the fleet: the guest has
no network adapter and no enrollment credentials.