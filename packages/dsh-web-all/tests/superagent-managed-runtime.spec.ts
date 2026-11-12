import { expect, it } from 'vitest'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedLedger } from '../src/host/services/superagent/kernel/managed-ledger.ts'
import { createCoordinationService } from '../src/host/services/superagent/coordination/intake.ts'
import { createProposalInterpreter } from '../src/host/services/superagent/coordination/interpreter.ts'

it('persists proposal intent before dispatch and never repeats an unknown side effect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p5-runtime-')), ledger = new ManagedLedger(join(root, 'ledger'))
  try {
    const coordination = createCoordinationService(ledger, { id: 'authenticated-test-host', revision: 1 })
    let calls = 0
    const interpreter = createProposalInterpreter(ledger, coordination, async () => {
      calls++
      expect(ledger.snapshot().some(o => o.kind === 'coordination_runtime_event' && o.data.event === 'proposal_started')).toBe(true)
      throw Error('process outcome unknown')
    })
    await expect(interpreter.apply('native-input:1', [{ kind: 'dispatch', role: 'implementation', instruction: 'inspect actual source' }], [])).rejects.toThrow('process outcome unknown')
    expect(await interpreter.apply('native-input:1', [{ kind: 'dispatch', role: 'implementation', instruction: 'inspect actual source' }], [])).toMatchObject([{ status: 'unknown' }])
    expect(calls).toBe(1)
    expect(ledger.snapshot().some(o => o.data.event === 'proposal_unknown')).toBe(true)
  } finally { ledger.close(); rmSync(root, { recursive: true, force: true }) }
})

it('bounds native session duration by a host-only declared capability instead of the fixed helper timeout', async () => {
  const { fixture } = await import('./fixtures/superagent/controlled.ts')
  const f = fixture()
  try {
    const base = f.spec('long-native')
    expect(() => f.k.actions.planAction({ ...base, timeoutMs: 180000 })).toThrow()
    f.k.host.grantCapability({ id: 'native-duration', revision: 1, expiresAt: Date.now()+240000, scopeRefs: [], evidenceRefs: ['qualified-native'], externalTools: 'blocked', revoked: false, launch: { executable: base.executable, args: base.args, processPolicy: 'single' }, nativeRuntime: { root: realpathSync(f.dir), stateDirectoryVariable: 'NATIVE_STATE', network: 'engine-transport', evidenceRefs: ['qualified-restricted-runtime'], maxProcessMs: 180000 } } as never)
    expect(f.k.actions.planAction({ ...base, capabilityRef: { id: 'native-duration', revision: 1 }, timeoutMs: 180000 }).state).toBe('planned')
    expect(() => f.k.actions.planAction({ ...base, id: 'over-limit', capabilityRef: { id: 'native-duration', revision: 1 }, timeoutMs: 180001 })).toThrow()
  } finally { f.ledger.close(); rmSync(f.dir, { recursive: true, force: true }) }
})

it('does not confuse permission to begin implementation with final API verification', async () => {
  const { intakeReadiness } = await import('../src/host/services/superagent/managed-runtime.ts')
  expect(intakeReadiness({ purpose: 'intake', intake_readiness: 'ready', verdict: 'inconclusive', reason: 'Requirements approved; behavior tests pending', cases: [] })).toBe('pass')
  expect(intakeReadiness({ purpose: 'intake', intake_readiness: 'blocked', verdict: 'pass', reason: 'Scope unclear', cases: [] })).toBe('inconclusive')
  expect(() => intakeReadiness({ verdict: 'pass' })).toThrow()
})

it('refuses writes outside the host allocated role paths before any helper dispatch', async () => {
  const { ControlledFileTools } = await import('../src/host/services/superagent/executors/native/tools.ts')
  const f = (await import('./fixtures/superagent/controlled.ts')).fixture()
  try {
    const planned = f.k.actions.planAction(f.spec()); f.k.actions.claimResources(planned.ref, f.workspace.resources)
    const launch = f.k.host.beginDispatch(planned.ref); if (launch.kind === 'denial') throw Error(launch.code)
    const tool = new ControlledFileTools(f.k, launch, process.execPath, { writePaths: ['permitted.ts'] })
    expect(await tool.call('write', { path: 'other.ts', content: 'unauthorized change' })).toEqual({ success: false, text: 'ROLE_WRITE_PATH_DENIED' })
    const readOnly = new ControlledFileTools(f.k, launch, process.execPath, { writePaths: [] })
    expect(await readOnly.call('write', { path: 'permitted.ts', content: 'qa cannot edit implementation' })).toEqual({ success: false, text: 'ROLE_WRITE_PATH_DENIED' })
  } finally { f.ledger.close(); rmSync(f.dir, { recursive: true, force: true }) }
})

it('the fixed replay uses a provenance-checked historical negative control and the current adapter ordinary-success control', async () => {
  const { CODEX_REPLAY } = await import('../src/host/services/superagent/executors/codex-replay.ts')
  const { writeFileSync, mkdirSync, copyFileSync, readFileSync } = await import('node:fs')
  const { createHash } = await import('node:crypto')
  const { pathToFileURL } = await import('node:url')
  const root = mkdtempSync(join(tmpdir(), 'p5-replay-'))
  try {
    const files = ['host/services/external-session/providers/codex.ts', 'core/external-session/adapters.ts', 'core/external-session/errors.ts', 'core/external-session/types.ts']
    const historical = join(process.cwd(), 'tests/fixtures/superagent/verification-parser-history')
    const provenance = JSON.parse(readFileSync(join(historical, 'provenance.json'), 'utf8')) as {
      baseCommit: string; captureSha256: string; sourceFiles: { path: string; sha256: string }[]
    }
    expect(provenance.baseCommit).toBe('ffdf44c58024470f2027e9a5bed81ef165fd6a89')
    expect(provenance.sourceFiles.map(file => file.path).sort()).toEqual(files.map(file => `src/${file}`).sort())
    for (const file of provenance.sourceFiles) {
      expect(createHash('sha256').update(readFileSync(join(historical, file.path))).digest('hex')).toBe(file.sha256)
    }
    expect(provenance.sourceFiles[0]?.sha256).toBe('43838ffe7c0cbb3eeba4b4ad8039e1812cc3c61ef5262146982229b7fbafdca2')
    expect(createHash('sha256').update(readFileSync(join(historical, 'captured-success.jsonl'))).digest('hex')).toBe(provenance.captureSha256)
    const loadReplay = async (name: string, source: string) => {
      const candidateRoot = join(root, name)
      for (const file of files) {
        const to = join(candidateRoot, 'packages/dsh-web-all/src', file)
        mkdirSync(join(to, '..'), { recursive: true }); copyFileSync(join(source, file), to)
      }
      const entry = join(candidateRoot, 'candidate.mjs'); writeFileSync(entry, CODEX_REPLAY)
      return await import(pathToFileURL(entry).href)
    }
    const replay = await loadReplay('historical', join(historical, 'src'))
    const current = await loadReplay('current', join(process.cwd(), 'src'))
    const stdout = (answer: string) => [{type:'thread.started',thread_id:'same-native-session'},{type:'item.completed',item:{type:'agent_message',text:answer}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}].map(JSON.stringify).join('\n')+'\n'
    const steps = (answer: string) => [{stdout:stdout(answer),stderr:'',exitCode:0,providerSessionId:null,continuePrevious:false}]
    expect(await replay.inspect({steps:steps('ordinary answer'),fields:['status','result']})).toEqual([['completed','ordinary answer']])
    expect(await current.inspect({steps:steps('ordinary answer'),fields:['status','result']})).toEqual([['completed','ordinary answer']])
    expect(await replay.inspect({steps:steps('401 explains authentication'),fields:['status','result','errorTag']})).toEqual([['failed','','auth-required']])
    await expect(replay.inspect({steps:steps('ok'),fields:[]})).rejects.toThrow('REPLAY_ASSERTION_FIELDS_REQUIRED')
  } finally { rmSync(root,{recursive:true,force:true}) }
})

it('retains one stable native consumption proof while repeated unchanged history polls add no duplicate page fact', async () => {
  const { CodexNativeExecutor } = await import('../src/host/services/superagent/executors/engines/codex.ts')
  const { encodeInput } = await import('../src/host/services/superagent/executors/native/bindings.ts')
  const { createHash } = await import('node:crypto')
  const input={request_id:'same-input',assignment_revision:1,text:'actual full payload',payload_ref:'context',payload_digest:createHash('sha256').update('actual full payload').digest('hex')}
  const observations: any[]=[]
  const io={launch:{epoch:1,actionRef:{id:'launch',revision:1}},generation:'generation',stream:'stream',kernel:{host:{nativeFacts:()=>[],nativeRecoveryFacts:()=>[]}},onMessage:()=>{},observe:(v:any)=>{observations.push(v);return 'native-event:'+observations.length},call:async()=>({data:[{id:'turn',status:'completed',startedAt:1,items:[{type:'userMessage',content:[{type:'text',text:encodeInput(input)}]}]}]})}
  const engine=new (CodexNativeExecutor as any)(io,{hostRef:'host',engineRef:'codex',runtimeNamespace:'private'},'same-thread')
  const first=await engine.receiptFor(input),second=await engine.receiptFor(input)
  expect(first.status).toBe('consumed'); expect(second).toEqual(first)
  expect(observations.filter(o=>o.kind==='turn-page')).toHaveLength(1)
  expect(observations.filter(o=>o.kind==='input-consumed')).toHaveLength(1)
})

it('fences unresolved role effects across input ids, wording, reopen and overlapping host domains', async () => {
  const { appendFileSync, readFileSync } = await import('node:fs')
  const root=mkdtempSync(join(tmpdir(),'p5-operation-')), path=join(root,'ledger'), effect=join(root,'effect')
  let ledger=new ManagedLedger(path)
  const proposal=(instruction='write one change')=>({kind:'dispatch',role:'implementation',instruction})
  const options={domains:()=>['seat:implementation','resource:candidate']}
  const execute=async (_:unknown,key:string)=>{appendFileSync(effect,key+'\n');throw Error('lost after effect')}
  try {
    let interpreter=createProposalInterpreter(ledger,createCoordinationService(ledger,{id:'host',revision:1}),execute,options)
    await expect(interpreter.apply('first',[proposal()],[])).rejects.toThrow('lost after effect')
    expect(await interpreter.apply('first',[proposal()],[])).toMatchObject([{status:'unknown'}])
    expect(await interpreter.apply('next',[proposal('rephrase and try another repair')],[])).toMatchObject([{status:'unknown'}])
    ledger.close();ledger=new ManagedLedger(path)
    interpreter=createProposalInterpreter(ledger,createCoordinationService(ledger,{id:'host',revision:1}),execute,options)
    expect(await interpreter.apply('after-reopen',[proposal()],[])).toMatchObject([{status:'unknown'}])
    expect(readFileSync(effect,'utf8').trim().split('\n')).toHaveLength(1)
    let independentCalls=0
    const other=createProposalInterpreter(ledger,createCoordinationService(ledger,{id:'host',revision:1}),async()=>{independentCalls++;return null},{domains:()=>['seat:quality','resource:separate-qa']})
    await other.apply('independent',[proposal()],[]);expect(independentCalls).toBe(1)
    expect(await other.apply('callback-return-is-not-proof',[proposal()],[])).toMatchObject([{status:'unknown'}]);expect(independentCalls).toBe(1)
    const overlap=createProposalInterpreter(ledger,createCoordinationService(ledger,{id:'host',revision:1}),execute,{domains:()=>['seat:new-assignment','resource:candidate']})
    expect(await overlap.apply('different-seat-same-resource',[proposal()],[])).toMatchObject([{status:'unknown'}])
  } finally {ledger.close();rmSync(root,{recursive:true,force:true})}
})

it('atomically claims an effect domain before awaiting execution but leaves read-only diagnosis available', async()=>{
 const root=mkdtempSync(join(tmpdir(),'p5-concurrent-')),ledger=new ManagedLedger(join(root,'ledger'))
 try {
  let finish!:()=>void,calls=0
  const running=new Promise<void>(resolve=>{finish=resolve})
  const interpreter=createProposalInterpreter(ledger,createCoordinationService(ledger,{id:'host',revision:1}),async()=>{calls++;await running;throw Error('unknown')},{domains:p=>(p as any).kind==='dispatch'?['seat:one']:undefined})
  const first=interpreter.apply('one',[{kind:'dispatch'}],[]);void first.catch(()=>{})
  expect(await interpreter.apply('two',[{kind:'dispatch'}],[])).toMatchObject([{status:'unknown'}]);expect(calls).toBe(1)
  finish();await expect(first).rejects.toThrow('unknown')
  const look=createProposalInterpreter(ledger,createCoordinationService(ledger,{id:'host',revision:1}),async()=>({status:'observed'}),{domains:()=>undefined})
  expect(await look.apply('look',[{kind:'look'}],[])).toEqual([{status:'observed'}])
 }finally{ledger.close();rmSync(root,{recursive:true,force:true})}
})

it('reconciles a lost callback using its bound actual controlled receipt, then permits legitimate new work', async()=>{
 const {readFileSync}=await import('node:fs'),f=(await import('./fixtures/superagent/controlled.ts')).fixture()
 const service=createCoordinationService(f.ledger,f.sourceRef);let executions=0,lost=true
 const current=(id:string)=>{const o=f.ledger.get(id)!;return {id:o.id,revision:o.revision}}
 const interpreter=createProposalInterpreter(f.ledger,service,async(_p,key)=>{
  const action=f.k.actions.planAction(f.spec('effect-'+(++executions)))
  service.host.bindOperationExecution(current(key),{kind:'controlled',slot:'write',action:action.ref})
  expect(()=>service.host.completeOperation(current(key),{status:'claimed-success'},[])).toThrow('OPERATION_CONTROLLED_OUTCOME_UNKNOWN')
  f.k.actions.claimResources(action.ref,f.workspace.resources)
  expect(await f.k.actions.execute(action.ref)).toMatchObject({receipt:{status:'confirmed',stopped:true}})
  if(lost)throw Error('lost host callback after actual write')
  service.host.completeOperation(current(key),{status:'completed'},[]);return {status:'completed'}
 },{domains:()=>f.workspace.resources.map(id=>'resource:'+id),executionSlots:()=>['write']})
 try {
  const proposal={kind:'dispatch',instruction:'write bounded result'}
  await expect(interpreter.apply('first',[proposal],[])).rejects.toThrow('lost host callback')
  expect(readFileSync(join(f.workspace.root,'result'),'utf8')).toBe('bounded\n')
  expect(await interpreter.apply('new-turn',[proposal],[])).toMatchObject([{status:'unknown'}]);expect(executions).toBe(1)
  const operation=f.ledger.snapshot('coordination_operation')[0]!
  service.host.completeOperation(current(operation.id),{status:'reconciled-from-actual-receipt'},[])
  const separate=service.host.claimOperation({id:'unrelated-proof',inputRef:'another',proposal:{kind:'dispatch'},domainKeys:['resource:elsewhere'],scopeRefs:[],executionSlots:['old']})
  expect(()=>service.host.bindOperationExecution(separate,{kind:'controlled',slot:'old',action:{id:'effect-1',revision:f.ledger.get('effect-1')!.revision}})).toThrow('OPERATION_ACTION_ALREADY_STARTED')
  expect(await interpreter.apply('first',[proposal],[])).toEqual([{status:'reconciled-from-actual-receipt'}])
  lost=false;expect(await interpreter.apply('legitimate-next-work',[proposal],[])).toEqual([{status:'completed'}]);expect(executions).toBe(2)
 }finally{f.ledger.close();rmSync(f.dir,{recursive:true,force:true})}
})

it('binds the actual native dispatch input to one operation/context and rejects unrelated completion evidence', async()=>{
 const f=(await import('./fixtures/superagent/controlled.ts')).fixture(),service=createCoordinationService(f.ledger,f.sourceRef)
 const {createContextCompiler}=await import('../src/host/services/superagent/context/compile.ts')
 const {runManagedOperationTurn}=await import('../src/host/services/superagent/managed-runtime.ts')
 const {encodeInput}=await import('../src/host/services/superagent/executors/native/bindings.ts')
 try {
  const host=service.host.registerHost({id:'host:native-op',authority:'fixture',evidenceRefs:['fixture']})
  const project=service.host.registerProject({id:'project:native-op',intent:'test',repositoryIdentity:f.workspace.repositoryId,hosts:[host],sourceRefs:[f.sourceRef]})
  const policy=service.host.registerPolicy({id:'policy:native-op',roles:[{name:'implementation',required:true,independentOf:[]}]})
  const profile=service.host.registerProfile({id:'profile:native-op',capabilities:['implementation'],evidenceRefs:['fixture'],limitations:[],expiresAt:Date.now()+60000})
  const worker=service.host.registerWorker({id:'worker:native-op',host,profile,projects:[project],engineRef:'codex',runtimeNamespace:'fixture'})
  const requirement={id:'target',revision:1}
  f.ledger.transact([], [{kind:'create',object:{id:'contract:native-op',kind:'acceptance_contract',revision:1,data:{intent:'test',requirement_refs:[requirement],criterion_refs:[requirement],source_refs:[f.sourceRef]},scope_revision_refs:[requirement],extensions:{}}},{kind:'create',object:{id:'delivery:native-op',kind:'delivery_contract',revision:1,data:{intent:'test',requirement_refs:[requirement],step_refs:[],source_refs:[f.sourceRef]},scope_revision_refs:[requirement],extensions:{}}}])
  const work=service.acceptManagedIntent(f.sourceRef,{id:'work:native-op',intent:'test',requirements:[requirement],acceptanceContract:{id:'contract:native-op',revision:1},deliveryContract:{id:'delivery:native-op',revision:1},projects:[project],boundary:'fixture',accountable:worker.id,policy,nextReviewAt:Date.now()+60000})
  const [assignment]=service.planProfessionalTeam(work,[{role:'implementation',applicable:true,basis:'fixture',worker,deliverables:['change'],consumers:['implementation'],criteria:[requirement],dependencies:[],combinationBasis:''}])
  const scopes=[worker,...service.semanticScopes(work.id),assignment!],expiresAt=Date.now()+60000
  const control=f.k.host.grantControl(worker,worker.id,expiresAt)
  f.k.host.grantMandate({id:'native-op-mandate',revision:1,requester:'owner',subject:worker.id,target:worker,actions:['dispatch'],workspaceId:f.workspace.id,resourceIds:f.workspace.resources,scopeRefs:scopes,expiresAt,revoked:false})
  const action=f.k.actions.planAction({...f.spec('native-op-launch'),target:worker,subject:worker.id,epoch:control.epoch,scopeRefs:scopes,mandateRef:{id:'native-op-mandate',revision:1}})
  f.k.actions.claimResources(action.ref,f.workspace.resources);const launch=f.k.host.beginDispatch(action.ref);if(launch.kind==='denial')throw Error(launch.code)
  const stream='native-op-stream',identity={host_ref:host.id,engine_ref:'codex',runtime_namespace:'fixture',native_session_id:'native-op-sid'}
  const observe=(observation:any)=>f.k.host.observeNative(launch.actionRef,stream,observation).nativeRef
  service.host.bindNativeSession(worker,observe({kind:'binding',binding:{identity,ref:{id:'native-op-binding',revision:1},launchRef:launch.actionRef,epoch:control.epoch}}))
  const envelope=createContextCompiler(f.ledger,service,()=>undefined).compile({commitmentId:work.id,assignment:assignment!,worker,audience:[worker.id],purpose:'implementation',sourceRefs:[],failedMethods:[],nativeContextBlindSpots:[]})
  const context=service.host.recordContext(envelope),operation=service.host.claimOperation({id:'operation:native',inputRef:'secretary:first',proposal:{kind:'dispatch'},domainKeys:['seat:'+worker.id,...f.workspace.resources.map(id=>'resource:'+id)],scopeRefs:scopes,executionSlots:['implementation']})
  let received:any,proof=''
  const session={launch,io:{stream},engine:{identity,execute:async(input:any)=>{received=input;observe({kind:'input-intent',input})},receiptFor:async(input:any)=>({status:'consumed',request_id:input.request_id,consumption:{turn_id:'actual-turn'}}),turns:()=>{const turn={id:'actual-turn',status:'completed',startedAt:1,items:[{type:'userMessage',content:[{type:'text',text:encodeInput(received)}]},{type:'agentMessage',text:'done'}]};proof=observe({kind:'turn-page',threadId:identity.native_session_id,page:{data:[turn]}});return [turn]}}}
  const result=await runManagedOperationTurn(f.ledger,service,operation.id,'implementation',worker,context,session as any,new AbortController().signal)
  expect(received.request_id).toBe(operation.id+':input:implementation');expect(received.text).toBe(envelope.text);expect(received.payload_digest).toBe(envelope.digest)
  expect(result.answer).toBe('done')
  const changedContext=service.host.recordContext(envelope)
  await expect(runManagedOperationTurn(f.ledger,service,operation.id,'implementation',worker,changedContext,session as any,new AbortController().signal)).rejects.toThrow('OPERATION_EXECUTION_CONFLICT')
  const bound=f.ledger.get(operation.id)!,ref={id:bound.id,revision:bound.revision}
  expect((bound.data.executions as any)[0]).toMatchObject({context,requestId:received.request_id,stream,nativeSessionId:identity.native_session_id})
  const unrelated=observe({kind:'turn-page',threadId:'another-thread',page:{data:[{id:'other',status:'completed',startedAt:1,items:[]}]}})
  expect(()=>service.host.completeOperation(ref,{status:'pretend'},[unrelated])).toThrow('OPERATION_NATIVE_OUTCOME_UNKNOWN')
  expect(()=>service.host.completeOperation(ref,{status:'pretend'},['model-says-done'])).toThrow('NATIVE_EVIDENCE_REQUIRED')
  service.host.completeOperation(ref,{status:'native-completed'},[proof])
  await expect(runManagedOperationTurn(f.ledger,service,operation.id,'implementation',worker,context,session as any,new AbortController().signal)).rejects.toThrow('OPERATION_NOT_RUNNING')
 }finally{f.ledger.close();rmSync(f.dir,{recursive:true,force:true})}
})

it.each(['before-quality','after-quality'])('allows %s input after trusted QA fixes a synchronous pre-dispatch refusal',async(retryInput)=>{
 const {createManagedRuntime}=await import('../src/host/services/superagent/managed-runtime.ts')
 const {mkdirSync,writeFileSync}=await import('node:fs')
 const dir=mkdtempSync(join(tmpdir(),'p5-fix1-refusal-')),source=join(dir,'source');mkdirSync(source);writeFileSync(join(source,'asset'),'public fixture')
 const config={root:join(dir,'managed'),projectRoot:source,publicFiles:['asset'],implementationWritePaths:['asset'],engine:{executable:'/never-launch-review-fixture',authFile:join(dir,'absent-auth'),model:'fixture',stateRoot:join(dir,'native')}}
 let runtime=createManagedRuntime(config)
 try {
  const l=runtime.ledger,c=runtime.coordination,sourceRef=runtime.source,requirement={id:'requirement:api',revision:1},contract={id:'contract:api',revision:1},delivery={id:'delivery:api',revision:1}
  const object=(id:string,kind:string,data:any)=>({id,kind,revision:1,data,scope_revision_refs:data.requirement_refs??[],extensions:{}})
  l.transact([], [object(requirement.id,'requirement',{intent:'fixture',source_refs:[sourceRef],wish_refs:[],observable_results:['change'],constraints:[],criterion_sources:['host']}),object(contract.id,'acceptance_contract',{intent:'fixture',requirement_refs:[requirement],criterion_refs:[requirement],source_refs:[sourceRef]}),object(delivery.id,'delivery_contract',{intent:'fixture',requirement_refs:[requirement],step_refs:[],source_refs:[sourceRef]})].map(object=>({kind:'create',object})))
  const work=c.acceptManagedIntent(sourceRef,{id:'work:api',intent:'fixture',requirements:[requirement],acceptanceContract:contract,deliveryContract:delivery,projects:[runtime.project],boundary:'fixture',accountable:'worker:coordinator',policy:{id:'policy:engineering',revision:1},nextReviewAt:Date.now()+60000})
  c.planProfessionalTeam(work,['coordinator','implementation','quality'].map(role=>({role,applicable:true,basis:'fixture',worker:runtime.workers.get(role)!,deliverables:['change'],consumers:['coordinator'],criteria:[requirement],dependencies:[],combinationBasis:''})))
  await runtime.dispose();runtime=createManagedRuntime(config)
  const proposal={kind:'dispatch',role:'implementation',instruction:'authorized repair',reason:'fixture',intake:null,questionId:'',answer:''} as any
  const wait={...proposal,kind:'wait',role:'none'}
  expect(runtime.coordination.dispatchReadiness(work.id)).toMatchObject({ready:false,code:'QUALITY_INTAKE_REQUIRED'})
  const first=await runtime.advance({requestId:'before-quality',proposals:{proposals:[proposal,wait]}})
  expect(first).toMatchObject([{status:'refused_or_unknown',reason:expect.stringContaining('QUALITY_INTAKE_REQUIRED')}])
  expect(runtime.ledger.snapshot('action')).toHaveLength(0);expect(runtime.native.size).toBe(0)
  expect(runtime.ledger.snapshot('coordination_operation')).toHaveLength(0)
  const actionsAtRefusal=runtime.ledger.snapshot('action').length
  // Trusted fixture supplies a native binding/review without starting any engine or helper.
  const quality=runtime.workers.get('quality')!,workspace=runtime.workspaces.get('quality')!.workspace,k=runtime.kernel,cc=runtime.coordination
  const assignments=runtime.ledger.snapshot('team_assignment').map(o=>({id:o.id,revision:o.revision})),qaAssignment=runtime.ledger.snapshot('team_assignment').find(o=>(o.data.worker_ref as any).id===quality.id)!
  const scopes=[quality,...cc.semanticScopes(work.id),{id:qaAssignment.id,revision:qaAssignment.revision}],expiresAt=Date.now()+60000
  const control=k.host.grantControl(quality,quality.id,expiresAt)
  k.host.grantCapability({id:'fixture:cap',revision:1,expiresAt,scopeRefs:[],evidenceRefs:['trusted-fixture'],externalTools:'blocked',revoked:false,launch:{executable:'/bin/sh',args:['-c','true'],processPolicy:'single'}})
  k.host.grantMandate({id:'fixture:mandate',revision:1,requester:'host',subject:quality.id,target:quality,actions:['dispatch'],workspaceId:workspace.id,resourceIds:workspace.resources,scopeRefs:scopes,expiresAt,revoked:false})
  const action=k.actions.planAction({id:'fixture:qa-binding',idempotencyKey:'fixture:qa-binding',requester:'host',subject:quality.id,target:quality,epoch:control.epoch,mandateRef:{id:'fixture:mandate',revision:1},capabilityRef:{id:'fixture:cap',revision:1},kind:'dispatch',workspaceId:workspace.id,resourceIds:workspace.resources,scopeRefs:scopes,purpose:'engineering',executable:'/bin/sh',args:['-c','true'],timeoutMs:2000,processPolicy:'single'})
  k.actions.claimResources(action.ref,workspace.resources);const launch=k.host.beginDispatch(action.ref);if(launch.kind==='denial')throw Error(launch.code)
  const fact=k.host.observeNative(launch.actionRef,'fixture:qa-stream',{kind:'binding',binding:{identity:{host_ref:'host:local',engine_ref:'codex',runtime_namespace:join(config.engine.stateRoot,'quality'),native_session_id:'fixture-sid'},ref:{id:'fixture-binding',revision:1},launchRef:launch.actionRef,epoch:control.epoch}} as any).nativeRef
  cc.host.bindNativeSession(quality,fact);cc.host.recordTeamReview(work.id,quality,assignments,[fact],'pass')
  expect(runtime.coordination.dispatchReadiness(work.id)).toMatchObject({ready:true})
  const reconciliation=runtime.reconcileOperations()
  const retry=await runtime.advance({requestId:retryInput,proposals:{proposals:[{...proposal,instruction:'corrected instruction'},wait]}})
  const operations=runtime.ledger.snapshot('coordination_operation').map(o=>({id:o.id,state:o.data.state,slots:o.data.execution_slots,executions:o.data.executions}))

  expect(retry[0],'ready implementation must pass preflight and reach private engine config preparation').toMatchObject({status:'refused_or_unknown',reason:expect.stringContaining('ENOENT')})
  expect(runtime.ledger.snapshot('coordination_operation')).toHaveLength(1)
  expect(runtime.native.size).toBe(0)
 } finally {await runtime.dispose();rmSync(dir,{recursive:true,force:true})}
})


it('refuses terminal delivery when the exact verifier proposal result was not persisted', async () => {
  const { assertDeliveryProposalPersisted } = await import('../src/host/services/superagent/managed-runtime.ts')
  const f = (await import('./fixtures/superagent/controlled.ts')).fixture(), ledger = f.ledger
  let actions = 0
  try {
    const coordination = createCoordinationService(ledger, { id: 'host', revision: 1 })
    const receipt = { commit: 'exact-fixture-commit' } as any
    const result = { status: 'delivered-local', receipt }
    let operationId = '', failResult = true
    const record = coordination.host.recordRuntimeEvent
    const faulted = { ...coordination, host: { ...coordination.host, recordRuntimeEvent: (...args: Parameters<typeof record>) => { if (failResult && args[1] === 'proposal_result') throw Error('fixture durable store failed'); return record(...args) } } }
    const interpreter = createProposalInterpreter(ledger, faulted, async (_proposal, key) => {
      operationId = key
      expect(() => assertDeliveryProposalPersisted(ledger, key, receipt)).toThrow('DELIVERY_PROPOSAL_NOT_DURABLE')
      const action = f.k.actions.planAction(f.spec('delivery-proof-' + (++actions)))
      let operation = ledger.get(key)!
      coordination.host.bindOperationExecution({ id: key, revision: operation.revision }, { kind: 'controlled', slot: 'verify', action: action.ref })
      f.k.actions.claimResources(action.ref, f.workspace.resources)
      await f.k.actions.execute(action.ref)
      operation = ledger.get(key)!
      coordination.host.completeOperation({ id: key, revision: operation.revision }, result, [])
      expect(() => assertDeliveryProposalPersisted(ledger, key, receipt)).toThrow('DELIVERY_PROPOSAL_NOT_DURABLE')
      return result
    }, { executionSlots: () => ['verify'], domains: () => f.workspace.resources.map(id => 'resource:' + id) })
    await expect(interpreter.apply('lost-result', [{ kind: 'verify' }], [])).rejects.toThrow('fixture durable store failed')
    expect(ledger.get(operationId)?.data.state).toBe('completed')
    expect(() => assertDeliveryProposalPersisted(ledger, operationId, receipt)).toThrow('DELIVERY_PROPOSAL_NOT_DURABLE')
    failResult = false
    await interpreter.apply('complete-result', [{ kind: 'verify' }], [])
    expect(() => assertDeliveryProposalPersisted(ledger, operationId, receipt)).not.toThrow()
    expect(() => assertDeliveryProposalPersisted(ledger, operationId, { commit: 'other' } as any)).toThrow('DELIVERY_PROPOSAL_NOT_DURABLE')
  } finally { ledger.close(); rmSync(f.dir, { recursive: true, force: true }) }
})

it('requires an exact host delivery attachment for a reconciled verifier without rewriting its result', async () => {
  const { assertDeliveryProposalPersisted } = await import('../src/host/services/superagent/managed-runtime.ts')
  const { createHash } = await import('node:crypto')
  const id='proposal:original:operation', operation={id,kind:'coordination_operation',revision:5,data:{state:'completed',proposal:{kind:'verify'},result:{status:'reconciled'}}}
  const step={ref:{id:'step',revision:1},plannedCommit:'commit',finalTree:'tree',action:{id:'successor'}}, receipt={stepRef:step.ref,commit:'commit',tree:'tree'}
  let attachment:any
  const ledger={get:(key:string)=>key===id?operation:key===id+':delivery-completion'?attachment:undefined} as any
  const original=JSON.stringify(operation)
  expect(()=>assertDeliveryProposalPersisted(ledger,id,receipt as any,step as any)).toThrow('DELIVERY_PROPOSAL_NOT_DURABLE')
  attachment={kind:'coordination_runtime_event',data:{event:'published_delivery_completion',payload:{operationRef:{id,revision:5},operationSHA:createHash('sha256').update(original).digest('hex'),step,receipt,result:{status:'delivered-local',receipt}}}}
  expect(()=>assertDeliveryProposalPersisted(ledger,id,receipt as any,step as any)).not.toThrow()
  expect(()=>assertDeliveryProposalPersisted(ledger,id,receipt as any,{...step,action:{id:'other'}} as any)).toThrow('DELIVERY_PROPOSAL_NOT_DURABLE')
  operation.data.proposal.kind='dispatch'
  attachment.data.payload.operationSHA=createHash('sha256').update(JSON.stringify(operation)).digest('hex')
  expect(()=>assertDeliveryProposalPersisted(ledger,id,receipt as any,step as any)).toThrow('DELIVERY_PROPOSAL_NOT_DURABLE')
  operation.data.proposal.kind='verify';expect(JSON.stringify(operation)).toBe(original)
})
