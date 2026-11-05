/**
 * The executor `report` tool (02 executor tool), registered only on executor sessions.
 *
 * report(state, summary <= 2000, evidence?: [{ command, exit, reading <= 500 }], question?)
 * - blocked without a question -> QUESTION_REQUIRED
 * - ready without evidence is accepted; closure (T22) can then reach unverified at best.
 * The tool records the report; it never closes the commitment.
 */

import { REPORT_STATES } from '../protocol/objects.ts'
import type { ReportInput, ToolResult } from '../protocol/tools.ts'

export const SUMMARY_MAX = 2000
export const READING_MAX = 500

export interface ToolDefinitionLike {
  name: 'report'
  description: string
  parameters: Record<string, unknown>
  execute(input: unknown, context: { sessionId: string }): ToolResult<{ seq: number }>
}

export type ReportParse = { ok: true; report: ReportInput } | { ok: false; code: 'QUESTION_REQUIRED' | 'INVALID'; message: string }

export function parseReport(raw: unknown): ReportParse {
  const bad = (message: string): ReportParse => ({ ok: false, code: 'INVALID', message })
  if (typeof raw !== 'object' || raw === null) return bad('report input must be an object')
  const r = raw as Record<string, unknown>
  if (typeof r.state !== 'string' || !(REPORT_STATES as readonly string[]).includes(r.state)) return bad(`state must be one of ${REPORT_STATES.join('/')}`)
  if (typeof r.summary !== 'string' || r.summary.length > SUMMARY_MAX) return bad(`summary must be a string of at most ${SUMMARY_MAX} characters`)
  const evidence: NonNullable<ReportInput['evidence']> = []
  if (r.evidence !== undefined) {
    if (!Array.isArray(r.evidence)) return bad('evidence must be an array')
    for (const e of r.evidence as unknown[]) {
      const item = e as Record<string, unknown>
      if (typeof item?.command !== 'string' || typeof item.exit !== 'number' || typeof item.reading !== 'string') return bad('evidence items are { command, exit, reading }')
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
    parameters: {
      type: 'object',
      required: ['state', 'summary'],
      properties: {
        state: { type: 'string', enum: [...REPORT_STATES] },
        summary: { type: 'string', maxLength: SUMMARY_MAX },
        evidence: { type: 'array', items: { type: 'object', required: ['command', 'exit', 'reading'],
          properties: { command: { type: 'string' }, exit: { type: 'number' }, reading: { type: 'string', maxLength: READING_MAX } } } },
        question: { type: 'string' },
      },
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
