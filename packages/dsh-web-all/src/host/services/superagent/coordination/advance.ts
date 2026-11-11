import { createHash } from 'node:crypto'
import type { ManagedLedger } from '../kernel/managed-ledger.ts'
import { assertJson, assertRefs, type Ref, type Json } from '../protocol/managed-work.ts'
import type { AssignmentSpec, ContextEnvelope, ProfessionalDecision, ContextRequest } from '../protocol/coordination.ts'
import type { ExtensionSchema } from '../protocol/extensions.ts'
import { resolvePlugins } from '../plugins/registry.ts'
import { createGenerationAuthority, prepareGeneration, type GenerationAuthority, type InvocationCheckpoint } from '../plugins/lifecycle.ts'
import type { CoordinatorRuntimePort, CapabilitySource, PluginCapabilities, PluginManifest } from '../plugins/contracts.ts'
import type { CoordinationService } from './intake.ts'

export interface CoordinatorInput { request_id: string; assignment_revision: number; text: string }
export interface OperationProposal { operation: 'inspect' | 'dispatch' | 'send_input' | 'respond_request' | 'cancel' | 'collect'; target: Ref; payloadRef: Ref }
export interface VerificationProposal { method: string; context: Ref }
export type CoordinationProposal =
  | { kind: 'plan'; commitment: Ref; assignments: AssignmentSpec[] }
  | { kind: 'decision'; decision: ProfessionalDecision }
  | { kind: 'operate'; operation: OperationProposal }
  | { kind: 'verify'; verification: VerificationProposal }
  | { kind: 'wait'; reason: string; waitingOn: string; nextReviewAt: number }
  | { kind: 'look'; refs: Ref[] }
  | { kind: 'outbox'; audience: string[]; basisRefs: Ref[]; text: string }
export interface ProposalBatch { proposals: CoordinationProposal[] }
export interface MaintenanceObservation { project_id: string; source_digest: string; source_refs: Ref[] }
export interface ManagedImplementations<Batch = ProposalBatch> {
  coordinator: CoordinatorRuntimePort<CoordinatorInput, Batch>
  roles: { plan(commitment: Ref, assignments: AssignmentSpec[]): Ref[] }
  context: { compile(input: ContextRequest): ContextEnvelope }
  executor: { operate(input: OperationProposal): Promise<{ status: 'requested' | 'unknown' | 'refused'; evidenceRefs: string[] }> }
  verifier: { readonly methods: readonly string[]; request(input: VerificationProposal): Promise<{ status: 'requested' | 'unknown' | 'refused'; evidenceRefs: string[] }> }
  observer: { observe(commitmentId: string, sources: Ref[]): MaintenanceObservation }
}
const permissions = { coordinator: 'propose', roles: 'coordinate', context: 'read-context', executor: 'controlled-execute', verifier: 'verify', observer: 'observe' } as const
type Builtin = keyof ManagedImplementations
const ids = Object.keys(permissions) as Builtin[]
const data = (v: unknown): Json => { assertJson(v); return v }

export const maintenanceSchemas: readonly ExtensionSchema[] = Object.freeze([{
  namespace: 'maintenance/source', schema: 1, owner: 'builtin:observer',
  validate(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const v = value as MaintenanceObservation
    if (Object.keys(v).sort().join(',') !== 'project_id,source_digest,source_refs' || typeof v.project_id !== 'string' || !v.project_id.trim() || !/^[a-f0-9]{64}$/.test(v.source_digest)) return false
    try { assertRefs(v.source_refs); return v.source_refs.length > 0 } catch { return false }
  },
}])

/** The observer reads real canonical source versions; it cannot mint authorization. */
export function createMaintenanceObserver(ledger: ManagedLedger): ManagedImplementations['observer'] {
  return { observe(commitmentId, sources) {
    assertRefs(sources)
    const work = ledger.get(commitmentId)
    if (!work || work.kind !== 'commitment' || !sources.length) throw new Error('OBSERVER_SCOPE_REQUIRED')
    const projects = work.data.project_refs as unknown as Ref[]
    if (projects.length !== 1) throw new Error('OBSERVER_PROJECT_SCOPE_AMBIGUOUS')
    const rows = sources.map(ref => {
      const o = ledger.get(ref.id)
      if (!o || o.revision !== ref.revision || ledger.applicability(o.id) !== 'usable') throw new Error('OBSERVER_STALE_SOURCE')
      if (!work.scope_revision_refs.some(s => s.id === ref.id && s.revision === ref.revision)) throw new Error('OBSERVER_SOURCE_OUTSIDE_SCOPE')
      return o
    })
    return { project_id: projects[0]!.id, source_digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex'), source_refs: structuredClone(sources) }
  } }
}

/** Concrete builtins go through the same manifest/qualification/lifecycle path as extensions. */
export function createManagedPorts<Batch = ProposalBatch>(implementations: ManagedImplementations<Batch>, capabilities: CapabilitySource, authority: GenerationAuthority = createGenerationAuthority(), validate: (value: unknown) => Batch = validateCoordinationProposals as (value: unknown) => Batch) {
  const caps: PluginCapabilities = typeof capabilities === 'function' ? capabilities() : capabilities
  const manifests: PluginManifest[] = ids.map(id => ({
    id: `builtin:${id}`, namespace: `managed-${id}`, version: '1.0.0', contract_version: '1.0.0',
    provides: [{ id, version: '1.0.0', contract: `managed/${id}` }],
    requires: id === 'coordinator' ? [{ id: 'context', version: '^1.0.0', contract: 'managed/context' }, { id: 'roles', version: '^1.0.0', contract: 'managed/roles' }] : [],
    compatible_schema_versions: ['2'], config_schema: { validate: v => v === null }, config: null,
    owned_state_schemas: [], migration_refs: [], permission_requirements: [permissions[id]], isolation_mode: 'controlled', reload_class: 'domain-controlled',
    contract_test_refs: caps.qualifications.filter(q => q.plugin_id === `builtin:${id}` && q.version === '1.0.0').map(q => q.evidence_ref),
    required_extensions: id === 'observer' ? ['maintenance/source@1'] : [],
  }))
  const graph = resolvePlugins(manifests, capabilities)
  if (!graph.ok) throw new Error(graph.code + ':' + graph.plugin_id + ':' + graph.subject)
  const generation = prepareGeneration(graph, { authority, in_flight: [] })
  for (const id of ids) generation.register(`builtin:${id}`, id, implementations[id])
  generation.activate()
  const invoke = <K extends Builtin, R>(id: K, callback: (port: ManagedImplementations<Batch>[K], checkpoint: InvocationCheckpoint) => R): R => generation.port<ManagedImplementations<Batch>[K]>(id).invoke((port, checkpoint) => {
    checkpoint.assertCurrent()
    const result = callback(port, checkpoint)
    if (result != null && typeof (result as { then?: unknown }).then === 'function') {
      return Promise.resolve(result).then(value => { checkpoint.assertCurrent(); return value }) as R
    }
    return result
  })
  return Object.freeze({
    generation,
    coordinator: (input: CoordinatorInput, signal: AbortSignal) => invoke('coordinator', async (port, checkpoint) => validate(await port.run(structuredClone(input), AbortSignal.any([signal, checkpoint.signal])))),
    plan: (commitment: Ref, assignments: AssignmentSpec[]) => invoke('roles', port => port.plan(commitment, assignments)),
    compile: (input: ContextRequest) => invoke('context', port => port.compile(input)),
    operate: (input: OperationProposal) => { validateOperation(input); const snapshot = structuredClone(input); return invoke('executor', port => port.operate(snapshot)) },
    verify: (input: VerificationProposal) => invoke('verifier', port => {
      if (!port.methods.includes(input.method)) throw new Error('VERIFICATION_METHOD_UNAVAILABLE:' + input.method)
      assertRefs([input.context]); return port.request(structuredClone(input))
    }),
    observe: (commitmentId: string, sources: Ref[]) => invoke('observer', port => port.observe(commitmentId, sources)),
  })
}
export type ManagedPorts = ReturnType<typeof createManagedPorts>
export function observeMaintenance(ports: ManagedPorts, coordination: CoordinationService, commitmentId: string, sources: Ref[]): Ref {
  const observation = ports.observe(commitmentId, sources)
  return coordination.host.recordObservation(commitmentId, 'builtin:observer@1.0.0', sources, 'Versioned maintenance sources observed', {
    'maintenance/source': { required: true, schema: 1, payload: data(observation) },
  })
}

function exact(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(k => !(k in value))) throw new Error('INVALID_COORDINATION_PROPOSAL')
}
function validateOperation(value: unknown): asserts value is OperationProposal {
  exact(value, ['operation', 'target', 'payloadRef'])
  if (!['inspect', 'dispatch', 'send_input', 'respond_request', 'cancel', 'collect'].includes(String(value.operation))) throw new Error('OPERATION_NOT_REGISTERED')
  assertRefs([value.target, value.payloadRef])
}
export function validateCoordinationProposals(value: unknown): ProposalBatch {
  assertJson(value); exact(value, ['proposals'])
  if (!Array.isArray(value.proposals) || !value.proposals.length || value.proposals.length > 20) throw new Error('PROPOSAL_BATCH_LIMIT')
  for (const p of value.proposals) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('INVALID_COORDINATION_PROPOSAL')
    switch (p.kind) {
      case 'plan': exact(p, ['kind', 'commitment', 'assignments']); assertRefs([p.commitment]); if (!Array.isArray(p.assignments) || !p.assignments.length) throw new Error('INVALID_COORDINATION_PROPOSAL'); break
      case 'decision': exact(p, ['kind', 'decision']); if (!p.decision || typeof p.decision !== 'object') throw new Error('INVALID_COORDINATION_PROPOSAL'); break
      case 'operate': exact(p, ['kind', 'operation']); validateOperation(p.operation); break
      case 'verify': exact(p, ['kind', 'verification']); exact(p.verification, ['method', 'context']); if (typeof p.verification.method !== 'string' || !p.verification.method.trim()) throw new Error('INVALID_COORDINATION_PROPOSAL'); assertRefs([p.verification.context]); break
      case 'look': exact(p, ['kind', 'refs']); assertRefs(p.refs); break
      case 'wait': exact(p, ['kind', 'reason', 'waitingOn', 'nextReviewAt']); if (typeof p.reason !== 'string' || !p.reason.trim() || typeof p.waitingOn !== 'string' || !p.waitingOn.trim() || !Number.isSafeInteger(p.nextReviewAt) || Number(p.nextReviewAt) <= Date.now()) throw new Error('WAIT_CONTEXT_REQUIRED'); break
      case 'outbox': exact(p, ['kind', 'audience', 'basisRefs', 'text']); assertRefs(p.basisRefs); if (!Array.isArray(p.audience) || !p.audience.length || p.audience.some(a => typeof a !== 'string' || !a.trim()) || typeof p.text !== 'string' || !p.text.trim()) throw new Error('OUTBOX_CONTEXT_REQUIRED'); break
      default: throw new Error('COORDINATION_PROPOSAL_NOT_REGISTERED')
    }
  }
  return structuredClone(value) as unknown as ProposalBatch
}

export interface EngineCandidate { engine: string; capabilities: string[]; evidenceRefs: string[]; qualified: boolean }
export function selectQualifiedEngine(candidates: EngineCandidate[], required: string[], priority = ['codex', 'dsh', 'claude']): { engine: string; declined: { engine: string; reason: string }[] } {
  const declined: { engine: string; reason: string }[] = []
  for (const engine of priority) {
    const c = candidates.find(v => v.engine === engine)
    const missing = required.filter(capability => !c?.capabilities.includes(capability))
    const reason = !c ? 'NOT_CONFIGURED' : !c.qualified || !c.evidenceRefs.length ? 'QUALIFICATION_MISSING' : missing.length ? 'CAPABILITY_MISSING:' + missing.join(',') : undefined
    if (reason) { declined.push({ engine, reason }); continue }
    return { engine, declined }
  }
  throw new Error('NO_QUALIFIED_ENGINE:' + JSON.stringify(declined))
}
