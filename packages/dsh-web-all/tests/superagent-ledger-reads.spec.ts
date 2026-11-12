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

it('indexes coordination reads without changing complete results or reopen behavior', () => {
 const root=mkdtempSync(join(tmpdir(),'coordination-reads-')),path=join(root,'ledger')
 let ledger=new ManagedLedger(path)
 let db=new DatabaseSync(path)
 try {
  // Represent an existing generation-2 ledger before the new read index.
  db.exec('DROP INDEX IF EXISTS sa_coordination_kind_read')
  const rows=[
   {coordination:{payload:{kind:'profile',input:{id:'p'}}},refs:[{id:'p',revision:2}]},
   {controlled:{kind:'host',command:{kind:'native',stream:'unrelated'}}},
   {coordination:{payload:{kind:'profile',input:{id:'p'}}},refs:[{id:'p',revision:1}]},
   {coordination:{payload:{kind:'runtime_event',event:'proof',payload:{value:1}}}},
   {coordination:{payload:{kind:'profile',input:{id:'other'}}},refs:[{id:'p',revision:2}]},
   {coordination:{payload:{kind:'profile',input:{id:'p'}}},refs:[{id:'p',revision:2}]},
   {coordination:{payload:{kind:'runtime_event',event:'other'}}},
   {coordination:{payload:{kind:'runtime_event',event:'proof',payload:{value:2}}}},
  ]
  rows.forEach((row,i)=>db.prepare('INSERT INTO sa_managed_event VALUES(?,?)').run(i+1,JSON.stringify(row)))
  const filters=[{profileRegistration:{id:'p',revision:2}},{runtimeEvent:'proof'}]
  const queries:string[]=[]
  const prepare=DatabaseSync.prototype.prepare
  const spy=vi.spyOn(DatabaseSync.prototype,'prepare').mockImplementation(function(this:DatabaseSync,sql:string) {
   if(sql.startsWith('SELECT sequence,body_json FROM sa_managed_event')) queries.push(sql)
   return prepare.call(this,sql)
  })
  let before:ReturnType<ManagedLedger['eventEntries']>[]
  try { before=filters.map(filter=>ledger.eventEntries(filter)) } finally {spy.mockRestore()}
  const args=[['p','p',2],['proof']]
  const plans=()=>queries.map((sql,i)=>db.prepare('EXPLAIN QUERY PLAN '+sql).all(...args[i]!).map(row=>String(row.detail)).join('\n'))
  expect(before.map(entries=>entries.map(entry=>entry.sequence))).toEqual([[1,6],[4,8]])
  expect(plans().every(plan=>plan.includes('SCAN sa_managed_event'))).toBe(true)
  const logicalBefore=db.prepare('SELECT sequence,body_json FROM sa_managed_event ORDER BY sequence').all()
  ledger.close(); ledger=new ManagedLedger(path); db.close(); db=new DatabaseSync(path)
  expect(plans().every(plan=>plan.includes('SEARCH sa_managed_event USING INDEX sa_coordination_kind_read'))).toBe(true)
  expect(filters.map(filter=>ledger.eventEntries(filter))).toEqual(before)
  expect(ledger.eventEntries({runtimeEvent:'proof',latest:true})).toEqual([before[1]![1]])
  ledger.close(); ledger=new ManagedLedger(path); db.close(); db=new DatabaseSync(path)
  expect(filters.map(filter=>ledger.eventEntries(filter))).toEqual(before)
  expect(plans().every(plan=>plan.includes('SEARCH sa_managed_event USING INDEX sa_coordination_kind_read'))).toBe(true)
  expect(db.prepare('SELECT sequence,body_json FROM sa_managed_event ORDER BY sequence').all()).toEqual(logicalBefore)
 } finally {db.close();ledger.close();rmSync(root,{recursive:true,force:true})}
})
