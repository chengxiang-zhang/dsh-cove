/**
 * Protocol objects: closed enumerations, row shapes and the commitment state machine.
 *
 * This file is the executable half of `docs/superagent/02-协议.md`. Values are
 * copied verbatim from that document; adding a value is a protocol version change
 * made by a human together with a migration, never by a plugin (P4).
 *
 * The protocol depends on nothing. Every other superagent module may import it.
 */

export const COMMITMENT_KINDS = ['deliver', 'watch', 'remind', 'goal'] as const
export const COMMITMENT_STATES = ['proposed', 'open', 'at_risk', 'fulfilled', 'unverified',
  'broken', 'released', 'withdrawn', 'orphaned'] as const
export const OPEN_STATES = ['proposed', 'open', 'at_risk'] as const
export const TERMINAL_STATES = ['fulfilled', 'unverified', 'broken', 'released', 'withdrawn', 'orphaned'] as const
export const CHECK_KINDS = ['command', 'artifact', 'observation', 'answer'] as const
export const ORIGIN_KINDS = ['event', 'host'] as const
export const INTAKE_STATES = ['pending', 'deliberating', 'disposed'] as const
export const DISPOSITIONS = ['answer', 'commit', 'amend', 'check', 'nudge', 'release', 'pushback',
  'decline', 'ask', 'acknowledge', 'route', 'passthrough'] as const
export const ATTEMPT_STATES = ['pending', 'running', 'ended'] as const
export const LIFETIMES = ['oneshot', 'durable'] as const
export const CANCEL_ORIGINS = ['release', 'budget', 'deadline', 'stall', 'loop', 'dispatch', 'reconcile', 'external'] as const
// Session turn/end kinds plus two host values (NEEDS-DECISION N6). Unknown values
// parse to 'unknown' and are treated as failure.
export const END_REASONS = ['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked',
  'orphaned', 'dispatch_failed', 'unknown'] as const
export const JOURNAL_KINDS = ['brief', 'amend', 'nudge', 'report', 'look', 'forecast', 'state', 'pushback',
  'note', 'passthrough'] as const
export const OUTBOX_MOMENTS = ['ack', 'deliver', 'answer', 'ask', 'pushback', 'cannot', 'alert', 'brief'] as const
export const TIERS = ['reply', 'interrupt', 'brief', 'silent'] as const
export const AUDIENCES = ['requester', 'owner'] as const
export const OUTBOX_STATES = ['queued', 'sent', 'failed', 'suppressed', 'folded'] as const
export const PAYLOADS = ['text', 'react'] as const
export const MEMORY_KINDS = ['constraint', 'preference', 'precedent', 'person', 'standing'] as const
// Array order is authority order, highest first.
export const AUTHORITIES = ['owner-said', 'config', 'party-said', 'observed', 'inferred'] as const
export const MEMORY_STATES = ['active', 'superseded', 'disputed', 'retired'] as const
export const RULE_LAYERS = ['constitution', 'policy', 'technique'] as const
export const RULE_THENS = ['allow', 'draft', 'deny', 'ask', 'escalate', 'notify', 'calibrate'] as const
export const PROVENANCES = ['config', 'extracted', 'inferred'] as const
export const RULE_STATES = ['proposed', 'active', 'retired'] as const
export const RULE_PREDICATES = ['sender_class', 'party', 'audience_class', 'capability', 'path_prefix',
  'commitment_kind', 'prior_count', 'eta_bucket', 'budget_state', 'time_window', 'repo_visibility'] as const
export const CAPABILITIES = ['read', 'write_repo', 'write_host', 'change_prod', 'publish', 'commit_promise',
  'steer_foreign', 'provision'] as const
// Autonomy ceiling (06): these capabilities never reach 'allow' automatically.
export const NEVER_AUTO_CAPABILITIES = ['change_prod', 'publish', 'commit_promise'] as const
export const STRENGTHS = ['allow', 'draft', 'deny'] as const
export const ENTITY_STATES = ['proposed', 'enrolled', 'stale', 'gone', 'revoked'] as const
export const ENTITY_SOURCES = ['config', 'enroll', 'discover'] as const
export const ASSUMPTION_MODES = ['declared', 'asked'] as const
export const ASSUMPTION_STATUSES = ['open', 'answered', 'overturned'] as const
export const TRIGGER_KINDS = ['intake', 'agenda', 'report', 'brief', 'goal'] as const
export const DELIBERATION_STATES = ['requested', 'running', 'done'] as const
export const OWNERS = ['responder', 'superagent'] as const
export const ROUTES = ['judge', 'fastpath', 'passthrough'] as const
export const REPORT_STATES = ['ready', 'progress', 'blocked', 'failed', 'dropped'] as const
export const DOC_KINDS = ['handoff', 'deliverable'] as const
export const DOC_WRITERS = ['host', 'human'] as const
export const SPECULATION_STATES = ['pending', 'used', 'discarded', 'expired'] as const
// Audience classes (07).
export const AUDIENCE_CLASSES = ['owner_p2p', 'group_with_owner', 'group_without_owner', 'external'] as const

export type Of<T extends readonly string[]> = T[number]

export type CommitmentKind = Of<typeof COMMITMENT_KINDS>
export type CommitmentState = Of<typeof COMMITMENT_STATES>
export type OpenState = Of<typeof OPEN_STATES>
export type TerminalState = Of<typeof TERMINAL_STATES>
export type CheckKind = Of<typeof CHECK_KINDS>
export type OriginKind = Of<typeof ORIGIN_KINDS>
export type IntakeState = Of<typeof INTAKE_STATES>
export type Disposition = Of<typeof DISPOSITIONS>
export type AttemptState = Of<typeof ATTEMPT_STATES>
export type Lifetime = Of<typeof LIFETIMES>
export type CancelOrigin = Of<typeof CANCEL_ORIGINS>
export type EndReason = Of<typeof END_REASONS>
export type JournalKind = Of<typeof JOURNAL_KINDS>
export type OutboxMoment = Of<typeof OUTBOX_MOMENTS>
export type Tier = Of<typeof TIERS>
export type Audience = Of<typeof AUDIENCES>
export type OutboxState = Of<typeof OUTBOX_STATES>
export type Payload = Of<typeof PAYLOADS>
export type MemoryKind = Of<typeof MEMORY_KINDS>
export type Authority = Of<typeof AUTHORITIES>
export type MemoryState = Of<typeof MEMORY_STATES>
export type RuleLayer = Of<typeof RULE_LAYERS>
export type RuleThen = Of<typeof RULE_THENS>
export type Provenance = Of<typeof PROVENANCES>
export type RuleState = Of<typeof RULE_STATES>
export type RulePredicate = Of<typeof RULE_PREDICATES>
export type Capability = Of<typeof CAPABILITIES>
export type NeverAutoCapability = Of<typeof NEVER_AUTO_CAPABILITIES>
export type Strength = Of<typeof STRENGTHS>
export type EntityState = Of<typeof ENTITY_STATES>
export type EntitySource = Of<typeof ENTITY_SOURCES>
export type AssumptionMode = Of<typeof ASSUMPTION_MODES>
export type AssumptionStatus = Of<typeof ASSUMPTION_STATUSES>
export type TriggerKind = Of<typeof TRIGGER_KINDS>
export type DeliberationState = Of<typeof DELIBERATION_STATES>
export type Owner = Of<typeof OWNERS>
export type Route = Of<typeof ROUTES>
export type ReportState = Of<typeof REPORT_STATES>
export type DocKind = Of<typeof DOC_KINDS>
export type DocWriter = Of<typeof DOC_WRITERS>
export type SpeculationState = Of<typeof SPECULATION_STATES>
export type AudienceClass = Of<typeof AUDIENCE_CLASSES>

/** Returns the value when it is a member of the closed set, otherwise undefined. Never guesses. */
export function parseEnum<T extends readonly string[]>(values: T, raw: unknown): Of<T> | undefined {
  if (typeof raw !== 'string') return undefined
  return (values as readonly string[]).includes(raw) ? (raw as Of<T>) : undefined
}

/** Unknown end reasons collapse to 'unknown' and must be treated as failure (F18). */
export function parseEndReason(raw: unknown): EndReason {
  return parseEnum(END_REASONS, raw) ?? 'unknown'
}

/**
 * Fold a model-typed work class into the protocol's kebab-case id space.
 *
 * `08` first judgement names the class freely and the class table starts empty, so
 * the first model to name one is also the first to spell it: a live turn died with
 * `status_query` and the turn was lost. Folding is the host's job, not the model's -
 * the ledger keeps one spelling per class (`primary class` readings group by it).
 */
export function normalizeClassId(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '').replace(/-{2,}/g, '-').slice(0, 41).replace(/-+$/, '')
}

/** Commitment state machine from 02, edge by edge. Terminal states have no outgoing edges. */
export const COMMITMENT_TRANSITIONS: Readonly<Record<CommitmentState, readonly CommitmentState[]>> = {
  proposed: ['open', 'released', 'withdrawn', 'orphaned'],
  open: ['at_risk', 'fulfilled', 'unverified', 'broken', 'released', 'withdrawn', 'orphaned'],
  at_risk: ['fulfilled', 'unverified', 'broken', 'released', 'withdrawn', 'orphaned'],
  fulfilled: [], unverified: [], broken: [], released: [], withdrawn: [], orphaned: [],
}

export function canTransition(from: CommitmentState, to: CommitmentState): boolean {
  return COMMITMENT_TRANSITIONS[from]?.includes(to) ?? false
}

// Row shapes. Field names are the snake_case column names of the T04 DDL so that
// reading SQL and code share one vocabulary. `*_json` columns stay raw strings;
// their consumers parse them. Every row carries `created_at`; mutable rows also
// carry `updated_at` (NEEDS-DECISION N10). Times are epoch milliseconds.

type Ms = number
type Flag = 0 | 1

interface Created { created_at: Ms }
interface Mutable extends Created { updated_at: Ms | null }

export interface PartyRow extends Mutable {
  party_id: string
  kind: 'person' | 'executor' | 'session'
  union_id: string | null
  open_id: string | null
  display: string | null
  class: 'owner' | 'colleague' | 'member' | 'external' | 'executor' | 'watched'
  source: 'config' | 'observed'
  manifest_json: string | null
}

export interface DeskRow extends Mutable {
  desk_id: string
  chat_id: string
  chat_type: 'p2p' | 'group'
  session_id: string | null
  generation: number
  audience_json: string | null
  audience_class: AudienceClass | null
  cwd: string | null
  turn_open: Flag
  event_count: number
  last_event_at: Ms | null
}

export interface IntakeRow extends Mutable {
  event_id: string
  shadow: Flag
  owner: Owner
  sender: string
  desk_id: string | null
  thread_key: string
  state: IntakeState
  disposition: Disposition | null
  about: string | null
  class: string | null
  confidence: number | null
  pred_eta_min: number | null
  pred_executor: string | null
  pred_executor_reason: string | null
  reason: string | null
  alternative: string | null
  corrects: string | null
  new_thread: Flag | null
  deliberation_id: string | null
}

export interface CommitmentRow extends Mutable {
  commitment_id: string
  n: number
  parent_id: string | null
  kind: CommitmentKind
  debtor: string
  creditor: string
  on_behalf_of: string | null
  ball: string
  desk_id: string | null
  thread_key: string | null
  origin_kind: OriginKind
  origin_ref: string
  work_class: string | null
  what: string
  intent: string
  check_kind: CheckKind
  done_when: string
  boundary: string | null
  target: string | null
  state: CommitmentState
  slot: string | null
  due_at: Ms | null
  eta_at: Ms | null
  next_look_at: Ms | null
  eta_model_min: number | null
  eta_factor: number | null
  budget_wall_ms: number | null
  budget_turns: number | null
  used_wall_ms: number
  used_turns: number
  used_tokens: number
  extended: Flag
  evidence_json: string | null
  actual_min: number | null
  attempts: number
  executor_switched: Flag
  closed_at: Ms | null
}

export interface AssumptionRow extends Mutable {
  commitment_id: string
  ordinal: number
  question: string
  taken: string
  reversible: Flag
  mode: AssumptionMode
  status: AssumptionStatus
  resolved_by: string | null
}

export interface AttemptRow extends Mutable {
  attempt_id: string
  commitment_id: string
  n: number
  executor: string
  provider: string | null
  model: string | null
  effort: string | null
  reason: string
  lifetime: Lifetime
  session_id: string | null
  cwd: string | null
  /** Machine canonical for a dispatched session; null/absent means this host. */
  host?: string | null
  branch: string | null
  state: AttemptState
  turn_open: Flag
  turns: number
  tool_calls: number
  last_tool_at: Ms | null
  repeat_sig: string | null
  repeat_count: number
  end_reason: EndReason | null
  cancel_origin: CancelOrigin | null
  started_at: Ms | null
  ended_at: Ms | null
}

/** Append-only (P2): no updated_at; only consumed_turn may go from NULL to a value. */
export interface JournalRow extends Created {
  commitment_id: string
  seq: number
  actor: string
  kind: JournalKind
  request_id: string | null
  consumed_turn: number | null
  verified: Flag | null
  body_json: string | null
}

export interface OutboxRow extends Mutable {
  outbox_id: string
  idem_key: string
  chat_id: string
  reply_to: string | null
  event_id: string | null
  commitment_id: string | null
  payload: Payload
  body: string
  moment: OutboxMoment
  tier: Tier
  audience: Audience
  words: number
  expects_reply: Flag
  deliver: Flag
  lease_epoch: number
  state: OutboxState
  attempts: number
  next_attempt_at: Ms | null
  message_id: string | null
  error: string | null
  sent_at: Ms | null
}

export interface LeaseRow extends Mutable {
  name: 'outlet'
  holder: string
  epoch: number
  heartbeat_at: Ms
  expires_at: Ms
}

export interface MemoryRow extends Mutable {
  memory_id: string
  kind: MemoryKind
  topic: string
  about: string | null
  body: string
  authority: Authority
  source_event: string | null
  source_quote: string | null
  commitment_id: string | null
  supersedes: string | null
  state: MemoryState
  use_set: string | null
  say_set: string | null
  last_used_at: Ms | null
}

export interface RuleRow extends Mutable {
  rule_id: string
  scope_path: string
  layer: RuleLayer
  when_json: string
  then: RuleThen
  exceptions_json: string | null
  priority: number
  provenance: Provenance
  version: number
  state: RuleState
  approved_by: string | null
  rollback_if: string | null
  weight: number | null
  hits: number
  last_hit_at: Ms | null
}

export interface RuleReplayRow extends Created {
  replay_id: string
  rule_id: string
  sample_size: number
  changed: number
  changed_ratio: number
  direction_json: string | null
  passed: Flag
}

export interface RuleConflictRow extends Mutable {
  conflict_id: string
  rule_a: string
  rule_b: string
  detail: string | null
  resolved_at: Ms | null
}

export interface MandateRow extends Mutable {
  mandate_id: string
  principal: string
  scope_path: string
  capability: Capability
  strength: Strength
  policy_version: number
  granted_by: string
  granted_at: Ms
  revoked_at: Ms | null
  revoked_by: string | null
}

export interface WorldEntityRow extends Mutable {
  entity_id: string
  canonical: string
  kind: 'host' | 'repo' | 'org' | 'session'
  realm: 'local' | 'netbird' | 'external'
  path: string
  state: EntityState
  source: EntitySource
  lease_until: Ms | null
  manifest_json: string | null
  revoked_by: string | null
}

export interface WorldAliasRow extends Mutable {
  alias: string
  entity_id: string
  kind: 'ip' | 'ssh' | 'dns' | 'spoken'
}

export interface WorldAddrRow extends Mutable {
  addr_id: string
  entity_id: string
  kind: 'lan' | 'wifi' | 'netbird' | 'dns'
  address: string
  priority: number
}

export interface WorkspaceRow extends Mutable {
  path: string
  entity_id: string | null
  commitment_id: string | null
  mandate_id: string | null
  branch: string | null
  removed_at: Ms | null
}

export interface WorkClassRow extends Mutable {
  class_id: string
  samples: number
  eta_factor: number
  ask_mode: 'declare' | 'ask'
  pushback_mode: 'on' | 'muted'
  preferred_executor: string | null
  misjudge_rate: number | null
  p90_turns: number | null
}

export interface AutonomyRow extends Mutable {
  class_id: string
  capability: Capability
  strength: Strength
  streak: number
  streak_days_json: string | null
  demoted_at: Ms | null
}

export interface SpeculationRow extends Mutable {
  spec_id: string
  kind: 'probe' | 'prep' | 'patrol'
  commitment_id: string | null
  desk_id: string | null
  path: string | null
  state: SpeculationState
}

export interface DeliberationRow extends Mutable {
  deliberation_id: string
  request_id: string
  desk_id: string | null
  commitment_id: string | null
  trigger_kind: TriggerKind
  state: DeliberationState
  shadow: Flag
  started_at: Ms | null
  ended_at: Ms | null
  window_id: number | null
  audience_class: AudienceClass | null
  pub_hash: string | null
  dossier_hash: string | null
  dossier_tokens: number | null
  rule_trace: string | null
  ops: number
  tool_errors: number
  tokens: number | null
  end_reason: EndReason | null
}

export interface SubscriptionRow extends Mutable {
  thread_key: string
  commitment_id: string
  attempt_id: string
  input_seq: number
}

export interface DocIndexRow extends Created {
  doc_id: string
  path: string
  title: string
  kind: DocKind
  commitment_id: string | null
  added_by: DocWriter
  added_at: Ms
}

export interface DegradeEventRow extends Mutable {
  degrade_id: string
  reason: string
  scope: string
  started_at: Ms
  ended_at: Ms | null
}
