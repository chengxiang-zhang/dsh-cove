import { expect, it } from 'vitest'
const load = () => import('../src/host/services/superagent/kernel/sandbox-wire.ts').catch(() => null)
it('decodes complete UTF-8 frames strictly and bounds bytes before JSON parsing', async () => {
  const api = await load(); expect(api).not.toBeNull()
  const bytes = Buffer.from('{"text":"中文"}\n'), split = bytes.indexOf(Buffer.from('中')) + 1
  const decoder = new api!.SandboxFrameDecoder(100)
  expect(decoder.push(bytes.subarray(0, split))).toEqual([])
  expect(decoder.push(bytes.subarray(split))).toEqual([{ text: '中文' }])
  expect(() => decoder.push(Buffer.concat([Buffer.from('{"text":"'), Buffer.from([255]), Buffer.from('"}\n')]))).toThrow()
  expect(() => new api!.SandboxFrameDecoder(10).push(Buffer.alloc(11, 65))).toThrow('SANDBOX_PROTOCOL_TOO_LARGE')
})
it('rejects extra fields, duplicate exits, malformed status and false complete observations', async () => {
  const api = await load(); expect(api).not.toBeNull()
  const spawned = { version: 1, seq: 1, type: 'spawned', handleId: 'h', pid: 12, originalDigest: 'a'.repeat(64), effectiveDigest: 'b'.repeat(64) }
  const state = new api!.SandboxEventValidator('h'); state.accept(spawned)
  expect(() => state.accept({ version: 1, seq: 2, type: 'exit', code: '0', signal: null })).toThrow()
  const valid = new api!.SandboxEventValidator('h'); valid.accept(spawned); valid.accept({ version: 1, seq: 2, type: 'exit', code: 0, signal: null })
  expect(() => valid.accept({ version: 1, seq: 3, type: 'exit', code: 0, signal: null })).toThrow()
  const extra = new api!.SandboxEventValidator('h')
  expect(() => extra.accept({ ...spawned, collector: true })).toThrow()
  const incomplete = new api!.SandboxEventValidator('h'); incomplete.accept(spawned)
  expect(() => incomplete.accept({ version: 1, seq: 2, type: 'observation-end', complete: true })).toThrow()
})
