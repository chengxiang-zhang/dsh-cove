# 产品回归（Product Regression）· 可选合同

> **可选能力：** 只有当宿主已具备稳定的浏览器回归入口（命令、账号、数据、环境）时再启用。
> **证明目标：** 用户关键旅程在迭代后没有回退。
> **底线：** 产品回归通过 = 真浏览器 + 真登录 + 主旅程证据（见下方 `product` 层）。
> 宿主模板不复制本文；活索引落在 `docs/product/regression-register.md`。

## 1) 何时启用

满足全部条件再启用：

1. `AGENTS.md` 已给出可复跑的浏览器入口（环境、角色、命令）；
2. 至少一个 Spec 已有可复核的 V2 证据；
3. 团队同意为长期维护投入回归维护成本。

未满足时：只做版本验收（`run.md`），不声明“产品回归已落地”。

## 2) 与相邻概念边界

| 概念 | 证明什么 | 真源 |
|---|---|---|
| 验收（Version Acceptance） | 当前版本能否办成 | Spec `tests.md` + `run.md` |
| Repair 回验 | 当前失败是否被修复 | Repair 方案 + 回验证据 |
| 产品回归（可选） | 长期关键旅程是否持续成立 | `docs/product/regression-register.md`（可选配 `surfaces.json`） |

## 3) 最小分层（建议）

| 层 | 作用 | 可声称 |
|---|---|---|
| `contract` | 预检、依赖探活、快速信号 | 合同层通过 |
| `product` | 真浏览器 + 真登录 + 主旅程 | 产品回归通过 |
| `manual` | 人工补证据 | 补充说明，不自动挡绿 |

说明：字段名（如 `verify_contract[]`、`verify_product[]`）仅是**示例**；宿主可自定义 schema。

## 4) 累积原则

1. 从 Spec 验收通过的主旅程里挑关键路径晋升为长期回归；
2. 已晋升路径不可无说明降级；
3. 未自动化路径登记 backlog，持续补齐；
4. 命令选型和触发条件只写宿主 `AGENTS.md`，不在插件写死。

## 5) 工件与最小闭环

| 工件 | 是否必需 | 用途 |
|---|---|---|
| `docs/product/regression-register.md` | 是（启用后） | 人读索引与状态 |
| `docs/product/regression/surfaces.json` | 否 | 宿主机读编排（有自动化 runner 时再创建） |
| `specs/<id>/optional/regression-map.md` | 否 | 某版晋升映射与范围说明 |

默认 scaffold **不**创建 `surfaces.json`。没有自动化 runner 时不存在该文件即可。
