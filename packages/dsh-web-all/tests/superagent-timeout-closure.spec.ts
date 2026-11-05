/**
 * T31: the three real gaps the T29 ledger found, asserted on what a person can
 * observe - an outbox row, a journal row, an attempt's state - not on internal
 * fields.
 *
 *   1. a turn abandoned by the timeout closes with a line, and the ledger can tell
 *      it apart from a normal failure (journal body `{closed:'timeout'}`, since
 *      END_REASONS is a closed protocol set, N6);
 *   2. one attempt accepts a bounded number of steers; beyond it the input waits
 *      for the next attempt's brief instead of interleaving forever;
 *   3. a session that never comes up is tried a bounded number of times, explained
 *      once, and then left to the agenda instead of looping silently.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createPresence,
  deskSessionId,
  MAX_SESSION_FAILURES,
  PENDING_CLOSE_RETRY_MS,
  sessionFailureMessage,
  TURN_TIMEOUT_MESSAGE,
  TURN_TIMEOUT_MS,
  type DeskConfig,
} from '../src/host/services/superagent/desk/presence.ts'
import type { DeskTool, ToolFace } from '../src/host/services/superagent/desk/toolface.ts'
import {
  createExecutors,
  MAX_STEER_PER_ATTEMPT,
  recordPendingAttempt,
} from '../src/host/services/superagent/executors/attempts.ts'
import { inputMarker } from '../src/host/services/superagent/executors/events.ts'
import { createProfileRegistry, PROFILES, type Profile } from '../src/host/services/superagent/executors/profiles/index.ts'
import { DURABLE_FULL } from '../src/host/services/superagent/executors/profiles/durable-full.ts'
import { createLease } from '../src/host/services/superagent/kernel/lease.ts'
import type { NewCommitment } from '../src/host/services/superagent/kernel/ledger.ts'
import { createOutlet } from '../src/host/services/superagent/kernel/outlet.ts'
import type { OutletPolicy } from '../src/host/services/superagent/kernel/ports.ts'
import type { MemoryLog } from '../src/host/services/superagent/memory/log.ts'
import { remember as rememberRow } from '../src/host/services/superagent/memory/log.ts'
import type { InboundEvent } from '../src/host/services/superagent/protocol/events.ts'
import { DEFAULT_TABLE } from '../src/host/services/superagent/world/defaults.ts'
import { createWorldRegistry } from '../src/host/services/superagent/world/registry.ts'
import { createFakeController, type FakeController } from './fixtures/superagent/fake-controller.ts'
import { deliverSpec, inboundEvent, openTestLedger, seedCommitment, type TestLedger } from './fixtures/superagent/ledger.ts'
import { seedInbound } from './fixtures/superagent/memdb.ts'

const OWNER = 'on_owner'
const MIN = 60_000
const SID = deskSessionId('p2p:oc_1', 0)
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

// ---------------------------------------------------------------------------
// Desk presence rig (same wiring as the T20 presence spec, reduced)
// ---------------------------------------------------------------------------

interface DeskRig {
  t: TestLedger
  controller: FakeController
  presence: ReturnType<typeof createPresence>
  tools: Map<string, DeskTool[]>
  lease: ReturnType<typeof createLease>
  mode: { value: 'responder' | 'shadow' | 'superagent' }
}

function deskRig(): DeskRig {
  const t = openTestLedger()
  const controller = createFakeController()
  const tools = new Map<string, DeskTool[]>()
  const toolface: ToolFace = {
    async apply(sid, list) { tools.set(sid, [...list]); return () => { tools.delete(sid) } },
    async visible(sid) { return (tools.get(sid) ?? []).map(x => x.name) },
  }
  const lease = createLease(t.ledger)
  lease.acquire('proc', t.clock.now())
  const outlet = createOutlet(t.ledger, lease, 'proc')
  const policy: OutletPolicy = { check: p => ({ ok: true, tier: 'reply', text: p.text, words: p.payload === 'react' ? 0 : 4 }) }
  const memory: MemoryLog = {
    remember: (entry, trigger) => t.ledger.open(tx => rememberRow(tx, entry, trigger), { module: 'memory' }),
    recall: () => [], visibility: () => undefined, promoteCandidates: () => [], applyPromotion: () => undefined,
    disclosures: () => [], retireStale: () => 0,
  }
  const cfg: DeskConfig = { seatDir: '/seat', preset: 'superagent-desk', idleEvictMs: 30 * MIN, rotateEvents: 4000,
    collectWindowMs: 3000, dossierTokens: 6000, owner: OWNER, tz: 'UTC' }
  const mode = { value: 'superagent' as 'responder' | 'shadow' | 'superagent' }
  const presence = createPresence({
    ledger: t.ledger, controller: () => controller, clock: t.clock,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    memory, docs: { read: () => ({ text: 'doc', truncated: false }) }, outlet, outletPolicy: policy, mode: () => mode.value,
    handlers: {}, toolface, config: () => cfg,
    degrade: e => t.ledger.open(tx => tx.run(
      `INSERT INTO sa_degrade_event (degrade_id, reason, scope, started_at, created_at) VALUES (?, ?, ?, ?, ?)`,
      `dg-${e.now}-${e.scope}-${Math.random().toString(16).slice(2, 8)}`, e.reason, e.scope, e.now, e.now),
    { module: 'recovery' }),
  })
  return { t, controller, presence, tools, lease, mode }
}

function deliver(r: DeskRig, over: Partial<InboundEvent> = {}): InboundEvent {
  const e = inboundEvent({ received_at: r.t.clock.now(), ...over })
  seedInbound(r.t.db, { event_id: e.event_id, received_at: e.received_at })
  const sender = e.sender.union_id ?? e.sender.open_id
  r.t.ledger.open(tx => tx.insertIntake({ event_id: e.event_id, shadow: r.mode.value === 'shadow' ? 1 : 0,
    owner: 'superagent', sender, thread_key: `${e.chat.type}:${e.chat.id}:${e.thread}`,
    desk_id: `${e.chat.type}:${e.chat.id}` }), { module: 'kernel' })
  r.presence.enqueue(e)
  return e
}

const closeWindow = async (r: DeskRig): Promise<void> => { r.t.clock.advance(3000); await r.presence.tick(r.t.clock.now()) }
const call = (r: DeskRig, name: string, input: unknown) =>
  (r.tools.get(SID)?.find(x => x.name === name) as DeskTool).execute(input, { sessionId: SID }) as Promise<Record<string, unknown>>
const rows = (r: { t: TestLedger }, sql: string): Array<Record<string, unknown>> => r.t.db.prepare(sql).all() as Array<Record<string, unknown>>
const creates = (r: DeskRig) => r.controller.calls.filter(c => c.method === 'create')

// ---------------------------------------------------------------------------
// Executors rig (same wiring as the T19 dispatch spec, reduced)
// ---------------------------------------------------------------------------

interface ExecRig {
  t: TestLedger
  controller: FakeController
  ex: ReturnType<typeof createExecutors>
  seatRoot: string
}

function execRig(profiles: readonly Profile[] = PROFILES): ExecRig {
  const t = openTestLedger()
  const seatRoot = mkdtempSync(join(tmpdir(), 'sa-t31-'))
  dirs.push(seatRoot)
  const controller = createFakeController()
  const world = createWorldRegistry({ read: t.ledger.read, clock: t.clock, defaults: DEFAULT_TABLE })
  t.ledger.open(tx => {
    world.registerParty(tx, { party_id: 'ou_owner', union_id: 'on_owner', class: 'owner', source: 'config' })
    world.register(tx, { canonical: 'seat-repo', kind: 'repo', realm: 'local', path: 'local/repo',
      manifest: { executors: profiles.map(p => p.id) } })
    world.grantFromConfig(tx, [{ principal: 'ou_owner', scopePath: 'local/repo', capability: 'write_repo',
      strength: 'allow', grantedBy: 'owner' }], 1)
  }, { module: 'world' })
  const ex = createExecutors({
    ledger: t.ledger, controller: () => controller, world, profiles: createProfileRegistry(profiles), clock: t.clock,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined }, seatRoot,
    speak: () => undefined, askOwner: () => undefined, workspacePath: () => 'local/repo',
  })
  return { t, controller, ex, seatRoot }
}

function commit(r: ExecRig, profile: Profile = DURABLE_FULL, over: Partial<NewCommitment> = {}) {
  return r.t.ledger.open(tx => {
    const c = tx.createCommitment({ ...deliverSpec({ desk_id: 'p2p:oc_1', ...over }), next_look_at: tx.now + 30 * MIN })
    const a = recordPendingAttempt(tx, c.commitment_id, profile, 'repo work fits a durable executor')
    tx.append(c.commitment_id, { actor: 'desk', kind: 'brief', body: { context: 'owner asked in p2p' } })
    return { c, a }
  }, { module: 'executors' })
}

const prompts = (r: ExecRig) => r.controller.calls.filter(c => c.method === 'prompt')
  .map(c => (c as Extract<FakeController['calls'][number], { method: 'prompt' }>).req)
let seq = 0
const ev = (type: string, data: Record<string, unknown>) => ({ type, seq: ++seq, data })

describe('T31 timeout closure and bounded retries', () => {
  it('1. a timed-out turn still closes: one cannot line and a closed:timeout journal row', async () => {
    const r = deskRig()
    seedCommitment(r.t, { desk_id: 'p2p:oc_1' })
    const e = deliver(r)
    await closeWindow(r)
    expect(await call(r, 'judge', { event_id: e.event_id, disposition: 'answer', class: 'chat', confidence: 0.9, reason: 'r' }))
      .toEqual({ ok: true })

    r.t.clock.advance(TURN_TIMEOUT_MS + 1)
    r.lease.acquire('proc', r.t.clock.now())   // the outlet lease expires after 60 s
    await r.presence.tick(r.t.clock.now())
    await r.presence.drain()

    // The person got the ack, then a closing line instead of silence.
    const outbox = rows(r, 'SELECT moment, body FROM sa_outbox ORDER BY rowid')
    expect(outbox.filter(entry => entry.moment === 'cannot')).toEqual([
      { moment: 'cannot', body: TURN_TIMEOUT_MESSAGE },
    ])
    expect(outbox.map(entry => entry.moment)).toEqual(['ack', 'ack', 'cannot'])
    // The ledger can tell an abandoned turn apart without widening END_REASONS.
    const journal = rows(r, 'SELECT body_json FROM sa_journal')
    expect(journal.some(entry => String(entry.body_json).includes('"closed":"timeout"'))).toBe(true)
    const [turn] = rows(r, 'SELECT end_reason, rule_trace FROM sa_deliberation')
    expect(turn.end_reason).toBe('unknown')
    expect(String(turn.rule_trace)).toContain('"closed":"timeout"')
    expect(r.controller.calls.filter(c => c.method === 'cancel')).toHaveLength(1)
  })

  it('2. a shadow turn that times out records the closure and sends nothing', async () => {
    const r = deskRig()
    r.mode.value = 'shadow'
    seedCommitment(r.t, { desk_id: 'p2p:oc_1' })
    const e = deliver(r)
    await closeWindow(r)
    // A shadow judge writes the shadow intake row only; that is what keeps the
    // host fallback from adding an outbox row later.
    expect(await call(r, 'judge', { event_id: e.event_id, disposition: 'answer', class: 'chat', confidence: 0.9, reason: 'r' }))
      .toEqual({ ok: true })

    r.t.clock.advance(TURN_TIMEOUT_MS + 1)
    r.lease.acquire('proc', r.t.clock.now())
    await r.presence.tick(r.t.clock.now())
    await r.presence.drain()

    expect(rows(r, 'SELECT count(*) AS n FROM sa_outbox')).toEqual([{ n: 0 }])
    const [turn] = rows(r, 'SELECT shadow, end_reason, rule_trace FROM sa_deliberation')
    expect(turn).toMatchObject({ shadow: 1, end_reason: 'unknown' })
    expect(String(turn.rule_trace)).toContain('"closed":"timeout"')
    expect(String(turn.rule_trace)).toContain('shadow_ops')
  })

  it('3. one attempt takes five steers, then the input waits for the next attempt brief', async () => {
    const r = execRig()
    const { c, a } = commit(r)
    await r.ex.dispatch(c.commitment_id)
    const sid = 'sa-x-C-1-a1'
    r.ex.onSessionEvent(sid, ev('turn/start', { turn: 1 }))
    const delivered = prompts(r).length

    for (let i = 1; i <= MAX_STEER_PER_ATTEMPT; i += 1) {
      expect(await r.ex.sendInput(a.attempt_id, `req-${i}`, `steer ${i}`)).toEqual({ mode: 'steer' })
    }
    expect(prompts(r)).toHaveLength(delivered + MAX_STEER_PER_ATTEMPT)

    // Sixth input for the same attempt: not delivered to the live turn.
    expect(await r.ex.sendInput(a.attempt_id, 'req-6', 'steer 6')).toEqual({ mode: 'queue' })
    expect(prompts(r)).toHaveLength(delivered + MAX_STEER_PER_ATTEMPT)

    // Nothing is dropped: six journal rows, one request id each, the last unconsumed.
    const inputs = rows(r, `SELECT request_id, consumed_turn FROM sa_journal WHERE kind = 'amend' ORDER BY seq`)
    expect(inputs).toHaveLength(MAX_STEER_PER_ATTEMPT + 1)
    expect(new Set(inputs.map(entry => entry.request_id)).size).toBe(MAX_STEER_PER_ATTEMPT + 1)
    expect(inputs.at(-1)).toMatchObject({ request_id: 'req-6', consumed_turn: null })

    // The next attempt's brief carries the capped input exactly once.
    r.t.ledger.open(tx => {
      tx.updateAttempt(a.attempt_id, { state: 'ended', end_reason: 'completed' })
      recordPendingAttempt(tx, c.commitment_id, DURABLE_FULL, 'retry after the cap')
    }, { module: 'executors' })
    await r.ex.dispatch(c.commitment_id)
    const brief = prompts(r).at(-1)?.content[0].text ?? ''
    expect(brief).toContain('steer 6')
    expect(brief).toContain(inputMarker('req-6'))
    expect(brief.match(/steer 6/g) ?? []).toHaveLength(1)
  })

  it('4. three failed session creates explain once, keep the batch, and stop looping', async () => {
    const r = deskRig()
    r.controller.failCreate(new Error('host down'))
    deliver(r)

    await closeWindow(r)
    expect(creates(r)).toHaveLength(1)
    await r.presence.tick(r.t.clock.now())
    expect(creates(r)).toHaveLength(2)
    await r.presence.tick(r.t.clock.now())
    expect(creates(r)).toHaveLength(MAX_SESSION_FAILURES)

    // Explained once, in the requester's own words.
    expect(rows(r, 'SELECT moment, body FROM sa_outbox')).toEqual([
      { moment: 'cannot', body: sessionFailureMessage('host down') },
    ])
    // One error row per turn, and the cap is visible on the last one.
    const turns = rows(r, 'SELECT end_reason, rule_trace FROM sa_deliberation ORDER BY rowid')
    expect(turns).toHaveLength(MAX_SESSION_FAILURES)
    expect(turns.every(turn => turn.end_reason === 'error')).toBe(true)
    expect(String(turns.at(-1)?.rule_trace)).toContain('"pending_close":true')
    // Degradation recorded on the first failure and at the cap, not once per retry.
    expect(rows(r, 'SELECT count(*) AS n FROM sa_degrade_event')).toEqual([{ n: 2 }])

    // The batch is kept but backs off: no relaunch inside the window, one after it.
    await r.presence.tick(r.t.clock.now())
    expect(creates(r)).toHaveLength(MAX_SESSION_FAILURES)
    r.t.clock.advance(PENDING_CLOSE_RETRY_MS + 1)
    await r.presence.tick(r.t.clock.now())
    expect(creates(r)).toHaveLength(MAX_SESSION_FAILURES + 1)
    expect(rows(r, 'SELECT count(*) AS n FROM sa_intake')).toEqual([{ n: 1 }])
  })
})
