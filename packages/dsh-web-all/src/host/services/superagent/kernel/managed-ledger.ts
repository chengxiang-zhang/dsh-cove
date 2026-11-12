import { deliveryTransaction, type DeliveryCommitCommand } from './delivery-ledger.ts'
import { verificationTransaction, type VerificationCommand } from './verification-ledger.ts'
import { VERIFICATION_KINDS } from '../protocol/verification.ts'
import { controlledTransaction, type ControlledCommand, type ControlledResult } from './actions.ts'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { assertJson, assertRefs, TERMINAL_MANAGED_STATES, validateManagedObject, type ManagedObject, type ManagedProposal, type Ref, type CommittedRevision, type Conflict } from '../protocol/managed-work.ts'
import { managedGeneration, migrateManagedWork } from '../protocol/migrations/managed-work.ts'
import type { ExtensionRegistry } from '../protocol/extensions.ts'
import { COORDINATION_KINDS } from '../protocol/coordination.ts'
import { coordinationTransaction, type CoordinationCommand } from './coordination-ledger.ts'
const transitions: Record<string, readonly string[]> = { proposed: ['ready','waiting','at_risk'], ready: ['working','waiting','at_risk'], working: ['verifying','waiting','at_risk'], verifying: ['working','waiting','at_risk'], delivering: ['working','waiting','at_risk'], waiting: ['proposed','ready','working','verifying','delivering','at_risk'], at_risk: ['proposed','ready','working','verifying','waiting'] }
/** Canonical v2 writer, deliberately not mounted by the legacy service composition.
 * Every mutated existing object needs a matching expectedRef; every scoped fact is
 * checked against live revisions again when queried/consumed, across all projects.
 */
export interface ManagedEventFilter {
 nativeStream?: string; nativeKind?: string; nativeThreadId?: string; workerRegistration?: Ref
 profileRegistration?: Ref; workspaceRoot?: string; workspaceRole?: string; runtimeEvent?: string; deliveryStep?: Ref
 latest?: boolean; afterSequence?: number; nativeKinds?: string[]; nativeRpcMethod?: string
 operationRetirement?: Ref; operationClaim?: string; controlledPlanKind?: string; controlledPlans?: boolean; nativeTurnId?: string; nativeInputText?: string
}
export class ManagedLedger {
 readonly #db: DatabaseSync
 readonly #extensions: ExtensionRegistry | undefined
 constructor(path: string, options: { extensions?: ExtensionRegistry } = {}) {
  this.#extensions = options.extensions
  this.#db = new DatabaseSync(path)
  try {
   this.#db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON')
   if (managedGeneration(this.#db) === undefined) migrateManagedWork(this.#db, 0)
   if (managedGeneration(this.#db) !== 2) throw new Error('PROTOCOL_GENERATION')
   this.#db.exec("CREATE INDEX IF NOT EXISTS sa_native_stream_read ON sa_managed_event(json_extract(body_json,'$.controlled.command.stream')) WHERE json_extract(body_json,'$.controlled.kind')='host' AND json_extract(body_json,'$.controlled.command.kind')='native'; CREATE INDEX IF NOT EXISTS sa_worker_registration_read ON sa_managed_event(json_extract(body_json,'$.coordination.payload.input.id')) WHERE json_extract(body_json,'$.coordination.payload.kind')='worker'")
   for (const name of ['sa_managed_object','sa_managed_event']) if (!this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) throw new Error('MANAGED_SCHEMA_INCOMPLETE')
  } catch (e) { this.#db.close(); throw e }
 }
 validate(object: ManagedObject): void { validateManagedObject(object, false, this.#extensions) }
 coordination(command: CoordinationCommand): Ref[] { return coordinationTransaction(this.#db, this, command) }
 verification(command: VerificationCommand): Ref { return verificationTransaction(this.#db, this, command) }
 controlled(command: ControlledCommand): ControlledResult { return controlledTransaction(this.#db, this, command) }
 delivery(command: DeliveryCommitCommand): Ref { return deliveryTransaction(this.#db, this, command) }
 close(): void { this.#db.close() }
 get(id: string): ManagedObject | undefined {
  const r = this.#db.prepare('SELECT body_json FROM sa_managed_object WHERE id=?').get(id)
  return r ? JSON.parse(String(r.body_json)) as ManagedObject : undefined
 }
 events(): import('../protocol/managed-work.ts').Json[] { return this.#db.prepare('SELECT body_json FROM sa_managed_event ORDER BY sequence').all().map(r => JSON.parse(String(r.body_json))) }
 eventEntries(filter: ManagedEventFilter): { sequence: number; body: import('../protocol/managed-work.ts').Json }[] {
  return this.#eventRows(filter, false).map(r => ({ sequence: Number(r.sequence), body: JSON.parse(String(r.body_json)) }))
 }
 eventRefs(filter: ManagedEventFilter): string[] { return this.#eventRows(filter, true).map(r => 'native-event:' + Number(r.sequence)) }
 #eventRows(filter: ManagedEventFilter, referencesOnly: boolean) {
  const clauses: string[] = [], values: (string | number)[] = []
  if (filter.nativeStream !== undefined) { clauses.push("json_extract(body_json,'$.controlled.kind')='host' AND json_extract(body_json,'$.controlled.command.kind')='native' AND json_extract(body_json,'$.controlled.command.stream')=?"); values.push(filter.nativeStream) }
  if (filter.workerRegistration) { clauses.push("json_extract(body_json,'$.coordination.payload.kind')='worker' AND json_extract(body_json,'$.coordination.payload.input.id')=? AND EXISTS(SELECT 1 FROM json_each(body_json,'$.refs') WHERE json_extract(value,'$.id')=? AND json_extract(value,'$.revision')=?)"); values.push(filter.workerRegistration.id, filter.workerRegistration.id, filter.workerRegistration.revision) }
  if (filter.nativeKind !== undefined) { clauses.push("json_extract(body_json,'$.controlled.kind')='host' AND json_extract(body_json,'$.controlled.command.kind')='native' AND json_extract(body_json,'$.controlled.command.observation.kind')=?"); values.push(filter.nativeKind) }
  if (filter.afterSequence !== undefined) { if (!Number.isSafeInteger(filter.afterSequence) || filter.afterSequence < 0) throw Error('EVENT_CURSOR_INVALID'); clauses.push('sequence>?'); values.push(filter.afterSequence) }
  if (filter.nativeKinds?.length || filter.nativeRpcMethod) {
   const choices: string[] = []
   if (filter.nativeKinds?.length) { choices.push("json_extract(body_json,'$.controlled.command.observation.kind') IN ("+filter.nativeKinds.map(()=>'?').join(',')+")"); values.push(...filter.nativeKinds) }
   if (filter.nativeRpcMethod) { choices.push("(json_extract(body_json,'$.controlled.command.observation.kind')='rpc' AND json_extract(body_json,'$.controlled.command.observation.message.method')=?)"); values.push(filter.nativeRpcMethod) }
   clauses.push("json_extract(body_json,'$.controlled.kind')='host' AND json_extract(body_json,'$.controlled.command.kind')='native' AND ("+choices.join(' OR ')+')')
  }
  if (filter.nativeThreadId !== undefined) { clauses.push("json_extract(body_json,'$.controlled.command.observation.threadId')=?"); values.push(filter.nativeThreadId) }
  if (filter.profileRegistration) { clauses.push("json_extract(body_json,'$.coordination.payload.kind')='profile' AND json_extract(body_json,'$.coordination.payload.input.id')=? AND EXISTS(SELECT 1 FROM json_each(body_json,'$.refs') WHERE json_extract(value,'$.id')=? AND json_extract(value,'$.revision')=?)"); values.push(filter.profileRegistration.id, filter.profileRegistration.id, filter.profileRegistration.revision) }
  for (const [key, value] of [['root', filter.workspaceRoot], ['role', filter.workspaceRole]] as const) if (value !== undefined) { clauses.push("json_extract(body_json,'$.controlled.kind')='host' AND json_extract(body_json,'$.controlled.command.kind')='workspace' AND json_extract(body_json,'$.controlled.command.workspace."+key+"')=?"); values.push(value) }
  if (filter.runtimeEvent !== undefined) { clauses.push("json_extract(body_json,'$.coordination.payload.kind')='runtime_event' AND json_extract(body_json,'$.coordination.payload.event')=?"); values.push(filter.runtimeEvent) }
  if (filter.operationRetirement) { clauses.push("json_extract(body_json,'$.coordination.payload.kind')='retire_interrupted' AND EXISTS(SELECT 1 FROM json_each(body_json,'$.refs') WHERE json_extract(value,'$.id')=? AND json_extract(value,'$.revision')=?)"); values.push(filter.operationRetirement.id, filter.operationRetirement.revision) }
  if (filter.operationClaim !== undefined) { clauses.push("json_extract(body_json,'$.coordination.payload.kind')='operation_claim' AND json_extract(body_json,'$.coordination.payload.input.id')=?"); values.push(filter.operationClaim) }
  if (filter.controlledPlanKind !== undefined) { clauses.push("json_extract(body_json,'$.controlled.kind')='plan' AND json_extract(body_json,'$.controlled.spec.kind')=?"); values.push(filter.controlledPlanKind) }
  if (filter.controlledPlans) clauses.push("json_extract(body_json,'$.controlled.kind')='plan'")
  if (filter.nativeTurnId !== undefined) { clauses.push("json_extract(body_json,'$.controlled.kind')='host' AND json_extract(body_json,'$.controlled.command.kind')='native' AND json_extract(body_json,'$.controlled.command.observation.kind')='turn-page' AND EXISTS(SELECT 1 FROM json_each(body_json,'$.controlled.command.observation.page.data') WHERE json_extract(value,'$.id')=?)"); values.push(filter.nativeTurnId) }
  if (filter.nativeInputText !== undefined) { clauses.push("EXISTS(SELECT 1 FROM json_each(body_json,'$.controlled.command.observation.page.data') t, json_each(t.value,'$.items') i, json_each(i.value,'$.content') c WHERE json_extract(i.value,'$.type')='userMessage' AND json_extract(c.value,'$.text')=?)"); values.push(filter.nativeInputText) }
  if (filter.deliveryStep) { clauses.push("json_extract(body_json,'$.delivery')='fulfilled' AND json_extract(body_json,'$.step.ref.id')=? AND json_extract(body_json,'$.step.ref.revision')=?"); values.push(filter.deliveryStep.id, filter.deliveryStep.revision) }
  return this.#db.prepare('SELECT '+(referencesOnly ? 'sequence' : 'sequence,body_json')+' FROM sa_managed_event' + (clauses.length ? ' WHERE '+clauses.join(' AND ') : '') + ' ORDER BY sequence' + (filter.latest ? ' DESC LIMIT 1' : '')).all(...values)
 }
 snapshot(kind?: string): ManagedObject[] { return (kind === undefined ? this.#db.prepare('SELECT body_json FROM sa_managed_object ORDER BY id').all() : this.#db.prepare('SELECT body_json FROM sa_managed_object WHERE kind=? ORDER BY id').all(kind)).map(r => JSON.parse(String(r.body_json)) as ManagedObject) }
 retiredNativeDomain(actionRef: Ref): string | undefined {
  const action = this.get(actionRef.id), spec = action?.data.execution_spec as any
  if (!action || action.revision !== actionRef.revision || action.kind !== 'action' || spec?.kind !== 'dispatch' || spec.processPolicy !== 'single') return undefined
  const raw = this.#db.prepare('SELECT body_json FROM sa_managed_control WHERE singleton=1').get()
  if (!raw) return undefined
  const state = JSON.parse(String(raw.body_json)), capability = state.capabilities.find((c:any)=>c.id===spec.capabilityRef.id && c.revision===spec.capabilityRef.revision)
  if (!capability?.revoked || state.controls.some((c:any)=>c.target.id===spec.target.id && c.epoch===spec.epoch && !c.revoked) || state.resources.some((r:any)=>r.actionRef.id===action.id && r.status==='held')) return undefined
  const proof = this.eventEntries({nativeStream:'execution:'+action.id,nativeKind:'domain_absence',latest:true})[0], command = (proof?.body as any)?.controlled.command, observation = command?.observation
  if (!proof || JSON.stringify(command.actionRef)!==JSON.stringify(actionRef) || JSON.stringify(observation.launchRef)!==JSON.stringify(actionRef) || observation.executionDigest!==createHash('sha256').update(JSON.stringify(spec)).digest('hex') || JSON.stringify(observation.retiredCapability)!==JSON.stringify(spec.capabilityRef)) return undefined
  return 'native-event:'+proof.sequence
 }
 profileExpiresAt(profile: ManagedObject): number {
  const lease = this.get('profile-qualification:'+profile.id+'@'+profile.revision)
  return lease?.kind === 'profile_qualification' && JSON.stringify(lease.data.profile_ref) === JSON.stringify({id:profile.id,revision:profile.revision}) ? Math.max(Number(profile.data.expires_at),Number(lease.data.expires_at)) : Number(profile.data.expires_at)
 }
 applicability(id: string): 'usable' | 'recheck_required' | 'revoked' {
  return this.#applicability(id, new Set())
 }
 #applicability(id: string, seen: Set<string>): 'usable' | 'recheck_required' | 'revoked' {
  const o = this.get(id)
  if (!o || seen.has(id) || o.data.read_only === true) return 'recheck_required'
  try { this.validate(o) } catch { return 'recheck_required' }
  if (o.data.revoked === true) return 'revoked'
  if ((o.kind === 'qualification' && Number(o.data.expires_at) <= Date.now()) || (o.kind === 'capability_profile' && this.profileExpiresAt(o) <= Date.now())) return 'recheck_required'
  // Stable semantic ancestry preserves ordinary progress, but never bypasses
  // the parent commitment's control/terminal state or current requirements.
  if (o.kind === 'coordination_intake') {
   const parent = this.get(String(o.data.commitment_id))
   if (!parent || parent.kind !== 'commitment' || parent.data.control_state !== 'autonomous' || TERMINAL_MANAGED_STATES.includes(parent.data.state as typeof TERMINAL_MANAGED_STATES[number]) || this.#applicability(parent.id, new Set([...seen, id])) !== 'usable') return 'recheck_required'
  }
  if (o.kind === 'action') {
   const target = typeof o.data.target_ref === 'string' ? this.get(o.data.target_ref) : undefined
   if (!target || target.revision !== o.data.expected_revision || !o.scope_revision_refs.some(r => r.id === target.id && r.revision === target.revision)) return 'recheck_required'
  }
  seen.add(id)
  for (const r of o.scope_revision_refs) if (this.get(r.id)?.revision !== r.revision || this.#applicability(r.id, new Set(seen)) !== 'usable') return 'recheck_required'
  return 'usable'
 }
 transact(expectedRefs: Ref[], proposals: ManagedProposal[]): CommittedRevision | Conflict {
  // A revision of zero represents absence only at the CAS boundary.
  assertJson(expectedRefs); assertJson(proposals)
  if (!Array.isArray(expectedRefs) || expectedRefs.some(r => !r || typeof r.id !== 'string' || !r.id || !Number.isSafeInteger(r.revision) || r.revision < 0) || new Set(expectedRefs.map(r => r.id)).size !== expectedRefs.length || !Array.isArray(proposals) || !proposals.length) throw new Error('INVALID_TRANSACTION')
  this.#db.exec('BEGIN IMMEDIATE')
  try {
   const stale = expectedRefs.filter(r => (this.get(r.id)?.revision ?? 0) !== r.revision)
   if (stale.length) { this.#db.exec('ROLLBACK'); return { kind: 'conflict', code: 'STALE_REVISION', refs: stale } }
   const changed: Ref[] = []
   for (const p of proposals) {
    if (!p || typeof p !== 'object') throw new Error('INVALID_COMMAND')
    const fields: Record<string, string[]> = { create: ['kind','object'], revise: ['kind','id','data','scope_revision_refs'], transition: ['kind','id','state','reason'], control: ['kind','id','control_state','reason','evidence_refs'], revoke_qualification: ['kind','id','reason','evidence_refs'] }
    if (fields[p.kind] && Object.keys(p).some(k => !fields[p.kind]!.includes(k))) throw new Error('INVALID_COMMAND_FIELDS')
    if (p.kind === 'create') {
     if ((COORDINATION_KINDS as readonly string[]).includes(p.object.kind)) throw new Error('COORDINATION_HOST_REQUIRED')
     if ((VERIFICATION_KINDS as readonly string[]).includes(p.object.kind)) throw new Error('VERIFICATION_HOST_REQUIRED')
     this.validate(p.object)
     const o = p.object
     if (o.revision !== 1 || this.get(o.id)) throw new Error('OBJECT_EXISTS')
     // M1 only admits declarative facts. Later phases own attestations and effects.
     if (['receipt','evaluation','delivery_step','team_assignment','session_binding','responsibility','finding','improvement'].includes(o.kind)) throw new Error('PHASE_NOT_IMPLEMENTED')
     if (o.kind === 'commitment' && (o.data.state !== 'proposed' || o.data.control_state !== 'autonomous' || ['previous_control_state','pause_reason','control_evidence_refs','state_reason'].some(k => k in o.data))) throw new Error('INITIAL_STATE_REQUIRED')
     if (o.kind === 'action' && ('execution_spec' in o.data || 'receipt' in o.data)) throw new Error('CONTROLLED_ACTION_REQUIRED')
     if (o.kind === 'action' && o.data.state !== 'planned') throw new Error('PHASE_NOT_IMPLEMENTED')
     this.#checkScopes(o)
     this.#db.prepare('INSERT INTO sa_managed_object VALUES(?,?,?,?,0)').run(o.id, o.kind, 1, JSON.stringify(o)); changed.push({ id: o.id, revision: 1 })
     continue
    }
    if (!['revise','transition','control','revoke_qualification'].includes(p.kind)) throw new Error('PHASE_NOT_IMPLEMENTED')
    const o = this.get(p.id)
    if (!o) throw new Error('OBJECT_MISSING')
    if (!expectedRefs.some(r => r.id === o.id)) throw new Error('EXPECTED_REF_REQUIRED')
    if (o.data.read_only) throw new Error('LEGACY_READ_ONLY')
    if (o.kind === 'commitment' && TERMINAL_MANAGED_STATES.includes(o.data.state as typeof TERMINAL_MANAGED_STATES[number])) throw new Error('TERMINAL')
    if (p.kind === 'revise') {
     if (!['wish','requirement','acceptance_contract','delivery_contract','worker'].includes(o.kind)) throw new Error('REVISION_COMMAND_NOT_ALLOWED')
     o.data = p.data
     if (p.scope_revision_refs) { assertRefs(p.scope_revision_refs); o.scope_revision_refs = p.scope_revision_refs }
    } else if (p.kind === 'transition') {
     if (o.kind !== 'commitment' || typeof p.reason !== 'string' || !p.reason.trim()) throw new Error('INVALID_TRANSITION')
     if (p.state === 'fulfilled' || p.state === 'delivering') throw new Error('PHASE_NOT_IMPLEMENTED')
     if (!['released','withdrawn','broken'].includes(p.state) && !transitions[String(o.data.state)]?.includes(p.state)) throw new Error('INVALID_TRANSITION')
     // Waiting recovery requires a dedicated version-bound context command in P2.
     if (p.state === 'waiting') throw new Error('WAITING_CONTEXT_REQUIRED')
     o.data.state = p.state; o.data.state_reason = p.reason
    } else if (p.kind === 'control') {
     if (o.kind !== 'commitment' || !['autonomous','paused','human_controlled'].includes(p.control_state) || typeof p.reason !== 'string' || !p.reason.trim() || !Array.isArray(p.evidence_refs) || p.evidence_refs.some(e => typeof e !== 'string' || !e)) throw new Error('INVALID_CONTROL')
     if (p.control_state !== 'paused') throw new Error('PHASE_NOT_IMPLEMENTED')
     if (!p.evidence_refs.length) throw new Error('EVIDENCE_MISSING')
     o.data.previous_control_state = o.data.control_state!; o.data.control_state = p.control_state; o.data.pause_reason = p.reason; o.data.control_evidence_refs = p.evidence_refs
    } else if (p.kind === 'revoke_qualification') {
     throw new Error('VERIFICATION_HOST_REQUIRED')

    }
    o.revision++; this.validate(o); this.#checkScopes(o)
    this.#db.prepare('UPDATE sa_managed_object SET revision=?,body_json=? WHERE id=?').run(o.revision, JSON.stringify(o), o.id); changed.push({ id: o.id, revision: o.revision })
   }
   const seq = Number(this.#db.prepare('SELECT sequence FROM sa_managed_meta WHERE singleton=1').get()!.sequence) + 1
   this.#db.prepare('UPDATE sa_managed_meta SET sequence=? WHERE singleton=1').run(seq)
   this.#db.prepare('INSERT INTO sa_managed_event VALUES(?,?)').run(seq, JSON.stringify({ protocol_version: 2, expectedRefs, proposals, refs: changed }))
   this.#db.exec('COMMIT'); return { kind: 'committed', sequence: seq, refs: changed }
  } catch (e) { this.#db.exec('ROLLBACK'); throw e }
 }
 #checkScopes(o: ManagedObject): void {
  if (o.kind === 'action') {
   const target = this.get(String(o.data.target_ref))
   if (!target) throw new Error('EXTERNAL_TARGET_UNSUPPORTED')
   if (target.revision !== o.data.expected_revision) throw new Error('STALE_TARGET_REVISION')
   if (!o.scope_revision_refs.some(r => r.id === target.id && r.revision === target.revision)) throw new Error('SCOPE_REF_REQUIRED')
  }
  for (const r of o.scope_revision_refs) if (r.id === o.id || this.get(r.id)?.revision !== r.revision || this.applicability(r.id) !== 'usable') throw new Error('STALE_SCOPE_REVISION')
  for (const key of ['acceptance_contract','delivery_contract']) {
   const ref = o.data[key]
   if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
    const r = ref as unknown as Ref
    if (this.get(r.id)?.kind !== key) throw new Error('REFERENCE_KIND_MISMATCH')
    if (!o.scope_revision_refs.some(s => s.id === r.id && s.revision === r.revision)) throw new Error('SCOPE_REF_REQUIRED')
   }
  }
  for (const [key, kind] of [['parent_id','commitment'],['responsibility_id','responsibility']] as const) if (typeof o.data[key] === 'string') {
   if (this.get(o.data[key] as string)?.kind !== kind) throw new Error('REFERENCE_KIND_MISMATCH')
   if (!o.scope_revision_refs.some(s => s.id === o.data[key])) throw new Error('SCOPE_REF_REQUIRED')
  }
  for (const key of ['requirement_refs','wish_refs']) {
   const refs = o.data[key]
   if (Array.isArray(refs)) for (const r of refs as unknown as Ref[]) {
    if (this.get(r.id)?.kind !== (key === 'requirement_refs' ? 'requirement' : 'wish')) throw new Error('REFERENCE_KIND_MISMATCH')
    if (this.get(r.id)?.revision !== r.revision || !o.scope_revision_refs.some(s => s.id === r.id && s.revision === r.revision)) throw new Error('SCOPE_REF_REQUIRED')
   }
  }
 }
}
