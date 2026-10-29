# Employee guide: joining the private network

[中文](employee-guide.zh.md) | English

This guide is for employees who use this private network: how to get an account, install the client on your own machines and sign in, bring more machines under your name, open your own machines' entry, and confirm that your machines reach each other while nobody else's are visible. Control-plane operations live in [netbird-management.md](netbird-management.md), the fleet address contract and machine inventory in [README.md](README.md), and the mobile client in [../netbird-client/README.md](../netbird-client/README.md).

## What you get

- The machines you connect form a private network that belongs to you alone; they can reach each other on any port (SSH, remote desktop, databases, web pages).
- A machine installed with the one-liner runs DSH as well, so it opens its own workspace at `http://dsh.<machine>.netbird/` without a second sign-in once an administrator publishes that name: it treats overlay membership as the credential.
- Android phones use our own client to list and open those pages under your name; installation and updates come from the in-network channel, not an app store.
- Colleagues' machines are outside your scope: you can neither see nor reach them.
- It works off the corporate network as well (at home, on a phone hotspot).

## Before you start

- A corporate account, created for you by an administrator in Casdoor.
- A machine to connect, and the administrator rights needed to install a client.
- A network path to the corporate SSO origin, the NetBird management origin and the install channel; this guide uses the sample addresses `https://sso.example.com`, `https://netbird.example.com:443` and `https://anywhere.example.com`.

## Step 1: get an account

Tell an administrator your name and email so they can create your member in Casdoor. There is no self-service sign-up, and you do not need to sign in to a browser first.

## Step 2: install the client

### macOS

```sh
curl -fsSL https://anywhere.example.com/install.sh | sh
```

Open Terminal and paste it: the script downloads the client from our channel, verifies its SHA-256, installs it, registers the background service, and finally opens the browser for you to sign in. It then installs DSH, keeps it running in the background and prints the one step it cannot take for you: the model API key (step 7). Intel and Apple silicon are both supported.

### Windows

Download the Windows installer from [NetBird Releases](https://github.com/netbirdio/netbird/releases/latest), run it, and follow the prompts.

### Linux

```sh
curl -fsSL https://anywhere.example.com/install.sh | sh
```

### Android

Use our own client on phones rather than installing the official NetBird app from an app store: it accepts only the `dsh.<machine>.netbird` addresses the fleet has registered and lets only the app's own traffic enter the overlay, so the device is not connected to a general VPN. The shipped build is the Android package (arm64-v8a; HarmonyOS devices that are APK-compatible can use it too); the iPad/iOS client is not delivered yet. The onboarding page lives on a public channel, so **joining the network first is not required**: open `https://anywhere.example.com/` in a browser and tap once to download the package (the same page carries the desktop command, and `http://tx.vpn/AnywhereWork.apk` is the same file once enrolled), then open the app and sign in with your company account. Client details are in [../netbird-client/README.md](../netbird-client/README.md).

## Step 3: sign in and connect

Desktop: paste the command above. The sign-in page offers **Feishu** by default and a switch to **account + password**; both lead to the same identity.

With the client already installed (signing in by hand):

```sh
anywhere up --management-url https://netbird.example.com:443
```

On a machine without a browser (a server or a container): add `--no-browser`, and the client prints a sign-in link; open it in any browser, sign in, and confirm.

```text
Use this URL to log in: https://netbird.example.com/oauth2/device?user_code=XXXX-XXXX
```

Mobile client: open the app and sign in with your corporate account (same channel, same identity as the desktop). Confirm the state on a computer afterwards:

```sh
anywhere status
```

`Management` and `Signal` both showing `Connected` means you are in.

## Step 4: your private group appears on its own

Once you have signed in the server creates your own private group automatically, normally within two minutes: there is no approval and no button to press. Before the group appears the client is already connected, it just sees no other machine yet.

## Step 5: connect more machines

Repeat steps 2 and 3 on every machine you want to connect, signing in with the same account. Those machines join your name automatically and can see and reach each other.

## Step 6: open your own machines' entry

Open this in a browser:

```text
http://dsh.<machine>.netbird/
```

- The address carries no port, and you should not substitute a NetBird IP or a LAN address: the entry only answers to this canonical name.
- `<machine>` is the peer name `anywhere status` shows for that machine, without the `.vpn` suffix.
- A machine installed with the one-liner already runs DSH; the administrator's part is publishing the name, so the entry appears without you deploying anything.
- The service list in the mobile client holds the same addresses and lists only the machines in your own namespace.

For plain remote access that does not need DSH, use the overlay address directly, for example `ssh user@100.64.x.y`.

## Step 7: give DSH its model key

DSH is configured with Kaon Router as its model provider, and one API key is all it needs. Its admin console is the sample address used throughout this guide:

```text
https://router-admin.example.com/
```

- Apply for a key in that console (API keys), then open `http://127.0.0.1:3080/` on the machine, go to the model provider settings, choose Kaon Router and paste the key.
- The same thing by hand: put `KAON_ROUTER_API_KEY: <the key>` under `refs:` in `~/.dsh/.credentials.yaml` (owner-readable only, mode 0600).
- Without the key DSH still starts and serves the interface; every conversation fails with an authentication error until it is filled in.

## Step 8: confirm isolation

```sh
anywhere status --ipv4
anywhere status -d
ping <another of your machines' NetBird address>
```

Isolation is in effect when `anywhere status -d` lists only your own machines.

## What the client does

- The app is a peer itself: only the app's own traffic enters the overlay, and the phone is not connected to a general VPN.
- The list, the opened page and the web microphone share one registry: it shows only the machines under your name and refuses every other intranet address, public address and raw IP.
- Pages render the full workspace in the app's built-in engine rather than the device's old WebView, and their voice input works: the app grants the page microphone access without transcribing or storing audio itself.
- An Android foreground service keeps the connection alive across the lock screen, backgrounding and process restarts.
- A stuck connection is not a dead end: the list screen says which layer is stuck and always offers Retry and Sign in again.

## How an entry asks you to sign in

An entry has one of two modes, depending on how that machine was deployed:

- No second sign-in (`network-gate`): reaching the overlay opens the workspace directly, which is how most fleet machines work.
- Sign-in required (`password`): it redirects to that machine's own DSH sign-in page, where you use the account its administrator gave you; local accounts, Feishu and OIDC are supported, the credentials belong to that machine's administrator, and they are not your NetBird account.

## Optional: split-tunnel egress

The network carries one optional domain-level egress: a curated set of overseas domains (the Google family, GitHub, OpenAI/ChatGPT, Claude, X/Twitter, Facebook, Telegram, Netflix, Notion, Cloudflare) is reached through the office's public egress, which is steadier for fetching code and looking things up. An administrator enables it by adding your device to the `sci-exit` group:

```sh
anywhere down && anywhere up
curl ifconfig.me
```

The second command shows the office public IP when it is in effect; stay out of that group if you do not want this egress.

## Common commands

| Goal | Command |
| --- | --- |
| Connect and sign in | `anywhere up --management-url https://netbird.example.com:443` |
| Disconnect | `anywhere down` |
| Refetch configuration and DNS | `anywhere down && anywhere up` |
| Show status | `anywhere status` |
| Show this machine's address | `anywhere status --ipv4` |
| Show visible machines | `anywhere status -d` |

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| No machines visible after signing in | The private group takes up to two minutes (the server does it, no approval needed); with only your first machine enrolled there is no other machine to see yet |
| Our app is not in the app store | The client comes only from our own channel: open `https://anywhere.example.com/` in a browser (the same page carries the desktop one-liner); an old `com.netbirdportal` install has to be removed by hand |
| Opening an entry asks you to sign in | That machine runs in `password` mode: use the DSH account its administrator gave you (local account, Feishu or OIDC) |
| `dsh.<machine>.netbird` does not resolve | Your account is not in the fleet DNS yet: ask an administrator to run `pnpm dsh-netbird:namespaces --apply`, then run `anywhere down && anywhere up` so your client picks up the new DNS configuration |
| Other machines' names resolve but nothing connects | By design: the names come from the fleet DNS, reachability is decided by policy, and your policy covers only your own machines |
| `dsh.<machine>.netbird` does not open | That machine has no DSH entry deployed; ask an administrator to confirm |
| DSH opens but every conversation fails with an authentication error | Its model key is missing: apply for one at `https://router-admin.example.com/` and paste it into DSH (step 7) |
| You want a colleague's machine or the corporate intranet | This is the isolation working as intended; ask an administrator for a policy when a service must be shared |
| Machines go offline after a while | Sign-in lasts 7 days; run `anywhere up` to sign in again |
| Forgot your password | Ask an administrator to reset it in Casdoor |
| Replacing or returning a machine | Ask an administrator to remove the old machine's record; `anywhere down` on the machine only disconnects it |
| The browser cannot open the sign-in page | Confirm you can reach `https://sso.example.com` |
| Sign-in says `Failed to launch 飞书` | Feishu's authorization page tried to open the Feishu app on your phone and could not. On that page use 更多登录方式 (more sign-in methods) or 扫码登录 (scan a QR code) - either completes the same authorization. Or go back one screen and sign in with account and password |
| Your phone runs HarmonyOS and the app will not install or crashes | It depends on whether the system can run Android apps: HarmonyOS 4 and earlier can; HarmonyOS NEXT (HarmonyOS 5) dropped Android app support, so there is no build for it yet. Check Settings, About phone, HarmonyOS version |
| Your phone's Feishu is the HarmonyOS build and tapping Feishu sign-in does nothing | The HarmonyOS Feishu build does not answer an Android app's jump; that is the boundary between the two systems. Use the alternatives in the row above |
| The install script reports a checksum mismatch | The download arrived incomplete; run it again, and ask an administrator to check the channel if it keeps happening |
| Latency is high | When a direct connection is impossible the client relays traffic, which is a normal fallback |

## Security and privacy

- Your machines talk over encrypted peer-to-peer connections; the management service hands out configuration and keys but does not carry your traffic, which is relayed only when a direct connection fails.
- Administrators can see the machine names, addresses, online state, and sign-in records of the machines you connect; that is the normal audit surface of a corporate network.
- Do not share an account: sign in with your own account on every machine so the machines are attributed to you.
- So that your machines open under their canonical name, your client receives every name in the fleet DNS zone (other machines' names and some internal service names included), but none of those addresses connect. An administrator can drop that name visibility with `--no-zone-access`, or narrow the zone as described in [netbird-management.md](netbird-management.md).

## What the administrator does

Only one onboarding step is manual: create the member in Casdoor (a Feishu sign-in creates the account by itself). Everything else is done by the installed cron every two minutes - it creates the `u-<username>` private group, writes it into that user's `auto_groups` (machines already connected join along), creates the `self-<username>` policy and adds the group to the fleet DNS distribution; no approval is involved. Run `pnpm dsh-netbird:namespaces --apply` by hand when it has to take effect immediately. Command details, direct IT access, and troubleshooting are in [netbird-management.md](netbird-management.md); run `pnpm dsh-netbird:audit --verify-gate` after deploying or repairing a machine, and `pnpm dsh-netbird:mobile-registry` after changing the machine inventory.