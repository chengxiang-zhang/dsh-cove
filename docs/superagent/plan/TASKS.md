# 任务表（TASKS）

> 适用性：本文属于 2026-11-05 原实施批次，保留既有记录，不是当前目标设计的施工依据。2026-11-09 用户授权重整需求后，与[当前设计](../README.md)、[需求基线](../01-需求基线.md)冲突的冻结、任务、默认裁定与 DONE 判据不再有效；新实现需重新规划并按[验收与评估](../13-验收与评估.md)验证。

30 个任务、9 个实现波（W0 是 spike，见 [SPIKES.md](SPIKES.md)）。每个任务 = 一个模块切片，新代码量估计 ≤ 800 行。记号（`SA`、`TS`、`FX`、`VT`、`TC`、`DEPS`、G1–G6）见 [spec/T-00-conventions.md](spec/T-00-conventions.md)；每个任务除下列专属验收外都必须通过 G1–G6。

档位：A = Opus 5.5 high（账本写事务、会话控制器、工具面、租约、对账、搬家与组合根）；B = Sonnet 5.5 high（纯函数、模板、脚本、读数）。验收者 V1、V2 全程不实现任何任务；R1 是对抗评审。

## 总表

| id | 标题 | 波 | 依赖 | spec | 档位 | 实现 | 验收 | 规模（新行） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T01 | 协议类型、内核端口、宿主端口、测试夹具、依赖围栏 | W1 | W0 | [T-01](spec/T-01-protocol.md) | A | I1 | V1 | 450 |
| T02 | lark-inbox 搬进 `channels/feishu`，挂载名换 superagent | W1 | W0 | [T-02](spec/T-02-channel.md) | A | I2 | V2 | 150（以移动为主） |
| T03 | `superagent-check.mjs` 骨架与退出码 | W1 | W0 | [T-03](spec/T-03-check-script.md) | B | I3 | V2 | 200 |
| T04 | 协议 DDL、迁移、启动自检（25 张 `sa_` 表 + owner 列） | W2 | T01 | [T-01](spec/T-01-protocol.md) | A | I1 | V1 + R1 | 600 |
| T05 | 世界模型纯函数：路径、授权判定、默认表、消歧 | W2 | T01 | [T-05](spec/T-05-world.md) | B | I2 | V2 | 350 |
| T06 | 规则引擎纯函数：谓词集、确定性解析、冲突检测 | W2 | T01 | [T-06](spec/T-06-rules.md) | B | I3 | V2 | 350 |
| T07 | 记忆可见域纯函数：canUse/canSay、字面兜底 | W2 | T01 | [T-07](spec/T-07-memory.md) | B | I4 | V2 | 250 |
| T08 | 内核账本 `Ledger` | W3 | T04 | [T-08](spec/T-08-kernel.md) | A | I1 | V1 | 500 |
| T09 | 判断快路径（`ClaimPolicy` 实现） | W3 | T01 | [T-09](spec/T-09-judgment.md) | B | I2 | V2 | 250 |
| T10 | 注意力、模板、词数、承诺词、时刻规则、`OutletPolicy` | W3 | T01 | [T-10](spec/T-10-timing-surface.md) | B | I3 | V2 | 450 |
| T11 | 案卷六段与 now 两层投影 | W3 | T01、T07 | [T-11](spec/T-11-desk.md) | B | I4 | V1 | 500 |
| T18 | 飞书通道契约、owner 认领钩子、union_id 回填 | W3 | T02、T04 | [T-02](spec/T-02-channel.md) | A | I5 | V2 | 450 |
| T12 | 内核认领 `claim`/`shadow` | W4 | T08 | [T-08](spec/T-08-kernel.md) | A | I1 | V1 + R1 | 350 |
| T13 | 内核时钟 `Clock` | W4 | T08 | [T-08](spec/T-08-kernel.md) | A | I2 | V1 | 250 |
| T14 | 内核出口与租约 `Outlet`/`Lease` | W4 | T08 | [T-08](spec/T-08-kernel.md) | A | I3 | V1 + R1 | 500 |
| T15 | 世界模型存储与适配器（config、ssh-config） | W4 | T05、T08 | [T-05](spec/T-05-world.md) | B | I4 | V2 | 500 |
| T16 | 记忆日志、五个抽取器、文档区 | W4 | T07、T08 | [T-07](spec/T-07-memory.md) | B | I5 | V2 | 650 |
| T17 | 规则注册、合并、回放、校准、自动度 | W5 | T06、T08 | [T-06](spec/T-06-rules.md) | B | I1 | V2 | 600 |
| T19 | 执行体画像、派发、追加输入、取消、止损 | W5 | T08、T15、S2、S4、S5 | [T-19](spec/T-19-executors.md) | A | I2 | V1 | 750 |
| T20 | 桌子单一在场、会话生命周期、工具面、look/remember/say | W5 | T08、T11、T12、T16、S1、S2 | [T-11](spec/T-11-desk.md) | A | I3 | V1 + R1 | 780 |
| T24 | 命令与路由族、`superagent-cmd.mjs` | W5 | T08、T10、T16 | [T-10](spec/T-10-timing-surface.md) | B | I4 | V2 | 450 |
| T21 | 判断：judge、六道闸事实、pushback | W6 | T09、T12、T15、T16、T17、T19 | [T-09](spec/T-09-judgment.md) | A | I1 | V2 + R1 | 600 |
| T22 | 执行体结案、升级、观察器、清扫 | W6 | T19、S4 | [T-19](spec/T-19-executors.md) | A | I2 | V1 | 700 |
| T28 | `superagent-check.mjs` 全量判据与七步链 | W6 | T03、T04 | [T-03](spec/T-03-check-script.md) | B | I3 | V2 | 700 |
| T23 | 议程四来源、简报、投机、防空跑 | W7 | T10、T13、T17 | [T-10](spec/T-10-timing-surface.md) | B | I1 | V2 | 650 |
| T25 | 恢复：启动顺序、tick 对账、租约守护、降级、第二声音、角色解析 | W7 | T13、T14、T19、T20、T22 | [T-25](spec/T-25-recovery.md) | A | I2 | V1 | 700 |
| T26 | 判断：commit/amend/release/propose 与快路径落地 | W7 | T21、T19、T22 | [T-09](spec/T-09-judgment.md) | A | I3 | V2 + R1 | 800 |
| T27 | 组合根装配与三档开关 | W8 | T12–T26、T28 | [T-27](spec/T-27-integration.md) | A | I1 | V1 + R1 | 600 |
| T29 | responder 用例迁移账本 | W8 | T14、T18、T21、T25、T26 | [T-27](spec/T-27-integration.md) | B | I2 | V2 | 500 |
| T30 | 七步链端到端、双语 README、交付报告 | W9 | T27、T28 | [T-27](spec/T-27-integration.md) | A | I1 | V1 + V2 | 600 |

波内并行度：W1=3、W2=4、W3=5、W4=5、W5=4、W6=3、W7=3、W8=2、W9=1。W8、W9 是集成尾部的串行点（组合根只能一个人写、端到端只能在组合根之后），并行度低是结构性的，不是排期问题。

## 逐任务

每条验收写成"命令 → 期望读数 → 负控（故意破坏什么，必须变红）"。

### W1

#### T01 协议类型、端口、夹具、依赖围栏

写域：`SA/protocol/objects.ts`、`SA/protocol/tools.ts`、`SA/protocol/events.ts`、`SA/kernel/ports.ts`、`SA/host-ports.ts`、`FX/manual-clock.ts`、`FX/fake-controller.ts`、`FX/fake-channel.ts`、`TS/superagent-protocol.spec.ts`、`TS/superagent-deps.spec.ts`

1. `VT tests/superagent-protocol.spec.ts` → passed=10、failed=0、退出码 0 → 删 `DISPOSITIONS` 的 `'route'`，第 1 条红、退出码 1。
2. `VT tests/superagent-deps.spec.ts` → passed=4、退出码 0 → 在 `SA/kernel/ports.ts` 加 `import type {} from '../desk/x.ts'`，第 1、2 条红。

#### T02 通道搬家与挂载改名

写域：`SA/channels/feishu/`、`SA/index.ts`、`packages/dsh-web-all/src/core/lark-inbox/config-shape.ts`、`packages/dsh-web-all/src/core/lark-inbox/reply-machine.ts`（第 17 行注释）、`packages/dsh-web-all/src/host/services/lark-inbox/`（删除）、`packages/dsh-web-all/src/host/services/index.ts`、`packages/dsh-web-all/src/host/services/notify/index.ts`、`TS/lark-inbox-`（只改 import）、`TS/capability-parity.manifest.json`、`TS/services-assembly.spec.ts`、`docs/native-capability-boundary.md`

1. `VT tests/lark-inbox-` → passed 与 W0 基线相同、failed=0 → 把 `REPLY_RECEIPT_EMOJI` 改成 `'OK'`，`lark-inbox-responder.spec.ts` 红。
2. `VT tests/capability-parity.spec.ts tests/services-assembly.spec.ts tests/notify.spec.ts` → failed=0 → manifest 不改名，parity 红。
3. `test -d packages/dsh-web-all/src/host/services/lark-inbox; echo $?` → `1` → 留一个旧文件，输出 `0`。
4. `grep -rn "superagent/channels" packages/dsh-web-all/src/host/services/notify` → 空输出 → notify 直接 import 通道 config，非空。
5. `F22` → `1` → 复制一行 `- id: web-all`，输出 `2`。

#### T03 检查脚本骨架

写域：`scripts/superagent-check.mjs`、`scripts/superagent-check.test.mjs`

1. `node --test scripts/superagent-check.test.mjs` → `# pass 7`、`# fail 0`、退出码 0 → IO 错的退出码写成 3，第 1 条红。
2. `node scripts/superagent-check.mjs --db /tmp/does-not-exist.sqlite; echo $?` → `2` → 同上破坏，输出 `3`。
3. `pnpm test:scripts` → 退出码 0 → 同上破坏，退出码非 0。

### W2

#### T04 DDL、迁移、自检

写域：`SA/protocol/db.ts`、`FX/memdb.ts`、`TS/superagent-db.spec.ts`

1. `VT tests/superagent-db.spec.ts` → passed=18、failed=0 → 去掉 `sa_outbox` 的 `words <= 100` CHECK，第 5 条红。
2. `VT tests/lark-inbox-inbound.spec.ts tests/lark-inbox-retention.spec.ts` → passed 与 W1 末相同、failed=0 → migrate 给 `inbox_events` 加无默认值的 `NOT NULL` 列，两个 spec 红。
3. `grep -nE "homedir|DSH_HOME|\.dsh/" packages/dsh-web-all/src/host/services/superagent/protocol/db.ts` → 空输出 → 在 db.ts 写 `join(homedir(), '.dsh')`，非空。

#### T05 世界模型纯函数

写域：`SA/world/paths.ts`、`SA/world/mandate.ts`、`SA/world/resolve.ts`、`SA/world/defaults.ts`、`TS/superagent-world-pure.spec.ts`

1. `VT tests/superagent-world-pure.spec.ts` → passed=12、failed=0 → 并列规则改成 allow 胜，第 4 条红。
2. `grep -rnE "Ledger|DatabaseSync|from '\.\./(kernel|desk|judgment)" packages/dsh-web-all/src/host/services/superagent/world/` → 空输出 → resolve.ts import kernel，非空且 DEPS 红。

#### T06 规则引擎纯函数

写域：`SA/rules/engine.ts`、`SA/rules/predicates.ts`、`SA/rules/conflict.ts`、`TS/superagent-rules-engine.spec.ts`

1. `VT tests/superagent-rules-engine.spec.ts` → passed=11、failed=0 → 层序改成 technique 最高，第 6 条红。

#### T07 记忆可见域纯函数

写域：`SA/memory/visibility.ts`、`SA/memory/disclose.ts`、`TS/superagent-memory-visibility.spec.ts`

1. `VT tests/superagent-memory-visibility.spec.ts` → passed=8、failed=0 → 最长公共子串阈值改成 13，第 4 条红。

### W3

#### T08 账本

写域：`SA/kernel/ledger.ts`、`FX/ledger.ts`、`TS/superagent-kernel-ledger.spec.ts`

1. `VT tests/superagent-kernel-ledger.spec.ts` → passed=12、failed=0 → 去掉 thenable 检查，第 2 条红。
2. G6 → 空输出 → 在 `SA/memory/log.ts` 写 `db.exec('BEGIN')`，非空。

#### T09 快路径

写域：`SA/judgment/route.ts`、`SA/judgment/route-rules.ts`、`TS/superagent-judgment-route.spec.ts`

1. `VT tests/superagent-judgment-route.spec.ts` → passed=10、failed=0 → 从范围变更标记删"顺便"，第 8 条红。

#### T10 注意力、模板、出口策略

写域：`SA/timing/attention.ts`、`SA/timing/outlet-policy.ts`、`SA/surface/templates.ts`、`SA/surface/words.ts`、`SA/surface/promise-scan.ts`、`SA/surface/moment.ts`、`TS/superagent-timing-policy.spec.ts`

1. `VT tests/superagent-timing-policy.spec.ts` → passed=13、failed=0 → 每日 interrupt 额度判断写成 `> 3`，第 3 条红。

#### T11 案卷与 now 投影

写域：`SA/desk/now.ts`、`SA/desk/dossier.ts`、`SA/desk/sections/`、`TS/superagent-desk-dossier.spec.ts`

1. `VT tests/superagent-desk-dossier.spec.ts` → passed=11、failed=0 → 把在办段放进可截断集合，第 6、7 条红。

#### T18 飞书通道契约

写域：`SA/channels/feishu/inbound.ts`、`SA/channels/feishu/send.ts`、`SA/channels/feishu/react.ts`、`SA/channels/feishu/audience.ts`、`SA/channels/feishu/channel.ts`、`SA/channels/feishu/index.ts`、`SA/channels/feishu/inbox-store.ts`、`TS/superagent-channel-feishu.spec.ts`

1. `VT tests/superagent-channel-feishu.spec.ts` → passed=10、failed=0 → 去掉 `pop` 的 owner 过滤，第 6 条红。
2. `VT tests/lark-inbox-` → passed 与 W1 末相同、failed=0 → admit 缺省时不 kick，`lark-inbox-responder.spec.ts` 红。
3. `grep -rnE "Ledger|sa_commitment|sa_intake" packages/dsh-web-all/src/host/services/superagent/channels` → 空输出 → inbound.ts 引用 `sa_intake`，非空。

### W4

#### T12 认领

写域：`SA/kernel/claim.ts`、`TS/superagent-kernel-claim.spec.ts`

1. `VT tests/superagent-kernel-claim.spec.ts` → passed=11、failed=0 → 去掉 CAS 条件 `AND owner IS NULL`，第 2、3 条红。

#### T13 时钟

写域：`SA/kernel/clock.ts`、`TS/superagent-kernel-clock.spec.ts`

1. `VT tests/superagent-kernel-clock.spec.ts` → passed=8、failed=0 → 无信号时也请求回合，第 2 条红。

#### T14 出口与租约

写域：`SA/kernel/outlet.ts`、`SA/kernel/lease.ts`、`TS/superagent-kernel-outlet.spec.ts`

1. `VT tests/superagent-kernel-outlet.spec.ts` → passed=12、failed=0 → flush 不校验 epoch，第 8 条红。
2. `grep -rnE "send\(|\.react\(" packages/dsh-web-all/src/host/services/superagent --include=*.ts | grep -vE 'kernel/outlet\.ts|channels/'` → 空输出 → 在 `SA/desk/` 直接调 `sender.send(`，非空。

#### T15 世界模型存储与适配器

写域：`SA/world/registry.ts`、`SA/world/place.ts`、`SA/world/adapters/`、`TS/superagent-world-registry.spec.ts`

1. `VT tests/superagent-world-registry.spec.ts` → passed=10、failed=0 → ssh-config 适配器走 `register` 而非 `propose`，第 1、2 条红。

#### T16 记忆日志、抽取器、文档区

写域：`SA/memory/log.ts`、`SA/memory/recall.ts`、`SA/memory/promote.ts`、`SA/memory/docs.ts`、`SA/memory/types/`、`TS/superagent-memory-log.spec.ts`

1. `VT tests/superagent-memory-log.spec.ts` → passed=13、failed=0 → `recall(speak)` 改用 canUse 过滤，第 4 条红。

### W5

#### T17 规则存储、回放、校准、自动度

写域：`SA/rules/registry.ts`、`SA/rules/replay.ts`、`SA/rules/calibration.ts`、`SA/rules/autonomy.ts`、`SA/rules/snapshot.ts`、`TS/superagent-rules-store.spec.ts`

1. `VT tests/superagent-rules-store.spec.ts` → passed=12、failed=0 → 回放门槛改成 `>= 0.10`，第 4 条红。

#### T19 执行体派发

写域：`SA/executors/profiles/`、`SA/executors/attempts.ts`、`SA/executors/budget.ts`、`SA/executors/events.ts`、`SA/executors/report-tool.ts`、`TS/superagent-executors-dispatch.spec.ts`

1. `VT tests/superagent-executors-dispatch.spec.ts` → passed=14、failed=0 → 派发失败直接 broken 不自愈，第 3 条红。
2. `grep -rnE "subagent_|selectModel" packages/dsh-web-all/src/host/services/superagent/executors` → 空输出 → 引入 `selectModel`，非空。

#### T20 桌子单一在场

写域：`SA/desk/presence.ts`、`SA/desk/turn.ts`、`SA/desk/toolface.ts`、`SA/desk/tools.ts`、`SA/desk/self-check.ts`、`TS/superagent-desk-presence.spec.ts`；预设子项（N15 解除后）：`packages/dsh-web-all/presets/superagent-desk.patch.yml`、`packages/dsh-web-all/presets/superagent-desk/`、`packages/dsh-web-all/package.json`

1. `VT tests/superagent-desk-presence.spec.ts` → passed=14、failed=0 → selfCheck 在工具数不等时仍 prompt，第 9 条红。
2. `pnpm test:scripts` → 退出码 0 → 把案卷写进 `systemPrompt.section` 的 text，system-prompt-audit 红。
3. `grep -rn "selectModel" packages/dsh-web-all/src/host/services/superagent` → 空输出 → 引入调用，非空。

#### T24 命令与路由族

写域：`SA/surface/commands/`、`SA/surface/routes.ts`、`scripts/superagent-cmd.mjs`、`TS/superagent-commands.spec.ts`、`docs/remote-access.md`

1. `VT tests/superagent-commands.spec.ts` → passed=8、failed=0 → 去掉路由的 `accessTrustOf` 调用，第 7 条红。
2. `pnpm test:scripts` → 退出码 0 → 同上破坏，`service-fence-contract` 静态门禁红。

### W6

#### T21 judge、六道闸事实、pushback

写域：`SA/judgment/judge.ts`、`SA/judgment/gates.ts`、`SA/judgment/pushback.ts`、`TS/superagent-judgment-judge.spec.ts`

1. `VT tests/superagent-judgment-judge.spec.ts` → passed=12、failed=0 → 去掉"线程有活承诺"校验，第 2 条红。

#### T22 结案、升级、观察器、清扫

写域：`SA/executors/closure.ts`、`SA/executors/escalate.ts`、`SA/executors/probes/`、`SA/executors/sweep.ts`、`TS/superagent-executors-closure.spec.ts`

1. `VT tests/superagent-executors-closure.spec.ts` → passed=13、failed=0 → command 判据只信报告不比对事件，第 3 条红。

#### T28 检查脚本全量

写域：`scripts/superagent-check.mjs`、`scripts/superagent-check.test.mjs`、`scripts/fixtures/superagent-check/`

1. `node --test scripts/superagent-check.test.mjs` → `# fail 0`、退出码 0 → 把 I3 期望从 0 改成 ≤1，I3 子用例红。
2. `node scripts/superagent-check.mjs --db scripts/fixtures/superagent-check/out/clean.sqlite; echo $?` → 输出含 `E1 ok` 至 `E7 ok`（E6 为 nodata）、退出码 0 → 换成 `bad-I2.sqlite`，退出码 1 且含 `I2 FAIL`。
3. `node scripts/superagent-check.mjs --db <空库>; echo $?` → `3` → —。

### W7

#### T23 议程、简报、投机、防空跑

写域：`SA/timing/agenda/`、`SA/timing/brief.ts`、`SA/timing/speculation.ts`、`SA/timing/idle-guard.ts`、`TS/superagent-timing-agenda.spec.ts`

1. `VT tests/superagent-timing-agenda.spec.ts` → passed=12、failed=0 → 停滞信号产生 interrupt 档，第 2 条红。

#### T25 恢复与降级

写域：`SA/recovery/`、`TS/superagent-recovery.spec.ts`

1. `VT tests/superagent-recovery.spec.ts` → passed=14、failed=0 → 对账只在 startup 调用，第 3、4 条红。

#### T26 交办与收放

写域：`SA/judgment/translate.ts`、`SA/judgment/dispatch.ts`、`SA/judgment/commit.ts`、`SA/judgment/amend-release.ts`、`SA/judgment/propose.ts`、`SA/judgment/fastpath-apply.ts`、`TS/superagent-judgment-commit.spec.ts`

1. `VT tests/superagent-judgment-commit.spec.ts` → passed=16、failed=0 → release 改为等下一轮 tick 再取消，第 11 条红。

### W8

#### T27 组合根

写域：`SA/index.ts`、`SA/config.ts`、`SA/channels/feishu/admin/config.ts`、`TS/superagent-assembly.spec.ts`

1. `VT tests/superagent-assembly.spec.ts` → passed=9、failed=0 → 在 `recovery.startup` 完成前打开 admit，第 6 条红。
2. `pnpm --filter @dsh-cove/dsh-web-all test` → failed=0、退出码 0 → —。
3. `F22` → `1` → 复制一行 `- id: web-all`，输出 `2` 且 parity 红。

#### T29 responder 用例迁移账本

写域：`TS/superagent-parity.manifest.json`、`TS/superagent-parity.spec.ts`、`TS/superagent-parity-`

1. `VT tests/superagent-parity.spec.ts tests/superagent-parity-` → failed=0、日志含 `parity migrated=<y>/<y>` → 在 `lark-inbox-steer.spec.ts` 新增一个用例而不登记，第 1 条红。

### W9

#### T30 七步链端到端与交付

写域：`TS/superagent-e2e-seven-step.spec.ts`、`FX/scripted-agent.ts`、`packages/dsh-web-all/README.md`、`packages/dsh-web-all/README.zh.md`、`packages/dsh-web-all/README.i18n.yaml`

1. `VT tests/superagent-e2e-seven-step.spec.ts` → passed=7、failed=0 → 快路径停止词表删"停"，第 5 条红。
2. `pnpm typecheck && pnpm test && pnpm docs:check && pnpm test:scripts` → 四个退出码均为 0 → 只改 README 一侧不 `docs:write-pair`，`docs:check` 红。
3. 交付报告 → 含"需要用户重启 DSH 服务后生效"、默认档 responder、切 shadow 的配置键、DONE-6 复核命令 → 缺任一项不收。
