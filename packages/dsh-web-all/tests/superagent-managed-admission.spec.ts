import { createHash } from 'node:crypto'
import { loadManagedMaterials } from '../src/host/services/superagent/executors/managed-materials.ts'
import { afterEach, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagedAdmission } from '../src/host/services/superagent/managed-runtime.ts'
import { managedWorkRoutes } from '../src/host/services/superagent/surface/managed-routes.ts'
const cleanup: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
it('durably admits once before native work, preserves failure evidence, and shares the trusted HTTP entrance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'managed-admission-')), source = join(dir, 'source'), root = join(dir, 'host'); mkdirSync(source); writeFileSync(join(source, 'input.ts'), 'export const value = 1')
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const bootstrap = join(dir, 'bootstrap.json')
  writeFileSync(bootstrap, JSON.stringify({ root, defaultProject: 'project', projects: { project: { projectRoot: source, publicFiles: ['input.ts'], implementationWritePaths: ['input.ts'], engine: { executable: '/never-execute-fixture', authFile: join(dir, 'absent-auth'), model: 'fixture' } } } }), { mode: 0o600 })
  const results: string[] = [], port = createManagedAdmission({ bootstrapFile: bootstrap }, (_request, result) => results.push(result.state)); cleanup.push(() => port.dispose())
  const request = { requestId: 'owner-message', text: 'Implement the requested behavior', origin: { kind: 'trusted-host' as const } }
  expect(port.enqueue(request)).toMatchObject({ state: 'queued', duplicate: false })
  expect(port.read(request.requestId).state).toBe('queued')
  expect(port.enqueue(request)).toMatchObject({ duplicate: true })
  expect(() => port.enqueue({ ...request, text: 'different request under the same id' })).toThrow('MANAGED_ADMISSION_CONFLICT')
  await port.settle()
  expect(port.read(request.requestId)).toMatchObject({ state: 'recovering', error: expect.stringContaining('ENOENT') })
  expect(results).toEqual([]); expect(readdirSync(join(root, 'jobs'))).toHaveLength(1)
  const routes = managedWorkRoutes(port, request => request.headers['x-test-owner'] === 'yes')
  const server = createServer((request, response) => { const route = routes.find(route => route.path === request.url); if (!route) { response.writeHead(404).end(); return }; void route.handler(request, response) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address() as { port: number }, url = `http://127.0.0.1:${address.port}/superagent/managed/`
  expect((await fetch(url + 'projects')).status).toBe(403)
  expect(await (await fetch(url + 'projects', { headers: { 'x-test-owner': 'yes' } })).json()).toMatchObject([{ id: 'project' }])
  const duplicate = await fetch(url + 'intake', { method: 'POST', headers: { 'x-test-owner': 'yes' }, body: JSON.stringify({ requestId: request.requestId, text: request.text }) })
  expect(duplicate.status).toBe(202); expect(await duplicate.json()).toMatchObject({ duplicate: true })
  const injection = await fetch(url + 'intake', { method: 'POST', headers: { 'x-test-owner': 'yes' }, body: JSON.stringify({ requestId: 'other', text: 'request', engine: { executable: '/bin/sh' } }) })
  expect(injection.status).toBe(400)
  const continuation = { requestId: request.requestId, continuationId: 'material-v1', text: 'Continue the same work with host materials' }
  const denied = await fetch(url + 'continue', { method: 'POST', body: JSON.stringify(continuation) })
  expect(denied.status).toBe(403)
  const forged = await fetch(url + 'continue', { method: 'POST', headers: { 'x-test-owner': 'yes' }, body: JSON.stringify({ ...continuation, trusted: true, materialPath: '/private/input' }) })
  expect(forged.status).toBe(400)
  const prior = port.read(request.requestId) as any
  expect(port.continue(continuation.requestId, continuation.continuationId, continuation.text)).toMatchObject({ state: 'queued', duplicate: false })
  expect(port.continue(continuation.requestId, continuation.continuationId, continuation.text)).toMatchObject({ duplicate: true })
  expect(() => port.continue(continuation.requestId, continuation.continuationId, 'changed')).toThrow('MANAGED_CONTINUATION_CONFLICT')
  expect(() => port.continue(continuation.requestId, 'second-version', continuation.text)).toThrow('MANAGED_CONTINUATION_NOT_READY')
  await port.settle()
  const resumed = port.read(request.requestId) as any
  expect(resumed.request).toEqual(prior.request)
  expect(resumed.runtimeRoot).toBe(prior.runtimeRoot)
  expect(resumed.priorOutcome.error).toBe(prior.error)
  expect(resumed.continuations).toHaveLength(1)
  expect(resumed.state).toBe('recovering')
  expect(readdirSync(join(root, 'jobs'))).toHaveLength(1)
  expect(readFileSync(bootstrap, 'utf8')).not.toContain('token')
})

it('keeps unconfigured host bootstraps absent after the real web-all schema parses config', async () => {
  const { Config } = await import('../src/index.ts')
  const empty = (Config as any)({})
  expect(empty.managedWork).toBeUndefined()
  expect(empty.nativeExecutors).toBeUndefined()
  const configured = (Config as any)({ managedWork: { bootstrapFile: '/host/private.json' } })
  expect(configured.managedWork).toEqual({ bootstrapFile: '/host/private.json' })
  expect(configured.nativeExecutors).toBeUndefined()
})


it('binds read-only host materials to exact source hashes and rejects drift', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'managed-materials-'))), path = join(dir, 'source.txt')
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(path, 'protocol evidence')
  const entries = [{ id: 'protocol', path, sha256: createHash('sha256').update('protocol evidence').digest('hex'), source: 'official local schema@version' }]
  const loaded = loadManagedMaterials(entries)
  expect(loaded.materials).toEqual([{ id: 'protocol', source: entries[0]!.source, sha256: entries[0]!.sha256, text: 'protocol evidence' }])
  expect(loadManagedMaterials(entries).digest).toBe(loaded.digest)
  writeFileSync(path, 'changed evidence')
  expect(() => loadManagedMaterials(entries)).toThrow('MANAGED_MATERIAL_CHANGED')
})


it('re-enters a host-interrupted admission through the same continuation preflight, preserving its prior outcome', async () => {
 const dir=mkdtempSync(join(tmpdir(),'managed-recovery-')),root=join(dir,'host'),requests=join(root,'requests'),runtimeRoot=join(root,'jobs','same-job'),bootstrap=join(dir,'bootstrap.json')
 mkdirSync(requests,{recursive:true});mkdirSync(runtimeRoot,{recursive:true})
 cleanup.push(()=>rmSync(dir,{recursive:true,force:true}))
 const request={requestId:'interrupted',project:'p',text:'Original requirement',origin:{kind:'trusted-host'}}
 writeFileSync(join(requests,createHash('sha256').update(request.requestId).digest('hex')+'.json'),JSON.stringify({request,state:'running',runtimeRoot,result:{old:'preserved'}}))
 writeFileSync(bootstrap,JSON.stringify({root,defaultProject:'p',projects:{p:{projectRoot:join(dir,'missing-source'),publicFiles:['input.ts'],implementationWritePaths:['input.ts'],engine:{executable:'/never-execute',authFile:join(dir,'absent'),model:'fixture'}}}}),{mode:0o600})
 const port=createManagedAdmission({bootstrapFile:bootstrap},()=>{});cleanup.push(()=>port.dispose())
 expect(port.read(request.requestId).state).toBe('needs-reconciliation')
 expect(port.continue(request.requestId,'exact-recovery','Continue original work')).toMatchObject({state:'queued',duplicate:false})
 await port.settle()
 const final=port.read(request.requestId) as any
 expect(final).toMatchObject({state:'recovering',request,runtimeRoot,priorOutcome:{state:'needs-reconciliation',result:{old:'preserved'}}})
 expect(final.error).toBeTruthy()
 expect(readdirSync(join(root,'jobs'))).toEqual(['same-job'])
})
