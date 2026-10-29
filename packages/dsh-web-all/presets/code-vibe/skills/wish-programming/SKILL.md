---
name: wish-programming
description: 许愿编程/愿望/从零构建系统应用工具平台网站/继续完成补全收尾； Use when a user gives a high-level product wish expecting a runnable implementation (develop or build a system, app, tool, platform, or website without a detailed spec), or when continuing, finishing, or extending an existing implementation in this preset workspace.
---

# Wish Programming

把愿望变成可运行、可验证的最小可用产品。禁止用提案、脚手架或托管第三方生成器替代用户要的软件。

> **性质（诚实声明）**：本 skill 是纪律约定 + 便利脚本 + 组织模式，不是运行时强制。真正的强制来自：DSH 审批栈（人闸）、沙箱（写码授权）、plan mode（方案闸）。脚本只帮自律的 agent 不自欺——别把脚本当安全边界。防自欺的终局防线是真人 co-sign + 真实渲染（截图）+ 机械对照，不是 AI 评 AI。

## 原话优先原则（宪法）

用户原话是唯一 ground truth，高于一切转述、设计、评审结论：

1. **原话永不被改写**：愿望入库即把用户原话逐字落盘为 `docs/wish/<id>/quote.md`（一等工件）；下游产物只能「引用 + 解读」，不能「替代」。PM 转述必须标注，不得冒充原话。
2. **冲突时原话赢**：任何转述/设计/结论与原话冲突 → 以原话为准，冲突显式登记并回用户裁决，禁止静默覆盖。
3. **每道闸都对照原话**：确认包（§0 回显段）、需求清单（§0 原话节）、设计规范单（覆盖矩阵）、机械验收（落点核对）全部锚定原话。
4. **原话与理解并置**：确认包必须「你的原话 ↔ 我的理解」对照呈现，让用户低注意力也能发现语义漂移。
5. **原话外的定性词默认降级**：原话里没有的定性/范围词（如「推倒重画」）一律标〔PM 推断〕，未经用户确认不得进入任何下游承诺。

## 五阶段流程

> 质量内建在生成层，不靠事后检测。每一阶段的「质量后果」是它存在的唯一理由——说不出真实后果的环节，删。

### 阶段 1 · 需求理解（不拆，conductor 主上下文执行）

- 输入：`docs/wish/<id>/quote.md`（先读）+ 用户口述补充 + 存量页面/功能盘点（旧页面代码与现有入口）。
- 动作：对照原话逐句消化；盘点存量功能（升级/迁移/重设计类愿望必做，逐条编号 O1…）；按 `references/templates/requirements.md.tpl` 产出 `docs/wish/<id>/requirements.md`（需求清单 N 编号 + 存量功能清单 O 编号 + ≤3 个澄清问题 + 语义不变量）；按 `references/templates/confirmation-pack.md` 产出确认包（§0 原样回显原话 + 场景故事 + 〔原话〕/〔PM 推断〕标注 + PM 推断清单 + 拍板点）。
- 用 `references/roles/pm-reviewer.md` 作为**内建自查清单**（对照原话逐条核 + 存量保留核），不再单独派评审 agent。
- 用户确认（人闸 ①）→ `journey.sh --confirm --by <用户>` 落 `.confirmed` 工件并**锁定 quote.md 指纹**（`.quote-hash`）；quote.md 内容一旦被改动（含只改一字），check_spec 凭指纹拦截——**quote 更新流程：quote.md 版本 +1 → 下游（requirements/confirmation-pack/design-spec）重新对齐 → 重新 `--confirm`（重落指纹），三步缺一不可**。
- **质量后果**：需求从源头逐条有编号，存量功能逐条在案，后面一切对照它们——W3「4 项真丢」在此阶段就不可能被漏掉。

### 阶段 2 · 设计规范单（不拆，conductor 主上下文执行 + 用户拍板）

- 输入：requirements.md + 平台组件盘点（读组件目录与设计系统，列出可复用件）+ 用户认可的对标页面。
- 动作：按 `references/templates/design-spec.md.tpl` 产出 `docs/wish/<id>/design-spec.md`——页面树 / 每页区块 / 每块指定组件 / 组件白名单 / 共享件清单 / 状态与响应式断点 / 需求覆盖矩阵 / **备选方案 Alternatives considered**。一次连续思考完成，禁止拆给多个 agent。
- **前端/UX 类愿望必须先加载 `frontend-design`**：LOAD-MAP 字段门是硬门（Job Brief 三必填未齐不得定视觉）；其字段（UI surface/Design Read/page_kind/anchor/knobs）与本模板节（页面树/每页区块/白名单/…）的映射见 frontend-design SKILL.md「术语映射」节——两套术语在加载时对照执行，不各写各的。
- 用 `references/roles/design-reviewer.md` 作为内建自查清单。技术架构类愿望（迁移/拆分/选型）额外做 arch.md 包（`arch.md.tpl` + arch-reviewer 内建自查）；页面/前端类愿望不做。
- 用户对规范单（或线框）拍板（人闸 ②）。
- **质量后果**：全部设计决策集中一次锁死；实现切片零设计决策权，互抄与口径漂移从机制上消失。

### 阶段 3 · 实现（按页面族拆 2~4 片）

- 第一片 = anchor（pro）：先建共享件 + 一个完整页面样板，锁模式。
- 后续片：按 `references/templates/brief.md.tpl` 派发，brief 只含 规范单引用 + 本片页面清单 + 组件白名单；默认 flash。
- **禁发明（硬规则）**：新组件/新布局/新样式是需要用户拍板的例外；禁止手写等价实现绕过白名单组件。
- 每片完成即保持可运行；lint/type-check 每片必过（journey `--assert lint|typecheck --dir <切片>`）。
- 每个切片 brief 必含：规范单引用 + 本片页面清单 + 组件白名单 + 原话对照 + **用户视角行**（目标用户是谁 + 做完后用户能看到/感受到什么变化；本片无用户可见面则显式说明）。
- **质量后果**：复用是默认动作；一致性由白名单机械保障；页面族共享一份规范与样板，不再各画各的。

### 阶段 4 · 机械验收（独立 agent，只做对照）

- **先加载 `quality-review`**：其证伪纪律与证据契约适用本阶段（先证伪再 Pass；Evidence Kind 与 coverage.tsv 的对接见 quality-review SKILL.md「证据落点对接」节）。
- 独立 fresh subagent（deny 写工具）执行：
  1. **需求落点核对**：requirements.md 每条 N → 在新页面找落点，逐条回填；
  2. **存量落点核对**：每条 O → 新落点 + 证据，写成 `.sdd/acceptance/<id>/coverage.tsv`，`coverage_check.py` 机械数数——缺条目 exit 1；
  3. **多视口真实渲染**：1280/1440/窄分栏三视口截图落 `.sdd/acceptance/<id>/shots/`——**文件名以前缀标记**（`1280-` / `1440-` / `narrow-`，如 `1280-home.png`），**必须为 PNG 且实际像素宽度落在对应视口物理范围**（1280-* ≥1200px / 1440-* ≥1366px / narrow-* ≤1000px；容差覆盖 retina 2x）——同图复制冒充三视口、非浏览器产物都会被 width 断言拦下。非 UI 愿望（纯后端/库）在确认阶段用 `journey.sh --confirm --by <用户> --no-ui` 显式声明豁免截图（`.no-ui` 文件，用户动作，不做默认）——豁免仅跳过截图，coverage.tsv 照查；
  4. **证伪刀**：按 falsify-checklist 默认证伪刀（翻页/无界滚动/表单/边界）至少一刀，失败 = Fail，不许 smoke 覆盖。
- **质量后果**：丢功能、不响应式在交付前被数出来，不是用户投诉后发现。

### 阶段 5 · 用户 judge（真实渲染迭代）

- 用户看截图说「丑/挤/不对」→ 改 → 再截图，循环到点头。
- 代码交付前：加载 `code-review` 做切片评审（缺陷+位置+影响+证据；门禁已覆盖的不重复提）；验收包按 `quality-review` 的 human-acceptance-pack 格式组织（产品级验收证据，与实证截图对应）。
- 用户批准 → `journey.sh --approve --by <用户>` 落 `.approved`，然后 `--transition acceptance-passed`。
- **质量后果**：用户反馈从「交付后投诉」变成「交付前迭代」。

### 迷你复盘（用户打回 ≥2 次时）

阶段 5 被打回 ≥2 次 → 写 `.sdd/acceptance/<id>/mini-postmortem.md`：哪道闸漏了（确认门/规范单/白名单/验收/截图）→ 为什么漏 → 补什么防线（回写 SKILL.md / check_spec / 模板）。只有重复出现的失败模式才写（防复盘通胀）；单次打回不写。

## 拆分原则

- **按认知边界拆，不按页面/文件拆**：需求理解不拆；设计决策不拆；实现按页面族拆（2~4 片）；验收机械拆。
- **设计中心化、实现分布式**：切片 agent 零设计决策权。
- **共享件先行**：anchor 片先建共享件与样板，后续片只用不造。
- **并行只在实现层**：阶段 1/2 串行（质量核心），阶段 3 并行（机械铺开）。
- **委托判据（反割裂）**：见 `agent-operation` skill——绝不委托需求理解、设计决策、产品判断、方案收敛；conductor 本身就是 pro，这些环节自己执行。

## 减法与通用纪律（引用）

- 涉及既有代码/存量逻辑：优先净删除；候选三态（不可达行为/收窄行为显式损失/证据不足）；「把复杂度搬家不算简化」——加载 `dsh-find-simplifications`。
- 模型路由（继承优先、同族换档）与委托判据：加载 `agent-operation`。
- 写作/措辞/确认包语言：加载 `dsh-prose-standard`（原话/〔PM 推断〕标注之外的通用文案纪律，含思维链泄漏清理 `dsh-trim-cot-leakage`）。
- 切片测试可靠性：加载 `dsh-ci-test-reliability`（防 flake、确定性、负对照）。

## 报告协议（防假报绿）

- **通用报告纪律（只报实跑命令、pending 报 pending、retries/skips 不称 passing）见 `agent-operation`「报告纪律」——本节点它的名，不重复全文。**
- 流程特有部分：`journey.sh --confirm/--approve --by <用户>` 只能由用户在确认交互中提供；agent 不得代填「用户已确认」；未运行的验证报告为 pending。

## 门禁与脚本

```bash
WISH="<预设>/scripts/wish.sh"          # --new --title "…" [--quote "用户原话"]；--start <id>
CHECK="<预设>/scripts/check_spec.py"   # <ws> <id> [--phase design|build|close]：机械结构门（下限，不是质量）
COVER="<预设>/scripts/coverage_check.py"  # <ws> <id>：存量功能落点完整性（阶段 4 用）
JOURNEY="<预设>/scripts/journey.sh"    # --confirm/--approve/--status/--transition acceptance-passed|blocked|stuck [--root <dir>]
```

- 人闸工件：`.sdd/acceptance/<id>.confirmed`（阶段 1 后）、`.sdd/acceptance/<id>.approved`（阶段 5 后）、`.sdd/acceptance/<id>.no-ui`（非 UI 愿望的截图豁免声明，仅 `--confirm --no-ui` 时生成）。
- 终态：`acceptance-passed | blocked（可复现外部阻断）| stuck（修复预算耗尽）`；blocked/stuck 仅人 `--set` 恢复。`--transition acceptance-passed` 无验收证据（`.sdd/acceptance/<id>/` 与 `.no-ui` 均缺）→ 机械拒绝。
- `--assert deploy` 永远失败：生产动作必须本回合真人授权。
- gate-lock：改 scripts/ 后必须重跑 `gate-lock.sh`，否则 verify/journey 拒信。

## 仓库体系路由规则（既有权威仓库适用）

工作区是带权威 AGENTS.md 与四维 docs 体系的既有仓库（如 data-sage）时：
1. 本预设 = 前置理解层（原话锚定 + 需求清单 + 设计规范单）；
2. 最终交付走仓库既定轨（vibe-coding 五件套 `docs/specs/<id>/`）；禁止从愿望直接编码；条件式降级：插件不可用时本预设闸门承担全责并向用户明示；
3. 回填对齐仓库回填矩阵与 handoff 纪律，不另立第二套。

## 调研/评审模式分轨

调研、探查类任务不套五阶段：产出白名单 = findings + Gap 登记 + 方向缺口对照表；禁越界产出新蓝图。调研前强制读已立项产品方向文档；结论逐条标 符合/偏离/缺口。

## 产品判断软约束

1. 先问再画：答不全「谁用、干什么、何时用、现在怎么解决」先问 1~3 个澄清。
2. 用户视角是必选维度：persona × 任务旅程组织发现。
3. 决策点只允许「用户价值取舍」；权限/技术决策内部收敛。
4. 自助耗尽再升级：凭证/账号/环境先耗尽 .env*/种子/历史会话/memoir/artifacts；技术验证（lint/浏览器/登录）是 agent 职责，永远不是暂停点。
5. 单点阻塞不停摆：blocked 切片挂起、其余继续，并行汇报。
6. 主对话常驻语义不变量清单（含 Out-of-scope 一句话版）。

## 模型路由

完整路由表与委托判据见 `agent-operation` skill（继承优先、同族换档；拿不准就继承；不跨族）。

## Delivery target

| Target | 含义 |
|---|---|
| code-ready | 代码+契约完成，未部署 |
| dev-effective | dev/preview 真实可用 |
| production-delivered | 生产真实可用（目标环境 smoke 后） |

`acceptance-passed` 是完成声明不是交付目标；上生产永远需要本回合真人授权。

## Construction channel（谁做什么）

| 工作 | 谁 |
|---|---|
| 需求理解、设计规范单、拆分、裁决 | conductor（pro） |
| 确认门 / 最终验收 | 用户（人闸，judge） |
| 实现切片 | 按页面族拆 2~4 片，anchor 先行；conductor 主上下文推进或用浅层 subagent 并行；workflow 仅用户点名时用 |
| 机械验收对照 | 独立 fresh subagent（deny 写工具） |
| 门禁脚本运行与证据合成 | conductor |
| 长跑修复 | goal 续跑；ralph 仅用户点名 |
