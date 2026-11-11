import type { Ref, Json } from '../../protocol/managed-work.ts'
import type { ActionReceipt, ExecutionEnvelope } from '../../kernel/actions.ts'
/** Native identity includes the backing store, not merely host + engine + thread. */
export interface SessionIdentity {
  host_ref: string
  engine_ref: string
  runtime_namespace: string
  native_session_id: string
}
export interface InputRecord {
  request_id: string
  assignment_revision: number
  payload_digest: string
  payload_ref: string
  text: string
  mode?: 'queue' | 'steer'
  expectedTurnId?: string
}
export interface InputConsumption {
  request_id: string
  assignment_revision: number
  payload_digest: string
  session_identity: SessionIdentity
  turn_id: string
  processing_started_event_ref: string
}
export type InputReceipt =
  | { request_id: string; status: 'accepted' | 'unknown' | 'rejected' }
  | { request_id: string; status: 'consumed'; consumption: InputConsumption }
export interface SessionBinding {
  ref: Ref
  identity: SessionIdentity
  epoch: number
  launchRef: Ref
  source: string
  control_version: number
}
export interface NativeEvent {
  ref: string
  identity: SessionIdentity
  cursor: string
  source: string
  kind: string
  payload: Json
}
export interface NativeEventPage {
  binding: Ref
  source: string
  runtime_namespace: string
  control_version: number
  events: NativeEvent[]
  cursor?: string
  completeness: 'complete' | 'gap' | 'unknown'
}
export interface RequestResponse {
  result?: Json
  error?: { code: number; message: string }
}
export interface NativeExecutor {
  readonly identity: SessionIdentity
  attachNative(identity: SessionIdentity, envelope: ExecutionEnvelope): SessionBinding
  execute(input: InputRecord, signal: AbortSignal): Promise<InputReceipt>
  sendNativeInput(binding: Ref, input: InputRecord): Promise<InputReceipt>
  listNativeRequests(binding: Ref): Promise<import('./requests.ts').ExecutorRequest[]>
  respondNativeRequest(
    request: Ref,
    response: RequestResponse,
    envelope: ExecutionEnvelope
  ): Promise<ActionReceipt>
  collectNativeEvents(binding: Ref, cursor?: string): Promise<NativeEventPage>
}
export interface EngineCapabilities {
  deployment_version: string
  evidence_refs: string[]
  supported: string[]
  gaps: { capability: string; owner: string; reason: string }[]
}
