# T-25 恢复与降级（T25）

> 适用性：本文属于 2026-11-05 原实施批次，保留既有记录，不是当前目标设计的施工依据。2026-11-09 用户授权重整需求后，与[当前设计](../../README.md)、[需求基线](../../01-需求基线.md)冲突的冻结、任务、默认裁定与 DONE 判据不再有效；新实现需重新规划并按[验收与评估](../../13-验收与评估.md)验证。

设计依据：`11-恢复与降级`（五条不变量 I1–I5、固定启动顺序、tick 拉式对账五步、热更自检 fail-closed、租约与第二个声音、失败隔离、降级矩阵、契约五方法、读数）。需求：G5、G9、B14。事实：F20、F34、P6。

写域：`SA/recovery/startup.ts`、`SA/recovery/reconcile.ts`、`SA/recovery/lease-keeper.ts`、`SA/recovery/degrade.ts`、`SA/recovery/second-voice.ts`、`SA/recovery/roles.ts`、`SA/recovery/checks/index.ts`、`TS/superagent-recovery.spec.ts`。依赖：T13、T14、T19、T20、T22。

## 契约（`11` 契约，加角色解析器）

```ts
export interface Recovery {
  startup(): Promise<{ leaseHeld: boolean; reconciled: { orphaned: number; closed: number; healed: number }; degraded: string[] }>
  reconcile(now: number): Promise<{ orphaned: number; closed: number; healed: number }>   // 每轮 tick 都调用
  selfCheck(deskId: string): Promise<'ok' | 'fail-closed'>                              // 委托 T20 self-check
  secondVoice(eventId: string): Promise<{ detected: boolean; expected: number; observed: number } | { unavailable: true }>
  degrade(reason: string, scope: string): string                                        // 写 degrade_event，返回 degrade_id；同 reason+scope 未结束时不重复写
  recover(reason: string, scope: string): void                                          // 置 ended_at
}
export function resolveRole(sessionId: string, deps: { isBotSession(id: string): boolean; desk: Presence; executors: Executors }):
  'bot' | `desk:${string}` | `executor:${string}` | undefined
// 11 角色解析器：保留现有 isBotSession 的读取点（F20，feishu/bot-sessions.ts）不动，superagent 的两类角色从账本可重建
export interface RecoveryCheck { name: string; check(now: number): Promise<Finding[]> }  // recovery/checks/<name>.ts，注册一行；只读
export function createRecovery(deps: { ledger: Ledger; lease: Lease; holder: string; clock: HostClock; log: HostLog;
  controller: () => SessionControllerFace; executors: Executors; closure: Closure; escalation: Escalation; presence: Presence;
  channelHistory?: (chatId: string, limit: number) => Promise<HistoryRow[]>; outlet: Outlet }): Recovery
```

## 启动顺序（固定，`11`）

`openLedgerDb`（建表/迁移，T04）→ `lease.acquire` → 注册角色解析器 → `reconcile(now)` → 对全部存量桌子 `selfCheck`（不过的桌子不启用）→ 返回，组合根此后才接新触发（通道 admit、时钟 start）。抢不到租约：继续启动，但出口只判断不发送（等价 shadow），写 `degrade_event(reason='lease_not_held')`，status 标出持有者。

`lease-keeper`：每 15 秒 `heartbeat`；连续失败或被抢 → `degrade('lease_lost','outlet')`；重新抢到 → `recover`。

## 对账（tick 拉式，`11` 五步）

1. 扫 running 尝试：`last_tool_at` 或最后事件时间超过 10 分钟，或事件流异常 → `inspect(session_id)`。
2. 会话不存在 → 尝试 `ended(end_reason='orphaned', cancel_origin='reconcile')`（N6）；未超重派次数 → `escalation.escalate(..., 'interrupted')` 自动重派，完成后简报一行（幂等键 `orphan:<commitment_id>:<attempt_id>`，读数 V-orphan-dup）；只有重派会覆盖未提交改动（工作目录有未提交改动）或需要新授权 → 一条 asked 假设，默认"不回 = 保留现场不重派"，此时承诺 `orphaned`；超次数 → broken。
3. 会话存在且最后回合已结束 → `closure.close(...)` 补结案。
4. 会话存在且还在跑 → 不动。
5. 桌面会话对应关系对不上（desk.session_id 指向不存在的会话）→ `presence.rotate(deskId,'manual')` 并从账本重建。

对账只标不杀：步骤 2 之前必须先 `inspect`；标孤儿后在下一轮复核一次才重派（防误杀，`11` 失败模式）。`I3`：账本里没有的执行体会话（`sa-x-` 前缀但无 attempt 行）一律 `cancel`。

## 第二个声音（`11`，P6）

每次 reply 档出站成功后 30 秒调用 `secondVoice(eventId)`：读该会话最近 20 条消息，统计本应用发出的、回复同一条入站的条数；大于本库 `outbox` 该 event_id 的 sent 条数 → `detected=true`，经出口提一次 `moment='alert'`（不可逆风险类，可破静默），`degrade('second_voice','<app>')`。`channelHistory` 未注入或 reject `HISTORY_UNAVAILABLE` → 返回 `{ unavailable: true }`，启动时写一次 `degrade_event(reason='second_voice_unavailable')`，不打断老板（N17）。

## 降级矩阵的机械形态

| 情况 | 本任务的处置 |
| --- | --- |
| 模型不可用（桌子回合 end_reason=error 连续 3 次） | `degrade('model_unavailable','desk')`；桌子回合按退避重排（1、2、4…分钟，封顶 10 分钟）；恢复后 `recover`；超 10 分钟由简报带一行 |
| 发送持续失败 | 出口已处理（T14）；本任务只在 `failed` 计数 > 0 时 `degrade('send_failing','feishu')` |
| SQLite 锁死（写入抛 `SQLITE_BUSY` 连续 3 次） | `degrade('ledger_readonly','kernel')`：停止 claim（通道回退给 responder）、停止回合，只读命令可用 |
| 热更后工具面不对 | `selfCheck` fail-closed（T20） |
| 磁盘/目录异常（工作目录创建失败） | `degrade('workspace_failed','executors')`：停止派新 durable 活 |

降级只减少能力，不制造错误：任何不确定路径选择闭嘴或排队。

## 单测清单（`TS/superagent-recovery.spec.ts`，fixture：`FX/ledger.ts`、`FX/fake-controller.ts`、`FX/fake-channel.ts`、`FX/manual-clock.ts`、T19/T20/T22 真实实现）

1. 启动顺序：用调用记录断言 `acquire` 在 `reconcile` 之前、`reconcile` 在 `selfCheck` 之前、`selfCheck` 在返回之前。
2. 抢不到租约：`leaseHeld=false`，`degrade_event` 一行 `lease_not_held`，出口 submit 返回 `NO_LEASE`。
3. 重启对账：库里 2 件 running（会话一个在、一个不在）→ 不在的尝试 ended(orphaned) 且下一轮复核后自动重派（新 attempt）；在的保持；简报行幂等键唯一。
4. 第一轮发现会话不存在时不立即重派（只标），第二轮复核仍不存在才重派。
5. 会话在且最后回合已结束 → 补结案（closure 被调用 1 次）。
6. 工作目录有未提交改动的孤儿 → 承诺 orphaned + 一条 asked 假设（默认保留现场），不重派。
7. 账本外的 `sa-x-` 会话被 cancel（I3）。
8. 重启前后"在办集合"查询（`11` 读数第一条）diff 为空（同一库、模拟进程重启 = 重建全部对象）。
9. 存量桌子 selfCheck 不过 → 该桌不启用、degrade_event 一行；其他桌照常。
10. secondVoice：history 返回 2 条本应用回复而 outbox 记 1 条 → detected 且 alert 提案 1 条；history 未注入 → unavailable 且 degrade 一行，无出站。
11. 心跳：手动时钟推进 61 秒无心跳 → 另一 holder 可抢；本 holder 下一次心跳返回 false 并写 `lease_lost`。
12. `degrade` 同 reason+scope 重复调用只写一行；`recover` 置 ended_at。
13. `resolveRole`：bot 会话返回 'bot'（经 isBotSession）；桌子与执行体会话按前缀与账本返回；未知返回 undefined。
14. 孤儿类提问计数：步骤 2 的普通孤儿（无未提交改动）产生的 asked 假设 = 0（G5 读数"孤儿类提问 = 0"）。

## 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-recovery.spec.ts` | passed=14，failed=0，退出码 0 | 把对账改为只在 startup 调用（tick 不调）→ 第 3、4 条红 |
| 测试内读数：`SELECT count(*) FROM commitment WHERE state='orphaned' AND closed_at IS NULL` | 0 | — |
| 测试内读数：`SELECT commitment_id, count(*) FROM outbox WHERE idem_key LIKE 'orphan:%' GROUP BY 1 HAVING count(*)>1` | 空 | 简报行不用幂等键 → 非空 |
| G1–G6 | 见 T-00 | 见 T-00 |
