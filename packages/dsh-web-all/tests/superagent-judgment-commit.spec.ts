/**
 * Judgment: commit, amend, release, propose and fast-path execution (T26).
 * Fixtures: FX/ledger.ts, FX/fake-controller.ts, the real T19 executors and T15 world
 * registry; gate facts, the work-class port and the say port are stubs (T21 seam).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createExecutors } from '../src/host/services/superagent/executors/attempts.ts'
import { createProfileRegistry } from '../src/host/services/superagent/executors/profiles/index.ts'
import { amendTool, releaseHost, releaseTool } from '../src/host/services/superagent/judgment/amend-release.ts'
import { commitTool, type SayPort } from '../src/host/services/superagent/judgment/commit.ts'
import { createDispatcher } from '../src/host/services/superagent/judgment/dispatch.ts'
import { applyFastpath } from '../src/host/services/superagent/judgment/fastpath-apply.ts'
import { proposeTool } from '../src/host/services/superagent/judgment/propose.ts'
import type { CommitFacts, JudgmentTurn, WorkClassPort } from '../src/host/services/superagent/judgment/translate.ts'
import { createClaim } from '../src/host/services/superagent/kernel/claim.ts'
import type { InboundEvent } from '../src/host/services/superagent/protocol/events.ts'
import type { Strength, WorkClassRow } from '../src/host/services/superagent/protocol/objects.ts'
import type { CommitInput } from '../src/host/services/superagent/protocol/tools.ts'
import { DEFAULT_TABLE } from '../src/host/services/superagent/world/defaults.ts'
import { createWorldRegistry } from '../src/host/services/superagent/world/registry.ts'
import { createFakeController, type FakeController } from './fixtures/superagent/fake-controller.ts'
import { inboundEvent, openTestLedger, type TestLedger } from './fixtures/superagent/ledger.ts'
import { seedInbound } from './fixtures/superagent/memdb.ts'

const OWNER = 'on_owner'
const COLLEAGUE = { open_id: 'ou_col', union_id: 'on_col' }
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function rig() {
  const t = openTestLedger()
  const seatRoot = mkdtempSync(join(tmpdir(), 'sa-commit-'))
  dirs.push(seatRoot)
  const controller = createFakeController()
  const world = createWorldRegistry({ read: t.ledger.read, clock: t.clock, defaults: DEFAULT_TABLE })
  t.ledger.open(tx => {
    world.registerParty(tx, { party_id: OWNER, union_id: OWNER, class: 'owner', source: 'config' })
    world.register(tx, { canonical: 'seat-repo', kind: 'repo', realm: 'local', path: 'local/repo', manifest: { executors: ['durable-full'] } })
    world.grantFromConfig(tx, [{ principal: OWNER, scopePath: 'local/repo', capability: 'write_repo', strength: 'allow', grantedBy: 'owner' }], 1)
  }, { module: 'world' })
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined }
  const profiles = createProfileRegistry()
  const executors = createExecutors({ ledger: t.ledger, controller: () => controller, world, profiles, clock: t.clock, log, seatRoot,
    workspacePath: () => 'local/repo' })
  const dispatcher = createDispatcher(executors, log)
  const said: Parameters<SayPort>[1][] = []
  const state = { mandate: 'allow' as Strength, quotes: [] as { memory_id: string; quote: string }[], answered: [] as CommitFacts['g1_answered'] }
  const classes: WorkClassPort = {
    get: id => t.ledger.read.get<WorkClassRow>('SELECT * FROM sa_work_class WHERE class_id = ?', id),
    ensure: id => t.ledger.open(tx => {
      tx.run(`INSERT OR IGNORE INTO sa_work_class (class_id, samples, eta_factor, ask_mode, pushback_mode, created_at, updated_at)
        VALUES (?, 0, 1, 'declare', 'on', ?, ?)`, id, tx.now, tx.now)
      return tx.get<WorkClassRow>('SELECT * FROM sa_work_class WHERE class_id = ?', id) as WorkClassRow
    }, { module: 'rules' }),
  }
  const base = { ledger: t.ledger, profiles, classes, owner: OWNER, say: ((_c, p) => { said.push(p) }) as SayPort,
    facts: (): CommitFacts => ({ g1_answered: state.answered, g3_mandate: () => state.mandate, g4_said: state.quotes }) }
  const commit = commitTool({ ...base, dispatcher })
  const ar = { ledger: t.ledger, executors, owner: OWNER, say: base.say }
  return { t, controller, executors, dispatcher, said, state, commit, amend: amendTool(ar), release: releaseTool(ar),
    propose: proposeTool({ ledger: t.ledger, owner: OWNER, say: base.say }), fastDeps: { ...ar, dispatcher, profiles, defaultProfile: 'durable-full' } }
}
type Rig = ReturnType<typeof rig>

/** What claim and judge would have left: inbox row, intake row with the judged class. */
function arrive(r: Rig, over: Partial<InboundEvent> = {}, intake: { cls?: string; about?: string; shadow?: 0 | 1 } = {}): InboundEvent {
  const e = inboundEvent({ received_at: r.t.clock.now(), ...over })
  seedInbound(r.t.db, { event_id: e.event_id, received_at: e.received_at })
  const shadow = intake.shadow ?? 0
  r.t.ledger.open(tx => {
    tx.insertIntake({ event_id: e.event_id, shadow, owner: 'superagent', sender: e.sender.union_id ?? e.sender.open_id,
      thread_key: `${e.chat.type}:${e.chat.id}:${e.thread}`, desk_id: `${e.chat.type}:${e.chat.id}` })
    tx.run('UPDATE sa_intake SET class = ?, about = ? WHERE event_id = ? AND shadow = ?', intake.cls ?? 'fix-build', intake.about ?? null, e.event_id, shadow)
  })
  return e
}
const turn = (e: InboundEvent, over: Partial<JudgmentTurn> = {}): JudgmentTurn => ({
  deskId: `${e.chat.type}:${e.chat.id}`, deliberationId: `D:${e.event_id}`, shadow: false, batch: [e],
  audience: { principals: [OWNER], cls: 'owner_p2p' }, ...over,
})
const input = (e: InboundEvent, over: Partial<CommitInput> = {}): CommitInput => ({
  event_id: e.event_id, kind: 'deliver', what: 'fix the build', intent: 'the build is green again', check_kind: 'command',
  done_when: '`pnpm test` 期望退出码 0', executor: 'durable-full', executor_reason: 'repo work needs a workspace', eta_minutes: 10, ...over,
})
const rows = (r: Rig, sql: string, ...p: Array<string | number>) => r.t.db.prepare(sql).all(...p) as Array<Record<string, unknown>>
const one = (r: Rig, sql: string, ...p: Array<string | number>) => r.t.db.prepare(sql).get(...p) as Record<string, unknown>
const calls = (r: Rig, m: 'create' | 'prompt' | 'cancel') => r.controller.calls.filter(c => c.method === m)

describe('judgment commit', () => {
  it('1. a command check without the expected reading is CHECK_MISSING; complete, it commits', () => {
    const r = rig()
    const e = arrive(r)
    expect(r.commit(turn(e), input(e, { done_when: '`pnpm test`' }))).toMatchObject({ ok: false, code: 'CHECK_MISSING' })
    expect(r.commit(turn(e), input(e))).toMatchObject({ ok: true, commitment_id: 'C-1', state: 'open' })
  })

  it('2. six assumptions are TOO_MANY_ASSUMPTIONS; an irreversible one left declared is ASK_REQUIRED', () => {
    const r = rig()
    const e = arrive(r)
    const a = { question: 'q', taken: 't', reversible: true }
    expect(r.commit(turn(e), input(e, { assumptions: Array(6).fill(a) }))).toMatchObject({ ok: false, code: 'TOO_MANY_ASSUMPTIONS' })
    expect(r.commit(turn(e), input(e, { assumptions: [{ question: 'drop the table?', taken: 'keep it', reversible: false }] }))).toMatchObject({ ok: false, code: 'ASK_REQUIRED' })
    // A technical choice may not be asked at all (B14).
    const technical = [{ question: '用哪个执行体？', taken: 'durable-full', reversible: true, mode: 'asked' }] as CommitInput['assumptions']
    expect(r.commit(turn(e), input(e, { assumptions: technical }))).toMatchObject({ ok: false, code: 'ASK_REQUIRED' })
    expect(rows(r, 'SELECT * FROM sa_commitment')).toHaveLength(0)
  })

  it('3. same thread and sender is THREAD_BUSY; a different sender on the thread opens a child', () => {
    const r = rig()
    const e1 = arrive(r, { thread: 'om_root' })
    expect(r.commit(turn(e1), input(e1))).toMatchObject({ ok: true, commitment_id: 'C-1' })
    const e2 = arrive(r, { thread: 'om_root' })
    expect(r.commit(turn(e2), input(e2))).toMatchObject({ ok: false, code: 'THREAD_BUSY' })
    const e3 = arrive(r, { thread: 'om_root', sender: COLLEAGUE })
    expect(r.commit(turn(e3, { sender: 'on_col' }), input(e3))).toMatchObject({ ok: true, commitment_id: 'C-2' })
    expect(one(r, `SELECT parent_id, creditor, on_behalf_of FROM sa_commitment WHERE commitment_id = 'C-2'`))
      .toEqual({ parent_id: 'C-1', creditor: 'on_col', on_behalf_of: OWNER })
  })

  it('4. a work class the model typed is folded into kebab case instead of failing the turn', () => {
    const r = rig()
    const e = arrive(r, {}, { cls: 'ship-docs' })
    expect(r.commit(turn(e), input(e))).toMatchObject({ ok: true })
    expect(rows(r, 'SELECT class_id, samples FROM sa_work_class')).toEqual([{ class_id: 'ship-docs', samples: 0 }])
    // A live turn died on `status_query`: the host keeps one spelling, the turn lives.
    const folded = arrive(r, { thread: 'om_cls2' }, { cls: 'status_query' })
    expect(r.commit(turn(folded), input(folded))).toMatchObject({ ok: true })
    expect(rows(r, 'SELECT class_id FROM sa_work_class ORDER BY class_id').map(x => x.class_id)).toContain('status-query')
    // A class that cannot be folded is still refused.
    const bad = arrive(r, { thread: 'om_cls3' }, { cls: '---' })
    expect(r.commit(turn(bad), input(bad))).toMatchObject({ ok: false, code: 'CLASS_UNKNOWN' })
  })

  it('5. budget_scale 5 is BUDGET_OVER_CAP', () => {
    const r = rig()
    const e = arrive(r)
    expect(r.commit(turn(e), input(e, { budget_scale: 5 }))).toMatchObject({ ok: false, code: 'BUDGET_OVER_CAP' })
    expect(r.commit(turn(e), input(e, { budget_scale: 4 }))).toMatchObject({ ok: true })
    expect(one(r, 'SELECT budget_wall_ms FROM sa_commitment').budget_wall_ms).toBe(4 * 25 * 60_000)   // clamp(10 x 1 x 2.5) x 4
  })

  it('6. a denied mandate is BOUNDARY_DENIED; a draft mandate makes a proposal on the owner with no attempt', () => {
    const r = rig()
    const e = arrive(r)
    r.state.mandate = 'deny'
    expect(r.commit(turn(e), input(e))).toMatchObject({ ok: false, code: 'BOUNDARY_DENIED' })
    r.state.mandate = 'draft'
    expect(r.commit(turn(e), input(e))).toMatchObject({ ok: true, state: 'proposed', mandate: 'draft' })
    expect(one(r, 'SELECT state, ball FROM sa_commitment')).toEqual({ state: 'proposed', ball: OWNER })
    expect(rows(r, 'SELECT * FROM sa_attempt')).toHaveLength(0)
  })

  it('7. a read-only profile for repo work is EXECUTOR_MISMATCH; an unregistered one EXECUTOR_UNKNOWN, naming the candidates', () => {
    const r = rig()
    const e = arrive(r)
    expect(r.commit(turn(e), input(e, { executor: 'oneshot-read' }))).toMatchObject({ ok: false, code: 'EXECUTOR_MISMATCH' })
    const unknown = r.commit(turn(e), input(e, { executor: 'robot-9' }))
    expect(unknown).toMatchObject({ ok: false, code: 'EXECUTOR_UNKNOWN' })
    // The refusal has to be able to correct the guess in the next step: the ids are
    // in the message because the desk tool face cannot enumerate them.
    if (!unknown.ok) {
      expect(unknown.message).toContain('oneshot-read')
      expect(unknown.message).toContain('durable-full')
    }
  })

  it('7b. the executor id the model types is folded: case and surrounding space do not fail the turn', () => {
    const r = rig()
    const e = arrive(r)
    expect(r.commit(turn(e), input(e, { executor: '  Durable-Full  ' }))).toMatchObject({ ok: true, commitment_id: 'C-1' })
    expect(rows(r, 'SELECT executor FROM sa_attempt')).toEqual([{ executor: 'durable-full' }])
  })

  it('8. one transaction writes commitment, pending attempt, subscription and brief; boundary carries the owner quote; ack is said', () => {
    const r = rig()
    r.state.quotes = [{ memory_id: 'M-3', quote: '别动 main 分支' }]
    const e = arrive(r)
    expect(r.commit(turn(e), input(e, { boundary_extra: '只改 src/' }))).toMatchObject({ ok: true, commitment_id: 'C-1' })
    expect(one(r, 'SELECT state, boundary, creditor, on_behalf_of FROM sa_commitment'))
      .toEqual({ state: 'open', boundary: '别动 main 分支（出处 M-3）；只改 src/', creditor: OWNER, on_behalf_of: null })
    expect(rows(r, 'SELECT state, executor FROM sa_attempt')).toEqual([{ state: 'pending', executor: 'durable-full' }])
    expect(rows(r, 'SELECT commitment_id, attempt_id FROM sa_subscription')).toEqual([{ commitment_id: 'C-1', attempt_id: 'C-1:A1' }])
    expect(String(one(r, `SELECT body_json FROM sa_journal WHERE kind = 'brief'`).body_json)).toContain('别动 main 分支（出处 M-3）')
    expect(r.said.map(s => [s.moment, s.text])).toEqual([['ack', '接了 C-1：fix the build。预计 10 分钟。不对就说']])
    expect(one(r, 'SELECT state, disposition FROM sa_intake')).toEqual({ state: 'disposed', disposition: 'commit' })
  })

  it('9. with the slot held a second durable deliver commits and stays pending; the sixth in line is SLOT_FULL', async () => {
    const r = rig()
    for (let i = 1; i <= 5; i++) {
      const e = arrive(r, { thread: `om_t${i}` })
      expect(r.commit(turn(e), input(e))).toMatchObject({ ok: true, commitment_id: `C-${i}` })
      await r.dispatcher.settle()
    }
    expect(rows(r, 'SELECT commitment_id, slot FROM sa_commitment ORDER BY n').map(x => x.slot)).toEqual(['1', null, null, null, null])
    expect(rows(r, 'SELECT state FROM sa_attempt ORDER BY commitment_id').map(x => x.state)).toEqual(['running', 'pending', 'pending', 'pending', 'pending'])
    const sixth = arrive(r, { thread: 'om_t6' })
    expect(r.commit(turn(sixth), input(sixth))).toMatchObject({ ok: false, code: 'SLOT_FULL' })
  })

  it('10. amend on a running attempt is queued with one prompt; without one it waits for the next attempt', async () => {
    const r = rig()
    const e = arrive(r)
    r.commit(turn(e), input(e))
    await r.dispatcher.settle()
    const before = calls(r, 'prompt').length
    const later = arrive(r)
    expect(await r.amend(turn(later), { commitment_id: 'C-1', text: 'also cover the lint step' })).toMatchObject({ ok: true, delivery: 'queued' })
    expect(calls(r, 'prompt').length).toBe(before + 1)
    const e2 = arrive(r, { thread: 'om_other' })
    r.state.mandate = 'allow'
    r.commit(turn(e2), input(e2))   // second durable deliver: pending behind the slot
    await r.dispatcher.settle()
    expect(await r.amend(turn(arrive(r)), { commitment_id: 'C-2', text: 'and docs' })).toMatchObject({ ok: true, delivery: 'next-attempt' })
  })

  it('11. release is immediate: released, attempt ended with origin release, the controller got cancel, no clock move', async () => {
    const r = rig()
    const e = arrive(r)
    r.commit(turn(e), input(e))
    await r.dispatcher.settle()
    const clockAt = r.t.clock.now()
    const out = await r.release(turn(arrive(r)), { commitment_id: 'C-1', reason: '不用了' })
    expect(out).toMatchObject({ ok: true, state: 'released', worktree: 'kept' })
    expect(r.t.clock.now()).toBe(clockAt)
    expect(one(r, 'SELECT state FROM sa_commitment').state).toBe('released')
    expect(rows(r, 'SELECT state, cancel_origin FROM sa_attempt')).toEqual([{ state: 'ended', cancel_origin: 'release' }])
    expect(calls(r, 'cancel')).toHaveLength(1)
    expect(r.said.at(-1)?.text).toContain('停在 C-1:A1')
  })

  it('12. someone who neither asked nor owns it cannot release: NOT_PERMITTED', async () => {
    const r = rig()
    const e = arrive(r)
    r.commit(turn(e), input(e))
    const other = arrive(r, { sender: COLLEAGUE })
    expect(await r.release(turn(other, { sender: 'on_col' }), { commitment_id: 'C-1', reason: 'stop' })).toMatchObject({ ok: false, code: 'NOT_PERMITTED' })
    expect(one(r, 'SELECT state FROM sa_commitment').state).toBe('open')
    // T27 gap 5: the host's stop entry releases synchronously and ends the live attempt in the same transaction.
    const cancelled: string[] = []
    expect(releaseHost({ ledger: r.t.ledger, cancelSession: s => cancelled.push(s) }, 'C-1')).toEqual({ ok: true })
    expect(rows(r, 'SELECT state, end_reason, cancel_origin FROM sa_attempt')).toEqual([{ state: 'ended', end_reason: 'aborted', cancel_origin: 'release' }])
    expect(one(r, 'SELECT state FROM sa_commitment').state).toBe('released')
    expect(releaseHost({ ledger: r.t.ledger }, 'C-1')).toEqual({ ok: false, reason: 'terminal' })
    expect(releaseHost({ ledger: r.t.ledger }, 'C-99')).toEqual({ ok: false, reason: 'missing' })
  })

  it('13. propose: NOT_GOAL for a deliver; three proposals on the owner for a goal; PROPOSAL_OPEN the second time', () => {
    const r = rig()
    const e = arrive(r)
    r.commit(turn(e), input(e))
    expect(r.propose(turn(e), { goal_id: 'C-1', items: [{ what: 'a', intent: 'a', done_when: 'a' }] })).toMatchObject({ ok: false, code: 'NOT_GOAL' })
    const goal = r.t.ledger.open(tx => tx.propose('host', { kind: 'goal', debtor: 'me', creditor: OWNER, ball: 'me', origin_ref: 'host:goal:q4',
      what: 'ship Q4', intent: 'Q4 shipped', check_kind: 'answer', done_when: '要包含 发布清单', desk_id: 'p2p:oc_1', next_look_at: tx.now + 3_600_000 }))
    const items = [1, 2, 3].map(i => ({ what: `step ${i}`, intent: `step ${i} done`, done_when: `要包含 ${i}` }))
    expect(r.propose(turn(e), { goal_id: goal.commitment_id, items })).toMatchObject({ ok: true, commitment_ids: ['C-3', 'C-4', 'C-5'] })
    expect(rows(r, `SELECT state, ball, parent_id FROM sa_commitment WHERE parent_id = ?`, goal.commitment_id))
      .toEqual(Array(3).fill({ state: 'proposed', ball: OWNER, parent_id: goal.commitment_id }))
    expect(r.propose(turn(e), { goal_id: goal.commitment_id, items })).toMatchObject({ ok: false, code: 'PROPOSAL_OPEN' })
  })

  it('14. an ordinal reply approves the proposal and dispatches once; the repeated message is a no-op', async () => {
    const r = rig()
    const goal = r.t.ledger.open(tx => tx.propose('host', { kind: 'goal', debtor: 'me', creditor: OWNER, ball: 'me', origin_ref: 'host:goal:x',
      what: 'goal', intent: 'goal', check_kind: 'answer', done_when: '要包含 x', desk_id: 'p2p:oc_1', next_look_at: tx.now + 3_600_000 }))
    r.propose(turn(arrive(r)), { goal_id: goal.commitment_id, items: [{ what: 'first', intent: 'first', done_when: '要包含 1' }, { what: 'second', intent: 'second', done_when: '要包含 2' }] })
    const reply = inboundEvent({ text: '1', received_at: r.t.clock.now() })
    seedInbound(r.t.db, { event_id: reply.event_id })
    const claim = createClaim(r.t.ledger)
    const decision = { owner: 'superagent' as const, route: 'fastpath' as const, disposition: 'commit' as const, detail: { ordinals: [1], target: 'proposal' } }
    for (let i = 0; i < 2; i++) {
      const res = claim.claim(reply, { decide: () => decision }, 'superagent')
      if (res.status === 'claimed') await applyFastpath(r.fastDeps, reply, decision)
    }
    await r.dispatcher.settle()
    expect(rows(r, `SELECT what, state FROM sa_commitment WHERE parent_id = ? ORDER BY n`, goal.commitment_id))
      .toEqual([{ what: 'first', state: 'open' }, { what: 'second', state: 'proposed' }])
    expect(calls(r, 'create')).toHaveLength(1)
    expect(one(r, `SELECT disposition FROM sa_intake WHERE event_id = ?`, reply.event_id).disposition).toBe('commit')
    await expect(applyFastpath(r.fastDeps, reply, { ...decision, detail: { ordinals: [9] } })).rejects.toThrow(/ORDINAL_OUT_OF_RANGE/)
  })

  it('15. a shadow commit writes no commitment or attempt; the shadow intake is disposed as commit', () => {
    const r = rig()
    const e = arrive(r, {}, { shadow: 1 })
    const ops: NonNullable<JudgmentTurn['shadowOps']> = []
    expect(r.commit(turn(e, { shadow: true, shadowOps: ops }), input(e))).toMatchObject({ ok: true, commitment_id: 'shadow' })
    expect(rows(r, 'SELECT * FROM sa_commitment')).toHaveLength(0)
    expect(rows(r, 'SELECT * FROM sa_attempt')).toHaveLength(0)
    expect(rows(r, 'SELECT shadow, disposition FROM sa_intake')).toEqual([{ shadow: 1, disposition: 'commit' }])
    expect(ops.map(o => o.tool)).toEqual(['commit'])
  })

  it('16. follow-up after delivery: a child of the fulfilled C-1 with its conclusion as prior; one top-level deliver on the thread', () => {
    const r = rig()
    const e1 = arrive(r, { thread: 'om_root' })
    r.commit(turn(e1), input(e1))
    r.t.ledger.open(tx => tx.transition('C-1', 'fulfilled', { evidence_json: '{"command":"pnpm test","exit":0}' }))
    const e2 = arrive(r, { thread: 'om_root' }, { about: 'C-1' })
    expect(r.commit(turn(e2), input(e2, { what: 'also fix lint' }))).toMatchObject({ ok: true, commitment_id: 'C-2' })
    expect(one(r, `SELECT parent_id FROM sa_commitment WHERE commitment_id = 'C-2'`).parent_id).toBe('C-1')
    const brief = String(one(r, `SELECT body_json FROM sa_journal WHERE commitment_id = 'C-2' AND kind = 'brief'`).body_json)
    expect(brief).toContain('接续 C-1（fulfilled）')
    expect(brief).toContain('pnpm test')
    expect(one(r, `SELECT count(*) AS n FROM sa_commitment WHERE thread_key = ? AND kind = 'deliver' AND parent_id IS NULL`, `p2p:oc_1:om_root`).n).toBe(1)
    // 02 reading: no decline without reason and alternative.
    expect(one(r, `SELECT count(*) AS n FROM sa_intake WHERE disposition = 'decline' AND (reason IS NULL OR alternative IS NULL)`).n).toBe(0)
  })
})

describe('attributeTurnEnd', () => {
  it('names the refusing commit and keeps the code under the tool that refused', async () => {
    const { attributeTurnEnd } = await import('../src/host/services/superagent/judgment/translate.ts')
    expect(attributeTurnEnd('unknown', [{ tool: 'judge', ok: true }, { tool: 'commit', ok: false, code: 'EXECUTOR_UNKNOWN' }]))
      .toEqual({ end_reason: 'error', commit: { ok: false, code: 'EXECUTOR_UNKNOWN' } })
    // A refused look explains the end too, but its code must not be filed as a commit.
    expect(attributeTurnEnd('unknown', [{ tool: 'look', ok: false, code: 'MISSING' }]))
      .toEqual({ end_reason: 'error' })
    // A protocol reason wins over any tool trace.
    expect(attributeTurnEnd('completed', [{ tool: 'commit', ok: false, code: 'X' }]))
      .toEqual({ end_reason: 'completed' })
  })
})
