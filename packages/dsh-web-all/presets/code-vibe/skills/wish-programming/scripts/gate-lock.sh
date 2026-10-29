#!/usr/bin/env bash
# gate-lock.sh — hash-lock the gate scripts so verify/journey can detect tampering.
#
# Usage:
#   gate-lock.sh            # (re)write MANIFEST.sha256 next to the scripts
#   gate-lock.sh --check    # verify current hashes match the manifest (exit 1 on mismatch)
#
# Run after any legitimate edit to scripts/. The manifest is the
# integrity baseline: verify.sh / journey.sh refuse to trust evidence when a gate script
# no longer matches it. Scripts live outside the workspace, so agents cannot rewrite them;
# the lock detects deployments where the scripts were changed after the baseline.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$DIR/MANIFEST.sha256"
FILES=(check_spec.py check_whitelist.py coverage_check.py gate-lock.sh journey.sh project.sh replay.sh scan_drift.py verify_preset_budgets.py verify.sh wish.sh)

sha256_of() {
  local f="$1"
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$f" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$f" | awk '{print $1}'
  else echo "gate-lock: no sha256sum/shasum available" >&2; exit 2; fi
}

if [[ "${1:-}" == "--check" ]]; then
  [[ -f "$MANIFEST" ]] || { echo "gate-lock: no manifest at $MANIFEST" >&2; exit 1; }
  bad=0
  while read -r want f; do
    [[ -f "$DIR/$f" ]] || { echo "gate-lock: $f missing" >&2; bad=1; continue; }
    got="$(sha256_of "$DIR/$f")"
    if [[ "$got" != "$want" ]]; then
      echo "gate-lock: $f modified since lock" >&2; bad=1
    fi
  done < <(grep -vE '^#|^$' "$MANIFEST")
  if (( bad )); then echo "gate-lock: CHECK FAIL" >&2; exit 1; fi
  echo "gate-lock: check ok"
  exit 0
fi

: > "$MANIFEST"
for f in "${FILES[@]}"; do
  if [[ -f "$DIR/$f" ]]; then
    printf '%s  %s\n' "$(sha256_of "$DIR/$f")" "$f" >> "$MANIFEST"
  fi
done
echo "gate-lock: wrote $MANIFEST ($(grep -vcE '^#|^$' "$MANIFEST") files)"
