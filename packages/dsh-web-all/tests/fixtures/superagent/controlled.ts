import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ManagedLedger } from '../../../src/host/services/superagent/kernel/managed-ledger.ts'
import { createControlledKernel, type ActionSpec } from '../../../src/host/services/superagent/kernel/actions.ts'
import { prepareWorkspace } from '../../../src/host/services/superagent/world/workspaces.ts'
export function fixture() {
 const dir = mkdtempSync(join(tmpdir(),'p2-')), source = join(dir,'source'), provision = join(dir,'workspaces')
 mkdirSync(source); mkdirSync(provision)
 const git = (...args: string[]) => execFileSync('/usr/bin/git',['-C',source,...args],{ encoding:'utf8' }).trim()
 git('init'); git('config','user.email','test@example.invalid');git('config','user.name','test');writeFileSync(join(source,'asset'),'baseline');git('add','.');git('commit','-m','baseline')
 const baseline = git('rev-parse','HEAD'); writeFileSync(join(source,'asset'),'user dirty')
 const workspace = prepareWorkspace({source,baseline,destination:join(provision,'isolated'),provisioningRoot:provision})
 const path = join(dir,'ledger.sqlite'), ledger = new ManagedLedger(path), sourceRef = {id:'host:owner',revision:1}
 ledger.transact([],[{kind:'create',object:{id:'target',kind:'requirement',revision:1,data:{intent:'work',source_refs:[{id:'human',revision:1}],wish_refs:[],observable_results:['file exists'],constraints:[],criterion_sources:['owner']},scope_revision_refs:[],extensions:{}}}])
 const k = createControlledKernel(ledger,sourceRef); k.host.registerWorkspace(workspace)
 k.host.grantCapability({id:'cap',revision:1,expiresAt:Date.now()+60000,scopeRefs:[],evidenceRefs:['host:external-tool-boundary-probe'],externalTools:'blocked',revoked:false,launch:{executable:'/bin/sh',args:['-c','echo bounded > result'],processPolicy:'single'}})
 k.host.grantMandate({id:'mandate',revision:1,requester:'owner',subject:'worker',target:{id:'target',revision:1},actions:['dispatch'],workspaceId:workspace.id,resourceIds:workspace.resources,scopeRefs:[],expiresAt:Date.now()+60000,revoked:false})
 const control = k.host.grantControl({id:'target',revision:1},'worker',Date.now()+60000)
 const spec = (id='action'): ActionSpec => ({id,idempotencyKey:id,requester:'owner',subject:'worker',target:{id:'target',revision:1},epoch:control.epoch,mandateRef:{id:'mandate',revision:1},capabilityRef:{id:'cap',revision:1},kind:'dispatch',workspaceId:workspace.id,resourceIds:workspace.resources,scopeRefs:[],purpose:'engineering',executable:'/bin/sh',args:['-c','echo bounded > result'],timeoutMs:2000,processPolicy:'single'})
 return { dir,source,workspace,path,ledger,k,spec,sourceRef }
}
