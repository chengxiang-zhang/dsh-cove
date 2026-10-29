#!/usr/bin/env bash
# wish.sh — manage wishes: add to the demand pool, then start one into docs/wish/<id>/.
#
# Usage:
#   wish.sh --cwd <workspace> --new --title "<标题>" [--quote "<用户原话>"]
#                                       # append to demand pool + create quote.md (原话最高优先级工件)
#   wish.sh --cwd <workspace> --start <id>             # create docs/wish/<id>/{contract.md,plan.md}
#
# `--start` also flips the pool row's status new -> active (best effort).
set -euo pipefail

CWD="."; ACTION=""; WISH=""; TITLE=""; QUOTE=""; ROOT_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cwd) CWD="${2:-}"; shift 2 ;;
    --root) ROOT_ARG="${2:-}"; shift 2 ;;
    --new) ACTION=new; shift ;;
    --start) ACTION=start; WISH="${2:-}"; shift 2 ;;
    --title) TITLE="${2:-}"; shift 2 ;;
    --quote) QUOTE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "wish: unknown arg $1" >&2; exit 2 ;;
  esac
done

[[ -n "$ACTION" ]] || { echo "wish: need --new or --start" >&2; exit 2; }

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
POOL="$ROOT/docs/product/demand-pool.md"
DOC="$ROOT/docs/wish"

emit() {  # emit <path> <<EOF ... EOF
  local f="$1"
  if [[ -f "$f" ]]; then echo "wish: keep $f (exists)"; return; fi
  cat > "$f"
  echo "wish: wrote $f"
}

if [[ "$ACTION" == "new" ]]; then
  [[ -n "$TITLE" ]] || { echo "wish: --new needs --title" >&2; exit 2; }
  if [[ "$TITLE" == *$'\n'* || "$TITLE" == *$'\r'* || "$TITLE" == *'|'* ]]; then
    echo "wish: --title 含换行或管道符（需求池注入防护；标题须为单行文本）" >&2; exit 2
  fi
  if [[ -n "$QUOTE" && ( "$QUOTE" == *$'\n'* || "$QUOTE" == *$'\r'* ) ]]; then
    QUOTE="$(printf '%s' "$QUOTE" | tr '\r\n' '  ')"
    echo "wish: --quote 换行已压平为空格（原话应逐字转录，换行请直接编辑 quote.md）" >&2
  fi
  [[ -f "$POOL" ]] || { echo "wish: no demand pool at $POOL — run project.sh first" >&2; exit 1; }
  last=$(grep -oE '^\| *W[0-9]+' "$POOL" | tail -1 | grep -oE '[0-9]+' || echo 0)
  next=$(( ${last:-0} + 1 ))
  printf '| W%d | %s | new | |\n' "$next" "$TITLE" >> "$POOL"
  mkdir -p "$DOC/W$next"
  if [[ -n "$QUOTE" ]]; then
    printf '# 用户原话（最高优先级 · 逐字转录 · 不可改写）\n\n> quote 版本：v1\n\n%s\n\n> 记录：%s（原话正文一字不改；本节与任何下游转述冲突时以本节为准；quote 更新到 vN+1 时下游一并重新对齐）\n' \
      "$QUOTE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DOC/W$next/quote.md"
    echo "wish: wrote $DOC/W$next/quote.md (原话已落盘, quote v1)"
  else
    emit "$DOC/W$next/quote.md" <<'EOF'
# 用户原话（最高优先级 · 逐字转录 · 不可改写）

> quote 版本：v1

<待补录：用户原话逐字原文（最高优先级工件，必须补录；check_spec 会拦截占位）>

> 记录：（原话正文一字不改；本节与任何下游转述冲突时以本节为准；quote 更新到 vN+1 时下游一并重新对齐）
EOF
    echo "wish: quote.md 为占位 — 请逐字补录用户原话（最高优先级）"
  fi
  echo "wish: added W$next to $POOL"
  echo "  next: wish.sh --cwd . --start W$next"
  exit 0
fi

# start
[[ -n "$WISH" ]] || { echo "wish: --start needs <id>" >&2; exit 2; }
[[ "$WISH" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || { echo "wish: --start 非法 id（仅允许字母数字下划线连字符，拒绝路径穿越）" >&2; exit 2; }
mkdir -p "$DOC/$WISH"

emit "$DOC/$WISH/contract.md" <<EOF
# $WISH

## 用户与主结果
- 用户：
- 主结果（可观察）：

## MVP 边界
- In：
- Out：

## 权威数据源
- （真实数据 / API / 账号；示例数据必须标注 example）

## 事实映射（仅 Verified 进 P0 / 实施阻断）
| 入口 | actor | 实体/表关系 | 可信路径 | 代码调用点 | 越权反例 | 证据级 |
|---|---|---|---|---|---|---|
| | | | | | | Verified/Unverified |
EOF

emit "$DOC/$WISH/plan.md" <<EOF
# $WISH

## 纵向切片（一切片 = 一入口 + 成功/失败路径 + Oracle）
| 切片 ID | 入口 | 完成定义（链 T-xxx） | 触及路径 | 依赖 | Oracle 强度 |
|---|---|---|---|---|---|
| S1 | | | | | unit/machine/browser |

## Workspace
- 模式：local | git-worktree
- 分支：sdd/<id>

## 单向门
- 不可逆操作 / 批准人：
EOF

emit "$DOC/$WISH/review.md" <<EOF
# $WISH — 代码评审

> 由**非实现者**的独立 subagent 在 merge / Verify 前填写。

## 结论
- 结论：（待填：pass 或 fail）
- 评审人：
- 日期：

## 问题清单
- （无则写「无」）
EOF

if [[ -f "$POOL" ]]; then
  sed -i -E "s/^(\| *$WISH *\| [^|]*\|) new( *\|)/\1 active\2/" "$POOL" 2>/dev/null || true
fi
# NOTE: phase stays idle — design-ready must be reached through the GATED transition
# (journey.sh --transition design-ready: requires .confirmed artifact + check_spec --phase design).
# Never --set here: it is the human recovery hatch and would bypass every gate.
echo "wish: started $WISH -> $DOC/$WISH (phase idle; design-ready via gated journey transition)"
