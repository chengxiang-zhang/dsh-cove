# 为 dsh-cove 贡献

[English](CONTRIBUTING.md) | 中文

感谢你愿意投入时间贡献。本文件是贡献者入口；仓库全局规则以 [AGENTS.md](AGENTS.md) 为准，两者冲突时以 AGENTS.md 为准。项目角色与决策方式见 [GOVERNANCE.md](GOVERNANCE.md)。

## 行为准则

参与本项目受[行为准则](CODE_OF_CONDUCT.md)约束。如遇不当行为，请报告到 `i@zhangchengxiang.com`。维护者可以管束或移除违反准则的贡献。

## 报告安全问题

漏洞不要开公开 Issue。请使用 [GitHub 私有漏洞报告](https://github.com/chengxiang-zhang/dsh-cove/security/advisories/new)；范围、响应时限与安全港见 [SECURITY.md](SECURITY.md)。

## 贡献范围

运行时是一个实体插件，first-party 能力必须落在 `packages/dsh-web-all` 内，因此本仓库不接受独立 first-party 插件包、第二条运行时行，也不接受对实体插件的大范围顺手重构。外部贡献走以下两条路径之一。

### 社区插件登记

这是仓库唯一接受的外部 PR 类型。插件在你自己的仓库按官方 cordis bundle 契约实现，再登记到 `packages/dsh-community-plugins/community.json` 并提交 PR。

### First-party 改动

Bug 修复、功能、文档、测试与维护类改动，请先用 Issue 表单提交请求，由维护者决定是否实现、如何实现。跳過 Issue 直接提的 PR 会被 [.github/workflows/reject-non-content-pr.yml](.github/workflows/reject-non-content-pr.yml) 关闭；纯文档 PR 由 [reject-docs-pr.yml](.github/workflows/reject-docs-pr.yml) 处理。仓库所有者、机器人与拥有写权限的协作者不受此限制。

## 分支模型

- `dev` 是集成分支。从 `dev` 分叉，所有 PR 以 `dev` 为目标。
- `main` 是稳定分支，只接收从 `dev` 合入且测试通过的代码；不要直接把 PR 指向它。
- 发布由 tag 驱动并从 `main` 切出，见 [docs/publish-prep.md](docs/publish-prep.md)。

## 开发前置

- Node.js 22 或更高版本，pnpm 11。
- 只使用官方 npm SDK：插件代码从 `node_modules` 解析 `@deepseek-ai/*`。禁止修改 DSH 源码，禁止让 tsconfig 指向 DSH checkout。
- token 放在用户级 `~/.npmrc`，项目 `.npmrc` 只留 scope 映射，见 [docs/plugins.md](docs/plugins.md)。

## 快速开始

```sh
git clone https://github.com/chengxiang-zhang/dsh-cove.git
cd dsh-cove
git checkout dev
git fetch origin && git rebase origin/dev
pnpm install
pnpm -r build
pnpm typecheck && pnpm test && pnpm docs:check
```

## 提交规范

使用 Conventional Commits：`type(scope): subject`，type 取 `feat`、`fix`、`chore`、`docs`、`test`、`refactor` 或 `perf`。关联 Issue 时在 subject 末尾追加编号，例如 `fix(ssh): restore timeout on cluster runs (#76)`。代码、注释、文档与提交信息中禁止出现 emoji。

## PR 检查清单

1. 必需检查全绿：`pnpm typecheck`、`pnpm test`、`pnpm test:scripts`、`pnpm docs:check`；改动涉及对应区域时另跑 `pnpm runtime-deps:check` 或 `pnpm community:check`。
2. 文档同步：改 README 必须同时更新中英两侧并重录配对记录：

```sh
pnpm docs:write-pair <目录或根标签>
```

3. 全程无 emoji，CI 会扫描整个仓库。
4. 附上验证证据：执行的命令与结果；用户可见变更附截图，视觉修复附修复前后对比。
5. 证明已同步上游：rebase 到 `origin/dev` 后重新跑通测试并附结果。
6. PR 模板填写完整，包含类别、类型与 AI 编码披露；不完整的 PR 会被自动关闭。
7. 一次性验证证据放在 PR 或 Issue 里，不要写进长期文档树。

## 社区插件登记步骤

1. 在插件仓库遵循官方 cordis bundle 契约：`package.json` 声明 `dsh.bundle.patch` 指向 `cordis.patch.yml`，声明 `dsh.client` 浏览器半区，类型只使用官方 `@deepseek-ai/*` SDK。
2. 在 `packages/dsh-community-plugins/community.json` 追加条目，必填 `id`、`name`、`nameEn`、`author`、`repo`，可选字段见 [docs/plugins.md](docs/plugins.md)。
3. 运行 `node scripts/community-index` 与 `pnpm community:check`。
4. 向 `dev` 提 PR，勾选社区插件索引类别，并确认你会随生态升级持续维护该插件。

## 文档

写文档前先读 [docs/AGENTS.md](docs/AGENTS.md)。每个事实只有一个归属文档，链接必须可解析，包 README 维护双语配对。根 `README.md` 是英文、`README.zh.md` 是中文；`docs/` 下的深度技术文档以中文维护并提供英文入口，新文档必须登记进 [docs/README.md](docs/README.md)。

## 发布流程

发布由维护者从 `main` 推送 `vX.Y.Z` tag 触发 [.github/workflows/release.yml](.github/workflows/release.yml)。`scripts/verify-version.mjs` 校验每个已发布 manifest 与 tag 一致。发布说明从 Git 历史生成到 GitHub Releases，仓库不维护提交式 changelog。

## Issue 与讨论

- 提交前先搜索既有 Issue；使用 [Issue 表单](https://github.com/chengxiang-zhang/dsh-cove/issues/new/choose)，不要开空白 Issue。
- Bug 报告需要复现步骤、环境信息、截图证据、实际执行的冒烟测试与精确代码位置。
- 标签体系、关闭标准与自动化见 [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md)。
- 已关闭的 Issue 可补充新信息后重开，不要重复开新 Issue。
- 使用问题也可先看 [SUPPORT.md](SUPPORT.md)。
