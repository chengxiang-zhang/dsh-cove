import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createManagedRuntime } from '../src/host/services/superagent/managed-runtime.ts'
import { createContextCompiler } from '../src/host/services/superagent/context/compile.ts'
import { encodeInput } from '../src/host/services/superagent/executors/native/bindings.ts'
import type { ContractPartition } from '../src/host/services/superagent/kernel/contract-partition.ts'

it.each(['approved','rejected','missing-slot','unknown-terminal','mismatched-exit','verify-handoff','verify-unknown','verify-issued'])('preserves exact contract and interrupted responsibility boundaries: %s', async (scenario) => {
  const dir = mkdtempSync(join(tmpdir(), 'partition-')), project = join(dir, 'source'); mkdirSync(project); writeFileSync(join(project, 'asset'), 'baseline')
  const runtime = createManagedRuntime({ root: join(dir, 'managed'), projectRoot: project, publicFiles: ['asset'], implementationWritePaths: ['asset'], engine: { executable: '/never-started', authFile: '/absent', model: 'fixture', stateRoot: join(dir, 'native') } })
  const { ledger, coordination: c, kernel: k, source, workers, workspaces } = runtime
  const ref = (id: string) => ({ id, revision: ledger.get(id)!.revision })
  try {
    const requirement = { id: 'req', revision: 1 }, business = { id: 'business', revision: 1 }, engineering = { id: 'engineering', revision: 1 }
    const objects: any[] = [requirement, business, engineering].map(r => ({ ...r, kind: 'requirement', scope_revision_refs: [], extensions: {}, data: { intent: r.id, source_refs: [source], wish_refs: [], observable_results: [r.id === 'engineering' ? 'same tree all seven gates and local dev commit' : r.id], constraints: [], criterion_sources: [source.id] } }))
    objects.push({ id: 'acceptance', revision: 1, kind: 'acceptance_contract', scope_revision_refs: [requirement,business,engineering], extensions: {}, data: { intent: 'task', requirement_refs: [requirement], criterion_refs: [business,engineering], source_refs: [source] } }, { id: 'delivery', revision: 1, kind: 'delivery_contract', scope_revision_refs: [requirement], extensions: {}, data: { intent: 'local delivery', requirement_refs: [requirement], step_refs: [{id:'step',revision:1}], source_refs: [source] } })
    ledger.transact([], objects.map(object => ({ kind: 'create', object })))
    const work = c.acceptManagedIntent(source, { id: 'work', intent: 'original user requirement', requirements: [requirement], acceptanceContract: ref('acceptance'), deliveryContract: ref('delivery'), projects: [runtime.project], boundary: 'no push', accountable: workers.get('coordinator')!.id, policy: runtime.policy, nextReviewAt: Date.now()+60000 })
    c.planProfessionalTeam(work, ['coordinator','implementation','quality'].map(role => ({ role, applicable: true, basis: 'fixture', worker: workers.get(role)!, deliverables: ['review'], consumers: ['coordinator'], criteria: [business,engineering], dependencies: [], combinationBasis: '' })))
    const team = () => ledger.snapshot('team_assignment').filter(o => o.data.commitment_id === work.id)
    const plan: ContractPartition = { commitment: work, acceptance: ref('acceptance'), delivery: ref('delivery'), assignments: team().map(o => ref(o.id)), businessCriteria: [business], deliveryCriteria: [engineering], operations: [], candidateRoot: workspaces.get('implementation')!.workspace.root, candidate: [{path:'asset',sha256:createHash('sha256').update('baseline').digest('hex'),mode:'100644'}], evidenceRefs: ['owner:approved-preserve-all'] }
    let serial = 0
    const launch = (role: string) => {
      const worker=workers.get(role)!, workspace=workspaces.get(role)!.workspace, assignment=team().find(o=>o.data.role===role)!, scopes=[worker,...c.semanticScopes(work.id),ref(assignment.id)], id='launch:'+role+':'+(++serial), expiresAt=Date.now()+60000
      const control=k.host.grantControl(worker,worker.id,expiresAt)
      k.host.grantCapability({id:id+':cap',revision:1,scopeRefs:scopes,evidenceRefs:['fixture'],expiresAt,externalTools:'blocked',revoked:false,launch:{executable:'/bin/sh',args:['-c','true'],processPolicy:'single'}})
      k.host.grantMandate({id:id+':mandate',revision:1,requester:'host',subject:worker.id,target:worker,actions:['dispatch'],workspaceId:workspace.id,resourceIds:workspace.resources,scopeRefs:scopes,expiresAt,revoked:false})
      const action=k.actions.planAction({id,idempotencyKey:id,requester:'host',subject:worker.id,target:worker,epoch:control.epoch,mandateRef:{id:id+':mandate',revision:1},capabilityRef:{id:id+':cap',revision:1},kind:'dispatch',workspaceId:workspace.id,resourceIds:workspace.resources,scopeRefs:scopes,purpose:workspace.role,executable:'/bin/sh',args:['-c','true'],timeoutMs:1000,processPolicy:'single'})
      k.actions.claimResources(action.ref,workspace.resources);const envelope=k.host.beginDispatch(action.ref);if(envelope.kind==='denial')throw Error(envelope.code)
      const stream=id, sid='original-'+role, observe=(observation:any)=>k.host.observeNative(envelope.actionRef,stream,observation).nativeRef
      const fact=observe({kind:'binding',binding:{identity:{host_ref:'host:local',engine_ref:'codex',runtime_namespace:ledger.get(worker.id)!.data.runtime_namespace,native_session_id:sid},ref:{id:'binding:'+id,revision:control.epoch},launchRef:envelope.actionRef}})
      if(ledger.snapshot('session_binding').some(o=>(o.data.worker_ref as any).id===worker.id))c.host.resumeNativeSession(worker,fact);else c.host.bindNativeSession(worker,fact)
      const context=c.host.recordContext(createContextCompiler(ledger,c,()=>undefined).compile({commitmentId:work.id,assignment:ref(assignment.id),worker,audience:[worker.id],purpose:role,sourceRefs:[],failedMethods:[],nativeContextBlindSpots:[]}))
      const domains=['seat:'+worker.id,...workspace.resources.map(id=>'resource:'+id)]
      return {worker,workspace,scopes,stream,sid,observe,context,domains,launch:envelope.actionRef,stop(){const receipt={status:'failed' as const,stopped:true,evidenceRefs:['fixture:process-exit']};k.host.observeNative(envelope.actionRef,'execution:'+envelope.actionRef.id,{kind:'process_exit',launchRef:scenario === 'mismatched-exit' && role === 'implementation' ? { ...envelope.actionRef, revision: envelope.actionRef.revision + 1 } : envelope.actionRef,receipt});k.host.reconcileAction(envelope.actionRef,receipt)}}
    }
    const execute=(session:ReturnType<typeof launch>,id:string,proposal:any,status:string,answer:string)=>{
      const operation=c.host.claimOperation({id,inputRef:'fixture',proposal,domainKeys:session.domains,scopeRefs:session.scopes,executionSlots:[String(proposal.role ?? 'quality'), ...(proposal.kind==='verify' ? ['collect:baseline','collect:candidate'] : []), ...(id === 'old-operation' && scenario === 'missing-slot' ? ['uncollected'] : [])]})
      const slot=String(proposal.role ?? 'quality'),requestId=id+':input:'+slot,context=ledger.get(session.context.id)!.data.envelope as any
      c.host.bindOperationExecution(operation,{kind:'native',slot,worker:session.worker,context:session.context,launch:session.launch,stream:session.stream,nativeSessionId:session.sid,requestId})
      const input={request_id:requestId,assignment_revision:context.assignment.revision,payload_digest:context.digest,payload_ref:requestId,text:context.text};session.observe({kind:'input-intent',input})
      const evidence=session.observe({kind:'turn-page',threadId:session.sid,page:{data:[{id:id+':turn',status,startedAt:1,items:[{type:'userMessage',content:[{type:'text',text:encodeInput(input)}]},{type:'agentMessage',text:answer}]}]}})
      return {operation:ref(id),evidenceRefs:[evidence]}
    }
    if(scenario.startsWith('verify-')) {
      const qa=launch('quality'),old=execute(qa,'old-verify',{kind:'verify'},scenario==='verify-unknown'?'inProgress':'interrupted','');qa.stop()
      const handoff={commitment:work,acceptance:ref('acceptance'),delivery:ref('delivery'),assignments:team().map(o=>ref(o.id)),operation:old.operation,candidateRoot:plan.candidateRoot,candidate:plan.candidate,evidenceRefs:['host:exact-interruption']}
      const nextInput={id:'next-verify',inputRef:'same-business',proposal:{kind:'verify'},domainKeys:qa.domains,scopeRefs:qa.scopes,executionSlots:['quality','collect:baseline','collect:candidate']}
      expect(()=>c.host.claimOperation(nextInput)).toThrow('OPERATION_DOMAIN_UNRESOLVED')
      const collect=()=>{
        const launchObject=ledger.get(qa.launch.id)!,spec=launchObject.data.execution_spec as any,id='unissued-collector'
        return k.actions.planAction({...spec,id,idempotencyKey:id,kind:'collect'})
      }
      if(scenario==='verify-issued'){collect();expect(()=>c.host.handoffInterruptedVerification(handoff)).toThrow('VERIFY_HANDOFF_COLLECTOR_ALREADY_ISSUED');return}
      if(scenario==='verify-unknown'){expect(()=>c.host.handoffInterruptedVerification(handoff)).toThrow('PARTITION_NATIVE_OUTCOME_UNKNOWN');return}
      c.host.handoffInterruptedVerification(handoff)
      expect(ledger.get(old.operation.id)?.data.state).toBe('running')
      expect(()=>c.host.completeOperation(old.operation,{status:'pretend'},old.evidenceRefs)).toThrow('OPERATION_COMPLETION_PROOF_REQUIRED')
      const resumed=launch('quality'),next=c.host.claimOperation({...nextInput,scopeRefs:resumed.scopes})
      const execution={kind:'native' as const,slot:'quality',worker:resumed.worker,context:resumed.context,launch:resumed.launch,stream:resumed.stream,nativeSessionId:'different-thread',requestId:'next-verify:input:quality'}
      expect(()=>c.host.bindOperationExecution(next,execution)).toThrow('PARTITION_SAME_NATIVE_THREAD_REQUIRED')
      c.host.bindOperationExecution(next,{...execution,nativeSessionId:resumed.sid})
      const action=collect()
      expect(()=>c.host.bindOperationExecution(ref(next.id),{kind:'controlled',slot:'quality',action:action.ref})).toThrow('OPERATION_EXECUTION_CONFLICT')
      c.host.bindOperationExecution(ref(next.id),{kind:'controlled',slot:'collect:baseline',action:action.ref})
      expect((ledger.get(next.id)!.data.executions as any[]).map(e=>e.kind)).toEqual(['native','controlled'])
      resumed.stop();return
    }
    const impl=launch('implementation'),old=execute(impl,'old-operation',{kind:'dispatch',role:'implementation'},scenario === 'unknown-terminal' ? 'inProgress' : 'interrupted','')
    impl.stop();plan.operations=[old.operation]
    const qa=launch('quality'),approval=execute(qa,'approval',{kind:'contract_partition_review',plan},'completed',JSON.stringify({approved:scenario !== 'rejected',businessCriteria:[business],deliveryCriteria:[engineering],reason:'All requirements retained; engineering proof is later'}))
    c.host.completeOperation(approval.operation,{status:'reviewed'},approval.evidenceRefs);approval.operation=ref('approval')
    const originalRequirement=ledger.get('req'),originalEngineering=ledger.get('engineering')
    expect(()=>c.host.partitionContracts({...plan,deliveryCriteria:[]},approval)).toThrow('PARTITION_REQUIREMENT_LOSS')
    expect(()=>c.host.partitionContracts(plan,approval)).toThrow('PARTITION_LIVE_WRITER')
    qa.stop()
    expect(()=>c.host.partitionContracts(plan,{...approval,evidenceRefs:[]})).toThrow('PARTITION_QA_REQUIRED')
    writeFileSync(join(plan.candidateRoot,'asset'),'concurrent change')
    expect(()=>c.host.partitionContracts(plan,approval)).toThrow('PARTITION_CANDIDATE_CHANGED')
    writeFileSync(join(plan.candidateRoot,'asset'),'baseline')
    expect(()=>c.host.completeOperation(old.operation,{status:'pretend-success'},old.evidenceRefs)).toThrow(scenario === 'missing-slot' ? 'OPERATION_COMPLETION_PROOF_REQUIRED' : 'OPERATION_NATIVE_OUTCOME_UNKNOWN')
    if (scenario !== 'approved') { expect(()=>c.host.partitionContracts(plan,approval)).toThrow(scenario === 'rejected' ? 'PARTITION_QA_REQUIRED' : scenario === 'missing-slot' ? 'PARTITION_UNCOLLECTED_SLOT' : scenario === 'mismatched-exit' ? 'PARTITION_WRITER_UNKNOWN' : 'PARTITION_NATIVE_OUTCOME_UNKNOWN'); return }
    c.host.partitionContracts(plan,approval)
    expect(ledger.get('req')).toEqual(originalRequirement);expect(ledger.get('engineering')).toEqual(originalEngineering)
    expect(ledger.get('acceptance')!.data.criterion_refs).toEqual([business]);expect(ledger.get('delivery')!.data.criterion_refs).toEqual([engineering])
    expect(ledger.get('work')!.data.state).toBe('proposed');expect(ledger.get('old-operation')!.data.state).toBe('running')
    expect(c.dispatchReadiness(work.id).ready).toBe(false)
    expect(()=>c.host.claimOperation({id:'stale',inputRef:'new',proposal:{kind:'dispatch'},domainKeys:impl.domains,scopeRefs:impl.scopes,executionSlots:['implementation']})).toThrow('COORDINATION_STALE_REFERENCE')
    const resumed=launch('implementation'),next=c.host.claimOperation({id:'successor',inputRef:'new',proposal:{kind:'dispatch'},domainKeys:resumed.domains,scopeRefs:resumed.scopes,executionSlots:['implementation']})
    const execution={kind:'native' as const,slot:'implementation',worker:resumed.worker,context:resumed.context,launch:resumed.launch,stream:resumed.stream,nativeSessionId:'different-thread',requestId:'successor:input:implementation'}
    expect(()=>c.host.bindOperationExecution(next,execution)).toThrow('PARTITION_SAME_NATIVE_THREAD_REQUIRED')
    c.host.bindOperationExecution(next,{...execution,nativeSessionId:resumed.sid});resumed.stop()
    expect(readFileSync(join(plan.candidateRoot,'asset'),'utf8')).toBe('baseline')
  } finally { await runtime.dispose(); rmSync(dir,{recursive:true,force:true}) }
})

it('reopens the sealed public baseline manifest while retaining the interrupted candidate postimage', async () => {
  const dir=mkdtempSync(join(tmpdir(),'partition-reopen-')),project=join(dir,'source');mkdirSync(project);writeFileSync(join(project,'asset'),'baseline')
  const config={root:join(dir,'managed'),projectRoot:project,publicFiles:['asset'],implementationWritePaths:['asset'],engine:{executable:'/never-started',authFile:'/absent',model:'fixture',stateRoot:join(dir,'native')}}
  let runtime=createManagedRuntime(config)
  try {
    const before=runtime.workspaces.get('implementation')!, manifest=before.manifest, sourceStatus=before.workspace.sourceStatus
    writeFileSync(join(before.workspace.root,'asset'),'retained unfinished candidate')
    await runtime.dispose();runtime=createManagedRuntime(config)
    const after=runtime.workspaces.get('implementation')!
    expect(after.manifest).toEqual(manifest)
    expect(after.workspace.sourceStatus).toBe(sourceStatus)
    expect(readFileSync(join(after.workspace.root,'asset'),'utf8')).toBe('retained unfinished candidate')
  } finally {await runtime.dispose();rmSync(dir,{recursive:true,force:true})}
})

it('selects the last durable baseline binding by event sequence, regardless of random event id order', async () => {
  const { ManagedLedger }=await import('../src/host/services/superagent/kernel/managed-ledger.ts')
  const { createCoordinationService }=await import('../src/host/services/superagent/coordination/intake.ts')
  const { latestFrameworkBaseline }=await import('../src/host/services/superagent/managed-runtime.ts')
  const dir=mkdtempSync(join(tmpdir(),'baseline-sequence-')),ledger=new ManagedLedger(join(dir,'ledger'))
  try {
    const c=createCoordinationService(ledger,{id:'host',revision:1})
    c.host.recordRuntimeEvent('baseline:z-old','framework_baseline_bound',{before:'first',after:'second'},[])
    c.host.recordRuntimeEvent('baseline:a-new','framework_baseline_bound',{before:'second',after:'third'},[])
    expect(latestFrameworkBaseline(ledger)).toEqual({before:'second',after:'third'})
  }finally{ledger.close();rmSync(dir,{recursive:true,force:true})}
})
