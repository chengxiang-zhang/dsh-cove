# T-09 判断：快路径（T09）、归位与闸与异议（T21）、交办与收放（T26）

设计依据：`08-判断`（快路径六条、第一判断归位、六道闸、交办五要素、派给谁、顶住老板三约束、双主、契约五方法）、`02-协议`（桌面工具与错误码、intake 约束）、`10-执行体`（`Budget`、`dispatch`、`cancel`）。需求：R3、R4、R12、R14、R15、R23、G2、G3、B14、B15。

判断模块只产出三类结果：一句直接答、一件承诺、一次有据的异议。它不发送：需要说话时调用桌子注入的 `say`（即内核出口提案）。

## T09 快路径（`ClaimPolicy` 的实现，纯函数）

写域：`SA/judgment/route.ts`、`SA/judgment/route-rules.ts`、`TS/superagent-judgment-route.spec.ts`。依赖：T01。

```ts
export interface RouteDeps { senderClass(e: InboundEvent): 'owner' | 'colleague' | 'member' | 'external' | 'unknown' }
export function createRoutePolicy(deps: RouteDeps, rules?: readonly RouteRule[]): ClaimPolicy
export interface RouteRule { order: number; name: string; when: (e: InboundEvent, s: ClaimSnapshot, cls: string) => boolean;
  result: Omit<ClaimDecision, 'owner'> }
export const ROUTE_RULES: readonly RouteRule[]       // 顺序固定，08 快路径表逐条；规则是数据表，加一条不改 decide 代码
export function normalizeForMatch(text: string): string   // 去首尾空白、去全部中英文标点与 '/'、转小写
export const STOP_WORDS = ['停', '停止', '算了', 'stop', '别做了', '先别做了', '不用了'] as const
export const ROTATE_WORDS = ['new', '新会话'] as const                         // '/new' 去 '/' 后为 'new'（NEEDS-DECISION N14）
export const GREETINGS = ['hi', 'hello', '你好', '您好', '谢谢', '感谢', '收到', 'ok', '好的', '好'] as const   // ≤4 字
export const SCOPE_CHANGE_MARKERS = ['改', '换', '停', '别', '先', '顺便', '也', '还有', '再加', '改主意', '不是这个'] as const
export const ORDINAL_RE = /^\s*\d+(\s*[、,，]\s*\d+)*\s*$/
```

`decide` 结果（`owner` 恒为 `superagent`；模式切换由 claim 的 mode 处理）：

| 序 | 条件 | route | disposition | detail |
| --- | --- | --- | --- | --- |
| 1 | 归一化文本 ∈ STOP_WORDS 且 `snapshot.liveCommitmentOnThread` | fastpath | release | `{ commitment_id }` |
| 1b | 归一化文本 ∈ ROTATE_WORDS | fastpath | acknowledge | `{ rotate: true }` |
| 2 | 匹配 ORDINAL_RE 且（本桌有未答问题或未批提案） | fastpath | 命中提案 → commit；命中问题 → amend（NEEDS-DECISION N26） | `{ ordinals: number[], target }` |
| 3 | 归一化文本 ∈ GREETINGS、长度 ≤4 字、本桌无未答问题 | fastpath | acknowledge | `{ react: true }` |
| 4 | `senderClass ∈ {external, unknown}` | fastpath | decline | `{ reason: 'not_authorized', alternative: 'identity_notice' }` |
| 5 | `snapshot.liveSubscription` 且原文不含任一 SCOPE_CHANGE_MARKERS | passthrough | passthrough | `{ commitment_id, attempt_id }` |
| 6 | 其余 | judge | — | — |

### T09 单测清单（`TS/superagent-judgment-route.spec.ts`，fixture：内联事件与快照）

1. "停。"、"先别做了！"、"STOP" 在线程有活承诺时 → release；线程无活承诺时 → judge。
2. "/new" 与 "新会话" → acknowledge + rotate。
3. "1、3" 在有未批提案时 → commit 且 ordinals=[1,3]；无提案无问题时 → judge。
4. "2" 在有未答问题时 → amend 且 target 为该问题。
5. "谢谢" 在无未答问题时 → acknowledge+react；有未答问题时 → judge。
6. "你好啊朋友们"（>4 字）→ 不走寒暄。
7. external 发送者 → decline，detail 含 reason 与 alternative（R4 两字段非空）。
8. 有活订阅、原文"跑完了吗" → passthrough；原文"顺便把 Z 也改了" → judge（范围变更标记）。
9. 规则按 order 求值：同时满足 1 与 5 的消息（"停"且有活订阅）→ release。
10. `ROUTE_RULES` 的 order 严格递增且 name 唯一；替换一份只含第 6 条的规则表时任何消息都 → judge（规则是数据）。

### T09 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-judgment-route.spec.ts` | passed=10，failed=0，退出码 0 | 从 SCOPE_CHANGE_MARKERS 删掉"顺便" → 第 8 条红 |
| G1–G6 | 见 T-00 | 见 T-00 |

## T21 归位（judge）、六道闸事实、异议（pushback）

写域：`SA/judgment/judge.ts`、`SA/judgment/gates.ts`、`SA/judgment/pushback.ts`、`TS/superagent-judgment-judge.spec.ts`。依赖：T09、T12、T15、T16、T17、T19（只读 `Profile` 注册表类型）。

```ts
export interface TurnContext {             // 由桌子在每个回合注入（模型传不进，02 桌面工具"上下文由宿主注入"）
  deskId: string; deliberationId: string; shadow: boolean; sender: string; senderClass: string;
  batch: readonly InboundEvent[]; audience: Audience; now: number }
export function judgeTool(deps: JudgmentDeps): (ctx: TurnContext, input: JudgeInput) => ToolResult<{}>
export function pushbackTool(deps: JudgmentDeps): (ctx: TurnContext, input: PushbackInput) => ToolResult<{ outbox_id: string }>
export interface GateFacts {                // 六道闸的宿主侧事实，进案卷"本批"段，并供 commit 校验复用
  g1_answered: { commitment_id?: string; memory_id?: string; conclusion: string }[]   // 近 7 天同话题结案与记忆
  g2_in_progress: { commitment_id: string; what: string }[]                           // 本桌可见在办
  g3_mandate: (capability: Capability, path: ScopePath) => Strength                   // 世界模型授权三态
  g4_said: { memory_id: string; quote: string }[]                                     // 命中话题的老板约束与偏好
  g5_precedents: { commitment_id: string; intent: string; outcome: string }[]         // 意图判例
  g6_cost: { class_id: string; eta_factor: number; p90_turns: number; preferred_executor?: string }
}
export function gateFacts(deps: JudgmentDeps, ctx: TurnContext, event: InboundEvent): GateFacts
export interface JudgmentDeps { ledger: Ledger; claim: Claim; world: WorldRegistry; memory: MemoryLog; rules: RuleRegistry;
  outletSay: (ctx: TurnContext, p: Omit<SpeechProposal, 'idem_key'>) => ToolResult<SayOutput>; profiles: ProfileRegistry }
```

`judge` 校验顺序与错误码（`02`）：

1. `event_id` 不在 `ctx.batch` → `NOT_IN_BATCH`。
2. 该事件 `intake(shadow=ctx.shadow?1:0)` 已 disposed → `ALREADY_DISPOSED`。
3. 线程有活承诺且 disposition ∉ {check, nudge, amend, release, answer}：`new_thread` 未置 → `LIVE_THREAD_FORBIDS`；置了但 `reason` 空 → `NEW_THREAD_REASON_REQUIRED`。
4. `about` 指向的承诺对本桌受众不可见 → `ABOUT_NOT_VISIBLE`。
5. 通过：`disposeIntake`；`nudge` 另 `append(kind='nudge')`；`decline` 必须带 reason 与 alternative（DDL 兜底）。`commit`/`pushback`/`amend`/`release` 处置由对应工具落账，`judge` 只记处置。

`pushback` 规则（`08` 顶住老板三约束）：

- `grounds` 每项必须是可见的 `M-…`（记忆 id）、`C-…`（承诺 id）或 `calib:<class_id>`（校准数字）之一，至少一项 → 否则 `NO_GROUNDS`；`alternative` 空 → `NO_GROUNDS`。
- 同一线程已有 `journal(kind='pushback')` → `PUSHBACK_REPEAT`。
- 该工作类 `pushback_mode='muted'` → `PUSHBACK_QUIET`（受理里只附一句风险）。
- 通过：`append(kind='pushback')` + 出口提案 `moment='pushback'`；老板随后坚持（下一条处置为 commit 原方案）由 T26 记一次"被推翻"进校准。
- 替老板对外：发送者不是老板时不允许异议（`08`：同事要求与老板约束冲突时直接 route 给老板并附冲突原话，R15）。协议错误码封闭，复用 `PUSHBACK_QUIET`，message 固定为 `non-owner request: use judge(disposition='route')`。

### T21 单测清单（`TS/superagent-judgment-judge.spec.ts`，fixture：`FX/ledger.ts`、T15/T16/T17 的真实实现 + 种子数据）

1. 批外 event_id → `NOT_IN_BATCH`；重复处置 → `ALREADY_DISPOSED`。
2. 活线程上 disposition='commit' 无 new_thread → `LIVE_THREAD_FORBIDS`；有 new_thread 无 reason → `NEW_THREAD_REASON_REQUIRED`。
3. about 指向群桌不可见的私聊承诺 → `ABOUT_NOT_VISIBLE`。
4. nudge 写一行 journal(kind='nudge')，承诺数与尝试数不变（G3"好了吗"的承诺增量 = 0）。
5. shadow 上下文下 judge 写的是 `intake(shadow=1)`，`shadow=0` 行不出现。
6. `gateFacts.g1_answered` 返回 6 天前同话题结案、不返回 8 天前的。
7. `gateFacts.g3_mandate` 对 colleague 的 publish 返回 deny。
8. `gateFacts.g4_said` 只返回本受众可用的约束，群桌不含私聊原话（派生提示）。
9. pushback 无 grounds → `NO_GROUNDS`；grounds 引用不存在的 `M-999` → `NO_GROUNDS`。
10. 同线程第二次 pushback → `PUSHBACK_REPEAT`。
11. 工作类 muted → `PUSHBACK_QUIET`；发送者为 colleague → `PUSHBACK_QUIET` 且 message 含 `route`。
12. 合法 pushback → journal 一行 + 出口提案一次（桩 outletSay 计数 1）。

### T21 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-judgment-judge.spec.ts` | passed=12，failed=0，退出码 0 | 去掉"线程有活承诺"校验 → 第 2 条红 |
| G1–G6 | 见 T-00 | 见 T-00 |

## T26 交办（commit）、追加（amend）、停（release）、提案（propose）与快路径落地

写域：`SA/judgment/translate.ts`、`SA/judgment/dispatch.ts`、`SA/judgment/commit.ts`、`SA/judgment/amend-release.ts`、`SA/judgment/propose.ts`、`SA/judgment/fastpath-apply.ts`、`TS/superagent-judgment-commit.spec.ts`。依赖：T21、T19、T22（`cancel` 与工作目录处置）。

```ts
export function commitTool(deps: JudgmentDeps & { executors: Executors }): (ctx: TurnContext, input: CommitInput) => ToolResult<CommitOutput>
export function amendTool(deps): (ctx: TurnContext, input: AmendInput) => ToolResult<AmendOutput>
export function releaseTool(deps): (ctx: TurnContext, input: ReleaseInput) => ToolResult<ReleaseOutput>
export function proposeTool(deps): (ctx: TurnContext, input: ProposeInput) => ToolResult<{ commitment_ids: string[] }>
export function candidates(spec: CommitInput, cls: WorkClassRow | undefined, last?: AttemptRow): string[]   // 宿主先算候选（08 选择规则）
export function applyFastpath(deps, event: InboundEvent, decision: ClaimDecision): void   // 快路径的宿主执行，不进模型
```

`commit` 校验（`08` 第三判断五件事 + `02` 错误码），按序：

| 校验 | 错误码 |
| --- | --- |
| `done_when` 按 `check_kind` 含必需要素：command 需一段反引号命令且含"期望"或比较符；artifact 需路径或分支名；observation 需"读数名 + 阈值数字"；answer 需"要包含"列表 | `CHECK_MISSING` |
| assumptions > 5 | `TOO_MANY_ASSUMPTIONS` |
| 存在 `reversible=false` 的假设却未设为 asked；或工作类 `ask_mode='ask'` 而第一条未设为 asked；同一承诺 asked > 1 | `ASK_REQUIRED` |
| 线程上同债务人已有未结案顶层 deliver（发送者不同则改开子承诺 `parent_id`，不报错） | `THREAD_BUSY` |
| 工作类名不合 `/^[a-z][a-z0-9-]{1,40}$/`；合法但未见过 → 新建 `work_class(samples=0)` 不报错（〔推断〕B14） | `CLASS_UNKNOWN` |
| `budget_scale > 4` | `BUDGET_OVER_CAP` |
| 所需能力的授权为 deny（`gateFacts.g3_mandate`） | `BOUNDARY_DENIED` |
| executor 不在画像注册表 | `EXECUTOR_UNKNOWN` |
| executor 不在 `candidates()` 内（如写仓库却选只读画像） | `EXECUTOR_MISMATCH` |
| 槽位：durable+full 的 deliver 遇槽位占用不报错，尝试留 `pending` 排队；排队 ≥ 5 件时才 `SLOT_FULL`（NEEDS-DECISION N27） | `SLOT_FULL` |

通过后一个 `Ledger.open`：授权为 draft → 承诺 `state='proposed'`、`ball=owner`（双主"授权外但可做 → 出草案等老板批"）；否则 `createCommitment(state='open')` + `recordAttempt(state='pending')` + assumptions + `subscription(thread_key)` + `append(kind='brief', body={intent, done_when, boundary, 前情})`。边界由宿主把 `g4_said` 命中的约束拼入并标出处（秘书只能追加）；前情 = 同话题最近 3 次结案结论与失败原因 + 同线程上一个尝试摘要。`eta_at = now + eta_minutes × eta_factor`；止损由 `executors.budget()`（T19）给出。`creditor = 发送者`，发送者非老板时 `on_behalf_of = owner`（R14）。父承诺由宿主定，模型传不进（`CommitInput` 无 `parent_id`）：同线程不同发送者 → `parent_id` = 该线程顶层；本事件的 intake `about` 指向一件已终态的承诺（交付后追加，NEEDS-DECISION N30）→ `parent_id` = 该承诺，前情取它的结案结论。返回后由桌子同回合 `say(ack)`；派发由组合根异步触发（`10` 三段）。shadow 上下文：只做全部校验，不落账，把拟处置写进影子 intake 与 `rule_trace.shadow_ops`（N18）。

`amend`：承诺终态 → `TERMINAL`；不可见 → `NOT_VISIBLE`；写 `journal(kind='amend', request_id='am:'+event_id)`；尝试 running → `executors.sendInput`，`delivery='queued'`；无 running 尝试 → `delivery='next-attempt'`（前情续接，同一承诺新开尝试，R23）；`overturns` 指向的假设 `status='overturned'` 并计一次误判。

`release`（即时路径，`10` 与 G2）：发送者不是 creditor 也不是 owner → `NOT_PERMITTED`；终态 → `TERMINAL`；通过：`transition(released)` → `executors.cancel(attempt,'release')` → 工作目录有未提交改动则 `kept`，否则 `removed` → 出口提案"停在第几步、改动在哪、怎么处理"。全程不等时钟。

`propose`：goal_id 不是 goal → `NOT_GOAL`；该 goal 已有未批提案 → `PROPOSAL_OPEN`；通过：≤3 件子承诺 `state='proposed'`、`ball=owner`、`next_look_at=now+7d`（`09`：7 天未批自动 withdrawn）。

`applyFastpath`：release → 同 `release` 工具的宿主路径；序号命中提案 → `transition(proposed→open)` 并触发派发；序号命中问题 → 假设 `answered` + amend；acknowledge → react 出站（或 rotate 桌子）；decline → 固定身份说明出站（R16）。

### T26 单测清单（`TS/superagent-judgment-commit.spec.ts`，fixture：`FX/ledger.ts`、`FX/fake-controller.ts`、T19/T22 真实实现）

1. command 判据缺期望读数 → `CHECK_MISSING`；补齐后成功。
2. 6 条假设 → `TOO_MANY_ASSUMPTIONS`；不可逆假设设为 declared → `ASK_REQUIRED`。
3. 同线程同债务人第二件 → `THREAD_BUSY`；同线程不同发送者 → 子承诺且 `parent_id` 指向第一件。
4. 新工作类名合法 → 新建 work_class 行；`"Run Tests"` → `CLASS_UNKNOWN`。
5. `budget_scale=5` → `BUDGET_OVER_CAP`。
6. 授权 deny → `BOUNDARY_DENIED`；draft → 承诺 proposed 且 ball=owner、无尝试。
7. 写仓库任务选只读画像 → `EXECUTOR_MISMATCH`；未注册画像 → `EXECUTOR_UNKNOWN`。
8. 成功 commit：一个事务内 commitment(open)+attempt(pending)+subscription+journal(brief)；boundary 含老板约束原话出处。
9. 槽位占用时第二件 durable deliver 成功且尝试 pending、slot 为空；第 6 件 → `SLOT_FULL`。
10. amend 在 running 尝试上 → `delivery='queued'` 且 fake-controller 收到一次 prompt；无 running → `next-attempt`。
11. release：承诺 released、尝试 ended(cancel_origin='release')、fake-controller 收到 cancel；全程在一次调用内完成（无时钟推进）。
12. 非 creditor 非 owner 的人 release → `NOT_PERMITTED`。
13. propose 对非 goal → `NOT_GOAL`；成功后 3 件 proposed、ball=owner；第二次 → `PROPOSAL_OPEN`。
14. applyFastpath 序号批准：proposed → open 且派发一次；同一序号消息重复到达不重复派发（claim 幂等）。
15. shadow 上下文 commit：无 commitment/attempt 行，影子 intake 的 disposition='commit'。
16. 交付后追加：intake.about 指向已 fulfilled 的 C-1 → 新承诺 parent_id='C-1'、journal(brief) 前情含 C-1 结论；本线程 `parent_id IS NULL` 的 deliver 仍为 1 件。

### T26 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-judgment-commit.spec.ts` | passed=16，failed=0，退出码 0 | release 改为等下一轮 tick 再取消 → 第 11 条红 |
| 测试内读数：`SELECT count(*) FROM intake WHERE disposition='decline' AND (reason IS NULL OR alternative IS NULL)` | 0 | — |
| G1–G6 | 见 T-00 | 见 T-00 |
