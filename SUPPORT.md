# Support

This document explains where to get help and what to include, so every request can be answered without a round trip.

## Where to ask

| Need | Channel |
| --- | --- |
| Installation, configuration or usage question | [Issue with the request form](https://github.com/chengxiang-zhang/dsh-cove/issues/new/choose) |
| Reproducible bug | [Bug report form](https://github.com/chengxiang-zhang/dsh-cove/issues/new/choose); it attaches the `bug` label automatically |
| Feature request or design discussion | [Issue with the request form](https://github.com/chengxiang-zhang/dsh-cove/issues/new/choose) |
| Security vulnerability | [Private advisory](https://github.com/chengxiang-zhang/dsh-cove/security/advisories/new), never a public issue; see [SECURITY.md](SECURITY.md) |
| Plugin development question | The plugin lives in its author's own repository; this project only ships the runtime entity |
| Documentation gap or wrong statement | Issue with the request form; documentation pull requests follow the contribution policy in [CONTRIBUTING.md](CONTRIBUTING.md) |

## Before asking

- Read [docs/README.md](docs/README.md) and the [dsh-web-all README](packages/dsh-web-all/README.md); most configuration questions are answered there.
- Search open and closed issues for the same symptom.
- Reproduce on the latest release, and note the exact plugin and DSH versions.

## What to include

- Plugin version (`@dsh-cove/dsh-web-all` from `dsh plugin list` or the profile manifest) and DSH host version.
- The deployment shape: local browser, remote entry, desktop or mobile client, and whether `noBrowserAuth` is enabled.
- The smallest reproduction you can manage: commands, configuration keys, browser steps and the observed result.
- Browser console and page errors for UI problems, and the relevant host log lines for backend problems.
- Screenshots for anything visual; a bug report without screenshot evidence is closed by the repository automation.

## What to expect

- This is a developer-preview project maintained in maintainer time. Responses are best effort; security reports follow the targets in [SECURITY.md](SECURITY.md).
- Issues are triaged against [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md). Requests that need a product decision stay open until a maintainer records a decision.
- The repository does not accept external pull requests directly; a fix you propose starts as an issue that a maintainer decides on.

## Out of scope

- DeepSeek Harness itself: report to the DSH project.
- Third-party DSH plugins: contact their authors.
- A deliberately misconfigured deployment that removes a documented guard, for example `noBrowserAuth` exposed on the public internet.
