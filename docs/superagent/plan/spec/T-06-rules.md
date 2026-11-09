# T-06 规则：引擎纯函数（T06）与注册、回放、校准、自动度（T17）

> 适用性：本文属于 2026-11-05 原实施批次，保留既有记录，不是当前目标设计的施工依据。2026-11-09 用户授权重整需求后，与[当前设计](../../README.md)、[需求基线](../../01-需求基线.md)冲突的冻结、任务、默认裁定与 DONE 判据不再有效；新实现需重新规划并按[验收与评估](../../13-验收与评估.md)验证。

设计依据：`06-规则`（三层、数据形状、固定谓词集、三条通路、确定性冲突解析、回放、四条防失控硬规则、校准、自动度、契约七方法）。需求：R21、B12。

## T06 引擎纯函数

写域：`SA/rules/engine.ts`、`SA/rules/predicates.ts`、`SA/rules/conflict.ts`、`TS/superagent-rules-engine.spec.ts`。依赖：T01。

### 契约

```ts
// predicates.ts：固定谓词集（06；新增谓词是本模块版本变更，不是插件扩展）
export type Facts = Partial<{ sender_class: string; party: string; audience_class: string; capability: Capability;
  path: ScopePath; commitment_kind: CommitmentKind; prior_count: number; eta_minutes: number;
  budget_state: 'ok' | 'near' | 'over'; now_local_hhmm: string; repo_visibility: 'public' | 'private' }>
export type When = { [P in RulePredicate]?: Condition }        // 多个谓词之间是 AND
export type Condition = { eq: string | number } | { in: (string | number)[] } | { gte: number } | { lt: number }
  | { prefix: ScopePath } | { between: [string, string] }      // between 只给 time_window（'22:00','08:00' 允许跨零点）
export function parseWhen(json: unknown): When                 // 出现谓词集外的键、或条件形状不合法 → 抛 PREDICATE_UNKNOWN（禁止自然语言条件）
export function matches(when: When, facts: Facts): boolean     // 事实缺失视为不匹配
// 谓词到事实的映射：path_prefix 读 facts.path；eta_bucket 读 facts.eta_minutes；time_window 读 facts.now_local_hhmm

// engine.ts：判定（06 Engine.evaluate）
export interface RuleTrace { candidates: string[]; winner?: string; reason: 'exception' | 'longer_scope' | 'layer' | 'priority' | 'only' | 'none'; layer?: RuleLayer }
export function evaluate(rules: readonly RuleRow[], scope: ScopePath, subject: string, facts: Facts):
  { then: RuleThen | null; trace: RuleTrace }
// 只考虑 state='active' 且 isPrefix(rule.scope_path, scope) 的规则；
// 解析顺序（06，可复现）：例外优先于本体 → scope_path 更长者 → 层高者（constitution > policy > technique）→ priority 大者 → 仍并列：抛 RULE_CONFLICT（运行期不允许"看情况"，冲突本应在启动时被挡住）

// conflict.ts：启动时一次（06 Registry.checkConflicts 的纯核心）
export function findConflicts(rules: readonly RuleRow[]): { rule_a: string; rule_b: string; detail: string }[]
// 两条 active 规则：scope_path 相同、层相同、priority 相同、when 可同时成立（逐谓词求交非空）、then 不同 → 冲突
```

### T06 单测清单（`TS/superagent-rules-engine.spec.ts`，fixture：内联 RuleRow 数组）

1. `parseWhen({ sender_class: { eq: 'owner' } })` 成功；`parseWhen({ mood: { eq: 'x' } })` 抛 `PREDICATE_UNKNOWN`；字符串条件 `"if he is busy"` 抛错。
2. 11 个谓词各一条命中与一条不命中（参数化 22 个断言，算一条测试）。
3. `time_window` between `['22:00','08:00']`：23:30 命中、07:59 命中、08:00 不命中。
4. 例外优先：本体 allow、例外 deny 命中时结果 deny，trace.reason='exception'。
5. 更长 scope 胜：`local/` deny 与 `local/~/code/dsh-web` allow → allow，reason='longer_scope'。
6. 层高者胜：同 scope 的 constitution deny 与 technique allow → deny，reason='layer'。
7. priority 胜：同 scope 同层 priority 5 与 1 → 5 的结论。
8. 全部并列且结论不同 → 抛 `RULE_CONFLICT`。
9. 非 active 规则不参与。
10. `findConflicts`：when 不相交（`sender_class eq owner` 与 `eq colleague`）不算冲突；相交且结论不同算冲突。
11. 每次 `evaluate` 都返回 trace（无规则命中时 `reason='none'`、`then=null`），供 `deliberation.rule_trace` 非空读数（R-trace）使用。

### T06 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-rules-engine.spec.ts` | passed=11，failed=0，退出码 0 | 把层序改成 technique 最高 → 第 6 条红 |
| G1–G6 | 见 T-00 | 见 T-00 |

## T17 注册、合并、回放、校准、自动度

写域：`SA/rules/registry.ts`、`SA/rules/replay.ts`、`SA/rules/calibration.ts`、`SA/rules/autonomy.ts`、`SA/rules/snapshot.ts`、`TS/superagent-rules-store.spec.ts`。依赖：T06、T08（测试夹具 `FX/ledger.ts`；代码只依赖协议的 `LedgerTx`）。

### 契约（`06` 契约）

```ts
export interface RuleRegistry {
  register(tx: LedgerTx, rule: RuleInput, provenance: Provenance, by: string): string   // RuleId
  merge(tx: LedgerTx, candidateIds: string[]): string[]          // 同 scope 同结论的 extracted 并成一条，weight 相加
  checkConflicts(tx: LedgerTx): { conflicts: number }            // 启动时一次；有冲突写 sa_rule_conflict 且冲突双方不加载
  snapshot(): readonly RuleRow[]                                 // 最后一份通过校验的快照（坏了也用它，11 失败隔离）
  activate(tx: LedgerTx, ruleId: string, approvedBy: string): void
  retireCandidates(now: number): string[]                        // 30 天未命中
}
export interface Replay { run(ruleId: string, sample: 'last100'): ReplayReport }
export interface ReplayReport { sample_size: number; changed: number; changed_ratio: number; passed: boolean;
  direction: { from: RuleThen | null; to: RuleThen | null; count: number }[] }
export interface Calibration { recompute(tx: LedgerTx, day: string): { classes: number } }
export interface Autonomy { apply(tx: LedgerTx, classId: string, capability: Capability,
  evidence: { kind: 'approved_as_is' | 'rejected' | 'rewritten' | 'stopped'; at: number }): { strength: Strength; demoted: boolean; promoted: boolean } }
```

规则（全部取自 `06`，实现时逐条对应单测）：

- 通路：config → 立即 active，宪法层只有这条；extracted → proposed，`activate` 需要 `approvedBy`；inferred → 永远 proposed 且只能 technique（DDL 已拦；NEEDS-DECISION N21）。
- 回放：只有 extracted 与 inferred 需要；样本固定为"最近 100 条同类事件"（同类 = 同 `work_class` 的 intake，按 `created_at` 倒序），用旧快照与"旧快照 + 新规则"各跑一遍 `evaluate`；`changed_ratio > 0.10` 则 `passed=false` 且不得 activate；结果写 `sa_rule_replay`。
- 预算：active 规则上限 120；`register` 会让 active 数超过 120 时抛 `RULE_BUDGET`。
- 扩权禁区：任何把 `(发送者类 × 能力 × 范围)` 从 draft 变 allow 的 technique 规则在 `register` 时抛 `SELF_GRANT_FORBIDDEN`；扩权只能走 `Autonomy.apply`。
- 校准（宿主算，模型看不到也改不了）：每个 `work_class` 的 `eta_factor` = 近样本"实际分钟 / 模型估计"的中位数，样本 ≥5 才更新，夹在 0.5–4；`p90_turns` 取实际回合 p90；`preferred_executor` = 近 ≥4 次成功率 ≥80% 的最低档；`misjudge_rate ≥ 0.3` → `ask_mode='ask'`，近 5 次干净 → `declare`；异议近 5 次被推翻 ≥4 → `pushback_mode='muted'`。
- 自动度：连续 5 次 `approved_as_is` 且跨 ≥2 个自然日 → allow（`promoted=true`，调用方负责通知一句）；任何一次 rejected/rewritten/stopped → 立即回 draft、`demoted=true`、不通知；`NEVER_AUTO_CAPABILITIES` 永不 allow（DDL 已拦）。

### 失败模式

| 失败 | 行为 |
| --- | --- |
| 启动时规则冲突 | 冲突双方不进快照，写 `sa_rule_conflict`，其余规则照常；status 可见 |
| 规则表读失败 | 用内存中最后一份快照；没有快照时只用 config 层默认（空规则 = 所有闸走默认表） |
| 校准样本不足 | 不更新，保留旧值 |

### T17 单测清单（`TS/superagent-rules-store.spec.ts`，fixture：`FX/ledger.ts` + 种子 intake/commitment 行）

1. config 规则 register 后立即 active；extracted 规则 register 后 proposed，未 approvedBy 调 `activate` 抛错。
2. inferred 规则 register 为 policy 层被拒。
3. 同 scope 同结论的 3 条 extracted `merge` 成 1 条，weight=3，另两条 retired。
4. 回放：100 条样本中 11 条结论改变 → `passed=false`，`activate` 抛 `REPLAY_FAILED`；10 条 → passed。
5. config 规则不写 `sa_rule_replay`（不参与回放）。
6. active 已 120 条时再 register config 规则抛 `RULE_BUDGET`。
7. technique 规则企图把 colleague 的 write_repo 从 draft 变 allow → `SELF_GRANT_FORBIDDEN`。
8. `checkConflicts` 写入冲突行且 `snapshot()` 不含冲突双方。
9. 校准：样本 4 条不更新；样本 5 条中位数 2.1 → eta_factor=2.1；中位数 9 → 夹到 4。
10. 自动度：5 次 approved_as_is 同一天 → 不升；跨 2 天 → allow；随后 1 次 rewritten → draft 且 demoted。
11. `publish` 能力 5 次批准跨 3 天 → 仍 draft。
12. `retireCandidates` 返回 30 天未命中的 active 规则 id，不返回 29 天的。

### T17 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `VT tests/superagent-rules-store.spec.ts` | passed=12，failed=0，退出码 0 | 把回放门槛改成 `>= 0.10` → 第 4 条（10 条改变应通过）红 |
| 测试内读数：`SELECT count(*) FROM rule WHERE provenance='inferred' AND layer<>'technique'` | 0 | — |
| G1–G6 | 见 T-00 | 见 T-00 |
