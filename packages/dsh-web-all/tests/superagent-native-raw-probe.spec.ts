import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, chmodSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<object>(), spawn: vi.fn() }))
import { spawn } from 'node:child_process'
import { runFixedNativeProbe } from '../src/host/services/superagent/managed-readiness.ts'
const roots: string[] = []
afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it.each(['absent', 'already-started', 'symlink', 'public', 'wrong-digest'])('never launches an unprovisioned raw probe: %s', mode => {
  const root = mkdtempSync(join(tmpdir(), 'native-raw-probe-')); roots.push(root); chmodSync(root, 0o700)
  const script = join(root, 'native-appserver-trust-probe.py'), result = join(root, 'native-appserver-trust-probe-result.json')
  if (mode === 'symlink') { writeFileSync(join(root, 'other.py'), 'bad'); symlinkSync(join(root, 'other.py'), script) }
  else if (mode !== 'absent') writeFileSync(script, 'untrusted', { mode: mode === 'public' ? 0o644 : 0o400 })
  if (mode === 'already-started') writeFileSync(result, '{}', { mode: 0o600 })
  if (['absent', 'already-started'].includes(mode)) expect(() => runFixedNativeProbe(root)).not.toThrow()
  else expect(() => runFixedNativeProbe(root)).toThrow(/NATIVE_PROBE_/)
  expect(spawn).not.toHaveBeenCalled(); expect(existsSync(result)).toBe(mode === 'already-started')
})
