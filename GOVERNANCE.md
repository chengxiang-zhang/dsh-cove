# Governance

This document records how dsh-cove is maintained and how decisions are made. It is intentionally small: the project has one maintainer and a developer-preview release cadence.

## Roles

| Role | Expectations |
| --- | --- |
| User | Installs the plugin, reports bugs and requests capabilities through the issue forms |
| Contributor | Submits a community plugin index registration or improves the project through issues; follows [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) |
| Maintainer | Owns release authority, reviews and merges contributions, triages issues, keeps documentation current and guards the single-entity architecture |
| Security responder | Triages private vulnerability reports under [SECURITY.md](SECURITY.md); normally the maintainer |

## Current maintainers

| GitHub handle | Scope |
| --- | --- |
| [@chengxiang-zhang](https://github.com/chengxiang-zhang) | Repository owner; all packages, releases and security response |

The maintainer list is the authoritative record. Review routing, required checks and automatic assignment live in [.github/pr-review-routes.json](.github/pr-review-routes.json) and [PR_TRIAGE.md](PR_TRIAGE.md).

## Decision making

- Routine changes use lazy consensus: a pull request that passes the required checks and receives no objection within two business days may be merged by a maintainer.
- Architecture, compatibility and user-visible behaviour changes need an issue first, so alternatives and consequences are recorded in public.
- The maintainer makes the final call when consensus is not reached, and records the reasoning in the issue or pull request.
- Security fixes may be prepared privately and merged without prior public discussion.

## Contribution scope

The runtime is a single entity plugin. First-party capabilities are added inside `packages/dsh-web-all`; the project does not accept independent first-party plugin packages or a second runtime row. External contributions are limited to community plugin index registrations, as defined in [CONTRIBUTING.md](CONTRIBUTING.md). This is a maintainability decision, not a statement about the value of a contribution.

## Becoming a maintainer

There is no fixed quota. A contributor becomes eligible after a sustained record of high-quality contributions, sound review judgement and consistent adherence to the repository rules. The current maintainer grants the role and records the addition in this file. Maintainers can step down at any time; inactive maintainers may be moved to emeritus status after six months without activity.

## Releases

Releases are cut from `main` by the maintainer only. A `vX.Y.Z` tag is the single version source and triggers the publishing workflows; the process and its gates are defined in [docs/publish-prep.md](docs/publish-prep.md). No other role may publish to the npm registry.

## Changes to this document

Governance changes are proposed as a pull request from a fork or as an issue, and require maintainer approval. The change is effective when merged into `dev` and integrated into `main`.
