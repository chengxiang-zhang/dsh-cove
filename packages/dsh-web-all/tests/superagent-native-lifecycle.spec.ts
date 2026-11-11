import { expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { fixture } from './fixtures/superagent/controlled.ts'
import * as launchPorts from '../src/host/services/superagent/kernel/sandbox-launch-port.ts'
import { configuredSandboxLaunchPort } from '../src/host/services/superagent/kernel/sandbox-launch-port.ts'
import type { ExecutionEnvelope } from '../src/host/services/superagent/kernel/actions.ts'

it('reconciles the same owned process when its exit arrives after the bounded drain result', async () => {
  const f=fixture(),port=configuredSandboxLaunchPort()
  let deliverOwnedExit:(()=>void)|undefined
  const spy=vi.spyOn(launchPorts,'configuredSandboxLaunchPort').mockReturnValue({open(request){
    const child=port.open(request),once=child.once.bind(child)
    child.once=((name:string,listener:(...args:any[])=>void)=>once(name,name==='exit'?(...args:any[])=>{deliverOwnedExit=()=>listener(...args)}:listener)) as typeof child.once
    return child
  }})
  try {
    const action=f.k.actions.planAction(f.spec('late-exit'));f.k.actions.claimResources(action.ref,f.workspace.resources)
    const launch=f.k.host.beginDispatch(action.ref) as ExecutionEnvelope,process=f.k.host.openProcess(launch.actionRef)
    expect((await process.closed).receipt?.stopped).toBe(false)
    expect(deliverOwnedExit).toBeTypeOf('function')
    deliverOwnedExit!()
    expect(f.ledger.get(action.ref.id)?.data.receipt).toMatchObject({stopped:true})
    const exits=f.k.host.nativeFacts('execution:'+action.ref.id).filter(f=>(f.observation as any).kind==='process_exit')
    expect(exits).toHaveLength(2)
    expect((exits[1]!.observation as any).launchRef).toEqual(launch.actionRef)
  }finally{spy.mockRestore();f.ledger.close();rmSync(f.dir,{recursive:true,force:true})}
})

it('releases credentials only after checking canonical cessation, never trusts a stop boolean', async () => {
  const { releaseManagedSession }=await import('../src/host/services/superagent/managed-runtime.ts')
  let receipt:any={status:'unknown',stopped:false,evidenceRefs:[]}
  const cleanup=vi.fn(),stop=vi.fn(async()=>{setTimeout(()=>{receipt={status:'failed',stopped:true,evidenceRefs:['late-owned-exit']}},35);return {receipt:{stopped:false}}})
  const ledger={get:()=>({data:{receipt}})} as any,session={launch:{actionRef:{id:'owned',revision:2}},stop,cleanupCredentials:cleanup} as any
  expect(await releaseManagedSession(ledger,session)).toMatchObject({stopped:true,evidenceRefs:['late-owned-exit']})
  expect(stop).toHaveBeenCalledTimes(1);expect(cleanup).toHaveBeenCalledTimes(1)
  await releaseManagedSession(ledger,session);expect(stop).toHaveBeenCalledTimes(1)
  receipt={status:'unknown',stopped:false,evidenceRefs:[]};session.stop=async()=>({receipt:{stopped:true}})
  await expect(releaseManagedSession(ledger,session)).rejects.toThrow('NATIVE_CESSATION_UNKNOWN')
  expect(cleanup).toHaveBeenCalledTimes(3)
})

it.each(['absent','present','unowned','children'])('only reconciles a proven historical owned single-process absence: %s', async scenario=>{
  const {createHash}=await import('node:crypto'), f=fixture()
  try {
    const spec=f.spec('historical'),action=f.k.actions.planAction(spec);f.k.actions.claimResources(action.ref,f.workspace.resources)
    const launch=f.k.host.beginDispatch(action.ref) as ExecutionEnvelope
    const receipt={status:'unknown' as const,stopped:false,evidenceRefs:[scenario==='unowned'?'untrusted-pid':`process:${process.pid}:old-owned`]}
    const digest=createHash('sha256').update(JSON.stringify(launch.spec)).digest('hex')
    f.k.host.observeNative(launch.actionRef,'execution:'+action.ref.id,{kind:'process_exit',launchRef:launch.actionRef,executionDigest:digest,receipt})
    f.k.host.reconcileAction(launch.actionRef,receipt)
    const current=f.ledger.get(action.ref.id)!,ref={id:current.id,revision:current.revision}
    if(scenario==='children') {
      const old=f.ledger.get.bind(f.ledger),get=vi.spyOn(f.ledger,'get').mockImplementation(id=>{const value=old(id);return id===ref.id?{...value!,data:{...value!.data,execution_spec:{...(value!.data.execution_spec as any),processPolicy:'children'}}}:value})
      expect(()=>f.k.host.reconcileSingleProcessAbsence(ref)).toThrow('PROCESS_ABSENCE_SINGLE_REQUIRED');get.mockRestore()
    }else if(scenario==='present')expect(()=>f.k.host.reconcileSingleProcessAbsence(ref)).toThrow('PROCESS_STILL_PRESENT')
    else if(scenario==='unowned')expect(()=>f.k.host.reconcileSingleProcessAbsence(ref)).toThrow('PROCESS_ABSENCE_OWNED_PID_REQUIRED')
    else {
      const kill=vi.spyOn(process,'kill').mockImplementation((pid,signal)=>{expect(pid).toBe(process.pid);expect(signal).toBe(0);throw Object.assign(Error('no process'),{code:'ESRCH'})})
      try{f.k.host.reconcileSingleProcessAbsence(ref);expect(f.ledger.get(ref.id)?.data.receipt).toMatchObject({status:'failed',stopped:true,reason:'OWNED_SINGLE_PROCESS_ABSENT'});expect(kill).toHaveBeenCalledTimes(1)}finally{kill.mockRestore()}
    }
  }finally{f.ledger.close();rmSync(f.dir,{recursive:true,force:true})}
})

it('keeps prior failure evidence without contaminating the next continuation state', async()=>{
  const {continuationVersion}=await import('../src/host/services/superagent/managed-runtime.ts')
  const prior={request:{requestId:'same'},state:'needs-attention',error:'old failure',endedAt:1,report:'old report',result:{status:'old'},continuationStartedAt:0,baseline:{head:'old'},continuations:[{id:'failed',state:'failed'}]}
  const next=continuationVersion(prior,{id:'new',state:'queued'})
  expect(next).toMatchObject({state:'queued',request:prior.request,continuations:[...prior.continuations,{id:'new',state:'queued'}]})
  for(const key of ['error','endedAt','report','result','continuationStartedAt','baseline']){expect(next).not.toHaveProperty(key);expect(next.priorOutcome[key as keyof typeof next.priorOutcome]).toEqual((prior as any)[key])}
  expect({...next,state:'running'}).not.toHaveProperty('error')
  expect({...next,state:'needs-attention',result:{status:'project-gate-failed'}}).not.toHaveProperty('error')
})
