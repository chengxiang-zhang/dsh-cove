import {expect,it} from 'vitest'
import {createHash} from 'node:crypto'
import {coordinationObjectView} from '../src/host/services/superagent/coordination/look.ts'
import type {ManagedObject} from '../src/host/services/superagent/protocol/managed-work.ts'
it('labels large canonical evidence projections and preserves result facts, source hash and original raw',()=>{
 const object={id:'evidence',kind:'verification_evidence',revision:2,data:{stdout:'complete output',stderr:'diagnostic',stdout_base64:'raw64',stderr_base64:'stderr64',raw_digest:'raw-digest',context_ref:{id:'context',revision:1},exit_code:0,complete:true,integrity:{valid:true},results:[{criterion:'C1',verdict:'fail'}]},scope_revision_refs:[],extensions:{}} as unknown as ManagedObject
 const raw=JSON.stringify(object),view=coordinationObjectView(object) as any
 expect(view).toMatchObject({kind:'canonical-summary',canonicalKind:'verification_evidence',ref:{id:'evidence',revision:2},sha256:createHash('sha256').update(raw).digest('hex'),facts:{raw_digest:'raw-digest',context_ref:{id:'context',revision:1},results:[{criterion:'C1',verdict:'fail'}]}})
 expect(view.facts.stdout).toBeUndefined();expect(view.facts.stdout_base64).toBeUndefined();expect(view.omitted).toContain('stdout')
 expect(JSON.stringify(object)).toBe(raw)
 const requirement={...object,kind:'requirement',data:{intent:'Original requirement',constraints:['All seven gates and receipt required']}}
 expect(coordinationObjectView(requirement)).toBe(requirement)
})
