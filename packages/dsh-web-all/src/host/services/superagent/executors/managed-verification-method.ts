import { assertJson, type Json, type Ref } from '../protocol/managed-work.ts'
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
export interface ManagedVerificationMethodSettings { entryPath: string }

const moduleQualitySchema = (criteria: Ref[]): Json => ({
  type: 'object', additionalProperties: false,
  required: ['purpose', 'intake_readiness', 'verdict', 'reason', 'cases'],
  properties: {
    purpose: { type: 'string', enum: ['intake', 'verification_design'] },
    intake_readiness: { type: 'string', enum: ['ready', 'blocked'] },
    verdict: { type: 'string', enum: ['pass', 'fail', 'inconclusive'] }, reason: { type: 'string' },
    cases: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['criterion', 'inputJson', 'expectedJson'],
      properties: {
        criterion: { type: 'string', enum: criteria.map(ref => ref.id) },
        inputJson: { type: 'string' }, expectedJson: { type: 'string' },
      },
    } },
  },
})

/** Decode provider-compatible string fields into the canonical exact JSON cases. */
export function parseModuleVerificationCases(value: unknown): { criterion: string; input: Json; expected: Json }[] {
  if (!Array.isArray(value)) throw new Error('MODULE_VERIFICATION_CASES_INVALID')
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).length !== 3 || !['criterion', 'inputJson', 'expectedJson'].every(key => Object.hasOwn(item, key))
      || typeof item.criterion !== 'string' || !item.criterion.trim() || typeof item.inputJson !== 'string' || typeof item.expectedJson !== 'string') throw new Error('MODULE_VERIFICATION_CASE_INVALID')
    let input: Json, expected: Json
    try { input = JSON.parse(item.inputJson); expected = JSON.parse(item.expectedJson); assertJson(input); assertJson(expected) }
    catch { throw new Error('MODULE_VERIFICATION_JSON_INVALID') }
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2
      || !Object.hasOwn(input, 'exportName') || !Object.hasOwn(input, 'args')
      || typeof input.exportName !== 'string' || !input.exportName.length || !Array.isArray(input.args)) throw new Error('MODULE_CASE_INVALID')
    return { criterion: item.criterion, input, expected }
  })
}

function javascriptModule(settings?: ManagedVerificationMethodSettings): ManagedVerificationMethod {
  if (!settings || !settings.entryPath) throw new Error('VERIFICATION_MODULE_ENTRY_REQUIRED')
  const entry = settings.entryPath
  // Only the host selects an entry; case data cannot supply paths or executable code.
  if (typeof entry !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_./-]*\.(?:mjs|js)$/.test(entry)
    || entry === 'candidate.mjs' || entry.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.') || ['private', 'secrets', 'node_modules'].includes(part.toLowerCase()))) {
    throw new Error('VERIFICATION_MODULE_ENTRY_INVALID')
  }
  const harness = `
const entryUrl = new URL(${JSON.stringify('./' + entry)}, import.meta.url);
function assertJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (!value || typeof value !== 'object' || seen.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw Error('MODULE_RESULT_NOT_JSON');
  seen.add(value);
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) { if (!Object.hasOwn(value, i)) throw Error('MODULE_RESULT_NOT_JSON'); assertJson(value[i], seen); } }
  else { for (const item of Object.values(value)) assertJson(item, seen); }
  seen.delete(value);
}
export async function inspect(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 || typeof input.exportName !== 'string' || !input.exportName.length || !Object.hasOwn(input, 'exportName') || !Object.hasOwn(input, 'args') || !Array.isArray(input.args)) throw Error('MODULE_CASE_INVALID');
  assertJson(input.args);
  const module = await import(entryUrl.href);
  if (!Object.hasOwn(module, input.exportName) || typeof module[input.exportName] !== 'function') throw Error('MODULE_EXPORT_NOT_CALLABLE');
  const result = await module[input.exportName](...input.args);
  assertJson(result);
  return result;
}
`
  return {
    id: 'javascript-module@1', description: 'Exact JSON input/output business acceptance against a host-configured public JavaScript module.',
    qualitySchema: moduleQualitySchema, entry: 'candidate.mjs', exportName: 'inspect', assets: { 'candidate.mjs': harness },
    instructions: 'Independently derive JSON cases from the current requirements and public module API. Each criterion must be an exact current requirement criterion id. Wire cases contain exactly criterion, inputJson and expectedJson. inputJson is strict JSON text encoding an object containing only exportName and args; expectedJson is strict JSON text encoding the exact complete JSON return value, including nulls, with no wildcards. These fields are data, never JavaScript or shell code. The host parses both JSON texts before executing the cases. Async exports are awaited. Design identical cases for baseline and candidate and identify which baseline failure discriminates each requirement. During intake report readiness and method gaps; intake is not execution evidence. Never provide shell commands or executable test code. If an observable requirement cannot be tested through the configured public module, report that precise gap; do not invent a fallback or redefine the requirement.',
  }
}

export function managedVerificationMethod(id: string, settings?: ManagedVerificationMethodSettings): ManagedVerificationMethod {
  if (id === 'javascript-module@1') return javascriptModule(settings)
  if (id !== codexReplay.id) throw new Error('VERIFICATION_METHOD_NOT_CONFIGURED:' + id)
  return codexReplay
}
export const methodAssetDigest = (value: string) => createHash('sha256').update(value).digest('hex')
