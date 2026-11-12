import { expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { sandboxProcessLaunchParameters } from '../src/host/services/superagent/kernel/sandbox-process.ts'

it('allows both trust service namespaces only for a native transport runtime', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-trust-')))
  const executable = realpathSync(process.execPath)
  const base = { workspace: { root }, spec: { executable, args: [], processPolicy: 'single' as const, timeoutMs: 1000 } }
  try {
    const native = sandboxProcessLaunchParameters({ ...base, nativeRuntime: { root, stateDirectoryVariable: 'CODEX_HOME', readonlyRuntimeRoots: [dirname(executable)], network: 'engine-transport', evidenceRefs: ['test'] } })
    expect(native.profile).toContain('(global-name "com.apple.trustd")')
    expect(native.profile).toContain('(global-name "com.apple.trustd.agent")')
    const ordinary = sandboxProcessLaunchParameters(base)
    expect(ordinary.profile).not.toContain('com.apple.trustd')
    expect(native.profile).not.toContain('(allow process-fork)')
    expect(ordinary.profile).not.toContain('(allow network-outbound)')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
