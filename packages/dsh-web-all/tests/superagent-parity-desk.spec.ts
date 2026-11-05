/**
 * T29 migration targets: the responder behaviours that DO have a desk equivalent.
 *
 * These are the cases the ledger points at. They live here rather than in the desk
 * and executor specs because they exist for one reason - to be the equivalent
 * reading of a specific lark-inbox responder case - and a reader deciding whether
 * `responder.ts` may be deleted should be able to read them next to the ledger.
 *
 * Each test names the responder case it replaces. Where the new mechanism differs
 * (an event-driven turn instead of a synchronous submit), the assertion is on the
 * same observable a person or an operator would see: a turn that closes, a sentence
 * that goes out, evidence that survives a failure, input that is not lost.
 *
 * One detail worth knowing while reading: the protocol's `END_REASONS` is a closed
 * set (N6) with no `timeout`, so a desk turn that expires is closed as `unknown` -
 * which the escalation policy already treats as failure. The responder wrote its own
 * `timeout`; the observable that matters is that the turn is cancelled and closed
 * rather than left running forever.
 */

import { describe, expect, it } from 'vitest'
import {
  ACK_TEMPLATE, ACK_TEMPLATE_MS, createPresence, deskSessionId, TURN_TIMEOUT_MS, type DeskConfig,
} from '../src/host/services/superagent/desk/presence.ts'
import type { DeskTool, ToolFace } from '../src/host/services/superagent/desk/toolface.ts'
import { createExecutors, sessionIdOf, type Executors } from '../src/host/services/superagent/executors/attempts.ts'
import { createProfileRegistry } from '../src/host/services/superagent/executors/profiles/index.ts'
import { createLease, type Lease } from '../src/host/services/superagent/kernel/lease.ts'
import { createOutlet } from '../src/host/services/superagent/kernel/outlet.ts'
import type { OutletPolicy } from '../src/host/services/superagent/kernel/ports.ts'
import { remember as rememberRow, type MemoryLog } from '../src/host/services/superagent/memory/log.ts'
import type { InboundEvent } from '../src/host/services/superagent/protocol/events.ts'
import { createFakeController, type FakeController } from './fixtures/superagent/fake-controller.ts'
import { inboundEvent, openTestLedger, seedAttempt, seedCommitment, type TestLedger } from './fixtures/superagent/ledger.ts'
import { seedInbound } from './fixtures/superagent/memdb.ts'

const OWNER = 'on_owner'
const MIN = 60_000
const SID = deskSessionId('p2p:oc_1', 0)

// ---------------------------------------------------------------------------
// Desk rig: one desk, a controller whose prompt the test can hold or fail.
// ---------------------------------------------------------------------------

interface Gate {
  promise: Promise<void>
  open(): void
}

function gate(): Gate {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open: () => open() }
}

interface Rig {
  t: TestLedger
  lease: Lease
  controller: FakeController
  presence: ReturnType<typeof createPresence>
  tools: Map<string, DeskTool[]>
  holdPrompt: { gate?: Gate; onPrompt?: () => void }
  /** The keeper's job: a real host beats every 15 s, and the lease dies after 60 s. */
  beat(): void
}

function rig(options: { lease?: boolean; refuseReact?: boolean } = {}): Rig {
  const t = openTestLedger()
  const controller = createFakeController()
  const tools = new Map<string, DeskTool[]>()
  const holdPrompt: { gate?: Gate; onPrompt?: () => void } = {}
  const refuseReact = options.refuseReact === true
  const toolface: ToolFace = {
    async apply(sid, list) { tools.set(sid, [...list]); return () => { tools.delete(sid) } },
    async visible(sid) { return (tools.get(sid) ?? []).map(x => x.name) },
  }
  const lease = createLease(t.ledger)
  if (options.lease !== false) lease.acquire('proc', t.clock.now())
  const outlet = createOutlet(t.ledger, lease, 'proc')
  const policy: OutletPolicy = {
    check: p => (refuseReact && p.payload === 'react'
      ? { ok: false as const, code: 'MOMENT_FORBIDDEN' as const, message: 'reaction refused for this test' }
      : { ok: true as const, tier: 'reply' as const, text: p.text, words: p.payload === 'react' ? 0 : 2 }),
  }
  const memory: MemoryLog = {
    remember: (entry, trigger) => t.ledger.open(tx => rememberRow(tx, entry, trigger), { module: 'memory' }),
    recall: () => [], visibility: () => undefined, promoteCandidates: () => [], applyPromotion: () => undefined,
    disclosures: () => [], retireStale: () => 0,
  }
  const cfg: DeskConfig = { seatDir: '/seat', preset: 'superagent-desk', idleEvictMs: 30 * MIN, rotateEvents: 4000,
    collectWindowMs: 3000, dossierTokens: 6000, owner: OWNER, tz: 'UTC' }
  const controllerFace = {
    create: (req: Parameters<FakeController['create']>[0]) => controller.create(req),
    prompt: async (req: Parameters<FakeController['prompt']>[0], signal: AbortSignal) => {
      holdPrompt.onPrompt?.()
      const held = holdPrompt.gate
      if (held !== undefined) await held.promise
      return await controller.prompt(req, signal)
    },
    cancel: (req: { sessionId: string }) => controller.cancel(req),
    inspect: (sid: string) => controller.inspect(sid),
  }
  const presence = createPresence({
    ledger: t.ledger, controller: () => controllerFace, clock: t.clock,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    memory, docs: { read: () => ({ text: 'doc', truncated: false }) }, outlet, outletPolicy: policy,
    mode: () => 'superagent', handlers: {}, toolface, config: () => cfg,
    degrade: e => t.ledger.open(tx => tx.run(`INSERT INTO sa_degrade_event (degrade_id, reason, scope, started_at, created_at) VALUES (?, ?, ?, ?, ?)`,
      `dg-${e.now}-${e.scope}`, e.reason, e.scope, e.now, e.now), { module: 'recovery' }),
  })
  return { t, lease, controller, presence, tools, holdPrompt, beat: () => { lease.heartbeat('proc', t.clock.now()) } }
}

/** Seed what claim would have written, then hand the event to the desk. */
function deliver(r: Rig, over: Partial<InboundEvent> = {}): InboundEvent {
  const e = inboundEvent({ received_at: r.t.clock.now(), ...over })
  seedInbound(r.t.db, { event_id: e.event_id, received_at: e.received_at })
  r.t.ledger.open(tx => tx.insertIntake({ event_id: e.event_id, shadow: 0, owner: 'superagent',
    sender: e.sender.union_id ?? e.sender.open_id, thread_key: `${e.chat.type}:${e.chat.id}:${e.thread}`,
    desk_id: `${e.chat.type}:${e.chat.id}` }))
  r.presence.enqueue(e)
  return e
}

const deliberations = (r: Rig) => r.t.db.prepare('SELECT deliberation_id, state, end_reason, rule_trace FROM sa_deliberation ORDER BY deliberation_id')
  .all() as unknown as Array<{ deliberation_id: string; state: string; end_reason: string | null; rule_trace: string | null }>
const outbox = (r: Rig) => r.t.db.prepare('SELECT payload, body, moment, tier FROM sa_outbox ORDER BY outbox_id')
  .all() as unknown as Array<{ payload: string; body: string; moment: string; tier: string }>
const prompts = (r: Rig) => r.controller.calls.filter(c => c.method === 'prompt')

/** Close the 3 second collect window so the desk launches its turn. */
async function launchTurn(r: Rig): Promise<void> {
  r.t.clock.advance(3000)
  await r.presence.tick(r.t.clock.now())
}

// ---------------------------------------------------------------------------
// Desk cases
// ---------------------------------------------------------------------------

describe('T29 equivalents: desk turn lifecycle', () => {
  it('replaces "captures a turn that finishes before the prompt call returns": an end that arrives while the prompt is still out still closes the turn', async () => {
    const r = rig()
    const held = gate()
    r.holdPrompt.gate = held
    // The turn's own end arrives inside the prompt call, before it returns.
    r.holdPrompt.onPrompt = () => r.presence.onSessionEvent(SID, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } })
    deliver(r)
    r.t.clock.advance(3000)
    const pending = r.presence.tick(r.t.clock.now())
    await Promise.resolve()
    held.open()
    await pending
    await r.presence.drain()

    const rows = deliberations(r)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.end_reason).toBe('completed')
  })

  it('replaces "closes a prompt that never opens a turn as a timeout instead of waiting forever": an expired turn is cancelled and closed', async () => {
    const r = rig()
    deliver(r)
    await launchTurn(r)
    // The prompt was accepted but no turn end ever arrives.
    expect(prompts(r)).toHaveLength(1)

    r.beat()
    r.t.clock.advance(TURN_TIMEOUT_MS)
    r.beat()
    await r.presence.tick(r.t.clock.now())
    await r.presence.drain()

    expect(r.controller.calls.filter(c => c.method === 'cancel')).toHaveLength(1)
    const closed = deliberations(r)[0]
    expect(closed?.state).toBe('done')
    // END_REASONS has no 'timeout'; the desk closes it as unknown, which escalation
    // already treats as failure. The turn is closed, not left running.
    expect(closed?.end_reason).toBe('unknown')
  })

  it('replaces "cancels an expired turn... and ignores its late end": the late end does not close the turn a second time', async () => {
    const r = rig()
    deliver(r)
    await launchTurn(r)
    r.t.clock.advance(TURN_TIMEOUT_MS)
    r.beat()
    await r.presence.tick(r.t.clock.now())
    await r.presence.drain()
    const first = deliberations(r)[0]

    // The cancelled turn reports its end afterwards; nothing may change.
    r.presence.onSessionEvent(SID, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'aborted' } } })
    await r.presence.drain()

    expect(deliberations(r)).toHaveLength(1)
    expect(deliberations(r)[0]).toEqual(first)
  })

  it('replaces "puts a job whose prompt threw before binding a turn back into the batch": a rejected prompt requeues and the next round delivers it', async () => {
    const r = rig()
    deliver(r)
    r.controller.failPrompt(new Error('engine offline'))
    r.t.clock.advance(3000)
    await r.presence.tick(r.t.clock.now())
    await r.presence.drain()
    expect(deliberations(r).at(-1)?.end_reason).toBe('error')
    expect(prompts(r)).toHaveLength(1)

    // The same message is tried again once the engine answers; it was never dropped.
    r.controller.failPrompt(undefined)
    r.t.clock.advance(3000)
    await r.presence.tick(r.t.clock.now())
    expect(prompts(r)).toHaveLength(2)
    r.presence.onSessionEvent(SID, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
    await r.presence.drain()
    expect(deliberations(r)).toHaveLength(2)
  })
})

describe('T29 equivalents: an answer that survives its own failure', () => {
  it('replaces "still answers in words when the reaction cannot be given": the acknowledgement in words goes out although the reaction was refused', async () => {
    const r = rig({ refuseReact: true })
    deliver(r)
    await launchTurn(r)

    r.beat()
    r.t.clock.advance(ACK_TEMPLATE_MS)
    r.beat()
    await r.presence.tick(r.t.clock.now())

    const sent = outbox(r)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.payload).toBe('text')
    expect(sent[0]?.body).toBe(ACK_TEMPLATE)
  })

  it('replaces "leaves evidence even when the fallback itself cannot close the job": the deliberation row survives an utterance the outlet refuses', async () => {
    const r = rig({ lease: false })
    deliver(r)
    await launchTurn(r)
    r.t.clock.advance(ACK_TEMPLATE_MS)
    await r.presence.tick(r.t.clock.now())
    r.presence.onSessionEvent(SID, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } })
    await r.presence.drain()

    // No lease means nothing could be said; the turn is still recorded with its trace.
    expect(outbox(r)).toHaveLength(0)
    const rows = deliberations(r)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.end_reason).toBe('completed')
    expect(rows[0]?.rule_trace).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Executor rig: input (steer) delivery
// ---------------------------------------------------------------------------

interface ExecRig {
  t: TestLedger
  controller: FakeController
  executors: Executors
  attemptId: string
  sessionId: string
  commitmentId: string
}

function execRig(): ExecRig {
  const t = openTestLedger()
  const controller = createFakeController()
  const commitment = seedCommitment(t)
  const attempt = seedAttempt(t, commitment.commitment_id, { executor: 'oneshot-read', lifetime: 'oneshot' })
  const sessionId = sessionIdOf(commitment.commitment_id, attempt.n)
  t.ledger.open(tx => tx.updateAttempt(attempt.attempt_id, {
    state: 'running', session_id: sessionId, started_at: t.clock.now(), last_tool_at: t.clock.now(),
  }))
  const executors = createExecutors({
    ledger: t.ledger, controller: () => controller,
    world: { place: () => ({ realm: 'local' as const, workspace: 'new' as const, scopePath: '/tmp/seat/work' }), registerWorkspace: () => {} },
    profiles: createProfileRegistry(), clock: t.clock,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined }, seatRoot: '/tmp/seat',
  })
  return { t, controller, executors, attemptId: attempt.attempt_id, sessionId, commitmentId: commitment.commitment_id }
}

describe('T29 equivalents: input the engine never took', () => {
  it('replaces "returns a steer the engine never took to the next batch": a refused steer is queued and stays as evidence for the next attempt', async () => {
    const r = execRig()
    await r.controller.create({ sessionId: r.sessionId })
    r.controller.failPrompt(new Error('turn refused'))

    const sent = await r.executors.sendInput(r.attemptId, 'req-1', 'plus one more thing')

    expect(sent.mode).toBe('queue')
    const amend = r.t.db.prepare("SELECT request_id, body_json FROM sa_journal WHERE kind = 'amend' AND request_id = 'req-1'").get() as
      { request_id: string; body_json: string } | undefined
    expect(amend?.request_id).toBe('req-1')
    expect(amend?.body_json).toContain('plus one more thing')
    // Delivered once: a second call with the same request id writes nothing new.
    await r.executors.sendInput(r.attemptId, 'req-1', 'plus one more thing')
    const count = r.t.db.prepare("SELECT count(*) AS k FROM sa_journal WHERE kind = 'amend' AND request_id = 'req-1'").get() as { k: number }
    expect(Number(count.k)).toBe(1)
  })

  it('replaces "does not extend the turn deadline by taking a steer": taking input changes neither the wall budget nor the extension flag', async () => {
    const r = execRig()
    await r.controller.create({ sessionId: r.sessionId })
    const read = () => r.t.db.prepare('SELECT budget_wall_ms, extended FROM sa_commitment WHERE commitment_id = ?')
      .get(r.commitmentId) as { budget_wall_ms: number; extended: number }
    const before = read()

    const sent = await r.executors.sendInput(r.attemptId, 'req-2', 'one more line')

    expect(sent.mode).toBe('queue')
    expect(read()).toEqual(before)
  })
})