/**
 * World registry, placement and adapters (T15).
 *
 * The ten cases follow the T-05 spec's list. Three of them exist to hold the
 * trust boundary in place rather than to test a happy path: discovery enters as
 * `proposed` and cannot be promoted (1, 2, 3), a mandate is revoked by stamping
 * it and the default table answers again (6), and a configuration row only a
 * person may write is rejected instead of stored (5, 10).
 *
 * Fixtures are in-memory rows over the real DDL (`FX/memdb.ts`), because the
 * interesting failures live in the table CHECKs and triggers, not in the code.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_TABLE } from '../src/host/services/superagent/world/defaults.ts'
import {
  WorldError,
  createWorldRegistry,
  type DiscoverySource,
  type EntityInput,
  type Manifest,
  type WorldRegistry,
  type WorldReport,
} from '../src/host/services/superagent/world/registry.ts'
import { createSshConfigSource } from '../src/host/services/superagent/world/adapters/ssh-config.ts'
import { applyWorldConfig, parseWorldConfig } from '../src/host/services/superagent/world/adapters/config.ts'
import { filterHosts } from '../src/host/services/superagent/world/resolve.ts'
import type { WorldEntityRow } from '../src/host/services/superagent/protocol/objects.ts'
import type { KernelTx } from '../src/host/services/superagent/kernel/ledger.ts'
import { createManualClock } from './fixtures/superagent/manual-clock.ts'
import { openTestLedger, type TestLedger } from './fixtures/superagent/ledger.ts'

const T0 = 1_762_300_000_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

function registryFor(t: TestLedger, report?: WorldReport): WorldRegistry {
  return createWorldRegistry({ read: t.ledger.read, clock: t.clock, defaults: DEFAULT_TABLE, report })
}

/** Every write goes through the kernel's transaction, tagged as the world module (P1). */
function write<T>(t: TestLedger, fn: (tx: KernelTx) => T): T {
  return t.ledger.open(fn, { module: 'world' })
}

function host(over: Partial<EntityInput> & Pick<EntityInput, 'canonical' | 'path'>): EntityInput {
  return { kind: 'host', realm: 'netbird', manifest: { executors: ['claude'] }, ...over }
}

function owner(t: TestLedger, world: WorldRegistry, party = 'p1'): void {
  write(t, tx => world.registerParty(tx, { party_id: party, union_id: `on_${party}`, class: 'owner', source: 'config' }))
}

function rows<T>(t: TestLedger, sql: string): T[] {
  return t.db.prepare(sql).all() as T[]
}

function count(t: TestLedger, sql: string): number {
  const row = t.db.prepare(sql).get() as { n?: unknown } | undefined
  return Number(row?.n ?? -1)
}

const SSH_ENTRIES = [
  { alias: 'dev', host: '192.168.200.2' },
  { alias: 'dev-lan', host: '192.168.200.2' },
  { alias: 'dev-wifi', host: '192.168.200.2' },
  { alias: 'dev-ssh', host: '192.168.200.2' },
]

describe('superagent world registry', () => {
  it('1. the ssh-config adapter merges four aliases into one proposed entity', async () => {
    const t = openTestLedger(createManualClock(T0))
    const world = registryFor(t)

    const gathered = await world.gatherDiscovery([createSshConfigSource({ entries: SSH_ENTRIES })], T0)
    expect(gathered.failed).toEqual([])
    expect(gathered.candidates).toHaveLength(1)
    expect(write(t, tx => world.landDiscovery(tx, gathered.candidates))).toEqual({ proposed: 1, skipped: 0 })

    const entity = rows<WorldEntityRow>(t, 'SELECT * FROM sa_world_entity')[0]
    expect(entity.canonical).toBe('dev')
    expect(entity.kind).toBe('host')
    expect(entity.path).toBe('netbird/dev')
    expect(entity.state).toBe('proposed')
    expect(entity.source).toBe('discover')

    // Four aliases, one machine, one address entry (F27: the entries were flat).
    expect(rows<{ alias: string }>(t, `SELECT alias FROM sa_world_alias WHERE kind = 'ssh' ORDER BY alias`).map((row) => row.alias))
      .toEqual(['dev', 'dev-lan', 'dev-ssh', 'dev-wifi'])
    expect(count(t, 'SELECT count(*) AS n FROM sa_world_addr')).toBe(1)
    // The reading 04 asks for: nothing discovered is enrolled.
    expect(count(t, `SELECT count(*) AS n FROM sa_world_entity WHERE state = 'enrolled' AND source = 'discover'`)).toBe(0)
  })

  it('2. a proposed entity is invisible to resolve and cannot be placed on', async () => {
    const t = openTestLedger(createManualClock(T0))
    const world = registryFor(t)
    owner(t, world)
    const gathered = await world.gatherDiscovery([createSshConfigSource({ entries: SSH_ENTRIES })], T0)
    write(t, tx => world.landDiscovery(tx, gathered.candidates))

    // Seen on the network is not the same as known by name.
    expect(world.resolve('dev', 'p1')).toMatchObject({ ask: 'unregistered', candidates: [] })
    // And a proposal grants nothing: the default table answers, which is `draft` for
    // an owner write - never `allow` from a machine that merely showed up.
    expect(world.mandate('p1', 'netbird/dev', 'write_repo')).toEqual({ strength: 'draft', source: 'default' })
    // Placement onto it fails for the same reason: it is not an enrolled host.
    expect(world.place({
      what: 'read the repo', check_kind: 'command', principal: 'p1', needsWrite: false,
      realm: 'netbird', host: 'dev', executorClass: 'claude', workspace: 'reuse',
    })).toEqual({ denied: 'NO_HOST' })
  })

  it('3. the protocol refuses a discovered entity that claims to be enrolled', async () => {
    const t = openTestLedger(createManualClock(T0))
    const world = registryFor(t)
    const gathered = await world.gatherDiscovery([createSshConfigSource({ entries: SSH_ENTRIES })], T0)
    write(t, tx => world.landDiscovery(tx, gathered.candidates))
    const entityId = rows<WorldEntityRow>(t, 'SELECT * FROM sa_world_entity')[0].entity_id

    // Promotion is a human act with an enrolment token, not an UPDATE.
    expect(() => write(t, tx => tx.run(`UPDATE sa_world_entity SET state = 'enrolled' WHERE entity_id = ?`, entityId))).toThrow()
    expect(rows<WorldEntityRow>(t, 'SELECT * FROM sa_world_entity')[0].state).toBe('proposed')
  })

  it('4. enrol needs a human-minted token and the token works once', () => {
    const t = openTestLedger(createManualClock(T0))
    const world = registryFor(t)

    const token = world.issueToken()
    const row = write(t, tx => world.enroll(tx, host({ canonical: 'pc-tower', path: 'netbird/pc-tower' }), token))
    expect(row.state).toBe('enrolled')
    expect(row.source).toBe('enroll')
    expect(row.lease_until).toBe(T0 + DAY)

    const reused = (): void => {
      write(t, tx => world.enroll(tx, host({ canonical: 'pc-tower', path: 'netbird/pc-tower' }), token))
    }
    expect(reused).toThrowError(WorldError)
    expect(reused).toThrow(/TOKEN_INVALID/)

    const unknown = (): void => {
      write(t, tx => world.enroll(tx, host({ canonical: 'other', path: 'netbird/other' }), 'T:not-a-token'))
    }
    expect(unknown).toThrow(/TOKEN_INVALID/)
    expect(count(t, 'SELECT count(*) AS n FROM sa_world_entity')).toBe(1)
  })

  it('5. config grants are personal, and rows a person may not write are rejected', () => {
    const t = openTestLedger(createManualClock(T0))
    const warnings: string[] = []
    const world = registryFor(t, { warn: (message) => warnings.push(message), degrade: () => undefined })
    write(t, tx => world.register(tx, host({ canonical: 'pc-tower', path: 'netbird/pc-tower' })))

    expect(write(t, tx => world.grantFromConfig(tx, [
      { principal: 'p1', scopePath: 'netbird/pc-tower/~/code/x', capability: 'write_repo', strength: 'allow', grantedBy: '老板' },
    ], 3))).toBe(1)
    const row = rows<{ granted_by: string; policy_version: number; scope_path: string }>(t, 'SELECT * FROM sa_mandate')[0]
    expect(row.granted_by).toBe('老板')
    expect(row.policy_version).toBe(3)
    expect(row.scope_path).toBe('netbird/pc-tower/~/code/x')

    expect(write(t, tx => world.grantFromConfig(tx, [
      // Only a person may grant; the agent may not grant itself anything.
      { principal: 'p1', scopePath: 'netbird/pc-tower', capability: 'write_host', strength: 'allow', grantedBy: 'superagent' },
      // An illegal scope path is refused before it reaches the table.
      { principal: 'p1', scopePath: 'netbird/pc-tower/../x', capability: 'read', strength: 'allow', grantedBy: '老板' },
      // A path no registered entity covers is refused too (04 failure table).
      { principal: 'p1', scopePath: 'external/github.com/git', capability: 'read', strength: 'allow', grantedBy: '老板' },
    ], 3))).toBe(0)
    expect(warnings).toHaveLength(3)
    expect(count(t, 'SELECT count(*) AS n FROM sa_mandate')).toBe(1)
  })

  it('6. revoking a mandate falls back to the defaults and keeps the row', () => {
    const t = openTestLedger(createManualClock(T0))
    const world = registryFor(t)
    owner(t, world)
    write(t, tx => world.register(tx, host({ canonical: 'pc-tower', path: 'netbird/pc-tower' })))
    write(t, tx => world.grantFromConfig(tx, [
      { principal: 'p1', scopePath: 'netbird/pc-tower', capability: 'write_repo', strength: 'allow', grantedBy: '老板' },
    ], 1))

    const granted = world.mandate('p1', 'netbird/pc-tower', 'write_repo')
    expect(granted).toEqual({ strength: 'allow', mandateId: 'M:p1:write_repo:netbird/pc-tower', source: 'mandate' })

    write(t, tx => world.revokeMandate(tx, String(granted.mandateId), '老板'))
    // The decision falls back immediately; the row is not deleted.
    expect(world.mandate('p1', 'netbird/pc-tower', 'write_repo')).toEqual({ strength: 'draft', source: 'default' })
    const row = rows<{ revoked_at: number | null; revoked_by: string | null }>(t, 'SELECT * FROM sa_mandate')[0]
    expect(row.revoked_at).toBe(T0)
    expect(row.revoked_by).toBe('老板')
    expect(count(t, 'SELECT count(*) AS n FROM sa_mandate')).toBe(1)
  })

  it('7. sweepLeases turns an expired lease stale and a month-old one gone', () => {
    const t = openTestLedger(createManualClock(T0))
    const world = registryFor(t)
    write(t, tx => world.enroll(tx, host({ canonical: 'quiet', path: 'netbird/quiet', lease_until: T0 - 60_000 }), world.issueToken()))
    write(t, tx => world.enroll(tx, host({ canonical: 'lost', path: 'netbird/lost', lease_until: T0 - 31 * DAY }), world.issueToken()))
    write(t, tx => world.register(tx, host({ canonical: 'configured', path: 'netbird/configured' })))

    expect(write(t, tx => world.sweepLeases(tx, T0))).toEqual({ stale: 1, gone: 1 })
    expect(write(t, tx => world.sweepLeases(tx, T0))).toEqual({ stale: 0, gone: 0 })
    const states = Object.fromEntries(
      rows<{ canonical: string; state: string }>(t, 'SELECT canonical, state FROM sa_world_entity').map((row) => [row.canonical, row.state]),
    )
    expect(states).toEqual({ quiet: 'stale', lost: 'gone', configured: 'enrolled' })

    // A stale machine is not a candidate for work; a configuration-only one is.
    const entities = rows<WorldEntityRow>(t, 'SELECT * FROM sa_world_entity')
    expect(filterHosts(entities, { tools: 'read', executorClass: 'claude' }, T0).map((row) => row.canonical)).toEqual(['configured'])
  })

  it('8. a new workspace needs an explicit write allow, not a draft', () => {
    const t = openTestLedger(createManualClock(T0))
    const world = registryFor(t)
    owner(t, world)
    write(t, tx => world.register(tx, host({
      canonical: 'pc-tower',
      path: 'netbird/pc-tower',
      manifest: { executors: ['claude'], tools: 'full' } satisfies Manifest,
    })))
    const request = {
      what: 'add the endpoint', check_kind: 'command' as const, principal: 'p1', needsWrite: true,
      realm: 'netbird' as const, host: 'pc-tower', path: 'netbird/pc-tower/~/code/x',
      workspace: 'new' as const, executorClass: 'claude',
    }

    // The owner default is `draft`, and a draft is not permission to provision.
    expect(world.place(request)).toEqual({ denied: 'NO_MANDATE' })

    write(t, tx => world.grantFromConfig(tx, [
      { principal: 'p1', scopePath: 'netbird/pc-tower/~/code/x', capability: 'write_repo', strength: 'allow', grantedBy: '老板' },
    ], 1))
    const chosen = world.place(request)
    if ('denied' in chosen) throw new Error(`expected a placement, got ${chosen.denied}`)
    expect(chosen.workspace).toBe('new')
    expect(chosen.host).toBe('pc-tower')
    expect(chosen.scopePath).toBe('netbird/pc-tower/~/code/x')
    expect(chosen.mandateId).toBe('M:p1:write_repo:netbird/pc-tower/~/code/x')

    // The workspace row is registered under that mandate, which is what makes it owned.
    write(t, tx => world.registerWorkspace(tx, {
      path: String(chosen.scopePath), entity_id: 'E:pc-tower', commitment_id: 'C-1', mandate_id: String(chosen.mandateId),
    }))
    expect(rows<{ path: string; mandate_id: string }>(t, 'SELECT path, mandate_id FROM sa_workspace')).toEqual([
      { path: 'netbird/pc-tower/~/code/x', mandate_id: 'M:p1:write_repo:netbird/pc-tower/~/code/x' },
    ])
  })

  it('9. one failing adapter is reported and the others still land', async () => {
    const t = openTestLedger(createManualClock(T0))
    const degrades: { reason: string; scope: string }[] = []
    const report: WorldReport = {
      warn: () => undefined,
      // degrade_event belongs to recovery (02), so the sink writes it as recovery.
      degrade: (entry) => {
        degrades.push(entry)
        t.ledger.open(tx => tx.run(
          `INSERT INTO sa_degrade_event (degrade_id, reason, scope, started_at, ended_at, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)`,
          `G:${degrades.length}`, entry.reason, entry.scope, entry.now, entry.now, entry.now), { module: 'recovery' })
      },
    }
    const world = registryFor(t, report)
    const broken: DiscoverySource = { name: 'broken', discover: async () => { throw new Error('adapter exploded') } }

    const gathered = await world.gatherDiscovery([broken, createSshConfigSource({ entries: SSH_ENTRIES })], T0)
    expect(gathered.failed).toEqual(['broken'])
    expect(gathered.candidates).toHaveLength(1)
    write(t, tx => world.landDiscovery(tx, gathered.candidates))

    expect(rows<{ reason: string; scope: string }>(t, 'SELECT reason, scope FROM sa_degrade_event')).toEqual([
      { reason: 'world_adapter_failed', scope: 'broken' },
    ])
    // The healthy source was not collateral damage.
    expect(rows<{ canonical: string }>(t, 'SELECT canonical FROM sa_world_entity')).toEqual([{ canonical: 'dev' }])
  })

  it('10. owner rows come from configuration only', () => {
    const t = openTestLedger(createManualClock(T0))
    const world = registryFor(t)
    const parsed = parseWorldConfig({
      entities: [
        { canonical: 'pc-tower', kind: 'host', realm: 'netbird', path: 'netbird/pc-tower', aliases: ['pc-tower'], manifest: { executors: ['claude'] } },
      ],
      parties: [{ partyId: 'p1', union_id: 'on_p1', class: 'owner' }],
      mandates: [{ principal: 'p1', scopePath: 'netbird/pc-tower', capability: 'write_repo', strength: 'allow', grantedBy: '老板' }],
    })
    expect(parsed.problems).toEqual([])
    expect(write(t, tx => applyWorldConfig(world, tx, parsed, 1))).toEqual({ entities: 1, mandates: 1, parties: 1 })

    const party = rows<{ class: string; source: string; union_id: string }>(t, 'SELECT * FROM sa_party')[0]
    expect(party.class).toBe('owner')
    expect(party.source).toBe('config')
    expect(party.union_id).toBe('on_p1')
    // And the identity path is the one that decides: owner read is allowed outright.
    expect(world.mandate('p1', 'netbird/pc-tower', 'read')).toEqual({ strength: 'allow', source: 'default' })

    // A scan can never produce an owner: the only observed party is a member.
    expect(() => write(t, tx => world.registerParty(tx, { party_id: 'p2', class: 'owner', source: 'observed' })))
      .toThrowError(/PARTY_CLASS_REQUIRES_CONFIG/)
    expect(count(t, 'SELECT count(*) AS n FROM sa_party')).toBe(1)
  })

  it('11. a workspace is owned by a mandate whose scope covers it, not only an exact-path one', () => {
    const t = openTestLedger(createManualClock(T0))
    const world = registryFor(t)
    owner(t, world)
    // A parent grant the person wrote; placement returns this mandate for a child target.
    write(t, tx => world.register(tx, { canonical: 'ws', kind: 'repo', realm: 'local', path: 'local/workspaces', manifest: { executors: ['claude'] } }))
    write(t, tx => world.grantFromConfig(tx, [
      { principal: 'p1', scopePath: 'local/workspaces', capability: 'write_repo', strength: 'allow', grantedBy: '老板' },
      { principal: 'p1', scopePath: 'local/workspaces/sub', capability: 'write_repo', strength: 'allow', grantedBy: '老板' },
    ], 1))
    const parent = 'M:p1:write_repo:local/workspaces'
    const child = 'M:p1:write_repo:local/workspaces/sub'

    // The parent mandate covers a deeper child path (the production bug: inheritance
    // is downward, so a root grant owns every workspace beneath it).
    write(t, tx => world.registerWorkspace(tx, {
      path: 'local/workspaces/sub/task', entity_id: 'E:ws', commitment_id: 'C-2', mandate_id: parent,
    }))
    expect(rows<{ path: string; mandate_id: string }>(t, 'SELECT path, mandate_id FROM sa_workspace')).toEqual([
      { path: 'local/workspaces/sub/task', mandate_id: parent },
    ])

    // A mandate that does not cover the path (a sibling/narrower grant) still owns nothing.
    expect(() => write(t, tx => world.registerWorkspace(tx, {
      path: 'local/workspaces/other', entity_id: 'E:ws', commitment_id: 'C-3', mandate_id: child,
    }))).toThrow(/MANDATE_NOT_LIVE/)

    // A revoked mandate is never a live owner, covering or not.
    write(t, tx => world.revokeMandate(tx, parent, '老板'))
    expect(() => write(t, tx => world.registerWorkspace(tx, {
      path: 'local/workspaces/sub/again', entity_id: 'E:ws', commitment_id: 'C-4', mandate_id: parent,
    }))).toThrow(/MANDATE_NOT_LIVE/)
    expect(count(t, 'SELECT count(*) AS n FROM sa_workspace')).toBe(1)
  })
})