# 开发流程（development）

dsh-cove 是单运行时实体的 DSH Web monorepo。仓库规则见根 [AGENTS.md](../AGENTS.md)，包级规则见 [packages/AGENTS.md](../packages/AGENTS.md)，文档标准见 [AGENTS.md](AGENTS.md)。

## 环境准备

- Node.js 22 或更高版本；
- pnpm 11；
- 依赖只解析官方 npm SDK；
- `NPM_TOKEN` 只保存在环境或用户级 `~/.npmrc`。

## 分支模型

- `dev` 是集成分支，提交前通过 `git fetch origin dev` 与 `origin/dev` 同步；
- `main` 是稳定分支，只接收通过验证的 `dev` 内容；
- PR 目标是 `dev`，发布 tag 从 `main` 创建；
- 规范远程仓库是 `https://github.com/chengxiang-zhang/dsh-cove`。

## 日常循环

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm test:scripts
pnpm docs:check
```

按 diff 追加 `pnpm runtime-deps:check` 或 `pnpm community:check`。

## 在 dsh-web-all 增加能力

不要创建独立 first-party 功能插件包。按 [plugins.md](plugins.md) 将 host 服务域、跨端协议和 browser UI 放入 `packages/dsh-web-all` 的对应 owner：

```text
src/host/services/<domain>/
src/core/<domain>/
src/client/sidebar/
src/client/settings/
src/client/conversation/
```

位置模块是唯一注入者，所有能力共享 `web-all` 的单一 Cordis 生命周期。服务域内每次获取路由、工具、监听器或进程资源后，立即向 `registerResources` / `registerAsyncResources` 事务登记 disposer；不能等全部注册完成后再拼清理函数。注册失败时逆序回滚，某项清理失败也继续清理其余资源。生命周期 owner 只能管理已返回的 disposer，不能替服务域撤销未登记的任意副作用。Playwright 的枚举失败、空工具列表、后续工具冲突和 owner abort 都必须清理此前注册的控制路由、实时视图与浏览器管理器。至少运行：

```sh
pnpm --filter @dsh-cove/dsh-web-all typecheck
pnpm --filter @dsh-cove/dsh-web-all test
pnpm --filter @dsh-cove/dsh-web-all build
pnpm runtime-deps:check
```

## 修改 shared

`shared/` 是跨包模块的事实源；包内带 generated 头注释的副本由 `scripts/sync-shared.mjs` 生成。修改后运行：

```sh
pnpm sync-shared
pnpm sync-shared:check
```

## 修改源/数据包

- `packages/dsh-community-plugins/`：社区插件索引。

该包不提供 profile 功能行，也不携带 `cordis.patch.yml`。社区索引变更运行 `node scripts/community-index` 与 `pnpm community:check`。

## 本地验证

本地 profile 的规范流程：

```sh
pnpm dsh-local:audit
node scripts/link-profile.mjs
# 仅当 profile 尚未挂载 web-all 时：
# dsh plugin --profile web add link:<仓库绝对路径>/packages/dsh-web-all
```

1. `pnpm dsh-local:audit` 检查 `$DSH_HOME`（默认 `~/.dsh`）下的 profile 是否与仓库包身份一致，任何 FAIL 以非零退出。
2. `node scripts/link-profile.mjs` 把全部当前 `@dsh-cove` 包链接进 `~/.dsh/profiles/node_modules/@dsh-cove`。
3. 仅当 profile 尚未挂载 web-all 时才运行 `dsh plugin ... add link:...`（见上方注释）。
4. 由用户重启现有托管服务。

profile 仍停留在旧 `@zcx/*` 身份时，先运行 `pnpm dsh-local:migrate` 查看 dry-run 计划，确认后再加 `--apply`；新安装不需要这一步。审计提示的废弃临时脚本按输出指认的目标改名为 `*.retired`，不要直接删除。

Profile 只挂载 `@dsh-cove/dsh-web-all`，不挂载源/数据包。链接、host bundle 或 patch 变化需要重启时，由用户重启现有托管服务；agent 不得执行重启、`kill`、`pkill` 或启动替代实例。

自托管部署的 systemd 与 LaunchDaemon 形态、重启顺序见 [tools/dsh-netbird/README.md](../tools/dsh-netbird/README.md)；该目录是参考模板，机器相关值不入库。

Linux 主机用 systemd 单元（参考 [examples/dsh-web.service](examples/dsh-web.service)）：

```sh
systemctl status dsh-web.service
journalctl -u dsh-web.service -f
```

macOS 主机用 LaunchDaemon（启动器与安装器见 [tools/dsh-launchd/README.md](../tools/dsh-launchd/README.md)）：

```sh
sudo launchctl print system/ai.deepseek.dsh.web
```

## 用户可见验证

类型检查和单测不能替代真实 GUI 验证。用户可见改动需在现有托管 DSH GUI 上刷新验证，检查页面、交互、console 和 page error；不要启动替代 Vite shell 或第二个 `dsh web`。

## 文档与历史

- 当前行为写入 owning README、AGENTS.md 或长期 docs；文档地图见 [README.md](README.md)，架构总览见 [architecture.md](architecture.md)；
- 根 README、CONTRIBUTING、包 README 与 tools 下成对的 README 都是中英配对：两侧同步后运行 `pnpm docs:write-pair <root|CONTRIBUTING|目录>`；
- 新增长期文档时同一次改动登记进 [README.md](README.md)；
- 安全报告流程只写在根 `SECURITY.md`，参与规则只写在根 `CODE_OF_CONDUCT.md`，不要复制进 docs/；
- 提案、交接和一次性验证证据放在 Issue / PR；
- 发布历史留在 GitHub Releases，长期 docs 只描述当前行为。

## 发布

发布流程见 [publish-prep.md](publish-prep.md) 与 `.github/workflows/release.yml`。`vX.Y.Z` tag 触发发布，`scripts/verify-version.mjs` 校验版本，`scripts/release-notes.mjs` 从 Git 历史生成 GitHub Release body。

## 完成前

运行 `git diff --check`，检查变更仅覆盖任务范围，并报告实际验证结果。共享工作树中不得使用 reset、clean、广泛 restore/stash 或 `git add -A`。除非用户明确要求，不提交；任何情况下都不由 agent 重启正在运行的 DSH 服务。

## 参考

- [文档索引](README.md)
- [架构总览](architecture.md)
- [向单实体插件增加能力](plugins.md)
- [双语文档契约](i18n.md)
- [客户端发布契约](client-release.md)
- [发布准备](publish-prep.md)
- [贡献指南](../CONTRIBUTING.md)
