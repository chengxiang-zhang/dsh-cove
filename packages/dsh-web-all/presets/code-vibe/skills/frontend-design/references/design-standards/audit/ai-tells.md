# AI tells（产品面输出扫描 · 蒸馏）

> 来源意图：product-ui-design `ai-tells.md` + Vercel design.md reject 列表。
> **输出完成前自扫**；命中则替换。`surface: product` 全适用；`consumer` in-product 同样禁后台味与发光点；growth 仍禁本表「模板脸」项。

## 色

| Tell | 替换 |
|------|------|
| `#6366f1` / `#818cf8` 等 AI 紫靛 accent | 宿主品牌或 `accent` 默认；单 accent |
| 紫径向 glow / 渐变 mesh 当产品底 | 平表面；色只表状态/CTA |
| 情绪化 token 名（`--warmth`） | 功能名（`--surface`/`--text`/`--accent`） |
| 组件内任意 hex | tokens / 宿主变量 |
| 纯 `#000` 大面积字或影 | near-black；影用多层淡色 |

## 状态与装饰

| Tell | 替换 |
|------|------|
| **发光/脉冲 ●** | pill + 文案 |
| 每节强制 eyebrow pill | 有用才留；否则小字 label |
| 彩色左边条默认刷每张卡 | 有语义才用 |

## 字

| Tell | 替换 |
|------|------|
| Mono 做 label/eyebrow | Mono 仅代码/数字/ID |
| 产品面 `text-9xl` / 视口巨字 | 封闭 type 阶梯 |
| `...` | `…` |
| 数字列无 tabular-nums | 加上 |

## 布局

| Tell | 替换 |
|------|------|
| 习惯性 filled+ghost 双主钮 | 一主 CTA + 静默文字链 |
| 无主次的四等大 KPI | 一主三从，或真对等才四等 |
| 图标彩圆三列特性格 | 按内容挣来的块 |
| 卡片墙替密表（product） | DataTable 合同 |

## 深度 / 动效

| Tell | 替换 |
|------|------|
| 单层纯黑 shadow | 双层、淡、贴背景色相 |
| grain / glass / 自定义光标 / 视差 | 产品面删除 |
| `transition: all` / 动画宽高 | 只 `opacity`/`transform`；列属性 |
| 高频操作（Cmd+K）开合动画 | 可不动画 |

## 收尾

| Tell | 替换 |
|------|------|
| `outline:none` 无替代 | `:focus-visible` ring |
| 任意 `p-[13px]` | 4px 封闭尺度 |
| 「Submit / 出了点问题」 | 具体动词；错误含下一步 |

全文色角色 → [../tokens/color-roles.md](../tokens/color-roles.md)。
