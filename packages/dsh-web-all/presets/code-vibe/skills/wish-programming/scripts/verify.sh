#!/usr/bin/env bash
# Wish 机械验收门 — 只核对「产生真实质量后果」的证据，不搞文档仪式。
#
# Usage:
#   verify.sh --cwd <workspace> --spec <id> [--root <dir>]
#
# Checks:
#   1. .sdd/acceptance/<id>/coverage.tsv 存在 且 coverage_check.py 通过（存量功能落点完整）
#   2. .sdd/acceptance/<id>/shots/ 下存在三个视口的真实渲染截图（1280 / 1440 / narrow 各 ≥1 张，
#      文件名含对应视口标记；多视口 = 用户可见验收）。非 UI 愿望：存在
#      .sdd/acceptance/<id>.no-ui 豁免文件（用户在确认阶段显式声明）→ 跳过截图要求，其余照查。
#   3. live 重跑（保留）：旧格式测试证据 TSV 若存在，unit/integration/health 命令自己重跑
#
# Gate integrity: scripts/MANIFEST.sha256 中锁定的全部脚本（gate-lock.sh FILES 列表）必须
# 与当前哈希一致，任一不匹配即拒绝（证据不可信）。改动后重跑 gate-lock.sh。
set -euo pipefail

CWD="."
SPEC=""
ROOT_ARG=""
RERUN_SCRIPT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cwd) CWD="${2:-}"; shift 2 ;;
    --spec) SPEC="${2:-}"; shift 2 ;;
    --root) ROOT_ARG="${2:-}"; shift 2 ;;
    --rerun) RERUN_SCRIPT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "verify: unknown arg $1" >&2; exit 2 ;;
  esac
done

[[ -n "$SPEC" ]] || { echo "verify: --spec required" >&2; exit 2; }
[[ "$SPEC" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || { echo "verify: --spec 非法（仅允许字母数字下划线连字符，拒绝路径穿越）" >&2; exit 2; }

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

ROOT="${ROOT_ARG:-$(find_root "$CWD")}"

# ---- gate integrity（校验面 = MANIFEST 全条目，不只是子集）--------------------------
GATES_DIR="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$GATES_DIR/MANIFEST.sha256"
if [[ -f "$MANIFEST" ]]; then
  nlocked="$(grep -vcE '^#|^$' "$MANIFEST" || true)"
  if [[ "${nlocked:-0}" -lt 1 ]]; then
    echo "verify FAIL: MANIFEST.sha256 为空（完整性基线缺失）——重跑 gate-lock.sh 再验收" >&2
    exit 1
  fi
  while read -r want f; do
    [[ -z "$want" || "$f" == \#* ]] && continue
    [[ -f "$GATES_DIR/$f" ]] || { echo "verify FAIL: locked file $f missing" >&2; exit 1; }
    got="$(sha256_of "$GATES_DIR/$f")"
    if [[ "$got" != "$want" ]]; then
      echo "verify FAIL: gate script $f modified since lock — evidence untrustworthy (rerun gate-lock.sh after legitimate edits)" >&2
      exit 1
    fi
  done < "$MANIFEST"
else
  echo "verify FAIL: MANIFEST.sha256 缺失（完整性基线不存在）——先跑 gate-lock.sh" >&2
  exit 1
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

# ---- 多视口真实渲染截图（1280 / 1440 / narrow 三视口；no-ui 豁免）-----------------
NO_UI="$ROOT/.sdd/acceptance/$SPEC.no-ui"
if [[ -f "$NO_UI" ]]; then
  echo "verify: non-UI wish exempts screenshots (no-ui marker present)"
else
  SHOTS="$ROOT/.sdd/acceptance/$SPEC/shots"
  [[ -d "$SHOTS" ]] || { echo "verify FAIL: no screenshots dir at $SHOTS (阶段 4 多视口截图；非 UI 愿望需 .no-ui 豁免文件)" >&2; exit 1; }
  # 视口断言：每个前缀至少一张 PNG，且 PNG 实际像素宽度落在该视口的物理范围
  # （1280-* ≥1200px / 1440-* ≥1366px / narrow-* ≤1000px，容差覆盖 retina 2x）；
  # 同图三命名（复制一张 1280 图冒充三视口）必然在某前缀的宽度断言上失败。
  png_width() {
    python3 -c '
import struct, sys
try:
    d = open(sys.argv[1], "rb").read(26)
    if d[:8] != b"\x89PNG\r\n\x1a\n":
        print(-1); sys.exit(0)
    print(struct.unpack(">I", d[16:20])[0])
except FileNotFoundError:
    print(-2)
' "$1"
  }
  missing=""
  for v in 1280 1440 narrow; do
    hits="$(find "$SHOTS" -maxdepth 1 -type f -iname "${v}-*.png" 2>/dev/null)"
    if [[ -z "$hits" ]]; then
      missing="$missing $v"; continue
    fi
    w="$(png_width "$(echo "$hits" | head -1)")"
    case "$v" in
      1280) ok_rule(){ [[ "$1" -ge 1200 ]]; } ;;
      1440) ok_rule(){ [[ "$1" -ge 1366 ]]; } ;;
      narrow) ok_rule(){ [[ "$1" -le 1000 ]]; } ;;
    esac
    if [[ "$w" == "-1" ]]; then
      echo "verify FAIL: $v 视口截图不是有效 PNG（可用浏览器真实渲染导出 PNG；文件：$(echo "$hits" | head -1)）" >&2; exit 1
    fi
    if ! ok_rule "$w"; then
      echo "verify FAIL: ${v}-* 截图宽度 $w px 不在 ${v} 视口物理范围（1280-*≥1200 / 1440-*≥1366 / narrow-*≤1000）——疑似复制图冒充多视口" >&2; exit 1
    fi
  done
  if [[ -n "$missing" ]]; then
    echo "verify FAIL: shots/ 缺少视口截图，文件名须以前缀标记视口：$missing（1280-* / 1440-* / narrow-* 各 ≥1 张 PNG，如 1280-home.png、1440-home.png、narrow-home.png；非 UI 愿望用 .no-ui 豁免）" >&2
    exit 1
  fi
fi

# ---- old-format evidence tsv：不再自动执行 cmd 列（v3 对抗修复）---------------
# 旧格式 .sdd/acceptance/<id>.tsv 的 cmd 列曾是 `bash -c` 任意执行面（红队 S4e：证据→代码执行）。
# 现默认不执行：仅统计存在并提示；需要 live 重跑请显式 `--rerun <script>`（白名单脚本名）。
OLD_EVID="$ROOT/.sdd/acceptance/$SPEC.tsv"
live="no"
if [[ -f "$OLD_EVID" ]]; then
  live="yes"
  echo "verify: 旧格式证据 tsv 发现于 $OLD_EVID（v3 起 cmd 列不再自动执行；live 重跑需显式 --rerun <script>）"
  if [[ -n "${RERUN_SCRIPT:-}" ]]; then
    if [[ ! -f "$ROOT/$RERUN_SCRIPT" ]]; then
      echo "verify FAIL: --rerun 脚本不存在: $ROOT/$RERUN_SCRIPT" >&2; exit 1
    fi
    log="$ROOT/.sdd/acceptance/$SPEC/rerun/$RERUN_SCRIPT.log"
    mkdir -p "$(dirname "$log")"
    set +e
    ( cd "$ROOT" && timeout "${RERUN_TIMEOUT:-180}" bash "$RERUN_SCRIPT" ) >"$log" 2>&1
    rc=$?
    set -e
    if [[ $rc -ne 0 ]]; then
      echo "verify FAIL: --rerun $RERUN_SCRIPT exited $rc (log $log)" >&2; exit 1
    fi
    echo "verify: --rerun $RERUN_SCRIPT ok (exit 0, log $log)"
  fi
fi

echo "verify OK: coverage=pass shots=$(if [[ -f "$NO_UI" ]]; then echo exempt; else find "$SHOTS" -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' -o -iname '*.gif' \) | wc -l | tr -d ' '; fi) live_rerun=$live"
exit 0
