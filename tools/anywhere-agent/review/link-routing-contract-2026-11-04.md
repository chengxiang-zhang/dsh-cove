# 链接去向契约：内网开页签、公网交给系统浏览器（2026-11-04）

> 状态：已实现，源码检出内真实 Electron 窗口验收 19 条全绿（修前同一脚本 10 条失败，见第四节）。**打包产物未重新构建**：`/Applications/Anywhere Work.app` 里还是旧壳，需重新打包并重启应用后生效；本机没有用旧包跑 `--packaged`。
> 适用范围：`tools/anywhere-agent/shell`（桌面客户端壳）与 `tools/anywhere-agent/src`。DSH Web 页面本身不需要任何改动。

## 一、报告的现象与根因

现象：在桌面端里点页面返回的链接，**内网地址能打开，公网地址打不开**。内网地址打开的方式也不对：它开成一个没有页签条、没有关闭按钮的裸窗口，绕过了整个窗口形态。

根因是壳从来没有回答过"页面请求打开一个地址"这件事。DSH 客户端的外部链接入口是 `openExternalLink`，装配在 `@deepseek-ai/dsh-client-ui-chat` 的 `lib/client.js`：

```js
openExternalLink: (url) => {
  if (linkOpening.getSnapshot() === 'sidebar' && ctx.get('sidebarRightTabs')?.get('browser') !== void 0) ctx.sidebarRight.openTab('browser', { params: { url } });
  else window.open(url, '_blank', 'noopener,noreferrer');
},
```

`window.open` 在 Electron 里没有 `setWindowOpenHandler` 时，默认就是**新建一个 `BrowserWindow`**。那个窗口和主窗口同一个 partition（`persist:anywhere-shell`），而 partition 的代理是 agent 的 loopback 端口——只走 NetBird 的 userspace 栈，**通不了公网**。于是：

| 点的是什么 | 修前行为 |
| --- | --- |
| 内网地址（`target=_blank` / `window.open`） | 新建一个裸 `BrowserWindow` 打开，页签条和关闭按钮都不在 |
| 公网地址（同上） | 同上，只是那个窗口里页面加载失败，看起来像"链接坏了" |
| 公网地址（无 `target`，普通导航） | 直接把当前工作区页面顶掉，工作区页变成一张打不开的公网页，**没有地址栏可以回来** |

同一份壳的修前行为可复现（`poc/link-routing.mjs`，本机 Electron 44.9.0，页面由本地服务器提供）：

```
the machine page is up
  ok   machine a opened its page
  ok   one window, as before

an overlay link opens as a tab in this window
  FAIL no second window was created: 2
  FAIL the link became a tab: ["home","svc:machine:dsh.a.netbird"]
  FAIL the page area shows the linked page: {"id":2,"url":"http://127.0.0.1:56458/a","visible":true}

a link to another machine stays in this window too
  FAIL no second window was created: 3

a public link goes to the platform browser
  FAIL no second window was created: 4
  FAIL the hand-off was recorded: []

a plain navigation to a public page does not replace the page on screen
  FAIL the hand-off was recorded: []
  FAIL the page on screen was kept: {"id":2,"url":"http://news.invalid/x","visible":true}
```

## 二、契约

1. **地址决定去向，不看链接的 `target` 属性。** 同一个地址无论以 `target=_blank` 还是原地导航出现，答案一致。判定是一个纯函数：`src/link-routing.mjs` 的 `classifyLink(url, published)`，返回 `tab` / `external` / `ignore`。
2. **什么算内网（开成页签）**：loopback（`127.0.0.0/8`、`::1`、`localhost`）、覆盖网与私网地址字面量（`100.64/10`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`fc00::/7`、`fe80::/10`）、单标签名字（`tx`、`superset`——只有覆盖网 DNS 答得出来）、机队 zone（`config/fleet.json` 的 `DSH_ZONES` 与 `CLOUD_DNS_DOMAIN`）、目录与机器列表里发布过的 host、通道文档自己声明的 overlay 前缀 host。
3. **什么算公网（交给系统浏览器）**：其余所有 http(s) 地址。窗口的代理只承载覆盖网，公网页在这里必然打不开；系统浏览器没有这个限制，所以那里才是它的家。
4. **什么都不打开**：`javascript:`、`about:blank`、`data:`、空地址、不成形的 URL。`mailto:` / `tel:` / `sms:` 交给系统（它们本来就是给别的应用开的）。
5. **弹窗一律拒绝。** 壳不再产生第二个 `BrowserWindow`：`window.open` / `target=_blank` 的请求被 `setWindowOpenHandler` 接住，返回 `{ action: 'deny' }`，地址按第 2、3 条路由。
6. **同源导航放行，异源导航不许顶掉页面。** 页面自己的 SPA 路由、查询串、表单提交（同源）不受影响；会换 origin 的导航一律 `preventDefault()` 后走同一套路由。这样公网地址不可能把机器页面换掉。
7. **内网链接是新页签，不是新窗口。** 页签 `kind: 'link'`，**地址就是它的身份**：同一地址只开一个页签（再点就是切过去），写进 `tabs.json` 跟着重启恢复；地址失效的恢复项丢弃。
8. **挂掉的链接页签是错误页，不是死点击。** 它和目录里的服务用同一个失败页与「重试」；重试走**唯一**的显式重载路径（见 9）。
9. **只有用户能替换页面。** 显式刷新（菜单 / 托盘 / `⌘R` / 错误页重试）现在对"屏幕上那页"生效——机器工作区、目录服务页、链接页都算；`webContents.reload()` 仍然只有 `reloadActiveWorkspace()` 一处。链接页签不新开重载路径，`test/view-freshness.test.mjs` 的"一条重载路径"结构门继续成立。

## 三、改动清单

| 文件 | 改动 |
| --- | --- |
| `src/link-routing.mjs`（新增） | 纯判定：`classifyLink(url, { zones, hosts })` → `{ route, url, host, reason }`；loopback / 覆盖网与私网字面量 / 单标签名 / 机队 zone / 已发布 host 五类算内网 |
| `src/tabs.mjs` | 新增 `linkTabId()` / `openLink()`；`restore()` 认 `kind: 'link'` 且只恢复 http(s) 地址；模块不变量补上"一个地址一个页签" |
| `shell/main.mjs` | `installPageLinkRouting(view)` 装到**每个**原生页面（机器工作区与目录服务页）：`setWindowOpenHandler` 一律 deny 后路由，`will-navigate` 只放行同源；`linkContext()` 汇总 zone / 目录 host / 机队 host；`routePageLink()` 记录 `shell: link <route> <url> (<reason>)`；`openLinkTab()`；`tabsPayload()` 给链接页签带 `url` 与 host 兜底标题；`activateTab()` / `tabs:reload` 认链接页签；`reloadActiveWorkspace()` 扩成"屏幕上那页"；`handOffToBrowser()` 统一交给系统浏览器，并在验收模式下写 `--external-log` |
| `shell/renderer/app.js` | 链接页签算"拥有页面区"（原生页才能压在上面）；页签图标用地球、tooltip 显示地址；标题 tooltip 显示地址 |
| `test/link-routing.test.mjs`（新增） | 13 条：loopback / 覆盖网与私网范围边界（`100.127.x` 内、`100.128.x` 外）/ 机队 zone 与大小写、尾点 / 已发布 host 带端口 / 公网 / `mailto:` / 必须忽略的 scheme / reason / 缺省与脏配置 / host 解析 |
| `test/tabs.test.mjs` | 3 条：链接一地址一页签、非 web 地址不开页签、链接页签随重启恢复且坏地址被丢弃 |
| `poc/link-routing.mjs`（新增） | 19 条真实窗口验收（含重启恢复），见下 |

`--external-log <file>` 是**验收缝**：验收运行时把"交给系统浏览器"记录成文件里的一行，而不是真的在跑检查的人桌面上弹出浏览器。产品路径（不给这个参数）行为不变。

## 四、验收证据

命令（本机，本机 Electron 44.9.0；仓库不 vendor Electron）：

```sh
node tools/anywhere-agent/poc/link-routing.mjs --electron /path/to/Electron
node --test tools/anywhere-agent/test/link-routing.test.mjs tools/anywhere-agent/test/tabs.test.mjs
node --test tools/anywhere-agent/test/*.test.mjs
```

页面由本地静态服务器提供，所以"在这个窗口里加载了"是服务端看到的请求，"交给系统浏览器"是 `--external-log` 里的那一行，都不是推断。修后 19 条全绿：

```
the machine page is up
  ok   machine a opened its page
  ok   one window, as before

an overlay link opens as a tab in this window
  ok   no second window was created
  ok   the link became a tab
  ok   the page area shows the linked page
  ok   the linked page was requested once

a link to another machine stays in this window too
  ok   no second window was created
  ok   the fleet-zone link became a tab

a dead link tab stays a tab, with the error page and its retry
  ok   retry asked for that page through the explicit-reload path
  ok   the dead link is still one tab

a public link goes to the platform browser
  ok   no second window was created
  ok   the public link did not become a tab
  ok   the hand-off was recorded
  ok   the public page was never loaded here

a plain navigation to a public page does not replace the page on screen
  ok   no second window was created
  ok   no tab was added
  ok   the hand-off was recorded
  ok   the page on screen was kept

a restart brings the link tabs back, and only the link tabs
  ok   the page this machine linked to came back
  ok   the other machine link came back too
  ok   no public address is a tab, then or now

all checks passed
handed to the platform browser:
  http://public.invalid/report
  http://news.invalid/x
```

单测：`test/link-routing.test.mjs` + `test/tabs.test.mjs` 26 条全绿；`node --test tools/anywhere-agent/test/*.test.mjs` 为 268 passed / 1 failed，唯一失败是 `make-dmg.test.mjs`——本机受限文件沙箱下 `hdiutil create` 被拒（`hdiutil: create failed - 操作不被允许`），与本次改动无关，见第六节。

## 五、为什么边界画在地址上

- **窗口没有自己的网络**：壳的 partition 代理是 agent 的 loopback 端口，只走 NetBird userspace 栈。公网地址不是"懒得支持"，是在这个进程里**不可能**加载成功。把它留在这里，用户看到的永远是失败页，而同一个地址在系统浏览器里是可用的——这就是把边界放在地址上的理由。
- **裸窗口是第二个浏览器形态**：`BrowserWindow` 没有页签条、没有关闭语义、没有回列表的路，等于在窗口形态之外长出了另一个窗口形态。deny + 页签是与现有形态一致的做法，也是 `review/intranet-browser-design-2026-10-30.md` 第 3 节早就写下的定案（"页面里的 `window.open` / `target=_blank` → 新标签"）。
- **让地址成为页签的身份**：链接页签不来自目录，没有服务 id；用地址当 id 就同时得到了去重、恢复和"再点一次切过去"，不需要额外状态。
- **同源与异源分开**：SPA 的路由变化是页面自己的事，拦它等于把 DSH 页面弄坏；异源导航才是"要离开这个页面"的信号。HTTP 30x 重定向走 `will-redirect`，不经过这条判定，所以服务端跳转（例如 http→https）行为不变。
- **不新开重载路径**：错误页的重试如果自己调 `reload()`，就把"只有用户能替换页面"变成一句口号。重试的语义是"再要一次这一页"，正好就是显式刷新，所以走同一条路。

## 六、未验证

| 项 | 说明 |
| --- | --- |
| 打包产物 | **未重新打包**。源码检出验收通过；`/Applications/Anywhere Work.app` 里是旧壳，需要在 `main` 上重新打包（`.github/workflows/desktop-release.yml` 或本机 `scripts/package-mac.sh`）并重启应用后才生效 |
| Windows | 无 Windows 机器；判定与路由都是平台无关的，但真实窗口行为未在该平台验证 |
| `mailto:` / `tel:` | 单测覆盖判定；验收运行只把"交给系统"记录成日志，没有真的唤起邮件客户端 |
| DSH 侧栏浏览器模式 | DSH 客户端设置里若把链接改为在侧栏浏览器页签打开（`linkOpening = 'sidebar'`），链接不经过壳，本契约不适用；该模式本次未改、未验证 |
| 宿主自跳的公网登录流 | 若某部署的工作区页面会跳转到公网 IdP，这次会把它交给系统浏览器（修前是原地加载失败）。本机机队是 password / network-gate，没有这种流，未做真实验收 |
| 弹窗型页面 | `window.open` 一律 deny，所以依赖弹窗的应用（例如需要打印预览窗口的第三方看板）会改为开一个页签；本机目录里的服务未逐个走查 |
| `make-dmg.test.mjs` | 本机受限文件沙箱下 `hdiutil create` 被拒，属环境限制，与本次改动无关；`view-freshness.test.mjs` 的"一条重载路径"结构门在本次改动后仍通过 |