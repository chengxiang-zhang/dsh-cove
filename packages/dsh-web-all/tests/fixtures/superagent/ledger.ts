/**
 * Kernel ledger fixture (T08): a `Ledger` over the in-memory test database.
 *
 * `seedCommitment` and `seedAttempt` give later kernel tasks (T12, T13, T14)
 * valid rows with one call; every default satisfies the 02 table constraints.
 */

import type { DatabaseSync } from 'node:sqlite'
import { createLedger, type Ledger, type NewAttempt, type NewCommitment } from '../../../src/host/services/superagent/kernel/ledger.ts'
import type { AttemptRow, CommitmentRow } from '../../../src/host/services/superagent/protocol/objects.ts'
import type { InboundEvent } from '../../../src/host/services/superagent/protocol/events.ts'
import { createManualClock, type ManualClock } from './manual-clock.ts'
import { openTestLedgerDb } from './memdb.ts'

export interface TestLedger {
  /** For test code: an omitted module means the test seeds as the kernel. Components still pass their own. */
  ledger: Ledger
  /** The ledger exactly as production builds it: `module` is required (R1 A3). */
  raw: Ledger
  db: DatabaseSync
  clock: ManualClock
}

/**
 * Test seeding convenience only. Production callers are held to an explicit module by
 * the type of `Ledger.open` and by `MODULE_REQUIRED` at runtime; test code that builds
 * rows directly is treated as the kernel. A module the caller does pass is never changed.
 */
export function seedingLedger(raw: Ledger): Ledger {
  return {
    open: (fn, opts) => raw.open(fn, { ...(opts as object | undefined), module: (opts as { module?: never } | undefined)?.module ?? 'kernel' }),
    read: raw.read,
    nowMs: () => raw.nowMs(),
  }
}

export function openTestLedger(clock: ManualClock = createManualClock(1_762_300_000_000)): TestLedger {
  const db = openTestLedgerDb()
  const raw = createLedger(db, clock)
  return { ledger: seedingLedger(raw), raw, db, clock }
}

let origin = 0

/** An open deliver commitment with both stop-loss lines and a look time one hour out. */
export function deliverSpec(over: Partial<NewCommitment> = {}): NewCommitment {
  origin += 1
  return {
    kind: 'deliver', debtor: 'me', creditor: 'ou_owner', ball: 'me', thread_key: `p2p:oc_1:m${origin}`,
    origin_ref: `evt-seed-${origin}`, what: 'do the thing', intent: 'thing done', check_kind: 'command',
    done_when: 'test passes', budget_wall_ms: 1_800_000, budget_turns: 20, next_look_at: undefined, ...over,
  } as NewCommitment
}

export function seedCommitment(t: TestLedger, over: Partial<NewCommitment> = {}): CommitmentRow {
  const spec = deliverSpec(over)
  return t.ledger.open(tx => tx.createCommitment({ ...spec, next_look_at: spec.next_look_at ?? tx.now + 3_600_000 }))
}

export function seedAttempt(t: TestLedger, commitmentId: string, over: Partial<NewAttempt> = {}): AttemptRow {
  return t.ledger.open(tx => tx.recordAttempt({ commitment_id: commitmentId, executor: 'codex', reason: 'repo work', lifetime: 'oneshot', ...over }))
}

/** A live subscription row: thread -> commitment -> attempt (T12 passthrough). */
export function seedSubscription(t: TestLedger, threadKey: string, commitmentId: string, attemptId: string): void {
  t.db.prepare(`INSERT INTO sa_subscription (thread_key, commitment_id, attempt_id, input_seq, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?)`).run(threadKey, commitmentId, attemptId, t.clock.now(), t.clock.now())
}

let inboundSeq = 0

/** An inbound event; seed its `inbox_events` row with `seedInbound` from memdb. */
export function inboundEvent(over: Partial<InboundEvent> = {}): InboundEvent {
  inboundSeq += 1
  return {
    event_id: `evt-${inboundSeq}`, chat: { id: 'oc_1', type: 'p2p' }, sender: { open_id: 'ou_owner', union_id: 'on_owner' },
    thread: `om_root_${inboundSeq}`, text: 'hello', message_id: `om_${inboundSeq}`, received_at: 0, ...over,
  }
}
