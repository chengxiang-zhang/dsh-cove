import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { writeFileSync, rmSync, readFileSync } from 'node:fs'
import { fixture } from './fixtures/superagent/controlled.ts'
import {
  registerDshNativeRoles,
  DshNativeExecutor
} from '../src/host/services/superagent/executors/engines/dsh.ts'
import type { ExecutionEnvelope } from '../src/host/services/superagent/kernel/actions.ts'
const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.ledger.close()
    rmSync(f.dir, { recursive: true, force: true })
  }
})
it('mounts actual managed tool definitions only for declared native sessions and fences inherited tools', async () => {
  const f = fixture()
  fixtures.push(f)
  f.k.host.grantMandate({
    id: 'native',
    revision: 1,
    requester: 'owner',
    subject: 'worker',
    target: { id: 'target', revision: 1 },
    actions: ['dispatch', 'inspect', 'respond_request'],
    workspaceId: f.workspace.id,
    resourceIds: f.workspace.resources,
    scopeRefs: [],
    expiresAt: Date.now() + 60000,
    revoked: false
  })
  const spec = { ...f.spec('dsh-launch'), mandateRef: { id: 'native', revision: 1 } },
    a = f.k.actions.planAction(spec)
  f.k.actions.claimResources(a.ref, spec.resourceIds)
  const launch = f.k.host.beginDispatch(a.ref) as ExecutionEnvelope
  const bootstrap = join(f.dir, 'bindings.json')
  writeFileSync(
    bootstrap,
    JSON.stringify({
      ledgerPath: f.path,
      sourceRef: f.sourceRef,
      nodeExecutable: process.execPath,
      runtimeNamespace: 'owned-dsh',
      bindings: [{ sessionId: 'managed-session', launchRef: launch.actionRef, role: 'worker' }]
    })
  )
  const hooks = new Map<string, Function>(),
    registered = new Map<string, any>(),
    guards: Function[] = [],
    restrictions: unknown[] = []
  const ctx = {
    on(event: string, fn: Function) {
      hooks.set(event, fn)
      return () => hooks.delete(event)
    }
  }
  const dispose = registerDshNativeRoles(ctx as never, { bootstrapFile: bootstrap })
  const io = {
    kernel: f.k,
    launch,
    stream: 'test-http',
    observe: (observation: any) =>
      f.k.host.observeNative(launch.actionRef, 'test-http', observation).nativeRef
  }
  const broker = new DshNativeExecutor(io as never, {
    host_ref: 'host',
    engine_ref: 'dsh',
    runtime_namespace: 'owned-dsh',
    native_session_id: 'managed-session'
  })
  const stopBroker = broker.serveControlledTools(process.execPath)
  const tools = {
    restrict: (value: unknown) => {
      restrictions.push(value)
      return () => {}
    },
    guard: (fn: Function) => {
      guards.push(fn)
      return () => {}
    },
    register: (tool: any) => {
      registered.set(tool.name, tool)
      return () => {}
    },
    schemas: () => [...registered.values()]
  }
  hooks.get('agent/created')!({ agent: { session: { id: 'unmanaged' }, ctx: { tools } } })
  expect(registered.size).toBe(0)
  hooks.get('agent/created')!({ agent: { session: { id: 'managed-session' }, ctx: { tools } } })
  expect(restrictions).toEqual([{ allow: [] }])
  expect([...registered.keys()].sort()).toEqual(['ask', 'check', 'read', 'write'])
  expect(guards[0]!({ name: 'exec_command' })).toBe('MANAGED_NATIVE_TOOL_DENIED')
  expect(
    await registered
      .get('write')
      .execute(
        { path: 'dsh.txt', content: 'real-helper' },
        { callId: 'actual-sdk-call', signal: new AbortController().signal }
      )
  ).toMatchObject({ success: true })
  expect(readFileSync(join(f.workspace.root, 'dsh.txt'), 'utf8')).toBe('real-helper')
  f.k.host.revokeControl(spec.target, f.sourceRef)
  expect(guards[0]!({ name: 'write' })).toBe('MANAGED_NATIVE_CONTROL_FENCED')
  stopBroker()
  await dispose()
  expect(guards[0]!({ name: 'exec_command' })).toBe('MANAGED_NATIVE_RETIRED')
})
