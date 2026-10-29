# 员工使用手册：接入私有网络

[English](employee-guide.md) | 中文

本手册面向使用这套私有网络的员工：如何拿到账号、在自己的机器上安装客户端并登录、把更多机器接入自己名下、打开自己机器的入口，以及如何确认自己的机器互通而别人的机器不可见。控制面的运维事实见 [netbird-management.zh.md](netbird-management.zh.md)，机群地址契约与机器清单见 [README.zh.md](README.zh.md)，手机客户端见 [../netbird-client/README.zh.md](../netbird-client/README.zh.md)。

## 你能得到什么

- 你自己接入的机器组成一个只属于你的私有网络，彼此可以互相访问，端口不限（SSH、远程桌面、数据库、网页等）。
- 用一键命令装好的机器同时跑起了 DSH，管理员发布该名字后在浏览器里打开 `http://dsh.<机器名>.netbird/` 就能用，不要求第二次登录：这类机器把「能进覆盖网」当作凭据。
- Android 手机用我们自己的客户端列出并打开你名下的这些页面，安装与更新走网内通道，不用应用商店。
- 同事的机器不在你的范围内：既看不到，也连不上。
- 在公司网络之外（家里、手机热点）同样可用。

## 开始之前

- 一个公司统一账号，由管理员在 Casdoor 中开通。
- 一台要接入的机器，以及安装客户端所需的管理员权限。
- 能访问公司 SSO、NetBird 管理端与安装通道的网络；本手册使用的示例地址为 `https://sso.example.com`、`https://netbird.example.com:443` 与 `https://anywhere.example.com`。

## 第一步：拿到账号

把你的姓名和邮箱告诉管理员，由他在 Casdoor 中为你建立成员。你不需要自助注册，也不需要提前在浏览器登录。

## 第二步：安装客户端

### macOS

```sh
curl -fsSL https://anywhere.example.com/install.sh | sh
```

打开「终端」粘贴执行：脚本从我们的通道下载客户端、校验 SHA-256、装好并注册后台服务，最后自动打开浏览器让你登录；接着它会装好 DSH 并让它常驻，同时打印唯一需要你自己做的一步——模型 API key（见第七步）。Intel 与 Apple 芯片都支持。

### Windows

从 [NetBird Releases](https://github.com/netbirdio/netbird/releases/latest) 下载 Windows 安装包并运行，按提示完成安装。

### Linux

```sh
curl -fsSL https://anywhere.example.com/install.sh | sh
```

### Android

手机端用我们自己的客户端，不要安装应用商店里的 NetBird 官方 App：它只接受机队登记过的 `dsh.<机器名>.netbird` 地址，只让 App 自己的流量进覆盖网，不把整台设备接入通用 VPN。目前交付的是 Android 包（arm64-v8a；鸿蒙设备兼容 Android 时同样可用），iPad/iOS 客户端尚未交付。入口页在公网通道上，**不必先入网**：用浏览器打开 `https://anywhere.example.com/`，点一下就能下载安装包（同一页上也给出电脑用的那条命令；入网后 `http://tx.vpn/AnywhereWork.apk` 是同一份文件）；装完打开 App 再用公司账号登录。客户端细节见 [../netbird-client/README.zh.md](../netbird-client/README.zh.md)。

## 第三步：登录并接入

桌面：粘贴上面那条命令即可。登录页默认是**飞书登录**，也可以切到**账号 + 密码**，两种方式进入的是同一个身份。

客户端已经装好时（手动登录）：

```sh
anywhere up --management-url https://netbird.example.com:443
```

没有浏览器的机器（服务器、容器）：加 `--no-browser`，客户端会打印一个登录链接，在任意浏览器打开它、登录并确认。

```text
Use this URL to log in: https://netbird.example.com/oauth2/device?user_code=XXXX-XXXX
```

手机客户端：打开 App、用公司账号登录、连接（与电脑同一条通道、同一个身份）。连接后在电脑上确认状态：

```sh
anywhere status
```

`Management` 与 `Signal` 均为 `Connected` 即接入成功。

## 第四步：私有分组自动就绪

登录成功后服务端会自动建立只属于你的私有分组，通常两分钟内生效：不需要审批，也不需要谁点按钮。分组就绪前客户端已经连上，只是还看不到别的机器。

## 第五步：接入更多机器

在每一台要接入的机器上重复第二步与第三步，用同一个账号登录。这些机器会自动归到你名下，互相可见、互相可达。

## 第六步：打开自己机器的入口

浏览器打开：

```text
http://dsh.<机器名>.netbird/
```

- 地址不带端口，也不要换成 NetBird IP 或局域网地址：入口只认这个规范名字。
- `<机器名>` 是该机器在 `anywhere status` 里显示的 peer 名去掉 `.vpn` 后缀。
- 用一键命令装好的机器已经跑着 DSH；管理员要做的只是发布这个名字，入口会自己出现，不需要你部署。
- 手机客户端里的服务列表就是同一批地址，只列你自己命名空间里的机器。

不需要 DSH 的普通远程访问直接用覆盖网地址即可，例如 `ssh 用户名@100.64.x.y`。

## 第七步：给 DSH 接上模型 key

DSH 已把 Kaon Router 配成模型供应商，只差一个 API key。其管理控制台为本手册通篇使用的示例地址：

```text
https://router-admin.example.com/
```

- 在那个控制台申请 key（API keys），然后在机器上打开 `http://127.0.0.1:3080/`，进入模型供应商设置，选 Kaon Router 把 key 填进去。
- 等价的手工做法：把 `KAON_ROUTER_API_KEY: <你的 key>` 写进 `~/.dsh/.credentials.yaml` 的 `refs:` 下（该文件仅本人可读，权限 0600）。
- 没填之前 DSH 照常启动、界面照常打开，但每次对话都会因鉴权失败而报错。

## 第八步：确认隔离生效

```sh
anywhere status --ipv4
anywhere status -d
ping <你另一台机器的 NetBird 地址>
```

`anywhere status -d` 中只列出你自己的机器，说明隔离已生效。

## 客户端能做什么

- App 自己也是一个 peer：只有 App 自己的流量进覆盖网，整台手机不接通用 VPN。
- 列表、打开页面与网页麦克风共用同一份登记清单：只列你名下的机器，其它内网地址、公网地址和原始 IP 一律拒绝。
- 页面在 App 内置引擎里渲染完整工作区，不依赖设备自带的旧 WebView；页面里的语音输入可用，App 只给网页麦克风授权，不自己识别或保存录音。
- Android 前台服务让连接跨锁屏、切后台与进程重启存活。
- 连接卡住时不是死胡同：列表页会说明卡在哪一层，并始终提供「重试」与「重新登录」。

## 入口会怎样要求登录

入口有两种模式，取决于那台机器是怎么部署的：

- 免二次登录（`network-gate`）：能进覆盖网就直接打开工作区，机队里多数机器是这种。
- 需要登录（`password`）：会跳到该机器自己的 DSH 登录页，用那台机器的管理员给你的账号登录；支持本地账号、飞书或 OIDC，凭据由该机器管理员管理，和 NetBird 账号不是一回事。

## 可选：分域出口

网络里有一条可选的域名级出口：精选境外域名（Google 全家桶、GitHub、OpenAI/ChatGPT、Claude、X/Twitter、Facebook、Telegram、Netflix、Notion、Cloudflare）经办公室公网出口访问，拉代码、查资料时更稳。由管理员把你的设备加入 `sci-exit` 分组后开启：

```sh
anywhere down && anywhere up
curl ifconfig.me
```

第二条命令显示的若是办公室公网 IP 即为生效；不需要这条出口就不要加入该分组。

## 常用命令

| 目的 | 命令 |
| --- | --- |
| 接入并登录 | `anywhere up --management-url https://netbird.example.com:443` |
| 断开连接 | `anywhere down` |
| 重新拉取配置与 DNS | `anywhere down && anywhere up` |
| 查看状态 | `anywhere status` |
| 查看本机地址 | `anywhere status --ipv4` |
| 查看可见机器 | `anywhere status -d` |

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 登录后看不到任何机器 | 私有分组最多两分钟就绪（服务端自动完成，不需要审批）；刚接入第一台机器时也还没有「其它机器」可看 |
| 应用商店里找不到我们的 App | 客户端只走自家通道：浏览器打开 `https://anywhere.example.com/`（同一页也有电脑的一键安装命令）；旧包 `com.netbirdportal` 需手动卸载 |
| 打开入口时要求登录 | 那台机器是 `password` 模式：用该机器管理员给你的 DSH 账号登录（本地账号、飞书或 OIDC） |
| `dsh.<机器名>.netbird` 解析不出来 | 管理员还没把你的账号加入机队 DNS：请他跑一次 `pnpm dsh-netbird:namespaces --apply`，然后你执行 `anywhere down && anywhere up` 让客户端拿到新的 DNS 配置 |
| 能解析出别的机器名，但连不上 | 设计如此：名字来自机队 DNS，能不能连由策略决定，你的策略只覆盖自己的机器 |
| 打不开 `dsh.<机器名>.netbird` | 那台机器没有部署 DSH 入口，找管理员确认 |
| DSH 打得开但每次对话都报鉴权失败 | 缺模型 key：到 `https://router-admin.example.com/` 申请后填进 DSH（见第七步） |
| 想访问同事的机器或公司内网 | 这是设计上的隔离；需要共享服务时找管理员开策略 |
| 过一段时间后机器离线 | 登录有效期为 7 天，重新执行 `anywhere up` 登录一次 |
| 忘记密码 | 找管理员在 Casdoor 中重置 |
| 换机器或退租 | 找管理员删除旧机器的记录；本机 `anywhere down` 只是断开 |
| 浏览器打不开登录页 | 确认能访问 `https://sso.example.com` |
| 登录时提示 `Failed to launch 飞书` | 飞书授权页想拉起手机上的飞书 App 但没拉起来。在那张页面里改用「更多登录方式」或「扫码登录」，同样能完成这次授权；也可以返回上一页用账号 + 密码登录 |
| 手机是鸿蒙，装不上或装上闪退 | 看系统能不能运行 Android 应用：HarmonyOS 4 及更早可以；纯血鸿蒙（HarmonyOS NEXT / 鸿蒙 5）不兼容 Android 应用，目前没有对应版本。设置 → 关于手机 → 「HarmonyOS 版本」可以确认 |
| 手机上飞书是鸿蒙版，点了飞书登录没反应 | 鸿蒙版飞书不会响应 Android 应用的跳转，这是两个系统的边界。用上面那条的替代路径（更多登录方式 / 扫码登录 / 账号密码） |
| 安装脚本报 checksum mismatch | 下载没传完整，重跑一次即可；反复出现就找管理员核对通道 |
| 延迟偏高 | 无法直连时客户端会走中继转发，属正常回退 |

## 安全与隐私

- 你的机器之间是加密的点对点连接；管理端只下发配置与密钥，不转发业务流量，直连失败时才经中继。
- 管理员可以看到你接入的机器名、地址、在线状态与登录记录，这是企业网络的常规审计面。
- 不要与他人共用账号：每台机器都用你自己的账号登录，机器才会归属到你名下。
- 为了让你的机器能用规范名字打开，你的客户端会拿到机队 DNS 分区里的全部名字（含别人的机器名与一些内部服务名），但这些地址都连不上；不想要这一层名字可见性时，管理员可以用 `--no-zone-access` 关掉，或按 [netbird-management.zh.md](netbird-management.zh.md) 把分区收窄。

## 管理员需要做什么

员工开通只有一步需要人工：在 Casdoor 建立成员（飞书登录会自动建号）。其余由已装好的 cron 每 2 分钟自动完成——建 `u-<用户名>` 私有组、写进该用户的 `auto_groups`（已连接的设备会一起入组）、建 `self-<用户名>` 策略、加入机队 DNS 分发；不需要审批。要立刻生效时手工跑一次 `pnpm dsh-netbird:namespaces --apply`。命令细节、IT 直达访问与故障排查见 [netbird-management.zh.md](netbird-management.zh.md)；部署或改动机器后跑 `pnpm dsh-netbird:audit --verify-gate`，改动机器清单后另跑 `pnpm dsh-netbird:mobile-registry`。