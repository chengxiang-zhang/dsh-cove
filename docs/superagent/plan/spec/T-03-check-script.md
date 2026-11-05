# T-03 七步链检查脚本：骨架（T03）与全量（T28）

设计依据：`11-恢复与降级`（`scripts/superagent-check.mjs` 归本模块、只读账本、退出码 0/1/2/3）、`01 §E`（七步链）、`02`–`11` 各"读数"节。事实：F31（旧脚本 `scripts/lark-autoreply-check.mjs` 的退出码约定：2 是参数或 IO 错，不是"无证据"）。

## 共同契约

```
node scripts/superagent-check.mjs [--db <path>] [--since-hours <n>] [--shadow]
                                  [--snapshot <file>] [--compare <file>] [--json]
```

- `--db` 缺省 `$DSH_HOME/lark-inbox/inbox.sqlite`（`$DSH_HOME` 缺省 `~/.dsh`），与旧脚本同一解析规则。
- 只读：`new DatabaseSync(path, { readOnly: true })`；脚本对数据库不发出任何写语句。逻辑名经 TEMP VIEW 映射：对 `PHYSICAL` 表中每一项执行 `CREATE TEMP VIEW <logical> AS SELECT * FROM <physical>`（TEMP 库在只读连接上可写；若运行期不允许，则退回对 SQL 文本做逻辑名到物理名的整词替换，两种方式同一组单测覆盖）。因此 `02`–`11` 的读数 SQL 可以逐字使用。
- 退出码：0 全部适用判据成立；1 任一判据失败；2 参数错误、库文件不存在或打不开、SQL 执行异常；3 无失败但证据不足（无 `sa_` 表、窗口内 `intake` 为 0 行、`--shadow` 下影子行数未达门槛）。
- 输出：每个判据一行 `<id> ok|FAIL|nodata <读数>`；`--json` 时输出 `{ checks: [{ id, status, value, expect }], exit }`。读数类条目（只记录不判定）输出 `<id> read <值>`，不影响退出码。

## T03 骨架

写域：`scripts/superagent-check.mjs`、`scripts/superagent-check.test.mjs`。依赖：无（`PHYSICAL` 映射在脚本里内联一份常量，T28 改为与 `SA/protocol/db.ts` 一致性单测对齐）。

内容：参数解析、库定位、只读打开、TEMP VIEW 映射、判据注册表 `CHECKS: { id, sql, expect: 'zero'|'empty'|'eq1'|'le:N', kind: 'verdict'|'reading' }[]`、退出码汇总。骨架阶段只注册一条判据 `P-words`（`SELECT count(*) FROM outbox WHERE words > 100` 期望 0），用于证明端到端通路。

### T03 单测清单（`node --test scripts/superagent-check.test.mjs`，fixture 在测试里用 `node:sqlite` 建临时库）

1. `--db /nonexistent` → 退出码 2，stderr 含路径。
2. `--since-hours abc` → 退出码 2。
3. 空库（无 `sa_` 表）→ 退出码 3，输出含 `nodata`。
4. 有 `sa_outbox` 且一行 words=50 → 退出码 0，`P-words ok 0`。
5. 一行 words=120（测试建表时不加 CHECK）→ 退出码 1，`P-words FAIL 1`。
6. 运行前后库文件的 mtime 与大小不变（只读）。
7. `--json` 输出可 `JSON.parse`，`exit` 字段与进程退出码相等。

### T03 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `node --test scripts/superagent-check.test.mjs` | `# pass 7`、`# fail 0`，退出码 0 | 把 IO 错的退出码写成 3 → 第 1 条红 |
| `pnpm test:scripts` | 退出码 0（新测试并入全量脚本测试） | 同上负控 → 退出码非 0 |
| `node scripts/superagent-check.mjs --db /tmp/does-not-exist.sqlite; echo $?` | `2` | — |
| G4、G5 | 见 T-00 | 见 T-00 |

## T28 全量判据

写域：`scripts/superagent-check.mjs`、`scripts/superagent-check.test.mjs`、`scripts/fixtures/superagent-check/`（fixture 生成脚本，只在测试中运行）。依赖：T03、T04。

### 判据表（id → SQL 来源 → 期望）

不变量与表级读数（逐字取自设计文档读数块，逻辑名）：

| id | 来源 | SQL 要点 | 期望 |
| --- | --- | --- | --- |
| P-json | 02 | `journal` 中 `length(body_json) > 8000` 计数 | 0 |
| P-words | 02 | `outbox` 中 `words > 100` 计数 | 0 |
| P-budget | 02 | `deliver` 缺墙钟或回合止损计数 | 0 |
| P-ask1 | 02 | 每承诺未答 asked 假设 > 1 的分组 | 空 |
| P-docwriter | 02 | `doc_index.added_by NOT IN ('host','human')` | 0 |
| I1 | 03 | 非 goal 开着承诺 `next_look_at > now+24h`；另加 goal `> now+7d` | 0 |
| I2 | 03 | `owner='superagent'` 且 10 分钟前到达而无 `shadow=0` 已处置 intake | 0 |
| I2-reply | 03 | 每个 event_id 的 `tier='reply' AND payload='text'` 出站 > 1 | 空 |
| I3 | 03 | running 尝试属于非 open/at_risk 承诺 | 0 |
| I4 | 03 | `queued` 出站的 `DISTINCT lease_epoch` 数 | ≤ 1 |
| IDLE | 03 | 24 小时 `avg(ops=0)` | < 0.3（无回合时 nodata） |
| W-discover | 04 | discover 且 enrolled | 0 |
| W-lease | 04 | enrolled 且 lease 过期 | 0 |
| W-workspace | 04 | 无有效 mandate 的工作区（N7：`removed_at IS NULL`） | 0 |
| W-selfgrant | 04 | `mandate.granted_by='superagent'` | 0 |
| M-dup | 05 | 同 topic 同 kind 多条 active | 空 |
| M-promote | 05 | 每天升公共请求 > 1 | 空 |
| M-canary | 05、07 | 群桌出站正文含 `CANARY-` | 0 |
| M-source | 05 | 原话类缺 source | 0 |
| R-trace | 06 | `deliberation.rule_trace IS NULL` | 0 |
| R-extract | 06 | extracted active 未批 | 0 |
| R-inferred | 06 | inferred 非 technique | 0 |
| R-cap | 06 | active 规则数 | ≤ 120 |
| R-replay | 06 | extracted/inferred active 无回放 | 0 |
| R-const | 06 | constitution 且 approved_by<>'owner' | 0 |
| D-fp | 07 | 同窗同受众类 `dossier_hash` 不唯一 | 空 |
| D-pub | 07 | 同窗 `pub_hash` 不唯一 | 空 |
| D-open8 | 07 | 有会话的桌在办 > 8 | 0 |
| J-thread | 08 | 同线程未结案顶层 deliver > 1（加 `state IN ('proposed','open','at_risk')`，NEEDS-DECISION N23） | 空 |
| T-interrupt | 09 | 每天 interrupt > 3 | 空 |
| T-brief | 09 | 每天 brief > 1 | 空 |
| X-evidence | 10 | fulfilled 无证据 | 0 |
| X-stale | 10 | running 且 `last_tool_at` 超 10 分钟 | 0 |
| V-orphan-dup | 11 | `orphan:%` 幂等键每承诺 > 1 | 空 |
| V-orphan-open | 11 | orphaned 而 closed_at 为空 | 0 |
| V-lease1 | 11 | `lease` 行数 | 1（无行时 nodata） |
| R23 | 01 R23 | 已结案（fulfilled/unverified）承诺上 `kind IN ('amend','passthrough')` 且 `consumed_turn IS NULL` 的 journal 行 | 0 |

读数类（只输出）：`J-dispositions`（08 处置分布）、`J-misjudge`（`avg(corrects IS NOT NULL)`，N9）、`T-tiers`、`T-spec-adopt`、`X-attempt-states`、`X-switched`、`X-reconcile`、`V-degrade-open`、`D-size`。

七步链（`01 §E`，每步一个判据；窗口 = `--since-hours`，缺省 24）：

| id | 判据（SQL 口径） | 期望 |
| --- | --- | --- |
| E1 | 每件 `origin_kind='event'` 的 deliver：首条 `moment='ack'` 出站的 `created_at - inbox_event.received_at ≤ 30000`，且 `≤` 首个尝试的 `started_at`（受理在派发之前） | 违规 0 |
| E2 | 每件已交付承诺：首条 ack 与首条 deliver 之间，同承诺 `moment NOT IN ('ask','cannot','pushback')` 的出站数 | 0 |
| E3 | `moment='deliver'` 出站 words ≤ 100；对应承诺为 fulfilled 时 `evidence_json` 非空；为 unverified 时正文以 `做完了，但没验证` 开头 | 违规 0 |
| E4 | 有 `disposition='amend'` 的线程：顶层未结案 deliver 数 = 1，且 amend 产生的 journal 行数 ≥ 1 | 违规 0 |
| E5 | 每条 `disposition='release'`（shadow=0）：承诺 `state='released'` 且 `closed_at - received_at ≤ 60000`；该承诺尝试均 `state='ended'` 且 `ended_at - received_at ≤ 60000`；`closed_at + 5000` 之后同承诺出站 ≤ 1（终止回执） | 违规 0 |
| E6 | 需要 `--compare <file>`：当前在办集合（`11` 读数第一条）与快照文件 diff；无 `--compare` 时 nodata | diff 为空 |
| E7 | I2 与 I2-reply 同时成立 | 两者 ok |

`--snapshot <file>` 把在办集合写成 JSON（`[{commitment_id, state}]`），这是脚本唯一的文件写出，写的是调用方指定的文件，不是数据库。

影子期判据（`--shadow`，NEEDS-DECISION N12、N18）：

| id | 判据 | 期望 |
| --- | --- | --- |
| S-owner | `intake.shadow=1` 行对应的 `inbox_event.owner` 不为 `responder` 的计数 | 0 |
| S-outbox | 出站中 `event_id` 属于 `owner='responder'` 事件的计数 | 0 |
| S-commit | `origin_kind='event'` 且来源事件 `owner='responder'` 的承诺计数 | 0 |
| S-volume | 窗口内 `intake.shadow=1` 行数 | ≥ 30，否则退出 3 |

### T28 单测清单（`scripts/superagent-check.test.mjs`，fixture 由 `scripts/fixtures/superagent-check/build.mjs` 生成：一份"干净"库与每条判据各一份"坏"库）

1. 干净 fixture 库（含七步链完整一轮：受理、交付、追加、停止）→ 退出码 0，全部 verdict 为 ok。
2. 对表中每个 verdict 判据，用对应坏库运行 → 该 id 为 FAIL 且退出码 1（参数化，共 37 个子用例；读数类不参与）。
3. `--shadow` 对影子期干净库退出 0；影子行 29 行时退出 3。
4. `--snapshot a.json` 后 `--compare a.json` → E6 ok；在库中新增一件开着承诺后再 compare → E6 FAIL。
5. 逻辑名映射与 `SA/protocol/db.ts` 的 `PHYSICAL` 一致（测试读取 db.ts 源码中的映射常量做集合比较）。
6. 七步链 E1：ack 晚于尝试 `started_at` 的坏库 → E1 FAIL。

### T28 验收

| 命令 | 期望读数 | 负控 |
| --- | --- | --- |
| `node --test scripts/superagent-check.test.mjs` | `# fail 0`，退出码 0；`# pass` ≥ 50（T03 的 7 条 + 本任务 6 个顶层用例 + 第 2 条的 37 个子用例；node:test 计数口径以实测为准，Lead 首次运行后把精确值写回本格） | 把 I3 的期望从 0 改为 ≤1 → 第 2 条 I3 子用例红 |
| `node scripts/superagent-check.mjs --db scripts/fixtures/superagent-check/out/clean.sqlite; echo $?` | 输出含 `E1 ok` 到 `E7 ok`（E6 nodata），退出码 0 | 用 `bad-I2.sqlite` → 退出码 1，输出含 `I2 FAIL` |
| `node scripts/superagent-check.mjs --db <空库>; echo $?` | `3` | — |
| `pnpm test:scripts` | 退出码 0 | — |
| G4、G5 | 见 T-00 | 见 T-00 |
