import { Worker } from 'node:worker_threads'
import { fixtureHolderSource } from './sandbox-fixture-holder.ts'
import { createServer, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { chmodSync, realpathSync, writeFileSync, fstatSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { FixtureLeaseTable } from './sandbox-fixtures.ts'
import { fixturePreloadSource, fixturePreloadVersion } from './sandbox-fixture-preload.ts'

interface TCPHandle {
  readonly fd: number
  bind(address: string, port: number): number
  bind6(address: string, port: number, flags: number): number
  getsockname(result: { port?: number }): number
  listen(backlog: number): number
  close(): void
}
interface TCPBinding { TCP: new (kind: number) => TCPHandle; constants: { SERVER: number } }
interface Descriptor { readonly source: number; readonly target: number }
export interface OwnedFixtureResources { readonly version: typeof fixturePreloadVersion }
interface Resources { descriptors: readonly Descriptor[]; env: Readonly<Record<string, string>>; alive: () => boolean; activate: () => void }
const issuedResources = new WeakMap<OwnedFixtureResources, Resources>()
/** A JSON object or an arbitrary integer is never an inherited host descriptor capability. */
export function materializeFixtureResources(value: OwnedFixtureResources): Omit<Resources, 'alive' | 'activate'> {
  const resource = issuedResources.get(value)
  if (!resource || !resource.alive()) throw new Error('FIXTURE_RESOURCE_IDENTITY')
  resource.activate()
  for (const descriptor of resource.descriptors) if (!fstatSync(descriptor.source).isSocket()) throw new Error('FIXTURE_HOLDER_CLOSED')
  return { descriptors: resource.descriptors, env: resource.env }
}
function binding(): TCPBinding {
  if (process.platform !== 'darwin' || ![22, 24].includes(Number(process.versions.node.split('.')[0]))) throw new Error('FIXTURE_PLATFORM_UNQUALIFIED')
  // The fixed Node binding only reserves sockets. No listener callbacks run in the collector.
  return (process as unknown as { binding(name: string): TCPBinding }).binding('tcp_wrap')
}
function descriptorLimit(): number {
  const result = spawnSync('/bin/sh', ['-c', 'ulimit -Sn'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, timeout: 1000 })
  const text = result.stdout?.trim()
  if (result.status !== 0 || !text || !/^(?:\d+|unlimited)$/.test(text)) throw new Error('FIXTURE_DESCRIPTOR_LIMIT_UNKNOWN')
  return text === 'unlimited' ? Number.MAX_SAFE_INTEGER : Number(text)
}
export async function createSandboxFixturePool(options: {
  capacity: number; socketPath: string; preloadPath: string
  record: (event: Readonly<Record<string, unknown>>) => void
}) {
  const leases = new FixtureLeaseTable(options.capacity), tcp = binding(), limit = descriptorLimit()
  if (64 + options.capacity + 32 >= limit) throw new Error('FIXTURE_DESCRIPTOR_LIMIT')
  const ports: number[] = [], descriptors: Descriptor[] = [], connections = new Set<Socket>()
  let holder: Worker | undefined, holderAlive = false
  let retired = false, closed = false, activated = false, collectorFailed = false
  const record = (event: Record<string, unknown>): boolean => {
    if (collectorFailed) return false
    try { options.record(Object.freeze({ fixtureVersion: fixturePreloadVersion, ...event })); return true }
    catch { collectorFailed = true; retire(); return false }
  }
  const retire = () => { retired = true; leases.retire(); for (const socket of connections) socket.destroy() }
  const server = createServer(socket => {
    if (retired || connections.size >= options.capacity + 8) { socket.destroy(); return }
    connections.add(socket)
    const owner = randomUUID(); let buffer = Buffer.alloc(0), allocated = false, released = false
    const timer = setTimeout(() => socket.destroy(), 1000)
    socket.on('error', () => {})
    socket.on('data', bytes => {
      try {
        buffer = Buffer.concat([buffer, bytes]); if (buffer.length > 1024) throw new Error('FIXTURE_FRAME_LIMIT')
        let end: number
        while ((end = buffer.indexOf(10)) >= 0) {
          const m = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end))); buffer = buffer.subarray(end + 1)
          if (m?.version !== 1 || typeof m !== 'object') throw new Error('FIXTURE_FRAME_SCHEMA')
          if (!allocated && Object.keys(m).sort().join(',') === 'type,version' && m.type === 'allocate') {
            const lease = leases.allocate(owner); allocated = true; clearTimeout(timer)
            if (!record({ type: 'fixture-allocated', owner, index: lease.index, port: ports[lease.index] })) throw new Error('FIXTURE_COLLECTOR_UNAVAILABLE')
            socket.write(JSON.stringify({ version: 1, type: 'allocated', index: lease.index }) + '\n')
          } else if (allocated && !released && Object.keys(m).sort().join(',') === 'index,type,version' && m.type === 'release') {
            leases.release(owner, m.index); released = true
            record({ type: 'fixture-close-claimed', owner, index: m.index })
            socket.end(JSON.stringify({ version: 1, type: 'released', index: m.index }) + '\n')
          } else throw new Error('FIXTURE_FRAME_SEQUENCE')
        }
      } catch (error) {
        socket.end(JSON.stringify({ version: 1, type: 'refused', reason: (error as Error).message }) + '\n', () => socket.destroy())
      }
    })
    socket.once('close', () => {
      clearTimeout(timer); connections.delete(socket); leases.disconnected(owner)
      record({ type: 'fixture-channel-closed', owner, closeClaimed: released, descendants: 'unknown' })
    })
  })
  try {
    holder = new Worker(fixtureHolderSource, { eval: true, workerData: { capacity: options.capacity } })
    const slots = await new Promise<Array<{ port: number; ipv4: number; ipv6: number }>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('FIXTURE_HOLDER_TIMEOUT')), 2000)
      holder!.once('error', error => { clearTimeout(timeout); reject(error) })
      holder!.once('message', message => { clearTimeout(timeout); resolve(message.slots) })
    })
    holderAlive = true
    holder.on('error', () => { holderAlive = false; retire() })
    holder.on('exit', () => { holderAlive = false; retire() })
    for (const [index, slot] of slots.entries()) {
      if (![slot.ipv4, slot.ipv6].every(fd => Number.isSafeInteger(fd) && fd >= 0 && fd < limit - 16 && fstatSync(fd).isSocket())) throw new Error('FIXTURE_HOLDER_DESCRIPTOR')
      ports.push(slot.port); descriptors.push(Object.freeze({ source: slot.ipv4, target: 64 + index }))
    }
    writeFileSync(options.preloadPath, fixturePreloadSource, { flag: 'wx', mode: 0o400 })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.socketPath, () => { server.off('error', reject); resolve() }) })
    chmodSync(options.socketPath, 0o600)
  } catch (error) { await holder?.terminate(); server.close(); throw error }
  const resources = Object.freeze({ version: fixturePreloadVersion })
  issuedResources.set(resources, {
    descriptors: Object.freeze(descriptors), activate: () => { activated = true }, alive: () => holderAlive && !closed && !retired,
    env: Object.freeze({ NODE_OPTIONS: `--require=${realpathSync(options.preloadPath)}`, DSH_FIXTURE_SOCKET: options.socketPath, DSH_FIXTURE_FDS: JSON.stringify(descriptors.map(d => d.target)) }),
  })
  return Object.freeze({
    resources, socketPath: options.socketPath, ports: Object.freeze(ports), leases: () => leases.snapshot(), retire,
    async verifyReservations() {
      if (!holderAlive || closed) throw new Error('FIXTURE_HOLDER_LOST')
      return ports.flatMap(port => ([4, 6] as const).map(family => {
        const probe = new tcp.TCP(tcp.constants.SERVER)
        try { const bind = family === 4 ? probe.bind('127.0.0.1', port) : probe.bind6('::1', port, 1); const code = bind || probe.listen(1); return { port, family, held: code === -48, code } }
        finally { probe.close() }
      }))
    },
    async disposeUnused() {
      if (activated) throw new Error('FIXTURE_CESSATION_PROOF_UNAVAILABLE')
      if (closed) return
      retire(); closed = true
      await new Promise<void>(resolve => server.close(() => resolve()))
      await holder?.terminate()
      record({ type: 'fixture-pool-closed', leases: leases.snapshot(), descendants: 'unknown' })
    },
  })
}
