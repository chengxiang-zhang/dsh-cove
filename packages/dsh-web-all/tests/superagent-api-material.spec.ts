import {it,expect} from 'vitest'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {currentApiMaterial} from '../src/host/services/superagent/context/api-material.ts'
const hash=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex')
it.each(['complete','incomplete','cross-operation','stale-context','tampered-cases','mismatched-binding','lossy-raw','symlink'])('passes exact current API facts through to professional context: %s',scenario=>{
 const root=mkdtempSync(join(tmpdir(),'api-material-')),objects=new Map<string,any>(),ref=(id:string)=>({id,revision:1}),put=(id:string,kind:string,data:any)=>{const r=ref(id);objects.set(id,{...r,kind,data,scope_revision_refs:[],extensions:{}});return r}
 try{
  const contract=put('contract','acceptance_contract',{criterion_refs:[ref('C0')]}),work=put('work','commitment',{acceptance_contract:contract}),operation=put('op','coordination_operation',{proposal:{kind:'verify'},semantic_refs:[contract]}),assignment=put('assignment','verification_assignment',{commitment_id:'work',contract_ref:contract})
  const cases=[{criterion:'C0',input:{text:'401'},expected:'completed'}],bytes=JSON.stringify(cases);mkdirSync(join(root,'assets-fixture'));writeFileSync(join(root,'assets-fixture','cases.json'),bytes)
  const events=['baseline','candidate'].map((label,i)=>{const candidate=put(label,'candidate',{assignment_ref:assignment,digest:hash(label),manifest:[]}),context=put(label+'ctx','verification_context',{candidate_ref:candidate,run_id:label,asset_root:join(root,'assets-fixture'),asset_digest:hash(bytes),case_bindings:cases.map(t=>({criterion:t.criterion,digest:hash(JSON.stringify(t))}))}),evidence=put(label+'ev','verification_evidence',{context_ref:context,run_id:label,stdout:'complete actual stdout\n',stderr:'complete actual stderr\n',stdout_base64:Buffer.from('complete actual stdout\n').toString('base64'),stderr_base64:Buffer.from('complete actual stderr\n').toString('base64'),raw_digest:hash(label),complete:true,integrity:true,results:[{criterion:'C0',verdict:'fail'}]}),evaluation=put(label+'eval','evaluation',{commitment_id:'work',contract_ref:contract,candidate_ref:candidate,context_refs:[context],evidence_refs:[evidence],verdict:'fail'});return{sequence:10+i,body:{coordination:{payload:{kind:'runtime_event',event:'independent_api_verification',payload:{operationId:operation.id,label,candidate,context,evidence,evaluation,verdict:'fail'}}}}}})
  if(scenario==='incomplete')events.pop()
  if(scenario==='cross-operation'){put('op2','coordination_operation',{proposal:{kind:'verify'},semantic_refs:[contract]});events[1]!.body.coordination.payload.payload.operationId='op2'}
  if(scenario==='stale-context')objects.get('candidatectx').revision=2
  if(scenario==='tampered-cases')writeFileSync(join(root,'assets-fixture','cases.json'),'[]')
  if(scenario==='mismatched-binding')objects.get('candidatectx').data.case_bindings[0].digest='wrong'
  if(scenario==='lossy-raw')objects.get('candidateev').data.stdout_base64=Buffer.from([255]).toString('base64')
  if(scenario==='symlink'){rmSync(join(root,'assets-fixture','cases.json'));writeFileSync(join(root,'elsewhere'),bytes);symlinkSync(join(root,'elsewhere'),join(root,'assets-fixture','cases.json'))}
  const ledger={get:(id:string)=>objects.get(id),eventEntries:()=>events} as any
  if(['stale-context','tampered-cases','mismatched-binding','lossy-raw','symlink'].includes(scenario)){expect(()=>currentApiMaterial(ledger,work,root)).toThrow();return}
  const packet=currentApiMaterial(ledger,work,root);expect(packet).toBeDefined();expect(hash(packet!.text)).toBe(packet!.digest);const data=JSON.parse(packet!.text)
  expect(data.operation.id).toBe(scenario==='cross-operation'?'op2':'op');expect(data.runs).toHaveLength(scenario==='complete'?2:1);expect(data.status).toBe(scenario==='complete'?'complete-pair':'incomplete-pair')
  expect(data.runs[0].evidence.data.stdout).toBe('complete actual stdout\n');expect(data.runs[0].evidence.data.stderr).toBe('complete actual stderr\n');expect(data.runs[0].evidence.data.stdout_base64).toBeUndefined();expect(data.frozenCases).toEqual([{sha256:hash(bytes),cases}])
 }finally{rmSync(root,{recursive:true,force:true})}
})
