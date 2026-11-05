/**
 * Speculative work: think ahead, never act ahead (09 投机执行, FREEZE D6).
 *
 * The boundary is the whole point. A speculation may read, probe and draft; it may
 * not change code, configuration or anything outward-facing. That is why nothing
 * in this module can enqueue an outbound message: there is no outbox write here at
 * all, so an unadopted speculation is silent by construction rather than by
 * discipline.
 *
 * Two consequences the code keeps mechanical:
 *
 * - `discard` leaves no trace the owner can hear: state only, zero messages.
 * - A discarded draft stays readable for seven days (the owner may ask "what were
 *   you working on?"), then the directory goes while the row stays, because the
 *   ledger is append-only and the row is the record.
 *
 * Over-eager speculation is the secretary's second form of empty running, so the
 * patrol class narrows itself when most of its output is thrown away.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { LedgerReader, LedgerTx } from '../protocol/db.ts'

/** The three speculation classes (09 投机执行). */
export const SPECULATION_KINDS = ['probe', 'prep', 'patrol'] as const
export type SpeculationKind = (typeof SPECULATION_KINDS)[number]

/** Unadopted drafts expire after three days (09: 3 天未采纳 → 过期，静默). */
export const SPECULATION_EXPIRE_MS = 3 * 24 * 3_600_000
/** Discarded drafts stay readable for seven days; the row itself is never deleted. */
export const SPECULATION_KEEP_MS = 7 * 24 * 3_600_000
/** Discard ratio above which the patrol class narrows (09: 连续一周 > 80%). */
export const PATROL_NARROW_THRESHOLD = 0.8
/** Window for the patrol discard ratio. */
export const PATROL_WINDOW_MS = 7 * 24 * 3_600_000

export interface SpeculationContext {
  commitment_id?: string
  desk_id?: string
}

export interface Speculation {
  /** Register a new speculation and create its draft directory; returns the id. */
  start(tx: LedgerTx, kind: SpeculationKind, ctx: SpeculationContext): string
  /** The owner used the draft; the first reply may cite it. */
  adopt(tx: LedgerTx, specId: string): void
  /** The draft was not used: state only, zero messages. */
  discard(tx: LedgerTx, specId: string): void
  /** Expire stale pending drafts and remove old discarded directories; returns expired count. */
  expire(tx: LedgerTx, now: number): number
  /** True when the patrol class should narrow (discard ratio over the window). */
  narrowPatrol(now: number): boolean
}

/** Default landing directory: `$DSH_HOME/superagent/speculations/<id>/`. */
export function speculationRoot(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'superagent', 'speculations')
}

interface SpecRow { spec_id: string, created_at: number, updated_at: number | null, path: string | null, state: string }

export function createSpeculation(deps: { read: LedgerReader, root?: string }): Speculation {
  const root = deps.root ?? speculationRoot()
  const read = deps.read

  function nextId(): string {
    const row = read.get<{ n: number | null }>(
      `SELECT max(CAST(substr(spec_id, 4) AS INTEGER)) AS n FROM sa_speculation WHERE spec_id LIKE 'SP-%'`,
    )
    return `SP-${(row?.n ?? 0) + 1}`
  }

  return {
    start(tx, kind, ctx) {
      const specId = nextId()
      const dir = join(root, specId)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'draft.md'), `# ${specId} ${kind}\n`, 'utf8')
      tx.run(
        `INSERT INTO sa_speculation (spec_id, kind, commitment_id, desk_id, path, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        specId,
        kind,
        ctx.commitment_id ?? null,
        ctx.desk_id ?? null,
        dir,
        tx.now,
        tx.now,
      )
      return specId
    },

    adopt(tx, specId) {
      tx.run(`UPDATE sa_speculation SET state = 'used', updated_at = ? WHERE spec_id = ?`, tx.now, specId)
    },

    discard(tx, specId) {
      // No outbound row, no journal line: a discarded draft is invisible outside
      // this table until the owner asks about it.
      tx.run(`UPDATE sa_speculation SET state = 'discarded', updated_at = ? WHERE spec_id = ?`, tx.now, specId)
    },

    expire(tx, now) {
      let expired = 0
      const pending = read.all<SpecRow>(
        `SELECT spec_id, created_at, updated_at, path, state FROM sa_speculation
         WHERE state = 'pending' AND created_at <= ?`,
        now - SPECULATION_EXPIRE_MS,
      )
      for (const row of pending) {
        tx.run(`UPDATE sa_speculation SET state = 'expired', updated_at = ? WHERE spec_id = ?`, now, row.spec_id)
        expired += 1
      }
      const discarded = read.all<SpecRow>(
        `SELECT spec_id, created_at, updated_at, path, state FROM sa_speculation
         WHERE state = 'discarded' AND COALESCE(updated_at, created_at) <= ?`,
        now - SPECULATION_KEEP_MS,
      )
      for (const row of discarded) {
        if (typeof row.path === 'string' && row.path.length > 0) {
          rmSync(row.path, { recursive: true, force: true })
        }
        // The row stays: the ledger is the record, the directory is just a draft.
        tx.run(`UPDATE sa_speculation SET path = NULL, updated_at = ? WHERE spec_id = ?`, now, row.spec_id)
      }
      return expired
    },

    narrowPatrol(now) {
      const rows = read.all<{ state: string }>(
        `SELECT state FROM sa_speculation
         WHERE created_at >= ? AND state IN ('used', 'discarded')`,
        now - PATROL_WINDOW_MS,
      )
      if (rows.length === 0) return false
      const discarded = rows.filter((row) => row.state === 'discarded').length
      return discarded / rows.length > PATROL_NARROW_THRESHOLD
    },
  }
}
