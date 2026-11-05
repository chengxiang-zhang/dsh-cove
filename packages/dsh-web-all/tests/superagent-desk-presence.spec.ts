/**
 * Desk presence, session lifecycle, tool face and desk tools (T20).
 * Fixtures: FX/ledger.ts, FX/fake-controller.ts, FX/manual-clock.ts, a stub ToolFace,
 * stub judgment handlers (absent: NOT_IMPLEMENTED).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPresence, deskSessionId, type DeskConfig } from '../src/host/services/superagent/desk/presence.ts'
import type { DeskTool, ToolFace } from '../src/host/services/superagent/desk/toolface.ts'
import { createLease } from '../src/host/services/superagent/kernel/lease.ts'
import { createOutlet } from '../src/host/services/superagent/kernel/outlet.ts'
import type { OutletPolicy, TurnRequest } from '../src/host/services/superagent/kernel/ports.ts'
import { remember as rememberRow } from '../src/host/services/superagent/memory/log.ts'
import type { MemoryLog } from '../src/host/services/superagent/memory/log.ts'
import type { InboundEvent } from '../src/host/services/superagent/protocol/events.ts'
import { DESK_TOOL_NAMES } from '../src/host/services/superagent/protocol/tools.ts'
import { createFakeController, type FakeController } from './fixtures/superagent/fake-controller.ts'
import { inboundEvent, openTestLedger, seedCommitment, type TestLedger } from './fixtures/superagent/ledger.ts'
import { seedInbound } from './fixtures/superagent/memdb.ts'

const OWNER = 'on_owner'
const MIN = 60_000

interface Rig {
  t: TestLedger
  controller: FakeController
  presence: ReturnType<typeof createPresence>
  tools: Map<string, DeskTool[]>
  setVisible(names: string[] | undefined): void
  cfg: DeskConfig
  mode: { value: 'responder' | 'shadow' | 'superagent' }
}

function rig(): Rig {
  const t = openTestLedger()
  const controller = createFakeController()
  const tools = new Map<string, DeskTool[]>()
  let visible: string[] | undefined
  const toolface: ToolFace = {
    async apply(sid, list) { tools.set(sid, [...list]); return () => { tools.delete(sid) } },
    async visible(sid) { return visible ?? (tools.get(sid) ?? []).map(x => x.name) },
  }
  const lease = createLease(t.ledger)
  lease.acquire('proc', t.clock.now())
  const outlet = createOutlet(t.ledger, lease, 'proc')
  const policy: OutletPolicy = { check: p => ({ ok: true, tier: 'reply', text: p.text, words: p.payload === 'react' ? 0 : 2 }) }
  const memory: MemoryLog = {
    remember: (entry, trigger) => t.ledger.open(tx => rememberRow(tx, entry, trigger), { module: 'memory' }),
    recall: () => [], visibility: () => undefined, promoteCandidates: () => [], applyPromotion: () => undefined,
    disclosures: () => [], retireStale: () => 0,
  }
  const cfg: DeskConfig = { seatDir: '/seat', preset: 'superagent-desk', idleEvictMs: 30 * MIN, rotateEvents: 4000,
    collectWindowMs: 3000, dossierTokens: 6000, owner: OWNER, tz: 'UTC' }
  const mode = { value: 'superagent' as 'responder' | 'shadow' | 'superagent' }
  const presence = createPresence({
    ledger: t.ledger, controller: () => controller, clock: t.clock, log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    memory, docs: { read: () => ({ text: 'doc', truncated: false }) }, outlet, outletPolicy: policy, mode: () => mode.value,
    handlers: {}, toolface, config: () => cfg,
    degrade: e => t.ledger.open(tx => tx.run(`INSERT INTO sa_degrade_event (degrade_id, reason, scope, started_at, created_at) VALUES (?, ?, ?, ?, ?)`,
      `dg-${e.now}-${e.scope}`, e.reason, e.scope, e.now, e.now), { module: 'recovery' }),
  })
  return { t, controller, presence, tools, setVisible: v => { visible = v }, cfg, mode }
}

/** Seed what claim would have written, then hand the event to the desk. */
function deliver(r: Rig, over: Partial<InboundEvent> = {}): InboundEvent {
  const e = inboundEvent({ received_at: r.t.clock.now(), ...over })
  seedInbound(r.t.db, { event_id: e.event_id, received_at: e.received_at })
  const sender = e.sender.union_id ?? e.sender.open_id
  r.t.ledger.open(tx => tx.insertIntake({ event_id: e.event_id, shadow: r.mode.value === 'shadow' ? 1 : 0, owner: 'superagent', sender,
    thread_key: `${e.chat.type}:${e.chat.id}:${e.thread}`, desk_id: `${e.chat.type}:${e.chat.id}` }))
  r.presence.enqueue(e)
  return e
}

let seq = 0
function emitEnd(r: Rig, sid: string, kind = 'completed'): void {
  r.presence.onSessionEvent(sid, { type: 'turn/end', seq: ++seq, data: { turn: 1, reason: { kind } } })
}
async function endTurn(r: Rig, sid: string, kind = 'completed'): Promise<void> {
  emitEnd(r, sid, kind)
  await r.presence.drain()
}
/** The model's part of a normal turn: one judge per batch event. */
async function judgeAll(r: Rig, sid: string, events: readonly InboundEvent[]): Promise<void> {
  for (const e of events) {
    expect(await call(r, sid, 'judge', { event_id: e.event_id, disposition: 'answer', class: 'chat', confidence: 0.9, reason: 'r' })).toEqual({ ok: true })
  }
}
async function closeWindow(r: Rig): Promise<string[]> {
  r.t.clock.advance(3000)
  return r.presence.tick(r.t.clock.now())
}
const prompts = (r: Rig) => r.controller.calls.filter(c => c.method === 'prompt').map(c => (c as Extract<FakeController['calls'][number], { method: 'prompt' }>).req)
const creates = (r: Rig) => r.controller.calls.filter(c => c.method === 'create').map(c => (c as Extract<FakeController['calls'][number], { method: 'create' }>).req)
const call = (r: Rig, sid: string, name: string, input: unknown) =>
  (r.tools.get(sid)?.find(x => x.name === name) as DeskTool).execute(input, { sessionId: sid }) as Promise<Record<string, unknown>>
const rows = (r: Rig, sql: string) => r.t.db.prepare(sql).all() as Array<Record<string, unknown>>
const SID = deskSessionId('p2p:oc_1', 0)
const openBlock = (text: string): string => {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.startsWith('在办(球权)'))
  const out = [lines[start]]
  for (const l of lines.slice(start + 1)) { if (!l.startsWith(' ')) break; out.push(l) }
  return out.join('\n')
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : []
  })
}

describe('desk presence', () => {
  it('1. no session before the first message; then exactly one create with seatDir and the desk preset', async () => {
    const r = rig()
    await r.presence.tick(r.t.clock.now())
    expect(creates(r)).toHaveLength(0)
    deliver(r)
    await closeWindow(r)
    expect(creates(r)).toEqual([{ sessionId: SID, cwd: '/seat', agentPreset: 'superagent-desk' }])
    expect(r.tools.get(SID)?.map(x => x.name)).toEqual([...DESK_TOOL_NAMES])
  })

  it('2. the 3-second collect window: messages at 0 s and 2 s share a turn, 4 s goes to the next', async () => {
    const r = rig()
    const alpha = deliver(r, { text: 'alpha' })
    r.t.clock.advance(2000); const beta = deliver(r, { text: 'beta' })
    r.t.clock.advance(1000); await r.presence.tick(r.t.clock.now())
    r.t.clock.advance(1000); deliver(r, { text: 'gamma' })
    expect(prompts(r)).toHaveLength(1)
    const first = prompts(r)[0].content[0].text
    expect(first).toContain('alpha'); expect(first).toContain('beta'); expect(first).not.toContain('gamma')
    await judgeAll(r, SID, [alpha, beta])
    await endTurn(r, SID)
    await closeWindow(r)
    expect(prompts(r)).toHaveLength(2)
    expect(prompts(r)[1].content[0].text).toContain('gamma')
  })

  it('3. two senders in one window become two turns (P5)', async () => {
    const r = rig()
    const mine = deliver(r, { text: 'from owner' })
    deliver(r, { text: 'from colleague', sender: { open_id: 'ou_col', union_id: 'on_col' } })
    await closeWindow(r)
    expect(prompts(r)).toHaveLength(1)
    await judgeAll(r, SID, [mine])
    await endTurn(r, SID)
    await r.presence.tick(r.t.clock.now())
    expect(prompts(r)).toHaveLength(2)
    expect(prompts(r)[0].content[0].text).not.toContain('from colleague')
    expect(prompts(r)[1].content[0].text).toContain('from colleague')
  })

  it('4. one turn per desk; an agenda turn meeting live human messages waits 60 s, at most five times', async () => {
    const r = rig()
    deliver(r, { text: 'a' })
    deliver(r, { text: 'b', sender: { open_id: 'ou_col', union_id: 'on_col' } })
    await closeWindow(r)
    await r.presence.tick(r.t.clock.now())
    expect(prompts(r)).toHaveLength(1)   // the second sub-batch waits for turn_open
    const c = seedCommitment(r.t, { desk_id: 'p2p:oc_1' })
    const did = r.t.ledger.open(tx => tx.requestTurn({ trigger_kind: 'agenda', commitment_id: c.commitment_id, request_id: 'tick:a' })) as string
    const trigger: TurnRequest = { deliberation_id: did, request_id: 'tick:a', commitment_id: c.commitment_id, trigger_kind: 'agenda' }
    expect((await r.presence.runTurn(trigger)).endReason).toBe('deferred')
    r.t.clock.advance(59_000)
    expect(await r.presence.tick(r.t.clock.now())).not.toContain(did)
    r.t.clock.advance(1000)
    expect(await r.presence.tick(r.t.clock.now())).toContain(did)   // second deferral happened inside this launch
    const later: string[] = []
    for (let i = 0; i < 4; i++) later.push((await r.presence.runTurn(trigger)).endReason)
    expect(later.slice(0, 3)).toEqual(['deferred', 'deferred', 'deferred'])
    expect(later[3]).not.toBe('deferred')   // the sixth attempt is not deferred again
  })

  it('5. 30 minutes idle evicts; the next message cold-resumes as g1 with the same open section (R1)', async () => {
    const r = rig()
    seedCommitment(r.t, { desk_id: 'p2p:oc_1', what: 'ship the report' })
    deliver(r)
    await closeWindow(r)
    await endTurn(r, SID)
    r.t.clock.advance(31 * MIN)
    expect(r.presence.evictIdle(r.t.clock.now())).toEqual(['p2p:oc_1'])
    expect(rows(r, 'SELECT session_id, generation FROM sa_desk')).toEqual([{ session_id: null, generation: 1 }])
    deliver(r)
    await closeWindow(r)
    expect(creates(r).map(c => c.sessionId)).toEqual([SID, deskSessionId('p2p:oc_1', 1)])
    expect(openBlock(prompts(r)[1].content[0].text)).toBe(openBlock(prompts(r)[0].content[0].text))
    expect(openBlock(prompts(r)[0].content[0].text)).toContain('ship the report')
  })

  it('6. rotate(manual) moves the generation up by one', async () => {
    const r = rig()
    deliver(r)
    await closeWindow(r)
    await endTurn(r, SID)
    expect(r.presence.rotate('p2p:oc_1', 'manual')).toBe(1)
    expect(rows(r, 'SELECT session_id, generation FROM sa_desk')).toEqual([{ session_id: null, generation: 1 }])
  })

  it('7. a finished turn writes ops, tool_errors, hashes, window_id and a rule trace', async () => {
    const r = rig()
    const e = deliver(r)
    await closeWindow(r)
    expect(await call(r, SID, 'judge', { event_id: e.event_id, disposition: 'answer', class: 'chat', confidence: 0.9, reason: 'greeting' })).toEqual({ ok: true })
    expect(await call(r, SID, 'commit', {})).toMatchObject({ ok: false, code: 'NOT_IMPLEMENTED' })
    expect(await call(r, SID, 'remember', { kind: 'preference', topic: 'greeting', body: 'owner says hello first', quote: 'hello' }))
      .toMatchObject({ ok: true, authority: 'owner-said' })
    expect(rows(r, 'SELECT authority, source_quote, source_event FROM sa_memory')).toEqual([{ authority: 'owner-said', source_quote: 'hello', source_event: e.event_id }])
    await endTurn(r, SID)
    const [d] = rows(r, `SELECT * FROM sa_deliberation`)
    expect(d).toMatchObject({ state: 'done', ops: 2, tool_errors: 1, end_reason: 'completed', trigger_kind: 'intake' })
    for (const k of ['pub_hash', 'dossier_hash', 'window_id', 'rule_trace', 'audience_class']) expect(d[k]).not.toBeNull()
    expect(String(d.rule_trace)).toContain('"tool":"judge"')
  })

  it('8. an event left unjudged is retried once; the second miss gets one host fallback', async () => {
    const r = rig()
    const e = deliver(r)
    await closeWindow(r)
    await endTurn(r, SID)
    expect(rows(r, 'SELECT * FROM sa_outbox')).toHaveLength(0)
    await r.presence.tick(r.t.clock.now())
    expect(prompts(r)).toHaveLength(2)
    await endTurn(r, SID)
    expect(rows(r, 'SELECT payload, moment, event_id FROM sa_outbox')).toEqual([{ payload: 'react', moment: 'ack', event_id: e.event_id }])
    expect(rows(r, 'SELECT state, disposition FROM sa_intake')).toEqual([{ state: 'disposed', disposition: 'acknowledge' }])
  })

  it('9. self-check fails closed on a foreign tool; host routes never call execute directly', async () => {
    const r = rig()
    r.setVisible([...DESK_TOOL_NAMES, 'bash'])
    deliver(r)
    await closeWindow(r)
    expect(prompts(r)).toHaveLength(0)
    expect(rows(r, 'SELECT reason, scope FROM sa_degrade_event')).toEqual([{ reason: 'desk_toolface', scope: 'p2p:oc_1' }])
    expect(rows(r, `SELECT moment, body FROM sa_outbox`)).toEqual([{ moment: 'alert', body: '我这边工具面不对，已停' }])
    // Exactly the desk tools (plus the known agent-plane tool) passes.
    r.setVisible([...DESK_TOOL_NAMES, 'subagent'])
    deliver(r)
    await closeWindow(r)
    expect(prompts(r)).toHaveLength(1)
    // A non-desk tool that actually ran (no refusal in its result) breaks the face for the next turn.
    r.presence.onSessionEvent(SID, { type: 'tool/call', seq: ++seq, data: { callId: 'x1', name: 'bash', arguments: '{}' } })
    r.presence.onSessionEvent(SID, { type: 'tool/result', seq: ++seq, data: { message: { toolCallId: 'x1', content: [{ type: 'text', text: 'ok' }] } } })
    await endTurn(r, SID)
    deliver(r)
    await closeWindow(r)
    expect(prompts(r)).toHaveLength(1)
    // S1: execution scope follows exec.agent, so a host-side registry execute without an agent
    // runs the global tool view. No host source outside channels/ may call the registry's
    // `tools.execute` (the T27 gate form). A tool definition's own body (the composition
    // root adapting a desk tool to the runtime's definition shape) is not that path: the
    // runtime calls it after its guards, so the scan names the registry call, not every `.execute(`.
    const root = join(__dirname, '../src/host/services/superagent')
    const offenders = sourceFiles(root).filter(f => !relative(root, f).startsWith('channels/'))
      .filter(f => /tools\.execute/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
    // The dossier must ride the turn's user message, never a system prompt section (T-11).
    // Why not system-prompt-audit: that gate (scripts/system-prompt-audit.test.mjs) only flags literal
    // {{...}} groups inside a section/context `text:` expression. A dynamic value such as
    // `systemPrompt.section({ name: 'dossier', text: dossier.text })` carries no literal braces, so the
    // gate stays green: negative control NC-a (2026-11-05) put exactly that call in desk/presence.ts
    // and test:scripts still read 608/608. Only a literal `{{dossier}}` turned it red (NC-b).
    // The stand-in is this source scan: any `systemPrompt.` under desk/ fails the test. This
    // constraint is enforced by this scan, not by system-prompt-audit.
    expect(sourceFiles(join(root, 'desk')).filter(f => /systemPrompt\./.test(readFileSync(f, 'utf8')))).toEqual([])
  })

  it('10. say passes the outlet code REPLY_EXISTS through; idem_key stays within 50 characters', async () => {
    const r = rig()
    const e = deliver(r)
    await closeWindow(r)
    expect(await call(r, SID, 'say', { event_id: e.event_id, moment: 'answer', text: 'hi' })).toMatchObject({ ok: true, tier: 'reply' })
    expect(await call(r, SID, 'say', { event_id: e.event_id, moment: 'answer', text: 'hi again' })).toMatchObject({ ok: false, code: 'REPLY_EXISTS' })
    const keys = rows(r, 'SELECT idem_key FROM sa_outbox').map(x => String(x.idem_key))
    expect(keys).toHaveLength(1)
    expect(keys.every(k => k.length <= 50 && k.startsWith('sa:'))).toBe(true)
  })

  it('11. look(commitment) from a group desk: a private commitment is NOT_VISIBLE, an unknown one MISSING', async () => {
    const r = rig()
    const c = seedCommitment(r.t, { desk_id: 'p2p:oc_1' })
    deliver(r, { chat: { id: 'oc_g', type: 'group' }, sender: { open_id: 'ou_col', union_id: 'on_col' } })
    await closeWindow(r)
    const sid = deskSessionId('group:oc_g', 0)
    expect(await call(r, sid, 'look', { what: 'commitment', id: c.commitment_id })).toMatchObject({ ok: false, code: 'NOT_VISIBLE' })
    expect(await call(r, sid, 'look', { what: 'commitment', id: 'C-99' })).toMatchObject({ ok: false, code: 'MISSING' })
  })

  it('12. a shadow turn sets deliberation.shadow=1 and writes no commitment or outbox row', async () => {
    const r = rig()
    r.mode.value = 'shadow'
    const e = deliver(r)
    await closeWindow(r)
    expect(await call(r, SID, 'judge', { event_id: e.event_id, disposition: 'answer', class: 'chat', confidence: 0.8, reason: 'r' })).toEqual({ ok: true })
    expect(await call(r, SID, 'say', { event_id: e.event_id, moment: 'answer', text: 'hi' })).toMatchObject({ ok: true, outbox_id: 'shadow' })
    await endTurn(r, SID)
    expect(rows(r, 'SELECT shadow FROM sa_deliberation')).toEqual([{ shadow: 1 }])
    expect(rows(r, 'SELECT count(*) AS n FROM sa_outbox')).toEqual([{ n: 0 }])
    expect(rows(r, 'SELECT count(*) AS n FROM sa_commitment')).toEqual([{ n: 0 }])
    expect(rows(r, 'SELECT shadow, state FROM sa_intake')).toEqual([{ shadow: 1, state: 'disposed' }])
    expect(String(rows(r, 'SELECT rule_trace FROM sa_deliberation')[0].rule_trace)).toContain('shadow_ops')
  })

  it('13. modelFor(desk session) is undefined without a configured model (N20), the model once configured', async () => {
    const r = rig()
    deliver(r)
    await closeWindow(r)
    expect(r.presence.modelFor(SID)).toBeUndefined()
    r.cfg.model = { provider: 'prov', model: 'desk-model' }
    expect(r.presence.modelFor(SID)).toEqual({ provider: 'prov', model: 'desk-model' })
    expect(r.presence.modelFor('sa-x-C-1-a1')).toBeUndefined()
    expect(r.presence.roleOf(SID)).toBe('desk:p2p:oc_1')
  })

  it('14. two desks in one 5-minute window with one audience class share the dossier fingerprint (R18)', async () => {
    const r = rig()
    seedCommitment(r.t, { desk_id: 'p2p:oc_1' })
    deliver(r, { chat: { id: 'oc_1', type: 'p2p' } })
    deliver(r, { chat: { id: 'oc_2', type: 'p2p' } })
    await closeWindow(r)
    emitEnd(r, SID)
    emitEnd(r, deskSessionId('p2p:oc_2', 0))
    await r.presence.drain()
    const d = rows(r, 'SELECT desk_id, dossier_hash, audience_class, window_id FROM sa_deliberation ORDER BY desk_id')
    expect(d).toHaveLength(2)
    expect(d[0].audience_class).toBe('owner_p2p')
    expect(d[0].audience_class).toBe(d[1].audience_class)
    expect(d[0].window_id).toBe(d[1].window_id)
    expect(d[0].dossier_hash).toBe(d[1].dossier_hash)
  })
})
