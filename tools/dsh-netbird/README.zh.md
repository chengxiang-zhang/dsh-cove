# NetBird DSH 部署

[English](README.md) | 中文

本目录是私有 NetBird 网络中每台电脑暴露一个 DSH Web 实例的运维事实源。接入这套网络的员工请阅读 [employee-guide.zh.md](employee-guide.zh.md)。 本目录中的机器名、地址与 peer id 均为脱敏示例，部署时替换为自己的值。

## 地址契约

每台电脑只使用一个规范浏览器地址：

```text
http://dsh.<NetBird 机器名>.netbird/
```

机器名取自 `netbird status` 展示的 peer 名称，并去掉 `.vpn` 后缀。当前机器清单和预期 NetBird IPv4 地址记录在 [machines.json](machines.json)。规范名只使用这一套规则：不使用兼容别名、短名、`.vpn` 名或 NetBird IP 字面量。

地址不显式带端口。NetBird 自定义 DNS 持有 `dsh.<机器名>.netbird` A 记录，目标电脑上的 nginx 只在该机器的 NetBird IPv4 上监听 80 端口（见「网络门禁」）。

## 移动端入口

手机/平板的入口是 [tools/netbird-client](../netbird-client/README.zh.md)，一个经覆盖网络到达这些机器的 React Native 门户；其服务列表来自本目录所述的同一套 NetBird DNS zone，因此新机器只要有了 `dsh.<机器名>.netbird` A 记录，手机端即可发现并访问。客户端只接受目标地址属于自己 peer 集合的记录（见该目录 README 的发现规则），所以同一 zone 里的其它机器名不会进入列表；而 zone 本身按分发组下发，看不到 zone 就没有列表，见「NetBird DNS 记录」。安装包走网络边缘提供的更新通道 `https://anywhere.example.com/`（本手册通篇使用的示例地址，公网 HTTPS；同一宿主的 `tx` / `tx.vpn` 也回答该通道，见 [netbird-management.zh.md](netbird-management.zh.md) 的域名契约）。

## 必需流量路径

```text
浏览器 -> dsh.<机器名>.netbird:80 -> nginx -> 127.0.0.1:3080（DSH 集成 WebAuth）
```

DSH 进程使用 `--host 127.0.0.1 --port 3080 --no-open` 启动，并通过 `--trusted-host` 传入每台机器的规范浏览器 authority。Nginx 把规范主机代理到该 loopback 监听器，并保留 Host、Origin、cookie 和 WebSocket upgrade 请求头。DSH 只信任文档中的规范主机；局域网和 NetBird IP 直连监听仍保持关闭。3082 是默认关闭的兼容监听器，不属于该拓扑。

在本 SDK 中，Web profile 的 `web` 行 `trustedHosts` 不会到达运行时围栏：connection 服务读取的是 `ctx.webRuntime.trustedHosts`，而 Web 运行时由启动参数推导该值。请在命令行传入规范 authority，不要把 IP 字面量、兼容别名或其他局域网名称写进该列表。

同一份 `ctx.webRuntime.trustedHosts` 也是宿主侧插件面板的准入列表：web-all 的 Git 管理、Agent 浏览器、worktree、SSH、memoir、运行方式与右栏工作台路由共用一个宿主访问围栏——请求 socket 必须是 loopback，且 Host 为 loopback，或属于该列表并携带有效 DSH 浏览器会话（本地账号、飞书或 OIDC 签发的同一个 HttpOnly 会话，或原生启动 token）；跨站标记、缺失 Host、未声明的 Host、无有效会话一律 403。本机浏览器直接访问 `127.0.0.1:3080` 时 Host 即 loopback，因此不需要额外配置。`noBrowserAuth: true` 会把远程分支退化为仅 Host/Origin 检查，等同于把这些面板开放给任何能到达 80 端口的 peer。

Nginx 代理 `127.0.0.1:3080`。最小虚拟主机模板见 [nginx.conf.template](nginx.conf.template)。必须保留 `proxy_buffering off;`：DSH 与插件的 JavaScript bundle 可能超过 nginx 内存代理缓冲区；若 worker 无权访问用户目录下的临时路径，响应会被截断，登录后的应用根节点将保持空白。

worker 临时路径同样不得留在用户目录：worker 以编译默认用户运行（macOS 为 `nobody`），master 保留绑定 80 端口所需的权限，并在启动时以 root 创建、chown 每条临时路径；位于用户目录下、worker 无法穿越的路径永远写不进去，请求体一旦超过内存缓冲就要落到临时文件，落盘失败使入口对该请求返回 500。模板把五条 `*_temp_path` 固定到 `/var/tmp/dsh-nginx/` 下，其父目录必须事先以 root 创建一次：nginx 只创建末级目录，父目录缺失会让 nginx 启动失败。

`typert-gateway.config.websocketHeartbeatIntervalMs` 必须按 [cordis.patch.yml](cordis.patch.yml) 设为 `30000`。DSH 上游默认值 `2000` 毫秒同时控制 WebSocket Ping 周期和 Pong 截止时间；浏览器主线程、宿主事件循环或 NetBird overlay 抖动超过两秒时，Host 会误杀仍健康的 `/api/remote.mux`，客户端随后固定间隔重连。30 秒仍能及时发现失联 peer，同时能容忍正常调度和 mesh 抖动。

## 目录选择器

peer 的浏览器只能走到 nginx，够不着宿主屏幕，所以每台机器的 Web profile 固定组合 browse 这一对交互，而不是 DSH 出厂的自适应选择器：按 [cordis.patch.yml](cordis.patch.yml) 禁用 bundle 的 `directory-picker` 行，再插入 `@deepseek-ai/dsh-host-directory-picker-browse` 后端与它的浏览器面 `@deepseek-ai/dsh-client-ui-directory-picker-browse`。patch 里的 `name` 是「目标行名字必须一致」的守卫而不是重命名，所以固定组合只能是「禁用 + 插入」；两个面属于同一条交互，必须成对出现。

自适应选择器在这个拓扑下必然判定 `native`：它只读绑定地址（loopback）和启动方式（非 SSH），据此推断操作者坐在宿主屏幕前，看不见插在中间的 nginx。`native` 的每次 `pick` 都在宿主屏幕上打开一个 OS 选择器并等待操作者；peer 既看不到也无法回答，请求一直挂到 nginx 放弃才以 `HTTP 504` 结束。browse 后端改为在浏览器里逐层列出宿主目录、创建子目录，本机浏览器与规范远程入口用的是同一条交互。

查看某台机器组合出的交互：

```sh
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"type":"client-request","rpcId":"picker","method":"directoryPicker/list","payload":{"args":{}}}' \
  http://dsh.<机器名>.netbird/api/directoryPicker/list
```

browse 返回目录列表；`native` 返回接缝的 `directory-picker/unavailable` 并在 `details.capability` 里指明 `"native"`。

## 网络门禁

入口只对 NetBird 覆盖网开放：DSH 虚拟主机的 80 端口绑定该机器的 NetBird IPv4（模板见 [nginx.conf.template](nginx.conf.template)），公网、办公内网和家庭内网都连不到它。

- 绑定是第一步：它把监听面从所有网卡收窄到覆盖网地址。nginx 按连接的本地地址选择虚拟主机，因此同一端口上的其它虚拟主机继续在各自地址上服务，发往其它地址的请求不会落到 DSH。
- Linux 还必须加接口级防火墙规则：默认拒绝入站 80，只放行 NetBird 接口 `wt0`。内核按本地地址交付，目的地址是本机 NetBird 地址的包可以在任意接口上被接受，所以绑定是收窄而不是接口过滤。
- nginx 必须在 NetBird 地址存在之后启动才会绑定成功：Linux 服务单元加 `After=netbird.service`，macOS 的 LaunchDaemon 用 `KeepAlive` 重试到地址出现。
- 443 与 80 一样是特权端口：nginx master 必须能绑它。一个 `server` 块的 `listen` 绑不上会让整份配置加载失败，因此不具备该能力的机器不要带 443 块（模板里两个块各自独立，删掉 TLS 块即可只留 80 端口入口）。

`authMode` 在 [machines.json](machines.json) 里逐台声明，审计据此判定未登录入口：

| authMode | 未登录入口 | 允许条件 |
| --- | --- | --- |
| `password` | `302` 跳转 `/login` | 默认值，集成 WebAuth 同时保护外壳、API 与特权面板 |
| `network-gate` | 直接返回 DSH 文档 | 门禁已部署，并由 `--verify-gate` 现场验证通过 |

`network-gate` 把覆盖网成员资格变成唯一凭据：能入网的任何设备无需二次认证即可驱动 Git、SSH、worktree、Agent 浏览器等特权面板。因此审计拒绝在门禁未现场验证时接受该机器，收紧 NetBird ACL 与 setup key 是这一模式的前置条件。

## TLS 入口

明文 HTTP 不是浏览器安全上下文，而需要真实授权的能力无法从页面补齐：`crypto.randomUUID` 与 `navigator.clipboard` 由插件在首页注入 polyfill 与 shim，但麦克风不行——`navigator.mediaDevices` 在非安全上下文里根本不存在，官方语音输入插件据此报「当前浏览器不支持录音」。同一台机器上的 `https://dsh.<机器名>.netbird/` 就是为解决这一类能力而存在的入口：它与 80 端口入口是同一个虚拟主机、同一条 `127.0.0.1:3080` 代理路径，只是多了 TLS 和一张为该规范名签发的证书。

机群用一套自建 CA（模板见 [nginx.conf.template](nginx.conf.template) 的 TLS 块），私钥材料只留在仓库之外：

```sh
# 每台机器各签一张叶子证书；重复执行会保留仍有效的证书，--rotate 才换新
pnpm dsh-netbird:tls init
pnpm dsh-netbird:tls issue <机器名> [<机器名>...]
pnpm dsh-netbird:tls trust          # 打印各客户端信任根证书的命令
pnpm dsh-netbird:tls verify --host dsh.<机器名>.netbird --ip <NetBird IP>
```

- 默认目录 `~/.dsh/tls`：`ca.key` 与叶子私钥 `0600`，证书 `0644`；`--dir` 落在仓库内会被拒绝，因为签出去的根证书不能靠删除提交来收回。
- 根证书要装到每台**客户端**机器的系统信任库（`trust` 打印 macOS 系统钥匙串、Debian/Ubuntu 与 RHEL/Fedora 的命令）。Chrome 与桌面客户端读系统钥匙串，装好即用；Android 的 GeckoView 只读自己的根证书库，所以移动端继续走 80 端口入口，这也是 80 端口入口不重定向到 HTTPS 的原因。
- 证书轮转：叶子用 `issue --rotate` 换新；换根要重建 `ca.key`/`ca.crt` 后对全部机器重跑 `issue`，脚本按签名而非 issuer 名判断，因此会重签。
- 部署：把模板渲染成该机器的虚拟主机（`__MACHINE__`、`__NETBIRD_IP__`、`__TLS_DIR__`），先 `nginx -t` 再 reload；master 必须先能绑 443（macOS 上的做法见「macOS 服务」）。80 端口块继续服务且不重定向。
- nginx 必须带 SSL 模块：`nginx -t` 报 `the "ssl" parameter requires ngx_http_ssl_module` 时，该机的 nginx 是没编 `--with-http_ssl_module` 的最小构建（机队里 macOS 自建的 `~/.dsh/nginx/sbin/nginx` 就是这样），必须先换或重建成带 SSL 的构建，配置本身补齐不了。
- 服务进程必须读得到证书文件：证书目录要对这台机器的 nginx 可见；容器化服务要把目录挂进去，而**单文件**挂载的容器在主机替换该文件后会继续读旧 inode，所以要么在容器启动前写好，要么把配置目录整体挂进去。
- 验收：`verify` 用该机器的叶子做一次真实握手（链 + 主机名都要通过）；客户端侧再看 `https://dsh.<机器名>.netbird/` 的语音输入是否可用，桌面客户端可用 `node poc/tls-entry.mjs` 在本地复现整条链路。

## 鉴权契约

DSH 集成 WebAuth 是面向浏览器的鉴权墙，也是 `password` 模式的判据。保持 `web-all.config.noBrowserAuth` 为 false，启用 `remote-web-ui.integratedAuthEnabled`，并配置一个本地应急管理员及所需飞书或 OIDC Provider。同一会话保护原生 Web 首页、HTTP API 与 `/api/remote.mux`；移动浏览器也使用 `/` 下的原生界面。远程入口下每一条特权宿主路由族的完整契约（Host 所有权声明、共享围栏、明文本地兜底）见 [docs/remote-access.md](../../docs/remote-access.md)；本页只记录它在机群上的部署取值。

正确的未登录 HTML 请求返回 `302` 到 `/login`。有效登录后，相同请求返回 HTTP `200` 和 DSH HTML 文档。本机仍可使用原生启动 token。OAuth Provider 需要外部可达的 HTTPS 回调 origin，并将其配置为 `publicBaseUrl`；私有 HTTP 部署可以只使用本地密码而不设置该项。

`network-gate` 模式按「网络门禁」一节替代这堵墙：`noBrowserAuth: true` 让宿主访问围栏只剩 Host/Origin 判定，所以只有当门禁被现场验证之后，审计才接受这台机器。

## 预置模型接入配置

全机器统一的 LLM provider 预置是 [llm-models.patch.yml](llm-models.patch.yml)：router 实测模型目录（端点来自 `config/deployment.local.json`，不写进仓库）（模型、上下文窗口封顶、最大输出、推理档位）加本机 codex 订阅代理（`codex-local`）。把它的 `llm-pi-ai` provider 块并入每台机器 `$DSH_HOME/profiles/web/cordis.patch.yml` 既有的唯一 `llm-pi-ai` 行（同名 provider 整块替换），`agent-default-model` 行直接替换；合并后由机器管理员重启 dsh web 生效。

员工一键安装脚本（[client/install.sh](client/install.sh)）用该目录的精简子集起步——Kaon Router、默认模型 `kaon/deepseek-v4.1-flash` 加少量模型——因此员工自己装好的机器在管理员介入前就能用；[../../scripts/dsh-netbird-client-dsh.test.mjs](../../scripts/dsh-netbird-client-dsh.test.mjs) 用本预置守住这些数值，而下面的命令会整块替换该 provider，这类机器因此收敛到完整目录。

秘钥不进仓库、不进服务单元：

- `KAON_ROUTER_API_KEY` 与 `DSH_API_PROXY_KEY` 是 DSH credential 引用，落在各机器 `$DSH_HOME/.credentials.yaml` 的 `refs:`；`DSH_API_PROXY_KEY` 的值必须与本机 dsh-api-proxy `config.yaml` 的 `apiKeys` 条目一致。
- 秘钥文件保持 0600 且仅 owner 可读；未配置秘钥只让对应 provider 的请求失败，不影响 dsh web 启动。

`codex-local` 指向 `127.0.0.1:8317` 的 [dsh-api-proxy](../dsh-api-proxy/README.zh.md)：每台机器运行自己的一份，用各自的 ChatGPT 订阅执行 `--login --provider=codex` 登录（OpenAI ToS 不允许中转他人会话，仅限本机个人使用）。没有该代理的机器保留 provider 块也不会阻塞启动。

`codex-local` 的「上下文已使用量」依赖代理在流式响应末尾转发 usage 块：当前仓库版 dsh-api-proxy 已实现（SDK 侧默认携带 `stream_options.include_usage`），旧版独立 auth2api 或过期 dist 构建不发，界面就显示不出来。各机器的代理按 worktree 方式更新，不碰机器自己的检出与未提交改动：

- 有 GitHub SSH 通道的机器：`git fetch origin dev`，然后 `git worktree add ~/code/dsh-proxy origin/dev --detach`，在 `~/code/dsh-proxy/tools/dsh-api-proxy` 里 `npm ci && npm run build`。
- 没有通道的机器：运维工作站先 `git bundle create /tmp/dsh-dev.bundle dev` 并 scp 过去，目标机器 `git fetch /tmp/dsh-dev.bundle dev` 后按上一步建 worktree（bundle 用完即删）。
- 服务单元的 `WorkingDirectory` 与 `ExecStart` 指向 worktree 的 dist，之后 `systemctl --user daemon-reload && systemctl --user restart auth2api.service`；机器本地 `config.yaml` 原样复制到 worktree。

预置的应用走仓库命令而不是逐台手改：

```sh
# 干跑：每个目标会改什么，不写文件不重启
pnpm dsh-netbird:llm-apply -- --dry-run

# 应用到全部机器并按各自服务形态重启（操作者自己的 ssh-studio-mac 一律拒绝）
pnpm dsh-netbird:llm-apply

# 单台应用 + 同机凭据映射 + 跨机秘钥管道
pnpm dsh-netbird:llm-apply -- ssh-thinkpad-lab --copy-ref CODEX_LOCAL_API_KEY:DSH_API_PROXY_KEY
ssh ssh-laptop-b '<打印 KAON_ROUTER_API_KEY 的命令>' | pnpm dsh-netbird:llm-apply -- --ref-stdin KAON_ROUTER_API_KEY nb-tx
```

命令在运维工作站本地完成合并（fetch → 纯函数 merge → 写回），远端只需要 cat/tee 与服务控制，写回前先落时间戳备份。机器本地秘钥只在同机文件之间复制（`--copy-ref`）或通过管道直连另一台机器（`--ref-stdin`），全程不进仓库、不进命令行参数。`pnpm dsh-netbird:audit` 与 scripts 的 drift 门禁测试守护预置与机器清单。

## 服务操作前置检查

在机器上 kill、重启或手工拉起 DSH 之前，先确定「谁在托管它」；在改 profile、或移动/归档 `~/.dsh` 下的任何路径之前，先确认没有服务定义或钩子脚本依赖它。四条都要走完：

1. 找托管方：`systemctl status <pid>`，或读 `/proc/<pid>/cgroup`；**system 作用域与 user 作用域都要查**（`systemctl is-active dsh-web.service` 与 `systemctl --user is-active dsh-web.service` 都可能命中；macOS 用 `launchctl print gui/$(id -u)/<label>`）。只查 `--user` 会把 system 单元误判成「无人托管」。
2. 只通过托管方操作：有单元就用 `systemctl [--user] restart <unit>` 或 `launchctl kickstart -k <label>`。**不要 kill 掉进程再手工 `nohup` 拉起**——手工实例会占住 3080，托管方随后按 `RestartSec` 反复重试并全部以 `EADDRINUSE` 失败，日志被刷成重启循环。
3. 启动钩子：Linux 单元的 `ExecStartPre` / `ExecStartPost`（含 `*.service.d/*.conf` drop-in）可能引用 profile 外的路径。移动或归档 `~/.dsh` 下任何目录前，先 `systemctl [--user] cat <unit>` 并 grep 钩子脚本；本机曾因归档 `~/.dsh/backups` 让一个 `ExecStartPre` 失败、服务起不来。
4. 一次操作、一台机器只重启一次，重启前要有用户明确授权，重启后先读新日志段（`startup failed` / `EADDRINUSE` / `failed to import`）再决定下一步，并按「滚动重启」逐台记录结果。

## 滚动重启

涉及多台机器的变更（模型目录、bundle、服务单元）按「先单台验证、再逐台推进、最后本机」的滚动顺序执行：

1. 先重启一台 canary（`ssh-laptop-b`），确认 loopback `http://127.0.0.1:3080` 返回 200、服务稳定、目录/行为符合预期后再继续。
2. 其余机器逐台重启并各自验证，不并行、不批量跳过验证。需要先部署代码的（如代理 worktree）先完成代码更新与重建再重启。
3. **操作者自己的机器（`ssh-studio-mac`）最后重启**：`dsh-netbird-llm-apply` 会拒绝操作者本机，按服务形态手动重启（launchd `ai.deepseek.dsh.web` 与代理 `com.zcx.dsh-api-proxy`）。本机重启会中断当前会话，属预期，应放在最后并提前告知。
4. 全程由同一轮操作记录每台机器的验证结果；有失败即停下排查，不带着失败继续滚动。

## Linux 服务

在目标用户的 Web profile 中安装 DSH 和 `@dsh-cove/dsh-web-all`，然后按 [dsh-web.service.template](dsh-web.service.template) 配置系统服务或等价的持久用户服务。只有启用 linger、无需交互式登录也能启动时，用户服务才可接受。

服务必须已启用、正在运行，并能异常自动重启。按 [dsh-web.service.template](dsh-web.service.template) 通过 `--trusted-host` 只传入规范 `dsh.<机器名>.netbird`；不要信任公网 IP、NetBird IP 字面量、兼容别名或其他局域网名称。

## macOS 服务

无头机器使用 LaunchDaemon，使 DSH 无需 GUI 登录即可在开机时启动。本机既有实现记录在 [../dsh-launchd/README.md](../dsh-launchd/README.md)。其 DSH 启动器遵循相同的 loopback-only 命令，nginx 虚拟主机把 80 端口代理到 3080 集成 WebAuth origin，并只在该机器的 NetBird 地址上监听（见「网络门禁」）。

开机启动器是 [../dsh-launchd/launchd/start-dsh-web.sh](../dsh-launchd/launchd/start-dsh-web.sh)，由 [../dsh-launchd/install-dsh-daemons.sh](../dsh-launchd/install-dsh-daemons.sh) 连同规范 authority 生成。`--trusted-host` 必须同时写在这里和运行命令里：重启是按该文件拉起 DSH 的，缺参数的启动器会让所有特权面板的远程访问失效。

在磁盘上修改过的用户 LaunchAgent 会继续使用已加载的旧定义：先 `launchctl bootout gui/$(id -u)/<label>`，再 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist`。`launchctl kickstart -k` 只重启程序，会静默保留旧的 `ProgramArguments`。

nginx 用 `UserName` 声明为普通用户时，master 只能继续持有启动时已拿到的特权端口，绑不了新的 443：reload 会在 `/opt/homebrew/var/log/nginx/error.log` 里留下 `bind() to <NetBird IP>:443 failed (13: Permission denied)`。要提供 TLS 入口就把 master 放回特权身份，并让 worker 保持今天的身份：删掉 plist 的 `UserName`/`GroupName`（master 以 root 启动），在 `nginx.conf` 顶部写 `user leo staff;`，再 `sudo launchctl bootout system/com.leo.dsh-nginx && sudo launchctl bootstrap system /Library/LaunchDaemons/com.leo.dsh-nginx.plist`。顺序不能反：先让 master 能绑 443，再把 TLS 块写进虚拟主机，否则一次冷启动会因为绑不上 443 而整份配置加载失败，连 80 端口入口一起失去。

远程 Mac 必须启用“远程登录”并授权运维 SSH 公钥，才能安装或修复。仅能通过 NetBird 连通并不代表拥有 SSH 权限。

## SSH 公钥免密运维

运维工作站在 `~/.ssh/config` 中维护规范 `nb-<机器名>` 别名：`ssh-studio-mac`、`ssh-laptop-b`、`nb-tx`、`ssh-imac-office`、`ssh-thinkpad-lab` 和 `ssh-tower-lab`。每个别名显式配置用户、私钥、`IdentitiesOnly yes` 和 `BatchMode yes`，因此日常运维不会回退到交互式密码登录。

公钥写入目标账户的 `~/.ssh/authorized_keys`，目录权限为 `0700`，文件权限为 `0600`。私钥只保留在运维工作站，不复制到 peer，也不提交到本仓库。本契约不关闭主机既有密码认证，因为本机恢复策略由各机器管理员拥有。

用以下命令验证所有别名均不弹密码：

```sh
for host in ssh-studio-mac ssh-laptop-b nb-tx ssh-imac-office ssh-thinkpad-lab ssh-tower-lab; do
  ssh -o ConnectTimeout=6 "$host" 'printf "%s@%s\\n" "$(id -un)" "$(hostname)"'
done
```

从 `studio-mac` 调用 `ssh-studio-mac` 时使用 loopback，因为 NetBird 客户端不支持自身地址 hairpin。其余别名使用清单中的 NetBird IPv4 地址。

## NetBird DNS 记录

规范名只使用一套规则：`dsh.<机器名>.netbird`。创建一个启用的自定义 DNS zone `netbird`，为 [machines.json](machines.json) 中每一行加一条 A 记录：记录名为 `dsh.<机器名>`，内容为该 peer 的 NetBird IPv4 地址；把该 zone 分发给包含所有目标客户端的组，并使用 300 秒一类的短 TTL。

分发列表必须覆盖每一个要用规范名字打开入口的客户端，员工的 `u-<用户名>` 组也在其中：zone 按分发组下发，不在列表里的 peer 会得到 `NXDOMAIN`（实测见 [netbird-management.zh.md](netbird-management.zh.md)）。`pnpm dsh-netbird:namespaces --apply` 会为命名空间成员补齐这一项，已连接的机器需要 `netbird down && netbird up` 才会收到新的 DNS 配置。zone 是整体下发的，因此员工也会看到 zone 内的其它名字（不可达）；只让他们拿到 `dsh.*` 名字的做法见控制面文档。

修改服务端 NetBird DNS 数据后，应递增账户 network serial，或使用受支持的 NetBird 管理 API，让已连接 peer 收到新的 network map。不得把 `/etc/hosts` 当作全网事实源。

## 审计

尽可能从另一台已连接的 NetBird 电脑运行仓库审计：

```sh
pnpm dsh-netbird:audit
```

审计逐台检查入口与部署事实。规范域名必须解析到清单地址，且未登录入口符合该机器的 `authMode`：`password` 必须是 `/login` 跳转，`network-gate` 必须是 DSH 文档，声明与部署不一致即失败。DNS 未解析或不匹配、连接失败、nginx 占位页、`502`、集成鉴权未挂载都会失败。

`GET /api/dsh-access/session` 要求 `authority.declared === true`：该读数不需要会话，是运行进程确实信任规范 authority 的证据，而这是所有特权面板（Git、右栏、worktree、SSH、memoir、运行方式、Agent 浏览器）可用前提。姿态状态包括 `authority-trusted`、`authority-untrusted`（缺失或写错 `--trusted-host`）、`access-probe-missing`（目标运行的插件构建还没有该路由，姿态无法验证）和 `access-probe-malformed`。

`GET /worktree/tree` 在不带会话时探测宿主访问围栏：未声明的 Host 拿到 `200` 即泄漏；`password` 机器上规范 Host 不带会话拿到 `200` 同样是泄漏，说明该机器运行的插件构建还早于共享围栏。加 `--skip-posture` 只跑文档探测。

审计还让每台机器自报组合出的目录选择器：`POST /api/directoryPicker/list` 是 browse 后端的动词，返回目录列表即 peer 能驱动的应用内浏览器，返回接缝的 `directory-picker/unavailable` 则按它指明的能力报 `picker-native-unreachable` 或 `picker-capability-missing` 并失败。`password` 机器在到达选择器之前就要求会话，因此报 `picker-not-verifiable`。

`--verify-gate` 通过 SSH 逐台验证「网络门禁」：机器上每个非覆盖网 IPv4 都必须不服务 DSH 入口，任何一个返回登录跳转或 DSH 文档都判定 `gate-leak`。声明 `network-gate` 的机器不跑这一步即 `gate-unverified` 失败：没有现场证据就不能取消密码。

完整部署还要在目标主机检查：

```sh
# DSH Web 只监听 loopback，且 nginx 正在监听。
ss -ltn | grep -E ':(80|3080)\\b'

# 有效 Web profile 启用集成 WebAuth，并保持 noBrowserAuth 为 false。
dsh --profile web --dump-config | grep -A4 -B1 'id: web-all'

# 运行中的命令通过 --trusted-host 信任规范 authority。
ps -o command= -p "$(launchctl print gui/$(id -u)/<label> | awk '/pid =/{print $3; exit}')"

# 开机启动器带着同一个参数，重启后远程访问才不丢。
grep -- '--trusted-host' "$DSH_HOME/bin/start-dsh-web.sh"

# 账户文件存在且仅 owner 可访问。
stat "$DSH_HOME/remote-web-ui-accounts.json"
```

不得把账户密码、bootstrap 密码、会话 cookie、API key 或生成的 DSH 启动 token 写入 [machines.json](machines.json)、文档、nginx 文件或服务单元。

## 故障诊断

| 现象 | 含义 | 修复 |
| --- | --- | --- |
| DNS 无法解析 | NetBird 自定义 zone/record 缺失或未分发 | 修复 zone 并分发新的 network map。 |
| 拒绝连接或超时 | nginx 缺失、绑定错误或被拦截 | 恢复目标 NetBird 接口上的 80 端口监听。 |
| `502 Bad Gateway` | nginx 无法访问 DSH Web | 确认 DSH 正在运行，且 3080 仅在 loopback 监听。 |
| nginx 欢迎页或无关站点 | 规范 Host 不在预期虚拟主机中 | 只把 `dsh.<机器名>.netbird` 加入DSH 虚拟主机并 reload nginx。 |
| 登录重定向循环 | 集成 WebAuth 未启用或会话 cookie 无法返回 | 保持 `noBrowserAuth: false`、启用 `integratedAuthEnabled`，并检查 Host、scheme 与 cookie 作用域。 |
| 登录成功但高权限 API 失败 | 请求使用非 admin 账户或进入错误代理路径 | 检查账户角色、cookie domain、Host header 和 `80 -> 3080` 路径。 |
| 登录后 `/api` 返回 `403 Forbidden` | 围栏拒绝了浏览器 authority：DSH 未信任规范 Host | 在 DSH 命令行加入 `--trusted-host dsh.<机器名>.netbird`，重载服务单元，并确认运行进程带上该参数。 |
| 右栏面板报 `loopback same-origin access only`，或 Git 管理只显示 `Git 操作失败：…` | 宿主访问围栏拒绝了请求：浏览器 authority 不在运行进程的 `--trusted-host` 列表中，或该浏览器没有有效 DSH 会话 | 用规范 `dsh.<机器名>.netbird` 地址重新登录后重试；确认运行进程带 `--trusted-host <该 authority>` 且 `noBrowserAuth` 为 false。 |
| 审计对某台机器报 `authority-untrusted` | 运行进程没有声明该机器的规范 authority，该机器所有特权面板都返回 403 | 在开机启动器里补 `--trusted-host dsh.<机器名>.netbird`，重载服务后重跑审计。 |
| 远程入口打开设置 → 模型报 `settings are unavailable in this browser` | 页面没有声明 Host 所有权：插件构建还没有远程访问 boot 行，或该 authority 未被声明 | 部署包含 remote-access 服务域的构建，确认 authority 参数，然后用规范地址重新加载。 |
| 复制按钮失效，或每个远程标签页各开一条 Git 流 | 明文 HTTP 远程入口不是浏览器安全上下文：`navigator.clipboard` 与 `navigator.locks` 缺失 | 插件已注入剪贴板 shim 与 `crypto.randomUUID` polyfill；需要完整浏览器能力时使用受信证书的 HTTPS 入口。 |
| 语音输入报「当前浏览器不支持录音，请使用支持麦克风的浏览器」 | 页面不是安全上下文：官方语音输入插件在 `navigator.mediaDevices` 缺失时给出的就是这句，而它只在 HTTPS（或 loopback）下存在；页面侧的 polyfill 代替不了真实授权 | 用 `https://dsh.<机器名>.netbird/` 打开该机器（见「TLS 入口」），并确认该客户端已装根证书；桌面客户端用 fleet 入口时同理，它只对本机 loopback 那一行天然可用。 |
| 未声明 Host 也能读到 worktree/工作区数据或 `/api/pair/*` | 该机器运行的插件构建里，读接口或配对围栏还早于共享宿主访问围栏 | 升级该机器的 `@dsh-cove/dsh-web-all`：特权读接口同样走围栏，`/api/pair/*` 另外要求 Host 为 loopback。 |
| 登录成功但页面白屏，资源报 `ERR_INCOMPLETE_CHUNKED_ENCODING` | nginx 尝试使用无权访问的代理临时路径，导致大型 JavaScript 响应被截断 | 恢复 `proxy_buffering off;`，检查并 reload nginx，然后确认核心 `/assets/*.js` 响应完整结束。 |
| 发送图片或任何大请求体报 `HTTP 500 (gateway/internal)`，短消息正常 | nginx 无法把请求体落到 worker 临时路径：路径位于 worker 用户无法穿越的用户目录下，超过内存缓冲的请求体因此必然失败 | 按 [nginx.conf.template](nginx.conf.template) 把 `client_body_temp_path` 与 `proxy_temp_path` 等临时路径固定到用户目录之外，先以 root 建好父目录，再 `nginx -t` 并 reload。 |
| 长会话（攒了多张截图）中途报 `400 ... Download multimodal file timed out`，重试同一轮仍可能再报 | 每次请求都会重发历史里的全部图片，上游（DashScope 侧）要按约 60 秒的时限重新取一遍；DSH 只在整包超过 router 的 `maxRequestImageBytes` 时才会把最旧的图换成文字占位，上限高于上游时限时这层保护永不触发 | 把当前 [llm-models.patch.yml](llm-models.patch.yml) 的 router 块（整包 1MiB）并入该机器 profile，重启 dsh web；需要更多图进上下文时按该文件注释上调。 |
| 页面以约 10–15 秒固定间隔显示断连并重连 | `/api/remote.mux` 的默认两秒 Pong 截止时间对 overlay 网络和繁忙主机过于激进 | 将 `typert-gateway.config.websocketHeartbeatIntervalMs` 恢复为 `30000`，由机器管理员重启目标 DSH 服务，再确认 WebSocket 在至少两个心跳周期内持续打开。 |
| 远程入口里点「选择目录」长时间挂起，最终在 `/api/directoryPicker/pick` 上报 `HTTP 504` | 该机器组合的是 OS 选择器：对话框开在宿主屏幕上，peer 既看不到也无法回答，请求一直等到 nginx 放弃 | 按「目录选择器」把 [cordis.patch.yml](cordis.patch.yml) 里的 browse 这一对并入该机器 profile；运行中的宿主经 HMR 监听该文件时当场生效，否则由机器管理员重启 dsh web，再用 `pnpm dsh-netbird:audit` 确认 `picker-browse`。 |
| 审计报 `gate-leak` | 该机器在某个非覆盖网地址上仍然服务 DSH 入口 | 按「网络门禁」把虚拟主机 `listen` 改到该机器的 NetBird IPv4，Linux 再加接口级防火墙规则，然后重跑 `--verify-gate`。 |
| 审计报 `undeclared-host-leak` 或 `session-fence-missing` | 宿主访问围栏未生效：插件构建早于共享围栏，或该机器仍用 socket-only 判定 | 升级该机器的 `@dsh-cove/dsh-web-all` 到带共享围栏的构建并重启 dsh web。 |
| 审计报 `gate-unverified` | 声明了 `network-gate` 却没有现场验证门禁 | 从能 SSH 到该机器的工作站跑 `pnpm dsh-netbird:audit --verify-gate`；门禁无法验证就不要取消密码。 |
| 审计报 `auth-mode-mismatch` 或 `no-browser-auth-exposed` | 清单声明与部署不一致：声明 `network-gate` 却仍跳登录，或声明 `password` 却直接返回文档 | 对齐 `authMode`、`noBrowserAuth` 与门禁状态三者。 |
| `nginx -t` 报 `duplicate upstream` 且指向 `.bak` 文件 | 备份文件落在 `include servers/*` 目录里，被当作第二个配置文件加载 | 把备份放到 include 目录之外，例如同级的 `backups/`。 |

## 添加电脑

1. 把 NetBird peer 名称、地址与 `authMode` 加入 [machines.json](machines.json)。
2. 在 NetBird 自定义 DNS zone `netbird` 中加一条 `dsh.<机器名>` A 记录，指向该 peer 的 NetBird IPv4 地址。
3. 缺少时安装 DSH 与 `@dsh-cove/dsh-web-all`；确认该构建包含远程访问契约（`/web-all/remote-access/boot.js` 与 `/api/dsh-access/session`），审计的 `authority-trusted` 即其证据。
4. 通过 loopback 或一次性 bootstrap 配置创建首个管理员，然后移除 bootstrap 密码。
5. 选择鉴权模式：`password` 启用集成 WebAuth 并保持 `noBrowserAuth` 为 false；要免密码就声明 `network-gate`，并以第 7 步的门禁验证为前提。
6. 把 [cordis.patch.yml](cordis.patch.yml) 的公共行（WebAuth、WebSocket 心跳、目录选择器组合）并入该机器的 Web profile，再安装持久、loopback-only 且带 `--trusted-host dsh.<机器名>.netbird` 的 DSH 服务。
7. 安装 nginx 虚拟主机：`listen` 写该机器的 NetBird IPv4，按模板把 worker 临时路径固定到用户目录之外（先以 root 建好父目录），Linux 另加接口级防火墙规则（见「网络门禁」）。
8. 从另一 peer 运行 `pnpm dsh-netbird:audit --verify-gate`，并在目标机确认服务持久化。

仅有 DNS 不代表电脑已可用。只有规范域名、鉴权模式与部署一致、loopback 隔离、门禁在覆盖网之外不可达和开机持久化全部通过，才能标记为可用。

## 安全限制

规范入口目前在私有 NetBird overlay 内使用明文 HTTP。密码和会话 cookie 因此依赖 mesh 边界保护，而不是应用层 TLS。不得把这些名称或监听器发布到公网；信任边界超出私有 overlay 时必须启用网关 TLS。

`network-gate` 机器把覆盖网成员资格变成唯一凭据：设备丢失、setup key 泄漏或某个 peer 被入侵，等同于拿到该网络内所有机器的特权面板。NetBird ACL、setup key 轮换和设备清单因此属于这一模式的安全边界。

## 许可证

Apache-2.0。

## 已知限制

审计不会执行带凭据的登录，因为凭据明确排除在仓库之外。它验证未登录 WebAuth 边界并发现常见代理/鉴权故障；带凭据登录仍属于目标主机验收步骤。

部署模板不会直接编辑自托管 NetBird 数据库。DNS 变更应使用受支持的管理 API 或控制台；直接维护数据库必须先做外部备份，并经过服务专属运维评审。

固定组合 browse 后，机器自己的本机浏览器（`127.0.0.1:3080`）也用应用内目录浏览器而不是 OS 选择器：一次启动只组合一种交互，而规范远程入口必须能选目录。

部分 NetBird 客户端不会 hairpin 自身流量，本机可能无法连接自己的 NetBird 地址。应从另一 peer 验证规范地址，本机只用 loopback 做诊断。

## 安装

本目录不是安装器。按上面的平台章节操作、显式替换模板占位符，并把机器专属 secret 留在仓库之外。

## 配置

[machines.json](machines.json) 是非敏感清单；[cordis.patch.yml](cordis.patch.yml)、[llm-models.patch.yml](llm-models.patch.yml)、[nginx.conf.template](nginx.conf.template) 和 [dsh-web.service.template](dsh-web.service.template) 定义共享配置契约。

控制面操作（DNS zone 与记录、路由、分组、setup key）与全网域名契约见 [netbird-management.zh.md](netbird-management.zh.md)。集群运维工作流（清单、审计、添加电脑、跨机 dsh 访问）加载 [dsh-netbird-ops skill](../../.agents/skills/dsh-netbird-ops/SKILL.md)。控制端属于自己的运维从 [self-hosted.zh.md](self-hosted.zh.md) 开始：那里写明已发布客户端对服务端的要求，并链到 [selfhosted/](selfhosted) 下的模板。

## 能力

本目录统一私有 NetBird 中每台电脑的 DSH 地址、代理拓扑、覆盖网门禁、鉴权归属、服务持久化和可重复健康检查。
