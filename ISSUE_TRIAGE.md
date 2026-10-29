# ISSUE_TRIAGE — Issue 分类标准与处理流程

本文件定义 dsh-cove 仓库的 Issue 标签体系、分类标准与处理流程，供维护者
与贡献者共同使用。目标是让每个 Open Issue 可检索、可认领、可追溯。

This maintainer policy is maintained in Chinese. Security reporting instructions are in English in [SECURITY.md](SECURITY.md); contribution rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

## 标签体系

| 标签 | 含义 | 何时打上 |
| --- | --- | --- |
| `bug` | 功能不符合预期、报错、兼容性问题 | 有明确的错误现象或复现步骤 |
| `enhancement` | 新功能请求、现有功能改进建议 | 请求新增能力或改进体验 |
| `documentation` | 文档改进（README / docs / 注释） | 内容缺失、过时或表述不清 |
| `question` | 使用疑问，非缺陷也非功能请求 | 需要解答「怎么用 / 为什么」 |
| `security` | 已公开的安全问题跟进或加固建议 | 漏洞已有修复或已公开披露；未修复漏洞走 SECURITY.md 的私密渠道 |
| `dependencies` | 依赖升级（含 Dependabot PR 与联动 Issue） | 版本升级、兼容性验证或供应链跟进 |
| `good first issue` | 适合新手贡献者的入门任务 | 范围小、有明确验收标准、不依赖深层上下文 |
| `duplicate` | 与已有 Issue 重复 | 内容与既有 open/closed Issue 相同或高度重叠 |
| `help wanted` | 需要社区协助 | 维护者确认接受外部 PR 且暂无排期 |
| `invalid` | 非本仓库问题或无法复现 | 环境问题、误报、缺信息且无法跟进 |
| `wontfix` | 明确不做 | 超出仓库范围（如需要修改 DSH 核心）或经讨论否决 |

标签命名与 GitHub 默认一致，仓库内不新建临时标签；新增标签需在
`ISSUE_TEMPLATE` 与本文档同步登记。

## 分类流程

新 Issue 创建后按以下顺序处理：

1. **安全优先**：内容涉及未修复漏洞时，不公开讨论利用细节；请报告者改走 [SECURITY.md](SECURITY.md) 的私密渠道，Issue 关闭并说明原因。已修复或已公开披露的安全问题可以按 `security` 标签正常跟进。
2. **查重**：检索 `duplicate` 标签与标题关键词；若与既有 open/closed Issue
   重复，打 `duplicate` 并关闭，评论附上原 Issue 链接。
3. **定类型**：按标题前缀与正文模板判断 `bug` / `enhancement` /
   `documentation` / `question`，打对应标签。
4. **补信息**：Bug 报告正文缺复现步骤、环境信息、截图、冒烟测试或代码引用时，评论请作者补充，并保留
   `question` 或 `bug` 标签等待回复。
5. **新手任务**：范围小、验收明确的任务追加 `good first issue`；涉及深层
   插件架构或需要修改 DSH 核心的不标。
6. **开放认领**：确认开放社区协助、暂无维护者排期的任务追加 `help wanted`；
   已被维护者认领或计划排期的任务不标该标签。

## 关闭标准

满足任一条件即可关闭，关闭时必须附说明评论：

- **已实现**：功能已合入 main（本地开发与远程 PR 先合入 `dev` 集成分支、
  测试通过后合入 `main`）并发布，评论注明 commit / merge / 版本号；
- **重复**：评论附原 Issue 链接；
- **已解答**：`question` 类已有结论，评论给出答案；
- **过时**：所依赖的功能或机制已变更、不再适用；
- **超范围**：需要修改 DSH 核心源码或不属于本仓库职责，评论说明原因
  （可用 `wontfix` 标签）。

关闭理由通过 GitHub 的 `completed` / `not_planned` 状态记录，保持可追溯。
作者认为关闭有误时可在评论区说明，维护者重新评估。

## 维护者操作速查

```sh
# 打标签（多个逗号分隔）
gh issue edit <n> -R chengxiang-zhang/dsh-cove --add-label "bug,good first issue"

# 关闭并说明（completed / not_planned）
gh api -X PATCH repos/chengxiang-zhang/dsh-cove/issues/<n> \
  -f state=closed -f state_reason=completed
gh issue comment <n> -R chengxiang-zhang/dsh-cove --body "说明"

# 列出待分类的 Open Issue
gh issue list -R chengxiang-zhang/dsh-cove --state open \
  --json number,title,labels --jq '.[] | select(.labels|length==0)'
```

## 自动化

自动化工作流在 Issue 创建时自动初筛、分配并可直接关闭，无需人工确认；作者可
通过评论请求重开，由维护者评估：

- `.github/workflows/auto-assign-issues.yml`：新建 Issue 触发，排除 pull request 载荷，并把每个 Issue 的负责人统一设为仓库所有者（非协作者会被 GitHub 拒绝分配）；它不读取 PR 分类路由；
- `.github/workflows/stale-assignment.yml`：每天检查开放项目，但只处理带 `pull_request` 载荷的 PR；分配给协作者且超过 14 天没有其评论或
  审查活动的 PR 自动转给仓库所有者，Issue 不参与该升级；
- `.github/workflows/issue-dedup.yml`：对疑似重复的 Issue 自动打 `duplicate`
  标签，评论附原 Issue 链接并关闭（`not_planned`）；作者可回复说明差异请求
  重开；
- `.github/workflows/issue-template-enforcer.yml`：Bug 报告必填段（含截图、冒烟测试、引用代码）缺失或无效、或未带 `bug` 标签时
  自动评论说明并关闭（`not_planned`），补充完整后可请求重开；
- 自动化只做初筛，人工标签补充与「重开 / 不重开」的最终决定由维护者确认。

## 贡献者指引

- 提 Issue 前先检索标签与关键词，确认没有重复；
- 改动不在内容贡献范围内（插件申请（社区插件索引登记），见
  [CONTRIBUTING.md](CONTRIBUTING.md) 的「PR 范围」）时不要直接开 PR，请以
  Issue 提交讨论；
- 用 [Issue 模板](.github/ISSUE_TEMPLATE/standard_issue.yml) 提交；Bug 报告用
  「Bug 报告」表单提交，自动附加 `bug` 标签，并包含复现步骤、环境信息、截图、冒烟测试、引用代码；
- 想认领任务，优先挑选 `good first issue` 或 `help wanted`，在评论区留言；
- 已关闭的 Issue 若问题仍然存在，请重开并补充最新信息，不要开新 Issue
  重复描述。
