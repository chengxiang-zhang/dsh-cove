import { expect, it } from 'vitest'
const load = () => import('../src/host/services/superagent/kernel/sandbox-fixtures.ts').catch(() => null)
it('allocates distinct bounded fixture slots across owners and never recycles a claimed close', async () => {
  const api = await load(); expect(api, 'trusted fixture leases must exist').not.toBeNull()
  const leases = new api!.FixtureLeaseTable(2)
  expect(leases.allocate('worker-a')).toEqual({ index: 0, state: 'active' })
  expect(leases.allocate('worker-b')).toEqual({ index: 1, state: 'active' })
  expect(() => leases.release('worker-b', 0)).toThrow('FIXTURE_LEASE_OWNER')
  leases.release('worker-a', 0)
  expect(() => leases.allocate('worker-c')).toThrow('FIXTURE_POOL_EXHAUSTED')
  expect(leases.snapshot()).toEqual([{ index: 0, owner: 'worker-a', state: 'released' }, { index: 1, owner: 'worker-b', state: 'active' }])
})
it('retains unknown ownership on disconnect and rejects replay or allocation after retirement', async () => {
  const api = await load(); expect(api).not.toBeNull()
  const leases = new api!.FixtureLeaseTable(3)
  leases.allocate('worker-a'); leases.allocate('worker-a'); leases.allocate('worker-b')
  leases.disconnected('worker-a')
  expect(leases.snapshot().map(x => x.state)).toEqual(['unknown', 'unknown', 'active'])
  expect(() => leases.release('worker-a', 0)).toThrow('FIXTURE_LEASE_STATE')
  leases.retire()
  expect(() => leases.allocate('worker-c')).toThrow('FIXTURE_POOL_RETIRED')
  expect(leases.snapshot().map(x => x.state)).toEqual(['unknown', 'unknown', 'unknown'])
})
it('rejects malformed capacities and lease identities', async () => {
  const api = await load(); expect(api).not.toBeNull()
  for (const n of [0, -1, 257, 1.2, NaN]) expect(() => new api!.FixtureLeaseTable(n)).toThrow('FIXTURE_POOL_LIMIT')
  const leases = new api!.FixtureLeaseTable(1)
  expect(() => leases.allocate('')).toThrow('FIXTURE_LEASE_OWNER')
  expect(() => leases.release('worker-a', -1)).toThrow('FIXTURE_LEASE_OWNER')
})

it('keeps detached fixture cwd as data and rejects source interpolation or changed programs', async () => {
  const { detachedFixtureArgs, detachedFixtureProgram, normalizeDetachedFixture } = await import('../src/host/services/superagent/kernel/sandbox-launch-port.ts')
  const cwd = "/tmp/quoted'path"
  const request = { profile: '', executable: '/usr/bin/perl', args: detachedFixtureArgs(cwd), cwd, env: {}, processPolicy: 'children' as const, timeoutMs: 100 }
  expect(request.args[2]).toBe(detachedFixtureProgram)
  expect(request.args[4]).toBe(cwd + '/detached-pid')
  expect(normalizeDetachedFixture(request)).toBe(request)
  expect(() => normalizeDetachedFixture({ ...request, args: ['-MPOSIX', '-e', detachedFixtureProgram.replace('$ARGV[0]', "'" + cwd + "/detached-pid'")] })).toThrow('SANDBOX_QA_DETACHED_SHAPE')
  expect(() => normalizeDetachedFixture({ ...request, cwd: '/tmp/safe', args: ['-MPOSIX', '-e', 'exit 0'] })).toThrow('SANDBOX_QA_DETACHED_SHAPE')
  const safe = '/tmp/safe'
  expect(normalizeDetachedFixture({ ...request, cwd: safe, args: ['-MPOSIX', '-e', detachedFixtureProgram.replace('$ARGV[0]', "'" + safe + "/detached-pid'")] }).args).toEqual(detachedFixtureArgs(safe))
})
