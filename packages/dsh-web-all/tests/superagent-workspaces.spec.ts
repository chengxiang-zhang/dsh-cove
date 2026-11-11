import { expect,it } from 'vitest'
import { rmSync,readFileSync,existsSync,mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { verifyWorkspace } from '../src/host/services/superagent/kernel/resources.ts'
import { fixture } from './fixtures/superagent/controlled.ts'
import { prepareWorkspace } from '../src/host/services/superagent/world/workspaces.ts'
it('creates a real isolated Git checkout at the trusted baseline and preserves dirty source',()=>{
 const f=fixture();try{
 expect(readFileSync(join(f.source,'asset'),'utf8')).toBe('user dirty')
 expect(readFileSync(join(f.workspace.root,'asset'),'utf8')).toBe('baseline')
 expect(f.workspace.sourceStatus).toContain('asset');expect(existsSync(join(f.workspace.root,'.git','HEAD'))).toBe(true)
 expect(f.workspace.resources.some(x=>x.startsWith('repository:'))).toBe(true)
 expect(()=>verifyWorkspace(f.workspace)).not.toThrow()
 expect(()=>prepareWorkspace({source:f.source,baseline:f.workspace.baseline,destination:join(f.dir,'escape'),provisioningRoot:join(f.dir,'workspaces')})).toThrow('WORKSPACE_BOUNDARY')
 }finally{f.ledger.close();rmSync(f.dir,{recursive:true,force:true})}
})
it('does not register an empty directory as a prepared repository',()=>{
 const f=fixture();try{const empty=join(f.dir,'empty');mkdirSync(empty);expect(()=>f.k.host.registerWorkspace({...f.workspace,id:'empty',root:empty})).toThrow()}finally{f.ledger.close();rmSync(f.dir,{recursive:true,force:true})}
})
it('locks repository identity across two distinct real checkouts',()=>{
 const f=fixture();try{
 const second=prepareWorkspace({source:f.source,baseline:f.workspace.baseline,destination:join(f.dir,'workspaces','second'),provisioningRoot:join(f.dir,'workspaces')})
 f.k.host.registerWorkspace(second)
 f.k.host.grantMandate({id:'second-mandate',revision:1,requester:'owner',subject:'worker',target:{id:'target',revision:1},actions:['dispatch'],workspaceId:second.id,resourceIds:second.resources,scopeRefs:[],expiresAt:Date.now()+60000,revoked:false})
 const a=f.k.actions.planAction(f.spec());f.k.actions.claimResources(a.ref,f.workspace.resources)
 const b=f.k.actions.planAction({...f.spec('second'),workspaceId:second.id,resourceIds:second.resources,mandateRef:{id:'second-mandate',revision:1}})
 expect(second.root).not.toBe(f.workspace.root)
 expect(()=>f.k.actions.claimResources(b.ref,second.resources)).toThrow('RESOURCE_BUSY')
 }finally{f.ledger.close();rmSync(f.dir,{recursive:true,force:true})}
})
