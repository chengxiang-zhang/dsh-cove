# LOAD-MAP（任务 → 必读）

> **有 UI 施工时先读本表再开写。** 不读本表 = 未执行 design-standards。
> 路径均相对 `skills/vibe-coding/references/design-standards/`。
> **字段×Rail 强度、豁免、场景必读：只以本文件为准**；其它册/Skill 只链到这里，勿另写强度表。
> `pages/` · `components/` · `surfaces/` 已归档（`references/_archive/design-standards/`）；施工以本表字段门 + 下列保留册为准，不再按页种/控件册展开。

## 字段门控（唯一真源）

| 字段 | Shape | Plan（`check_spec`） | Build |
|------|-------|----------------------|-------|
| **Job Brief**（见 [product-judgment.md](./product-judgment.md)） | **必须**（有 UI） | **warn** 若缺 | **必须** |
| `UI surface` | **必须** | **fail** 若缺 | **必须** |
| Design Read | **必须**（有 UI） | **warn** 若缺 | **必须** |
| `page_kind` 或 `motif` | 有具体页则必须 | **warn** 若缺（二者等价） | **必须** |
| `anchor` + `diverge` | 可后置到切片收敛 | **warn**（Build 前须补） | **必须** |
| knobs / `visitor_mode` | 建议 | 建议（缺则用 craft-knobs 默认） | 缺则用默认 |
| `shell`（product 改壳） | 建议 | **warn** 若疑改壳却未声明 | **必须** |
| `change: refinement\|redesign` | 改存量时声明 | 改存量时声明 | 改存量时 **必须** |

`motif:` 与 `page_kind:` **等价**（consumer 可写 `motif: growth` 或 `page_kind: growth`）。

**硬门（顺序）：**

1. Job Brief 三必填（Job / Desired outcome / Consequence）未齐 → **不得**定视觉、不得输出线框当定稿、不得写新页业务 UI（应先问清）。见 [product-judgment.md](./product-judgment.md)。
2. 未声明 surface / 未写 Design Read → **不得定视觉方向、不得写新页业务 UI**。
3. Build 前未写可用 anchor → **不得定视觉实现方向**（可先写 IA/文案结构）；见 [anchor.md](./anchor.md)。

## 豁免（缩读）

| 情形 | 仍须 | 可跳过 |
|------|------|--------|
| trivial：笔误 / 单点 CSS / 已知单控件 bug（不改合同·导航·跨面入口·权限可见性） | 输出前 [ai-tells](./audit/ai-tells.md) 抽一眼 | 完整前缀、Job Brief 重写、ui-page-gate、新 anchor |
| **Polish / 非 material refinement**（见 [change-control.md](./change-control.md) §3；须写码硬闸 (c)） | ai-tells；声明 `change: refinement`；沿用已有 Job Brief（无则从界面推断并标假设） | 新 Spec、完整产品包、完整页面评审、重写 Design Read / Job Brief、新 anchor |
| 已有 Spec 内的非 material UI 修补（Repair / 批内抛光） | 同上 + 对照既有 Job Brief | 新开另一份 Spec |

触及导航 / 跨表面入口 / 主任务路径 / shell / visitor_mode / **权限或分发模型** 大改 → **非豁免**，走完整前缀（含 Job Brief）；不得用 Polish 话术绕过。

## 每次有 UI 的固定前缀（非豁免）

0. **[product-judgment.md](./product-judgment.md)** — Job Brief + 人话验收；**IA / 交互单位先于视觉**
1. [craft-knobs.md](./craft-knobs.md) — **Design Read** 一行；建议 visitor_mode + variance/motion/density
2. [anchor.md](./anchor.md) — 写下 anchor / diverge（Shape 可后置；**Build 前必须**）
3. 定 `UI surface` + `page_kind`/`motif`（值写进合同；细则不再分册）
4. [tokens/](./tokens/)（有宿主 DS 则只遵角色与禁令）
5. [audit/ai-tells.md](./audit/ai-tells.md) — **输出前再扫一遍**

改已有 UI 先读 [change-control.md](./change-control.md)。
写页面前评审输出模板 → [ui-page-gate.md](./ui-page-gate.md)（加载义务仍以本表为准；评审块须含 Job Brief）。

## 按场景加读

| 你在做什么 | 必读（按序） |
|------------|--------------|
| 判定 B/C、写切片 | **product-judgment** → craft-knobs；声明 surface + page_kind/motif |
| **配置 / 授权 / 分发** | **product-judgment** → [copy](./copy.md) |
| 新建/改应用壳 | product-judgment → change-control；合同写 `shell:` |
| **列表 / 详情 / 设置 / 看板 / 表单 / C 端主路径** | product-judgment → craft-knobs → ai-tells；合同写 `page_kind`/`motif` |
| Modal / Sheet / Drawer / 批量 | product-judgment → copy（先定交互单位，再选容器） |
| 文案/错误/空态 | [copy](./copy.md) |
| UI 回归 / AI 脸 | [debug-playbook](./debug-playbook.md) → ai-tells |
| 对照好坏 | [exemplars](./exemplars/README.md) |
| 按需索引 | [tokens/README](./tokens/README.md) · 本表 |

## 按 Rail（摘要；强度见上表）

| Rail | 动作 |
|------|------|
| Shape | **先 Job Brief**；写 Design Read；必须 surface；有具体页则 page_kind/motif；knobs 建议；anchor 可后置 |
| Plan | 合同写 Job Brief + surface；page_kind/motif + Design Read + anchor 建议（机检 warn）；架构边界点名服从本包 |
| Build | **Job Brief 齐全** + **本表场景行** + 需要时 ui-page-gate 评审模板；改存量先 change-control；确认前不写页 |
| Verify | 同 surface/page_kind；**先证伪**（testing/falsify-checklist）；对照人话验收 / Job；ai-tells + copy 抽检；有界轮次见 testing/bounded-verify；list/dashboard 须 api-diff/network-har |

## 禁止

- 跳过 product-judgment / Job Brief，直接 tokens 开画
- 只读 [visual.md](./visual.md) / [ux.md](./ux.md) 开头就开写（二者是原则索引，非施工入口）
- 跳过 Design Read / surface 用「现代干净」代替
- Build 前跳过 anchor 用空话形容
- 把已归档 pages/components/surfaces 当必读再展开施工
- UI/验收使用实现黑话（主体、投影未完成、registry…）冒充产品语言
