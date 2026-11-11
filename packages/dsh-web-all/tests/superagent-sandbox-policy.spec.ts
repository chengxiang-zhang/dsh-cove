import { expect, it } from 'vitest'
const load = () => import('../src/host/services/superagent/kernel/sandbox-policy.ts').catch(() => null)
it('rejects executable Scheme, unknown predicates and unbounded profiles before host compilation', async () => {
  const api = await load()
  expect(api, 'a non-executing finite policy parser is required').not.toBeNull()
  for (const text of ['(version 1)(allow default)', '(version 1)(deny default)(import "evil.sb")', '(version 1)(deny default)(define x (system "x"))', '(version 1)(deny default)(allow file-read* (regex ".*"))', '(version 1)(deny default)' + ' '.repeat(131072)])
    expect(() => api!.parseSandboxPolicy(text)).toThrow()
})
it('round trips candidate read/write/fork semantics without replacing them with a correct inner policy', async () => {
  const api = await load(); expect(api).not.toBeNull()
  const good = '(version 1)(deny default)(allow process-exec)(allow file-read* (subpath "/run/inner"))'
  const bad = good.replace('/run/inner', '/run')
  expect(api!.serializeSandboxPolicy(api!.parseSandboxPolicy(good))).toContain('"/run/inner"')
  expect(api!.serializeSandboxPolicy(api!.parseSandboxPolicy(bad))).toContain('"/run"')
  expect(api!.parseSandboxPolicy(good)).not.toEqual(api!.parseSandboxPolicy(bad))
})
it('keeps the maximum authority host-owned and clamps after candidate policy', async () => {
  const api = await load(); expect(api).not.toBeNull()
  const domain = { readRoots: ['/run', '/usr'], writeRoots: ['/run/inner'], executableRoots: ['/bin'], metadataPaths: ['/'], fixturePorts: [49152], unixSockets: ['/run/broker.sock'] }
  const output = api!.constrainSandboxPolicy('(version 1)(deny default)(allow file-read* file-write* (subpath "/"))(allow network-outbound)', domain)
  expect(output.profile).toContain('(deny file-write*')
  expect(output.profile).not.toContain('localhost:*')
  expect(output.profile.indexOf('(deny file-write*')).toBeGreaterThan(output.profile.indexOf('(allow file-read*'))
  expect(output.originalDigest).not.toBe(output.effectiveDigest)
  expect(() => api!.constrainSandboxPolicy('(version 1)(deny default)', { ...domain, fixturePorts: [0] })).toThrow()
})
