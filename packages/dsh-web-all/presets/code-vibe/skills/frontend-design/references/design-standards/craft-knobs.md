# Craft knobs（Design Read · 旋钮 · Visitor mode）

> 蒸馏：taste-skill §0–1、Impeccable Modes。与 `surface` / `page_kind` **正交**，写入切片或 Spec。

## 1. Design Read（Shape / 写码前硬门）

开写或落 UI 切片前，输出**一行**：

```text
Reading this as: <page_kind or motif> for <audience>, <vibe>, leaning <DS or aesthetic>
```

例：`Reading this as: list for ops analysts, dense/calm, leaning Stripe data-table`

- 模糊时最多 **一个** 澄清问句，再定 Read。
- 未写出 Design Read → 不得定视觉方向（与 surface 门同级；Rail 强度见 [LOAD-MAP](./LOAD-MAP.md)）。
- Plan 合同可复述该行或写 `Design Read: …`。

## 2. VARIANCE / MOTION / DENSITY

三旋钮（整数 **1–10**；未声明用默认）。由 brief 推断，不平均塞满。

| 旋钮 | 默认 | 含义 |
|------|------|------|
| `variance` | **8** consumer growth / **5** product | 布局/节奏不对称与意外程度；product 偏低 |
| `motion` | **6** growth / **3** product | 动效预算；见 [tokens/motion.md](./tokens/motion.md) |
| `density` | **4** growth / **7** product | 信息密度（**真源为 1–10**） |

**别名（写入时归一到数字）：** `compact` → 8；`comfortable` → 5。合同优先写整数。

落盘示例：

```text
variance: 5
motion: 3
density: 7
```

| brief 信号 | 倾向 |
|------------|------|
| 密表、工单、分析台 | density↑ motion↓ variance↓ |
| 品牌落地、活动页 | variance↑ motion 中高 density↓ |
| 已登录 C 端工具 | density 中；motion 短反馈 |

## 3. Visitor mode（与 surface 正交）

按**本页访客要成功什么**选一（同产品不同面可不同）：

| mode | 访客成功 | 典型 |
|------|----------|------|
| `persuade` | 做决策并行动 | growth 落地、定价 |
| `operate` | 完成任务 | product list/detail/settings |
| `read` | 理解内容 | docs、帮助、长详情 |
| `experience` | 沉浸作品/氛围 | media、品牌体验页 |

未声明时：product → `operate`；`motif:growth` → `persuade`；文档型 → `read`。

## 4. 与 LOAD-MAP

字段何时必须 / 建议 → [LOAD-MAP.md](./LOAD-MAP.md) 字段门控表。
Build：有 UI 时确认 knobs 与 [tokens/](./tokens/) / surfaces 一致。
