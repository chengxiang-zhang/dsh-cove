# NetBird 管理端运维

[English](netbird-management.md)

自建 NetBird 管理端的运维事实源。机器清单、`dsh.<机器名>.netbird` 地址契约与健康审计在本目录的 [README.zh.md](README.zh.md) 与 [machines.json](machines.json)；本页覆盖控制面：认证、自定义 DNS、路由、分组与 setup key。文中的事实来自对现有设备的实际操作；当端点与控制台不一致时，以控制台为准并更新本页。

## 访问与认证

- 管理端：`https://netbird.example.com:443`。
- API base：`https://netbird.example.com/api`。
- 认证：管理控制台签发的个人访问令牌（PAT），以 bearer token 传入。令牌不进仓库、不进 shell 历史，优先用专用环境变量。

```sh
export NETBIRD_MGMT_TOKEN=<从控制台获取>
curl -fsS -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" \
  "https://netbird.example.com/api/peers"
```

## 统一 SSO 与员工命名空间

员工用统一 SSO（Casdoor）登录，在同一个账户内以「每人一个私有组」实现：**只能看到并访问自己接入的机器**。

- IdP：Casdoor 自建在 `tx` 上，issuer `https://sso.example.com`（容器 `casdoor` + `casdoor-db`，凭据与运维信息见该机 `/opt/casdoor/README.txt`）；NetBird 侧以通用 OIDC 接入（IdP id `db7j5a6keeas73e8cng0`）。
- 入网链路（已实测）：员工在机器上运行 `netbird up` → 客户端走 Dex 的 device flow（打印 `user_code`）→ 浏览器经 Casdoor 登录确认 → `/oauth2/callback` → `/oauth2/device/callback` → 客户端轮询拿到令牌，peer 的 `user_id` 即为该员工。
- 隔离模型：`ops` 组持有全部机群机器；员工每人一个 `u-<user>` 组加一条 `self-<user>` 策略（组内双向、任意协议）。**任何启用策略都不得引用 `All` 组**：实测一旦引用，账户内全部 peer 都会进入每个人的网络地图（名字可见），因此 `ops-full-access` 等运维策略的源与目标都写 `ops`。
- 机队 DNS 与员工入口：`dsh.<机器名>.netbird` 只在客户端收到 zone `netbird` 时才能解析，而该 zone 按分发组下发。一个只在 `u-<user>` 组里的 peer 对 `dsh.<机器名>.netbird` 得到 `NXDOMAIN`；把该组加入 zone 的分发组并让客户端重连后解析为清单地址，peer 集合仍是 `0/0`、向该地址的连接被拒（`Host is unreachable`）。也就是说 DNS 名称是账户级的、访问仍按策略隔离。**所以员工的命名空间包含 DNS 分发**，`pnpm dsh-netbird:namespaces --apply` 会一并完成；已连接的机器需要 `netbird down && netbird up` 才收到新的 DNS 配置。
- DNS 的两个已验证约束：NetBird 拒绝同域名的第二个 zone（`POST /api/dns/zones` 返回 `409 zone with domain netbird already exists`），因此无法给每个员工建一个同域的精简 zone；而**子域 zone 可以共存**（例如 domain `tower-lab.netbird`，创建返回 200），所以「只让员工拿到 `dsh.*` 名字」要靠把非 DSH 记录拆进 `tower-lab.netbird`、`thinkpad-lab.netbird` 这类子域 zone（仅分发给 `ops`），代价是要另用记录接口补记录（创建 zone 时随带的 `records` 不会落库）。
- 账户设置：`regular_users_view_blocked` 必须为 `false`，否则 `user` 角色连自己的 peer 都看不到（`GET /api/peers` 返回空数组）；`user_approval_required` 保持开启作为准入闸门；`peer_login_expiration` 为 7 天。
- 自动化：`pnpm dsh-netbird:namespaces`（默认 dry-run，`--apply` 写入）为已审批成员补齐组、策略与 zone 分发；`--no-zone-access` 只跳过 DNS，`--revoke-zone-access` 只回收（不会顺手再分发）。目标 zone 由 `machines.json` 的 `domainPattern` 推导，改名不会让它指向错误的 zone。用户组传播已开启，给用户设置 `auto_groups` 会自动下发到该用户已有的全部机器。
- 运维访问：默认**不授予**。需要 IT 直达员工机器时用 `--with-ops-access` 生成 `ops-manage-<user>`（单向 ops → 该员工组）；代价是该员工客户端会列出 `ops` 组内所有机器的名字（仍不可达），用完执行 `--revoke-ops-access` 收回。
- 隔离结论（3 个账号 4 台机器）：员工自己的机器互通 0% 丢包；跨员工双向 `Required key not available`；员工到机群 100% 丢包或密钥缺失；员工客户端的地图只含自己命名空间的机器（`2/2`）；员工在面板只看到自己的 peer；机群侧（`ops`）连通性与各机器 DSH 入口不受影响。

### 飞书登录链

一条链、四段，现状是**前三段已通、第四段卡在飞书控制台**：

```
App/面板 → NetBird Dex(/oauth2/auth) → Dex connector「Casdoor SSO」→ Casdoor 应用 netbird
        → Casdoor provider「provider_feishu」→ 飞书应用 cli_REPLACE_WITH_FEISHU_APP_ID
```

- NetBird 侧：登录页（`/oauth2/auth`，scope 含 `groups`）给出「Continue with Email」与「Continue with Casdoor SSO」两个连接器。connector 存在内嵌 IdP 的 `connector` 表（Dex 存储 `idp.db`）：`id=db7j5a6keeas73e8cng0`、`type=oidc`、`issuer=https://sso.example.com`、`clientID=netbird-mgmt`、`redirectURI=https://netbird.example.com/oauth2/callback`，`clientSecret` 与 Casdoor 应用 `netbird` 的 secret 一致（已比对），`insecureSkipEmailVerified=true`、`insecureEnableGroups=true`。
- App 侧不需要改动：`Portal.loginSSO` 返回的是 `netbird-cli` 客户端的授权 URL——`redirect_uri=http://localhost:53000/`、`prompt=login`、`scope=openid profile email groups`（在模拟器上实测得到）。`prompt=login` 保证每次都进连接器选择页，所以飞书链修好后**无需发版**。
- Casdoor 侧：应用 `netbird`（`client_id=netbird-mgmt`，org `example-org`）挂了 provider `provider_feishu`（`category=OAuth`、`type=Lark`、`method=Normal`、`client_id=cli_REPLACE_WITH_FEISHU_APP_ID`、`disable_ssl=false`），`signin_methods` 为 Password + `provider_feishu`；登录页因此渲染出飞书按钮（浏览器实测）。Casdoor 的两个 Lark 特性：**`disable_ssl` 同时兼作「飞书/国际版」开关**（`false` → `open.feishu.cn`，`true` → `larksuite`），所以这里必须为 `false`；授权地址由前端拼成 `…/open-apis/authen/v1/index?app_id=…&redirect_uri=…&state=…`，换码由 Go 侧用 `tenant_access_token` 作 Bearer 调 `/open-apis/authen/v1/access_token`（实测被接受：bogus code 返回 `20003 code is invalid`，而非 token 错误）。
- 飞书侧唯一未完成项：应用目前只有 `bot` 能力（`app_versions` 里 `abilities={"bot":{}}`）、`redirect_urls` 为空。需要开「网页应用」能力并把 `https://sso.example.com/callback` 加进「安全设置 → 重定向URL」，否则授权接口返回 `20029 redirect_uri 请求不合法`（实测错误页 + 日志 ID）。**这一步只能用控制台，没有 API 替代**：应用信息接口 `PATCH /open-apis/application/v6/applications/:app_id` 的请求体只有 `common_categories`、`allow_refresh_token`、`callback_info`，**根本没有 `redirect_urls` 字段**（官方文档实测核对）；该接口缺 `application:application` 权限而报的 `99991672` 是权限检查先于字段校验，补齐权限也改不了重定向URL。
- 无管理员登录时改 Casdoor 配置的办法：直接写库（`provider` 插一行，改写 `application.providers` 与 `application.signin_methods`），**改完不需要重启**（`GET /api/get-application?id=admin/netbird` 立即返回新 provider）。Casdoor 的 `client_credentials` 未启用，所以没有免登录的 API 路径；管理员密码在 `/opt/casdoor/README.txt`（已修正为 0600）。
- 与隔离的关系：飞书登录后 Casdoor 用用户信息里的 `email`（缺失时回退 `enterprise_email`）匹配既有账号，NetBird 再按同一邮箱匹配用户。因此**要用飞书登录拿到机队权限，飞书账号的邮箱必须等于该 NetBird 用户的邮箱**（例如 `i@example.com`）；邮箱对不上会新建用户，而新用户没有 `auto_groups`，入网后仍看不到任何机器。

### 登录页主题

Casdoor 登录页现在按 **Anywhere Work** 呈现：左侧深蓝品牌栏（图标 + 产品名 + 副标题 + 三条要点）、右侧登录卡、页脚换成我们自己的文案，官方「Powered by Casdoor」与「立即注册」都已去掉。用的是 App 自己的启动图标，不另造品牌资产。

- 本版本**真正生效**的字段（对着已发布的前端产物核实过，其余字段改了也不会到页面）：`application.title`（标签页标题）、`logo` / `logo_dark` / `favicon`、`theme_data`（`{themeType,colorPrimary,borderRadius,isCompact,isEnabled}`，喂给 CSS 变量）、`form_offset`（**只有 = 4 时才渲染 `form_side_html`**，容器类名 `.side-image`）、`form_css`（注入 `<style>`，可用钩子 `.side-image` / `.login-panel` / `.login-logo-box`）、`footer_html`（**整块替换**内置页脚，不是追加）。自定义 HTML 经消毒后注入（`p` 组件 + `dangerouslySetInnerHTML`），`<script>` 会被剥离；内联 `style` 会保留。
- 资产放在 **SSO 同源目录**：`/www/wwwroot/sso-brand/{logo.png,favicon.png}`，由 sso vhost 的 `location /brand/` 提供（`/www/server/panel/vhost/nginx/sso-casdoor.conf`）。**不要放进 `/www/wwwroot/apk`**：`scripts/publish.sh` 整目录原子替换，品牌文件会被一起删掉。图标源文件是 App 的 `mipmap-xxxhdpi/ic_launcher.png`（192×192），用 `sips -z 64 64` 缩出 favicon。
- 一键复现：[casdoor-theme.sql](casdoor-theme.sql)（DB 直写；Casdoor 逐请求读库，**不需要重启**）。
- 两个开关，别搞混：**关自助注册要用 `disable_self_signup=true`，不能用 `enable_sign_up=false`**。Casdoor 的 OAuth 分支（`controllers/auth.go` 的 "Sign up via OAuth"）要求 `enable_sign_up` 为真，关掉它会连「飞书登录一个还不在 Casdoor 里的账号」一起拒掉；`disable_self_signup` 只关密码自助注册（登录页不渲染注册链接，注册页没有邀请码直接拒绝），provider 登录仍可正常开户。之所以要去掉自助注册：自造身份没有 `auto_groups`，登录后会看到一个空列表。已经预建的账号仍能在登录时绑定（Lark 对任何非空邮箱都报 `EmailVerified`，默认绑定规则先 Email 后 Phone）。`enable_password` 仍为真，保留本地密码登录作为飞书之外的兜底，等飞书端到端验证通过后可一行关掉。
- 验证方式：1280×720（浅色 + 深色）与 390×844 三个视口截图逐一核对，确认左栏、卡片、页脚、无重复 logo、无注册入口。
- 窄屏读的是**另一个 CSS 字段**：`AuthLayout` 按视口选 `form_css_mobile` 而不是 `form_css`，左栏与 `form_side_html` 在窄屏也不渲染。只设 `form_css` 时，手机拿到的是 Casdoor 原生表单（用户名 + 密码 + Sign In，飞书只是个图标）。两个字段都写之后，1280×720、390×844 与 App 内 GeckoView（实测 1080×2400 深色）**三处都是飞书优先 + 页脚切换密码**；注入的提示与页脚恒为中文，Casdoor 自身的表单文案跟随设备语言。窄屏的 logo 用 `display_name`、桌面用 `title`，两者都已设为 Anywhere Work。

### 登录方式与 NetBird 自带登录的停用

**只保留两种登录方式**，且默认走飞书；NetBird 自己的邮箱/密码连接器已移除，鉴权统一交给 Casdoor。

- 两种方式：`enable_password=true` + `signin_methods=[{"Password"},{"provider_feishu"}]`；`enable_code_signin` / `enable_web_authn` / `enable_guest_signin` 全为 false，`disable_self_signup=true`（自助注册关闭）。
- 默认飞书、可切密码：`form_css` 把 provider 行重排成整行主按钮（图标用 `filter: brightness(0) invert(1)` 反白 + 文案「使用飞书登录」），密码表单默认 `display:none`；页脚注入的复选框配 `:has(#aw-pw:checked)` 切换成账号密码，切换后页脚文案变「改为飞书登录」。**Casdoor 对通用 OAuth provider 只渲染图标**，它的「登录方式页签」只覆盖 Password / 验证码 / WebAuthn / 微信，没有原生页签可用；隐藏规则必须带 `!important`，否则 Tailwind 的 `display` 工具类会赢。
- 停用 NetBird 自带登录：配置项 `server.auth.localAuthDisabled: true`（`/opt/netbird/config.yaml`，bind mount 进容器，**改动需要重启 `netbird-server` 容器**）。启动时执行 `DisableLocalAuth`：日志出现 `local authentication disabled - only external identity providers can be used`，Dex 的 `connector` 表里 `local` 那行被删除（只剩 `oidc` 的 Casdoor 连接器），而 `password` 表里的本地账号**保留**，改回 `false` 重启即可再次使用。
- 只有一个 connector 之后，Dex 不显示「选择登录方式」：`/oauth2/auth` 直接 302 到 Casdoor，面板与 App（带 `prompt=login`）都直达我们的登录页。
- 源码依据（v0.78.1）：`management/server/idp/embedded.go` 里 `LocalAuthDisabled` 的注释，以及 `NewEmbeddedIdPManager` 会校验「没有其它 connector 时不允许关闭本地登录」；YAML 键名取自 `combined/cmd/config.go` 的 `yaml:"localAuthDisabled"`。
- 回滚一行：把 `localAuthDisabled` 改回 `false` 并重启容器。
- 影响与前提：面板登录从此**依赖 Casdoor**。Casdoor 控制台（内置应用）与管理员密码不受影响、可独立登录，所以不会锁死；机队数据面不受影响（本次重启后 6 个 DSH 入口仍全部 200）。

### 面板登录回调路径

dashboard 容器是 Next.js 静态导出，自身规则为 `try_files $uri $uri.html $uri/ =404`，**没有 SPA 回退**；而 Dex 给 dashboard 客户端的 `redirect_uri` 是 `/nb-auth`（静默续期用 `/nb-silent-auth`），这两个路径都不存在对应 HTML 文件，只有 Next.js 的 `404.html` 会加载应用外壳。因此 tx 的 `netbird_proxy.conf`（`/www/server/panel/vhost/nginx/`）在 443 server 里显式接住这两个回调路径并直接返回应用外壳（`proxy_pass http://netbird_dashboard/index.html;`，nginx 保留查询串，浏览器 URL 仍是 `/nb-auth`，前端按该路由处理 code）。官方 dashboard 仓库的 `docker/default.conf` 同样是这条 `try_files`，所以这里的显式路径是必需的而不是可选的；外层 nginx 的 `location /` 只是 `proxy_pass http://netbird_dashboard;`。

### 按用户隔离：身份分离、自动配组、容器化实测

**身份分离**：管理员与飞书身份必须是不同的 NetBird 用户。当前账户里是三类身份：

- `owner-sample`（`idp=local`，owner）：NetBird 自带登录的账号；因 `localAuthDisabled` 已停用而**不可登录**，仅作为 owner 保留。
- `admin-sample`（`idp=db7j5a6keeas73e8cng0`，**admin**，`auto_groups=[ops]`）：管理员的**可登录**身份，走 Casdoor「账号密码」，与任何飞书身份都是不同用户。Casdoor 侧账号 `admin-sample`（邮箱 `i@example.com`）。
- `on_584676b5…`（飞书身份，`user`，`auto_groups=[u-on_584676b5…]`）：普通成员，只有自己的命名空间。
- 预建成员 `employee-a/b/c`（`user`，各自 `u-employee-x`）。

注意 NetBird **不会按邮箱去重**：同一个邮箱在 `idp=local` 与 `idp=casdoor` 下是两个用户（实测 `i@example.com` 就是这样两条）。

**自动配组**：每个 NetBird 用户（含**没有邮箱**的飞书身份）在 `tx` 上由 cron 每 2 分钟补齐自己的隔离组：

```
*/2 * * * * /www/server/nodejs/v24.15.0/bin/node /opt/dsh-netbird/scripts/dsh-netbird-user-namespace.mjs --apply --json >> /var/log/dsh-netbird-namespaces.log 2>&1
```

- 脚本与清单：`/opt/dsh-netbird/scripts/dsh-netbird-user-namespace.mjs` + `/opt/dsh-netbird/tools/dsh-netbird/machines.json`（相对路径必须保持）；令牌 `/root/.dsh/netbird-mgmt-token`（0600）。
- 它做三件事并幂等：建 `u-<用户名>` 组、把该组写进用户的 `auto_groups`（`groups_propagation_enabled=true`，已连接的设备会一起入组）、建 `self-<用户名>`（组内双向、任意协议）策略，并把该组加入机队 zone 的分发组。
- **无邮箱不是障碍**：`isNamespaceUser` 只看 name/role/status，`namespaceNames` 从 `user.name` 推导，所以 `on_<union_id>` 也能拿到 `u-on_<union_id>`。实测 `pnpm dsh-netbird:namespaces --apply` 为飞书身份建好了组、策略与分发。
- **不要加 `--include-admins`**：命名空间写入固定 `role: "user"`，NetBird 拒绝把 owner 降级（`only owners can remove owner role from their user`）。管理员用 `ops`，不需要 `u-` 命名空间。

**容器化实测**（`scripts/dsh-netbird-isolation-docker.mjs`，在 macOS 上用 colima + docker 跑 4 个真实独立机器：2 个用户 × 2 台）：

```sh
brew install colima docker && colima start
docker pull netbirdio/netbird:latest
# 每个用户一条带其 group 的 setup key，然后
node scripts/dsh-netbird-isolation-docker.mjs --key-a <key> --key-b <key>
```

- 必须各自独立网络命名空间（`--cap-add=NET_ADMIN --device /dev/net/tun`）；官方文档的 `--network host --privileged` 会让 4 个客户端共用一个 namespace，测不了。
- 实测结果 **12/12**：同用户两台互通 4/4 可达；跨用户 8/8 被策略丢弃；4 台机器对机队 7 台机器**一台都看不到**（`Peers count` 各自 1/1）。

## 桌面客户端通道（一键安装）

员工在**入网之前**唯一需要的地址是 `https://anywhere.example.com/install.sh`：

```sh
curl -fsSL https://anywhere.example.com/install.sh | sh
```

脚本按顺序做五件事：从通道的 `latest.txt` 取版本、下载对应的 `netbird_<版本>_<系统>_<架构>.tar.gz` 并用 `checksums.txt` 校验 SHA-256（缺校验和或不一致就**拒绝安装**）、装成 `/usr/local/bin/netbird` 并注册系统服务（macOS 用 launchd，Linux 用 systemd；容器与 CI 可以 `--no-service` 改成只起本次会话的守护进程）、用 `netbird up` 打开浏览器做 SSO 登录（没有浏览器的机器加 `--no-browser`，改为打印登录链接），最后安装 DSH 并让它常驻：`npm` 全局安装（本机没有 Node 22 时先在 `$DSH_HOME/node` 装一份私有 Node，并用 Node 官方 release 的 SHA-256 列表校验）、把 `@dsh-cove/dsh-web-all` 装进 Web profile、写入 Kaon Router 供应商并把默认模型指向 `kaon/deepseek-v4.1-flash`、注册用户级服务（macOS 用 `org.dsh.web` LaunchAgent，Linux 用 `com.dsh.web.service` systemd 用户单元并开启 lingering）。

- 全部参数：`curl -fsSL https://anywhere.example.com/install.sh | sh -s -- --help`；`--uninstall` 反装，`--dry-run` 只打印计划，`--force` 覆盖本机已有的客户端，`--no-dsh` 只装网络客户端，`--dsh-version V` 固定 DSH 版本。
- DSH 在本机是 `http://127.0.0.1:3080/`，在其他机器上是 `http://dsh.<机器名>.netbird/`（需要管理员先发布该名字）；服务以 `--trusted-host dsh.<机器名>.netbird` 启动，机器名取自客户端自己的 FQDN，首次登录前退回本机主机名；该端口上已经有 DSH 在服务的机器保留它原有的服务，不会再装第二份。
- 模型 API key 是脚本唯一做不到的一步：到 `https://router-admin.example.com/` 申请，然后填进 DSH（模型供应商设置，或 `$DSH_HOME/.credentials.yaml` 的 `refs:` 下的 `KAON_ROUTER_API_KEY`）。脚本只打印这两个位置，绝不写入秘钥。
- 脚本写入的供应商块只是 [llm-models.patch.yml](llm-models.patch.yml) 的精简子集；`scripts/dsh-netbird-client-dsh.test.mjs` 用该预置文件守住它写入的数值，管理员对机器跑 `pnpm dsh-netbird:llm-apply` 时会整块替换为完整目录。
- 本机已有 `netbird`（例如 Homebrew 装的）时脚本**复用**它，不装第二份；脚本始终用安装路径调用客户端，因此安装目录不在 `PATH` 里也能跑完。
- 归档都在 `/client/` 下：`latest.txt`、`management-url.txt`、`checksums.txt` 与四个平台的 tar.gz（darwin/linux × arm64/amd64）。`checksums.txt` 取自上游 release 的校验和文件，并在发布时与本地归档逐一比对，镜像漂移会**拒绝发布**。

发布（在 dsh-cove 仓库根目录，需要到 `nb-tx` 的 ssh）：

```sh
pnpm dsh-netbird:client-publish --dry-run   # 只暂存并打印文件清单
pnpm dsh-netbird:client-publish             # 上传 + 逐字节校验
```

- 归档缓存 `~/.dsh/client-dist/<版本>/`（从上游 release 下载一次，`netbird_<版本>_checksums.txt` 必须一起放在那里）。
- 发布脚本会拿线上的 `/`（官网首页）、`/qr-phone.svg`、`/install.sh`、`checksums.txt`、`latest.txt`、`management-url.txt` 与本地逐字节比对，`/client/` 必须是 301 到根，并对每个归档做 Content-Length 与 1 MiB Range（206）检查，任一不一致就以非零退出。
- 静态根是 `/www/wwwroot/client`，与 APK 通道的 `/www/wwwroot/apk` **分开**：`tools/netbird-client/scripts/publish.sh` 会原子替换它自己的根目录，共用会让一次 APK 发布删掉安装脚本。
- 官网首页就是这个通道的 `index.html`，服务在**规范域名的根路径**上：`/` 直接返回该文件，页面的相对资源 `qr-phone.svg` 由同一发布根的 `/qr-phone.svg` 提供，`/client/` 一律 301 到根（`/client/` 从此只承载归档）。

Android 手机走同一条公网通道：`https://anywhere.example.com/` 首页同时给出安装脚本与 APK 下载，手机端细节见 [../netbird-client/README.zh.md](../netbird-client/README.zh.md)。

### 用容器模拟各端接入

Linux 端点的接入可以在容器里完整跑一遍，用它替代真机验证"装完就在自己的组里"：

```sh
docker run -d --name ep --cap-add=NET_ADMIN --device /dev/net/tun debian:12-slim sleep infinity
docker exec ep sh -c 'apt-get update -qq && apt-get install -y -qq curl ca-certificates'
docker exec -d ep sh -c 'curl -fsSL https://anywhere.example.com/install.sh | sh -s -- --no-service --no-browser > /tmp/install.log 2>&1'
docker exec ep sh -c 'grep -o "user_code=[A-Z-]*" /tmp/install.log | tail -1'
```

- `--no-service` 起的是**本次会话的守护进程**，脚本用 `setsid` 把它从安装 shell 的会话里摘出来；否则 shell 退出会带走它（实测三个容器里有一个就这样丢了守护进程）。
- `--no-browser` 打印登录链接；把它交给操作者或浏览器完成登录，登录后 `netbird status` 应为 `Management: Connected`。**登录链接有时限**：没人及时打开时 `netbird up` 会以 `DeadlineExceeded` 结束，脚本会提示重跑同一条 `netbird up` 取新链接。
- 每个容器必须有自己的网络命名空间（`--cap-add=NET_ADMIN --device /dev/net/tun`），不能用 `--network host`。
- **不要在 qemu 模拟的 amd64 里查数据面**：`--platform linux/amd64` 下客户端能装、能登录、能注册，但建接口会失败（`create wg interface: socket: protocol not supported`），跨端可达性要在原生 x86_64 主机（例如 `tx`）上跑。
- 实测矩阵（同一身份 = 同一条 `u-` 组，策略 deny-by-default）：arm64 容器（本机 colima）与 amd64 容器（`tx`）**同身份跨架构、跨主机双向 8080 可达**；另一身份的两个方向、以及两个容器到机队（studio-mac/tower-lab 的 22、tx 的 3080）全部 BLOCKED；两个容器的 `Peers count` 只列出自己身份的机器。

## 域名契约

| 模式 | 用途 | 解析 |
| --- | --- | --- |
| `dsh.<机器名>.netbird` | 每台电脑的 DSH Web 入口（权威清单：`machines.json` 的 `domain` 字段） | 共享 zone `netbird` 内的 `dsh.<机器名>` A 记录，指向该 peer 的 NetBird IPv4 |
| `anywhere.example.com`（公网 HTTPS） | 官网（根路径）、桌面一键安装（`install.sh` 与 `/client/` 归档）、手机更新通道（`version.json` / `fleet.json` / APK）与 `/deck/` 路演幻灯片 | 网络边缘宿主 `tx`（文档专用地址段的公网样本 `203.0.113.10`，也是管理端宿主）上的 nginx 虚拟主机 `/www/server/panel/vhost/nginx/anywhere.conf`（仓库源 [nginx-anywhere.conf](nginx-anywhere.conf)，由 `pnpm dsh-netbird:client-publish` 安装并逐字节校验）；静态根 `/www/wwwroot/client`（官网首页、`install.sh`、`qr-phone.svg`、`/client/` 归档）、`/www/wwwroot/apk`（APK、`version.json`、`fleet.json`）、`/www/wwwroot/deck`（幻灯片）。覆盖网名 `tx` / `tx.vpn:80` 由 apk vhost 回答，因此 WiFi 与入网两条路都能取。TLS 走 Let's Encrypt（`certbot --webroot`，webroot `/www/wwwroot/netbird-acme`） |
| sci-exit 域名 | 分域出口：精选境外域名经办公室出口路由 | 域名型路由（见下文路由），routing peer 为 `tower-lab` |
| `apk.example.com`（兼容别名） | 不对外引用；仅为 2.7.5 之前安装的客户端继续服务同一份内容 | 与上面是同一个 vhost、同一个静态根、同一张证书（SAN 同时包含两个名字）。**不要**在任何面向用户的地方使用它；等确认没有 2.7.5 之前的安装后，可以从 `server_name` 和证书里一起去掉 |

DNS 记录名在 App 可见名中会去掉尾点；管理端 API 存储的是带尾点的完整域名。

## 自定义 DNS

- 全网共用一个启用的 zone `netbird`。这个名字是客户端要求而非偏好：Android App 把它编译在包里，要换名字必须重新构建 App（见 [self-hosted.zh.md](self-hosted.zh.md)）。
- 该 zone 内的 `dsh.<机器名>` A 记录指向机器的 NetBird IPv4，解析结果即 `dsh.<机器名>.netbird`（[README.zh.md](README.zh.md) 地址契约所依赖的解析）。
- 该 zone 分发组是 `ops` **加 `All`**。只发给 `ops` 是不够的：客户端每次全新安装都会注册一个**新 peer**，新 peer 只落在 `All`，于是拿不到任何 zone 记录，App 的服务列表就会是空的（实测：新 peer `records=[]`）。`All` 不能挂到 setup key 上（管理端会拒），但可以作为 zone 的分发组。
- 分发是按 zone 整体生效的，所以组内 peer 会看到 zone 内的全部名字（其中大部分不可达）；只让员工拿到 `dsh.*` 名字的做法见上文「机队 DNS 与员工入口」。
- zone 与记录通过 `/api/dns/zones` 与 `/api/dns/records` 或控制台管理。使用短 TTL（300 秒）让变更快速传播。
- 更新 zone 用 `PUT /api/dns/zones/<zone-id>`，请求体是全量替换：必须把现有 `records` 原样带回（本仓库的脚本已如此处理），否则记录会被丢弃；分发组变更后已连接的 peer 要重连才生效。
- 修改服务端 DNS 数据后，应递增账户 network serial（或使用受支持的管理 API 调用），让已连接 peer 收到新的 network map。`/etc/hosts` 不是全网事实源。

```sh
# 列出 zones
curl -fsS -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" \
  "https://netbird.example.com/api/dns/zones"
# 列出某 zone 的记录
curl -fsS -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" \
  "https://netbird.example.com/api/dns/zones/<zone-id>/records"
```

## 路由与分组

### 新注册 peer 的可见性（空列表的第二个根因）

策略决定 network map 里能看到哪些 peer；看不到 peer，App 就一条 DSH 记录都接受不了（接受条件要求目标 IP 属于本网络的一个 peer），列表因此为空。当时的实测事实：

- `Default`（All ↔ All）策略是 **disabled**；生效策略的来源/目的地组全是 `ops`（`ops-full-access`、`dsh-http`、`SSH-only` 等）与 `self-employee-*`（各自 `u-employee-*`）。
- 因此一个只属于 `All` 的 peer **不在任何策略里**：它的 map 里 `peerAddresses=[]`，App 列表空。全新设备正是这种情况。
- SSO 注册的设备没有 setup key，身份侧的分组只能来自 **user 的 `auto_groups`**（见下），而不是 setup key 的。

**禁止**用 `All → ops` 这类宽策略来补这个洞：它会让任何入网设备都能访问全部机器，等于删掉按员工隔离。正确的补法是给身份配 `auto_groups`——peer 注册时继承身份的分组（setup key 继承 key 的，SSO 继承 user 的）：

```sh
# 机队设备：给 owner 用户配 ops，则该用户注册的所有设备自动进 ops
curl -fsS -X PUT -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"role":"owner","auto_groups":["<ops id>"],"is_blocked":false}' \
  "https://netbird.example.com/api/users/<user id>"
# 员工设备：给员工配自己的 u-employee-<x>，配合已有的 self-employee-<x> 策略
curl -fsS -X PUT -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"role":"user","auto_groups":["<u-employee-x id>"],"is_blocked":false}' \
  "https://netbird.example.com/api/users/<user id>"
```

依据（管理端 v0.78.1 源码，非猜测）：`management/server/peer.go` 的 `handleUserAddedPeer` 在注册时执行 `config.GroupsToAdd = user.AutoGroups`；`management/server/user.go` 在 `GroupsPropagationEnabled`（本账户为 true）下，改 user 的 `auto_groups` 会把增删的组同步到该用户**已有的全部 peer**。因此改 user 的 `auto_groups` 不需要设备重新注册。

模拟器上两个全新 peer，同一账户、同一 zone：

| 入网身份 | `peerAddresses` | 收到的 `dsh.*` 记录 | App 接受 |
| --- | --- | --- | --- |
| setup key `auto_groups=[ops]` | 9 个（全机队） | 6 条 | 6 条 |
| setup key `auto_groups=[u-employee-a]` | 1 个（仅 thinkpad-lab） | 6 条 | 1 条 |

第二行是隔离的关键：zone 分发按组下发的是**名字**，而 App 只接受目标 IP 属于本 peer 可达 peer 的记录。所以即使名字下发到了员工设备，它也只能看到自己的机器。是否要让员工设备拿到机队分区的全部名字，是 `pnpm dsh-netbird:namespaces` 已有的取舍（`--no-zone-access` 则完全不发名字）；两种情形下**访问**都由策略决定，不看名字。

按员工隔离的完整配方由 `pnpm dsh-netbird:namespaces --apply` 落地：user 的 `auto_groups=u-employee-<x>` + 机器加入 `u-employee-<x>` + `self-employee-<x>` 策略（`u-employee-<x> → u-employee-<x>`）+（可选）机队分区对该组的分发。机队自己的规则是：聚合 zone（`netbird`）分发给 `ops`，机队策略全部以 `ops` 为源/目的，且**不存在** `All → ops` 的宽策略。

清理注意：`All` 组是自动组，扣 peer 的分组要用组接口整表替换，不是 peer 接口：

```sh
# 组接口用 {"name":..., "peers":[peerId...]} 整表替换（peer 接口不接受 groups 字段，会 500）
curl -fsS -X PUT -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"ops","peers":["<peer id>", "..."]}' \
  "https://netbird.example.com/api/groups/<ops id>"
```

另外：SSO 设备每次重装都会注册一个**新 peer**，旧 peer 不会消失，所以判断「多台设备」必须先看 hostname + OS 指纹，不能按 peer 数量下结论；这些被取代的 peer 应删除，否则它们会随着 user 的 `auto_groups` 传播持续重新获得机队访问权。

域名级分域出口配置为一条或多条域名型路由（每条最多 32 个域名），仅分发给专用分组：

```sh
# 列出分组与路由
curl -fsS -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" \
  "https://netbird.example.com/api/groups"
curl -fsS -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" \
  "https://netbird.example.com/api/routes"
```

现有网络事实：

- 分组 `sci-exit`（id `daqahtmkeeas738pj3a0`）持有允许使用办公室出口的设备。
- 域名路由 `daqak9mkeeas738pj7bg` 将精选境外域名（Google 全家桶、GitHub、OpenAI/ChatGPT、Claude、X/Twitter、Facebook、Telegram、Netflix、Notion、Cloudflare，共 28 条域名）送往 routing peer `tower-lab`（`peer-sample-0001`），metric 9999、`masquerade true`、`keep_route true`，仅分发给 `sci-exit`。该路由处于启用状态，`sci-exit` 组内 0 台设备。
- 设备加入方式：加入该分组，然后在设备上执行 `netbird down && netbird up` 拉取新路由集；用 `curl ifconfig.me` 验证（应显示办公室公网 IP）。

## Setup key

Setup key 用于免交互登录注册新 peer。它们是一次性或限量使用、带有效期，用后必须吊销：

```sh
# 创建一次性 key
curl -fsS -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"ephemeral-enroll","type":"one-off","expires_in":86400,"auto_groups":["<group-id>"]}' \
  "https://netbird.example.com/api/setup-keys"
# 用后吊销
curl -fsS -X DELETE -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" \
  "https://netbird.example.com/api/setup-keys/<key-id>"
```

禁止把 setup key、PAT 或共享 WireGuard 私钥硬编码进 App、仓库或本文档。

## 添加电脑

完整流程见 [README.zh.md](README.zh.md)（添加电脑）。控制面部分：注册 peer（或用一次性 setup key 注册）、创建其 DNS zone 与 `dsh.<机器名>.netbird` A 记录、把机器加入 [machines.json](machines.json)。然后从另一台已连接 peer 运行审计。

## 安全规则

- PAT、setup key、密码与会话 cookie 永不进入仓库、文档、nginx 文件或服务单元。
- 一次性 setup key 用后删除；测试用户验证完成后移除。
- 路由/分组/DNS 变更影响整个网络：优先短 TTL + 增量推进，并在不受影响的 peer 上验证后再宣告成功。

## 官网的根路径

官网服务在规范域名的**根路径**上，`/client/` 是 301 到根。含义如下：

- 根路径是这个域名的第一身份，访客不该先看到一层子目录；已有链接（包括 App 内已编译进去的地址）继续可用，因为 301 把 `/client/` 送回根。
- 根路径必须是「渠道首页」而不是别的页面：`/health`、`/version.json`、`/fleet.json`、`/install.sh`、`/AnywhereWork.apk` 与 `/client/` 归档都在此提供，发布脚本逐条校验它们仍然 200。
- 页面按相对路径引用自己的二维码（`qr-phone.svg`），服务在根路径时浏览器会请求 `/qr-phone.svg`，所以该路径由同一个发布根提供；页面因此保持单文件可离线缓存，不引入绝对资源地址。
- 幻灯片是官网的一个入口（导航项、首屏次按钮、独立区块与页脚各有一处），但它仍住在 `/deck/`：那是一份 7 MB 的自包含包，由本仓库之外的独立链路部署更新。vhost 里只有 `deck (anywhere work roadshow)` 标记区属于它。

vhost 的所有权因此分成两层：**整份规范 vhost 属于客户端通道**（仓库源 [nginx-anywhere.conf](nginx-anywhere.conf)，由 `pnpm dsh-netbird:client-publish` 安装；`nginx -t` 不通过就回滚备份），**幻灯片只拥有其中的标记区**（`the deck deploy script` 按标记替换，标记缺失才插入）。
