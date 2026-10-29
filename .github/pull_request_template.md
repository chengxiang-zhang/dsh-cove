> 提 PR 前请阅读 [CONTRIBUTING.md](../CONTRIBUTING.md) 与 [AGENTS.md](../AGENTS.md)；
> 提交信息用 Conventional Commits（`type(scope): subject`），禁止 emoji。
> 本仓库只接受一类内容贡献：插件申请（社区插件索引登记）。其余改动（修复 / 增强 / 全新功能 / 文档 / 测试 / 维护）不接受直接 PR，请先提 Issue 讨论；仓库所有者、机器人与拥有写权限的协作者（维护者）不受此限制，可直接提交任意改动。
> 仅文档类 PR（标题以 `docs:` 开头或勾选「仅文档」）不接受，会被自动关闭；文档改动请先提 Issue 讨论（仓库所有者、机器人与拥有写权限的协作者不受此限制）。
>
> English contributors: section headings and checkbox labels stay in Chinese because repository automation matches those exact strings. Fill in the checkboxes unchanged; the guidance comments under each section explain what is required, and [CONTRIBUTING.md](../CONTRIBUTING.md) has the full English rules.
## 摘要（Summary）

<!-- 用一两句话说明改了什么、为什么改。 / One or two sentences: what changed and why. -->

## 涉及包（Affected Packages）

<!-- 勾选本次改动涉及的包；仅脚本改动（维护类）可全部不勾选并说明。 -->

- [ ] Web 运行时能力 `packages/dsh-web-all`
- [ ] 社区插件索引 `packages/dsh-community-plugins`
- [ ] 自动化 / 其他（请说明）

## PR 类别（PR Category）

<!-- 必填。勾选本 PR 最贴近的类别（可多选），用于机器人按类别自动分派给协作者。插件申请勾「社区插件索引」；其余运行时功能改动、维护 / 其他不在公开内容贡献范围，会被自动关闭，请改提 Issue；仓库所有者与拥有写权限的协作者（维护者）不受此限制。 / Required: select the closest category. Only the community plugin index category is accepted from external contributors; other changes start as an issue. -->

- [ ] Web 运行时能力（侧栏 / 设置 / 会话区 / Host 服务）
- [ ] 社区插件索引
- [ ] 维护 / 其他

## PR 类型（PR Type）

<!-- 勾选所有适用的类别。 -->

- [ ] 面向用户的功能或行为变更
- [ ] Bug 修复
- [ ] 视觉修复（UI / 视觉类问题的修复）
- [ ] 增强 / 优化（现有功能的改进、性能 / 体验优化）
- [ ] 维护 / 重构

<!-- 仅文档类 PR 不接受，会被自动关闭；文档改动请先提 Issue 讨论。 -->

## 最新代码确认（Latest Codebase Confirmation）

- [ ] 我已基于最新 `dev` 分支开发，或在提交前已 rebase / 合并最新 `dev`。

同步命令：

<!-- 示例：git fetch origin && git rebase origin/dev -->

## 测试证据与上游同步（Test Evidence & Upstream Sync）

<!-- 必填。缺少下列任一证据的 PR 不予接受；文本类改动可不附截图，但必须提供测试证据。 / Required: a PR without these evidence items is not accepted. Text-only changes may skip screenshots but still need test evidence. -->

- [ ] 我提供了自己本地测试的证据（执行的命令 / 测试结果 / 运行截图）。
- [ ] 我已同步上游最新 `dev` 分支（`git fetch origin && git rebase origin/dev`），并附上同步后重新测试通过的证据（视觉 / 用户可见变更附截图）。

## 视觉修复要求（Visual Fix Requirements）

<!-- 仅当 PR 类型勾选了「视觉修复」时必填；纯文本类改动可跳过本节。 -->

- [ ] 我提供了修复完成后的截图（完成态或修复前后对比）。
- [ ] 修复使用的 AI 模型支持图像输入（多模态模型）；未使用 AI 编码时此项视为满足。

<!-- 使用纯文本模型（如 deepseek-chat / deepseek-reasoner / gpt-3.5 等不支持图像输入的模型）进行视觉修复的 PR 不接受；使用的多模态模型请在「AI 编码披露」节填写。 -->

## AI 编码披露（AI Coding Disclosure）

<!-- 必填。勾选一项，且模型 / 工具字段不得留空。 -->

- [ ] 完全 AI 编码：全部编程改动由 AI 产出，并由贡献者接受 / 审查。
- [ ] 部分 AI 辅助：AI 帮助编写或修改了部分编程改动。
- [ ] 未使用 AI 编码辅助。

使用的 AI 模型：

<!-- 使用 AI 时必填；未使用 AI 时填 N/A。示例：DeepSeek、GPT-5、Claude Sonnet 4。 -->

使用的编码 Agent 工具：

<!-- 使用 AI 时必填；未使用 AI 时填 N/A。示例：DeepSeek Harness、Codex、Claude Code、Cursor。 -->

## 仓库规范检查（Repo Rules）

<!-- 本仓库硬性规范，请逐项确认。 -->

- [ ] 未修改 DSH 官方源码，仅基于官方 NPM SDK（`@deepseek-ai/*`）开发。
- [ ] 未新增指向 DSH 源码 checkout 的 tsconfig `extends` / `paths` / `references`。
- [ ] 新增 first-party 运行时能力位于 `packages/dsh-web-all`，未创建独立功能包或子插件行。
- [ ] 所有新增 / 修改文件不含任何 emoji 字符。
- [ ] 改动包 README 时同步维护中英双语三件套（`README.md` / `README.zh.md` / `README.i18n.yaml`）并运行 `pnpm docs:check`。

## 贡献者版权声明（Contributor Copyright）

<!-- 可选。若本 PR 贡献的是插件，可在项目 README 末尾「来源与版权」的版权表中追加一行声明你自己的版权（包 / 来源 / 版权三列，格式参考表中现有行）；不声明则维持现有版权归属。 -->

## 社区插件索引登记（Community Plugin Index）

<!-- 仅当本 PR 新增接入一个社区插件时必填；其余改动可跳过本节。新接入的社区插件对下述要求逐项确认。 -->

插件 GitHub 仓库链接：

<!-- 必填。提供插件源码的公开 GitHub 仓库链接，供协作者评审参考。 -->

插件详细说明：

<!-- 必填。提供插件的功能、用途、依赖、已知限制等详细说明，供协作者评审参考。 -->

- [ ] 已按 [docs/plugins.md](../docs/plugins.md) 的登记说明在 `packages/dsh-community-plugins/community.json` 追加条目，并运行 `pnpm community:check` 校验索引。
- [ ] 已确认插件与 dsh-cove 插件体系兼容：遵循官方 cordis bundle 独立标准（package.json 声明 `dsh.bundle.patch` 指向 `cordis.patch.yml`、`dsh.client` 浏览器半区），类型仅基于官方 `@deepseek-ai/*` NPM SDK，未修改 DSH 源码；已在本仓库最新代码上验证插件可被 `dsh web` 挂载并正常运行。
- [ ] 承诺负责后续更新跟进：插件与 DSH / dsh-cove 生态保持同步，生态升级导致不兼容时主动跟进修复；条目信息（description / npm 等）变动或插件停更时，及时更新索引登记或提交移除。

## 本地验证（Local Validation）

执行的命令：

```bash
# Example: build the whole repository, then add the focused checks for your diff. / 示例：运行全仓构建，并按改动范围补充专项检查
pnpm build
```

结果摘要：

<!-- 失败也要写明。不要留空。 / Report failures too; never leave this blank. -->

## 用户可见变更证据（Local Feature Evidence）

<!--
面向用户的功能或行为变更必填。
附截图或短视频，展示：
- 本地加载的插件来自本 PR / 最新代码
- 功能已启用 / 配置（如适用）
- 成功使用并展示可见结果
- 涉及 agent 循环的功能展示后续 / 结果反馈
-->

证据：

<!-- 粘贴 GitHub 图片 / 视频附件、Markdown 图片或直接图片 / 视频链接。纯内部改动（无用户可见变更）可填 N/A。 -->