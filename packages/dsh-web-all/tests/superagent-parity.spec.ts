/**
 * The T29 ledger, checked mechanically: 174 lark-inbox cases, each one classified.
 *
 * The retirement condition for `responder.ts` is not "the new code is written"; it
 * is "every responder case has been migrated with an equivalent reading, and not
 * one line was left behind". A prose inventory cannot hold that promise - it stops
 * being true the moment somebody adds a case and forgets to record it - so the
 * inventory is a data file and this spec is the check that keeps it honest:
 *
 * - every case in the eleven lark-inbox specs is in the ledger exactly once
 *   (reading the sources, so a new case that nobody recorded is a failure);
 * - every `migrated` target names a real superagent case in a real file
 *   (a ledger that points at nothing would silently bless the old code);
 * - every `retired` / `not-applicable` row carries its reason;
 * - the responder-class migration count is printed, and the unmigrated ones are
 *   listed by name rather than folded into a number.
 *
 * The last point is the one worth keeping: `migrated=<y>/<y>` is the precondition
 * for deleting the responder, and a number that reaches y by relabelling is worse
 * than no number at all.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import manifest from './superagent-parity.manifest.json'

const packageRoot = process.cwd()
const testsDir = resolve(packageRoot, 'tests')

/** Every `it(`/`test(` title of one spec file, in source order. */
function casesOf(file: string): string[] {
  const out: string[] = []
  for (const line of readFileSync(resolve(testsDir, file), 'utf8').split('\n')) {
    const match = line.match(/\b(?:it|test)\(\s*(?:'([^']*)'|"([^"]*)")/u)
    if (match) out.push(match[1] ?? match[2] ?? '')
  }
  return out
}

/** The eleven source specs, read from disk rather than trusted from the manifest. */
function sourceFiles(): string[] {
  return readdirSync(testsDir)
    .filter(name => name.startsWith('lark-inbox-') && /\.spec\.tsx?$/u.test(name))
    .sort()
}

interface LedgerRow {
  suite: string
  case: string
  class: 'responder' | 'channel' | 'admin'
  responder: boolean
  status: 'migrated' | 'kept-in-channel' | 'retired' | 'not-applicable'
  target?: string
  module?: string
  reading: string
  why?: string
}

/** One identity per case, whether the suite is written with or without the tests/ prefix. */
const keyOf = (suite: string, name: string): string => `${suite.replace(/^tests\//u, '')}::${name}`

const rows = manifest.cases as LedgerRow[]
const responderRows = rows.filter(row => row.class === 'responder')
const migrated = responderRows.filter(row => row.status === 'migrated')
const unmigrated = responderRows.filter(row => row.status !== 'migrated')
/** Ruled out by the Lead with a reason: not migrated, but accounted for. */
const ruled = responderRows.filter(row => row.status === 'not-applicable')

describe('T29 ledger: the inventory is the sources', () => {
  it('covers exactly the eleven lark-inbox specs and every one of their cases, once', () => {
    const sources = sourceFiles()
    expect(sources).toHaveLength(11)
    expect([...manifest.sources].sort()).toEqual(sources.map(name => `tests/${name}`))

    const recorded = new Map<string, number>()
    for (const row of rows) recorded.set(keyOf(row.suite, row.case), (recorded.get(keyOf(row.suite, row.case)) ?? 0) + 1)
    for (const count of recorded.values()) expect(count).toBe(1)

    const unrecorded: string[] = []
    let total = 0
    for (const suite of sources) {
      for (const name of casesOf(suite)) {
        total += 1
        if (!recorded.has(keyOf(suite, name))) unrecorded.push(keyOf(suite, name))
      }
    }
    expect(unrecorded).toEqual([])
    expect(rows).toHaveLength(total)
    expect(manifest.counts.cases).toBe(total)
  })

  it('invents no case: every row names a case its suite really contains', () => {
    const phantom: string[] = []
    for (const row of rows) {
      const file = row.suite.replace(/^tests\//u, '')
      if (!casesOf(file).includes(row.case)) phantom.push(`${row.suite}::${row.case}`)
    }
    expect(phantom).toEqual([])
  })
})

describe('T29 ledger: migrated targets really exist', () => {
  it('points every migrated row at a case that exists in that spec file', () => {
    const missing: string[] = []
    for (const row of rows.filter(entry => entry.status === 'migrated')) {
      const target = row.target ?? ''
      const [declared, name] = target.split('::')
      if (declared === undefined || name === undefined) { missing.push(`${row.suite}::${row.case} -> ${target}`); continue }
      // Targets are written `tests/<file>::<case>`; the enumerator works from tests/.
      const file = declared.replace(/^tests\//u, '')
      let titles: string[]
      try {
        titles = casesOf(file)
      } catch {
        missing.push(`${row.suite}::${row.case} -> missing file ${file}`)
        continue
      }
      if (!titles.includes(name)) missing.push(`${row.suite}::${row.case} -> missing case ${target}`)
      if (row.module === undefined || row.module === '') missing.push(`${row.suite}::${row.case} -> no module`)
    }
    expect(missing).toEqual([])
  })

  it('gives every retired or not-applicable row a reason, and keeps class and responder in step', () => {
    const unexplained: string[] = []
    for (const row of rows) {
      expect(['responder', 'channel', 'admin']).toContain(row.class)
      expect(row.responder).toBe(row.class === 'responder')
      expect(['migrated', 'kept-in-channel', 'retired', 'not-applicable']).toContain(row.status)
      if (row.status === 'migrated') expect(row.target).toBeTypeOf('string')
      if (row.status === 'retired' || row.status === 'not-applicable') {
        if ((row.why ?? '').trim() === '') unexplained.push(`${row.suite}::${row.case}`)
      }
      expect(row.reading.trim()).not.toBe('')
    }
    expect(unexplained).toEqual([])
  })
})

describe('T29 ledger: the retirement reading', () => {
  it('prints migrated=<x>/<y> and names every responder case that is still unmigrated', () => {
    // Printed, not just asserted: this line is the reading the retirement decision
    // is taken on, and a bare number would hide which behaviour is missing.
    console.info(`parity migrated=${migrated.length}/${responderRows.length}`)
    // The second reading: a responder case is either migrated or ruled not-applicable
    // by the Lead with a reason. Both count as accounted for; only the first is a
    // migration, and the two numbers are never merged into one.
    console.info(`parity accounted=${migrated.length + ruled.length}/${responderRows.length} (migrated=${migrated.length}, not-applicable=${ruled.length})`)
    for (const row of unmigrated) console.info(`parity responder-unmigrated: ${row.suite}::${row.case} [${row.status}] ${row.why ?? ''}`)
    console.info(`parity responder-unmigrated=${unmigrated.length}`)

    expect(migrated.length + unmigrated.length).toBe(responderRows.length)
    expect(manifest.counts.responder).toBe(responderRows.length)
    expect(manifest.counts.responderMigrated).toBe(migrated.length)
    expect(manifest.counts.responderNotApplicable).toBe(ruled.length)
    expect(manifest.counts.responderAccounted).toBe(migrated.length + ruled.length)
    expect(unmigrated.every(row => row.status === 'not-applicable' && (row.why ?? '').trim() !== '')).toBe(true)
    expect(`parity migrated=${migrated.length}/${responderRows.length}`).toMatch(/^parity migrated=\d+\/\d+$/u)
  })

  it('accounts for the class split so a relabelled case cannot hide in the totals', () => {
    const channels = rows.filter(row => row.class === 'channel').length
    const admin = rows.filter(row => row.class === 'admin').length
    expect(channels + admin + responderRows.length).toBe(rows.length)
    // Every channel/admin row states where it lives; none of them may be 'migrated'.
    for (const row of rows.filter(entry => entry.class !== 'responder')) {
      expect(row.status).not.toBe('migrated')
      expect((row.reading ?? '').trim()).not.toBe('')
    }
    expect(channels).toBeGreaterThan(0)
    expect(admin).toBeGreaterThan(0)
  })
})