---
name: dsh-web-pre-push-checks
description: Use before pushing, opening or updating a pull request, or claiming dsh-cove checks pass. Selects the required repository gates and diff-specific generation, build, and GUI evidence.
whenToUse: A dsh-cove change is about to be pushed, submitted for review, merged, or reported as validated.
user-invocable: true
---

# dsh-cove Pre-Push Checks

Run checks from the repository root after the implementation is stable. This workflow supplements [AGENTS.md](../../../AGENTS.md); it does not replace a focused regression test for changed behavior.

## Inspect the outgoing change

1. Confirm the branch, repository root, and worktree status.
2. Inspect the requested base-to-head diff and every dirty file that will be included.
3. Run `git diff --check` before reporting success. Do not stage unrelated changes with `git add -A`.
4. Sync collaborator merges before validating: `git fetch origin` and rebase onto `origin/dev` (`git rebase origin/dev`); when the rebase pulls in new base commits, re-run the affected gates on the rebased tree before reporting.

## Required repository gates

Before a push or review claim, run the repository baseline unless a higher-priority instruction narrows the operation:

```sh
pnpm typecheck
pnpm test
pnpm test:scripts
pnpm docs:check
```

Run the narrowest owning test first for a behavior change. Add an affected-package build or `pnpm build` when package exports, manifests, runtime entry points, generated bundles, or build configuration changed.

## Add checks dictated by the diff

- `shared/` changes: run `pnpm sync-shared` followed by `pnpm sync-shared:check`.
- Runtime entity layout changes: run the package build and `pnpm runtime-deps:check`; first-party runtime behavior must remain inside `dsh-web-all`.
- Browser runtime imports, dependency manifests, or client bundle changes: run `pnpm runtime-deps:check` and the affected package build.
- Changed package README files: update the paired language and record the pair through `pnpm docs:write-pair <package-directory>` before `pnpm docs:check`.
- User-facing client changes: follow [dsh-web-web-qa](../dsh-web-web-qa/SKILL.md) and retain the actual GUI evidence.

Report commands that ran and their outcomes. State any check not run and the concrete reason rather than implying full validation.
