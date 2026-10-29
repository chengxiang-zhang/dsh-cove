# Design critique format（Shape / Verify）

> 蒸馏：ai-ux-skills design-critique。用于评审稿、走查意见、Repair 聚类前的结构化反馈。
> 有 UI 时先对照 [product-judgment.md](./design-standards/product-judgment.md) 的 Job Brief / `rule/*`，再评视觉。

## Presenter 先声明（30 秒）

1. **Problem** — 要解决什么
2. **User** — 谁
3. **Job / Consequence** — 用户任务与动作后果（缺则先补 Brief，再评）
4. **Constraints** — 时间/技术/品牌硬约束
5. **Scope** — 评什么、不评什么

## 反馈句式（二选一）

**Observation → Impact → Suggestion**

```text
Observation: …
Impact: …（对 Job / 信任 / 效率）
Suggestion: …（可执行；尽量引用 rule/*）
Rule: rule/… | coverage-gap
```

**I Like / I Wish / What If** — 探索阶段；收敛后改成 O→I→S。

## 分流

| 类型 | 处理 |
|------|------|
| **Actionable** | 进 P0/P1 或 Spec |
| **Preferential** | 标偏好；不挡关版除非违反合同 |

禁止只写「不够高级」「再现代一点」——无 Observation 的评价作废。
实现黑话上屏、交互单位跟内部类型走、权限与分发揉成一团 → 按 product-judgment 对应 `rule/*` 标 **Actionable / P0–P1**。
