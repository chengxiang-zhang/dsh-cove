#!/bin/bash
# dsh web launcher for the system LaunchDaemon ai.deepseek.dsh.web.
#
# Invariant: every canonical browser authority must reach `--trusted-host`.
# ctx.webRuntime.trustedHosts is the admission list for all privileged web-all
# host routes (Git workbench, right pane, worktree, SSH, memoir, schedule mode,
# Agent Browser, workbench reads); without it a remote browser gets HTTP 403 and
# the Git panel reports "Git operation failed: 403 Forbidden". The canonical
# traffic path and the authority rule live in tools/dsh-netbird/README.md.
#
# tools/dsh-launchd/install-dsh-daemons.sh substitutes these tokens:
#   dsh bin dir   = __DSH_BIN_DIR__
#   home          = __HOME__
#   dsh home      = __DSH_HOME__
#   trusted hosts = __TRUSTED_HOST_FLAGS__   (one --trusted-host per authority)
#
# launchd runs this without a GUI session, so it stays free of prompts,
# hostname discovery and any dependence on a login environment.

set -u

export HOME="__HOME__"
export DSH_HOME="__DSH_HOME__"
export PATH="__DSH_BIN_DIR__:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

exec __DSH_BIN_DIR__/dsh web --host 127.0.0.1 --port 3080 --no-open __TRUSTED_HOST_FLAGS__
