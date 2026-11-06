# 冻结记录（Lead 判决）

本文件是 Lead 对 [PLAN.md](PLAN.md) 的冻结与偏离记录，属程序控制文件，不由实现者改写。冻结后 spec 不再改；实现中发现 spec 错，停下报 Lead，由 Lead 在此追加一条并重开该任务。

## 冻结

- 冻结日：2026-11-05。冻结对象：`PLAN.md`、`TASKS.md`、`SPIKES.md`、`spec/T-*.md`（18 个文件，2572 行），以及 `docs/superagent/00`–`11` 设计本体。
- 执行方式：Agent Team + subagent。Lead 不实现任何任务，只开波、复跑波退出判据、合入、写本文件。
- 验收纪律：maker≠grader。每个任务的验收者在 `TASKS.md` 指定，且验收者整个程序内不实现任何任务。负控必须真变红再恢复。

## 三处偏离（与本机既有硬规则冲突，以既有规则为准）

### 偏离一：不使用 git worktree（覆盖 PLAN §6 与 §7）

`PLAN.md` 第 100 行要求"每个实现者在独立 git worktree 里工作"。本机规则禁止任何仓、任何场景使用 `git worktree`：worktree 与主树共享 `.git` admin 面却不带主树未提交文件，其红绿与交付态不一致（假红/空跑）；并行写入改为「同一 checkout 本体 + 分支 + 写域划分 + 串行合入」。

替代做法：

- 并行写者一律在主 checkout 本体工作，开工前在任务里声明写域（文件/目录前缀），同一波写域两两不相交；重叠即用依赖串起来。
- 门禁与验收只在主 checkout 本体跑；任何临时导出目录（`git archive`）里的红绿不作交付证据。
- 需要干净基线时用 `git archive HEAD | tar -x -C <临时目录>`，不建工作树。
- 基线先记：本文件落笔时 `git status --porcelain` 为 20 项（全部属 `external-session` 的在制改动，与 superagent 写域不相交，程序全程不碰、不回退、不提交）。

### 偏离二：W1 的三个任务不阻塞于 W0 spike（收窄 PLAN §4 的波闸）

`PLAN.md` 第 57 行的波闸是"spike 不过不许进 W1"。该闸的目的是保护运行时相关的实现（T19 依赖 S2/S4/S5，T20 依赖 S1/S2）。T01（协议类型与端口，纯 TS 声明）、T02（通道搬家，纯移动）、T03（check 脚本骨架）不读运行时，与之无依赖。

因此：W0 的 S0–S5 与 T01 并行开工；T19 在 S2/S4/S5 有读数前不开工；T20 在 S1 有读数前不开工。其余波闸不变。

### 偏离三：桌面专用预设推迟（对应 NEEDS-DECISION N15）

`presets/` 与 `package.json` 处于 external-session 在制改动内。T20 的预设子项推迟到该批改动由用户提交之后；在此之前桌子用设计 `01 §F D8` 自带的回退形态（`standard` 预设 + 静态 section 注入）。T20 其余部分照常。

## NEEDS-DECISION 处置

标"Lead"的按默认执行（N2、N4、N6、N8、N9、N10、N11、N13、N14、N17、N20、N21、N22、N23、N25、N26、N27、N29），不逐条复述。

标"老板"的十条，Lead 按下列口径先行执行，理由与回退点写在这里；老板一句话即可覆盖：

| 编号 | 采行口径 | 依据 | 回退点 |
| --- | --- | --- | --- |
| N1 | 止损到线按 `00` 的 B14（原话 23）自愈：有进展证据自动续一次，否则停并按升级规则处置；只有"停掉会丢不可恢复成果"才打断一次且带默认 | 原话高于需求基线文字（`README` 权威顺序） | 老板要"球回老板"即改 `at_risk` 出口 |
| N3 | 有条件采行：先由 S1 判定。S1 不成立才降级为"执行工具集恰等于桌面工具集"，并在交付报告单列 | 不赌结果，等读数 | S1 读数推翻即恢复 R2 原读数 |
| N5 | 采行：按会话 id 覆盖模型（`agent/request` 通道，从账本读映射，零持久写），不用 `selectModel`；S2(b) 不成立再退回 F8 按目录 | 每个 durable 尝试有独立目录，按目录覆盖等于每派一次活写一次配置 | 若污染全局默认即回退 |
| N7 | 采行：协议新增 `workspace` 对象（物理 `sa_workspace`），纯追加、有迁移、有回退（删表即回退），记入协议变更 | `04` 自己的读数依赖它，缺则 `04` 验收无从落地 | 老板否决即改 `04` 读数口径 |
| N12 | 采行门槛：72 小时内 `intake(shadow=1)` ≥ 30 行、抽检 10 条一致 ≥ 8、`shadow_outbox_rows=0`、owner 一致 100%；不满足延长 shadow，不降门槛 | 门槛必须可判定，否则 DONE-6 无法验收 | 老板可改数字 |
| N15 | 采行推迟口径（见偏离三） | 避免踩用户在制改动 | 改动提交后可立即补预设 |
| N16 | 采行：本轮 plan 保持未提交、不改 `docs/README.md`；W9 交付时由 Lead 把方案摘要转 Issue，`plan/` 转 `plan.retired/` | 仓库规则：实施期交接物进 Issue | 老板要求入库即入索引 |
| N18 | 采行：影子回合桌面工具一律只校验不落账，只写 `intake(shadow=1)` 与 `deliberation.rule_trace.shadow_ops` | 影子期若真 `commit` 就会与 responder 同时在真实仓库动手，违背 D3 并发 1 | 无（这是安全默认） |
| N19 | 采行：`words` = `Intl.Segmenter('zh',{granularity:'word'})` 的 `isWordLike` 段数，数字串计 1，出口校验与 check 脚本共用同一函数 | R5 的 ≤100 词必须单口径，否则读数差数倍 | 老板可改口径 |
| N24 | 采行：老板 `read` = allow；`write_repo`/`write_host`/`provision`/`steer_foreign`/`change_prod`/`publish`/`commit_promise` = draft，按路径级显式给才升 allow | 与 `04`"写必须显式给到路径级"一致 | 老板按路径放开即变 |
| N28 | 采行：命令在服务内实现，暴露为受 `accessTrustOf` 围栏保护的 `/superagent/commands/<name>` 路由族；`scripts/superagent-cmd.mjs` 只调本机路由并转出退出码 | 服务外进程不得写账本（P1） | 老板否决即只留服务内 |
| N30 | 采行：两种时序都实现并都验收（执行中追加走 `amend`；交付后追加开子承诺带前情），顶层承诺数仍为 1 | 七步链第 4 步排在交付之后，与"终态不可改"冲突，只能两种都成立 | 老板二选一即删另一条 |

## 不自行执行的不可逆步骤

沿用 `PLAN.md` 第 125–131 行：切 `superagent` 档接管真实回复、用户重启 DSH 服务、开飞书读历史权限、授予写类 mandate、退役 `responder.ts`/`reply-machine.ts`。

其中"切 shadow 档"不在其列：它不发送任何消息、配置一改即回，属可逆动作，由 Lead 在 DONE-6 阶段直接做并报读数。

## 进度摘要（每波收口时追加一行）

| 波 | 状态 | 读数 | 时间 |
| --- | --- | --- | --- |
| W0 | 完成 | S0 holds / S1 **fails**（见下）/ S2 holds / S3 holds(n=1) / S4 holds / S5 holds | 2026-11-05 23:46 |
| W1 | 完成 | T01 10+4、T02 174/174 + trio 75、T03 7；commits a877a56 / 2ee3444 | 2026-11-05 23:47 |
| W2 | 完成 | T04 18、T05 12、T06 11、T07 8；commit 50777f3 | 2026-11-05 23:47 |
| W3 | 完成 | T08 12、T09 10、T10 13、T11 11、T18 11；`tests/superagent-` 18 files / 200 passed | 2026-11-06 00:07 |
| W4 | 完成 | T12 11、T13 8、T14 12、T15 10、T16 13 | 2026-11-06 00:07 |
| W5 | 完成 | T17 12、T19 14、T20 14、T28 53 + 608；commit 4fbbe1d | 2026-11-06 00:40 |
| W6 | 完成 | T21 12、T22 13；commit 5a1d3c1 | 2026-11-06 01:10 |
| W7 | 完成 | T23 12、T24 8、T25 14、T26 16；commit 5a1d3c1 | 2026-11-06 01:10 |
| W8 | 完成 | T27 9（全包 1864 passed / 0 failed）、T29 6 断言（migrated 46/67，21 条缺口已逐条列出）；commit 6c1e2f0 | 2026-11-06 01:49 |
| W9 | 完成 | T30 7/7 七步链；全包 131 files / 1877 passed / 4 skipped；F22 = 1；线程键双重前缀已修 | 2026-11-06 01:49 |

DONE-1 四个命令（`pnpm typecheck` / `pnpm test` / `pnpm docs:check` / `pnpm test:scripts`）退出码全 0；DONE-2 七步链 7/7；DONE-3 账本检查脚本 exit 0 且 I1–I4 与 E1–E7 全 ok；DONE-4 F22 = 1；DONE-5 依赖边 4 passed。**DONE-6 待用户重启 DSH 服务并切 shadow 跑满 72 小时后复核**（命令 `node scripts/superagent-check.mjs --shadow --since-hours 72`，门槛见 N12）。

## W0 spike 的结论（比 SPIKES.md 原文更权威，实现按这里）

- **S1 fails，但原因不是拿不到 scope**：agent 级 ctx 拿到了、三件套生效；`subagent` 注册在**agent 面**，`restrict` 按设计只过滤继承来的工具（F10 被真实会话证实：31 个工具砍到只剩它）。所以"可见集恰等于 9 个桌面工具"不可达。
- **执行作用域由 `exec.agent` 决定，不由调用方 ctx 决定**：不带 agent 的宿主侧 `tools.execute` 走全局视图，`ssh_exec` 照跑。R2 的真实缺口。
- guard 能从 `ToolExecutionInput.agent` 读到会话 id，按会话拒绝成立。
- **S4**：退出码只有 `tool/result.data.message.content[*].text` 的 `[exit code: N]` 文本标记（无标记即 0），`isError` 非零退出仍为 false，不可当失败信号；`user/message` 无 turn 字段，`consumed_turn` 只能按 `turn/start…turn/end` 的 seq 区间算。
- **S2**：`create({agentPreset})` 可用且返回值带预设；按会话覆盖模型（`agent/request`）与按目录覆盖都生效，全局默认不变；`modelCatalog()` 的字段是 `groups`/`routableProviders`/`failures`。
- **S5**：运行中 steer 不打断原回合、queue 落到下一回合、空闲 queue 起新回合。
- **S3**：19/19 行可从 `raw.sender.sender_id.union_id` 回填（扁平形状；v2 包装在 `raw.event.sender.sender_id`），`user_id` 恒空不可作备用键；样本只有 1 个发送者与 1 个 app，属方向性。

## R2 现在的机械保证（T20 交付后的口径）

1. guard 兜底 + fail-closed 自检：桌子会话上非桌面工具一律拒；任意一次非桌面工具真执行成功，下一回合不发 prompt。
2. 禁止宿主侧裸调 `tools.execute`：源码扫描用例 + grep 门禁。
3. **仍靠提示词的一条**：agent 面的 `subagent` 不装，只能靠专用预设；`restrict` 过滤不到它。
4. **"案卷不进 system prompt"靠源码扫描**（`desk/` 出现 `systemPrompt.` 即红），不靠 `system-prompt-audit`：后者只拦字面 `{{…}}`，对动态文本空转。

## 已发生的 spec 修正（Lead 授权，均已提交）

- T-00 G6 白名单含 `channels/**`（`DatabaseSync` 与事务入口三处），账本不变量改由"只有 kernel 写 `sa_*`"承担（T08 运行时 + T28 静态）。
- T-00 F22 的 grep 改为 `grep -cE '^\s*- id:'`（原文会把注释数成 4）；G1 的类型错误退出码记为 1（pnpm 包装）或 2（直接 `tsc -b`）。
- T-01 的 T04 通过数 16 → 18；T-01 的 `TABLE_OWNERS` 注释改为 kernel 只拥有 intake/commitment/journal/outbox/lease/inbox_events(owner)，deliberation 归 desk、subscription 归 judgment（以 02 对象目录为准）。
- `kernel/ledger.ts` 追加三个具名方法：`touch`（I1 上限）、`recordOutbox`、`advanceSubscription`（passthrough 的 input_seq+1）、`patchCommitment`（只许 slot/used_*/extended/budget_* 六列）。
- `tx.run` 拒绝多语句（`MULTI_STATEMENT`）：此前 `INSERT …; DELETE …` 会静默丢掉尾句。

## 已知未决（不阻塞，但交付报告必须写）

- 退出码只能靠文本标记解析；若 provider 改文本，结案会退到 unverified。
- `promoteCandidates` 需要 owner 注入；记忆派生提示因协议无 `body_json` 列，到案卷只能是固定句。
- `world` 的 ssh 适配器把所有候选提议成 `netbird/<canonical>`，公网域名也会出现为候选（只影响噪声，人批时不选即可）。
- 真实工具面证据要等用户重启 DSH 服务后读一张桌子会话的 `request/header`。

## 独立对抗评审 R1（2026-11-06，只读，跨模型族）

verdict 初始为 **FAIL**：R1 用可复现 probe 打穿 3 条不变量并找出 12 处实现缺口 + 5 处设计缺口。逐条修复后（commit `fix(superagent): close the invariants the adversarial review broke`），六靶现状：

| 靶 | 初始 | 现在 |
| --- | --- | --- |
| P1 唯一写入者 | 突破（`opts.module ?? 'kernel'` 让 9 处非内核调用点拿到裸写权） | 守住（`module` 类型必填 + 运行期 `MODULE_REQUIRED`；27 处调用点已补） |
| P2 只追加 | 突破（`INSERT OR REPLACE` 绕过 BEFORE DELETE 触发器） | 守住（ledger 拒绝 REPLACE + `BEFORE INSERT` 触发器 + 裸句柄同样被拦） |
| I3 无主算力 | 突破（库级无"running 必须属未结案承诺"） | 守住（`updateAttempt` 校验 + 两道库级触发器） |
| 结案不信自述 | 突破（command 判据不比对 `done_when`，执行体自造证据即可结案） | 守住（判据必须命中 `done_when` 里的那条命令；`report` 不算证据；对不上判 unverified） |
| P3 幂等 | 守住 | 守住 |
| 状态机全部边 | 部分（终态边守住，非终态边只靠 `ledger.transition`） | 同左，列入未决 |

最严重的一个（已修）：`ledger.ts` 的 `active = true` 在 `BEGIN IMMEDIATE` 之前，一次 `SQLITE_BUSY` 之后账本在本进程内永久写死，只能重启——现在置位在 `BEGIN` 成功之后、`finally` 无条件复位。

设计层 5 条（B1–B5）已由 Lead 改文档：`10` 的 command 判据收紧为"必须是 `done_when` 里的那条命令"，`03` 的 owner 不变量排除影子行并写明"只有影子行"的中间态，`02` 的 attempt 止损线按 kind 分档，`02` 的 P3 注明 `message_id` 的唯一索引归通道 DDL。

## 最终验收读数（Lead 复跑，2026-11-06 02:22）

- `pnpm typecheck` → 退出码 0，error TS 0
- `pnpm test` → `shared` 4 files / 37 passed + `packages/dsh-web-all` 134 files / **1908 passed** / 4 skipped，退出码 0
- `pnpm docs:check` → all documentation gates passed
- `pnpm test:scripts` → **608 pass / 0 fail**
- `vitest run tests/superagent-` → 31 files / **343 passed**（`79ca1ed`，含 I3 竞态用例与两条围栏自检）
- `grep -cE '^\s*- id:' packages/dsh-web-all/cordis.patch.yml` → 1
- 七步链 e2e → 7/7

仍未验证（需真实实例）：真实工具面端口、执行体 report 工具的真实注册、按会话覆盖模型的真实生效、飞书真实发送；以及 DONE-6 的 72 小时影子期读数。

## 最终独立验收（V1，2026-11-06 02:38）

verdict **PASS-WITH-NITS**，判据对象 `e83c811`（干净树）：DONE-1..5 全部成立，DONE-2 连跑三次均 7/7，DONE-3 三档退出码 0/1/3（缺文件 2）全对，DONE-4 = 1，DONE-5 = 4 passed 且 kernel 无上行 import。报告在 `~/.dsh/superagent-verify/FINAL.md`。

四条 nit 的处置：
1. FREEZE 的读数过期（340 → 341、漏记 shared 4/37）——已按本节上面的数字改正。
2. **`superagent-deps.spec.ts` 会假绿**：`walk()` 在目录不存在时返回 `[]`，四条断言对空集恒真（把 `superagent/` 整体移走仍 4/4 绿）。已修（`79ca1ed`）：`walk` 缺目录抛 `refusing to scan nothing`，并加两条规模断言（实测 132 文件 / 515 条边，下限 >100 / >400）。负控：目录改名后整份 spec 以文件级错误红、退出码 1；边数下限抬到 1000 时第 5 条红。现在 6 passed。
3. `PLAN.md` 的 DONE-4 命令数注释——已改为 `grep -cE '^\s*- id:'`。
4. P1 的边界要说准（写入交付报告）：命名 `KernelTx` 方法对任何已声明 module 开放（`memory` 也能 `tx.append`/`tx.transition`），P1 的机械边界是"模块拿不到裸连接 + 裸 SQL 按声明 module 白名单"。

另有三条限制必须写进交付报告：`answer` 判据可只凭 summary 结案（设计如此）；七步链第 3 步本身不断言证据来自会话事件（来源校验在 `closure.ts` 与 hardening A11 的用例里）；三档开关没有设置页入口，只能改 profile 的 `lark-inbox` 命名空间。

## 交付后仍在册的两件事（都不阻塞交付，需用户或下一轮决定）

1. **DONE-6**：用户重启 DSH 服务 → 把 `lark-inbox.superagentMode` 切到 `shadow` → 跑满 72 小时 → `node scripts/superagent-check.mjs --shadow --since-hours 72` 退出码 0，且 `shadow_owner_mismatch=0`、`shadow_outbox_rows=0`、`intake_shadow>=30`。
2. **退役 `responder.ts` / `reply-machine.ts` 的判断部分**：账本已达 `accounted=67/67`（57 migrated + 10 not-applicable，0 retired），但 PLAN §8 把退役列为需老板授权的不可逆动作，且要求接管档稳定运行后再做。
3. **围栏只拦"整块消失"不拦"整块缺项"**：删掉一个模块（如 `timing/`）后文件数 132→~123 仍过。补法是加"模块覆盖断言"（对每个已存在模块断言其文件存在），属新增判据，留给下一轮。

## 事实修正：生效方式（2026-11-06 实测）

设计与方案里到处写着"新服务域进 bundle 后要用户重启才生效（F23）"。实测不成立：`pnpm build` 完成后约 11 秒，新服务域就在**已经在运行的**进程里起来了（证据：`sa_lease.created_at` = 09:01:16，`holder` = 当时的 pid 13918，而该进程启动于 11-05 21:25）。所以 `@dsh-cove/dsh-web-all` 的代码改动**不需要重启**，实体在 `lib/` 变化时自己重载；需要重启的只有 profile、`cordis.patch.yml` 与预设的改动。

同一次实测还确认了重启的正确做法与错误做法，已写进 [tools/dsh-launchd/README.md](../../../tools/dsh-launchd/README.md) 的 Restart 段：`kill` 不会把 LaunchDaemon 拉起来（`KeepAlive` 是 `SuccessfulExit: false`，SIGTERM 算成功退出），必须 `sudo launchctl kickstart -k system/ai.deepseek.dsh.web`。这次 `kill` 让本机入口断了 1 小时 33 分，是我执行方式错了。
