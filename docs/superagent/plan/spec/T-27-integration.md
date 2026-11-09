# T-27 集成：组合根（T27）、responder 用例迁移账本（T29）、七步链端到端与交付（T30）

> 适用性：本文属于 2026-11-05 原实施批次，保留既有记录，不是当前目标设计的施工依据。2026-11-09 用户授权重整需求后，与[当前设计](../../README.md)、[需求基线](../../01-需求基线.md)冲突的冻结、任务、默认裁定与 DONE 判据不再有效；新实现需重新规划并按[验收与评估](../../13-验收与评估.md)验证。

设计依据：README（组合根只做装配与钩子接线、依赖方向、挂载）、`03-内核`（三档开关、shadow 判据、退役条件）、`11-恢复与降级`（启动顺序）、`01 §E`（七步链）。事实：F20、F22、F23、F33。

## T27 组合根

写域：`SA/index.ts`、`SA/config.ts`、`SA/channels/feishu/admin/config.ts`（只加 superagent 配置键）、`TS/superagent-assembly.spec.ts`。依赖：T12–T26 全部、T28（无代码依赖，只为 W8 前读数可用）。

### 配置（NEEDS-DECISION N29：放在既有 `lark-inbox` 命名空间下，设置页与 parity manifest 不变）

```ts
export interface SuperagentConfig {
  superagentMode: 'responder' | 'shadow' | 'superagent'   // 默认 'responder'；每条入站在 claim 时现读（N13）
  superagentDesk: { seatDir?: string; preset?: string; model?: { provider: string; model: string; effort?: string } }   // D8–D10、N20
  superagentWorld: { entities: ConfigEntity[]; mandates: ConfigMandate[]; owners: { union_id: string; name: string }[]; colleagues: { union_id: string; name: string }[] }
  superagentAttention: { interruptQuota: number; quiet: { from: string; to: string }; briefAt: string }   // 3、22:00–08:00、18:30
}
```

### 装配（`register(ctx)` 内，严格按 `11` 启动顺序）

1. 飞书通道照旧 `feishu.register(ctx, ..., { admit })`；`admit` 在第 6 步之前一律返回 `'responder'`（与今天完全一致）。
2. `openLedgerDb(<queueDir>/inbox.sqlite)`；失败 → 记 diagnostic，`admit` 永远 `'responder'`，superagent 其余部分不挂载（responder 不受影响）。
3. 构造：Ledger → Claim/Clock/Lease/Outlet → World（config 适配器 + ssh-config 适配器）→ Memory/DocArea → Rules（`checkConflicts`）→ OutletPolicy（注入 `memory.disclosures`、`world.mandate(commit_promise)`）→ Executors → Presence（注入判断处理器、ToolFace）→ Judgment（`createRoutePolicy` + 工具处理器）→ Timing（TickSignal、Brief、Speculation、IdleGuard）→ Commands（注入 applyFastpath、DocArea.add、Brief）→ Recovery。
4. 宿主钩子：`ctx.on('session/event')` 转发给 `executors.onSessionEvent` 与 `presence`；若 SPIKES S2(b) 成立，装一个 `agent/request` waterfall：`presence.modelFor(id) ?? executors.modelFor(id)` 命中则覆盖 provider/model/effort（N5），否则透传；ToolFace 按 S1 分支对 `sa-desk-*` 与 `sa-x-*` 会话施加。
5. `await recovery.startup()`。
6. 打开入口：`admit = event => mode() === 'responder' ? claim(event, policy, 'responder') : claim(event, policy, mode())`，结果分派：`route='judge'` → `presence.enqueue`；`fastpath` → `applyFastpath`；`passthrough` → `executors.sendInput`（订阅的尝试）。
7. 定时器（全部 `unref`）：60 秒 `clock.tick → presence.runTurn` + `recovery.reconcile` + `closure.pendingSweep`；1 秒 `outlet.flush`；15 秒 lease 心跳；每天一次 `calibration.recompute`、`sweep`、`memory.retireStale`、`speculation.expire`；`superagentAttention.briefAt` 时刻 `brief.build` → 出口。
8. dispose：先停定时器与 admit，再等在途回合结束（≤5 秒），最后关数据库连接；由 `owner` 等待（与现有 `lifecycle.ts` 同语义）。

### T27 单测清单（`TS/superagent-assembly.spec.ts`，fixture：全部 FX、`TS/services-assembly.spec.ts` 的宿主桩写法）

1. 默认配置（responder 档）：一条入站后 `inbox_events.owner='responder'`，`sa_intake` 0 行，responder 的 kick 被调用 1 次。
2. shadow 档：owner='responder'、`intake(shadow=1)` 1 行、出站 0、承诺 0；桌子回合 deliberation.shadow=1。
3. superagent 档：owner='superagent'，经桩桌子脚本完成一次 commit + ack，出站 1 条且 tier=reply。
4. 运行中把配置从 shadow 切到 superagent：下一条入站即按新档认领（N13）；切回 responder：下一条回到 responder，已有账本不删。
5. `openLedgerDb` 抛错 → 服务域仍挂载、responder 照常、diagnostic 1 条。
6. 启动顺序：`recovery.startup` 完成前到达的入站一律按 responder 认领。
7. dispose 后无定时器回调再执行（手动时钟推进 10 分钟，调用计数不变）、数据库连接已关闭。
8. `agent/request` 覆盖：桌子会话的请求被改成配置的 model；普通会话透传不变；全局默认模型未被写（X3、F14）。
9. `F22` 读数仍为 1；`VT tests/capability-parity.spec.ts` 通过。

### T27 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-assembly.spec.ts` | passed=9，failed=0，退出码 0 | 在 startup 完成前打开 admit → 第 6 条红 |
| `pnpm --filter @dsh-cove/dsh-web-all test` | 全包 failed=0，退出码 0 | — |
| `pnpm typecheck && pnpm test:scripts` | 退出码 0 | — |
| G1–G6 | 见 T-00 | 见 T-00 |

生效方式：需要用户重启 DSH 服务后生效；重启前请备份 `$DSH_HOME/lark-inbox/inbox.sqlite`。默认档为 responder，重启后线上行为不变。

## T29 responder 用例迁移账本

写域：`TS/superagent-parity.manifest.json`、`TS/superagent-parity.spec.ts`、`TS/superagent-parity-*.spec.ts`（迁移来的等价用例）。依赖：T18、T21、T26、T14、T25。

`03` 的退役条件：lark-inbox 的 spec 里与 responder 相关的用例逐条迁到新模块并有等价读数（底数按 NEEDS-DECISION N8 为 11 个文件）。本任务不删除任何旧代码或旧测试，只建立可机械检查的账本。

manifest 形状：

```json
{ "sources": ["tests/lark-inbox-responder.spec.ts", "..."],
  "cases": [ { "source": "tests/lark-inbox-steer.spec.ts", "name": "<it 标题原文>",
               "class": "responder" | "channel" | "admin",
               "status": "migrated" | "kept-in-channel" | "not-applicable",
               "target": "tests/superagent-...spec.ts::<it 标题>", "reading": "<等价读数一句话>", "why"?: "<not-applicable 的理由>" } ] }
```

分类口径：`responder` = 判断要不要回、回什么、何时主动说、steer/停止/会话绑定的用例（迁移对象）；`channel` = 入站归一、去重、队列、发送重试（随通道保留，`kept-in-channel`）；`admin` = 向导、设置页、审计、保留期（保留）。

### T29 单测清单（`TS/superagent-parity.spec.ts`）

1. 解析 11 个源文件的全部 `it(`/`test(` 标题，每个标题在 manifest 中恰出现一次（不多不少）。
2. `status='migrated'` 的每条，其 `target` 文件存在且含同名用例。
3. `status='not-applicable'` 的每条有非空 `why`。
4. `class='responder'` 的条目中 `migrated` 占比读数输出到测试日志（`parity migrated=<x>/<y>`），作为退役前提的读数；本任务的门槛是 `x = y`。

### T29 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-parity.spec.ts tests/superagent-parity-` | failed=0，退出码 0；日志含 `parity migrated=<y>/<y>` | 在 `lark-inbox-steer.spec.ts` 新增一个用例而不登记 → 第 1 条红 |
| G1–G6 | 见 T-00 | 见 T-00 |

退役本身（删除 `responder.ts`、`reply-machine.ts` 判断部分）不在本程序内，需老板授权（PLAN 第 8 节）。

## T30 七步链端到端与交付

写域：`TS/superagent-e2e-seven-step.spec.ts`、`FX/scripted-agent.ts`、`packages/dsh-web-all/README.md`、`packages/dsh-web-all/README.zh.md`、`packages/dsh-web-all/README.i18n.yaml`（经 `pnpm docs:write-pair packages/dsh-web-all` 重写）。依赖：T27、T28。

`FX/scripted-agent.ts`：在 fake-controller 上为 `sa-desk-*` 与 `sa-x-*` 会话挂"脚本代理"：收到 prompt 时按脚本直接调用 ToolFace 测试实现里注册的工具处理器，并推送对应的 `tool/call`、`tool/result`、`turn/end` 事件。脚本是数据（每步一段），不含判断逻辑。

### 七个用例（`01 §E`，老板原话："把 lark-inbox 的某个超时改成 X，并跑对应测试"）

1. 受理：入站 → 桌子脚本 `judge(commit)`、`commit`、`say(ack)`；读数：ack 出站 `created_at - received_at ≤ 30000`（手动时钟），且早于尝试 `started_at`；派发失败的变体：create 注入失败 → 自愈重派，终止句只在两次失败后出现 1 条。
2. 等待：执行体脚本跑两次工具调用；读数：ack 与交付之间同承诺出站 0。
3. 交付：执行体 `tool/call`（`pnpm vitest run tests/lark-inbox-responder.spec.ts`，退出码 0）+ `report(ready, evidence)` + `turn/end(completed)`；读数：承诺 fulfilled、evidence_json 非空、deliver 出站 words ≤100。
4. 追加（NEEDS-DECISION N30 两种时序各一个子用例）：(a) 执行中老板发"顺便把 Z 也改了" → 桌子 `judge(amend)` + `amend`，journal 追加 1 行且被下一回合消费（consumed_turn 非空），本线程顶层承诺数 = 1；(b) 交付后再发 → 子承诺 `parent_id` 指向原承诺、带前情，本线程顶层承诺数仍 = 1。
5. 停：老板发"停" → 快路径 release；读数：60 秒内承诺 released、尝试 ended(cancel_origin='release')、fake-controller 收到 cancel、之后同承诺出站 ≤1（终止回执）。
6. 重启：在一件开着承诺存在时，销毁全部对象并在同一数据库上重新装配；读数：重启前后在办集合 diff 为空，无新承诺、无重复派发。
7. 全程：对本用例产出的数据库运行 `node scripts/superagent-check.mjs --db <file> --compare <第 6 步前的快照>`，退出码 0。

### T30 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-e2e-seven-step.spec.ts` | passed=7（第 4 条含 2 个子用例），failed=0，退出码 0 | 让快路径停止词表缺"停" → 第 5 条红 |
| `pnpm typecheck && pnpm test && pnpm docs:check && pnpm test:scripts` | 四个退出码均为 0（PLAN DONE-1） | — |
| `F22` | `1` | — |
| `codegraph sync . && codegraph status .` | 退出码 0（根 AGENTS 开发流程） | — |
| 交付报告 | 含"需要用户重启 DSH 服务后生效"、默认档 responder、切 shadow 的配置项、DONE-6 的复核命令 | 报告缺任一项即不收 |

README（双语同改）只写用户契约：三档开关与默认值、shadow 不发送任何消息、切换即时生效、生效需要重启服务、已知限制（并发 1、第二声音在无历史读权限时不可用、面板不做）。
