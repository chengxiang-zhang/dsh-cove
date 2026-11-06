/**
 * The nine desk tools (02 desk tools, T20). Context (desk, batch, sender, audience)
 * comes from the host's TurnContext; the model cannot pass it in.
 *
 * Implemented here: judge, look, remember, say. commit/amend/release/pushback/propose
 * are the judgment module's handlers (T21/T26), injected by the composition root;
 * until then they answer NOT_IMPLEMENTED, but the face always has all nine.
 *
 * Shadow turns (N18): every tool validates, nothing lands except intake(shadow=1)
 * and the shadow_ops trace.
 */

import { createHash } from 'node:crypto'
import type { Ledger } from '../kernel/ledger.ts'
import type { Outlet } from '../kernel/outlet.ts'
import type { OutletPolicy, SpeechProposal } from '../kernel/ports.ts'
import type { MemoryLog } from '../memory/log.ts'
import { MEMORY_TYPES, type MemoryTrigger } from '../memory/types/index.ts'
import { PHYSICAL } from '../protocol/db.ts'
import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { CHECK_KINDS, COMMITMENT_KINDS, COMMITMENT_STATES, DISPOSITIONS, MEMORY_KINDS, OUTBOX_MOMENTS, TIERS, type AttemptRow, type CommitmentRow, type Disposition } from '../protocol/objects.ts'
import { DESK_TOOL_NAMES, MAX_ASSUMPTIONS, MAX_PROPOSE_ITEMS, type DeskToolName, type JudgeInput, type LookInput, type RememberInput, type SayInput, type ToolErrorCode } from '../protocol/tools.ts'
import { renderJson, type DeskTool, type ToolOutputSpec } from './toolface.ts'
import type { TurnContext } from './turn.ts'

export type DeskToolResult = { ok: true; [key: string]: unknown } | { ok: false; code: ToolErrorCode | 'NOT_IMPLEMENTED' | 'NO_TURN'; message: string }

export type DeskHandler = (input: unknown, ctx: TurnContext) => DeskToolResult | Promise<DeskToolResult>
/** Judgment handlers; an injected `judge` (T21) takes the place of the desk's own. */
export type DeskHandlers = Partial<Record<'judge' | 'commit' | 'amend' | 'release' | 'pushback' | 'propose', DeskHandler>>

export interface DocArea { read(docId: string): { text: string; truncated: boolean } }

export interface DeskToolDeps {
  ledger: Ledger
  memory: MemoryLog
  docs: DocArea
  outlet: Outlet
  outletPolicy: OutletPolicy
  mode: () => 'responder' | 'shadow' | 'superagent'
  handlers: DeskHandlers
  owner: string
  /** The open turn of the session calling the tool, if any. */
  turnOf(sessionId: string): TurnContext | undefined
}

const IDEM_MAX = 50
const WRITE_TOOLS: ReadonlySet<string> = new Set(['judge', 'commit', 'amend', 'release', 'pushback', 'remember', 'propose', 'say'])

const fail = (code: ToolErrorCode | 'NOT_IMPLEMENTED' | 'NO_TURN', message: string): DeskToolResult => ({ ok: false, code, message })

/** `sa:<deliberation>:<n>`, hashed down when it would pass the 50-character Feishu uuid limit (F19). */
export function idemKeyOf(deliberationId: string, n: number): string {
  const plain = `sa:${deliberationId}:${n}`
  if (plain.length <= IDEM_MAX) return plain
  return `sa:${createHash('sha256').update(deliberationId).digest('hex').slice(0, 32)}:${n}`
}

function visibleTo(c: CommitmentRow, ctx: TurnContext): boolean {
  // The owner's private desk sees every commitment; any other desk only its own.
  return ctx.audience.cls === 'owner_p2p' || c.desk_id === ctx.deskId
}

// Host-facing contracts (02 desk tools). Required marks follow the protocol input
// types; everything a handler answers is declared, nothing more.
const str = (description: string) => ({ type: 'string', description }) as const
const req = <T extends object>(spec: T) => ({ ...spec, required: true }) as T & { required: true }
const oneOfEnum = (values: readonly string[], description: string) => ({ type: 'string', enum: values, description }) as const

const FAILURE: ValueSchemaSpec = {
  type: 'object', additionalProperties: false,
  properties: { ok: req({ type: 'boolean', const: false }), code: req(str('closed error code')), message: req(str('why')) },
}
function outputOf(success: ParameterSchemaSpec): ToolOutputSpec {
  return {
    schema: { oneOf: [{ type: 'object', additionalProperties: false, properties: { ok: req({ type: 'boolean', const: true }), ...success } }, FAILURE] },
    render: renderJson,
  }
}
const ROW = { type: 'json', description: 'a ledger row' } as const

interface DeskToolContract { description: string; parameters: ParameterSchemaSpec; success: ParameterSchemaSpec }

export const DESK_TOOL_CONTRACTS: Record<DeskToolName, DeskToolContract> = {
  judge: {
    description: 'Dispose one event of this batch: what it is, what it is about, how sure you are and why. Every event in the batch must be judged exactly once.',
    parameters: {
      event_id: req(str('event id from this batch')),
      disposition: req(oneOfEnum(DISPOSITIONS, 'what this event is')),
      about: str('commitment id (C-n) this event is about, if any'),
      class: req(str('work class id: lowercase kebab case, a-z then a-z0-9- (e.g. status-query); the host creates it on first use')),
      confidence: req({ type: 'number', description: '0..1' }),
      reason: req(str('one sentence, the grounds')),
      corrects: str('event id this event corrects'),
      new_thread: { type: 'boolean', description: 'start a new thread despite a live one (needs a reason)' },
    },
    success: {},
  },
  commit: {
    description: 'Take on work for an event of this batch: what, the result wanted, how it will be checked, who does it and by when.',
    parameters: {
      event_id: req(str('event id from this batch')),
      kind: req(oneOfEnum(COMMITMENT_KINDS, 'commitment kind')),
      what: req(str('the action, one line')),
      intent: req(str('the result wanted, not the action')),
      check_kind: req(oneOfEnum(CHECK_KINDS, 'how completion is checked')),
      done_when: req(str('the check; a command criterion names the command in backticks and its exit code')),
      boundary_extra: str('extra boundary beyond the defaults'),
      assumptions: {
        type: 'array', description: `open questions taken on an assumption, at most ${MAX_ASSUMPTIONS}`,
        items: { type: 'object', additionalProperties: false, properties: {
          question: req(str('the open question')), taken: req(str('the assumption taken')), reversible: req({ type: 'boolean' }) } },
      },
      executor: req(str('executor profile id; pick one of the candidates listed under 可派执行体 in the dossier')),
      executor_reason: req(str('why this executor')),
      eta_minutes: req({ type: 'number', description: 'minutes until done' }),
      target: str('where the work lands: local/..., netbird/..., external/...'),
      budget_scale: { type: 'number', description: 'budget multiplier' },
    },
    success: {
      commitment_id: req(str('C-n')), state: req(oneOfEnum(COMMITMENT_STATES, 'state after commit')),
      eta_at: req({ type: 'number', description: 'epoch ms' }), mandate: req(str('mandate applied')),
      asked_ordinal: { type: 'integer', description: 'ordinal of the question asked' },
    },
  },
  amend: {
    description: 'Add to or correct a live commitment.',
    parameters: {
      commitment_id: req(str('C-n')), text: req(str('the amendment')),
      overturns: { type: 'array', items: { type: 'integer' }, description: 'journal seqs this amendment overturns' },
    },
    success: { seq: req({ type: 'integer' }), delivery: req(oneOfEnum(['queued', 'next-attempt'], 'when the executor sees it')) },
  },
  release: {
    description: 'Release a commitment its creditor or the owner no longer wants.',
    parameters: { commitment_id: req(str('C-n')), reason: req(str('why it is released')) },
    success: { state: req(oneOfEnum(COMMITMENT_STATES, 'state after release')), worktree: req(oneOfEnum(['kept', 'removed'], 'worktree fate')), changes: req(str('what the work left')) },
  },
  pushback: {
    description: 'Push back on a request with grounds and an alternative.',
    parameters: {
      event_id: req(str('event id from this batch')), commitment_id: str('C-n the pushback is about'),
      concern: req(str('the concern')), grounds: req({ type: 'array', items: { type: 'string' }, description: 'facts behind the concern' }),
      alternative: req(str('what to do instead')),
    },
    success: { outbox_id: req(str('outbox row id; empty in shadow')) },
  },
  look: {
    description: 'Read the ledger: commitments, memory, attempts or a document.',
    parameters: {
      what: req(oneOfEnum(['commitment', 'memory', 'attempt', 'doc'], 'what to read')),
      id: str('id to read; omit to list'), q: str('memory search text'), limit: { type: 'integer', description: 'list size' },
    },
    success: {
      items: { type: 'array', items: ROW, description: 'listed rows' }, item: ROW,
      text: str('document text'), truncated: { type: 'boolean', description: 'document was cut' },
    },
  },
  remember: {
    description: 'Write a memory; a quote must come from the triggering message.',
    parameters: {
      kind: req(oneOfEnum(MEMORY_KINDS, 'memory kind')), topic: req(str('topic')), body: req(str('the memory')),
      quote: str('verbatim quote from the triggering message'), about: str('who or what it is about'), supersedes: str('memory id it replaces'),
    },
    success: { memory_id: req(str('M-n; shadow in shadow mode')), authority: req(str('owner-said or inferred')) },
  },
  propose: {
    description: `Propose up to ${MAX_PROPOSE_ITEMS} steps under a goal commitment.`,
    parameters: {
      goal_id: req(str('goal commitment C-n')),
      items: req({ type: 'array', description: `at most ${MAX_PROPOSE_ITEMS}`, items: { type: 'object', additionalProperties: false, properties: {
        what: req(str('the step')), intent: req(str('result wanted')), done_when: req(str('the check')) } } }),
    },
    success: { commitment_ids: req({ type: 'array', items: { type: 'string' } }) },
  },
  say: {
    description: 'Say one thing to the requester at a moment the protocol allows; the host picks the tier.',
    parameters: {
      event_id: str('event this answers'), commitment_id: str('commitment this is about'),
      moment: req(oneOfEnum(OUTBOX_MOMENTS, 'the speech moment')), text: req(str('what to say')),
    },
    success: { outbox_id: req(str('outbox row id; shadow in shadow mode')), tier: req(oneOfEnum(TIERS, 'tier the host chose')), words: req({ type: 'integer' }) },
  },
}

export function createDeskTools(deps: DeskToolDeps): DeskTool[] {
  const read = deps.ledger.read

  function judge(input: JudgeInput, ctx: TurnContext): DeskToolResult {
    const event = ctx.batch.find(e => e.event_id === input.event_id)
    if (!event) return fail('NOT_IN_BATCH', `${input.event_id} is not in this batch`)
    if (ctx.judged.has(event.event_id)) return fail('ALREADY_DISPOSED', `${input.event_id} was judged in this turn`)
    if (input.new_thread === true && !(input.reason ?? '').trim()) return fail('NEW_THREAD_REASON_REQUIRED', 'a new thread needs a reason')
    const shadow: 0 | 1 = ctx.shadow ? 1 : 0
    const row = read.get<{ state: string }>(`SELECT state FROM ${PHYSICAL.intake} WHERE event_id = ? AND shadow = ?`, event.event_id, shadow)
    if (!row) return fail('NOT_IN_BATCH', `${input.event_id} has no intake row`)
    if (row.state === 'disposed') return fail('ALREADY_DISPOSED', `${input.event_id} is already disposed`)
    deps.ledger.open(tx => tx.disposeIntake(event.event_id, shadow, {
      disposition: input.disposition as Disposition, reason: input.reason, class: input.class, confidence: input.confidence,
      ...(input.new_thread === undefined ? {} : { new_thread: input.new_thread }), deliberation_id: ctx.deliberationId,
      ...(input.about ? { about: input.about } : {}), ...(input.corrects ? { corrects: input.corrects } : {}),
    }), { module: 'desk', shadow: ctx.shadow })
    ctx.judged.add(event.event_id)
    return { ok: true }
  }

  function look(input: LookInput, ctx: TurnContext): DeskToolResult {
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50)
    if (input.what === 'commitment') {
      if (!input.id) {
        const rows = read.all<CommitmentRow>(`SELECT * FROM ${PHYSICAL.commitment} ORDER BY n DESC LIMIT 200`).filter(c => visibleTo(c, ctx)).slice(0, limit)
        return { ok: true, items: rows }
      }
      const c = read.get<CommitmentRow>(`SELECT * FROM ${PHYSICAL.commitment} WHERE commitment_id = ?`, input.id)
      if (!c) return fail('MISSING', `${input.id} does not exist`)
      if (!visibleTo(c, ctx)) return fail('NOT_VISIBLE', `${input.id} is not visible from this desk`)
      return { ok: true, item: c }
    }
    if (input.what === 'attempt') {
      if (!input.id) return fail('MISSING', 'attempt id required')
      const a = read.get<AttemptRow>(`SELECT * FROM ${PHYSICAL.attempt} WHERE attempt_id = ?`, input.id)
      if (!a) return fail('MISSING', `${input.id} does not exist`)
      const c = read.get<CommitmentRow>(`SELECT * FROM ${PHYSICAL.commitment} WHERE commitment_id = ?`, a.commitment_id)
      if (!c || !visibleTo(c, ctx)) return fail('NOT_VISIBLE', `${input.id} is not visible from this desk`)
      return { ok: true, item: a }
    }
    if (input.what === 'memory') {
      const items = deps.memory.recall({ ...(input.q ? { topic: input.q } : {}) }, ctx.audience, 'judge', limit)
      return { ok: true, items }
    }
    if (!input.id) return fail('MISSING', 'doc id required')
    try {
      return { ok: true, ...deps.docs.read(input.id) }
    } catch (error) {
      return fail('MISSING', error instanceof Error ? error.message : String(error))
    }
  }

  function remember(input: RememberInput, ctx: TurnContext): DeskToolResult {
    const sender = ctx.batch[0] ? (ctx.batch[0].sender.union_id ?? ctx.batch[0].sender.open_id) : ''
    const authority = input.quote ? (sender === deps.owner ? 'owner-said' : 'party-said') : 'inferred'
    if (ctx.shadow) {
      ctx.shadowOps.push({ tool: 'remember', input, verdict: 'validated' })
      return { ok: true, memory_id: 'shadow', authority }
    }
    const trigger: MemoryTrigger = { kind: 'inbound', ...(ctx.batch[0] ? { event: ctx.batch[0] } : {}), batchTexts: ctx.batch.map(e => e.text),
      sender, owner: deps.owner, audience: ctx.audience }
    // Visibility atoms come from the memory type's default (05); unknown kinds stay owner-only.
    const visibility = MEMORY_TYPES.find(t => t.kind === input.kind)?.defaultVisibility(trigger) ?? { use: [deps.owner], say: [deps.owner] }
    try {
      const result = deps.memory.remember(
        { kind: input.kind, topic: input.topic, body: input.body, authority, use: visibility.use, say: visibility.say,
          ...(input.about ? { about: input.about } : {}), ...(input.quote ? { quote: input.quote } : {}),
          ...(input.supersedes ? { supersedes: input.supersedes } : {}) }, trigger)
      return { ok: true, memory_id: result.memoryId, authority }
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code === 'QUOTE_NOT_IN_TRIGGER' || code === 'CONFLICTS' || code === 'SUPERSEDE_FORBIDDEN') return fail(code, (error as Error).message)
      throw error
    }
  }

  function say(input: SayInput, ctx: TurnContext): DeskToolResult {
    ctx.sayCount += 1
    const event = input.event_id ? ctx.batch.find(e => e.event_id === input.event_id) : undefined
    const proposal: SpeechProposal = {
      ...(input.event_id ? { event_id: input.event_id } : {}), ...(input.commitment_id ? { commitment_id: input.commitment_id } : {}),
      chat_id: ctx.chatId, ...(event ? { reply_to: event.message_id } : {}), moment: input.moment, audience: 'requester',
      payload: 'text', text: input.text, idem_key: idemKeyOf(ctx.deliberationId, ctx.sayCount),
    }
    if (ctx.shadow) {
      const verdict = deps.outletPolicy.check(proposal, deps.ledger.nowMs())
      ctx.shadowOps.push({ tool: 'say', input, verdict: verdict.ok ? 'ok' : verdict.code })
      return verdict.ok ? { ok: true, outbox_id: 'shadow', tier: verdict.tier, words: verdict.words } : fail(verdict.code, verdict.message)
    }
    const r = deps.outlet.submit(proposal, deps.outletPolicy, deps.mode())
    if (!r.ok) return fail(r.code, r.message)
    return { ok: true, outbox_id: r.outboxId, tier: r.tier, words: r.words }
  }

  const own: Partial<Record<DeskToolName, (input: never, ctx: TurnContext) => DeskToolResult>> = { judge, look, remember, say }

  return DESK_TOOL_NAMES.map((name): DeskTool => ({
    name,
    description: DESK_TOOL_CONTRACTS[name].description,
    parameters: DESK_TOOL_CONTRACTS[name].parameters,
    output: outputOf(DESK_TOOL_CONTRACTS[name].success),
    async execute(input, context) {
      const ctx = deps.turnOf(context.sessionId)
      if (!ctx) return fail('NO_TURN', 'no open turn on this session')
      const injected = deps.handlers[name as keyof DeskHandlers]
      const impl = own[name] as ((input: unknown, ctx: TurnContext) => DeskToolResult) | undefined
      const handler = name === 'judge' && injected ? injected : impl ?? injected
      const result: DeskToolResult = handler ? await handler(input, ctx) : fail('NOT_IMPLEMENTED', `${name} lands with T21/T26`)
      ctx.trace.push({ tool: name, ok: result.ok, ...(result.ok ? {} : { code: result.code }) })
      if (!result.ok) ctx.toolErrors += 1
      else if (WRITE_TOOLS.has(name)) ctx.ops += 1
      return result
    },
  }))
}
