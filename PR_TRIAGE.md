# PR_TRIAGE — PR 分类与审批路由

本文件定义 dsh-cove 仓库 PR 的自动分类与分派路由机制：PR 打开后由
`.github/workflows/auto-assign-pr-reviewers.yml` 按 PR 描述勾选的类别（`PR 类别（PR Category）`）、
变更文件与标题匹配分类，自动把对应协作者设为负责人（assignee）并请求其审查，
与 [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md) 中 Issue 的自动分派对应。

This maintainer policy is maintained in Chinese. Contribution rules and the review checklist are in English in [CONTRIBUTING.md](CONTRIBUTING.md).

## 路由配置

分类与审批者的映射在 `.github/pr-review-routes.json`：

| 字段 | 说明 |
| --- | --- |
| `comment` | 顶层标记：该配置是否发布说明评论 |
| `defaultRoute` | 顶层兜底路由：无任何分类命中时使用的 `reviewers` / `assignees` |
| `routes[].name` | 分类唯一名，出现在路由日志与评论中 |
| `routes[].label` | 分类的中文展示名 |
| `routes[].types` | PR 描述「PR 类别（PR Category）」中勾选项的标签列表，勾中任一项即匹配 |
| `routes[].authors` | PR 作者登录名列表，作者是其中任一用户即匹配（可选维度，用于需要按作者转交的场景） |
| `routes[].paths` | 变更文件 glob 列表（`*` 不跨目录，`**` 跨目录），命中任一文件即匹配 |
| `routes[].title` | 标题正则（大小写不敏感），可选 |
| `routes[].prAllowed` | 该分类是否接受 PR；`false` 表示只收 Issue，命中它的 PR 会被自动关闭 |
| `routes[].ai` | 分类或兜底路由的 AI 处理标记 |
| `routes[].reviewers` | GitHub 用户名列表，命中后请求这些用户审查 |
| `routes[].assignees` | GitHub 用户名列表，命中后把这些用户设为 PR 负责人（可选） |

`comment` 与 `ai` 是配置文件中的声明字段，当前路由工作流不读取。

匹配规则：`authors`、`types`、`paths` 与 `title` 任一命中即匹配；多个分类可同时命中，
负责人与审查者各取并集；PR 作者本人会被过滤（避免自审，作者本人命中的路由贡献
空集，由其他命中的路由接管），draft PR 不触发。工作流从 base 分支读取配置
（PR 自身无法修改自己的路由），读取失败时跳过并记录警告。

## 当前路由

| name | 分类 | 类别勾选 | 负责人 / 审批者 |
| --- | --- | --- | --- |
| `plugins` | Web 运行时能力（侧栏 / 设置 / 会话区 / Host 服务） | Web 运行时能力（侧栏 / 设置 / 会话区 / Host 服务） | chengxiang-zhang |
| `maintenance` | 维护 / 其他 | 维护 / 其他 | chengxiang-zhang |
| `defaultRoute` | 未匹配任何分类时的兜底 | 无 | chengxiang-zhang |

新增分类：在 `routes` 追加条目并同步本表格；纯按标题路由可只写 `title`，
例如 `{"name": "docs", "title": "^docs", "reviewers": ["chengxiang-zhang"]}`；
按类别路由可只写 `types`，值为 PR 描述「PR 类别」勾选项的完整标签（须与模板一致），例如
`{"name": "plugins", "types": ["Web 运行时能力（侧栏 / 设置 / 会话区 / Host 服务）"], "assignees": ["chengxiang-zhang"], "reviewers": ["chengxiang-zhang"]}`；
按作者转交可只写 `authors`：`{"name": "maintainer", "authors": ["chengxiang-zhang"], "reviewers": ["chengxiang-zhang"]}`。

## 自动化行为

- 触发：`pull_request_target` 的 `opened` / `reopened` / `synchronize` /
  `ready_for_review`；
- 命中后调用 `pulls.requestReviewers` 请求审查，并调用
  `issues.addAssignees` 把 `assignees` 中的用户设为 PR 负责人；
- `opened` 时另发布一条分类路由说明评论（负责人与审查者）；
- 无命中时走 `defaultRoute` 的兜底分派，没有兜底配置时才只记录日志。

## 合并门禁

`dev` 与 `main` 分支保护：必需状态检查为 `CI checks` / `plugin-mount` /
`Validate PR contribution evidence`（GitHub Actions，strict 关闭）；
**必需人工审批为 0** —— 检查全绿后，具有 write 权限的协作者即可自行合并
PR（含自己提交的 PR），无需等待维护者审批；维护者仍可随时追加审查。

机器人（`github-actions[bot]` 与任意 `type: Bot` 账号，含 Dependabot）开的 PR 豁免贡献证据门禁与内容范围关闭规则，但仍必须通过全部必需检查，并由维护者合并；依赖升级的分组与节奏见 [.github/dependabot.yml](.github/dependabot.yml)。

## 维护者速查

```sh
# 手动请求审查
gh pr edit <n> -R chengxiang-zhang/dsh-cove --add-reviewer chengxiang-zhang

# 查看某 PR 的变更文件
gh api repos/chengxiang-zhang/dsh-cove/pulls/<n>/files --jq '.[].filename'
```