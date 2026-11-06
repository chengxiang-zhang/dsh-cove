/**
 * The model-facing tool contracts of the secretary and of an executor, pinned at
 * the edge the host enforces.
 *
 * The live defect of 2026-11-06 (shadow, first real message) was a registration
 * refusal, and its repair hand-declared one output schema per tool. A hand
 * declaration drifts silently: the host validates every successful value against
 * `output.schema` before the model sees it, so a renamed or forgotten field turns
 * a real answer into a host-side tool error, and an over-declared field advertises
 * a result no handler can produce. The compile step below is the production one -
 * `createDeskTools` reads `DESK_TOOL_CONTRACTS`, and `hostToolOf` runs it through
 * the SDK's `defineTool` - so these cases fail when either side of that pair moves
 * without the other. The execute path on a real host runtime is covered by the
 * sibling registration spec; this file only pins the declared shapes.
 */

import { parameterSchemaSpecToJsonSchema, validateJsonSchemaValue, type JsonSchemaNode, type ParameterJsonSchema } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { DESK_TOOL_CONTRACTS, createDeskTools } from '../src/host/services/superagent/desk/tools.ts'
import { hostToolOf, type DeskTool } from '../src/host/services/superagent/desk/toolface.ts'
import { createReportTool } from '../src/host/services/superagent/executors/report-tool.ts'
import type { MemoryLog } from '../src/host/services/superagent/memory/log.ts'
import { REPORT_STATES } from '../src/host/services/superagent/protocol/objects.ts'
import { DESK_TOOL_NAMES, type DeskToolName } from '../src/host/services/superagent/protocol/tools.ts'
import { openTestLedger } from './fixtures/superagent/ledger.ts'

const SID = 'sa-desk-p2poc_1-g0'
const REPORT_SID = 'sa-x-p2poc_1-C-1-a1'

/**
 * The specs production hands to the tool face: `createDeskTools` is the only
 * builder, so the contracts under test are the ones a desk session registers.
 */
function deskTools(): DeskTool[] {
  const t = openTestLedger()
  return createDeskTools({ ledger: t.ledger, memory: {} as MemoryLog, docs: { read: () => ({ text: '', truncated: false }) },
    outlet: {} as never, outletPolicy: {} as never, mode: () => 'superagent', handlers: {}, owner: 'on_owner', turnOf: () => undefined })
}

const tools = deskTools()
const byName = (name: string): DeskTool => tools.find(tool => tool.name === name) as DeskTool
/** Exactly what `ctx.tools.register` receives in production. */
const compiled = (name: string) => hostToolOf(byName(name), SID)
const schemaOf = (name: string): JsonSchemaNode => compiled(name).output.schema
const violations = (schema: JsonSchemaNode, value: unknown): string[] => validateJsonSchemaValue(schema, value, 'value')

/**
 * The arguments the model must send for each tool (02 desk tools). The literal
 * set is deliberate: it is the protocol the model was promised, not a projection
 * of whatever the code happened to declare today.
 */
const REQUIRED: Record<DeskToolName, readonly string[]> = {
  judge: ['event_id', 'disposition', 'class', 'confidence', 'reason'],
  commit: ['event_id', 'kind', 'what', 'intent', 'check_kind', 'done_when', 'executor', 'executor_reason', 'eta_minutes'],
  amend: ['commitment_id', 'text'],
  release: ['commitment_id', 'reason'],
  pushback: ['event_id', 'concern', 'grounds', 'alternative'],
  look: ['what'],
  remember: ['kind', 'topic', 'body'],
  propose: ['goal_id', 'items'],
  say: ['moment', 'text'],
}

/**
 * The success fields the host must find, `ok` excluded because both branches
 * carry it. `look` requires none: its handler answers listed rows, one row or
 * document text, and no single call has all three, so every field stays optional.
 */
const OUTPUT_REQUIRED: Record<DeskToolName, readonly string[]> = {
  judge: [],
  commit: ['commitment_id', 'state', 'eta_at', 'mandate'],
  amend: ['seq', 'delivery'],
  release: ['state', 'worktree', 'changes'],
  pushback: ['outbox_id'],
  look: [],
  remember: ['memory_id', 'authority'],
  propose: ['commitment_ids'],
  say: ['outbox_id', 'tier', 'words'],
}

const SUCCESS: Record<DeskToolName, readonly unknown[]> = {
  judge: [{ ok: true }],
  commit: [{ ok: true, commitment_id: 'C-1', state: 'open', eta_at: 1, mandate: 'local/dev' },
    { ok: true, commitment_id: 'C-1', state: 'open', eta_at: 1, mandate: 'local/dev', asked_ordinal: 2 }],
  amend: [{ ok: true, seq: 1, delivery: 'queued' }],
  release: [{ ok: true, state: 'released', worktree: 'kept', changes: 'none' }],
  pushback: [{ ok: true, outbox_id: '' }],
  look: [{ ok: true, items: [] }, { ok: true, item: {} }, { ok: true, text: 't', truncated: false }],
  remember: [{ ok: true, memory_id: 'M-1', authority: 'owner-said' }],
  propose: [{ ok: true, commitment_ids: [] }],
  say: [{ ok: true, outbox_id: 'o', tier: 'reply', words: 3 }],
}

const FAILURE = { ok: false, code: 'NOT_IN_BATCH', message: 'x' } as const

/** The `ok:true` branch of the declared output union, with the failure branch beside it. */
function branchesOf(schema: JsonSchemaNode): { ok: JsonSchemaNode; failure: JsonSchemaNode } {
  const branches = (schema as { oneOf?: JsonSchemaNode[] }).oneOf ?? []
  expect(branches).toHaveLength(2)
  const ok = branches.find(branch => branch.properties?.ok?.const === true)
  const failure = branches.find(branch => branch.properties?.ok?.const === false)
  expect(ok).toBeDefined()
  expect(failure).toBeDefined()
  return { ok: ok as JsonSchemaNode, failure: failure as JsonSchemaNode }
}

describe('desk tool contracts', () => {
  it('1. every contract compiles through the SDK into a definition the host can register', () => {
    expect(tools.map(tool => tool.name)).toEqual([...DESK_TOOL_NAMES])
    for (const name of DESK_TOOL_NAMES) {
      const def = compiled(name)
      expect(def.name, name).toBe(name)
      // The model reads the contract's own description; a divergence means the
      // table and the registered face are no longer the same source.
      expect(def.description, name).toBe(DESK_TOOL_CONTRACTS[name].description)
      expect(def.parameters, name).toMatchObject({ type: 'object' })
      expect(typeof def.output.render, name).toBe('function')
      expect(Array.isArray((def.output.schema as { oneOf?: unknown[] }).oneOf), name).toBe(true)
    }
  })

  it('2. the parameter schema carries the protocol required set, in declaration order', () => {
    for (const name of DESK_TOOL_NAMES) {
      const contract = DESK_TOOL_CONTRACTS[name]
      const schema: ParameterJsonSchema = parameterSchemaSpecToJsonSchema(contract.parameters)
      expect(schema.required, name).toEqual([...REQUIRED[name]])
      expect(Object.keys(schema.properties), name).toEqual(Object.keys(contract.parameters))
      // The registered definition is compiled from the same table, so what the
      // model is told to send is what the handler validates.
      expect((compiled(name).parameters as { required?: string[] }).required, name).toEqual([...REQUIRED[name]])
    }
  })

  it('3. every value a handler answers validates against the declared output schema', () => {
    for (const name of DESK_TOOL_NAMES) {
      for (const payload of SUCCESS[name]) {
        expect(violations(schemaOf(name), payload), `${name}: ${JSON.stringify(payload)}`).toEqual([])
      }
    }
  })

  it('4. a protocol failure is a value, and validates on every tool', () => {
    for (const name of DESK_TOOL_NAMES) {
      expect(violations(schemaOf(name), FAILURE), name).toEqual([])
    }
  })

  it('5. the output union carries the expected required fields and rejects anything undeclared', () => {
    for (const name of DESK_TOOL_NAMES) {
      const { ok, failure } = branchesOf(schemaOf(name))
      expect(ok.required, name).toEqual(['ok', ...OUTPUT_REQUIRED[name]])
      expect(failure.required, name).toEqual(['ok', 'code', 'message'])
      // additionalProperties:false is the only thing that keeps a handler's stray
      // field from reaching the model as an undeclared shape.
      expect(violations(schemaOf(name), { ok: true, stray: 1 }).length, name).toBeGreaterThan(0)
      expect(violations(schemaOf(name), { ...FAILURE, stray: 1 }).length, name).toBeGreaterThan(0)
      // A success body of `ok` alone is a real answer only where the contract
      // declares nothing else; elsewhere it means the required marks stopped
      // being enforced.
      if (OUTPUT_REQUIRED[name].length > 0) expect(violations(schemaOf(name), { ok: true }).length, name).toBeGreaterThan(0)
    }
  })
})

describe('executor report tool contract', () => {
  const report = createReportTool(() => ({ ok: true, seq: 1 }))

  it('6. the argument contract keeps its required set, the state enum and the evidence items', () => {
    const params: ParameterJsonSchema = parameterSchemaSpecToJsonSchema(report.parameters)
    expect(params.required).toEqual(['state', 'summary'])
    expect(params.properties.state).toMatchObject({ type: 'string', enum: [...REPORT_STATES] })
    expect(params.properties.evidence.items?.required).toEqual(['command', 'exit', 'reading'])
    expect(params.properties.evidence.items?.additionalProperties).toBe(false)
    // Optional on purpose: a ready report may carry no evidence (closure then
    // reaches unverified at best), and only a blocked one needs a question.
    expect(params.required).not.toContain('evidence')
    expect(params.required).not.toContain('question')
  })

  it('7. both outcomes validate on the compiled definition; a bare ok does not', () => {
    const def = hostToolOf(report, REPORT_SID)
    expect(def.name).toBe('report')
    expect(violations(def.output.schema, { ok: true, seq: 7 })).toEqual([])
    expect(violations(def.output.schema, { ok: false, code: 'QUESTION_REQUIRED', message: 'x' })).toEqual([])
    // `seq` is what the host returns to the executor; a body without it is not a
    // report outcome and must not pass as one.
    expect(violations(def.output.schema, { ok: true }).length).toBeGreaterThan(0)
    expect(violations(def.output.schema, { ok: true, seq: 7, stray: 1 }).length).toBeGreaterThan(0)
  })
})