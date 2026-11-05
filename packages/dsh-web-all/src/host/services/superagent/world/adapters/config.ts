/**
 * Configuration adapter: the highest-trust registration path (04).
 *
 * A human writes `superagent.world.entities`, `superagent.world.mandates` and
 * `superagent.world.parties` in the settings namespace; this adapter parses that
 * text into the same shapes the registry takes and lands it through `register`
 * (straight to enrolled), `grantFromConfig` and `registerParty`. Owners and
 * colleagues exist only on this path (G6), and the identity key is `union_id`.
 *
 * Two rules keep it honest:
 *
 * 1. Parsing never guesses. A row missing `canonical`, `path`, `principal` or
 *    `grantedBy` is dropped and reported; a path that is not a legal scope path is
 *    dropped and reported by the registry. Nothing is stored "to be fixed later".
 * 2. Parsing is separate from applying, so the operator can see what a config
 *    file would do (`parseWorldConfig`) before it is written, and a bad file
 *    cannot half-apply: the caller runs `applyWorldConfig` inside one transaction.
 */

import type { LedgerTx } from '../../protocol/db.ts'
import { CAPABILITIES, STRENGTHS, parseEnum, type Capability, type Strength } from '../../protocol/objects.ts'
import type {
  AddrInput, AliasInput, ConfigMandate, EntityInput, Manifest, PartyInput, WorldRegistry,
} from '../registry.ts'

/** The three settings sections this adapter reads; each is a raw JSON value. */
export interface WorldConfigInput {
  entities?: unknown
  mandates?: unknown
  parties?: unknown
}

export interface ParsedWorldConfig {
  entities: EntityInput[]
  mandates: ConfigMandate[]
  parties: PartyInput[]
  /** One line per dropped row, with the section and index, for the operator. */
  problems: string[]
}

const ENTITY_KINDS = ['host', 'repo', 'org', 'session'] as const
const ENTITY_REALMS = ['local', 'netbird', 'external'] as const
const ALIAS_KINDS = ['ip', 'ssh', 'dns', 'spoken'] as const
const ADDR_KINDS = ['lan', 'wifi', 'netbird', 'dns'] as const
const PARTY_CLASSES = ['owner', 'colleague', 'member', 'external', 'executor', 'watched'] as const

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function isIpv4(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)
}

/** A bare configured name is classified by shape; the row keeps what it was given. */
function aliasKindOf(alias: string): AliasInput['kind'] {
  if (isIpv4(alias)) return 'ip'
  return alias.includes('.') ? 'dns' : 'spoken'
}

function parseAliases(value: unknown): AliasInput[] {
  const out: AliasInput[] = []
  for (const item of list(value)) {
    if (typeof item === 'string') {
      const alias = text(item)
      if (alias !== undefined) out.push({ alias, kind: aliasKindOf(alias) })
      continue
    }
    const row = record(item)
    const alias = text(row?.alias)
    if (alias === undefined) continue
    out.push({ alias, kind: parseEnum(ALIAS_KINDS, row?.kind) ?? aliasKindOf(alias) })
  }
  return out
}

function parseAddrs(value: unknown): AddrInput[] {
  const out: AddrInput[] = []
  for (const item of list(value)) {
    const row = record(item)
    const address = text(row?.address)
    const kind = parseEnum(ADDR_KINDS, row?.kind)
    if (address === undefined || kind === undefined) continue
    const priority = typeof row?.priority === 'number' ? row.priority : 0
    out.push({ kind, address, priority })
  }
  return out
}

function parseManifest(value: unknown): Manifest | null {
  const row = record(value)
  if (row === undefined) return null
  const executors = list(row.executors).filter((item): item is string => typeof item === 'string')
  const tools = row.tools === 'full' || row.tools === 'read' ? row.tools : undefined
  return tools === undefined ? { executors } : { executors, tools }
}

function parseEntity(value: unknown, index: number, problems: string[]): EntityInput | undefined {
  const row = record(value)
  const canonical = text(row?.canonical)
  const path = text(row?.path)
  const kind = parseEnum(ENTITY_KINDS, row?.kind)
  const realm = parseEnum(ENTITY_REALMS, row?.realm)
  if (row === undefined) {
    problems.push(`entities[${index}]: not an object`)
    return undefined
  }
  if (canonical === undefined) {
    problems.push(`entities[${index}]: missing canonical`)
    return undefined
  }
  if (path === undefined) {
    problems.push(`entities[${index}] (${canonical}): missing path`)
    return undefined
  }
  if (kind === undefined) {
    problems.push(`entities[${index}] (${canonical}): unknown kind`)
    return undefined
  }
  if (realm === undefined) {
    problems.push(`entities[${index}] (${canonical}): unknown realm`)
    return undefined
  }
  return {
    canonical,
    kind,
    realm,
    path,
    aliases: parseAliases(row.aliases),
    addrs: parseAddrs(row.addrs),
    manifest: parseManifest(row.manifest),
    lease_until: null,
  }
}

function parseMandate(value: unknown, index: number, problems: string[]): ConfigMandate | undefined {
  const row = record(value)
  const principal = text(row?.principal)
  const scopePath = text(row?.scopePath) ?? text(row?.scope_path)
  const grantedBy = text(row?.grantedBy) ?? text(row?.granted_by)
  const capability = parseEnum(CAPABILITIES, row?.capability)
  const strength = parseEnum(STRENGTHS, row?.strength)
  if (principal === undefined || scopePath === undefined) {
    problems.push(`mandates[${index}]: missing principal or scope path`)
    return undefined
  }
  if (capability === undefined || strength === undefined) {
    problems.push(`mandates[${index}] (${principal}): unknown capability or strength`)
    return undefined
  }
  if (grantedBy === undefined) {
    problems.push(`mandates[${index}] (${principal}): missing grantedBy; only a person can grant`)
    return undefined
  }
  return { principal, scopePath, capability, strength, grantedBy }
}

function parseParty(value: unknown, index: number, problems: string[]): PartyInput | undefined {
  const row = record(value)
  const partyId = text(row?.partyId) ?? text(row?.party_id)
  const partyClass = parseEnum(PARTY_CLASSES, row?.class)
  const unionId = text(row?.union_id) ?? text(row?.unionId)
  if (partyId === undefined) {
    problems.push(`parties[${index}]: missing party id`)
    return undefined
  }
  if (partyClass === undefined) {
    problems.push(`parties[${index}] (${partyId}): unknown class`)
    return undefined
  }
  if (unionId === undefined && (partyClass === 'owner' || partyClass === 'colleague')) {
    problems.push(`parties[${index}] (${partyId}): ${partyClass} needs a union_id identity key`)
    return undefined
  }
  return {
    party_id: partyId,
    union_id: unionId ?? null,
    open_id: text(row?.open_id) ?? text(row?.openId) ?? null,
    display: text(row?.display) ?? null,
    class: partyClass,
    source: 'config',
    kind: parseEnum(['person', 'executor', 'session'] as const, row?.kind) ?? 'person',
    manifest: parseManifest(row?.manifest),
  }
}

/** Turns the three config sections into registry inputs; every drop is explained. */
export function parseWorldConfig(input: WorldConfigInput): ParsedWorldConfig {
  const problems: string[] = []
  const entities: EntityInput[] = []
  const mandates: ConfigMandate[] = []
  const parties: PartyInput[] = []

  list(input.entities).forEach((value, index) => {
    const entity = parseEntity(value, index, problems)
    if (entity !== undefined) entities.push(entity)
  })
  list(input.mandates).forEach((value, index) => {
    const mandate = parseMandate(value, index, problems)
    if (mandate !== undefined) mandates.push(mandate)
  })
  list(input.parties).forEach((value, index) => {
    const party = parseParty(value, index, problems)
    if (party !== undefined) parties.push(party)
  })

  return { entities, mandates, parties, problems }
}

export interface ConfigApplyResult {
  entities: number
  mandates: number
  parties: number
}

/**
 * Lands a parsed configuration inside the caller's transaction: entities first
 * (mandates may name their paths), then parties, then mandates.
 */
export function applyWorldConfig(
  world: WorldRegistry,
  tx: LedgerTx,
  config: ParsedWorldConfig,
  policyVersion: number,
): ConfigApplyResult {
  let entities = 0
  let parties = 0
  for (const entity of config.entities) {
    world.register(tx, entity)
    entities += 1
  }
  for (const party of config.parties) {
    world.registerParty(tx, party)
    parties += 1
  }
  const mandates = world.grantFromConfig(tx, config.mandates, policyVersion)
  return { entities, mandates, parties }
}