/**
 * Placement: steps 2 and 3 of `04` "归属：活落在哪".
 *
 * The three steps have three different deciders, and this file only owns two of
 * them. Step 1 (realm) and step 3's landing mode are proposals the caller makes;
 * step 2 (which machine) is a mechanical filter over the world model; step 3's
 * "new workspace" is a provision on a target host, so it needs a write mandate
 * that is `allow` rather than `draft` (`04`: "新建工作区就是没人认领的副作用"
 * otherwise).
 *
 * Two deliberate limits:
 *
 * 1. Read-only. `place` answers where the work would go; the caller registers the
 *    workspace and dispatches. Keeping the decision pure is what lets the same
 *    question be asked twice (dossier rebuild, retry) without side effects.
 * 2. Only `workspace='new'` is gated here, because that is the one the design
 *    names. For `reuse` and `temp` the write gate stays with the caller's
 *    `mandate()` query; a placement is not an authorization.
 */

import { PHYSICAL, type LedgerReader } from '../protocol/db.ts'
import { normalizePath, type ScopePath } from './paths.ts'
import { filterHosts } from './resolve.ts'
import type { MandateDecision } from './mandate.ts'
import type { Capability, CheckKind, WorldEntityRow } from '../protocol/objects.ts'

const ENTITY = PHYSICAL.world_entity

export type PlacementRealm = 'local' | 'netbird' | 'external'
export type WorkspaceMode = 'reuse' | 'new' | 'temp'

/**
 * What the caller proposes plus what it knows about the work. The five fields of
 * `04`'s `place(commitment)` are `what`, `check_kind`, `target`, `principal` and
 * `needsWrite`; `realm`, `host`, `path` and `workspace` are the step 1/3
 * proposals the spec says come from the caller (judgment), and `executorClass` is
 * what the step 2 filter must match against the host's self-declared manifest.
 */
export interface PlacementRequest {
  what: string
  check_kind: CheckKind
  target?: string
  principal: string
  needsWrite: boolean
  realm: PlacementRealm
  /** Proposed machine canonical or entity id. Absent means "let the filter pick". */
  host?: string
  /** Proposed target path. Defaults to the host's path (netbird) or the realm root. */
  path?: string
  workspace: WorkspaceMode
  /** Which executor class has to run there; without one no machine can be filtered. */
  executorClass?: string
}

export type PlacementDenial = 'NO_MANDATE' | 'NO_HOST'

export interface PlacementChoice {
  realm: PlacementRealm
  host?: string
  workspace: WorkspaceMode
  scopePath: ScopePath
  /** The explicit mandate that allowed the landing, when a write was involved. */
  mandateId?: string
}

export type Placement = PlacementChoice | { denied: PlacementDenial }

/** What placement needs from the world model: the mandate decision, nothing else. */
export interface PlacementPorts {
  mandate(principal: string, scopePath: ScopePath, capability: Capability): MandateDecision
}

/**
 * Decides where the work lands. `NO_HOST` when the proposed machine is not a
 * candidate (not enrolled, lease expired, or it never declared this executor
 * class); `NO_MANDATE` when a new workspace was asked for at a path where the
 * principal only holds `draft`.
 */
export function decidePlacement(
  ports: PlacementPorts,
  read: LedgerReader,
  request: PlacementRequest,
  now: number,
): Placement {
  let host: string | undefined
  let scopePath: ScopePath

  if (request.realm === 'netbird') {
    if (request.executorClass === undefined || request.executorClass === '') return { denied: 'NO_HOST' }
    const candidates = filterHosts(
      read.all<WorldEntityRow>(`SELECT * FROM ${ENTITY}`),
      { tools: request.needsWrite ? 'full' : 'read', executorClass: request.executorClass },
      now,
    )
    const chosen = request.host === undefined
      ? candidates[0]
      : candidates.find((row) => row.canonical === request.host || row.entity_id === request.host)
    if (chosen === undefined) return { denied: 'NO_HOST' }
    host = chosen.canonical
    scopePath = normalizePath(request.path ?? chosen.path)
  } else {
    scopePath = normalizePath(request.path ?? (request.realm === 'local' ? 'local/' : 'external/'))
  }

  let mandateId: string | undefined
  if (request.workspace === 'new') {
    const decision = ports.mandate(request.principal, scopePath, 'write_repo')
    if (decision.strength !== 'allow') return { denied: 'NO_MANDATE' }
    mandateId = decision.mandateId
  } else if (request.needsWrite) {
    // Not a new workspace: no provision happens here, so the write gate belongs to
    // the caller. Attach the mandate when one explicitly allows the write, so the
    // caller can record it against the attempt.
    const decision = ports.mandate(request.principal, scopePath, 'write_repo')
    if (decision.strength === 'allow') mandateId = decision.mandateId
  }

  // `host` stays absent for realms that do not name a machine (local, external).
  if (host === undefined) {
    return mandateId === undefined
      ? { realm: request.realm, workspace: request.workspace, scopePath }
      : { realm: request.realm, workspace: request.workspace, scopePath, mandateId }
  }
  return mandateId === undefined
    ? { realm: request.realm, host, workspace: request.workspace, scopePath }
    : { realm: request.realm, host, workspace: request.workspace, scopePath, mandateId }
}