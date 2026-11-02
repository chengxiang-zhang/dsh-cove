---
name: tech-selection
description: Use when choosing between technologies or deciding whether to migrate/replace — A vs B、选型、迁移评估、换底座. Produces a selection matrix with knock-out gates, pre-agreed weights, independent scoring, sensitivity check, PoC evidence and reversal conditions. Conclusion must land on OUR real runtime path, not popularity. Do NOT use when the choice is already made and only rollout remains (use tech-design/change-spec).
---

# 技术选型（Tech Selection）

> 先定门槛与权重，再打分；矩阵是对话工具不是神谕；必须写"什么情况下改判"。

## 何时用

- "A 还是 B""要不要迁移/换底座""选型对比"；
- 架构设计中出现技术选项分歧。

## 流程

1. **钉现状**：我方版本、读写端、主路径、真实瓶颈（无证据的维度写"未定"，不填 0 分）；
2. **Knock-out 门槛**（3–8 条，可证伪）：不满足直接出局，不进入打分；
3. **权重先定**（总和 1.00），再独立打分（1–5，带一行证据）；
4. **多人/多角色打分**，看分歧（分歧=信息缺口）；
5. **敏感性检查**：换权重看排名是否翻转；差距小 ⇒ 不算定局；
6. **PoC**：小规模、可回滚、有读数；
7. **结论 + 改判条件 + 回退方案**。

## 工件（`docs/design/<id>/selection-matrix.md`）

门槛表 / 权重表 / 打分表（含证据列）/ 敏感性 / PoC 读数 / 结论 / 改判条件 / 回退方案 / 未定项。

## 评审（selection review）

- reviewer：arch-reviewer + sre + security（+ 采购/财务按需）；
- 判据：门槛可证、权重先定、打分有证据、分歧处理、敏感性、回退可行；
- L2/L3 用户拍板。

## 反例

- 用"已生产 N 年""更流行"当加分；
- 迁移成本压倒效果分（成本只作代价项）；
- 只给一个总分、没有改判条件；
- 无来源事实不标"未定"。
