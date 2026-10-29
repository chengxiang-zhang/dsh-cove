# Falsify Checklist（证伪优先）

> 防止用冒烟 JSON / 首屏截图洗白 Pass。Verify **先跑证伪**，再写 `run.md` Pass。
> Evidence Kind 真源：[`evidence-contract.md`](./evidence-contract.md) §1.1。
> 结束信号 / Floor≠关版：[`verification-loop.md`](./verification-loop.md)。
> 系列全角色验收：[`version-acceptance-matrix.md`](./version-acceptance-matrix.md)。

## 硬门

1. **证伪先于结案**：适用 Test 标 Pass 前，须执行本切片「怎么证伪」步骤（写在 `tests.md` Then / 自动化，或下方默认刀）。
2. Build 轨完成语义 / 关版闸 / Oracle 冻结：见 wish-programming 五阶段 + [`verification-loop.md`](./verification-loop.md)（本文件不复述）。
3. **同会话 Build→Verify**：禁止把 Build 期间的 window-smoke / health 结果原样誊为 Verify Pass；须重跑证伪或等价命令并记新证据。
4. **指挥施工**：`maker ≠ grader` — 指挥侧至少亲自跑 **1 条** 证伪命令（或复核其输出），不只读施工侧 `run.md`。真源 verification-loop。
5. **禁改 Oracle（钉 2）**：证伪失败 → Result=`Fail`；禁止改 `tests.md` / 矩阵 Oracle 消 Fail。

## 默认证伪刀（按触及面选用）

| 触及面 | 至少一刀（失败 = Fail，不许 smoke 覆盖） | 合格 Evidence Kind |
|---|---|---|
| 分页 / 无限滚动 / load-more | 同一 API 两个 `offset`/`cursor`（或翻页两次），**首行主键或 body 哈希不同**；`has_more` 与 total 一致 | `api-diff` 或 `network-har` |
| 排序 | 改排序后抓真实请求：带 `order_by`/`sort`（或宿主等价参数）；首行字段序与方向一致 | `network-har` 或 `api-diff` |
| 筛选 | 开/关筛选后结果集可区分（行数或主键集合变化） | `api-diff` / `browser-job` |
| 双分页控件 | UI 不得同时启用「页码分页」与「无限滚动」争同一数据源；Spec 只留一种，另一种 Out 或删除 | `browser-job` + 代码 diff |
| 权限 / 隔离 | 越权角色走同一入口 → 可观察拒绝 | `browser-job` / 自动化 |
| 纯文案 / 布局 | 真实通道走完 Job + 截图能判断结果（仍禁仅 smoke JSON） | `browser-job` |

数据面（`page_kind`/`motif` 为 `list`|`dashboard`，或合同写分页/排序/筛选）→ **前三行至少覆盖触及项**；未触及可写 `N/A + 理由`。

## 禁止当作 Pass 的「证据」

单独出现下列任一，**不得**将对应 Test 标 Pass：

- `*smoke*.json` / window-smoke / dev-ui-window-smoke
- `curl /health`、进程 active、首页 HTTP 200
- 「页面能打开」「列表有数据」「可以滚动」且无两态对比
- 仅 DOM 控件存在 / Toast / 脚本旁路

允许与合格 Kind **并列表述**作旁证，但不能是唯一证据。

## 写入 `run.md`

- 追踪矩阵 Evidence：`kind=<名> · <路径或命令摘要>`（见 evidence-contract Kind 表）
- 「已验证的用户结果」每行须含：**操作 → 两态观察差 → 证据**；无两态差不得写「已通过」
- 证伪失败 → Result=`Fail`，归入统一 Repair；禁止改 Oracle 来消 Fail
