---
name: dsh-web-release
description: Release the refactored dsh-cove monorepo from main through its tag-triggered GitHub Actions pipeline, with a single runtime-entity version, current single-entity validation, npm publication, and GitHub Release verification.
whenToUse: The user asks to release, publish, bump a version, create a tag, repair the release pipeline, or recover from a bad dsh-cove package version.
---

# dsh-cove Release

## Repository facts

- Canonical repository: `chengxiang-zhang/dsh-cove`.
- `dev` is the integration branch; tested changes reach `main` through maintainer integration. Release tags are cut from `main`.
- `packages/dsh-web-all` is the only runtime entity. `dsh-community-plugins` is the only source/data package.
- Tag `vX.Y.Z` versions `@dsh-cove/dsh-web-all` only; it is that package's version source of truth. Source/data packages version independently and are not republished by the tag.
- GitHub Actions publishes with `NPM_TOKEN`; do not depend on local npm authentication.
- Release history lives in GitHub Releases. `scripts/release-notes.mjs` generates the release body from Git history; do not create committed release-history snapshots.

## Before changing versions

1. Read the repository instructions and inspect the exact `origin/dev`, `dev`, `main`, and working-tree state.
2. Confirm all intended changes are integrated and tested on `dev`, then integrate `dev` into `main` according to branch protection.
3. Determine the previous formal tag and ensure the next version has never been published. npm versions are immutable; a bad release is followed by a new patch version.
4. Audit changes to current package names, exports, the single `web-all` Cordis row, settings keys, API/wire shapes, persisted files, browser storage, SDK services, minimum runtime versions, and generated assets. Compatibility review covers the current package inventory and does not publish identities outside it.
5. Use isolated `DSH_HOME` fixtures for installation or upgrade validation. Never mutate the active user profile or restart the managed DSH service during an agent session.

## Required gates

Run from the repository root on the final release commit:

```sh
node scripts/verify-version.mjs "$GITHUB_REF_NAME"
pnpm typecheck
pnpm build
pnpm test
pnpm test:scripts
pnpm runtime-deps:check
```

Treat every failed, skipped, or environment-blocked gate as unverified.

## Version bump

Set the target version in the `@dsh-cove/dsh-web-all` manifest. Source/data packages version independently and are not tied to the tag. Use the repository version verifier instead of relying on a hand-written package list:

```sh
node scripts/verify-version.mjs X.Y.Z
```

Regenerate owned build artifacts after the version change:

```sh
pnpm build
```

Inspect the manifest, lockfile, generated-asset, and package-file-list diffs before committing. Do not hand-edit the lockfile.

## Commit, tag, and publish

On `main`, after all gates pass:

```sh
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

The tag triggers `.github/workflows/release.yml`, which installs with the frozen lockfile, runs the gates, verifies versions, generates release notes from Git history, and always creates the GitHub Release with the gated tarballs. The npm path (publish `candidate`, verify the registry bytes, promote `latest`) runs only when the repository variable `NPM_PUBLISH` is `true` and a publisher (trusted publisher or `NPM_TOKEN`) is configured.

Do not run local `npm publish` or publish package identities outside the current family package inventory.

## Post-release verification

```sh
npm view @dsh-cove/dsh-web-all version
gh release view vX.Y.Z --repo chengxiang-zhang/dsh-cove
gh run list --repo chengxiang-zhang/dsh-cove --workflow=release.yml
git ls-remote --tags origin | grep 'refs/tags/vX.Y.Z'
```

Confirm the published tarball contains the declared runtime entries and that the release workflow's mount smoke passed. Merge the release commit back into `dev` if the branch model requires it.

## Failure recovery

- Failure before npm publish: fix the commit and recreate the unshipped tag only after confirming no package version was published.
- Partial npm publish: never republish an occupied version; publish a new patch version or explicitly finish only packages whose version is still absent.
- Bad package: deprecate the bad version and publish a corrected patch. Do not overwrite it.
- Mount-smoke failure after publish: do not create or edit the release to imply success; fix forward with a new version.
- Missing/expired `NPM_TOKEN`: repair the repository secret and rerun only when version immutability permits it.

## Report

Report the target version, exact commit and tag, every gate result, workflow run, npm versions, GitHub Release URL, known blocked checks, and rollback/deprecation actions. Do not claim release success until npm and GitHub verification both pass.
