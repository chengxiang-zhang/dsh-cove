# Contributing to dsh-cove

English | [中文](CONTRIBUTING.zh.md)

Thanks for taking the time to contribute. This file is the contributor entry point. Repository-wide rules live in [AGENTS.md](AGENTS.md); if the two disagree, AGENTS.md wins. Project roles and decision making are in [GOVERNANCE.md](GOVERNANCE.md).

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Report unacceptable behaviour to `i@zhangchengxiang.com`. Maintainers may moderate or remove contributions that violate it.

## Reporting security issues

Do not open a public issue for a vulnerability. Use [GitHub private vulnerability reporting](https://github.com/chengxiang-zhang/dsh-cove/security/advisories/new); [SECURITY.md](SECURITY.md) defines scope, response targets and safe harbour.

## Contribution scope

The runtime is one entity plugin. First-party capabilities belong inside `packages/dsh-web-all`, so the project does not accept independent first-party plugin packages, a second runtime row, or drive-by refactors of the entity. External contributions start as an issue.

### First-party changes

Open an issue with the request form for bug fixes, feature work, documentation, tests and maintenance. A maintainer decides whether and how to implement it. Pull requests that skip the issue step are closed by [.github/workflows/reject-non-content-pr.yml](.github/workflows/reject-non-content-pr.yml); documentation-only pull requests are handled by [reject-docs-pr.yml](.github/workflows/reject-docs-pr.yml). The repository owner, bots and collaborators with write access are exempt.

## Branch model

- `dev` is the integration branch. Fork from `dev`, and target `dev` in every pull request.
- `main` is the stable branch. It receives tested changes from `dev` through maintainer integration; never target it directly.
- Releases are tag-driven and cut from `main`; see [docs/publish-prep.md](docs/publish-prep.md).

## Development prerequisites

- Node.js 22 or newer and pnpm 11.
- Official npm SDK only: plugin code resolves `@deepseek-ai/*` from `node_modules`. Never patch DSH source, and never point a tsconfig at a DSH checkout.
- Tokens live in the user-level `~/.npmrc`; the project `.npmrc` keeps scope mappings only. See [docs/plugins.md](docs/plugins.md).

## Quick start

```sh
git clone https://github.com/chengxiang-zhang/dsh-cove.git
cd dsh-cove
git checkout dev
git fetch origin && git rebase origin/dev
pnpm install
pnpm -r build
pnpm typecheck && pnpm test && pnpm docs:check
```

## Commit conventions

Use Conventional Commits: `type(scope): subject`, where type is one of `feat`, `fix`, `chore`, `docs`, `test`, `refactor` or `perf`. Reference an issue at the end of the subject, for example `fix(ssh): restore timeout on cluster runs (#76)`. Emoji are rejected in code, comments, documentation and commit messages.

## Pull request checklist

1. Required checks are green: `pnpm typecheck`, `pnpm test`, `pnpm test:scripts` and `pnpm docs:check`. Add `pnpm runtime-deps:check` when the diff touches runtime dependencies.
2. Documentation is current. A README change updates both language versions and re-records the pair:

```sh
pnpm docs:write-pair <directory-or-root-label>
```

3. No emoji anywhere. CI scans the repository for them.
4. Evidence is attached: the commands you ran and their results, plus screenshots for user-visible changes and before/after images for visual fixes.
5. Upstream sync is proven: rebase on `origin/dev` and show a passing run after the rebase.
6. The pull request template is complete, including category, type and AI coding disclosure. Incomplete pull requests are closed automatically.
7. One-time evidence belongs in the pull request or issue, not in the long-lived documentation tree.

## Documentation

Before editing documentation, read [docs/AGENTS.md](docs/AGENTS.md). Each fact has one owning document, links must resolve, and package READMEs are maintained as bilingual pairs. Root `README.md` is English and `README.zh.md` is Chinese; deep technical documents under `docs/` are maintained in Chinese with English entry points, and every new document must be listed in [docs/README.md](docs/README.md).

## Release process

Releases are pushed by a maintainer as a `vX.Y.Z` tag from `main`, which triggers [.github/workflows/release.yml](.github/workflows/release.yml). `scripts/verify-version.mjs` checks every published manifest against the tag. Release notes are generated from Git history into GitHub Releases; the repository does not keep a committed changelog.

## Issue and discussion

- Search existing issues before filing; use the [issue forms](https://github.com/chengxiang-zhang/dsh-cove/issues/new/choose) rather than a blank issue.
- Bug reports need reproduction steps, environment details, screenshot evidence, the smoke test you ran and precise code references.
- Labels, closing criteria and automation are documented in [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md).
- Closed issues can be reopened with new information; do not open a duplicate.
- Usage questions are also covered by [SUPPORT.md](SUPPORT.md).
