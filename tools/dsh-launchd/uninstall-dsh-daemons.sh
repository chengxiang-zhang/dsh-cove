#!/bin/zsh
# 回滚 install-dsh-daemons.sh：移除系统守护进程，恢复登录时启动的用户 agent。
# 用法（需要 sudo）：sudo zsh /Users/tester/.dsh/bin/uninstall-dsh-daemons.sh

set -u

TARGET_USER=leo
TARGET_UID=$(id -u "$TARGET_USER")
DAEMON_DIR=/Library/LaunchDaemons
AGENT_DIR=/Users/tester/Library/LaunchAgents
BACKUP=/Users/tester/.dsh/launchd/agents-disabled
LABELS=(ai.deepseek.dsh.web com.leo.dsh-nginx com.zcx.dsh-api-proxy)

if [[ $EUID -ne 0 ]]; then
  echo "请用 sudo 运行：sudo zsh $0" >&2
  exit 1
fi

for label in "${LABELS[@]}"; do
  launchctl bootout "system/$label" 2>/dev/null || true
  launchctl disable "system/$label" 2>/dev/null || true
  rm -f "$DAEMON_DIR/$label.plist"
  if [[ -f "$BACKUP/$label.plist" && ! -f "$AGENT_DIR/$label.plist" ]]; then
    mv "$BACKUP/$label.plist" "$AGENT_DIR/$label.plist"
    chown "$TARGET_USER":staff "$AGENT_DIR/$label.plist"
  fi
  launchctl bootstrap "gui/$TARGET_UID" "$AGENT_DIR/$label.plist" 2>/dev/null || true
  echo "restored gui/$label"
done