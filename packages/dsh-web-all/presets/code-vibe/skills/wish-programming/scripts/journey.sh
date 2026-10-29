#!/usr/bin/env bash
# Wish journey state machine — 简化状态机（v2 五阶段）。
#
# State file: <workspace>/.sdd/journey/<spec>.env
#
# Usage:
#   journey.sh --cwd <workspace> --spec <id> --status
#   journey.sh --cwd <workspace> --spec <id> --list-phases
#   journey.sh --cwd <workspace> --spec <id> --set <phase>            # human recovery only
#   journey.sh --cwd <workspace> --spec <id> --transition <phase> [--reason "<why>"]
#   journey.sh --cwd <workspace> --spec <id> --confirm --by <who>    # 需求理解确认工件（人①）
#   journey.sh --cwd <workspace> --spec <id> --approve --by <who>    # 用户 judge 验收标记（人②）
#   journey.sh --cwd <workspace> --spec <id> --assert write|build|lint|typecheck|deploy|claim-deliver
#   journey.sh --cwd <workspace> --spec <id> --assert lint|typecheck [--dir <dir>]  # v2: per-slice quality gate
#   journey.sh --cwd <workspace> --spec <id> --confirm --by <who> [--channel interactive|cli]
#   journey.sh --cwd <workspace> --spec <id> --confirm --by <who> [--no-ui]  # 非 UI 愿望：声明豁免多视口截图
#   journey.sh --cwd <workspace> --spec <id> [--root <dir>]  # 显式指定项目根（防 find_root 漂移）
#
# Gates (no --force; --set is the human recovery hatch):
#   - acceptance-passed requires the human approval marker (--approve) AND
#     check_spec.py --phase close exit 0 (回填: handoff + 决策/债落库)
#   - blocked / stuck require --reason and are terminal except human --set
set -euo pipefail

CWD="."
SPEC=""
ACTION=""
TARGET=""
REASON=""
APPROVER=""
CHANNEL="cli"
ASSERT_DIR=""
ROOT_ARG=""
NO_UI_FLAG=0

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cwd) CWD="${2:-}"; shift 2 ;;
    --spec) SPEC="${2:-}"; shift 2 ;;
    --status) ACTION=status; shift ;;
    --list-phases) ACTION=list; shift ;;
    --set) ACTION=set; TARGET="${2:-}"; shift 2 ;;
    --transition) ACTION=transition; TARGET="${2:-}"; shift 2 ;;
    --approve) ACTION=approve; shift ;;
    --confirm) ACTION=confirm; shift ;;
    --by) APPROVER="${2:-}"; shift 2 ;;
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --dir) ASSERT_DIR="${2:-}"; shift 2 ;;
    --root) ROOT_ARG="${2:-}"; shift 2 ;;
    --no-ui) NO_UI_FLAG=1; shift ;;
    --reason) REASON="${2:-}"; shift 2 ;;
    --assert) ACTION=assert; TARGET="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "journey: unknown arg $1" >&2; exit 2 ;;
  esac
done

[[ -n "$SPEC" ]] || { echo "journey: --spec required" >&2; exit 2; }
[[ "$SPEC" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || { echo "journey: --spec 非法（仅允许字母数字下划线连字符，拒绝路径穿越）" >&2; exit 2; }
[[ -n "$ACTION" ]] || { echo "journey: need --status|--set|--transition|--approve|--confirm|--assert|--list-phases" >&2; exit 2; }

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

ROOT="${ROOT_ARG:-$(find_root "$CWD")}"
DIR="$ROOT/.sdd/journey"
FILE="$DIR/${SPEC}.env"
APPROVAL="$ROOT/.sdd/acceptance/${SPEC}.approved"
CONFIRMED="$ROOT/.sdd/acceptance/${SPEC}.confirmed"
mkdir -p "$DIR"

PHASES=(idle acceptance-passed blocked stuck)

is_phase() { local p="$1" x; for x in "${PHASES[@]}"; do [[ "$x" == "$p" ]] && return 0; done; return 1; }

can_transition() {
  local from="$1" to="$2"
  case "${from}__${to}" in
    idle__acceptance-passed|idle__blocked|idle__stuck) return 0 ;;
    acceptance-passed__blocked|acceptance-passed__stuck) return 0 ;;
    *) return 1 ;;
  esac
}

sha256_of() {
  local f="$1"
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$f" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$f" | awk '{print $1}'
  else echo "journey: no sha256sum/shasum available" >&2; exit 2; fi
}

# ---- gate integrity（校验面 = MANIFEST 全条目，不只是子集）--------------------------
GATES_DIR="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$GATES_DIR/MANIFEST.sha256"
if [[ -f "$MANIFEST" ]]; then
  nlocked="$(grep -vcE '^#|^$' "$MANIFEST" || true)"
  if [[ "${nlocked:-0}" -lt 1 ]]; then
    echo "journey: MANIFEST.sha256 为空（完整性基线缺失）——重跑 gate-lock.sh" >&2
    exit 1
  fi
  while read -r want f; do
    [[ -z "$want" || "$f" == \#* ]] && continue
    [[ -f "$GATES_DIR/$f" ]] || { echo "journey: locked file $f missing" >&2; exit 1; }
    got="$(sha256_of "$GATES_DIR/$f")"
    if [[ "$got" != "$want" ]]; then
      echo "journey: gate script $f modified since lock — state machine integrity compromised (rerun gate-lock.sh)" >&2
      exit 1
    fi
  done < "$MANIFEST"
else
  echo "journey: MANIFEST.sha256 缺失（完整性基线不存在）——先跑 gate-lock.sh" >&2
  exit 1
fi

load() {
  PHASE=idle; UPDATED_AT=""; LAST_REASON=""
  if [[ -f "$FILE" ]]; then
    p="$(grep -E '^PHASE=' "$FILE" 2>/dev/null | tail -1 | sed 's/^PHASE=//' | tr -d '\r')" || p=""
    [[ -n "$p" ]] && PHASE="$p"
    UPDATED_AT="$(grep -E '^UPDATED_AT=' "$FILE" 2>/dev/null | tail -1 | sed 's/^UPDATED_AT=//' | tr -d '\r')" || UPDATED_AT=""
    LAST_REASON="$(grep -E '^LAST_REASON=' "$FILE" 2>/dev/null | tail -1 | sed 's/^LAST_REASON=//' | tr -d '\r')" || LAST_REASON=""
  fi
  PHASE="${PHASE:-idle}"
}

save() {
  {
    echo "PHASE=$PHASE"
    echo "SPEC_ID=$SPEC"
    [[ -n "${LAST_REASON:-}" ]] && echo "LAST_REASON=$LAST_REASON"
    echo "UPDATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$FILE"
}

need_reason() {
  [[ -n "$REASON" ]] || { echo "journey: --reason required for -> $1" >&2; exit 2; }
}

gate_enter_acceptance_passed() {
  local py="$GATES_DIR/check_spec.py"
  if [[ ! -f "$py" ]]; then
    echo "journey: cannot gate -> acceptance-passed: check_spec.py missing" >&2; exit 1
  fi
  if ! python3 "$py" "$ROOT" "$SPEC" --phase close >/dev/null 2>&1; then
    echo "journey: -> acceptance-passed refused: check_spec.py --phase close failed (回填: handoff 含 wish id + 决策/债落库)" >&2
    exit 1
  fi
  # v2 前置链②：机械验收证据（覆盖/截图/回放）——verify.sh；
  #   acceptance 目录不存在且无 no-ui 豁免 → 拒绝（机械验收缺失）
  local vsh="$GATES_DIR/verify.sh"
  if [[ -f "$vsh" ]]; then
    if [[ -d "$ROOT/.sdd/acceptance/$SPEC" || -f "$ROOT/.sdd/acceptance/$SPEC.no-ui" ]]; then
      if ! bash "$vsh" --cwd "$ROOT" --spec "$SPEC" >/dev/null 2>&1; then
        echo "journey: -> acceptance-passed refused: verify.sh FAIL（快照/覆盖/多视口截图证据不完整）" >&2
        exit 1
      fi
    else
      echo "journey: -> acceptance-passed refused: 无机械验收证据（.sdd/acceptance/$SPEC/ 或 .no-ui 豁免均缺失——先完成阶段 4）" >&2
      exit 1
    fi
  fi
  # v2 前置链③：组件白名单合规（设计类 wish）——check_whitelist.py
  local wl="$GATES_DIR/check_whitelist.py"
  if [[ -f "$wl" && -f "$ROOT/docs/wish/$SPEC/design-spec.md" ]]; then
    if ! python3 "$wl" "$ROOT" "$SPEC" >/dev/null 2>&1; then
      echo "journey: -> acceptance-passed refused: check_whitelist FAIL（实现用了白名单外组件；禁发明，须用户拍板补白名单）" >&2
      exit 1
    fi
  fi
  # v2 前置链④：per-slice lint（若 workspace 有 lint 脚本）
  if [[ -f "$ROOT/package.json" ]] && grep -q '"lint"' "$ROOT/package.json"; then
    if ! (cd "$ROOT" && npm run lint --silent) >/dev/null 2>&1; then
      echo "journey: -> acceptance-passed refused: lint FAIL" >&2
      exit 1
    fi
  fi
}

load

case "$ACTION" in
  list) printf '%s\n' "${PHASES[@]}"; exit 0 ;;
  status)
    echo "journey: spec=$SPEC phase=$PHASE file=$FILE updated_at=${UPDATED_AT:-}${LAST_REASON:+ last_reason=$LAST_REASON}"
    exit 0 ;;
  set)
    is_phase "$TARGET" || { echo "journey: invalid phase $TARGET" >&2; exit 2; }
    PHASE="$TARGET"; save; echo "journey: set $PHASE ($FILE) — human recovery"; exit 0 ;;
  confirm)
    case "$PHASE" in
      idle|acceptance-passed) ;;
      *) echo "journey: --confirm only from idle/acceptance-passed (phase=$PHASE)" >&2; exit 1 ;;
    esac
    [[ -n "$APPROVER" ]] || { echo "journey: --confirm needs --by <who>" >&2; exit 2; }
    mkdir -p "$(dirname "$CONFIRMED")"
    printf 'by=%s\nts=%s\nphase=%s\nchannel=%s\n' "$APPROVER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PHASE" "$CHANNEL" > "$CONFIRMED"
    # 原话指纹（v3 对抗修复）：确认时锁定 quote.md sha256，check_spec 凭此发现内容篡改
    QMD="$ROOT/docs/wish/$SPEC/quote.md"
    if [[ -f "$QMD" ]]; then
      printf 'sha256=%s\nts=%s\nby=%s\n' "$(sha256_of "$QMD")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$APPROVER" > "$ROOT/.sdd/acceptance/$SPEC.quote-hash"
      echo "journey: quote fingerprint locked ($ROOT/.sdd/acceptance/$SPEC.quote-hash)"
    fi
    if [[ "$NO_UI_FLAG" == "1" ]]; then
      printf 'by=%s\nts=%s\nreason=non-UI wish\n' "$APPROVER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$ROOT/.sdd/acceptance/$SPEC.no-ui"
      echo "journey: non-UI exemption recorded ($ROOT/.sdd/acceptance/$SPEC.no-ui)"
    fi
    echo "journey: understanding confirmed by $APPROVER (channel=$CHANNEL) -> $CONFIRMED"
    exit 0 ;;
  approve)
    case "$PHASE" in
      idle|acceptance-passed) ;;
      *) echo "journey: --approve only from idle/acceptance-passed (phase=$PHASE)" >&2; exit 1 ;;
    esac
    [[ -n "$APPROVER" ]] || { echo "journey: --approve needs --by <who>" >&2; exit 2; }
    mkdir -p "$(dirname "$APPROVAL")"
    printf 'by=%s\nts=%s\nphase=%s\nchannel=%s\n' "$APPROVER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PHASE" "$CHANNEL" > "$APPROVAL"
    echo "journey: human approval recorded by $APPROVER (channel=$CHANNEL) -> $APPROVAL"
    exit 0 ;;
  transition)
    is_phase "$TARGET" || { echo "journey: invalid phase $TARGET" >&2; exit 2; }
    FROM="$PHASE"
    if ! can_transition "$FROM" "$TARGET"; then
      echo "journey: illegal transition $FROM -> $TARGET (--set is the human recovery hatch)" >&2
      exit 1
    fi
    case "$TARGET" in
      acceptance-passed)
        [[ -f "$APPROVAL" ]] || { echo "journey: -> acceptance-passed refused: no human approval (journey.sh --approve --by <who>)" >&2; exit 1; }
        gate_enter_acceptance_passed ;;
      blocked|stuck)
        need_reason "$TARGET"
        ;;
    esac
    LAST_REASON="${REASON:-}"
    PHASE="$TARGET"; save
    printf 'journey: %s -> %s' "$FROM" "$TARGET"
    [[ -n "${REASON:-}" ]] && printf ' (%s)' "$REASON"
    printf '\n'
    exit 0 ;;
  assert)
    case "$TARGET" in
      write|build)
        if [[ "$PHASE" == "idle" ]]; then
          echo "journey: assert $TARGET ok (phase=$PHASE)"; exit 0
        fi
        echo "journey: assert $TARGET FAIL (phase=$PHASE; need idle)" >&2; exit 1 ;;
      deploy)
        echo "journey: assert deploy FAIL (deploy requires explicit human authorization this turn)" >&2; exit 1 ;;
      lint|typecheck)
        d="${ASSERT_DIR:-$ROOT}"
        if [[ -f "$d/package.json" ]] && grep -q "\"$TARGET\"" "$d/package.json"; then
          if (cd "$d" && npm run "$TARGET" --silent) >/dev/null 2>&1; then
            echo "journey: assert $TARGET ok ($d)"; exit 0
          else
            echo "journey: assert $TARGET FAIL ($d) — 修好再交付，不要 push 后指望别处不同" >&2; exit 1
          fi
        else
          echo "journey: assert $TARGET ok (no $TARGET script in $d/package.json)"
          exit 0
        fi ;;
      claim-deliver)
        if [[ "$PHASE" == "acceptance-passed" ]]; then
          echo "journey: assert claim-deliver ok"; exit 0
        fi
        echo "journey: assert claim-deliver FAIL (phase=$PHASE)" >&2; exit 1 ;;
      *) echo "journey: unknown assert $TARGET" >&2; exit 2 ;;
    esac ;;
esac
