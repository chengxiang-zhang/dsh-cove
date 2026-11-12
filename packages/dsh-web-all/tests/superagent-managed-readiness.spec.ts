import { expect, it } from 'vitest'
import { request, createServer } from 'node:http'
import { managedWorkRoutes } from '../src/host/services/superagent/surface/managed-routes.ts'
it('serves loaded readiness only through the existing trust fence and only as GET', async () => {
  const readiness = { generation: 'loaded-instance', pid: 123, runtimeDigest: 'actual-method' }
  const port = { projects: () => [], readiness: () => readiness, enqueue: () => { throw Error('never') }, continue: () => {}, read: () => {} }
  const routes = managedWorkRoutes(port, request => request.headers.host === 'trusted.local' && request.headers['x-test-session'] === 'owner')
  const server = createServer((req,res) => { const route = routes.find(r => r.path === req.url); if (!route) {res.writeHead(404).end();return}; void route.handler(req,res) })
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve))
  try {
    const url = `http://127.0.0.1:${(server.address() as any).port}/superagent/managed/readiness`
    const fetch = (url: string, options: any = {}): Promise<{status: number; json(): Promise<unknown>}> => new Promise((resolve,reject) => { const r=request(url, options, res => { let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode!,json:async()=>JSON.parse(body)})) });r.on('error',reject);r.end() })
    for (const headers of [{host:'remote.invalid','x-test-session':'owner'}, {host:'trusted.local'}]) expect((await fetch(url,{headers})).status).toBe(403)
    const headers = {host:'trusted.local','x-test-session':'owner'}
    expect((await fetch(url,{headers,method:'POST'})).status).toBe(405)
    expect(await (await fetch(url,{headers})).json()).toEqual(readiness)
  } finally {await new Promise<void>(resolve => server.close(()=>resolve()))}
})

it('calibrates the actual collector once per loaded method and retains external observations', async () => {
  const { calibrateManagedMethod, managedLoadedIdentity } = await import('../src/host/services/superagent/managed-readiness.ts')
  const pending = calibrateManagedMethod('control.mjs')
  expect(calibrateManagedMethod('control.mjs')).toBe(pending)
  const result = await pending
  expect(result.runtimeDigest).toBe(managedLoadedIdentity().runtimeDigest)
  expect(result.results.map(r=>r.verdict)).toEqual(['pass','fail','inconclusive','pass'])
  expect(result.results.every(r=>Number.isSafeInteger(r.collectorPid)&&r.collectorPid!==process.pid)).toBe(true)
  expect(result.observations).toHaveLength(4)
}, 30000)

it('keeps pending owner input durable and blocks native launch on a mismatched qualification', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createManagedAdmission } = await import('../src/host/services/superagent/managed-runtime.ts')
  const root=mkdtempSync(join(tmpdir(),'readiness-admission-')),source=join(root,'source'),bootstrap=join(root,'bootstrap.json')
  mkdirSync(source);writeFileSync(join(source,'control.mjs'),'export function probe(){return true}')
  writeFileSync(bootstrap,JSON.stringify({root:join(root,'host'),defaultProject:'project',projects:{project:{projectRoot:source,publicFiles:['control.mjs'],implementationWritePaths:['control.mjs'],engine:{executable:'/must-not-launch',authFile:'/must-not-read',model:'fixture'},verification:{methodId:'javascript-module@1',settings:{entryPath:'control.mjs'},qualification:{runtimeDigest:'wrong',methodAssetsDigest:'wrong',expiresAt:Date.now()+60000,evidenceRefs:['fixture']}}}}}),{mode:0o600})
  const port=createManagedAdmission({bootstrapFile:bootstrap},()=>{})
  try {
    const result=port.message({requestId:'real-owner-event',text:'/work project requested work',origin:{kind:'trusted-host'}})
    expect(result.state).toBe('queued')
    expect(port.read('real-owner-event').request.text).toBe('requested work')
    await port.settle()
    expect(port.read('real-owner-event')).toMatchObject({state:'recovering',error:'MANAGED_VERIFICATION_NOT_READY'})
    expect(port.readiness()).toMatchObject({ready:false,projects:[{qualificationMatches:false}]})
  } finally {await port.dispose();rmSync(root,{recursive:true,force:true})}
},30000)

it('prevents a delayed native start when the host disposes during calibration', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createManagedAdmission } = await import('../src/host/services/superagent/managed-runtime.ts')
  const root=mkdtempSync(join(tmpdir(),'readiness-admission-')),source=join(root,'source'),bootstrap=join(root,'bootstrap.json')
  mkdirSync(source);writeFileSync(join(source,'dispose-control.mjs'),'export function probe(){return true}')
  writeFileSync(bootstrap,JSON.stringify({root:join(root,'host'),defaultProject:'project',projects:{project:{projectRoot:source,publicFiles:['dispose-control.mjs'],implementationWritePaths:['dispose-control.mjs'],engine:{executable:'/must-not-launch',authFile:'/must-not-read',model:'fixture'},verification:{methodId:'javascript-module@1',settings:{entryPath:'dispose-control.mjs'},qualification:{runtimeDigest:'wrong',methodAssetsDigest:'wrong',expiresAt:Date.now()+60000,evidenceRefs:['fixture']}}}}}),{mode:0o600})
  const port=createManagedAdmission({bootstrapFile:bootstrap},()=>{})
  try {
    const result=port.message({requestId:'real-owner-event',text:'/work project requested work',origin:{kind:'trusted-host'}})
    expect(result.state).toBe('queued')
    expect(port.read('real-owner-event').request.text).toBe('requested work')
    await new Promise(resolve => setTimeout(resolve, 10))
    await port.dispose()
    expect(port.read('real-owner-event')).toMatchObject({state:'recovering',error:'MANAGED_ADMISSION_DISPOSED'})
    expect(port.readiness()).toMatchObject({ready:false,projects:[{qualificationMatches:false}]})
  } finally {await port.dispose();rmSync(root,{recursive:true,force:true})}
},30000)
