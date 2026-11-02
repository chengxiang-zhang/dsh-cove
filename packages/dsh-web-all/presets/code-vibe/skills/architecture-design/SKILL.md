---
name: architecture-design
description: Use for system structure and evolution decisions — 架构/重构/拆分/迁移/高可用/性能瓶颈/要不要微服务, when the 14 evolution signals fire. Produces arch.md (C4 context/container, quality-attribute budgets, boundaries/dependencies, signal verdict) plus ADRs. Do NOT use for interface/rollback detail after architecture is frozen (use tech-design) or for technology comparison (use tech-selection).
---

# 架构设计（Architecture Design）

> 架构是决策的累积：结构决策、非功能预算、取舍记录、可复查判据。
> 没触发演进信号就别动架构；一次只解一个瓶颈；每次升级写 ADR。

## 何时用

- "架构/重构/拆分/迁移/高可用/性能瓶颈/要不要微服务"；
- 出现演进信号（14 条，四层）：数据层、延迟与体验层、可用性与可靠性层、组织与研发效率层。

## 工件（`docs/design/<id>/`）

### `arch.md`

1. **C4**：context + container（必要时 component），按受众选层，不堆图；
2. **质量属性预算**：可用性/RPO/RTO/尾延迟/容量/成本，每项给目标与验证方式；
3. **边界与依赖**：模块/服务边界、允许依赖方向、禁依赖；
4. **演进判定**：命中哪条信号、当前读数、不做的代价、做了的代价；
5. **回滚与迁移**：可逆性、回退成本、数据迁移策略。

### `adr/000N-<decision>.md`

背景 / 备选（含否决理由）/ 结论 / 后果 / 置信度 / 改判条件 / 状态（proposed/accepted/superseded）。
**已接受 ADR 不改写**，被替代时新开一条并链接。

## 评审（architecture review）

- reviewer：arch-reviewer + sre-reviewer + security-reviewer；
- 判据：决策边界（该谁拍）、备选充分、预算可验证、边界清晰、回滚可行、信号有读数；
- 机械只查 ADR 编号/状态/字段非空；**是否合理由评审判断**。

## 反例

- 没有信号就"重构一下"；
- 只画图没有质量属性预算；
- 一次改多个瓶颈；
- ADR 拍完就忘（无状态/无改判条件）。
