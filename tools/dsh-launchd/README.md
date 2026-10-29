# dsh-launchd — office Mac service management

The reference deployment on `Laptop-B.local` (`dsh.laptop-b`) runs three services that
used to be **user LaunchAgents** (started at GUI login) and are now **system
LaunchDaemons** (started at boot), so a reboot does not require anyone to log in
at the console:

| Label | What | Ports |
| --- | --- | --- |
| `ai.deepseek.dsh.web` | `dsh web` through `~/.dsh/bin/start-dsh-web.sh` (the family entity) | 3080, 3082 (gateway) |
| `com.leo.dsh-nginx` | nginx front door (`/opt/homebrew/etc/nginx/servers/dsh.mac.conf`) | 80, 443, 8080 |
| `com.zcx.dsh-api-proxy` | Codex/LLM API proxy | 8317 |

## Managed artifacts

`install-dsh-daemons.sh` is the single writer for these paths. Its sources live
in the repository and are deployed to `~/.dsh`:

| Artifact | Repository source | Contents |
| --- | --- | --- |
| `/Library/LaunchDaemons/<label>.plist` | `launchd/<label>.plist` | the three boot-time services |
| `~/.dsh/bin/start-dsh-web.sh` | `launchd/start-dsh-web.sh` | the `dsh web` launcher, materialized with the `dsh` directory, the user home and the `--trusted-host` authorities |
| `~/.dsh/launchd/agents-disabled/` | — | the user LaunchAgents the installer displaced |

## Why this exists

These three services must come up at boot without a GUI login: `dsh.mac` is a
remote-only machine, so as *user* LaunchAgents they would stay down after a
reboot until somebody logged in at the console. LaunchDaemons start them at boot
instead.

## The trusted-host invariant

`dsh web` admits a browser authority only when it is passed with
`--trusted-host`; the acceptance contract for that fence is
[../../docs/remote-access.md](../../docs/remote-access.md). That list is the admission
list for every privileged web-all host route (Git workbench, right pane,
worktree, SSH, memoir, schedule mode, Agent Browser, workbench reads): a launcher
that omits it answers HTTP 403 to every remote browser and the Git panel renders
`Git operation failed: 403 Forbidden`, so a reboot silently loses remote access.
The canonical authority is `dsh.<netbird-machine-name>`, as documented in
[../dsh-netbird/README.md](../dsh-netbird/README.md). The nginx virtual host
also accepts legacy names (`dsh.mac`, LAN and overlay addresses), but those are
compatibility aliases: only the canonical authority belongs in the admission
list, and browsers reach the machine at `http://dsh.<netbird-machine-name>/`.

The installer refuses to run without at least one authority and installs nothing
in that case. Repeat and mix these options freely:

- `--trusted-host dsh.laptop-b` names the authority directly.
- `--machine laptop-b` takes the `domain` of that `netbirdName` from
  [../dsh-netbird/machines.json](../dsh-netbird/machines.json); set
  `DSH_LAUNCHD_MACHINES` when that file is not next to the installer.

An authority must be a DNS name with at least one dot. IP literals, names with a
port, schemes and paths are refused.

## Install (on the Mac)

```bash
sudo zsh ~/.dsh/bin/install-dsh-daemons.sh --machine laptop-b            # install only
sudo zsh ~/.dsh/bin/install-dsh-daemons.sh --trusted-host dsh.laptop-b   # name the authority directly
sudo zsh ~/.dsh/bin/install-dsh-daemons.sh --machine laptop-b --reboot   # install, verify, reboot
```

The `~/.dsh/bin/...` form needs the current `install-dsh-daemons.sh`,
`lib-dsh-launchd.sh` and `launchd/start-dsh-web.sh` deployed there; from a
repository checkout run the repository copy instead:
`sudo zsh tools/dsh-launchd/install-dsh-daemons.sh --machine <netbirdName>`.

The installer first resolves the authorities and materializes
`~/.dsh/bin/start-dsh-web.sh`, then stops the GUI agents, moves their plists to
`~/.dsh/launchd/agents-disabled/`, installs + bootstraps the three daemons, then
verifies each label has a pid and that 3080/3082/80/8317 are listening. If any
check fails it rolls back to the previous (login-time) mode. The launcher phase
runs before any daemon change, so a bad invocation cannot half-install.

The launcher is written at mode 0755 from `~/.dsh/launchd/start-dsh-web.sh` and
printed in full after it is written. An existing launcher that already passes
`--trusted-host` is kept as it is; `--rewrite-launcher` replaces it anyway.
Every replacement first copies the previous file to
`~/.dsh/bin/start-dsh-web.sh.bak-<timestamp>`.

Rollback:

```bash
sudo zsh ~/.dsh/bin/uninstall-dsh-daemons.sh
```

That removes the daemons and restores the login-time agents; the launcher
stays in place. To restore an earlier launcher, copy the matching
`~/.dsh/bin/start-dsh-web.sh.bak-<timestamp>` over it.

Recovery helper after a socket-table hang (prints the occupancy, then reboots):

```bash
zsh ~/.dsh/bin/recover-dsh.sh
```

## Notes

- The daemons run as the operator user (`UserName`), with `HOME` / `DSH_HOME` / `PATH` set as the agents had them.
- The plists in `launchd/` are templates: the installer substitutes `__USER__`, `__HOME__` and `__REPO_DIR__` (override the repository path with `DSH_COVE_REPO`, the user with `DSH_LAUNCHD_USER`).
- Without a GUI session the services are headless: `open-in-app` and the native
  directory picker degrade; the web UI, SSH, git and headless Playwright are
  unaffected.
- The launcher exports `HOME`, `DSH_HOME` and `PATH` itself and stays free of
  prompts and hostname discovery, so it is safe to `exec` from launchd.
- The `dsh` directory defaults to the first `PATH` entry of
  `~/.dsh/launchd/ai.deepseek.dsh.web.plist`; pass `--dsh-bin-dir <dir>` when the
  executable lives elsewhere.
- `install-dsh-daemons.sh` sources `lib-dsh-launchd.sh` from its own directory
  or from `~/.dsh/launchd/`; deploy both files together.