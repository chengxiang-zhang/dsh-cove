import { deliveryActionSpec as deliveryRecoverySpec } from '../protocol/delivery.ts'
import { inspectNativeDomainAbsence } from './native-domain.ts'
import type { ExpectedDevTransition } from '../protocol/delivery.ts'
import { managedLaunchScope } from './coordination-ledger.ts'
import type { DatabaseSync } from 'node:sqlite'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { openSandboxProcess, type SandboxProcess } from './sandbox-process.ts'
import type { ManagedLedger } from './managed-ledger.ts'
import {
  assertJson,
  assertRefs,
  type Ref,
  type ManagedObject,
  type Json
} from '../protocol/managed-work.ts'
import type { ControlLease, ControlReceipt, Mandate, Denial } from './control.ts'
import type { ResourceLease } from './resources.ts'
import { verifyWorkspace } from './resources.ts'
import type { Workspace } from '../protocol/execution.ts'
import { runSandbox, type SandboxResult } from './sandbox-runner.ts'
import { verificationScopes } from './verification-ledger.ts'
export interface ActionSpec {
  expectedDevTransition?: ExpectedDevTransition
  id: string
  idempotencyKey: string
  requester: string
  subject: string
  target: Ref
  epoch: number
  mandateRef: Ref
  capabilityRef: Ref
  kind:
    | 'dispatch'
    | 'inspect'
    | 'attach'
    | 'send_input'
    | 'steer'
    | 'respond_request'
    | 'cancel'
    | 'collect'
    | 'provision'
    | 'prepare_preview'
    | 'integrate'
    | 'deliver'
  payloadDigest?: string
  nativeRequestId?: string
  workspaceId: string
  resourceIds: string[]
  scopeRefs: Ref[]
  purpose: Workspace['role']
  executable: string
  args: string[]
  timeoutMs: number
  processPolicy: 'single' | 'children'
}
export interface OperationProof {
  ownerRef: Ref
  payloadDigest: string
  nativeRequestId: string
  responseDigest: string
}
export interface ActionReceipt {
  operation?: OperationProof
  status: 'confirmed' | 'failed' | 'unknown'
  evidenceRefs: string[]
  stopped: boolean
  cessation?: {
    kind: 'stopped' | 'isolated' | 'unconfirmed'
    evidenceRefs: string[]
    isolatedWorkspaceId?: string
  }
  exitCode?: number
  reason?: string
  observation?: { stdout: string; stderr: string; observedAt: number }
}
export interface ActionRecord {
  ref: Ref
  spec: ActionSpec
  state: string
  receipt?: ActionReceipt
}
export interface NativeRuntimePolicy {
  maxProcessMs?: number
  loopbackServer?: boolean
  readonlyRuntimeRoots?: string[]
  root: string
  stateDirectoryVariable: string
  network: 'engine-transport'
  evidenceRefs: string[]
}
export interface ProcessActionResult extends ActionRecord {
  processObservationRef: string
  reconciliation: 'updated' | 'historical'
}
export interface ExecutionEnvelope {
  nativeRuntime?: NativeRuntimePolicy
  kind: 'envelope'
  actionRef: Ref
  target: Ref
  epoch: number
  expiresAt: number
  workspace: Workspace
  spec: ActionSpec
}
export interface CapabilityFence {
  deliveryRecovery?: Ref
  expectedDevTransition?: ExpectedDevTransition
  nativeRuntime?: NativeRuntimePolicy
  id: string
  revision: number
  expiresAt: number
  scopeRefs: Ref[]
  evidenceRefs: string[]
  externalTools: 'blocked'
  revoked: boolean
  launch: { executable: string; args: string[]; processPolicy: 'single' | 'children' }
}
interface State {
  nativeClaims?: { ownerRef: Ref; key: string }[]
  helperDomains?: { workspaceId: string; actionId: string }[]
  opened?: string[]
  borrowed?: { actionId: string; ownerRef: Ref }[]
  frames?: { actionId: string; digest: string }[]
  capabilities: CapabilityFence[]
  mandates: Mandate[]
  controls: ControlLease[]
  resources: ResourceLease[]
  workspaces: Workspace[]
}
interface ReadLedger {
  events(): Json[]
  eventEntries(filter: import('./managed-ledger.ts').ManagedEventFilter): { sequence: number; body: Json }[]
  eventRefs(filter: import('./managed-ledger.ts').ManagedEventFilter): string[]
  validate(object: ManagedObject): void
  get(id: string): ManagedObject | undefined
  applicability(id: string): string
  snapshot(): ManagedObject[]
}
const hostTokens = new WeakSet<object>()
type HostCommand =
  | { kind: 'retire_partial_delivery'; actionRef: Ref; specDigest: string; journalDigest: string }
  | { kind: 'native_domain_absence'; actionRef: Ref }
  | { kind: 'request_claim'; ownerRef: Ref; key: string }
  | { kind: 'native'; actionRef: Ref; stream: string; observation: Json }
  | { kind: 'mandate'; mandate: Omit<Mandate, 'source'> }
  | { kind: 'workspace'; workspace: Workspace }
  | { kind: 'capability'; capability: CapabilityFence }
  | { kind: 'revoke_capability'; id: string }
  | { kind: 'control'; target: Ref; holder: string; expiresAt: number }
  | { kind: 'revoke'; target: Ref }
  | { kind: 'revoke_mandate'; id: string }
export type ControlledCommand =
  | { kind: 'host'; token: object; source: Ref; command: HostCommand }
  | { kind: 'plan'; spec: ActionSpec }
  | { kind: 'authorize' | 'send' | 'run' | 'fence'; ref: Ref }
  | { kind: 'helper'; ref: Ref; token: object }
  | { kind: 'process_open'; ref: Ref; token: object }
  | { kind: 'borrow'; ref: Ref; ownerRef: Ref; token: object }
  | { kind: 'frame'; ref: Ref; ownerRef: Ref; digest: string; token: object }
  | { kind: 'claim'; ref: Ref; resourceIds: string[] }
  | { kind: 'result'; ref: Ref; receipt: ActionReceipt; token?: object; source?: Ref }
export type ControlledResult =
  | { claimed: boolean }
  | { nativeRef: string }
  | ActionRecord
  | ExecutionEnvelope
  | Denial
  | ResourceLease[]
  | ControlReceipt
  | Mandate
  | Workspace
  | ControlLease
  | CapabilityFence
const deny = (code: string, ...basis: string[]): Denial => ({ kind: 'denial', code, basis })
const record = (o: ManagedObject): ActionRecord => ({
  ref: { id: o.id, revision: o.revision },
  spec: o.data.execution_spec as unknown as ActionSpec,
  state: String(o.data.state),
  ...(o.data.receipt ? { receipt: o.data.receipt as unknown as ActionReceipt } : {})
})
const currentRef = (l: ReadLedger, r: Ref) =>
  l.get(r.id)?.revision === r.revision && l.applicability(r.id) === 'usable'
function check(
  l: ReadLedger,
  state: State,
  o: ManagedObject,
  now: number,
  sent = false
): ExecutionEnvelope | Denial {
  const a = record(o),
    s = a.spec
  if (!s || !(sent ? ['sent'] : ['planned', 'authorized']).includes(a.state))
    return deny('ACTION_NOT_SENDABLE', a.state)
  if (!currentRef(l, s.target) || !s.scopeRefs.every((r) => currentRef(l, r)))
    return deny('STALE_SCOPE', s.target.id)
  const target = l.get(s.target.id)!
  if (target.kind === 'worker') {
    try { managedLaunchScope(l, s.target, s.scopeRefs) } catch { return deny('MANAGED_LAUNCH_SCOPE_REQUIRED', s.target.id) }
  }

  if (
    (target.data.control_state && target.data.control_state !== 'autonomous') ||
    ['released', 'withdrawn', 'broken', 'fulfilled'].includes(String(target.data.state))
  )
    return deny('TARGET_NOT_AUTONOMOUS', s.target.id)
  const c = state.controls.find((c) => c.target.id === s.target.id)
  if (
    !c ||
    c.revoked ||
    c.epoch !== s.epoch ||
    c.target.revision !== s.target.revision ||
    c.holder !== s.subject ||
    c.expiresAt <= now
  )
    return deny('CONTROL_FENCE', s.target.id)
  const m = state.mandates.find((m) => m.id === s.mandateRef.id)
  if (
    !m ||
    m.revoked ||
    m.revision !== s.mandateRef.revision ||
    m.expiresAt <= now ||
    m.subject !== s.subject ||
    m.requester !== s.requester ||
    m.target.id !== s.target.id ||
    m.target.revision !== s.target.revision ||
    !m.actions.includes(s.kind) ||
    m.workspaceId !== s.workspaceId ||
    !s.resourceIds.every((r) => m.resourceIds.includes(r)) ||
    !m.scopeRefs.every((r) => s.scopeRefs.some((s) => s.id === r.id && s.revision === r.revision)) ||
    !m.scopeRefs.every((r) => currentRef(l, r))
  )
    return deny('MANDATE_SCOPE', s.mandateRef.id)
  if (s.kind === 'deliver') {
    const required = verificationScopes(l, target.id)
    if (!required.length || required.some(r => !s.scopeRefs.some(s => s.id === r.id && s.revision === r.revision)))
      return deny('VERIFICATION_SCOPE_REQUIRED', target.id)
    const binding = l.snapshot().find(o => o.kind === 'verification_binding' && o.data.commitment_id === target.id)
    const evaluation = binding?.data.evaluation_ref as unknown as Ref | undefined
    const e = evaluation && l.get(evaluation.id)
    if (!e || e.data.verdict !== 'pass' || l.applicability(e.id) !== 'usable' ||
      JSON.stringify(e.data.contract_ref) !== JSON.stringify(target.data.acceptance_contract))
      return deny('VERIFICATION_NOT_PASS', target.id)
    if (l.snapshot().some(o => o.kind === 'review_issue' && JSON.stringify(o.data.contract_ref) === JSON.stringify(e.data.contract_ref) && !['resolved', 'dismissed'].includes(String(o.data.state))))
      return deny('REVIEW_ISSUE_OPEN', target.id)
  }
  const capability = state.capabilities.find((c) => c.id === s.capabilityRef.id)
  if (
    !capability ||
    capability.revoked ||
    capability.revision !== s.capabilityRef.revision ||
    capability.expiresAt <= now ||
    capability.externalTools !== 'blocked' ||
    JSON.stringify(capability.launch) !==
      JSON.stringify({ executable: s.executable, args: s.args, processPolicy: s.processPolicy }) ||
    !capability.evidenceRefs.length ||
    !capability.scopeRefs.every(
      (r) => s.scopeRefs.some((x) => x.id === r.id && x.revision === r.revision) && currentRef(l, r)
    )
  )
    return deny('CAPABILITY_FENCE', s.capabilityRef.id)
  const w = state.workspaces.find((w) => w.id === s.workspaceId)
  if (!w || w.role !== s.purpose || !w.resources.every((r) => s.resourceIds.includes(r)))
    return deny('WORKSPACE_SCOPE', s.workspaceId)
  try {
    const recovery=capability.deliveryRecovery&&l.get(capability.deliveryRecovery.id),p=recovery?.data.payload as any
    const predecessor=p?.before?.action?.id&&l.get(p.before.action.id),oldCap=predecessor&&(predecessor.data.execution_spec as any)?.capabilityRef
    const recoveryCurrent=!!recovery&&recovery.revision===capability.deliveryRecovery?.revision&&recovery.kind==='coordination_runtime_event'&&recovery.data.event==='local_delivery_reauthorization'&&predecessor?.data.state==='failed'&&(predecessor.data.receipt as any)?.stopped===true&&(predecessor.data.receipt as any)?.reason==='DELIVERY_PUBLISHED_ALIGNMENT_PENDING'&&state.capabilities.some(c=>c.id===oldCap?.id&&c.revoked)&&JSON.stringify(p.after?.action)===JSON.stringify((({kind,executable,args,payloadDigest,expectedDevTransition,...action})=>action)(s))&&JSON.stringify(p.after&&deliveryRecoverySpec(p.after))===JSON.stringify(s)
    const transition = (sent || recoveryCurrent) && s.kind === 'deliver' && s.executable === '/dsh-host/local-git-delivery@1' &&
      s.expectedDevTransition && JSON.stringify(s.expectedDevTransition) === JSON.stringify(capability.expectedDevTransition)
      ? s.expectedDevTransition : undefined
    if (transition && transition.before !== w.baseline) return deny('DELIVERY_TRANSITION_BASELINE', w.id)
    verifyWorkspace(w, transition)
    if (capability.nativeRuntime) {
      const r = capability.nativeRuntime
      if (
        realpathSync(r.root) !== r.root ||
        !relative(w.root, r.root).startsWith('..') ||
        !relative(r.root, w.root).startsWith('..')
      )
        return deny('NATIVE_RUNTIME_IDENTITY', r.root)
    }
  } catch {
    return deny('WORKSPACE_IDENTITY_CHANGED', w.id)
  }
  return {
    kind: 'envelope',
    actionRef: a.ref,
    target: s.target,
    epoch: c.epoch,
    expiresAt: Math.min(c.expiresAt, m.expiresAt, capability.expiresAt),
    workspace: w,
    spec: s,
    ...(capability.nativeRuntime ? { nativeRuntime: capability.nativeRuntime } : {})
  }
}
/** Typed commands only: no SQL or model-controlled privileged flags. Shared canonical DB transaction. */
export function controlledTransaction(
  db: DatabaseSync,
  l: ReadLedger,
  cmd: ControlledCommand
): ControlledResult {
  if (
    ['host', 'borrow', 'frame', 'process_open', 'helper'].includes(cmd.kind) &&
    !hostTokens.has((cmd as { token: object }).token)
  )
    throw new Error('HOST_ADMISSION_REQUIRED')
  db.exec(
    'CREATE TABLE IF NOT EXISTS sa_managed_control (singleton INTEGER PRIMARY KEY CHECK(singleton=1), body_json TEXT NOT NULL CHECK(json_valid(body_json)))'
  )
  db.exec('BEGIN IMMEDIATE')
  try {
    const raw = db.prepare('SELECT body_json FROM sa_managed_control WHERE singleton=1').get()
    const state: State = raw
      ? JSON.parse(String(raw.body_json))
      : { capabilities: [], mandates: [], controls: [], resources: [], workspaces: [] }
    const now = Date.now()
    let persistControl = true
    let result: ControlledResult
    let changed: ManagedObject | undefined
    if (cmd.kind === 'host') {
      assertRefs([cmd.source])
      const h = cmd.command
      if (h.kind === 'retire_partial_delivery') {
        const o=l.get(h.actionRef.id),a=o&&record(o),s=a?.spec
        const c=s&&state.controls.find(c=>c.target.id===s.target.id),cap=s&&state.capabilities.find(c=>c.id===s.capabilityRef.id),m=s&&state.mandates.find(m=>m.id===s.mandateRef.id)
        if(!o||o.revision!==h.actionRef.revision||a?.state!=='sent'||s?.kind!=='deliver'||s.executable!=='/dsh-host/local-git-delivery@1'||!s.expectedDevTransition||createHash('sha256').update(JSON.stringify(s)).digest('hex')!==h.specDigest||! /^[a-f0-9]{64}$/.test(h.journalDigest)||state.opened?.includes(o.id)||!c||c.epoch!==s.epoch||c.target.revision!==s.target.revision||c.holder!==s.subject||c.revoked||!cap||cap.revision!==s.capabilityRef.revision||cap.revoked||!m||m.revision!==s.mandateRef.revision||m.revoked)throw Error('DELIVERY_PREDECESSOR_CHANGED')
        cap.revoked=true;cap.revision++;m.revoked=true;m.revision++;c.revoked=true
        for(const lease of state.resources)if(lease.actionRef.id===o.id&&lease.status==='held')lease.status='released'
        o.data.state='failed';o.data.receipt={status:'failed',stopped:true,reason:'DELIVERY_PUBLISHED_ALIGNMENT_PENDING',evidenceRefs:['delivery-journal:'+h.journalDigest]};o.revision++;changed=o;result=record(o)
      } else if (h.kind === 'native_domain_absence') {
        const object = l.get(h.actionRef.id)
        if (!object || object.kind !== 'action' || object.revision !== h.actionRef.revision) throw Error('NATIVE_DOMAIN_STALE_ACTION')
        const action = record(object), capability = state.capabilities.find(c => c.id === action.spec.capabilityRef.id && c.revision === action.spec.capabilityRef.revision), workspace = state.workspaces.find(w => w.id === action.spec.workspaceId)
        if (!['sent','unknown'].includes(action.state) || action.spec.kind !== 'dispatch' || !capability?.nativeRuntime || !workspace || capability.externalTools !== 'blocked' || !state.opened?.includes(action.ref.id)) throw Error('NATIVE_DOMAIN_OWNED_LAUNCH_REQUIRED')
        if (JSON.stringify(capability.launch) !== JSON.stringify({executable:action.spec.executable,args:action.spec.args,processPolicy:action.spec.processPolicy})) throw Error('NATIVE_DOMAIN_LAUNCH_MISMATCH')
        const observation = {kind:'domain_absence',launchRef:h.actionRef,executionDigest:createHash('sha256').update(JSON.stringify(action.spec)).digest('hex'),...inspectNativeDomainAbsence(action.spec,capability.nativeRuntime,workspace.root)}
        // Retire only this absent execution's authority and leases, never its business outcome.
        capability.revoked = true
        const control = state.controls.find(c => c.target.id === action.spec.target.id && c.epoch === action.spec.epoch)
        if (control) { control.revoked = true; control.expiresAt = now }
        const releasedResources = state.resources.filter(r => r.actionRef.id === action.ref.id && r.status === 'held')
        for (const lease of releasedResources) lease.status = 'released'
        cmd = {...cmd,command:{kind:'native',actionRef:h.actionRef,stream:'execution:'+h.actionRef.id,observation:{...observation,releasedResources:releasedResources.map(r=>r.resourceId),retiredCapability:{id:capability.id,revision:capability.revision}} as unknown as Json}}
        result = {nativeRef:'native-event:'+String(Number(db.prepare('SELECT sequence FROM sa_managed_meta WHERE singleton=1').get()!.sequence)+1)}
      } else if (h.kind === 'request_claim') {
        const owner = l.get(h.ownerRef.id)
        if (
          !owner ||
          owner.kind !== 'action' ||
          owner.revision !== h.ownerRef.revision ||
          record(owner).spec.kind !== 'dispatch' ||
          !h.key.trim() ||
          h.key.length > 2048 ||
          check(l, state, owner, now, true).kind !== 'envelope'
        )
          throw new Error('SESSION_OWNER_FENCED')
        const duplicate = state.nativeClaims?.some(
          (claim) =>
            claim.ownerRef.id === h.ownerRef.id &&
            claim.ownerRef.revision === h.ownerRef.revision &&
            claim.key === h.key
        )
        if (!duplicate) (state.nativeClaims ??= []).push({ ownerRef: h.ownerRef, key: h.key })
        result = { claimed: !duplicate }
      } else if (h.kind === 'native') {
        assertRefs([h.actionRef])
        assertJson(h.observation)
        const owner = l.get(h.actionRef.id)
        if (
          !owner ||
          owner.kind !== 'action' ||
          (record(owner).spec?.kind !== 'dispatch' && !state.opened?.includes(owner.id)) ||
          !['sent', 'unknown', 'confirmed', 'failed'].includes(record(owner).state) ||
          !h.stream.trim()
        )
          throw new Error('NATIVE_OBSERVATION_OWNER_REQUIRED')
        // Only the original observation branch is read-only; domain absence rewrites cmd after mutations.
        persistControl = false
        result = {
          nativeRef:
            'native-event:' +
            String(
              Number(db.prepare('SELECT sequence FROM sa_managed_meta WHERE singleton=1').get()!.sequence) + 1
            )
        }
      } else if (h.kind === 'capability') {
        const c = structuredClone(h.capability)
        assertJson(c)
        assertRefs(c.scopeRefs)
        if (
          !c.id.trim() ||
          c.revision !== 1 ||
          c.revoked ||
          c.expiresAt <= now ||
          c.externalTools !== 'blocked' ||
          !c.launch ||
          typeof c.launch.executable !== 'string' ||
          !Array.isArray(c.launch.args) ||
          !['single', 'children'].includes(c.launch.processPolicy) ||
          !c.evidenceRefs.length ||
          c.evidenceRefs.some((x) => typeof x !== 'string' || !x.trim()) ||
          state.capabilities.some((x) => x.id === c.id)
        )
          throw new Error('INVALID_CAPABILITY')
        if (c.expectedDevTransition) {
          const t = c.expectedDevTransition
          assertRefs([t.stepRef])
          if (c.launch.executable !== '/dsh-host/local-git-delivery@1' || c.launch.args.length ||
            !/^[a-f0-9]{40}$/.test(t.before) || !/^[a-f0-9]{40}$/.test(t.after) || t.before === t.after ||
            realpathSync(t.realGitDir) !== t.realGitDir) throw new Error('INVALID_DELIVERY_TRANSITION')
        }
        if (c.nativeRuntime) {
          const r = c.nativeRuntime
          if (r.maxProcessMs !== undefined && (!Number.isSafeInteger(r.maxProcessMs) || r.maxProcessMs < 1 || r.maxProcessMs > 900000)) throw new Error('INVALID_NATIVE_RUNTIME_DURATION')
          if (r.loopbackServer !== undefined && typeof r.loopbackServer !== 'boolean')
            throw new Error('INVALID_NATIVE_RUNTIME')
          if (
            r.readonlyRuntimeRoots &&
            (!Array.isArray(r.readonlyRuntimeRoots) ||
              r.readonlyRuntimeRoots.length > 8 ||
              r.readonlyRuntimeRoots.some((p) => p === '/' || !isAbsolute(p) || realpathSync(p) !== p))
          )
            throw new Error('INVALID_NATIVE_RUNTIME')
          if (
            !isAbsolute(r.root) ||
            realpathSync(r.root) !== r.root ||
            !/^([A-Z][A-Z0-9_]*_HOME|NATIVE_STATE)$/.test(r.stateDirectoryVariable) ||
            r.network !== 'engine-transport' ||
            !Array.isArray(r.evidenceRefs) ||
            !r.evidenceRefs.length ||
            r.evidenceRefs.some((x) => typeof x !== 'string' || !x.trim())
          )
            throw new Error('INVALID_NATIVE_RUNTIME')
        }
        state.capabilities.push(c)
        result = c
      } else if (h.kind === 'revoke_capability') {
        const c = state.capabilities.find((c) => c.id === h.id)
        if (!c) throw new Error('CAPABILITY_MISSING')
        c.revoked = true
        c.revision++
        result = c
      } else if (h.kind === 'workspace') {
        verifyWorkspace(h.workspace)
        if (state.workspaces.some((w) => w.id === h.workspace.id || w.root === h.workspace.root))
          throw new Error('WORKSPACE_EXISTS')
        state.workspaces.push(structuredClone(h.workspace))
        result = h.workspace
      } else if (h.kind === 'mandate') {
        const m: Mandate = { ...structuredClone(h.mandate), source: cmd.source }
        assertJson(m)
        assertRefs([m.target, ...m.scopeRefs])
        if (
          !m.id?.trim() ||
          !m.subject?.trim() ||
          !m.requester?.trim() ||
          m.revision !== 1 ||
          m.revoked !== false ||
          m.expiresAt <= now ||
          !m.actions.length ||
          !state.workspaces.some((w) => w.id === m.workspaceId) ||
          state.mandates.some((x) => x.id === m.id)
        )
          throw new Error('INVALID_MANDATE')
        state.mandates.push(m)
        result = m
      } else if (h.kind === 'revoke_mandate') {
        const m = state.mandates.find((m) => m.id === h.id)
        if (!m) throw new Error('MANDATE_MISSING')
        m.revoked = true
        m.revision++
        result = m
      } else {
        assertRefs([h.target])
        if (h.kind === 'control' && !currentRef(l, h.target)) throw new Error('STALE_TARGET')
        if (
          h.kind === 'revoke' &&
          !state.controls.some((c) => c.target.id === h.target.id && c.target.revision === h.target.revision)
        )
          throw new Error('CONTROL_TARGET_MISMATCH')
        const old = state.controls.find((c) => c.target.id === h.target.id),
          epoch = (old?.epoch ?? 0) + 1
        const c: ControlLease = {
          target: h.target,
          epoch,
          holder: h.kind === 'control' ? h.holder : (old?.holder ?? ''),
          expiresAt: h.kind === 'control' ? h.expiresAt : now,
          revoked: h.kind === 'revoke'
        }
        if (h.kind === 'control' && (!c.holder.trim() || c.expiresAt <= now))
          throw new Error('INVALID_CONTROL')
        state.controls = state.controls.filter((x) => x.target.id !== c.target.id)
        state.controls.push(c)
        result =
          h.kind === 'revoke'
            ? {
                target: h.target,
                source: cmd.source,
                epoch,
                expiresAt: now,
                status: 'unknown',
                evidenceRefs: []
              }
            : c
      }
    } else if (cmd.kind === 'plan') {
      const s = structuredClone(cmd.spec)
      assertJson(s)
      assertRefs([s.target, s.mandateRef, s.capabilityRef, ...s.scopeRefs])
      if (
        !s.id?.trim() ||
        !s.idempotencyKey?.trim() ||
        !s.requester?.trim() ||
        !s.subject?.trim() ||
        !Number.isSafeInteger(s.epoch) ||
        s.epoch < 1 ||
        !Number.isSafeInteger(s.timeoutMs) ||
        s.timeoutMs < 1 ||
        s.timeoutMs > (s.kind === 'dispatch' ? state.capabilities.find(c => c.id === s.capabilityRef.id)?.nativeRuntime?.maxProcessMs ?? 60000 : 60000) ||
        !Array.isArray(s.args) ||
        s.args.some((x) => typeof x !== 'string') ||
        !['single', 'children'].includes(s.processPolicy) ||
        !s.executable?.startsWith('/') ||
        !Array.isArray(s.resourceIds) ||
        !s.resourceIds.length ||
        s.resourceIds.some((x) => typeof x !== 'string' || !x.trim())
      )
        throw new Error('INVALID_ACTION_SPEC')
      if (!currentRef(l, s.target) || !s.scopeRefs.every((r) => currentRef(l, r)))
        throw new Error('STALE_SCOPE')
      const existing = db
        .prepare("SELECT body_json FROM sa_managed_object WHERE kind='action'")
        .all()
        .map((r) => JSON.parse(String(r.body_json)) as ManagedObject)
        .find((o) => (o.data.execution_spec as unknown as ActionSpec)?.idempotencyKey === s.idempotencyKey)
      if (existing) {
        if (JSON.stringify(record(existing).spec) !== JSON.stringify(s))
          throw new Error('IDEMPOTENCY_CONFLICT')
        db.exec('COMMIT')
        return record(existing)
      }
      if (l.get(s.id)) throw new Error('OBJECT_EXISTS')
      changed = {
        id: s.id,
        kind: 'action',
        revision: 1,
        data: {
          state: 'planned',
          action_kind: s.kind,
          target_ref: s.target.id,
          expected_revision: s.target.revision,
          expected_epoch: s.epoch,
          mandate_ref: s.mandateRef.id,
          payload_ref: s.idempotencyKey,
          execution_spec: s as unknown as Json
        },
        scope_revision_refs: [s.target, ...s.scopeRefs.filter((r) => r.id !== s.target.id)],
        extensions: {}
      }
      result = record(changed)
    } else {
      const o = l.get(cmd.ref.id)
      if (!o || o.kind !== 'action' || o.revision !== cmd.ref.revision || !o.data.execution_spec) {
        db.exec('ROLLBACK')
        return deny('STALE_ACTION', cmd.ref.id)
      }
      const a = record(o)
      if (cmd.kind === 'result') {
        const r = cmd.receipt
        assertJson(r)
        if (
          r.cessation &&
          (!['stopped', 'isolated', 'unconfirmed'].includes(r.cessation.kind) ||
            !Array.isArray(r.cessation.evidenceRefs) ||
            (r.stopped && r.cessation.kind !== 'stopped'))
        )
          throw new Error('INVALID_RECEIPT')
        if (cmd.token) {
          if (!cmd.source) throw new Error('RECEIPT_SOURCE_REQUIRED')
          assertRefs([cmd.source])
        }
        if ((r.status !== 'unknown' || r.stopped) && (!cmd.token || !hostTokens.has(cmd.token)))
          throw new Error('TRUSTED_RECEIPT_REQUIRED')
        if (!['sent', 'unknown'].includes(a.state)) throw new Error('INVALID_RECEIPT')
        if (r.operation) {
          const b = state.borrowed?.find((b) => b.actionId === o.id),
            frame = state.frames?.find((f) => f.actionId === o.id),
            proof = r.operation
          if (
            !b ||
            !frame ||
            a.spec.kind === 'dispatch' ||
            r.stopped ||
            proof.ownerRef.id !== b.ownerRef.id ||
            proof.ownerRef.revision !== b.ownerRef.revision ||
            proof.payloadDigest !== a.spec.payloadDigest ||
            proof.payloadDigest !== frame.digest ||
            proof.nativeRequestId !== a.spec.nativeRequestId ||
            !/^[a-f0-9]{64}$/.test(proof.responseDigest)
          )
            throw new Error('OPERATION_PROOF_MISMATCH')
        }
        if (
          !['sent', 'unknown'].includes(a.state) ||
          !['confirmed', 'failed', 'unknown'].includes(r.status) ||
          !Array.isArray(r.evidenceRefs) ||
          r.evidenceRefs.some((x) => typeof x !== 'string' || !x.trim()) ||
          typeof r.stopped !== 'boolean' ||
          (r.status !== 'unknown' && ((!r.stopped && !r.operation) || !r.evidenceRefs.length))
        )
          throw new Error('INVALID_RECEIPT')
        o.data.state = r.status
        o.data.receipt = structuredClone(r) as unknown as Json
        o.revision++
        changed = o
        if (r.status !== 'unknown' && r.stopped) {
          for (const lease of state.resources) if (lease.actionRef.id === o.id) lease.status = 'released'
          state.helperDomains = state.helperDomains?.filter((lease) => lease.actionId !== o.id)
        }
        result = record(o)
      } else {
        const envelope = check(
          l,
          state,
          o,
          now,
          cmd.kind === 'fence' || cmd.kind === 'frame' || cmd.kind === 'process_open'
        )
        if (envelope.kind === 'denial') {
          db.exec('ROLLBACK')
          return envelope
        }
        const borrowed = state.borrowed?.find((b) => b.actionId === o.id)
        const ownerValid = (ownerRef: Ref): boolean => {
          const owner = l.get(ownerRef.id)
          if (
            !owner ||
            owner.id === o.id ||
            owner.revision !== ownerRef.revision ||
            owner.data.state !== 'sent'
          )
            return false
          const ownerSpec = record(owner).spec
          return (
            ownerSpec.kind === 'dispatch' &&
            ownerSpec.subject === a.spec.subject &&
            ownerSpec.requester === a.spec.requester &&
            ownerSpec.workspaceId === a.spec.workspaceId &&
            ownerSpec.epoch === a.spec.epoch &&
            ownerSpec.target.id === a.spec.target.id &&
            ownerSpec.target.revision === a.spec.target.revision &&
            check(l, state, owner, now, true).kind === 'envelope' &&
            a.spec.resourceIds.every((id) =>
              state.resources.some(
                (r) =>
                  r.resourceId === id &&
                  r.actionRef.id === owner.id &&
                  r.status === 'held' &&
                  r.epoch === a.spec.epoch
              )
            )
          )
        }
        if (borrowed && !ownerValid(borrowed.ownerRef)) {
          db.exec('ROLLBACK')
          return deny('SESSION_OWNER_FENCED', borrowed.ownerRef.id)
        }
        if (
          cmd.kind === 'helper' &&
          (!borrowed || envelope.nativeRuntime || !['inspect', 'respond_request'].includes(a.spec.kind))
        )
          throw new Error('INVALID_SESSION_HELPER')
        if (cmd.kind === 'helper') {
          // A borrowed owner lease does not serialize helpers. Reserve this sublease in the
          // same transaction as sent, before spawning, across all kernel handles.
          if (state.helperDomains?.some((lease) => lease.workspaceId === a.spec.workspaceId)) {
            db.exec('ROLLBACK')
            return deny('HELPER_DOMAIN_BUSY', a.spec.workspaceId)
          }
          ;(state.helperDomains ??= []).push({ workspaceId: a.spec.workspaceId, actionId: o.id })
          ;(state.opened ??= []).push(o.id)
        }
        if (cmd.kind === 'run' && envelope.nativeRuntime) throw new Error('NATIVE_PROCESS_REQUIRES_HOST')
        if (cmd.kind === 'run' && borrowed) throw new Error('SESSION_OPERATION_REQUIRES_HOST')
        if (cmd.kind === 'process_open') {
          if (a.spec.kind !== 'dispatch') throw new Error('LAUNCH_ACTION_REQUIRED')
          if (state.opened?.includes(o.id)) throw new Error('PROCESS_ALREADY_OPEN')
          ;(state.opened ??= []).push(o.id)
          result = envelope
        } else if (cmd.kind === 'borrow') {
          if (a.spec.kind === 'dispatch' || borrowed || !ownerValid(cmd.ownerRef))
            throw new Error('SESSION_OWNER_FENCED')
          ;(state.borrowed ??= []).push({ actionId: o.id, ownerRef: cmd.ownerRef })
          result = envelope
        } else if (cmd.kind === 'frame') {
          if (
            !borrowed ||
            borrowed.ownerRef.id !== cmd.ownerRef.id ||
            borrowed.ownerRef.revision !== cmd.ownerRef.revision ||
            !ownerValid(cmd.ownerRef)
          )
            throw new Error('SESSION_OWNER_FENCED')
          if (state.frames?.some((f) => f.actionId === o.id)) throw new Error('FRAME_ALREADY_SENT')
          if (a.spec.payloadDigest !== cmd.digest) throw new Error('FRAME_PAYLOAD_MISMATCH')
          ;(state.frames ??= []).push({ actionId: o.id, digest: cmd.digest })
          result = envelope
        } else if (cmd.kind === 'fence') {
          db.exec('ROLLBACK')
          return envelope
        } else if (cmd.kind === 'claim') {
          if (
            cmd.resourceIds.length !== a.spec.resourceIds.length ||
            !cmd.resourceIds.every((r) => a.spec.resourceIds.includes(r))
          )
            throw new Error('RESOURCE_SCOPE')
          for (const id of cmd.resourceIds)
            if (
              state.resources.some(
                (r) => r.resourceId === id && r.status === 'held' && r.actionRef.id !== o.id
              )
            )
              throw new Error('RESOURCE_BUSY')
          result = cmd.resourceIds.map((resourceId) => {
            let lease = state.resources.find(
              (r) => r.resourceId === resourceId && r.status === 'held' && r.actionRef.id === o.id
            )
            if (!lease) {
              lease = {
                resourceId,
                target: a.spec.target,
                actionRef: a.ref,
                epoch: a.spec.epoch,
                expiresAt: envelope.expiresAt,
                status: 'held'
              }
              state.resources.push(lease)
            }
            return lease
          })
        } else {
          if (
            ['send', 'run', 'helper'].includes(cmd.kind) &&
            !borrowed &&
            !a.spec.resourceIds.every((id) =>
              state.resources.some(
                (r) =>
                  r.resourceId === id &&
                  r.actionRef.id === o.id &&
                  r.status === 'held' &&
                  r.epoch === a.spec.epoch
              )
            )
          ) {
            db.exec('ROLLBACK')
            return deny('RESOURCE_LEASE_REQUIRED', o.id)
          }
          o.data.state = ['send', 'run', 'helper'].includes(cmd.kind) ? 'sent' : 'authorized'
          o.revision++
          changed = o
          result = { ...envelope, actionRef: { id: o.id, revision: o.revision } }
        }
      }
    }
    if (changed) {
      l.validate(changed)
      if (changed.revision === 1)
        db.prepare('INSERT INTO sa_managed_object VALUES(?,?,?,?,0)').run(
          changed.id,
          changed.kind,
          1,
          JSON.stringify(changed)
        )
      else
        db.prepare('UPDATE sa_managed_object SET revision=?,body_json=? WHERE id=?').run(
          changed.revision,
          JSON.stringify(changed),
          changed.id
        )
    }
    if (persistControl) db.prepare(
      'INSERT INTO sa_managed_control VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET body_json=excluded.body_json'
    ).run(JSON.stringify(state))
    const seq =
      Number(db.prepare('SELECT sequence FROM sa_managed_meta WHERE singleton=1').get()!.sequence) + 1
    db.prepare('UPDATE sa_managed_meta SET sequence=? WHERE singleton=1').run(seq)
    const event =
      cmd.kind === 'host'
        ? { kind: 'host', source: cmd.source, command: cmd.command }
        : cmd.kind === 'result'
          ? {
              kind: cmd.kind,
              ref: cmd.ref,
              receipt: cmd.receipt,
              ...(cmd.source ? { source: cmd.source } : {})
            }
          : cmd
    db.prepare('INSERT INTO sa_managed_event VALUES(?,?)').run(
      seq,
      JSON.stringify({
        protocol_version: 2,
        controlled: event,
        ...(changed ? { refs: [{ id: changed.id, revision: changed.revision }] } : {})
      })
    )
    db.exec('COMMIT')
    return structuredClone(result)
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
/** Only host composition receives host. Register only actions on the model tool surface. */
export function createControlledKernel(ledger: ManagedLedger, trustedSource: Ref) {
  assertRefs([trustedSource])
  const source = structuredClone(trustedSource),
    token = {}
  hostTokens.add(token)
  const hostCommand = (command: HostCommand) => ledger.controlled({ kind: 'host', token, source, command })
  const active = new Map<string, AbortController>()
  function reconcileExecution(e: ExecutionEnvelope, receipt: ActionReceipt): ProcessActionResult {
    // Persist the observed exit independently of revision races or a prior trusted result.
    const executionDigest = createHash('sha256').update(JSON.stringify(e.spec)).digest('hex')
    const observed = hostCommand({
      kind: 'native',
      actionRef: e.actionRef,
      stream: 'execution:' + e.actionRef.id,
      observation: {
        kind: 'process_exit',
        launchRef: e.actionRef as unknown as Json,
        executionDigest,
        receipt: receipt as unknown as Json
      }
    }) as { nativeRef: string }
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = ledger.get(e.actionRef.id)
      if (
        !current ||
        current.kind !== 'action' ||
        current.revision < e.actionRef.revision ||
        createHash('sha256')
          .update(JSON.stringify(record(current).spec))
          .digest('hex') !== executionDigest
      )
        throw new Error('PROCESS_EXECUTION_IDENTITY_CHANGED')
      if (['confirmed', 'failed'].includes(String(current.data.state)))
        return {
          ...record(current),
          processObservationRef: observed.nativeRef,
          reconciliation: 'historical'
        }
      if (!['sent', 'unknown'].includes(String(current.data.state)))
        throw new Error('PROCESS_RECONCILE_STATE')
      const result = ledger.controlled({
        kind: 'result',
        ref: { id: current.id, revision: current.revision },
        receipt,
        token,
        source
      })
      if ('kind' in result && result.kind === 'denial') continue
      if (!('spec' in result) || !('state' in result) || !('ref' in result))
        throw new Error('PROCESS_RECONCILE_RESULT')
      return { ...result, processObservationRef: observed.nativeRef, reconciliation: 'updated' }
    }
    throw new Error('PROCESS_RECONCILE_CONFLICT')
  }
  const actions = {
    planAction: (spec: ActionSpec) => ledger.controlled({ kind: 'plan', spec }) as ActionRecord,
    authorizeAction: (ref: Ref) =>
      ledger.controlled({ kind: 'authorize', ref }) as ExecutionEnvelope | Denial,
    claimResources: (ref: Ref, resourceIds: string[]) =>
      ledger.controlled({ kind: 'claim', ref, resourceIds }) as ResourceLease[],
    recordActionResult: (ref: Ref, receipt: ActionReceipt) =>
      ledger.controlled({ kind: 'result', ref, receipt }) as ActionRecord,
    async execute(ref: Ref): Promise<ActionRecord | Denial> {
      const envelope = ledger.controlled({ kind: 'run', ref }) as ExecutionEnvelope | Denial
      if (envelope.kind === 'denial') return envelope
      const abort = new AbortController()
      active.set(ref.id, abort)
      let result: SandboxResult
      try {
        result = await runSandbox(envelope, abort.signal, () => {
          const probe = ledger.controlled({ kind: 'fence', ref: envelope.actionRef }) as
            ExecutionEnvelope | Denial
          return probe.kind === 'envelope'
        })
      } finally {
        active.delete(ref.id)
      }
      result.receipt.observation = { stdout: result.stdout, stderr: result.stderr, observedAt: Date.now() }
      return ledger.controlled({
        kind: 'result',
        ref: envelope.actionRef,
        receipt: result.receipt,
        token,
        source
      }) as ActionRecord
    }
  }
  return {
    actions,
    host: {
      retirePartialDelivery: (actionRef: Ref, specDigest: string, journalDigest: string) => hostCommand({kind:'retire_partial_delivery',actionRef,specDigest,journalDigest}) as ActionRecord,
      claimNativeRequest: (ownerRef: Ref, key: string) =>
        (hostCommand({ kind: 'request_claim', ownerRef, key }) as { claimed: boolean }).claimed,
      async executeSessionHelper(ref: Ref): Promise<ActionRecord | Denial> {
        const e = ledger.controlled({ kind: 'helper', ref, token }) as ExecutionEnvelope | Denial
        if (e.kind === 'denial') return e
        const abort = new AbortController()
        active.set(ref.id, abort)
        try {
          const result = await runSandbox(e, abort.signal, () => {
            const p = ledger.controlled({ kind: 'fence', ref: e.actionRef }) as ExecutionEnvelope | Denial
            return p.kind === 'envelope'
          })
          result.receipt.observation = {
            stdout: result.stdout,
            stderr: result.stderr,
            observedAt: Date.now()
          }
          return reconcileExecution(e, result.receipt)
        } finally {
          active.delete(ref.id)
        }
      },
      reconcileSingleProcessAbsence(ref: Ref): ProcessActionResult | ActionRecord {
        const current = ledger.get(ref.id)
        if (!current || current.revision !== ref.revision || current.kind !== 'action') throw Error('PROCESS_ABSENCE_ACTION_CHANGED')
        const action = record(current)
        if (action.spec.kind !== 'dispatch' || action.spec.processPolicy !== 'single') throw Error('PROCESS_ABSENCE_SINGLE_REQUIRED')
        if (action.receipt?.stopped === true && ['confirmed','failed'].includes(action.state)) return action
        if (action.state !== 'unknown' || action.receipt?.stopped !== false) throw Error('PROCESS_ABSENCE_UNKNOWN_REQUIRED')
        const executionDigest = createHash('sha256').update(JSON.stringify(action.spec)).digest('hex')
        const proof = ledger.eventEntries({ nativeStream: 'execution:' + ref.id, nativeKind: 'process_exit' }).map(({sequence,body}: any) => ({ sequence, command: body.controlled?.kind === 'host' ? body.controlled.command : undefined })).findLast(({command}: any) => command?.kind === 'native' && command.actionRef?.id === ref.id && command.observation?.kind === 'process_exit' && command.observation.executionDigest === executionDigest && JSON.stringify(command.observation.receipt) === JSON.stringify(action.receipt))
        const launchRef = proof?.command.observation.launchRef as Ref | undefined
        const ids = action.receipt.evidenceRefs.map(value => /^process:([1-9][0-9]*):[^:]+$/.exec(value)).filter(Boolean)
        if (!proof || !launchRef || JSON.stringify(launchRef) !== JSON.stringify(proof.command.actionRef) || ids.length !== 1) throw Error('PROCESS_ABSENCE_OWNED_PID_REQUIRED')
        const pid = Number(ids[0]![1]); if (!Number.isSafeInteger(pid)) throw Error('PROCESS_ABSENCE_OWNED_PID_REQUIRED')
        try { process.kill(pid, 0); throw Error('PROCESS_STILL_PRESENT') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
        const observedAt = Date.now(), observation = hostCommand({ kind: 'native', actionRef: launchRef, stream: 'execution:' + ref.id, observation: { kind: 'process_absence', launchRef: launchRef as unknown as Json, executionDigest, pid, observedAt, basis: 'ESRCH for the previously owned single-process PID; no signal sent', priorObservationRef: 'native-event:' + proof.sequence } }) as { nativeRef: string }
        return reconcileExecution({ actionRef: launchRef, spec: action.spec } as ExecutionEnvelope, { status: 'failed', stopped: true, reason: 'OWNED_SINGLE_PROCESS_ABSENT', evidenceRefs: ['native-event:' + proof.sequence, observation.nativeRef], observation: { stdout: '', stderr: '', observedAt } })
      },
      observeNative: (actionRef: Ref, stream: string, observation: Json) =>
        hostCommand({ kind: 'native', actionRef, stream, observation }) as { nativeRef: string },
      nativeRecoveryFacts: (stream: string): { ref: string; observation: Json }[] => ledger.eventEntries({ nativeStream: stream, nativeKinds: ['request', 'input-intent', 'input-rejected'], nativeRpcMethod: 'turn/started' }).map(({ sequence, body }: any) => ({ ref: 'native-event:' + sequence, observation: body.controlled.command.observation })),
      observeNativeDomainAbsence: (actionRef: Ref) => hostCommand({kind:'native_domain_absence',actionRef}) as {nativeRef:string},
      nativeFactRefs: (stream: string, nativeKind?: string): string[] => ledger.eventRefs({ nativeStream: stream, ...(nativeKind ? { nativeKind } : {}) }),
      nativeFacts: (stream: string, nativeKind?: string, afterSequence?: number): { ref: string; observation: Json }[] =>
        ledger.eventEntries({ nativeStream: stream, ...(nativeKind ? { nativeKind } : {}), ...(afterSequence === undefined ? {} : { afterSequence }) }).flatMap(({ body: value, sequence }) => {
          const event = value as unknown as { controlled?: { kind: string; command?: HostCommand } }
          const command = event.controlled?.command
          return event.controlled?.kind === 'host' && command?.kind === 'native' && command.stream === stream
            ? [{ ref: 'native-event:' + String(sequence), observation: command.observation }]
            : []
        }),
      reserveNativeExchange: (ref: Ref, ownerRef: Ref, payload: string) =>
        ledger.controlled({
          kind: 'frame',
          ref,
          ownerRef,
          digest: createHash('sha256').update(payload).digest('hex'),
          token
        }) as ExecutionEnvelope | Denial,
      borrowSessionResources: (ref: Ref, ownerRef: Ref) =>
        ledger.controlled({ kind: 'borrow', ref, ownerRef, token }) as ExecutionEnvelope | Denial,
      openProcess(ref: Ref): SandboxProcess<ProcessActionResult> {
        const e = ledger.controlled({ kind: 'process_open', ref, token }) as ExecutionEnvelope | Denial
        if (e.kind === 'denial') throw new Error(e.code)
        if (e.spec.kind !== 'dispatch') throw new Error('LAUNCH_ACTION_REQUIRED')
        const abort = new AbortController()
        active.set(ref.id, abort)
        return openSandboxProcess(
          e,
          abort.signal,
          () => {
            const p = ledger.controlled({ kind: 'fence', ref }) as ExecutionEnvelope | Denial
            return p.kind === 'envelope'
          },
          (operationRef, line) => {
            const digest = createHash('sha256').update(line).digest('hex')
            const p = ledger.controlled({
              kind: 'frame',
              ref: operationRef,
              ownerRef: ref,
              digest,
              token
            }) as ExecutionEnvelope | Denial
            if (p.kind === 'denial') throw new Error(p.code)
          },
          (receipt) => {
            active.delete(ref.id)
            return reconcileExecution(e, receipt)
          }
        )
      },
      beginDispatch: (ref: Ref) => ledger.controlled({ kind: 'send', ref }) as ExecutionEnvelope | Denial,
      fenceDispatch: (ref: Ref) => ledger.controlled({ kind: 'fence', ref }) as ExecutionEnvelope | Denial,
      completeOperation: (ref: Ref, operation: OperationProof, evidenceRefs: string[]) =>
        ledger.controlled({
          kind: 'result',
          ref,
          receipt: { status: 'confirmed', stopped: false, operation, evidenceRefs },
          token,
          source
        }) as ActionRecord | Denial,
      reconcileAction: (ref: Ref, receipt: ActionReceipt) =>
        ledger.controlled({ kind: 'result', ref, receipt, token, source }) as ActionRecord,
      grantCapability: (capability: CapabilityFence) =>
        hostCommand({ kind: 'capability', capability }) as CapabilityFence,
      revokeCapability: (id: string) => hostCommand({ kind: 'revoke_capability', id }) as CapabilityFence,
      registerWorkspace: (workspace: Workspace) => hostCommand({ kind: 'workspace', workspace }) as Workspace,
      grantMandate: (mandate: Omit<Mandate, 'source'>) =>
        hostCommand({ kind: 'mandate', mandate }) as Mandate,
      grantControl: (target: Ref, holder: string, expiresAt: number) =>
        hostCommand({ kind: 'control', target, holder, expiresAt }) as ControlLease,
      revokeMandate: (id: string) => hostCommand({ kind: 'revoke_mandate', id }) as Mandate,
      revokeControl(target: Ref, sourceRef: Ref): ControlReceipt {
        if (sourceRef.id !== source.id || sourceRef.revision !== source.revision)
          throw new Error('HOST_SOURCE_MISMATCH')
        const receipt = hostCommand({ kind: 'revoke', target }) as ControlReceipt
        for (const [id, abort] of active) {
          const o = ledger.get(id)
          if ((o?.data.execution_spec as unknown as ActionSpec)?.target.id === target.id) abort.abort()
        }
        return receipt
      }
    }
  }
}
