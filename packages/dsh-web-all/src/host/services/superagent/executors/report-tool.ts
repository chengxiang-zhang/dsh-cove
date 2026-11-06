/**
 * The executor `report` tool (02 executor tool), registered only on executor sessions.
 *
 * report(state, summary <= 2000, evidence?: [{ command, exit, reading <= 500 }], question?)
 * - blocked without a question -> QUESTION_REQUIRED
 * - ready without evidence is accepted; closure (T22) can then reach unverified at best.
 * The tool records the report; it never closes the commitment.
 */

import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { REPORT_STATES } from '../protocol/objects.ts'
import type { ReportInput, ToolResult } from '../protocol/tools.ts'

export const SUMMARY_MAX = 2000
export const READING_MAX = 500
const REPORT_KEYS: ReadonlySet<string> = new Set(['state', 'summary', 'evidence', 'question'])
const EVIDENCE_KEYS: ReadonlySet<string> = new Set(['command', 'exit', 'reading'])

/** Structurally a desk HostToolSpec; the composition root compiles it with \`hostToolOf\`. */
export interface ToolDefinitionLike {
  name: 'report'
  description: string
  parameters: ParameterSchemaSpec
  output: { schema: ValueSchemaSpec; render(args: unknown, value: unknown): { type: 'text'; text: string }[] }
  execute(input: unknown, context: { sessionId: string }): ToolResult<{ seq: number }>
}

export type ReportParse = { ok: true; report: ReportInput } | { ok: false; code: 'QUESTION_REQUIRED' | 'INVALID'; message: string }

export function parseReport(raw: unknown): ReportParse {
  const bad = (message: string): ReportParse => ({ ok: false, code: 'INVALID', message })
  if (typeof raw !== 'object' || raw === null) return bad('report input must be an object')
  const r = raw as Record<string, unknown>
  // R1 A11: no extra keys - a stray `command` on the report call must never look like evidence.
  const extra = Object.keys(r).filter(k => !REPORT_KEYS.has(k))
  if (extra.length) return bad(`unknown report fields: ${extra.join(', ')}`)
  if (typeof r.state !== 'string' || !(REPORT_STATES as readonly string[]).includes(r.state)) return bad(`state must be one of ${REPORT_STATES.join('/')}`)
  if (typeof r.summary !== 'string' || r.summary.length > SUMMARY_MAX) return bad(`summary must be a string of at most ${SUMMARY_MAX} characters`)
  const evidence: NonNullable<ReportInput['evidence']> = []
  if (r.evidence !== undefined) {
    if (!Array.isArray(r.evidence)) return bad('evidence must be an array')
    for (const e of r.evidence as unknown[]) {
      const item = e as Record<string, unknown>
      if (typeof item?.command !== 'string' || typeof item.exit !== 'number' || typeof item.reading !== 'string') return bad('evidence items are { command, exit, reading }')
      if (Object.keys(item).some(k => !EVIDENCE_KEYS.has(k))) return bad('evidence items carry only command, exit, reading')
      if (item.reading.length > READING_MAX) return bad(`evidence reading must be at most ${READING_MAX} characters`)
      evidence.push({ command: item.command, exit: item.exit, reading: item.reading })
    }
  }
  const question = typeof r.question === 'string' && r.question.trim() !== '' ? r.question : undefined
  if (r.state === 'blocked' && question === undefined) return { ok: false, code: 'QUESTION_REQUIRED', message: 'blocked needs the one question that unblocks it' }
  return { ok: true, report: { state: r.state as ReportInput['state'], summary: r.summary, ...(evidence.length ? { evidence } : {}), ...(question ? { question } : {}) } }
}

export function createReportTool(accept: (sessionId: string, report: ReportInput) => ToolResult<{ seq: number }>): ToolDefinitionLike {
  return {
    name: 'report',
    description: 'Report the state of the delegated work: ready, progress, blocked (with one question), failed or dropped. Attach evidence as the commands you ran and their exit codes.',
    // Host property table. Lengths are enforced by parseReport (the host subset has no maxLength).
    parameters: {
      state: { type: 'string', enum: REPORT_STATES, description: 'ready, progress, blocked, failed or dropped', required: true },
      summary: { type: 'string', description: `what happened, at most ${SUMMARY_MAX} characters`, required: true },
      evidence: { type: 'array', description: 'commands you ran and what they printed',
        items: { type: 'object', additionalProperties: false, properties: {
          command: { type: 'string', description: 'the command line', required: true },
          exit: { type: 'number', description: 'its exit code', required: true },
          reading: { type: 'string', description: `what it printed, at most ${READING_MAX} characters`, required: true } } } },
      question: { type: 'string', description: 'the one question that unblocks a blocked report' },
    },
    output: {
      schema: { oneOf: [
        { type: 'object', additionalProperties: false, properties: {
          ok: { type: 'boolean', const: true, required: true }, seq: { type: 'integer', description: 'journal seq of the report', required: true } } },
        { type: 'object', additionalProperties: false, properties: {
          ok: { type: 'boolean', const: false, required: true }, code: { type: 'string', required: true }, message: { type: 'string', required: true } } },
      ] },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    execute(input, context) {
      const parsed = parseReport(input)
      if (!parsed.ok && parsed.code === 'QUESTION_REQUIRED') return { ok: false, code: 'QUESTION_REQUIRED', message: parsed.message }
      // A malformed call is a tool-call error, not a protocol outcome: 02 defines no code for it.
      if (!parsed.ok) throw new Error(`report: ${parsed.message}`)
      return accept(context.sessionId, parsed.report)
    },
  }
}
