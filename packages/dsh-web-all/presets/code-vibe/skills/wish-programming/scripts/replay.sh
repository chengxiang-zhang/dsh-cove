#!/usr/bin/env bash
# Red-green replay: an acceptance oracle must be RED on the baseline (HEAD) and GREEN on the
# current tree. Non-destructive: the baseline half runs in a throwaway `git worktree` at HEAD.
#
# Usage:
#   replay.sh --cwd <repo> --oracle '<command>' [--link <dir> ...]
#
# --link <dir>: symlink a dependency dir (e.g. node_modules, .venv) from the working tree into
#               the baseline worktree so the oracle can run there. Repeatable.
#
# Exit: 0 = red(baseline) -> green(now), discriminating evidence.
#       1 = green-on-baseline (nondiscriminating), not green now, or cannot run.
set -euo pipefail

CWD="."
ORACLE=""
LINKS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cwd) CWD="${2:-}"; shift 2 ;;
    --oracle) ORACLE="${2:-}"; shift 2 ;;
    --link) LINKS+=("${2:-}"); shift 2 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "replay: unknown arg $1" >&2; exit 2 ;;
  esac
done
[[ -n "$ORACLE" ]] || { echo "replay: --oracle required" >&2; exit 2; }

ROOT="$(cd "$CWD" && git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$ROOT" && -d "$ROOT/.git" ]] || { echo "replay FAIL: not a git repo: $CWD" >&2; exit 1; }

TMP="$(mktemp -d)"
cleanup() {
  git -C "$ROOT" worktree remove --force "$TMP" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

git -C "$ROOT" worktree add --detach "$TMP" HEAD >/dev/null 2>&1 || {
  echo "replay FAIL: cannot create baseline worktree at HEAD" >&2; exit 1
}

for d in "${LINKS[@]}"; do
  [[ -n "$d" ]] || continue
  if [[ -d "$ROOT/$d" && ! -e "$TMP/$d" ]]; then
    ln -s "$ROOT/$d" "$TMP/$d"
  fi
done

set +e
( cd "$TMP" && eval "$ORACLE" ) >/dev/null 2>&1
base=$?
( cd "$ROOT" && eval "$ORACLE" ) >/dev/null 2>&1
now=$?
set -e

if [[ $now -ne 0 ]]; then
  echo "replay FAIL: oracle not green on the current tree (exit $now)" >&2; exit 1
fi
if [[ $base -eq 0 ]]; then
  echo "replay FAIL: oracle GREEN on baseline (exit $base) — nondiscriminating, it tests nothing" >&2; exit 1
fi
echo "replay OK: baseline red (exit $base) -> current green (exit $now)"
exit 0
