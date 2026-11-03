#!/bin/sh
# codex-acp-kaon.sh — Codex 的 kaon-router 兜底通道。
#
# 策略（2026-11-03 由用户定）：
#   默认走 ChatGPT 订阅（codex 原生 OAuth，无需任何配置）；
#   订阅不可用（429 / 配额耗尽 / 模型无路由 / 认证失效）时，才用本脚本走 kaon-router。
#
# 为什么需要这个壳，而不是直接改 ~/.codex/config.toml：
#   · 订阅是默认路径，把 kaon 写进全局 config 会翻转默认值；
#   · kaon 的 key 不落在 DSH profile patch 里（那里是明文），运行时从已有的
#     ~/.claude/settings.json 读，单一真相；
#   · CODEX_CONFIG 是 codex-acp 官方入口，合并进它启动的 app-server 配置。
#
# 实测（2026-11-03）：kaon/gpt-5.5 走 /v1/responses 可行；
#   kaon/gpt-6-astra 在 kaon 上「no available route」，不可用；
#   codex 侧对未编入 catalog 的模型会打一条 metadata 警告，不影响出答案。
set -e

KEY="${KAON_ROUTER_API_KEY:-}"
if [ -z "$KEY" ] && [ -f "$HOME/.claude/settings.json" ]; then
  KEY=$(node -e '
    const fs = require("node:fs");
    const p = process.env.HOME + "/.claude/settings.json";
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    process.stdout.write((s.env && s.env.ANTHROPIC_AUTH_TOKEN) || "");
  ')
fi
if [ -z "$KEY" ] && [ -f "$HOME/.config/kaon/token" ]; then
  KEY=$(tr -d '\n' < "$HOME/.config/kaon/token")
fi
if [ -z "$KEY" ]; then
  echo "codex-acp-kaon: no kaon key. Set KAON_ROUTER_API_KEY, or ~/.claude/settings.json env.ANTHROPIC_AUTH_TOKEN, or ~/.config/kaon/token" >&2
  exit 1
fi

KAON_MODEL="${KAON_CODEX_MODEL:-kaon/gpt-5.5}"
export KAON_ROUTER_API_KEY="$KEY"
export CODEX_CONFIG="{
  \"model\": \"$KAON_MODEL\",
  \"model_provider\": \"kaon\",
  \"model_providers\": {
    \"kaon\": {
      \"name\": \"Kaon Router\",
      \"base_url\": \"https://kaon-router.kaonai.com/v1\",
      \"wire_api\": \"responses\",
      \"env_key\": \"KAON_ROUTER_API_KEY\",
      \"requires_openai_auth\": false
    }
  }
}"

HERE=$(cd "$(dirname "$0")" && pwd)
exec "$HERE/node_modules/.bin/codex-acp" "$@"