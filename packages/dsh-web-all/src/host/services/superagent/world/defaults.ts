/**
 * The three-state default table: what a party class may do when no explicit
 * mandate names the path.
 *
 * `04` calls this "默认配置，不是代码" - data, not a branch. Read is not the
 * dangerous half: everyone inside the room may read. Write is the dangerous half,
 * so the table never grants one. The owner's write rows say `draft`, and only an
 * explicit path-level mandate out of the configuration channel raises one to
 * `allow` (`04` "写必须显式给到路径级", NEEDS-DECISION N24). `mandate.ts` enforces
 * that ceiling again at decision time, so a future edit of this table cannot
 * hand out a write by accident.
 */

import type { Capability, Strength } from '../protocol/objects.ts'

/** Who is asking. `04`算: 老板 / 同事 / 群内其他人 / 外部人. */
export type PartyClass = 'owner' | 'colleague' | 'member' | 'external'

/**
 * A complete table: every party class answers every capability. The `Record`
 * type makes completeness a compile-time property, and the test re-checks it at
 * runtime so a hand-edited table cannot leave a hole that fails open.
 */
export type DefaultTable = Readonly<Record<PartyClass, Readonly<Record<Capability, Strength>>>>

const TABLE: Record<PartyClass, Record<Capability, Strength>> = {
  // N24: read is allowed outright; every write starts at draft.
  owner: {
    read: 'allow',
    write_repo: 'draft',
    write_host: 'draft',
    change_prod: 'draft',
    publish: 'draft',
    commit_promise: 'draft',
    steer_foreign: 'draft',
    provision: 'draft',
  },
  // A colleague may work in the repository (draft, so the request is visible)
  // but may never touch production, publish, or promise on someone's behalf.
  colleague: {
    read: 'allow',
    write_repo: 'draft',
    write_host: 'draft',
    change_prod: 'deny',
    publish: 'deny',
    commit_promise: 'deny',
    steer_foreign: 'deny',
    provision: 'draft',
  },
  // Everyone else in the room may read and nothing more.
  member: {
    read: 'allow',
    write_repo: 'deny',
    write_host: 'deny',
    change_prod: 'deny',
    publish: 'deny',
    commit_promise: 'deny',
    steer_foreign: 'deny',
    provision: 'deny',
  },
  // Outside the room nothing is granted, read included.
  external: {
    read: 'deny',
    write_repo: 'deny',
    write_host: 'deny',
    change_prod: 'deny',
    publish: 'deny',
    commit_promise: 'deny',
    steer_foreign: 'deny',
    provision: 'deny',
  },
}

for (const row of Object.values(TABLE)) Object.freeze(row)

/** Frozen so a caller cannot widen policy by mutating the shared table. */
export const DEFAULT_TABLE: DefaultTable = Object.freeze(TABLE)