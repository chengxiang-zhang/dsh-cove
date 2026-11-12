/**
 * `status [--json]`: what is in flight, what waits on someone, today's
 * interruptions, the idle rate, open degradations, and who holds the outlet
 * lease (02, 09, 11).
 *
 * The open set is the readout `11` fixes - `state IN ('proposed','open','at_risk')`
 * ordered by id - so that the panel, the command and the restart comparison all
 * read the same list. Nothing is derived: every field is a row or a count, and an
 * empty ledger is a successful answer, not "no data" (that code is for a command
 * that was asked for something absent).
 */

import type { LedgerReader } from '../../protocol/db.ts'
import { EXIT_OK, usage, type CommandDeps, type CommandResult } from './index.ts'

/** The open set of `11`: a commitment in one of these states is in flight. */
export const OPEN_STATES_SQL = `('proposed', 'open', 'at_risk')`

/** One screen. The text form never exceeds this many lines. */
export const STATUS_MAX_LINES = 40

const OPEN_ROWS_SHOWN = 12
const DEGRADE_ROWS_SHOWN = 4
const DAY_MS = 86_400_000

export interface StatusOpenRow {
  commitment_id: string
  state: string
  what: string
  ball: string
  next_look_at: number | null
}

export interface StatusPayload {
  open: StatusOpenRow[]
  /** In flight but not on the secretary's desk: `ball <> 'me'`. */
  waiting: StatusOpenRow[]
  interruptsToday: number
  idleRate24h: number
  degrade: Array<{ degrade_id: string; reason: string; scope: string; started_at: number }>
  leaseHolder: string | null
}

function startOfLocalDay(now: number): number {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  return midnight.getTime()
}

/** Reads every field the status contract names. */
export function buildStatus(read: LedgerReader, now: number): StatusPayload {
  const open = read.all<StatusOpenRow>(
    `SELECT commitment_id, state, what, ball, next_look_at FROM sa_commitment
      WHERE state IN ${OPEN_STATES_SQL} ORDER BY commitment_id ASC`)
  const interruptsToday = read.get<{ n: number }>(
    `SELECT count(*) AS n FROM sa_outbox WHERE tier = 'interrupt' AND state = 'sent' AND sent_at >= ?`,
    startOfLocalDay(now))?.n ?? 0
  const window = read.get<{ total: number; idle: number }>(
    `SELECT count(*) AS total, coalesce(sum(CASE WHEN ops = 0 THEN 1 ELSE 0 END), 0) AS idle
       FROM sa_deliberation WHERE created_at >= ?`, now - DAY_MS)
  const total = window?.total ?? 0
  return {
    open,
    waiting: open.filter((row) => row.ball !== 'me'),
    interruptsToday,
    idleRate24h: total === 0 ? 0 : (window?.idle ?? 0) / total,
    degrade: read.all(
      `SELECT degrade_id, reason, scope, started_at FROM sa_degrade_event
        WHERE ended_at IS NULL ORDER BY started_at ASC, degrade_id ASC`),
    leaseHolder: read.get<{ holder: string }>(`SELECT holder FROM sa_lease WHERE name = 'outlet'`)?.holder ?? null,
  }
}

function clip(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines - 1)
  kept.push(`另有 ${lines.length - kept.length} 行，用 --json 看全量`)
  return kept
}

/**
 * The human form: one summary line, the in-flight rows, then degradations.
 *
 * The line cap is applied last, so a large ledger loses rows and says so; it never
 * produces more than one screen.
 */
export function renderStatusText(payload: StatusPayload, maxLines = STATUS_MAX_LINES): string {
  const idlePercent = Math.round(payload.idleRate24h * 100)
  const lines = [
    `在办 ${payload.open.length} · 等别人 ${payload.waiting.length} · 今日打断 ${payload.interruptsToday}`
      + ` · 24h 空跑率 ${idlePercent}% · 租约 ${payload.leaseHolder ?? '无'}`,
  ]
  for (const row of payload.open.slice(0, OPEN_ROWS_SHOWN)) {
    const look = row.next_look_at === null ? '' : ` · 下次 ${new Date(row.next_look_at).toISOString()}`
    lines.push(`${row.commitment_id} ${row.state} · ${row.what} · 球在 ${row.ball}${look}`)
  }
  if (payload.open.length > OPEN_ROWS_SHOWN) lines.push(`…还有 ${payload.open.length - OPEN_ROWS_SHOWN} 件在办`)
  if (payload.degrade.length > 0) {
    lines.push('降级:')
    for (const event of payload.degrade.slice(0, DEGRADE_ROWS_SHOWN)) {
      lines.push(`  ${event.reason} · ${event.scope} · 自 ${new Date(event.started_at).toISOString()}`)
    }
    if (payload.degrade.length > DEGRADE_ROWS_SHOWN) {
      lines.push(`  …还有 ${payload.degrade.length - DEGRADE_ROWS_SHOWN} 条`)
    }
  }
  return clip(lines, maxLines).join('\n')
}

/** Stamp that changes whenever the executor transport ships; the hot-reload probe reads it. */
export const SUPERAGENT_BUILD = '2026-11-07-transport-http+registry'

/** `status [--json]`; an unknown flag is an argument error. */
export function statusCommand(deps: CommandDeps, args: string[]): CommandResult {
  if (args.some((arg) => arg !== '--json')) return usage('用法: status [--json]', 'usage: status [--json]')
  const payload = {
    ...buildStatus(deps.read, deps.now()),
    runtime: { build: SUPERAGENT_BUILD, transport: deps.runtime?.().transport ?? 'unknown' },
  }
  return { json: payload, text: renderStatusText(payload), exitCode: EXIT_OK }
}