# superagent 实施方案（PLAN）

本文把已冻结的 superagent 设计（`docs/superagent/00`–`11`）拆成 Agent Team 可直接执行的波次、任务、写域与验收人。任务明细在 [TASKS.md](TASKS.md)，每任务的接口与单测在 [spec/](spec/T-00-conventions.md)，第 0 天的 spike 在 [SPIKES.md](SPIKES.md)，需要老板拍板或文档自相矛盾的事项在 [NEEDS-DECISION.md](NEEDS-DECISION.md)。

权威顺序沿用设计 README：原话（00）> 需求基线（01）> 协议（02）> 模块文档 > 本方案。本方案与设计冲突时以设计为准，冲突项已列入 NEEDS-DECISION，不在这里自行改设计。

## 1 目标与范围

目标：在 `packages/dsh-web-all/src/host/services/superagent/` 落地一个服务域，按设计实现内核四原语（`ClaimPolicy`/`TickSignal`/`OutletPolicy`/`SenderPort` 注入）、协议对象与 DDL、世界模型、记忆、规则、桌子、判断、时机与措辞、执行体、恢复与降级、飞书通道（原 lark-inbox 并入 `channels/feishu`），以及 `scripts/superagent-check.mjs` 七步链检查。

范围内：

- 三档开关 `responder | shadow | superagent`（`03` 共存与接管），默认 `responder`，交付时可切 `shadow`。
- 七步验收链（`01 §E`）在假会话控制器与假通道上全部可机械复跑；在真实服务上以 shadow 读数验证（用户重启后生效）。
- 读数 SQL（`02`–`11` 各"读数"节）全部进入 `superagent-check.mjs`，退出码 0/1/2/3（F31）。

## 2 非目标

沿用 `01 §I`：群聊话题切分；面板优先（D2，第一期不做 `Panel.render`）；多秘书水平再切分；自建执行体池；跨机与多设备常驻；修改 DSH 源码（F24）；重启正在跑的服务（F23）。

本方案额外不做：

- 不删除 `responder.ts` / `reply-machine.ts`：退役是接管后的独立动作，需老板授权（见第 8 节）。
- 不打开并发 >1（D3）；不引入 subagent 派活（D7、X4）；不用 `selectModel`（X3）。
- 不写面板 UI、不做跨机第二声音的"防止"（只做发现，P6 未验证前降级为不可用）。

## 3 交付判据（什么算这个程序做完了）

全部满足才算完成，每条都是命令 + 读数：

| 编号 | 命令 | 期望读数 |
| --- | --- | --- |
| DONE-1 | `pnpm typecheck && pnpm test && pnpm docs:check && pnpm test:scripts` | 四个命令退出码均为 0 |
| DONE-2 | `pnpm --filter @dsh-cove/dsh-web-all exec vitest run tests/superagent-e2e-seven-step.spec.ts` | 7 个用例（`01 §E` 每步一个）全过，退出码 0 |
| DONE-3 | `node scripts/superagent-check.mjs --db <e2e 产出的 fixture 库>` | 退出码 0，输出含 `I1 ok`、`I2 ok`、`I3 ok`、`I4 ok` 与七步链 7 行 `ok` |
| DONE-4 | `grep -cE '^\s*- id:' packages/dsh-web-all/cordis.patch.yml` | `1`（F22；不要用 `grep -c -- '- id:'`，注释行会被数到，实测输出 4） |
| DONE-5 | `pnpm --filter @dsh-cove/dsh-web-all exec vitest run tests/superagent-deps.spec.ts` | 依赖边与 `README` 精确边表一致、kernel 无上行 import，退出码 0 |
| DONE-6 | 用户重启 DSH 服务并把开关切到 `shadow` 后，`node scripts/superagent-check.mjs --shadow --since-hours 72` | 退出码 0；`shadow_owner_mismatch=0`、`shadow_outbox_rows=0`、`intake_shadow>=30`（数量门槛见 NEEDS-DECISION N12） |

DONE-6 依赖用户重启与真实流量，是交付的最后一格；DONE-1 到 DONE-5 在仓库内可复跑。切到 `superagent` 档（接管）不在交付判据里，它是交付后的老板授权动作。

## 4 波次

| 波 | 任务 | 并行度 | 退出判据（命令 → 期望读数） |
| --- | --- | --- | --- |
| W0 | S1–S5 spike + 基线读数 | 5 | `SPIKES.md` 五项全部"成立"或其不成立分支的设计改动已按 NEEDS-DECISION 默认动作落档；基线 `pnpm typecheck/test/test:scripts/docs:check` 读数已记录 |
| W1 | T01 T02 T03 | 3 | 三任务验收全绿；`pnpm --filter @dsh-cove/dsh-web-all test` 退出 0（通道搬家后 lark-inbox 11 个 spec 原样通过） |
| W2 | T04 T05 T06 T07 | 4 | 四任务验收全绿；`VT tests/superagent-db.spec.ts` 证明 25 张 `sa_` 表（含 NEEDS-DECISION N7 的 `sa_workspace`）与 `inbox_events.owner` 列存在 |
| W3 | T08 T09 T10 T11 T18 | 5 | 五任务验收全绿；`DEPS` 通过；`VT tests/lark-inbox-` 与 W1 末读数相同 |
| W4 | T12 T13 T14 T15 T16 | 5 | 五任务验收全绿；内核四原语单测 passed = 12+11+8+12 = 43 |
| W5 | T17 T19 T20 T24 | 4 | 四任务验收全绿；`pnpm test:scripts` 退出 0（含 system-prompt-audit 与静态围栏门禁） |
| W6 | T21 T22 T28 | 3 | 三任务验收全绿；`superagent-check.mjs` 对空库退出 3、对 clean fixture 退出 0 |
| W7 | T23 T25 T26 | 3 | 三任务验收全绿；`VT tests/superagent-` 全部 failed=0 |
| W8 | T27 T29 | 2（集成串行点） | 组合根接线后 `pnpm --filter @dsh-cove/dsh-web-all test` 退出 0；`capability-parity` 通过；`parity migrated=<y>/<y>` |
| W9 | T30 | 1 | DONE-1 到 DONE-5 全部成立；交付报告写明"需要用户重启 DSH 服务后生效" |

波间依赖：W(n+1) 的任何任务开工前，W(n) 的退出判据必须由 Lead 复跑并记录读数。spike 不过不许进 W1。

## 5 总 DAG

```
W0  S1 S2 S3 S4 S5 + 基线读数                                        （闸：五项有读数）
W1  T01 协议类型        T02 通道搬家        T03 check 骨架
W2  T04 DDL◄T01         T05 世界纯函数◄T01  T06 规则引擎◄T01  T07 记忆可见域◄T01
W3  T08 账本◄T04        T09 快路径◄T01      T10 注意力/模板◄T01  T11 案卷◄T01,T07  T18 飞书通道◄T02,T04
W4  T12 认领◄T08        T13 时钟◄T08        T14 出口租约◄T08  T15 世界存储◄T05,T08  T16 记忆存储◄T07,T08
W5  T17 规则存储◄T06,T08  T19 派发◄T08,T15,S2,S4,S5  T20 在场◄T08,T11,T12,T16,S1,S2  T24 命令◄T08,T10,T16
W6  T21 judge/闸/异议◄T09,T12,T15,T16,T17,T19  T22 结案升级◄T19,S4  T28 check 全量◄T03,T04
W7  T23 议程简报◄T10,T13,T17  T25 恢复◄T13,T14,T19,T20,T22  T26 交办收放◄T19,T21,T22
W8  T27 组合根◄T12..T26,T28   T29 迁移账本◄T14,T18,T21,T25,T26
W9  T30 七步链 e2e 与交付◄T27,T28
```

| 波 | 任务数 | 并行度 | 关键路径上的任务 |
| --- | --- | --- | --- |
| W1 | 3 | 3 | T01 |
| W2 | 4 | 4 | T04 |
| W3 | 5 | 5 | T08 |
| W4 | 5 | 5 | T12 |
| W5 | 4 | 4 | T19 |
| W6 | 3 | 3 | T21、T22 |
| W7 | 3 | 3 | T26 |
| W8 | 2 | 2 | T27 |
| W9 | 1 | 1 | T30 |

关键路径：T01 → T04 → T08 → T15 → T19 → T21 → T26 → T27 → T30（9 跳，对应 9 个实现波）。W8、W9 的低并行度是结构性的：组合根只能一人写，端到端只能在组合根之后。图无环：每条边都从较早的波指向较晚的波。

## 6 并发与写域

写域记号：`SA=packages/dsh-web-all/src/host/services/superagent/`，`TS=packages/dsh-web-all/tests/`。每任务写域在 TASKS.md 精确到文件或目录前缀；同一波内写域两两不相交，由 Lead 在开波前用 `TASKS.md` 的写域列做一次交集检查（命令见 [spec/T-00-conventions.md](spec/T-00-conventions.md) 的"写域检查"）。

串行点（只能一个任务独占）：

- `SA/protocol/` 只有 T01、T04 写；W3 之后协议冻结，改协议必须回到 Lead 开协议变更单（`02` "契约是关闭的"）。
- `SA/index.ts`（组合根）：T02 建骨架（只委托飞书通道），之后只有 T27 写。
- `packages/dsh-web-all/src/host/services/index.ts` 与 `TS/capability-parity.manifest.json`：只有 T02 写。
- `packages/dsh-web-all/package.json`、`tsdown.config.ts`、`presets/`：当前工作树有未提交的 external-session 改动；只有 T20 的预设子项会碰 `presets/` 与 `package.json`，且必须等那批改动由用户提交后再开工（NEEDS-DECISION N15）。
- `TS/superagent-deps.spec.ts`：T01 建，此后只读；新增模块不改边表，边表就是 `README` 的精确边表。

工作方式：每个实现者在独立 git worktree（基于 `dev` 已提交的 HEAD）里工作，不碰主工作树中未提交的 external-session 文件；Lead 按波合入 `dev`（本地提交，Conventional Commits，不 push）。

## 7 Agent 编制

| 角色 | 人数 | 模型档 | 职责 | 禁止 |
| --- | --- | --- | --- | --- |
| Lead | 1 | Opus 5.5，xhigh | 开波、冻结 spec、执行 NEEDS-DECISION 默认动作、合入、复跑波退出判据 | 不实现任何任务 |
| 实现者 I1–I5 | 5 | A 档：Opus 5.5 high；B 档：Sonnet 5.5 high | 按 spec 实现与写单测，交付时贴验收命令原始输出 | 越出写域；改 spec；改 `00`–`11` |
| 验收者 V1、V2 | 2 | Opus 5.5 high | 在干净 worktree 复跑验收命令与负控，负控必须变红再恢复 | 修代码；验收自己写过的任何文件 |
| 对抗评审 R1 | 1 | Opus 5.5 xhigh | 对 T04、T12、T14、T20、T21、T27 做安全与不变量对抗评审 | 修代码 |

maker≠grader 规则：每任务的验收者在 TASKS.md 指定，且验收者整个程序内不实现任何任务；对抗评审结论只能由 Lead 采纳或驳回，不能由实现者自评关闭。Lead 冻结的含义：spec 一经开波不再改；实现中发现 spec 错，停下报 Lead，Lead 改 spec 并重新开该任务。

档位分配原则：碰账本写事务、会话控制器、工具面、租约与对账的任务用 A 档；纯函数、模板、脚本用 B 档。具体到任务见 TASKS.md。

## 8 风险、回退点与不可逆步骤

| 风险 | 触发信号 | 回退点 |
| --- | --- | --- |
| S1 不成立：拿不到 agent 级 ctx，restrict 无法在桌子会话生效 | SPIKES S1 读数 | 改用全局 guard 按 `resolveRole(sessionId)` 拒绝 + 可见性降级声明（NEEDS-DECISION N3）；R2 的"可见工具集恰等于"读数降级为"执行工具集恰等于" |
| 同一 SQLite 文件双连接（InboxStore 与内核）写冲突 | `SQLITE_BUSY` 计数 > 0 | 内核写事务必须同步完成（`Ledger.open` 回调不得 await）；退到共用 InboxStore 连接 |
| 真实流量稀少，shadow 读数攒不够（F32：21 小时 19 条） | DONE-6 的 `intake_shadow` 72 小时内 < 30 | 延长 shadow 期，不降低门槛 |
| external-session 未提交改动与 `package.json`/`presets/` 冲突 | `git status` 显示这些文件仍有未提交改动 | T20 预设子项推迟；桌子先用 D8 回退形态（`standard` + 静态 section） |
| 运行时 0.2.1-rc.5 与依赖面 0.2.0-rc.2 类型漂移 | spike 中真实 API 与 d.ts 不一致 | 以本仓 d.ts 为编译面，运行期能力用 optional 探测；差异记入 SPIKES 读数 |

不可逆或对外、需要老板授权的步骤（本方案不自行执行）：

1. 把开关切到 `superagent`（接管真实消息的回复）：对外发言，需老板一句话授权；默认不切。
2. 用户重启 DSH 服务（3080）使新服务域生效：由用户执行；重启前须备份 `$DSH_HOME/lark-inbox/inbox.sqlite`（新增 `owner` 列与 `sa_` 表是原地迁移）。
3. 给飞书应用开读消息历史权限（P6，第二声音与送达回读）：改应用权限面，需老板在飞书后台操作。
4. 授予 `steer_foreign`、`write_repo`（尤其 dsh-cove 公开仓库）等 mandate：只能由老板经配置给出（`04` 授权是不可变记录）。
5. 退役 `responder.ts` 与 `reply-machine.ts` 判断部分：前提是 T29 的迁移账本全部等价且接管运行稳定，需老板授权后另开任务。

可逆、无需授权的动作（Lead 直接做）：本地提交到 `dev`、切 `shadow`（不发送任何消息，配置一改即回）、重跑门禁、把废弃产物移到 `*.retired/`。
