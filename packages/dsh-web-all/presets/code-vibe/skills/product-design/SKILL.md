---
name: product-design
description: Use when deciding WHAT to build and for WHOM — 产品目标/用户/场景/范围/优先级、PRD、验收语义（Given-When-Then）、成功度量. Produces product.md + requirements.md ready for design and implementation. Do NOT use for information architecture details (use information-architecture), visual/interaction (use interaction-visual-design), or pure research (use research-brief).
---

# 产品设计（Product Design）

> 把"想做什么"变成可验收的产品定义；范围与取舍先于方案。

## 何时用

- "做产品/新功能""排优先级""写 PRD""范围是什么""怎么算成功"；
- 商业设计已通过（或用户明示跳过商业层）。

## 工件（`docs/design/<id>/`）

### `product.md`

- 目标（用户价值 + 业务价值，各一句）；
- 目标用户与场景（谁、在什么情况下、要完成什么）；
- 范围（In / Out，Out 必须写）；
- 优先级（P0/P1/P2 + 依据）；
- 成功度量（指标定义 + 目标值 + 采集方式）；
- 依赖与约束。

### `requirements.md`

每条需求写 **Given-When-Then + 验收判据**；禁止"提示用户 XX"这种不可判的表述。
末尾列**未决问题**（谁拍板、期限）。

## 评审（product review）

- reviewer：pm-reviewer + ux-reviewer；
- 判据：范围有无 Out、GWT 可判、度量可采、未决有归属；
- 结论写 `review.md`；L2/L3 用户确认。

## 反例

- 只写功能列表没有范围/度量；
- 把方案当需求（"用抽屉展示"是设计，不是需求）；
- 无 Out 范围 → 必然膨胀。
