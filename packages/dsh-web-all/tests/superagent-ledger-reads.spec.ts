import { expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedLedger } from '../src/host/services/superagent/kernel/managed-ledger.ts'
import { latestFrameworkBaseline } from '../src/host/services/superagent/managed-runtime.ts'
import { createControlledKernel } from '../src/host/services/superagent/kernel/actions.ts'

it('reads exact recovery facts and ordered refs without parsing unrelated native history', () => {
 const root=mkdtempSync(join(tmpdir(),'ledger-reads-')),path=join(root,'ledger'),ledger=new ManagedLedger(path),db=new DatabaseSync(path)
 const native=(stream:string,observation:unknown)=>({controlled:{kind:'host',command:{kind:'native',stream,observation}}})
 const rows=[native('s',{kind:'rpc',message:{result:'UNRELATED_LARGE_RPC'.repeat(100000)}}),
  {coordination:{payload:{kind:'runtime_event',event:'framework_baseline_bound',payload:{head:'first'}}}},
  {controlled:{kind:'host',command:{kind:'workspace',workspace:{root:'/exact',role:'collector'}}}},
  native('s',{kind:'input-intent',binding:'bound',input:{request_id:'r'}}),native('foreign',{kind:'request',request:{id:'foreign'}}),
  native('s',{kind:'request',request:{id:'exact'}}),native('s',{kind:'rpc',message:{method:'turn/started',params:{turn:{id:'t'}}}}),
  {coordination:{payload:{kind:'runtime_event',event:'framework_baseline_bound',payload:{head:'last'}}}},
  {coordination:{payload:{kind:'profile',input:{id:'p'}}},refs:[{id:'p',revision:2}]},
  {delivery:'fulfilled',step:{ref:{id:'step',revision:3}}}]
 rows.forEach((v,i)=>db.prepare('INSERT INTO sa_managed_event VALUES(?,?)').run(i+1,JSON.stringify(v)))
 const parse=JSON.parse,spy=vi.spyOn(JSON,'parse').mockImplementation((text,...args)=>{if(String(text).includes('UNRELATED_LARGE_RPC'))throw Error('UNRELATED_HISTORY_MATERIALIZED');return parse(text,...args)})
 try {
  expect(latestFrameworkBaseline(ledger)).toEqual({head:'last'})
  expect(ledger.eventEntries({workspaceRoot:'/exact'}).map(x=>x.sequence)).toEqual([3])
  expect(ledger.eventEntries({workspaceRole:'collector'}).map(x=>x.sequence)).toEqual([3])
  expect(ledger.eventEntries({profileRegistration:{id:'p',revision:2}})).toHaveLength(1)
  expect(ledger.eventEntries({profileRegistration:{id:'p',revision:1}})).toHaveLength(0)
  expect(ledger.eventEntries({deliveryStep:{id:'step',revision:3}})).toHaveLength(1)
  expect(ledger.eventEntries({deliveryStep:{id:'step',revision:2}})).toHaveLength(0)
  const k=createControlledKernel(ledger,{id:'host',revision:1})
  expect(k.host.nativeFactRefs('s')).toEqual(['native-event:1','native-event:4','native-event:6','native-event:7'])
  expect(k.host.nativeRecoveryFacts('s').map(x=>x.ref)).toEqual(['native-event:4','native-event:6','native-event:7'])
  expect(k.host.nativeFacts('s','input-intent')).toHaveLength(1)
  expect(k.host.nativeFacts('s',undefined,6).map(x=>x.ref)).toEqual(['native-event:7'])
 } finally {spy.mockRestore();db.close();ledger.close();rmSync(root,{recursive:true,force:true})}
})
