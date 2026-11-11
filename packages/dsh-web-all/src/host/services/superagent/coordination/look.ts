import { createHash } from 'node:crypto'
import type { ManagedObject, Json } from '../protocol/managed-work.ts'

/** Explicit projections for coordination, never substitutes for canonical evidence bodies. */
export function coordinationObjectView(object: ManagedObject): Json {
 if (!['verification_evidence','coordination_operation'].includes(object.kind)) return object as unknown as Json
 const data = object.data
 const facts = object.kind === 'verification_evidence'
  ? Object.fromEntries(Object.entries(data).filter(([key])=>!['stdout','stderr','stdout_base64','stderr_base64'].includes(key)))
  : {state:data.state,execution_slots:data.execution_slots,executions:data.executions,domain_keys:data.domain_keys,semantic_refs:data.semantic_refs,evidence_refs:data.evidence_refs,proposal:{kind:(data.proposal as any)?.kind ?? null,role:(data.proposal as any)?.role ?? null},resultStatus:(data.result as any)?.status ?? null}
 return {kind:'canonical-summary',ref:{id:object.id,revision:object.revision},canonicalKind:object.kind,sha256:createHash('sha256').update(JSON.stringify(object)).digest('hex'),facts,omitted:object.kind==='verification_evidence'?['stdout','stderr','stdout_base64','stderr_base64']:['proposal body','result body'],rawLocation:'Full canonical object retained unchanged in managed ledger; this is a projection, not a full object'} as Json
}
