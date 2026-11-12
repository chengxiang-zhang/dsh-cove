/**
 * Executors: profiles, dispatch, appended input, cancel, stop-loss (T19).
 * Fixtures: FX/ledger.ts, FX/fake-controller.ts, FX/manual-clock.ts, the real T15 world registry.
 */

import { createServer } from 'node:http'
import { createTransportFactory, type ExecutorTransportFactory } from '../src/host/services/superagent/executors/transport/index.ts'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createExecutors, durableDir, oneshotDir, recordPendingAttempt } from '../src/host/services/superagent/executors/attempts.ts'
import { budget } from '../src/host/services/superagent/executors/budget.ts'
import { inputMarker } from '../src/host/services/superagent/executors/events.ts'
import { EXECUTOR_DENIED_TOOLS, executorGuard } from '../src/host/services/superagent/executors/profiles/guard.ts'
import { createProfileRegistry, PROFILES, type Profile } from '../src/host/services/superagent/executors/profiles/index.ts'
import { DURABLE_FULL } from '../src/host/services/superagent/executors/profiles/durable-full.ts'
import { ONESHOT_READ } from '../src/host/services/superagent/executors/profiles/oneshot-read.ts'
import type { SpeechProposal } from '../src/host/services/superagent/kernel/ports.ts'
import type { NewCommitment } from '../src/host/services/superagent/kernel/ledger.ts'
import { DEFAULT_TABLE } from '../src/host/services/superagent/world/defaults.ts'
import { createWorldRegistry } from '../src/host/services/superagent/world/registry.ts'
import { createFakeController, type FakeController } from './fixtures/superagent/fake-controller.ts'
import { deliverSpec, openTestLedger, type TestLedger } from './fixtures/superagent/ledger.ts'

const MIN = 60_000
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

interface Rig {
  t: TestLedger
  controller: FakeController
  ex: ReturnType<typeof createExecutors>
  seatRoot: string
  speech: SpeechProposal[]
  asked: unknown[]
}

function rig(profiles: readonly Profile[] = PROFILES, transport?: ExecutorTransportFactory): Rig {
  const t = openTestLedger()
  const seatRoot = mkdtempSync(join(tmpdir(), 'sa-exec-'))
  dirs.push(seatRoot)
  const controller = createFakeController()
  const world = createWorldRegistry({ read: t.ledger.read, clock: t.clock, defaults: DEFAULT_TABLE })
  t.ledger.open(tx => {
    world.registerParty(tx, { party_id: 'ou_owner', union_id: 'on_owner', class: 'owner', source: 'config' })
    world.register(tx, { canonical: 'seat-repo', kind: 'repo', realm: 'local', path: 'local/repo', manifest: { executors: profiles.map(p => p.id) } })
    world.grantFromConfig(tx, [{ principal: 'ou_owner', scopePath: 'local/repo', capability: 'write_repo', strength: 'allow', grantedBy: 'owner' }], 1)
  }, { module: 'world' })
  const speech: SpeechProposal[] = []
  const asked: unknown[] = []
  const ex = createExecutors({
    ledger: t.ledger, controller: () => controller, transport, world, profiles: createProfileRegistry(profiles), clock: t.clock,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined }, seatRoot,
    speak: p => speech.push(p), askOwner: (...a) => asked.push(a), workspacePath: () => 'local/repo',
  })
  return { t, controller, ex, seatRoot, speech, asked }
}

/** commit's transaction: commitment (open) + pending attempt + brief, as T26 will write it. */
function commit(r: Rig, profile: Profile = DURABLE_FULL, over: Partial<NewCommitment> = {}) {
  return r.t.ledger.open(tx => {
    const c = tx.createCommitment({ ...deliverSpec({ desk_id: 'p2p:oc_1', ...over }), next_look_at: tx.now + 30 * MIN })
    const a = recordPendingAttempt(tx, c.commitment_id, profile, 'repo work fits a durable executor')
    tx.append(c.commitment_id, { actor: 'desk', kind: 'brief', body: { context: 'owner asked in p2p' } })
    return { c, a }
  })
}

const attempts = (r: Rig, cid: string) =>
  r.t.db.prepare('SELECT * FROM sa_attempt WHERE commitment_id = ? ORDER BY n').all(cid) as Array<Record<string, unknown>>
const one = (r: Rig, sql: string, ...p: Array<string | number>) => r.t.db.prepare(sql).get(...p) as Record<string, unknown>
const prompts = (r: Rig) => r.controller.calls.filter(c => c.method === 'prompt').map(c => (c as Extract<typeof c, { method: 'prompt' }>).req)
let seq = 0
const ev = (type: string, data: Record<string, unknown>, time?: number) => ({ type, seq: ++seq, ...(time === undefined ? {} : { time }), data })

describe('executors dispatch', () => {
  it('1. budget: clamp(eta x factor x 2.5, 5, 120) minutes; turns p90 x 1.5 or 12', () => {
    expect(budget(3, 2.1, undefined)).toEqual({ wall_ms: 15.75 * MIN, turns: 12 })
    expect(budget(100, 4, 8)).toEqual({ wall_ms: 120 * MIN, turns: 12 })
    expect(budget(1, 1, undefined).wall_ms).toBe(5 * MIN)
    expect(budget(3, 2.1, undefined, 10).wall_ms).toBe(4 * 15.75 * MIN)   // scale capped at 4
  })

  it('2. dispatch: session sa-x-C-1-a1, attempt cwd, superagent-executor preset, first prompt queue with intent and done_when; running', async () => {
    const r = rig()
    const { c, a } = commit(r)
    // T27 gap 4: an amend written while nothing ran reaches the first prompt with its marker.
    r.t.ledger.open(tx => tx.append(c.commitment_id, { actor: 'desk', kind: 'amend', request_id: 'am:early', body: { text: 'also cover lint' } }))
    const out = await r.ex.dispatch(c.commitment_id)
    expect(out).toEqual({ attemptId: a.attempt_id, sessionId: 'sa-x-C-1-a1' })
    const create = r.controller.calls.find(x => x.method === 'create') as Extract<FakeController['calls'][number], { method: 'create' }>
    expect(create.req).toEqual({ sessionId: 'sa-x-C-1-a1', cwd: durableDir(r.seatRoot, 'C-1'), agentPreset: 'superagent-executor' })
    const [first] = prompts(r)
    expect(first.mode).toBe('queue')
    expect(first.content[0].text).toContain('Intent: thing done')
    expect(first.content[0].text).toContain('test passes')
    expect(first.content[0].text).toContain('also cover lint')
    expect(first.content[0].text).toContain(inputMarker('am:early'))
    expect(attempts(r, c.commitment_id)[0]).toMatchObject({ state: 'running', session_id: 'sa-x-C-1-a1', branch: 'sa/C-1' })
    expect(one(r, 'SELECT path, branch, commitment_id FROM sa_workspace')).toEqual({ path: 'local/repo', branch: 'sa/C-1', commitment_id: 'C-1' })
    expect(one(r, `SELECT body_json FROM sa_journal WHERE kind = 'state'`).body_json).toContain('"agentPreset":"superagent-executor"')
  })

  it('3. a failed create ends the attempt as dispatch_failed and self-heals one tier up (n=2)', async () => {
    const r = rig()
    const { c } = commit(r)
    r.controller.failCreateTimes(1, new Error('host busy'))
    const out = await r.ex.dispatch(c.commitment_id)
    const rows = attempts(r, c.commitment_id)
    expect(rows[0]).toMatchObject({ n: 1, state: 'ended', end_reason: 'dispatch_failed', cancel_origin: 'dispatch' })
    expect(rows[1]).toMatchObject({ n: 2, executor: 'durable-full-strong', state: 'running' })
    expect(out).toEqual({ attemptId: rows[1].attempt_id, sessionId: 'sa-x-C-1-a2' })
    expect(one(r, 'SELECT state FROM sa_commitment').state).toBe('open')
  })

  it('4. after two failed redispatches the commitment is broken with one cannot proposal and no question', async () => {
    const r = rig()
    const { c } = commit(r)
    r.controller.failCreate(new Error('host down'))
    expect(await r.ex.dispatch(c.commitment_id)).toEqual({ failed: 'host down' })
    expect(attempts(r, c.commitment_id).map(x => x.state)).toEqual(['ended', 'ended', 'pending'])   // third queued for the agenda
    expect(one(r, 'SELECT state FROM sa_commitment').state).toBe('open')
    await r.ex.dispatch(c.commitment_id)
    expect(one(r, 'SELECT state, closed_at IS NOT NULL AS closed FROM sa_commitment')).toEqual({ state: 'broken', closed: 1 })
    expect(r.speech.map(s => s.moment)).toEqual(['cannot'])
    expect(r.speech[0].text).toContain('Tried:')
    expect(r.asked).toHaveLength(0)
    expect(one(r, 'SELECT count(*) AS n FROM sa_assumption').n).toBe(0)
  })

  it('5. a second durable deliver waits pending while the slot is held, then takes it', async () => {
    const r = rig()
    const first = commit(r)
    const second = commit(r)
    await r.ex.dispatch(first.c.commitment_id)
    expect(await r.ex.dispatch(second.c.commitment_id)).toEqual({ failed: 'SLOT_FULL' })
    expect(attempts(r, second.c.commitment_id)[0]).toMatchObject({ state: 'pending' })
    expect(r.t.db.prepare('SELECT commitment_id, slot FROM sa_commitment ORDER BY n').all()).toEqual([{ commitment_id: 'C-1', slot: '1' }, { commitment_id: 'C-2', slot: null }])
    await r.ex.cancel(first.a.attempt_id, 'release')
    r.t.ledger.open(tx => tx.transition(first.c.commitment_id, 'released'))
    expect(await r.ex.dispatch(second.c.commitment_id)).toMatchObject({ sessionId: 'sa-x-C-2-a1' })
  })

  it('5b. a dispatch that never seats releases the slot so another durable is not wedged', async () => {
    const r = rig()
    const first = commit(r)
    const second = commit(r)
    // Both of C-1's attempts fail to create; the third is queued for the agenda.
    r.controller.failCreateTimes(2, new Error('host busy'))
    expect(await r.ex.dispatch(first.c.commitment_id)).toEqual({ failed: 'host busy' })
    expect(attempts(r, first.c.commitment_id).map(x => x.state)).toEqual(['ended', 'ended', 'pending'])
    // The failed durable kept the commitment open but let go of the single slot.
    expect(one(r, 'SELECT slot FROM sa_commitment WHERE commitment_id = ?', 'C-1').slot).toBeNull()
    // So the other durable deliver seats now instead of SLOT_FULL until C-1 breaks.
    expect(await r.ex.dispatch(second.c.commitment_id)).toMatchObject({ sessionId: 'sa-x-C-2-a1' })
    expect(r.t.db.prepare('SELECT commitment_id, slot FROM sa_commitment ORDER BY n').all())
      .toEqual([{ commitment_id: 'C-1', slot: null }, { commitment_id: 'C-2', slot: '1' }])
  })

  it('6. a oneshot attempt takes no slot and runs next to a durable one', async () => {
    const r = rig()
    const durable = commit(r)
    const shot = commit(r, ONESHOT_READ)
    await r.ex.dispatch(durable.c.commitment_id)
    expect(await r.ex.dispatch(shot.c.commitment_id)).toMatchObject({ sessionId: 'sa-x-C-2-a1' })
    expect(one(r, `SELECT count(*) AS n FROM sa_attempt WHERE state = 'running'`).n).toBe(2)
    expect(existsSync(oneshotDir(r.seatRoot, shot.a.attempt_id))).toBe(true)
  })

  it('7. input steers an open turn, queues on an ended one; the consuming turn is written from the seq range', async () => {
    const r = rig()
    const { c, a } = commit(r)
    await r.ex.dispatch(c.commitment_id)
    const sid = 'sa-x-C-1-a1'
    r.ex.onSessionEvent(sid, ev('turn/start', { turn: 1 }))
    expect(await r.ex.sendInput(a.attempt_id, 'req-1', 'also cover X')).toEqual({ mode: 'steer' })
    expect(prompts(r).at(-1)).toMatchObject({ requestId: 'req-1', mode: 'steer' })
    expect(prompts(r).at(-1)?.content[0].text).toContain(inputMarker('req-1'))
    r.ex.onSessionEvent(sid, ev('user/message', { role: 'user', content: [{ type: 'text', text: `also cover X\n${inputMarker('req-1')}` }] }))
    expect(one(r, `SELECT consumed_turn FROM sa_journal WHERE request_id = 'req-1'`).consumed_turn).toBe(1)
    r.ex.onSessionEvent(sid, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    expect(await r.ex.sendInput(a.attempt_id, 'req-2', 'and Y')).toEqual({ mode: 'queue' })
    expect(one(r, `SELECT consumed_turn FROM sa_journal WHERE request_id = 'req-2'`).consumed_turn).toBeNull()
    expect(r.ex.lastTurnEnd(a.attempt_id)).toEqual({ turn: 1, reason: 'completed' })
  })

  it('8. tool/call events count calls, stamp last_tool_at and count repeats of one command', async () => {
    const r = rig()
    const { c, a } = commit(r)
    await r.ex.dispatch(c.commitment_id)
    const now = r.t.clock.now()
    for (let i = 0; i < 3; i++) {
      r.ex.onSessionEvent('sa-x-C-1-a1', ev('tool/call', { turn: 1, step: 1, callId: `c${i}`, name: 'bash', arguments: '{"command":"pnpm test"}' }, now + i))
    }
    expect(attempts(r, c.commitment_id)[0]).toMatchObject({ tool_calls: 3, last_tool_at: now + 2, repeat_sig: 'bash:pnpm test', repeat_count: 3 })
    r.ex.onSessionEvent('sa-x-C-1-a1', ev('tool/result', { turn: 1, step: 1, message: { toolCallId: 'c2', content: [{ type: 'text', text: 'FAIL\n[exit code: 1]' }], isError: false } }))
    expect(r.ex.toolLog(a.attempt_id).at(-1)).toMatchObject({ callId: 'c2', exit: 1 })
  })

  it('9. wall line with progress extends once (extended=1); the second hit cancels with origin budget', async () => {
    const r = rig()
    const { c, a } = commit(r)
    await r.ex.dispatch(c.commitment_id)
    const tick = (n: number) => r.ex.onSessionEvent('sa-x-C-1-a1', ev('tool/call', { turn: 1, step: 1, callId: `k${n}`, name: 'edit', arguments: `{"path":"f${n}.ts"}` }, r.t.clock.now()))
    r.t.clock.advance(30 * MIN); tick(1)
    expect(await r.ex.supervise(r.t.clock.now())).toEqual([{ attemptId: a.attempt_id, action: 'extend' }])
    expect(one(r, 'SELECT extended, state, budget_wall_ms, budget_turns FROM sa_commitment')).toEqual({ extended: 1, state: 'open', budget_wall_ms: 45 * MIN, budget_turns: 30 })
    r.t.clock.advance(15 * MIN); tick(2)
    expect(await r.ex.supervise(r.t.clock.now())).toEqual([{ attemptId: a.attempt_id, action: 'budget' }])
    expect(attempts(r, c.commitment_id)[0]).toMatchObject({ state: 'ended', cancel_origin: 'budget' })
  })

  it('10. wall line without progress cancels with origin budget and proposes nothing', async () => {
    const r = rig()
    const { c, a } = commit(r)
    await r.ex.dispatch(c.commitment_id)
    r.t.clock.advance(30 * MIN)
    expect(await r.ex.supervise(r.t.clock.now())).toEqual([{ attemptId: a.attempt_id, action: 'budget' }])
    expect(attempts(r, c.commitment_id)[0]).toMatchObject({ state: 'ended', cancel_origin: 'budget' })
    expect(one(r, 'SELECT extended FROM sa_commitment').extended).toBe(0)
    expect(r.speech).toHaveLength(0)
  })

  it('11. modelFor returns the profile provider/model for its session; unknown sessions are undefined', async () => {
    const custom: Profile = { ...DURABLE_FULL, id: 'durable-pinned', provider: 'prov-a', model: 'model-b', effort: 'high' }
    const r = rig([ONESHOT_READ, custom])
    const { c } = commit(r, custom)
    await r.ex.dispatch(c.commitment_id)
    expect(r.ex.modelFor('sa-x-C-1-a1')).toEqual({ provider: 'prov-a', model: 'model-b', effort: 'high' })
    expect(r.ex.roleOf('sa-x-C-1-a1')).toBe('executor:durable-pinned')
    expect(r.ex.modelFor('sa-x-nope')).toBeUndefined()
    expect(r.ex.roleOf('sa-x-nope')).toBeUndefined()
  })

  it('12. report: blocked without a question is QUESTION_REQUIRED; ready without evidence is accepted', async () => {
    const r = rig()
    const { c, a } = commit(r)
    await r.ex.dispatch(c.commitment_id)
    const ctx = { sessionId: 'sa-x-C-1-a1' }
    expect(r.ex.report.execute({ state: 'blocked', summary: 'stuck' }, ctx)).toMatchObject({ ok: false, code: 'QUESTION_REQUIRED' })
    expect(r.ex.report.execute({ state: 'ready', summary: 'done' }, ctx)).toMatchObject({ ok: true })
    expect(one(r, `SELECT count(*) AS n FROM sa_journal WHERE kind = 'report'`).n).toBe(1)
    expect(r.ex.lastReport(a.attempt_id)).toEqual({ state: 'ready', summary: 'done' })
  })

  it('13. cancel calls the controller, ends the attempt with the given origin, and leaves nothing running (I3)', async () => {
    const r = rig()
    const { c, a } = commit(r)
    await r.ex.dispatch(c.commitment_id)
    await r.ex.cancel(a.attempt_id, 'release')
    expect(r.controller.calls.filter(x => x.method === 'cancel')).toEqual([{ method: 'cancel', req: { sessionId: 'sa-x-C-1-a1' } }])
    expect(attempts(r, c.commitment_id)[0]).toMatchObject({ state: 'ended', cancel_origin: 'release', end_reason: 'aborted' })
    expect(one(r, `SELECT count(*) AS n FROM sa_attempt WHERE state = 'running'`).n).toBe(0)
  })

  it('15. a turn ended aborted without our own cancel is recorded as an external stop', async () => {
    const r = rig()
    const { c } = commit(r)
    await r.ex.dispatch(c.commitment_id)
    const sid = 'sa-x-C-1-a1'
    r.ex.onSessionEvent(sid, ev('turn/start', { turn: 1 }))
    r.ex.onSessionEvent(sid, ev('turn/end', { turn: 1, reason: { kind: 'aborted' } }))
    expect(attempts(r, c.commitment_id)[0]).toMatchObject({ state: 'running', cancel_origin: 'external', turn_open: 0 })
    // A cancellation this process issued keeps its own origin, never `external`.
    const r2 = rig()
    const second = commit(r2)
    await r2.ex.dispatch(second.c.commitment_id)
    await r2.ex.cancel(second.a.attempt_id, 'release')
    r2.ex.onSessionEvent('sa-x-C-1-a1', ev('turn/end', { turn: 1, reason: { kind: 'aborted' } }))
    expect(attempts(r2, second.c.commitment_id)[0]).toMatchObject({ cancel_origin: 'release' })
  })

  it('16. the fenced JSON report is the fallback when the host has no report tool', async () => {
    const r = rig()
    const { c, a } = commit(r)
    await r.ex.dispatch(c.commitment_id)
    const text = 'Done.\n```json\n{"state":"ready","summary":"tests pass","evidence":[{"command":"pnpm test","exit":0,"reading":"ok"}]}\n```'
    r.ex.onSessionEvent('sa-x-C-1-a1', ev('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] } }))
    expect(r.ex.lastReport(a.attempt_id)).toEqual({
      state: 'ready', summary: 'tests pass', evidence: [{ command: 'pnpm test', exit: 0, reading: 'ok' }],
    })
  })

  it('17. a report tool call on the event stream is the claim even without a local tool', async () => {
    const r = rig()
    const { c, a } = commit(r)
    await r.ex.dispatch(c.commitment_id)
    const args = JSON.stringify({ state: 'ready', summary: 'tests pass', evidence: [{ command: 'pnpm test', exit: 0, reading: 'ok' }] })
    r.ex.onSessionEvent('sa-x-C-1-a1', ev('tool/call', { turn: 1, step: 1, callId: 'c9', name: 'report', arguments: args }))
    expect(r.ex.lastReport(a.attempt_id)).toEqual({
      state: 'ready', summary: 'tests pass', evidence: [{ command: 'pnpm test', exit: 0, reading: 'ok' }],
    })
    expect(r.ex.toolLog(a.attempt_id).at(-1)).toMatchObject({ name: 'report' })
  })

  it('18. refuses a wrong-cwd session without cancelling it or prompting an alternate attempt', async () => {
    const r = rig(), { c, a } = commit(r)
    const stale = join(r.seatRoot, 'work', 'STALE')
    r.controller.seedSession('sa-x-C-1-a1', stale)
    expect(await r.ex.dispatch(c.commitment_id)).toMatchObject({ failed: expect.stringContaining('belongs to') })
    expect(r.controller.calls.map(x => x.method)).toEqual(['create'])
    expect(attempts(r, c.commitment_id)).toHaveLength(1)
    expect(attempts(r, c.commitment_id)[0]).toMatchObject({ attempt_id: a.attempt_id, state: 'ended', end_reason: 'dispatch_failed' })
    expect(prompts(r)).toEqual([])
  })

  it.each(['MODEL_UNAVAILABLE', 'PRESET_UNAVAILABLE', 'HOST_PROTOCOL'])('preserves %s without silently upgrading the requested route', async code => {
    const r = rig(), { c } = commit(r)
    r.controller.failCreateTimes(1, Object.assign(Error('required setup refused'), { code }))
    expect(await r.ex.dispatch(c.commitment_id)).toEqual({ failed: 'required setup refused' })
    expect(attempts(r, c.commitment_id)).toHaveLength(1)
    expect(prompts(r)).toEqual([])
  })

  it('real HTTP model-selection refusal cannot be retried under another dispatcher profile', async () => {
    const calls: string[] = []
    const server = createServer((req, res) => { if (req.method !== 'POST') { res.writeHead(404).end(); return }; let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => {
      const message = JSON.parse(body), method = message.method; calls.push(method)
      const value = method === 'agentPresets/list' ? { presets: [{ id: 'superagent-executor' }] } : method === 'session/create' ? { sessionId: message.payload.args.request.sessionId } : null
      const result = method === 'session/selectModel' ? { ok: false, error: { code: 'MODEL_UNAVAILABLE', message: 'required model refused' } } : { ok: true, value }
      res.end(JSON.stringify({ result }))
    }) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const transport = createTransportFactory({ config: { transport: 'http', localBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` }, controller: () => { throw Error('no inproc fallback') } })
    const profiles = PROFILES.map(p => p.id === DURABLE_FULL.id ? { ...p, provider: 'required', model: 'required' } : p)
    const r = rig(profiles, transport), { c } = commit(r, profiles.find(p => p.id === DURABLE_FULL.id)!)
    try {
      expect(await r.ex.dispatch(c.commitment_id)).toMatchObject({ failed: expect.stringContaining('required model refused') })
      expect(calls).toEqual(['agentPresets/list', 'session/create', 'session/selectModel'])
      expect(attempts(r, c.commitment_id)).toHaveLength(1)
      expect(attempts(r, c.commitment_id)[0]).toMatchObject({ state: 'ended', end_reason: 'dispatch_failed', provider: 'required', model: 'required' })
    } finally { transport.dispose(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })

  it('14. executorGuard: read-only refuses writes; every profile refuses channel and worktree tools', () => {
    expect(executorGuard(ONESHOT_READ, 'bash')).toMatch(/read-only/)
    expect(executorGuard(ONESHOT_READ, 'edit_file')).toMatch(/read-only/)
    for (const p of PROFILES) {
      expect(executorGuard(p, 'lark_inbox_reply')).toBeDefined()
      expect(executorGuard(p, 'worktree_lane')).toBeDefined()
      expect(executorGuard(p, 'subagent', { preset: 'reviewer' })).toBeDefined()
    }
    expect(EXECUTOR_DENIED_TOOLS).toContain('lark_inbox_reply')
    expect(executorGuard(ONESHOT_READ, 'read_file')).toBeUndefined()
    expect(executorGuard(DURABLE_FULL, 'bash')).toBeUndefined()
  })
})
