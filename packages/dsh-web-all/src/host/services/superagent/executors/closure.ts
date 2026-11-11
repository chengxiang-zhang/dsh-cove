/** Legacy turn closure retains ready claims for canonical candidate collection.
 * Independent verification and delivery own fulfillment; a report, path, tool
 * exit or timeout can never promote this legacy observation into acceptance.
 */

import type { KernelTx, Ledger } from '../kernel/ledger.ts'
import { PHYSICAL } from '../protocol/db.ts'
import { TERMINAL_STATES, type AttemptRow, type CommitmentRow, type CommitmentState, type EndReason } from '../protocol/objects.ts'
import type { ReportInput } from '../protocol/tools.ts'
import type { ToolLogEntry } from './attempts.ts'

const A = PHYSICAL.attempt
const C = PHYSICAL.commitment
const J = PHYSICAL.journal

/** How long a `ready` report may wait for its `turn/end` before the table judges it. */
export const PENDING_CLOSE_MS = 10 * 60_000

export type ClosureState = CommitmentState | 'pending_close' | 'escalate'

export interface ClosureResult {
  state: ClosureState
  evidenceOk: boolean
}

/** What the closure needs to know about one running executor; T19's `Executors` satisfies it. */
export interface ExecutorFacts {
  lastTurnEnd(attemptId: string): { turn: number; reason: EndReason } | undefined
  lastReport(attemptId: string): ReportInput | undefined
  toolLog(attemptId: string): readonly ToolLogEntry[]
}

/** Host-side checks for `artifact` criteria: a path on disk, or commits on the branch. */
export interface ArtifactProbe {
  pathExists(path: string): boolean
  /** Commits on the branch relative to its base; 0 when unknown or none. */
  branchCommits(branch: string): number
}

export interface ClosureDeps {
  ledger: Ledger
  facts: ExecutorFacts
  artifacts: ArtifactProbe
  /**
   * `10` splits a block into technical (environment/dependency/permission, solvable
   * inside) and product (scope/standard/trade-off). That reading belongs to judgment;
   * executors default to the safe side, which is self-healing rather than asking.
   */
  blockedAs?: (report: ReportInput) => 'technical' | 'product'
  /** One asked assumption carrying the product question and its default. */
  ask?: (commitmentId: string, question: string, fallback: string) => void
}

export interface Closure {
  close(attemptId: string, turnEnd: { reason: EndReason }, report?: ReportInput): ClosureResult
  /** A `ready` report arrived before its `turn/end`: record the wait, judge nothing yet. */
  noteReady(attemptId: string, report: ReportInput): ClosureResult
  /** Judges waiting `ready` reports older than `PENDING_CLOSE_MS`; returns how many. */
  pendingSweep(now: number): number
}

const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_STATES)
const UNVERIFIED_FALLBACK = 'no reply = park this until you decide'

interface Outcome {
  state: CommitmentState | 'pending_close' | 'escalate' | 'ask'
  evidenceOk: boolean
  note: string
  evidence?: unknown
  question?: string
}

const outcome = (state: Outcome['state'], note: string, extra: { evidence?: unknown; question?: string } = {}): Outcome =>
  ({ state, evidenceOk: state === 'fulfilled', note, ...extra })

/** Trailing spaces, doubled spaces and case are noise when comparing a command. */
function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Tools whose calls are never evidence (R1 A11): the executor's own report and the
 * host-side tools. A command is only ever what a command-running tool was asked to run.
 */
export const NON_EVIDENCE_TOOLS: ReadonlySet<string> = new Set(['report', 'judge', 'commit', 'amend', 'release', 'pushback', 'look', 'remember', 'propose', 'say'])

/**
 * The command a `tool/call` ran: the explicit `command`/`cmd` key of its arguments JSON.
 * No fallback to the raw text, and never from a non-evidence tool (R1 A11).
 */
export function commandOf(entry: ToolLogEntry): string | undefined {
  if (NON_EVIDENCE_TOOLS.has(entry.name) || entry.callId === '') return undefined
  try {
    const parsed: unknown = JSON.parse(entry.arguments)
    if (typeof parsed === 'object' && parsed !== null) {
      const pick = (parsed as Record<string, unknown>).command ?? (parsed as Record<string, unknown>).cmd
      if (typeof pick === 'string' && pick.trim() !== '') return pick
    }
  } catch {
    // Non-JSON arguments carry no command key: not evidence.
  }
  return undefined
}

/**
 * The command `done_when` names (B1): the first backtick span. Without one, a command
 * criterion cannot be checked mechanically and closes at most as unverified.
 */
export function expectedCommand(doneWhen: string): string | undefined {
  const m = /`([^`]+)`/.exec(doneWhen)
  return m && m[1].trim() !== '' ? m[1].trim() : undefined
}

/** The exit code `done_when` expects: `退出码 N` / `exit N` / `exit code N`; 0 when it states none. */
export function expectedExit(doneWhen: string): number {
  const m = /(?:退出码|exit(?:\s*code)?)\s*[:=：为是]?\s*(-?\d+)/i.exec(doneWhen.replace(/`[^`]*`/g, ''))
  return m ? Number(m[1]) : 0
}

/** `done_when` elements for answer/observation criteria: separated by ';', ',', '、'. */
export function elementsOf(doneWhen: string): string[] {
  return doneWhen.split(/[;；,，、\n]/).map(part => normalized(part)).filter(part => part.length > 0)
}

export function createClosure(deps: ClosureDeps): Closure {
  const { ledger, facts } = deps
  const write = <T>(fn: (tx: KernelTx) => T): T => ledger.open(fn, { module: 'executors' })

  const attemptById = (id: string): AttemptRow | undefined =>
    ledger.read.get<AttemptRow>(`SELECT * FROM ${A} WHERE attempt_id = ?`, id)
  const commitmentById = (id: string): CommitmentRow | undefined =>
    ledger.read.get<CommitmentRow>(`SELECT * FROM ${C} WHERE commitment_id = ?`, id)

  /** R23: an amendment or passthrough the executor has not consumed yet. */
  function unconsumed(commitmentId: string): number {
    const row = ledger.read.get<{ n: number }>(
      `SELECT count(*) AS n FROM ${J} WHERE commitment_id = ? AND kind IN ('amend', 'passthrough') AND consumed_turn IS NULL`,
      commitmentId)
    return row?.n ?? 0
  }

  function ended(attempt: AttemptRow, reason: EndReason): void {
    if (attempt.state === 'ended') return
    write(tx => tx.updateAttempt(attempt.attempt_id, { state: 'ended', end_reason: reason }))
  }

  function readyOutcome(attempt: AttemptRow, commitment: CommitmentRow, report: ReportInput): Outcome {
    // Ready is a candidate claim. P5 collects it into the canonical verification
    // flow; legacy path/summary/tool observations cannot authorize fulfillment.
    return outcome('unverified', 'candidate awaiting independent verification', {
      evidence: { candidateClaim: report, attemptId: attempt.attempt_id, commitmentId: commitment.commitment_id },
    })
  }

  function blockedOutcome(commitment: CommitmentRow, report: ReportInput): Outcome {
    const kind = deps.blockedAs?.(report) ?? 'technical'
    if (kind === 'technical') return outcome('escalate', 'blocked on something technical')
    // A product question is the one case where a person is asked (R13): one question
    // with a default, and the commitment stays open while it waits.
    return outcome('pending_close', 'blocked on a product question', {
      question: report.question ?? `what should ${commitment.commitment_id} optimise for?`,
    })
  }

  /** The table of `10 "结案"`, one branch per row. */
  function judge(attempt: AttemptRow, commitment: CommitmentRow, reason: EndReason, report: ReportInput | undefined): Outcome {
    if (reason === 'completed' || reason === 'blocked') {
      if (reason === 'blocked' || report?.state === 'blocked') {
        if (report === undefined) return outcome('escalate', 'ended blocked without a report')
        return blockedOutcome(commitment, report)
      }
      if (report?.state === 'failed' || report?.state === 'dropped') {
        return outcome('escalate', `ended ${reason} with a ${report.state} report`)
      }
      if (report?.state === 'ready') return readyOutcome(attempt, commitment, report)
      return outcome('unverified', report === undefined ? 'ended without a terminal report' : `ended with a ${report.state} report`)
    }
    if (reason === 'aborted') {
      if (attempt.cancel_origin === 'release') return outcome('released', 'released by the owner')
      if (attempt.cancel_origin === 'budget' || attempt.cancel_origin === 'deadline') {
        return outcome('at_risk', `stopped by ${attempt.cancel_origin}`, { evidence: { cancel_origin: attempt.cancel_origin } })
      }
      // stall/loop/dispatch/reconcile: the self-heal loop owns this attempt, not closure.
      return outcome('pending_close', `cancelled by ${attempt.cancel_origin ?? 'unknown'}: self-heal decides`)
    }
    // interrupted | error | max-tokens | unknown | forked | orphaned | dispatch_failed:
    // every one of them is a failure for closure purposes ("未知当失败", P4).
    return outcome('escalate', `turn ended ${reason}`)
  }

  function record(commitmentId: string, body: Record<string, unknown>): void {
    write(tx => tx.append(commitmentId, { actor: 'executors', kind: 'state', body }))
  }

  function commitOutcome(attempt: AttemptRow, commitment: CommitmentRow, reason: EndReason, result: Outcome): ClosureResult {
    // Three outcomes are not commitment states: the work waits, the escalation
    // decides, or the owner is being asked. None of them closes anything.
    if (result.state === 'pending_close' || result.state === 'escalate' || result.state === 'ask') {
      if (result.state === 'escalate') ended(attempt, reason)
      const waiting = result.state === 'ask' ? 'pending_close' : result.state
      record(commitment.commitment_id, result.question === undefined
        ? { closed: waiting, reason, note: result.note }
        : { closed: waiting, reason, note: result.note, asked: result.question })
      if (result.question !== undefined) deps.ask?.(commitment.commitment_id, result.question, UNVERIFIED_FALLBACK)
      return { state: waiting, evidenceOk: false }
    }

    const state = result.state
    ended(attempt, reason)
    write(tx => {
      tx.append(commitment.commitment_id, { actor: 'executors', kind: 'state', body: {
        closed: state, reason, note: result.note, ...(result.evidence === undefined ? {} : { evidence: result.evidence }) } })
      if (state === 'at_risk') return tx.transition(commitment.commitment_id, 'at_risk', { ball: 'me' })
      if (state === 'fulfilled') {
        return tx.transition(commitment.commitment_id, 'fulfilled', { evidence_json: JSON.stringify(result.evidence ?? null) })
      }
      return tx.transition(commitment.commitment_id, state)
    })
    return { state, evidenceOk: result.evidenceOk }
  }

  return {
    close(attemptId: string, turnEnd: { reason: EndReason }, report?: ReportInput): ClosureResult {
      const attempt = attemptById(attemptId)
      if (attempt === undefined) throw new Error(`closure: unknown attempt ${attemptId}`)
      const commitment = commitmentById(attempt.commitment_id)
      if (commitment === undefined) throw new Error(`closure: unknown commitment ${attempt.commitment_id}`)
      if (TERMINAL.has(commitment.state)) return { state: commitment.state, evidenceOk: commitment.evidence_json !== null }

      // R23 first: while input is waiting to be eaten, nothing is judged.
      if (unconsumed(commitment.commitment_id) > 0) {
        record(commitment.commitment_id, { closed: 'pending_close', reason: turnEnd.reason, note: 'unconsumed input' })
        return { state: 'pending_close', evidenceOk: false }
      }

      const resolved = report ?? facts.lastReport(attemptId)
      return commitOutcome(attempt, commitment, turnEnd.reason, judge(attempt, commitment, turnEnd.reason, resolved))
    },

    noteReady(attemptId: string, report: ReportInput): ClosureResult {
      const attempt = attemptById(attemptId)
      if (attempt === undefined) throw new Error(`closure: unknown attempt ${attemptId}`)
      // A turn end already arrived: the normal path owns it.
      if (facts.lastTurnEnd(attemptId) !== undefined) return { state: 'pending_close', evidenceOk: false }
      record(attempt.commitment_id, { closed: 'pending_close', waiting: 'turn/end', attempt: attemptId, report })
      return { state: 'pending_close', evidenceOk: false }
    },

    pendingSweep(now: number): number {
      const rows = ledger.read.all<{ commitment_id: string; seq: number; body_json: string | null }>(
        `SELECT commitment_id, seq, body_json FROM ${J} WHERE kind = 'state' AND body_json IS NOT NULL AND created_at <= ? ORDER BY seq`,
        now - PENDING_CLOSE_MS)
      // R1 A12: the journal is append-only, so a judged waiting row is marked by a later
      // `{ swept_of: <seq> }` row; a marked row is never judged again.
      const swept = new Set(ledger.read.all<{ commitment_id: string; body_json: string }>(
        `SELECT commitment_id, body_json FROM ${J} WHERE kind = 'state' AND body_json LIKE '%"swept_of"%'`)
        .map(r => { try { return `${r.commitment_id}#${String((JSON.parse(r.body_json) as { swept_of?: unknown }).swept_of)}` } catch { return '' } }))
      let judged = 0
      for (const row of rows) {
        if (swept.has(`${row.commitment_id}#${row.seq}`)) continue
        let body: Record<string, unknown>
        try {
          const parsed: unknown = JSON.parse(row.body_json as string)
          if (typeof parsed !== 'object' || parsed === null) continue
          body = parsed as Record<string, unknown>
        } catch {
          continue
        }
        if (body.waiting !== 'turn/end' || typeof body.attempt !== 'string') continue
        const attempt = attemptById(body.attempt)
        if (attempt === undefined || attempt.state === 'ended') continue
        const commitment = commitmentById(row.commitment_id)
        if (commitment === undefined || TERMINAL.has(commitment.state)) continue
        // A real turn end arrived meanwhile; the normal closure path has it.
        if (facts.lastTurnEnd(body.attempt) !== undefined) continue
        const report = (body.report ?? facts.lastReport(body.attempt)) as ReportInput | undefined
        if (report === undefined || report.state !== 'ready') continue
        // Missing `turn/end` is not failure (10): the report said done, so the table is
        // read from the `completed` row and the missing fact decides nothing.
        record(commitment.commitment_id, { swept_of: row.seq, attempt: body.attempt })
        commitOutcome(attempt, commitment, 'completed', judge(attempt, commitment, 'completed', report))
        judged += 1
      }
      return judged
    },
  }
}