import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { ManagedLedger } from '../kernel/managed-ledger.ts'
import type { ManagedObject, Ref } from '../protocol/managed-work.ts'
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
const hash=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex')
const ref=(o:ManagedObject)=>({id:o.id,revision:o.revision})

/** Read only host-recorded API events and their sealed assets, never instruction-selected paths.
 * This is evidence of the recorded candidate, not acceptance of a later workspace postimage.
 */
export function currentApiMaterial(ledger: Pick<ManagedLedger,'get'|'eventEntries'>, workRef: Ref, storage: string): {text:string;digest:string} | undefined {
 const get=(r:Ref,kind:string)=>{const o=r&&ledger.get(r.id);if(!o||o.kind!==kind||!same(ref(o),r))throw Error('API_MATERIAL_REFERENCE_MISMATCH');return o}
 const work=get(workRef,'commitment'),contract=work.data.acceptance_contract as unknown as Ref
 const events=ledger.eventEntries({runtimeEvent:'independent_api_verification'}).map(({sequence,body}:any)=>({sequence,payload:body.coordination.payload.payload})).filter(({payload})=>{
  const candidate=ledger.get(payload.candidate?.id),assignment=ledger.get((candidate?.data.assignment_ref as any)?.id)
  return assignment?.data.commitment_id===work.id
 })
 if(!events.length)return undefined
 const latest=events.at(-1)!,operation=ledger.get(latest.payload.operationId)
 if(!operation||operation.kind!=='coordination_operation'||(operation.data.proposal as any)?.kind!=='verify'||!(operation.data.semantic_refs as unknown as Ref[]).some(r=>same(r,contract)))throw Error('API_MATERIAL_OPERATION_MISMATCH')
 const selected=events.filter(e=>e.payload.operationId===operation.id)
 if(selected.length>2||new Set(selected.map(e=>e.payload.label)).size!==selected.length||selected.some(e=>!['baseline','candidate'].includes(e.payload.label)))throw Error('API_MATERIAL_PAIR_MISMATCH')
 const frozen=new Map<string,unknown>()
 const runs=selected.map(({sequence,payload:p})=>{
  const candidate=get(p.candidate,'candidate'),assignment=get(candidate.data.assignment_ref as unknown as Ref,'verification_assignment'),context=get(p.context,'verification_context'),evidence=get(p.evidence,'verification_evidence'),evaluation=get(p.evaluation,'evaluation')
  if(assignment.data.commitment_id!==work.id||!same(assignment.data.contract_ref,contract)||!same(context.data.candidate_ref,p.candidate)||!same(evidence.data.context_ref,p.context)||evidence.data.run_id!==context.data.run_id||!same(evaluation.data.candidate_ref,p.candidate)||!same(evaluation.data.contract_ref,contract)||evaluation.data.commitment_id!==work.id||!same(evaluation.data.context_refs,[p.context])||!same(evaluation.data.evidence_refs,[p.evidence])||evaluation.data.verdict!==p.verdict)throw Error('API_MATERIAL_BINDING_MISMATCH')
  const assetRoot=String(context.data.asset_root),realStorage=realpathSync(storage),realAsset=realpathSync(assetRoot),file=join(assetRoot,'cases.json'),stat=lstatSync(file)
  if(dirname(resolve(assetRoot))!==resolve(storage)||!basename(assetRoot).startsWith('assets-')||lstatSync(assetRoot).isSymbolicLink()||realAsset!==join(realStorage,basename(assetRoot))||!stat.isFile()||stat.isSymbolicLink()||stat.size>1048576||realpathSync(file)!==join(realAsset,'cases.json'))throw Error('API_MATERIAL_ASSET_PATH')
  const bytes=readFileSync(file)
  if(hash(bytes)!==context.data.asset_digest)throw Error('API_MATERIAL_ASSET_DIGEST')
  const cases=JSON.parse(bytes.toString('utf8')),bindings=context.data.case_bindings as any[]
  if(!Array.isArray(cases)||!Array.isArray(bindings)||cases.length!==bindings.length||cases.some((c,i)=>c.criterion!==bindings[i]?.criterion||hash(JSON.stringify(c))!==bindings[i]?.digest))throw Error('API_MATERIAL_CASE_BINDING')
  frozen.set(String(context.data.asset_digest),cases)
  const data={...evidence.data}
  for(const key of ['stdout','stderr'] as const){if(typeof data[key]!=='string'||typeof data[key+'_base64']!=='string'||!Buffer.from(String(data[key+'_base64']),'base64').equals(Buffer.from(String(data[key]),'utf8')))throw Error('API_MATERIAL_RAW_ENCODING');delete data[key+'_base64']}
  return {label:p.label,eventSequence:sequence,candidate,assignment,context,evaluation,evidence:{...evidence,data},evidenceCanonicalSha256:hash(JSON.stringify(evidence)),rawEncoding:'Complete UTF-8 stdout/stderr, verified byte-identical to canonical base64; duplicate encoding omitted',stdoutSha256:hash(String(data.stdout)),stderrSha256:hash(String(data.stderr)),casesDigest:context.data.asset_digest,qualificationApplicability:'Historical recorded method context; current qualification and exact candidate must be checked again for new acceptance'}
 })
 if(frozen.size!==1)throw Error('API_MATERIAL_PAIR_CASES_MISMATCH')
 const text=JSON.stringify({kind:'canonical-api-evidence',work:workRef,contract,operation:ref(operation),status:runs.length===2?'complete-pair':'incomplete-pair',boundary:'Latest recorded operation only. Full raw and frozen cases are unchanged. These facts describe the recorded candidate digest; they do not approve a later candidate, project gates, or delivery.',frozenCases:[...frozen].map(([sha256,cases])=>({sha256,cases})),runs})
 return {text,digest:hash(text)}
}
