# 远程访问契约

本文件是 dsh-cove 远程可访问性的长期事实源：一台电脑的 DSH Web 经私有 NetBird 网络暴露给其他设备时，哪些不变量必须成立、如何用命令与测试证明它们、以及新增能力时必须遵守什么。

地址、DNS、nginx 拓扑、机器清单与滚动重启属于 [tools/dsh-netbird/README.md](../tools/dsh-netbird/README.md)；插件侧的路由与围栏行为属于 [packages/dsh-web-all/README.md](../packages/dsh-web-all/README.md)；本文件只写两者共同成立的验收契约。文中 `dsh.<机器名>.netbird`、机器清单与审计命令以自托管参考部署为例，示例清单与地址均为脱敏数据，按自己的网络替换。

## 流量路径

```text
浏览器 -> http://dsh.<机器名>.netbird/  -> nginx :80（只绑该机器的 NetBird 地址）-> 127.0.0.1:3080 (dsh web)
浏览器 -> https://dsh.<机器名>.netbird/ -> nginx :443 ssl（同一个虚拟主机）        -> 127.0.0.1:3080 (dsh web)
```

反向代理连接 loopback，因此**每个远程请求的 socket 都是 loopback**，浏览器真实来源只体现在 Host 头。任何只检查 socket 的本地判定在远程访问下都等于没有判定。

入口监听面（只对覆盖网开放的 80 与 443 端口）、逐台门禁与 TLS 材料属于 [tools/dsh-netbird/README.md](../tools/dsh-netbird/README.md#overlay-gate)（证书与部署见同页 [TLS entry](../tools/dsh-netbird/README.md#tls-entry)）。

## 不变量

1. **启动参数携带规范 authority**：`dsh web --host 127.0.0.1 --port 3080 --no-open --trusted-host dsh.<机器名>.netbird`。`ctx.webRuntime.trustedHosts` 由 `--trusted-host` 与绑定 `0.0.0.0` 时推导的 LAN 字面量组成；绑定 loopback 且缺参数时该列表为空，所有特权宿主路由对远程浏览器返回 403，Git 管理面板显示 `Git operation failed: 403 Forbidden`。启动器模板见 [tools/dsh-launchd/launchd/start-dsh-web.sh](../tools/dsh-launchd/launchd/start-dsh-web.sh)，安装器见 [tools/dsh-launchd/install-dsh-daemons.sh](../tools/dsh-launchd/install-dsh-daemons.sh)。
2. **特权宿主路由走同一围栏**：socket 必须 loopback，Host 必须是 loopback 或已声明 authority 且携带有效 DSH 浏览器会话，并始终要求同源标记。新路由族必须解析 `accessTrustOf(ctx)`；自带的 socket-only 判定、只读接口的豁免、以及把 `--trusted-host` 之外的 authority 当成受信都属于缺陷。
3. **远程页面声明 Host 所有权**：`GET /web-all/remote-access/boot.js` 以 parser-blocking 的 `<script src>` 在每次首页响应中逐请求决定是否写入 `__DSH_TRANSPORT__.ownsHost`。缺这一步时 DSH 客户端把设置面降级为进程内存态，设置 → 模型报 `settings are unavailable in this browser`，提供商目录、账号页与配置文件入口同时为空。该脚本只对通过围栏的请求声明所有权，并且是这个声明的唯一所有者：按部署注入（与请求 Host 无关）的脚本不得声明 `ownsHost`，否则未声明 authority 的页面也会拿到特权设置面，那一行的 no-op 决定会被静默压掉（客户端只读 `__DSH_TRANSPORT__.ownsHost` 这一个字段）。客户端另有逐请求兜底探测（`/api/dsh-access/session` 的 `owners`），合法入口不会因此失去设置面。
4. **只读暴露面同样受限**：仓库路径、分支与 worktree 索引（`GET /worktree/tree`、`POST /worktree/lane`）、工作区预设（`/workspace-model/list|get`）、运行方式任务列表（`GET /api/schedule-mode/tasks`）、运行结束通知源（`GET /api/dsh-notify/feed`，只读且不含会话正文）、飞书凭据向导（`/lark-inbox/wizard/*`）与配对令牌管理（`/api/pair/*`，额外要求 Host 为 loopback）都必须走不变量 2。唯一例外是 Codex 桥（`/api/dsh-codex-bridge/*`）：设备码登录与代理控制按设计仅限本机，远程入口显示不可用属于预期。`GET /api/dsh-access/session` 是不变量 6 要求的无会话姿态入口，只返回 `authority`（不含令牌、不含 authority 清单）供审计发现缺失 `--trusted-host` 的机器；`session` 位仅在调用方已通过围栏时计算。
5. **明文 HTTP 不是安全上下文**：远程入口没有 `crypto.randomUUID` 与 `navigator.clipboard`，插件在首页注入 polyfill 与 execCommand 后备的剪贴板 shim；`navigator.locks` 无法补齐，Git 图的跨标签 SSE 共享在远程入口降级为每标签一条流（同标签内仍共享）。需要真实授权的能力不能靠页面补齐：`navigator.mediaDevices` 在非安全上下文里不存在，官方语音输入插件据此报「当前浏览器不支持录音」，所以这一类能力只能在 `https://dsh.<机器名>.netbird/`（受信证书的 HTTPS 入口）或 loopback 入口上使用。
6. **审计覆盖权限姿态与门禁**：`pnpm dsh-netbird:audit` 除未登录首页外还判定该机器声明的 `authMode`、探测 `GET /api/dsh-access/session` 要求 `authority.declared === true`、并用 `GET /worktree/tree` 在无会话下探测宿主访问围栏。缺少姿态路由时报 `access-probe-missing`，缺 `--trusted-host` 报 `authority-untrusted`，围栏未生效报 `undeclared-host-leak` 或 `session-fence-missing`；加 `--verify-gate` 时还逐台验证覆盖网之外没有地址服务 DSH 入口。
7. **入口只对覆盖网开放**：nginx 虚拟主机的 80 端口绑定该机器的 NetBird IPv4，公网、办公内网与家庭内网都连不上；Linux 另需接口级防火墙规则，因为内核按本地地址交付。声明 `network-gate`（即 `noBrowserAuth: true`，取消密码）的机器必须先通过 `--verify-gate`，否则审计以 `gate-unverified` 拒绝。
8. **远程入口不组合 OS 选择器交互**：目录选择驱动宿主文件系统，而远程浏览器够不到宿主屏幕。机器 profile 固定组合 browse 这一对（`@deepseek-ai/dsh-host-directory-picker-browse` 后端加 `@deepseek-ai/dsh-client-ui-directory-picker-browse` 浏览器面），不要用出厂的自适应选择器：它只读绑定地址与启动方式，在本拓扑（loopback 绑定、nginx 在前、非 SSH 启动）必然判定 `native`，peer 的 `directoryPicker/pick` 于是在宿主屏幕上打开对话框并一直等到代理放弃（HTTP 504）。组合结果本身可判定：`POST /api/directoryPicker/list` 是 browse 的动词，返回目录列表即远程可驱动的交互。

## 验证

```sh
# 仓库门禁：围栏、所有权脚本、剪贴板/uuid 注入、审计分类器、TLS 材料与静态围栏门禁
pnpm --filter @dsh-cove/dsh-web-all test
pnpm test:scripts
node --test tools/anywhere-agent/test/*.test.mjs

# 全线权限姿态（未登录首页 + 规范 authority 是否被信任）
pnpm dsh-netbird:audit

# TLS 入口：逐台做一次真实握手（链 + 主机名）
pnpm dsh-netbird:tls verify --host dsh.<机器名>.netbird --ip <NetBird IP>
```

审计的第 7 项探针（`POST /api/directoryPicker/list`）逐台判定目录选择交互：browse 返回目录列表，组合成 `native` 即报 `picker-native-unreachable`；`password` 机器在到达选择器之前就要求会话，报 `picker-not-verifiable`。

单台机器可用带 Host 的 loopback 请求复现围栏判定：

```sh
# 已声明 authority：200（noBrowserAuth）或 403（需要会话）
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' \
  -H 'Host: dsh.<机器名>.netbird' -d '{"path":"/repo"}' http://127.0.0.1:3080/git/status
# 未声明 Host：必须 403 且返回 {"error":"forbidden: loopback-only"}
curl -s -X POST -H 'Content-Type: application/json' -H 'Host: evil.example' \
  -d '{"path":"/repo"}' http://127.0.0.1:3080/git/status
```

浏览器验收（需要受管 DSH 服务重启到包含本次插件的构建后执行）：打开 `http://dsh.<机器名>.netbird/`，确认设置 → 模型列出提供商目录、任一复制按钮可用、Git 管理与右栏面板不报 `forbidden`。

TLS 入口验收：`pnpm dsh-netbird:tls verify` 逐台确认链与主机名；客户端侧打开 `https://dsh.<机器名>.netbird/` 后确认语音输入可用（即页面里 `navigator.mediaDevices` 存在）。桌面客户端可用 `node tools/anywhere-agent/poc/tls-entry.mjs` 在本地把两个入口的差异跑出来：明文入口 `isSecureContext=false` 且 `navigator.mediaDevices` 缺失，TLS 入口两项都成立。

## 变更纪律

- 新增宿主路由族：接入 `accessTrustOf(ctx)` 并在 `packages/dsh-web-all/tests` 增加「伪造 Host / 无会话 / 规范 authority + 会话 / loopback」四种拓扑用例。静态门禁 [scripts/service-fence-contract.test.mjs](../scripts/service-fence-contract.test.mjs) 会拒绝未登记的路由目录与 socket-only 的本地回环判定；新目录必须在该文件的固定表里登记其围栏 token。
- 新增首页注入：只通过 `src/host/services/remote-access/` 注入，路径与常量与浏览器半边共享 [paths.ts](../packages/dsh-web-all/src/core/remote-access/paths.ts)。
- 改动机器清单、启动器、nginx 拓扑或机器 profile 的组合行：同步 [tools/dsh-netbird/README.md](../tools/dsh-netbird/README.md) 并运行 `pnpm dsh-netbird:audit`。
- 改动 TLS 入口：同时更新 [tools/dsh-netbird/nginx.conf.template](../tools/dsh-netbird/nginx.conf.template) 的 TLS 块与同页 README 的 TLS 入口一节，并对每台机器跑一次 `pnpm dsh-netbird:tls verify`。
- 修改应用户可见行为的服务重启由用户执行；agent 不重启受管服务。
- 远程入口的漏洞按 [SECURITY.md](../SECURITY.md) 私下报告；未修复的围栏绕过不要开公开 Issue。