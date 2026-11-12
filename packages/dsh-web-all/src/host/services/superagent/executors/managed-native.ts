import { copyFileSync, chmodSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import type { Ref, Json } from '../protocol/managed-work.ts'
import type { Workspace } from '../protocol/execution.ts'
import type { createControlledKernel } from '../kernel/actions.ts'
import { CodexNativeExecutor, isolatedCodexArgs } from './engines/codex.ts'
import { ControlledJsonl } from './native/jsonl.ts'

export interface ManagedEngineConfig { executable: string; authFile: string; model: string; stateRoot: string; source: Ref }
export async function launchManagedCodex(kernel: ReturnType<typeof createControlledKernel>, config: ManagedEngineConfig, worker: Ref, workspace: Workspace, scopes: Ref[], instructions: string, tools: Json[], outputSchema?: Json, resume?: { home: string; nativeSessionId: string }) {
  const home = resume?.home ?? config.stateRoot
  {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    copyFileSync(config.authFile, join(home, 'auth.json')); chmodSync(join(home, 'auth.json'), 0o600)
    writeFileSync(join(home, 'config.toml'), `model = ${JSON.stringify(config.model)}\nmodel_reasoning_effort = "medium"\ncli_auth_credentials_store = "file"\n`, { mode: 0o600 })
  }
  const id = 'native:' + randomUUID(), args = isolatedCodexArgs(), expiresAt = Date.now() + 15 * 60_000
  const control = kernel.host.grantControl(worker, worker.id, expiresAt)
  kernel.host.grantCapability({ id: id + ':cap', revision: 1, scopeRefs: scopes, evidenceRefs: ['P3b:restricted-codex-native-qualification', 'P3:real-dynamic-tools-and-inventory'], expiresAt, externalTools: 'blocked', revoked: false,
    launch: { executable: config.executable, args, processPolicy: 'single' }, nativeRuntime: { maxProcessMs: 600000, root: realpathSync(home), readonlyRuntimeRoots: [realpathSync(dirname(config.executable))], stateDirectoryVariable: 'CODEX_HOME', network: 'engine-transport', evidenceRefs: ['P3b:actual-inventory-and-denied-native-shell'] } })
  kernel.host.grantMandate({ id: id + ':mandate', revision: 1, requester: 'authenticated-host', subject: worker.id, target: worker, actions: ['dispatch','attach','inspect','send_input','steer','respond_request','cancel','collect'], workspaceId: workspace.id, resourceIds: workspace.resources, scopeRefs: scopes, expiresAt, revoked: false })
  const action = kernel.actions.planAction({ id, idempotencyKey: id, requester: 'authenticated-host', subject: worker.id, target: worker, epoch: control.epoch, mandateRef: { id: id + ':mandate', revision: 1 }, capabilityRef: { id: id + ':cap', revision: 1 }, kind: 'dispatch', scopeRefs: scopes, workspaceId: workspace.id, resourceIds: workspace.resources, purpose: workspace.role, executable: config.executable, args, timeoutMs: 600000, processPolicy: 'single' })
  kernel.actions.claimResources(action.ref, workspace.resources)
  const launch = kernel.host.beginDispatch(action.ref)
  if (launch.kind === 'denial') throw new Error(launch.code)
  const io = new ControlledJsonl(kernel, launch, id)
  try {
    const engine = await CodexNativeExecutor.connect(io, { hostRef: 'host:local', engineRef: 'codex', runtimeNamespace: home, cwd: workspace.root, instructions, dynamicTools: tools, ...(outputSchema ? { outputSchema } : {}), ...(resume ? { nativeSessionId: resume.nativeSessionId } : {}) })
    return { engine, io, home, launch, async stop() { kernel.host.revokeControl(worker, config.source); const result = await io.process.closed; return result }, cleanupCredentials() { rmSync(join(home, 'auth.json'), { force: true }) } }
  } catch (error) {
    kernel.host.revokeControl(worker, config.source); await io.process.closed
    rmSync(join(home, 'auth.json'), { force: true }); throw error
  }
}
export async function runManagedTurn(native: Awaited<ReturnType<typeof launchManagedCodex>>, text: string, requestId: string, assignmentRevision: number, signal: AbortSignal) {
  const input = { request_id: requestId, assignment_revision: assignmentRevision, payload_digest: createHash('sha256').update(text).digest('hex'), payload_ref: requestId, text }
  let receipt = await native.engine.execute(input, signal)
  let initialReceipt = true
  while (Date.now() < native.launch.expiresAt) {
    if (signal.aborted) throw new Error('MANAGED_TURN_ABORTED')
    if (!initialReceipt) receipt = await native.engine.receiptFor(input)
    initialReceipt = false
    if (receipt.status === 'consumed') {
      const turnId = receipt.consumption.turn_id
      const turn = native.engine.turns().find(t => t.id === turnId)
      if (turn?.status === 'completed') return { input, receipt, turn, answer: turn.items.filter(i => i.type === 'agentMessage').at(-1)?.text ?? '' }
      if (turn && ['failed', 'interrupted'].includes(turn.status)) throw new Error('MANAGED_TURN_' + turn.status)
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('MANAGED_TURN_OUTCOME_UNKNOWN')
}
