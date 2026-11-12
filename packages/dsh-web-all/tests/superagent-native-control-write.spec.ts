import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, realpathSync, rmSync } from 'node:fs'
import { fixture } from './fixtures/superagent/controlled.ts'
import { ManagedLedger } from '../src/host/services/superagent/kernel/managed-ledger.ts'
import { createControlledKernel, type ExecutionEnvelope } from '../src/host/services/superagent/kernel/actions.ts'
import * as domain from '../src/host/services/superagent/kernel/native-domain.ts'
import * as sandbox from '../src/host/services/superagent/kernel/sandbox-process.ts'

function watchWrites(db: DatabaseSync) {
  db.exec(`CREATE TABLE control_writes (n INTEGER NOT NULL);
    INSERT INTO control_writes VALUES(0);
    CREATE TRIGGER count_control_write AFTER UPDATE ON sa_managed_control
    BEGIN UPDATE control_writes SET n=n+1; END;`)
  return () => Number(db.prepare('SELECT n FROM control_writes').get()!.n)
}

it('durably appends every raw native frame without rewriting unchanged control state', () => {
  const f = fixture(), db = new DatabaseSync(f.path)
  let reopened: ManagedLedger | undefined
  try {
    const action = f.k.actions.planAction(f.spec())
    f.k.actions.claimResources(action.ref, f.workspace.resources)
    const launch = f.k.host.beginDispatch(action.ref) as ExecutionEnvelope
    const writes = watchWrites(db)
    const before = String(db.prepare('SELECT body_json FROM sa_managed_control').get()!.body_json)
    const sequence = Number(db.prepare('SELECT sequence FROM sa_managed_meta').get()!.sequence)
    const frames = Array.from({ length: 4 }, (_, i) => ({ kind: 'delta', raw: { type: 'item', delta: `raw\n${i}`, index: i } }))
    const refs = frames.map(frame => f.k.host.observeNative(launch.actionRef, 'raw-stream', frame).nativeRef)
    expect(writes(), 'native observations must not rewrite control state').toBe(0)
    expect(String(db.prepare('SELECT body_json FROM sa_managed_control').get()!.body_json)).toBe(before)
    expect(refs).toEqual(frames.map((_, i) => `native-event:${sequence + i + 1}`))
    expect(() => f.k.host.observeNative({ id: 'missing', revision: 1 }, 'raw-stream', frames[0]!)).toThrow('NATIVE_OBSERVATION_OWNER_REQUIRED')
    expect(() => f.k.host.observeNative({ id: 'target', revision: 1 }, 'raw-stream', frames[0]!)).toThrow('NATIVE_OBSERVATION_OWNER_REQUIRED')
    expect(() => f.k.host.observeNative(launch.actionRef, ' ', frames[0]!)).toThrow('NATIVE_OBSERVATION_OWNER_REQUIRED')
    expect(Number(db.prepare('SELECT sequence FROM sa_managed_meta').get()!.sequence)).toBe(sequence + frames.length)
    f.ledger.close()
    reopened = new ManagedLedger(f.path)
    const kernel = createControlledKernel(reopened, f.sourceRef)
    expect(kernel.host.nativeFacts('raw-stream')).toEqual(frames.map((observation, i) => ({ ref: refs[i], observation })))
    expect(reopened.eventEntries({ nativeStream: 'raw-stream' }).map(e => e.body)).toEqual(frames.map(observation => ({ protocol_version: 2, controlled: { kind: 'host', source: f.sourceRef, command: { kind: 'native', actionRef: launch.actionRef, stream: 'raw-stream', observation } } })))
    expect(kernel.host.observeNative(launch.actionRef, 'raw-stream', { kind: 'delta', raw: 'after reopen' }).nativeRef).toBe(`native-event:${sequence + frames.length + 1}`)
    expect(writes()).toBe(0)
  } finally { if (reopened) reopened.close(); else f.ledger.close(); db.close(); rmSync(f.dir, { recursive: true, force: true }) }
})

it('persists domain absence revocation and resource release despite its native event rewrite', () => {
  const f = fixture(), db = new DatabaseSync(f.path)
  const open = vi.spyOn(sandbox, 'openSandboxProcess').mockReturnValue({} as never)
  const inspect = vi.spyOn(domain, 'inspectNativeDomainAbsence').mockReturnValue({ observedAt: 1, runtimeRoot: realpathSync(f.dir) } as never)
  let reopened: ManagedLedger | undefined
  try {
    const base = f.spec(), runtimeRoot = join(f.dir, 'native-runtime')
    mkdirSync(runtimeRoot)
    f.k.host.grantCapability({ id: 'native', revision: 1, expiresAt: Date.now() + 60000, scopeRefs: [], evidenceRefs: ['test'], externalTools: 'blocked', revoked: false, launch: { executable: base.executable, args: base.args, processPolicy: base.processPolicy }, nativeRuntime: { root: realpathSync(runtimeRoot), stateDirectoryVariable: 'CODEX_HOME', network: 'engine-transport', evidenceRefs: ['test'] } })
    const action = f.k.actions.planAction({ ...base, capabilityRef: { id: 'native', revision: 1 } })
    f.k.actions.claimResources(action.ref, f.workspace.resources)
    const launch = f.k.host.beginDispatch(action.ref) as ExecutionEnvelope
    f.k.host.openProcess(launch.actionRef)
    const writes = watchWrites(db)
    const fact = f.k.host.observeNativeDomainAbsence(launch.actionRef)
    expect(writes()).toBe(1)
    expect(inspect).toHaveBeenCalledTimes(1)
    f.ledger.close()
    reopened = new ManagedLedger(f.path)
    const state = JSON.parse(String(db.prepare('SELECT body_json FROM sa_managed_control').get()!.body_json))
    expect(state.capabilities.find((c: any) => c.id === 'native').revoked).toBe(true)
    expect(state.controls.find((c: any) => c.target.id === 'target').revoked).toBe(true)
    const leases = state.resources.filter((r: any) => r.actionRef.id === action.ref.id)
    expect(leases.map((r: any) => r.resourceId)).toEqual(f.workspace.resources)
    expect(leases.every((r: any) => r.status === 'released')).toBe(true)
    const kernel = createControlledKernel(reopened, f.sourceRef)
    expect(kernel.host.nativeFacts('execution:' + action.ref.id)).toMatchObject([{ ref: fact.nativeRef, observation: { kind: 'domain_absence', releasedResources: f.workspace.resources, retiredCapability: { id: 'native', revision: 1 } } }])
    kernel.host.grantControl({ id: 'target', revision: 1 }, 'replacement', Date.now() + 60000)
    expect(writes()).toBe(2)
    expect(JSON.parse(String(db.prepare('SELECT body_json FROM sa_managed_control').get()!.body_json)).controls.find((c: any) => c.target.id === 'target')).toMatchObject({ holder: 'replacement', revoked: false })
  } finally { open.mockRestore(); inspect.mockRestore(); if (reopened) reopened.close(); else f.ledger.close(); db.close(); rmSync(f.dir, { recursive: true, force: true }) }
})
