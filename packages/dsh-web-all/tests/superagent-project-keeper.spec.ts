import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startProjectKeeper } from '../src/host/services/superagent/executors/project-keeper.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function input(version?: 'project-gates-v1') {
  const root = mkdtempSync(join(tmpdir(), 'keeper-budget-')); roots.push(root)
  return { collectorRoot: root, budgetVersion: version, runId: 'budget-test', epoch: 1, capacity: 1,
    expiresAt: Date.now() + 1000, commands: [], domain: { readRoots: [root], writeRoots: [root], executableRoots: ['/bin'], metadataPaths: [], fixturePorts: [], unixSockets: [] } }
}
it('refuses a ninth keeper and counts all eight retired unknown owners against the fixed project budget', async () => {
  const configuration = input('project-gates-v1')
  writeFileSync(join(configuration.collectorRoot, 'budget.json'), JSON.stringify({ version: 'project-gates-v1', maximum: 8 }))
  for (let i = 0; i < 8; i++) {
    const retained = join(configuration.collectorRoot, 'keeper-' + i); mkdirSync(retained)
    writeFileSync(join(retained, 'status.json'), JSON.stringify({ phase: 'quarantine', cessation: 'unknown' }))
  }
  await expect(startProjectKeeper(configuration)).rejects.toThrow('KEEPER_QUARANTINE_BUDGET')
  expect(JSON.parse(readFileSync(join(configuration.collectorRoot, 'keeper-0/status.json'), 'utf8')).cessation).toBe('unknown')
})
it('does not expand an existing four-owner collector to the project budget', async () => {
  const configuration = input('project-gates-v1')
  writeFileSync(join(configuration.collectorRoot, 'budget.json'), JSON.stringify({ version: 'fixed-four-v1', maximum: 4 }))
  await expect(startProjectKeeper(configuration)).rejects.toThrow('KEEPER_BUDGET_VERSION_CHANGED')
})
it('keeps legacy unversioned collectors at four and refuses in-place project expansion', async () => {
  const configuration = input('project-gates-v1')
  for (let i = 0; i < 4; i++) mkdirSync(join(configuration.collectorRoot, 'keeper-' + i))
  await expect(startProjectKeeper(configuration)).rejects.toThrow('KEEPER_BUDGET_VERSION_CHANGED')
  await expect(startProjectKeeper({ ...configuration, budgetVersion: undefined })).rejects.toThrow('KEEPER_QUARANTINE_BUDGET')
})
