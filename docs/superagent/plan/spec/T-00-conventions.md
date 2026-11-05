# T-00 共同约定（每份 spec 的一部分）

每份任务 spec 都默认包含本页。fresh agent 开工前读：本页 + 自己的任务 spec + spec 里点名的设计文档契约名。不需要读本对话。

## 路径记号

| 记号 | 路径 |
| --- | --- |
| `PKG` | `packages/dsh-web-all/` |
| `SA` | `packages/dsh-web-all/src/host/services/superagent/` |
| `TS` | `packages/dsh-web-all/tests/` |
| `FX` | `packages/dsh-web-all/tests/fixtures/superagent/` |
| `CORE` | `packages/dsh-web-all/src/core/lark-inbox/`（纯逻辑，保留原位，不搬） |
| 设计 | `docs/superagent/00`–`11`（只读，任何任务都不得修改） |

## 命令记号

| 记号 | 展开 |
| --- | --- |
| `VT <file>` | `pnpm --filter @dsh-cove/dsh-web-all exec vitest run <file>` |
| `TC` | `pnpm --filter @dsh-cove/dsh-web-all typecheck` |
| `DEPS` | `VT tests/superagent-deps.spec.ts` |
| `F22` | `grep -c -- '- id:' packages/dsh-web-all/cordis.patch.yml`，期望输出 `1` |

vitest 的读数口径：输出末尾 `Tests  <passed> passed (<total>)` 与退出码。验收里写"passed=N"指 N 等于该 spec"单测清单"的条数，`failed=0`，退出码 0。

## 每个任务都必须满足的通用验收（G 组）

| 编号 | 命令 | 期望读数 | 负控 |
| --- | --- | --- | --- |
| G1 | `TC` | 退出码 0 | 在本任务新文件里写一处类型错误（如把 `CommitmentState` 赋给 `number`），退出码变 2 |
| G2 | `DEPS` | passed=全部、退出码 0 | 在 `SA/kernel/` 任一文件加 `import '../desk/dossier.ts'`，DEPS 变红 |
| G3 | `F22` | `1` | 在 cordis.patch.yml 复制一行 `- id: web-all`，输出 `2` 且 `VT tests/capability-parity.spec.ts` 变红 |
| G4 | 写域检查：`git diff --name-only dev...HEAD \| grep -vE '<本任务写域正则>'` | 空输出（grep 退出码 1） | 在写域外改一个文件，输出非空 |
| G5 | `grep -rnP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' <本任务写域>` | 空输出 | 在注释里放一个 emoji，输出非空 |
| G6 | `grep -rnE "new DatabaseSync\|\\.exec\\(['\"\`]BEGIN" SA --include=*.ts \| grep -vE 'SA/(protocol/db\|kernel/ledger)\\.ts'`（把 SA 展开） | 空输出（P1：只有协议建库、只有账本开写事务） | 在 `SA/memory/log.ts` 写 `db.exec('BEGIN')`，输出非空 |

## 测试夹具（FX）

| 文件 | 由谁建 | 内容 |
| --- | --- | --- |
| `FX/manual-clock.ts` | T01 | `createManualClock(startMs)`：`now()`、`advance(ms)`、`setInterval/clearInterval` 由 `advance` 驱动 |
| `FX/fake-controller.ts` | T01 | 实现 `SessionControllerFace`（见下）；记录每次调用；`emit(sessionId, event)` 推送会话事件；`inspect` 返回已推送事件；可注入 `create`/`prompt` 失败 |
| `FX/fake-channel.ts` | T01 | 实现协议 `Channel`：`push(inbound)` 产生入站；`sent[]`、`reacted[]` 记录出站；`history(chatId)` 返回 `sent` 中该会话的行；可注入发送失败 |
| `FX/memdb.ts` | T04 | `openTestLedgerDb()`：`new DatabaseSync(':memory:')` + 建 `inbox_events`（与 InboxStore 相同 DDL）+ `migrate(db)`；`seedInbound(db, partial)` 插一行入站 |
| `FX/ledger.ts` | T08 | `openTestLedger(clock)`：在 memdb 上构造 `Ledger`；`seedCommitment(...)` 等种子函数 |

## 宿主端口类型（`SA/host-ports.ts`，T01 建，类型而已）

```ts
export interface SessionControllerFace {
  create(req: { sessionId?: string; cwd?: string; agentPreset?: string }): Promise<{ sessionId?: unknown }>
  prompt(req: { requestId: string; sessionId: string; mode: 'queue' | 'steer';
                content: readonly { type: 'text'; text: string }[] }, signal: AbortSignal): Promise<{ accepted?: unknown }>
  cancel(req: { sessionId: string }): unknown
  inspect(sessionId: string): Promise<{ meta?: { cwd?: unknown }; events?: readonly unknown[] }>
}
export interface HostClock { now(): number; setInterval(fn: () => void, ms: number): unknown; clearInterval(h: unknown): void }
export interface HostLog { info(m: string): void; warn(m: string): void; error(m: string): void }
```

形状照抄 `lark-inbox/index.ts` 的 `SessionControllerFace`（F1），只加 `inspect` 的 `events`（F2）。desk 与 executors 都依赖这个文件，它不依赖任何模块。

## 数据库约定

- 同库：`sa_` 表与现有 `inbox_events`、`reply_jobs` 同在 `<queueDir>/inbox.sqlite`（默认 `$DSH_HOME/lark-inbox/inbox.sqlite`）。物理名一律 `sa_<逻辑名>`（`02` 物理命名）；`inbox_event` 的物理名是现有的 `inbox_events`。
- 内核用自己的第二个 `DatabaseSync` 连接（WAL，`busy_timeout=5000`），不复用 InboxStore 的连接。
- 写事务必须同步完成：`Ledger.open(fn)` 的 `fn` 不得返回 Promise（类型上 `fn: (tx) => T` 且运行期检查 `T` 非 thenable，否则抛 `LEDGER_ASYNC_TX`）。原因：`node:sqlite` 是同步 API，跨 await 的 BEGIN 会和 responder 的写交错。
- 时间一律 epoch 毫秒，由注入的 `HostClock.now()` 取，不直接调 `Date.now()`（测试可控）。
- 迁移：`PRAGMA table_info` 判列再 `ALTER`（F26），全部迁移在一个事务里；启动自检缺列即拒绝启动。

## 写域检查（Lead 开波前）

```sh
# 每个任务写域一行正则，同一波内两两求交；任一交集非空即不许开波
node -e 'const d=require("fs").readFileSync("docs/superagent/plan/TASKS.md","utf8");console.log(d.match(/^写域：.*$/gm).join("\n"))'
```

Lead 人工核对同波任务的写域前缀互不包含；TASKS.md 已按此排好，开波时复核一次并在合入说明里记"写域交集为空"。

## 交付物格式（实现者交给验收者）

1. 改动文件清单（`git diff --name-only dev...HEAD`）。
2. 本任务 spec "验收"表每一行命令的原始输出末 20 行。
3. 每条负控：做了什么破坏、红在哪一行、恢复后重跑为绿的输出。
4. 若需要用户重启 DSH 服务才生效，写明"需要用户重启 DSH 服务后生效"。

验收者在干净 worktree 自己复跑 2 和 3，不采信实现者贴的输出。
