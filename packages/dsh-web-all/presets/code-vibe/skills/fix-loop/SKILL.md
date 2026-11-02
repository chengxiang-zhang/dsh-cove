---
name: fix-loop
description: Use for a small, well-scoped fix — a failing test, a single bug, a ≤2-file change, a copy/config tweak (T1). Reproduce first, make the minimal change, run the targeted test, report in 3 lines. Do NOT use for multi-module features, data migrations or anything irreversible (use change-spec) or for large backlogs (use the program path).
---

# Fix Loop（T1）

> **Entry tier: T1 only.** ≤2 files / ≤40 lines / reversible / no contract·data·permission change.
> 预算：15–30 分钟、≤4 轮、0 agent、0 goal、零工件（回复内 3 行报告即可）。

## 步骤（顺序不可换）

1. **复现（先红）**：跑失败测试或最小复现命令，记下退出码与关键读数。造不出红 ⇒ 停，报告"无法复现 + 缺什么"。
2. **定位**：只读相关文件（≤2 个）；写一句"根因假设"。
3. **最小修改**：只改必要处；不顺手重构、不格式化整文件、不引入新依赖。
4. **目标测试（绿）**：跑同一测试/命令；附退出码与读数；必要时加一条负控（注入缺陷必须红）。
5. **3 行报告**：`改了什么 / 证据（命令+读数）/ 回滚方式`。
6. **提交**（若用户要求/仓库约定）：message 含证据；门绿才提交。

## 可选 `bugfix.md`（写入 `docs/changes/<id>/`，仅当需要留档）

```markdown
# Bugfix · <id>
- **Current**：现在的行为（含复现命令与读数）
- **Expected**：期望行为
- **Unchanged**：不能改变的行为/接口
- **Root cause**：一句话
- **Fix**：改了什么（文件:行）
- **Evidence**：`<命令>` ⇒ `<读数>`；负控：`<注入>` ⇒ 必红
- **Rollback**：`git revert <sha>` / `<命令>`
```

## 证据下限（E1）

命令 + 退出码 + 读数；"看起来好了"不算。改到门/契约/不可逆 ⇒ **升 T2**。

## 禁止

- 先写设计文档、拆多任务、开账本、建 goal；
- 为一行改动重启服务/重建环境；
- 顺手改他人文件或生成物；
- 同一个测试连续失败 2 次还继续猜 ⇒ 停下，升级为 T2。

## 升级触发器（任一命中）

- 第 2 次修复失败 / 波及第 3 个文件 / 发现契约·数据·权限影响 / 需要设计选择 / 用户要求留档。
- 动作：停手 → 补 acceptance + plan → 宣告 T2-spec（保留已有 diff 作证据）。