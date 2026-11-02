---
name: information-architecture
description: Use when deciding where things live and what they are called — 导航/分类/树/命名/归属、用户找不到东西、IA 重构、树测试与卡片分类. Produces an IA tree with naming, ownership and cross-page rules, plus a test plan when structure is uncertain. Do NOT use for page visual design (use interaction-visual-design) or product scope (use product-design).
---

# 信息架构（IA）

> 结构优先于视觉；判据优先于原则。结构错了，视觉打磨全是白费。

## 何时用

- "结构怎么分/导航怎么放/分类/命名/用户找不到"；
- 页面 ≥3 且跨流程，或重构/新增模块影响导航。

## 工件（`docs/design/<id>/ia.md`）

1. **树**：层级 ≤4（超过要说明理由；4 层掉失率显著上升）；
2. **命名**：用户词优先，业务黑话标"待替换"；
3. **归属**：每项一个主归属 + 允许的交叉入口；
4. **跨页规则**：面包屑/返回/搜索范围/空态归属；
5. **验证计划**（结构不确定时）：树测试任务（成功/直接/首击/终点）或卡片分类；样本与判据先写。

## 评审（IA review）

- reviewer：ia-reviewer + ux-reviewer；
- 判据：层级、命名可理解、归属唯一、跨页规则完整、测试计划可执行；
- 有树测试读数时以读数为准，不用"我觉得"。

## 参考

OV B 端 IA wiki（结构错误判据、树测试/卡片分类配方、载体四分支判据）。
