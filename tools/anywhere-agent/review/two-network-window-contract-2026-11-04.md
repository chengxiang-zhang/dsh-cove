# 双网络窗口契约：公网直连、内网走 agent、页面链接开成页签（2026-11-04）

> 状态：已实现并已安装。本机真实 Electron 窗口验收 16 条全绿（源码检出与安装路径的 `--packaged` 各一遍，见第四节），整套桌面单测 272 条全绿。安装值为 0.7.1 / CFBundleVersion 94；旧包按序保留在 `/Applications/Anywhere Work.app.retired-20261104`、`-1`、`-2`、`-3`，回滚是一条命令：`rm -rf "/Applications/Anywhere Work.app" && mv "/Applications/Anywhere Work.app.retired-20261104" "/Applications/Anywhere Work.app"`。
> 适用范围：`tools/anywhere-agent/shell`（桌面客户端壳）与 `tools/anywhere-agent/src`。DSH Web 页面本身不需要任何改动。

## 一、产品事实：这个窗口有两个网络

桌面客户端不是"只能进私网"的窗口，它是一个同时接两条网的浏览器：**机器自己的网络**（公网、办公网，操作系统本来就能到）和**机队的 NetBird 私网**（只有 agent 的 loopback 代理能到，操作系统不认识那些名字）。

一个 Chromium session 只有一个代理设置，所以"这条请求走哪张网"必须逐请求决定。此前整个 session 的代理被设成 agent 的 loopback 代理（`proxyRules`），结果是**所有**请求都塞进覆盖网：公网页面（飞书登录页、datasage 报告）在窗口里必然加载失败。把"公网地址一律外跳系统浏览器"当作绕法也不成立——登录链（应用 → Casdoor → 飞书 → 回到内网应用）必须在同一个浏览会话里闭环，跳到系统浏览器后回不到 `.netbird` 地址。

## 二、契约

1. **流量按地址逐请求分流**（`src/proxy-pac.mjs` 生成 PAC）：覆盖网名字 → `PROXY <agent 代理>`；其它一律 `DIRECT`。覆盖网名字是：单标签名（`tx`、`superset`）、机队 zone（`DSH_ZONES` + `CLOUD_DNS_DOMAIN`）、部署发布过的 host（服务目录、机器列表、通道文档的 overlay 前缀），以及 `100.64/10` 地址字面量。**loopback 永远 DIRECT**：本机工作区不依赖私网，私网断了它也要能开。
2. **公网页面就是本窗口的页面**。没有"公网一律外跳"的特例：登录跳转（应用 → Casdoor → 飞书 → 回到内网应用）在同一个页签里走完并回到原处。
3. **链接**：web 地址 → 页签（`kind: 'link'`，**地址即身份**，同一地址一个页签，写进 `tabs.json` 跟着重启恢复）；`mailto:` / `tel:` / `sms:` → 交给系统（它们是别的应用的地址）；其它 scheme（`javascript:`、`about:`、`data:`）丢弃。弹窗一律 deny 后开成页签，本窗口不产生裸 `BrowserWindow`。
4. **导航交给页面**。只拦非 http(s) 的导航（否则点一个 `mailto:` 会把页面导航成一屏空白），同源与异源都由页面自己走——SSO 回环依赖这一点。
5. **页签恢复先等事实就位**：等机器列表（有界 45 秒）与等代理生效，然后才恢复并激活最后一个页签。否则会出现两种静默损坏：目录还没到就把机器页签当"已下线"丢掉；页面在代理生效前发出请求，覆盖网名字撞系统 DNS 失败，页签一起来就是错误页。
6. **只有用户能替换页面**：显式刷新（菜单 / 托盘 / `⌘R` / 错误页重试）命中"屏幕上那页"，`webContents.reload()` 仍只有一处。

## 三、改动清单

| 文件 | 改动 |
| --- | --- |
| `src/proxy-pac.mjs`（新增） | 生成 PAC：`pacScript({ upstream, zones, hosts })` → 脚本源码；`pacDataUrl()` → Chromium 接受的 `data:` URL；`proxyEntryOf()` 把代理 URL 变成 `PROXY host:port`；PAC 里的常量放在顶层（helper 函数看不到函数内 `var`） |
| `src/link-routing.mjs` | 只回答"这条链接怎么开"：web 地址 → 页签；系统 scheme → 外跳；其余忽略。网络分流不再在这里判断 |
| `shell/main.mjs` | `applyAgentProxy` 改为安装 PAC（zone / host 变化时重建，签名相同则不动）；`overlayContext()` 汇总 zone 与已发布 host；`installPageLinkRouting()`：弹窗 deny→页签、导航只拦非 http(s)；`restoreTabs()` 等机器列表与代理；`tabs:reload` 的链接页签走唯一重载路径；`--external-log` 验收缝 |
| `shell/renderer/app.js` | 链接页签算"拥有页面区"（原生页才能压在上面）、地球图标、地址 tooltip |
| `src/tabs.mjs` | 链接页签：`linkTabId()` / `openLink()` / `restore()` 认 `kind: 'link'`；"一个地址一个页签"写进模块不变量 |
| `test/proxy-pac.test.mjs`（新增） | 10 条：在最小 PAC 运行时里执行生成的脚本，断言覆盖网走代理、公网直连、loopback 直连、zone 是后缀匹配、发布 host 忽略大小写与端口、无可用代理时不生成脚本 |
| `test/link-routing.test.mjs` / `test/tabs.test.mjs` | 链接方向与页签模型（含链接页签重启恢复）；恢复先等列表的顺序由文本门钉住 |
| `poc/public-and-overlay.mjs`（新增） | 16 条真实窗口验收，见下 |

## 四、验收证据

命令（本机 Electron 44.9.0；仓库不 vendor Electron）：

```sh
node tools/anywhere-agent/poc/public-and-overlay.mjs --electron /path/to/Electron
node tools/anywhere-agent/poc/public-and-overlay.mjs --packaged --electron "/path/to/Anywhere Work.app/Contents/MacOS/Electron"
node --test tools/anywhere-agent/test/*.test.mjs
```

验收脚本起两个服务器：一个是被代理转发的"覆盖网"（stub agent proxy，只记录到达它的请求），一个是直连可达的"公网"（由 Chromium 的 resolver 规则指到本机）。所以"走了哪张网"不是推断，是两份日志的差别。16 条全绿：

```
the machine page loads through the agent
  ok   the page came up
  ok   the request went through the agent proxy
  ok   one window, as always

a sign-in flow through a public identity provider completes in the tab
  ok   the flow came back to the machine
  ok   the provider was reached directly, not through the agent
  ok   the signed-in page is the one in the tab

a public link opens as a tab, directly
  ok   no second window was created
  ok   the link became a tab
  ok   the public page loaded directly
  ok   the public page did not go through the agent

a public link without a target navigates in this tab
  ok   the page on screen is the public one
  ok   no tab was added

a scheme another application owns is handed over
  ok   the hand-off was recorded
  ok   the page on screen was kept
  ok   no web address was handed to another application

a restart brings the link tab back
  ok   the public link tab came back
  ok   the machine tab came back

all checks passed
handed to the platform:
  mailto:someone@example.com
through the agent: dsh.a.netbird /a, dsh.a.netbird /sso, dsh.a.netbird /after, ...
```

安装路径复验：`0.7.1` / CFBundleVersion 94，`codesign --verify --deep --strict` 通过，用 `/Applications/Anywhere Work.app/Contents/MacOS/Electron` 跑 `--packaged` 同样 16 条全绿。

真机启动（日志 `~/Library/Logs/Anywhere-Work.log`）：`shell: session proxy http://127.0.0.1:19001 for 2 zone(s), 32 host(s)` → 机队 31 台可达 → `shell: select dsh.leo-mac.netbird -> found`，无 `did-fail-load`，5 个机器页签从 `tabs.json` 恢复。

桌面单测 `node --test tools/anywhere-agent/test/*.test.mjs` 为 272 passed / 0 failed。

## 五、为什么把"网络"和"链接"分成两层

- **网络是一层、链接是一层，问题不同**：能不能到由地址决定（代理分流）；怎么开由页面意图决定（同一张网里的一个链接）。上一版把两者混成一个 `classifyLink`，于是"公网"既被判成"不可达"又被判成"不许在这里开"，SSO 这类**必须在这里开**的公网页面就无处安放。
- **PAC 而不是外跳**：外跳把登录状态带出窗口，回程地址是覆盖网名字，系统浏览器解析不了。PAC 只决定每条请求走哪条路，页面、cookie、重定向链都留在同一个会话里。
- **loopback 例外**：本机工作区必须在私网断开时也能打开，它是唯一不依赖机队名字的入口。
- **恢复要等事实**：`tabs.json` 与机器列表、代理三者到达顺序不确定；先恢复会静默丢页签或让第一页撞 DNS。等待有界（45 秒），因为"这台机器确实没有别的机器"也是一个合法终态。

## 六、未验证

| 项 | 说明 |
| --- | --- |
| 真实飞书登录的人工点击 | 契约在夹具里验到"公网身份提供方 + 回到内网应用"的完整回环；本会话没有在真实 datasage/Casdoor 上由人手点一次（屏幕捕获权限被拒，无法留截图） |
| Windows | 无 Windows 机器；PAC、路由与重载路径都是平台无关的，但真实窗口未在该平台验证 |
| 依赖弹窗的页面 | `window.open` 一律 deny 后开页签；依赖 popup 返回结果（`window.opener` 回传）的第三方页面会失去那条回传通道，本机目录里的服务未逐个走查 |
| 其它网卡/路由形态 | PAC 只区分"覆盖网名字"与"其它"；机器自己网络里需要代理才能到的地址（例如办公网出口代理）不在本契约内 |
| `make-dmg.test.mjs` | 受限文件沙箱下 `hdiutil` 会被拒；本会话放开权限后整套单测包含它在内为 272/272 通过 |