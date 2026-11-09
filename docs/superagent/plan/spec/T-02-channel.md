# T-02 飞书通道：搬家（T02）与通道契约（T18）

> 适用性：本文属于 2026-11-05 原实施批次，保留既有记录，不是当前目标设计的施工依据。2026-11-09 用户授权重整需求后，与[当前设计](../../README.md)、[需求基线](../../01-需求基线.md)冲突的冻结、任务、默认裁定与 DONE 判据不再有效；新实现需重新规划并按[验收与评估](../../13-验收与评估.md)验证。

设计依据：`03-内核`"通道：lark-inbox 并入 superagent"与"共存与接管"、`02-协议`通道契约与 `inbox_event.owner`、`11-恢复与降级`第二声音（只取 `history`）。事实：F16、F17、F19、F20、F22、F29、F33。

## T02 搬家：lark-inbox → `SA/channels/feishu/`，挂载名换成 superagent

目标：零行为变化地完成 README"代码布局"里的并入，并让组合根从第一天起只有一个服务域。

写域：

- `git mv packages/dsh-web-all/src/host/services/lark-inbox/{gateway,inbox-store,reply-store,responder,session-binding,tools,index}.ts SA/channels/feishu/`
- `git mv packages/dsh-web-all/src/host/services/lark-inbox/{audit,config,host-routes,responder-watchdog,wizard}.ts SA/channels/feishu/admin/`
- 新建 `SA/index.ts`（组合根骨架）、新建 `packages/dsh-web-all/src/core/lark-inbox/config-shape.ts`
- 修改：`packages/dsh-web-all/src/host/services/index.ts`（第 10、66 行）、`packages/dsh-web-all/src/host/services/notify/index.ts`（第 49 行 import 路径）、`TS/lark-inbox-*.spec.ts`（只改 import 路径）、`TS/capability-parity.manifest.json`（`hostServices` 中 `lark-inbox` → `superagent`）、`TS/services-assembly.spec.ts`（若断言挂载名）、`docs/native-capability-boundary.md:90`（路径列）、`packages/dsh-web-all/src/core/lark-inbox/reply-machine.ts:17`（注释路径）

不改的：设置命名空间 `lark-inbox`、宿主路由 `/lark-inbox/wizard`、`data-dsh-plugin="lark-inbox"`、客户端 `src/client/lark-inbox/` 与 `src/client/settings/lark-inbox.tsx`、`family-config.ts` 的命名空间表、队列目录默认值 `$DSH_HOME/lark-inbox`。理由：这些是用户可见的配置与 UI 契约（`03`："客户端设置页仍在 client 侧，配置命名空间保持兼容"）。

notify 的依赖：`notify/index.ts:49` 今天 import `lark-inbox/config.ts` 的 `LARK_INBOX_SETTINGS_NAMESPACE` 与 `LarkInboxConfig` 类型。搬家后若改指 `SA/channels/feishu/admin/config.ts`，notify 就依赖了秘书入口，违背 `03`"notify 不依赖秘书入口"。处置：把这一个常量与该类型的纯形状搬到 `CORE/config-shape.ts`，通道的 `admin/config.ts` 与 notify 都从那里 import（NEEDS-DECISION N22）。

`SA/index.ts` 骨架：

```ts
import type { Context } from '@deepseek-ai/cordis'
import * as feishu from './channels/feishu/index.ts'
/** superagent 服务域组合根。T02 阶段只装配飞书通道（行为与原 lark-inbox 域完全一致）。 */
export function register(ctx: Context): () => Promise<void> { return feishu.register(ctx) }
```

`host/services/index.ts`：`import * as superagent from './superagent/index.ts'`，`mount('superagent', () => superagent.register(ctx))` 替换原 `mount('lark-inbox', ...)`，位置不变（仍在 `feishu` 之后、`notify` 之前）；注释同步。

### T02 单测清单

不新增测试；判据是既有测试原样通过：

1. `TS/lark-inbox-*.spec.ts`（11 个文件）只改 import 路径后全部通过，passed 数与搬家前基线相同。
2. `TS/capability-parity.spec.ts` 在 manifest 改名后通过。
3. `TS/services-assembly.spec.ts`、`TS/notify.spec.ts`、`TS/notify-settings.spec.ts` 通过。

### T02 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/lark-inbox-` （前缀匹配 11 个文件） | passed 与 W0 基线读数相同，failed=0，退出码 0 | 在 `SA/channels/feishu/responder.ts` 把 `REPLY_RECEIPT_EMOJI` 改成 `'OK'` → `lark-inbox-responder.spec.ts` 红 |
| `VT tests/capability-parity.spec.ts tests/services-assembly.spec.ts tests/notify.spec.ts` | failed=0，退出码 0 | manifest 留着 `lark-inbox` 不改 → parity 红 |
| `test -d packages/dsh-web-all/src/host/services/lark-inbox; echo $?` | `1`（旧目录不存在） | 留一个旧文件 → 输出 `0` |
| `grep -rn "superagent/channels" packages/dsh-web-all/src/host/services/notify` | 空输出（notify 不依赖秘书入口） | 让 notify 直接 import 通道 config → 输出非空 |
| `pnpm --filter @dsh-cove/dsh-web-all build && grep -c "lark-inbox/wizard" packages/dsh-web-all/lib/index.js` | 构建退出码 0；计数 ≥1（路由仍在 bundle 中） | 删掉 host-routes 注册 → 计数 0 |
| `pnpm docs:check` | 退出码 0（`docs/native-capability-boundary.md` 路径已更新） | 不改该文档 → 若门禁检查代码路径则红；不检查时以 `grep -n "services/lark-inbox" docs/native-capability-boundary.md` 空输出为准 |
| G1–G6 | 见 T-00 | 见 T-00 |

用户可见变化：无。生效方式：随下一次用户重启 DSH 服务；重启前旧 bundle 照常。

## T18 通道契约、owner 认领接线、union_id 回填

写域：`SA/channels/feishu/inbound.ts`、`SA/channels/feishu/send.ts`、`SA/channels/feishu/react.ts`、`SA/channels/feishu/audience.ts`、`SA/channels/feishu/channel.ts`（五方法装配）、`SA/channels/feishu/index.ts`（只加 admit 钩子）、`SA/channels/feishu/inbox-store.ts`（只改 `pop`/`peek` 的 owner 过滤）、`TS/superagent-channel-feishu.spec.ts`。依赖：T02、T04（`owner` 列）。admit 钩子的结果类型在本文件内定义，不依赖内核；内核 claim 与 SenderPort 的接线在组合根 T27。

### 契约

```ts
// channel.ts：协议 Channel 的飞书实现（02 通道契约五方法）
export function createFeishuChannel(deps: {
  store: () => InboxStore | undefined
  sender: () => InboxReplySender | undefined          // 现有 createFeishuTextSender，含 F19 退避
  reactor: () => ((messageId: string, emoji: string) => Promise<void>) | undefined  // 现有表情回执能力
  members: (chatId: string) => Promise<{ union_id?: string; open_id: string }[]>     // 群成员快照
  historyReader?: (chatId: string, limit: number) => Promise<HistoryRow[]>           // P6 未授权时缺省
  ownerUnionIds: () => string[]
}): Channel

// inbound.ts：信封 → 协议 InboundEvent；union_id 从 payload.raw 回填（F17）
export function toInboundEvent(envelope: LarkInboxEnvelope, receivedAt: number): InboundEvent
export function unionIdOf(raw: unknown): string | undefined   // event.sender.sender_id.union_id

// index.ts：入站接线点（替换今天的 `if (stored === 'appended') activeResponder?.kick(envelope)`）
export type AdmitResult = 'responder' | 'shadow' | 'superagent' | 'already_claimed'
export interface FeishuChannelHooks { admit?: (event: InboundEvent) => AdmitResult }
// 规则：appended 之后调用 admit；结果为 responder 或 shadow → kick 现有 responder；superagent 或 already_claimed → 不 kick
// 未注入 admit（T27 之前）→ 行为与今天一致：直接 kick
```

`inbox-store.ts` 的改动只有一处：`peek`、`pop` 的候选集合加 `AND (owner IS NULL OR owner = 'responder')`，使秘书认领的事件不会被 `lark_inbox_pop` 工具取走（F16 的 pending→routed 语义不变）。`owner` 列由 T04 迁移保证存在；列不存在时（旧库未迁移）退化为原查询，判据是 `PRAGMA table_info` 一次缓存。

`send` 用 `idemKey` 作飞书 uuid（≤50 字符，F19）；`react` 复用现有表情回执；`audience` 返回 `{ party_ids, has_owner }`，p2p 时为发送者一人；`history` 在未注入 `historyReader` 时 reject `HISTORY_UNAVAILABLE`（NEEDS-DECISION N17）。

### 失败模式

| 失败 | 行为 |
| --- | --- |
| payload 无 union_id | `sender.union_id` 留空；下游按 SPIKES S3 的不成立分支处理（弱身份按"群内其他人"） |
| admit 抛错 | 记 warn，按 responder 处理（kick），保证消息一定有人负责；`owner` 不写（I2 的 60 秒告警会显示） |
| 发送失败 | 沿用现有退避（30 秒起、24 小时放弃，F19）；通道不写账本，失败结果返回调用方 |
| 群成员读失败 | `audience` reject；调用方按"受众不明 = 最窄受众"处理（只用公共核心案卷） |

### T18 单测清单（`TS/superagent-channel-feishu.spec.ts`）

fixture：`FX/memdb.ts`（带 `inbox_events` 与 owner 列）、现有 lark-inbox 测试里的事件样例（从 `TS/lark-inbox-inbound.spec.ts` 复制一条 `im.message.receive_v1` 原始事件，加 `sender_id.union_id`）。

1. `toInboundEvent` 从 `payload.raw` 取出 union_id、open_id、chat type、message_id、thread；无 union_id 时字段缺省而不抛错。
2. admit 返回 `superagent` → responder 的 `kick` 未被调用（spy 计数 0）。
3. admit 返回 `shadow` → `kick` 调用 1 次。
4. 未注入 admit → `kick` 调用 1 次（与今天一致）。
5. admit 抛错 → `kick` 调用 1 次且 warn 日志 1 条。
6. `pop` 不返回 `owner='superagent'` 的行；返回 `owner IS NULL` 的行。
7. 旧库（无 owner 列）上 `pop` 照常工作。
8. `send` 两次同 idemKey，底层 sender 收到同一 uuid 两次（幂等由飞书侧保证），返回 messageId 相同。
9. `history` 未注入 reader 时 reject，错误码 `HISTORY_UNAVAILABLE`。
10. `audience` p2p 返回发送者一人且 `has_owner` 按 `ownerUnionIds` 判定。

### T18 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-channel-feishu.spec.ts` | passed=10，failed=0，退出码 0 | 去掉 `pop` 的 owner 过滤 → 第 6 条红 |
| `VT tests/lark-inbox-` | passed 与 W1 末读数相同，failed=0 | 让 admit 缺省时不 kick → `lark-inbox-responder.spec.ts` 红 |
| `grep -rn "Ledger\|sa_commitment\|sa_intake" packages/dsh-web-all/src/host/services/superagent/channels` | 空输出（通道不写账本、不认识承诺） | 在 inbound.ts 引用 `sa_intake` → 非空 |
| G1–G6 | 见 T-00 | 见 T-00 |
