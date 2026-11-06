#!/bin/sh
# design-dispatch 前置自检：两个外部 CLI 与实体注册行是否在位。
#
# 这两个工具由实体 Loader 行注册（profile 的 web-all -> config.externalSession），
# 没有装机步骤。所以这里只查三件事：CLI 在不在、profile 有没有这段配置、域挂载没有。
# 它不产生模型调用，不花 token，可以每次会话首次派发前跑。
#
# 退出码：
#   0 所查的侧都可用
#   1 有一侧不可用（CLI 缺失或不可执行），或域没挂载
#   2 机器前置缺失（所查的侧一个 CLI 都没有，或 profile 没有 externalSession 配置）
#
# 用法：
#   sh preflight.sh            # 全部检查
#   sh preflight.sh codex      # 只查 codex 侧
#   sh preflight.sh claude     # 只查 claude 侧
#
# 环境变量：DSH_PROFILE_DIR（默认 ~/.dsh/profiles/web）、DSH_WEB_BASE（默认 http://127.0.0.1:3080）
set -u

PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
PATCH="$PROFILE_DIR/cordis.patch.yml"
HOST="${DSH_WEB_BASE:-http://127.0.0.1:3080}"
ONLY="${1:-all}"
FAIL=0
FOUND=0

# 托管启动器的 PATH 不含 ~/.local/bin，所以 claudeBin/codexBin 可能是绝对路径：
# 先读 profile 里的配置，再退回 PATH。
configured_bin() {
  key="$1"
  [ -f "$PATCH" ] || return 0
  awk -v k="$key" '
    $0 ~ "^ *" k ":" {
      sub("^ *" k ": *", "")
      gsub(/["\047]/, "")
      print
      exit
    }' "$PATCH"
}

resolve_bin() {
  key="$1"
  name="$2"
  configured=$(configured_bin "$key")
  if [ -n "${configured:-}" ] && [ -x "$configured" ]; then
    printf '%s\n' "$configured"
    return 0
  fi
  command -v "$name" 2>/dev/null
}

check_side() {
  label="$1"
  bin="$2"
  key="$3"
  if [ -z "${bin:-}" ]; then
    echo "PREFLIGHT_FAIL $label: CLI not found (set ${key} in $PATCH, or put it on PATH)"
    FAIL=1
    return
  fi
  FOUND=$((FOUND + 1))
  version=$("$bin" --version 2>&1 | head -1)
  echo "PREFLIGHT_OK   $label $bin ${version:-(no --version)}"
}

case "$ONLY" in
  all|codex)  check_side codex  "$(resolve_bin codexBin codex)"   codexBin ;;
esac
case "$ONLY" in
  all|claude) check_side claude "$(resolve_bin claudeBin claude)" claudeBin ;;
esac

if [ "$FOUND" -eq 0 ]; then
  echo "PREFLIGHT_NO_CLI"
  exit 2
fi

# 注册行是这两个工具存在的前提：没有它，工具表里不会有 subagent_claude_code / subagent_codex。
if ! grep -q 'externalSession:' "$PATCH" 2>/dev/null; then
  echo "PREFLIGHT_FAIL entity row: $PATCH has no externalSession config"
  echo "  the two delegation tools are registered by that config; without it they do not exist"
  exit 2
fi

# 域的挂载状态：200 已挂载 / 403 已挂载但调用方不在围栏内 / 404 没挂载。
code=$(curl -s -o /dev/null -w '%{http_code}' "$HOST/api/external-session/list" 2>/dev/null || echo 000)
case "$code" in
  200|403) echo "PREFLIGHT_OK   mount $HOST/api/external-session/list -> $code" ;;
  404)     echo "PREFLIGHT_FAIL mount: 404 (the domain is not mounted; the host log names the mutex refusal)"; FAIL=1 ;;
  *)       echo "PREFLIGHT_FAIL mount: $code (host unreachable? expected 200, 403 or 404)"; FAIL=1 ;;
esac

[ "$FAIL" -eq 0 ] && echo "PREFLIGHT_ALL_OK" || echo "PREFLIGHT_HAS_FAILURES"
exit "$FAIL"