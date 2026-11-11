import type { Json, Ref } from '../protocol/managed-work.ts'
import { CODEX_REPLAY } from './codex-replay.ts'
import { createHash } from 'node:crypto'

const replayQualitySchema = (criteria: Ref[]): Json => ({
  type: 'object', additionalProperties: false, required: ['purpose','intake_readiness','verdict','reason','cases'], properties: {
    purpose: { type:'string', enum:['intake','verification_design'] }, intake_readiness: {type:'string',enum:['ready','blocked']}, verdict: {type:'string',enum:['pass','fail','inconclusive']}, reason: {type:'string'},
    cases: {type:'array',items:{type:'object',additionalProperties:false,required:['criterion','input','expected'],properties:{
      criterion:{type:'string',enum:criteria.map(r=>r.id)},
      input:{type:'object',additionalProperties:false,required:['fields','steps'],properties:{
        fields:{type:'array',items:{type:'string',enum:['status','result','providerSessionId','errorTag']}},
        steps:{type:'array',items:{type:'object',additionalProperties:false,required:['stdout','stderr','exitCode','providerSessionId','continuePrevious'],properties:{stdout:{type:'string'},stderr:{type:'string'},exitCode:{type:'integer'},providerSessionId:{type:['string','null']},continuePrevious:{type:'boolean'}}}}
      }},
      expected:{type:'array',items:{type:'array',items:{type:['string','null']}}}
    }}}
  }
})

export interface ManagedVerificationMethod {
  id: string
  description: string
  qualitySchema(criteria: Ref[]): Json
  entry: string
  exportName: string
  assets: Readonly<Record<string, string>>
  instructions: string
}
const codexReplay: ManagedVerificationMethod = {
  id: 'codex-runTurn-replay@1', description: 'Captured protocol/API replay of the external Codex provider; synthetic samples do not prove live CLI behavior.',
  qualitySchema: replayQualitySchema, entry: 'candidate.mjs', exportName: 'inspect', assets: { 'candidate.mjs': CODEX_REPLAY },
  instructions: 'Independently design asynchronous createCodexAdapter.runTurn cases from the actual requirements and source. Each criterion is an exact current id. fields selects assertions; expected is one array per steps element; null is never a wildcard. continuePrevious uses the actual prior providerSessionId. Distinguish exec dot events and app-server slash notifications, same thread/turn, transient willRetry errors and authoritative nested turn.status/error. Use documented/captured shapes and genuine authentication/session failure controls. Mark synthetic samples synthetic. Design the same cases for baseline and candidate and explain which requirement a baseline failure discriminates. Do not invent fullgate, live CLI or parent-platform success. If this method cannot evaluate a requirement, report the precise method gap; do not redefine the requirement.',
}
export function managedVerificationMethod(id: string): ManagedVerificationMethod {
  if (id !== codexReplay.id) throw new Error('VERIFICATION_METHOD_NOT_CONFIGURED:' + id)
  return codexReplay
}
export const methodAssetDigest = (value: string) => createHash('sha256').update(value).digest('hex')
