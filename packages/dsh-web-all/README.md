# @dsh-cove/dsh-web-all

English | [中文](README.zh.md)

`@dsh-cove/dsh-web-all` is the single runtime entity for the dsh-cove feature family. Its runtime patch contributes exactly one entity row, `web-all`; separate bundle patches declare the HiOpen model route and optional `code-vibe` Agent preset. Browser features are coordinated by the sidebar, conversation, and settings position modules, while host capabilities run as service domains in the same plugin lifecycle.

## What it does

- **Workspace and session workflow**: Git worktree management with per-session isolation, and workspace-model presets. Worktrees have no page of their own. A worktree is a lane: the composer's branch picker creates the branch's worktree and registers its directory as a workspace (a platform requirement, not a taste: a session is only accounted to a workspace while its cwd equals that workspace's path, and a blank conversation no workspace accounts for has an inert composer), then moves the conversation onto it through the platform's own workspace navigation. That registration is short-lived by design: archiving the lane's conversations retires it (the directory, the branch and the binding stay, so picking the branch again re-registers it in one step), and a boot pass retires the rows an older build left behind. The conversation header's lane chip names that branch and carries the rest of its life - open the PR, check whether it is merged, and delete the directory (optionally the local branch with it), which also unregisters the workspace. The copy a user reads says "branch directory", never worktree or lane.
- **Development workbench**: the Git branch chip and graph dialog in the composer, and the right-pane Source Control workbench.
- **Memory viewer (read-only)**: the sidebar's Memory page reads the OpenViking global space and the current workspace's peer space - directory by directory, document text, and semantic search. It never writes and keeps no local store; the OpenViking plugin owns the memory itself. See [docs/memory-view.md](../../docs/memory-view.md).
- **HiOpen model route**: a credential-free `llm-pi-ai` preset ships a curated model catalog for any OpenAI-compatible endpoint; the address is bring-your-own (set `llm.hiopen.baseUrl` in `config/deployment.local.json`, then run `node scripts/config-render.mjs`) and no endpoint or credential is committed. It curates exact model ids, context/output limits, reasoning levels, and text/image modalities for DSH agent use.
- **Remote operations**: SSH hosts, terminal, transfer, tunnels and cluster execution. The plugin no longer mints account sessions for a remote browser entry; remote reachability is decided by the deployment's `--trusted-host` and its network gate, as described in [docs/remote-access.md](../../docs/remote-access.md).
- **Feishu (Lark) bot**: one shared application - the `feishu` namespace (`appId`, `appSecret`, `domain`; `appSecret` accepts `env:NAME`, and an ambient `FEISHU_APP_SECRET` takes precedence over the legacy `LARK_APP_SECRET`) - serves three surfaces of the same bot: the WebSocket inbox with the `lark_inbox_peek`, `lark_inbox_pop`, `lark_inbox_ack`, `lark_inbox_reply` and `lark_autoreply_status` tools, the reply the agent sends to an inbound message, and the run-finished push. The credential wizard and the credential area of the page under **Settings → Built-in plugins → Feishu** configure it; the manual area is what lets an installation without lark-cli finish the setup.
- **Run-finished notifications**: every finished turn is recorded and aggregated into the read-only `GET /api/dsh-notify/feed`, which the desktop and mobile machine lists use to mark results that have not been looked at, and which can be pushed to Feishu once the run has fully stopped. Configure it under **Settings → Built-in plugins → Notifications**.
- **Browser automation**: per-session Playwright browsers exposed as the `mcp__playwright__*` tool namespace.
- **Automation run target**: native automation tasks deliver into the conversation that created them; this capability lets each task run in a fresh session every time instead, keeping the original conversation clean. There is no settings UI for it: it is chosen in natural language when the task is created, and the agent applies it with `schedule_mode_set`.
- **Wish Programming preset**: a bundled `code-vibe` preset with tiered task routing, its curated skills, a session confirmation and routing gate, and native coding tools appears as an additional session mode; Standard remains the default.
- **Superagent (secretary)**: an optional second owner for Feishu inbound messages that keeps commitments in a ledger, dispatches work to executor sessions and reports back, behind a three-position switch that defaults to the existing responder.

The web profile runtime stack is `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + `@dsh-cove/dsh-web-all`.

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
| `playwright` | `{ mode: launch, … }` | Selects isolated browser launch, attended attachment to selected tabs in the user's Chrome/Edge, or CDP attachment to a browser the operator already started. |

Example profile override:

```yaml
- id: web-all
  config:
    noBrowserAuth: true
```

Capability settings aggregate as namespaces of the single `web-all` entry: `feishu`, `lark-inbox`, `notify`, `dsh-ssh`, `workspace-model`, `web-render`, and `schedule-mode`. The Web GUI carries one page for Feishu and one for notifications (**Settings → Built-in plugins → Feishu / Notifications**); the Feishu page owns both how events arrive and the shared application credentials, and the notifications page owns how results go out and how clients read them. The credential secret is write-only: the Host stores it and strips it from every read, so the page can send a new secret, reports no stored value, and treats an empty box as "keep the current one"; `lark-inbox` still carries the pre-shared-namespace `appId`, `appSecret` and `domain` for an installation configured before the move, and the wizard routes only write `feishu`. Edit the other namespaces through a profile override or the settings document. The same page carries the answer path: `autoReplyMode` (`off` queues without answering, `probe` runs the whole path but only records the reply, `self` answers direct messages and group messages that mention the bot), `autoReplyOpenIds` (who may be answered; blank means no allowlist), `autoReplyCwd` (the working directory reply sessions run in) and `autoReplyPreamble` (instructions prepended to the first message of each new conversation). Consecutive messages in one conversation fold into a single turn and a turn produces exactly one reply; a failed, timed-out or interrupted turn still sends a sentence, so the path is never silent. Finished queue rows and reply jobs are pruned after `retentionDays` (default 30, `0` keeps them); the daily JSONL shards are left alone, so the record of what the platform sent survives the index. The idempotency keys live in the rows that retention prunes, which makes `retentionDays` the honest limit of the "one reply per message" promise: a redelivery older than that window looks like a new message. `autoReplyReceipt` (on by default) adds a reaction as soon as a message is accepted, so the sender can see it was read even while it queues behind another turn; a reaction that is refused costs a log line and never the reply, and probe mode does not react at all. `proactiveNotice` (off by default) lets the bot speak first about a long run in another session: three gates decide whether the model is even asked - the run was long, the hour is not quiet, the conversation is under its hourly budget - and the model answers `SILENT` when it should stay quiet, which the ledger records as a deliberate `empty` rather than as a cancellation. `autoReplySteer` (`off`, `shadow` or `on`; `off` by default) decides whether a message that arrives while the bot is working on that conversation has to queue: with `on` it may join the turn already running instead of waiting for the next one, and that decision is made deterministically - the turn is bound, enough of its deadline remains, nothing is stopping it or timing out, no batch is collecting, and this turn has not taken its limit of folded-in messages. `shadow` records what that decision would have been and folds nothing in. A folded-in message and the one it joined still produce exactly one reply, and that reply is attached to the message that was folded in. `autoReplyRouter` (`off` or `on`; `off` by default) hands the shape of the answer to the conversation: with `on` the instructions gain a paragraph about how to converse, and the model may answer either with prose or with `ACK` alone - a reaction on the sender's message and no text. One guard stands between that choice and the person, and it only pushes towards speaking: a direct question, meaning one that carries a question mark or question word or is not purely an acknowledgement or thanks, is never downgraded to a reaction, and when the guard refuses, a fixed sentence is sent instead; a reaction that cannot be made falls back to text. The instructions are versioned by their own hash, so a conversation told an older set receives the current one once. Both are hot-reload switches, and setting either to `off` restores the behaviour without it: messages wait for their own turn, and every answer is prose.

The bundled `hiopen` route resolves `HIOPEN_API_KEY` through DSH credentials; store the secret as `refs.HIOPEN_API_KEY` in `$DSH_HOME/.credentials.yaml`, never in the profile or repository. The preset intentionally exposes a curated chat/agent subset rather than every item returned by `/v1/models`: the endpoint also advertises embedding, guard, detector, and temporarily unavailable routes. A profile override can replace or extend the `hiopen.models` list when the endpoint changes.

The Playwright service domain is the sole owner of public tool names under `mcp__playwright__*`. Remove any global `mcp-playwright` row before starting this plugin; duplicate tool ownership makes Playwright registration fail. Its default `launch` mode keeps browser processes isolated by DSH session, limits them to two concurrent browsers, and reclaims idle sessions. `extension` mode instead gives one attended DSH session an exclusive lease on tabs selected through the official [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm): `POST /api/playwright-sessions/connect` opens the extension's approval and tab picker, and the external Chrome remains open after disconnect. The browser is exposed as `mcp__playwright__*` tools only: the right pane has no browser tab and no live view. `cdp` mode attaches to a browser the operator already started with `--remote-debugging-port`: point `cdpEndpoint` at it and the session drives that browser directly, with no extension and no consent prompt, while the browser's persistent profile keeps its sign-ins (Chrome 136 and later only honor remote debugging together with a non-default `--user-data-dir`, so keep a dedicated automation profile and sign in there once). The control plane uses the plugin's shared host access fence — a loopback request, or a Host authority the deployment declares through `--trusted-host` (read from `ctx.webStartup.trustedHosts`, or `ctx.webRuntime.trustedHosts` on earlier SDKs) carrying an authenticated DSH browser session. Only `extension` mode is gated: unsafe code execution is hidden there by default, and `approvalPolicy: mutations` asks through DSH before every non-read-only browser action.

```yaml
- id: web-all
  config:
    playwright:
      mode: extension
      browserChannel: chrome
      approvalPolicy: mutations
      allowedOrigins: ['https://example.com']
```

Attach to a browser the operator started instead (no extension and no consent prompt):

```yaml
- id: web-all
  config:
    playwright:
      mode: cdp
      cdpEndpoint: http://127.0.0.1:9222
```

`allowedOrigins` and `blockedOrigins` are Playwright navigation guardrails rather than complete authorization boundaries: redirects and page content remain untrusted.

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

## Superagent

The `superagent` service domain is a secretary on the same Feishu inbox. It shares the `web-all` lifecycle and the Feishu queue's `inbox.sqlite`, and it leaves the existing responder in place.

A three-position switch decides who answers each inbound message. The switch is read for every message, so a change applies to the next message without restarting the process.

| Mode | Who answers | What superagent writes |
| --- | --- | --- |
| `responder` (default) | the existing responder, exactly as before | message ownership only |
| `shadow` | the existing responder | its own judgment on shadow rows; it never sends a message |
| `superagent` | the secretary | the ledger and every outbound message |

The keys live in the `lark-inbox` settings namespace; there is no settings page for them.

| Key | Meaning |
| --- | --- |
| `superagentMode` | `responder`, `shadow` or `superagent`; any other value reads as `responder` |
| `superagentDesk` | `seatDir`, `preset` (default `superagent-desk`) and an optional `model` with `provider`, `model`, `effort`; no model keeps the global default |
| `superagentWorld` | `owners` and `colleagues` (`union_id`, `name`), `entities`, and `mandates`, which only people grant |
| `superagentAttention` | `interruptQuota` (3), `quiet` (`22:00` to `08:00`) and `briefAt` (`18:30`) |

- The domain takes effect after the DSH service is restarted; until then the responder runs unchanged. Back up `$DSH_HOME/lark-inbox/inbox.sqlite` before the restart.
- Switching back to `responder` keeps the ledger; switching forward again continues from it.
- Check the ledger with `node scripts/superagent-check.mjs --db <inbox.sqlite>`; after a shadow period, `node scripts/superagent-check.mjs --shadow --since-hours 72` reads the shadow criteria.

## Security model

- Host APIs that expose local state or privileged actions share one access fence: a loopback request, or a Host authority the deployment declares through `--trusted-host` (read from `ctx.webStartup.trustedHosts`, or `ctx.webRuntime.trustedHosts` on earlier SDKs) carrying an authenticated DSH browser session, always with same-origin markers. The socket itself must stay loopback, which is why a same-host reverse proxy forwards the canonical Host to `127.0.0.1`. The fence is not a substitute for an authenticated network boundary, and `noBrowserAuth: true` reduces the remote branch to the Host/Origin check alone.
- Reads are privileged too: the worktree index and lane lookup, the workspace-model reads, the finished-run feed (`GET /api/dsh-notify/feed`), and the Feishu credential wizard all carry that fence. The feed publishes the session title, the end reason and the time only, never the conversation body, and it has no write route: a client's read position is stored on the client, so the host keeps no per-client state. There is no second allow path, and the worktree mutations consult the fence alone. Pairing administration under `/api/pair/*` is stricter: it requires a loopback Host as well as a loopback socket, so a same-host reverse proxy cannot expose token minting, listing, or revocation to a remote browser.
- Worktree git calls are bounded and fail closed: `git fetch`, `ls-remote` and the ancestor probes carry a 15 s deadline and a push 180 s, so a stalled network can neither hold a repository's operation lock nor leave the lane menu loading. `POST /worktree/status` is served from a host cache (60 s) that every mutation this plugin performs invalidates, so opening the lane menu is a memory read and only its explicit "check whether it is merged" action (or a name-filtered probe) runs the network checks again. A lane is merged when its remote tip is an ancestor of the base, or - once the tracking ref has been pruned, which is what GitHub's delete-on-merge leaves behind - when it moved past the commit it was created from and its local tip is contained in the base; the header chip answers with that same rule, so the badge the user reads and the guard that permits the delete can never disagree. Deleting with the branch checkbox on runs that merged-aware cleanup (the directory, its local branch and its manifest entry); with it off it is the plain removal, which keeps the branch, so a directory removed by mistake can be created again by picking that branch. Cleanup escalates a refused `git branch -d` to `-D` only after that merge check, and reports a branch it cannot delete instead of claiming success. A live session still blocks a lane's teardown, except in the one case that would otherwise be impossible: the conversation the lane records as its own may ask for it through its lane chip (and the teardown archives that conversation, as it does for any lane session). An id the lane does not record excuses nothing. Binding a conversation to its lane is validated before it changes anything: the session must be live, the branch must be a valid ref, the repository's manifest must record that lane, and the conversation's own cwd must resolve to exactly that directory - otherwise the request is refused (`lane-mismatch`, `session-unknown`, `worktree-not-found`, `invalid-branch`) and the session's access mode is left untouched. A bind records where a conversation already runs; it is never a way to move one, and it can never hand `danger-full-access` to a conversation that is not in the lane. Mutations also carry an explicit repository path, and that path must resolve inside a workspace the host has registered: `realpath` on the request side, the registry's own list, and a segment-aware containment test (so a sibling named `repo-other` is not read as inside `repo`). It is the same rule the Git workbench applies through its workspace gate, and a repository outside every workspace is refused with `workspace-unknown` before any git step runs.
- Remote entries get their Host ownership from `GET /web-all/remote-access/boot.js`, a parser-blocking boot row whose handler answers per request from the same fence. Without the claim DSH's client keeps the settings plane in a process-local memory store and Settings → Models reports `settings are unavailable in this browser`. `GET /api/dsh-access/session` publishes the credential-free posture (`authority.declared`, `session`, `owners`) that the fleet audit and the client fallback probe read.
- A plain-HTTP remote entry is not a browser secure context, so the same domain injects a `crypto.randomUUID` polyfill and an `execCommand`-backed `navigator.clipboard` shim (never replacing a real clipboard object) into every served index document. `navigator.locks` has no shim, so cross-tab Git stream sharing degrades to one stream per tab there.
- `noBrowserAuth` is opt-in and defaults to `false`. When enabled, it patches only BrowserAuth's authentication decision; the Host/Origin fence remains active. Enable it only behind an authenticating reverse proxy or an equivalent trusted network gate, and never as a convenience setting on a publicly reachable host.
- TLS is optional. Without `serverTlsCert` and `serverTlsKey`, credentials, cookies, and traffic use plaintext HTTP and the gateway should remain on a trusted network. `serverTlsKey` is a readable filesystem path rather than key content, while `bootstrapAdminPassword` is a secret-schema field; protect the settings source, and clear or rotate bootstrap credentials after the first account is created. The first account is forced to admin, and the last enabled administrator cannot be demoted, disabled, or deleted.
- SSH keys, passwords, and passphrases are host-side configuration. Secret fields are excluded from list projections, but credentials are stored unencrypted under the DSH home in an atomically replaced owner-only `0600` file (including existing-file repairs on save), and remote command output is returned without redaction; protect the account and filesystem accordingly. Server key verification does not isolate remote execution or limit the SSH account's authority. Connection establishment is single-flight per host and rechecks current configuration and trust after authentication; unloading rejects pending/new connections. Malformed host stores fail closed without replacement. Cooperating writers hold an exclusive lock across the whole read-modify-save operation and wait up to two seconds; contention reports `SSH_HOST_STORE_BUSY`. A crashed writer's lock is not stolen based on age or PID: stop all writers and verify ownership before manual recovery. This is not an OS boundary against a malicious same-user process.
- Playwright tools can browse sites and mutate external systems with the permissions of the local DSH process and browser session. Keep their unique tool namespace, review target URLs, and close sensitive sessions when finished.
- Feishu application credentials live in the `feishu` namespace of the profile settings document and are written by the wizard routes or by the Feishu page's credential area, both behind the shared host access fence. The secret is write-only: the Host strips `role('secret')` fields from every read, so the page can send a new one but never displays the stored one, and `env:NAME` keeps it out of the document entirely. The same bot serves inbound intake, replies, and run-finished notifications; notifications may still carry their own `feishuAppId` and `feishuAppSecret`. An ambient `FEISHU_APP_SECRET`, then the legacy `LARK_APP_SECRET`, supplies the secret when neither namespace holds one. Treat that document as credential-sensitive, and keep the loopback web server private.

## Known limitations

- All service domains share one `web-all` lifecycle and cannot be enabled or disabled as separate profile entries.
- The shared host access fence decides whether a request comes from an admitted browser surface, not which account it belongs to: it exposes a single boolean. Surfaces whose data belongs to one conversation (workbench `git-status` in a registered workspace, and workspace data keyed by a session cwd) are therefore reachable by any caller the fence admits that also knows the session id or workspace path, and cannot be scoped per account until the host exposes caller identity to route families.
- Configuration surfaces are deliberately minimal: only Feishu and notifications have a page; other capability settings are edited through a profile override or the settings document.
- Feishu intake is single-instance per `$DSH_HOME`: exactly one dsh-web process may consume the bot's queue. The application's long connection is delivered to a random connected client rather than broadcast, so a second process on the same `$DSH_HOME` silently misses events instead of sharing them.
- The bot does not subscribe to `im.message.recalled_v1`, so a recalled message can still sit in the queue and be handed to the agent by `lark_inbox_peek` or `lark_inbox_pop`. `allowedOpenIds` left empty accepts every sender; list the allowed open_ids to restrict who can reach the agent.
- Read the intake tools by the question they answer: `lark_inbox_peek` reports `gateway` (`connected`, `connecting`, `error`) plus `gatewayError`, which separates "no new messages" from "the socket is not up"; `peek` and `pop` both carry `chatId`, which is what `lark_inbox_reply` addresses, so an answer lands in the conversation it came from (and in the original thread when the message id is known); `lark_inbox_ack` answers `not-found` for an event that is unknown or already settled instead of reporting success. A group message is not queued while `requireMentionInGroup` is on and the bot's own open_id could not be learned (fail-closed); direct messages are unaffected, and turning the rule off removes the dependency on that identity.
- Notifications hold only what this process has seen, in memory: a host restart clears the recorded results and invalidates the ids a client had not read. A client whose stored position is higher than the feed's newest id (the host is a different process now) re-reads from zero, so new results can never be hidden; the cost is that the first read after a restart repeats whatever is currently held. What is recorded is the end event, not the conversation, whose body stays in the session log.
- The HiOpen catalog is a conservative agent-ready subset. Endpoint availability and upstream routing can change independently; advertised models that fail chat/tool probes are not exposed until verified.
- Playwright requires its bundled browser runtime and available browser binaries. A global `mcp-playwright` entry conflicts with the `mcp__playwright__*` tools owned here and must be removed.
- Only `ssh_exec` and `ssh_cluster` carry the default command timeout: SFTP transfers (`ssh_upload`, `ssh_download`) and the interactive Web terminal keep running until the transfer or the session ends, because their duration is set by payload size and remote responsiveness rather than by a command.
- "New session per run" tasks can be deleted through the agent tools, or by deleting the row on the run session in the native task page: either way the task stops and is not rebuilt. After a native-page delete the policy is retired at the next reconciliation (so schedule_mode_list stops reporting it); interrupted rotations resume only where their journal identifies the effects, otherwise they remain visibly `recovery-required`.
- Archiving or stopping the original conversation disarms that task's run copy and marks it stopped (the native layer only cleans rows bound to the archived conversation).
- Superagent runs one durable executor at a time; further repository work waits in line, with five places.
- Without message-history read permission for the Feishu application, superagent cannot detect a second instance answering the same bot.
- Superagent has no panel: its state is read through the `status` command route and the ledger check script.
- Compatibility follows the pinned `@deepseek-ai/*` SDK versions and the repository release cadence.

## License

Apache-2.0. Third-party assets and retained implementations keep their own notices in the repository source packages.
