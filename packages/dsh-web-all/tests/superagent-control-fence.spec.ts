import { afterEach, expect, it } from 'vitest'
import { existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from './fixtures/superagent/controlled.ts'
import type { ActionSpec, ExecutionEnvelope } from '../src/host/services/superagent/kernel/actions.ts'
const fs: ReturnType<typeof fixture>[]=[]
const setup=()=>{const f=fixture();fs.push(f);return f}
afterEach(()=>{for(const f of fs.splice(0)){f.ledger.close();rmSync(f.dir,{recursive:true,force:true})}})
function launch(f:ReturnType<typeof fixture>, args:string[], policy:'single'|'children'='single', executable='/bin/sh', timeoutMs=2000) {
 const s:ActionSpec={...f.spec(),args,processPolicy:policy,executable,timeoutMs,capabilityRef:{id:'probe-cap',revision:1}}
 f.k.host.grantCapability({id:'probe-cap',revision:1,expiresAt:Date.now()+60000,scopeRefs:[],evidenceRefs:['host:probe'],externalTools:'blocked',revoked:false,launch:{executable,args,processPolicy:policy}})
 const a=f.k.actions.planAction(s), e=f.k.actions.authorizeAction(a.ref);if(e.kind!=='envelope')throw Error(JSON.stringify(e))
 f.k.actions.claimResources(e.actionRef,s.resourceIds);return e
}
it('real OS sandbox blocks traversal and symlink writes, inherited by child processes',async()=>{
 for(const kind of ['absolute','traversal','symlink','child']) {
  const f=setup(), outside=join(f.dir,'escape')
  symlinkSync(f.dir,join(f.workspace.root,'outside'))
  const target=kind==='traversal'?'../../escape':kind==='symlink'?'outside/escape':outside
  const args=kind==='child'?['-c',`/bin/sh -c 'echo escape > "${target}"'`]:['-c',`echo escape > "${target}"`]
  const e=launch(f,args,kind==='child'?'children':'single')
  const result=await f.k.actions.execute(e.actionRef)
  expect(existsSync(outside)).toBe(false)
  expect(result).toMatchObject({state:kind==='child'?'unknown':'failed'})
 }
})
it('does not expose arbitrary shell through an altered Action payload',()=>{
 const f=setup(),a=f.k.actions.planAction({...f.spec(),args:['-c','echo unauthorized > illicit']})
 expect(f.k.actions.authorizeAction(a.ref)).toMatchObject({kind:'denial',code:'CAPABILITY_FENCE'})
})
it('removes inherited credentials and denies reading another role workspace',async()=>{
 const f=setup();process.env.P2_PRIVATE_CANARY='must-not-inherit'
 const e=launch(f,['-c','test -z "$P2_PRIVATE_CANARY" && echo clean > result'])
 try {expect(await f.k.actions.execute(e.actionRef)).toMatchObject({state:'confirmed'});expect(readFileSync(join(f.workspace.root,'result'),'utf8')).toBe('clean\n')}finally{delete process.env.P2_PRIVATE_CANARY}
 const second=setup(),x=launch(second,['-c',`/bin/cat '${join(f.workspace.root,'asset')}'`],'children')
 const result=await second.k.actions.execute(x.actionRef)
 expect(result).toMatchObject({state:'unknown',receipt:{exitCode:1}})
})
it('revokes an active single process within the 60 second budget',async()=>{
 const f=setup(),e=launch(f,['-c','while :; do :; done'])
 const started=Date.now(),running=f.k.actions.execute(e.actionRef)
 await new Promise(resolve=>setTimeout(resolve,80))
 expect(f.k.host.revokeControl(e.target,f.sourceRef)).toMatchObject({status:'unknown'})
 expect(await running).toMatchObject({state:'failed',receipt:{stopped:true,reason:'CONTROL_REVOKED'}})
 expect(Date.now()-started).toBeLessThan(60000)
})
it('permits bounded children but keeps unknown locks when descendants cannot be proven stopped',async()=>{
 const f=setup(),e=launch(f,['-c','/bin/sh -c "echo child > child-result"'],'children')
 expect(await f.k.actions.execute(e.actionRef)).toMatchObject({state:'unknown',receipt:{stopped:false}})
 expect(readFileSync(join(f.workspace.root,'child-result'),'utf8')).toBe('child\n')
 const b=f.k.actions.planAction({...f.spec('replacement')})
 expect(()=>f.k.actions.claimResources(b.ref,f.workspace.resources)).toThrow('RESOURCE_BUSY')
})
it('can revoke an old controlled target after its requirement revision changes',()=>{
 const f=setup();f.ledger.transact([{id:'target',revision:1}],[{kind:'revise',id:'target',data:{...f.ledger.get('target')!.data,intent:'changed'}}])
 expect(()=>f.k.host.revokeControl({id:'target',revision:1},f.sourceRef)).not.toThrow()
})
it('a detached descendant cannot escape the inherited write sandbox',async()=>{
 const f=setup(),outside=join(f.dir,'detached-escape')
 const code=`const {spawn}=require('node:child_process');const c=spawn('/bin/sh',['-c',${JSON.stringify(`sleep 0.15; echo escaped > '${outside}'`)}],{detached:true,stdio:'ignore'});c.unref()`
 const e=launch(f,['-e',code],'children',process.execPath)
 expect(await f.k.actions.execute(e.actionRef)).toMatchObject({state:'unknown',receipt:{stopped:false}})
 await new Promise(resolve=>setTimeout(resolve,350))
 expect(existsSync(outside)).toBe(false)
})
it('single process policy rejects creating a background writer',async()=>{
 const f=setup(),e=launch(f,['-c','(echo forbidden > background) & wait'])
 const result=await f.k.actions.execute(e.actionRef)
 expect(existsSync(join(f.workspace.root,'background'))).toBe(false)
 expect(result).toMatchObject({state:'failed',receipt:{stopped:true}})
})

it.each(['timeout','cancel'])('bounds %s when a detached descendant keeps inherited output pipes open',async mode=>{
 const f=setup(),pidFile=join(f.workspace.root,'detached-pid')
 const perl=`if (fork() == 0) { POSIX::setsid(); open(my $p, '>', '${pidFile}') or die $!; print $p $$; close $p; select(undef,undef,undef,1.5); exit 0; } exit 0;`
 const e=launch(f,['-MPOSIX','-e',perl],'children','/usr/bin/perl',mode==='timeout'?100:2000)
 const started=Date.now(),running=f.k.actions.execute(e.actionRef)
 let cancel:ReturnType<typeof setTimeout>|undefined
 if(mode==='cancel')cancel=setTimeout(()=>f.k.host.revokeControl(e.target,f.sourceRef),70)
 try{
  const result=await running
  expect(Date.now()-started).toBeLessThan(800)
  expect(result).toMatchObject({state:'unknown',receipt:{stopped:false}})
  const fresh=f.k.host.grantControl(e.target,'worker',Date.now()+60000)
  const replacement=f.k.actions.planAction({...f.spec('replacement'),epoch:fresh.epoch})
  expect(()=>f.k.actions.claimResources(replacement.ref,f.workspace.resources)).toThrow('RESOURCE_BUSY')
 }finally{
  if(cancel)clearTimeout(cancel)
  if(existsSync(pidFile)){const pid=Number(readFileSync(pidFile,'utf8'));if(Number.isSafeInteger(pid)&&pid>1)try{process.kill(pid,'SIGKILL')}catch{}}
 }
})
