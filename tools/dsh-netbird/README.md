# NetBird DSH deployment

English | [中文](README.zh.md)

This directory is the operational source of truth for exposing one DSH Web instance on every computer in the private NetBird network. Employees who join the network follow [employee-guide.md](employee-guide.md). Machine names, addresses and peer ids in this directory are sanitized examples; replace them with your own deployment values.

## Address contract

Every computer uses exactly one canonical browser address:

```text
http://dsh.<NetBird machine name>.netbird/
```

The machine name is the peer name shown by `netbird status`, without the `.vpn` suffix. The current inventory and expected NetBird IPv4 address live in [machines.json](machines.json). The canonical name is the single naming rule: no compatibility aliases, short names, `.vpn` names, or NetBird IP literals.

The address has no explicit port. NetBird custom DNS owns the `dsh.<machine>.netbird` A record, and nginx listens on port 80 on that machine's NetBird IPv4 only (see Overlay gate).

## Mobile entry

The phone and tablet entry point is [tools/netbird-client](../netbird-client/README.md), a React Native portal that reaches these machines over the overlay. Its service list derives from the same NetBird DNS zones documented here, so a new machine becomes reachable from phones once it has a `dsh.<machine>.netbird` A record. The client accepts only records whose target address belongs to its own peer set (see that directory's discovery rules), so other machine names in the same zone never reach the list; and a zone itself is delivered per distribution group, so a client without the zone has no list at all. See NetBird DNS records below. Installers come from the update channel served by the network edge over public HTTPS, `https://anywhere.example.com/` (the sample address used throughout this manual; the same host also answers it as `tx` / `tx.vpn` - see the domain contract in [netbird-management.md](netbird-management.md)).

## Required traffic path

```text
browser -> dsh.<machine>.netbird:80 -> nginx -> 127.0.0.1:3080 DSH Web with integrated WebAuth
```

The DSH process starts with `--host 127.0.0.1 --port 3080 --no-open` and passes every canonical browser authority through `--trusted-host`. Nginx proxies the canonical host to that loopback listener and preserves Host, Origin, cookies, and WebSocket upgrade headers. DSH must trust only the documented canonical host; direct LAN and NetBird-IP listeners remain disabled. Port 3082 is a default-off compatibility listener and is not part of this topology.

The profile `web` row's `trustedHosts` value does not reach the runtime fence in this SDK: the connection service reads `ctx.webRuntime.trustedHosts`, which the Web runtime derives from the invocation flags. Pass the canonical authority on the command line instead, and keep IP literals, compatibility aliases, and other LAN names out of that list.

That same `ctx.webRuntime.trustedHosts` list is the admission list for the plugin's host-side panels: web-all's Git workbench, Agent Browser, worktree, SSH, memoir, run-target and right-pane workbench routes share one host access fence — the request socket must be loopback, and the Host must be loopback or a declared authority carrying a valid DSH browser session (the one HttpOnly session minted by local accounts, Feishu or OIDC, or the native launch token); cross-site markers, a missing Host, an undeclared Host or a missing session are refused with 403. A local browser hitting `127.0.0.1:3080` sends a loopback Host, so it needs no extra configuration. `noBrowserAuth: true` reduces the remote branch to the Host/Origin check alone, which exposes those panels to any peer that can reach port 80.

Nginx proxies to `127.0.0.1:3080`. Use [nginx.conf.template](nginx.conf.template) as the minimal virtual-host template. Keep `proxy_buffering off;`: DSH and plugin JavaScript bundles can exceed nginx's in-memory proxy buffers, and a worker that cannot access a temp path under a user's home will otherwise truncate the response and leave an empty application root after login.

Worker temp paths must stay outside user directories for the same reason: the worker runs as the compiled default user (`nobody` on macOS) while the master keeps the privilege port 80 needs and creates every temp path as root at startup before chowning it to that user; a path under a user home the worker cannot traverse is never writable, so a request body above the in-memory buffer has to spool to a temp file and fails with a 500 when that write fails. The template pins all five `*_temp_path` directives under `/var/tmp/dsh-nginx/`, whose parent directory must be created once as root: nginx creates only the leaf directories, and a missing parent makes nginx fail to start.

Set `typert-gateway.config.websocketHeartbeatIntervalMs` to `30000` as shown in [cordis.patch.yml](cordis.patch.yml). DSH's upstream default of `2000` milliseconds controls both the WebSocket Ping cadence and the Pong deadline; a browser main-thread pause, host event-loop stall, or NetBird overlay delay longer than two seconds makes the Host terminate a healthy `/api/remote.mux`, after which the client reconnects at a regular cadence. Thirty seconds still detects dead peers promptly while tolerating normal scheduler and mesh jitter.

## Directory picker

A peer's browser reaches this machine through nginx and can never see the host display, so every machine's Web profile composes the browse interaction as a fixed pair instead of DSH's shipped adaptive chooser: per [cordis.patch.yml](cordis.patch.yml) the bundle's `directory-picker` row is disabled and `@deepseek-ai/dsh-host-directory-picker-browse` plus its browser half `@deepseek-ai/dsh-client-ui-directory-picker-browse` are inserted. `name` in a patch is a mismatch guard rather than a rename, so pinning is disable-and-insert, and both faces belong to one interaction and must be composed together.

The adaptive chooser resolves `native` in this topology by construction: it reads only the bind address (loopback) and the launch shape (not over SSH) and concludes that an operator sits at the host display, because it cannot see the nginx in front of it. Each `native` `pick` opens one OS chooser on the host display and waits for an operator; a peer can neither see nor answer it, so the request hangs until nginx gives up with `HTTP 504`. The browse backend lists host directories level by level and creates child directories in the browser instead, which serves a local browser and the canonical remote entry alike.

Read the interaction one machine composed:

```sh
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"type":"client-request","rpcId":"picker","method":"directoryPicker/list","payload":{"args":{}}}' \
  http://dsh.<machine>.netbird/api/directoryPicker/list
```

Browse answers with a directory listing; `native` answers with the seam's `directory-picker/unavailable` naming `"native"` in `details.capability`.

## Overlay gate

The entry is open to the NetBird overlay only: the DSH virtual host binds port 80 to that machine's NetBird IPv4 (template in [nginx.conf.template](nginx.conf.template)), so the public Internet, an office LAN and a home LAN cannot reach it.

- The bind is the first step: it narrows the listener from every interface to the overlay address. Nginx selects the virtual host by the connection's local address, so other virtual hosts on the same port keep serving their own addresses and a request for any other address never lands on DSH.
- Linux additionally needs an interface-scoped firewall rule: deny inbound port 80 by default and allow only the NetBird interface `wt0`. The kernel delivers by local address, so a packet addressed to the machine's NetBird address is accepted on any interface; the bind narrows the listener, the firewall is what filters.
- Nginx binds only once the NetBird address exists: `After=netbird.service` on the Linux service unit, and a macOS LaunchDaemon that retries through `KeepAlive` until the address appears.
- Port 443 is a privileged port just as 80 is: the nginx master has to be allowed to bind it. A `listen` that cannot bind fails the whole configuration load, so a machine without that capability carries no TLS block (the template declares the two blocks independently, so deleting the TLS one leaves the port 80 entry alone).

`authMode` is declared per machine in [machines.json](machines.json), and the audit judges the signed-out entry against it:

| authMode | Signed-out entry | Allowed when |
| --- | --- | --- |
| `password` | `302` to `/login` | Default; integrated WebAuth protects the shell, the API, and the privileged panels. |
| `network-gate` | The DSH document | The gate is deployed and verified live by `--verify-gate`. |

`network-gate` makes overlay membership the only credential: any device that can join the network may drive the Git, SSH, worktree and Agent Browser panels without a second factor. The audit therefore refuses such a machine while its gate is unverified, and tightening NetBird ACLs and setup keys is a precondition of that mode.

## TLS entry

Plaintext HTTP is not a browser secure context, and a capability that asks for a real permission cannot be filled in from the page: the plugin injects a `crypto.randomUUID` polyfill and a `navigator.clipboard` shim into the index document, but a microphone cannot be faked - `navigator.mediaDevices` does not exist outside a secure context at all, which is why the official voice-input plugin reports "this browser cannot record". `https://dsh.<machine>.netbird/` on the same machine is the entry that exists for this class of capability: it is the same virtual host and the same `127.0.0.1:3080` proxy path, with TLS and a certificate issued for exactly that canonical name.

The fleet uses one private CA (template in the TLS block of [nginx.conf.template](nginx.conf.template)), and private material stays outside the repository:

```sh
# one leaf per machine; re-running keeps a still-valid certificate, --rotate replaces it
pnpm dsh-netbird:tls init
pnpm dsh-netbird:tls issue <machine> [<machine>...]
pnpm dsh-netbird:tls trust          # prints how each client trusts the root
pnpm dsh-netbird:tls verify --host dsh.<machine>.netbird --ip <NetBird IP>
```

- The default directory is `~/.dsh/tls`: `ca.key` and the leaf keys are `0600`, the certificates `0644`; a `--dir` inside the repository is refused, because a root that was committed once cannot be withdrawn by deleting the commit.
- The root has to be installed in the system trust store of every **client** machine (`trust` prints the commands for the macOS system keychain, Debian/Ubuntu and RHEL/Fedora). Chrome and the desktop client read the system keychain, so they work as soon as it is installed; Android's GeckoView reads only its own root store, so the mobile client keeps using the port 80 entry - which is why the port 80 entry does not redirect to HTTPS.
- Rotation: replace a leaf with `issue --rotate`; replacing the root means rebuilding `ca.key`/`ca.crt` and running `issue` for every machine, which re-issues because the script judges a leaf by its signature rather than by the issuer name.
- Deployment: render the template into that machine's virtual host (`__MACHINE__`, `__NETBIRD_IP__`, `__TLS_DIR__`), run `nginx -t`, then reload; the master has to be able to bind 443 first (on macOS see macOS service). The port 80 block keeps serving, with no redirect.
- The nginx has to have the SSL module: `nginx -t` answers `the "ssl" parameter requires ngx_http_ssl_module` when the machine's nginx is a minimal build without `--with-http_ssl_module` (the fleet's own `~/.dsh/nginx/sbin/nginx` on macOS is exactly that), and no configuration change can make up for it - the build has to be replaced or rebuilt with SSL.
- The serving process has to be able to read the certificate files: the TLS directory must be visible to that machine's nginx, and a containerized service needs it mounted; a container that mounts a **single file** keeps reading the old inode after the host replaces that file, so write it before the container starts or mount the whole configuration directory.
- Verification: `verify` performs a real handshake with that machine's leaf (chain and host name both have to pass); on the client side, check whether voice input works on `https://dsh.<machine>.netbird/`, and `node poc/tls-entry.mjs` reproduces the whole chain locally for the desktop client.

## Authentication contract

DSH's integrated WebAuth is the browser-facing authentication wall and the criterion of `password` mode. Keep `web-all.config.noBrowserAuth` false, enable `remote-web-ui.integratedAuthEnabled`, and configure a local break-glass administrator plus any Feishu or OIDC providers. The same session protects the native Web index, HTTP API, and `/api/remote.mux`; mobile browsers use that native index at `/`. The full contract for every privileged host route family behind a remote entry (Host ownership declaration, the shared fence, the cleartext fallbacks) lives in [docs/remote-access.md](../../docs/remote-access.md); this page records only the values deployed across the fleet.

A correct signed-out HTML request returns `302` to `/login`. After a valid login, the same request returns the DSH HTML document with HTTP `200`. Native launch-token authentication remains available locally. OAuth providers require an externally reachable HTTPS callback origin configured as `publicBaseUrl`; private HTTP deployments can use local passwords without one.

`network-gate` replaces that wall as described in Overlay gate: `noBrowserAuth: true` reduces the host access fence to the Host/Origin check, so the audit accepts the machine only once its gate has been verified live.

## Preset model access

The fleet-wide LLM provider preset is [llm-models.patch.yml](llm-models.patch.yml): the field-verified router model catalog (the endpoint comes from `config/deployment.local.json`, never from the repository) (models, context-window caps, max output, reasoning efforts) plus the per-machine codex subscription proxy (`codex-local`). Merge its `llm-pi-ai` provider block into the single existing `llm-pi-ai` row of each machine's `$DSH_HOME/profiles/web/cordis.patch.yml` (replace same-named providers wholesale) and replace the `agent-default-model` row; the machine administrator restarts dsh web afterwards.

The desktop one-liner ([client/install.sh](client/install.sh)) starts a fresh machine from a compact subset of that catalog - Kaon Router with `kaon/deepseek-v4.1-flash` as the default model and a handful of models - so an employee-installed machine works before an administrator touches it; [../../scripts/dsh-netbird-client-dsh.test.mjs](../../scripts/dsh-netbird-client-dsh.test.mjs) holds those values against this preset, and the command below replaces the block wholesale, which is how such a machine converges on the full catalog.

Secrets stay out of the repository and out of service units:

- `KAON_ROUTER_API_KEY` and `DSH_API_PROXY_KEY` are DSH credential references living in each machine's `$DSH_HOME/.credentials.yaml` under `refs:`; the `DSH_API_PROXY_KEY` value must match an `apiKeys` entry of that machine's dsh-api-proxy `config.yaml`.
- Keep the credential file 0600 and owner-readable only; a missing secret only fails that provider's requests and never blocks dsh web startup.

`codex-local` points at the [dsh-api-proxy](../dsh-api-proxy/README.md) on `127.0.0.1:8317`: every machine runs its own copy and logs in with its own ChatGPT subscription via `--login --provider=codex` (OpenAI ToS forbids relaying other people's sessions; local personal use only). Machines without the proxy keep the provider block without startup impact.

The codex-local context-used meter depends on the proxy forwarding the usage chunk at the end of a stream: the current repository dsh-api-proxy does (the SDK sends `stream_options.include_usage` by default), while the legacy standalone auth2api and stale dist builds do not, and the display stays empty. Update each machine's proxy through a worktree so the machine's own checkout and uncommitted work stay untouched:

- Machines with GitHub SSH access: `git fetch origin dev`, then `git worktree add ~/code/dsh-proxy origin/dev --detach`, and inside `~/code/dsh-proxy/tools/dsh-api-proxy` run `npm ci && npm run build`.
- Machines without access: the ops workstation runs `git bundle create /tmp/dsh-dev.bundle dev` and scps it over; the target runs `git fetch /tmp/dsh-dev.bundle dev` and continues with the worktree step above (delete the bundle afterwards).
- Point the service unit's `WorkingDirectory` and `ExecStart` at the worktree dist, then `systemctl --user daemon-reload && systemctl --user restart auth2api.service`; copy the machine-local `config.yaml` into the worktree unchanged.

Applying the preset goes through the repository command instead of hand-editing each host:

```sh
# dry run: what each target would change, no writes, no restarts
pnpm dsh-netbird:llm-apply -- --dry-run

# apply to every machine and restart per its service shape (the
# operator's own ssh-studio-mac is always refused)
pnpm dsh-netbird:llm-apply

# single host, same-machine credential mapping, cross-host key pipe
pnpm dsh-netbird:llm-apply -- ssh-thinkpad-lab --copy-ref CODEX_LOCAL_API_KEY:DSH_API_PROXY_KEY
ssh ssh-laptop-b '<command printing KAON_ROUTER_API_KEY>' | pnpm dsh-netbird:llm-apply -- --ref-stdin KAON_ROUTER_API_KEY nb-tx
```

The command merges on the ops workstation (fetch -> pure-function merge -> write back); the remote side needs only cat/tee plus service control, and every write is preceded by a timestamped backup. Machine-local secrets move only between that machine's own files (`--copy-ref`) or through a direct pipe from another machine (`--ref-stdin`); they never enter the repository or argv. `pnpm dsh-netbird:audit` and the scripts drift-gate tests guard the preset and the machine inventory.

## Service-operation pre-flight

Before killing, restarting, or hand-launching DSH on a host, establish who supervises it; before editing a profile or moving/archiving anything under `~/.dsh`, confirm no service definition or hook script depends on that path. All four checks apply:

1. Find the supervisor: `systemctl status <pid>`, or read `/proc/<pid>/cgroup`; check **both the system and user scopes** (`systemctl is-active dsh-web.service` and `systemctl --user is-active dsh-web.service` can each hit; on macOS use `launchctl print gui/$(id -u)/<label>`). Checking only `--user` misreads a system unit as unmanaged.
2. Act through the supervisor only: `systemctl [--user] restart <unit>` or `launchctl kickstart -k <label>`. **Never kill the process and hand-launch a `nohup` replacement** — the manual instance holds 3080, the supervisor then retries every `RestartSec`, and every attempt fails with `EADDRINUSE`, filling the log with a restart loop.
3. Startup hooks: a Linux unit's `ExecStartPre` / `ExecStartPost` (including `*.service.d/*.conf` drop-ins) can reference paths outside the profile. Before moving or archiving any directory under `~/.dsh`, run `systemctl [--user] cat <unit>` and grep the hook scripts; archiving `~/.dsh/backups` here made an `ExecStartPre` fail and the service would not start.
4. Restart a given host once per operation, only with explicit user authorization; read the new log segment (`startup failed` / `EADDRINUSE` / `failed to import`) before the next step, and record per-host results as Rolling restart requires.

## Rolling restart

Multi-host changes (model catalogs, bundles, service units) roll out in a "canary first, then one host at a time, operator host last" order:

1. Restart one canary host first (`ssh-laptop-b`): confirm loopback `http://127.0.0.1:3080` returns 200, the service is stable, and the catalog/behavior matches expectations before continuing.
2. Restart the remaining hosts one at a time, verifying each; never parallelize or skip verification. Deploy code first where needed (e.g. a proxy worktree: update and rebuild before restarting).
3. Restart the operator's own host (`ssh-studio-mac`) LAST: `dsh-netbird-llm-apply` always refuses the operator host; restart it manually per its service shape (launchd `ai.deepseek.dsh.web` and the proxy `com.zcx.dsh-api-proxy`). Restarting the local host interrupts the current session — expected, announced, and done last.
4. Record each host's verification result in the same operation; stop on any failure and investigate before rolling further.

## Linux service

Install DSH and `@dsh-cove/dsh-web-all` in the target user's Web profile, then adapt [dsh-web.service.template](dsh-web.service.template) for a system service or an equivalent persistent user service. A user service is acceptable only when lingering is enabled so it starts without an interactive login.

The service must be enabled, running, and restart automatically. Pass the canonical `dsh.<machine>.netbird` name with `--trusted-host` as shown in [dsh-web.service.template](dsh-web.service.template). Do not trust public IPs, NetBird IP literals, compatibility aliases, or other LAN names.

## macOS service

Use a LaunchDaemon for headless machines so DSH starts at boot without a GUI login. The existing local implementation is documented in [../dsh-launchd/README.md](../dsh-launchd/README.md). Its DSH launcher follows the same loopback-only command, and its nginx virtual host proxies port 80 to the integrated WebAuth origin on 3080 while listening on that machine's NetBird address only (see Overlay gate).

The boot-time launcher is [../dsh-launchd/launchd/start-dsh-web.sh](../dsh-launchd/launchd/start-dsh-web.sh), materialized with the canonical authority by [../dsh-launchd/install-dsh-daemons.sh](../dsh-launchd/install-dsh-daemons.sh). The `--trusted-host` flag must live there as well as in the running command, because a reboot restarts DSH from that file and a launcher without it drops remote access to every privileged panel.

A user LaunchAgent that was edited on disk keeps its previously loaded definition until the job is reloaded: run `launchctl bootout gui/$(id -u)/<label>` and then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist`. `launchctl kickstart -k` only restarts the program and silently keeps stale `ProgramArguments`.

An nginx declared as an ordinary user through `UserName` keeps only the privileged ports it already held at startup and cannot bind a new 443: the reload leaves `bind() to <NetBird IP>:443 failed (13: Permission denied)` in `/opt/homebrew/var/log/nginx/error.log`. To serve the TLS entry, put the master back on a privileged identity while the workers keep today's identity: delete `UserName`/`GroupName` from the plist (the master starts as root), write `user leo staff;` at the top of `nginx.conf`, then `sudo launchctl bootout system/com.leo.dsh-nginx && sudo launchctl bootstrap system /Library/LaunchDaemons/com.leo.dsh-nginx.plist`. The order matters: make the master able to bind 443 first and only then put the TLS block into the virtual host, because a cold start with a listener it cannot bind fails the whole configuration and takes the port 80 entry down with it.

A remote Mac must enable Remote Login and authorize an operator SSH key before it can be installed or repaired. NetBird reachability alone does not grant SSH access.

## Key-only SSH maintenance

The operator workstation keeps canonical `nb-<machine>` aliases in `~/.ssh/config`: `ssh-studio-mac`, `ssh-laptop-b`, `nb-tx`, `ssh-imac-office`, `ssh-thinkpad-lab`, and `ssh-tower-lab`. Every alias sets an explicit user, private key, `IdentitiesOnly yes`, and `BatchMode yes`; interactive password fallback is therefore disabled for routine maintenance.

Public keys are installed in the target account's `~/.ssh/authorized_keys` with directory mode `0700` and file mode `0600`. Private keys remain only on the operator workstation and are never copied to a peer or committed to this repository. Existing host password authentication is not disabled by this contract because local recovery policy belongs to each machine administrator.

Verify every alias without prompting:

```sh
for host in ssh-studio-mac ssh-laptop-b nb-tx ssh-imac-office ssh-thinkpad-lab ssh-tower-lab; do
  ssh -o ConnectTimeout=6 "$host" 'printf "%s@%s\\n" "$(id -un)" "$(hostname)"'
done
```

`ssh-studio-mac` uses loopback when invoked on `studio-mac` because the NetBird client does not hairpin its own address. Other aliases use their inventory NetBird IPv4 address.

## NetBird DNS records

The canonical name has exactly one rule: `dsh.<machine>.netbird`. Create one enabled custom DNS zone `netbird` and add one A record per [machines.json](machines.json) row: record name `dsh.<machine>`, content = that peer's NetBird IPv4 address. Distribute the zone to the group that contains all intended clients and use a short TTL such as 300 seconds.

The distribution list must cover every client that opens an entry by its canonical name, which includes each employee's `u-<username>` group: a zone is delivered per distribution group, and a peer outside the list gets `NXDOMAIN` (measured, see [netbird-management.md](netbird-management.md)). `pnpm dsh-netbird:namespaces --apply` fills that in for namespace members, and machines already connected need `netbird down && netbird up` before they receive the new DNS configuration. Distribution applies to the zone as a whole, so a member also sees that zone's other names (unreachable); the control-plane document covers how to keep members to `dsh.*` names alone.

After changing server-side NetBird DNS data, increment the account network serial or use the supported NetBird management API so connected peers receive a new network map. Never rely on `/etc/hosts` as the network-wide source of truth.

## Audit

Run the repository audit from a different connected NetBird computer when possible:

```sh
pnpm dsh-netbird:audit
```

The audit checks the entry and the deployment facts per machine. Every canonical domain must resolve to the inventory address, and the signed-out entry must match that machine's `authMode`: `password` must redirect to `/login`, `network-gate` must answer the DSH document, and a declaration that disagrees with the deployment fails. Unresolved or mismatched DNS, connection failure, nginx placeholder pages, `502`, and an unmounted integrated auth all fail.

It also probes `GET /api/dsh-access/session` on every canonical domain and requires `authority.declared === true`: that readout needs no session and is the proof that the running process trusts its canonical authority, which is the precondition for every privileged panel (Git, right pane, worktree, SSH, memoir, run target, Agent Browser). Posture states are `authority-trusted`, `authority-untrusted` (missing or wrong `--trusted-host`), `access-probe-missing` (the target runs a plugin build without the route, so posture cannot be verified), and `access-probe-malformed`.

`GET /worktree/tree` probes the host access fence without a session: a `200` for an undeclared Host is a leak, and on a `password` machine a `200` for the canonical Host without a session is a leak too, which means the running plugin build predates the shared fence. Pass `--skip-posture` to run only the document probe.

The audit also makes every machine report the picker interaction it composed: `POST /api/directoryPicker/list` is the browse backend's verb, so a directory listing means a peer can drive the in-app browser, while the seam's `directory-picker/unavailable` is reported as `picker-native-unreachable` or `picker-capability-missing` — per the capability it names — and fails. A `password` machine answers before the picker is reached and is reported as `picker-not-verifiable`.

`--verify-gate` verifies the overlay gate per machine over SSH: every non-overlay IPv4 on the machine must not serve the DSH entry, and any address that answers with a login redirect or the DSH document is reported as `gate-leak`. A machine declared `network-gate` fails as `gate-unverified` without this step: no password may be dropped without live evidence.

A complete deployment also checks the target host:

```sh
# DSH Web is loopback-only and nginx is listening.
ss -ltn | grep -E ':(80|3080)\\b'

# The effective Web profile enables integrated WebAuth and keeps noBrowserAuth false.
dsh --profile web --dump-config | grep -A4 -B1 'id: web-all'

# The running command trusts the canonical authority through --trusted-host.
ps -o command= -p "$(launchctl print gui/$(id -u)/<label> | awk '/pid =/{print $3; exit}')"

# The boot-time launcher carries the same flag, so a reboot keeps remote access.
grep -- '--trusted-host' "$DSH_HOME/bin/start-dsh-web.sh"

# The account file exists and is owner-only.
stat "$DSH_HOME/remote-web-ui-accounts.json"
```

Do not put account passwords, bootstrap passwords, session cookies, API keys, or generated DSH launch tokens in [machines.json](machines.json), documentation, nginx files, or service units.

## Failure diagnosis

| Symptom | Meaning | Repair |
| --- | --- | --- |
| DNS does not resolve | Missing or undistributed NetBird custom zone/record | Repair the zone and distribute a fresh network map. |
| Connection refused or timeout | nginx is absent, bound incorrectly, or blocked | Restore the port-80 listener on the target NetBird interface. |
| `502 Bad Gateway` | nginx cannot reach DSH Web | Confirm DSH is running and port 3080 is listening on loopback. |
| nginx welcome or unrelated site | The canonical host is missing from the intended virtual host | Add only `dsh.<machine>.netbird` to the DSH virtual host and reload nginx. |
| Login redirect loop | Integrated WebAuth is disabled or the session cookie cannot be returned | Keep `noBrowserAuth: false`, enable `integratedAuthEnabled`, and verify Host, scheme, and cookie scope. |
| Login succeeds but privileged APIs fail | The request reached a non-admin account or an unintended proxy path | Verify the account role, cookie domain, Host header, and `80 -> 3080` path. |
| `/api` returns `403 Forbidden` after login | The fence rejected the browser authority: DSH is not trusting the canonical Host | Pass `--trusted-host dsh.<machine>.netbird` on the DSH command line, reload the service unit, and confirm the flag is present in the running process. |
| A right-pane panel reports `loopback same-origin access only`, or Git management shows only `Git operation failed: ...` | The host access fence refused the request: the browser authority is not in the running process's `--trusted-host` list, or that browser has no valid DSH session | Sign in again through the canonical `dsh.<machine>.netbird` address and retry; confirm the running process carries `--trusted-host <that authority>` and that `noBrowserAuth` is false. |
| Audit reports `authority-untrusted` for a machine | The canonical authority is not declared to the running process, so every privileged panel returns 403 there | Add `--trusted-host dsh.<machine>.netbird` to the boot-time launcher, reload the service, and re-run the audit. |
| Settings → Models reports `settings are unavailable in this browser` on a remote entry | The page never claimed Host ownership: the plugin build predates the remote-access boot row, or the authority is not declared | Deploy a build that includes the remote-access domain, confirm the authority flag, and reload through the canonical address. |
| Copy buttons fail, or each remote tab opens its own Git stream | A plain-HTTP remote entry is not a browser secure context: `navigator.clipboard` and `navigator.locks` are absent | The plugin injects a clipboard shim and the `crypto.randomUUID` polyfill; use a trusted-certificate HTTPS entry when the full browser capability is required. |
| Voice input says "this browser cannot record; use a browser with a microphone" | The page is not a secure context: that is the message the official voice-input plugin produces when `navigator.mediaDevices` is absent, and it exists only over HTTPS (or loopback); a page-side polyfill cannot stand in for a real permission | Open that machine at `https://dsh.<machine>.netbird/` (see TLS entry) and confirm the client has the root certificate installed; the desktop client is in the same position on a fleet entry, and only its own loopback row works without one. |
| A worktree/workspace read or `/api/pair/*` answers an undeclared Host | The target runs a plugin build whose read routes or pairing guard predate the shared host access fence | Upgrade `@dsh-cove/dsh-web-all` on that machine: privileged reads carry the same fence, and `/api/pair/*` additionally requires a loopback Host. |
| Login succeeds but the page is blank; assets fail with `ERR_INCOMPLETE_CHUNKED_ENCODING` | Nginx truncated a large JavaScript response after trying to use an inaccessible proxy temp path | Restore `proxy_buffering off;`, test the nginx configuration, reload nginx, and verify that a core `/assets/*.js` response completes. |
| An image attachment or any large send answers `HTTP 500 (gateway/internal)` while short messages keep working | Nginx cannot spool the request body: its worker temp path sits under a user directory the worker user cannot traverse, so every body above the in-memory buffer fails | Pin `client_body_temp_path`, `proxy_temp_path` and the other temp paths outside user directories as in [nginx.conf.template](nginx.conf.template), create the parent once as root, then run `nginx -t` and reload. |
| A long session that has accumulated screenshots fails a turn with `400 ... Download multimodal file timed out`, and retrying the same turn may fail again | Every request re-sends all history images and the upstream (DashScope side) re-fetches them under a roughly 60-second deadline; DSH replaces the oldest images with text only when the payload exceeds router's `maxRequestImageBytes`, so a cap above that deadline never triggers the protection | Merge the current [llm-models.patch.yml](llm-models.patch.yml) router block (1 MiB total) into the machine profile and restart dsh web; raise it per that file's comment when more images must stay in context. |
| The page reports a disconnect and reconnect at a regular 10–15 second cadence | The default two-second `/api/remote.mux` Pong deadline is too aggressive for the overlay network or a busy host | Restore `typert-gateway.config.websocketHeartbeatIntervalMs` to `30000`, have the machine administrator restart the target DSH service, and verify that the WebSocket stays open for at least two heartbeat periods. |
| "Choose directory" on a remote entry hangs and finally reports `HTTP 504` on `/api/directoryPicker/pick` | The machine composed the OS chooser: the dialog opens on the host display, where a peer can neither see nor answer it, so the request waits until nginx gives up | Merge the browse pair from [cordis.patch.yml](cordis.patch.yml) into that machine's profile as described in Directory picker; a profile the running host watches through HMR applies it in place, otherwise have the machine administrator restart dsh web, then confirm `picker-browse` with `pnpm dsh-netbird:audit`. |
| Audit reports `gate-leak` | The machine still serves the DSH entry on a non-overlay address | Point the virtual host `listen` at that machine's NetBird IPv4 as described in Overlay gate, add the interface-scoped firewall rule on Linux, and re-run `--verify-gate`. |
| Audit reports `undeclared-host-leak` or `session-fence-missing` | The host access fence is not in force: the plugin build predates the shared fence, or the machine still decides on the socket alone | Upgrade `@dsh-cove/dsh-web-all` on that machine to a build carrying the shared fence and restart dsh web. |
| Audit reports `gate-unverified` | `network-gate` is declared but the gate was never verified live | Run `pnpm dsh-netbird:audit --verify-gate` from a workstation that can SSH to the machine; do not drop the password while the gate is unverifiable. |
| Audit reports `auth-mode-mismatch` or `no-browser-auth-exposed` | The inventory declaration disagrees with the deployment: `network-gate` still redirects to login, or `password` already answers the document | Align `authMode`, `noBrowserAuth`, and the gate state. |
| `nginx -t` reports `duplicate upstream` and points at a `.bak` file | A backup file landed in the `include servers/*` directory and is loaded as a second configuration file | Keep backups outside the include directory, for example in a sibling `backups/`. |

## Adding a computer

1. Add the NetBird peer name, address, and `authMode` to [machines.json](machines.json).
2. Add a `dsh.<machine>` A record for that peer's NetBird IPv4 address to the NetBird custom DNS zone `netbird`.
3. Install DSH and `@dsh-cove/dsh-web-all` if absent; confirm that build carries the remote-access contract (`/web-all/remote-access/boot.js` and `/api/dsh-access/session`), which the audit's `authority-trusted` state proves.
4. Create the first administrator through loopback or one-time bootstrap configuration, then remove the bootstrap password.
5. Choose the authentication mode: `password` enables integrated WebAuth and keeps `noBrowserAuth` false; declaring `network-gate` drops the password and depends on the gate verified in step 7.
6. Merge [cordis.patch.yml](cordis.patch.yml)'s shared rows (WebAuth, WebSocket heartbeat, directory-picker pair) into that machine's Web profile, then install a persistent loopback-only DSH service that passes `--trusted-host dsh.<machine>.netbird`.
7. Install the nginx virtual host: `listen` names that machine's NetBird IPv4, the worker temp paths are pinned outside user directories as in the template (create the parent as root first), plus the interface-scoped firewall rule on Linux (see Overlay gate).
8. Run `pnpm dsh-netbird:audit --verify-gate` from another peer and confirm service persistence on the target.

A computer is not marked operational merely because DNS exists. It is operational only after the canonical domain, an authentication declaration that matches the deployment, loopback isolation, a gate unreachable from outside the overlay, and boot persistence all pass.

## Security limitation

The canonical endpoints currently use plaintext HTTP inside the private NetBird overlay. Passwords and session cookies are therefore protected by the mesh boundary rather than application TLS. Do not publish these names or listeners to the public Internet; use HTTPS when the trust boundary expands beyond the private overlay.

A `network-gate` machine makes overlay membership the only credential: a lost device, a leaked setup key, or one compromised peer is equivalent to holding the privileged panels of every machine in the network. NetBird ACLs, setup-key rotation, and the device inventory are therefore the security boundary of that mode.

## License

Apache-2.0.

## Known limitations

The audit cannot perform a credentialed login because credentials are intentionally excluded from the repository. It proves the signed-out WebAuth boundary and detects common proxy/authentication failures; credentialed login remains a target-host acceptance step.

The deployment templates do not edit the self-hosted NetBird database. DNS changes should use the supported management API or dashboard; direct database maintenance requires an external backup and service-specific operational review.

With browse composed, the machine's own local browser (`127.0.0.1:3080`) also uses the in-app directory browser instead of the OS chooser: one boot composes one interaction, and the canonical remote entry must be able to pick a directory.

The local machine may not be able to connect to its own NetBird address because some NetBird clients do not hairpin self-traffic. Validate that canonical address from a different peer and use loopback only for local diagnostics.

## Install

This directory is not an installer. Follow the platform sections above, substitute the explicit template placeholders, and keep machine-specific secrets outside the repository.

## Configuration

[machines.json](machines.json) is the non-secret inventory; [cordis.patch.yml](cordis.patch.yml), [llm-models.patch.yml](llm-models.patch.yml), [nginx.conf.template](nginx.conf.template), and [dsh-web.service.template](dsh-web.service.template) define the shared configuration contract.

Control-plane operations (DNS zones and records, routes, groups, setup keys) and the fleet domain contract live in [netbird-management.md](netbird-management.md). Load the [dsh-netbird-ops skill](../../.agents/skills/dsh-netbird-ops/SKILL.md) for the fleet-operation workflow (inventory, audit, adding a machine, cross-machine dsh access). An operator whose control plane is their own starts at [self-hosted.md](self-hosted.md): it states what the shipped clients require of that server and links the templates under [selfhosted/](selfhosted).

## What it does

It standardizes private NetBird DSH addressing, proxy topology, overlay gating, authentication ownership, service persistence, and repeatable health checks for every computer in the inventory.
