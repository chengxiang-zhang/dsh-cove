/**
 * SSH configuration discovery: the lowest-trust registration path (04).
 *
 * `~/.dsh/dsh-ssh.json` holds one entry per *alias*, and several aliases are the
 * same machine (F27: 27 aliases for 25 hosts, because nothing ever asked for them
 * to be merged). This adapter is that merge: entries are grouped by their
 * `host`, and one group becomes one entity candidate carrying every alias the
 * group had plus the address.
 *
 * Three limits keep it inside the discovery trust level:
 *
 * 1. It only proposes. Every candidate is landed through `propose`, so a machine
 *    appearing in an ssh config can never widen our authority by itself; a human
 *    confirms the name (and the capability manifest, which an ssh file cannot
 *    describe) at enrolment.
 * 2. It never touches the network. No DNS lookup, no ssh handshake, no port test:
 *    the file is parsed and grouped, and that is all this adapter knows.
 * 3. The realm is a proposal. Every candidate is a machine, so it is proposed in
 *    the `netbird` realm as `netbird/<canonical>`, with the actual entry address in
 *    `sa_world_addr` (which is where 04 puts LAN/wifi/NetBird/DNS entries).
 *    Organisations are not machines and only ever arrive through configuration.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AddrInput, AddrKind, AliasInput, DiscoverySource, EntityInput, Manifest } from '../registry.ts'

/** Where the ssh-sync tool writes its host list. */
export const DEFAULT_SSH_CONFIG_PATH = join(homedir(), '.dsh', 'dsh-ssh.json')

/** One ssh alias. The file carries more (port, user, auth); none of it names an entity. */
export interface SshHostEntry {
  alias: string
  host: string
}

export interface SshParseResult {
  entries: SshHostEntry[]
  problems: string[]
}

/** One machine: several aliases that resolve to the same address. */
export interface SshHostGroup {
  host: string
  entries: SshHostEntry[]
}

/** NetBird hands out addresses in the carrier-grade NAT range 100.64.0.0/10. */
const NETBIRD_CGNAT = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./
/** Lower tries first: the private network beats a DNS name beats a raw LAN address. */
const PRIORITY: Readonly<Record<AddrKind, number>> = { netbird: 0, wifi: 1, dns: 2, lan: 3 }

function isIpv4(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Reads the `hosts` array of the ssh file (or a bare array). Entries without an
 * alias or a host are reported, never guessed.
 */
export function parseSshConfig(raw: unknown): SshParseResult {
  const problems: string[] = []
  const source = Array.isArray(raw) ? raw : asRecord(raw)?.hosts
  if (!Array.isArray(source)) return { entries: [], problems: ['ssh config: no hosts array'] }
  const entries: SshHostEntry[] = []
  source.forEach((item, index) => {
    const row = asRecord(item)
    const alias = typeof row?.alias === 'string' ? row.alias.trim() : ''
    const host = typeof row?.host === 'string' ? row.host.trim() : ''
    if (alias.length === 0 || host.length === 0) {
      problems.push(`ssh config hosts[${index}]: missing alias or host`)
      return
    }
    entries.push({ alias, host })
  })
  return { entries, problems }
}

/** Groups aliases by address, case-insensitively (DNS names are not case-sensitive). */
export function groupSshEntries(entries: readonly SshHostEntry[]): SshHostGroup[] {
  const groups = new Map<string, SshHostGroup>()
  for (const entry of entries) {
    const key = entry.host.toLowerCase()
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { host: entry.host, entries: [entry] })
    else group.entries.push(entry)
  }
  return [...groups.values()]
}

/**
 * The name a machine is filed under: a human-readable alias beats a literal
 * address, the shortest alias next, then lexical order so the choice is stable.
 */
function canonicalOf(group: SshHostGroup): string {
  const ranked = [...group.entries].sort((left, right) => {
    const byLiteral = Number(isIpv4(left.alias)) - Number(isIpv4(right.alias))
    if (byLiteral !== 0) return byLiteral
    if (left.alias.length !== right.alias.length) return left.alias.length - right.alias.length
    return left.alias < right.alias ? -1 : left.alias > right.alias ? 1 : 0
  })
  return ranked[0].alias
}

/** Entry address to the four kinds of 04 by shape; a literal address is a LAN entry. */
function addrKindOf(host: string): AddrKind {
  if (NETBIRD_CGNAT.test(host) || /\.netbird\.selfhosted$/i.test(host)) return 'netbird'
  if (isIpv4(host)) return 'lan'
  return 'dns'
}

function aliasesOf(group: SshHostGroup): AliasInput[] {
  const out: AliasInput[] = []
  const seen = new Set<string>()
  for (const entry of group.entries) {
    if (seen.has(entry.alias)) continue
    seen.add(entry.alias)
    out.push({ alias: entry.alias, kind: 'ssh' })
  }
  // 04 lists DNS names and IPs as aliases too, so the address itself can be said.
  if (!seen.has(group.host)) out.push({ alias: group.host, kind: isIpv4(group.host) ? 'ip' : 'dns' })
  return out
}

function addrsOf(group: SshHostGroup): AddrInput[] {
  const kind = addrKindOf(group.host)
  return [{ kind, address: group.host, priority: PRIORITY[kind] }]
}

/**
 * Turns ssh entries into entity candidates: one per address, aliases merged, the
 * address recorded. The manifest is empty on purpose: an ssh file says how to
 * connect, not what the machine can run, so the human fills that in at enrolment.
 */
export function sshEntityCandidates(entries: readonly SshHostEntry[]): { entity: EntityInput; manifest: Manifest }[] {
  return groupSshEntries(entries).map((group) => {
    const canonical = canonicalOf(group)
    return {
      entity: {
        canonical,
        kind: 'host',
        realm: 'netbird',
        path: `netbird/${canonical}`,
        aliases: aliasesOf(group),
        addrs: addrsOf(group),
        lease_until: null,
      },
      manifest: { executors: [] },
    }
  })
}

function readSshConfigFile(path: string): SshHostEntry[] {
  if (!existsSync(path)) throw new Error(`ssh config not found: ${path}`)
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const result = parseSshConfig(parsed)
  if (result.entries.length === 0) throw new Error(`ssh config has no usable entries: ${path}`)
  return result.entries
}

export interface SshConfigSourceOptions {
  /** Inline entries, for tests and for a host list that arrived another way. */
  entries?: readonly SshHostEntry[]
  /** File to read instead of the default location. */
  path?: string
}

/** The discovery source. Reading the file happens inside `discover`, so a missing file is a degrade event, not a crash at wiring time. */
export function createSshConfigSource(options: SshConfigSourceOptions = {}): DiscoverySource {
  return {
    name: 'ssh-config',
    async discover(): Promise<{ entity: EntityInput; manifest: Manifest }[]> {
      const entries = options.entries ?? readSshConfigFile(options.path ?? DEFAULT_SSH_CONFIG_PATH)
      return sshEntityCandidates(entries)
    },
  }
}