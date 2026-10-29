/**
 * The Windows onboarding script has to run on the powershell.exe a Windows machine has.
 *
 * install.ps1 is executed by Windows PowerShell 5.1 when the app hands it over, and that
 * shell does not define $IsWindows (it arrived in PowerShell 6). With Set-StrictMode a read
 * of an undefined variable is a terminating error, so the script died in its own platform
 * check on a real Windows host - while a -DryRun on pwsh 7 passed, which is how it reached
 * a virtual machine before anyone noticed.
 *
 * A static gate is the cheap half of that lesson: the version-dependent variable may only
 * be read through the guard that checks for its existence first. The real half is the
 * acceptance run in tools/anywhere-agent/poc/winvm.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SCRIPT = 'tools/dsh-netbird/client/install.ps1'

test('the Windows installer does not assume PowerShell 6', () => {
  const source = readFileSync(SCRIPT, 'utf8')

  // A version-agnostic check exists, and the platform assertion goes through it.
  assert.match(source, /function Test-IsWindows/, 'the script defines a version-agnostic check')
  assert.match(source, /Get-Variable -Name IsWindows -ErrorAction SilentlyContinue/, 'which asks whether the variable exists at all')
  assert.match(source, /if \(-not \(Test-IsWindows\)\)/, 'and the platform assertion uses it')

  // No bare read outside that helper: everything after the helper must not mention it.
  const helper = source.indexOf('function Test-IsWindows')
  const guardEnd = source.indexOf('function Assert-Windows')
  assert.ok(helper !== -1 && guardEnd > helper, 'the helper precedes the assertion')
  const afterGuard = source.slice(guardEnd)
  assert.equal(/\$IsWindows/.test(afterGuard), false, 'nothing after the guard reads $IsWindows directly')
})

test('uninstall is answered before the channel is read', () => {
  // Removing what is on this machine must not depend on the network that put it there. The
  // acceptance guest has no network adapter, and -Uninstall used to fail on "the channel
  // published no latest.txt" before removing anything.
  const source = readFileSync(SCRIPT, 'utf8')
  const uninstallAt = source.indexOf('if ($Uninstall) {')
  const channelAt = source.indexOf("Step 'resolving the client version'")
  assert.ok(uninstallAt !== -1, 'the uninstall branch exists')
  assert.ok(channelAt > uninstallAt, 'and it comes before anything reads the channel')
})

test('the installer does not redirect a native command\'s stderr', () => {
  // Windows PowerShell 5.1 turns a *redirected* native stderr into a terminating error while
  // $ErrorActionPreference is Stop. `schtasks /Delete` on a machine that never had the logon
  // task writes to stderr, and that is how the uninstall stopped before removing anything -
  // found in the guest, not in review, and missed by a DryRun on PowerShell 7.
  const offending = readFileSync(SCRIPT, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .filter((line) => /2>\$null|2>&1/.test(line))
  assert.deepEqual(offending, [], 'native stderr must not be redirected')
})

test('the Windows installer keeps the pieces its acceptance run exercises', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  // Each of these is a claim the guest's acceptance run checks on a real Windows; losing one
  // here would silently shrink what that run proves.
  for (const [pattern, what] of [
    [/Get-FileHash -Algorithm SHA256/, 'the channel digest is verified before unpacking'],
    [/checksum mismatch/, 'and a mismatch stops the install'],
    [/-Uninstall/, 'uninstall can be asked for explicitly'],
    [/schtasks\.exe \/Create/, 'the DSH host is kept resident by a logon task'],
  ]) {
    assert.match(source, pattern, what)
  }
})
