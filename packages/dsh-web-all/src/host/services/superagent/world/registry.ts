/**
 * World registry: the stored half of the world model (T15).
 *
 * `04` gives three registration paths and three trust levels, and the whole file
 * is built around not confusing them:
 *
 *   config   a human wrote it         highest  -> `register`: straight to enrolled
 *   enroll   a machine self-enrols    medium   -> one-time token, human-minted name
 *   discover a scan saw a peer        lowest   -> `propose`: proposed, never enrolled
 *
 * The last line is the security boundary, not a convenience: if discovery could
 * enrol, whoever attaches a machine to the network would widen our authority. So
 * `propose` writes `state='proposed'` unconditionally, a proposed row never takes
 * part in `resolve` or `mandate`, and the protocol DDL refuses a `discover` row
 * that claims to be enrolled as a backstop.
 *
 * Writes never open a transaction here: every mutating method takes the
 * `LedgerTx` the kernel opened (P1), and the world module may only write the six
 * tables `TABLE_OWNERS` gives it. `degrade_event` belongs to recovery, so an
 * adapter failure is reported through `WorldReport.degrade` and the composition
 * root writes the row.
 *
 * Decisions are not re-implemented: `decideMandate`, `resolveMention`,
 * `filterHosts` and `decidePlacement` are the pure T05 functions, and this file
 * only feeds them rows and writes what they concluded.
 */

import { randomUUID } from 'node:crypto'
import { PHYSICAL, type LedgerReader, type LedgerTx } from '../protocol/db.ts'
import {
  CAPABILITIES, STRENGTHS, parseEnum,
  type Capability, type EntitySource, type EntityState, type MandateRow, type PartyRow, type Strength,
  type WorldAddrRow, type WorldAliasRow, type WorldEntityRow,
} from '../protocol/objects.ts'
import type { DefaultTable, PartyClass } from './defaults.ts'
import { decideMandate, type MandateDecision } from './mandate.ts'
import { normalizePath, isPrefix, parsePath, type ScopePath } from './paths.ts'
import { resolveMention, type ResolveResult } from './resolve.ts'
import { decidePlacement, type Placement, type PlacementRequest } from './place.ts'

const ENTITY = PHYSICAL.world_entity
const ALIAS = PHYSICAL.world_alias
const ADDR = PHYSICAL.world_addr
const MANDATE = PHYSICAL.mandate
const WORKSPACE = PHYSICAL.workspace
const PARTY = PHYSICAL.party

/** Thirty days after the lease expires a machine is `gone`, not merely `stale` (04). */
const GONE_AFTER_MS = 30 * 24 * 3_600_000
/** Default lease for a machine that enrolled without naming one: a day. */
const DEFAULT_LEASE_MS = 24 * 3_600_000

export type AliasKind = WorldAliasRow['kind']
export type AddrKind = WorldAddrRow['kind']

/** What a host says about itself: which executor classes it can carry, and how much of it. */
export interface Manifest {
  executors: readonly string[]
  tools?: 'read' | 'full'
  [key: string]: unknown
}

export interface AliasInput {
  alias: string
  kind: AliasKind
}

export interface AddrInput {
  kind: AddrKind
  address: string
  priority?: number
}

/** One entity as a caller describes it; aliases and addresses are part of the registration. */
export interface EntityInput {
  canonical: string
  kind: WorldEntityRow['kind']
  realm: WorldEntityRow['realm']
  path: string
  aliases?: readonly AliasInput[]
  addrs?: readonly AddrInput[]
  manifest?: Manifest | null
  /** Absent means the registry's default lease; `null` means configuration (no lease). */
  lease_until?: number | null
}

export interface PartyInput {
  party_id: string
  union_id?: string | null
  open_id?: string | null
  display?: string | null
  class: PartyRow['class']
  source: PartyRow['source']
  kind?: PartyRow['kind']
  manifest?: Manifest | null
}

/** A mandate row as the configuration channel writes it (04: only people grant). */
export interface ConfigMandate {
  principal: string
  scopePath: string
  capability: Capability
  strength: Strength
  grantedBy: string
}

export interface DiscoveryCandidate {
  source: string
  entity: EntityInput
  manifest: Manifest
}

/** A discovery source; spec T-05. Adapters implement this and can only produce candidates. */
export interface DiscoverySource {
  name: string
  discover(now: number): Promise<{ entity: EntityInput; manifest: Manifest }[]>
}

export interface DiscoveryGather {
  candidates: DiscoveryCandidate[]
  failed: string[]
}

export interface WorkspaceInput {
  path: string
  entity_id: string
  commitment_id: string
  mandate_id: string
  branch?: string
}

export type WorldErrorCode = 'TOKEN_INVALID' | 'ENTITY_MISSING' | 'PARTY_CLASS_REQUIRES_CONFIG'
  | 'MANDATE_MISSING' | 'MANDATE_NOT_LIVE' | 'MANDATE_ID_EXHAUSTED'

export class WorldError extends Error {
  readonly code: WorldErrorCode

  constructor(code: WorldErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'WorldError'
    this.code = code
  }
}

/**
 * Where a module that does not own `degrade_event` puts its degradation. `warn`
 * is for a rejected configuration row, `degrade` for a whole source that failed.
 */
export interface WorldReport {
  warn(message: string): void
  degrade(entry: { reason: string; scope: string; now: number }): void
}

export interface WorldDeps {
  read: LedgerReader
  /**
   * Structural clock: only `now()` is used, and a `HostClock` satisfies it. The
   * world module may not import host-ports (dependency table), so the narrow
   * shape is what the type says.
   */
  clock: { now(): number }
  defaults: DefaultTable
  /** Optional: without it a rejected row is still skipped, just not narrated. */
  report?: WorldReport
}

export interface WorldRegistry {
  resolve(mention: string, principal: string): ResolveResult
  mandate(principal: string, scopePath: ScopePath, capability: Capability): MandateDecision
  /** Human-minted one-time token; the person who mints it also names the machine. */
  issueToken(): string
  enroll(tx: LedgerTx, entity: EntityInput, token: string): WorldEntityRow
  /** Discovery only: the row is always `proposed`. */
  propose(tx: LedgerTx, entity: EntityInput, manifest: Manifest): WorldEntityRow
  /** Configuration only: a human wrote it, so it is `enrolled` straight away. */
  register(tx: LedgerTx, entity: EntityInput, manifest?: Manifest): WorldEntityRow
  registerParty(tx: LedgerTx, party: PartyInput): PartyRow
  place(request: PlacementRequest): Placement
  revoke(tx: LedgerTx, entityId: string, by: string): void
  /** Revocation of a mandate is a `revoked_at` stamp; the row stays (04: immutable record). */
  revokeMandate(tx: LedgerTx, mandateId: string, by: string): void
  /** Returns how many rows were written; invalid rows are rejected and reported, never stored. */
  grantFromConfig(tx: LedgerTx, rows: readonly ConfigMandate[], policyVersion: number): number
  sweepLeases(tx: LedgerTx, now: number): { stale: number; gone: number }
  registerWorkspace(tx: LedgerTx, workspace: WorkspaceInput): void
  removeWorkspace(tx: LedgerTx, path: string, now: number): void
  /** Waits on every source, collecting candidates; failures are reported, not thrown. */
  gatherDiscovery(sources: readonly DiscoverySource[], now: number): Promise<DiscoveryGather>
  /** Lands candidates through `propose` only; an already-enrolled entity is never touched. */
  landDiscovery(tx: LedgerTx, candidates: readonly DiscoveryCandidate[]): { proposed: number; skipped: number }
}

/**
 * The party class a mandate question is answered with. `02` has six party classes
 * but `04`'s default table has four; an executor or watched session never asks for
 * a mandate, and mapping anything unknown to `external` keeps the answer a denial.
 */
function partyClassOf(party: PartyRow | undefined): PartyClass {
  if (party === undefined) return 'external'
  if (party.class === 'owner' || party.class === 'colleague' || party.class === 'member') return party.class
  return 'external'
}

function entityIdOf(canonical: string): string {
  return `E:${canonical}`
}

function manifestJson(manifest: Manifest | null | undefined): string | null {
  return manifest === null || manifest === undefined ? null : JSON.stringify(manifest)
}

export function createWorldRegistry(deps: WorldDeps): WorldRegistry {
  const { read, defaults } = deps
  const tokens = new Map<string, { used: boolean }>()
  const now = (): number => deps.clock.now()

  const warn = (message: string): void => deps.report?.warn(message)

  function findEntity(tx: LedgerTx, path: string, canonical: string): WorldEntityRow | undefined {
    return tx.get<WorldEntityRow>(
      `SELECT * FROM ${ENTITY} WHERE path = ? OR canonical = ? ORDER BY rowid LIMIT 1`, path, canonical)
  }

  function writeAliases(tx: LedgerTx, entityId: string, aliases: readonly AliasInput[] | undefined, authoritative: boolean, at: number): void {
    for (const alias of aliases ?? []) {
      if (alias.alias.length === 0) continue
      // Only the configuration channel may move an alias from one entity to
      // another; a scan must never steal a name a human already confirmed.
      const verb = authoritative ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE'
      tx.run(`${verb} INTO ${ALIAS} (alias, entity_id, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        alias.alias, entityId, alias.kind, at, at)
    }
  }

  function writeAddrs(tx: LedgerTx, entityId: string, addrs: readonly AddrInput[] | undefined, authoritative: boolean, at: number): void {
    for (const addr of addrs ?? []) {
      const addrId = `A:${entityId}:${addr.kind}:${addr.address}`
      const verb = authoritative ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE'
      tx.run(`${verb} INTO ${ADDR} (addr_id, entity_id, kind, address, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        addrId, entityId, addr.kind, addr.address, addr.priority ?? 0, at, at)
    }
  }

  function writeEntity(
    tx: LedgerTx,
    input: EntityInput,
    path: { source: EntitySource; state: EntityState; leaseUntil: number | null; authoritative: boolean },
    at: number,
  ): WorldEntityRow {
    const scopePath = normalizePath(input.path)
    const manifest = manifestJson(input.manifest)
    const existing = findEntity(tx, scopePath, input.canonical)

    // Discovery may only touch the rows discovery created, and it may never
    // resurrect a revoked one: a human rejecting a peer is final for that path.
    // Anything a person confirmed - enrolled, or a stale row that is still theirs -
    // is left exactly as it is.
    if (existing !== undefined && !path.authoritative
      && (existing.source !== 'discover' || existing.state === 'revoked')) return existing

    let entityId: string
    if (existing === undefined) {
      entityId = entityIdOf(input.canonical)
      tx.run(`INSERT INTO ${ENTITY} (entity_id, canonical, kind, realm, path, state, source, lease_until, manifest_json, revoked_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        entityId, input.canonical, input.kind, input.realm, scopePath, path.state, path.source, path.leaseUntil, manifest, at, at)
    } else {
      entityId = existing.entity_id
      tx.run(`UPDATE ${ENTITY} SET canonical = ?, kind = ?, realm = ?, path = ?, state = ?, source = ?, lease_until = ?, manifest_json = ?, updated_at = ?
        WHERE entity_id = ?`,
        input.canonical, input.kind, input.realm, scopePath, path.state, path.source, path.leaseUntil, manifest, at, entityId)
    }

    writeAliases(tx, entityId, input.aliases, path.authoritative, at)
    writeAddrs(tx, entityId, input.addrs, path.authoritative, at)

    const row = tx.get<WorldEntityRow>(`SELECT * FROM ${ENTITY} WHERE entity_id = ?`, entityId)
    if (row === undefined) throw new WorldError('ENTITY_MISSING', `entity ${entityId} vanished after write`)
    return row
  }

  function nextMandateId(tx: LedgerTx, base: string): string {
    for (let suffix = 1; suffix <= 1000; suffix += 1) {
      const id = suffix === 1 ? base : `${base}#${suffix}`
      if (tx.get(`SELECT 1 FROM ${MANDATE} WHERE mandate_id = ?`, id) === undefined) return id
    }
    throw new WorldError('MANDATE_ID_EXHAUSTED', `mandate id ${base}`)
  }

  /** One configuration row: skip what is already granted, revoke what changed, then append. */
  function grantOne(
    tx: LedgerTx,
    principal: string,
    scopePath: ScopePath,
    capability: Capability,
    strength: Strength,
    grantedBy: string,
    policyVersion: number,
    at: number,
  ): boolean {
    const live = tx.get<MandateRow>(
      `SELECT * FROM ${MANDATE} WHERE principal = ? AND scope_path = ? AND capability = ? AND revoked_at IS NULL`,
      principal, scopePath, capability)
    if (live !== undefined) {
      if (live.strength === strength && live.granted_by === grantedBy) return false
      // Immutability: a changed grant is a new row, and the old one is stamped out.
      tx.run(`UPDATE ${MANDATE} SET revoked_at = ?, revoked_by = ?, updated_at = ? WHERE mandate_id = ?`,
        at, grantedBy, at, live.mandate_id)
    }
    const id = nextMandateId(tx, `M:${principal}:${capability}:${scopePath}`)
    tx.run(`INSERT INTO ${MANDATE} (mandate_id, principal, scope_path, capability, strength, policy_version, granted_by, granted_at, revoked_at, revoked_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      id, principal, scopePath, capability, strength, policyVersion, grantedBy, at, at, at)
    return true
  }

  function mandate(principal: string, scopePath: ScopePath, capability: Capability): MandateDecision {
    const rows = read.all<MandateRow>(
      `SELECT * FROM ${MANDATE} WHERE principal = ? AND capability = ? AND revoked_at IS NULL`, principal, capability)
    const party = read.get<PartyRow>(`SELECT * FROM ${PARTY} WHERE party_id = ?`, principal)
    return decideMandate(rows, { principal, scopePath, capability }, defaults, partyClassOf(party))
  }

  const registry: WorldRegistry = {
    resolve(mention: string, principal: string): ResolveResult {
      const entities = read.all<WorldEntityRow>(`SELECT * FROM ${ENTITY}`)
      const aliases = read.all<{ alias: string; entity_id: string }>(`SELECT alias, entity_id FROM ${ALIAS}`)
      // A denied path is not an authorized place to act, so it does not silence
      // the question; an allow or a draft both mean "this is one of our places".
      const rows = read.all<MandateRow>(
        `SELECT * FROM ${MANDATE} WHERE principal = ? AND revoked_at IS NULL AND strength <> 'deny'`, principal)
      const authorizedPaths: ScopePath[] = []
      for (const row of rows) {
        try {
          authorizedPaths.push(normalizePath(row.scope_path))
        } catch {
          // An unusable row cannot authorize anything; it is ignored, not fatal.
        }
      }
      return resolveMention({ mention, entities, aliases, authorizedPaths })
    },

    mandate,

    issueToken(): string {
      const token = `T:${randomUUID()}`
      tokens.set(token, { used: false })
      return token
    },

    enroll(tx: LedgerTx, entity: EntityInput, token: string): WorldEntityRow {
      const record = tokens.get(token)
      if (record === undefined || record.used) throw new WorldError('TOKEN_INVALID', 'enrolment token unknown or already used')
      record.used = true
      const at = tx.now
      return writeEntity(tx, entity, {
        source: 'enroll',
        state: 'enrolled',
        leaseUntil: entity.lease_until === undefined ? at + DEFAULT_LEASE_MS : entity.lease_until,
        authoritative: true,
      }, at)
    },

    propose(tx: LedgerTx, entity: EntityInput, manifest: Manifest): WorldEntityRow {
      const at = tx.now
      return writeEntity(tx, { ...entity, manifest: manifest }, {
        source: 'discover',
        state: 'proposed',
        leaseUntil: entity.lease_until ?? null,
        authoritative: false,
      }, at)
    },

    register(tx: LedgerTx, entity: EntityInput, manifest?: Manifest): WorldEntityRow {
      const at = tx.now
      return writeEntity(tx, manifest === undefined ? entity : { ...entity, manifest }, {
        source: 'config',
        state: 'enrolled',
        leaseUntil: entity.lease_until ?? null,
        authoritative: true,
      }, at)
    },

    registerParty(tx: LedgerTx, party: PartyInput): PartyRow {
      // G6: owner and colleague rows only ever come from configuration. The DDL
      // repeats this; catching it here produces a named error instead of ABORT.
      if ((party.class === 'owner' || party.class === 'colleague') && party.source !== 'config') {
        throw new WorldError('PARTY_CLASS_REQUIRES_CONFIG', `${party.class} rows must come from configuration, not ${party.source}`)
      }
      const at = tx.now
      const row = {
        kind: party.kind ?? 'person',
        union_id: party.union_id ?? null,
        open_id: party.open_id ?? null,
        display: party.display ?? null,
        class: party.class,
        source: party.source,
        manifest_json: manifestJson(party.manifest),
      }
      const existing = tx.get<PartyRow>(`SELECT * FROM ${PARTY} WHERE party_id = ?`, party.party_id)
      if (existing === undefined) {
        tx.run(`INSERT INTO ${PARTY} (party_id, kind, union_id, open_id, display, class, source, manifest_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          party.party_id, row.kind, row.union_id, row.open_id, row.display, row.class, row.source, row.manifest_json, at, at)
      } else {
        tx.run(`UPDATE ${PARTY} SET kind = ?, union_id = ?, open_id = ?, display = ?, class = ?, source = ?, manifest_json = ?, updated_at = ?
          WHERE party_id = ?`,
          row.kind, row.union_id, row.open_id, row.display, row.class, row.source, row.manifest_json, at, party.party_id)
      }
      const written = tx.get<PartyRow>(`SELECT * FROM ${PARTY} WHERE party_id = ?`, party.party_id)
      if (written === undefined) throw new WorldError('ENTITY_MISSING', `party ${party.party_id} vanished after write`)
      return written
    },

    place(request: PlacementRequest): Placement {
      return decidePlacement({ mandate }, read, request, now())
    },

    revoke(tx: LedgerTx, entityId: string, by: string): void {
      const existing = tx.get<WorldEntityRow>(`SELECT * FROM ${ENTITY} WHERE entity_id = ?`, entityId)
      if (existing === undefined) throw new WorldError('ENTITY_MISSING', `entity ${entityId}`)
      tx.run(`UPDATE ${ENTITY} SET state = 'revoked', revoked_by = ?, updated_at = ? WHERE entity_id = ?`,
        by, tx.now, entityId)
    },

    revokeMandate(tx: LedgerTx, mandateId: string, by: string): void {
      const existing = tx.get<MandateRow>(`SELECT * FROM ${MANDATE} WHERE mandate_id = ?`, mandateId)
      if (existing === undefined) throw new WorldError('MANDATE_MISSING', `mandate ${mandateId}`)
      // The stamp is final: a second revoke is a no-op, never a rewrite.
      if (existing.revoked_at !== null) return
      tx.run(`UPDATE ${MANDATE} SET revoked_at = ?, revoked_by = ?, updated_at = ? WHERE mandate_id = ?`,
        tx.now, by, tx.now, mandateId)
    },

    grantFromConfig(tx: LedgerTx, rows: readonly ConfigMandate[], policyVersion: number): number {
      const at = tx.now
      // 04's failure table: a mandate that points at a path no entity registered is
      // rejected with a warning rather than stored. Reads see the entities the
      // adapter registered earlier in this same transaction.
      const registeredPaths: ScopePath[] = []
      for (const row of read.all<{ path: string }>(`SELECT path FROM ${ENTITY}`)) {
        try {
          registeredPaths.push(normalizePath(row.path))
        } catch {
          // An unreadable entity path authorizes nothing.
        }
      }
      const covers = (scopePath: ScopePath): boolean => {
        if (parsePath(scopePath).rest.length === 0) return true
        return registeredPaths.some((path) => path === scopePath || isPrefix(scopePath, path) || isPrefix(path, scopePath))
      }

      let written = 0
      for (const row of rows) {
        if (row.grantedBy.trim().length === 0 || row.grantedBy === 'superagent') {
          warn(`mandate rejected: granted_by must be a person, got ${JSON.stringify(row.grantedBy)} for ${row.principal}`)
          continue
        }
        if (row.principal.trim().length === 0) {
          warn('mandate rejected: empty principal')
          continue
        }
        const capability = parseEnum(CAPABILITIES, row.capability)
        const strength = parseEnum(STRENGTHS, row.strength)
        if (capability === undefined || strength === undefined) {
          warn(`mandate rejected: unknown capability or strength ${JSON.stringify([row.capability, row.strength])}`)
          continue
        }
        let scopePath: ScopePath
        try {
          scopePath = normalizePath(row.scopePath)
        } catch (error) {
          warn(`mandate rejected: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        if (!covers(scopePath)) {
          warn(`mandate rejected: no registered entity covers ${scopePath}`)
          continue
        }
        if (grantOne(tx, row.principal, scopePath, capability, strength, row.grantedBy, policyVersion, at)) written += 1
      }
      return written
    },

    sweepLeases(tx: LedgerTx, at: number): { stale: number; gone: number } {
      // `gone` first: a machine that has been quiet for 31 days is gone, not stale,
      // so the two counts never overlap.
      const gone = tx.run(`UPDATE ${ENTITY} SET state = 'gone', updated_at = ?
        WHERE lease_until IS NOT NULL AND lease_until < ? AND state IN ('enrolled', 'stale')`,
      at, at - GONE_AFTER_MS).changes
      const stale = tx.run(`UPDATE ${ENTITY} SET state = 'stale', updated_at = ?
        WHERE lease_until IS NOT NULL AND lease_until < ? AND state = 'enrolled'`,
      at, at).changes
      return { stale, gone }
    },

    registerWorkspace(tx: LedgerTx, workspace: WorkspaceInput): void {
      const path = normalizePath(workspace.path)
      const mandateRow = tx.get<MandateRow>(
        `SELECT * FROM ${MANDATE} WHERE mandate_id = ? AND revoked_at IS NULL`, workspace.mandate_id)
      if (mandateRow === undefined) throw new WorldError('MANDATE_NOT_LIVE', `mandate ${workspace.mandate_id}`)
      // 04's reading is exact: a workspace with no mandate on that same path is an
      // unowned directory, so the mandate has to name this path.
      if (normalizePath(mandateRow.scope_path) !== path) {
        throw new WorldError('MANDATE_NOT_LIVE', `mandate ${workspace.mandate_id} is not for ${path}`)
      }
      const at = tx.now
      tx.run(`INSERT INTO ${WORKSPACE} (path, entity_id, commitment_id, mandate_id, branch, removed_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(path) DO UPDATE SET entity_id = excluded.entity_id, commitment_id = excluded.commitment_id,
          mandate_id = excluded.mandate_id, branch = excluded.branch, removed_at = NULL, updated_at = excluded.updated_at`,
        path, workspace.entity_id, workspace.commitment_id, workspace.mandate_id, workspace.branch ?? null, at, at)
    },

    removeWorkspace(tx: LedgerTx, path: string, at: number): void {
      // Never a delete: the directory existed, and the row is the record of that.
      tx.run(`UPDATE ${WORKSPACE} SET removed_at = ?, updated_at = ? WHERE path = ? AND removed_at IS NULL`,
        at, at, normalizePath(path))
    },

    async gatherDiscovery(sources: readonly DiscoverySource[], at: number): Promise<DiscoveryGather> {
      const candidates: DiscoveryCandidate[] = []
      const failed: string[] = []
      for (const source of sources) {
        try {
          const found = await source.discover(at)
          for (const item of found) candidates.push({ source: source.name, entity: item.entity, manifest: item.manifest })
        } catch {
          // One broken source must not stop the others (04 failure table).
          failed.push(source.name)
          deps.report?.degrade({ reason: 'world_adapter_failed', scope: source.name, now: at })
        }
      }
      return { candidates, failed }
    },

    landDiscovery(tx: LedgerTx, candidates: readonly DiscoveryCandidate[]): { proposed: number; skipped: number } {
      let proposed = 0
      let skipped = 0
      for (const candidate of candidates) {
        let scopePath: ScopePath
        try {
          scopePath = normalizePath(candidate.entity.path)
        } catch (error) {
          warn(`discovery candidate dropped: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        const existing = findEntity(tx, scopePath, candidate.entity.canonical)
        // Same rule as `propose`: a row a person owns, or one they revoked, is
        // reported as skipped rather than rewritten.
        if (existing !== undefined && (existing.source !== 'discover' || existing.state === 'revoked')) {
          skipped += 1
          continue
        }
        registry.propose(tx, candidate.entity, candidate.manifest)
        proposed += 1
      }
      return { proposed, skipped }
    },
  }

  return registry
}