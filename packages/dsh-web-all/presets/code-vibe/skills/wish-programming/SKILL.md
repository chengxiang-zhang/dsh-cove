---
name: wish-programming
description: Use when a user gives a high-level software product wish and expects a runnable implementation, including requests to develop or build a system, application, tool, platform, or website without a detailed specification. Also use when continuing, finishing, or extending an existing implementation in this preset's workspace (e.g. "继续完成 / 补全 / 收尾" a spec, feature, or module).
---

# Wish Programming

> **Entry tier: T2-wish / T3-wish only.** T0/T1 use `fix-loop`; T2 backend/data use `change-spec`; T3 program uses `large-backlog-program` + `agent-team-project-loop`. Do not run this five-stage path for small changes.

## 产品理解门（仅 T2-wish / T3-wish）

设计类愿望（页面/前端/设计/体验/对标/重设计/IA/模块归属/迁移/拆分/选型）在**任何实现派工之前**先产出三段并等用户确认：
① 目标复述（用户原话逐字并置 + 你的理解）；② 模块定位陈述（求纠偏）；③ 方案预览。未确认前 subagent 只能做只读调研。
小改版（单页面族/单模块）走**短路径**：原话 + 简版需求 + 一页设计规范 → 实现 → 机械验收 → 用户看一次；
大改版（>4 页面族/多天）走**全路径**（六阶段 + journey 人闸）。

## PM 前台规范

- 决策点只允许"用户价值取舍"（新手 vs 老手、开放 vs 管控、快 vs 全）；权限/技术决策团队内收敛。
- 技术验证（lint / type-check / 浏览器走查 / 登录检查）是 agent 职责，不是暂停点、不提问。
- 自助耗尽再升级：凭证/账号/环境先查 `.env*`、seed、历史会话、memoir；确无才用一个精确请求升级。
- 单点阻塞不停摆：挂起 blocked 切片，其余继续，并行汇报；按用户可感知里程碑汇报。
- 构建系统/应用/工具/平台时先加载本 skill，再考虑其它构建类 skill；不得路由到托管生成器（Lark/Feishu/Miaoda 等），除非用户点名。
- 完成要求可运行结果 + 真实验收证据，不是只有设计或脚手架。

把愿望变成可运行、可验证的最小可用产品。禁止用提案、脚手架或托管第三方生成器替代用户要的软件。

> **性质（诚实声明）**：本 skill 是纪律约定 + 便利脚本 + 组织模式，不是运行时强制。真正的强制来自：DSH 审批栈（人闸）、沙箱（写码授权）、plan mode（方案闸）。脚本只帮自律的 agent 不自欺——别把脚本当安全边界。防自欺的终局防线是真人 co-sign + 真实渲染（截图）+ 机械对照，不是 AI 评 AI。

## 原话优先原则（宪法）

用户原话是唯一 ground truth，高于一切转述、设计、评审结论：

1. **原话永不被改写**：愿望入库即把用户原话逐字落盘为 `docs/wish/<id>/quote.md`（一等工件）；下游产物只能「引用 + 解读」，不能「替代」。PM 转述必须标注，不得冒充原话。
2. **冲突时原话赢**：任何转述/设计/结论与原话冲突 → 以原话为准，冲突显式登记并回用户裁决，禁止静默覆盖。
3. **每道闸都对照原话**：确认包（§0 回显段）、需求清单（§0 原话节）、设计规范单（覆盖矩阵）、机械验收（落点核对）全部锚定原话。
4. **原话与理解并置**：确认包必须「你的原话 ↔ 我的理解」对照呈现，让用户低注意力也能发现语义漂移。
5. **原话外的定性词默认降级**：原话里没有的定性/范围词（如「推倒重画」）一律标〔PM 推断〕，未经用户确认不得进入任何下游承诺。

## 六阶段流程

> 质量内建在生成层，不靠事后检测。每一阶段的「质量后果」是它存在的唯一理由——说不出真实后果的环节，删。

### 阶段 1 · 需求理解（不拆，conductor 主上下文执行）

- 输入：`docs/wish/<id>/quote.md`（先读）+ 用户口述补充 + 存量页面/功能盘点（旧页面代码与现有入口）。
- 动作：对照原话逐句消化；盘点存量功能（升级/迁移/重设计类愿望必做，逐条编号 O1…）；按 `references/templates/requirements.md.tpl` 产出 `docs/wish/<id>/requirements.md`（需求清单 N 编号 + 存量功能清单 O 编号 + ≤3 个澄清问题 + 语义不变量）；按 `references/templates/confirmation-pack.md` 产出确认包（§0 原样回显原话 + 场景故事 + 〔原话〕/〔PM 推断〕标注 + PM 推断清单 + 拍板点）。
- 用 `references/roles/pm-reviewer.md` 作为**内建自查清单**（对照原话逐条核 + 存量保留核），不再单独派评审 agent。
- 用户确认（人闸 ①）→ `journey.sh --confirm --by <用户>` 落 `.confirmed` 工件。
- **质量后果**：需求从源头逐条有编号，存量功能逐条在案，后面一切对照它们——W3「4 项真丢」在此阶段就不可能被漏掉。

### 阶段 2 · 设计规范单（不拆，conductor 主上下文执行 + 用户拍板）

- 输入：requirements.md + 平台组件盘点（读组件目录与设计系统，列出可复用件）+ 用户认可的对标页面。
- 动作：按 `references/templates/design-spec.md.tpl` 产出 `docs/wish/<id>/design-spec.md`——页面树 / 每页区块 / 每块指定组件 / 组件白名单 / 共享件清单 / 状态与响应式断点 / 需求覆盖矩阵。一次连续思考完成，禁止拆给多个 agent。
- 用 `references/roles/design-reviewer.md` 作为内建自查清单。技术架构类愿望（迁移/拆分/选型）额外做 arch.md 包（`arch.md.tpl` + arch-reviewer 内建自查）；页面/前端类愿望不做。
- 用户对规范单（或线框）拍板（人闸 ②）。
- **质量后果**：全部设计决策集中一次锁死；实现切片零设计决策权，互抄与口径漂移从机制上消失。

### 阶段 3 · 实现（按页面族拆 2~4 片）

- 第一片 = anchor（pro）：先建共享件 + 一个完整页面样板，锁模式。
- 后续片：按 `references/templates/brief.md.tpl` 派发，brief 只含 规范单引用 + 本片页面清单 + 组件白名单；默认 flash。
- **禁发明（硬规则）**：新组件/新布局/新样式是需要用户拍板的例外；禁止手写等价实现绕过白名单组件。
- 每片完成即保持可运行；lint/type-check 每片必过。
- **质量后果**：复用是默认动作；一致性由白名单机械保障；页面族共享一份规范与样板，不再各画各的。

### 阶段 4 · 机械验收（独立 agent，只做对照）

- 独立 fresh subagent（deny 写工具）执行：
  1. **需求落点核对**：requirements.md 每条 N → 在新页面找落点，逐条回填；
  2. **存量落点核对**：每条 O → 新落点 + 证据，写成 `.sdd/acceptance/<id>/coverage.tsv`，`coverage_check.py` 机械数数——缺条目 exit 1；
  3. **多视口真实渲染**：1280/1440/窄分栏截图落 `.sdd/acceptance/<id>/shots/`（浏览器证据才算用户可见验收）；
  4. **端到端浏览器走查（E2E，不是截图）**：`.sdd/acceptance/<id>/e2e/` 三件套——`steps.md`（≥2 条编号步骤）+ `run.log`（真实浏览器通道逐步输出）+ 至少一张截图。首屏截图、`curl /health`、单测绿、接口 JSON 都不算；缺三件套不得宣称验收完成，`check_spec --phase close` 会拦。
- **质量后果**：丢功能、不响应式、没真点过一遍，都在交付前被数出来，不是用户投诉或提醒后才发现。

### 阶段 5 · 用户 judge（真实渲染迭代）

- 用户看截图说「丑/挤/不对」→ 改 → 再截图，循环到点头。
- 用户批准 → `journey.sh --approve --by <用户>` 落 `.approved`，然后 `--transition acceptance-passed`。
- **质量后果**：用户反馈从「交付后投诉」变成「交付前迭代」。

### 阶段 6 · 发布（交付目标为 dev-effective / production-delivered 时）

- 计划期就把目标写进 `docs/wish/<id>/delivery.md`（`Target:` + 目标环境 + 回滚点）；目标含 production 时，发布轨从第一天就在关键路径上，不是验收后的可选项。
- `acceptance-passed` ≠ 已上线。上线走 `release-gate`：P2 发布方案 + P3 验证方案 → `journey.sh --authorize-deploy --by <用户> --quote "<原话>"`（一次授权）→ 执行 → `release_check.py <ws> <id> --run` 全 PASS 才是 `production-delivered`。
- 用户问「能上线了吗 / 上线前检查 / 发布前还有什么问题」时**先跑 `release_check.py` 再回答**：表就是答案。缺项要么当场补（代码没 push、没构建、没 E2E、没回滚点都属于我们自己的欠账），要么一句话说清等的是哪一次用户授权。
- **为什么有这一段**：2026-11-08 的真实会话跑完五阶段后代码没上生产，用户问「具备全量上线条件了吗」，得到的是「生产还在跑旧代码 / 没有回滚演练 / 告警没验证」一串流程欠账——发布不是验收后另起一件事，它本身就是交付目标的一部分。

## 拆分原则

- **按认知边界拆，不按页面/文件拆**：需求理解不拆；设计决策不拆；实现按页面族拆（2~4 片）；验收机械拆。
- **设计中心化、实现分布式**：切片 agent 零设计决策权。
- **共享件先行**：anchor 片先建共享件与样板，后续片只用不造。
- **并行只在实现层**：阶段 1/2 串行（质量核心），阶段 3 并行（机械铺开）。
- **委托判据（反割裂）**：subagent/workflow 只用于「不需要你的上下文就能执行的活」——照锁定规范机械实现、独立验收（fresh 上下文是优点）、并行可分的调研收集。**绝不委托**需求理解、设计决策、产品判断、方案收敛——它们靠主上下文活着，委托即割裂；conductor 本身就是 pro，这些环节自己执行。

## 门禁与脚本

```bash
WISH="<预设>/scripts/wish.sh"          # --new --title "…" [--quote "用户原话"]；--start <id>
CHECK="<预设>/scripts/check_spec.py"   # <ws> <id> [--phase design|build|close]：机械结构门（下限，不是质量）
COVER="<预设>/scripts/coverage_check.py"  # <ws> <id>：存量功能落点完整性（阶段 4 用）
JOURNEY="<预设>/scripts/journey.sh"    # --confirm/--approve/--status/--transition acceptance-passed|blocked|stuck
RELEASE="<预设>/scripts/release_check.py"  # <ws> <id> --run：发布轨机械门（阶段 6 用；未全 PASS 不得报 production-delivered）
```

- 人闸工件：`.sdd/acceptance/<id>.confirmed`（阶段 1 后）、`.sdd/acceptance/<id>.approved`（阶段 5 后）。
- 终端态：`acceptance-passed | blocked（可复现外部阻断）| stuck（修复预算耗尽）`；blocked/stuck 仅人 `--set` 恢复。
- 发布：`journey.sh --authorize-deploy --by <用户> --quote "<原话>"` 落授权工件；`--assert deploy` 只认「发布方案 + 授权」同时存在；`--assert claim-deliver` 在 `TARGET=production` 时必须 `release_check.py --run` 全 PASS。
- gate-lock：改 scripts/ 后必须重跑 `gate-lock.sh`，否则 verify/journey 拒信。

## 仓库体系路由规则（既有权威仓库适用）

工作区是带权威 AGENTS.md 与四维 docs 体系的既有仓库（如 data-sage）时：
1. 本预设 = 前置理解层（原话锚定 + 需求清单 + 设计规范单）；
2. 最终交付走仓库既定轨（vibe-coding 五件套 `docs/specs/<id>/`）；禁止从愿望直接编码；条件式降级：插件不可用时本预设闸门承担全责并向用户明示；
3. 回填对齐仓库回填矩阵与 handoff 纪律，不另立第二套。

## 调研/评审模式分轨

调研、探查类任务不套六阶段：产出白名单 = findings + Gap 登记 + 方向缺口对照表；禁越界产出新蓝图。调研前强制读已立项产品方向文档；结论逐条标 符合/偏离/缺口。

## 产品判断软约束

1. 先问再画：答不全「谁用、干什么、何时用、现在怎么解决」先问 1~3 个澄清。
2. 用户视角是必选维度：persona × 任务旅程组织发现。
3. 决策点只允许「用户价值取舍」；权限/技术决策内部收敛。
4. 自助耗尽再升级：凭证/账号/环境先耗尽 .env*/种子/历史会话/memoir/artifacts；技术验证（lint/浏览器/登录）是 agent 职责，永远不是暂停点。
5. 单点阻塞不停摆：blocked 切片挂起、其余继续，并行汇报。
6. 主对话常驻语义不变量清单（含 Out-of-scope 一句话版）。

## 模型路由

**默认继承，换能力靠换工具**——原则指导，不是死表。

- 默认：本地子代理（`subagent` / `subagent_fork`）**没有** `model`/`provider` 参数，天然继承本会话。拿不准就继承。
- 要换能力：两个外部委派工具按 `model` 选档 —— `subagent_codex` 省略 `model` 即 `gpt-6-astra`；`subagent_claude_code` 取 `kaon/claude-opus-5-5`（最强）/ `kaon/claude-sonnet-5-5`（均衡）/ `kaon/claude-haiku-5-5`（最快最便宜）。取值必须是 profile 为这个工具列出的 id，否则在参数校验层被拒。
- 换族（DeepSeek ↔ Codex ↔ Claude）等于**换工具**，不是传 `provider`：这两个工具都没有 `provider` 参数。
- 派发不等答案：`wait_ms`（默认 15 秒）之后回 `status: running`，用 `external_session_wait` 收；把等待当成下一件事在跑，而不是本回合结束。
- 不要因为目录里还有别的族就随便跳；换族仅当用户点名，或任务明显依赖该族专长，并在回执里写明换了哪个工具、为什么。

| 任务倾向 | 建议 |
|---|---|
| 需求/设计/裁决/语义敏感/高风险 | 继承；需要外部强判断时 `subagent_codex` 或 `subagent_claude_code` + 强档 model |
| 机械切片 / 证据收集 / 回填（窄 I/O） | 继承；必要时 `subagent_claude_code` + `kaon/claude-haiku-5-5` |
| 开放式设计判断 | 不要丢给快档 |

## Delivery target

| Target | 含义 |
|---|---|
| code-ready | 代码+契约完成，未部署 |
| dev-effective | dev/preview 真实可用 |
| production-delivered | 生产真实可用（目标环境 smoke 后） |

`acceptance-passed` 是完成声明不是交付目标；上生产的授权一次、本会话内执行，流程见 `release-gate`。目标为 production 时「上线前检查」= 跑 `release_check.py` 并贴表，禁止用散文结论代替。

## Construction channel（谁做什么）

| 工作 | 谁 |
|---|---|
| 需求理解、设计规范单、拆分、裁决 | conductor（pro） |
| 确认门 / 最终验收 | 用户（人闸，judge） |
| 实现切片 | 按页面族拆 2~4 片，anchor 先行；conductor 主上下文推进或用浅层 subagent 并行；workflow 仅用户点名时用 |
| 机械验收对照 | 独立 fresh subagent（deny 写工具） |
| 门禁脚本运行与证据合成 | conductor |
| 长跑修复 | goal 续跑；ralph 仅用户点名 |
