import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareVerificationAssets } from '../src/host/services/superagent/executors/verification-run.ts'

it('retains bounded child exit diagnostics when private asset creation fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prepare-failure-'))
  try {
    const error = await prepareVerificationAssets(root, []).catch(error => error)
    expect(error.message).toMatch(/^VERIFICATION_PROCESS_FAILED:/)
    expect(error.subprocessDiagnostic).toMatchObject({ code: 1, signal: null, timeoutMs: 5000, failed: false, stopping: false, stdoutBytes: 0 })
    expect(error.subprocessDiagnostic.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(error.subprocessDiagnostic.stderrTail).toMatch(/EEXIST|EISDIR/)
    expect(error.subprocessDiagnostic.stderrTail.length).toBeLessThanOrEqual(8192)
    expect(error.subprocessDiagnostic).not.toHaveProperty('stdout')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('persists only private fixed-control diagnostics and keeps public failure closed', async () => {
  const diagnostic = { code: 1, signal: null, timeoutMs: 5000, elapsedMs: 12, failed: false, stopping: false, reason: null, stdoutBytes: 0, stderrTail: 'synthetic child failure', stdout: 'must not persist', env: { TOKEN: 'must not persist' } }
  vi.doMock('../src/host/services/superagent/managed-readiness.ts', async importOriginal => ({
    ...await importOriginal<any>(),
    calibrateManagedMethod: async () => { throw Object.assign(Error('VERIFICATION_PROCESS_FAILED: synthetic child failure'), { calibrationControl: 'known-good', subprocessDiagnostic: diagnostic, businessRows: ['must not persist'] }) },
  }))
  const { createManagedAdmission } = await import('../src/host/services/superagent/managed-runtime.ts')
  const root = mkdtempSync(join(tmpdir(), 'calibration-failure-')), home = join(root, 'host'), bootstrap = join(root, 'bootstrap.json')
  writeFileSync(bootstrap, JSON.stringify({ root: home, defaultProject: 'p', projects: { p: { verification: { methodId: 'javascript-module@1', settings: { entryPath: 'control.mjs' } } } } }), { mode: 0o600 })
  try {
    const port = createManagedAdmission({ bootstrapFile: bootstrap }, () => {})
    await port.dispose()
    expect(port.readiness()).toMatchObject({ ready: false, projects: [{ calibration: 'fail', error: 'VERIFICATION_PROCESS_FAILED' }] })
    expect(JSON.stringify(port.readiness())).not.toContain('synthetic child failure')
    expect(port.readiness()).toMatchObject({ projects: [{ diagnosticPersistence: 'saved' }] })
    const files = readdirSync(home).filter(name => name.startsWith('calibration-failure-'))
    expect(files).toHaveLength(1)
    const next = createManagedAdmission({ bootstrapFile: bootstrap }, () => {})
    await next.dispose()
    expect(readdirSync(home).filter(name => name.startsWith('calibration-failure-'))).toHaveLength(2)
    const path = join(home, files[0]!), bytes = readFileSync(path, 'utf8'), saved = JSON.parse(bytes)
    expect(statSync(path).mode & 0o777).toBe(0o400)
    expect(statSync(home).mode & 0o777).toBe(0o700)
    expect(saved).toMatchObject({ stage: 'fixed-calibration', control: 'known-good', errorCode: 'VERIFICATION_PROCESS_FAILED', subprocess: { stderrTail: 'synthetic child failure', code: 1 } })
    expect(bytes).not.toContain('must not persist')
  } finally { vi.doUnmock('../src/host/services/superagent/managed-readiness.ts'); rmSync(root, { recursive: true, force: true }) }
})

it('retains the original failure when private diagnostic storage is unavailable', async () => {
  vi.resetModules()
  vi.doMock('../src/host/services/superagent/managed-readiness.ts', async importOriginal => ({
    ...await importOriginal<any>(), calibrateManagedMethod: async () => { throw Error('VERIFICATION_PROCESS_FAILED: private reason') },
  }))
  const { createManagedAdmission } = await import('../src/host/services/superagent/managed-runtime.ts')
  const root = mkdtempSync(join(tmpdir(), 'calibration-storage-')), home = join(root, 'host'), bootstrap = join(root, 'bootstrap.json')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(home, { mode: 0o755 })
  writeFileSync(bootstrap, JSON.stringify({ root: home, defaultProject: 'p', projects: { p: { verification: { methodId: 'javascript-module@1', settings: { entryPath: 'control.mjs' } } } } }), { mode: 0o600 })
  try {
    const port = createManagedAdmission({ bootstrapFile: bootstrap }, () => {})
    await port.dispose()
    expect(port.readiness()).toMatchObject({ ready: false, projects: [{ calibration: 'fail', error: 'VERIFICATION_PROCESS_FAILED', diagnosticPersistence: 'failed' }] })
    expect(readdirSync(home).filter(name => name.startsWith('calibration-failure-'))).toEqual([])
    expect(JSON.stringify(port.readiness())).not.toContain('private reason')
  } finally { vi.doUnmock('../src/host/services/superagent/managed-readiness.ts'); rmSync(root, { recursive: true, force: true }) }
})

it('labels a fixed-control failure while rethrowing the original subprocess error', async () => {
  vi.resetModules()
  const failure = Object.assign(Error('VERIFICATION_PROCESS_FAILED: synthetic prepare failure'), { subprocessDiagnostic: { code: 1 } })
  vi.doMock('../src/host/services/superagent/executors/verification-run.ts', async importOriginal => ({
    ...await importOriginal<any>(), prepareVerificationAssets: async () => { throw failure },
  }))
  try {
    const { calibrateManagedMethod } = await import('../src/host/services/superagent/managed-readiness.ts')
    const error = await calibrateManagedMethod('diagnostic-control.mjs').catch(error => error)
    expect(error).toBe(failure)
    expect(error.calibrationControl).toBe('known-good')
    expect(error.subprocessDiagnostic).toEqual({ code: 1 })
  } finally { vi.doUnmock('../src/host/services/superagent/executors/verification-run.ts') }
})
