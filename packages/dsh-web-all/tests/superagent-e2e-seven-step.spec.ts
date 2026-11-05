/**
 * The seven-step acceptance chain (01 §E, T30) end to end on one ledger.
 *
 * The owner's sentence: 「把 lark-inbox 的某个超时改成 X，并跑对应测试」. One assembled
 * superagent (real InboxStore and Feishu channel, the composition root, a scripted
 * desk and executor on the fake controller), one continuous scenario, one database
 * that step 7 hands to scripts/superagent-check.mjs. Each job runs on its own thread
 * so every E criterion reads the shape it is about:
 *   A  steps 1-3 (accept, wait, deliver) and 4b (follow-up after delivery)
 *   B  step 4a (added while running; B stays open to the end)
 *   C  step 5 (stop)
 * The manual clock starts 36 minutes before real time and `Date` follows it, so the
 * check script's real-time criteria (X-stale, I1, windows) read a recent ledger.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { toEnvelope } from '../src/core/lark-inbox/queue.ts'
import { createFeishuChannel } from '../src/host/services/superagent/channels/feishu/channel.ts'
import { InboxStore } from '../src/host/services/superagent/channels/feishu/inbox-store.ts'
import { DEFAULT_SUPERAGENT_CONFIG, type SuperagentConfig } from '../src/host/services/superagent/config.ts'
import type { AgentScopeLike, DeskTool, ToolFacePort } from '../src/host/services/superagent/desk/toolface.ts'
import { createSuperagent, type Assembly } from '../src/host/services/superagent/index.ts'
import type { SenderPort } from '../src/host/services/superagent/kernel/ports.ts'
import { createFakeController, type FakeController } from './fixtures/superagent/fake-controller.ts'
import { createManualClock, type ManualClock } from './fixtures/superagent/manual-clock.ts'
import { createScriptedAgent, type DeskStep, type ScriptedAgent } from './fixtures/superagent/scripted-agent.ts'

const OWNER = 'on_owner'
const MIN = 60_000
const REPO = join(__dirname, '../../..')
const CHECK = join(REPO, 'scripts/superagent-check.mjs')
const settle = async (rounds = 30): Promise<void> => { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)) }

interface World {
  root: string
  path: string
  store: InboxStore
  clock: ManualClock
  base: FakeController
  agent: ScriptedAgent
  cfg: SuperagentConfig
  tools: Map<string, DeskTool[]>
  sent: { chatId: string; text: string }[]
  asm: Assembly
  build(): Assembly
  deliver(text: string, root?: string): { id: string; messageId: string; receivedAt: number }
  rows(sql: string, ...p: Array<string | number>): Array<Record<string, unknown>>
}
let W: World
const threads: Record<'A' | 'B' | 'C', string> = { A: '', B: '', C: '' }
let snapshotFile = ''

function makeWorld(): World {
  const root = mkdtempSync(join(tmpdir(), 'sa-e2e-'))
  const clock = createManualClock(Date.now() - 36 * MIN)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(clock.now())
  const advance = clock.advance.bind(clock)
  clock.advance = (ms: number) => { advance(ms); vi.setSystemTime(clock.now()) }
  const store = InboxStore.open({ rootDir: root })
  const cfg: SuperagentConfig = {
    ...structuredClone(DEFAULT_SUPERAGENT_CONFIG), superagentMode: 'superagent',
    superagentWorld: {
      entities: [{ canonical: 'dsh-web', kind: 'repo', realm: 'local', path: 'local/' }],
      mandates: [{ principal: OWNER, scopePath: 'local/', capability: 'write_repo', strength: 'allow', grantedBy: 'owner' }],
      owners: [{ union_id: OWNER, name: '老板' }], colleagues: [],
    },
    superagentAttention: { interruptQuota: 3, quiet: { from: '00:00', to: '00:00' }, briefAt: '23:59' },
  }
  const tools = new Map<string, DeskTool[]>()
  const toolface: ToolFacePort = {
    async scope(sessionId): Promise<AgentScopeLike> {
      if (!tools.has(sessionId)) tools.set(sessionId, [])
      return { restrict: () => () => undefined, register: t => { tools.get(sessionId)?.push(t); return () => undefined },
        guard: () => () => undefined, visible: () => (tools.get(sessionId) ?? []).map(t => t.name) }
    },
  }
  const sent: World['sent'] = []
  const sender: SenderPort = { send: async (chatId, text) => { sent.push({ chatId, text }); return { messageId: `om_out_${sent.length}` } }, react: async () => undefined }
  const base = createFakeController()
  const w = { root, path: join(root, 'inbox.sqlite'), store, clock, base, cfg, tools, sent } as World
  w.agent = createScriptedAgent({ base, deskTools: sid => tools.get(sid), report: () => w.asm.reportTool(), emit: (sid, ev) => w.asm.onSessionEvent(sid, ev), now: () => clock.now() })
  w.build = () => createSuperagent({ config: () => cfg, controller: () => w.agent.controller, clock, log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    sender, holder: 'proc-e2e', seatRoot: join(root, 'seat'), seatDir: join(root, 'desk'), toolface, tz: 'UTC' })
  w.asm = w.build()
  const channel = createFeishuChannel({ store: () => store, sender: () => undefined, reactor: () => undefined, members: async () => [],
    ownerUnionIds: () => [OWNER], hooks: { admit: e => w.asm.admit(e) } })
  let seq = 0
  w.deliver = (text, rootId) => {
    seq += 1
    const id = `evt-${seq}`
    const messageId = `om_${id}`
    const envelope = toEnvelope({ header: { event_id: id }, event: {
      sender: { sender_id: { open_id: 'ou_owner', union_id: OWNER }, sender_type: 'user' },
      message: { message_id: messageId, chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }),
        ...(rootId ? { root_id: rootId } : {}) } } })
    expect(store.append(envelope)).toBe('appended')
    const receivedAt = Date.now()
    channel.deliver(envelope, () => undefined)
    return { id, messageId, receivedAt }
  }
  w.rows = (sql, ...p) => {
    const db = w.asm.ledger() as unknown as { read: { all<T>(s: string, ...a: unknown[]): T[] } }
    return db.read.all<Record<string, unknown>>(sql, ...p)
  }
  return w
}

/** Move the clock (a new 5-minute window keeps D-pub/D-fp honest) and let every timer and turn run. */
async function step(ms: number): Promise<void> {
  W.clock.advance(ms)
  await settle()
  await W.agent.settle()
  await settle()
}
/** Executor B's keep-alive: a tool call each step, so stall self-heal and X-stale see a live worker. */
async function beatB(): Promise<void> {
  if (W.rows(`SELECT 1 FROM sa_attempt WHERE attempt_id = 'C-2:A1' AND state = 'running'`).length) {
    await W.agent.run('sa-x-C-2-a1', [{ call: { name: 'read_file', args: { path: `src/notify/${Date.now()}.ts` } } }])
  }
}
const judgeStep = (disposition: string, extra: Record<string, unknown> = {}): DeskStep =>
  ({ tool: 'judge', input: t => ({ event_id: t.eventIds[0], disposition, class: 'repo-change', confidence: 0.9, reason: 'owner request', ...extra }) })
const commitStep = (over: Record<string, unknown>): DeskStep =>
  ({ tool: 'commit', input: t => ({ event_id: t.eventIds[0], kind: 'deliver', check_kind: 'command', executor: 'durable-full',
    executor_reason: 'changing the repo needs its own workspace', eta_minutes: 120, ...over }) })
const one = (sql: string, ...p: Array<string | number>): Record<string, unknown> => W.rows(sql, ...p)[0]

beforeAll(async () => {
  W = makeWorld()
  await W.asm.start(W.path)
})
afterAll(async () => {
  await W.asm.dispose()
  W.store.close()   // the last connection: checkpoints the WAL into the file
  // Opt-in: keep the ledger and the pre-restart snapshot for a standalone DONE-3 reading.
  const keep = process.env.SA_E2E_KEEP
  if (keep) { copyFileSync(W.path, `${keep}.sqlite`); if (snapshotFile) copyFileSync(snapshotFile, `${keep}.open.json`) }
  vi.useRealTimers()
  rmSync(W.root, { recursive: true, force: true })
})

describe('seven-step chain', () => {
  it('1. one sentence: the ack goes out within 30 s and before the dispatch; a failed create self-heals without a cannot', async () => {
    await step(5 * MIN)
    W.agent.desk([judgeStep('commit'), commitStep({ what: '把 lark-inbox 的某个超时改成 X', intent: '超时为 X 且对应测试通过',
      done_when: '`pnpm vitest run tests/lark-inbox-responder.spec.ts` 期望退出码 0' })])
    const a = W.deliver('把 lark-inbox 的某个超时改成 X，并跑对应测试')
    threads.A = a.messageId
    await step(4000)
    await step(1000)
    const c = one(`SELECT commitment_id, state, thread_key FROM sa_commitment WHERE commitment_id = 'C-1'`)
    // T30 thread-key fix: one composition, no doubled prefix; the subscription agrees.
    expect(c).toEqual({ commitment_id: 'C-1', state: 'open', thread_key: `p2p:oc_dm:${a.messageId}` })
    expect(W.rows(`SELECT thread_key FROM sa_subscription WHERE commitment_id = 'C-1'`)).toEqual([{ thread_key: `p2p:oc_dm:${a.messageId}` }])
    const ack = one(`SELECT created_at, state, body FROM sa_outbox WHERE commitment_id = 'C-1' AND moment = 'ack'`)
    const attempt = one(`SELECT state, started_at FROM sa_attempt WHERE commitment_id = 'C-1'`)
    expect(attempt.state).toBe('running')
    expect(Number(ack.created_at) - a.receivedAt).toBeLessThanOrEqual(30_000)
    expect(Number(ack.created_at)).toBeLessThanOrEqual(Number(attempt.started_at))
    expect(ack.state).toBe('sent')
    expect(String(ack.body)).toContain('接了 C-1')

    // Variant on a separate ledger: create fails once -> self-heal redispatch, no termination sentence.
    const saved = W
    const variant = makeWorld()
    W = variant
    try {
      await variant.asm.start(variant.path)
      // The failure is armed at commit time so it hits the executor's create, not the desk's.
      const arm: DeskStep = { tool: 'commit', input: t => { variant.base.failCreateTimes(1, new Error('host busy'))
        return commitStep({ what: '查 W', intent: '知道 W', check_kind: 'answer', done_when: '要包含 W 的状态', executor: 'oneshot-read' }).input(t) } }
      variant.agent.desk([judgeStep('commit', { class: 'lookup' }), arm])
      variant.deliver('帮我查一下 W 的状态')
      await step(4000)
    await step(1000)
      expect(variant.rows(`SELECT n, state, end_reason FROM sa_attempt ORDER BY n`)).toEqual([
        { n: 1, state: 'ended', end_reason: 'dispatch_failed' }, { n: 2, state: 'running', end_reason: null }])
      expect(variant.rows(`SELECT count(*) AS n FROM sa_outbox WHERE moment = 'cannot'`)).toEqual([{ n: 0 }])
    } finally {
      await variant.asm.dispose()
      rmSync(variant.root, { recursive: true, force: true })
      W = saved
      vi.setSystemTime(W.clock.now())
    }
  })

  it('2. waiting: the executor works, and nothing is said between the ack and the delivery', async () => {
    const before = W.sent.length
    await W.agent.run('sa-x-C-1-a1', [{ call: { name: 'edit_file', args: { path: 'src/core/lark-inbox/reply-machine.ts' } } }])
    await step(MIN)
    await W.agent.run('sa-x-C-1-a1', [{ call: { name: 'read_file', args: { path: 'tests/lark-inbox-responder.spec.ts' } } }])
    await step(MIN)
    expect(W.rows(`SELECT moment FROM sa_outbox WHERE commitment_id = 'C-1'`)).toEqual([{ moment: 'ack' }])
    expect(W.sent.length).toBe(before)
    expect(one(`SELECT tool_calls FROM sa_attempt WHERE attempt_id = 'C-1:A1'`).tool_calls).toBe(2)
  })

  it('3. delivery: fulfilled on evidence the session events confirm, the delivery is at most 100 words', async () => {
    await step(5 * MIN)
    W.agent.desk([{ tool: 'say', input: () => ({ commitment_id: 'C-1', moment: 'deliver',
      text: 'C-1 做完了：超时已改成 X；pnpm vitest run tests/lark-inbox-responder.spec.ts 退出码 0。' }) }])
    const command = 'pnpm vitest run tests/lark-inbox-responder.spec.ts'
    await W.agent.run('sa-x-C-1-a1', [
      { call: { name: 'bash', args: { command }, output: 'Tests  40 passed (40)' } },
      { report: { state: 'ready', summary: '超时已改成 X，对应测试通过', evidence: [{ command, exit: 0, reading: 'Tests 40 passed' }] } },
      { end: 'completed' },
    ])
    await step(2000)
    await step(1000)
    expect(one(`SELECT state, evidence_json IS NOT NULL AS ev FROM sa_commitment WHERE commitment_id = 'C-1'`)).toEqual({ state: 'fulfilled', ev: 1 })
    const delivery = W.rows(`SELECT words, state FROM sa_outbox WHERE commitment_id = 'C-1' AND moment = 'deliver'`)
    expect(delivery).toHaveLength(1)
    expect(Number(delivery[0].words)).toBeLessThanOrEqual(100)
    expect(W.sent.at(-1)?.text).toContain('C-1 做完了')
  })

  it('4. "顺便把 Z 也改了": (a) while running it joins the commitment and is consumed; (b) after delivery it is a child; one top-level each', async () => {
    // (a) thread B: accept, then add a line while the executor runs.
    await step(5 * MIN)
    W.agent.desk([judgeStep('commit'), commitStep({ what: '把 notify 的重试次数改成 5', intent: '重试次数为 5 且测试通过',
      done_when: '`pnpm vitest run tests/notify.spec.ts` 期望退出码 0' })])
    const b = W.deliver('把 notify 的重试次数改成 5，并跑测试')
    threads.B = b.messageId
    await step(4000)
    await step(1000)
    expect(one(`SELECT state FROM sa_attempt WHERE attempt_id = 'C-2:A1'`).state).toBe('running')
    await beatB()
    await step(5 * MIN)
    await beatB()
    W.agent.desk([judgeStep('amend', { about: 'C-2' }), { tool: 'amend', input: () => ({ commitment_id: 'C-2', text: '顺便把 Z 也改了' }) }])
    W.deliver('顺便把 Z 也改了', threads.B)
    await step(4000)
    await step(1000)
    expect(W.rows(`SELECT consumed_turn FROM sa_journal WHERE commitment_id = 'C-2' AND kind = 'amend'`)).toEqual([{ consumed_turn: 1 }])
    expect(one(`SELECT count(*) AS n FROM sa_commitment WHERE thread_key = ? AND parent_id IS NULL`, `p2p:oc_dm:${threads.B}`).n).toBe(1)
    expect(one(`SELECT count(*) AS n FROM sa_intake WHERE disposition = 'amend'`).n).toBe(1)

    // (b) thread A after delivery: a child of C-1 with its history.
    await step(5 * MIN)
    await beatB()
    W.agent.desk([judgeStep('commit', { about: 'C-1' }), commitStep({ what: '顺便把 Z 也改了', intent: 'Z 也改好',
      done_when: '`pnpm vitest run tests/lark-inbox-responder.spec.ts` 期望退出码 0' })])
    W.deliver('顺便把 Z 也改了', threads.A)
    await step(4000)
    await step(1000)
    expect(one(`SELECT commitment_id, parent_id, thread_key FROM sa_commitment WHERE commitment_id = 'C-3'`))
      .toEqual({ commitment_id: 'C-3', parent_id: 'C-1', thread_key: `p2p:oc_dm:${threads.A}` })
    expect(String(one(`SELECT body_json FROM sa_journal WHERE commitment_id = 'C-3' AND kind = 'brief'`).body_json)).toContain('接续 C-1')
    expect(one(`SELECT count(*) AS n FROM sa_commitment WHERE thread_key = ? AND parent_id IS NULL`, `p2p:oc_dm:${threads.A}`).n).toBe(1)
  })

  it('5. "停": the immediate path releases within 60 s, ends the attempt, cancels the session, says at most one receipt', async () => {
    await step(5 * MIN)
    await beatB()
    W.agent.desk([judgeStep('commit', { class: 'lookup' }), commitStep({ what: '查一下发布状态', intent: '知道发布状态', check_kind: 'answer',
      done_when: '要包含 发布状态与时间', executor: 'oneshot-read' })])
    const c = W.deliver('帮我查一下发布状态')
    threads.C = c.messageId
    await step(4000)
    await step(1000)
    expect(one(`SELECT state FROM sa_attempt WHERE commitment_id = 'C-4'`).state).toBe('running')
    const stop = W.deliver('停', threads.C)
    await settle()
    const row = one(`SELECT state, closed_at FROM sa_commitment WHERE commitment_id = 'C-4'`)
    expect(row.state).toBe('released')
    expect(Number(row.closed_at) - stop.receivedAt).toBeLessThanOrEqual(60_000)
    expect(W.rows(`SELECT state, cancel_origin FROM sa_attempt WHERE commitment_id = 'C-4'`)).toEqual([{ state: 'ended', cancel_origin: 'release' }])
    expect(W.base.calls.filter(x => x.method === 'cancel').map(x => (x as { req: { sessionId: string } }).req.sessionId)).toContain('sa-x-C-4-a1')
    expect(one(`SELECT count(*) AS n FROM sa_outbox WHERE commitment_id = 'C-4' AND created_at >= ?`, Number(row.closed_at)).n).toBeLessThanOrEqual(1)
    expect(one(`SELECT disposition FROM sa_intake WHERE event_id = ?`, stop.id).disposition).toBe('release')
  })

  it('6. restart: the open set before and after reassembly is the same, nothing reopened or redispatched', async () => {
    await beatB()
    await step(MIN)
    snapshotFile = join(W.root, 'open-before.json')
    // --snapshot writes the open set and still runs every criterion; its verdict is step 7's job.
    try { execFileSync(process.execPath, [CHECK, '--db', W.path, '--snapshot', snapshotFile], { stdio: 'pipe' }) } catch { /* verdict read in step 7 */ }
    expect(existsSync(snapshotFile)).toBe(true)
    const openSet = (): unknown => W.rows(`SELECT commitment_id, state FROM sa_commitment WHERE state IN ('proposed', 'open', 'at_risk') ORDER BY n`)
    const before = { open: openSet(), commitments: W.rows('SELECT count(*) AS n FROM sa_commitment'), attempts: W.rows('SELECT count(*) AS n FROM sa_attempt') }
    const creates = W.base.calls.filter(x => x.method === 'create').length
    await W.asm.dispose()
    W.asm = W.build()
    await W.asm.start(W.path)
    await step(2 * MIN)
    await beatB()
    expect({ open: openSet(), commitments: W.rows('SELECT count(*) AS n FROM sa_commitment'), attempts: W.rows('SELECT count(*) AS n FROM sa_attempt') }).toEqual(before)
    expect(W.base.calls.filter(x => x.method === 'create').length).toBe(creates)
    expect(openSet()).toEqual([{ commitment_id: 'C-2', state: 'open' }, { commitment_id: 'C-3', state: 'open' }])
  })

  it('7. the whole run: superagent-check over this ledger exits 0 (I1-I4, E1-E7)', async () => {
    let out = ''
    let code = 0
    try {
      out = execFileSync(process.execPath, [CHECK, '--db', W.path, '--compare', snapshotFile], { encoding: 'utf8', stdio: 'pipe' })
    } catch (error) {
      const e = error as { status?: number; stdout?: string }
      code = e.status ?? 1
      out = e.stdout ?? ''
    }
    expect(out).not.toMatch(/FAIL/)
    for (const id of ['I1', 'I2', 'I3', 'I4', 'E1', 'E2', 'E3', 'E4', 'E5', 'E7']) expect(out).toMatch(new RegExp(`^${id} ok`, 'm'))
    expect(out).toMatch(/^E6 (ok|nodata)/m)
    expect(code).toBe(0)
  })
})
