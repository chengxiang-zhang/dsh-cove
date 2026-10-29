# 自建控制端

[English](self-hosted.md) | 中文

本页面向「NetBird 控制端是自己的」的运维：让已发布的客户端（桌面一行安装命令与 Android App）用上你这套控制端。这里说明客户端究竟依赖什么、按什么顺序把它立起来、以及怎么证明整条链路。 两个客户端现在默认连接 NetBird Cloud；要用这套自建部署，需要在客户端里显式改地址（或构建时传 `-PawManagementUrl=` / `AW_MANAGEMENT_URL=`），之后下面的依赖就是这次选择所需要的全部。属于本机队自身的运维事实仍在 [README.zh.md](README.zh.md)（每机暴露）、[netbird-management.zh.md](netbird-management.zh.md)（本机队控制端）与 [employee-guide.zh.md](employee-guide.zh.md)（成员）。

## 客户端依赖

| 依赖 | 客户端为什么离不开它 |
| --- | --- |
| 公网 HTTPS 的管理端，且证书被手机信任 | App 的登录跑在 WebView 里，注册也拨同一个宿主；自签或明文端点两边都完不成 |
| 该宿主上应答的身份提供方（IdP） | `Portal.loginSSO` 返回的是内嵌 IdP 为部署已注册的 `netbird-cli` 客户端签发的授权 URL（`redirect_uri=http://localhost:53000/`、`prompt=login`、`scope=openid profile email groups`）；App 自己不注册任何回调 |
| 域名恰好为 `netbird` 的自定义 DNS zone | App 把 zone 名编译在包里（`res/values/fleet_dsh_zones.xml`），每机安装器也按 `dsh.<机器名>.netbird` 命名；要换 zone 名必须重新构建 App |
| 该 zone 里每台机器一条 `dsh.<机器名>` A 记录，指向该机的 NetBird IPv4 | 发现规则要求名字是 zone 内的 `dsh.<机器名>`，且地址属于客户端自己的 peer 集合 |
| zone 分发到设备所属分组 | 分发按组进行；分组不在 `distribution_groups` 里的设备收不到任何记录，列表恒为空 |
| 有策略把该机器的 peer 放进设备的 network map | 不在任何策略里的 peer 不贡献地址，于是 DNS 能解析、记录仍会被拒绝 |
| 每台机器在覆盖网地址上的 DSH 暴露 | 入口是 80 端口的 `http://dsh.<机器名>.netbird/`，只绑该机 NetBird IP，且 DSH 以 `--trusted-host dsh.<机器名>.netbird` 启动 |
| App 的更新通道与引导地址 | 它们编译在包里；指向别的控制端的安装包仍会向本机队通道查更新，而通道不可达无害 |

## 落地顺序

模板都在 [selfhosted/](selfhosted)：每个文件都写明了为什么要设这一项，所有 `__PLACEHOLDER__` 都要替换。

1. 管理端：[selfhosted/netbird-server-config.yaml.template](selfhosted/netbird-server-config.yaml.template) 记录本部署在出厂默认之上设置的键——只允许外部身份登录，以及让 peer 在多 WAN 网络里打洞而不是回落中继的 STUN 集合。
2. 身份提供方：[selfhosted/idp-dex-connector.yaml.template](selfhosted/idp-dex-connector.yaml.template) 是连接器字段集，[selfhosted/netbird-dashboard.env.template](selfhosted/netbird-dashboard.env.template) 是 dashboard 客户端的密钥。外部 IdP 自己那一侧——应用、provider 行与登录方式——连同本机队所设字段记录在 [netbird-management.zh.md](netbird-management.zh.md)，控制台主题可用 [casdoor-theme.sql](casdoor-theme.sql) 复现。
3. TLS 前端：[selfhosted/netbird-proxy.conf.template](selfhosted/netbird-proxy.conf.template) 承载已实测的要求，包括 dashboard 静态导出自身无法提供的回调路径。
4. 自定义 DNS：[selfhosted/custom-zone.json.template](selfhosted/custom-zone.json.template) 建 zone。建 zone 不会保存随它提交的 `records`，所以每台机器的记录要在之后用 `POST /api/dns/records` 补，请求体就是该模板里的 record 条目；分发规则与 API 形状见 [netbird-management.zh.md](netbird-management.zh.md)。
5. 机器：[client/install.sh](client/install.sh) 负责入网并安装 DSH **与插件包**（`dsh plugin --profile web add @dsh-cove/dsh-web-all@latest`——客户端依赖它：没有插件的宿主会应答，但不是这个产品）——`--management-url` 指向你的控制端、`--channel` 指向你自己发布的通道——每机暴露使用 [nginx.conf.template](nginx.conf.template) 与 [dsh-web.service.template](dsh-web.service.template)。
6. 手机：装 App，在登录页（`服务器 · 修改`）或设置页（登录服务器）填服务器地址。改地址会清除本机注册，并向新控制端重新登录。

## 验收

每一步证明一跳，第一处失败就指出要修的那一跳。按顺序执行。

```sh
# 1. TLS 与可达性：未认证返回 401 就是预期结果。
curl -fsS -o /dev/null -w '%{http_code}\n' "https://<管理端>/api/peers"

# 2. 内嵌 IdP 公布自己的端点。
curl -fsS "https://<管理端>/.well-known/openid-configuration" | head -c 200

# 3. zone 名为 netbird，且每台机器一条 A 记录。
curl -fsS -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" "https://<管理端>/api/dns/zones"
curl -fsS -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" "https://<管理端>/api/dns/zones/<zone-id>/records"

# 4. 从另一台已入网 peer 看，入口应答 302（登录）或 200。
curl -sI -m 10 "http://dsh.<机器名>.netbird/" | head -1
```

最后两跳在客户端，服务端无法代跑：手机用你的地址登录后能在列表里看到那台机器，桌面客户端的 `anywhere status` 报告管理端已连上。

## 仍然属于本机队

- 更新通道与引导地址属于 App 构建，新装所对接的控制端也一样：打包时传给它即可编译进包内。
  ```sh
  cd tools/netbird-client/android
  ./gradlew -p . :app:assembleRelease \
    -PawManagementUrl=https://netbird.<你的域名>:443
  ```
  `build.gradle` 把它写进 `BuildConfig.AW_MANAGEMENT_URL`，由 `NetBirdRuntime` 读取，因此不需要改 Kotlin；仓库自身保留文档占位地址作为兜底。不传该参数时，新装没有可用地址，只能在 App 内逐台设置；`scripts/publish.sh` 会拒绝发布「包内地址与通道广播不一致」的 APK，所以这个错不会再发到手机上。
- [machines.json](machines.json)、审计（`pnpm dsh-netbird:audit`）与命名空间工具（`pnpm dsh-netbird:namespaces`）都以本仓库的机队与 SSH 清单为前提；可以照搬，但部署要维护自己同形状的清单。