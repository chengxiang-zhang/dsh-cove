# T-19 执行体：画像与派发（T19）、结案与升级与探针与清扫（T22）

> 适用性：本文属于 2026-11-05 原实施批次，保留既有记录，不是当前目标设计的施工依据。2026-11-09 用户授权重整需求后，与[当前设计](../../README.md)、[需求基线](../../01-需求基线.md)冲突的冻结、任务、默认裁定与 DONE 判据不再有效；新实现需重新规划并按[验收与评估](../../13-验收与评估.md)验证。

设计依据：`10-执行体`（画像、三段派发、止损与自愈、结案不信自述、升级三选一、工作目录、观察器、契约六方法）、`08-判断`（派给谁、`Budget`）、`02-协议`（attempt、journal.request_id/consumed_turn、report 工具）。需求：R10、R13、R23、G1、G2、G4、G9、B14、B15、D3、D6、D7。前置读数：SPIKES S2（建会话与选模型）、S4（事件字段路径）、S5（追加输入语义）。

## T19 画像、派发、追加输入、取消、止损

写域：`SA/executors/profiles/index.ts`、`SA/executors/profiles/{oneshot-read,durable-full,durable-full-strong}.ts`、`SA/executors/attempts.ts`、`SA/executors/budget.ts`、`SA/executors/events.ts`、`SA/executors/report-tool.ts`、`TS/superagent-executors-dispatch.spec.ts`。依赖：T08、T15（`place`、工作区登记）、SPIKES S2、S4、S5。

```ts
export interface Profile { id: string; provider?: string; model?: string; effort?: string;
  cost_tier: 1 | 2 | 3; lifetime: Lifetime; tools: 'read' | 'full'; budget_tier: 'small' | 'medium' | 'large'; preset: 'standard' }
export interface ProfileRegistry { get(id: string): Profile | undefined; all(): Profile[]; higher(id: string): Profile | undefined }
export const PROFILES: readonly Profile[]      // profiles/index.ts 一行一个；provider/model/effort 取 S2 读数的可用组合，空 = 全局默认
export interface Budget { wall_ms: number; turns: number }
export function budget(etaMin: number, etaFactor: number, p90Turns: number | undefined, scale = 1): Budget
// wall = clamp(eta × factor × 2.5, 5, 120) 分钟 × scale；turns = p90 存在 ? ceil(p90 × 1.5) : 12，× scale；scale ≤ 4（10）
export interface Executors {
  dispatch(commitmentId: string): Promise<{ attemptId: string; sessionId: string } | { failed: string }>
  // 两阶段：attempt 已 pending（由 commit 写）→ create 会话 + 首次 prompt(queue) → running；失败 → ended(end_reason='dispatch_failed', cancel_origin='dispatch')（N6）
  sendInput(attemptId: string, requestId: string, text: string): Promise<{ consumedTurn?: number; mode: 'steer' | 'queue' }>
  cancel(attemptId: string, origin: CancelOrigin): Promise<void>
  onSessionEvent(sessionId: string, event: unknown): void    // 组合根转发 session/event；更新 turns、tool_calls、last_tool_at、repeat_sig/count、consumed_turn
  modelFor(sessionId: string): { provider: string; model: string; effort?: string } | undefined   // 按会话覆盖（N5）
  roleOf(sessionId: string): `executor:${string}` | undefined
  report: ToolDefinitionLike                                   // report 工具（02 执行体工具），只对执行体会话可用
}
export function createExecutors(deps: { ledger: Ledger; controller: () => SessionControllerFace; world: WorldRegistry;
  profiles: ProfileRegistry; clock: HostClock; log: HostLog; seatRoot: string }): Executors
```

派发细节：

- 会话 id：`sa-x-<commitment_id>-a<n>`（P3：`attempt.session_id` 唯一）；cwd：oneshot = `<seatRoot>/tmp/<attempt_id>`（无 .git、结束后删除）；durable = 经 `world.place` 得到的工作目录，新建时登记 `sa_workspace`（N7）并在其中建分支 `sa/<commitment_id>`。
- 首次 prompt 文本 = 交办五件事（意图、完成判据、边界、前情、悬念）+ 回报格式（`report` 工具的形状），取自承诺的 `journal(kind='brief')`。
- 槽位（D3、N2）：durable+full 的 deliver 在 dispatch 前取 `slot=1`（部分唯一索引）；取不到则保持 pending，等议程重试；oneshot 不取槽位。
- 派发失败自愈：换档或换机重派一次；仍失败进入议程重试（排队）；两次重派仍失败 → 承诺 broken，由出口发一条终止句（`moment='cannot'`）。只有失败原因是缺新授权或需要新机器才产出一条 asked 假设（带默认"不回=排队等"）。
- 追加输入（R23、S5）：attempt 有开着的回合 → `prompt(mode:'steer', requestId)`（或按 S5 不成立分支一律 queue）；回合已结束且会话在 → `prompt(mode:'queue')`；会话不在 → 不发送，返回 `{ mode: 'queue' }` 并由下一尝试带前情消费。消费判定：会话事件里该 requestId 对应的用户消息所在回合号写入 `journal.consumed_turn`（`markConsumed`）。
- guard（`10`）：执行体会话拒绝 lark-inbox 工具、worktree 工具与带预设的 subagent 调用；oneshot read 另拒一切写工具。本任务只交付纯函数 `executorGuard(profile, toolName) → string | undefined` 与拒绝名单常量 `EXECUTOR_DENIED_TOOLS`；把它装到会话上由组合根 T27 用 T20 同一套工具面机制完成（本任务不依赖 T20）。
- 止损：`running` 必有止损（DDL 触发器 I3）；墙钟到线或回合到线 → 近两窗口有进展证据（新工具调用且 repeat_sig 在变）→ 自动续一次（≤原止损 50%，`extended=1`）；否则 `cancel(origin='budget')` → 交给升级（T22）。token 只记 `used_tokens`，不触发任何动作（G4）。

### T19 单测清单（`TS/superagent-executors-dispatch.spec.ts`，fixture：`FX/ledger.ts`、`FX/fake-controller.ts`、`FX/manual-clock.ts`、T15 真实实现）

1. `budget(3, 2.1, undefined)` → wall = 15.75 分钟（clamp 内）、turns = 12；`budget(100, 4, 8)` → wall 封顶 120 分钟、turns = 12。
2. dispatch 成功：controller.create 收到 `sa-x-C-1-a1`、cwd 正确、agentPreset='standard'；首个 prompt 为 queue 且文本含意图与完成判据；attempt 转 running。
3. create 失败 → attempt ended(end_reason='dispatch_failed', cancel_origin='dispatch')；自动换档重派一次（新 attempt n=2）。
4. 两次重派均失败 → 承诺 broken 且出口提案一条 `moment='cannot'`；无 asked 假设（技术原因不问老板，B14）。
5. 第二件 durable deliver 在槽位占用时保持 pending；第一件结案后再 dispatch 拿到槽位。
6. oneshot 不取槽位，与 durable 并行 running。
7. sendInput 在开着的回合上用 steer（S5 成立分支）；在已结束回合上用 queue；`onSessionEvent` 收到含该 requestId 的消息后 journal.consumed_turn = 该回合号。
8. `onSessionEvent` 对 tool/call 事件累加 tool_calls、更新 last_tool_at；同一命令连续 3 次 → repeat_count=3。
9. 墙钟到线且近两窗口有新工具调用 → 自动续一次（extended=1）；第二次到线 → cancel(origin='budget')。
10. 墙钟到线且无进展 → cancel(origin='budget')，不产生任何 interrupt 出站。
11. `modelFor(sa-x-C-1-a1)` 返回画像的 provider/model（画像有值时）；未知会话 undefined。
12. `report(state='blocked')` 无 question → `QUESTION_REQUIRED`；`report(ready)` 无证据被接收（不拒绝），journal 记一行 report。
13. cancel 后 controller.cancel 被调用、attempt ended(cancel_origin=传入值)、running 计数为 0（I3 读数）。
14. `executorGuard`：oneshot-read 画像对写工具返回拒绝串；任何画像对 `lark_inbox_reply`、`worktree_lane` 返回拒绝串；对只读工具返回 undefined。

### T19 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-executors-dispatch.spec.ts` | passed=14，failed=0，退出码 0 | 让派发失败直接 broken 不自愈 → 第 3 条红 |
| `grep -rnE "subagent_|selectModel" packages/dsh-web-all/src/host/services/superagent/executors` | 空输出（D7、X3、X4） | — |
| G1–G6 | 见 T-00 | 见 T-00 |

## T22 结案判定、升级、观察器、工作目录清扫

写域：`SA/executors/closure.ts`、`SA/executors/escalate.ts`、`SA/executors/probes/index.ts`、`SA/executors/probes/session-activity.ts`、`SA/executors/sweep.ts`、`TS/superagent-executors-closure.spec.ts`。依赖：T19、SPIKES S4。

```ts
export interface Closure {
  close(attemptId: string, turnEnd: { reason: EndReason }, report?: ReportInput): { state: CommitmentState | 'pending_close' | 'escalate'; evidenceOk: boolean }
  pendingSweep(now: number): number            // report(ready) 先到而 turn/end 未到的"待结案"，超时（10 分钟）后按同表判
}
export interface Escalation { escalate(commitmentId: string, reason: 'stall' | 'loop' | 'failed' | 'max-tokens' | 'interrupted' | 'error' | 'budget' | 'blocked_technical'):
  { action: 'retry' | 'upgrade' | 'broken' | 'ask'; attemptId?: string } }
export interface Probe { name: string; probe(target: string, signal: AbortSignal): Promise<Reading[]> }   // 只读，固定墙钟 5 分钟
export interface Reading { name: 'event_count' | 'last_tool' | 'tool_calls_10m' | 'last_text_similarity'; value: number | string }
export interface Sweep { sweep(now: number): { candidates: string[]; deleted: string[]; dryRun: boolean } }   // 两次 dry-run 一致才删
```

结案表（`10`"结案：不信自述"，逐行实现）：

| 条件 | 结果 |
| --- | --- |
| 有未消费输入（该承诺 journal 中 amend/passthrough 行 `consumed_turn IS NULL`） | 不判定，`pending_close`，留给下一回合（R23） |
| completed + ready + command：某条 evidence 的 `command` 与会话事件里某 `tool/call` 参数相同，且其 `tool/result` 退出码相同（字段路径取 S4 读数） | fulfilled，`evidence_json` = 匹配到的三元组 |
| completed + ready + artifact：路径存在，或分支 `sa/<C-n>` 相对基线有提交 | fulfilled |
| completed + ready + answer/observation：摘要覆盖 `done_when` 列出的要素（逐要素子串匹配） | fulfilled |
| completed + ready 但核对不过，或 completed 无终态报告 | unverified（交付前缀由模板强制） |
| completed + blocked：技术性（环境/依赖/权限内） | escalate(`blocked_technical`) |
| completed + blocked：产品问题（口径/范围/取舍） | 一条 asked 假设给老板，带默认 |
| completed + failed/dropped，或 interrupted/error/max-tokens/unknown | escalate（未知当失败） |
| 我方 aborted，cancel_origin=release | released |
| 我方 aborted，cancel_origin ∈ {budget, deadline} | at_risk，`ball='me'`，交给升级（NEEDS-DECISION N1） |

升级（`10` 三选一，按序）：interrupted/error/stall 且尝试数 < 2 → 同画像重派（retry）；loop、max-tokens、自报 failed、或已重派过一次 → `higher()` 画像（upgrade）；尝试数 = 3 或无更高档 → broken，出口提案 `moment='cannot'`（做不到 + 已试过什么 + 两个方向 + 默认）；只有真产品问题才 `ask`（问题数 = 1，R13）。每次写 journal 与 `executor_switched`。停滞与打转全程不产生 interrupt（G9）。

观察器：`session-activity` 探针对 watch 承诺的 `target`（如 `netbird/pc-tower/session/s-88`）读事件计数与最近工具调用名；优先目标机只读会话接口，没有则由 oneshot 只读执行体读持久化文件尾部；`inspect` 返回全量事件（F2），探针必须只取尾部 N=200 条。读不到记一次失败，连续 3 次 → 承诺 broken + 简报一行。

清扫：列出 `sa_workspace` 中 `removed_at IS NULL` 而所属承诺已终态超过 24 小时的目录与 `sa/*` 分支；第一次只报告（dry-run，写 journal note），连续两次报告集合一致才删除并置 `removed_at`；有未提交改动的目录永不自动删（只报告）。

### T22 单测清单（`TS/superagent-executors-closure.spec.ts`，fixture：`FX/ledger.ts`、`FX/fake-controller.ts`（按 S4 读数的事件形状推送 tool/call、tool/result、turn/end）、临时目录）

1. 有未消费 amend → `pending_close`，承诺仍 open。
2. command 判据：事件里有同命令、退出码 0 的工具调用 → fulfilled 且 evidence_json 非空。
3. 同命令但事件里退出码 1、报告声称 0 → unverified。
4. ready 无证据 → unverified。
5. artifact 判据：分支有提交 → fulfilled；无提交 → unverified。
6. blocked 技术性 → escalate；blocked 产品问题 → 一条 asked 假设、问题数 1。
7. turn/end 为 `forked` 或未知值 → escalate（未知当失败）。
8. report(ready) 先到、turn/end 未到 → pending_close；10 分钟后 `pendingSweep` 按表判定。
9. 升级序：第一次 stall → retry；第二次 stall → upgrade；尝试 3 → broken 且 cannot 提案 1 条、interrupt 0 条。
10. loop → 直接 upgrade；无更高档 → broken。
11. cancel_origin=budget 的 aborted → at_risk 且 ball='me'。
12. 探针连续 3 次失败 → 承诺 broken；探针只请求尾部 200 条（fake inspect 记录 limit）。
13. 清扫：第一次 dry-run 不删；集合一致的第二次删除且 removed_at 非空；有未提交改动的目录不删。

### T22 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-executors-closure.spec.ts` | passed=13，failed=0，退出码 0 | 让 command 判据只信报告不比对事件 → 第 3 条红 |
| 测试内读数：`SELECT count(*) FROM commitment WHERE state='fulfilled' AND evidence_json IS NULL` | 0 | — |
| G1–G6 | 见 T-00 | 见 T-00 |
