import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { createSandboxBroker, type SandboxBrokerGrant } from './sandbox-broker.ts'
import { detachedFixtureArgs, type SandboxLaunchRequest } from './sandbox-launch-port.ts'
/** Registered shapes for this repository's P2/P3 mechanism tests, always inside the fixed project domain. */
export async function createProjectQAGrants(base: Omit<SandboxBrokerGrant, 'socketPath' | 'admitLaunch'>, root: string, collector: string, node: string) {
  const fixture = join(root, '.qa-port-fixtures'); mkdirSync(join(fixture, 'inner'), { recursive: true }); writeFileSync(join(fixture, 'inner-negative'), 'INNER-CANARY')
  const canary = join(collector, 'collector-canary'); writeFileSync(canary, 'COLLECTOR-CANARY', { flag: 'wx', mode: 0o400 })
  const outputFixture = "const channel=process.argv[1];let sent=0;const timer=setInterval(()=>{process[channel].write(Buffer.alloc(32768,65));if(++sent===160)clearInterval(timer)},2)"
  const scripts = new Set(['for p in "$1" "$2"; do if [ -r "$p" ]; then IFS= read -r value < "$p"; printf "%s" "$value"; else printf denied; fi; printf "\\n"; done', 'while IFS= read -r line; do printf "%s\\n" "$line"; printf "%s\\n" "$line" >&2; done', 'printf "%s" "$1"', 'printf ready; while :; do :; done', 'printf disconnect-ready; read value', 'printf ready; read value', 'printf collector-fault'])
  const inside = (p: string) => { const rel = relative(root, p); return rel === '' || !rel.startsWith('..') && !isAbsolute(rel) }
  const runnerShape = (r: Readonly<SandboxLaunchRequest>): string | null => {
    if (!inside(r.cwd)) return null
    if (['/bin/sh', '/bin/bash'].includes(r.executable) && r.args[0] === '-c' && r.args.length <= 8) return 'qa:p2-shell-fixture'
    if (r.executable === '/usr/bin/perl' && r.args.length === 2 && r.args[0] === '-e') return 'qa:p3-perl-byte-fixture'
    if (r.executable === node && r.args[0] === '-e' && r.args.length <= 8) return 'qa:p3-node-fixture'
    if (r.executable === node && r.args.length <= 8 && isAbsolute(r.args[0] ?? '') && inside(r.args[0]!) && /\.(?:js|cjs|mjs)$/.test(r.args[0]!)) return 'qa:sealed-node-fixture'
    return null
  }
  const detachedShape = (r: Readonly<SandboxLaunchRequest>, timeout: number): string | null => {

    return inside(r.cwd) && r.executable === '/usr/bin/perl' && r.processPolicy === 'children' && r.timeoutMs === timeout && JSON.stringify(r.args) === JSON.stringify(detachedFixtureArgs(r.cwd)) ? 'qa:fixed-detached-fixture' : null
  }
  const brokers: Awaited<ReturnType<typeof createSandboxBroker>>[] = [], scopes: Record<string, Awaited<ReturnType<typeof createSandboxBroker>>['address']> = {}
  for (const [index, scope] of ['runner', 'default', 'legacy-disconnect', 'r1', 'r1-recovered', 'stdout-overflow', 'stderr-overflow', 'collector-fault', 'detached-timeout', 'detached-cancel'].entries()) {
    const detached = scope.startsWith('detached-'), fault = scope !== 'runner' && !detached
    const broker = await createSandboxBroker({ ...base, runId: base.runId + ':' + scope, epoch: scope === 'r1-recovered' ? 2 : 1, socketPath: join(collector, 'qa' + index + '.sock'), directoryEnvironmentNames: fault ? [] : ['NATIVE_STATE'], maxConcurrent: detached ? 1 : fault ? 8 : 64, maxLaunches: detached ? 1 : fault ? 64 : 4096, ...(fault ? { fixtureResources: undefined, launchEnvironment: undefined } : {}), admitLaunch: detached ? r => detachedShape(r, scope === 'detached-timeout' ? 100 : 2000) : fault ? r => r.executable === node && JSON.stringify(r.args) === JSON.stringify(['-e', outputFixture, r.args[2]]) && ['stdout', 'stderr'].includes(r.args[2]!) ? 'fixture:slow-output' : r.executable === '/bin/bash' && r.args[0] === '-c' && scripts.has(r.args[1]!) ? 'fixture:registered-shell' : null : runnerShape,
      record: event => { if (scope === 'collector-fault' && event.type === 'admitted') throw new Error('FIXTURE_COLLECTOR_UNAVAILABLE'); base.record({ qaScope: scope, ...event }) },
    })
    brokers.push(broker); scopes[scope] = broker.address
  }
  const socketPaths = [...brokers.map(b => b.address.socketPath), join(collector, 'missing.sock')]
  const q = JSON.stringify, preload = join(collector, 'fixture.cjs'), allocator = join(collector, 'allocator.sock')
  const profile = `(allow file-read* (literal ${q(preload)}))(allow file-read-metadata ${[...base.domain.metadataPaths,collector,allocator].map(p=>`(literal ${q(p)})`).join(' ')})(allow signal (target self) (target children))`
  return { socketPaths, profile, environment: { DSH_QA_SANDBOX_BROKER: JSON.stringify(scopes.runner), DSH_QA_SANDBOX_ROUTES: JSON.stringify({ 'detached-timeout': scopes['detached-timeout'], 'detached-cancel': scopes['detached-cancel'] }), DSH_QA_SANDBOX_PROFILE: profile, DSH_VERIFICATION_BROKER: JSON.stringify({ ...scopes.default, scopes, root: fixture, node, outputFixture, collector: canary, missingSocket: socketPaths.at(-1) }) }, close: async () => { for (const broker of brokers) await broker.close() } }
}
