#!/bin/zsh
# 把 dsh / nginx / api-proxy 从「登录才启动的用户 LaunchAgent」改成
# 「开机自启的系统 LaunchDaemon」，这样远程机器重启后无需有人在图形界面登录。
#
# 同时把 dsh web 的启动脚本变成受管产物：规范浏览器入口必须出现在
# --trusted-host 上（见 tools/dsh-netbird/README.md），否则远程浏览器的
# Git / SSH / worktree / memoir 等特权路由一律 403，Git 面板显示
# "Git operation failed: 403 Forbidden"。
#
# 用法（需要 sudo）：
#   只安装：        sudo zsh /Users/tester/.dsh/bin/install-dsh-daemons.sh --machine laptop-b
#   指定入口：      ... --trusted-host dsh.laptop-b（可重复，也可与 --machine 混用）
#   强制重写脚本：  ... --rewrite-launcher
#   安装并重启：    ... --reboot
# 回滚：            sudo zsh /Users/tester/.dsh/bin/uninstall-dsh-daemons.sh
#
# 注意：这台机器上真正在跑 nginx 的是 brew services 的 gui agent（sh.brew.nginx），
# 而 com.leo.dsh-nginx 早已因端口被占而启动失败 —— 两个都会被停掉并由守护进程接管。

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
TARGET_USER=${DSH_LAUNCHD_USER:-$(id -un)}
TARGET_HOME=/Users/$TARGET_USER
TARGET_UID=$(id -u "$TARGET_USER")
DSH_HOME_DIR=${DSH_HOME:-$TARGET_HOME/.dsh}
REPO_DIR=${DSH_COVE_REPO:-$TARGET_HOME/code/dsh-web}
DAEMON_DIR=/Library/LaunchDaemons
SRC=$DSH_HOME_DIR/launchd
AGENT_DIR=$TARGET_HOME/Library/LaunchAgents
BACKUP=$DSH_HOME_DIR/launchd/agents-disabled
LAUNCHER=$DSH_HOME_DIR/bin/start-dsh-web.sh
DAEMON_LABELS=(ai.deepseek.dsh.web com.leo.dsh-nginx com.zcx.dsh-api-proxy)
AGENT_LABELS=(ai.deepseek.dsh.web com.leo.dsh-nginx sh.brew.nginx com.zcx.dsh-api-proxy)

die() {
  echo "!! $1" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
用法：sudo zsh install-dsh-daemons.sh [--trusted-host <authority>]... [--machine <netbirdName>]... [选项]

  --trusted-host <authority>  规范浏览器入口，可重复（如 dsh.laptop-b）
  --machine <netbirdName>     取 tools/dsh-netbird/machines.json 里该机器的 domain，可重复
  --dsh-bin-dir <dir>         dsh 可执行文件所在目录（默认取守护进程 plist 的 PATH 首项）
  --rewrite-launcher          已有启动脚本带 --trusted-host 时也重写（旧文件先备份为 .bak-<时间戳>）
  --reboot                    安装并校验通过后重启这台 Mac
  -h, --help                  显示本帮助

至少要有一个 --trusted-host 或 --machine，否则不安装任何东西。
EOF
}

find_in() {
  _name=$1
  shift
  for _dir in "$@"; do
    if [ -f "$_dir/$_name" ]; then
      printf '%s\n' "$_dir/$_name"
      return 0
    fi
  done
  return 1
}

append_line() {
  printf '%s%s\n' "$1" "$2"
}

if [[ $EUID -ne 0 ]]; then
  echo "请用 sudo 运行：sudo zsh $0" >&2
  exit 1
fi

LIB=$(find_in lib-dsh-launchd.sh "$SCRIPT_DIR" "$SRC") || die "找不到 lib-dsh-launchd.sh（应与本脚本同目录，或位于 ${SRC}）"
. "$LIB"

TRUSTED_HOST_ARGS=''
MACHINE_ARGS=''
REWRITE_LAUNCHER=0
REBOOT=0
DSH_BIN_DIR_ARG=''
MACHINES_JSON=${DSH_LAUNCHD_MACHINES:-}
if [ -z "$MACHINES_JSON" ]; then
  MACHINES_JSON=$(find_in machines.json "$SCRIPT_DIR/../dsh-netbird" "$SRC/../dsh-netbird") || MACHINES_JSON=''
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --trusted-host)
      [ $# -ge 2 ] || die "--trusted-host 缺少参数"
      TRUSTED_HOST_ARGS=$(append_line "$TRUSTED_HOST_ARGS" "$2")
      shift 2
      ;;
    --trusted-host=*)
      TRUSTED_HOST_ARGS=$(append_line "$TRUSTED_HOST_ARGS" "${1#--trusted-host=}")
      shift
      ;;
    --machine)
      [ $# -ge 2 ] || die "--machine 缺少参数"
      MACHINE_ARGS=$(append_line "$MACHINE_ARGS" "$2")
      shift 2
      ;;
    --machine=*)
      MACHINE_ARGS=$(append_line "$MACHINE_ARGS" "${1#--machine=}")
      shift
      ;;
    --dsh-bin-dir)
      [ $# -ge 2 ] || die "--dsh-bin-dir 缺少参数"
      DSH_BIN_DIR_ARG=$2
      shift 2
      ;;
    --dsh-bin-dir=*)
      DSH_BIN_DIR_ARG=${1#--dsh-bin-dir=}
      shift
      ;;
    --rewrite-launcher)
      REWRITE_LAUNCHER=1
      shift
      ;;
    --reboot)
      REBOOT=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数：$1" >&2
      usage
      exit 2
      ;;
  esac
done

echo "== 1/5 生成 dsh web 启动脚本（--trusted-host 不变式）=="

if [ -n "$MACHINE_ARGS" ] && [ -z "$MACHINES_JSON" ]; then
  die "找不到 netbird 机器清单 machines.json：请直接传 --trusted-host <authority>，或设置 DSH_LAUNCHD_MACHINES"
fi
if ! AUTHORITY_LIST=$(dsh_launchd_authorities "$MACHINES_JSON" "$TRUSTED_HOST_ARGS" "$MACHINE_ARGS"); then
  die "没有可用的规范入口：请传 --trusted-host <authority> 或 --machine <netbirdName>；本次未安装任何东西"
fi

DSH_BIN_DIR=${DSH_BIN_DIR_ARG:-}
if [ -z "$DSH_BIN_DIR" ]; then
  DSH_BIN_DIR=$(dsh_launchd_plist_first_path_dir "$SRC/ai.deepseek.dsh.web.plist" 2>/dev/null) || DSH_BIN_DIR=''
fi
if [ -z "$DSH_BIN_DIR" ]; then
  _dsh_path=$(command -v dsh) || _dsh_path=''
  if [ -n "$_dsh_path" ]; then
    DSH_BIN_DIR=$(dirname "$_dsh_path")
  fi
fi
[ -n "$DSH_BIN_DIR" ] || die "无法确定 dsh 所在目录：请传 --dsh-bin-dir <dir>"
[ -x "$DSH_BIN_DIR/dsh" ] || die "在 $DSH_BIN_DIR 下找不到可执行的 dsh：请传 --dsh-bin-dir <dir>"

TEMPLATE=${DSH_LAUNCHD_TEMPLATE:-}
if [ -z "$TEMPLATE" ]; then
  TEMPLATE=$(find_in start-dsh-web.sh "$SCRIPT_DIR/launchd" "$SRC") || die "找不到启动脚本模板 start-dsh-web.sh（期望 $SCRIPT_DIR/launchd/ 或 $SRC/）"
fi

echo "   规范入口："
printf '%s\n' "$AUTHORITY_LIST" | sed 's/^/     /'

if [ "$(dsh_launchd_launcher_decision "$LAUNCHER" "$REWRITE_LAUNCHER")" = "keep" ]; then
  echo "   $LAUNCHER 已存在且已带 --trusted-host，保持不变（要按本次参数重写请加 --rewrite-launcher）："
  grep -v -e '^[[:space:]]*#' "$LAUNCHER" | grep -e '--trusted-host' | sed 's/^/     /'
  _existing=$(grep -v -e '^[[:space:]]*#' "$LAUNCHER" | grep -o -e '--trusted-host [^ ]*' | awk '{print $2}' | sort -u | tr '\n' ' ')
  _wanted=$(printf '%s\n' "$AUTHORITY_LIST" | sort -u | tr '\n' ' ')
  if [ "$_existing" != "$_wanted" ]; then
    echo "   !! 已有脚本的入口 [$_existing] 与本次参数 [$_wanted] 不一致：确认无误后加 --rewrite-launcher 重写" >&2
  fi
else
  mkdir -p "$DSH_HOME_DIR/bin" || die "无法创建 $DSH_HOME_DIR/bin"
  _tmp=$(mktemp "$DSH_HOME_DIR/bin/.start-dsh-web.sh.XXXXXX") || die "mktemp 失败"
  if ! dsh_launchd_render_launcher "$TEMPLATE" "$DSH_BIN_DIR" "$TARGET_HOME" "$DSH_HOME_DIR" "$AUTHORITY_LIST" > "$_tmp"; then
    rm -f "$_tmp"
    die "渲染启动脚本失败（模板 ${TEMPLATE}）"
  fi
  if grep -q -e '__[A-Z_][A-Z_]*__' "$_tmp"; then
    rm -f "$_tmp"
    die "启动脚本里仍有未替换的占位符"
  fi
  if ! grep -q -e '--trusted-host' "$_tmp"; then
    rm -f "$_tmp"
    die "启动脚本缺少 --trusted-host"
  fi
  if command -v bash >/dev/null 2>&1 && ! bash -n "$_tmp"; then
    rm -f "$_tmp"
    die "启动脚本语法检查失败"
  fi
  if [ -f "$LAUNCHER" ]; then
    _backup=$LAUNCHER.bak-$(date +%Y%m%d-%H%M%S)
    cp -p "$LAUNCHER" "$_backup" || { rm -f "$_tmp"; die "备份到 $_backup 失败"; }
    echo "   备份旧脚本：$_backup"
  fi
  install -o "$TARGET_USER" -g staff -m 755 "$_tmp" "$LAUNCHER" || { rm -f "$_tmp"; die "写入 $LAUNCHER 失败"; }
  rm -f "$_tmp"
  echo "   已写入 ${LAUNCHER}（mode 0755，owner ${TARGET_USER}:staff）："
  cat "$LAUNCHER"
fi

if ! grep -q -e '__HOME__/.dsh/bin/start-dsh-web.sh' "$SRC/ai.deepseek.dsh.web.plist" 2>/dev/null; then
  echo "   !! $SRC/ai.deepseek.dsh.web.plist 的 ProgramArguments 未指向 __HOME__/.dsh/bin/start-dsh-web.sh" >&2
fi

mkdir -p "$BACKUP"

restore_agents() {
  for label in "${AGENT_LABELS[@]}"; do
    if [[ -f "$BACKUP/$label.plist" && ! -f "$AGENT_DIR/$label.plist" ]]; then
      mv "$BACKUP/$label.plist" "$AGENT_DIR/$label.plist"
      chown "$TARGET_USER":staff "$AGENT_DIR/$label.plist"
    fi
    launchctl bootstrap "gui/$TARGET_UID" "$AGENT_DIR/$label.plist" 2>/dev/null || true
  done
}

echo "== 2/5 停掉现有 GUI agent（dsh / api-proxy / 两个 nginx 入口）=="
for label in "${AGENT_LABELS[@]}"; do
  if launchctl print "gui/$TARGET_UID/$label" >/dev/null 2>&1; then
    launchctl bootout "gui/$TARGET_UID/$label" 2>/dev/null && echo "   bootout gui/$label" || echo "   bootout gui/$label 失败，继续"
  fi
done
# brew services 的 nginx 可能不由 launchd 持有，或 bootout 后仍有残留进程：把 nginx 收干净
pkill -f '/opt/homebrew/opt/nginx/bin/nginx' 2>/dev/null && echo "   killed leftover nginx" || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  lsof -nP -iTCP:80 -sTCP:LISTEN >/dev/null 2>&1 || break
  sleep 1
done
sleep 2

echo "== 3/5 让这些 agent 不再随登录启动（移到 $BACKUP）=="
for label in "${AGENT_LABELS[@]}"; do
  if [[ -f "$AGENT_DIR/$label.plist" ]]; then
    mv "$AGENT_DIR/$label.plist" "$BACKUP/$label.plist"
    echo "   moved $label.plist"
  fi
done

echo "== 4/5 安装并启动 LaunchDaemon =="
_render_dir=$(mktemp -d "${TMPDIR:-/tmp}/dsh-launchd.XXXXXX") || die "mktemp -d 失败"
for label in "${DAEMON_LABELS[@]}"; do
  sed -e "s|__USER__|$(dsh_launchd_sed_escape "$TARGET_USER")|g" \
      -e "s|__HOME__|$(dsh_launchd_sed_escape "$TARGET_HOME")|g" \
      -e "s|__REPO_DIR__|$(dsh_launchd_sed_escape "$REPO_DIR")|g" \
      "$SRC/$label.plist" > "$_render_dir/$label.plist" || { rm -rf "$_render_dir"; restore_agents; die "render $label failed"; }
  install -o root -g wheel -m 644 "$_render_dir/$label.plist" "$DAEMON_DIR/$label.plist" || { rm -rf "$_render_dir"; echo "install $label failed" >&2; restore_agents; exit 1; }
  launchctl bootout "system/$label" 2>/dev/null || true
  launchctl bootstrap system "$DAEMON_DIR/$label.plist" || { echo "bootstrap $label failed" >&2; restore_agents; exit 1; }
  launchctl enable "system/$label" 2>/dev/null || true
  echo "   bootstrapped system/$label"
done
rm -rf "$_render_dir"

echo "== 5/5 校验（等 25s：看 pid 与监听端口，不看 HTTP —— 当前端口表已耗尽）=="
sleep 25
failed=0
for label in "${DAEMON_LABELS[@]}"; do
  state=$(launchctl print "system/$label" 2>/dev/null | awk '/state = /{print $3; exit}')
  pid=$(launchctl print "system/$label" 2>/dev/null | awk '/pid = /{print $3; exit}')
  echo "   $label: state=${state:-none} pid=${pid:-none}"
  [[ -n "$pid" ]] || failed=1
done
for port in 3080 3082 80 8317; do
  owner=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $1" pid="$2}')
  echo "   listen :$port -> ${owner:-（无）}"
  [[ -n "$owner" ]] || failed=1
done

if [[ $failed -ne 0 ]]; then
  echo
  echo "!! 有服务没起来，回滚到 GUI agent 模式" >&2
  for label in "${DAEMON_LABELS[@]}"; do
    launchctl bootout "system/$label" 2>/dev/null || true
    launchctl disable "system/$label" 2>/dev/null || true
    rm -f "$DAEMON_DIR/$label.plist"
  done
  restore_agents
  exit 1
fi

echo
echo "全部就绪：重启后无需登录即可恢复。"
if [[ "$REBOOT" -eq 1 ]]; then
  echo "3 秒后重启这台 Mac（要取消就 Ctrl-C）…"
  sleep 3
  sync
  reboot
else
  echo "接下来可以执行重启：  sudo reboot"
fi
echo "（回滚：sudo zsh /Users/tester/.dsh/bin/uninstall-dsh-daemons.sh）"