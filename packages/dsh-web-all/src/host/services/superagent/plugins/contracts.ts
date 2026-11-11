/** Host-independent logical plugin contracts. No business state is owned here. */
/** id is a provider instance binding (e.g. account/runtime), contract identifies its interface. Omission means the instance id itself is the contract. */
export interface PortDeclaration { id: string; version: string; contract?: string }
export interface PluginManifest {
  id: string
  namespace: string
  version: string
  contract_version: string
  provides: readonly PortDeclaration[]
  requires: readonly PortDeclaration[]
  compatible_schema_versions: readonly string[]
  config_schema: { validate(value: unknown): boolean }
  config?: unknown
  owned_state_schemas: readonly { id: string; version: string; retention: string }[]
  migration_refs: readonly string[]
  permission_requirements: readonly string[]
  isolation_mode: string
  reload_class: 'domain-controlled' | 'restart-required'
  contract_test_refs: readonly string[]
  required_extensions: readonly string[]
}
export interface PluginCapabilities {
  contract_version: string
  schema_versions: readonly string[]
  permissions: readonly string[]
  extensions: readonly string[]
  isolated_modes: readonly string[]
  now: number
  qualifications: readonly {
    plugin_id: string; version: string; evidence_ref: string; expires_at: number
  }[]
}
export type CapabilitySource = PluginCapabilities | (() => PluginCapabilities)
export interface Rejection { ok: false; code: string; plugin_id: string; subject: string }
export interface ResolvedGraph {
  ok: true
  order: readonly string[]
  manifests: readonly PluginManifest[]
  checkAdmission(pluginId?: string): Rejection | undefined
  providers: ReadonlyMap<string, { plugin_id: string; version: string; contract: string }>
}
export interface HostPort {
  readonly host_ref: string
  readonly loading_mode: 'domain-controlled'
  now(): number
  onDispose(callback: () => void): void
}
/** Proposals remain opaque here; managed-work owns domain definitions. */
export interface CoordinatorRuntimePort<Input = unknown, Proposal = unknown> {
  run(input: Input, signal: AbortSignal): Promise<Proposal>
}
export interface ExecutorIdentity {
  host_ref: string
  engine_ref: string
  runtime_namespace: string
  native_session_id: string
}
export interface ExecutorInput {
  request_id: string
  assignment_revision: number
  payload_digest: string
  payload_ref: string
}
export interface InputConsumption {
  request_id: string
  assignment_revision: number
  payload_digest: string
  session_identity: ExecutorIdentity
  turn_id: string
  processing_started_event_ref: string
}
export type ExecutorReceipt =
  | { request_id: string; status: 'accepted' | 'unknown' | 'rejected' }
  | { request_id: string; status: 'consumed'; consumption: InputConsumption }
export interface ExecutorPort<Command = ExecutorInput, Receipt = ExecutorReceipt> {
  readonly identity: ExecutorIdentity
  execute(command: Command, signal: AbortSignal): Promise<Receipt>
}
