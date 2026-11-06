/**
 * Live defect 2026-11-06 11:04 (shadow, first real message): the host refused every
 * desk tool registration - `tool "judge" must declare output { schema, render,
 * presentationMeta? }` - and the model would have seen `parameters: { type: 'object' }`,
 * an object with no fields. These cases run the real dsh-tools ToolRuntime (register,
 * schemas, execute with output validation), not a re-implementation of its checks.
 */

import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { hostToolOf, type DeskTool } from '../src/host/services/superagent/desk/toolface.ts'
import { createDeskTools } from '../src/host/services/superagent/desk/tools.ts'
import { newTurnContext, type TurnContext } from '../src/host/services/superagent/desk/turn.ts'
import { createReportTool } from '../src/host/services/superagent/executors/report-tool.ts'
import type { MemoryLog } from '../src/host/services/superagent/memory/log.ts'
import { DESK_TOOL_NAMES } from '../src/host/services/superagent/protocol/tools.ts'
import { inboundEvent, openTestLedger, seedCommitment } from './fixtures/superagent/ledger.ts'
import { seedInbound } from './fixtures/superagent/memdb.ts'

const SID = 'sa-desk-p2poc_1-g0'

function runtime(): ToolRuntime {
  const ctx = new Context()
  const noop = () => () => undefined
  ctx.provide('systemPrompt', new Proxy({}, { get: () => noop }))
  return new ToolRuntime(ctx, {} as never)
}

const exec = (rt: ToolRuntime, name: string, args: unknown) =>
  rt.execute({ callId: `c-${name}` as never, name, arguments: args, signal: new AbortController().signal })

function desk(turn?: TurnContext) {
  const t = openTestLedger()
  const memory = {} as MemoryLog
  const tools = createDeskTools({ ledger: t.ledger, memory, docs: { read: () => ({ text: 'doc body', truncated: false }) },
    outlet: {} as never, outletPolicy: {} as never, mode: () => 'shadow', handlers: {}, owner: 'on_owner', turnOf: () => turn })
  return { t, tools }
}
const byName = (tools: DeskTool[], name: string) => tools.find(x => x.name === name) as DeskTool
const compiled = (tool: DeskTool): ToolDefinition => hostToolOf(tool, SID)

describe('desk tools against the real host tool runtime', () => {
  it('1. the pre-fix shapes are refused by register exactly as on the live host', () => {
    const rt = runtime()
    // HEAD desk/tools.ts + index.ts registered { name, description, parameters: { type: 'object' }, execute }.
    expect(() => rt.register({ name: 'judge', description: 'desk tool judge', parameters: { type: 'object' }, execute: async () => ({ ok: true }) } as never))
      .toThrow('tool "judge" must declare output { schema, render, presentationMeta? }')
    expect(() => rt.register({ name: 'report', description: 'r', parameters: { type: 'object' }, execute: async () => ({ ok: true, seq: 1 }) } as never))
      .toThrow('tool "report" must declare output { schema, render, presentationMeta? }')
  })

  it('2. all nine desk tools and report register, and the model sees real fields with the protocol required set', () => {
    const rt = runtime()
    const { tools } = desk()
    for (const tool of tools) expect(typeof rt.register(compiled(tool))).toBe('function')
    expect(typeof rt.register(hostToolOf(createReportTool(() => ({ ok: true, seq: 1 })), 'sa-x-C-1-a1'))).toBe('function')
    const schemas = new Map(rt.schemas().map(s => [s.name, s.parameters as { properties: Record<string, unknown>; required?: string[] }]))
    expect([...schemas.keys()].sort()).toEqual([...DESK_TOOL_NAMES, 'report'].sort())
    expect(Object.keys(schemas.get('judge')!.properties)).toEqual(['event_id', 'disposition', 'about', 'class', 'confidence', 'reason', 'corrects', 'new_thread'])
    expect(schemas.get('judge')!.required).toEqual(['event_id', 'disposition', 'class', 'confidence', 'reason'])
    expect(Object.keys(schemas.get('commit')!.properties)).toEqual(['event_id', 'kind', 'what', 'intent', 'check_kind', 'done_when', 'boundary_extra',
      'assumptions', 'executor', 'executor_reason', 'eta_minutes', 'target', 'budget_scale'])
    expect(schemas.get('commit')!.required).toEqual(['event_id', 'kind', 'what', 'intent', 'check_kind', 'done_when', 'executor', 'executor_reason', 'eta_minutes'])
    expect(schemas.get('report')!.required).toEqual(['state', 'summary'])
    for (const [name, p] of schemas) expect(Object.keys(p.properties).length, name).toBeGreaterThan(0)
  })

  it('3. a real judge and a real look run through execute: output validated, rendered as the JSON value', async () => {
    const turnHolder: { ctx?: TurnContext } = {}
    const t = openTestLedger()
    const e = inboundEvent({ received_at: t.clock.now() })
    seedInbound(t.db, { event_id: e.event_id, received_at: e.received_at })
    t.ledger.open(tx => tx.insertIntake({ event_id: e.event_id, shadow: 0, owner: 'superagent', sender: 'on_owner',
      thread_key: `${e.chat.type}:${e.chat.id}:${e.thread}`, desk_id: `${e.chat.type}:${e.chat.id}` }), { module: 'kernel' })
    seedCommitment(t, { desk_id: `${e.chat.type}:${e.chat.id}` })
    const tools = createDeskTools({ ledger: t.ledger, memory: {} as MemoryLog, docs: { read: () => ({ text: 'doc body', truncated: false }) },
      outlet: {} as never, outletPolicy: {} as never, mode: () => 'superagent', handlers: {}, owner: 'on_owner', turnOf: () => turnHolder.ctx })
    turnHolder.ctx = newTurnContext({ deskId: `${e.chat.type}:${e.chat.id}`, chatId: e.chat.id, sessionId: SID, deliberationId: 'D-1', shadow: false, batch: [e],
      audience: { cls: 'owner_p2p' } as never })
    const rt = runtime()
    for (const tool of tools) rt.register(compiled(tool))

    const judged = await exec(rt, 'judge', { event_id: e.event_id, disposition: 'answer', class: 'chat', confidence: 0.9, reason: 'r' })
    expect(judged).toMatchObject({ isError: false, value: { ok: true }, content: [{ type: 'text', text: '{"ok":true}' }] })
    const looked = await exec(rt, 'look', { what: 'commitment' })
    expect(looked.isError).toBe(false)
    expect((looked as unknown as { value: { items: unknown[] } }).value.items).toHaveLength(1)
    const doc = await exec(rt, 'look', { what: 'doc', id: 'd1' })
    expect(doc).toMatchObject({ isError: false, value: { ok: true, text: 'doc body', truncated: false } })
    // A protocol failure is a value, not a host error: it validates against the failure branch.
    const again = await exec(rt, 'judge', { event_id: e.event_id, disposition: 'answer', class: 'chat', confidence: 0.9, reason: 'r' })
    expect(again).toMatchObject({ isError: false, value: { ok: false, code: 'ALREADY_DISPOSED' } })
  })

  it('4. arguments are checked by the host: a judge without event_id never reaches the handler', async () => {
    const rt = runtime()
    const { tools } = desk()
    rt.register(compiled(byName(tools, 'judge')))
    const r = await exec(rt, 'judge', { disposition: 'answer', class: 'chat', confidence: 0.9, reason: 'r' })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r)).toContain('event_id')
  })

  it('5. every success shape the handlers return validates; an undeclared field does not', () => {
    const { tools } = desk()
    const schemaOf = (name: string) => compiled(byName(tools, name)).output.schema
    const ok = (name: string, value: unknown) => expect(validateJsonSchemaValue(schemaOf(name), value, 'value'), name).toEqual([])
    ok('judge', { ok: true })
    ok('commit', { ok: true, commitment_id: 'C-1', state: 'open', eta_at: 1, mandate: 'draft', asked_ordinal: 1 })
    ok('commit', { ok: true, commitment_id: 'shadow', state: 'proposed', eta_at: 1, mandate: 'draft' })
    ok('amend', { ok: true, seq: 0, delivery: 'next-attempt' })
    ok('release', { ok: true, state: 'released', worktree: 'kept', changes: 'shadow' })
    ok('pushback', { ok: true, outbox_id: '' })
    ok('look', { ok: true, items: [{ commitment_id: 'C-1', slot: null }] })
    ok('look', { ok: true, item: { attempt_id: 'a1' } })
    ok('look', { ok: true, text: 't', truncated: true })
    ok('remember', { ok: true, memory_id: 'shadow', authority: 'inferred' })
    ok('propose', { ok: true, commitment_ids: ['C-2'] })
    ok('say', { ok: true, outbox_id: 'o1', tier: 'reply', words: 3 })
    for (const name of DESK_TOOL_NAMES) {
      ok(name, { ok: false, code: 'NO_TURN', message: 'no open turn on this session' })
      expect(validateJsonSchemaValue(schemaOf(name), { ok: true, stray: 1 }, 'value').length, name).toBeGreaterThan(0)
    }
    const report = hostToolOf(createReportTool(() => ({ ok: true, seq: 1 })), 'sa-x-C-1-a1').output.schema
    expect(validateJsonSchemaValue(report, { ok: true, seq: 4 }, 'value')).toEqual([])
    expect(validateJsonSchemaValue(report, { ok: false, code: 'QUESTION_REQUIRED', message: 'm' }, 'value')).toEqual([])
  })
})
