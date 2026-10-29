# Security policy

## Supported versions

dsh-cove is a developer preview. Security fixes land on the latest published release line only; older lines are not backported.

| Version | Supported |
| --- | --- |
| Latest `vX.Y.Z` release | Yes |
| Latest `dev` branch | Best effort; use it to verify a fix, not as a supported runtime |
| Any earlier release | No |

Always verify a report against the latest release before filing it.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/chengxiang-zhang/dsh-cove/security/advisories/new) on this repository. That channel creates a private advisory visible only to you and the maintainers.

- Do not open a public issue, discussion or pull request for an unfixed vulnerability, and do not include exploit details in a public contribution.
- If GitHub private reporting is unavailable, email `i@zhangchengxiang.com` with the subject `[dsh-cove security] <short summary>`.
- Do not test against infrastructure you do not own or have explicit permission to assess. A local DSH Home with your own data is sufficient for almost every case.

## What to include

- The affected version (`@dsh-cove/dsh-web-all` version, commit or tag) and the DSH host version from `dsh --version`.
- The deployment shape: local `127.0.0.1:3080`, a remote entry behind a reverse proxy or overlay network, and whether `noBrowserAuth` is enabled.
- A minimal reproduction: configuration keys that matter, request/response pairs or browser steps, and the observed impact.
- Any proof of concept, logs or screenshots, with credentials, tokens, private keys and conversation content redacted.
- Whether the issue is already public anywhere else.

## Response targets

These are targets, not a contractual service level:

| Stage | Target |
| --- | --- |
| Acknowledgement | Within 3 business days |
| Initial triage and severity assessment | Within 10 business days |
| Fix or mitigation plan | Depends on severity; critical issues are prioritised over feature work |
| Coordinated disclosure | By mutual agreement, normally within 90 days of the report |

We will keep you informed when a fix lands and credit you in the advisory unless you ask otherwise. If a report is accepted as a vulnerability, we publish the advisory after users have a reasonable upgrade path.

## Scope

In scope:

- The runtime entity `packages/dsh-web-all`: host access fence, remote-access boot script, Web authentication and account/session storage, SSH host store and execution, Feishu credential wizard, notification feed, worktree and Git routes, Playwright tool namespace, schedule-mode API.
- Release and repository automation in `.github/` where it can affect published artifacts or credentials.
- Supply-chain issues in how published packages are produced, signed or distributed.

Out of scope:

- Vulnerabilities in DeepSeek Harness itself. Report them to the DSH project.
- Third-party community plugins listed in the index; each belongs to its author. We will help route a report when the target is unclear.
- Deliberate configuration that removes a documented guard, for example exposing a `noBrowserAuth` instance on the public internet or serving plaintext HTTP outside a trusted network.
- Missing hardening that the documentation already lists as a known limitation, unless the impact is worse than documented.
- Social engineering, physical access and denial of service from unbounded local resource use.

## Safe harbour

We will not pursue legal action or restrict participation for research that follows this policy: use your own instance, avoid privacy violations and data destruction, give us reasonable time to fix the issue before disclosure, and do not exploit a finding beyond what is needed to demonstrate it.

## Hardening checklist

- Keep `noBrowserAuth` at its default `false` unless an authenticating reverse proxy or an equivalent network gate fronts the instance.
- Pass `--trusted-host` with the canonical authority for every remote entry; never expose the loopback listener directly.
- Terminate TLS in front of any remote entry, and keep plaintext HTTP on a trusted network only.
- Remove any global `mcp-playwright` entry: the plugin owns the `mcp__playwright__*` namespace and duplicate ownership fails closed.
- Protect `$DSH_HOME`: account, session and SSH stores are owner-only `0600` files but are not encrypted at rest.
- Rotate the bootstrap administrator password after the first account exists, and keep one local break-glass administrator.
- Treat profile settings documents and `.credentials.yaml` as credential material; never commit them.
- Review Playwright target URLs and close sensitive browser sessions when finished.

## Security model references

- [dsh-web-all security model](packages/dsh-web-all/README.md#security-model): access fence, credentials, accounts, sessions, SSH and Playwright consequences.
- [Remote-access contract](docs/remote-access.md): invariants that must hold for a remotely reachable instance.
- [Self-hosted deployment guide](tools/dsh-netbird/README.md): reference topology for an overlay-network entry.
