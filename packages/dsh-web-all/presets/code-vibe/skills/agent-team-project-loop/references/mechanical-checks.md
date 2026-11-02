# 16. 机械判定附录（把规则变成能跑的检查）

> 规则若不能机械判定，就会被重新解释。以下 10 条是本 skill 的"最小可判定集"，每条给检查对象与失败判据。

| # | 判定对象 | 怎么查 | 失败示例 |
|---|---|---|---|
| M1 | **Lead 越界写** | 每轮 `git log --since=<轮起点> --name-only` 的文件集合 ∩ 非白名单路径（`scripts/`·`deploy/`·`installer/`·包内 `VERSION/contract/tests/plan/run`）必须为空 | 真实：Lead 改 `pg-wal-archive-rotate.sh`、`test_edge_only_management_pages_contract.py` |
| M2 | **回合收尾** | 该轮最后一条 `tool/call` ∈ {门命令, 运行态只读 get, `git commit`} 且其 `tool/result` 含账本计数或 `git log -1` 读数；否则记 `unclosed` | 真实：T120–T123 每轮 1 次只读 bash，输出恒定 |
| M3 | **关条** | 每条 closed：命令 ∈ 当轮 `tool/call` ∧ 读数 ∈ 同 call `tool/result` ∧ 该 id 出现在输出里；三缺一 ⇒ open | 真实：17 条关闭 0 条当轮证据 |
| M4 | **maker ≠ grader** | 板卡/账本行加 `maker:` / `graded_by:`；相同即红 | 真实：s0-verifier 判完 M5 又造 M5 |
| M5 | **上限来源** | goal/charter 每处 `≤N/不许/禁止` 必须同行带 `source: <用户原话+日期>`；缺 ⇒ 红 | 真实：`≤2` 从冒烟文档升格为全项目上限 |
| M6 | **汇报数字** | 三个数各自附生成命令；命令 ∈ 当轮 `tool/call` 且退出码 0 | 真实：切片映射 4/6 错 |
| M7 | **自查有效性** | 自查轮必须含 ≥1 条当轮新读数且与上轮不同 | 真实：四轮输出恒定仍自称"自查完成" |
| M8 | **空转计数** | 轮日志固定一行 `ledger_hits=<n>`；连续 2 轮 0 ⇒ 停轮整改 | — |
| M9 | **重试上限** | 日志固定 `gap_retry=<n>`；同一 gap ≥2 次或无缺口清单即停手枚举 | 真实：SK03 3 小时 ≥9 次重建 |
| M10 | **证据模式** | Lead 自执批次用 M3；worker 执行批次必须 `source=receipt:<sender>` + `verified_by:`（Lead 或第三人重跑过该命令） | 真实：B-010 拿回执当一级证据 |

**口径命令（可直接复制）**

```bash
grep -cE '^### GAP-' <ledger>                      # 账本开放条数
grep -cE '^#### GAP-' <ledger>                     # 已降级/归档条数
git log -1 --format='%h %ad %s' --date=iso         # 树头
git log --since=<轮起点> --name-only               # M1 的文件集合
```

**注意**：M1 的白名单必须与 §1 一致；M3 的"同 turn"在 worker 批次上不可满足，所以 M10 给了替代证据模式——
不要把 M3 生搬到 worker 批次上，那会逼出"伪造一级证据"（真实：B-010）。
