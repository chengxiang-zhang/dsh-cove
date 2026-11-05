/**
 * Judge, gate facts and pushback (T21).
 *
 * Fixtures: FX/ledger.ts plus the real T15 world registry, T16 memory log, T17
 * rule registry and the executor profile registry. The six gates are asserted
 * against seed data, because a gate fact the host cannot prove is exactly the
 * case the model must not be able to fake.
 */

import { describe, expect, it } from 'vitest'
import { createClaim } from '../src/host/services/superagent/kernel/claim.ts'
import type { Ledger } from '../src/host/services/superagent/kernel/ledger.ts'
import { PHYSICAL } from '../src/host/services/superagent/protocol/db.ts'
import type { InboundEvent } from '../src/host/services/superagent/protocol/events.ts'
import type { CommitmentRow } from '../src/host/services/superagent/protocol/objects.ts'
import { applyPromotion } from '../src/host/services/superagent/memory/promote.ts'
import { remember, retireStale, visibility as memoryVisibility, type MemoryLog } from '../src/host/services/superagent/memory/log.ts'
import { disclosuresOf, recall } from '../src/host/services/superagent/memory/recall.ts'
import type { MemoryEntry } from '../src/host/services/superagent/memory/types/index.ts'
import { createProfileRegistry } from '../src/host/services/superagent/executors/profiles/index.ts'
import { createRuleRegistry } from '../src/host/services/superagent/rules/registry.ts'
import { DEFAULT_TABLE } from '../src/host/services/superagent/world/defaults.ts'
import { createWorldRegistry } from '../src/host/services/superagent/world/registry.ts'
import {
  gateFacts,
  senderOf,
  threadOf,
  type JudgmentDeps,
  type TurnContext,
} from '../src/host/services/superagent/judgment/gates.ts'
import { judgeTool } from '../src/host/services/superagent/judgment/judge.ts'
import { MUTED_MESSAGE, NON_OWNER_MESSAGE, pushbackTool } from '../src/host/services/superagent/judgment/pushback.ts'
import { openTestLedger, seedCommitment, type TestLedger } from './fixtures/superagent/ledger.ts'

const DAY = 86_400_000
const OWNER_UNION = 'ou_owner_union'
const COLLEAGUE_UNION = 'ou_colleague_union'
const OWNER_PARTY = 'party-owner'
const COLLEAGUE_PARTY = 'party-colleague'
const P2P_CHAT = 'oc_p2p'
const GROUP_CHAT = 'oc_group'
const P2P_DESK = `p2p:${P2P_CHAT}`
const GROUP_DESK = `group:${GROUP_CHAT}`

const C = PHYSICAL.commitment
const J = PHYSICAL.journal
const I = PHYSICAL.intake
const WC = PHYSICAL.work_class

interface Harness {
  t: TestLedger
  deps: JudgmentDeps
  judge: ReturnType<typeof judgeTool>
  pushback: ReturnType<typeof pushbackTool>
  say: { calls: number; texts: string[] }
}

function makeMemoryLog(t: TestLedger): MemoryLog {
  return {
    remember: (entry, trigger) => t.ledger.open((tx) => remember(tx, entry, trigger), { module: 'memory' }),
    recall: (query, audience, purpose, limit) => recall(t.ledger.read, query, audience, purpose, limit),
    visibility: (memoryId) => memoryVisibility(t.ledger.read, memoryId),
    // Promotion is the daily batch job (T16); T21 never calls it.
    promoteCandidates: () => [],
    applyPromotion: (memoryId, approved) => t.ledger.open((tx) => applyPromotion(tx, memoryId, approved), { module: 'memory' }),
    disclosures: (text, audience) => disclosuresOf(t.ledger.read, text, audience),
    retireStale: (now) => t.ledger.open((tx) => retireStale(tx, now), { module: 'memory' }),
  }
}

function setup(): Harness {
  const t = openTestLedger()
  const world = createWorldRegistry({ read: t.ledger.read, clock: t.clock, defaults: DEFAULT_TABLE })
  t.ledger.open((tx) => world.registerParty(tx, {
    party_id: OWNER_PARTY, union_id: OWNER_UNION, open_id: 'ou_owner_open', class: 'owner', source: 'config',
  }), { module: 'world' })
  t.ledger.open((tx) => world.registerParty(tx, {
    party_id: COLLEAGUE_PARTY, union_id: COLLEAGUE_UNION, open_id: 'ou_colleague_open', class: 'colleague', source: 'config',
  }), { module: 'world' })

  const say = { calls: 0, texts: [] as string[] }
  const deps: JudgmentDeps = {
    ledger: t.ledger as Ledger,
    claim: createClaim(t.ledger as Ledger),
    world,
    memory: makeMemoryLog(t),
    rules: createRuleRegistry(t.ledger as Ledger),
    outletSay: (_ctx, proposal) => {
      say.calls += 1
      say.texts.push(proposal.text)
      return { ok: true, outbox_id: `O-${say.calls}`, tier: 'reply', words: 8 }
    },
    profiles: createProfileRegistry(),
  }
  return { t, deps, judge: judgeTool(deps), pushback: pushbackTool(deps), say }
}

function makeEvent(eventId: string, over: { chat?: { id: string; type: 'p2p' | 'group' }; union?: string; text?: string } = {}): InboundEvent {
  return {
    event_id: eventId,
    chat: over.chat ?? { id: P2P_CHAT, type: 'p2p' },
    sender: { open_id: `open-${eventId}`, union_id: over.union ?? OWNER_UNION },
    thread: '',
    text: over.text ?? '把测试跑一遍',
    message_id: `msg-${eventId}`,
    received_at: 1,
  }
}

function turn(over: Partial<TurnContext> = {}): TurnContext {
  return {
    deskId: P2P_DESK,
    deliberationId: 'D:1',
    shadow: false,
    batch: [],
    audience: { principals: [OWNER_PARTY], cls: 'owner_p2p' },
    ...over,
  }
}

function seedIntake(t: TestLedger, event: InboundEvent, shadow: 0 | 1 = 0): void {
  t.ledger.open((tx) => tx.insertIntake({
    event_id: event.event_id, shadow, owner: 'superagent', sender: senderOf(event), thread_key: threadOf(event),
  }))
}

function seedLive(t: TestLedger, event: InboundEvent, over: Record<string, unknown> = {}): CommitmentRow {
  return seedCommitment(t, { thread_key: threadOf(event), desk_id: P2P_DESK, ...over } as never)
}

function seedClosed(t: TestLedger, daysAgo: number, workClass: string, deskId = P2P_DESK): CommitmentRow {
  const row = seedCommitment(t, { work_class: workClass, desk_id: deskId, intent: `${workClass} done` } as never)
  t.db.prepare(
    `UPDATE sa_commitment SET state = 'fulfilled', evidence_json = '{}', closed_at = ?, work_class = ? WHERE commitment_id = ?`,
  ).run(t.clock.now() - daysAgo * DAY, workClass, row.commitment_id)
  return { ...row, work_class: workClass, state: 'fulfilled' }
}

function seedMemory(t: TestLedger, event: InboundEvent, entry: Partial<MemoryEntry> & { topic: string; body: string; use: string[]; say: string[] }): string {
  const quote = entry.quote ?? entry.body
  const result = t.ledger.open((tx) => remember(tx, {
    kind: entry.kind ?? 'constraint',
    topic: entry.topic,
    body: entry.body,
    authority: entry.authority ?? 'owner-said',
    quote,
    use: entry.use,
    say: entry.say,
  }, {
    kind: 'inbound', event, batchTexts: [quote], sender: senderOf(event), owner: OWNER_UNION,
    audience: { principals: [OWNER_PARTY], cls: 'owner_p2p' },
  }), { module: 'memory' })
  return result.memoryId
}

function countRows(t: TestLedger, table: string, where = '', ...params: (string | number)[]): number {
  return (t.db.prepare(`SELECT count(*) AS n FROM ${table}${where === '' ? '' : ` WHERE ${where}`}`).get(...params) as { n: number }).n
}

describe('superagent judge', () => {
  it('1. an event outside the batch is refused, and a second judge on the same event is refused', () => {
    const h = setup()
    const event = makeEvent('evt-1')
    seedIntake(h.t, event)
    const ctx = turn({ batch: [event] })

    expect(h.judge(ctx, { event_id: 'evt-404', disposition: 'answer', class: 'q-and-a', confidence: 0.5, reason: 'r' }))
      .toMatchObject({ ok: false, code: 'NOT_IN_BATCH' })

    const first = h.judge(ctx, { event_id: event.event_id, disposition: 'answer', class: 'q-and-a', confidence: 0.8, reason: 'info' })
    expect(first.ok).toBe(true)
    expect(h.judge(ctx, { event_id: event.event_id, disposition: 'answer', class: 'q-and-a', confidence: 0.8, reason: 'info' }))
      .toMatchObject({ ok: false, code: 'ALREADY_DISPOSED' })

    const row = h.t.db.prepare(`SELECT state, disposition FROM ${I} WHERE event_id = ? AND shadow = 0`).get(event.event_id)
    expect(row).toMatchObject({ state: 'disposed', disposition: 'answer' })
  })

  it('2. a live commitment narrows the dispositions and a new thread needs a reason', () => {
    const h = setup()
    const event = makeEvent('evt-2')
    seedIntake(h.t, event)
    const live = seedLive(h.t, event)
    const ctx = turn({ batch: [event] })

    expect(h.judge(ctx, { event_id: event.event_id, disposition: 'commit', class: 'repo-change', confidence: 0.9, reason: 'new work' }))
      .toMatchObject({ ok: false, code: 'LIVE_THREAD_FORBIDS' })
    expect(h.judge(ctx, {
      event_id: event.event_id, disposition: 'commit', class: 'repo-change', confidence: 0.9, reason: '', new_thread: true,
    })).toMatchObject({ ok: false, code: 'NEW_THREAD_REASON_REQUIRED' })
    // check is on the allowed list, so it is not blocked by the live commitment.
    expect(h.judge(ctx, { event_id: event.event_id, disposition: 'check', class: 'repo-change', confidence: 0.6, reason: 'status' }))
      .toMatchObject({ ok: true })
    expect(h.t.db.prepare(`SELECT disposition FROM ${I} WHERE event_id = ? AND shadow = 0`).get(event.event_id))
      .toMatchObject({ disposition: 'check' })
    expect(live.state).toBe('open')
  })

  it('3. about must name a commitment visible at this desk', () => {
    const h = setup()
    const groupEvent = makeEvent('evt-3', { chat: { id: GROUP_CHAT, type: 'group' } })
    seedIntake(h.t, groupEvent)
    const privateCommitment = seedCommitment(h.t, { desk_id: P2P_DESK } as never)
    const localCommitment = seedCommitment(h.t, { desk_id: GROUP_DESK } as never)
    const ctx = turn({
      deskId: GROUP_DESK,
      audience: { principals: [OWNER_PARTY, COLLEAGUE_PARTY], cls: 'group_with_owner' },
      batch: [groupEvent],
    })

    expect(h.judge(ctx, {
      event_id: groupEvent.event_id, disposition: 'amend', about: privateCommitment.commitment_id,
      class: 'repo-change', confidence: 0.7, reason: 'follow up',
    })).toMatchObject({ ok: false, code: 'ABOUT_NOT_VISIBLE' })
    expect(h.judge(ctx, {
      event_id: groupEvent.event_id, disposition: 'amend', about: localCommitment.commitment_id,
      class: 'repo-change', confidence: 0.7, reason: 'follow up',
    })).toMatchObject({ ok: true })
  })

  it('4. a nudge leaves one journal row and creates no new work', () => {
    const h = setup()
    const event = makeEvent('evt-4')
    seedIntake(h.t, event)
    seedLive(h.t, event)
    const commitments = countRows(h.t, C)
    const attempts = countRows(h.t, PHYSICAL.attempt)

    expect(h.judge(turn({ batch: [event] }), {
      event_id: event.event_id, disposition: 'nudge', class: 'repo-change', confidence: 0.7, reason: 'chase it',
    })).toMatchObject({ ok: true })

    expect(countRows(h.t, J, `kind = 'nudge'`)).toBe(1)
    expect(countRows(h.t, C)).toBe(commitments)
    expect(countRows(h.t, PHYSICAL.attempt)).toBe(attempts)
  })

  it('5. a shadow turn writes the shadow intake and nothing else', () => {
    const h = setup()
    const event = makeEvent('evt-5')
    seedIntake(h.t, event, 1)

    expect(h.judge(turn({ shadow: true, batch: [event] }), {
      event_id: event.event_id, disposition: 'answer', class: 'q-and-a', confidence: 0.8, reason: 'info',
    })).toMatchObject({ ok: true })

    const rows = h.t.db.prepare(`SELECT shadow, state, disposition FROM ${I} WHERE event_id = ? ORDER BY shadow`).all(event.event_id)
    expect(rows).toEqual([{ shadow: 1, state: 'disposed', disposition: 'answer' }])
    expect(countRows(h.t, I, `event_id = ? AND shadow = 0`, event.event_id)).toBe(0)
  })

  it('6. gate 1 answers with the last seven days only', () => {
    const h = setup()
    const event = makeEvent('evt-6')
    seedIntake(h.t, event)
    seedLive(h.t, event, { work_class: 'repo-change' })
    const sixDays = seedClosed(h.t, 6, 'repo-change')
    const eightDays = seedClosed(h.t, 8, 'repo-change')
    const otherClass = seedClosed(h.t, 6, 'release-notes')

    const facts = gateFacts(h.deps, turn({ batch: [event] }), event)
    const ids = facts.g1_answered.map((entry) => entry.commitment_id)
    expect(ids).toContain(sixDays.commitment_id)
    expect(ids).not.toContain(eightDays.commitment_id)
    expect(ids).not.toContain(otherClass.commitment_id)
    expect(facts.g1_answered.every((entry) => typeof entry.conclusion === 'string' && entry.conclusion.length > 0)).toBe(true)
  })

  it('7. gate 3 answers with the world model mandate, so a colleague cannot publish', () => {
    const h = setup()
    const event = makeEvent('evt-7', { chat: { id: GROUP_CHAT, type: 'group' }, union: COLLEAGUE_UNION })
    seedIntake(h.t, event)
    const facts = gateFacts(h.deps, turn({
      deskId: GROUP_DESK,
      audience: { principals: [OWNER_PARTY, COLLEAGUE_PARTY], cls: 'group_with_owner' },
      batch: [event],
    }), event)

    expect(facts.g3_mandate('publish', 'local/~/code/dsh-web')).toBe('deny')
    expect(facts.g3_mandate('read', 'local/~/code/dsh-web')).toBe('allow')
  })

  it('8. gate 4 hands out only what this audience may use, and never the private words', () => {
    const h = setup()
    const groupEvent = makeEvent('evt-8', { chat: { id: GROUP_CHAT, type: 'group' } })
    seedIntake(h.t, groupEvent)
    const shared = seedMemory(h.t, groupEvent, {
      kind: 'constraint', topic: 'group-secret', body: '别在群里提密码 4321',
      use: [OWNER_PARTY, COLLEAGUE_PARTY], say: [OWNER_PARTY],
    })
    const speakable = seedMemory(h.t, groupEvent, {
      kind: 'preference', topic: 'brevity', body: '回复要短',
      use: [OWNER_PARTY, COLLEAGUE_PARTY], say: [OWNER_PARTY, COLLEAGUE_PARTY],
    })
    // Not usable by this audience at all: neither principal of the group is on the
    // use set, so the row is absent rather than hinted.
    const privateOnly = seedMemory(h.t, groupEvent, {
      kind: 'constraint', topic: 'machine-address', body: '不要把机房地址说出去',
      use: ['party-outsider'], say: ['party-outsider'],
    })

    const facts = gateFacts(h.deps, turn({
      deskId: GROUP_DESK,
      audience: { principals: [OWNER_PARTY, COLLEAGUE_PARTY], cls: 'group_with_owner' },
      batch: [groupEvent],
    }), groupEvent)
    const ids = facts.g4_said.map((entry) => entry.memory_id)
    expect(ids).toContain(shared)
    expect(ids).toContain(speakable)
    expect(ids).not.toContain(privateOnly)
    const sharedQuote = facts.g4_said.find((entry) => entry.memory_id === shared)?.quote ?? ''
    expect(sharedQuote.length).toBeGreaterThan(0)
    expect(sharedQuote).not.toContain('密码')
    expect(facts.g4_said.find((entry) => entry.memory_id === speakable)?.quote).toContain('回复要短')
  })

  it('9. pushback without a usable ground is refused', () => {
    const h = setup()
    const event = makeEvent('evt-9')
    seedIntake(h.t, event)
    const live = seedLive(h.t, event)
    const ctx = turn({ batch: [event] })

    expect(h.pushback(ctx, { event_id: event.event_id, commitment_id: live.commitment_id, concern: 'c', grounds: [], alternative: 'a' }))
      .toMatchObject({ ok: false, code: 'NO_GROUNDS' })
    expect(h.pushback(ctx, { event_id: event.event_id, commitment_id: live.commitment_id, concern: 'c', grounds: ['M-999'], alternative: 'a' }))
      .toMatchObject({ ok: false, code: 'NO_GROUNDS' })
    // A ground that exists but names nothing usable is refused as well.
    expect(h.pushback(ctx, { event_id: event.event_id, commitment_id: live.commitment_id, concern: 'c', grounds: ['feelings'], alternative: 'a' }))
      .toMatchObject({ ok: false, code: 'NO_GROUNDS' })
    // And an empty alternative is not an alternative.
    expect(h.pushback(ctx, { event_id: event.event_id, commitment_id: live.commitment_id, concern: 'c', grounds: [live.commitment_id], alternative: '  ' }))
      .toMatchObject({ ok: false, code: 'NO_GROUNDS' })
    expect(h.say.calls).toBe(0)
    expect(countRows(h.t, J, `kind = 'pushback'`)).toBe(0)
  })

  it('10. a second pushback on the same thread is refused', () => {
    const h = setup()
    const event = makeEvent('evt-10')
    seedIntake(h.t, event)
    const live = seedLive(h.t, event)
    const ctx = turn({ batch: [event] })
    const input = {
      event_id: event.event_id, commitment_id: live.commitment_id, concern: '这个会破坏 A 的约束',
      grounds: [live.commitment_id], alternative: '先只跑 responder 的那一半',
    }

    expect(h.pushback(ctx, input)).toMatchObject({ ok: true, outbox_id: 'O-1' })
    expect(h.pushback(ctx, input)).toMatchObject({ ok: false, code: 'PUSHBACK_REPEAT' })
    expect(countRows(h.t, J, `kind = 'pushback'`)).toBe(1)
  })

  it('11. a muted work class and a non-owner sender both silence the pushback', () => {
    const muted = setup()
    const mutedEvent = makeEvent('evt-11a')
    seedIntake(muted.t, mutedEvent)
    const mutedLive = seedLive(muted.t, mutedEvent, { work_class: 'repo-change' })
    muted.t.db.prepare(
      `INSERT INTO ${WC} (class_id, samples, eta_factor, ask_mode, pushback_mode, created_at, updated_at)
       VALUES ('repo-change', 6, 1.2, 'declare', 'muted', ?, ?)`,
    ).run(muted.t.clock.now(), muted.t.clock.now())
    expect(muted.pushback(turn({ batch: [mutedEvent] }), {
      event_id: mutedEvent.event_id, commitment_id: mutedLive.commitment_id, concern: 'c',
      grounds: [mutedLive.commitment_id], alternative: 'a',
    })).toMatchObject({ ok: false, code: 'PUSHBACK_QUIET', message: MUTED_MESSAGE })

    // Speaking for the owner: a colleague's collision is routed, never argued.
    const colleague = setup()
    const colleagueEvent = makeEvent('evt-11b', { union: COLLEAGUE_UNION })
    seedIntake(colleague.t, colleagueEvent)
    const colleagueLive = seedCommitment(colleague.t, { desk_id: P2P_DESK } as never)
    const result = colleague.pushback(turn({ batch: [colleagueEvent] }), {
      event_id: colleagueEvent.event_id, commitment_id: colleagueLive.commitment_id, concern: 'c',
      grounds: [colleagueLive.commitment_id], alternative: 'a',
    })
    expect(result).toMatchObject({ ok: false, code: 'PUSHBACK_QUIET', message: NON_OWNER_MESSAGE })
    expect(result.ok === false ? result.message : '').toContain('route')
    expect(colleague.say.calls).toBe(0)
  })

  it('12. a grounded pushback writes one journal row and one outbox proposal', () => {
    const h = setup()
    const event = makeEvent('evt-12')
    seedIntake(h.t, event)
    const live = seedLive(h.t, event, { work_class: 'repo-change' })
    h.t.db.prepare(
      `INSERT INTO ${WC} (class_id, samples, eta_factor, ask_mode, pushback_mode, created_at, updated_at)
       VALUES ('repo-change', 6, 1.2, 'declare', 'on', ?, ?)`,
    ).run(h.t.clock.now(), h.t.clock.now())

    const outcome = h.pushback(turn({ batch: [event] }), {
      event_id: event.event_id,
      commitment_id: live.commitment_id,
      concern: '发这条消息不会让那个会话恢复进展',
      grounds: [live.commitment_id, 'calib:repo-change'],
      alternative: '把具体指令发过去，或者停掉重派',
    })
    expect(outcome).toMatchObject({ ok: true, outbox_id: 'O-1' })
    expect(h.say.calls).toBe(1)
    expect(h.say.texts[0]).toContain('备选：')
    expect(countRows(h.t, J, `kind = 'pushback'`)).toBe(1)
  })
})