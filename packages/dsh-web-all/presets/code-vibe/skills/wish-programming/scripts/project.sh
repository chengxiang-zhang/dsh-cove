#!/usr/bin/env bash
# project.sh — scaffold a project's product layer + wish root (once per NEW project).
#
# Usage:
#   project.sh --cwd <workspace> [--force]
#
# Creates (never overwrites):
#   docs/product/{PRODUCT.md, demand-pool.md, gap-register.md, gap-closed.md, decisions/}
#   docs/wish/
#
# Guard: refuses to init when an existing project is detected (AGENTS.md + docs/ both present);
# use --force to override. Existing projects attach read-only to their own docs system.
set -euo pipefail

CWD="."
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cwd) CWD="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "project: unknown arg $1" >&2; exit 2 ;;
  esac
done

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

ROOT="$(find_root "$CWD")"

# ---- existing-project guard (greenfield init only) --------------------------
if [[ -f "$ROOT/AGENTS.md" && -d "$ROOT/docs" ]]; then
  if [[ "$FORCE" != "1" ]]; then
    echo "project: existing project detected (AGENTS.md + docs/ present) — refuse greenfield init" >&2
    echo "project: attach read-only to the existing docs system instead; rerun with --force to override" >&2
    exit 1
  fi
  echo "project: existing project detected, --force given — proceeding"
fi

PROD="$ROOT/docs/product"
WISH="$ROOT/docs/wish"
mkdir -p "$PROD/decisions" "$WISH"

emit() {  # emit <path> <<'EOF' ... EOF
  local f="$1"
  if [[ -f "$f" ]]; then echo "project: keep $f (exists)"; return; fi
  cat > "$f"
  echo "project: wrote $f"
}

emit "$PROD/PRODUCT.md" <<'EOF'
# 产品寄存器

## 用户
-

## Job（用户要完成的任务）
-

## 反参考（不要做）
-
EOF

emit "$PROD/demand-pool.md" <<'EOF'
# 需求池（愿望 inbox）

> 新愿望先进这里（`wish.sh --new`）；接走后再建 `docs/wish/<id>/`。

| ID | 愿望 | 状态 | 接走日期 |
|---|---|---|---|
| | | new | |
EOF

emit "$PROD/gap-register.md" <<'EOF'
# 未满足需求登记

| ID | 需求 | 来源 | 状态 |
|---|---|---|---|
| | | | open |
EOF

emit "$PROD/gap-closed.md" <<'EOF'
# 已满足记录（关版回填）

| 愿望 ID | 关版日期 | 证据 |
|---|---|---|
| | | |
EOF

emit "$ROOT/AGENTS.md" <<'EOF'
# AGENTS.md — 工程事实面

> 本文件是「怎么跑 / 测 / 构建 / 部署」的唯一事实面；产品愿景在 docs/product/，愿望契约在 docs/wish/<id>/。

## 项目
- 技术栈：
- 代码入口：
- 默认分支：

## 常用命令
```bash
# 安装：
# 启动：
# 定向测试：
# 全量测试：
# lint / typecheck：
# build：
```

## 环境与入口
| 环境 | URL / 访问方式 | 版本识别 | 日志 / 监控 |
|---|---|---|---|
| Local | | | |
| Preview | | | |
| Production | | | |

## 单向门（执行前需批准）
- 事项 / 触发条件：
- 批准人 / 政策：
- 风险与回滚：

## 外部共享资源（并行时需领取）
| 资源 | 冲突规则 |
|---|---|
| 端口 | |
| 数据库 / 测试数据 | |
| 测试账号 | |
| 浏览器 / 设备 | |

## 项目就绪度
| 能力 | 状态 |
|---|---|
| 本地启动与定向验证 | ready / missing |
| 用户可见页面验收 | ready / missing / n/a |
| 日志与监控只读入口 | ready / missing / n/a |
| 部署与回滚 | ready / missing / n/a |
EOF

echo "project ready: $ROOT/{AGENTS.md, docs/product, docs/wish}"
