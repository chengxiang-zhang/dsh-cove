# 第 0 天 spike

对应 `11-恢复与降级` 的"第 0 天必须先测的五件事"与 `01 §H` 的 P1–P5。五项全部给出"成立/不成立"读数之前，不许开 W1。不成立时按本文"不成立时"一栏改设计或执行 NEEDS-DECISION 的默认动作，改完再开 W1。

## 共同约束

- 不碰正在运行的 DSH 服务（3080）、不复用它的 `$DSH_HOME`、不占它的端口。所有 spike 在临时家目录里跑：`export DSH_HOME=/tmp/sa-spike/home`。
- 临时家目录里不配置飞书凭据：lark-inbox 网关因此不启动，杜绝第二个声音（F34）。spike 0 的第一条命令就是验证这一点。
- spike 代码不进仓库、不进 `packages/**`：放在 `~/.dsh/superagent-spikes/`（仓库外），以本地插件包形式装进临时 profile。
- 编译面用本仓 `node_modules/@deepseek-ai/*` 的 d.ts（0.2.0-rc.2），运行面是本机 `dsh`（读数 `dsh --version` = `0.2.1-rc.5`）。两者不一致处一律记读数，不猜。
- 每个 spike 产出一个读数文件 `~/.dsh/superagent-spikes/out/S<n>.json`，字段 `{ spike, verdict: 'holds'|'fails', readings: {...}, ran_at }`；Lead 把 verdict 与关键读数抄进对应任务的 spec "前置读数"一节。
- 回退点：删除 `/tmp/sa-spike/` 与 `~/.dsh/superagent-spikes/` 即完全回退，不留任何仓库改动。

## S0 隔离自检（所有 spike 的前置）

| 项 | 内容 |
| --- | --- |
| 命令 | `DSH_HOME=/tmp/sa-spike/home dsh --profile web --dump-config \| grep -c lark-inbox` 与 `ls /tmp/sa-spike/home/lark-inbox/inbox.sqlite 2>/dev/null \| wc -l` |
| 成立判据 | 临时 profile 可组合（退出码 0）；临时家目录下不存在 `inbox.sqlite`（输出 `0`）；`lsof -iTCP:3080 -sTCP:LISTEN` 的 PID 在 spike 前后相同 |
| 不成立时 | 停止全部 spike，报 Lead；不得退而在真实 `$DSH_HOME` 下做 |

## S1 桌子工具面：restrict + scoped 注册 + guard 能否在一个会话上生效（P5、R2、F9–F11、F30）

怎么测：

1. 进程内（不需要宿主）：在 `~/.dsh/superagent-spikes/s1/inproc.test.mjs` 里用本仓 `node_modules` 的 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-scope` 构造一个工具注册表，注册三个全局工具（`ssh_exec`、`lark_inbox_reply`、`noop_read`），`createScope(ctx, key)` 得到 scoped ctx，在其上 `restrict({ allow: [] })`、scoped 注册 `judge`、`guard(exec => exec.name === 'judge' ? undefined : 'desk-has-no-such-tool')`。读 scoped 视图的可见工具名集合；对 `ssh_exec` 发起执行。命令：`node --test ~/.dsh/superagent-spikes/s1/inproc.test.mjs`。
2. 真实会话：spike 插件 `s1-plugin` 在插件行上订阅 agent 创建类事件（以 d.ts 中 `@deepseek-ai/dsh-agent` 暴露的事件为准），对 sessionId 前缀为 `sa-desk-` 的 agent 拿到其 scope 并施加第 1 步的三件套；用 `DSH_HOME=/tmp/sa-spike/home dsh headless --profile sa-spike "列出你能调用的全部工具名，然后尝试调用 ssh_exec"`，从会话持久化文件读 `request/header` 里的工具清单与 `tool/result`。
3. 兜底探测：同一插件再装一个全局 `guard`，读 `execution.agent` 上的会话 id（`ToolExecutionInput.agent` 字段，d.ts 已有），断言能据此区分桌子会话与普通会话。

成立判据（三条全中）：

- 第 1 步可见集合恰为 `["judge"]`；`ssh_exec` 执行返回拒绝串 `desk-has-no-such-tool`。
- 第 2 步 `request/header` 的工具清单恰为 `["judge"]`，且 `ssh_exec` 调用以拒绝结束，会话里无 `ssh_exec` 的成功 `tool/result`。
- 第 3 步全局 guard 能读到会话 id，桌子会话拒、普通会话放行。

不成立时：

- 只有第 2 步不成立（拿不到 agent 级 scope）：执行 NEEDS-DECISION N3 默认动作——可见性靠专用预设声明 + 全局 guard 按 `resolveRole(sessionId)` 拒绝；`R2` 读数从"可见工具集恰等于"降为"执行成功的工具集恰等于"；改 T20 spec 的"工具面"一节。
- 第 3 步也不成立：R2 无机械保证，T20 不开工，报老板（这是 R2 锁定需求的前提，不能降级）。

## S2 执行体画像：按预设建会话与 provider/model/effort 实际可用集合（P1、P2，按 D7 重述）

D7 已裁定不用 subagent 派活，所以 P1 的"按预设起 subagent"改为验证"按预设起普通会话"（NEEDS-DECISION N4）。

怎么测：

1. `DSH_HOME=/tmp/sa-spike/home dsh --profile web --port 0 --no-open` 起临时实例（OS 选端口，读启动日志得到端口），spike 插件 `s2-plugin` 取 `sessionController`，`create({ sessionId: 'sa-x-spike-1', cwd: '/tmp/sa-spike/seat-a', agentPreset: 'standard' })`，再 `prompt({ mode: 'queue', ... })` 一句"回答 1+1"。
2. 两种选模型方式各测一次：(a) F8 按目录覆盖：给 `/tmp/sa-spike/seat-a` 写工作区模型预设；(b) 按会话覆盖：插件在 `agent/request` waterfall 上按 `payload.agent.session` 的 id 改 `provider/model/reasoningEffort`（NEEDS-DECISION N5 的推断方案）。
3. 读会话持久化里每个 `request/header` 的 provider/model/effort；同时读全局默认模型配置在 spike 前后的值。
4. 枚举本机配置可用的 provider/model 组合：读临时 profile 的 `--dump-config` 输出。

成立判据：

- 带 `agentPreset: 'standard'` 的 create 返回 sessionId 且首个回合 `turn/end.reason.kind = 'completed'`。
- (a) 或 (b) 至少一种使 `request/header` 的 model 等于设定值；全局默认模型 spike 前后不变（F14 的反面）。
- 可用组合清单非空，写入读数文件，供 T19 的画像表引用。

不成立时：

- (a)(b) 都不成立：R10 的"决定执行体与模型"降为"只决定执行体画像，模型随全局默认"，T19 画像表的 model 字段改为只记账；报老板（R10 锁定，属需求级降级）。
- 只有 (b) 成立：执行 N5 默认（按会话覆盖），T19 不用 F8。
- 只有 (a) 成立：T19 为每个画像预建座席目录并写一次工作区预设，durable 工作目录必须落在可被预设覆盖的目录下；改 T19 spec。

## S3 身份：从 payload.raw 回填 union_id 后四类身份判定是否稳定（F17、G6）

怎么测：只读真实库的副本，不读不写原库。

1. `cp $HOME/.dsh/lark-inbox/inbox.sqlite /tmp/sa-spike/inbox-copy.sqlite`（WAL 模式下先 `sqlite3 原库 '.backup /tmp/sa-spike/inbox-copy.sqlite'`，`.backup` 是只读操作）。
2. `node ~/.dsh/superagent-spikes/s3/union.mjs /tmp/sa-spike/inbox-copy.sqlite`：对 `inbox_events` 每行解析 `payload`（信封 JSON）→ `raw` → 取 `event.sender.sender_id.union_id` 与 `open_id`；统计 `rows`、`with_union_id`、`distinct_open_id`、`distinct_union_id`、`open_ids_per_union_id` 的最大值。
3. 把 `allowedOpenIds`（`lark-inbox` 设置）映射到 union_id，检查每个 owner open_id 是否都能映射到恰一个 union_id。

成立判据：`with_union_id / rows = 1.00`（或缺失行全部是非 `im.message.receive_v1` 事件）；每个 open_id 映射到恰 1 个 union_id；owner 对应的 union_id 恰 1 个。

不成立时：

- 有消息事件缺 union_id：T18 入站回填对缺失行写 `party` 时以 `open_id` 作临时键并标 `identity_weak=1`（写进 `party.manifest` JSON，不改协议），授权判定对弱身份一律按"群内其他人"处理；改 T15/T18 spec。
- 一个 open_id 对多个 union_id：停止，报老板（身份模型前提不成立）。

## S4 会话事件：回合结束原因、回合计数、工具调用能否从事件流读出（P4、F2、G1、G4）

怎么测：沿用 S2 的临时实例与会话。

1. 让执行体会话跑两回合：第一回合"运行 `echo sa-spike-42; exit 3`"（触发一次 shell 工具调用与非零退出），第二回合"再说一句 ok"。
2. 第二回合中途 `cancel({ sessionId })`。
3. `inspect(sessionId)` 读全部事件，统计 `turn/start` 数、`turn/end` 数与每个 `reason.kind`、`tool/call` 的工具名与参数形状、`tool/result` 中退出码字段的位置。
4. 同时用插件行 `ctx.on('session/event', (session, event) => ...)` 实时记录同一批事件，比对两路是否一致。

成立判据：

- `turn/end` 数 = 2，`reason.kind` 依次为 `completed`、`aborted`（取值集合与本仓 d.ts `TurnEndReasonMap` 的 7 个键一致或为其子集）。
- 能定位到 `echo sa-spike-42` 的 `tool/call` 与其 `tool/result` 中的退出码 3；把字段路径写入读数（T22 结案判定的证据比对按此路径实现）。
- 实时事件与 `inspect` 事件的 `turn/end` 数一致。

不成立时：

- 读不到退出码：G1 的 command 判据降为"命令字符串匹配 + 执行体自报退出码"，结案只能到 `unverified` 而非 `fulfilled`（宁可少报完成）；改 T22 spec。
- 读不到回合计数：G4 的回合止损改为按 `turn/start` 事件在宿主侧自计数；改 T19 spec。

## S5 追加输入：运行中会话能否被送入新输入而不打断当前回合；空闲会话 prompt(queue) 能否起新回合（P4、F1、F3、G3、R19、R23）

怎么测：沿用 S2 的临时实例。

1. 运行中：给执行体一个耗时回合（"每 5 秒运行一次 `date`，共 6 次"），第 2 次工具调用之后 `prompt({ mode: 'steer', requestId: 'sa-in-1', ... })` 送"顺便输出 marker-7"。
2. 运行中 queue：同样场景改用 `mode: 'queue'`，`requestId: 'sa-in-2'`。
3. 空闲：回合结束后 `prompt({ mode: 'queue', requestId: 'sa-in-3' })`。
4. 对每个 requestId 读：该输入出现在哪个回合（第几个 `turn/start` 之后的用户消息）、原回合是否以 `completed` 结束、是否出现 `session/steer-unavailable` 类事件（d.ts 已有该名）。

成立判据：

- 第 1 步：原回合 `turn/end.reason.kind = 'completed'`（未被打断），marker-7 出现在该回合内的输出；`sa-in-1` 可定位到消费它的回合号。
- 第 3 步：`sa-in-3` 起了一个新回合，回合号 = 上一个 + 1。
- 第 2 步的读数只记录（queue 在运行中的语义写入读数，供 T19 选择）。

不成立时：

- steer 会打断回合：R23 的"同一执行体会话消费"改为"排队到下一回合消费"——运行中一律 `queue`，`consumed_turn` = 下一回合号；结案判定在有未消费输入时不结案（`10` 已有此规则），改 T19 spec。
- 空闲 queue 起不了新回合：durable 续接改为"同一承诺新开尝试并带前情"（`08` 第三判断第 4 条的前情续接），改 T19 spec。

## 非阻塞项（不挡 W1，挡对应任务）

| 项 | 挡哪个任务 | 怎么测 | 不成立时 |
| --- | --- | --- | --- |
| P3 外部 provider 只能 one-shot（F6） | T19 的降级档 | 读 `external-session` 适配器实现与其测试，不运行 | 不把外部 provider 列入画像表 |
| P6 读消息历史权限 | T26 第二声音 | 用真实应用凭据做只读调用前需老板授权（PLAN 第 8 节第 3 条）；授权前只做 d.ts 与 SDK 方法存在性检查 | 执行 NEEDS-DECISION N17 默认：第二声音降级为不可用，写一行 `degrade_event` |
