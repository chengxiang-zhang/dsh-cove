---
name: design-orchestrator
description: Use at the START of any design request (设计/方案/架构/IA/交互/视觉/UX/商业/选型/重构/迁移) — decides which design layers apply, the level L1/L2/L3, required artifacts, reviewers, and the freeze point that must exist before implementation. It does not design by itself; it routes to the independent design skills and enforces completeness (not quality). Do NOT use for pure execution when a frozen design already exists.
---

# 设计编排（Design Orchestrator）

> 唯一入口：**先判层、定档、列件、定评审、定冻结，再分派领域 skill**。
> 机械只查"完整性/可追溯"；**质量由评审角色判断 + 用户确认**，不做设计评分。

## 1. 判层（8 层，可多选）

`商业 business` / `产品 product` / `信息架构 ia` / `交互视觉 visual` / `用户体验 ux` / `架构 arch` / `技术 tech` / `选型 selection`

判据（任一命中即纳入该层）：

- 商业：谁付钱、定价、渠道、伙伴、单位经济 → `business-design`
- 产品：做什么、范围、优先级、验收语义 → `product-design`
- IA：东西放哪/叫什么、导航/分类/用户找得到 → `information-architecture`
- 交互视觉：载体/流程/状态/视觉方向/设计系统 → `interaction-visual-design`
- UX：用户研究、可用性、体验度量 → `ux-research`
- 架构：系统结构、边界、质量属性、演进时机 → `architecture-design`
- 技术：接口/数据/迁移/回滚怎么落 → `tech-design`
- 选型：A vs B、要不要迁移/换底座 → `tech-selection`

**不设计的反例**（必须显式声明 design=off）：既有模式复制、单文件可回滚小修、纯调研、设计已冻结直接施工。

## 2. 定档（强度）

| 档 | 适用 | 必做层 | 预算 | 用户确认 |
|---|---|---|---|---|
| L1 轻设计 | 单页/单组件/局部体验 | 交互视觉（或 IA 微调） | ≤0.5 天 | 可选 |
| L2 产品设计 | 一条旅程/单模块新功能 | 产品 + IA + 交互视觉（+UX 按需） | 1–3 天 | **必须** |
| L3 系统设计 | 跨模块/跨仓/架构演进/重大选型 | 全部适用层 + ADR | 3 天+ | **必须** |

升档：D2=2（跨模块/契约/数据/权限）、D3=2（不可逆）、D4=2（要拍板）、D5=2（多团队）任一 ⇒ ≥L2；D1=2 且 D2=2 ⇒ L3。

## 3. 列件（产物清单，放仓库 `docs/design/<id>/`）

必填按档：L1 = `brief.md` + `design.md` + `freeze.md`；L2 = `brief/product/ia/design/review/freeze`；L3 = 适用层 + `adr/` + `review.md` + `freeze.md`。
完整清单见 `references/artifacts.md`。

## 4. 并行评审协议（fresh context，禁止互相看结论）

**派工方式**：按层并行 `subagent`（每个 fresh 上下文），一个 reviewer 一个 subagent；Lead 不替 reviewer 写结论。

**派工可选外部强 agent**：需要独立强判断时（L3、或本轮结论要冻结/进 ADR），reviewer 可以是外部 agent —— `subagent_astra` 与 `subagent_opus55` 并行两路，packet 与路由规则见 `design-dispatch`。外部结论与本地 reviewer 同权，都是输入；Lead 写裁决，且必须区分已证实/推断/未证实。

每个 reviewer 的 brief 只含：
1. 本层 artifact 路径（只读，禁止修改）；
2. 自己的判据清单（`references/reviewers.md` 对应行）；
3. 输出格式：`结论（通过/带条件/退回）+ 逐条判据 + 未决`，写入指定的 `review.<role>.md` 临时文件或消息返回。

**禁止**：reviewer 看其他 reviewer 的结论、改设计件、扩大评审范围。
**取数**：reviewer 优先 `read/glob/grep/read_image`；需要命令读数时请 Lead 代跑（review 上下文可能被门禁限制 bash），不要自己绕门。
**聚合**：Lead 收齐后合并为 `review.md`，冲突列"分歧"，交用户确认；L2/L3 用户确认后才写 `freeze.md`。

## 4.1 定评审（agent 扮演 + 用户确认）

按层派 reviewer（可并行、可 fresh context）：`pm-reviewer`、`ux-reviewer`、`ia-reviewer`、`design-reviewer`、`arch-reviewer`、`sre-reviewer`、`security-reviewer`、`tech-lead-reviewer`。
每份评审写 `review.md`：角色 / 判据逐条 / 结论（通过/带条件/退回）/ 未决。L2/L3 汇总后**请用户确认**。

## 5. 冻结（施工前置）

`freeze.md` 必须含：版本、各产物 sha256、评审结论、未决与已接受风险、**用户确认记录**（L2/L3）。
施工只认冻结版本；设计变更 → 新 ADR + 重新冻结。

## 6. 机械 vs 判断（边界）

- 可机械查：文件齐、必填非空、ADR 编号/状态、freeze 哈希、review 有角色/结论、设计阶段无实现代码（PoC 需标注）。
- 不可机械查：设计好坏、洞察、取舍、美感、可用性、架构优雅度 → **只由评审 + 用户判断**。

## 7. 执行顺序

1. 读需求原话 → 判层 + 定档 + 声明 design=on/off（4 行）；**建 `docs/design/<id>/brief.md` 时第一段必须写 `level: L1|L2|L3`**（完整性门靠它判必填件）；
2. 加载对应领域 skill（可多个），产出该层最小件；
3. 派 reviewer 评审 → `review.md`；
4. 用户确认（L2/L3）→ `freeze.md`；
5. 交接施工（change-spec / large-backlog-program / fix-loop），引用冻结版本。
