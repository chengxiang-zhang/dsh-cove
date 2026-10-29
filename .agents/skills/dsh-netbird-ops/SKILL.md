---
name: dsh-netbird-ops
description: Use for NetBird fleet operations around the dsh cluster — inventory, DNS/domain management, adding or fixing a machine, audit, and cross-machine dsh access. Loads the fleet facts and command templates needed to operate the private NetBird network and its DSH entry points.
whenToUse: Any request about the NetBird network, its DNS zones and records, the per-machine DSH entries, update channel domains, routes/groups/setup keys, or running dsh work on another machine in the fleet.
user-invocable: true
---

# dsh + NetBird Fleet Operations

This skill is operational guidance for the private NetBird network that hosts one DSH Web instance per machine. The authoritative facts live in [tools/dsh-netbird](../../../tools/dsh-netbird/README.md) (address contract, inventory, audit), [tools/dsh-netbird/machines.json](../../../tools/dsh-netbird/machines.json) (machine list), and [tools/dsh-netbird/netbird-management.md](../../../tools/dsh-netbird/netbird-management.md) (control plane: DNS, routes, groups, setup keys). Read those before acting; this skill only wires the workflow.

## Fleet model

- Every computer is a NetBird peer (`<machine>.vpn`, NetBird IPv4 in `machines.json`) and runs a loopback-only DSH Web on `127.0.0.1:3080` exposed as `http://dsh.<machine>.netbird/` through nginx on port 80, bound to that machine's NetBird address so the entry is overlay-only. Each machine declares `authMode` (`password` or `network-gate`) in `machines.json`; `network-gate` means the overlay is the authenticator and is only allowed once the gate is verified.
- The operational workstation reaches any machine via the `nb-<machine>` SSH aliases defined in `~/.ssh/config` (BatchMode, key-only). The mobile entry point is the NetBird Portal app ([tools/netbird-client](../../../tools/netbird-client/README.md)); the mobile update channel is served by the network edge at `https://anywhere.example.com/` (`tx`).

## Read the state

1. Load `tools/dsh-netbird/machines.json` — canonical machine list, domains, NetBird IPs, ssh aliases.
2. Run the audit with `--verify-gate` from the operator workstation so the overlay gate is checked over SSH as well:

```sh
pnpm dsh-netbird:audit --verify-gate
```

It verifies every canonical domain resolves to the inventory address, that the signed-out entry matches the machine's `authMode` (`password` redirects to `/login`, `network-gate` answers the DSH document), that `GET /api/dsh-access/session` reports a declared authority, that `GET /worktree/tree` leaks to no undeclared or sessionless caller, that an oversized request body is not answered with 500 at the edge, and that no non-overlay local address serves the DSH entry. Failures mean DNS mismatch, connection failure, nginx placeholder, 502, broken auth, a stale plugin build without the shared fence, an unusable proxy temp path, or an entry that is still reachable off the overlay — do not declare a machine healthy until its entry passes.

3. For control-plane queries (peers, DNS zones/records, routes, groups, setup keys) use the management API templates in `netbird-management.md` with `NETBIRD_MGMT_TOKEN` set from the console. Tokens never enter the repository.

## Service-operation pre-flight

Run this before touching any machine's DSH process, profile, or `~/.dsh` paths. The owning rules and their rationale are in [tools/dsh-netbird](../../../tools/dsh-netbird/README.md) (Service-operation pre-flight).

1. Identify the supervisor for the pid (`systemctl status <pid>` / `/proc/<pid>/cgroup`) in **both scopes** — `systemctl is-active <unit>` and `systemctl --user is-active <unit>`, or `launchctl print gui/$(id -u)/<label>` on macOS. Checking only `--user` misreads a system unit as unmanaged.
2. Act through that supervisor only (`systemctl [--user] restart <unit>`, `launchctl kickstart -k`). Never kill a process and hand-launch a `nohup` replacement: the manual instance holds 3080 and the supervisor's `RestartSec` retries all fail with `EADDRINUSE`.
3. A restart needs explicit user authorization, one restart per host per operation; then read the new log segment for `startup failed` / `EADDRINUSE` / `failed to import`.
4. Before moving or archiving anything under `~/.dsh`, check the units' `ExecStartPre` / `ExecStartPost` (including `*.service.d/*.conf`) and their hook scripts for references to that path.

## Change workflows

- **Onboard an employee**: create the member in Casdoor, approve them in the console, then run `pnpm dsh-netbird:namespaces` (dry-run) and `--apply`. That gives them a `u-<user>` group, a `self-<user>` policy and membership of the fleet DNS zone's distribution; without the DNS half their machines get `NXDOMAIN` for their own `dsh.<machine>.netbird` entry, and a machine already connected needs `netbird down && netbird up` before it receives the new DNS configuration. `--no-zone-access` skips the DNS half, `--revoke-zone-access` takes it back, and `--with-ops-access` adds opt-in IT reach.
- **Add a machine**: follow the numbered procedure in `tools/dsh-netbird/README.md` (Adding a computer), including the control-plane steps in `netbird-management.md` (peer registration or one-off setup key, DNS zone + `dsh.<machine>.netbird` A record, `machines.json` entry), then audit from another peer. A zone update is a whole-zone replace, so carry the existing records back or they are dropped.
- **Repair a machine**: work from the failure table in `tools/dsh-netbird/README.md`; each row names the symptom, the cause, and the repair. A symptom that appears only for large sends (an image attachment, a long prompt, an upload) while short messages keep working is the edge proxy failing to spool the request body, so edit that machine's virtual host as the table says and reload its proxy. Preparing that config needs no privilege, but activating it does: every macOS entry runs an nginx master owned by root, so its operator reloads it.
- **DNS / domains**: zones and records under `/api/dns/zones` and `/api/dns/records`; keep short TTLs and bump the network serial after server-side changes. The domain contract table in `netbird-management.md` lists every name pattern in use (`dsh.<machine>.netbird`, `anywhere.example.com`, sci-exit domains).
- **Routes / groups / setup keys**: templates in `netbird-management.md`; one-time setup keys are deleted after use; route changes are fleet-affecting — verify from a non-affected peer.

## Cross-machine dsh access

To operate another machine's DSH instance (multi-agent work across the cluster):

```sh
# reachable entry (browser or HTTP API)
curl -sI http://dsh.<machine>.netbird/            # 302 to /login, or the DSH document on a network-gate machine
# check the gate: no non-overlay address may serve the entry
ssh nb-<machine> 'ifconfig 2>/dev/null | awk "/inet /{print \$2}"; ss -ltn | grep -E ":(80|3080)\b"'
```

Use the ssh alias only; never fall back to interactive password login (BatchMode is configured). Prefer the loopback listener over the overlay address for diagnostics, and verify canonical URLs from a second peer because some NetBird clients do not hairpin their own traffic.

## Safety boundaries

- Keep PATs, setup keys, passwords, session cookies, and bootstrap tokens out of the repository, docs, nginx files, and service units.
- Do not add IP literals or compatibility aliases to a machine's trusted-host list; only the canonical `dsh.<machine>.netbird` authority.
- Never drop a machine's browser password (`noBrowserAuth: true`, `authMode: network-gate`) before the overlay gate passes `--verify-gate` on that machine; keep the backup file of any nginx edit outside the `include servers/*` directory.
- Fleet changes roll out one machine at a time (canary first), with per-machine verification recorded before moving on; the operator's own machine restarts last.
