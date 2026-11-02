# Plan Card 模板（T2/T3 必填）

```markdown
## Plan Card · <id>
tier: T2-spec
context:
  estimate: 60K            # 固定 19K + 读取 + 工件 + 轮数×3~5K
  zone: green              # green ≤250K / yellow 250–400K / orange 400–550K / red >550K
  checkpoints: [after W2, after W3]
  handoff_at: 400K
waves:
  W1 (parallel): read A | read B | baseline tests
  W2 (serial):   design decision (Lead) + user gate
  W3 (parallel): impl A | impl B      # write scopes: A→src/a/**, B→src/b/**
  W4 (serial):   independent verify → gate green → commit
serial_chain: [decision, gate, ledger, commit]
max_parallel: 2
```

**校验**：并行波内写域交集为空；`serial_chain` 覆盖所有共享写者；`max_parallel ≤ min(5, 写域数)`；
黄/橙区必须有 checkpoints；`estimate` 与 `zone` 必须给出。
