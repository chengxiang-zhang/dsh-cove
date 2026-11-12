import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, realpathSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { ManagedLedger } from './kernel/managed-ledger.ts'
import type { ManagedObject, Ref } from './protocol/managed-work.ts'
import { file, treeEntries } from './executors/delivery/git.ts'

export interface RetainedFrameworkCandidate { candidateRef: Ref; manifestDigest: string; professionalResultRef: Ref; evidenceRefs: string[] }
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
/** Read-only retention of a host-frozen failed candidate, never an acceptance grant. */
export function verifyRetainedFrameworkCandidate(input: {
  ledger: ManagedLedger; root: string; projectRoot: string; before: string; work: ManagedObject
  proof: RetainedFrameworkCandidate; publicFiles: string[]; writePaths: string[]; assets: Readonly<Record<string,string>>
  implementation: string; quality: string
}): Set<string> {
  const { ledger, proof, work } = input
  const refuse = () => { throw Error('MANAGED_RETAINED_CANDIDATE_PROOF_REQUIRED') }
  const exact = (ref: Ref, kind: string) => { const o = ref && ledger.get(ref.id); if (!o || o.revision !== ref.revision || o.kind !== kind) return refuse(); return o }
  const candidate = exact(proof.candidateRef, 'candidate'), assignment = exact(candidate.data.assignment_ref as unknown as Ref, 'verification_assignment'), professional = exact(proof.professionalResultRef, 'coordination_runtime_event')
  if (!proof.evidenceRefs.length || !proof.evidenceRefs.includes(professional.id) || !proof.evidenceRefs.every(id=>[professional.id,candidate.id,...(professional.data.evidence_refs as string[])].includes(id)) || work.data.control_state !== 'autonomous' || !['working','verifying'].includes(String(work.data.state)) || assignment.data.commitment_id !== work.id || !isDeepStrictEqual(assignment.data.contract_ref, work.data.acceptance_contract) || professional.data.event !== 'professional_result') refuse()
  const contract = exact(work.data.acceptance_contract as unknown as Ref, 'acceptance_contract')
  if (!isDeepStrictEqual(assignment.data.requirement_refs, contract.data.requirement_refs)) refuse()
  const result = professional.data.payload as any
  const binding = ledger.snapshot('session_binding').find(o => (o.data.worker_ref as any)?.id === 'worker:implementation')
  const generator = binding && JSON.stringify([binding.data.host_ref,binding.data.engine_ref,binding.data.runtime_namespace,binding.data.native_session_id])
  if (result?.role !== 'implementation' || !binding || result.nativeSessionId !== binding.data.native_session_id || !(assignment.data.generators as string[]).includes(generator!)) refuse()
  const operation = ledger.get(result.operationId)
  if (!operation || operation.kind !== 'coordination_operation' || operation.data.state !== 'completed' || (operation.data.result as any)?.role !== 'implementation' || !isDeepStrictEqual((operation.data.result as any)?.evidence,proof.professionalResultRef) || !(operation.data.semantic_refs as unknown as Ref[]).some(r=>isDeepStrictEqual(r,work.data.acceptance_contract))) refuse()
  const professionalEvent = ledger.eventEntries({ runtimeEvent: 'professional_result' }).findLast(e => (e.body as any).coordination.payload.payload.role === 'implementation' && (e.body as any).coordination.payload.scopeRefs.some((r:Ref)=>isDeepStrictEqual(r,work.data.acceptance_contract)))
  const currentBinding = ledger.snapshot('verification_binding').find(o=>o.data.commitment_id===work.id)
  if (!currentBinding || !isDeepStrictEqual(currentBinding.data.candidate_ref,proof.candidateRef) || (professionalEvent?.body as any)?.coordination.payload.id !== professional.id) refuse()
  const command = (professionalEvent?.body as any)?.coordination
  if (!command || !isDeepStrictEqual(command.payload.payload, result) || !command.payload.scopeRefs.some((r: Ref) => isDeepStrictEqual(r, work.data.acceptance_contract)) || !command.payload.evidenceRefs.length || !command.payload.evidenceRefs.every((id:string) => {
    const consumed=ledger.get(id), contextRef=consumed?.data.context_ref as unknown as Ref, context=contextRef && ledger.get(contextRef.id), envelope=context?.data.envelope as any, teamRef=envelope?.assignment as Ref, team=teamRef && ledger.get(teamRef.id)
    return consumed?.kind==='context_input' && (consumed.data.worker_ref as any)?.id==='worker:implementation' && consumed.data.native_session_id===result.nativeSessionId && consumed.data.turn_id===result.turnId && context?.kind==='context_envelope' && context.revision===contextRef.revision && envelope.commitmentId===work.id && envelope.semanticRefs.some((r:Ref)=>isDeepStrictEqual(r,work.data.acceptance_contract)) && team?.kind==='team_assignment' && team.revision===teamRef.revision && team.data.commitment_id===work.id && (team.data.worker_ref as any)?.id==='worker:implementation'
  })) refuse()
  const collected = ledger.eventEntries({ verificationObject: proof.candidateRef }).find(e => (e.body as any).verification === 'candidate')
  if (!collected || collected.sequence <= professionalEvent!.sequence || !(collected.body as any).objects.some((o: ManagedObject) => isDeepStrictEqual(o, candidate))) refuse()
  if (ledger.snapshot('evaluation').some(o => o.data.verdict === 'pass' && isDeepStrictEqual(o.data.candidate_ref, proof.candidateRef)) || ledger.eventEntries({ runtimeEvent:'project_gate_observed' }).length || existsSync(join(input.root,'delivery-intent.json')) || readdirSync(input.root).some(name => /^(final-tree-|seal-|gate-tools-|gate-work-)/.test(name))) refuse()
  const frozenRoot = String(candidate.data.root), manifest = candidate.data.manifest as unknown as {path:string;digest:string}[]
  if (dirname(frozenRoot) !== join(input.root,'verification') || !frozenRoot.startsWith(join(input.root,'verification','candidate-')) || realpathSync(frozenRoot) !== frozenRoot || candidate.data.digest !== proof.manifestDigest || hash(JSON.stringify(manifest)) !== proof.manifestDigest) refuse()
  const inventory = (root:string, frozen=false) => {
    const found = new Map<string,{digest:string;mode:number}>()
    const scan = (path:string,prefix='') => {
      const directory=lstatSync(path)
      if (!directory.isDirectory() || directory.uid !== process.getuid?.() || directory.mode & 0o022) refuse()
      for (const name of readdirSync(path).sort()) {
        if (!prefix && !frozen && name === '.git') continue
        const relative=prefix+name, absolute=join(path,name), stat=lstatSync(absolute)
        if (stat.isDirectory()) scan(absolute,relative+'/')
        else { if (!stat.isFile() || stat.nlink!==1 || stat.uid!==process.getuid?.() || (frozen && (stat.mode & 0o777)!==0o400)) refuse(); found.set(relative,{digest:hash(readFileSync(absolute)),mode:stat.mode & 0o111}) }
      }
    }
    scan(root); return found
  }
  const frozen=inventory(frozenRoot,true), expected=new Map(manifest.map(entry=>[entry.path,entry.digest])), paths=[...new Set([...input.publicFiles,...Object.keys(input.assets)])].sort()
  if (!isDeepStrictEqual([...expected.keys()].sort(),paths) || !isDeepStrictEqual([...frozen.keys()].sort(),paths) || [...expected].some(([path,digest])=>frozen.get(path)?.digest!==digest)) refuse()
  for (const [path,bytes] of Object.entries(input.assets)) if (expected.get(path)!==hash(bytes)) refuse()
  const before=treeEntries(input.projectRoot,input.before), implementation=inventory(input.implementation), quality=inventory(input.quality)
  if (!isDeepStrictEqual([...implementation.keys()].sort(),[...input.publicFiles].sort()) || !isDeepStrictEqual([...quality.keys()].sort(),[...input.publicFiles].sort())) refuse()
  let qualityBaseline=true, qualityCandidate=true
  for (const path of input.publicFiles) {
    const prior=before.get(path), actual=file(input.implementation,path), qa=file(input.quality,path)
    if (!prior || !actual || !qa || implementation.get(path)?.digest!==expected.get(path) || actual.mode!==prior.mode || qa.mode!==prior.mode) refuse()
    if (actual!.blob!==prior!.blob && !input.writePaths.includes(path)) refuse()
    qualityBaseline &&= qa!.blob===prior!.blob
    qualityCandidate &&= quality.get(path)?.digest===expected.get(path)
  }
  if (!qualityBaseline && !qualityCandidate) refuse()
  return new Set([input.implementation,...(qualityCandidate?[input.quality]:[])])
}
