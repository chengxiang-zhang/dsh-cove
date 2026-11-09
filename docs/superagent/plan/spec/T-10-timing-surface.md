# T-10 时机与措辞：注意力与模板（T10）、议程与简报与投机（T23）、命令与文档区入口（T24）

> 适用性：本文属于 2026-11-05 原实施批次，保留既有记录，不是当前目标设计的施工依据。2026-11-09 用户授权重整需求后，与[当前设计](../../README.md)、[需求基线](../../01-需求基线.md)冲突的冻结、任务、默认裁定与 DONE 判据不再有效；新实现需重新规划并按[验收与评估](../../13-验收与评估.md)验证。

设计依据：`09-时机与措辞`（四个议程来源、投机三类与边界、全双工、注意力四档、措辞模板、命令、防空跑、契约六方法）、`02-协议`（`say` 时刻规则、宿主命令与退出码）、`05-记忆`（升公共批量批准进简报）。需求：R5、R9、R15、R16、R19、G7、G9、B6、B14。事实：F28、F31、F32。

本模块不发送：一切出站都是交给内核 `Outlet.submit` 的提案；`OutletPolicy` 的实现在这里，由组合根注入内核。本模块依赖协议、内核、规则（README 边表），记忆的 `disclosures` 由组合根以函数形式注入。

## T10 注意力、模板、出口策略（纯函数）

写域：`SA/timing/attention.ts`、`SA/surface/templates.ts`、`SA/surface/words.ts`、`SA/surface/promise-scan.ts`、`SA/surface/moment.ts`、`SA/timing/outlet-policy.ts`、`TS/superagent-timing-policy.spec.ts`。依赖：T01。

```ts
// words.ts（NEEDS-DECISION N19）
export function countWords(text: string): number      // Intl.Segmenter('zh',{granularity:'word'}) 的 isWordLike 段数；连续数字计 1

// attention.ts（09 注意力四档；tier 只由宿主算）
export interface AttentionContext { moment: OutboxMoment; ballToOwnerWithClock: boolean; irreversible: boolean;
  isReplyToInbound: boolean; interruptsToday: number; quotaPerDay: number; localHHMM: string;
  quiet: { from: string; to: string } }                                   // 默认 22:00–08:00（F28）
export function tier(ctx: AttentionContext): { tier: Tier; folded: boolean }
// 规则：isReplyToInbound 且 moment ∈ {ack, answer, pushback, ask, deliver} → reply；
// moment='alert' 或（moment ∈ {ask, cannot} 且 ballToOwnerWithClock）→ interrupt；超额或静默时段（非 irreversible）→ brief 且 folded=true；
// moment='brief' → brief；其余 → silent。空跑/停滞/打转/消耗类从不产生 interrupt（调用方不会以这些 moment 提案；本函数对 moment 以外的原因一概不升档）

// templates.ts（09 措辞表）
export function render(moment: OutboxMoment, data: TemplateData): { text: string; words: number; expectsReply: boolean }
// ack: '接了 C-<n>：<理解>。预计 <分钟> 分钟。' + (问题 ? '先回答我：<问题>（不回按 <默认>）' : '不对就说。')
// deliver: verified=false 时强制前缀 '做完了，但没验证：'；正文含 改了哪 / 跑了什么 / 退出码 / 读数
// cannot: '停在<步骤>。已试过：<…>。改动：<…>。两个方向：1 <…> 2 <…>（不回按 <默认>）'
// ask: 一个问题 + 选项 + 默认；brief: 编号清单 ≤6 行、每行 ≤15 词，溢出行替换为 '另有 N 件，回"全部"展开'
// 任一模板渲染后 words > 100 → 抛 TOO_LONG（模板本身不允许越界）

// promise-scan.ts（R15）
export function promiseHits(text: string): string[]   // 时间点（明天/今晚/下周X/\d+点/\d+号/\d+月\d+日）、范围扩大（全部/所有/保证/一定）、对外（上线/发布/对外/公开）
// moment.ts（02 say 时刻规则，事实由调用方给）
export interface MomentFacts { committedInThisTurn: boolean; commitmentTerminal: boolean; dispositionIsAnswerOrCheck: boolean;
  hasAskedAssumptionOrRoute: boolean; brokenOrAtRiskOrDispatchFailed: boolean; isAgendaTurnWithSignal: boolean; byHost: boolean }
export function momentAllowed(moment: OutboxMoment, f: MomentFacts): boolean
// ack ⇔ committedInThisTurn 或 byHost（宿主兜底句"收到，正在判断"，10：60 秒内由宿主模板兜一句）；deliver ⇔ commitmentTerminal；answer ⇔ dispositionIsAnswerOrCheck；ask ⇔ hasAskedAssumptionOrRoute；
// cannot ⇔ brokenOrAtRiskOrDispatchFailed；alert ⇔ isAgendaTurnWithSignal；brief ⇔ byHost；pushback 永不经 say（由 pushback 工具产出）

// outlet-policy.ts：OutletPolicy 实现（03 依赖反转表）
export function createOutletPolicy(deps: { attentionCtx(p: SpeechProposal, now: number): AttentionContext;
  momentFacts(p: SpeechProposal): MomentFacts; disclosures(text: string, chatId: string): string[];
  mayPromise(chatId: string): boolean; identityNeeded(chatId: string): boolean }): OutletPolicy
// check 顺序：momentAllowed → countWords ≤100（TOO_LONG）→ promiseHits 非空且 !mayPromise（PROMISE_BLOCKED）→ disclosures 非空（DISCLOSE_BLOCKED）
// → 首条非老板对话前置身份说明 '我是<老板称呼>的代理，' 并重算词数（R16）→ tier
```

### T10 单测清单（`TS/superagent-timing-policy.spec.ts`，fixture：内联）

1. `countWords('把 lark-inbox 的超时改成 30 秒')` 为确定值（用例里写死实测值），同一输入两次相同；连续数字 `123456` 计 1。
2. reply：入站回复的 ack → reply。
3. interrupt：第 4 条 interrupt（quota 3）→ brief 且 folded。
4. 静默时段 23:00 的 interrupt → brief；`irreversible=true` → interrupt。
5. moment='brief' → brief；内部进度类（moment 不在表内的调用以 silent 验证）→ silent。
6. ack 模板：有问题时含"不回按"，无问题时含"不对就说"；words ≤100。
7. deliver 模板 verified=false → 以"做完了，但没验证"开头。
8. brief 模板 9 条输入 → 6 行，最后一行为"另有 4 件"（5 条正文 + 1 行溢出）。
9. 渲染超过 100 词 → `TOO_LONG`。
10. `promiseHits('明天上线')` 命中 2 处；`mayPromise=false` 时策略返回 `PROMISE_BLOCKED`。
11. `disclosures` 桩返回非空 → `DISCLOSE_BLOCKED`。
12. `momentAllowed('ack', {committedInThisTurn:false,...})` 假；`'pushback'` 恒假。
13. 首条非老板对话正文被前置身份说明，且前置后超 100 词时返回 `TOO_LONG` 而非截断。

### T10 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-timing-policy.spec.ts` | passed=13，failed=0，退出码 0 | 把 interrupt 每日额度判断写成 `>` 3 而非 `>=` 3 → 第 3 条红 |
| G1–G6 | 见 T-00 | 见 T-00 |

## T23 议程、简报、投机、防空跑

写域：`SA/timing/agenda/index.ts`、`SA/timing/agenda/{deliver-warning,watch,remind,goal}.ts`、`SA/timing/brief.ts`、`SA/timing/speculation.ts`、`SA/timing/idle-guard.ts`、`TS/superagent-timing-agenda.spec.ts`。依赖：T10、T13、T17（读 work_class 阈值）。

```ts
export interface AgendaSource { name: string; due(c: CommitmentRow, now: number, read: LedgerReader): Signal | null }
export const AGENDA_SOURCES: readonly AgendaSource[]            // index.ts，一行一个注册
export function createTickSignal(read: LedgerReader, sources = AGENDA_SOURCES): TickSignal   // TickSignal.has 的实现
export interface Brief { build(day: string, now: number): { body: string; items: BriefItem[] } | null }   // 无开着承诺且当天无事 → null（不发）
export interface Speculation {
  start(tx: LedgerTx, kind: 'probe' | 'prep' | 'patrol', ctx: { commitment_id?: string; desk_id?: string }): string  // spec_id；落点 ~/.dsh/superagent/speculations/<id>/
  adopt(tx: LedgerTx, specId: string): void      // used
  discard(tx: LedgerTx, specId: string): void    // discarded，零消息
  expire(tx: LedgerTx, now: number): number      // 3 天未采纳 → expired；discarded 保留 7 天后删目录（行保留）
  narrowPatrol(now: number): boolean             // 近 7 天 discarded/(used+discarded) > 0.8 → 关第 3 类
}
export interface IdleGuard { turnsToday(now: number): number; overCap(now: number): boolean;   // 每日秘书回合上限默认 200
  idleRate24h(now: number): number; tighten(now: number): boolean }                           // ops=0 占比 > 0.3 → 收紧信号阈值并后推，静默
```

议程来源（`09` 主动只有四个）：

| 来源 | 信号条件 | 不开口的情况 |
| --- | --- | --- |
| deliver-warning | 已用墙钟 > `eta_at`；或尝试 `last_tool_at` 两窗口（10 分钟）无变化；或 `repeat_count ≥ 3` | 停滞与打转只返回 `{kind:'self_heal'}` 信号，由执行体升级处置（T22），不请求说话；首次超 ETA 且老板在等 → 只进简报 |
| watch | 承诺到点且距上次探针 ≥10 分钟 | 探针读不到连续 3 次 → `{kind:'probe_failed'}`，承诺转 broken 由执行体模块处置 |
| remind | `due_at - now ≤ 提醒提前量` 且未提醒过（journal 无 `kind='note', body.reminded`） | 已提醒过 |
| goal | 每 7 天一次 | 有未批提案时不再产出 |

简报：每天一条、≤100 词、每行 ≤15 词、至多 6 行；内容来源 = 不在等的交付、待决（≤3，带默认与截止）、校准与自动度变化、`memory.promoteCandidates`（至多 5 条，"回 1、3"）、目标提案、被折叠的打断、降级事件。待决到截止不回 → 按默认执行并在下一份简报记结果；默认动作不可逆时执行前升一次 interrupt。

### T23 单测清单（`TS/superagent-timing-agenda.spec.ts`，fixture：`FX/ledger.ts`、`FX/manual-clock.ts`）

1. deliver 未到 ETA、有工具调用 → `has` 返回 null。
2. 10 分钟零工具调用 → 信号 kind='self_heal'（不是说话类信号）。
3. 超 ETA 首次 → 信号 kind='late'，下游注意力把它放进 brief 而非 interrupt。
4. watch 距上次探针 9 分钟 → null；10 分钟 → 信号。
5. remind 到提前量 → 信号一次；已提醒后 → null。
6. goal 有未批提案 → null。
7. `Brief.build` 无开着承诺且当天无事 → null；有 9 项 → 正文 ≤6 行且 words ≤100。
8. 升公共候选进简报，至多 5 条，带"回 1、3"。
9. 投机 discard 后无出站行；3 天后 expire；7 天内 `discard` 的行可被 `look` 查到（行保留）。
10. 近 7 天 discard 率 0.85 → `narrowPatrol` 真。
11. 当天第 201 个桌子回合 → `overCap` 真。
12. 24 小时 ops=0 占比 0.4 → `tighten` 真且不产生任何出站提案。

### T23 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-timing-agenda.spec.ts` | passed=12，failed=0，退出码 0 | 让停滞信号产生 interrupt 档 → 第 2 条红 |
| 测试内读数：`SELECT d, count(*) FROM (SELECT date(created_at/1000,'unixepoch','localtime') d FROM outbox WHERE moment='brief') GROUP BY d HAVING count(*)>1` | 空 | — |
| G1–G6 | 见 T-00 | 见 T-00 |

## T24 命令与文档区入口

写域：`SA/surface/commands/index.ts`、`SA/surface/commands/{status,stop,brief,calibration,doc}.ts`、`SA/surface/routes.ts`、`scripts/superagent-cmd.mjs`、`TS/superagent-commands.spec.ts`、`docs/remote-access.md`（只在路由族清单里加一行）。依赖：T08、T16（`DocArea`）、T10。

入口形态（NEEDS-DECISION N28〔推断〕）：命令在服务内实现为 `Commands.run(name, args) → { json, exitCode }`；暴露为宿主路由族 `/superagent/commands/<name>`（POST），每个路由先过共享围栏 `accessTrustOf(ctx)`（根 AGENTS 远程访问契约：只读接口同样是特权面）；`scripts/superagent-cmd.mjs <name> [args]` 只是调用本机该路由并把 `exitCode` 作为进程退出码。命令不直接写库：`stop` 经判断模块的 release 宿主路径（`applyFastpath` 同一实现），`doc add` 经记忆模块的 `DocArea.add(by='human')`，`brief --now` 经 T23 的 `Brief`。三者都由组合根以函数注入 `createCommands(deps)`：`surface` 按 README 边表不能 import 判断与记忆。

```ts
export interface Commands { run(name: 'status' | 'stop' | 'brief' | 'calibration' | 'doc', args: string[]): Promise<{ json: unknown; exitCode: 0 | 1 | 2 | 3 }> }
// status [--json]：在办（球权）、等老板、今日打断计数、空跑率、降级段（只从 degrade_event 读）、租约持有者；不超过一屏（≤40 行）
// stop C-n：参数不合 /^C-\d+$/ → 2；承诺不存在 → 3；已终态 → 1；成功 → 0
// brief --now：立即构建并提交一份简报；无内容 → 3
// calibration：work_class 读数（06 读数最后一条）
// doc add <path> | doc list [q]：路径不存在 → 2；list 无结果 → 3
```

### T24 单测清单（`TS/superagent-commands.spec.ts`，fixture：`FX/ledger.ts`、种子承诺与 degrade_event）

1. `status --json` 的 `open` 列表与 `11` 在办集合 SQL 结果一致；降级段只含 `ended_at IS NULL` 的行。
2. `status` 文本 ≤40 行。
3. `stop C-x` → 2；`stop C-999` → 3；对终态承诺 → 1；对开着承诺 → 0 且承诺 released、尝试 cancel_origin='release'。
4. `brief --now` 无内容 → 3。
5. `doc add` 不存在的路径 → 2；存在的路径 → 0 且 `doc_index.added_by='human'`。
6. `doc list` 无匹配 → 3。
7. 路由在围栏拒绝时返回 403 且不执行命令（桩 `accessTrustOf` 返回不可信）。
8. `scripts/superagent-cmd.mjs` 把路由返回的 exitCode 原样作为进程退出码（用本地桩 HTTP 服务测）。

### T24 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-commands.spec.ts` | passed=8，failed=0，退出码 0 | 去掉路由的围栏调用 → 第 7 条红 |
| `pnpm test:scripts` | 退出码 0（含 `service-fence-contract` 静态围栏门禁） | 同上负控 → 静态门禁红 |
| `pnpm dsh-netbird:audit` | 与 W0 基线读数一致（新增路由族不改变既有机器读数） | — |
| G1–G6 | 见 T-00 | 见 T-00 |
