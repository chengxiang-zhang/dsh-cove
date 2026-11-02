# scripts（v5 机械判定）

| 脚本 | 判据 | 用法 |
|---|---|---|
| `check_lead_scope.py` | M1 越界写 | `--root <repo> [--since HEAD~1] [--allow prefix]` |
| `check_batch_ledger.py` | M3/EC 批次三格 + 减条 + 列数 | `--file BATCH-STATE.md [--ledger gap-register.md]` |
| `check_plan_card.py` | Plan Card 字段/写域/并发上限 | `--file tasks.md` |
| `ctx_budget.py` | 上下文估算与区段 | `--reads 20 --avg-lines 300 --rounds 8` |

退出码统一：0 通过 / 1 失败 / 2 用法错。全部离线、只读。
