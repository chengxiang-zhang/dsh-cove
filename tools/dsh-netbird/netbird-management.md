# NetBird management operations

[中文](netbird-management.zh.md)

Operational source of truth for the self-hosted NetBird management server. Machine inventory, the `dsh.<machine>.netbird` address contract, and health audit live in this directory's [README.md](README.md) and [machines.json](machines.json); this page covers the control plane: authentication, custom DNS, routes, groups, and setup keys. Facts recorded here come from actual operations on the fleet; when an endpoint below disagrees with what the console shows, the console wins and this page must be updated.

## Access and authentication

- Management server: `https://netbird.example.com:443`.
- API base: `https://netbird.example.com/api`.
- Authentication: a personal access token (PAT) issued from the management console, passed as a bearer token. Keep it out of the repository and out of shell history; prefer a dedicated environment variable.

```sh
export NETBIRD_MGMT_TOKEN=<from-console>
curl -fsS -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" \
  "https://netbird.example.com/api/peers"
```

## Unified SSO and per-employee namespaces

Employees sign in through the unified SSO (Casdoor) and, inside one account, a private group per member means each of them **sees and reaches only the machines they enrolled themselves**.

- IdP: Casdoor is self-hosted on `tx`, issuer `https://sso.example.com` (containers `casdoor` and `casdoor-db`; credentials and operations live in that host's `/opt/casdoor/README.txt`). NetBird consumes it as a Generic OIDC provider (IdP id `db7j5a6keeas73e8cng0`).
- Enrollment (verified): the employee runs `netbird up`; the client uses Dex's device flow (it prints a `user_code`), the browser authorises through Casdoor, `/oauth2/callback` and `/oauth2/device/callback` complete the flow, the client polls for its token, and the new peer's `user_id` is that employee.
- Isolation model: the `ops` group holds every fleet machine; each employee gets a `u-<user>` group plus a `self-<user>` policy (that group both ways, any protocol). **No enabled policy may reference the `All` group**: once one does, every peer in the account enters every member's network map (names visible). Fleet policies such as `ops-full-access` therefore name `ops` as both source and destination.
- Fleet DNS and the member entry: `dsh.<machine>.netbird` resolves only when the client has received zone `netbird`, and a zone is delivered per distribution group. A peer sitting only in a `u-<user>` group gets `NXDOMAIN` for `dsh.<machine>.netbird`; once that group joins the zone's distribution groups and the client reconnects, the name resolves to the inventory address while the peer set stays `0/0` and a connection to that address is refused (`Host is unreachable`). DNS names are account-scoped, reachability stays policy-scoped. **A member's namespace therefore includes DNS distribution**, which `pnpm dsh-netbird:namespaces --apply` performs; machines already connected need `netbird down && netbird up` to receive the new DNS configuration.
- Two verified DNS constraints: NetBird rejects a second zone with the same domain (`POST /api/dns/zones` answers `409 zone with domain netbird already exists`), so a leaner same-domain zone per member is impossible; **sub-domain zones do coexist** (for example domain `tower-lab.netbird`, create returns 200), so keeping members to `dsh.*` names alone means moving the non-DSH records into such sub-domain zones (distributed to `ops` only), paying the cost of adding records through the record endpoint because `records` sent with a zone create are not stored.
- Account settings: `regular_users_view_blocked` must be `false`, otherwise a `user` cannot even see their own peers (`GET /api/peers` returns an empty array). `user_approval_required` stays on as the admission gate; `peer_login_expiration` is 7 days.
- Automation: `pnpm dsh-netbird:namespaces` (dry-run by default, `--apply` to write) creates the missing groups, policies and zone distribution for approved members; `--no-zone-access` skips DNS only, and `--revoke-zone-access` only revokes (it never hands out what it is undoing). The target zone is derived from `machines.json`'s `domainPattern`, so a rename cannot leave it pointing at the wrong zone. User group propagation is enabled, so setting `auto_groups` on a user reaches every machine that user already owns.
- IT access: not granted by default. When support needs a direct path to an employee's machine, `--with-ops-access` creates `ops-manage-<user>` (unidirectional ops -> that member's group); the cost is that the member's client then lists every machine of the `ops` group (still unreachable). Revoke it again with `--revoke-ops-access`.
- Isolation outcome (three accounts and four machines): a member's own machines reach each other with 0% packet loss; cross-member traffic fails with `Required key not available`; member to fleet is 100% packet loss or a missing key; a member's client map contains only their own namespace (`2/2`); a member's dashboard lists only their own peers; fleet connectivity and every machine's DSH entry are unaffected.

### Feishu sign-in chain

One chain in four hops; the first three are live and the fourth is blocked in the Feishu console:

```
App/dashboard -> NetBird Dex (/oauth2/auth) -> Dex connector "Casdoor SSO" -> Casdoor app netbird
              -> Casdoor provider "provider_feishu" -> Feishu app cli_REPLACE_WITH_FEISHU_APP_ID
```

- NetBird side: the login page (`/oauth2/auth`, scope includes `groups`) offers "Continue with Email" and "Continue with Casdoor SSO". The connector lives in the embedded IdP's `connector` table (Dex store `idp.db`): `id=db7j5a6keeas73e8cng0`, `type=oidc`, `issuer=https://sso.example.com`, `clientID=netbird-mgmt`, `redirectURI=https://netbird.example.com/oauth2/callback`, with a `clientSecret` that matches the Casdoor app `netbird` (compared directly), `insecureSkipEmailVerified=true`, `insecureEnableGroups=true`.
- App side needs no change: `Portal.loginSSO` returns the `netbird-cli` client's authorize URL - `redirect_uri=http://localhost:53000/`, `prompt=login`, `scope=openid profile email groups` (captured on the emulator). `prompt=login` always lands on the connector chooser, so fixing the Feishu hop needs **no app release**.
- Casdoor side: app `netbird` (`client_id=netbird-mgmt`, org `example-org`) carries provider `provider_feishu` (`category=OAuth`, `type=Lark`, `method=Normal`, `client_id=cli_REPLACE_WITH_FEISHU_APP_ID`, `disable_ssl=false`) and `signin_methods` is Password plus `provider_feishu`, which is why the login page renders a Feishu button (verified in a browser). Two Casdoor Lark quirks: **`disable_ssl` doubles as the Feishu-vs-international switch** (`false` gives `open.feishu.cn`, `true` gives `larksuite`), so it must stay `false`; the frontend builds the authorize URL as `.../open-apis/authen/v1/index?app_id=...&redirect_uri=...&state=...`, and the Go side exchanges the code at `/open-apis/authen/v1/access_token` with the `tenant_access_token` as the bearer token (measured to be accepted: a bogus code returns `20003 code is invalid` rather than a token error).
- The one unfinished Feishu-side item: the app currently has the `bot` ability only (`app_versions` reports `abilities={"bot":{}}`) and an empty `redirect_urls`. It needs the web-app ability and `https://sso.example.com/callback` in "Security settings -> Redirect URLs"; otherwise the authorize endpoint answers `20029 redirect_uri is invalid` (error page and log id captured). That step is console-only and has **no API equivalent**: the application endpoint `PATCH /open-apis/application/v6/applications/:app_id` accepts only `common_categories`, `allow_refresh_token` and `callback_info` in its body - there is no `redirect_urls` field at all (checked against the official docs). The `99991672` that endpoint returns for a missing `application:application` scope is the permission check running before body validation, so granting that scope would still not change the redirect list.
- Changing Casdoor without an admin login: write the database directly (insert the `provider` row, rewrite `application.providers` and `application.signin_methods`); **no restart is needed** (`GET /api/get-application?id=admin/netbird` reflects it immediately). Casdoor's `client_credentials` grant is disabled, so there is no login-free API path; the admin password is in `/opt/casdoor/README.txt` (now mode 0600).
- Why this matters for isolation: after a Feishu login, Casdoor matches an existing account by the user info's `email` (falling back to `enterprise_email`) and NetBird then matches a user by that same email. So **a Feishu login only inherits fleet access when the Feishu account's email equals that NetBird user's email** (for example `i@example.com`); a mismatch creates a new user, and a new user has no `auto_groups`, so it still sees no machines.

### Login page theme

The Casdoor login page now presents as **Anywhere Work**: a navy brand panel on the left (mark, product name, tagline, three points), the sign-in card on the right, and our own footer text. The stock "Powered by Casdoor" footer and the self-signup link are gone. It reuses the app's own launcher icon rather than inventing a brand asset.

- The fields that **actually take effect** in this build (checked against the served frontend bundles - anything else is silently ignored): `application.title` (tab title), `logo` / `logo_dark` / `favicon`, `theme_data` (`{themeType,colorPrimary,borderRadius,isCompact,isEnabled}`, feeding the CSS variables), `form_offset` (**`form_side_html` is only rendered when it is 4**, in a container classed `.side-image`), `form_css` (injected as a `<style>`; usable hooks are `.side-image`, `.login-panel`, `.login-logo-box`) and `footer_html` (**replaces** the built-in footer rather than appending to it). Custom HTML is sanitized before injection (`p` component plus `dangerouslySetInnerHTML`), so `<script>` is stripped while inline `style` survives.
- Assets live on the **SSO origin**: `/www/wwwroot/sso-brand/{logo.png,favicon.png}`, served by a `location /brand/` in the sso vhost (`/www/server/panel/vhost/nginx/sso-casdoor.conf`). **Do not put them under `/www/wwwroot/apk`**: `scripts/publish.sh` swaps that whole directory atomically and would delete them. The mark's source file is the app's `mipmap-xxxhdpi/ic_launcher.png` (192x192); `sips -z 64 64` derives the favicon.
- Reproduce with [casdoor-theme.sql](casdoor-theme.sql) (direct DB writes; Casdoor reads these rows per request, so **no restart** is needed).
- Two switches, and they are not interchangeable: **close self-service signup with `disable_self_signup=true`, never with `enable_sign_up=false`**. Casdoor's OAuth branch (`controllers/auth.go`, "Sign up via OAuth") requires `enable_sign_up`, so turning it off also rejects a Feishu login for anyone not already in Casdoor, whereas `disable_self_signup` closes only the password signup route (the login page does not render the signup link and SignupPage refuses without an invitation code) and leaves provider provisioning working. Removing self-service signup matters because a self-made identity has no `auto_groups` and would sign in to an empty list. Pre-created accounts still bind at login: Lark reports `EmailVerified` for any non-empty email and the default binding rule tries Email before Phone. `enable_password` stays true so local password login remains as a fallback beside Feishu; once Feishu is verified end to end it is a one-line change to turn it off.
- Verified by screenshot at 1280x720 (light and dark) and 390x844, checking the side panel, the card, the footer, the absence of a duplicate logo and the absence of a signup entry point.
- The narrow layout reads a **different CSS field**: `AuthLayout` picks `form_css_mobile` on a small viewport instead of `form_css`, and the brand panel and `form_side_html` are not rendered there at all. With only `form_css` set, a phone gets the stock Casdoor form (username, password and Sign In, with Feishu as a bare icon). With both fields written, 1280x720, 390x844 and the in-app GeckoView (measured at 1080x2400 in dark mode) all show **Feishu first with the footer switch to the password form**; the injected hints and the footer are always Chinese while Casdoor's own labels follow the device language. The narrow layout labels the logo with `display_name` and the desktop one with `title`, and both are set to Anywhere Work.

### Sign-in methods, with NetBird's own login disabled

**Exactly two ways in**, Feishu by default; NetBird's own email/password connector is gone, so Casdoor is the only authenticator.

- The two methods: `enable_password=true` plus `signin_methods=[{"Password"},{"provider_feishu"}]`, with `enable_code_signin` / `enable_web_authn` / `enable_guest_signin` all false and `disable_self_signup=true`.
- Feishu first, password on demand: `form_css` turns the provider row into a full-width primary button (its icon inverted with `filter: brightness(0) invert(1)`, label "使用飞书登录") and hides the password form; a checkbox injected through the footer plus `:has(#aw-pw:checked)` swaps it in, and the footer label flips to "改为飞书登录". **Casdoor renders a generic OAuth provider as an icon only** - its signin-method tabs cover just Password / verification code / WebAuthn / WeChat - so there is no native tab to use here. The hide rules need `!important`, because Tailwind's own `display` utilities otherwise win.
- Disabling NetBird's login: `server.auth.localAuthDisabled: true` in `/opt/netbird/config.yaml` (bind-mounted into the container, so **a `netbird-server` container restart is required**). At startup it runs `DisableLocalAuth`: the log shows `local authentication disabled - only external identity providers can be used`, the `local` row disappears from Dex's `connector` table (leaving only the `oidc` Casdoor connector), and the local accounts in the `password` table are **preserved** - flip the flag back and they work again.
- With a single connector Dex offers no "choose your login method" page: `/oauth2/auth` redirects straight to Casdoor, for both the dashboard and the app (which sends `prompt=login`).
- Source basis (v0.78.1): the `LocalAuthDisabled` comment in `management/server/idp/embedded.go`, plus `NewEmbeddedIdPManager` refusing to disable local auth when no other connector exists; the YAML key comes from `yaml:"localAuthDisabled"` in `combined/cmd/config.go`.
- One-line revert: set `localAuthDisabled` back to `false` and restart the container.
- Consequences: dashboard sign-in now **depends on Casdoor**. The Casdoor console (built-in app) and its admin password are independent, so this cannot lock anyone out, and the fleet data plane is unaffected - all six DSH entries still answered 200 in the audit run right after the restart.

### Dashboard login callback paths

The dashboard container is a Next.js static export whose own rule is `try_files $uri $uri.html $uri/ =404`, with **no SPA fallback**, while the Dex client for the dashboard uses `redirect_uri=/nb-auth` (`/nb-silent-auth` for silent renewal); neither path has a matching HTML file, and only Next's `404.html` boots the app shell. In tx's `netbird_proxy.conf` (`/www/server/panel/vhost/nginx/`) the 443 server claims both callback paths and returns the app shell directly (`proxy_pass http://netbird_dashboard/index.html;` - nginx keeps the query string, the browser URL stays `/nb-auth`, and the frontend handles the code on that route). The official dashboard repo's `docker/default.conf` carries the same `try_files`, so the explicit paths are required here rather than optional; the outer nginx `location /` is otherwise just `proxy_pass http://netbird_dashboard;`.

### Per-user isolation: separate identities, automatic groups, container proof

**Separate identities**: the administrator and any Feishu identity must be different NetBird users. The account now holds three kinds:

- `owner-sample` (`idp=local`, owner): the account NetBird's own login used; it is **not reachable** while `localAuthDisabled` is set, and is kept only as the owner.
- `admin-sample` (`idp=db7j5a6keeas73e8cng0`, **admin**, `auto_groups=[ops]`): the administrator's **usable** login, through Casdoor's password method, and a different user from every Feishu identity. Its Casdoor account is `admin-sample` (`i@example.com`).
- `on_584676b5...` (the Feishu identity, `user`, `auto_groups=[u-on_584676b5...]`): an ordinary member with only its own namespace.
- The pre-created members `employee-a/b/c` (`user`, each in its own `u-employee-x`).

Note NetBird does **not** dedupe by email: the same email under `idp=local` and `idp=casdoor` is two users (measured - `i@example.com` exists twice).

**Automatic groups**: every NetBird user, **including Feishu identities that carry no email**, gets its own isolation group from a cron on `tx` every two minutes:

```
*/2 * * * * /www/server/nodejs/v24.15.0/bin/node /opt/dsh-netbird/scripts/dsh-netbird-user-namespace.mjs --apply --json >> /var/log/dsh-netbird-namespaces.log 2>&1
```

- Script and inventory: `/opt/dsh-netbird/scripts/dsh-netbird-user-namespace.mjs` plus `/opt/dsh-netbird/tools/dsh-netbird/machines.json` (the relative layout must be preserved); token at `/root/.dsh/netbird-mgmt-token` (0600).
- Per user it does three idempotent things: create `u-<username>`, put that group into the user's `auto_groups` (with `groups_propagation_enabled=true`, already-connected devices move with it), create the `self-<username>` policy (in-group, bidirectional, any protocol), and add the group to the fleet zone's distribution.
- A missing email is not an obstacle: `isNamespaceUser` only looks at name/role/status and `namespaceNames` derives names from `user.name`, so `on_<union_id>` yields `u-on_<union_id>`. Measured: `pnpm dsh-netbird:namespaces --apply` created the group, the policy and the distribution for the Feishu identity.
- **Do not add `--include-admins`**: the namespace write pins `role: "user"`, and NetBird refuses to demote the owner (`only owners can remove owner role from their user`). Administrators use `ops` and need no `u-` namespace.

**Container proof** (`scripts/dsh-netbird-isolation-docker.mjs`, run with colima + docker on macOS as four real independent machines: two users by two machines):

```sh
brew install colima docker && colima start
docker pull netbirdio/netbird:latest
# mint one setup key per user, each carrying that user's group, then
node scripts/dsh-netbird-isolation-docker.mjs --key-a <key> --key-b <key>
```

- Each client needs its own network namespace (`--cap-add=NET_ADMIN --device /dev/net/tun`); the upstream docs' `--network host --privileged` would put all four clients in one namespace and cannot test this.
- Measured **12/12**: all four in-group directions reachable, all eight cross-user directions dropped by policy, and none of the four machines able to see any of the seven fleet machines (`Peers count` 1/1 each).

## Desktop client channel (one-line install)

The only address an employee needs **before joining the network** is `https://anywhere.example.com/install.sh`:

```sh
curl -fsSL https://anywhere.example.com/install.sh | sh
```

The script does five things in order: read the version from the channel's `latest.txt`, download the matching `netbird_<version>_<os>_<arch>.tar.gz` and verify its SHA-256 against `checksums.txt` (a missing checksum or a different digest **refuses the install**), install it as `/usr/local/bin/netbird` and register the system service (launchd on macOS, systemd on Linux; containers and CI pass `--no-service` to run a session daemon instead), run `netbird up` to open the browser for SSO login (a machine without a browser passes `--no-browser`, which prints the login link instead), and finally install DSH and keep it resident: a global `npm` install (behind a private Node under `$DSH_HOME/node`, verified against the Node release SHA-256 list, when the machine has no Node 22), `@dsh-cove/dsh-web-all` in the Web profile, the Kaon Router provider with `kaon/deepseek-v4.1-flash` as the default model, and a user-level service (`org.dsh.web` LaunchAgent on macOS, `com.dsh.web.service` systemd user unit with lingering on Linux).

- Every flag: `curl -fsSL https://anywhere.example.com/install.sh | sh -s -- --help`; `--uninstall` removes the client, `--dry-run` only prints the plan, `--force` replaces a client that is already on the machine, `--no-dsh` installs the network client alone, and `--dsh-version V` pins the DSH release.
- DSH answers on `http://127.0.0.1:3080/` on the machine itself and on `http://dsh.<machine>.netbird/` once an administrator publishes that name; the service starts with `--trusted-host dsh.<machine>.netbird`, taken from the client's own FQDN (the local host name is the fallback before the first login), and a machine already serving that port keeps the service it has instead of getting a second one.
- The model API key is the one step the script cannot take: apply for it at `https://router-admin.example.com/` and paste it into DSH (model provider settings, or `KAON_ROUTER_API_KEY` under `refs:` in `$DSH_HOME/.credentials.yaml`). The installer prints both places and never writes a secret.
- The provider block the installer seeds is a compact subset of [llm-models.patch.yml](llm-models.patch.yml); `scripts/dsh-netbird-client-dsh.test.mjs` holds its values against that preset, and `pnpm dsh-netbird:llm-apply` replaces it with the full catalog on any machine an administrator manages.
- When a `netbird` is already installed (a Homebrew one, for example) the script **reuses** it instead of installing a second copy, and it always calls the client by its installed path, so the install directory does not have to be on `PATH`.
- The archives all live under `/client/`: `latest.txt`, `management-url.txt`, `checksums.txt` and the four platform archives (darwin/linux x arm64/amd64). `checksums.txt` comes from the upstream release checksum file and is compared with the local archives while publishing, so a drifted mirror **refuses to publish**.

Publishing (from the dsh-cove project root, needs ssh to `nb-tx`):

```sh
pnpm dsh-netbird:client-publish --dry-run   # stage and print the file list only
pnpm dsh-netbird:client-publish             # upload and verify byte for byte
```

- Archive cache: `~/.dsh/client-dist/<version>/` (downloaded from the upstream release once; `netbird_<version>_checksums.txt` has to sit there too).
- The publish script compares the served `/` (the site), `/qr-phone.svg`, `/install.sh`, `checksums.txt`, `latest.txt` and `management-url.txt` with the local bytes, requires `/client/` to be a 301 to the root, and checks every archive's Content-Length and a 1 MiB Range request (206); any mismatch exits non-zero.
- The static root is `/www/wwwroot/client`, **separate** from the APK channel's `/www/wwwroot/apk`: `tools/netbird-client/scripts/publish.sh` replaces its own root atomically, so sharing one directory would let an APK release delete the installer.
- The site is this channel's `index.html`, served at the **root of the canonical name**: `/` returns that file, the page's relative asset `qr-phone.svg` is served from the same published root at `/qr-phone.svg`, and the `/client/` address 301s to the root (`/client/` carries the archives only).

Android phones use the same public channel: `https://anywhere.example.com/` carries both the install script and the APK download, and the phone details are in [../netbird-client/README.md](../netbird-client/README.md).

### Simulating every endpoint in a container

A Linux endpoint can be enrolled end to end inside a container, which replaces a physical machine when checking "signed in, therefore in its own group":

```sh
docker run -d --name ep --cap-add=NET_ADMIN --device /dev/net/tun debian:12-slim sleep infinity
docker exec ep sh -c 'apt-get update -qq && apt-get install -y -qq curl ca-certificates'
docker exec -d ep sh -c 'curl -fsSL https://anywhere.example.com/install.sh | sh -s -- --no-service --no-browser > /tmp/install.log 2>&1'
docker exec ep sh -c 'grep -o "user_code=[A-Z-]*" /tmp/install.log | tail -1'
```

- `--no-service` starts a **session-scoped daemon**; the script detaches it from the installing shell with `setsid`, otherwise the shell exiting takes it down (measured: one of three containers lost its daemon that way).
- `--no-browser` prints the login link; hand it to an operator or a browser, and `netbird status` should then read `Management: Connected`. The link is time-limited: when nobody opens it in time `netbird up` ends with `DeadlineExceeded`, and the script tells you to run the same `netbird up` again for a fresh one.
- Every container needs its own network namespace (`--cap-add=NET_ADMIN --device /dev/net/tun`); `--network host` cannot be used.
- Do not check the data plane under qemu-emulated amd64: with `--platform linux/amd64` the client installs, logs in and registers, but creating the interface fails (`create wg interface: socket: protocol not supported`). Run reachability on a native x86_64 host such as `tx`.
- Measured matrix (one identity = one `u-` group, policies deny by default): an arm64 container (colima on the laptop) and an amd64 container (`tx`) on the same identity reached each other **in both directions across architectures and hosts on port 8080**; the other identity in both directions, and both containers towards the fleet (port 22 on studio-mac/tower-lab, port 3080 on tx) were BLOCKED; each container's `Peers count` listed only its own identity's machines.

## Domain contract

| Pattern | Purpose | Resolution |
| --- | --- | --- |
| `dsh.<machine>.netbird` | DSH web entry of every computer (authoritative list: `machines.json` `domain` fields) | `dsh.<machine>` A record in the shared `netbird` zone pointing at that peer's NetBird IPv4 |
| `anywhere.example.com` (public HTTPS) | The site (root), desktop one-line install (`install.sh` and the `/client/` archives), the mobile update channel (`version.json` / `fleet.json` / APK) and the `/deck/` roadshow deck | nginx virtual host `/www/server/panel/vhost/nginx/anywhere.conf` on the network edge host `tx` (public sample `203.0.113.10` from the documentation range, also the management host); the repository source is [nginx-anywhere.conf](nginx-anywhere.conf), installed and byte-checked by `pnpm dsh-netbird:client-publish`. Static roots: `/www/wwwroot/client` (site page, `install.sh`, `qr-phone.svg`, the `/client/` archives), `/www/wwwroot/apk` (APK, `version.json`, `fleet.json`), `/www/wwwroot/deck` (the deck). The overlay names `tx` / `tx.vpn:80` are answered by the apk vhost, so WiFi and overlay both serve it. TLS is Let's Encrypt via `certbot --webroot` (webroot `/www/wwwroot/netbird-acme`) |
| sci-exit domains | Split-tunnel egress: a curated set of overseas domains routed via the office exit | Domain-type route (see Routes below), routing peer `tower-lab` |
| `apk.example.com` (compatibility alias) | Not referenced anywhere; it keeps serving the same content for clients installed before 2.7.5 | Same vhost, same static root, same certificate (its SAN carries both names). Do **not** use it in anything user-facing; once no pre-2.7.5 install remains it can be dropped from `server_name` and from the certificate together |

DNS record names keep the trailing dot stripped in app-visible names; the management API stores fully qualified names with the trailing dot.

## Custom DNS

- The fleet owns one enabled zone named `netbird`. The name is a client requirement rather than a preference: the Android app compiles it, so a deployment that needs a different name must rebuild the app (see [self-hosted.md](self-hosted.md)).
- An A record named `dsh.<machine>` inside the `netbird` zone points at the machine's NetBird IPv4, which resolves as `dsh.<machine>.netbird` (this is what the address contract in [README.md](README.md) relies on).
- That zone is distributed to `ops` **plus `All`**. `ops` alone is not enough: a fresh install registers a **new peer**, and a new peer lands in `All` only, so it receives none of the zone's records and the app's service list comes back empty (measured: a new peer with `records=[]`). `All` cannot be attached to a setup key (the management API rejects it), but it can be a distribution group.
- Distribution applies to the zone as a whole, so a peer in either group sees every name in it (mostly unreachable); restricting members to just the `dsh.*` names is described under Fleet DNS above.
- Records and zones are managed through the API under `/api/dns/zones` and `/api/dns/records`, or the console. Use short TTLs (300 s) so fleet changes propagate quickly.
- Update a zone with `PUT /api/dns/zones/<zone-id>`; the body replaces the zone wholesale, so the existing `records` must travel back unchanged (this repository's script does), otherwise they are dropped. Connected peers need a reconnect before a distribution change takes effect.
- After editing server-side DNS data, bump the account network serial (or use a supported management API call) so connected peers receive the new network map. `/etc/hosts` is not a fleet source of truth.

```sh
# list zones
curl -fsS -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" \
  "https://netbird.example.com/api/dns/zones"
# list records of a zone
curl -fsS -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" \
  "https://netbird.example.com/api/dns/zones/<zone-id>/records"
```

## Routes and groups

### Visibility of a freshly registered peer (the second cause of an empty list)

Policies decide which peers appear in a peer's network map, and with no peers in the map the app accepts no DSH record at all (acceptance requires the target IP to be one of this network's peers), so the list comes back empty. Measured facts:

- The `Default` policy (All to All) is **disabled**; every enabled policy uses `ops` as its source and/or destination (`ops-full-access`, `dsh-http`, `SSH-only`, ...) plus `self-employee-*` for their own `u-employee-*` groups.
- A peer that is in `All` only therefore sits in **no policy**: its map reports `peerAddresses=[]` and the app shows nothing. A newly enrolled device is exactly that case.
- An SSO-enrolled device has no setup key, so its groups can only come from the **user's** `auto_groups` (below), never from a setup key's.

**Never** close this gap with a broad `All -> ops` policy: that lets any enrolled device reach every machine and throws per-member isolation away. The correct fix is to give the identity its `auto_groups` - a peer inherits its identity's groups at registration (a setup key inherits the key's, an SSO login inherits the user's):

```sh
# Fleet devices: give the owner user ops, and every device that user
# registers lands in ops.
curl -fsS -X PUT -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"role":"owner","auto_groups":["<ops id>"],"is_blocked":false}' \
  "https://netbird.example.com/api/users/<user id>"
# Member devices: give the member their own u-employee-<x>, which the
# existing self-employee-<x> policy already covers.
curl -fsS -X PUT -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"role":"user","auto_groups":["<u-employee-x id>"],"is_blocked":false}' \
  "https://netbird.example.com/api/users/<user id>"
```

Basis (management v0.78.1 source, not inference): `handleUserAddedPeer` in `management/server/peer.go` sets `config.GroupsToAdd = user.AutoGroups` at registration, and `management/server/user.go` adds/removes the changed groups on **every peer that user already owns** while `GroupsPropagationEnabled` is on (it is, on this account). Changing a user's `auto_groups` therefore needs no re-enrolment.

Two brand-new emulator peers in the same account and zone:

| Enrolment identity | `peerAddresses` | `dsh.*` records received | Accepted by the app |
| --- | --- | --- | --- |
| setup key `auto_groups=[ops]` | 9 (the whole fleet) | 6 | 6 |
| setup key `auto_groups=[u-employee-a]` | 1 (thinkpad-lab only) | 6 | 1 |

The second row is the isolation guarantee: zone distribution hands out **names**, and the app accepts a record only when its target IP is a peer this peer can reach. So even with the names on disk a member device sees only its own machine. Whether a member device should receive the fleet zone's names at all is the tradeoff `pnpm dsh-netbird:namespaces` already encodes (`--no-zone-access` withholds the names entirely); in both shapes **access** is decided by policy, never by a name.

The full per-member recipe is what `pnpm dsh-netbird:namespaces --apply` writes: user `auto_groups=u-employee-<x>`, the machine in `u-employee-<x>`, the `self-employee-<x>` policy (`u-employee-<x>` to `u-employee-<x>`), and optionally the fleet zone distributed to that group. The fleet's own rule is: the shared zone (`netbird`) is distributed to `ops`, every fleet policy sources and/or targets `ops`, and **no** broad `All -> ops` policy exists.

Cleanup note: `All` is an automatic group, and peer membership is replaced wholesale through the group endpoint, not the peer endpoint:

```sh
# The group endpoint takes {"name":..., "peers":[peerId...]} and replaces the
# whole list (the peer endpoint rejects a groups field with HTTP 500).
curl -fsS -X PUT -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"ops","peers":["<peer id>", "..."]}' \
  "https://netbird.example.com/api/groups/<ops id>"
```

Also: every SSO reinstall registers a **new peer** and leaves the old one behind, so never conclude "several devices" from a peer count - read the hostname and OS fingerprint first. Superseded peers must be deleted, or the user's `auto_groups` propagation keeps handing them fleet access again.

Domain-level split-tunnel egress is configured as one or more domain-type routes (up to 32 domains per route) distributed only to a dedicated group:

```sh
# list groups and routes
curl -fsS -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" \
  "https://netbird.example.com/api/groups"
curl -fsS -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" \
  "https://netbird.example.com/api/routes"
```

Current fleet facts:

- Group `sci-exit` (id `daqahtmkeeas738pj3a0`) holds the devices allowed to use the office exit.
- Domain route `daqak9mkeeas738pj7bg` sends curated overseas domains (Google suite, GitHub, OpenAI/ChatGPT, Claude, X/Twitter, Facebook, Telegram, Netflix, Notion, Cloudflare; 28 domains in total) to routing peer `tower-lab` (`peer-sample-0001`) with metric 9999, `masquerade true`, `keep_route true`, distributed only to `sci-exit`. The route is enabled and the `sci-exit` group holds no devices.
- A device joins by being added to the group, then `netbird down && netbird up` on the device to fetch the new route set; verify with `curl ifconfig.me` (should show the office public IP).

## Setup keys

Setup keys enroll new peers without interactive login. They are one-time or limited-usage, carry an expiry, and must be revoked once consumed:

```sh
# create a one-time key
curl -fsS -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"ephemeral-enroll","type":"one-off","expires_in":86400,"auto_groups":["<group-id>"]}' \
  "https://netbird.example.com/api/setup-keys"
# revoke a key after use
curl -fsS -X DELETE -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" \
  "https://netbird.example.com/api/setup-keys/<key-id>"
```

Never hardcode setup keys, PATs, or shared WireGuard keys into the app, the repository, or this documentation.

## Adding a machine

The full procedure lives in [README.md](README.md) (Adding a computer). The control-plane parts are: register the peer (or enroll it with a one-off setup key), create its DNS zone with the `dsh.<machine>.netbird` A record, and add the machine to [machines.json](machines.json). Then run the audit from another connected peer.

## Safety rules

- PATs, setup keys, passwords, and session cookies never enter the repository, docs, nginx files, or service units.
- One-time setup keys are deleted after use; test users are removed after verification.
- Route/group/DNS changes are fleet-affecting: prefer a short TTL + incremental rollout and verify from a non-affected peer before declaring success.

## The site at the root

The site is served at the **root** of the canonical name, and `/client/` is a 301 to the root. What that means:

- The root is this name's first identity; a visitor should not land one directory down first. Existing links keep working - including the address compiled into the app - because the 301 sends `/client/` back to the root.
- The root has to be the channel's landing page and nothing else: `/health`, `/version.json`, `/fleet.json`, `/install.sh`, `/AnywhereWork.apk` and the `/client/` archives are served there, and the publish script checks all of them answer 200.
- The page references its own QR code relatively (`qr-phone.svg`), so served at the root the browser asks for `/qr-phone.svg`; that path is served from the same published root. The page stays a single offline-cacheable file with no absolute asset address.
- The deck is one entry of the site (a nav item, the hero's secondary button, its own block and a footer link), but it still lives at `/deck/`: it is a 7 MB self-contained bundle deployed by its own pipeline outside this repository. Only the `deck (anywhere work roadshow)` marked region of the vhost belongs to it.

Vhost ownership therefore has two layers: **the whole canonical vhost belongs to the client channel** (repository source [nginx-anywhere.conf](nginx-anywhere.conf), installed by `pnpm dsh-netbird:client-publish`, which restores the backup when `nginx -t` rejects it), and **the deck owns only the marked region inside it** (`the deck deploy script` replaces it by marker, and only inserts when the markers are missing).
