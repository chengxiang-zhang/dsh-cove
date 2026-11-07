#!/usr/bin/env bash
# Wish 机械验收门 — 只核对「产生真实质量后果」的证据，不搞文档仪式。
#
# Usage:
#   verify.sh --cwd <workspace> --spec <id> [--kind ui|code]
#
# Checks:
#   1. .sdd/acceptance/<id>/coverage.tsv 存在 且 coverage_check.py 通过（存量功能落点完整）
#   2. .sdd/acceptance/<id>/shots/ 下存在 ≥1 张截图（多视口真实渲染 = 用户可见验收）
#   3. .sdd/acceptance/<id>/e2e/ 三件套：steps.md（≥2 编号步骤）+ run.log + ≥1 截图（端到端走查）
#   3. live 重跑（保留）：旧格式测试证据 TSV 若存在，unit/integration/health 命令自己重跑
#
# Gate integrity: if scripts/MANIFEST.sha256 exists next to this script, verify.sh,
# replay.sh, journey.sh, check_spec.py, coverage_check.py and release_check.py must match
# their locked hashes or the gate refuses (evidence untrustworthy). Regenerate with gate-lock.sh.
set -euo pipefail

CWD="."
SPEC=""
KIND="ui"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cwd) CWD="${2:-}"; shift 2 ;;
    --spec) SPEC="${2:-}"; shift 2 ;;
    --kind) KIND="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "verify: unknown arg $1" >&2; exit 2 ;;
  esac
done

[[ -n "$SPEC" ]] || { echo "verify: --spec required" >&2; exit 2; }
case "$KIND" in ui|code) ;; *) echo "verify: --kind must be ui|code" >&2; exit 2 ;; esac

find_root() {
  local d
  d="$(cd "$1" && pwd)"
  while true; do
    if [[ -f "$d/AGENTS.md" || -d "$d/.sdd" || -d "$d/docs" ]]; then
      printf '%s\n' "$d"; return
    fi
    local parent; parent="$(dirname "$d")"
    [[ "$parent" == "$d" ]] && break
    d="$parent"
  done
  cd "$1" && pwd
}

trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"; printf '%s' "$s"; }

sha256_of() {
  local f="$1"
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$f" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$f" | awk '{print $1}'
  else echo "verify: no sha256sum/shasum available" >&2; exit 2; fi
}

ROOT="$(find_root "$CWD")"

# ---- gate integrity ---------------------------------------------------------
GATES_DIR="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$GATES_DIR/MANIFEST.sha256"
if [[ -f "$MANIFEST" ]]; then
  for f in verify.sh replay.sh journey.sh check_spec.py coverage_check.py release_check.py; do
    [[ -f "$GATES_DIR/$f" ]] || continue
    want="$(grep -E "  $f\$" "$MANIFEST" | head -1 | awk '{print $1}')" || want=""
    if [[ -n "$want" ]]; then
      got="$(sha256_of "$GATES_DIR/$f")"
      if [[ "$got" != "$want" ]]; then
        echo "verify FAIL: gate script $f modified since lock — evidence untrustworthy (rerun gate-lock.sh after legitimate edits)" >&2
        exit 1
      fi
    fi
  done
fi

# ---- code 类验收：命令型证据（非 UI 任务） ---------------------------------
if [[ "$KIND" == "code" ]]; then
  ACC=""
  for f in "$ROOT/docs/changes/$SPEC/acceptance.md" "$ROOT/docs/wish/$SPEC/acceptance.md"; do
    [[ -f "$f" ]] && ACC="$f" && break
  done
  [[ -n "$ACC" ]] || { echo "verify FAIL: no acceptance.md for code task ($SPEC)" >&2; exit 1; }
  grep -qE '负控|negative' "$ACC" || { echo "verify FAIL: acceptance.md lacks negative control" >&2; exit 1; }
  grep -qE '回滚|rollback|revert' "$ACC" || { echo "verify FAIL: acceptance.md lacks rollback" >&2; exit 1; }
  echo "verify OK: code evidence acceptance=$ACC"
  exit 0
fi

# ---- 存量功能落点映射 + 机械数数 -------------------------------------------
COVER_TSV="$ROOT/.sdd/acceptance/$SPEC/coverage.tsv"
[[ -f "$COVER_TSV" ]] || { echo "verify FAIL: no coverage.tsv at $COVER_TSV (阶段 4 存量功能落点映射)" >&2; exit 1; }

COVER_PY="$GATES_DIR/coverage_check.py"
[[ -f "$COVER_PY" ]] || { echo "verify FAIL: coverage_check.py missing next to verify.sh" >&2; exit 1; }
if ! python3 "$COVER_PY" "$ROOT" "$SPEC"; then
  echo "verify FAIL: coverage_check.py failed (存量功能落点不完整)" >&2
  exit 1
fi

# ---- 多视口真实渲染截图 ------------------------------------------------------
SHOTS="$ROOT/.sdd/acceptance/$SPEC/shots"
[[ -d "$SHOTS" ]] || { echo "verify FAIL: no screenshots dir at $SHOTS (阶段 4 多视口截图)" >&2; exit 1; }
nshots="$(find "$SHOTS" -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' -o -iname '*.gif' \) 2>/dev/null | wc -l | tr -d ' ')"
[[ "$nshots" -ge 1 ]] || { echo "verify FAIL: no screenshot file in $SHOTS (浏览器证据才算用户可见验收)" >&2; exit 1; }

# ---- 端到端浏览器走查（E2E，不是截图） --------------------------------------
E2E="$ROOT/.sdd/acceptance/$SPEC/e2e"
[[ -f "$E2E/steps.md" ]] || { echo "verify FAIL: no $E2E/steps.md (端到端走查 ≥2 条编号步骤；多视口截图不等于真点过一遍)" >&2; exit 1; }
nsteps="$(grep -cE '^[[:space:]]*[0-9]+[.)][[:space:]]+[^[:space:]]' "$E2E/steps.md" 2>/dev/null || echo 0)"
[[ "${nsteps:-0}" -ge 2 ]] || { echo "verify FAIL: $E2E/steps.md needs >=2 numbered steps" >&2; exit 1; }
[[ -s "$E2E/run.log" ]] || { echo "verify FAIL: $E2E/run.log missing or empty (真实浏览器通道输出，不是手写摘要)" >&2; exit 1; }
n_e2e_shots="$(find "$ROOT/.sdd/acceptance/$SPEC" -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' \) 2>/dev/null | wc -l | tr -d ' ')"
[[ "${n_e2e_shots:-0}" -ge 1 ]] || { echo "verify FAIL: no browser screenshot under .sdd/acceptance/$SPEC (至少一张)" >&2; exit 1; }

# ---- live 重跑（保留）：旧格式测试证据 TSV 若存在，可重跑类命令自己重跑 -------
OLD_EVID="$ROOT/.sdd/acceptance/$SPEC.tsv"
live="no"
if [[ -f "$OLD_EVID" ]]; then
  live="yes"
  while IFS=$'\t' read -r tid kind result path cmd exitcode output ts; do
    kind="$(trim "$kind")"
    result="$(trim "$result" | tr '[:upper:]' '[:lower:]')"
    cmd="$(trim "$cmd")"
    [[ "$tid" == "test_id" ]] && continue
    [[ -z "$tid" || "$tid" == \#* ]] && continue
    case "$kind" in
      unit|integration|health)
        if [[ "$result" == "pass" && -n "$cmd" && "$cmd" != "-" ]]; then
          mkdir -p "$ROOT/.sdd/acceptance/$SPEC/rerun"
          log="$ROOT/.sdd/acceptance/$SPEC/rerun/$tid.log"
          set +e
          if command -v timeout >/dev/null 2>&1; then
            ( cd "$ROOT" && timeout "${RERUN_TIMEOUT:-180}" bash -c "$cmd" ) >"$log" 2>&1
          else
            ( cd "$ROOT" && bash -c "$cmd" ) >"$log" 2>&1
          fi
          rc=$?
          set -e
          if [[ $rc -ne 0 ]]; then
            echo "verify FAIL: live re-run of $tid exited $rc — evidence stale or broken (see $log)" >&2
            exit 1
          fi
          echo "verify: live re-run $tid ok (exit 0, log $log)"
        fi
        ;;
    esac
  done < "$OLD_EVID"
fi

echo "verify OK: coverage=pass shots=$nshots live_rerun=$live"
exit 0
