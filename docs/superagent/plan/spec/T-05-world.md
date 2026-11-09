# T-05 世界模型：纯函数（T05）与存储、适配器（T15）

> 适用性：本文属于 2026-11-05 原实施批次，保留既有记录，不是当前目标设计的施工依据。2026-11-09 用户授权重整需求后，与[当前设计](../../README.md)、[需求基线](../../01-需求基线.md)冲突的冻结、任务、默认裁定与 DONE 判据不再有效；新实现需重新规划并按[验收与评估](../../13-验收与评估.md)验证。

设计依据：`04-世界模型`（范围路径、三条注册通路、实体/称呼/地址三层、不可变授权、归属三步、契约六方法）。事实：F17、F27、G6、R6、R20。

## T05 纯函数

写域：`SA/world/paths.ts`、`SA/world/mandate.ts`、`SA/world/resolve.ts`、`SA/world/defaults.ts`、`TS/superagent-world-pure.spec.ts`。依赖：T01。

### 契约

```ts
// paths.ts：范围路径（04"范围是路径"）
export type ScopePath = string   // 'local/' | 'local/~/code/dsh-web' | 'netbird/<host>' | 'netbird/<host>/~/code/x' | 'netbird/<host>/session/<id>' | 'external/<domain>/<org>'
export function parsePath(raw: string): { realm: 'local' | 'netbird' | 'external'; host?: string; rest: string[] }  // 非法抛 PATH_INVALID
export function normalizePath(raw: string): ScopePath            // 去尾斜杠（realm 根除外）、折叠 '//'、拒绝 '..'
export function isPrefix(ancestor: ScopePath, path: ScopePath): boolean   // 按段比较，'local/~/code/dsh' 不是 'local/~/code/dsh-web' 的前缀
export function ancestors(path: ScopePath): ScopePath[]           // 近到远

// mandate.ts：授权判定（04"授权是不可变记录"）
export interface MandateQuery { principal: string; scopePath: ScopePath; capability: Capability }
export function decideMandate(rows: readonly MandateRow[], q: MandateQuery, defaults: DefaultTable, principalClass: PartyClass):
  { strength: Strength; mandateId?: string; source: 'mandate' | 'default' }
// 规则：只看 revoked_at IS NULL 且 principal 相等的行；取 isPrefix(row.scope_path, q.scopePath) 中最长者；
// 同长度并列时 deny > draft > allow（最严者胜）；无命中 → 默认表；写类能力（write_repo/write_host/change_prod/publish/provision）
// 只有显式行才可能 allow，默认表对写类最多给 draft（"写必须显式给到路径级"）

// defaults.ts：三态默认表（04；数据，不是代码分支）
export type PartyClass = 'owner' | 'colleague' | 'member' | 'external'
export type DefaultTable = Readonly<Record<PartyClass, Readonly<Record<Capability, Strength>>>>
export const DEFAULT_TABLE: DefaultTable
// owner: read=allow，write_repo/write_host/provision/steer_foreign/change_prod/publish/commit_promise=draft（NEEDS-DECISION N24〔推断〕）
// colleague: read=allow，其余写类=draft，change_prod/publish=deny，commit_promise=deny，steer_foreign=deny
// member: read=allow，其余全部 deny
// external: 全部 deny

// resolve.ts：消歧（04"名字在注册时定，不在查询时猜"）
export interface ResolveInput { mention: string; entities: readonly WorldEntityRow[]; aliases: readonly { alias: string; entity_id: string }[];
  authorizedPaths: readonly ScopePath[] }
export interface ResolveResult { entity?: WorldEntityRow; scopePath?: ScopePath; candidates: { entity_id: string; score: number }[];
  ask: null | 'unregistered' | 'close_scores' | 'outside_scope' }
export function resolveMention(input: ResolveInput): ResolveResult
// 顺序：alias 精确（大小写不敏感）→ canonical 精确 → 路径字面 → 模糊（编辑距离归一 0–100）；
// 只在三种情况 ask：说法未登记（无精确命中）、前两名分差 < 30、命中实体不在任何 authorizedPaths 前缀下
// 只考虑 state='enrolled' 的实体；proposed/stale/gone/revoked 不参与

// place 第 2 步：机械筛主机（04 归属三步）
export function filterHosts(entities: readonly WorldEntityRow[], need: { tools: 'read' | 'full'; executorClass: string }, now: number): WorldEntityRow[]
// 条件：enrolled、lease_until ≥ now 或为空（config 来源无租约）、manifest_json.executors 含 executorClass
```

### T05 单测清单（`TS/superagent-world-pure.spec.ts`，fixture：内联实体/别名/授权行数组）

1. `normalizePath` 对 `local//~/code/dsh-web/` 得 `local/~/code/dsh-web`；含 `..` 抛 `PATH_INVALID`。
2. `isPrefix('local/~/code/dsh','local/~/code/dsh-web')` 为假；`isPrefix('netbird/pc-tower','netbird/pc-tower/~/code/x')` 为真。
3. `decideMandate`：仓库级 allow + 机器级 deny（同 principal），查仓库下路径得 allow（更长者胜）；查机器另一仓库得 deny。
4. 同长度 allow 与 draft 并列 → draft。
5. `revoked_at` 非空的 allow 不计入，回落默认表。
6. 默认表对 owner 的 `write_repo` 给 draft；对 external 的 `read` 给 deny；对 colleague 的 `publish` 给 deny。
7. `resolveMention('那台 mac')`：别名表有 `那台mac → imac` 时命中且 `ask=null`；别名表没有时 `ask='unregistered'`。
8. 两个候选分数 80 与 60 → `ask='close_scores'`；80 与 40 → 命中高者。
9. 命中实体路径不在 authorizedPaths 下 → `ask='outside_scope'`。
10. `state='proposed'` 的实体即使别名精确命中也不返回。
11. `filterHosts` 排除 lease 过期与 manifest 不含该执行体类的主机。
12. 负控内置：把"最长前缀"改成"最先匹配"的替身实现跑第 3 条必须红（测试内对两个实现分别断言，保证用例有区分力）。

### T05 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-world-pure.spec.ts` | passed=12，failed=0，退出码 0 | 把 `decideMandate` 的并列规则改成 allow 胜 → 第 4 条红 |
| `grep -rnE "Ledger\|DatabaseSync\|from '\.\./(kernel\|desk\|judgment)" packages/dsh-web-all/src/host/services/superagent/world/{paths,mandate,resolve,defaults}.ts` | 空输出（纯函数，只依赖协议） | 在 resolve.ts import kernel → 非空且 DEPS 红 |
| G1–G6 | 见 T-00 | 见 T-00 |

## T15 存储与适配器

写域：`SA/world/registry.ts`、`SA/world/place.ts`、`SA/world/adapters/index.ts`、`SA/world/adapters/config.ts`、`SA/world/adapters/ssh-config.ts`、`TS/superagent-world-registry.spec.ts`。依赖：T05、T08。

### 契约（`04` 契约六方法；写入一律经 `Ledger.open` 传入的事务）

```ts
export interface WorldRegistry {
  resolve(mention: string, principal: string): ResolveResult
  mandate(principal: string, scopePath: ScopePath, capability: Capability): { strength: Strength; mandateId?: string }
  enroll(tx: LedgerTx, entity: EntityInput, token: string): WorldEntityRow      // 令牌由人生成；一次性；无效抛 TOKEN_INVALID
  propose(tx: LedgerTx, entity: EntityInput, manifest: Manifest): WorldEntityRow // discover 只能走这条，state='proposed'
  place(commitment: { what: string; check_kind: CheckKind; target?: string; principal: string; needsWrite: boolean }):
    { realm: string; host?: string; workspace: 'reuse' | 'new' | 'temp'; scopePath: ScopePath; mandateId?: string } | { denied: 'NO_MANDATE' | 'NO_HOST' }
  revoke(tx: LedgerTx, entityId: string, by: string): void                     // 立即生效，不删记录
  grantFromConfig(tx: LedgerTx, rows: ConfigMandate[], policyVersion: string): number   // 只有配置通路能写 mandate
  sweepLeases(tx: LedgerTx, now: number): { stale: number; gone: number }       // lease_until 过期 → stale；过期 30 天 → gone
  registerWorkspace(tx: LedgerTx, w: { path: string; entity_id: string; commitment_id: string; mandate_id: string; branch?: string }): void  // N7
  removeWorkspace(tx: LedgerTx, path: string, now: number): void              // 置 removed_at，不删行
}
export interface DiscoverySource { name: string; discover(now: number): Promise<{ entity: EntityInput; manifest: Manifest }[]> }
export function createWorldRegistry(deps: { read: LedgerReader; clock: HostClock; defaults: DefaultTable }): WorldRegistry
```

- `LedgerTx`、`LedgerReader` 是 T04 在 `SA/protocol/db.ts` 定义的接口类型、由 T08 的 `Ledger` 实现（世界模型只依赖协议，不 import 内核）。registry 只对 `sa_world_entity`、`sa_world_alias`、`sa_world_addr`、`sa_mandate`、`sa_workspace` 与 `sa_party` 写（`LedgerTx.run` 的表白名单由构造参数给定）。
- 适配器 `config.ts`：从设置命名空间读 `superagent.world.entities`（canonical、kind、realm、path、aliases、addrs、manifest）与 `superagent.world.mandates`，经 `register`（config 通路，直接 enrolled）与 `grantFromConfig` 落账。owner 与 colleague 的 `sa_party` 行只从这里来（G6），身份键用 union_id（S3 读数决定弱身份处理）。
- 适配器 `ssh-config.ts`：只读 `~/.dsh/dsh-ssh.json`，按 `HostName`（或解析后的地址）把多个别名归并成一个实体候选（F27：27 条别名 → 25 个 host），全部走 `propose`（state='proposed'），别名写入 `sa_world_alias(kind='ssh')`，地址写 `sa_world_addr`。不连网、不做 SSH。
- `place`：第 1 步域与第 3 步落点由调用方（判断）给出提议，本方法只做第 2 步机械筛选与第 3 步校验：`workspace='new'` 必须持有目标路径的 `write_repo` 且不为 draft，否则 `NO_MANDATE`。

### 失败模式

| 失败 | 行为 |
| --- | --- |
| 适配器抛错 | 只停这一个来源的发现，写一行 `degrade_event(reason='world_adapter_failed', scope=<name>)`；已有实体与授权不变（README 扩展点表） |
| 配置里 mandate 指向未注册路径 | 拒绝该行并记 warn；其余照常 |
| 对话里声称"我是老板" | 不经配置通路，任何写入都不发生（DDL CHECK + 本模块无对话入口） |

### T15 单测清单（`TS/superagent-world-registry.spec.ts`，fixture：`FX/ledger.ts`、内联 `dsh-ssh.json` 样例含 4 个别名指向同一 HostName）

1. ssh-config 适配器把 4 个别名归并为 1 个 proposed 实体、4 条 alias。
2. proposed 实体不参与 `resolve` 与 `mandate`（读数 W-discover 为 0）。
3. 直接把 discover 实体改 enrolled 被 DDL 拒绝。
4. `enroll` 用无效令牌抛 `TOKEN_INVALID`；有效令牌一次后第二次抛 `TOKEN_INVALID`。
5. `grantFromConfig` 写入的 mandate 行 `granted_by` 为配置里的人名；`granted_by='superagent'` 的输入被拒。
6. `revoke` 后 `mandate()` 立即回落默认表；行仍在、`revoked_at` 非空。
7. `sweepLeases`：过期 1 分钟 → stale；过期 31 天 → gone；stale 实体不被 `filterHosts` 选中。
8. `place(needsWrite=true, workspace='new')` 在只有 draft 时返回 `NO_MANDATE`；有显式 allow 时返回 mandateId。
9. 适配器抛错时写一行 degrade_event，其他适配器的发现结果照常落账。
10. config 适配器写的 owner party 行 `source='config'`；observed 来源写 `class='owner'` 被拒。

### T15 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-world-registry.spec.ts` | passed=10，failed=0，退出码 0 | 让 ssh-config 适配器走 `register` 而非 `propose` → 第 1、2 条红 |
| 读数 SQL（在测试库上，测试内执行）：`SELECT count(*) FROM world_entity WHERE state='enrolled' AND source='discover'` | 0 | 同上负控 → 非 0 |
| G1–G6 | 见 T-00 | 见 T-00 |
