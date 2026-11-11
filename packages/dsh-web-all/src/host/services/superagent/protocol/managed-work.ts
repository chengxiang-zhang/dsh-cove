import { VERIFICATION_KINDS, validateVerificationData } from './verification.ts'
import type { ExtensionRegistry } from './extensions.ts'
import { COORDINATION_KINDS, validateCoordinationData } from './coordination.ts'
/** Canonical managed-work generation. No host or engine implementation dependencies. */
export const MANAGED_PROTOCOL_VERSION = 2
export interface Ref { id: string; revision: number }
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export interface Extension { required: boolean; schema: number; payload: Json }
export type ManagedKind = 'wish' | 'requirement' | 'commitment' | 'acceptance_contract' | 'delivery_contract' | 'worker' | 'session_binding' | 'team_assignment' | 'action' | 'receipt' | 'evaluation' | 'delivery_step' | 'responsibility' | 'finding' | 'improvement' | 'qualification' | typeof VERIFICATION_KINDS[number] | typeof COORDINATION_KINDS[number]
export interface ManagedObject {
 id: string; kind: string; revision: number; data: Record<string, Json>
 scope_revision_refs: Ref[]; extensions: Record<string, Extension>
}
export type ControlState = 'autonomous' | 'paused' | 'human_controlled'
export type ManagedState = 'proposed' | 'ready' | 'working' | 'verifying' | 'delivering' | 'fulfilled' | 'waiting' | 'at_risk' | 'released' | 'withdrawn' | 'broken'
export const TERMINAL_MANAGED_STATES = ['fulfilled', 'released', 'withdrawn', 'broken'] as const
export type ManagedProposal =
 | { kind: 'create'; object: ManagedObject }
 | { kind: 'revise'; id: string; data: Record<string, Json>; scope_revision_refs?: Ref[] }
 | { kind: 'transition'; id: string; state: ManagedState; reason: string }
 | { kind: 'control'; id: string; control_state: ControlState; reason: string; evidence_refs: string[] }
 | { kind: 'revoke_qualification'; id: string; reason: string; evidence_refs: string[] }
 | { kind: 'fulfill' | 'dispatch' | 'evaluate' | 'deliver' | 'handoff' | 'receipt' | 'learn' | 'finding' | 'responsibility'; id: string }
export interface CommittedRevision { kind: 'committed'; sequence: number; refs: Ref[] }
export interface Conflict { kind: 'conflict'; code: 'STALE_REVISION'; refs: Ref[] }
export interface RuntimeIdentity { host: string; engineId: string; runtimeNamespace: string; nativeSessionId: string }
const kinds: readonly string[] = ['legacy_record','wish','requirement','commitment','acceptance_contract','delivery_contract','worker','session_binding','team_assignment','action','receipt','evaluation','delivery_step','responsibility','finding','improvement','qualification', ...VERIFICATION_KINDS, ...COORDINATION_KINDS]
export function assertJson(value: unknown): asserts value is Json {
 const visit = (v: unknown, seen: Set<object>): void => {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return
  if (typeof v === 'number' && Number.isFinite(v)) return
  if (typeof v !== 'object' || !v || seen.has(v)) throw new Error('INVALID_JSON')
  if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error('INVALID_JSON')
  seen.add(v); for (const x of Object.values(v)) visit(x, seen); seen.delete(v)
 }; visit(value, new Set())
}
export function assertRefs(refs: unknown): asserts refs is Ref[] {
 if (!Array.isArray(refs) || refs.some(r => !r || typeof r.id !== 'string' || !r.id.trim() || !Number.isSafeInteger(r.revision) || r.revision < 1 || Object.keys(r).some(k => !['id','revision'].includes(k)))) throw new Error('INVALID_REFS')
}
export function validateManagedObject(o: ManagedObject, legacy = false, extensions?: ExtensionRegistry): void {
 assertJson(o)
 if (!o || Object.keys(o).some(k => !['id','kind','revision','data','scope_revision_refs','extensions'].includes(k)) || typeof o.id !== 'string' || !o.id.trim() || !kinds.includes(o.kind) || !Number.isSafeInteger(o.revision) || o.revision < 1 || !o.data || Array.isArray(o.data) || typeof o.data !== 'object' || !o.extensions || Array.isArray(o.extensions) || typeof o.extensions !== 'object') throw new Error('INVALID_OBJECT')
 assertRefs(o.scope_revision_refs)
 for (const [name, e] of Object.entries(o.extensions)) {
  if (!/^[a-z][a-z0-9.-]*\/[a-zA-Z0-9_.-]+$/.test(name) || !e || typeof e.required !== 'boolean' || !Number.isSafeInteger(e.schema) || e.schema < 1 || !('payload' in e) || Object.keys(e).some(k => !['required','schema','payload'].includes(k))) throw new Error('INVALID_EXTENSION')
  if (extensions) extensions.validate(name, e)
  else if (e.required) throw new Error('UNKNOWN_REQUIRED_EXTENSION')
 }
 if (legacy) return
 if ((COORDINATION_KINDS as readonly string[]).includes(o.kind)) { validateCoordinationData(o.kind, o.data); return }
 if ((VERIFICATION_KINDS as readonly string[]).includes(o.kind)) { validateVerificationData(o.kind, o.data); return }
 const schemas: Record<string, { required: string[]; optional: string[] }> = {
  wish: { required: ['intent','source_refs','subject_ref','scope_refs'], optional: [] },
  requirement: { required: ['intent','source_refs','wish_refs','observable_results','constraints','criterion_sources'], optional: [] },
  acceptance_contract: { required: ['intent','requirement_refs','criterion_refs','source_refs'], optional: [] },
  delivery_contract: { required: ['intent','requirement_refs','step_refs','source_refs'], optional: ['criterion_refs','evidence_policy'] },
  worker: { required: ['intent','capability_profile_refs','engine_ref','host_binding_ref','epoch'], optional: ['runtime_namespace'] },
  action: { required: ['state','action_kind','target_ref','expected_revision','expected_epoch','mandate_ref','payload_ref'], optional: ['execution_spec','receipt'] },
 }
 if (o.kind !== 'commitment') {
  const schema = schemas[o.kind]
  if (!schema) throw new Error('PHASE_NOT_IMPLEMENTED')
  if (schema.required.some(k => !(k in o.data)) || Object.keys(o.data).some(k => !schema.required.includes(k) && !schema.optional.includes(k))) throw new Error('INVALID_OBJECT_FIELDS')
  for (const [key, value] of Object.entries(o.data)) {
   if (o.kind === 'action' && ['execution_spec','receipt'].includes(key)) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_ACTION'); continue }
   if (key.endsWith('_refs')) { assertRefs(value); continue }
   if (['observable_results','constraints','criterion_sources'].includes(key)) {
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim())) throw new Error('INVALID_REQUIREMENT')
   } else if (['epoch','expected_epoch','expected_revision'].includes(key)) {
    if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('INVALID_VERSION')
   } else if (typeof value !== 'string' || !value.trim()) throw new Error('INVALID_OBJECT_FIELD')
  }
  if (o.kind === 'requirement' && (!(o.data.observable_results as Json[]).length || (!(o.data.source_refs as Json[]).length && !(o.data.wish_refs as Json[]).length))) throw new Error('REQUIREMENT_SOURCE_REQUIRED')
  if (o.kind === 'action' && (!['planned','authorized','sent','confirmed','failed','unknown'].includes(String(o.data.state)) || !['inspect','dispatch','attach','send_input','steer','respond_request','cancel','collect','provision','integrate','prepare_preview','deliver'].includes(String(o.data.action_kind)))) throw new Error('INVALID_ACTION')
 }
 if (o.kind === 'commitment') {
  const d = o.data
  const fields = ['intent','work_kind','type_ref','wish_refs','requirement_refs','source_refs','project_refs','responsibility_id','parent_id','requirement_revision','acceptance_contract','delivery_contract','boundary','accountable','next_review_at','thread_key','state','control_state','waiting','state_reason','previous_control_state','pause_reason','control_evidence_refs']
  if (Object.keys(d).some(k => !fields.includes(k))) throw new Error('INVALID_COMMITMENT_FIELDS')
  for (const key of ['parent_id','responsibility_id','thread_key','state_reason','pause_reason']) if (key in d && (typeof d[key] !== 'string' || !(d[key] as string).trim())) throw new Error('INVALID_CORE_FIELD')
  if ('previous_control_state' in d && (typeof d.previous_control_state !== 'string' || !['autonomous','paused','human_controlled'].includes(d.previous_control_state))) throw new Error('INVALID_CORE_FIELD')
  if ('control_evidence_refs' in d && (!Array.isArray(d.control_evidence_refs) || !d.control_evidence_refs.length || d.control_evidence_refs.some(v => typeof v !== 'string' || !v.trim()))) throw new Error('INVALID_CORE_FIELD')
  if (d.control_state === 'paused' && (!d.pause_reason || !d.previous_control_state || !d.control_evidence_refs)) throw new Error('INVALID_CONTROL_CONTEXT')
  if ('waiting' in d && d.state !== 'waiting') throw new Error('UNEXPECTED_WAITING_CONTEXT')
  for (const key of ['acceptance_contract','delivery_contract']) if (d[key] !== null) assertRefs([d[key]])
  for (const key of ['source_refs','project_refs']) assertRefs(d[key])
  for (const k of ['intent','type_ref','boundary','accountable']) if (typeof d[k] !== 'string' || (k !== 'boundary' && !(d[k] as string).trim())) throw new Error('INVALID_COMMITMENT')
  if ((typeof d.work_kind !== 'string' || !['outcome','task'].includes(d.work_kind)) || !/^[\w.-]+\/[\w.-]+@\d+$/.test(String(d.type_ref))) throw new Error('INVALID_WORK_TYPE')
  for (const k of ['wish_refs','requirement_refs','source_refs','project_refs']) { if (!Array.isArray(d[k])) throw new Error('INVALID_COMMITMENT'); if (k === 'requirement_refs' || k === 'wish_refs') assertRefs(d[k]) }
  if (!Number.isSafeInteger(d.requirement_revision) || Number(d.requirement_revision) < 1 || !Number.isSafeInteger(d.next_review_at) || Number(d.next_review_at) < 0) throw new Error('INVALID_COMMITMENT')
  if (typeof d.state !== 'string' || !['proposed','ready','working','verifying','delivering','fulfilled','waiting','at_risk','released','withdrawn','broken'].includes(d.state) || typeof d.control_state !== 'string' || !['autonomous','paused','human_controlled'].includes(d.control_state)) throw new Error('INVALID_STATE')
  if (!('acceptance_contract' in d) || !('delivery_contract' in d)) throw new Error('INVALID_CONTRACT')
  if (d.state === 'waiting') {
   const w = d.waiting
   if (!w || typeof w !== 'object' || Array.isArray(w) || Object.keys(w).some(k => !['waiting_on','resume_trigger','latest_review_at','resume_stage'].includes(k)) || typeof w.waiting_on !== 'string' || !w.waiting_on.trim() || typeof w.resume_trigger !== 'string' || !w.resume_trigger.trim() || !Number.isSafeInteger(w.latest_review_at) || Number(w.latest_review_at) < 0 || typeof w.resume_stage !== 'string' || !['proposed','ready','working','verifying','delivering'].includes(w.resume_stage)) throw new Error('WAITING_CONTEXT_REQUIRED')
  }
 }
}
