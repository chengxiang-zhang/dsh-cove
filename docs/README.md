# Documentation

This page is the map of the repository's long-lived documentation. Each document describes current behaviour and owns one area; generated facts stay with their generator, and one-time evidence belongs in the issue or pull request that produced it. The documentation contract itself is in [AGENTS.md](AGENTS.md), and the bilingual pairing mechanism is in [i18n.md](i18n.md).

## Start here

| Document | Audience | Language |
| --- | --- | --- |
| [README.md](../README.md) | Users installing the plugin | English |
| [README.zh.md](../README.zh.md) | Users installing the plugin | Chinese |
| [docs/architecture.md](architecture.md) | Contributors learning the repository layout and runtime model | English |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Contributors | English |
| [CONTRIBUTING.zh.md](../CONTRIBUTING.zh.md) | Contributors | Chinese |
| [SECURITY.md](../SECURITY.md) | Security researchers and operators | English |
| [SUPPORT.md](../SUPPORT.md) | Users who need help | English |
| [GOVERNANCE.md](../GOVERNANCE.md) | Contributors and maintainers | English |
| [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Everyone | English |

## Documents by area

| Area | Documents |
| --- | --- |
| Runtime and feature contract | [packages/dsh-web-all/README.md](../packages/dsh-web-all/README.md), [packages/dsh-web-all/README.zh.md](../packages/dsh-web-all/README.zh.md) |
| Native capability boundary | [docs/native-capability-boundary.md](native-capability-boundary.md) |
| Memory viewer (read-only OpenViking surface) | [docs/memory-view.md](memory-view.md) |
| External harness sessions | [docs/external-session.md](external-session.md) |
| Built-in plugin usage for operators | [docs/plugin-usage.md](plugin-usage.md) |
| Development workflow | [docs/development.md](development.md), [docs/i18n.md](i18n.md) |
| What applies hot, and when a restart is really required | [docs/hmr.md](hmr.md) |
| Remote and self-hosted deployment | [docs/remote-access.md](remote-access.md), [tools/dsh-netbird/README.md](../tools/dsh-netbird/README.md) |
| Cross-project Agent work delegation design (Chinese; target architecture) | [docs/superagent/README.md](superagent/README.md), [coordination](superagent/12-托管协调.md), [acceptance and evaluation](superagent/13-验收与评估.md), [professional team collaboration](superagent/14-专业团队协作.md), [implementation roadmap](superagent/15-实施路线.md) |
| Fleet collection and merge-back | [docs/fleet-collection.md](fleet-collection.md), [docs/preset-self-review.md](preset-self-review.md) |
| Release and client packaging | [docs/publish-prep.md](publish-prep.md), [docs/client-release.md](client-release.md) |
| Desktop client design and delivery | [tools/anywhere-agent/DESIGN.md](../tools/anywhere-agent/DESIGN.md), [product design spec](../tools/anywhere-agent/review/desktop-product-design-spec-2026-10-30.md), [delivery plan](../tools/anywhere-agent/review/desktop-intranet-browser-plan-2026-10-30.md), [window layout and native layer contract](../tools/anywhere-agent/review/window-layout-contract-2026-11-02.md), [tab residency contract](../tools/anywhere-agent/review/tab-residency-contract-2026-11-02.md), [two-network window contract](../tools/anywhere-agent/review/two-network-window-contract-2026-11-04.md) |
| Issue and pull request policy | [ISSUE_TRIAGE.md](../ISSUE_TRIAGE.md), [PR_TRIAGE.md](../PR_TRIAGE.md) |

## Language policy

- The root README is a bilingual pair: `README.md` is English and `README.zh.md` is Chinese, and both are equally authoritative.
- Contributor-facing community files (`CONTRIBUTING`, `SECURITY`, `SUPPORT`, `GOVERNANCE`, `CODE_OF_CONDUCT`) are written in English so that GitHub surfaces them correctly for every visitor.
- Deep technical documents under `docs/` are maintained in Chinese for the maintainers, with English entry points in this index and in [architecture.md](architecture.md). Translations of an individual deep document are welcome as an additional file, not as a replacement.
- The issue and pull request templates keep Chinese anchor labels because repository automation matches those exact strings; English guidance is included alongside them.

## Documentation rules

- A fact lives in one owning document; every other place links to it instead of restating it.
- Long-lived documents describe the current state, never a change history.
- Relative links must resolve, including anchors; `pnpm docs:check` enforces it.
- Package READMEs, tool READMEs and the root README maintain the bilingual pair plus its pairing record; re-record with `pnpm docs:write-pair <label>` after both sides agree.
- New documents are added to this page in the same change.
- Documentation changes never restart a running DSH service.
