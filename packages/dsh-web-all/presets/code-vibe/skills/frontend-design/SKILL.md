---
name: frontend-design
description: 前端/UX 设计标准：设计类愿望的规范单产出、字段门控、视觉/文案/交互底线；Use when 页面/前端/设计/体验/对标/重设计/IA 类任务或 wish-programming 阶段 2 之前必须加载；禁发明、组件白名单、LOAD-MAP 字段门。
---

# Frontend Design（前端/UX 设计标准）

> 从 SDD 体系（sdd-vibe-coding，MIT）移植的 design-standards 全套 + design 专项 references。设计类愿望的阶段 2（设计规范单）前**必须加载**本 skill——不读 LOAD-MAP = 未执行设计标准。

## 加载即执行的硬门

1. **先读 `references/design-standards/LOAD-MAP.md`**（字段门控唯一真源：Job Brief 三必填未齐 → 不得定视觉、不得输出线框当定稿）——有 UI 施工必须先读本表再开写。
2. **Job Brief 三必填**（Job / Desired outcome / Consequence）未齐 → 先问清，禁止跳视觉。
3. **组件白名单纪律**（与 wish-programming 阶段 2/3 联动）：指定组件必须引用平台已有组件；找不到 → 标「需新建，待用户拍板」，禁止默认发明；实现阶段由 `check_whitelist.py` 机械核对。
4. **用户视角是必选维度**：每个设计决策回答「目标用户是谁 + 做完后用户能看到/感受到什么」；Design Read 缺省按 craft-knobs 默认。
5. **改存量页**：声明 `change: refinement|redesign`（change-control.md），material 门与 polish 轨按册执行。

## 册导航（references/design-standards/ 内）

| 场景 | 读什么 |
|---|---|
| 任务→必读路由（入口） | `LOAD-MAP.md` |
| 交互决策层（先于视觉） | `product-judgment.md` |
| Design Read / variance / density | `craft-knobs.md` |
| 写页面前评审输出模板 | `ui-page-gate.md` |
| 改存量 refinement/redesign | `change-control.md` |
| 视觉 / 文案 / 动画 / 色角色 / 尺度 | `visual.md` · `copy.md` · `tokens/motion.md` · `tokens/color-roles.md` · `tokens/scale.md` |
| 系统架构描述 | `system-architecture.md` |
| UI 回归 / 错缝排查 | `debug-playbook.md` |
| AI 味检查 | `audit/ai-tells.md` |
| 正反例校准 | `exemplars/README.md` |
| 用户故事包措辞/评审格式 | `references/critique-format.md` · `references/scheme-antipatterns.md` |

## 术语映射（LOAD-MAP 字段 ↔ wish-programming design-spec 模板）

> 本 skill 材料来自 SDD 体系；wish-programming 的 `design-spec.md.tpl` 有自己的节结构。**两套术语对照本表执行，不各写各的**——产出物只有一份（design-spec.md），字段门是检查清单。

| LOAD-MAP 字段（本 skill） | design-spec 模板节（wish-programming） | 说明 |
|---|---|---|
| Job Brief（Job/Desired outcome/Consequence） | requirements.md 需求清单 N 编号 + 确认包场景故事 | 未齐 → 不得定视觉（先问清） |
| UI surface | §1 页面树 | 页面/入口清单 |
| Design Read | §2 每页区块设计 | 每块指定组件+状态样式；阶段 3 用户视角行 |
| page_kind / motif | §1 页面树每页标注 | 页面类型（list/detail/form/…）等价 |
| anchor + diverge | §4 共享件清单 + §3 组件白名单 | anchor 片建的样板与差异点 |
| knobs / visitor_mode | §5 状态与响应式 | 缺省用 craft-knobs 默认 |
| shell（产品改壳） | §1 页面树声明 | 「改壳」须显式声明 |
| change: refinement\|redesign | §6 需求覆盖矩阵 + change-control | 改存量页必须声明，非默认 |
| （本体系）组件白名单 | §3 组件白名单 | 实现阶段由 check_whitelist.py 机械核对 |

## 与 wish-programming 的分工

- 本 skill 管「设计质量」：阶段 2 规范单的正确产出姿势、字段门控、白名单、设计评审。
- wish-programming 管「流程」：阶段顺序、人闸、机械验收；本 skill 不重复这些。
- 设计类愿望的顺序：加载本 skill（阶段 2 前）→ 产出 design-spec.md（含备选方案节）→ 用户拍板 → 实现切片按白名单执行。

## 边界

- 只做设计与评审产出，不替代实现；不写业务代码。
- 验收/走查侧（不听设计的证伪与截图验收）→ `quality-review` skill。
- 调研/探索类任务不套本 skill（路由见 wish-programming「调研/评审模式分轨」）。
