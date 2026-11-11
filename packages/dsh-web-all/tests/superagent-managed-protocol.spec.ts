import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateManagedObject } from '../src/host/services/superagent/protocol/managed-work.ts'
import { ManagedLedger } from '../src/host/services/superagent/kernel/managed-ledger.ts'
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const object = (id: string, kind = 'requirement') => ({ id, kind, revision: 1, data: { intent: id, source_refs: [{ id: 'external:source', revision: 1 }], wish_refs: [], observable_results: ['observable'], constraints: [], criterion_sources: ['source'] }, scope_revision_refs: [], extensions: {} })
const work = (id: string) => ({ ...object(id, 'commitment'), data: { intent: id, work_kind: 'task', type_ref: 'core/task@2', wish_refs: [], requirement_refs: [], source_refs: [], project_refs: [], requirement_revision: 1, acceptance_contract: null, delivery_contract: null, boundary: '', accountable: 'sa', next_review_at: 1, thread_key: 'same', state: 'proposed', control_state: 'autonomous' } })
it('persists independently identified same-thread Tasks and rejects stale CAS atomically', () => {
 const dir = mkdtempSync(join(tmpdir(), 'managed-')); dirs.push(dir); const path = join(dir, 'db')
 let l = new ManagedLedger(path)
 expect(l.transact([], [{ kind: 'create', object: work('a') }, { kind: 'create', object: work('b') }]).kind).toBe('committed')
 l.close(); l = new ManagedLedger(path)
 expect(l.snapshot()).toHaveLength(2)
 expect(l.transact([{ id: 'a', revision: 0 }], [{ kind: 'create', object: object('r') }]).kind).toBe('conflict')
 expect(l.snapshot()).toHaveLength(2)
 expect(() => l.transact([], [{ kind: 'create', object: object('r') }, { kind: 'create', object: object('a') }])).toThrow()
 expect(l.snapshot()).toHaveLength(2); l.close()
})
it('shared/parent version changes immediately invalidate old scoped facts', () => {
 const l = new ManagedLedger(':memory:')
 l.transact([], [{ kind: 'create', object: object('r') }, { kind: 'create', object: { ...object('action', 'action'), data: { state: 'planned', action_kind: 'dispatch', target_ref: 'r', expected_revision: 1, expected_epoch: 1, mandate_ref: 'mandate', payload_ref: 'payload' }, scope_revision_refs: [{ id: 'r', revision: 1 }] } }])
 expect(l.applicability('action')).toBe('usable')
 l.transact([{ id: 'r', revision: 1 }], [{ kind: 'revise', id: 'r', data: { ...object('r').data, intent: 'changed' } }])
 expect(l.applicability('action')).toBe('recheck_required'); l.close()
})
it('rejects unsupported completion and unknown required extensions; preserves optional opaque extensions', () => {
 const l = new ManagedLedger(':memory:')
 expect(() => l.transact([], [{ kind: 'create', object: { ...work('x'), data: { ...work('x').data, state: 'fulfilled' } } }])).toThrow()
 expect(() => l.transact([], [{ kind: 'create', object: { ...object('r'), extensions: { 'vendor/test': { required: true, schema: 1, payload: {} } } } }])).toThrow()
 l.transact([], [{ kind: 'create', object: { ...object('r'), extensions: { 'vendor/test': { required: false, schema: 1, payload: { nested: [1] } } } } }])
 expect(l.get('r')?.extensions['vendor/test']?.payload).toEqual({ nested: [1] })
 expect(() => l.transact([], [{ kind: 'fulfill', id: 'r' }])).toThrow('PHASE_NOT_IMPLEMENTED'); l.close()
})
it('control is separate from progress and released history is immutable', () => {
 const l = new ManagedLedger(':memory:'); l.transact([], [{ kind: 'create', object: work('w') }])
 l.transact([{ id: 'w', revision: 1 }], [{ kind: 'control', id: 'w', control_state: 'paused', reason: 'ownership_unconfirmed', evidence_refs: ['event:cancel'] }])
 expect(l.get('w')?.data.state).toBe('proposed')
 l.transact([{ id: 'w', revision: 2 }], [{ kind: 'transition', id: 'w', state: 'released', reason: 'user stop' }])
 expect(() => l.transact([{ id: 'w', revision: 3 }], [{ kind: 'control', id: 'w', control_state: 'autonomous', reason: 'resume', evidence_refs: [] }])).toThrow('TERMINAL'); l.close()
})
it('rejects malformed domain fields, fake qualification and forged progress/control', () => {
 const l = new ManagedLedger(':memory:')
 for (const o of [
  { ...object('r'), data: { intent: 'too little' } },
  { ...object('r'), data: { ...object('r').data, revoked: false } },
  { ...object('q', 'qualification'), data: { pass: true } },
  { ...work('w'), data: { ...work('w').data, control_state: 'human_controlled' } },
  { ...object('r'), data: { ...object('r').data, constraints: [null] } },
 ]) expect(() => l.transact([], [{ kind: 'create', object: o }])).toThrow()
 l.transact([], [{ kind: 'create', object: object('r') }])
 expect(() => l.transact([], [{ kind: 'revise', id: 'r', data: object('r').data }])).toThrow('EXPECTED_REF_REQUIRED')
 expect(() => l.transact([{ id: 'r', revision: 1 }], [{ kind: 'revise', id: 'r', data: { ...object('r').data, fake: undefined } } as never])).toThrow('INVALID_JSON')
 expect(l.get('r')?.revision).toBe(1); l.close()
})
it('a stale grandparent and contract revision invalidate the entire dependent chain', () => {
 const l = new ManagedLedger(':memory:')
 const contract = { ...object('contract', 'acceptance_contract'), data: { intent: 'criteria', requirement_refs: [{ id: 'r', revision: 1 }], criterion_refs: [], source_refs: [] }, scope_revision_refs: [{ id: 'r', revision: 1 }] }
 const action = { ...object('action', 'action'), data: { state: 'planned', action_kind: 'dispatch', target_ref: 'contract', expected_revision: 1, expected_epoch: 1, mandate_ref: 'm', payload_ref: 'p' }, scope_revision_refs: [{ id: 'contract', revision: 1 }] }
 l.transact([], [{ kind: 'create', object: object('r') }, { kind: 'create', object: contract }, { kind: 'create', object: action }])
 l.transact([{ id: 'r', revision: 1 }], [{ kind: 'revise', id: 'r', data: { ...object('r').data, intent: 'new' } }])
 expect(l.applicability('action')).toBe('recheck_required')
 expect(() => l.transact([], [{ kind: 'create', object: { ...action, id: 'old-action' } }])).toThrow('STALE_SCOPE_REVISION'); l.close()
})
const plannedAction = (id: string, target_ref: string, expected_revision = 1) => ({ ...object(id, 'action'), data: { state: 'planned', action_kind: 'dispatch', target_ref, expected_revision, expected_epoch: 1, mandate_ref: 'm', payload_ref: 'p' }, scope_revision_refs: [] as { id: string; revision: number }[] })
it('binds Action to a current internal target and requires its dependency even when omitted by caller', () => {
 const l = new ManagedLedger(':memory:')
 const w = { ...work('w'), data: { ...work('w').data, requirement_refs: [{ id: 'r', revision: 1 }] }, scope_revision_refs: [{ id: 'r', revision: 1 }] }
 l.transact([], [{ kind: 'create', object: object('r') }, { kind: 'create', object: w }])
 expect(() => l.transact([], [{ kind: 'create', object: plannedAction('wrong-version', 'w', 999) }])).toThrow()
 expect(() => l.transact([], [{ kind: 'create', object: plannedAction('omitted-target', 'w') }])).toThrow()
 expect(() => l.transact([], [{ kind: 'create', object: plannedAction('external-target', 'external:unknown') }])).toThrow()
 l.transact([], [{ kind: 'create', object: { ...plannedAction('valid', 'w'), scope_revision_refs: [{ id: 'w', revision: 1 }] } }])
 expect(l.applicability('valid')).toBe('usable')
 l.transact([{ id: 'r', revision: 1 }], [{ kind: 'revise', id: 'r', data: { ...object('r').data, intent: 'changed' } }])
 expect(l.applicability('valid')).toBe('recheck_required'); l.close()
})
it('rejects wrong domain kinds in contract, requirement, wish and parent relations', () => {
 const l = new ManagedLedger(':memory:'); l.transact([], [{ kind: 'create', object: work('other') }])
 const ref = { id: 'other', revision: 1 }
 for (const key of ['acceptance_contract','delivery_contract','requirement_refs','wish_refs']) {
  const value = key.endsWith('_refs') ? [ref] : ref
  expect(() => l.transact([], [{ kind: 'create', object: { ...work('bad'), data: { ...work('bad').data, [key]: value }, scope_revision_refs: [ref] } }])).toThrow('REFERENCE_KIND_MISMATCH')
 }
 l.transact([], [{ kind: 'create', object: object('r') }])
 expect(() => l.transact([], [{ kind: 'create', object: { ...work('bad-parent'), data: { ...work('bad-parent').data, parent_id: 'r' }, scope_revision_refs: [{ id: 'r', revision: 1 }] } }])).toThrow('REFERENCE_KIND_MISMATCH')
 l.close()
})
it('rejects malformed optional core fields rather than persisting uninterpretable identities', () => {
 const l = new ManagedLedger(':memory:')
 for (const key of ['parent_id','responsibility_id','thread_key']) for (const value of [{ id: 'w', revision: 1 }, [], 1, null, '', '   ']) {
  expect(() => l.transact([], [{ kind: 'create', object: { ...work('bad'), data: { ...work('bad').data, [key]: value } } }])).toThrow()
 }
 expect(() => l.transact([], [{ kind: 'create', object: { ...work('bad'), data: { ...work('bad').data, next_review_at: -1 } } }])).toThrow()
 expect(() => l.transact([], [{ kind: 'create', object: { ...work('bad'), data: { ...work('bad').data, waiting: [] } } }])).toThrow()
 l.close()
})

it('checks internal control, waiting and enum shapes without string coercion', () => {
 for (const [key, value] of [['work_kind',['task']],['state',['proposed']],['control_state',['autonomous']],['previous_control_state',['autonomous']],['state_reason',{}],['pause_reason',1],['control_evidence_refs',[1]]]) {
  expect(() => validateManagedObject({ ...work('w'), data: { ...work('w').data, [key as string]: value } } as never)).toThrow()
 }
 const waiting = { waiting_on: 'dependency', resume_trigger: 'event', latest_review_at: 1, resume_stage: ['working'] }
 expect(() => validateManagedObject({ ...work('w'), data: { ...work('w').data, state: 'waiting', waiting } })).toThrow('WAITING_CONTEXT_REQUIRED')
})
