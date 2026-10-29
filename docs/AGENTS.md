# AGENTS.md — 文档标准

本文件定义 dsh-cove 的文档结构、写作规则与 i18n 配对契约。`pnpm docs:check`（`scripts/verify-docs.mjs`）强制执行可机械检查的部分。

## 文档分层：一个事实只有一个家

每个事实只在其归属层写一次，其他层用链接引用，不重复展开。

| 层 | 职责 | 不属于这里 |
| --- | --- | --- |
| 根 AGENTS.md | 每个会话都需要的全局规则（布局/命令/约定），每条 1-3 行并链接归属 | 故事、示例、任何从归属层重述的内容 |
| 根目录社区文件 | 对外入口与政策：README 双语、CONTRIBUTING 双语、SECURITY、SUPPORT、GOVERNANCE、CODE_OF_CONDUCT、NOTICE、ISSUE_TRIAGE、PR_TRIAGE | 长篇技术细节（放 docs/ 或包 README） |
| packages/AGENTS.md | 包级通用规则 | 根文件已有的全局规则 |
| 各包 AGENTS.md | 该包特有规则 | 包级通用规则、全局规则 |
| 各包 README | 包的用户契约：功能、安装、配置、安全模型、已知限制 | JSDoc 重述、构建内部细节 |
| docs/ 长期文档 | 跨包流程与约定：README.md（索引）、architecture.md（架构总览）、plugins.md（向单实体增加能力）、i18n.md（双语契约）、development.md（开发流程） | 一次性任务记录、发布历史、验证快照 |
| Issue / PR / commit / GitHub Release | 提案、任务交接、验证证据、变更历史和发布说明 | 当前行为的唯一说明 |

- **README 必含结构**：功能（What it does / 能力）、安装（Install / 安装）、配置（Config / 配置）、已知限制（Known limitations / 已知限制）。涉及安全的包必须有「安全模型 / Security model」一节。
- **对外入口英文优先**：根 README 默认英文 `README.md` + 中文 `README.zh.md`；`CONTRIBUTING.md` 默认英文 + `CONTRIBUTING.zh.md`；`SECURITY.md`、`SUPPORT.md`、`GOVERNANCE.md`、`CODE_OF_CONDUCT.md` 用英文，保证 GitHub 的社区健康入口对任何访客可读。`docs/` 深度文档以中文维护，但在 `docs/README.md` 标注语言并提供英文索引与架构总览。
- **docs/ 只放长期文档**：任务交接、一次性验证记录、历史发布说明不进入当前文档树；把证据放在对应 Issue / PR，把发布说明保留在 GitHub Release，把行为事实写回长期文档。
- **README 标题层级**：H1 是文档名，## 为顶级章节，### 为子节；安装方式的并列选项用 ###，不得用 # 破坏层级。

## 写作规则

- **写当前状态，不写变更历史**：避免「之前/现在/不再/改名为」；变更故事留在 commit、PR 或 GitHub Release。
- **一个物理段落一行**：编辑器软换行，便于 diff 与自动检查。
- **链接必须真实**：相对链接的目标文件必须存在，锚点（#）必须指向真实标题；`pnpm docs:check` 对根入口文档、社区健康文件与 `docs/` 强制执行。
- **不做装饰性表达**：不用 emoji（全仓禁止），强调用加粗而非通篇大写。
- **包描述与 README 一致**：package.json 的 description 与 README 首段描述同一能力，不残留脚手架占位（如「<edit me>」）。
- **只引用当前资料**：当前文档、技能和贡献指南只链接现存文件；任务证据和历史分别留在 Issue / PR 与 GitHub Releases。
- **新文档入索引**：新增任何长期文档时，同一次改动把它登记进 `docs/README.md`。

## i18n 配对契约

- **声明式配对**：根入口文档在 `scripts/verify-docs.mjs` 的 `pairSets` 中显式声明；`packages/` 与 `tools/` 下同时存在 `README.md` 与 `README.zh.md` 的目录自动纳入。每一对是「英文文件 + 中文文件 + `.i18n.yaml` 配对记录」，同目录平铺，无 locale 子目录。
- **两种语言同等权威**：中英必须表达同一事实；编辑任一侧必须同 PR 更新另一侧，然后重新记录配对 hash。
- **语言切换行**：中文文件 H1 后立即 `[English](<英文文件>) | 中文`；英文文件 H1 后 `English | [中文](<中文文件>)`。
- **结构镜像**：标题层级与顺序、代码块、表格行列数、链接目标、列表种类与条数在两侧一一对应（见 docs/i18n.md）。
- **门禁**：`pnpm docs:check` 校验每个配对的三件套完整、hash 与当前内容一致、切换行存在、结构签名匹配。编辑任一侧不同步即变红。

## 写作检查清单

- 同一规则是否在多个地方出现？（保留一个家，其余链接）
- 是否叙述了历史或一次性过程？（改为当前状态；证据放 Issue / PR / GitHub Release）
- 是否有手抄的清单/目录，而源码或生成器才是权威？
- 是否有一个自然段承载多条规则？（拆开或降级到归属层）
- 是否引用了不存在的历史目录、旧仓库地址、命令或脚手架？
- 是否把 `dsh-community-plugins` 误写成运行时实体？
- 是否用了 emoji、机翻痕迹或占位符？

## 当前架构术语

- **runtime entity**：profile 挂载并拥有 Cordis 生命周期的实体；本仓库只有 `packages/dsh-web-all`。
- **source/data package**：可发布、可被构建脚本消费，但不在 profile 中提供功能行的包；当前为 `dsh-community-plugins`。
- **external community plugin**：在贡献者自己的仓库维护的独立官方 Cordis bundle；本仓库只登记元数据。
- **capability/service domain**：`dsh-web-all` 内部功能模块，不是独立插件。

文档或技能变更至少运行 `git diff --check` 与 `pnpm docs:check`。用户限定修改路径时，不得让生成器、格式化器或全仓替换写入范围外文件。文档任务不重启正在运行的 DSH 服务。

`scripts/release-notes.mjs` 从 Git 历史生成 GitHub Release body；仓库不维护提交式 release-history 文档。
