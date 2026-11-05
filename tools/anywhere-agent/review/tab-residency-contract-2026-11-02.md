# 页签常驻契约：切页签不重建、不重载（2026-11-02）

> 状态：报告的现象已修，本机真实 Electron 窗口内实测通过（源码检出 15 条全绿）；重新打包的 `Anywhere Work.app`（0.6.1，CFBundleVersion 33）用 `--packaged` 复验同样 15 条全绿，并已安装覆盖 `/Applications/Anywhere Work.app`。壳现在没有任何自动重载：切页签、睡眠醒来都不重建不重载，只有应用重启、用户打开页签/「新会话」/显式刷新会加载或替换页面。Windows 未验证，见第六节。
> 适用范围：`tools/anywhere-agent/shell`（桌面客户端壳）。DSH Web 页面本身不需要任何改动。

## 一、报告的现象与根因

现象：切到另一个页签再切回来，DSH 工作区页面被销毁、重新加载——要再等一次首屏，"Loading plugins" 重来一遍，页面里的位置和未发送草稿一起丢。

根因不在页面，也不在 Chromium：是壳自己给常驻页加了两个**按时间**的策略，两者都在猜"页面的更新连接已经死了"。

| 位置 | 策略 | 修前行为 |
| --- | --- | --- |
| `src/view-freshness.mjs` | `HIDDEN_STALE_AFTER_MS = 5 分钟` | 页签离开屏幕超过 5 分钟，再打开时 `webContents.reload()` |
| `shell/main.mjs` | `IDLE_DISCARD_MS = 10 分钟` + 每分钟的 `reclaimIdleViews` | 隐藏超过 10 分钟，`dropWorkspaceView()` 直接销毁页面，下次打开整页重载 |

这个猜测在常见情形下是错的：隐藏的页签**不会**断开它的更新连接，Chromium 还会主动把后台页的内存还回来（实测隐藏几秒后 renderer 合计 428MB → 220MB，见 [多标签负载实测](multi-tab-load-test-2026-10-30.md)）。所以这两个定时器付出的代价（用户的位置、草稿、等待）换回来的是浏览器本来就会回收的内存。

把同一份壳的阈值缩到秒级（1.5s / 4s，仅用于把分钟级事实压成秒级证据）后，修前行为可复现：

```
open a: id=2 counts={"/a":1}
hide 2s then switch back -> id=2 counts={"/a":2}   # reload，服务端看到第二次 GET /a
hide 5s then switch back -> id=3 counts={"/a":3}   # 旧 view 被销毁，新 view 整页重载
stderr:
shell: reloading dsh.a.netbird after being off screen
shell: reclaiming idle page dsh.a.netbird (0 min off screen)
```

## 二、契约

1. **页签打开后，页面常驻。** 切走只是 `setVisible(false)`，切回只是 `setVisible(true)`：不 reload、不重建、不换 `webContents`。路由、滚动位置、未发送草稿都跟着页面留着。
2. **页面只在这两种情况被导航**：视图还没有页面（首次打开）；用户点「新会话」（`fresh`，回到机器的前台门，而不是重载原来的路由）。
3. **页面只在一种情况被重载**：用户显式刷新（`shouldReloadOnRefresh`，菜单 / 托盘 / `⌘R` / chrome 行右侧的刷新控件）。没有第二种自动重载：机器从睡眠中醒来也**不**重载页面，醒来只重读一次机器列表（可达性/未读/引擎状态），页面的 socket 重连是 DSH 客户端自己的循环。
4. **页面只在这两种情况被销毁**：页签关闭；机器持续缺席机器列表超过 `VIEW_PRUNE_GRACE_MS`（`viewsToPrune`，目前 10 分钟，针对的是机器真的不在了，不是时间过去）。
5. **没有任何自动重载。** 页面只在应用重启（从地址加载）、用户打开页签/点「新会话」（导航）、用户显式刷新（重载）这三种动作下被加载或替换；不按时间、不按睡眠、不按隐藏时长。判定只在 `src/view-freshness.mjs`，单测 `test/view-freshness.test.mjs`。
6. **隐藏期间连接真断了的兜底**是 DSH 客户端自己的重连循环（500ms→10s，带抖动、持续），以及用户的显式刷新。壳不再用"屏外时长"代理"连接已死"。
7. **刷新就是重载，入口多、动作只有一个。** `refreshScreen()` 只做 `reloadActiveWorkspace()`：不读机器列表、不碰 agent、不设锁定、不去重。列表的新鲜度归心跳与那些真正改变它的事件（连接/断开、登录、打开机器），一个按键不再顺带探测整张网——那正是「点刷新要等很久」和「读失败就什么都不发生」的来源（2026-11-05 补，来自用户实测反馈）。入口：控件（`refresh` IPC）、窗口 `before-input-event`、每个原生页面的 `before-input-event`、View 菜单项、托盘项，五处都调同一条命令。验收：控件在 chrome 行内、可见、有名字、提示写 ⌘R、本机准备中仍可用且按下不产生读取（`poc/shell-states.mjs`）；点击替换一次页面且不产生列表读取、窗口层与页面层的 ⌘R 各替换一次、页签条与激活页签不变（`poc/tab-residency.mjs`）；「刷新只是重载」有静态断言（`test/view-freshness.test.mjs`）。

## 三、改动清单

| 文件 | 改动 |
| --- | --- |
| `src/view-freshness.mjs` | 删除 `HIDDEN_STALE_AFTER_MS`、`WAKE_STALE_AFTER_MS`、`shouldReloadOnWake` 与 `reload` 分支；`workspacePageAction({ hasPage, fresh })` 只回答 `load` / `reuse`；只保留显式刷新一条重载判定 |
| `shell/main.mjs` | 删除 `IDLE_DISCARD_MS`、`reclaimIdleViews`、`startIdleReclaim`、`workspaceHiddenSince`；`showWorkspace` 不再按屏外时长重载；`hideWorkspace` / `dropWorkspaceView` 同步去掉时间记账；删除 `powerMonitor` 醒来重载（醒来只重读机器列表） |
| `test/view-freshness.test.mjs` | 改为断言"无自动重载"：`reuse` 不随时间改变、`activateTab` 不导航、壳里不再有 idle 回收与醒来重载、`webContents.reload()` 只剩显式刷新一处 |
| `poc/tab-residency.mjs`（新增） | 15 条断言的真实窗口验收：切走不销毁、切回同一 `webContents`、多次往返不产二次请求、显式刷新仍重载、关页签销毁页面 |
| `DESIGN.md` / `docs/README.md` | 指向本契约，替换原来"5 分钟重载"的说法 |

## 四、验收证据

命令（本机，Electron 44.9.0）：

```sh
node tools/anywhere-agent/poc/tab-residency.mjs --electron /path/to/Electron
node tools/anywhere-agent/poc/tab-residency.mjs --packaged --electron "/path/to/Anywhere Work.app/Contents/MacOS/Electron"
node --test tools/anywhere-agent/test/view-freshness.test.mjs
node --test tools/anywhere-agent/test/*.test.mjs
```

页面由本地静态服务器提供并自己数加载次数，所以"重载了"是服务端看到的第二个 `GET`，不是推断。修后源码检出 15 条全绿：

```
a fixed tab loads its page once
  ok   machine a opened its page
  ok   the page was requested once

leaving a tab hides its page instead of destroying it
  ok   the page process is still alive off screen
  ok   leaving did not reload the page

coming back shows the same page
  ok   the same web contents came back
  ok   coming back did not reload the page
  ok   the page is on screen again

switching between two tabs keeps both pages resident
  ok   machine b opened a second page
  ok   three round trips did not reload a
  ok   three round trips did not reload b
  ok   both pages are still alive

explicit refresh still reloads the page on screen
  ok   refresh reloaded the page
  ok   refresh kept the page identity

closing a tab destroys its page
  ok   the closed page was destroyed
  ok   the other tab kept its page

all checks passed
```

`test/view-freshness.test.mjs` 8 条全绿，其中三条是结构门：壳里不再有 `hiddenSince` / idle 回收，`activateTab` 的整个函数体不含 `reload` / `loadURL`。

仓库门禁（本机）：`pnpm typecheck`、`pnpm test`（shared 37 条、dsh-web-all 1375 passed / 1 skipped）、`git diff --check` 通过；`node scripts/verify-docs.mjs`（`pnpm docs:check` 的同一门禁）通过。`node --test tools/anywhere-agent/test/*.test.mjs` 为 248 passed / 0 failed（版本门要求的两个 manifest 已由 `886bcc7` 同步到 0.6.1）。`make-dmg.test.mjs` 在受限文件沙箱下会因 `hdiutil` 被拒失败，放开文件访问后 3 条全过。

## 五、为什么没有任何自动重载

- **内存不是理由**：Chromium 自己会还后台页的内存（同上实测）。壳再按时间销毁，等于用用户的位置换一份浏览器已经还过的内存。
- **"连接可能已死"不是理由**：页签隐藏时页面进程仍在跑，socket 仍在；真断了是 DSH 客户端重连的事，重连不上是刷新的事——两件都是页面自己的状态，壳用分钟数猜不出来。
- **睡眠醒来同理**：醒来时页面 socket 随挂起而死，但重连仍是 DSH 客户端自己的循环（500ms→10s、带抖动、持续），壳能补的只有机器列表那三个答案的重读；用"睡了多久"去换页面，同样是拿用户的位置赌一个没有依据的判断。
- **代价是确定的**：一次重载 = 一次首屏等待（实测 2.5–3.2s），加丢位置与草稿；而它保护的问题在隐藏页上通常根本没有发生。

## 六、未验证

| 项 | 说明 |
| --- | --- |
| 打包产物 | 已复验：`--packaged` 对 0.6.1（CFBundleVersion 33）的 `Anywhere Work.app` 跑同一份脚本，15 条全绿；payload 的 `main.mjs` / `view-freshness.mjs` 与提交 HEAD 的 blob 逐字节一致。payload `package.json` 的 build 标为 `33-dirty`，原因是同一工作区里有另一会话未提交的 `docs/fleet-upgrade-0.6.1-20261102.md`（未被拷进 payload），不是应用源码不干净。已安装覆盖 `/Applications/Anywhere Work.app`；0.5.0 旧包保留在 `/Applications/Anywhere Work.app.retired-20261102-2139` |
| 安装后的人工验证 | 装好的是新包，但正在运行的进程还是旧包；重启 App 后才生效。本机未经人手点击验证，验收以 `--packaged` 的 15 条断言为准 |
| 隐藏数小时后的页面内容新鲜度 | 契约只保证"不重建、不重载、同一页面"；页面内容是否最新由 DSH 客户端自己的重连决定，属宿主行为，不在壳的控制面 |
| 睡眠醒来后的页面内容新鲜度 | 醒来不再自动重载，页面靠 DSH 客户端自己重连；本机未做真实的合盖/开盖走查，只做了"醒来不重载"的结构门断言 |
| 内存长期读数 | 多页签常驻数小时的总内存未做小时级测量；已有实测支持"Chromium 会还后台页内存"这一判断 |
| Windows | 无 Windows 机器，`WebContentsView` 的可见性/内存行为未在该平台验证 |
| 机器真的下线 | 仍走 `viewsToPrune` 的 10 分钟缺席宽限销毁；该路径本次未改，也未回归 |
