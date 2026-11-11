import { expect, it } from 'vitest'
import { ManagedLedger } from '../src/host/services/superagent/kernel/managed-ledger.ts'
import { createControlledKernel } from '../src/host/services/superagent/kernel/actions.ts'
it('requires trusted host mandate; owner/report cannot authorize out of scope', () => {
 const l = new ManagedLedger(':memory:')
 const k = createControlledKernel(l, { id: 'host:user', revision: 1 })
 expect(k.actions.authorizeAction({ id: 'missing', revision: 1 })).toMatchObject({ kind: 'denial' })
 expect('grantMandate' in k.actions).toBe(false)
 l.close()
})
import { afterEach } from 'vitest'
import { rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from './fixtures/superagent/controlled.ts'
const fixtures: ReturnType<typeof fixture>[] = []
const setup = () => { const f = fixture(); fixtures.push(f); return f }
afterEach(() => { for (const f of fixtures.splice(0)) { try { f.ledger.close() } catch {} rmSync(f.dir,{recursive:true,force:true}) } })
it('persists intent, requires locks, sends a real sandboxed process and persists its receipt', async () => {
 const f = setup(), a = f.k.actions.planAction(f.spec())
 expect(f.ledger.get(a.ref.id)?.data.state).toBe('planned')
 const e = f.k.actions.authorizeAction(a.ref); expect(e.kind).toBe('envelope'); if(e.kind !== 'envelope') return
 expect(await f.k.actions.execute(e.actionRef)).toMatchObject({kind:'denial',code:'RESOURCE_LEASE_REQUIRED'})
 f.k.actions.claimResources(e.actionRef,f.workspace.resources)
 const result = await f.k.actions.execute(e.actionRef)
 expect(result).toMatchObject({state:'confirmed',receipt:{stopped:true,status:'confirmed'}})
 expect(readFileSync(join(f.workspace.root,'result'),'utf8')).toBe('bounded\n')
 expect(f.ledger.get(a.ref.id)?.data.state).toBe('confirmed')
})
it('owner identity and worker reports cannot extend a mandate or forge confirmation', () => {
 const f=setup(); const a=f.k.actions.planAction({...f.spec(),kind:'deliver'})
 expect(f.k.actions.authorizeAction(a.ref)).toMatchObject({kind:'denial',code:'MANDATE_SCOPE'})
 expect(()=>f.ledger.controlled({kind:'host',token:{},source:f.sourceRef,command:{kind:'revoke_mandate',id:'mandate'}})).toThrow('HOST_ADMISSION_REQUIRED')
 const b=f.k.actions.planAction(f.spec('b')), e=f.k.actions.authorizeAction(b.ref); if(e.kind!=='envelope') throw Error('denied')
 f.k.actions.claimResources(e.actionRef,f.workspace.resources)
 const sent=f.ledger.controlled({kind:'send',ref:e.actionRef}) as {actionRef:{id:string;revision:number}}
 expect(()=>f.k.actions.recordActionResult(sent.actionRef,{status:'confirmed',stopped:true,evidenceRefs:['worker:ready']})).toThrow('TRUSTED_RECEIPT_REQUIRED')
})
it('invalidates authorization immediately when mandate/capability/requirement or epoch changes', async () => {
 for(const change of ['mandate','capability','requirement','epoch']) {
  const f=setup(), a=f.k.actions.planAction(f.spec()), e=f.k.actions.authorizeAction(a.ref); if(e.kind!=='envelope')throw Error('denied')
  f.k.actions.claimResources(e.actionRef,f.workspace.resources)
  if(change==='mandate')f.k.host.revokeMandate('mandate')
  if(change==='capability')f.k.host.revokeCapability('cap')
  if(change==='epoch')f.k.host.revokeControl({id:'target',revision:1},f.sourceRef)
  if(change==='requirement')f.ledger.transact([{id:'target',revision:1}],[{kind:'revise',id:'target',data:{...f.ledger.get('target')!.data,intent:'new'}}])
  expect(await f.k.actions.execute(e.actionRef)).toMatchObject({kind:'denial'})
 }
})
it('unknown receipt survives reopen, retains resources and prevents duplicate send/replacement', () => {
 const f=setup(), a=f.k.actions.planAction(f.spec()), e=f.k.actions.authorizeAction(a.ref);if(e.kind!=='envelope')throw Error('denied')
 f.k.actions.claimResources(e.actionRef,f.workspace.resources)
 const sent=f.ledger.controlled({kind:'send',ref:e.actionRef}) as {actionRef:{id:string;revision:number}}
 const unknown=f.k.actions.recordActionResult(sent.actionRef,{status:'unknown',stopped:false,evidenceRefs:[]})
 f.ledger.close(); const reopened=new ManagedLedger(f.path)
 expect(reopened.get(unknown.ref.id)?.data.state).toBe('unknown')
 const k=createControlledKernel(reopened,f.sourceRef), b=k.actions.planAction(f.spec('b'))
 expect(()=>k.actions.claimResources(b.ref,f.workspace.resources)).toThrow('RESOURCE_BUSY')
 expect(k.actions.authorizeAction(unknown.ref)).toMatchObject({kind:'denial',code:'ACTION_NOT_SENDABLE'})
 reopened.close()
})
import { DatabaseSync } from 'node:sqlite'
it('fails closed before spawn when the durable send event cannot be written',async()=>{
 const f=setup(),a=f.k.actions.planAction(f.spec()),e=f.k.actions.authorizeAction(a.ref);if(e.kind!=='envelope')throw Error('denied')
 f.k.actions.claimResources(e.actionRef,f.workspace.resources)
 const blocker=new DatabaseSync(f.path)
 blocker.exec("CREATE TRIGGER p2_test_readonly BEFORE INSERT ON sa_managed_event BEGIN SELECT RAISE(ABORT,'TEST_DATABASE_UNWRITABLE'); END")
 try{await expect(f.k.actions.execute(e.actionRef)).rejects.toThrow('TEST_DATABASE_UNWRITABLE');expect(f.ledger.get(a.ref.id)?.data.state).toBe('authorized')}
 finally{blocker.exec('DROP TRIGGER p2_test_readonly');blocker.close()}
})
it('keeps an isolated old write domain locked rather than pretending it has stopped',()=>{
 const f=setup(),a=f.k.actions.planAction(f.spec()),e=f.k.actions.authorizeAction(a.ref);if(e.kind!=='envelope')throw Error('denied')
 f.k.actions.claimResources(e.actionRef,f.workspace.resources)
 const sent=f.ledger.controlled({kind:'send',ref:e.actionRef}) as {actionRef:{id:string;revision:number}}
 expect(()=>f.k.host.reconcileAction(sent.actionRef,{status:'confirmed',stopped:true,evidenceRefs:['isolation:seal'],cessation:{kind:'isolated',evidenceRefs:['seal']}})).toThrow('INVALID_RECEIPT')
})
it('gives a trusted native adapter a durable send envelope and a live fence for each operation',()=>{
 const f=setup(),a=f.k.actions.planAction(f.spec()),e=f.k.actions.authorizeAction(a.ref);if(e.kind!=='envelope')throw Error('denied')
 f.k.actions.claimResources(e.actionRef,f.workspace.resources)
 const sent=f.k.host.beginDispatch(e.actionRef);expect(sent.kind).toBe('envelope');if(sent.kind!=='envelope')throw Error('denied')
 expect(f.ledger.get(a.ref.id)?.data.state).toBe('sent')
 expect(f.k.host.fenceDispatch(sent.actionRef).kind).toBe('envelope')
 f.k.host.revokeCapability('cap')
 expect(f.k.host.fenceDispatch(sent.actionRef)).toMatchObject({kind:'denial',code:'CAPABILITY_FENCE'})
})
