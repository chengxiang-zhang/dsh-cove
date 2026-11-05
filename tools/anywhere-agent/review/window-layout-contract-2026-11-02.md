# 窗口尺寸、原生页面几何与层序契约（2026-11-02）

> 状态：报告的现象已修，本机真实 Electron 窗口内实测通过，重新打包并安装到 `/Applications` 后复验通过；Windows、多显示器与本机之外的环境未验证，见第七节。
> 适用范围：`tools/anywhere-agent/shell`（桌面客户端壳）。DSH Web 页面本身不需要任何改动。

## 一、报告的现象与根因

现象：拖动窗口改变宽高时，窗口里的服务页面不跟着变，切一次页签后才适应。

根因不在页面，也不在 CSS：服务页面是 `WebContentsView`，一块**原生面**，画在整个 renderer 之上，它的几何不是 CSS 能重排的属性，而是主进程调用 `view.setBounds` 放置出来的结果。修前这个放置只由一个来源驱动——renderer 的 `apply()`（快照或页签推送触发）里调用一次 `api.detailBounds(rect)`。

- renderer 侧没有任何布局监听：修前 `shell/renderer/app.js` 里 `resize` / `ResizeObserver` 匹配数为 0；
- main 侧也没有窗口监听：修前 `shell/main.mjs` 里 `on('resize')` / `on('enter-full-screen')` 匹配数为 0。

于是窗口改变尺寸这件事，谁都不知道。它只在**下一次推送**到来时被顺带修正，而切页签恰好会产生一次推送——这就是"切 tab 之后才适应"的全部原因。同一个洞也吞掉了全屏、窗口缩放和 over­lay：凡是"不产生推送的布局变化"都不会被放置层看到。

## 二、三层结构，两种坐标

| 层 | 谁拥有 | 能表达什么 | 不能表达什么 |
| --- | --- | --- | --- |
| 窗口 chrome（页签条、首页、设置、面板） | renderer（DOM） | 一切 CSS 布局 | 不能画到原生面之上 |
| 服务页面 | main（`WebContentsView`） | 自己页面内部的一切 | 自身的位置与尺寸 |
| 菜单与焦点 | main（`Menu`） | 与焦点无关的命令 | 菜单项若不存在，焦点在页面时命令就不可达 |

两条硬事实，构成本次契约的前提：

1. **原生面永远在 renderer 之上**，没有 z-index 能翻转它；DOM 想盖住页面，只能让页面先让位。
2. **坐标不是一套**：`getBoundingClientRect` 给 CSS 像素（受窗口 zoom 影响），`setBounds` 要 DIP。同一个数字在两个坐标系里含义不同。

## 三、契约

### 3.1 唯一的测量方，唯一的放置方

- **测量**：只有 renderer 知道页面区在哪，所以 renderer 报告页面区矩形（CSS 像素），且只在"布局真的变了"时报（`shell/renderer/app.js:736`、`:726`）。
- **放置**：只有 main 能调 `setBounds`，所以 main 是唯一的放置方，并且**每次放置都重新换算**，不缓存 DIP 结果（`shell/main.mjs:1436`、`:1457`）。
- 上报带幂等键、放置带 `sameRect` 去重：一次拖拽缩放是每帧一次布局变化，但只有真正变化的帧才会产生 IPC 和 `setBounds`。

### 3.2 单位换算

换算只发生在放置那一刻，纯粹函数放在 `src/view-geometry.mjs:43`：DIP = CSS × zoomFactor，并按窗口内容区夹紧。夹紧不是防御性编程——窗口缩小后的那一帧里，renderer 报的还是旧尺寸，不夹紧就会有一块原生面画到窗口外面，看起来像黑边。

### 3.3 触发源

| 触发 | 位置 | 覆盖的变化 |
| --- | --- | --- |
| `ResizeObserver(#page)` | `renderer/app.js:766` | 页面区自身的盒子变化：横幅/agent 条出现消失、页签条换行 |
| `window resize` | 同上 | 拖拽缩放、最大化、还原、分屏吸附 |
| `visualViewport resize` | 同上 | 窗口 zoom 导致的视口变化 |
| 窗口 `resize` / `restore` | `main.mjs:1931` | 窗口比下一帧更早变化的那段空窗期 |
| `enter-full-screen` / `leave-full-screen` | `main.mjs:1935` | 全屏动画结束后的最终尺寸 |
| `zoom-changed` | `main.mjs:1939` | 缩放改变 CSS↔DIP 汇率而布局"没变"的情形 |
| 快照/页签推送 | `renderer/app.js:161` | 页签切换、打开、关闭 |
| overlay 开关 | `main.mjs:2660` | 面板盖住页面区、以及面板期间的 resize |

### 3.4 可见性归属

可见性仍由打开页签的那条路径决定（`showWorkspace`、`showWebView`），放置层只回答"放哪里"，并在没有地方放时隐藏机器工作区。overlay 期间的例外写在两处：打开时隐藏（`main.mjs:2660`），关闭时用**当前**窗口尺寸重新放置（`showCurrentSurface`，`main.mjs:1489`），所以"面板开着的时候改了窗口大小"不会丢。

### 3.5 层序

面板（⌘K）、服务器地址栏都是 DOM，盖住页面区时必须让原生面让位（`renderer/app.js:781` → `main.mjs:2660`）。这是一条状态，不是样式：只有 renderer 知道"有没有东西正盖在页面区上"。

### 3.6 命令与焦点

按键去焦点所在的那一层。页面被点中之后焦点在原生面里，renderer 上的 `keydown` 收不到 ⌘K/⌘W/⌘T/⌘, ——这些命令等于只在"首页"可用。因此命令进菜单（`main.mjs:1810` 起）：文件菜单给新页签/关闭页签，应用菜单给设置，视图菜单给"跳到服务…"。菜单快捷键不依赖焦点，renderer 的 keydown 保留为普通情况下的同一条路径。

另外删掉了两个"看起来能用但没有接收方"的菜单项（搜索机器、显示或隐藏侧栏）以及对应的 `sidebar` IPC：没有接收方的命令是缺陷，不是装饰。

### 3.7 外观

页面自己会画背景，但在"挂载完成到首次绘制"之间露出的是 `view.setBackgroundColor`。切换深浅色时同步这条颜色（`main.mjs:1513`），否则浅色窗口里的深色页面会闪一帧旧底色。

## 四、场景走查矩阵

状态含义：**已实测**＝本机真实窗口内断言通过；**同契约覆盖**＝走的是已实测的同一条路径，但该场景未单独起跑；**未修**／**无法验证**见备注。

| # | 场景 | 期望 | 走查结论 |
| --- | --- | --- | --- |
| 1 | 拖拽缩放（放大） | 页面跟着变宽、变高 | 修前失败，已实测修复 |
| 2 | 拖拽缩放（缩小） | 页面跟着变窄、变矮，不留黑边 | 修前失败，已实测修复 |
| 3 | 双击标题栏最大化 / 还原 | 同 1、2 | 同契约覆盖（同一 `resize` 源） |
| 4 | 进入全屏 / 退出全屏 | 动画结束后占满内容区 | 修前失败，已实测修复 |
| 5 | 窗口分屏吸附（macOS tile / Windows snap） | 同 1、2 | 同契约覆盖 |
| 6 | 最小化后恢复 | 回到原尺寸 | 同契约覆盖（`resize`/`restore`） |
| 7 | 窗口缩放 ⌘+/⌘-（shell 自身） | 页面仍铺满，不出现尺寸错位 | 已实测换算路径（`setZoomFactor(1.25)`）；菜单 role 本身未单跑 |
| 8 | 页面自己缩放（焦点在页面时 ⌘+） | 只影响页面内部，不改放置 | 结构上不受影响，未单跑 |
| 9 | 显示器间移动、DPR 变化 | 布局不变即无需重新放置 | 无法验证（本机单显示器） |
| 10 | 横幅 / agent 条出现或消失 | 页面区 y 与高度跟着变 | 同契约覆盖（`ResizeObserver`），未单跑 |
| 11 | 页签条因页签过多换行 | 页面区整体下移 | 同契约覆盖（`ResizeObserver`） |
| 12 | 页签切换 / 打开 / 关闭 | 页面在该在的位置 | 修前已正确（推送驱动），本次回归通过 |
| 13 | ⌘K 面板盖住页面区 | 面板可见、可交互，页面让位 | 修前失败（面板被原生面盖住），已实测修复 |
| 14 | 服务器地址栏盖住页面区 | 同上 | 同契约覆盖（同一个 overlay 状态） |
| 15 | 面板开着时改变窗口 | 关闭面板后页面按新尺寸回来 | 已实测 |
| 16 | 焦点在页面里按 ⌘K/⌘W/⌘T/⌘, | 命令生效 | 修前失败（renderer 收不到），已实测（菜单命令可达 + 页面吃掉按键） |
| 17 | 焦点在页面里按 ⌘R | 刷新 | 修前已正确（本就在菜单里） |
| 17b | 点 chrome 行上的刷新控件（焦点原先可以在页面里） | 页面立即被替换，页签条不动，不读取机器列表 | 2026-11-05 新增。命令 `refreshScreen` 只 `reloadActiveWorkspace()`；页面里的 ⌘R 在其 `before-input-event` 接住，窗口自身也同样接线，菜单/托盘调同一条命令。`poc/shell-states.mjs` 断言控件在 `#tabbar` 内、有可访问名、提示写 ⌘R、准备中仍可用且按下不产生读取；`poc/tab-residency.mjs` 断言点击替换一次页面（且零列表读取）、窗口层与页面层的 ⌘R 各替换一次、页签条与激活页签不变 |
| 18 | 深浅色切换 | 页面底色跟随，不闪旧色 | 修前失败（底色停留在创建时），已修，未跑视觉走查 |
| 19 | 页面加载失败 | 落错误页，几何无关 | 未改动，未回归 |
| 20 | 第二个实例 / 多窗口 | 单窗口模型，不适用 | 不适用 |

## 五、改动清单

| 文件 | 改动 |
| --- | --- |
| `src/view-geometry.mjs`（新增） | CSS→DIP 换算、夹紧、放置幂等比较 |
| `test/view-geometry.test.mjs`（新增） | 8 条：缩放两个方向、夹紧、脏输入、幂等 |
| `shell/renderer/app.js` | 布局驱动的几何上报（`ResizeObserver` + `resize` + `visualViewport`）、overlay 状态上报、菜单命令监听 |
| `shell/main.mjs` | 每次放置重新换算并夹紧、overlay 让位与回归、窗口/全屏/缩放触发、原生面底色随主题重刷、菜单补齐页签与设置命令、删除无接收方命令 |
| `shell/preload.cjs` | `setOverlay` 转发；删除无接收方的 `setSidebar` |
| `poc/resize-contract.mjs`（新增） | 26 条断言的窗口几何验收 |

## 六、验收证据

命令（本机，Electron 44.9.0）：

```sh
node tools/anywhere-agent/poc/resize-contract.mjs --electron /path/to/Electron
node tools/anywhere-agent/poc/resize-contract.mjs --packaged --electron "/path/to/Anywhere Work.app/Contents/MacOS/Electron"
node --test tools/anywhere-agent/test/view-geometry.test.mjs
node --test tools/anywhere-agent/test/*.test.mjs
```

`--packaged` 跑的是打包产物本身的 payload（打包应用会忽略 app 目录参数），用来证明"交付给人双击的那个产物"而不是"当前检出"通过了验收。

同一份脚本在修前与修后各跑一次，修前 13 条失败，其中最能说明问题的是：

```
FAIL bounds followed the larger window:
  bounds={"x":0,"y":38,"width":1000,"height":722}
  expected={"x":0,"y":38,"width":1260,"height":831}
  content={"width":1260,"height":869}
FAIL the page really got wider: 1000 -> 1000
```

窗口内容区已经是 1260×869，原生面还停在 1000×722，页面自己的 `innerWidth` 一直是 1000：这正是报告里的"不跟着变"。修后同一时刻：

```
ok bounds followed the larger window
ok the page reflowed wider without a tab switch
ok the page really got wider: 1000 -> 1260
```

页面自身的截图（`poc/evidence/resize/page-after-growing.png`，只在本机保留）显示页面视口为 1260×831，与窗口内容区减去 38px 页签条一致。整套 26 条断言在源码检出与重新打包的 `Anywhere Work.app` 上各跑一遍，均为全绿；`test/view-geometry.test.mjs` 8 条全绿。

仓库门禁：`pnpm -w typecheck`、`pnpm -w test`（1372 passed，1 skipped）、`node scripts/verify-docs.mjs`、`node --test scripts/*.test.mjs`（457 passed）、`node --test test/*.test.mjs`（247 passed）均通过。

交付：打包产物在 `tools/anywhere-agent/build/Anywhere Work.app`（本地构建产物，不入库），并已安装覆盖 `/Applications/Anywhere Work.app`（0.4.10 → 0.5.0）；旧包保留在 `/Applications/Anywhere Work.app.retired-20261102`，回滚即把它移回原位。安装后的产物用同一脚本加 `--packaged` 再跑一遍，26 条断言仍全绿。

## 七、未修与无法验证

| 项 | 说明 |
| --- | --- |
| Windows | 无 Windows 机器。窗口 frame、自定义 titlebar、系统缩放比例下的行为未验证 |
| 多显示器 / DPR 变化 | 本机单显示器，无法验证。设计上 bounds 用 DIP，并已接 `resize`，理论上无需额外放置；若将来出现 1px 抖动，再考虑接 `screen.on('display-metrics-changed')` |
| 菜单 role 缩放（⌘+/⌘-） | 已验算换算路径，未用真实菜单项跑视觉走查；若将来禁用 renderer 缩放，`visualViewport` 这条触发也要复核 |
| 外观切换的视觉证据 | 已改代码路径，未截图比对深浅色下的首帧底色 |
| 面板、地址栏以外的 DOM 覆盖物 | 当前只有这两个；新增覆盖物必须调用 `syncOverlay`，否则会重犯本缺陷 |
| 焦点路由 | "页面吃掉按键"是实测的；但"OS 把 ⌘K 发给谁"取决于系统与焦点，自动化里无法完整复现，结论以菜单入口可用为准 |
