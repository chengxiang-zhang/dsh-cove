# T-08 内核：账本（T08）、认领（T12）、时钟（T13）、出口与租约（T14）

> 适用性：本文属于 2026-11-05 原实施批次，保留既有记录，不是当前目标设计的施工依据。2026-11-09 用户授权重整需求后，与[当前设计](../../README.md)、[需求基线](../../01-需求基线.md)冲突的冻结、任务、默认裁定与 DONE 判据不再有效；新实现需重新规划并按[验收与评估](../../13-验收与评估.md)验证。

设计依据：`03-内核`（四原语、I1–I4、共存与接管、依赖反转、失败模式、读数）、`02-协议`（状态机、表级约束、P1–P5）、`11-恢复与降级`（租约心跳 15 秒、过期 60 秒）。事实：F18、F19、F33、F34。

内核硬规则（四个任务共同遵守，DEPS 与 G6 机械检查）：只 import `SA/protocol/` 与 `SA/kernel/`；不出现"飞书""模型""秘书"语义；`Ledger.open` 是全仓唯一开写事务的地方。

## T08 账本

写域：`SA/kernel/ledger.ts`、`FX/ledger.ts`、`TS/superagent-kernel-ledger.spec.ts`。依赖：T04。

```ts
export interface KernelTx extends LedgerTx {
  createCommitment(spec: NewCommitment): CommitmentRow            // n = max(n)+1，id = 'C-'||n；校验 02 四条表级约束（DDL 兜底）
  transition(id: string, to: CommitmentState, patch?: Partial<CommitmentRow>): CommitmentRow
  // canTransition 不过 → 抛 ILLEGAL_TRANSITION；进入终态时写 closed_at，并回填 actual_min/attempts/executor_switched（校准原料）
  append(id: string, entry: { actor: string; kind: JournalKind; request_id?: string; body: unknown }): number   // 返回 seq；body 序列化 > 8000 字符时拆成多行（02 JSON 膨胀：拆行不截断）
  markConsumed(requestId: string, turn: number): boolean          // journal.consumed_turn 由 NULL 写成 turn；已写过返回 false
  recordAttempt(a: NewAttempt): AttemptRow
  updateAttempt(id: string, patch: Partial<AttemptRow>): AttemptRow
  propose(origin: 'host', spec: NewCommitment & { origin_ref: string }): CommitmentRow   // kind ∉ {goal,remind,watch} → HOST_PROPOSE_KIND
  insertIntake(row: NewIntake): void
  disposeIntake(eventId: string, shadow: 0 | 1, d: { disposition: Disposition; reason?: string; alternative?: string; about?: string; corrects?: string }): void
  requestTurn(r: { trigger_kind: TriggerKind; desk_id?: string; commitment_id?: string; request_id: string }): string | undefined  // 已有未结束回合 → undefined
  finishTurn(deliberationId: string, r: { ops: number; tool_errors: number; tokens: number; end_reason: string; rule_trace: unknown;
    pub_hash?: string; dossier_hash?: string; audience_class?: AudienceClass; dossier_tokens?: number; window_id?: number }): void
}
export interface Ledger {
  open<T>(fn: (tx: KernelTx) => T, opts?: { module?: TableOwner; shadow?: boolean }): T
  // fn 返回 thenable → 回滚并抛 LEDGER_ASYNC_TX；opts.module 决定 tx.run 的表白名单（TABLE_OWNERS）；
  // opts.shadow=true 时 createCommitment/recordAttempt/propose 抛 SHADOW_NO_WRITE（NEEDS-DECISION N18）
  read: LedgerReader
  nowMs(): number
}
export function createLedger(db: DatabaseSync, clock: HostClock): Ledger
```

I1 机械形态：`createCommitment`、`transition`、`propose` 写入 `next_look_at` 时，非 goal 夹到 `≤ now+24h`，goal 夹到 `≤ now+7d`。

### T08 单测清单（`TS/superagent-kernel-ledger.spec.ts`，fixture：`FX/memdb.ts`、`FX/manual-clock.ts`）

1. `open` 回调抛错 → 事务内全部写入回滚（承诺数不变）。
2. `open` 回调返回 Promise → 抛 `LEDGER_ASYNC_TX` 且无残留写入。
3. `createCommitment` 连续两次得到 `C-1`、`C-2`。
4. `transition(open→fulfilled)` 无 evidence → DDL 拒绝；带 evidence 成功且 `closed_at` 非空、`actual_min` 已回填。
5. `transition(at_risk→open)` 抛 `ILLEGAL_TRANSITION`；终态再 transition 抛 `ILLEGAL_TRANSITION`。
6. `next_look_at` 传 now+48h 的 deliver 被夹到 now+24h；goal 传 now+10d 被夹到 now+7d。
7. `append` 的 seq 在同一承诺内从 1 递增；body 序列化 9000 字符拆成 2 行且无一行 > 8000。
8. `markConsumed` 首次 true、二次 false；同 request_id 第二次 `append` 抛唯一约束错误（P3）。
9. `propose(origin='host', kind='deliver')` 抛 `HOST_PROPOSE_KIND`；kind='remind' 成功且 `origin_kind='host'`。
10. `open({ module: 'memory' })` 内 `tx.run('UPDATE sa_commitment ...')` 抛 `TABLE_NOT_OWNED`。
11. `open({ shadow: true })` 内 `createCommitment` 抛 `SHADOW_NO_WRITE`。
12. `requestTurn` 对同一承诺第二次返回 undefined；`finishTurn` 后可再请求。

### T08 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-kernel-ledger.spec.ts` | passed=12，failed=0，退出码 0 | 去掉 thenable 检查 → 第 2 条红 |
| G1–G6 | 见 T-00 | 见 T-00 |

## T12 认领

写域：`SA/kernel/claim.ts`、`TS/superagent-kernel-claim.spec.ts`。依赖：T08（单测用桩 ClaimPolicy；与判断快路径 T09 的真实组合在 T27 组合根里测）。

```ts
export type ClaimMode = 'responder' | 'shadow' | 'superagent'
export type ClaimResult =
  | { status: 'claimed'; owner: Owner; route: Route; disposition?: Disposition; deskId: string; threadKey: string }
  | { status: 'shadowed'; deskId: string; threadKey: string }       // 影子期：owner=responder，另有 intake(shadow=1)
  | { status: 'already_claimed' }
export interface Claim {
  claim(event: InboundEvent, policy: ClaimPolicy, mode: ClaimMode): ClaimResult
  shadow(event: InboundEvent): void
  unowned(now: number, olderThanMs: number): string[]              // 超时无主事件（03：60 秒内必须有主，否则告警）
  snapshot(event: InboundEvent): ClaimSnapshot                     // 只读账本：线程活承诺、活订阅、本桌未答问题与未批提案
}
export function createClaim(ledger: Ledger): Claim
```

一次 `claim` 在一个 `Ledger.open` 里完成（03）：

| mode | owner CAS | intake 行 | 其他写入 |
| --- | --- | --- | --- |
| responder | `responder` | 无 | 无 |
| shadow | `responder` | `shadow=1`，`state='pending'` | 无（之后影子回合写处置） |
| superagent | 由 `policy.decide` 给出（通常 `superagent`） | `shadow=0`；`route='judge'` 时 `state='pending'`；`fastpath` 写具体 disposition 且 `state='disposed'`；`passthrough` 写 `disposition='passthrough'` | `passthrough`：对活订阅的承诺 `append(kind='passthrough', request_id='pt:'+event_id)` 并把订阅的 `input_seq` +1；不建承诺、不建尝试、不请求回合（R3） |

CAS 语义：`UPDATE inbox_events SET owner=? WHERE event_id=? AND owner IS NULL`，`changes=0` → `already_claimed`，整个事务回滚（第二次到达是空操作，P3）。`deskId = chat.type + ':' + chat.id`，`threadKey = threadKey(...)`（T01）。

### T12 单测清单（`TS/superagent-kernel-claim.spec.ts`，fixture：`FX/ledger.ts`、`FX/memdb.ts.seedInbound`、桩 ClaimPolicy）

1. superagent 模式 + `route='judge'`：`inbox_events.owner='superagent'`，一行 `intake(shadow=0,state='pending')`。
2. 同一事件第二次 claim → `already_claimed`，intake 仍一行。
3. 两个 `Ledger` 实例（两条连接、同一文件库，用临时文件而非 `:memory:`）并发 claim 同一事件 → 恰一个 `claimed`（CAS）。
4. fastpath `release` → intake `state='disposed'`、`disposition='release'`。
5. passthrough → journal 新增一行 `kind='passthrough'`、`request_id='pt:<event_id>'`，承诺数与尝试数不变，`deliberation` 无新行。
6. responder 模式 → owner='responder' 且无 intake 行。
7. shadow 模式 → owner='responder' 且一行 `intake(shadow=1)`；无 outbox、无 commitment。
8. 影子行存在时再以 superagent 模式 claim 同一事件 → `already_claimed`（owner 已是 responder）。
9. `unowned(now, 60000)` 返回 61 秒前到达且 owner 为空的事件，不返回 59 秒的。
10. `snapshot` 对有活承诺与活订阅的线程返回二者 id；对另一线程返回空。
11. I2 读数（测试内执行 `03` 的 I2 SQL）在全部处置完成后为 0。

### T12 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-kernel-claim.spec.ts` | passed=11，failed=0，退出码 0 | 把 CAS 条件 `AND owner IS NULL` 去掉 → 第 2、3 条红 |
| G1–G6 | 见 T-00 | 见 T-00 |

## T13 时钟

写域：`SA/kernel/clock.ts`、`TS/superagent-kernel-clock.spec.ts`。依赖：T08。

```ts
export interface Clock {
  tick(now: number, signal: TickSignal): { requested: TurnRequest[]; deferred: string[] }
  lastTickAt(): number | undefined                                 // 时钟停摆检测（> 3 分钟即停摆，03 失败模式）
  start(host: HostClock, signal: TickSignal, onRequest: (r: TurnRequest) => void): () => void   // 每 60 秒一轮；回调不等待（内核不等桌子返回）
}
export function createClock(ledger: Ledger): Clock
```

- 取 `state IN ('proposed','open','at_risk') AND next_look_at <= now` 的承诺。
- `signal.has` 返回 null → `next_look_at = now + max(300000, 剩余预计/2)`（剩余预计 = `eta_at - now`，为负按 0），再按 I1 夹取；不请求回合（防空跑第一道）。
- 有信号 → `requestTurn({ trigger_kind:'agenda', commitment_id, request_id: 'tick:'+id+':'+now })`；已有未结束回合 → 计入 deferred，不重复请求。
- `TickSignal.has` 抛错 → 视为无信号并后推（不让一件坏承诺卡住整轮）。

### T13 单测清单（`TS/superagent-kernel-clock.spec.ts`，fixture：`FX/ledger.ts`、`FX/manual-clock.ts`、桩 TickSignal）

1. 无到点承诺 → `requested=[]`，无写入。
2. 到点 + 无信号 → 无 deliberation 行；`next_look_at` = now+5 分钟（eta 已过）或 now+剩余/2（剩余 40 分钟 → +20 分钟）。
3. 到点 + 有信号 → 一行 deliberation(requested)，`requested` 长度 1。
4. 同一承诺已有 requested 回合 → 第二轮计入 deferred，deliberation 仍一行。
5. `signal.has` 抛错 → 后推且同轮其他承诺照常处理。
6. `start` 在手动时钟推进 180 秒后恰执行 3 轮；`lastTickAt` 等于最后一轮时间。
7. `onRequest` 回调抛错不影响下一轮。
8. 终态承诺即使 `next_look_at` 早于 now 也不被选中。

### T13 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-kernel-clock.spec.ts` | passed=8，failed=0，退出码 0 | 无信号时也请求回合 → 第 2 条红 |
| G1–G6 | 见 T-00 | 见 T-00 |

## T14 出口与租约

写域：`SA/kernel/outlet.ts`、`SA/kernel/lease.ts`、`TS/superagent-kernel-outlet.spec.ts`。依赖：T08。

```ts
export interface Lease {
  acquire(holder: string, now: number): { held: boolean; epoch: number; holder: string }   // 过期（heartbeat_at + 60000 < now）才可抢，抢到 epoch+1
  heartbeat(holder: string, now: number): boolean                                         // 每 15 秒；非持有者返回 false
  current(): LeaseRow | undefined
}
export interface Outlet {
  submit(p: SpeechProposal, policy: OutletPolicy, mode: 'responder' | 'shadow' | 'superagent'): { ok: true; outboxId: string; tier: Tier; words: number } |
    { ok: false; code: 'NO_LEASE' | 'REPLY_EXISTS' | 'SHADOW_NO_WRITE' | 'TOO_LONG' | 'MOMENT_FORBIDDEN' | 'DISCLOSE_BLOCKED' | 'PROMISE_BLOCKED'; message: string }
  flush(now: number, sender: SenderPort): Promise<{ sent: number; failed: number; suppressed: number; retried: number }>
  pendingNote(chatId: string): string | undefined                 // "有一条消息没发出去"，附在下一条出站末尾后清除
}
export function createLease(ledger: Ledger): Lease
export function createOutlet(ledger: Ledger, lease: Lease, holder: string): Outlet
```

- `submit`：mode≠superagent → `SHADOW_NO_WRITE`；本进程不持租约 → `NO_LEASE`；`policy.check` 失败 → 原码返回；reply 档同一 event_id 已有 text 行 → `REPLY_EXISTS`；通过则写 `outbox(state='queued', lease_epoch=当前 epoch, tier/words 取 policy 结果)`。`tier` 只由 policy 给，提案里没有 tier 字段（R5 机械形态）。
- `flush`：只发 `lease_epoch = 当前 epoch` 的 queued 行，过期 epoch 的行 → `suppressed` 并写一条审计 journal（I4）；发送前先把 `attempts+1, next_attempt_at=now+30000` 写库再调 `SenderPort`（"发送前先认领"，F19）；成功 → `sent`、`message_id`、`sent_at`；失败 → 退避 30 秒起翻倍、封顶 30 分钟，首次尝试起 24 小时 → `failed` 并登记 pendingNote。
- 从未尝试过发送且排队超过 5 分钟的行 → `failed`（03"出口堆积"；与 24 小时重试的区分见 NEEDS-DECISION N25）。
- react 出站：`payload='react'`、`words=0`，同样过租约与幂等。

### T14 单测清单（`TS/superagent-kernel-outlet.spec.ts`，fixture：`FX/ledger.ts`、`FX/manual-clock.ts`、`FX/fake-channel.ts` 适配成 SenderPort、桩 OutletPolicy）

1. 两个 holder 抢租约：先到者 held、epoch=1；后到者 held=false。
2. 持有者 61 秒无心跳 → 另一 holder 抢到，epoch=2。
3. 不持租约 `submit` → `NO_LEASE`，无 outbox 行。
4. mode='shadow' `submit` → `SHADOW_NO_WRITE`，无 outbox 行。
5. 同一 event_id 第二条 reply 档 text → `REPLY_EXISTS`；react 行不受此限。
6. policy 返回 `TOO_LONG` → 原码返回，无 outbox 行。
7. `flush` 发送成功 → `sent`、`message_id` 非空；fake-channel 收到的 idemKey = outbox.idem_key。
8. epoch 1 的 queued 行在 epoch 2 下 flush → `suppressed`，未发送，审计行 1 条。
9. 发送失败 → 30 秒后重试、第二次失败 60 秒后重试；24 小时后 → `failed` 且 `pendingNote(chat)` 非空，取一次后为空。
10. 未尝试的 queued 行 5 分钟后 → `failed`。
11. I4 读数（`03` I4 SQL）在测试末尾为 1。
12. 提案对象带 `tier` 字段时被忽略（类型层不存在该字段；运行期以 policy 结果为准）。

### T14 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-kernel-outlet.spec.ts` | passed=12，failed=0，退出码 0 | flush 不校验 epoch → 第 8 条红 |
| `grep -rnE "send\\(|\\.react\\(" packages/dsh-web-all/src/host/services/superagent --include=*.ts \| grep -vE 'kernel/outlet\\.ts\|channels/'` | 空输出（出口唯一：除出口与通道外无人调发送） | 在 `SA/desk/` 某文件直接调 `sender.send(` → 非空 |
| G1–G6 | 见 T-00 | 见 T-00 |
