/**
 * World model pure functions (T05).
 *
 * Contract: docs/superagent/04-世界模型.md and plan/spec/T-05-world.md. The
 * fixtures are inline row arrays on purpose: this slice has to be decidable
 * without a database, a clock or a network, because that is what makes the
 * authorization answer reproducible. Expected values are written out here so the
 * test is a second, independent copy of the contract rather than a mirror of the
 * implementation.
 *
 * Test 12 is the built-in negative control: a stand-in that keeps the first
 * matching row instead of the longest one must disagree with the real decision on
 * test 3's fixture, otherwise the case would pass under either rule and prove
 * nothing.
 */

import { describe, expect, it } from 'vitest'
import { CAPABILITIES, type MandateRow, type WorldEntityRow } from '../src/host/services/superagent/protocol/objects.ts'
import { DEFAULT_TABLE, type DefaultTable } from '../src/host/services/superagent/world/defaults.ts'
import {
  defaultStrength,
  decideMandate,
  WRITE_CAPABILITIES,
  type MandateDecision,
  type MandateQuery,
} from '../src/host/services/superagent/world/mandate.ts'
import {
  ancestors,
  isPrefix,
  normalizePath,
  parsePath,
  PATH_INVALID,
  ScopePathError,
} from '../src/host/services/superagent/world/paths.ts'
import { filterHosts, resolveMention, type AliasEntry } from '../src/host/services/superagent/world/resolve.ts'

const NOW = 1_000_000

type MandateSeed = Partial<MandateRow> & Required<Pick<MandateRow, 'mandate_id' | 'principal' | 'scope_path' | 'capability' | 'strength'>>

function mandate(seed: MandateSeed): MandateRow {
  return {
    created_at: NOW,
    updated_at: null,
    policy_version: 1,
    granted_by: 'owner',
    granted_at: NOW,
    revoked_at: null,
    revoked_by: null,
    ...seed,
  }
}

type EntitySeed = Partial<WorldEntityRow> & Required<Pick<WorldEntityRow, 'entity_id' | 'canonical' | 'path'>>

function entity(seed: EntitySeed): WorldEntityRow {
  const realm = seed.path.startsWith('local/') ? 'local' : seed.path.startsWith('external/') ? 'external' : 'netbird'
  return {
    kind: 'host',
    realm,
    state: 'enrolled',
    source: 'config',
    lease_until: null,
    manifest_json: null,
    revoked_by: null,
    created_at: NOW,
    updated_at: null,
    ...seed,
  }
}

const REPO = 'netbird/pc-tower/~/code/x'

/**
 * The shorter deny row comes first. An implementation that kept the first match
 * instead of the longest one would answer `deny` for test 3's first query.
 */
const REPO_ROWS: MandateRow[] = [
  mandate({ mandate_id: 'm-host-deny', principal: 'p1', scope_path: 'netbird/pc-tower', capability: 'write_repo', strength: 'deny' }),
  mandate({ mandate_id: 'm-repo-allow', principal: 'p1', scope_path: REPO, capability: 'write_repo', strength: 'allow' }),
]

describe('superagent world pure functions', () => {
  it('1. normalizePath collapses separators and rejects relative segments', () => {
    expect(normalizePath('local//~/code/dsh-web/')).toBe('local/~/code/dsh-web')
    expect(normalizePath('local')).toBe('local/')
    expect(normalizePath('netbird/pc-tower/')).toBe('netbird/pc-tower')
    expect(normalizePath('external/github.com/chengxiang-zhang/')).toBe('external/github.com/chengxiang-zhang')

    expect(parsePath('local/~/code/dsh-web')).toEqual({ realm: 'local', rest: ['~', 'code', 'dsh-web'] })
    expect(parsePath('netbird/pc-tower/session/sa-x-C-12')).toEqual({
      realm: 'netbird',
      host: 'pc-tower',
      rest: ['pc-tower', 'session', 'sa-x-C-12'],
    })

    for (const raw of ['local/../x', 'local/./x', 'workspace/foo', '']) {
      expect(() => normalizePath(raw)).toThrowError(ScopePathError)
      try {
        normalizePath(raw)
      } catch (error) {
        expect((error as ScopePathError).code).toBe(PATH_INVALID)
      }
    }
  })

  it('2. isPrefix compares segments and ancestors walk nearest to farthest', () => {
    expect(isPrefix('local/~/code/dsh', 'local/~/code/dsh-web')).toBe(false)
    expect(isPrefix('netbird/pc-tower', 'netbird/pc-tower/~/code/x')).toBe(true)
    expect(isPrefix('local/', 'local/~/code/dsh-web')).toBe(true)
    expect(isPrefix('netbird/pc-tower/~/code/x', 'netbird/pc-tower')).toBe(false)
    expect(isPrefix('local/~/code/dsh-web', 'local/~/code/dsh-web')).toBe(true)

    expect(ancestors('netbird/pc-tower/~/code/x')).toEqual([
      'netbird/pc-tower/~/code',
      'netbird/pc-tower/~',
      'netbird/pc-tower',
      'netbird/',
    ])
    expect(ancestors('local/')).toEqual([])
    expect(ancestors('local/~/code/dsh-web').at(-1)).toBe('local/')
  })

  it('3. the longest matching scope wins over a shorter one', () => {
    const inRepo = decideMandate(
      REPO_ROWS,
      { principal: 'p1', scopePath: `${REPO}/src`, capability: 'write_repo' },
      DEFAULT_TABLE,
      'owner',
    )
    expect(inRepo).toEqual({ strength: 'allow', mandateId: 'm-repo-allow', source: 'mandate' })

    const otherRepo = decideMandate(
      REPO_ROWS,
      { principal: 'p1', scopePath: 'netbird/pc-tower/~/code/y', capability: 'write_repo' },
      DEFAULT_TABLE,
      'owner',
    )
    expect(otherRepo).toEqual({ strength: 'deny', mandateId: 'm-host-deny', source: 'mandate' })

    const otherCapability = decideMandate(
      REPO_ROWS,
      { principal: 'p1', scopePath: REPO, capability: 'publish' },
      DEFAULT_TABLE,
      'owner',
    )
    expect(otherCapability).toEqual({ strength: 'draft', source: 'default' })

    const otherPrincipal = decideMandate(
      REPO_ROWS,
      { principal: 'p2', scopePath: REPO, capability: 'write_repo' },
      DEFAULT_TABLE,
      'owner',
    )
    expect(otherPrincipal).toEqual({ strength: 'draft', source: 'default' })
  })

  it('4. two rows on one scope resolve to the strictest: draft beats allow', () => {
    const rows: MandateRow[] = [
      mandate({ mandate_id: 'm-allow', principal: 'p1', scope_path: 'local/~/code/dsh-web', capability: 'write_repo', strength: 'allow' }),
      // The trailing slash must normalize onto the same scope, so the two rows tie
      // on specificity instead of one looking longer than the other.
      mandate({ mandate_id: 'm-draft', principal: 'p1', scope_path: 'local/~/code/dsh-web/', capability: 'write_repo', strength: 'draft' }),
    ]
    const query: MandateQuery = { principal: 'p1', scopePath: 'local/~/code/dsh-web', capability: 'write_repo' }

    expect(decideMandate(rows, query, DEFAULT_TABLE, 'owner')).toEqual({
      strength: 'draft',
      mandateId: 'm-draft',
      source: 'mandate',
    })
    // Row order is not an input to the decision.
    expect(decideMandate([...rows].reverse(), query, DEFAULT_TABLE, 'owner').strength).toBe('draft')
  })

  it('5. a revoked allow is invisible and the default table answers', () => {
    const revoked = mandate({
      mandate_id: 'm-revoked',
      principal: 'p1',
      scope_path: 'local/',
      capability: 'write_repo',
      strength: 'allow',
      revoked_at: NOW - 1,
      revoked_by: 'owner',
    })
    const query: MandateQuery = { principal: 'p1', scopePath: 'local/~/code/x', capability: 'write_repo' }

    expect(decideMandate([revoked], query, DEFAULT_TABLE, 'owner')).toEqual({ strength: 'draft', source: 'default' })
    // The same row while live is exactly what revocation took away.
    expect(decideMandate([{ ...revoked, revoked_at: null, revoked_by: null }], query, DEFAULT_TABLE, 'owner')).toEqual({
      strength: 'allow',
      mandateId: 'm-revoked',
      source: 'mandate',
    })
  })

  it('6. defaults: owner writes are draft, external read is deny, colleague publish is deny', () => {
    expect(DEFAULT_TABLE.owner.write_repo).toBe('draft')
    expect(DEFAULT_TABLE.external.read).toBe('deny')
    expect(DEFAULT_TABLE.colleague.publish).toBe('deny')
    expect(DEFAULT_TABLE.owner.read).toBe('allow')
    expect(DEFAULT_TABLE.colleague.read).toBe('allow')
    expect(DEFAULT_TABLE.member.read).toBe('allow')
    expect(DEFAULT_TABLE.member.write_repo).toBe('deny')

    const classes = ['owner', 'colleague', 'member', 'external'] as const
    for (const partyClass of classes) {
      // Complete table: no capability lookup can fall through a hole.
      expect(Object.keys(DEFAULT_TABLE[partyClass]).sort()).toEqual([...CAPABILITIES].sort())
      // N24: the table can never hand out a write.
      for (const capability of WRITE_CAPABILITIES) expect(DEFAULT_TABLE[partyClass][capability]).not.toBe('allow')
    }

    // The ceiling is a mechanism, not just this data: a widened table is clamped.
    const widened: DefaultTable = { ...DEFAULT_TABLE, owner: { ...DEFAULT_TABLE.owner, write_repo: 'allow' } }
    expect(defaultStrength(widened, 'owner', 'write_repo')).toBe('draft')
    expect(defaultStrength(widened, 'owner', 'read')).toBe('allow')
    // Unknown class or capability fails closed.
    expect(defaultStrength({} as DefaultTable, 'owner', 'read')).toBe('deny')
  })

  it('7. a registered spoken name resolves without asking', () => {
    const imac = entity({ entity_id: 'e-imac', canonical: 'imac', path: 'netbird/imac' })
    const aliases: AliasEntry[] = [{ alias: '那台mac', entity_id: 'e-imac' }]

    const hit = resolveMention({ mention: '那台 mac', entities: [imac], aliases, authorizedPaths: ['netbird/imac'] })
    expect(hit.ask).toBeNull()
    expect(hit.entity?.entity_id).toBe('e-imac')
    expect(hit.scopePath).toBe('netbird/imac')
    expect(hit.candidates[0]).toEqual({ entity_id: 'e-imac', score: 100 })

    // Same saying, no alias row: the answer is a question about registration.
    const unknown = resolveMention({ mention: '那台 mac', entities: [imac], aliases: [], authorizedPaths: ['netbird/imac'] })
    expect(unknown.ask).toBe('unregistered')
    expect(unknown.entity).toBeUndefined()
  })

  it('8. fuzzy candidates need a clear margin: 80 vs 60 asks, 80 vs 40 answers', () => {
    const hostA = entity({ entity_id: 'e-a', canonical: 'hellp', path: 'netbird/host-a' })
    const hostB = entity({ entity_id: 'e-b', canonical: 'hxllz', path: 'netbird/host-b' })
    const hostC = entity({ entity_id: 'e-c', canonical: 'hzzzo', path: 'netbird/host-c' })

    const close = resolveMention({ mention: 'hello', entities: [hostA, hostB], aliases: [], authorizedPaths: ['netbird/'] })
    expect(close.candidates.map((candidate) => candidate.score)).toEqual([80, 60])
    expect(close.ask).toBe('close_scores')
    expect(close.entity).toBeUndefined()

    const clear = resolveMention({ mention: 'hello', entities: [hostA, hostC], aliases: [], authorizedPaths: ['netbird/'] })
    expect(clear.candidates.map((candidate) => candidate.score)).toEqual([80])
    expect(clear.ask).toBeNull()
    expect(clear.entity?.entity_id).toBe('e-a')

    // The margin rule itself, with a live runner-up still in the candidate list.
    const exact = entity({ entity_id: 'e-exact', canonical: 'hello', path: 'netbird/exact' })
    const decisive = resolveMention({ mention: 'hello', entities: [exact, hostB], aliases: [], authorizedPaths: ['netbird/'] })
    expect(decisive.candidates.map((candidate) => candidate.score)).toEqual([100, 60])
    expect(decisive.ask).toBeNull()
    expect(decisive.entity?.entity_id).toBe('e-exact')
  })

  it('9. a hit outside every authorized path is a question, not an answer', () => {
    const imac = entity({ entity_id: 'e-imac', canonical: 'imac', path: 'netbird/imac' })
    const aliases: AliasEntry[] = [{ alias: '那台mac', entity_id: 'e-imac' }]

    const outside = resolveMention({ mention: '那台 mac', entities: [imac], aliases, authorizedPaths: ['netbird/another-host'] })
    expect(outside.ask).toBe('outside_scope')
    expect(outside.entity?.entity_id).toBe('e-imac')
    expect(outside.scopePath).toBe('netbird/imac')

    // No authorized path at all is the same answer, not a grant.
    expect(resolveMention({ mention: '那台 mac', entities: [imac], aliases, authorizedPaths: [] }).ask).toBe('outside_scope')
    // A wider authorized path covers the entity.
    expect(resolveMention({ mention: '那台 mac', entities: [imac], aliases, authorizedPaths: ['netbird/'] }).ask).toBeNull()
  })

  it('10. a proposed entity never resolves, even through an exact alias', () => {
    const proposed = entity({
      entity_id: 'e-imac',
      canonical: 'imac',
      path: 'netbird/imac',
      state: 'proposed',
      source: 'discover',
    })
    const result = resolveMention({
      mention: '那台 mac',
      entities: [proposed],
      aliases: [{ alias: '那台mac', entity_id: 'e-imac' }],
      authorizedPaths: ['netbird/imac'],
    })

    expect(result.entity).toBeUndefined()
    expect(result.ask).toBe('unregistered')
    expect(result.candidates).toEqual([])
  })

  it('11. filterHosts keeps enrolled, leased-or-config hosts that declare the executor class', () => {
    const declaration = (executors: string[], tools?: string): string =>
      JSON.stringify(tools === undefined ? { executors } : { executors, tools })
    const hosts: WorldEntityRow[] = [
      entity({ entity_id: 'h-ok', canonical: 'ok', path: 'netbird/ok', lease_until: NOW + 1_000, manifest_json: declaration(['claude'], 'full') }),
      entity({ entity_id: 'h-expired', canonical: 'expired', path: 'netbird/expired', lease_until: NOW - 1, manifest_json: declaration(['claude'], 'full') }),
      entity({ entity_id: 'h-other-class', canonical: 'other', path: 'netbird/other', manifest_json: declaration(['codex'], 'full') }),
      entity({ entity_id: 'h-config', canonical: 'config', path: 'netbird/config', manifest_json: declaration(['claude'], 'full') }),
      entity({ entity_id: 'h-proposed', canonical: 'proposed', path: 'netbird/proposed', state: 'proposed', source: 'discover', manifest_json: declaration(['claude'], 'full') }),
      entity({ entity_id: 'h-boundary', canonical: 'boundary', path: 'netbird/boundary', lease_until: NOW, manifest_json: declaration(['claude']) }),
      entity({ entity_id: 'h-read-only', canonical: 'readonly', path: 'netbird/readonly', manifest_json: declaration(['claude'], 'read') }),
      entity({ entity_id: 'h-no-manifest', canonical: 'nomanifest', path: 'netbird/nomanifest' }),
    ]

    expect(filterHosts(hosts, { tools: 'full', executorClass: 'claude' }, NOW).map((host) => host.entity_id)).toEqual([
      'h-ok',
      'h-config',
      'h-boundary',
    ])
    // A read-only declaration covers a read need but not a full one.
    expect(filterHosts(hosts, { tools: 'read', executorClass: 'claude' }, NOW).map((host) => host.entity_id)).toEqual([
      'h-ok',
      'h-config',
      'h-boundary',
      'h-read-only',
    ])
  })

  it('12. the fixture discriminates longest-prefix from first-match', () => {
    // The bug this case exists to catch: keeping the first matching row.
    const firstMatch = (rows: readonly MandateRow[], query: MandateQuery): MandateDecision => {
      for (const row of rows) {
        if (row.principal !== query.principal) continue
        if (row.capability !== query.capability) continue
        if (row.revoked_at !== null) continue
        if (!isPrefix(row.scope_path, query.scopePath)) continue
        return { strength: row.strength, mandateId: row.mandate_id, source: 'mandate' }
      }
      return { strength: 'draft', source: 'default' }
    }
    const query: MandateQuery = { principal: 'p1', scopePath: `${REPO}/src`, capability: 'write_repo' }

    expect(decideMandate(REPO_ROWS, query, DEFAULT_TABLE, 'owner')).toEqual({
      strength: 'allow',
      mandateId: 'm-repo-allow',
      source: 'mandate',
    })
    // Same fixture, first-match rule: a different answer, so test 3 has teeth.
    expect(firstMatch(REPO_ROWS, query)).toEqual({ strength: 'deny', mandateId: 'm-host-deny', source: 'mandate' })
    // Ordering the same rows most-specific-first makes the stand-in agree, which
    // locates the difference in the rule rather than in the data.
    const longestFirst = [...REPO_ROWS].sort((left, right) => right.scope_path.length - left.scope_path.length)
    expect(firstMatch(longestFirst, query).strength).toBe('allow')
  })
})