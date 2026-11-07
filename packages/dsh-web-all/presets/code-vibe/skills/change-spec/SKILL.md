---
name: change-spec
description: Use for a medium change (T2) — a single-module feature, backend/data/SQL change, small user-visible wish-lite, or a single environment batch (deploy/config/rollback). Produces the minimum artifacts (spec/tasks/acceptance + Plan Card), implements, then gets an independent verification. Do NOT use for one-file fixes (fix-loop) or multi-module programs (large-backlog-program).
---

# Change Spec（T2）

> **Entry tier: T2 only.** 预算：2–4 小时 / ≤12 轮 / 1–2 agent（1 实现 + 1 验收）/ 不建 goal。
> 超 50% 预算时间仍未过验收 ⇒ 缩范围或升 T3。

## 三个变体（先选一个，再开工）

| 变体 | 触发 | 额外件 |
|---|---|---|
| **T2-spec** | 后端/数据/一般功能/多文件 | 数据类加备份 + dry-run + 回滚演练 |
| **T2-wish** | 用户可见小改（单页面族/单模块） | `quote.md` + 简版 `spec.md` + 一页 `design.md`；用户看一次（截图/渲染） |
| **T2-ops** | 部署/配置生效/单批演练（**生产发布 / rollout 不走本 skill，走 `release-gate`**） | `runbook.md` 六要素 + 写令牌 + 生产授权（`journey.sh --authorize-deploy`） |

## 步骤

1. **三事实（入口必报）**：intent gaps（用户没说但会看出来的）/ irreversible（不可逆动作及回滚）/ footprint（预计触达文件/模块）。任一"有" ⇒ 计划先行。
2. **Plan Card**（写进 `tasks.md` 头部）：
   ```markdown
   ## Plan Card
   tier: T2-spec
   context: {estimate: 60K, zone: green, checkpoints: [after W2, after W3], handoff_at: 400K}
   waves:
     W1 (parallel): read A | read B | baseline tests
     W2 (serial):   design decision
     W3 (parallel): impl A | impl B      # write scopes: A→src/a/**, B→src/b/**
     W4 (serial):   independent verify → gate green → commit
   serial_chain: [decision, gate, ledger, commit]
   max_parallel: 2
   ```
3. **acceptance.md**：3–5 条判据（每条命令 + 期望读数）、至少 1 条负控（注入缺陷必须红）、回滚命令、验证命令。模板见 `references/acceptance.tpl.md`。
4. **实现**：按 waves 执行；写域互斥；G2/G3（环境生效）转单批窗口（见 ops runbook）。
5. **独立验收**：fresh context、只读、maker≠grader；复跑 acceptance + 负控；报"同意/不同意 + 依据"。
6. **报告（5 行）**：改了什么 / 证据（命令+读数）/ 未验证 / 风险 / 回滚。

## 证据下限（E2）

- 目标测试 + 至少 1 条负控 + 独立复跑；数据/运维类再加"双向实测"（该通的通、该拒的拒）。
- 门命令禁用 `| tail` 掩码；提交闸门：`if pytest …; then git commit; else stop; fi`。

## 数据安全（数据类必读）

`references/data-safety.md`：备份/快照 → dry-run（`BEGIN…ROLLBACK` 或只读预演）→ 回滚 SQL/命令 → 权限最小化 → 变更后回读。

## 运维单批（T2-ops 必读）

`references/ops-runbook.md`：六要素（只读基线 / 单批 apply / 双向实测 / 回滚在手 / 材料包内 / 生效回读）+ 写令牌（`pgrep`）+ 生产授权。

## 禁止

- 建 goal、开团队、开账本；
- 边做边改需求（需求变化 ⇒ 回 T5 重估）；
- 无回滚动数据/环境；"apply 成功"当生效；
- 让实现者验收自己。

## 升级触发器

- ≥3 模块 / ≥10 条 / >1 天 / 需 ≥3 并行 / 第二次压缩 ⇒ T3（先过价值门与合并设计）。
- 出现第二个用户可感的设计取舍 ⇒ 回用户 1 问。