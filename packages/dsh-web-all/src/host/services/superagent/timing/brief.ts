/**
 * The daily brief: one message a day that is also a heartbeat (09 简报, G9).
 *
 * The brief exists so the owner never has to ask "is anything happening". That
 * makes two things mandatory rather than nice: it carries at most six lines, and
 * it exists every day a commitment is still open even when there is no news — a
 * silent day with work in flight is indistinguishable from a dead secretary, which
 * is the failure this module is here to prevent.
 *
 * Every line goes through the shared brief template, so the mechanical limits
 * (six lines, fifteen words a line) are enforced by `surface/templates.ts` and not
 * re-implemented here. A line that is too long throws `BRIEF_LINE_TOO_LONG` rather
 * than being silently trimmed: a brief that quietly drops the detail it was
 * supposed to carry is worse than a red test.
 */

import type { LedgerReader } from '../protocol/db.ts'
import { PHYSICAL } from '../protocol/db.ts'
import type { CommitmentRow } from '../protocol/objects.ts'
import { render } from '../surface/templates.ts'
import { countWords } from '../surface/words.ts'

/** One candidate line. `kind` is for the reader of the ledger, not for the owner. */
export interface BriefItem {
  kind: 'delivery' | 'decision' | 'calibration' | 'promote' | 'goal' | 'folded' | 'degrade' | 'heartbeat'
  text: string
}

export interface BriefBody { body: string; items: BriefItem[] }

export interface Brief {
  /** Build the brief for one local day, or null when there is nothing to say and nothing open. */
  build(day: string, now: number): BriefBody | null
}

/** Up to this many pending decisions enter the brief, each with its default. */
export const BRIEF_PENDING_MAX = 3
/** Up to this many promote candidates are offered for one reply of "回 1、3". */
export const BRIEF_PROMOTE_MAX = 5

export interface BriefDeps {
  read: LedgerReader
  /** Memory module's promote candidates (T16); at most `BRIEF_PROMOTE_MAX` are asked for. */
  promoteCandidates?: (now: number) => { memory_id: string; topic: string }[]
  /** Calibration or autonomy changes since the last brief (T17). */
  calibrationChanges?: (now: number) => string[]
  /** Interrupts that were folded into a brief instead of sent (T10). */
  foldedInterrupts?: (now: number) => string[]
  /** Degrade events still open (T25). */
  degradeEvents?: (now: number) => string[]
}

const DAY = 86_400_000

function openCommitments(read: LedgerReader): CommitmentRow[] {
  return read.all<CommitmentRow>(
    `SELECT * FROM ${PHYSICAL.commitment}
     WHERE state IN ('proposed', 'open', 'at_risk') ORDER BY n`,
  )
}

function closedToday(read: LedgerReader, since: number): CommitmentRow[] {
  return read.all<CommitmentRow>(
    `SELECT * FROM ${PHYSICAL.commitment}
     WHERE closed_at IS NOT NULL AND closed_at >= ? ORDER BY closed_at`,
    since,
  )
}

/**
 * Build one day's brief.
 *
 * Order is fixed: deliveries, decisions the owner owes, calibration changes,
 * promote candidates, goal proposals, folded interrupts, degrade events. The
 * template numbers them, so "回 1、3" always refers to the lines the owner sees.
 */
export function createBrief(deps: BriefDeps): Brief {
  const { read } = deps
  return {
    build(day: string, now: number): BriefBody | null {
      const items: BriefItem[] = []
      const since = now - DAY

      for (const closed of closedToday(read, since)) {
        items.push({ kind: 'delivery', text: `${closed.commitment_id} ${closed.state}：${closed.what}` })
      }

      const waiting = read.all<CommitmentRow>(
        `SELECT * FROM ${PHYSICAL.commitment}
         WHERE state IN ('proposed', 'open', 'at_risk') AND ball = creditor
         ORDER BY next_look_at, n LIMIT ?`,
        BRIEF_PENDING_MAX,
      )
      for (const row of waiting) {
        const due = typeof row.due_at === 'number' ? `，截止 ${new Date(row.due_at).toISOString().slice(5, 16).replace('T', ' ')}` : ''
        items.push({ kind: 'decision', text: `${row.commitment_id} 待决：${row.intent}${due}` })
      }

      for (const change of deps.calibrationChanges?.(now) ?? []) {
        items.push({ kind: 'calibration', text: change })
      }

      const candidates = (deps.promoteCandidates?.(now) ?? []).slice(0, BRIEF_PROMOTE_MAX)
      if (candidates.length > 0) {
        const topics = candidates.map((candidate) => candidate.topic).join('、')
        items.push({ kind: 'promote', text: `升公共 ${candidates.length} 条：${topics}（回 1、3 批准）` })
      }

      const goals = read.all<CommitmentRow>(
        `SELECT * FROM ${PHYSICAL.commitment} WHERE kind = 'goal' AND state IN ('proposed', 'open') ORDER BY n`,
      )
      for (const row of goals) {
        const proposals = read.get<{ c: number }>(
          `SELECT count(*) AS c FROM sa_commitment WHERE state = 'proposed' AND parent_id = ?`,
          row.commitment_id,
        )
        if ((proposals?.c ?? 0) > 0) {
          items.push({ kind: 'goal', text: `${row.commitment_id} 有 ${proposals?.c} 件提案待批（回序号批准）` })
        }
      }

      for (const folded of deps.foldedInterrupts?.(now) ?? []) {
        items.push({ kind: 'folded', text: `折叠 ${folded}` })
      }

      for (const degrade of deps.degradeEvents?.(now) ?? []) {
        items.push({ kind: 'degrade', text: `降级 ${degrade}` })
      }

      const open = openCommitments(read)
      if (open.length === 0 && items.length === 0) return null
      if (items.length === 0) {
        // Heartbeat line: work is in flight and nothing changed today.
        items.push({ kind: 'heartbeat', text: `在办 ${open.length} 件，今天没有变化` })
      }

      const rendered = render('brief', { items: items.map((item) => item.text) })
      return { body: rendered.text, items }
    },
  }
}

/** Words in a built brief body; the template's own ceiling is shared with every message. */
export function briefWords(body: BriefBody): number {
  return countWords(body.body)
}
/** What `brief --now` gets back: the submitted body, or null when there was nothing to say. */
export interface BriefNowOutcome { body: string; items: readonly BriefItem[] }

/**
 * One-step entry for `brief --now` (T27 gap 6): build today's brief and hand it to
 * the outlet. Null means nothing to say, which the command maps to exit 3.
 */
export function createBriefNow(deps: {
  brief: Brief
  now(): number
  day(now: number): string
  submit(body: BriefBody): void
}): () => Promise<BriefNowOutcome | null> {
  return async () => {
    const now = deps.now()
    const body = deps.brief.build(deps.day(now), now)
    if (body === null) return null
    deps.submit(body)
    return { body: body.body, items: body.items }
  }
}
