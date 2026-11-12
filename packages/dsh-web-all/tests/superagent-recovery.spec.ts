/**
 * Recovery: order, reconciliation, degradation and the second voice.
 *
 * Each test is a way this module has to fail silently: a startup that connects new
 * triggers before the ledger is reconciled, a reconciliation that kills live work,
 * one that only runs at startup (FMEA-4), a degradation nobody can read, a redo that
 * asks the owner a question it promised never to ask (G5), and a second instance
 * answering the same message eight times (F34).
 *
 * Fixtures are the real kernel (`createLease`, `createOutlet`, `createEscalation`)
 * and the real executor dispatch; closure and presence are spied, because what
 * recovery owes them is "called exactly once" and "called with this id", not their
 * own behaviour, which their own specs cover.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createManualClock, type ManualClock } from './fixtures/superagent/manual-clock.ts'
import { openTestLedger, seedAttempt, seedCommitment } from './fixtures/superagent/ledger.ts'
import { createFakeController, type FakeController } from './fixtures/superagent/fake-controller.ts'
import { seedInbound } from './fixtures/superagent/memdb.ts'
import { createLease, LEASE_EXPIRY_MS, type Lease } from '../src/host/services/superagent/kernel/lease.ts'
import { createOutlet, type Outlet } from '../src/host/services/superagent/kernel/outlet.ts'
import { createEscalation, type Escalation } from '../src/host/services/superagent/executors/escalate.ts'
import { createExecutors, sessionIdOf, type Executors } from '../src/host/services/superagent/executors/attempts.ts'
import { createProfileRegistry } from '../src/host/services/superagent/executors/profiles/index.ts'
import { createLeaseKeeper } from '../src/host/services/superagent/recovery/lease-keeper.ts'
import { createDegrades } from '../src/host/services/superagent/recovery/degrade.ts'
import {
  createRecovery,
  resolveRole,
  sweepUnownedSessions,
  type Recovery,
  type RecoveryPresence,
} from '../src/host/services/superagent/recovery/startup.ts'
import { promoteOwnerProposals } from '../src/host/services/superagent/recovery/owner-ball.ts'
import type { HistoryRow } from '../src/host/services/superagent/recovery/second-voice.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'web-all-superagent-recovery-'))
  roots.push(root)
  return root
}

const HOLDER = 'host-a'
const OWNER = 'on_owner'

interface Harness {
  clock: ManualClock
  db: ReturnType<typeof openTestLedger>['db']
  ledger: ReturnType<typeof openTestLedger>['ledger']
  lease: Lease
  outlet: Outlet
  controller: FakeController
  escalation: Escalation
  executors: Executors
  recovery: Recovery
  presence: RecoveryPresence
  order: string[]
  ask: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  rotate: ReturnType<typeof vi.fn>
  startupCheck: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  /** Build a second recovery over the same ledger, as a process restart would. */
  remount(): Recovery
}

interface MountOptions {
  /** Presence answers; defaults to "every desk is fine". */
  presence?: Partial<RecoveryPresence>
  /** Inbox history reader; absent means P6 is not verified. */
  history?: (chatId: string, limit: number) => Promise<readonly HistoryRow[]>
  /** Lease identity; a different one simulates a second process. */
  holder?: string
}

function mount(options: MountOptions = {}): Harness {
  const clock = createManualClock(1_762_300_000_000)
  const { ledger, db } = openTestLedger(clock)
  const seatRoot = tempDir()
  const order: string[] = []
  const warn = vi.fn()
  const log = { info: vi.fn(), warn, error: vi.fn() }
  const ask = vi.fn()

  const base = createLease(ledger)
  const lease: Lease = {
    acquire(holder, now) {
      order.push('acquire')
      return base.acquire(holder, now)
    },
    heartbeat: (holder, now) => base.heartbeat(holder, now),
    current: () => base.current(),
  }
  const outlet = createOutlet(ledger, lease, options.holder ?? HOLDER)
  const controller = createFakeController()
  const profiles = createProfileRegistry()
  const escalation = createEscalation({ ledger, profiles, clock, ask })
  const executors = createExecutors({
    ledger,
    controller: () => controller,
    world: {
      place: () => ({ realm: 'local' as const, workspace: 'new' as const, scopePath: join(seatRoot, 'work') }),
      registerWorkspace: () => {},
    },
    profiles,
    clock,
    log,
    seatRoot,
  })
  const close = vi.fn()
  const rotate = vi.fn()
  const startupCheck = vi.fn(async () => {
    order.push('selfCheck')
    return { enabled: [], disabled: [] }
  })
  const presence: RecoveryPresence = {
    startupCheck,
    rotate,
    roleOf: () => undefined,
    settleStaleTurns: () => 0,
    ...options.presence,
  }

  const build = (): Recovery => createRecovery({
    ledger,
    lease,
    holder: options.holder ?? HOLDER,
    clock,
    log,
    controller: () => controller,
    executors,
    closure: { close },
    escalation,
    presence,
    outlet,
    profiles,
    owner: () => OWNER,
    ...(options.history === undefined ? {} : { channelHistory: options.history }),
  })

  return {
    clock, db, ledger, lease, outlet, controller, escalation, executors,
    recovery: build(), presence, order, ask, close, rotate, startupCheck, warn,
    remount: build,
  }
}

/** A commitment with its n-th attempt open in `running`, quiet for `quietMs`. */
function seedRunning(
  harness: Harness,
  options: { executor?: string; lifetime?: 'oneshot' | 'durable'; quietMs?: number; session?: string | false } = {},
) {
  const commitment = seedCommitment(harness)
  const lifetime = options.lifetime ?? 'oneshot'
  const executor = options.executor ?? (lifetime === 'durable' ? 'durable-full' : 'oneshot-read')
  const attempt = seedAttempt(harness, commitment.commitment_id, { executor, lifetime })
  const quiet = options.quietMs ?? 20 * 60_000
  const now = harness.clock.now()
  const sessionId = sessionIdOf(commitment.commitment_id, attempt.n)
  harness.ledger.open(tx => tx.updateAttempt(attempt.attempt_id, {
    state: 'running',
    session_id: options.session === false ? null : (options.session ?? sessionId),
    started_at: now - quiet,
    last_tool_at: now - quiet,
  }))
  return { commitment, attemptId: attempt.attempt_id, sessionId }
}

function outboxRows(harness: Harness) {
  return harness.db.prepare('SELECT idem_key, moment, tier, state FROM sa_outbox ORDER BY created_at, outbox_id')
    .all() as unknown as Array<{ idem_key: string; moment: string; tier: string; state: string }>
}

function degradeRows(harness: Harness) {
  return harness.db.prepare('SELECT reason, scope, ended_at FROM sa_degrade_event ORDER BY started_at, degrade_id')
    .all() as unknown as Array<{ reason: string; scope: string; ended_at: number | null }>
}

function attemptStates(harness: Harness, commitmentId: string) {
  return harness.db.prepare('SELECT attempt_id, state, end_reason, cancel_origin FROM sa_attempt WHERE commitment_id = ? ORDER BY n')
    .all(commitmentId) as unknown as Array<{ attempt_id: string; state: string; end_reason: string | null; cancel_origin: string | null }>
}

describe('startup: the fixed order', () => {
  it('takes the lease, then reconciles, then self-checks the desks, and only then returns', async () => {
    const harness = mount()
    // One stale attempt whose session is gone forces reconciliation to reach the
    // controller; without it the order would be unobservable and unchecked.
    // The id is set but no such session exists in the controller, so reconciliation
    // reaches `inspect` - which is where the order becomes observable.
    const seeded = seedRunning(harness)
    const inspect = vi.spyOn(harness.controller, 'inspect')
    inspect.mockImplementation(async (sessionId: string) => {
      harness.order.push('inspect')
      throw new Error(`unknown session ${sessionId}`)
    })

    const report = await harness.recovery.startup()

    expect(harness.order).toEqual(['acquire', 'inspect', 'selfCheck'])
    expect(report.reconciled.orphaned).toBe(1)
    expect(report.leaseHeld).toBe(true)
    expect(attemptStates(harness, seeded.commitment.commitment_id)[0]?.end_reason).toBe('orphaned')
  })

  it('starts without the lease, writes one lease_not_held row, and the outlet refuses every send', async () => {
    const harness = mount()
    harness.lease.acquire('host-b', harness.clock.now())
    const report = await harness.recovery.startup()

    expect(report.leaseHeld).toBe(false)
    expect(degradeRows(harness).filter(row => row.reason === 'lease_not_held')).toHaveLength(1)

    const submitted = harness.outlet.submit({
      chat_id: 'oc_1', moment: 'brief', audience: 'owner', payload: 'text',
      text: 'x', idem_key: 'probe-1',
    }, { check: () => ({ ok: true, tier: 'brief', text: 'x', words: 1 }) }, 'superagent')
    expect(submitted).toMatchObject({ ok: false, code: 'NO_LEASE' })
  })
})

describe('reconcile: repair without killing', () => {
  it('marks a lost session orphaned, keeps the live one, and redoes it on the next round with one brief line', async () => {
    const harness = mount()
    harness.lease.acquire(HOLDER, harness.clock.now())
    const lost = seedRunning(harness, { session: false })
    const live = seedRunning(harness)
    await harness.controller.create({ sessionId: live.sessionId })

    const first = await harness.recovery.reconcile(harness.clock.now())
    expect(first).toMatchObject({ orphaned: 1, closed: 0, healed: 0 })
    expect(attemptStates(harness, lost.commitment.commitment_id)[0]).toMatchObject({ state: 'ended', end_reason: 'orphaned', cancel_origin: 'reconcile' })
    expect(attemptStates(harness, live.commitment.commitment_id)[0]?.state).toBe('running')

    // Only a second round may redo it: the mark is the evidence, the recheck is the proof.
    const second = await harness.recovery.reconcile(harness.clock.now())
    expect(second.healed).toBe(1)
    const states = attemptStates(harness, lost.commitment.commitment_id)
    expect(states).toHaveLength(2)
    expect(states[1]?.state).toBe('running')

    const briefs = outboxRows(harness).filter(row => row.idem_key.startsWith('orphan:'))
    expect(briefs).toHaveLength(1)
    expect(briefs[0]?.idem_key).toBe(`orphan:${lost.commitment.commitment_id}:${lost.attemptId}`)
    expect(briefs[0]?.moment).toBe('brief')
  })

  it('does not redo anything on the first round, and produces no question for an ordinary orphan', async () => {
    const harness = mount()
    const lost = seedRunning(harness)

    await harness.recovery.reconcile(harness.clock.now())

    // "Mark only": the first round does record the loss, and stops there.
    expect(attemptStates(harness, lost.commitment.commitment_id)).toEqual([
      expect.objectContaining({ state: 'ended', end_reason: 'orphaned', cancel_origin: 'reconcile' }),
    ])
    expect(outboxRows(harness)).toHaveLength(0)
    // G5: an orphan with nothing at risk is redone silently, never asked about.
    expect(harness.ask).toHaveBeenCalledTimes(0)
  })

  it('asks nothing about an ordinary orphan: the redo is a brief line, not a question', async () => {
    const harness = mount()
    harness.lease.acquire(HOLDER, harness.clock.now())
    const lost = seedRunning(harness)

    await harness.recovery.reconcile(harness.clock.now())
    await harness.recovery.reconcile(harness.clock.now())

    // G5's reading in its own words: no asked assumption, and no commitment left
    // holding an orphan state that a question was supposed to resolve.
    expect(harness.ask).toHaveBeenCalledTimes(0)
    const assumptions = harness.db.prepare('SELECT count(*) AS k FROM sa_assumption WHERE commitment_id = ?')
      .get(lost.commitment.commitment_id) as unknown as { k: number }
    expect(Number(assumptions.k)).toBe(0)
    const orphaned = harness.db.prepare("SELECT count(*) AS k FROM sa_commitment WHERE state = 'orphaned' AND closed_at IS NULL")
      .get() as unknown as { k: number }
    expect(Number(orphaned.k)).toBe(0)
    expect(outboxRows(harness).filter(row => row.idem_key.startsWith('orphan:'))).toHaveLength(1)
  })

  it('closes a session whose last turn ended instead of leaving the commitment running', async () => {
    const harness = mount()
    const seeded = seedRunning(harness)
    await harness.controller.create({ sessionId: seeded.sessionId })
    harness.controller.emit(seeded.sessionId, { type: 'turn/start', seq: 1, time: harness.clock.now(), data: { turn: 1 } })
    harness.controller.emit(seeded.sessionId, { type: 'turn/end', seq: 2, time: harness.clock.now(), data: { turn: 1, reason: { kind: 'completed' } } })

    const result = await harness.recovery.reconcile(harness.clock.now())

    expect(result).toMatchObject({ orphaned: 0, closed: 1 })
    expect(harness.close).toHaveBeenCalledTimes(1)
    expect(harness.close).toHaveBeenCalledWith(seeded.attemptId, { reason: 'completed' })
  })

  it('asks instead of redoing when the lost attempt held a work tree, and parks the scene as orphaned', async () => {
    const harness = mount()
    const lost = seedRunning(harness, { lifetime: 'durable', session: false })

    await harness.recovery.reconcile(harness.clock.now())
    const second = await harness.recovery.reconcile(harness.clock.now())

    expect(second.healed).toBe(0)
    expect(harness.ask).toHaveBeenCalledTimes(1)
    expect(String(harness.ask.mock.calls[0]?.[2])).toContain('保留')
    const commitment = harness.db.prepare('SELECT state FROM sa_commitment WHERE commitment_id = ?')
      .get(lost.commitment.commitment_id) as unknown as { state: string }
    expect(commitment.state).toBe('orphaned')
    expect(attemptStates(harness, lost.commitment.commitment_id)).toHaveLength(1)
  })

  it('cancels an executor session that has no attempt row (I3) and leaves the ledger\'s own alone', async () => {
    const harness = mount()
    const seeded = seedRunning(harness)
    await harness.controller.create({ sessionId: 'sa-x-ghost-a1' })
    const cancel = vi.spyOn(harness.controller, 'cancel')

    const cancelled = await sweepUnownedSessions(
      { ledger: harness.ledger, controller: () => harness.controller, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
      ['sa-x-ghost-a1', seeded.sessionId],
      harness.clock.now(),
    )

    expect(cancelled).toEqual(['sa-x-ghost-a1'])
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledWith({ sessionId: 'sa-x-ghost-a1' })
  })

  it('answers the same in-progress set before and after a restart', async () => {
    const harness = mount()
    seedRunning(harness)
    const query = (recoveryLedger: Harness['ledger']): unknown[] => recoveryLedger.read.all(
      'SELECT commitment_id, state FROM sa_commitment ORDER BY commitment_id')
    const before = query(harness.ledger)

    const restarted = harness.remount()
    await restarted.startup()

    expect(query(harness.ledger)).toEqual(before)
  })
})

describe('reconcile: a pending attempt with no live seat is the one thing the agenda never dispatches', () => {
  const holdLease = (harness: Harness) => { harness.lease.acquire(HOLDER, harness.clock.now()) }
  const creates = (harness: Harness) => harness.controller.calls.filter(call => call.method === 'create')

  it('dispatches a commitment whose latest attempt is pending and nothing is running', async () => {
    const harness = mount()
    holdLease(harness)
    const commitment = seedCommitment(harness)
    seedAttempt(harness, commitment.commitment_id, { executor: 'durable-full', lifetime: 'durable' })
    expect(attemptStates(harness, commitment.commitment_id).map(a => a.state)).toEqual(['pending'])

    const result = await harness.recovery.reconcile(harness.clock.now())

    expect(result.flushed).toBe(1)
    expect(attemptStates(harness, commitment.commitment_id).map(a => a.state)).toEqual(['running'])
    expect(creates(harness)).toHaveLength(1)
  })

  it('picks up the queued retry a twice-failed durable dispatch leaves pending (the live C-2 shape)', async () => {
    const harness = mount()
    holdLease(harness)
    const commitment = seedCommitment(harness)
    seedAttempt(harness, commitment.commitment_id, { executor: 'durable-full', lifetime: 'durable' })
    // Two dispatches fail to create a session; the third attempt is written "queued for
    // agenda retry" and returns, with nothing in the agenda to dispatch a pending attempt.
    harness.controller.failCreateTimes(2, new Error('host busy'))
    expect(await harness.executors.dispatch(commitment.commitment_id)).toEqual({ failed: 'host busy' })
    expect(attemptStates(harness, commitment.commitment_id).map(a => a.state)).toEqual(['ended', 'ended', 'pending'])
    // The failed durable also let go of the slot, so nothing is wedged on it either.
    const slot = (harness.db.prepare('SELECT slot FROM sa_commitment WHERE commitment_id = ?').get(commitment.commitment_id) as { slot: string | null }).slot
    expect(slot).toBeNull()

    const result = await harness.recovery.reconcile(harness.clock.now())

    expect(result.flushed).toBe(1)
    expect(attemptStates(harness, commitment.commitment_id).map(a => a.state)).toEqual(['ended', 'ended', 'running'])
  })

  it('flushes a pending attempt at startup too, so a reorg that lost the in-flight dispatch self-heals', async () => {
    const harness = mount()
    const commitment = seedCommitment(harness)
    seedAttempt(harness, commitment.commitment_id, { executor: 'durable-full', lifetime: 'durable' })

    const report = await harness.recovery.startup()

    expect(report.reconciled.flushed).toBe(1)
    expect(attemptStates(harness, commitment.commitment_id).map(a => a.state)).toEqual(['running'])
  })

  it('leaves a running commitment and a lease held elsewhere alone', async () => {
    const running = mount()
    running.lease.acquire(HOLDER, running.clock.now())
    const live = seedRunning(running, { lifetime: 'durable', quietMs: 0 })
    await running.controller.create({ sessionId: live.sessionId })
    expect((await running.recovery.reconcile(running.clock.now())).flushed).toBe(0)
    expect(attemptStates(running, live.commitment.commitment_id).map(a => a.state)).toEqual(['running'])

    const other = mount()
    other.lease.acquire('host-b', other.clock.now())
    const parked = seedCommitment(other)
    seedAttempt(other, parked.commitment_id, { executor: 'durable-full', lifetime: 'durable' })
    expect((await other.recovery.reconcile(other.clock.now())).flushed).toBe(0)
    expect(attemptStates(other, parked.commitment_id).map(a => a.state)).toEqual(['pending'])
    expect(creates(other)).toHaveLength(0)
  })
})

describe('reconcile: the owner\'s own request is not the owner\'s to approve', () => {
  interface Parked {
    creditor?: string
    kind?: 'deliver' | 'goal'
    executor?: string
    /** Write no brief at all, as `propose` does. */
    brief?: boolean
    parent?: string
    origin?: string
    etaMin?: number
  }
  /** What commit used to leave behind for an owner's draft mandate: proposed, ball on the owner, no attempt, a commit brief. */
  function seedParked(harness: Harness, over: Parked = {}) {
    const creditor = over.creditor ?? OWNER
    const parked = seedCommitment(harness, {
      state: 'proposed', creditor, ball: OWNER, kind: over.kind ?? 'deliver',
      ...(over.parent === undefined ? {} : { parent_id: over.parent }),
      ...(over.origin === undefined ? {} : { origin_ref: over.origin }),
      ...(over.etaMin === undefined ? {} : { eta_at: harness.clock.now() - 3_600_000, eta_model_min: over.etaMin, eta_factor: 1 }),
    })
    if (over.brief !== false) {
      harness.ledger.open(tx => tx.append(parked.commitment_id, { actor: 'desk', kind: 'brief',
        body: { executor: over.executor ?? 'oneshot-read', mandate: 'draft' } }))
    }
    return parked.commitment_id
  }
  /** This process holds the outlet lease, as it does after startup. */
  const holdLease = (harness: Harness) => { harness.lease.acquire(HOLDER, harness.clock.now()) }
  const commitmentOf = (harness: Harness, id: string) => harness.db.prepare('SELECT state, ball FROM sa_commitment WHERE commitment_id = ?')
    .get(id) as { state: string; ball: string }
  const creates = (harness: Harness) => harness.controller.calls.filter(call => call.method === 'create')

  it('opens an owner proposal, gives it a pending attempt on the briefed executor and dispatches it', async () => {
    const harness = mount()
    holdLease(harness)
    const id = seedParked(harness)
    expect(commitmentOf(harness, id)).toEqual({ state: 'proposed', ball: OWNER })
    expect(attemptStates(harness, id)).toHaveLength(0)

    const result = await harness.recovery.reconcile(harness.clock.now())

    expect(result.lifted).toBe(1)
    expect(commitmentOf(harness, id)).toEqual({ state: 'open', ball: 'me' })
    expect(attemptStates(harness, id)).toEqual([expect.objectContaining({ state: 'running' })])
    expect(creates(harness)).toHaveLength(1)
    const attempt = harness.db.prepare('SELECT executor FROM sa_attempt WHERE commitment_id = ?').get(id) as { executor: string }
    expect(attempt.executor).toBe('oneshot-read')
  })

  it('leaves a colleague\'s proposal and a host goal for the owner to approve, and lifts nothing twice', async () => {
    const harness = mount()
    holdLease(harness)
    const colleague = seedParked(harness, { creditor: 'on_col' })
    const goal = seedParked(harness, { kind: 'goal' })
    const mine = seedParked(harness)

    expect((await harness.recovery.reconcile(harness.clock.now())).lifted).toBe(1)
    expect((await harness.recovery.reconcile(harness.clock.now())).lifted).toBe(0)

    expect(commitmentOf(harness, colleague).state).toBe('proposed')
    expect(commitmentOf(harness, goal).state).toBe('proposed')
    expect(commitmentOf(harness, mine).state).toBe('open')
    expect(attemptStates(harness, colleague)).toHaveLength(0)
    expect(creates(harness)).toHaveLength(1)
  })

  it('never lifts the shape `propose` writes: no brief, a prop: origin, a goal as parent', async () => {
    const harness = mount()
    holdLease(harness)
    const goal = seedParked(harness, { kind: 'goal' })
    // Same creditor, ball and state as the owner's own request, but not one.
    const noBrief = seedParked(harness, { brief: false })
    const propOrigin = seedParked(harness, { origin: 'prop:C-1:D-1:1' })
    const child = seedParked(harness, { parent: goal })
    const both = seedParked(harness, { brief: false, origin: 'prop:C-1:D-1:2', parent: goal })

    for (let round = 0; round < 3; round += 1) {
      expect((await harness.recovery.reconcile(harness.clock.now())).lifted).toBe(0)
    }

    for (const id of [noBrief, propOrigin, child, both]) {
      expect(commitmentOf(harness, id)).toEqual({ state: 'proposed', ball: OWNER })
      expect(attemptStates(harness, id)).toHaveLength(0)
    }
    expect(creates(harness)).toHaveLength(0)
  })

  it('does not warn every round for a row it cannot recognise', async () => {
    const harness = mount()
    holdLease(harness)
    seedParked(harness, { brief: false })
    seedParked(harness, { executor: 'robot-9' })

    for (let round = 0; round < 3; round += 1) await harness.recovery.reconcile(harness.clock.now())

    expect(harness.warn).not.toHaveBeenCalled()
  })

  it('starts the clock when it opens: eta and next look are in the future, not a stale late', async () => {
    const harness = mount()
    holdLease(harness)
    const id = seedParked(harness, { etaMin: 30 })
    const now = harness.clock.now()
    const before = harness.db.prepare('SELECT eta_at FROM sa_commitment WHERE commitment_id = ?').get(id) as { eta_at: number }
    expect(before.eta_at).toBeLessThan(now)

    await harness.recovery.reconcile(now)

    const row = harness.db.prepare('SELECT eta_at, next_look_at FROM sa_commitment WHERE commitment_id = ?').get(id) as { eta_at: number; next_look_at: number }
    expect(row.eta_at).toBe(now + 30 * 60_000)
    expect(row.next_look_at).toBeGreaterThan(now)
    expect(row.next_look_at).toBeLessThanOrEqual(row.eta_at)
  })

  it('does nothing while another process holds the outlet lease', async () => {
    const harness = mount()
    harness.lease.acquire('host-b', harness.clock.now())
    const id = seedParked(harness)

    expect((await harness.recovery.reconcile(harness.clock.now())).lifted).toBe(0)

    expect(commitmentOf(harness, id).state).toBe('proposed')
    expect(creates(harness)).toHaveLength(0)
  })

  it('a row that is no longer proposed when the transaction runs is left alone', async () => {
    const harness = mount()
    holdLease(harness)
    const id = seedParked(harness)
    // The owner approved it between the selection and the write: it already has an attempt.
    const original = harness.ledger.read.all.bind(harness.ledger.read)
    const racing = { ...harness.ledger, read: { ...harness.ledger.read, get: harness.ledger.read.get,
      all: ((sql: string, ...params: Array<string | number | null>) => {
        const rows = original(sql, ...params)
        if (/state = 'proposed' AND kind = 'deliver'/.test(sql)) {
          harness.ledger.open(tx => { tx.transition(id, 'open', { ball: 'me' }); tx.recordAttempt({ commitment_id: id, executor: 'oneshot-read', reason: 'approved meanwhile', lifetime: 'oneshot' }) })
        }
        return rows
      }) as typeof harness.ledger.read.all } }
    const dispatch = vi.fn(async () => ({ attemptId: 'x', sessionId: 'y' }))
    const lifted = await promoteOwnerProposals({ ledger: racing, profiles: createProfileRegistry(), executors: { dispatch },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, lease: harness.lease, holder: HOLDER, owner: () => OWNER }, harness.clock.now())

    expect(lifted).toEqual([])
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('runs at startup too, before the first trigger can meet the parked row', async () => {
    const harness = mount()
    const id = seedParked(harness)

    const report = await harness.recovery.startup()

    expect(report.reconciled.lifted).toBe(1)
    expect(commitmentOf(harness, id).state).toBe('open')
  })

  it('does not guess an executor: a row whose brief names an unregistered one stays proposed', async () => {
    const harness = mount()
    holdLease(harness)
    const id = seedParked(harness, { executor: 'robot-9' })

    expect((await harness.recovery.reconcile(harness.clock.now())).lifted).toBe(0)

    expect(commitmentOf(harness, id).state).toBe('proposed')
  })
})

describe('degrade: readable state, not silent breakage', () => {
  it('writes one row per condition, and closes it on recover', async () => {
    const harness = mount()
    const degrades = createDegrades(harness.ledger)
    const first = degrades.degrade('model_unavailable', 'desk')
    const second = degrades.degrade('model_unavailable', 'desk')
    expect(second).toBe(first)
    expect(degrades.open().filter(row => row.reason === 'model_unavailable')).toHaveLength(1)

    degrades.recover('model_unavailable', 'desk')
    expect(degrades.open().filter(row => row.reason === 'model_unavailable')).toHaveLength(0)
    expect(degradeRows(harness).find(row => row.reason === 'model_unavailable')?.ended_at).not.toBeNull()
  })

  it('keeps a desk that fails its toolface self-check disabled and records why', async () => {
    const enabled = 'p2p:oc_ok'
    const broken = 'p2p:oc_bad'
    const harness = mount({ presence: { startupCheck: vi.fn(async () => ({ enabled: [enabled], disabled: [broken] })) } })

    const report = await harness.recovery.startup()

    expect(report.degraded.length).toBeGreaterThan(0)
    expect(degradeRows(harness).some(row => row.reason === 'toolface_mismatch' && row.scope === `desk:${broken}`)).toBe(true)
    expect(await harness.recovery.selfCheck(broken)).toBe('fail-closed')
    expect(await harness.recovery.selfCheck(enabled)).toBe('ok')
  })
})

describe('the second voice', () => {
  it('alerts once when history shows more answers than this ledger recorded, and degrades quietly without a reader', async () => {
    const eventId = 'evt-dup'
    const history = vi.fn(async (): Promise<readonly HistoryRow[]> => [
      { message_id: 'om_a', sender_is_self: true, reply_to: 'om_1', at: 1 },
      { message_id: 'om_b', sender_is_self: true, reply_to: 'om_1', at: 2 },
      { message_id: 'om_c', sender_is_self: true, reply_to: 'om_other', at: 3 },
    ])
    const harness = mount({ history })
    seedInbound(harness.db, { event_id: eventId, payload: JSON.stringify({ chatId: 'oc_1', messageId: 'om_1' }) })
    harness.lease.acquire(HOLDER, harness.clock.now())
    harness.db.prepare(`INSERT INTO sa_outbox (outbox_id, idem_key, chat_id, event_id, payload, body, moment, tier,
      audience, words, expects_reply, deliver, lease_epoch, state, attempts, created_at, updated_at)
      VALUES ('O:reply-1', 'reply-1', 'oc_1', ?, 'text', 'answer', 'answer', 'reply', 'requester', 3, 0, 1, 1, 'sent', 1, 1, 1)`)
      .run(eventId)

    const detected = await harness.recovery.secondVoice(eventId)
    expect(detected).toEqual({ detected: true, expected: 1, observed: 2 })
    const alerts = outboxRows(harness).filter(row => row.moment === 'alert')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.tier).toBe('interrupt')
    expect(degradeRows(harness).some(row => row.reason === 'second_voice')).toBe(true)

    // P6 unverified: no reader means one row at startup, no alert, no retry.
    const deaf = mount()
    const report = await deaf.recovery.startup()
    expect(report.degraded.length).toBeGreaterThan(0)
    expect(degradeRows(deaf).filter(row => row.reason === 'second_voice_unavailable')).toHaveLength(1)
    expect(await deaf.recovery.secondVoice(eventId)).toEqual({ unavailable: true })
    expect(outboxRows(deaf).filter(row => row.moment === 'alert')).toHaveLength(0)
  })
})

describe('the lease keeper', () => {
  it('lets another holder take an expired lease and reports the loss to its own process', async () => {
    const harness = mount()
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const onLost = vi.fn()
    const keeper = createLeaseKeeper({ lease: harness.lease, holder: HOLDER, clock: harness.clock, log, onLost })
    expect(keeper.beat()).toBe(true)

    harness.clock.advance(LEASE_EXPIRY_MS + 1_000)
    expect(harness.lease.acquire('host-b', harness.clock.now())).toMatchObject({ held: true, epoch: 2 })

    expect(keeper.beat()).toBe(false)
    expect(onLost).toHaveBeenCalledTimes(1)
    // One loss is announced once, not on every failed heartbeat.
    expect(keeper.beat()).toBe(false)
    expect(onLost).toHaveBeenCalledTimes(1)
  })
})

describe('roles', () => {
  it('classifies a bot session by the existing set, a desk and an executor by their owners, and nothing else', () => {
    const desk = { roleOf: (id: string) => id.startsWith('sa-desk-') ? `desk:${id}` as const : undefined }
    const executors = { roleOf: (id: string) => id.startsWith('sa-x-') ? `executor:${id}` as const : undefined }
    const sources = { isBotSession: (id: string) => id.startsWith('lark-'), desk, executors }

    expect(resolveRole('lark-session-1', sources)).toBe('bot')
    expect(resolveRole('sa-desk-x-g1', sources)).toBe('desk:sa-desk-x-g1')
    expect(resolveRole('sa-x-C-1-a1', sources)).toBe('executor:sa-x-C-1-a1')
    expect(resolveRole('someone-else', sources)).toBeUndefined()
    expect(resolveRole('   ', sources)).toBeUndefined()
  })
})