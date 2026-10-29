# Bounded Verify（有界验收轮次）

> 蒸馏：Impeccable Core principles、visual-qa-testing。防止 open-ended 自扫烧钱。
> 证伪步骤与禁烟规则见 [falsify-checklist.md](./falsify-checklist.md)。

## 轮次硬停

1. **一批** 证伪 + 证据：按 `tests.md` 适用用例跑完（含约定 desktop + 关键 mobile 截图）；数据面先两态对比。
2. **一批** 修复：只修本批 Fail / P0–P1（Verify **不改码**；Repair 回 Build）。
3. **最多再一轮** confirm 扫描。
4. **停止** — 剩余 P2 记限制；禁止无期限「再扫一轮」。

## Visual QA 三态报告（有 UI 的浏览器通道）

在 [browser-verify.md](./browser-verify.md) V2 之上，UI 变更须记录：

| 态 | 查什么 | 写入 |
|----|--------|------|
| **视觉** | 主 Job 屏截图；对照 page_kind 自检 + ai-tells 抽检 | `run.md` Evidence |
| **控制台** | 无 fatal / 未处理 rejection（与 Job 相关） | 有则 Fail 或限制 |
| **网络** | 主路径无意外 4xx/5xx；**数据面另查**请求参数与分页进度 | 有则归因 |

不必每轮全站爬虫；覆盖**本切片声明的 page_kind 主 Job**即可。

## 数据面（list / dashboard / 分页·排序·筛选）

Visual QA **不替代**证伪。至少记录：

- 两页或两 offset 响应可区分；或
- 排序/筛选请求参数与结果序；

Evidence Kind 须为 `api-diff` / `network-har`（旁挂 smoke 不算）。真源 [`evidence-contract.md`](./evidence-contract.md)。

## 与走查

UX 走查变体仍用 [ux-walkthrough.md](./ux-walkthrough.md)；发现分级用 [critique-format](../../frontend-design/references/critique-format.md) 或 O→I→S。
严重度 4 → Job Fail（ux.md）。
