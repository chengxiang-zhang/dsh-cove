# UPSTREAM — 搬运来源记录（vendor 台账）

本目录中 `agent-experience`、`dsh-ci-test-reliability`、`dsh-find-simplifications`、`dsh-merging-stacked-prs`、`dsh-prose-standard`、`dsh-speed-up-perf`、`dsh-trim-cot-leakage`、`record-browser-gif` 八个 skill 搬运自 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 `.agents/skills/`。

## 许可

- 上游：**MIT License**，Copyright (c) 2026 DeepSeek。
- 完整版权声明、许可文本与免责声明随包置于 [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。

## 搬运基线

- 上游 commit：`00102833dfaee1da9f48a3a8eae9d34005a75218`（2026-09-22，release-dsh-0.1.7-alpha.2）
- 搬运日期：本仓库会话（code-vibe 预设提升，方案 v2 的 E 组）
- 维护模式：**单向 vendor**——上游更新时手动对比 diff、选择性同步（见本文件的搬运基线与改动总则）；本地改造不回推上游。

## 改动总则（每个被搬 skill 统一执行）

1. 整目录拷贝（含 references/、scripts/ 子目录），目录名保留 `dsh-` 前缀；
2. **引用修复**：指向上游仓库的文档/决策记录链接（`../../../docs/*`、`../../../AGENTS.md`、`../../notes/*`、`packages/`、`benchmarks/`、`snapshots/`）改写为自包含一句话，并标注「源自 DeepSeek Harness」；skill 互引（`../dsh-*/SKILL.md`）保留（整体搬入后相对路径仍有效）；references/ 子目录里的历史出处链接转为纯文本「（上游决策档案）」；
3. **provenance 头注**：每篇 SKILL.md 在 frontmatter 内（`---` 闭合前、description 等字段之后）插入 HTML 注释（上游路径 + commit SHA + MIT 声明）——yaml 解析实测兼容（eemeli `yaml` 包对裸注释行容忍，`name`/`description` 字段读取正常）；2026-09-25 确认：8 篇均为 frontmatter 内注释，非「frontmatter 后」。
4. **description 双语化**：保留英文原描述为主体，前缀中文触发关键词（样例见下表）。

## 各 skill 的 description 中文触发词

| skill | 中文触发词前缀 |
|---|---|
| agent-experience | agent 工具/上下文设计元技能 |
| dsh-ci-test-reliability | 测试可靠性/防 flake/确定性测试 |
| dsh-find-simplifications | 简化/减法/防复杂度累积 |
| dsh-merging-stacked-prs | GitHub 栈式 PR 合并 |
| dsh-prose-standard | 写作/措辞/注释与文档文案标准 |
| dsh-speed-up-perf | 性能测量/基准纪律 |
| dsh-trim-cot-leakage | 思维链泄漏清理/CoT 残留 |
| record-browser-gif | 浏览器演示录制/GIF 证据 |

## 改写对照表（被改写引用的原文摘录 → 改写后语义）

> 原则：改写只做「自包含化」，不改变规则语义。需要与上游原文对账时按本表检索。

| 文件 | 原文引用（简写）| 改写后语义 |
|---|---|---|
| dsh-ci-test-reliability | docs/testing.md | 测试证据分层（单元/覆盖/期望输出/快照/浏览器/真 API）选择依据 |
| dsh-ci-test-reliability | docs/defensive-patterns.md | 生命周期/子进程/取消/拆除缺陷类 |
| dsh-ci-test-reliability | snapshots/AGENTS.md | 录制会话场景的 keyless 重放规则 |
| dsh-ci-test-reliability | dsh-pre-push-checks（未搬）| pre-push 最小证据集纪律（改名引用） |
| dsh-find-simplifications | AGENTS.md/architecture/defensive-patterns/testing | 仓库宪法四文档 → 自包含一句 |
| dsh-find-simplifications | 上游 notes/README.md（两次）| 已改写为本仓 Issue / pull request 决策记录规则 |
| dsh-find-simplifications | docs/development.md urgency rules | TODO/FIXME/XXX 按紧迫度分级 |
| dsh-find-simplifications | 2026-07-26-dependencies-over-hand-rolling | 依赖政策：优先维护依赖/Node builtins；替换须净删除 |
| dsh-find-simplifications | 上游决策笔记归档 skill（未搬）| 已改写为本仓 Issue 去重与 Git 历史规则 |
| dsh-merging-stacked-prs | AGENTS.md | 仓库宪法允许的 merge-forward/rebase 历史 |
| dsh-merging-stacked-prs | docs/cookbook/responding-to-pr-review-on-a-stack.md | 栈评审修复传播纪律 |
| dsh-prose-standard | docs/AGENTS.md（两次：writing rules / documentation standard）| 文档分层/写作规则/预算；双语最小更新路径 |
| dsh-prose-standard | docs/cookbook/adding-a-package.md#4 | package README 必备契约面 |
| dsh-prose-standard | dsh-doc（未搬）| dsh-doc 文档工作流（放置/预算/双语对）自包含一句 |
| dsh-speed-up-perf | AGENTS.md/architecture/testing/defensive-patterns | 仓库宪法四文档 → 自包含一句 |
| dsh-speed-up-perf | 2026-09-06-evidence-driven-performance-skill（notes）| 性能工作流决策（上游档案，历史线索非权威） |
| dsh-speed-up-perf | benchmarks/AGENTS.md + 2026-09-04-session-open-performance-gate | 基准纪律：扩展现有必需通道而非另建设施 |
| dsh-speed-up-perf | notes/README.md | 决策记录规则 |
| dsh-speed-up-perf | dsh-pre-push-checks（未搬）| pre-push 最小证据集纪律 |
| dsh-trim-cot-leakage | 2026-08-09-committed-artifact-citations（notes）| 引用必须指向已提交工件 |
| dsh-trim-cot-leakage | docs/AGENTS.md（两次）| 文档分层标准；双语最小更新路径 |
| dsh-trim-cot-leakage | dsh-doc（未搬）| 双语文档纪律 |
| record-browser-gif | 2026-08-08-browser-gif-evidence-chain（notes）| evidence-chain 决策：一个 storyboard 一个隔离 run |
| dsh-find-simplifications/references/historical-patterns.md | 21 处 notes/archived/implemented/rejected 链接 | 转纯文本「（上游决策档案）」，保留笔记名 |
| dsh-trim-cot-leakage/references/*.md | 2 处 notes 链接 | 同上 |

### 未搬运清单（明确不带）

| skill | 原因 |
|---|---|
| dsh-doc | 深度绑定上游 docs/AGENTS.md tier 体系与双向文档门禁 |
| dsh-translate-docs | 绑定上游 i18n 双语体系（本环境无此需求） |
| 上游决策笔记归档 skill | 绑定上游 notes 生命周期与归档门禁；本仓使用 Issue、pull request 与 Git 历史 |
| dsh-pre-push-checks | 绑定上游 pnpm change-scope 与测试命令；其「最小证据集」思想已由本环境的 journey --assert 与 B 组机制承接 |

> 注：`dsh-code-review` 原列于未搬运清单（"若需要可后续提炼通用版"），2026-09-25 已提炼为 `code-review`（见下方补充来源），从本表移除。

## 上游引用完整性校验

`scripts/verify_preset_budgets.py`（或既有 verify.sh）校验：persona 与全部 SKILL.md 中点名的 skill 名称、相对互引必须存在于本目录（缺失 → exit 1）。本表是人工对照底稿，脚本是持续防线。
---

# 补充来源：sdd-vibe-coding（frontend-design / quality-review / code-review）

- 来源仓库：[chengxiang-zhang/sdd-vibe-coding](https://github.com/chengxiang-zhang/sdd-vibe-coding)（**MIT License**），搬运路径 `skills/design`（design-standards 全套 + design 专项 references）、`skills/testing`（Verify 专项全套）、`skills/vibe-coding/references/`（verification-loop、evidence-contract）。
- 搬运日期：方案 v2 收尾轮（「剩余内容全面完成」）。
- 引用改造：`../../vibe-coding/references/*` → 本地 `./` 或跨 skill `../frontend-design/references/…`；未复制文件（rails/states/workflow-contract/release-lifecycle）改为自包含一句话（对应 wish-programming 五阶段 + journey 状态机 + release 人闸）。
- `frontend-design/SKILL.md`、`quality-review/SKILL.md`、`code-review/SKILL.md` 为本环境新写路由（SDD rail 体系 → wish-programming 五阶段映射），references 目录为素材原样（含 LOAD-MAP 唯一真源册）。
- code-review 提炼自 deepseek-harness 的 dsh-code-review（MIT，同前台账），去除仓库绑定。
- 维护：同前——单向 vendor；sdd-vibe-coding 上游更新时手动对比同步。

## v3 修复轮（2026-09-25）——搬运自包含化补漏

深度审计（code-vibe-deep-audit-v3.md）发现 4 处上游专属命令/技能名残留，本次改写为本地语义（不改规则意图）：

| 文件 | 原文 | 改写后 |
|---|---|---|
| dsh-prose-standard | `use dsh-doc …`、run `verify-client-ui-i18n` | 本环境文档工作流承接表述 + 人工对照 |
| dsh-trim-cot-leakage | `verify-type-equiv` / `verify-translation-pairing` / `doc-sync` | 本环境门禁等价动作（git diff --check / quote 模板检查 / 人工对照，未校验项如实报 pending） |
| dsh-find-simplifications | `pnpm run doc-sync`、`pnpm run lint`、draft PR | 项目自身构建/lint + `git diff --check` + gap-register 登记 |
| record-browser-gif | `pnpm run build && pnpm run build:web` | 被测项目自身构建命令 |

原则（写入校验）：搬运技能不可指示模型运行**本环境不存在的门禁命令**或加载**未搬运技能**；改写为本地可执行动作或显式「以人工对照确认」。
