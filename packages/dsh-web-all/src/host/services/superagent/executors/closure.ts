/**
 * Closure: judging an executor's turn end without believing its self-report (10).
 *
 * The table in `10 "结案：不信自述"` is implemented row by row. Two properties drive
 * the shape of this file:
 *
 * 1. A report is a claim, evidence is a fact. For `command` criteria the claim is
 *    checked against the session's tool log — same command, same exit code — and a
 *    report that does not match is only ever `unverified`, never `fulfilled`.
 *    Exit codes come from the `[exit code: N]` marker (no marker means 0); a
 *    `tool/result` that never arrived cannot verify anything.
 * 2. Not judging is a valid outcome. Unconsumed input means the next turn still has
 *    to eat it (`pending_close`, R23); a `ready` report that arrives before its
 *    `turn/end` is a "pending close" that the sweep judges after ten minutes with
 *    the same table. Both are recorded in the journal so the wait has a reason.
 *
 * Closure writes the ledger (`transition`, `journal`, attempt end) but never talks:
 * `cannot` and the asked assumption belong to escalate/judgment.
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

/** The command a `tool/call` ran: the `command`/`cmd` key of its arguments JSON, else the raw text. */
export function commandOf(entry: ToolLogEntry): string | undefined {
  const raw = entry.arguments
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) {
      const pick = (parsed as Record<string, unknown>).command ?? (parsed as Record<string, unknown>).cmd
      if (typeof pick === 'string') return pick
    }
  } catch {
    // Raw, non-JSON arguments are compared as they arrived.
  }
  return raw.length > 0 ? raw : undefined
}

/** `done_when` elements for answer/observation criteria: separated by ';', ',', '、'. */
export function elementsOf(doneWhen: string): string[] {
  return doneWhen.split(/[;；,，、\n]/).map(part => normalized(part)).filter(part => part.length > 0)
}

export function createClosure(deps: ClosureDeps): Closure {
  const { ledger, facts, artifacts } = deps
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
    const evidence = report.evidence ?? []
    if (commitment.check_kind === 'command') {
      if (evidence.length === 0) return outcome('unverified', 'ready without evidence')
      const calls = facts.toolLog(attempt.attempt_id)
      for (const item of evidence) {
        const matched = calls.find(call => commandOf(call) !== undefined
          && normalized(commandOf(call) as string) === normalized(item.command)
          && call.exit !== undefined && call.exit === item.exit)
        // Same command, same exit code, both from the session itself: that is the fact.
        if (matched !== undefined) return outcome('fulfilled', 'command matched the tool log', { evidence: item })
      }
      return outcome('unverified', 'no tool call matches the reported command and exit code')
    }
    if (commitment.check_kind === 'artifact') {
      const branch = `sa/${commitment.commitment_id}`
      const commits = artifacts.branchCommits(branch)
      if (artifacts.pathExists(commitment.done_when) || commits > 0) {
        return outcome('fulfilled', 'artifact present', { evidence: { artifact: commitment.done_when, branch, commits } })
      }
      return outcome('unverified', 'neither the path nor the branch shows the artifact')
    }
    // answer | observation: every element of done_when has to appear in the summary.
    const elements = elementsOf(commitment.done_when)
    const summary = normalized(report.summary)
    if (elements.length > 0 && elements.every(element => summary.includes(element))) {
      return outcome('fulfilled', 'summary covers done_when', { evidence: { done_when: commitment.done_when, elements } })
    }
    return outcome('unverified', 'summary does not cover done_when')
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
      const rows = ledger.read.all<{ commitment_id: string; body_json: string | null }>(
        `SELECT commitment_id, body_json FROM ${J} WHERE kind = 'state' AND body_json IS NOT NULL AND created_at <= ?`,
        now - PENDING_CLOSE_MS)
      let judged = 0
      for (const row of rows) {
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
        commitOutcome(attempt, commitment, 'completed', judge(attempt, commitment, 'completed', report))
        judged += 1
      }
      return judged
    },
  }
}