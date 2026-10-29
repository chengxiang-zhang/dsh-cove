# Anchor（参考锚点）

> 蒸馏自 product-ui-design「observe before invent」。
> **强度以 [LOAD-MAP.md](./LOAD-MAP.md) 为准：** Shape 可后置；**Build 前未写可用 anchor → 不得定视觉实现方向**（可先写 IA/文案结构）。

## 合同

每个有 UI 的切片在 **Build 开写前**必须出现：

```text
anchor: <真实产品名或具名 profile>
diverge: <本产品相对锚点的 1–3 条差量>
```

写在理解卡、`plan.md` 设计边界、或页面评审块均可；PR / 文件注释须能追溯。

## 合法 anchor 示例

| 类型 | 例 |
|------|-----|
| 真产品 | Linear Issues 列表、Stripe Payments、Notion 数据库、GitHub PR、淘宝商详、微信会话 |
| 具名 profile | `profile:linear-dense` / `profile:stripe-data` / `profile:vercel-flush` / `profile:notion-doc` / `profile:commerce-mobile` |

`profile:*` 对应具名壳/ motif 约定（写进合同 `shell:` / `motif:`），不是形容词。

## 非法（必须重写）

- 「现代 / 干净 / 简洁 / 高级 / SaaS 风」
- 空 anchor 或 `anchor: AI`
- 只写竞品名却无任何可观察差量（diverge 空白）

## 如何选

1. 优先：**打开真实参考**（或宿主已有页面）量字体/行高/边距/行样式。
2. 不能打开时：用具名 profile + shell/motif。
3. diverge 只写**故意不同**之处（品牌色、密度、无侧栏…），其余跟锚点。

## 与宿主

若 `AGENTS.md` 或 `docs/product/DESIGN.md` 已声明默认 anchor / 品牌，本切片可写：

```text
anchor: 宿主 DESIGN.md
diverge: 本页仅…
```

## 自检

- [ ] anchor 可指认
- [ ] diverge 非空或显式「无差量，严格跟锚点」
- [ ] 输出未漂回 AI 紫模板（ai-tells）
