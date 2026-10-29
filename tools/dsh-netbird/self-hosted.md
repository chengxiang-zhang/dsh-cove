# Self-hosted control plane

English | [中文](self-hosted.zh.md)

This page is the entry point for an operator whose NetBird control plane is their own and who wants the shipped clients to use it: the desktop one-liner and the Android app. It states what those clients require, in what order to stand it up, and how to prove the chain. Both shipped clients now default to NetBird Cloud; choosing this deployment is an explicit address change in the client (or `-PawManagementUrl=` / `AW_MANAGEMENT_URL=` at build time), after which the requirements below are what that choice needs. Fleet-specific operation stays in [README.md](README.md) (machine exposure), [netbird-management.md](netbird-management.md) (this fleet's control plane) and [employee-guide.md](employee-guide.md) (members).

## Client requirements

| Requirement | Why a client depends on it |
| --- | --- |
| A management host on public HTTPS whose certificate a phone trusts | The app's sign-in runs in a WebView and enrollment dials that same host; a self-signed or cleartext endpoint completes neither |
| An identity provider answering at that host | `Portal.loginSSO` returns the embedded IdP's authorize URL for the deployment-registered `netbird-cli` client (`redirect_uri=http://localhost:53000/`, `prompt=login`, `scope=openid profile email groups`); the app registers no redirect of its own |
| A custom DNS zone whose domain is exactly `netbird` | The app compiles the zone name (`res/values/fleet_dsh_zones.xml`) and the machine installer authors `dsh.<machine>.netbird`; another zone name needs an app build |
| `dsh.<machine>` A records in that zone, one per machine, pointing at that machine's NetBird IPv4 | Discovery accepts a record only when the name is `dsh.<machine>` inside the zone and the address belongs to the client's own peer set |
| The zone distributed to the device's group | Distribution is per group; a device whose group is not in `distribution_groups` receives no records and lists nothing |
| A policy that puts the machine's peer into the device's network map | A peer in no policy contributes no address, so the record is refused even while DNS resolves |
| Per-machine DSH exposure on the overlay address | The entry is `http://dsh.<machine>.netbird/` on port 80 bound to that machine's NetBird IP, with DSH started as `--trusted-host dsh.<machine>.netbird` |
| The app's update channel and bootstrap origins | They stay compiled into the app; an install pointing at another control plane still asks this fleet's channel for updates, and an unreachable channel is harmless |

## Deployment order

Templates live in [selfhosted/](selfhosted): each one carries the reason for what it sets, and every `__PLACEHOLDER__` must be replaced.

1. Management server: [selfhosted/netbird-server-config.yaml.template](selfhosted/netbird-server-config.yaml.template) records the keys this deployment sets over the shipped defaults - external-only sign-in, and the STUN set that lets peers punch through multi-WAN networks instead of falling back to the relay.
2. Identity provider: [selfhosted/idp-dex-connector.yaml.template](selfhosted/idp-dex-connector.yaml.template) is the connector field set, and [selfhosted/netbird-dashboard.env.template](selfhosted/netbird-dashboard.env.template) is the dashboard client's secret. The external IdP's own side - the application, its provider row and its sign-in methods - is documented with the fields this fleet sets in [netbird-management.md](netbird-management.md), and the console theme is reproducible with [casdoor-theme.sql](casdoor-theme.sql).
3. TLS front: [selfhosted/netbird-proxy.conf.template](selfhosted/netbird-proxy.conf.template) carries the verified requirements, including the dashboard callback paths its static export cannot serve by itself.
4. Custom DNS: [selfhosted/custom-zone.json.template](selfhosted/custom-zone.json.template) creates the zone. A zone create does not store the `records` it carries, so add each machine's record afterwards with `POST /api/dns/records`, whose body is that template's record entry; the distribution rule and the API shapes are in [netbird-management.md](netbird-management.md).
5. Machines: [client/install.sh](client/install.sh) enrolls a computer and installs DSH **and the plugin bundle** (`dsh plugin --profile web add @dsh-cove/dsh-web-all@latest` - the clients require it: a host without it answers, but is not the product) - `--management-url` points it at your control plane, `--channel` at a channel you publish - and per-machine exposure uses [nginx.conf.template](nginx.conf.template) with [dsh-web.service.template](dsh-web.service.template).
6. Phones: install the app and set the server on the login screen (`服务器 · 修改`) or under Settings (login server). Changing the address clears the local enrollment and signs in again against the new control plane.

## Acceptance

Each check proves one hop, and the first failure names the hop to fix. Run them in this order.

```sh
# 1. TLS and reachability: an unauthenticated 401 is the expected answer.
curl -fsS -o /dev/null -w '%{http_code}\n' "https://<management-host>/api/peers"

# 2. The embedded IdP publishes its endpoints.
curl -fsS "https://<management-host>/.well-known/openid-configuration" | head -c 200

# 3. The zone is named netbird and holds one A record per machine.
curl -fsS -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" "https://<management-host>/api/dns/zones"
curl -fsS -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" "https://<management-host>/api/dns/zones/<zone-id>/records"

# 4. From another enrolled peer, the entry answers 302 (login) or 200.
curl -sI -m 10 "http://dsh.<machine>.netbird/" | head -1
```

The last two hops are client-side and cannot be automated from the server: the phone lists the machine after signing in with your address, and the desktop client's `anywhere status` reports a connected management stream.

## What stays this fleet's

- The update channel and the bootstrap origins belong to the app build, and so does the control plane a fresh install enrolls against: pass it when building, and it is compiled in.
  ```sh
  cd tools/netbird-client/android
  ./gradlew -p . :app:assembleRelease \
    -PawManagementUrl=https://netbird.<your-domain>:443
  ```
  `build.gradle` writes it into `BuildConfig.AW_MANAGEMENT_URL` and `NetBirdRuntime` reads it, so no Kotlin edit is needed and the repository keeps the documentation placeholder as its fallback. Without the property a fresh install has no usable address and has to be given one in the app per install; `scripts/publish.sh` refuses to publish an APK that does not carry the address its channel advertises, so that mistake cannot reach a phone twice.
- [machines.json](machines.json), the audit (`pnpm dsh-netbird:audit`) and the namespace tool (`pnpm dsh-netbird:namespaces`) assume this repository's fleet and SSH inventory; they are adoptable, but each deployment keeps its own inventory of the same shape.