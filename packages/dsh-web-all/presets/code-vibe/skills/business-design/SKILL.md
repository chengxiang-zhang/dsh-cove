---
name: business-design
description: Use when the request is about whether/how a product makes money or fits a market — 商业模式、谁付钱、定价、渠道、伙伴、单位经济、立项值不值. Produces a one-page business canvas plus the four payment judgments and a value-gate verdict (做/缩/杀). Do NOT use for feature-level product design (use product-design) or technical selection.
---

# 商业设计（Business Design）

> 一页纸回答"这门生意怎么收钱、怎么站位"；不成立就 KILL 或缩范围。

## 何时用

- "这个功能/产品值不值得做""怎么收费/定价""商业模式""立项论证""要不要做这条线"；
- 或产品设计前需要先判断商业可行性（L3 / 涉及付费、渠道、伙伴）。

## 工件（`docs/design/<id>/business-canvas.md`）

1. **四判据先行**：谁付钱 / 怎么付 / 付几次 / 换什么权利；
2. **画布九问**：客户细分、价值主张、渠道、客户关系、收入来源、关键资源、关键业务、重要伙伴、成本结构；
3. **单位经济一行**：单价 − 变动成本 − 获客成本 = 单位毛利；回收期；
4. **假设与验证**：每条关键假设标"已证/待证/证伪路径"。

## 价值门（机械记录 + 判断）

- 机械：上述字段非空、假设有状态；
- 判断：**价值门结论**（做 / 缩 / 杀）由 pm-reviewer + business reviewer 给出，L2/L3 请用户确认；
- 不成立时**不许进入产品设计**，直接停或缩范围。

## 判据与反例

- 允许"先卖后做"：画布可以是稻草人，但必须标假设；
- 禁止：填满格子却答不出收付；把"市场很大"当结论；不做单位经济就进产品设计。

## 参考

OV 商业模式 wiki（九问/四判据/单位经济）、`tech-selection-research-verdict`（若同时涉及选型）。
