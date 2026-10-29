# @dsh-cove/dsh-web-all

English | [中文](README.zh.md)

`@dsh-cove/dsh-web-all` is the single runtime entity for the dsh-cove feature family. Its runtime patch contributes exactly one entity row, `web-all`; separate bundle patches declare the HiOpen model route and optional `code-vibe` Agent preset. Browser features are coordinated by the sidebar, conversation, and settings position modules, while host capabilities run as service domains in the same plugin lifecycle.

## What it does

- **Workspace and session workflow**: project memoir, Git worktree management with per-session isolation, and workspace-model presets. Worktrees have no page of their own. A worktree is a lane: the composer's branch picker creates the branch's worktree and registers its directory as a workspace (a platform requirement, not a taste: a session is only accounted to a workspace while its cwd equals that workspace's path, and a blank conversation no workspace accounts for has an inert composer), then moves the conversation onto it through the platform's own workspace navigation. That registration is short-lived by design: archiving the lane's conversations retires it (the directory, the branch and the binding stay, so picking the branch again re-registers it in one step), and a boot pass retires the rows an older build left behind. The conversation header's lane chip names that branch and carries the rest of its life - open the PR, check whether it is merged, and delete the directory (optionally the local branch with it), which also unregisters the workspace. The copy a user reads says "branch directory", never worktree or lane.
- **Development workbench**: the Git branch chip and graph dialog in the composer, the right-pane Source Control workbench, and the Codex bridge that registers Codex as an `llm-pi-ai` provider.
- **HiOpen model route**: a credential-free `llm-pi-ai` preset ships a curated model catalog for any OpenAI-compatible endpoint; the address is bring-your-own (set `llm.hiopen.baseUrl` in `config/deployment.local.json`, then run `node scripts/config-render.mjs`) and no endpoint or credential is committed. It curates exact model ids, context/output limits, reasoning levels, and text/image modalities for DSH agent use.
- **Remote operations**: SSH hosts, terminal, transfer, tunnels and cluster execution, plus authenticated access to DSH's native Web UI with local-password, Feishu, or generic OIDC login and persistent sessions.
- **Feishu (Lark) intake**: the bot's WebSocket inbox with the `lark_inbox_peek`, `lark_inbox_pop` and `lark_inbox_ack` tools, the credential wizard, and a configuration page under **Settings → Built-in plugins → Feishu**.
- **Run-finished notifications**: every finished turn is recorded and aggregated into the read-only `GET /api/dsh-notify/feed`, which the desktop and mobile machine lists use to mark results that have not been looked at, and which can be pushed to Feishu once the run has fully stopped. Configure it under **Settings → Built-in plugins → Notifications**.
- **Browser automation**: per-session Playwright browsers exposed as the `mcp__playwright__*` tool namespace.
- **Automation run target**: native automation tasks deliver into the conversation that created them; this capability lets each task run in a fresh session every time instead, keeping the original conversation clean. There is no settings UI for it: it is chosen in natural language when the task is created, and the agent applies it with `schedule_mode_set`.
- **Wish Programming preset**: a bundled `code-vibe` preset with its curated skills and native coding tools appears as an additional session mode; Standard remains the default.

The web profile runtime stack is `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + `@dsh-cove/dsh-web-all`. The community-plugin index package is a source/data package rather than a profile entry.

## Install

### From npm

```sh
dsh plugin --profile web add @dsh-cove/dsh-web-all@latest
# Stopped on ERR_PNPM_IGNORED_BUILDS? Add the printed keys to the profile's
# pnpm-workspace.yaml allowBuilds, then remove and add again: that failed run
# already wrote the dependency, and a plain re-run writes only the dependency,
# never the profile bundle row.
dsh --profile web --dump-config  # a mounted web-all row is the proof it registered
# Restart the managed dsh web process after installation.
```

For DSH Desktop, replace `web` with `desktop`, verify with `dsh --profile desktop --dump-config`, then fully quit and reopen the desktop application.

### From the repository

```sh
git clone https://github.com/chengxiang-zhang/dsh-cove.git
cd dsh-cove
pnpm install
pnpm --filter @dsh-cove/dsh-web-all build
node scripts/link-profile.mjs
dsh plugin --profile web add link:$(pwd)/packages/dsh-web-all
dsh --profile web --dump-config
```

Restart the target DSH host after changing its profile; refreshing the page does not reload a Cordis bundle.

### Remove

```sh
dsh plugin --profile web remove @dsh-cove/dsh-web-all
```

Restart the target DSH host after removal.

## Config

The `web-all` row accepts these plugin-level options:

| Option | Default | Purpose |
| --- | --- | --- |
| `dshHome` | `$DSH_HOME` or the current user's DSH home | Overrides the DSH data root used by service domains that accept the central value. |
| `agentsHome` | `$DSH_AGENTS_HOME` or the resolved DSH home | Overrides the user agents and skills root. |
| `noBrowserAuth` | `false` | Skips BrowserAuth token and cookie validation only when explicitly set to `true`; see [Security model](#security-model). |
| `playwright` | `{ mode: launch, … }` | Selects isolated browser launch or attended attachment to selected tabs in the user's Chrome/Edge. |

Example profile override:

```yaml
- id: web-all
  config:
    noBrowserAuth: true
```

Capability settings aggregate as namespaces of the single `web-all` entry: `remote-web-ui`, `lark-inbox`, `notify`, `dsh-ssh`, `dsh-codex-bridge`, `workspace-model`, `web-render`, and `schedule-mode`. The Web GUI carries one page for Feishu and one for notifications (**Settings → Built-in plugins → Feishu / Notifications**); the Feishu page owns how events arrive and the notifications page owns how results go out and how clients read them. Edit the other namespaces through a profile override or the settings document.

The bundled `hiopen` route resolves `HIOPEN_API_KEY` through DSH credentials; store the secret as `refs.HIOPEN_API_KEY` in `$DSH_HOME/.credentials.yaml`, never in the profile or repository. The preset intentionally exposes a curated chat/agent subset rather than every item returned by `/v1/models`: the endpoint also advertises embedding, guard, detector, and temporarily unavailable routes. A profile override can replace or extend the `hiopen.models` list when the endpoint changes.

The `remote-web-ui` namespace enables integrated DSH-origin authentication by default. Local accounts, Feishu and generic OIDC all mint the same HttpOnly session used by `/`, `/api`, and `/api/remote.mux`; native launch-token authentication remains available. Mobile browsers use the same native Web UI at `/`. Set `publicBaseUrl` to the exact HTTPS origin used by OAuth callbacks. The compatibility listener on `0.0.0.0:3082` remains available through `legacyGatewayEnabled: true`, but is disabled by default.

Generic OIDC providers use Authorization Code with PKCE S256 plus state and nonce validation. Configure an `issuer`, `clientId`, `clientSecret`, and a stable allowlist (`allowedSubjects` and/or `allowedEmailDomains`). Feishu uses `appId`, `appSecret`, and `allowedOpenIds`. External sign-in cannot create the first account: bootstrap a local administrator first. Empty provider allowlists then enable just-in-time binding for additional accounts, so production deployments should normally set an explicit allowlist and keep that local break-glass administrator.

The Playwright service domain is the sole owner of public tool names under `mcp__playwright__*`. Remove any global `mcp-playwright` row before starting this plugin; duplicate tool ownership makes Playwright registration fail. Its default `launch` mode keeps browser processes isolated by DSH session, limits them to two concurrent browsers, and reclaims idle sessions. `extension` mode instead gives one attended DSH session an exclusive lease on tabs selected through the official [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm): open **Agent Browser** in that session's right pane, connect, approve the extension prompt, and assign tabs. The external Chrome remains open after disconnect. The control plane uses the plugin's shared host access fence — a loopback request, or a Host authority the deployment declares through `ctx.webRuntime.trustedHosts` (`--trusted-host`) carrying an authenticated DSH browser session; unsafe code execution is hidden by default, and `approvalPolicy: mutations` asks through DSH before every non-read-only browser action.

```yaml
- id: web-all
  config:
    playwright:
      mode: extension
      browserChannel: chrome
      approvalPolicy: mutations
      allowedOrigins: ['https://example.com']
```

`allowedOrigins` and `blockedOrigins` are Playwright navigation guardrails rather than complete authorization boundaries: redirects and page content remain untrusted. Extension mode intentionally has no mirrored screencast because the user already sees the attached Chrome window; `liveView` remains available only for launched browsers.

SSH server identity is verified before client authentication for execution, interactive terminals, transfers and tunnels. Provision a verified entry in the host user's `~/.ssh/known_hosts` (including `[host]:port` for a non-default port), or set the host entry's `hostKeyFingerprint` to a SHA256 fingerprint independently verified with the server administrator through `POST /api/dsh-ssh/hosts` or `PATCH /api/dsh-ssh/hosts/:alias` behind the shared host fence. Omit the field on PATCH to preserve it, or set it to `null` to return to known-host verification. Unknown or changed keys fail closed; there is no automatic first-use trust. Pooled connections recheck current trust before admitting a new operation; removing or revoking trust blocks new operations without terminating existing channels or tunnels. Hostname patterns and hashed known-host entries are supported, but host certificates and `@cert-authority` entries are not. An explicit fingerprint pin is authoritative; revoked matching keys remain rejected. The current engine rejects `proxyJump` rather than silently connecting directly. Do not treat `ssh-keyscan` output alone as identity verification.

SSH execution always has a timeout: when `ssh_exec` and `ssh_cluster` are called without an explicit `timeoutMs`, the plugin uses `execTimeoutMs` from the `dsh-ssh` namespace (120000 ms, two minutes, by default), so a remote command that never returns (`tail -f`, a prompt waiting for input, a stuck mount) fails with a timeout instead of making the call wait forever. On timeout the plugin closes that SSH channel, so sshd tears the remote command down with it; if the channel is still open after a short grace period (a wedged connection), the whole connection is dropped so it never re-enters the reuse pool. Long-running commands should pass a larger `timeoutMs`:

```yaml
- id: web-all
  config:
    dsh-ssh:
      execTimeoutMs: 600000
```

The `web-render` service domain gives `web_fetch` a fetch backend that renders in a real Chromium. The native `dsh-web-fetch-http` provider performs a plain HTTP GET, so a client-rendered page (SPA, lazy-loaded list, content backfilled over XHR) yields nothing but an empty shell; this domain registers the fetch provider id `browser`, waits for the page's scripts to run, and returns the **rendered DOM**. HTML→markdown, GFM tables, and truncation stay with `dsh-tool-web`, and the model-facing tool name and schema are unchanged.

The `dsh-web-app` bundle already pins the `web` row's `fetchProvider` to `http`, and the seam does not pick a winner when several providers are usable (it fails every call with `WEB_PROVIDER_AMBIGUOUS`), so the pin must be changed explicitly in the `cordis.patch.yml` of **the profile that uses the capability**:

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    fetchProvider: browser
```

The pin and the provider registration must agree: a missing provider reports `WEB_PROVIDER_CONFIGURED_MISSING`, so this domain registers whenever the `web` service is present; with no launchable browser it warns at registration time and fetches fail with `WEB_PROVIDER_UNAVAILABLE`. Reverting means deleting that profile block.

Fetches use a persistent Chrome profile (default `$DSH_HOME/cache/web-render/chrome-profile`), so signing in once reuses the login state from then on; one profile can only be held by a single process at a time, and on collision this domain falls back to a temporary profile and warns. The `web-render` namespace tunes headless mode, navigation waiting, timeouts, viewport, extraction mode, and the character cap.

The `web-search-anthropic` service domain registers one extra search provider, id `anthropic-messages`, that fixes exactly one thing: **response parsing**. The bundled `deepseek-official` provider sends a correct Anthropic-compatible Messages request with the native `web_search_20250305` server tool, but its mapper hard-requires a `web_search_tool_result` block and throws `WEB_PROVIDER_ERROR` when a response has none — so no configuration can make it work against an upstream that returns only `server_tool_use` plus `text` blocks whose `citations[]` carry every hit (Bedrock-backed routes behave this way). This domain sends the same request from the same configuration and accepts both shapes, joins citation excerpts to result items as snippets, and reports a client-side `tool_use(web_search)` (a model that asks for a client tool instead of the endpoint searching) as an actionable error instead of an empty result.

**It adds no configuration surface.** Endpoint, model, credential reference, `anthropic-version`, and the two request bounds are read live from the official `web-search-deepseek` entry — the same knobs as **Settings → Plugins → Built-in plugin settings → Web search**. To search through any Anthropic-compatible Messages API, change that page (or the entry's `baseURL`/`model`/`apiKeyEnv` in a profile patch) exactly as you would for the bundled provider; the plugin source carries no vendor endpoint, model name, or key reference. The key is resolved through the configured credential reference from DSH credentials or the launching environment on every search, so a rotated key reaches the next call without a restart. A literal `apiKey` typed into that entry cannot be reused here, because settings reads are redacted for secrets; use the credential reference instead.

Selection is pinned the same way fetching is, in the `cordis.patch.yml` of **the profile that uses the capability**:

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: anthropic-messages
    fetchProvider: browser
```

Keep both keys together: a patch replaces the whole `config` object, so a `searchProvider`-only block silently drops the `fetchProvider` pin. The pin and the provider registration must agree — a missing provider reports `WEB_PROVIDER_CONFIGURED_MISSING`, which is why this domain registers whenever the `web` service is present; with no endpoint or model configured it warns at registration time and searches fail with an explicit "configure Web search" error. Reverting means changing `searchProvider` back to `deepseek-official`; the configuration stays valid either way.

## Automation run target

The native `@deepseek-ai/dsh-schedule` plugin binds every task to the conversation that created it and delivers each occurrence back into that conversation (`resolveAgent(sessionId)` + `followup`); it offers no "new session per run" option. This service domain adds that choice **without modifying the native plugin**.

**It has no UI surface, deliberately**: the run target is set in natural language **when the task is created** — the user says "run this one in a new chat every time", and the agent calls `schedule_create` and then `schedule_mode_set(mode=new)` (`schedule_mode_list` reports where each task runs). No sidebar page, no header icon, no extra card.

- **Original conversation** (default): no policy is stored and native delivery runs unchanged, byte for byte as if this capability were not installed.
- **New session per run**: the original rule is armed on a freshly created **run session**, and the row on the original conversation is removed. After each delivery the domain opens the next run session and moves the run copy there, so the original conversation is never a delivery target again and every run lands in its own new session.

Timing stays entirely with the native scheduler: the run copy advances its own `scheduledAt` under the original rule and the native runtime performs the delivery, so cron, daily, weekly, and fixed-interval semantics are identical to the native ones, survive Host restarts, and need no time-zone or occurrence math here. Rotation is driven by delivery confirmation (the native receipt plus the primary signal "the copy's target already advanced"). Target changes and rotation persist a write-ahead journal and delete the exact old task before creating its replacement. Recovery resumes known task associations, but cannot provide exactly-once creation because the native scheduler has no idempotency key: a persisted create intent without a recorded result stops with `recovery-required` instead of creating another task. Inspect the native task catalog and the saved journal before manually retiring ambiguous copies and recreating the task; do not blindly retry. An `at` deadline crossed during replacement is also marked for recovery, not silently reported as completed. Delete-before-create favors avoiding duplicates over availability: a failure can pause a task or miss an occurrence. Legacy incomplete transitions without precise identity also require operator recovery. Multiple engines at the same path coordinate only within one process; multiple Host processes must not share this schedule store. Corrupt persistence and invalid journals refuse execution and preserve their bytes. Confirmed one-shot delivery is incorporated before switching, never replayed; a delete window crossing the delivery time without a native receipt can only be marked for recovery.

- A task keeps a stable **logical id** (the id `schedule_create` returned) in the tools; internal run-copy ids never surface.
- Run history keeps the newest `runHistoryLimit` entries (50 by default), readable through the loopback-only `/api/schedule-mode/*` API, scoped to the `sessionId` the caller names (an unscoped read returns no rows); each run session is named `<title> · #N`.
- Switching back to **Original conversation** re-arms the same rule on the original conversation (a recurring rule restarts its phase under native `create` semantics) and keeps the run history.
- Run-target changes and run history use the shared host access fence on `/api/schedule-mode/*`, and a task id alone never reaches another conversation's task (the armed-task lookup requires the calling session to own that policy); the agent tools are `schedule_mode_list` and `schedule_mode_set` (`session_id` defaults to the calling conversation), so "run this one in a new session every time" works from chat.
- A run session is created outside every workspace (it sits in Ungrouped until its run starts) and joins its workspace only after its first delivery: DSH's "New session" reuses a workspace's blank sessions as drafts, so a pending run session would otherwise be adopted as the user's new conversation. A confirmed missing copy with no in-flight transition is treated as a user deletion and is not rebuilt; an interrupted transition is handled only through its persisted journal.
- The native schedule bundle is optional. On a profile without it the tools answer `schedule-unavailable`, and nothing else is affected: a missing bundle never breaks loading `web-all`.

On the native automation page a task in **New session per run** mode appears under its current run session while rotating — a direct consequence of native grouping by binding session. The original conversation no longer shows that task's native clock mark. Manage such a task through the agent tools (switch target, delete) or by asking in chat; there is deliberately no run-target settings page.

The `schedule-mode` namespace: `enabled` (default `true`; disabling it removes the tools and the host API), `nameRunSessions` (default `true`), and `runHistoryLimit` (default 50).

```yaml
- id: web-all
  config:
    schedule-mode:
      runHistoryLimit: 200
```

## Security model

- Host APIs that expose local state or privileged actions share one access fence: a loopback request, or a Host authority the deployment declares through `ctx.webRuntime.trustedHosts` (`--trusted-host`) carrying an authenticated DSH browser session, always with same-origin markers. The socket itself must stay loopback, which is why a same-host reverse proxy forwards the canonical Host to `127.0.0.1`. The fence is not a substitute for an authenticated network boundary, and `noBrowserAuth: true` reduces the remote branch to the Host/Origin check alone.
- Reads are privileged too: the worktree index and lane lookup, the workspace-model reads, the finished-run feed (`GET /api/dsh-notify/feed`), and the Feishu credential wizard all carry that fence. The feed publishes the session title, the end reason and the time only, never the conversation body, and it has no write route: a client's read position is stored on the client, so the host keeps no per-client state. There is no second allow path, and the worktree mutations consult the fence alone. Pairing administration under `/api/pair/*` is stricter: it requires a loopback Host as well as a loopback socket, so a same-host reverse proxy cannot expose token minting, listing, or revocation to a remote browser.
- Worktree git calls are bounded and fail closed: `git fetch`, `ls-remote` and the ancestor probes carry a 15 s deadline and a push 180 s, so a stalled network can neither hold a repository's operation lock nor leave the lane menu loading. `POST /worktree/status` is served from a host cache (60 s) that every mutation this plugin performs invalidates, so opening the lane menu is a memory read and only its explicit "check whether it is merged" action (or a name-filtered probe) runs the network checks again. A lane is merged when its remote tip is an ancestor of the base, or - once the tracking ref has been pruned, which is what GitHub's delete-on-merge leaves behind - when it moved past the commit it was created from and its local tip is contained in the base; the header chip answers with that same rule, so the badge the user reads and the guard that permits the delete can never disagree. Deleting with the branch checkbox on runs that merged-aware cleanup (the directory, its local branch and its manifest entry); with it off it is the plain removal, which keeps the branch, so a directory removed by mistake can be created again by picking that branch. Cleanup escalates a refused `git branch -d` to `-D` only after that merge check, and reports a branch it cannot delete instead of claiming success. A live session still blocks a lane's teardown, except in the one case that would otherwise be impossible: the conversation the lane records as its own may ask for it through its lane chip (and the teardown archives that conversation, as it does for any lane session). An id the lane does not record excuses nothing. Binding a conversation to its lane is validated before it changes anything: the session must be live, the branch must be a valid ref, the repository's manifest must record that lane, and the conversation's own cwd must resolve to exactly that directory - otherwise the request is refused (`lane-mismatch`, `session-unknown`, `worktree-not-found`, `invalid-branch`) and the session's access mode is left untouched. A bind records where a conversation already runs; it is never a way to move one, and it can never hand `danger-full-access` to a conversation that is not in the lane. Mutations also carry an explicit repository path, and that path must resolve inside a workspace the host has registered: `realpath` on the request side, the registry's own list, and a segment-aware containment test (so a sibling named `repo-other` is not read as inside `repo`). It is the same rule the Git workbench applies through its workspace gate, and a repository outside every workspace is refused with `workspace-unknown` before any git step runs.
- The Codex bridge (`/api/dsh-codex-bridge/*`) is deliberately outside that fence: device-code login, proxy restart, and chain verification are local operations, so a remote entry reports the module as unavailable instead of exposing it. Do not widen it to a remote authority.
- Remote entries get their Host ownership from `GET /web-all/remote-access/boot.js`, a parser-blocking boot row whose handler answers per request from the same fence. Without the claim DSH's client keeps the settings plane in a process-local memory store and Settings → Models reports `settings are unavailable in this browser`. `GET /api/dsh-access/session` publishes the credential-free posture (`authority.declared`, `session`, `owners`) that the fleet audit and the client fallback probe read.
- A plain-HTTP remote entry is not a browser secure context, so the same domain injects a `crypto.randomUUID` polyfill and an `execCommand`-backed `navigator.clipboard` shim (never replacing a real clipboard object) into every served index document. `navigator.locks` has no shim, so cross-tab Git stream sharing degrades to one stream per tab there.
- `noBrowserAuth` is opt-in and defaults to `false`. When enabled, it patches only BrowserAuth's authentication decision; the Host/Origin fence remains active. Enable it only behind an authenticating reverse proxy or an equivalent trusted network gate, and never as a convenience setting on a publicly reachable host.
- Integrated WebAuth composes with native BrowserAuth and keeps DSH's Host/Origin trust fence. Valid local, Feishu, and OIDC sessions cover the index, HTTP RPC and `/api/remote.mux`; native launch-token authentication is retained as break-glass access. The private BrowserAuth compatibility seam fails closed if its runtime shape changes.
- The `3082` gateway is a default-off compatibility listener. When enabled it has the same account store, while normal NetBird and reverse-proxy deployments route directly to DSH's `3080` origin and must configure DSH trusted hosts correctly.
- Account passwords are stored as per-account scrypt verifiers and checked with timing-safe comparison. Account and session stores use atomic owner-only `0600` files under `$DSH_HOME` by default. Account APIs omit password verifiers and passwords. Authorization/revocation journals and `.blocked` sidecars are sensitive recovery state and must be backed up with their main image; do not automatically remove a deny marker. Failed persistence rejects authentication in the current process and reports failure, not a committed edit. If an entire storage medium rejects every write, no durable denial can be recorded: after restart the last committed state can remain valid. Stop service access and recover storage before relying on a failed revocation; neither the store nor atomic rename provides power-loss fsync guarantees.
- Login creates a fresh 256-bit session id in an HttpOnly, SameSite=Lax cookie; the cookie is Secure only with built-in TLS. Sessions persist across restarts, default to seven days of idle time and a 30-day absolute cap, and are revoked by logout, administrator action, password or role changes, account disabling, or account deletion. A role change requires the affected account to sign in again; old cookies cannot retain their previous administrative role. Account image v2 atomically stores a nonempty authorization revision alongside account state; strict legacy migration invalidates cookies without that revision. Existing corrupt or unsupported account images require recovery, never automatic bootstrap. Slow administrative requests recheck authorization after reading the body. The legacy gateway closes both directions of an upgraded connection on revocation and checks expiry within one second; this does not prove immediate revocation of already-upgraded native DSH mux connections. The administrator session list includes opaque live session ids for revocation, so protect that surface as credential-sensitive.
- Integrated accounts are trusted operators: all authenticated users share this DSH instance's workspaces, sessions, settings, credentials and filesystem authority. Roles control account/session administration and legacy-gateway compatibility policy; they are not resource isolation or multi-tenant RBAC. In the legacy gateway, user WebSocket access includes `/api/remote.mux` while terminal and other upgrade paths require admin.
- TLS is optional. Without `serverTlsCert` and `serverTlsKey`, credentials, cookies, and traffic use plaintext HTTP and the gateway should remain on a trusted network. `serverTlsKey` is a readable filesystem path rather than key content, while `bootstrapAdminPassword` is a secret-schema field; protect the settings source, and clear or rotate bootstrap credentials after the first account is created. The first account is forced to admin, and the last enabled administrator cannot be demoted, disabled, or deleted.
- SSH keys, passwords, and passphrases are host-side configuration. Secret fields are excluded from list projections, but credentials are stored unencrypted under the DSH home in an atomically replaced owner-only `0600` file (including existing-file repairs on save), and remote command output is returned without redaction; protect the account and filesystem accordingly. Server key verification does not isolate remote execution or limit the SSH account's authority. Connection establishment is single-flight per host and rechecks current configuration and trust after authentication; unloading rejects pending/new connections. Malformed host stores fail closed without replacement. Cooperating writers hold an exclusive lock across the whole read-modify-save operation and wait up to two seconds; contention reports `SSH_HOST_STORE_BUSY`. A crashed writer's lock is not stolen based on age or PID: stop all writers and verify ownership before manual recovery. This is not an OS boundary against a malicious same-user process.
- Playwright tools can browse sites and mutate external systems with the permissions of the local DSH process and browser session. Keep their unique tool namespace, review target URLs, and close sensitive sessions when finished.
- Feishu credentials are written by the wizard routes behind the shared host access fence and land in the profile settings document. Notifications reuse that same application by default (or take their own `feishuAppId` and `feishuAppSecret`, which accept `env:NAME`). Treat that document as credential-sensitive, and keep the loopback web server private.

## Known limitations

- All service domains share one `web-all` lifecycle and cannot be enabled or disabled as separate profile entries.
- The shared host access fence decides whether a request comes from an admitted browser surface, not which account it belongs to: it exposes a single boolean. Surfaces whose data belongs to one conversation (the agent-browser live view at `/playwright-sessions/ws/browser`, workbench `git-status` in a registered workspace, and the memoir project store keyed by a session cwd) are therefore reachable by any caller the fence admits that also knows the session id or workspace path, and cannot be scoped per account until the host exposes caller identity to route families.
- Configuration surfaces are deliberately minimal: only Feishu and notifications have a page; other capability settings are edited through a profile override or the settings document.
- Notifications hold only what this process has seen, in memory: a host restart clears the recorded results and invalidates the ids a client had not read. A client whose stored position is higher than the feed's newest id (the host is a different process now) re-reads from zero, so new results can never be hidden; the cost is that the first read after a restart repeats whatever is currently held. What is recorded is the end event, not the conversation, whose body stays in the session log.
- The HiOpen catalog is a conservative agent-ready subset. Endpoint availability and upstream routing can change independently; advertised models that fail chat/tool probes are not exposed until verified.
- Playwright requires its bundled browser runtime and available browser binaries. A global `mcp-playwright` entry conflicts with the `mcp__playwright__*` tools owned here and must be removed.
- Only `ssh_exec` and `ssh_cluster` carry the default command timeout: SFTP transfers (`ssh_upload`, `ssh_download`) and the interactive Web terminal keep running until the transfer or the session ends, because their duration is set by payload size and remote responsiveness rather than by a command.
- "New session per run" tasks can be deleted through the agent tools, or by deleting the row on the run session in the native task page: either way the task stops and is not rebuilt. After a native-page delete the policy is retired at the next reconciliation (so schedule_mode_list stops reporting it); interrupted rotations resume only where their journal identifies the effects, otherwise they remain visibly `recovery-required`.
- Archiving or stopping the original conversation disarms that task's run copy and marks it stopped (the native layer only cleans rows bound to the archived conversation).
- Compatibility follows the pinned `@deepseek-ai/*` SDK versions and the repository release cadence.

## License

Apache-2.0. Third-party assets and retained implementations keep their own notices in the repository source packages.
