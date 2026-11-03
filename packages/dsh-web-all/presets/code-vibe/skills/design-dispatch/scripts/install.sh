#!/bin/sh
# design-dispatch 安装器：把「外部强 agent 派发」的机器前置一次装好。
#
# 它做四件事（全部幂等）：
#   1. 在 $ROOT（默认 ~/tools/acp-agents）安装两个 ACP adapter：codex-acp / claude-agent-acp
#   2. 把本 skill 自带的 acp-probe.mjs 复制到 $ROOT
#   3. 往 DSH profile 的 cordis.patch.yml 追加三个 provider + 三个工具行（有标记块，可卸载）
#   4. 跑 preflight 验证三条通道
#
# 用法：
#   sh install.sh                     # 装/更新 + 验证
#   sh install.sh --check             # 只检查，不改任何东西（退出码 0=齐备）
#   sh install.sh --uninstall         # 移除 patch 块（不动 adapter 与 $ROOT）
#   sh install.sh --profile-dir DIR   # 指定 profile 目录（默认 ~/.dsh/profiles/web）
#   sh install.sh --skip-npm          # 跳过 npm 安装，只补文件与 patch
#   sh install.sh --no-verify         # 装完不跑 preflight
#
# 模型可覆盖（写进 patch）：
#   --astra-model <id>  默认 gpt-6-astra        （ChatGPT 订阅通道）
#   --kaon-model <id>   默认 kaon/gpt-5.5       （kaon 兜底通道）
#   --opus-model <id>   默认 kaon-rp/claude-opus-5-5
#
# 退出码：0 成功/已齐备；1 安装或验证失败；2 前置条件不满足（node 太旧、profile 不存在）
set -eu

ROOT="${ACP_AGENTS_ROOT:-$HOME/tools/acp-agents}"
PROFILE_DIR="$HOME/.dsh/profiles/web"
PATCH_FILE=""
ASTRA_MODEL="gpt-6-astra"
KAON_MODEL="kaon/gpt-5.5"
OPUS_MODEL="kaon-rp/claude-opus-5-5"
CODEX_ACP_VERSION="2.5.0"
CLAUDE_ACP_VERSION="0.100.0"
MODE="install"
DO_NPM=1
DO_VERIFY=1

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
BEGIN_MARK="# BEGIN design-dispatch (managed by presets/code-vibe/skills/design-dispatch/scripts/install.sh)"
END_MARK="# END design-dispatch"

while [ $# -gt 0 ]; do
  case "$1" in
    --check)         MODE="check"; DO_VERIFY=0 ;;
    --uninstall)     MODE="uninstall"; DO_VERIFY=0 ;;
    --skip-npm)      DO_NPM=0 ;;
    --no-verify)     DO_VERIFY=0 ;;
    --profile-dir)   PROFILE_DIR="$2"; shift ;;
    --root)          ROOT="$2"; shift ;;
    --astra-model)   ASTRA_MODEL="$2"; shift ;;
    --kaon-model)    KAON_MODEL="$2"; shift ;;
    --opus-model)    OPUS_MODEL="$2"; shift ;;
    -h|--help)       sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -n "$PATCH_FILE" ] || PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

say()  { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
die()  { printf '%s\n' "INSTALL_FAIL $*" >&2; exit 1; }

# ── 0. 前置 ────────────────────────────────────────────────────────────────
need_node() {
  command -v node >/dev/null 2>&1 || { warn "INSTALL_FAIL node not found"; exit 2; }
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 20 ] || { warn "INSTALL_FAIL node >= 20 required, found $(node -v)"; exit 2; }
}

check_state() {
  rc=0
  [ -d "$ROOT/node_modules/@agentclientprotocol/codex-acp" ] || { warn "MISSING adapter codex-acp ($ROOT)"; rc=1; }
  [ -d "$ROOT/node_modules/@agentclientprotocol/claude-agent-acp" ] || { warn "MISSING adapter claude-agent-acp ($ROOT)"; rc=1; }
  [ -f "$ROOT/acp-probe.mjs" ] || { warn "MISSING $ROOT/acp-probe.mjs"; rc=1; }
  if [ -f "$PATCH_FILE" ]; then
    for id in subagent-acp-astra tool-subagent-astra subagent-acp-opus tool-subagent-opus; do
      grep -q "id: $id\$" "$PATCH_FILE" || { warn "MISSING profile row: $id ($PATCH_FILE)"; rc=1; }
    done
  else
    warn "MISSING profile patch: $PATCH_FILE"
    rc=1
  fi
  [ "$rc" -eq 0 ] && say "STATE_OK adapters+scripts+profile rows present ($ROOT)"
  return "$rc"
}

need_node

if [ "$MODE" = "check" ]; then
  check_state || exit 1
  exit 0
fi

# ── 1. 卸载分支 ────────────────────────────────────────────────────────────
if [ "$MODE" = "uninstall" ]; then
  [ -f "$PATCH_FILE" ] || die "no patch file: $PATCH_FILE"
  if grep -qF "$BEGIN_MARK" "$PATCH_FILE"; then
    tmp="$PATCH_FILE.design-dispatch.tmp"
    awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
      $0==b {skip=1; next}
      skip && $0==e {skip=0; next}
      !skip {print}
    ' "$PATCH_FILE" > "$tmp"
    mv "$tmp" "$PATCH_FILE"
    say "UNINSTALLED profile block from $PATCH_FILE"
  else
    say "NO_BLOCK nothing to remove (rows may be hand-managed); edit $PATCH_FILE yourself"
  fi
  say "NOTE adapters in $ROOT were left in place; remove that directory manually if you want them gone."
  exit 0
fi

# ── 2. npm 安装 ────────────────────────────────────────────────────────────
if [ "$DO_NPM" -eq 1 ]; then
  mkdir -p "$ROOT"
  cd "$ROOT"
  if [ ! -f package.json ]; then
    npm init -y >/dev/null 2>&1
  fi
  if node -e '
      const fs=require("node:fs");
      const p=JSON.parse(fs.readFileSync("package.json","utf8"));
      const d={...(p.dependencies||{})};
      process.exit(d["@agentclientprotocol/codex-acp"] && d["@agentclientprotocol/claude-agent-acp"] ? 0 : 1);
    ' 2>/dev/null &&
     [ -d node_modules/@agentclientprotocol/codex-acp ] &&
     [ -d node_modules/@agentclientprotocol/claude-agent-acp ]; then
    say "ADAPTERS_PRESENT skip npm install"
  else
    say "ADAPTERS_INSTALL @agentclientprotocol/codex-acp@$CODEX_ACP_VERSION @agentclientprotocol/claude-agent-acp@$CLAUDE_ACP_VERSION"
    npm install --no-audit --no-fund \
      "@agentclientprotocol/codex-acp@$CODEX_ACP_VERSION" \
      "@agentclientprotocol/claude-agent-acp@$CLAUDE_ACP_VERSION" >/dev/null 2>&1 \
      || die "npm install failed in $ROOT"
  fi
  cd "$SELF_DIR"
fi

# ── 3. 复制探针与兜底壳 ────────────────────────────────────────────────────
mkdir -p "$ROOT"
install -m 0755 "$SELF_DIR/acp-probe.mjs" "$ROOT/acp-probe.mjs"
say "SCRIPTS_INSTALLED $ROOT/acp-probe.mjs"

# ── 4. profile patch ───────────────────────────────────────────────────────
if [ ! -f "$PATCH_FILE" ]; then
  warn "INSTALL_FAIL profile patch not found: $PATCH_FILE"
  warn "  pass --profile-dir <dir>; available profiles:"
  ls -1 "$HOME/.dsh/profiles" 2>/dev/null | sed 's/^/    /' >&2 || true
  exit 2
fi

if grep -qF "$BEGIN_MARK" "$PATCH_FILE"; then
  say "PROFILE_BLOCK_PRESENT managed by install.sh; regenerating the block"
  tmp="$PATCH_FILE.design-dispatch.tmp"
  awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
    $0==b {skip=1; next}
    skip && $0==e {skip=0; next}
    !skip {print}
  ' "$PATCH_FILE" > "$tmp" && mv "$tmp" "$PATCH_FILE"
  APPEND_BLOCK=1
elif grep -q "id: subagent-acp-astra\$" "$PATCH_FILE"; then
  say "PROFILE_ROWS_PRESENT (hand-managed, no marker) — leaving them untouched"
else
  APPEND_BLOCK=1
fi

if [ "${APPEND_BLOCK:-0}" -eq 1 ] && ! grep -qF "$BEGIN_MARK" "$PATCH_FILE"; then
  katmp=$(mktemp)
  cat > "$katmp" <<EOF

$BEGIN_MARK
# 由 install.sh 生成：外部强 agent 派发（design-dispatch）。
# 三个通道：codex 走 ChatGPT 订阅、codex 走 kaon 兜底、claude 走 kaon。
# permission: allow = 无人值守批准权限请求；要只读改成 reject。
- insert:
    - id: subagent-acp-astra
      name: '@deepseek-ai/dsh-subagent-acp'
      config:
        providerName: acp-astra
        command: $ROOT/node_modules/.bin/codex-acp
        args: []
        permission: allow
        env:
          CODEX_CONFIG: '{"model":"$ASTRA_MODEL"}'
    - id: tool-subagent-astra
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: acp-astra
        toolName: subagent_astra
        backgroundMode: one-shot
        maxDepth: provider-managed
    - id: subagent-acp-opus
      name: '@deepseek-ai/dsh-subagent-acp'
      config:
        providerName: acp-opus
        command: $ROOT/node_modules/.bin/claude-agent-acp
        args: []
        permission: allow
        env:
          ANTHROPIC_MODEL: $OPUS_MODEL
    - id: tool-subagent-opus
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: acp-opus
        toolName: subagent_opus55
        backgroundMode: one-shot
        maxDepth: provider-managed
$END_MARK
EOF
  # 保证原文件以换行结尾，再追加
  if [ -s "$PATCH_FILE" ] && [ "$(tail -c 1 "$PATCH_FILE" | wc -l)" -eq 0 ]; then
    printf '\n' >> "$PATCH_FILE"
  fi
  cat "$katmp" >> "$PATCH_FILE"
  rm -f "$katmp"
  say "PROFILE_BLOCK_ADDED $PATCH_FILE"
  say "NOTE hot reload is observed on this machine (tools appear on the NEXT request); if they do not,"
  say "     tell the user the change needs a DSH restart per the repository AGENTS.md contract -- do not claim they are live."
fi

if command -v python3 >/dev/null 2>&1 && python3 -c 'import yaml' >/dev/null 2>&1; then
  python3 -c 'import sys,yaml; yaml.safe_load(open(sys.argv[1],encoding="utf-8")); print("YAML_OK")' "$PATCH_FILE" \
    || die "profile patch is not valid YAML after edit: $PATCH_FILE"
else
  say "YAML_UNVERIFIED (python3+yaml not available); inspect $PATCH_FILE before restarting DSH"
fi

# ── 5. 验证 ────────────────────────────────────────────────────────────────
if [ "$DO_VERIFY" -eq 1 ]; then
  say "VERIFY running preflight (three channels, ~20-60s)..."
  if sh "$SELF_DIR/preflight.sh"; then
    say "INSTALL_DONE"
  else
    warn "INSTALL_FAIL preflight reported a broken channel (see PREFLIGHT_FAIL lines above)"
    exit 1
  fi
else
  say "INSTALL_DONE (verification skipped)"
fi