---
name: incident-runbook
description: Use when production/staging is broken or data is corrupted (TX) — stop the bleeding first (rollback/isolate/limit), report and get authorization, then diagnose and fix as T2. Never start with root-cause analysis, docs or refactors. For planned deployments use change-spec (T2-ops).
---

# Incident Runbook（TX）

> **Entry tier: TX only.** 优先级最高；先止血、后根因、再修复。止血动作前必须报用户并拿授权（生产）。

## 顺序（不可换）

1. **止血**（分钟级）：回滚上一变更 / 隔离故障面 / 限流 / 摘流量 / 切只读。记录每个动作的时间与读数。
2. **报用户**：一句现状 + 已做动作 + 需要什么授权；不要先写长报告。
3. **确认恢复**：关键读数回到基线（入口 2xx / 写入恢复 / 错误率下降）；贴命令 + 读数。
4. **根因**（只读）：时间线 + 变更关联 + 复现命令；区分"触发因素 vs 根本原因"。
   **根因未知时先派一次强模型档**（顺序 `subagent_codex` → `subagent_claude_code`，见 `design-dispatch`），要求产出"3 条竞争假设 + 每条的证伪实验 + 各自需要的读数"；**实验由本栈跑**，不许把"它说是这个原因"当根因。派发内容里必须带：症状、时间线、已采集读数、允许读的范围。 排障不要被派发卡住：回 `running` 就先自己取证，`external_session_wait` 收结论。
5. **修复**：转 T2-spec（带复现与负控）；修复要有回归门，防复发。
6. **复盘**：`incident.md`（时间线 / 动作 / 读数 / 根因 / 门 / 待办），24h 内交。

## incident.md 模板

```markdown
# Incident · <id> · <时间>
- **影响**：什么不可用/错了多久（起止时间、影响面）
- **止血**：动作 → 时间 → 读数
- **恢复**：读数恢复证据（命令 + 值）
- **根因**：一句话 + 证据链（变更/日志/复现）
- **修复**：PR/commit + 回归门（防复发）
- **遗留**：未解决项 + owner + 复查日
```

## 硬规则

- 禁止先根因、先文档、先重构、先"优化"；
- 生产动作要有当轮授权；不可逆动作（删数据/重建）必须备份 + 二次确认；
- 不要在止血前跑大范围扫描/压测；
- 事故期间的猜测必须标〔推断〕，用读数纠正；
- 恢复后必须补回归门（否则同一事故会复发）。

## 与其它档的关系

- 止血 = TX；修复 = T2-spec；若修复涉及多模块/长跑 ⇒ T3；
- 事后复盘是 TR 的产出（findings），但事故记录独立留档。