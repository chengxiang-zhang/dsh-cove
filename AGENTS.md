# dsh-cove Repository Instructions

This repository is a monorepo with one runtime entity plugin: `packages/dsh-web-all`. All first-party host and browser behavior belongs to that package and shares its single `web-all` Cordis lifecycle. Never modify a DSH source checkout.

Before changing `packages/`, read [packages/AGENTS.md](packages/AGENTS.md). Before editing documentation, read [docs/AGENTS.md](docs/AGENTS.md).

## Repository Layout

`packages/dsh-web-all/` is the only runtime entity. Add first-party capabilities there by DSH injection position; no other package may create a first-party functional row.

`packages/dsh-community-plugins/` is a source/data package, not a runtime entity. It owns the community plugin index and provides no runtime behavior.

`shared/tsdown.client.ts` is the only shared client build preset. `shared/web-platform.ts` defines the browser platform seed table. `shared/` contains repository-wide runtime and tooling helpers. Generated package copies, when declared by `sync-shared.mjs`, must not be edited manually.

`scripts/` contains repository maintenance tools and `docs/` contains current long-lived documentation (indexed by [docs/README.md](docs/README.md)).

The repository root carries the public entry documents: the bilingual `README.md` / `README.zh.md` pair, `CONTRIBUTING.md` / `CONTRIBUTING.zh.md`, `SECURITY.md`, `SUPPORT.md`, `GOVERNANCE.md`, `CODE_OF_CONDUCT.md`, `NOTICE`, and the maintainer policies `ISSUE_TRIAGE.md` and `PR_TRIAGE.md`. Community health files are owned at the root; do not duplicate their content into `docs/`.

## Common Commands

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm test:scripts
pnpm dsh-local:audit
pnpm docs:check
```

Before merging, run at least `pnpm typecheck && pnpm test && pnpm docs:check`. Run `pnpm community:check` when the community index changes.

## Repository Rules

- Mount first-party runtime behavior only through `packages/dsh-web-all/cordis.patch.yml` and profiles. Source/data packages must not declare functional runtime rows. TypeScript configuration must not reference a DSH checkout; use official `@deepseek-ai/*` SDK packages from `node_modules`.
- New first-party capabilities go into `dsh-web-all`. External community plugins remain independent repositories indexed through `packages/dsh-community-plugins/community.json`.
- Published packages use the `@dsh-cove/dsh-*` scope, with `@dsh-cove/dsh-client-ui-*` reserved for client UI/data packages where applicable.
- Use `shared/tsdown.client.ts`; do not copy the build preset into a package.
- Keep `NPM_TOKEN` in the environment. Store token configuration in the user `~/.npmrc`; the project `.npmrc` should contain only scope mappings.
- Do not use emoji in code, comments, documentation, UI text, scripts, or commit messages.
- Keep each fact in its owning document and update current documentation when behavior changes. Use Issues and pull requests for temporary handoffs and validation evidence, Git history for change narratives, and GitHub Releases for publication history.
- Bilingual pairs: the root entry documents (`README`, `CONTRIBUTING`) and every package README declare English, Chinese and an `*.i18n.yaml` pairing record. Both sides are equally authoritative; re-record after both agree with `pnpm docs:write-pair <label>`. Follow [docs/AGENTS.md](docs/AGENTS.md) for the contract.
- Every new long-lived document is listed in [docs/README.md](docs/README.md) in the same change. Security reporting instructions live only in `SECURITY.md`; participation rules live only in `CODE_OF_CONDUCT.md`.
- Do not make a publicly reachable deployment easier by weakening a documented guard: `noBrowserAuth`, trusted hosts and the loopback fence are described in [SECURITY.md](SECURITY.md) and [docs/remote-access.md](docs/remote-access.md).
- Do not ask the user to confirm small, reversible, in-scope actions (cleanup, retiring stale artifacts, local commits on `dev`, rerunning the documented gates). Decide, do it, and report the result as fact; prefer reversible shapes such as moving things to `*.retired/` over deleting them. Reserve questions for genuinely destructive or outward-facing changes with a real blast radius.

## Development Workflow

- For implementation and maintenance tasks, load [dsh-web-agent-coding](.agents/skills/dsh-web-agent-coding/SKILL.md) and the focused skill it selects.
- Prefer CodeGraph for code navigation, symbol lookup, dependency analysis, review, and impact analysis. Use `query`, `explore`, `node`, `impact`, and `affected`; initialize with `codegraph init <project-root>` when needed.
- After all code changes in a session, before final validation, run `codegraph sync <project-root>` and `codegraph status <project-root>`. If the index is missing or sync fails, run `codegraph index <project-root>`.
- Keep changes focused, preserve existing work, and verify real behavior. User-visible changes require appropriate runtime evidence; visual changes require screenshots and multimodal validation.

## 运行中的 DSH 服务

NetBird 中每台电脑的规范入口、DNS 命名、`80 → 3080` 代理拓扑、鉴权规则、机器清单和审计命令统一归 [tools/dsh-netbird/README.zh.md](tools/dsh-netbird/README.zh.md) 管理；新增或修复机器后必须运行 `pnpm dsh-netbird:audit`。

本机 DSH Web 由托管服务拉起：Linux 主机是 systemd 单元 `dsh-web.service`，macOS 主机是 LaunchDaemon `ai.deepseek.dsh.web`；逐台清单、启动器与重启顺序见 [tools/dsh-netbird/README.zh.md](tools/dsh-netbird/README.zh.md) 与 [tools/dsh-launchd/README.md](tools/dsh-launchd/README.md)，本地审计流程见 [docs/development.md](docs/development.md#本地验证)。

- 会话运行期间不得中断或重启当前正在运行的 DSH 服务（`dsh web` 及其宿主进程）：禁止 `kill` / `pkill` / `SIGTERM`，禁止抢占其端口另起替代实例。
- 改动需要服务重启才生效时（例如 bundle 行或 `cordis.patch.yml` 变化），不要自行重启；改为在交付报告中明确标注「需要用户重启 DSH 服务后生效」，由用户自行重启验证。页面刷新、只读探测等不打扰服务的验证不受此限制。

## 远程访问契约

远程入口 `http://dsh.<机器名>/` 下的功能正确性由 [docs/remote-access.md](docs/remote-access.md) 定义：启动器必须带 `--trusted-host <规范 authority>`，每个特权宿主路由族走共享围栏 `accessTrustOf(ctx)`，远程页面靠逐请求 boot 脚本声明 Host 所有权，明文 HTTP 入口由插件注入 uuid/clipboard 兜底。

- 新增或修改宿主路由族、首页注入、启动器、nginx 拓扑时，按该契约更新测试与文档，并运行 `pnpm --filter @dsh-cove/dsh-web-all test`、`pnpm test:scripts`（含静态围栏门禁）与 `pnpm dsh-netbird:audit`。
- 只读接口同样是特权面：不要因为「只是读」而跳过围栏，也不要用 socket-only 判定代替 Host + 会话判定。

## Branches, Commits, and PRs

- 本项目唯一的远程仓库是 `https://github.com/chengxiang-zhang/dsh-cove`（`origin`）。不要向其他 GitHub 仓库推送、创建 PR 或修改其仓库元数据。
- `dev` is the integration branch. Rebase on `origin/dev` before submitting a PR. `main` receives tested changes from `dev` through maintainer integration.
- 同步远程仓库代码时，本地与远程的同步对象只能是 `dev` 分支：`git fetch origin dev`，需要整合时把本地 `dev` rebase 或 merge 到 `origin/dev`。禁止把 `main` / `origin/main` 作为本地 `dev` 的同步来源或重基目标——`main` 只通过维护者集成接收 `dev` 的测试内容，agent 不向 main 同步，也不以 main 重写本地 dev 的历史。
- Use Conventional Commits: `type(scope): subject`, with types such as `feat`, `fix`, `docs`, `test`, `refactor`, and `chore`. Do not include emoji.
- 改动默认直接提交到 `dev`（本地提交即可；需要时推送 `origin/dev`），PR 不是强制流程——只有需要评审或走合入流程时才开 PR。若开 PR：target 必须是 `dev`，并按 [.github/pull_request_template.md](.github/pull_request_template.md) 填写 scope、变更类型、上游同步、AI 披露、本地测试证据与用户可见证据。
- README changes update all paired files and run `pnpm docs:write-pair <label>` (`root`, `CONTRIBUTING` or the package directory). Package registry changes also update `docs/publish-prep.md`.

## Release

Releases are tag-driven by [.github/workflows/release.yml](.github/workflows/release.yml). Verify the `@dsh-cove/dsh-web-all` version against the `vX.Y.Z` tag, generate the GitHub Release body with `scripts/release-notes.mjs`, and pass all gates before publishing. Release notes are generated from Git history and are not maintained as committed historical documents. Do not bypass the release process by editing package versions manually.

Releases are cut from `main`: a tag must point at a commit that is on `main`, and the publishing workflows ([release.yml](.github/workflows/release.yml), [desktop-release.yml](.github/workflows/desktop-release.yml), [android-release.yml](.github/workflows/android-release.yml)) refuse any other tag. GitHub tag events carry no branch information, so each workflow checks its own commit against `main` before doing any work. Cutting a release therefore starts with integrating `dev` into `main`.

## Instruction Layers

- This file: repository layout, commands, and cross-repository rules.
- [docs/README.md](docs/README.md): the documentation index; every long-lived document is listed there.
- [dsh-web-agent-coding](.agents/skills/dsh-web-agent-coding/SKILL.md): implementation workflow and task-specific skill routing.
- [packages/AGENTS.md](packages/AGENTS.md): package-level SDK, runtime-entity, source-package, and testing rules.
- [docs/AGENTS.md](docs/AGENTS.md): documentation structure, writing, and i18n rules.
- Package-level `AGENTS.md` files: package-specific behavior and constraints.

Keep each rule in its owning file. Prefer short rules and links over duplicated explanations.
