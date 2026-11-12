import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const capture = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../src/host/services/superagent/kernel/sandbox-launch-port.ts', async importOriginal => ({
  ...await importOriginal<object>(),
  configuredSandboxLaunchPort: () => ({ open: capture.open }), sandboxFixtureProfile: (profile: string) => profile,
}))
import { openSandboxProcess } from '../src/host/services/superagent/kernel/sandbox-process.ts'
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })
it('limits native transport diagnostics to fixed connection targets without inheriting secrets or log directives', async () => {
  vi.stubEnv('RUST_LOG', 'trace'); vi.stubEnv('HTTPS_PROXY', 'credential-canary'); vi.stubEnv('OPENAI_API_KEY', 'credential-canary')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-log-env-')))
  try {
    for (const native of [true, false]) {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), cancel: vi.fn(), unref: vi.fn() })
      capture.open.mockReturnValue(child)
      const process = openSandboxProcess({ workspace: { root }, spec: { executable: '/usr/bin/true', args: [], processPolicy: 'single', timeoutMs: 1000 }, expiresAt: Date.now() + 1000, ...(native ? { nativeRuntime: { root, stateDirectoryVariable: 'CODEX_HOME' } } : {}) } as any, new AbortController().signal, () => true, () => {}, x => x)
      const env = capture.open.mock.calls.at(-1)![0].env
      expect(env).toEqual({ PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, LANG: 'en_US.UTF-8', ...(native ? { CODEX_HOME: root, RUST_LOG: 'error,reqwest::connect=debug,hyper_util::client::legacy::connect=debug' } : {}) })
      child.emit('exit', 0); child.emit('close'); await process.closed
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
