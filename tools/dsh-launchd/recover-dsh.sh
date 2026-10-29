#!/bin/zsh
# dsh.mac 端口耗尽恢复脚本
#
# 背景：这台 Mac 的临时端口（8192–65535）已被 ~8.6 万个卡死的 TCP socket 占满
# （TIME_WAIT / LAST_ACK / FIN_WAIT 等，且不回收），于是任何"新建出站连接"都会
# 立刻失败（EADDRNOTAVAIL, errno 49）：
#   - nginx → 127.0.0.1:3082 失败 ⇒ http://dsh.mac/ 返回 502
#   - 家族网关 → 127.0.0.1:3080 失败 ⇒ 登录后页面/接口全挂
#   - 机器上其它要联网的东西（git push、npm、MCP、模型 API、codex 代理）同样失效
#
# 这些 socket 没有属主进程（lsof 里看不到），重启 DSH 服务也不会释放，
# 用户级没有任何办法清掉它们；只能用 root 重启系统（或等内核自行回收，实测不会）。
#
# 用法：  zsh ~/.dsh/bin/recover-dsh.sh
#   脚本会先打印诊断，再让你确认，然后执行 `sudo reboot`（会提示输入你的登录密码）。

set -u

echo "== 诊断 =="
python3 - <<'PY'
import subprocess
from collections import Counter
out = subprocess.run(['netstat', '-an', '-p', 'tcp'], capture_output=True, text=True).stdout
states = Counter()
ports = set()
for line in out.splitlines():
    parts = line.split()
    if len(parts) < 6:
        continue
    local, state = parts[3], parts[5]
    states[state] += 1
    addr, _, port = local.rpartition('.')
    if port.isdigit():
        ports.add(int(port))
ephemeral = [p for p in ports if 8192 <= p <= 65535]
total = 65535 - 8192 + 1
print(f"临时端口占用: {len(ephemeral)}/{total}  ({len(ephemeral) * 100 // total}%)")
print("主要状态:", {k: v for k, v in states.most_common(5)})
free = total - len(ephemeral)
print(f"剩余可用端口: {free}")
PY

echo
echo "判断: 端口几乎耗尽 ⇒ 新建出站连接必然失败 (EADDRNOTAVAIL)。"
echo "      http://dsh.mac/ 的 502 就来自 nginx 连不上 127.0.0.1:3082。"
echo
echo "注意: 重启后 DSH 是「登录时才启动」的用户级 LaunchAgent（~/Library/LaunchAgents），"
echo "      且这台机器没有开启自动登录 —— 所以重启后需要在 Mac 的图形界面登录一次（本机或屏幕共享），"
echo "      dsh.mac 才会回来。如果做不到，先跟我说，我给你一条命令把它装成开机自启的守护进程。"
echo
read -r "answer?现在重启这台 Mac? [y/N] "
if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
  echo "已取消。"
  exit 0
fi

sudo reboot