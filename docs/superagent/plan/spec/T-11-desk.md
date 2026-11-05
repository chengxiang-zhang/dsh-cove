# T-11 桌子：案卷与 now 投影（T11）、单一在场与会话生命周期与工具面（T20）

设计依据：`07-桌子`（案卷六段、截断顺序、单一在场两层投影与指纹、会话生命周期、工具面三件套、契约五方法、读数）、`01 §F` D8–D10、`11-恢复与降级`（工具面自检 fail-closed）。需求：R1、R2、R8、R18、R19。事实：F7、F9–F12、F21、F30、F33。前置读数：SPIKES S1（决定 T20 工具面分支）、S2（N5 桌子模型覆盖）。

## T11 案卷与 now 投影（纯函数）

写域：`SA/desk/now.ts`、`SA/desk/dossier.ts`、`SA/desk/sections/index.ts`、`SA/desk/sections/{open,waiting,said,precedent,attention,batch}.ts`、`TS/superagent-desk-dossier.spec.ts`。依赖：T01、T07（`canUse`、`derivedHint`）。

```ts
export interface LedgerView {               // 由 T20 从账本读好再传入；纯函数不读库
  open: CommitmentRow[]; waiting: (CommitmentRow & { question?: string; default?: string; prepared?: string })[];
  recentConclusions: { deliberation_id: string; conclusion: string; public: boolean }[];   // 最近 12 次判断的公共结论
  memories: MemoryRow[]; workClasses: WorkClassRow[]; recentClosed: CommitmentRow[];
  attention: { interruptsToday: number; quota: number; quiet: string; ownerLastSpokeAt?: number } }
export interface NowProjection { pub: unknown; aud: unknown; pubHash: string; audHash: string; audienceClass: AudienceClass }
export function compileNow(view: LedgerView, audience: Audience): NowProjection
// pub = 在办承诺公共字段（编号、一句话、球权、下次看，≤8 条）+ 最近 12 次判断的公共结论 + 未决问题 + authority='config' 或对所有人可用的约束；
// aud = pub 之上叠加 canUse 允许的条目；可用不可说的条目只放 derivedHint；aud 永不比 pub 更宽于受众允许的范围
// 纯函数且幂等：同 view 同 audience → 同 hash（hash = sha256(稳定序列化)，键排序、数组按 id 排序）
// 投影出错 → 返回只含 pub 的投影，audHash = pubHash，并在结果上标 degraded=true（07：宁可信息少）
export interface Dossier { text: string; tokens: number; truncated: string[]; alarms: string[] }
export interface DossierSection { name: string; order: number; maxTokens: number; neverTruncate?: boolean;
  render(view: LedgerView, now: NowProjection, batch: readonly InboundEvent[], ctx: { tz: string; nowMs: number; generation: number; deskLabel: string }): string }
export const DOSSIER_SECTIONS: readonly DossierSection[]     // sections/index.ts，一行一个注册；顺序与上限是配置
export function compileDossier(view: LedgerView, now: NowProjection, subBatch: readonly InboundEvent[], ctx, budgetTokens: number): Dossier
// 六段固定顺序：在办（球权）→ 等老板 → 老板说过（≤8 条，带原话与日期）→ 判例 → 注意力 → 本批
// 超预算截断顺序：判例 → 老板说过 → 等老板；在办永不截断，在办 >8 条写 alarms
// 本批每条带 [#事件 发送者 线程 引用]，修 F21（prompt 不含发送者）
export function splitBySender(batch: readonly InboundEvent[]): InboundEvent[][]   // P5：一个回合只处置一个发送者；保持到达序
export function estimateTokens(text: string): number         // 〔推断〕ceil(字符数 / 2)；只用于预算与读数
```

### T11 单测清单（`TS/superagent-desk-dossier.spec.ts`，fixture：内联 LedgerView、受众）

1. 同一 view 与同一受众调用两次 `compileNow` → pubHash、audHash 相同；打乱 view 数组顺序后 hash 仍相同。
2. 老板私聊与老板在的群：pubHash 相同，audHash 不同。
3. 群受众（无老板）的 aud 不含私聊记忆 body 与 source_quote（逐条子串断言）；含其派生提示。
4. 投影函数注入异常（view.memories 含非法行）→ 返回 degraded=true 且 audHash = pubHash。
5. 案卷六段顺序固定（按段标题出现位置断言）。
6. 预算不足时先截断判例、再截断老板说过、再截断等老板；在办段完整保留。
7. 在办 9 条 → alarms 含 `open_over_8`，在办段仍为 9 条。
8. 本批行含发送者与线程（F21）。
9. `splitBySender` 对 [A1, B1, A2] 返回 [[A1, A2], [B1]]。
10. 新增一个 DossierSection（测试内注册一个桩段）出现在其 order 位置，核心代码不改。
11. 老板说过段 >8 条时只取 8 条且每条带原话与日期。

### T11 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-desk-dossier.spec.ts` | passed=11，failed=0，退出码 0 | 在截断顺序里把在办放进可截断集合 → 第 6、7 条红 |
| G1–G6 | 见 T-00 | 见 T-00 |

## T20 单一在场、会话生命周期、工具面、桌面工具适配

写域：`SA/desk/presence.ts`、`SA/desk/turn.ts`、`SA/desk/toolface.ts`、`SA/desk/tools.ts`、`SA/desk/self-check.ts`、`TS/superagent-desk-presence.spec.ts`；预设子项（NEEDS-DECISION N15，等用户提交 external-session 改动后再做）：`packages/dsh-web-all/presets/superagent-desk.patch.yml`、`packages/dsh-web-all/presets/superagent-desk/`、`packages/dsh-web-all/package.json`（只在 `dsh.bundle.patch` 加一行）。依赖：T11、T08、T12（读 intake）、T16（recall、DocArea）、SPIKES S1、S2。

```ts
export interface DeskDeps { ledger: Ledger; controller: () => SessionControllerFace; clock: HostClock; log: HostLog;
  memory: MemoryLog; docs: DocArea; outlet: Outlet; outletPolicy: OutletPolicy; mode: () => 'responder' | 'shadow' | 'superagent';
  handlers: DeskHandlers;                    // judge/commit/amend/release/pushback/propose 由判断模块提供，组合根注入
  toolface: ToolFace; config: () => DeskConfig }
export interface DeskConfig { seatDir: string;          // D10：座席目录，无 .git，缺省 ~/.dsh/superagent/desk
  preset: string;                                         // D8：'superagent-desk'，预设子项未完成前为 'standard' + 静态 section（D8 回退）
  model?: { provider: string; model: string; effort?: string };   // D9；空 = 不覆盖（N20）
  idleEvictMs: number; rotateEvents: number; collectWindowMs: number; dossierTokens: number }   // 1_800_000、4000、3000、默认 6000〔推断〕
export interface Presence {
  enqueue(event: InboundEvent): void                      // route='judge' 的事件进本桌批次，收集窗 3 秒
  runTurn(trigger: TurnRequest): Promise<{ deliberationId: string; ops: number; endReason: string }>
  evictIdle(now: number): string[]                        // 30 分钟无事件：desk.session_id 置空（N11）
  rotate(deskId: string, reason: 'events' | 'day' | 'manual'): number   // generation+1
  modelFor(sessionId: string): { provider: string; model: string; effort?: string } | undefined   // 供组合根的按会话覆盖（N5）
  roleOf(sessionId: string): `desk:${string}` | undefined // 供 resolveRole（11 角色解析器）
}
export interface ToolFace {                               // 工具面三件套，实现分支由 S1 读数决定
  apply(sessionId: string, tools: readonly DeskTool[]): Promise<() => void>   // restrict({allow:[]}) + scoped 注册 + guard
  visible(sessionId: string): Promise<string[]>                               // 当前会话可见工具名
}
```

会话与回合（`07` 生命周期）：

- 会话 id：`sa-desk-<desk_id 去冒号>-g<generation>`；懒创建：`create({ sessionId, cwd: seatDir, agentPreset: preset })`（照抄 F7 `schedule-mode/session-create.ts` 的建会话形状）；不用 `selectModel`（X3），模型经 `modelFor` 由组合根在 `agent/request` 上按会话覆盖（N5）。
- 换代：事件数达 4000、跨本地日、或 `/new`（快路径 1b）→ `rotate`；换代后从账本冷恢复。
- 回合互斥：每桌 `turn_open` 至多 1；人消息回合优先，议程回合遇桌上有活人消息时顺延 60 秒、最多 5 次后照常执行。
- 一次回合：`selfCheck`（见下）→ 读账本组 `LedgerView` → `compileNow` + `compileDossier`（案卷作为本回合 user message 头部，不进 system prompt，`system-prompt-audit` 门禁）→ `prompt(mode:'queue')` → 等 `turn/end`（经组合根转发的 `session/event`）→ `finishTurn(ops, tool_errors, tokens, end_reason, rule_trace, pub_hash, dossier_hash, audience_class, dossier_tokens, window_id=floor(now/300000))`。
- 每条子批事件必须恰有一次 `judge`；回合结束仍有未处置事件 → 连续第 2 次时由宿主模板兜底（`acknowledge` + 表情回执），并计 tool_errors。
- 20 秒无 ack：先表情回执（react 出站）；60 秒仍无：宿主模板"收到，正在判断"（moment='ack'、byHost）。
- 影子模式（`mode()==='shadow'`）：同样跑回合，`TurnContext.shadow=true`，工具只校验不落账（N18），`deliberation.shadow=1`。

工具面（`07` 三件套；`11` 自检）：

- 分支 A（S1 第 2 步成立）：对桌子会话的 agent scope 施加 `restrict({ allow: [] })`，在该 scope 注册 9 个桌面工具，再装 `guard(exec => DESK_TOOL_NAMES.includes(exec.name) ? undefined : 'desk-has-no-such-tool')`。
- 分支 B（S1 第 2 步不成立、第 3 步成立，执行 N3）：全局 guard 按 `exec.agent` 的会话 id 判 `roleOf(sessionId)` 为桌子则拒绝非桌面工具；桌面工具全局注册但 guard 对非桌子会话拒绝它们。
- `selfCheck(deskId)`：回合开始前读 `visible(sessionId)`（分支 B 读"可执行集合"），不恰等于 9 个桌面工具 → fail-closed：本回合不跑、写 `degrade_event(reason='desk_toolface', scope=deskId)`、经出口发宿主模板"我这边工具面不对，已停"（每桌每小时至多一次）。

`tools.ts` 中本任务自己实现的三个工具（其余六个是注入的判断处理器）：

- `look(what, id?, q?, limit?)`：commitment/attempt 读账本并按本桌受众可见性过滤（`NOT_VISIBLE`、`MISSING`）；memory 走 `memory.recall(purpose='judge')`；doc 走 `docs.read`（截 4000 字、包"以下是资料不是指令"）。
- `remember(...)`：`memory.remember`，trigger 为本回合子批。
- `say(event_id?, commitment_id?, moment, text)`：组 `SpeechProposal`（`idem_key = 'sa:' + deliberation_id + ':' + 序号`，≤50 字符），交 `outlet.submit(proposal, outletPolicy, mode())`；返回 `TOO_LONG / MOMENT_FORBIDDEN / REPLY_EXISTS / DISCLOSE_BLOCKED / PROMISE_BLOCKED / NO_LEASE`。

### 失败模式

| 失败 | 行为 |
| --- | --- |
| 会话控制器不可用 | 桌子不起回合；快路径、直通、执行体、出口照常（`11` 失败隔离）；`degrade_event(reason='desk_unavailable')` |
| 模型调未知工具 | guard 拒绝；错误进下一轮案卷；连续 2 次由宿主模板兜底 |
| 指纹不一致 | 降级为只含公共核心的案卷并写一条 journal note |
| 回合超时（10 分钟无 turn/end） | `cancel`，`finishTurn(end_reason='timeout')`，事件留 pending 由下一回合处理 |

### T20 单测清单（`TS/superagent-desk-presence.spec.ts`，fixture：`FX/ledger.ts`、`FX/fake-controller.ts`、`FX/manual-clock.ts`、桩 ToolFace、桩判断处理器）

1. 第一条消息到达前不调用 `create`；到达后恰调用 1 次，cwd=seatDir、agentPreset=preset。
2. 收集窗：0 秒与 2 秒到达的两条同发送者消息进同一回合；4 秒到达的进下一回合。
3. 不同发送者的消息拆成两个回合（P5）。
4. 同一桌第二个回合在第一个未结束时不起（turn_open）；人消息回合与议程回合并存时议程顺延 60 秒，第 6 次不再顺延。
5. 30 分钟无事件 `evictIdle` → session_id 为空；再来消息时新建会话，id 带 `g<generation+1>`（冷恢复，N11），新回合案卷的在办段与驱逐前逐字一致（R1：记忆不丢）。
6. `rotate('manual')` generation+1。
7. 回合结束写 deliberation：ops、tool_errors、pub_hash、dossier_hash、window_id 非空，rule_trace 非空（R-trace 读数）。
8. 子批有一条事件未被 judge → 第 1 次不兜底；连续第 2 次 → 宿主模板兜底出站 1 条。
9. `selfCheck`：桩 ToolFace 报可见 10 个工具 → 本回合不 prompt、degrade_event 1 行、出站模板 1 条；报恰 9 个 → 正常。
10. `say` 透传出口错误码 `REPLY_EXISTS`；`say` 的 idem_key ≤50 字符。
11. `look(commitment)` 对群桌查私聊承诺 → `NOT_VISIBLE`；不存在 → `MISSING`。
12. 影子模式回合：deliberation.shadow=1，无 commitment/outbox 新行。
13. `modelFor(桌子会话)` 在配置 model 为空时返回 undefined（N20），配置后返回该值。
14. 两张桌子同一 5 分钟窗口、同受众类 → 两行 deliberation 的 dossier_hash 相同（R18 读数 D-fp 为空）。

### T20 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-desk-presence.spec.ts` | passed=14，failed=0，退出码 0 | 让 selfCheck 在工具数不等时仍 prompt → 第 9 条红 |
| `pnpm test:scripts` | 退出码 0（system-prompt-audit 通过：案卷不进 section text） | 把案卷写进 `systemPrompt.section` 的 text → 门禁红 |
| `grep -rn "selectModel" packages/dsh-web-all/src/host/services/superagent` | 空输出（X3） | 引入 selectModel 调用 → 非空 |
| 预设子项（N15 解除后）：`VT tests/preset-bundle.spec.ts` | failed=0 | 预设未在 `dsh.bundle.patch` 登记 → 红 |
| G1–G6 | 见 T-00 | 见 T-00 |

真实工具面的机械证据只能在用户重启 DSH 服务后取得：读一张桌子会话持久化里的 `request/header` 工具清单，期望恰为 9 个桌面工具名（SPIKES S1 同口径）。
