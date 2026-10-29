---
name: dsh-local-ops
description: Use when the local DSH fails to load the web-all entity (ModuleLoader "already executed without registering", legacy @zcx/dsh-web-all, or a stale profile link) or after a package scope rename. Runs the audit, migration, and link refresh, then hands the restart to the user.
whenToUse: Local DSH Web does not mount @dsh-cove/dsh-web-all, a profile still names @zcx/dsh-web-all, or a stale com.dsh.doctor LaunchAgent or ad-hoc restart script is suspected.
user-invocable: true
---

# dsh Local Ops

The canonical flow and its rationale live in [docs/development.md](../../../docs/development.md#本地验证). This skill only sequences it.

1. Run `pnpm dsh-local:audit`. Every FAIL line states its own remedy.
2. For `@zcx/dsh-web-all` findings, run `pnpm dsh-local:migrate` (dry run), then `pnpm dsh-local:migrate --apply`. Do not use `dsh plugin add` to repair a profile.
3. Run `node scripts/link-profile.mjs` (the migration already does this for the default `~/.dsh`).
4. Re-run `pnpm dsh-local:audit` until it exits 0.
5. Tell the user the managed DSH service needs a restart. Never restart, `kill`, or replace the running `dsh web` process.

Stale `com.dsh.doctor.plist` and `dsh-web-restart.sh` findings are operator actions named in the audit output; retire the script with a `*.retired` rename and ask before touching LaunchAgents.
