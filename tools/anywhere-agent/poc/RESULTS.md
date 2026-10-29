# 内网浏览器 PoC 结果

验证日期 2026-10-18。方案 A(进程内嵌 userspace 引擎 + 回环代理)、外壳 Electron。全部数字为实测。

## 结论

1. **应用级链路成立。** 在故意让名字无法解析的条件下(`MAP <authority> ~NOTFOUND`),Chromium 与 Electron 都能经回环代理加载并完整渲染 DSH 工作区,Host 保留,围栏成立。
2. **WebView 可行,而且不需要系统面。** Electron 用 `session.setProxy` 把流量交给回环代理,`scutil --proxy` 运行前后完全一致(HTTP/HTTPS/PAC/SOCKS 全为 0)。名字映射由代理自己完成,所以壳不需要 `--host-resolver-rules` 这类能力,只需要"指向代理"。
3. **"每次都等 Loading plugins"的解是常驻 + 预热,不是换引擎。** 已加载的工作区切回来 **3ms**,预热好的 **18ms**;而重新打开一次文档是 3.3s(温)/4.2s(P2P 冷)/28.0s(中继冷)。

## 实测数据

### 时间线(经代理,浏览器解析被破坏)

| 机器 | 链路 | 冷启动→可用 | 温启动→可用 | 新标签→可用 | 温字节 | 冷字节 |
| --- | --- | --- | --- | --- | --- | --- |
| tower-lab | P2P | 8.4s | 6.1s | 4.0s | 0.72MB | 6.7MB |
| laptop-b | 中继 | 30.3s | 6.7s | 8.0s | 1.4MB | 7.4MB |

### Electron 壳(同一代理、同一解析破坏条件)

| 阶段 | 结果 |
| --- | --- |
| 打开 tower-lab(P2P) | loaded=1474ms,ready=4214ms |
| 打开 laptop-b(中继) | loaded=23034ms,ready=27972ms |
| 切回已常驻的 tower-lab | **3ms** |
| 切到已预热的 laptop-b | **18ms** |
| 再次打开 tower-lab(新文档) | loaded=948ms,ready=3303ms |

### 系统面零残留

- 运行前后 `scutil --proxy`:HTTPEnable / HTTPSEnable / ProxyAutoConfigEnable / SOCKSEnable 全为 0。
- `scutil --dns` 中的 netbird 条目来自本机既有的系统级 netbird 安装,PoC 未新增(运行前后计数一致)。
- 代理只监听 `127.0.0.1`;非本网名字一律 403。

### 围栏与长连接

- `GET /api/dsh-access/session` 返回 `{"authority":{"host":"dsh.<机器>.netbird","declared":true},"session":true,"owners":true}`。
- `ws://dsh.<机器>.netbird/api/remote.mux` 经代理(CONNECT 隧道)升级成功,保持 65 秒以上(>2 个 30 秒心跳周期)。
- 完整工作区渲染:插件侧边栏入口、工作区与会话历史、模型选择器、权限档、分支均正确;console/page error 为 0。

## 主机侧的两个瓶颈(客户端修不了)

1. **资产没有缓存验证器。** `/assets/index-*.js` 响应头无 `cache-control` / `etag` / `last-modified`,文件名却带内容哈希,安全可加 `Cache-Control: public, max-age=31536000, immutable`。gzip 已开(633KB → 237KB),未启用 brotli。
2. **冷启动有一个 5.4MB 的合并插件 bundle**,中继下单个请求耗时 23.1 秒;这是首次体验的命门。

## 未验证与风险

- WKWebView 未实测。macOS 14+ 有 `WKWebsiteDataStore.proxyConfigurations`,理论上可行;本次只验了 Chromium 系(Electron)。
- password 模式机器的完整登录链路未跑(需要凭据);实测到的是 `302 → /login?next=%2F` 的重定向形态与 network-gate 机器的完整工作区。
- 预热必须节制:中继机器预热一次要 23-28 秒的带宽占用,应只预热最近使用或在用的机器,不要 9 台全上。
- PoC 截图含同事机器的工作区名与会话标题,属敏感材料,不得进入公开仓库。

## 落地建议顺序

1. 壳:Electron + `session.setProxy` + 常驻文档 + 选择性预热。
2. 发现与清单:复用已验证的判定(仅机队 zone 内、目标为本网 peer 的 `dsh.<机器>` 记录)。
3. 一次登录贯通:PKCE loopback 复用手机端(client_id / redirect_uri / prompt 与手机端一致),网络身份、DSH OIDC 会话、kaon key 三件一起拿。
4. 内嵌引擎:netbird v0.78.1 树 + 两处补丁 + `go build` 出 helper(不需要 gomobile)。
5. 主机侧配合:资产缓存头、拆分 5.4MB bundle。

---

# 轨道 2:内嵌 userspace 引擎(2026-10-18 同日)

方案 A 的桌面实现。结论:**不需要 gomobile**;内嵌引擎在 macOS 上应用级运行成立,且系统面零残留经前后快照核对。

## 构建

- 输入:netbird **v0.78.1** 源码树(HEAD `23a1487`)+ 两处补丁(`wlynxg/anet v0.0.5` 去掉 Go 1.26 已删的两条 `//go:linkname`;`native/*.go` 作为包放进 `client/portalbind`)+ 本仓库的 helper 源码。
- Android 之所以要 gomobile 是为了产出 AAR 给 Java;桌面只要 `go build` 出一个二进制,**同一套三平台**。
- 产物:29.9 MB(`-s -w -trimpath`;未裁剪 44.8 MB,gzip 后 10.7 MB),嵌入 96 个 Go 依赖,只动态链接系统库。
- 实测工具链:`go1.26.7`(本机 1.26.5 自动升级到 netbird go.mod 要求的版本,与 Android AAR 记录的构建版本一致)。
- `go test ./client/portalbind` 通过。

## 应用级证据(引擎自己的日志)

| 行 | 含义 |
| --- | --- |
| `advanced routing disabled: netstack mode is enabled` | 不走系统路由 |
| `create nbnetstack tun interface` | 进程内 netstack,不建系统接口 |
| `server routes are disabled` | 不下发路由 |
| `system DNS is disabled, not setting up host manager` | 不碰系统解析器 |
| `blocking inbound connections` / `setting IPv6 overlay disabled=true` | 入站阻断、IPv6 关闭 |

## 系统面零残留(前后快照核对)

`~/.anywhere-poc` 私有配置/状态目录;引擎存活期间与启动前的快照逐行 diff,**过滤无关的本地 WiFi ARP 过期计时后为空**;

| 关键词 | 基线 | 引擎存活期间 |
| --- | --- | --- |
| `netbird` | 1 | 1 |
| `utun` | 3 | 3 |
| `100.108` | 6 | 6 |

本机原有的系统级 netbird(`studio-mac`)未受影响:核验时 `Management: Connected`、`Peers 7/10`。

## 真实机队上的发现

- **网络 map 比管理端连接晚到**:管理端连上后先报 0 peers / 0 records,约 **2 秒后** map 到达。补上等待窗口后 `peers=10`、收到 63 条记录。手机端的 `CATALOGUE_SETTLE_TIMEOUT_MS`(8 秒)就是为这个存在;冷启动报空列表是用户会立刻注意到的故障。
- **发现规则在真实数据上成立**:63 条记录里**接受 6 条 `dsh.*`、拒绝 57 条**。被拒的 46 条是内网服务名(`clickhouse.tower-lab.netbird`、`auth.tower-lab.netbird`、`browserless-mcp.tower-lab.netbird`、`appium.*` 等)。若没有"首标签必须是 `dsh`"这条,这些内网服务会全部出现在用户的机器列表里。
- **DeviceName 在 macOS 上被忽略**:传入 `anywhere-poc`,peer 仍以主机名注册(`Laptop-B.local`,dns label `laptop-b.vpn`)。客户端做"一台机器一个稳定名字"时要知道这一点。
- **引擎会尝试写系统路径**:日志出现 `failed to clean up temporary installer file: stat /var/lib/netbird/tmp-install: permission denied`。macOS 上因权限失败而无害,但在该路径可写的 Linux 上需要核实。应作为应用级审计项。
- **登录回调监听在 `*:53000` 而非仅回环**(`lsof` 实测),5 分钟窗口内理论上可被同网段/覆盖网设备打进来。上游行为,落地时需在那层收口。

## 端到端(经内嵌引擎的代理,浏览器解析故意打坏)

| 项 | 结果 |
| --- | --- |
| `dsh.tower-lab.netbird` | 200,38833 字节 |
| `/api/dsh-access/session` | `declared: true` |
| 非本网名字 / 未登记 dsh 名字 | 403 / 403 |
| 工作区渲染 | 完整(侧边栏、工作区、会话列表含 73 条以上、相对时间) |
| `/api/remote.mux` | 经 CONNECT 隧道 OPEN,65 秒后仍存活 |
| console / page error | 0 / 0 |

## 清理

PoC peer(`Laptop-B.local`,`100.64.1.6`)已从机队删除,机队回到 10 台;`~/.anywhere-poc` 私有目录(含 PoC 私钥)已删;本机系统级 netbird 与原有的 `studio-mac` peer 未改动。

---

# 出口验证:应用级模式下出口不通(2026-10-18 同日,第三轮)

问题:办公出口(`sci-exit` 的 28 个域名路由)在应用级(netstack)模式下是否对壳内流量生效。答案:**不生效**,而且原因在 netbird 源码里。

## 三段证据

**1. 路由确实下发并完成选路。** 引擎日志(第二台 PoC peer 加入 `sci-exit` 后):

```
server routes are disabled
New chosen route is daqak9mkeeas738pj7bg ... with peer ... for network [google.com, ..., cloudflare.com]
New chosen route is damufrmkeeas73dgphq0 ... with peer ... for network [192.168.200.0/24]
New chosen route is damufrmkeeas73dgphog ... with peer ... for network [192.168.130.0/24]
```

顺带回答了一条此前标"未验证"的事项:**办公内网段路由存在**(两条 `/24`,经 `tower-lab`)。

**2. 但流量不通,且不是拨号或代码的问题。** 新增 `fetch-static` 命令(由 App 解析名字、按地址经 netstack 拨号)后:

| 目标 | 结果 |
| --- | --- |
| `http://dsh.tower-lab.netbird/`(机队内) | 成功 |
| `https://www.cloudflare.com/cdn-cgi/trace`(在 28 域清单内) | 超时,入组前/入组后都一样 |
| `http://example.com/`(不在清单内) | 超时 |

**3. 机制在源码里。**

- 路由安装:netstack 模式下直接走 noop —— `client/internal/routemanager/manager.go:146`:`useNoop := netstack.IsEnabled() || config.DisableClientRoutes`。
- 域名路由还依赖客户端解析这些公网域,而应用级下系统 DNS 被禁用、netstack 的解析器只答机队 zone,实测报错:`dial: lookup www.cloudflare.com. on 100.64.1.5: server misbehaving`(手机端文档里记过同一个坑)。

## 结论

应用级(内嵌 userspace netstack)能给:访问自己与他人的 DSH 工作区、访问机队内任意地址。**给不了**:借办公室出口访问公网、访问办公内网段——路由虽已下发并被选中,但 netstack 模式下不安装。

因此"另加显式系统模式开关"不是可选项:**R8/R9(当 VPN 用)必须走系统模式**。产品口径建议收敛为:应用级 = 工作区与机队内访问;系统模式 = 出口与整机 VPN,默认关闭并明确提示会接管系统路由与 DNS。

## 清理

PoC peer 已从 `sci-exit` 移除(组回到 0 成员)、peer 已删除(机队 10 台)、`~/.anywhere-poc` 已删、PoC 端口(53000/19001/19002)已释放。