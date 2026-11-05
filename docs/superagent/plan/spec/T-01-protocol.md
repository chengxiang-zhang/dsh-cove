# T-01 协议：类型（T01）与 DDL（T04）

设计依据：`02-协议`（唯一契约源）、`03-内核`（四个注入接口）、`11-恢复与降级`（启动自检）。本 spec 与 `02` 冲突时以 `02` 为准并报 Lead；`02` 没写而本 spec 补的，标〔推断〕并已列入 NEEDS-DECISION。

## T01 协议类型

写域：`SA/protocol/objects.ts`、`SA/protocol/tools.ts`、`SA/protocol/events.ts`、`SA/kernel/ports.ts`、`SA/host-ports.ts`、`FX/manual-clock.ts`、`FX/fake-controller.ts`、`FX/fake-channel.ts`、`TS/superagent-protocol.spec.ts`、`TS/superagent-deps.spec.ts`。

前置：W0 全部 spike 有读数（本任务不依赖其结论，但按 PLAN 不过闸不开 W1）。

### objects.ts：封闭枚举（数组常量 + 联合类型，值与 `02` 逐字一致）

```ts
export const COMMITMENT_KINDS = ['deliver', 'watch', 'remind', 'goal'] as const
export const COMMITMENT_STATES = ['proposed', 'open', 'at_risk', 'fulfilled', 'unverified',
  'broken', 'released', 'withdrawn', 'orphaned'] as const
export const OPEN_STATES = ['proposed', 'open', 'at_risk'] as const
export const TERMINAL_STATES = ['fulfilled', 'unverified', 'broken', 'released', 'withdrawn', 'orphaned'] as const
export const CHECK_KINDS = ['command', 'artifact', 'observation', 'answer'] as const
export const ORIGIN_KINDS = ['event', 'host'] as const
export const INTAKE_STATES = ['pending', 'deliberating', 'disposed'] as const
export const DISPOSITIONS = ['answer', 'commit', 'amend', 'check', 'nudge', 'release', 'pushback',
  'decline', 'ask', 'acknowledge', 'route', 'passthrough'] as const          // 12 值
export const ATTEMPT_STATES = ['pending', 'running', 'ended'] as const
export const LIFETIMES = ['oneshot', 'durable'] as const
export const CANCEL_ORIGINS = ['release', 'budget', 'deadline', 'stall', 'loop', 'dispatch', 'reconcile'] as const
// end_reason：会话 turn/end 的 kind 原值 + 宿主两值（NEEDS-DECISION N6）；未知一律 'unknown' 并当失败
export const END_REASONS = ['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked',
  'orphaned', 'dispatch_failed', 'unknown'] as const
export const JOURNAL_KINDS = ['brief', 'amend', 'nudge', 'report', 'look', 'forecast', 'state', 'pushback',
  'note', 'passthrough'] as const                                                // 10 值
export const OUTBOX_MOMENTS = ['ack', 'deliver', 'answer', 'ask', 'pushback', 'cannot', 'alert', 'brief'] as const
export const TIERS = ['reply', 'interrupt', 'brief', 'silent'] as const
export const AUDIENCES = ['requester', 'owner'] as const
export const OUTBOX_STATES = ['queued', 'sent', 'failed', 'suppressed', 'folded'] as const
export const PAYLOADS = ['text', 'react'] as const
export const MEMORY_KINDS = ['constraint', 'preference', 'precedent', 'person', 'standing'] as const
export const AUTHORITIES = ['owner-said', 'config', 'party-said', 'observed', 'inferred'] as const  // 数组序即权威序，高在前
export const MEMORY_STATES = ['active', 'superseded', 'disputed', 'retired'] as const
export const RULE_LAYERS = ['constitution', 'policy', 'technique'] as const
export const RULE_THENS = ['allow', 'draft', 'deny', 'ask', 'escalate', 'notify', 'calibrate'] as const
export const PROVENANCES = ['config', 'extracted', 'inferred'] as const
export const RULE_STATES = ['proposed', 'active', 'retired'] as const
export const RULE_PREDICATES = ['sender_class', 'party', 'audience_class', 'capability', 'path_prefix',
  'commitment_kind', 'prior_count', 'eta_bucket', 'budget_state', 'time_window', 'repo_visibility'] as const
export const CAPABILITIES = ['read', 'write_repo', 'write_host', 'change_prod', 'publish', 'commit_promise',
  'steer_foreign', 'provision'] as const
export const NEVER_AUTO_CAPABILITIES = ['change_prod', 'publish', 'commit_promise'] as const  // 06 自动度天花板
export const STRENGTHS = ['allow', 'draft', 'deny'] as const
export const ENTITY_STATES = ['proposed', 'enrolled', 'stale', 'gone', 'revoked'] as const
export const ENTITY_SOURCES = ['config', 'enroll', 'discover'] as const
export const ASSUMPTION_MODES = ['declared', 'asked'] as const
export const ASSUMPTION_STATUSES = ['open', 'answered', 'overturned'] as const      // 〔推断〕02 未列值
export const TRIGGER_KINDS = ['intake', 'agenda', 'report', 'brief', 'goal'] as const
export const DELIBERATION_STATES = ['requested', 'running', 'done'] as const
export const OWNERS = ['responder', 'superagent'] as const
export const ROUTES = ['judge', 'fastpath', 'passthrough'] as const
export const REPORT_STATES = ['ready', 'progress', 'blocked', 'failed', 'dropped'] as const
export const DOC_KINDS = ['handoff', 'deliverable'] as const
export const DOC_WRITERS = ['host', 'human'] as const
export const SPECULATION_STATES = ['pending', 'used', 'discarded', 'expired'] as const  // 〔推断〕
export const AUDIENCE_CLASSES = ['owner_p2p', 'group_with_owner', 'group_without_owner', 'external'] as const // 07 受众类
export type Of<T extends readonly string[]> = T[number]
export function parseEnum<T extends readonly string[]>(values: T, raw: unknown): Of<T> | undefined
export function parseEndReason(raw: unknown): Of<typeof END_REASONS>   // 未知 → 'unknown'
```

行对象接口（字段名用 snake_case，与列名一致，便于读数 SQL 与代码共用）：`CommitmentRow`、`IntakeRow`、`AssumptionRow`、`AttemptRow`、`JournalRow`、`OutboxRow`、`LeaseRow`、`MemoryRow`、`RuleRow`、`MandateRow`、`WorldEntityRow`、`DeliberationRow`、`SubscriptionRow`、`DocIndexRow`、`DegradeEventRow`、`DeskRow`、`PartyRow`、`WorkspaceRow`、`WorkClassRow`、`AutonomyRow`、`SpeculationRow`。字段即本 spec T04 DDL 的列，一一对应；`*_json` 列在行对象里是 `string | null`，解析由使用方负责。

状态机表（`02` 的 commitment 状态机，逐边）：

```ts
export const COMMITMENT_TRANSITIONS: Readonly<Record<CommitmentState, readonly CommitmentState[]>> = {
  proposed: ['open', 'released', 'withdrawn', 'orphaned'],
  open: ['at_risk', 'fulfilled', 'unverified', 'broken', 'released', 'withdrawn', 'orphaned'],
  at_risk: ['fulfilled', 'unverified', 'broken', 'released', 'withdrawn', 'orphaned'],
  fulfilled: [], unverified: [], broken: [], released: [], withdrawn: [], orphaned: [],
}
export function canTransition(from: CommitmentState, to: CommitmentState): boolean
```

### tools.ts：桌面工具与执行体工具的入参、出参、错误码

```ts
export const DESK_TOOL_NAMES = ['judge', 'commit', 'amend', 'release', 'pushback', 'look', 'remember', 'propose', 'say'] as const
export type ToolResult<T> = ({ ok: true } & T) | { ok: false; code: ToolErrorCode; message: string }
export interface JudgeInput { event_id: string; disposition: Disposition; about?: string; class: string;
  confidence: number; reason: string; corrects?: string; new_thread?: boolean }
export interface CommitInput { event_id: string; kind: CommitmentKind; what: string; intent: string;
  check_kind: CheckKind; done_when: string; boundary_extra?: string;
  assumptions?: { question: string; taken: string; reversible: boolean }[];   // ≤5
  executor: string; executor_reason: string; eta_minutes: number; target?: string; budget_scale?: number }
export interface CommitOutput { commitment_id: string; state: CommitmentState; eta_at: number; mandate: string; asked_ordinal?: number }
export interface AmendInput { commitment_id: string; text: string; overturns?: number[] }
export interface AmendOutput { seq: number; delivery: 'queued' | 'next-attempt' }
export interface ReleaseInput { commitment_id: string; reason: string }
export interface ReleaseOutput { state: CommitmentState; worktree: 'kept' | 'removed'; changes: string }
export interface PushbackInput { event_id: string; commitment_id?: string; concern: string; grounds: string[]; alternative: string }
export interface LookInput { what: 'commitment' | 'memory' | 'attempt' | 'doc'; id?: string; q?: string; limit?: number }
export interface RememberInput { kind: MemoryKind; topic: string; body: string; quote?: string; about?: string; supersedes?: string }
export interface ProposeInput { goal_id: string; items: { what: string; intent: string; done_when: string }[] }  // ≤3
export interface SayInput { event_id?: string; commitment_id?: string; moment: OutboxMoment; text: string }
export interface SayOutput { outbox_id: string; tier: Tier; words: number }
export interface ReportInput { state: ReportState; summary: string;                    // ≤2000 字符
  evidence?: { command: string; exit: number; reading: string }[];                     // reading ≤500
  question?: string }
export const TOOL_ERROR_CODES = {
  judge: ['ALREADY_DISPOSED', 'NOT_IN_BATCH', 'LIVE_THREAD_FORBIDS', 'ABOUT_NOT_VISIBLE', 'NEW_THREAD_REASON_REQUIRED'],
  commit: ['CHECK_MISSING', 'ASK_REQUIRED', 'TOO_MANY_ASSUMPTIONS', 'THREAD_BUSY', 'CLASS_UNKNOWN', 'SLOT_FULL',
           'BUDGET_OVER_CAP', 'BOUNDARY_DENIED', 'EXECUTOR_UNKNOWN', 'EXECUTOR_MISMATCH'],
  amend: ['TERMINAL', 'NOT_VISIBLE'],
  release: ['NOT_PERMITTED', 'TERMINAL'],
  pushback: ['NO_GROUNDS', 'PUSHBACK_REPEAT', 'PUSHBACK_QUIET'],
  look: ['NOT_VISIBLE', 'MISSING'],
  remember: ['QUOTE_NOT_IN_TRIGGER', 'CONFLICTS', 'SUPERSEDE_FORBIDDEN'],
  propose: ['NOT_GOAL', 'PROPOSAL_OPEN'],
  say: ['TOO_LONG', 'MOMENT_FORBIDDEN', 'REPLY_EXISTS', 'DISCLOSE_BLOCKED', 'PROMISE_BLOCKED', 'NO_LEASE'],
  report: ['QUESTION_REQUIRED'],
  kernel: ['ILLEGAL_TRANSITION', 'LEDGER_ASYNC_TX', 'SHADOW_NO_WRITE'],   // 后两者〔推断〕，内核内部
} as const
```

### events.ts：三种事件与通道契约

```ts
export interface InboundEvent { event_id: string; chat: { id: string; type: 'p2p' | 'group' };
  sender: { open_id: string; union_id?: string }; thread: string; text: string; message_id: string; received_at: number }
export interface ExecutorReportEvent { attempt_id: string; report: ReportInput; turn_end_reason?: EndReason }
export interface TickEvent { now: number; due: string[] }
export interface Channel {                       // 02 通道契约，五方法
  inbound(handler: (event: InboundEvent) => void): () => void
  send(chatId: string, text: string, replyTo: string | undefined, idemKey: string): Promise<{ messageId: string }>
  react(messageId: string, emoji: string): Promise<void>
  audience(chatId: string): Promise<{ party_ids: string[]; has_owner: boolean }>
  history(chatId: string, limit: number): Promise<{ message_id: string; sender_is_self: boolean; reply_to?: string; at: number }[]>
}
export function threadKey(chatType: 'p2p' | 'group', chatId: string, rootMessageId: string): string  // 'p2p:<chat>:<root>'
```

### kernel/ports.ts：内核四个注入接口（类型）

```ts
export interface ClaimSnapshot { liveCommitmentOnThread?: string; liveSubscription?: { commitment_id: string; attempt_id: string };
  openQuestionOnDesk?: { commitment_id: string; ordinal: number }; openProposalsOnDesk: string[] }
// 快照只含账本事实；发送者身份类由 ClaimPolicy 的实现（判断模块）自己向世界模型查，内核不读 sa_party
export interface ClaimDecision { owner: Owner; route: Route; disposition?: Disposition; detail?: Record<string, unknown> }
export interface ClaimPolicy { decide(event: InboundEvent, snapshot: ClaimSnapshot): ClaimDecision }
export interface Signal { kind: string; detail: Record<string, unknown> }
export interface TickSignal { has(commitmentId: string, now: number): Signal | null }
export interface SpeechProposal { event_id?: string; commitment_id?: string; chat_id: string; reply_to?: string;
  moment: OutboxMoment; audience: Audience; payload: Payload; text: string; idem_key: string; expects_reply?: boolean }
export interface OutletVerdict { ok: true; tier: Tier; text: string; words: number } |
  { ok: false; code: 'TOO_LONG' | 'MOMENT_FORBIDDEN' | 'DISCLOSE_BLOCKED' | 'PROMISE_BLOCKED'; message: string }
export interface OutletPolicy { check(proposal: SpeechProposal, now: number): OutletVerdict }
export interface SenderPort { send(chatId: string, text: string, idemKey: string, replyTo?: string): Promise<{ messageId: string }>;
  react(messageId: string, emoji: string): Promise<void> }
export interface TurnRequest { deliberation_id: string; request_id: string; desk_id?: string; commitment_id?: string; trigger_kind: TriggerKind }
```

### deps spec（`TS/superagent-deps.spec.ts`）

读 `SA/**/*.ts` 的全部相对 import，把路径映射为模块（目录第一段：`protocol kernel world memory rules desk judgment timing surface executors recovery channels capabilities`；`host-ports.ts` 与根 `index.ts` 单列），按下表判定。表就是 `README` 的精确边表，`timing` 与 `surface` 同属"时机与措辞"。

| 模块 | 允许 import 的 SA 模块 |
| --- | --- |
| protocol | 无 |
| kernel | protocol |
| world | protocol |
| memory | protocol、world |
| rules | protocol、world |
| executors | protocol、kernel、world、host-ports |
| judgment | protocol、kernel、rules、memory、world、executors |
| desk | protocol、kernel、rules、memory、world、judgment、host-ports |
| timing、surface | protocol、kernel、rules（以及彼此） |
| recovery | protocol、kernel、desk、executors、world、host-ports |
| channels | protocol、host-ports（SA 外：`CORE/`、`../../feishu/`、`../../family-config.ts`、`../../access-trust/`、`../../resources.ts` 允许） |
| capabilities | protocol、world |
| host-ports.ts | 无 |
| 根 index.ts | 全部 |

此外：`SA` 外的任何文件不得 import `SA/` 下除 `index.ts` 以外的路径（`TS/` 测试例外）。

### T01 单测清单

`TS/superagent-protocol.spec.ts`：

1. `DISPOSITIONS` 恰 12 值且与 `02` 列表逐字相等（fixture：内联期望数组）；负控：删一个值即红。
2. `COMMITMENT_STATES` 恰 9 值，`TERMINAL_STATES` 恰 6 值，二者与 `OPEN_STATES` 两两不交且并集 = 全部。
3. `JOURNAL_KINDS` 10 值、`OUTBOX_MOMENTS` 8 值、`TIERS` 4 值、`CAPABILITIES` 8 值、`RULE_PREDICATES` 11 值、`CANCEL_ORIGINS` 7 值。
4. `canTransition` 对 9×9 全矩阵与 `COMMITMENT_TRANSITIONS` 一致；断言 `open→fulfilled` 真、`at_risk→open` 假、任一终态出边全假。
5. `parseEndReason('weird')` = `'unknown'`；对 `END_REASONS` 每个值往返不变。
6. `DESK_TOOL_NAMES` 恰 9 个、顺序与 `02` 桌面工具表一致；`TOOL_ERROR_CODES` 每个工具的错误码集合与 `02` 表一致。
7. `threadKey('p2p','oc_x','m17')` = `'p2p:oc_x:m17'`；chatType 非法抛错。
8. `FX/fake-controller`：`create` 后 `emit` 两个事件，`inspect` 返回同序两个事件；注入 `create` 失败时 reject。
9. `FX/fake-channel`：`send` 记录到 `sent`，同一 idemKey 第二次 `send` 返回同一 messageId（模拟飞书 uuid 幂等）。
10. `FX/manual-clock`：`advance(60_000)` 恰触发一次 60 秒间隔回调。

`TS/superagent-deps.spec.ts`：

1. 真实 `SA` 目录下全部 import 边都在允许表内（目录为空的模块视为通过）。
2. `SA/kernel/**` 只 import `protocol`、`kernel` 自身。
3. `SA` 外文件 import `SA/` 只经 `index.ts`。
4. 自证：对一份内联的合成边表（`kernel → desk`）运行同一判定函数，必须报告 1 条违规（负控内置在测试里，保证检查器本身会红）。

### T01 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-protocol.spec.ts` | passed=10，failed=0，退出码 0 | 把 `DISPOSITIONS` 的 `'route'` 删掉 → 第 1 条红，退出码 1 |
| `VT tests/superagent-deps.spec.ts` | passed=4，退出码 0 | 在 `SA/kernel/ports.ts` 加 `import type {} from '../desk/x.ts'` → 第 1、2 条红 |
| G1–G6 | 见 T-00 | 见 T-00 |

## T04 DDL 与迁移（`SA/protocol/db.ts`）

写域：`SA/protocol/db.ts`、`FX/memdb.ts`、`TS/superagent-db.spec.ts`。依赖：T01。

### 契约

```ts
export const SCHEMA_VERSION = 1
export const PHYSICAL: Readonly<Record<LogicalTable, string>>   // 'commitment' → 'sa_commitment'；'inbox_event' → 'inbox_events'
export function migrate(db: DatabaseSync): { added: string[] }  // 单事务；幂等；PRAGMA 判列再 ALTER
export function selfCheck(db: DatabaseSync): { ok: true } | { ok: false; missing: string[] }  // 缺表缺列即 ok:false
export function openLedgerDb(path: string): DatabaseSync         // WAL、busy_timeout=5000、synchronous=NORMAL、foreign_keys=ON，再 migrate + selfCheck，失败抛错拒绝启动

// 账本事务与只读视图的接口类型：定义在协议里，由内核 T08 实现。
// 世界、记忆、规则三个模块只依赖协议（README 边表），因此它们拿到的是这两个接口，不 import 内核。
export interface LedgerTx {
  run(sql: string, ...params: SqlParam[]): { changes: number }   // 运行期校验目标表在调用方模块的白名单内，否则抛 TABLE_NOT_OWNED
  get<T>(sql: string, ...params: SqlParam[]): T | undefined
  all<T>(sql: string, ...params: SqlParam[]): T[]
  readonly now: number                                            // 事务开始时的宿主时钟
}
export interface LedgerReader { get<T>(sql: string, ...params: SqlParam[]): T | undefined; all<T>(sql: string, ...params: SqlParam[]): T[] }
export type SqlParam = string | number | null
export const TABLE_OWNERS: Readonly<Record<string, 'kernel' | 'world' | 'memory' | 'rules' | 'desk' | 'judgment' | 'timing' | 'executors' | 'recovery'>>
// kernel: intake commitment journal outbox lease inbox_events(owner 列)
// desk: deliberation；judgment: subscription（归属以 02 对象目录为准）
// world: party world_entity world_alias world_addr mandate workspace
// memory: memory doc_index ； rules: rule rule_replay rule_conflict work_class autonomy
// desk: desk ； judgment: assumption ； timing: speculation ； executors: attempt ； recovery: degrade_event
```

`migrate` 对既有 `inbox_events` 只做一件事：若无 `owner` 列则 `ALTER TABLE inbox_events ADD COLUMN owner TEXT CHECK (owner IS NULL OR owner IN ('responder','superagent'))`，并建触发器 `sa_inbox_owner_cas`：`BEFORE UPDATE OF owner ON inbox_events WHEN OLD.owner IS NOT NULL AND NEW.owner IS NOT OLD.owner BEGIN SELECT RAISE(ABORT,'OWNER_ALREADY_SET'); END`。不动 `inbox_events` 其他列、不动 `reply_jobs`。

### 表（全部 `CREATE TABLE IF NOT EXISTS`；时间列 epoch 毫秒；每表有 `created_at INTEGER NOT NULL`，可变表另有 `updated_at`，见 N10）

| 物理表 | 列（主键加粗含义写在约束列） | 约束、索引、触发器 |
| --- | --- | --- |
| `sa_party` | party_id、kind(person/executor/session)、union_id、open_id、display、class(owner/colleague/member/external/executor/watched)、source(config/observed)、manifest_json | PK party_id；UNIQUE union_id；CHECK `class NOT IN ('owner','colleague') OR source='config'`（G6） |
| `sa_desk` | desk_id、chat_id、chat_type(p2p/group)、session_id、generation、audience_json、audience_class、cwd、turn_open、event_count、last_event_at | PK desk_id；UNIQUE chat_id；UNIQUE session_id（非空时） |
| `sa_intake` | event_id、shadow、owner、sender、desk_id、thread_key、state、disposition、about、class、confidence、pred_eta_min、pred_executor、pred_executor_reason、reason、alternative、corrects、new_thread、deliberation_id | PK (event_id, shadow)；CHECK shadow IN (0,1)；CHECK `(state='disposed') = (disposition IS NOT NULL)`；CHECK `disposition IS NOT 'decline' OR (reason IS NOT NULL AND alternative IS NOT NULL)`（R4）；枚举 CHECK |
| `sa_commitment` | commitment_id、n、parent_id、kind、debtor、creditor、on_behalf_of、ball、desk_id、thread_key、origin_kind、origin_ref、work_class、what、intent、check_kind、done_when、boundary、target、state、slot、due_at、eta_at、next_look_at、eta_model_min、eta_factor、budget_wall_ms、budget_turns、used_wall_ms、used_turns、used_tokens、extended、evidence_json、actual_min、attempts、executor_switched、closed_at | PK commitment_id（`'C-'||n`）；UNIQUE n；UNIQUE origin_ref；CHECK 开着必有 next_look_at；CHECK `state<>'fulfilled' OR evidence_json IS NOT NULL`；CHECK `kind<>'watch' OR target IS NOT NULL`；CHECK `kind<>'deliver' OR (budget_wall_ms IS NOT NULL AND budget_turns IS NOT NULL)`；CHECK 终态必有 closed_at；CHECK `origin_kind<>'host' OR kind IN ('goal','remind','watch')`；部分唯一 `ux_sa_commit_thread(thread_key, debtor) WHERE kind='deliver' AND parent_id IS NULL AND state IN ('proposed','open','at_risk')`；部分唯一 `ux_sa_commit_slot(slot) WHERE slot IS NOT NULL AND state IN ('open','at_risk')`（N2）；触发器 `sa_commit_terminal`：`BEFORE UPDATE WHEN OLD.state IN (终态)` → `RAISE(ABORT,'TERMINAL')` |
| `sa_assumption` | commitment_id、ordinal、question、taken、reversible、mode、status、resolved_by | PK (commitment_id, ordinal)；部分唯一 `(commitment_id) WHERE mode='asked' AND status='open'` |
| `sa_attempt` | attempt_id、commitment_id、n、executor、provider、model、effort、reason、lifetime、session_id、cwd、branch、state、turn_open、turns、tool_calls、last_tool_at、repeat_sig、repeat_count、end_reason、cancel_origin、started_at、ended_at | PK attempt_id；UNIQUE session_id（非空时）；CHECK n BETWEEN 1 AND 3；CHECK reason 非空（R10）；部分唯一 `(commitment_id) WHERE state IN ('pending','running')`；触发器 `sa_attempt_running_budget`：转 running 时所属 deliver 承诺止损为空 → `RAISE(ABORT,'NO_BUDGET')`（I3） |
| `sa_journal` | commitment_id、seq、actor、kind、request_id、consumed_turn、verified、body_json | PK (commitment_id, seq)；UNIQUE request_id（非空时）；CHECK `length(body_json) <= 8000`；触发器拒删；触发器拒改，唯一例外是 consumed_turn 由 NULL 写成一个值（P2） |
| `sa_outbox` | outbox_id、idem_key、chat_id、reply_to、event_id、commitment_id、payload、body、moment、tier、audience、words、expects_reply、deliver、lease_epoch、state、attempts、next_attempt_at、message_id、error、sent_at | PK outbox_id；UNIQUE idem_key；CHECK `length(idem_key) <= 50`（飞书 uuid 上限，F19）；CHECK words ≤ 100；CHECK `payload<>'react' OR words=0`；部分唯一 `(event_id) WHERE tier='reply' AND payload='text' AND event_id IS NOT NULL`（I2） |
| `sa_lease` | name、holder、epoch、heartbeat_at、expires_at | PK name；CHECK `name='outlet'`（单行） |
| `sa_memory` | memory_id、kind、topic、about、body、authority、source_event、source_quote、commitment_id、supersedes、state、use_set、say_set、last_used_at | PK memory_id；部分唯一 `(topic, kind) WHERE state='active'`；CHECK 原话类必带 source_event 与 source_quote；触发器拒删；触发器只允许改 state 与 last_used_at |
| `sa_rule` | rule_id、scope_path、layer、when_json、then、exceptions_json、priority、provenance、version、state、approved_by、rollback_if、weight、hits、last_hit_at | PK rule_id；CHECK `provenance<>'inferred' OR layer='technique'`；CHECK `provenance<>'inferred' OR state<>'active'`（N21）；CHECK `layer<>'constitution' OR approved_by='owner'`；CHECK `provenance<>'extracted' OR state<>'active' OR approved_by IS NOT NULL` |
| `sa_rule_replay` | replay_id、rule_id、sample_size、changed、changed_ratio、direction_json、passed | PK replay_id |
| `sa_rule_conflict` | conflict_id、rule_a、rule_b、detail、resolved_at | PK conflict_id |
| `sa_world_entity` | entity_id、canonical、kind(host/repo/org/session)、realm(local/netbird/external)、path、state、source、lease_until、manifest_json、revoked_by | PK entity_id；UNIQUE canonical；UNIQUE path；CHECK `NOT (source='discover' AND state='enrolled')` |
| `sa_world_alias` | alias、entity_id、kind(ip/ssh/dns/spoken) | PK alias |
| `sa_world_addr` | addr_id、entity_id、kind(lan/wifi/netbird/dns)、address、priority | PK addr_id |
| `sa_mandate` | mandate_id、principal、scope_path、capability、strength、policy_version、granted_by、granted_at、revoked_at、revoked_by | PK mandate_id；CHECK `granted_by<>'superagent'`；触发器拒删；触发器只允许 revoked_at/revoked_by 由 NULL 写入 |
| `sa_workspace` | path、entity_id、commitment_id、mandate_id、branch、removed_at | PK path（N7〔推断〕） |
| `sa_work_class` | class_id、samples、eta_factor、ask_mode(declare/ask)、pushback_mode(on/muted)、preferred_executor、misjudge_rate、p90_turns | PK class_id；CHECK eta_factor BETWEEN 0.5 AND 4 |
| `sa_autonomy` | class_id、capability、strength、streak、streak_days_json、demoted_at | PK (class_id, capability)；CHECK `capability NOT IN ('change_prod','publish','commit_promise') OR strength<>'allow'` |
| `sa_speculation` | spec_id、kind(probe/prep/patrol)、commitment_id、desk_id、path、state | PK spec_id |
| `sa_deliberation` | deliberation_id、request_id、desk_id、commitment_id、trigger_kind、state、shadow、started_at、ended_at、window_id、audience_class、pub_hash、dossier_hash、dossier_tokens、rule_trace、ops、tool_errors、tokens、end_reason | PK deliberation_id；UNIQUE request_id；部分唯一 `(commitment_id) WHERE commitment_id IS NOT NULL AND state IN ('requested','running')`；部分唯一 `(desk_id) WHERE desk_id IS NOT NULL AND state='running'` |
| `sa_subscription` | thread_key、commitment_id、attempt_id、input_seq | PK thread_key |
| `sa_doc_index` | doc_id、path、title、kind、commitment_id、added_by、added_at | PK doc_id；UNIQUE path；CHECK `added_by IN ('host','human')` |
| `sa_degrade_event` | degrade_id、reason、scope、started_at、ended_at | PK degrade_id |

共 25 张 `sa_` 表。枚举列一律 `CHECK (col IN (...))`，值取自 T01 常量（DDL 由常量生成，不手抄）。

### 失败模式

| 失败 | 行为 |
| --- | --- |
| 迁移半途失败 | 单事务回滚；`openLedgerDb` 抛错，服务域不挂载（组合根记一行 diagnostic），responder 照常运行 |
| 启动自检缺列 | 同上，拒绝启动 superagent，不影响 lark-inbox 通道 |
| 旧库已有同名 `sa_` 表但缺列 | 按 PRAGMA 补列（F26），不删不重建 |

### T04 单测清单（`TS/superagent-db.spec.ts`，fixture：`FX/memdb.ts`）

1. 新库 `migrate` 后 `sqlite_master` 中 `sa_%` 表恰 25 张，名字集合等于 `PHYSICAL` 的值去掉 `inbox_events`。
2. 第二次 `migrate` 返回 `added=[]`，表数不变（幂等）。
3. 旧库（只有 InboxStore 的 `inbox_events` DDL，含一行数据）`migrate` 后有 `owner` 列且原行 `owner IS NULL`、其余列原值不变。
4. `owner` CAS 触发器：NULL→'superagent' 成功；'superagent'→'responder' 抛 `OWNER_ALREADY_SET`。
5. `sa_outbox` 插 words=101 失败；react 行 words=1 失败；同一 event_id 两条 reply 档 text 行第二条失败。
6. `sa_commitment` 四条表级约束各一个反例失败：开着无 next_look_at、fulfilled 无 evidence、watch 无 target、deliver 无 budget。
7. 同 thread_key 同 debtor 两件未结案顶层 deliver 第二件失败；第二件带 parent_id 成功。
8. 终态承诺任意 UPDATE 抛 `TERMINAL`。
9. `sa_journal` DELETE 抛错；UPDATE body_json 抛错；consumed_turn NULL→3 成功、3→4 抛错；body_json 长 8001 失败。
10. `sa_memory` DELETE 抛错；同 topic+kind 两条 active 第二条失败；owner-said 无 source_quote 失败。
11. `sa_mandate` granted_by='superagent' 失败；revoked_at 二次写入失败；DELETE 失败。
12. `sa_world_entity` source='discover' 且 state='enrolled' 失败。
13. `sa_autonomy` capability='publish' strength='allow' 失败。
14. `sa_rule` inferred+policy 失败；inferred+active 失败；constitution 且 approved_by<>'owner' 失败。
15. `selfCheck` 对删掉一列的库（手工 `ALTER TABLE ... DROP COLUMN words`）返回 `missing` 含 `sa_outbox.words`。
16. `sa_attempt` 转 running 而所属 deliver 承诺 budget 为空 → 抛 `NO_BUDGET`；同承诺两个 pending 尝试第二个失败。

### T04 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-db.spec.ts` | passed=18，failed=0，退出码 0 | 去掉 `sa_outbox` 的 `words <= 100` CHECK → 第 5 条红 |
| `VT tests/lark-inbox-inbound.spec.ts tests/lark-inbox-retention.spec.ts` | 与 W1 末读数相同的 passed 数，failed=0（证明加列不影响旧表行为） | 在 `migrate` 里对 `inbox_events` 加 `NOT NULL` 无默认值列 → 两个 spec 红 |
| `grep -nE "homedir\|DSH_HOME\|\.dsh/" packages/dsh-web-all/src/host/services/superagent/protocol/db.ts` | 空输出（库路径只由调用方传入；真实库迁移只在用户重启后发生） | 在 db.ts 写 `join(homedir(), '.dsh')` → 输出非空 |
| G1–G6 | 见 T-00 | 见 T-00 |
