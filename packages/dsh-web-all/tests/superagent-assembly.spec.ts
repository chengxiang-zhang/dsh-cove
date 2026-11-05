/**
 * Superagent composition root and the three-way switch (T27).
 *
 * A real InboxStore on a temp directory (it creates inbox_events, then the ledger
 * opens the same file), a real Feishu channel with the assembly's admission hook,
 * the fake session controller, a manual clock and a stub tool-face port.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { toEnvelope } from '../src/core/lark-inbox/queue.ts'
import { createFeishuChannel } from '../src/host/services/superagent/channels/feishu/channel.ts'
import { InboxStore } from '../src/host/services/superagent/channels/feishu/inbox-store.ts'
import { DEFAULT_SUPERAGENT_CONFIG, type SuperagentConfig } from '../src/host/services/superagent/config.ts'
import type { AgentScopeLike, DeskTool, ToolFacePort } from '../src/host/services/superagent/desk/toolface.ts'
import { createSuperagent, overrideModel, type Assembly } from '../src/host/services/superagent/index.ts'
import type { SenderPort } from '../src/host/services/superagent/kernel/ports.ts'
import { openLedgerDb } from '../src/host/services/superagent/protocol/db.ts'
import { createBriefNow } from '../src/host/services/superagent/timing/brief.ts'
import { createFakeController, type FakeController } from './fixtures/superagent/fake-controller.ts'
import { createManualClock, type ManualClock } from './fixtures/superagent/manual-clock.ts'

const OWNER = 'on_owner'
const dirs: string[] = []
const assemblies: Assembly[] = []
afterEach(async () => {
  for (const a of assemblies.splice(0)) await a.dispose()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const settle = async (rounds = 20): Promise<void> => { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)) }

interface Rig {
  asm: Assembly
  cfg: SuperagentConfig
  clock: ManualClock
  controller: FakeController
  store: InboxStore
  path: string
  sent: { chatId: string; text: string; idemKey: string }[]
  kicks: string[]
  tools: Map<string, DeskTool[]>
  diagnostics: string[]
  dbs: DatabaseSync[]
  deliver(text: string, over?: { chat?: string }): string
  rows(sql: string, ...p: Array<string | number>): Array<Record<string, unknown>>
}

function rig(opts: { mode?: SuperagentConfig['superagentMode']; openDb?: (path: string) => DatabaseSync; start?: boolean } = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), 'sa-asm-'))
  dirs.push(root)
  const store = InboxStore.open({ rootDir: root })
  const cfg: SuperagentConfig = { ...structuredClone(DEFAULT_SUPERAGENT_CONFIG), superagentMode: opts.mode ?? 'responder',
    superagentWorld: { entities: [], mandates: [], owners: [{ union_id: OWNER, name: '老板' }], colleagues: [] } }
  const clock = createManualClock(Date.UTC(2026, 10, 6, 2, 0, 0))
  const controller = createFakeController()
  const sent: Rig['sent'] = []
  const sender: SenderPort = {
    send: async (chatId, text, idemKey) => { sent.push({ chatId, text, idemKey }); return { messageId: `om_out_${sent.length}` } },
    react: async () => undefined,
  }
  const tools = new Map<string, DeskTool[]>()
  const toolface: ToolFacePort = {
    async scope(sessionId): Promise<AgentScopeLike> {
      return {
        restrict: () => () => undefined,
        register: tool => { tools.set(sessionId, [...(tools.get(sessionId) ?? []), tool]); return () => undefined },
        guard: () => () => undefined,
        visible: () => (tools.get(sessionId) ?? []).map(t => t.name),
      }
    },
  }
  const diagnostics: string[] = []
  const dbs: DatabaseSync[] = []
  const asm = createSuperagent({
    openDb: p => { const db = (opts.openDb ?? openLedgerDb)(p); dbs.push(db); return db },
    config: () => cfg, controller: () => controller, clock, log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    sender, holder: 'proc-test', seatRoot: join(root, 'seat'), seatDir: join(root, 'desk'), toolface, diagnostic: m => diagnostics.push(m), tz: 'UTC',
  })
  assemblies.push(asm)
  const kicks: string[] = []
  const channel = createFeishuChannel({ store: () => store, sender: () => undefined, reactor: () => undefined,
    members: async () => [], ownerUnionIds: () => [OWNER], hooks: { admit: e => asm.admit(e) } })
  let seq = 0
  const path = join(root, 'inbox.sqlite')
  const r: Rig = {
    asm, cfg, clock, controller, store, path, sent, kicks, tools, diagnostics, dbs,
    deliver(text, over = {}) {
      seq += 1
      const id = `evt-${seq}`
      const envelope = toEnvelope({
        header: { event_id: id },
        event: {
          sender: { sender_id: { open_id: 'ou_owner', union_id: OWNER }, sender_type: 'user' },
          message: { message_id: `om_${id}`, chat_id: over.chat ?? 'oc_dm', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) },
        },
      })
      expect(store.append(envelope)).toBe('appended')
      channel.deliver(envelope, () => kicks.push(id))
      return id
    },
    rows: (sql, ...p) => (dbs[0] as DatabaseSync).prepare(sql).all(...p) as Array<Record<string, unknown>>,
  }
  return r
}

async function started(opts: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = rig(opts)
  await r.asm.start(r.path)
  return r
}

/** Close the 3 s collect window and let the desk turn reach its prompt. */
async function runDesk(r: Rig): Promise<string> {
  r.clock.advance(4000)
  await settle()
  const sid = [...r.tools.keys()].find(k => k.startsWith('sa-desk-'))
  expect(sid).toBeDefined()
  return sid as string
}
const call = (r: Rig, sid: string, name: string, input: unknown) =>
  (r.tools.get(sid)?.find(t => t.name === name) as DeskTool).execute(input, { sessionId: sid }) as Promise<Record<string, unknown>>
async function endTurn(r: Rig, sid: string): Promise<void> {
  r.asm.onSessionEvent(sid, { type: 'turn/end', seq: 99, data: { turn: 1, reason: { kind: 'completed' } } })
  await settle()
}

describe('superagent assembly', () => {
  it('1. responder (default): owner=responder, no intake, the responder is kicked once', async () => {
    const r = await started()
    const id = r.deliver('你好')
    expect(r.rows('SELECT owner FROM inbox_events WHERE event_id = ?', id)).toEqual([{ owner: 'responder' }])
    expect(r.rows('SELECT count(*) AS n FROM sa_intake')).toEqual([{ n: 0 }])
    expect(r.kicks).toEqual([id])
    // T27 gap 6: brief --now is one step; nothing to say is null (the command maps it to 3).
    const submitted: string[] = []
    const empty = createBriefNow({ brief: { build: () => null }, now: () => 1, day: () => '2026-11-06', submit: b => submitted.push(b.body) })
    expect(await empty()).toBeNull()
    const full = createBriefNow({ brief: { build: () => ({ body: '今天交付 1 件', items: [] }) }, now: () => 1, day: () => '2026-11-06', submit: b => submitted.push(b.body) })
    expect(await full()).toEqual({ body: '今天交付 1 件', items: [] })
    expect(submitted).toEqual(['今天交付 1 件'])
    // T27 gap 1: the five command routes exist and the injected fence refuses before the command runs.
    const routes = r.asm.routes({ isTrusted: () => false })
    expect(routes.map(x => (x as { path: string }).path)).toEqual(['status', 'stop', 'brief', 'calibration', 'doc'].map(n => `/superagent/commands/${n}`))
    let status = 0
    const res = { statusCode: 0, setHeader: () => undefined, writeHead(code: number) { status = code; return res }, end: () => undefined } as never
    await (routes[0] as unknown as { handler(q: unknown, s: unknown): Promise<void> }).handler({ method: 'POST', headers: {} }, res)
    expect(status || (res as { statusCode: number }).statusCode).toBe(403)
  })

  it('2. shadow: owner=responder, one shadow intake, no outbox or commitment; the desk turn is a shadow deliberation', async () => {
    const r = await started({ mode: 'shadow' })
    const id = r.deliver('帮我查一下发布状态')
    expect(r.kicks).toEqual([id])
    expect(r.rows('SELECT owner FROM inbox_events')).toEqual([{ owner: 'responder' }])
    expect(r.rows('SELECT shadow, state FROM sa_intake')).toEqual([{ shadow: 1, state: 'pending' }])
    const sid = await runDesk(r)
    expect(await call(r, sid, 'judge', { event_id: id, disposition: 'answer', class: 'lookup', confidence: 0.8, reason: 'status question' })).toEqual({ ok: true })
    expect(await call(r, sid, 'say', { event_id: id, moment: 'answer', text: '发布正常' })).toMatchObject({ ok: true, outbox_id: 'shadow' })
    await endTurn(r, sid)
    expect(r.rows('SELECT shadow, state FROM sa_deliberation')).toEqual([{ shadow: 1, state: 'done' }])
    expect(r.rows('SELECT count(*) AS n FROM sa_outbox')).toEqual([{ n: 0 }])
    expect(r.rows('SELECT count(*) AS n FROM sa_commitment')).toEqual([{ n: 0 }])
    expect(r.rows('SELECT class, confidence FROM sa_intake')).toEqual([{ class: 'lookup', confidence: 0.8 }])
  })

  it('3. superagent: owner=superagent; a scripted desk commit and ack leave one reply-tier outbound', async () => {
    const r = await started({ mode: 'superagent' })
    const id = r.deliver('帮我查一下 X 的结论')
    expect(r.kicks).toEqual([])
    expect(r.rows('SELECT owner FROM inbox_events')).toEqual([{ owner: 'superagent' }])
    const sid = await runDesk(r)
    expect(await call(r, sid, 'judge', { event_id: id, disposition: 'commit', class: 'lookup', confidence: 0.9, reason: 'owner asked' })).toEqual({ ok: true })
    expect(await call(r, sid, 'commit', { event_id: id, kind: 'deliver', what: '查 X 的结论', intent: '知道 X 的结论', check_kind: 'answer',
      done_when: '要包含 结论与出处', executor: 'oneshot-read', executor_reason: 'read only lookup', eta_minutes: 5 })).toMatchObject({ ok: true, commitment_id: 'C-1' })
    await endTurn(r, sid)
    r.clock.advance(1000)
    await settle()
    expect(r.rows('SELECT moment, tier, state FROM sa_outbox')).toEqual([{ moment: 'ack', tier: 'reply', state: 'sent' }])
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0].text).toContain('接了 C-1')
  })

  it('4. switching the mode takes effect on the next inbound; switching back keeps the ledger', async () => {
    const r = await started({ mode: 'shadow' })
    const a = r.deliver('one')
    r.cfg.superagentMode = 'superagent'
    const b = r.deliver('two')
    r.cfg.superagentMode = 'responder'
    const c = r.deliver('three')
    expect(r.rows('SELECT event_id, owner FROM inbox_events ORDER BY event_id')).toEqual([
      { event_id: a, owner: 'responder' }, { event_id: b, owner: 'superagent' }, { event_id: c, owner: 'responder' }])
    expect(r.rows('SELECT event_id, shadow FROM sa_intake ORDER BY event_id')).toEqual([{ event_id: a, shadow: 1 }, { event_id: b, shadow: 0 }])
    expect(r.kicks).toEqual([a, c])
  })

  it('5. a ledger that cannot open leaves the responder answering and one diagnostic', async () => {
    const r = rig({ mode: 'superagent', openDb: () => { throw new Error('disk full') } })
    expect(await r.asm.start(r.path)).toBeUndefined()
    const id = r.deliver('hello')
    expect(r.kicks).toEqual([id])
    expect(r.asm.ready()).toBe(false)
    expect(r.diagnostics).toHaveLength(1)
    expect(r.diagnostics[0]).toContain('disk full')
  })

  it('6. inbound before recovery startup finishes stays with the responder', async () => {
    const r = rig({ mode: 'superagent' })
    const starting = r.asm.start(r.path)
    const early = r.deliver('early')
    expect(r.asm.ready()).toBe(false)
    expect(r.kicks).toEqual([early])
    await starting
    expect(r.rows('SELECT count(*) AS n FROM sa_intake')).toEqual([{ n: 0 }])
    expect(r.rows(`SELECT count(*) AS n FROM inbox_events WHERE owner = 'superagent'`)).toEqual([{ n: 0 }])
    const late = r.deliver('late')
    expect(r.rows('SELECT owner FROM inbox_events WHERE event_id = ?', late)).toEqual([{ owner: 'superagent' }])
  })

  it('7. after dispose no timer runs again and the database is closed', async () => {
    const r = await started({ mode: 'superagent' })
    r.deliver('x')
    await r.asm.dispose()
    expect(r.clock.pending()).toBe(0)
    const prompts = r.controller.calls.length
    r.clock.advance(10 * 60_000)
    await settle()
    expect(r.controller.calls.length).toBe(prompts)
    expect(r.sent).toHaveLength(0)
    expect(() => r.dbs[0].prepare('SELECT 1').get()).toThrow()
    expect(r.asm.ledger()).toBeUndefined()
  })

  it('8. agent/request: a desk session gets the configured model, others pass through, nothing global is written', async () => {
    const r = await started({ mode: 'superagent' })
    r.cfg.superagentDesk = { model: { provider: 'prov-desk', model: 'desk-model', effort: 'low' } }
    r.deliver('帮我看看 Y 的进度')   // a plain greeting would take the fast path and never reach a desk
    const sid = await runDesk(r)
    const resolved = Object.freeze({ provider: 'global-prov', model: 'global-model' }) as never
    expect(overrideModel(resolved, r.asm.modelFor(sid))).toEqual({ provider: 'prov-desk', model: 'desk-model', reasoningEffort: 'low' })
    expect(overrideModel(resolved, r.asm.modelFor('plain-session'))).toBe(resolved)
    expect(resolved).toEqual({ provider: 'global-prov', model: 'global-model' })
    await endTurn(r, sid)
  })

  it('9. the bundle still mounts exactly one runtime row (F22)', () => {
    const patch = readFileSync(join(__dirname, '../cordis.patch.yml'), 'utf8')
    expect(patch.split('\n').filter(l => /^\s*- id:/.test(l))).toHaveLength(1)
  })
})
