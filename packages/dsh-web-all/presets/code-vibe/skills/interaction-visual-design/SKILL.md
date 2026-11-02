---
name: interaction-visual-design
description: Use when designing the interface itself — 交互流程/状态（空/载/错/满/无权限）/载体选择/视觉方向/设计系统与 token/渲染证据. Produces design.md plus rendered screenshots, and passes design review. Do NOT use for IA structure (use information-architecture), product scope (use product-design), or research (use ux-research).
---

# 交互视觉设计（Interaction & Visual）

> 先结构后视觉；状态齐全再谈好看；组件走 token 不走临时色值。

## 何时用

- "页面怎么设计/交互怎么做/好不好看/重设计/设计系统"；
- IA 已定，进入界面层；L1 可只做局部。

## 工件（`docs/design/<id>/design.md`）

1. **流程**：主路径 + 分支 + 中断恢复；
2. **状态清单**：空（三分类）、加载（分档）、错误、满、无权限、只读；每态给文案与出口；
3. **载体判据**：抽屉/独立页/主从/模态/同页展开——写判据而不是偏好（参考四分支判据，默认非模态）；
4. **视觉方向**：字阶、色板、栅格、动效；用 token 命名，不写死色值；
5. **可访问性**：键盘/焦点/对比度/语义；
6. **渲染证据**：截图或渲染输出（1440/375），不是文字自述。

## 评审（design review）

- reviewer：design-reviewer + frontend + a11y；
- 判据：状态齐全、载体有判据、视觉方向一致、token 化、证据真实、生成感/可读性（主观项由 reviewer 判断）；
- 结论写 `review.md`。

## 参考

OV IA wiki（交互规范/状态异常）、`design-craft`、`frontend-design`、`ux-ia-and-delivery`。
