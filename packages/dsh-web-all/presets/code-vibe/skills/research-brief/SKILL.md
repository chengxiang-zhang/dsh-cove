---
name: research-brief
description: Use for read-only research, audits, comparisons, or "先看看/调研一下/为什么" tasks (TR) — produce findings with evidence and coverage, register gaps, and hand off to an implementation tier. Never edit code or produce a new blueprint. Do NOT use when the user asks to implement or fix.
---

# Research Brief（TR）

> **Entry tier: TR only.** 只读；产出白名单 = findings + gap 登记 + 方向缺口 + handoff。
> 禁止边调研边改；禁止产出新蓝图；禁止把推测写成事实。

## 步骤

1. **定题**：一句话写清"要回答什么"（不是"研究 X"）；列出 3–6 个要核的问题。
2. **取证**：每条结论给来源（`path:line` / 命令 + 读数 / 官方文档链接）；标注"实测 / 文档 / 推断"。
3. **覆盖声明**：`已查 x/y`（y = 范围总量）；未查项写 `missing=`，不许用"已全部看完"。
4. **findings.md**（写入 `docs/changes/<id>/` 或 `docs/research/<id>/`）：
   ```markdown
   # Findings · <id>
   ## 问题
   ## 结论（每条带证据与置信度）
   ## 覆盖（x/y；缺失清单）
   ## 缺口/机会（不是蓝图）
   ## 建议下一步（转 T2/T3 或不做）
   ```
5. **Gap 登记**：发现的问题进唯一账本（若有）或 `gaps.md`；每条带验收门，不许私藏。
6. **Handoff**（转档时）：objective / constraints / facts / references / evidence / unknowns / next 七字段，交给实施档。

## 证据与覆盖

- 每条结论：来源 + 命令/读数（E1）；无来源的"我认为"必须标〔推断〕。
- 覆盖：`已查/应查`；空集合（0 命中）必须说明"范围是否为空"，空集不等于验证。
- 对比类：给统一口径（同一指标/同一环境/同一时间窗），否则标"不可比"。

## 禁止

- 修改代码/配置/数据（只读）；
- 产出"重构蓝图/新架构"（那是 T2/T3 的设计件）；
- 用"调研"名义跳过用户确认去实施；
- 未标来源的结论。

## 出口

- findings 交付 → 用户决定是否转 T2/T3；
- 转档必须交 handoff（七字段），否则不许开工。