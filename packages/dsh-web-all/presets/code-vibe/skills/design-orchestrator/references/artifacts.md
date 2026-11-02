# 设计工件清单与模板

目录：`docs/design/<design-id>/`

| 文件 | 必填档 | 最小内容 |
|---|---|---|
| brief.md | L1/L2/L3 | **第一段 `level: L1\|L2\|L3`** + 需求原话、目标、约束、不做什么、设计id |
| business-canvas.md | 商业层 | 四判据、九问、单位经济一行、假设状态 |
| product.md | L2/L3 | 目标/用户/场景/In-Out/优先级/度量/依赖 |
| requirements.md | L2/L3 | GWT + 验收判据 + 未决问题 |
| ia.md | IA层 | 树(≤4层)/命名/归属/跨页规则/测试计划 |
| ux-research.md | UX层 | 问题/方法/前提与失效/样本/发现/含义/度量 |
| design.md | 交互视觉层 | 流程/状态清单/载体判据/视觉方向/token/证据 |
| arch.md | 架构层 | C4/质量属性预算/边界依赖/演进信号/回滚 |
| tech-design.md | 技术层 | 模块职责/接口冻结/数据变更/迁移回滚/负控/观测 |
| selection-matrix.md | 选型层 | 门槛/权重/打分+证据/敏感性/PoC/改判/回退 |
| adr/000N-*.md | L3 | 背景/备选/结论/后果/置信度/改判/状态 |
| review.md | L2/L3 | 评审角色/判据逐条/结论/未决 |
| freeze.md | L1/L2/L3 | 版本/sha256/评审摘要/未决与已接受风险/用户确认 |

## freeze.md 模板

```markdown
# Design Freeze · <id>
- version: v1
- date: YYYY-MM-DD
- artifacts: brief.md <sha256>; product.md <sha256>; ...
- reviews: pm=pass; arch=pass(conditional: ...); security=n/a
- open_questions: ...
- accepted_risks: ...
- user_confirmation: <L2/L3 用户确认原文/时间>
- supersedes: none
```
