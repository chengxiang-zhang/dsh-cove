/**
 * Daily sweep of leaked workspaces and `sa/*` branches (10 "工作目录").
 *
 * The leak is a known gap: nothing ever removed a workspace a closed commitment
 * left behind. The repair is deliberately timid, because deleting a directory is
 * the one irreversible act in this module:
 *
 * 1. a run only ever *reports* (dry run) and writes that report to the journal;
 * 2. a directory is deleted only when a second run produces exactly the same
 *    candidate set — one report could be a coincidence, two identical ones are a
 *    policy;
 * 3. a directory with uncommitted changes is never deleted, whatever the report
 *    says: the changes are the owner's work, not our garbage;
 * 4. the row is stamped `removed_at`, never deleted, so "this directory existed"
 *    survives the cleanup.
 *
 * The previous report is kept in memory. A restart therefore postpones deletion to
 * the next pair of runs; it can never cause a premature one.
 */

import type { KernelTx, Ledger } from '../kernel/ledger.ts'
import { PHYSICAL } from '../protocol/db.ts'
import { TERMINAL_STATES, type CommitmentRow } from '../protocol/objects.ts'

const W = PHYSICAL.workspace
const C = PHYSICAL.commitment

/** A commitment has to be closed for this long before its directory is a candidate. */
export const SWEEP_IDLE_MS = 24 * 3_600_000

const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_STATES)

/** The filesystem and git side, supplied by the host (never opened from here). */
export interface SweepPorts {
  hasUncommittedChanges(dir: string): boolean
  removeDir(dir: string): void
  listBranches(): readonly string[]
  removeBranch(branch: string): void
}

/** `sa_workspace` belongs to the world module; the sweep delegates that one write. */
export interface SweepWorld {
  removeWorkspace(tx: KernelTx, path: string, now: number): void
}

export interface SweepDeps {
  ledger: Ledger
  ports: SweepPorts
  world: SweepWorld
  idleMs?: number
}

export interface SweepReport {
  /** Directories and branches that qualify, sorted; both runs must agree exactly. */
  candidates: string[]
  deleted: string[]
  dryRun: boolean
}

export interface Sweep {
  sweep(now: number): SweepReport
}

interface Candidate {
  key: string
  kind: 'dir' | 'branch'
  commitmentId: string
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function createSweep(deps: SweepDeps): Sweep {
  const { ledger, ports } = deps
  const idleMs = deps.idleMs ?? SWEEP_IDLE_MS
  let previous: readonly string[] | undefined

  return {
    sweep(now: number): SweepReport {
      const rows = ledger.read.all<{ path: string; commitment_id: string | null }>(
        `SELECT path, commitment_id FROM ${W} WHERE removed_at IS NULL`)
      const branches = new Set(ports.listBranches())
      const found: Candidate[] = []

      for (const row of rows) {
        if (row.commitment_id === null) continue
        const commitment = ledger.read.get<CommitmentRow>(`SELECT * FROM ${C} WHERE commitment_id = ?`, row.commitment_id)
        if (commitment === undefined || !TERMINAL.has(commitment.state)) continue
        if (commitment.closed_at === null || commitment.closed_at > now - idleMs) continue
        found.push({ key: row.path, kind: 'dir', commitmentId: commitment.commitment_id })
        const branch = `sa/${commitment.commitment_id}`
        if (branches.has(branch)) found.push({ key: branch, kind: 'branch', commitmentId: commitment.commitment_id })
      }

      found.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
      const candidates = found.map(item => item.key)
      const dryRun = previous === undefined || !sameSet(previous, candidates)
      const deleted: string[] = []

      if (!dryRun) {
        for (const item of found) {
          if (item.kind === 'branch') {
            ports.removeBranch(item.key)
            deleted.push(item.key)
            continue
          }
          // Dirty means the owner has work in there; report it and stop.
          if (ports.hasUncommittedChanges(item.key)) continue
          ports.removeDir(item.key)
          ledger.open(tx => deps.world.removeWorkspace(tx, item.key, now), { module: 'world' })
          deleted.push(item.key)
        }
      }

      const byCommitment = new Map<string, string[]>()
      for (const item of found) {
        const list = byCommitment.get(item.commitmentId)
        if (list === undefined) byCommitment.set(item.commitmentId, [item.key])
        else list.push(item.key)
      }
      for (const [commitmentId, keys] of byCommitment) {
        ledger.open(tx => tx.append(commitmentId, {
          actor: 'executors',
          kind: 'note',
          body: { sweep: 'workspace', dryRun, candidates: keys, deleted: deleted.filter(key => keys.includes(key)) },
        }), { module: 'executors' })
      }

      previous = candidates
      return { candidates, deleted, dryRun }
    },
  }
}