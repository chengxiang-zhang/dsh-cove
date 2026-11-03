#!/bin/sh
# design-dispatch 前置自检：外部强 agent 通道是否可用。
#
# 退出码：
#   0 三条通道（codex 订阅 / codex kaon 兜底 / claude opus55）全部 end_turn
#   1 有通道不可用（缺 adapter、adapter 起不来、模型无路由、认证失效）
#   2 机器前置条件缺失（~/tools/acp-agents 未安装）
#
# 用法：
#   sh preflight.sh            # 全部检查
#   sh preflight.sh codex      # 只查订阅通道
#   sh preflight.sh kaon       # 只查 kaon 兜底
#   sh preflight.sh claude     # 只查 claude 通道
#
# 注意：本脚本只做**通道可用性**验证，不验证产质量。每次会话首次派发前跑一次即可；
# 它会产生一次极小的真实调用（约 6k tokens），不要放进循环。
set -u

ROOT="${ACP_AGENTS_ROOT:-$HOME/tools/acp-agents}"
PROBE="$ROOT/acp-probe.mjs"
ONLY="${1:-all}"
TIMEOUT="${ACP_PREFLIGHT_TIMEOUT:-120000}"
FAIL=0

if [ ! -d "$ROOT" ] || [ ! -f "$PROBE" ]; then
  echo "PREFLIGHT_FAIL missing adepter root: $ROOT" >&2
  echo "  install: see presets/code-vibe/skills/design-dispatch/SKILL.md §2" >&2
  exit 2
fi

run() {
  label="$1"
  bin="$2"
  if [ ! -x "$bin" ]; then
    echo "PREFLIGHT_FAIL $label: not executable: $bin"
    FAIL=1
    return
  fi
  out=$(node "$PROBE" "$bin" /tmp "Reply exactly: PING" "$TIMEOUT" 2>&1)
  if printf '%s' "$out" | grep -q 'stopReason=end_turn'; then
    ms=$(printf '%s' "$out" | sed -n 's/.*elapsedMs=\([0-9]*\).*/\1/p' | tail -1)
    echo "PREFLIGHT_OK   $label ${ms}ms"
  else
    echo "PREFLIGHT_FAIL $label"
    printf '%s\n' "$out" | tail -5 | sed 's/^/  /'
    FAIL=1
  fi
}

case "$ONLY" in
  all|codex)  run "codex-subscription" "$ROOT/node_modules/.bin/codex-acp" ;;
esac
case "$ONLY" in
  all|kaon)   run "codex-kaon"       "$ROOT/codex-acp-kaon.sh" ;;
esac
case "$ONLY" in
  all|claude) run "claude-opus55"    "$ROOT/node_modules/.bin/claude-agent-acp" ;;
esac

[ "$FAIL" -eq 0 ] && echo "PREFLIGHT_ALL_OK" || echo "PREFLIGHT_HAS_FAILURES"
exit "$FAIL"