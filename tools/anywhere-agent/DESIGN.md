# 桌面客户端设计规范

> **施工状态（2026-10-30）**：窗口形态已改为「单行页签条 + 服务页」，本文件第六节（三列 + rail）、第七节（首页面板）、第十节（面板动作）与第十四节的 rail 断言描述的是**改造前**的形态，保留作历史依据。
> 现行界面与交互规格见 `review/desktop-product-design-spec-2026-10-30.md`，决策与分期见 `review/desktop-intranet-browser-plan-2026-10-30.md`。
> 仍然有效且继续执行的部分：第一节（产品是什么）、第八节（登录是可选项）、第九节（只读本机状态）、第十一节（未查看结果）、第十二节（文案）、第十三节（视觉与可访问性）、第十五到十六节（版本与安装包）。

本文件是客户端交互与视觉的唯一验收依据。它不发明规则:每条都标出来源,并写清在本产品里**长什么样、怎么被机器检查**。

## 来源

- Apple, Human Interface Guidelines:
  - [App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons)
  - [Branding](https://developer.apple.com/design/human-interface-guidelines/branding)
  - [Windows](https://developer.apple.com/design/human-interface-guidelines/windows)
  - [The menu bar](https://developer.apple.com/design/human-interface-guidelines/the-menu-bar)
  - [Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)
  - [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)
- Nielsen Norman Group, [10 Usability Heuristics for User Interface Design](https://www.nngroup.com/articles/ten-usability-heuristics/):下文以 `H1`–`H10` 引用。
- 同代桌面客户端的既有做法(Codex / Claude Code / Cursor 的窗口):左侧一层导航 + 中央内容,单行分组标签、圆角选中行、行内徽标、底部账号条;窗口不铺装饰,密度只放在列表上。本产品借的是**工艺**,不是它们的结构。
- 本仓库既有的品牌门禁:`tools/dsh-netbird/brand/tokens.json` 是唯一真值,`scripts/dsh-netbird-brand.test.mjs` 对每个上线的文字/背景组合断言 **WCAG AA**。

## 一、这个产品是什么

工具,不是内容产品:用户带着一个明确任务来(进入某台自己机器的会话),完成后离开。目标函数是**最短的可靠路径**。由此:

- 主界面只回答两件事:**我有哪些机器**、**现在能不能进**。
- **本机不需要账号**:这台电脑上的工作区是客户端自己能建立的事实,不是网络给的待遇。私网只负责**其他**机器,所以它是用户点开的一项增强。
- 首屏不摆内部信息(协议号、引擎版本)。它们在**诊断**里,默认收起(`H8`)。
- 状态永远比装饰重要(`H1`),且**必须放在始终可见的位置**。

## 二、窗口:用系统定义的解剖,不自造

HIG《Windows》对 macOS 的定义是:**窗口 = frame(含窗口控件与可选 toolbar)+ body**,并要求 *"Avoid creating custom window UI"*、不要复制系统外观;另有一条常被忽略的硬规则:*"Avoid putting critical information or actions in a bottom bar, because people often relocate a window in a way that hides its bottom edge."*

| 区域 | 内容 | 依据 |
| --- | --- | --- |
| **toolbar(frame,46px)** | 侧栏开关、窗口标题(`<机器> · Anywhere Work`)、状态(圆点 + 文字 + 数量)、刷新 | 上面两条 HIG |
| **侧栏(来源列表)** | 搜索、一层分组(本机 / 其他机器,组头可带一个动作)、底部**账号条** + 折叠诊断 | 《Sidebars》 |
| **detail(body)** | 状态面板,或选中机器的 DSH 工作区(内嵌 `WebContentsView`) | 《Windows》:默认不要多开窗口 |

**因此不采**的两种做法(都在本产品上试过并被规范否掉):

1. **自造无 frame 的窗口**:把 toolbar 整条删掉、用不可见拖动条代替——违反 *Avoid creating custom window UI*,也让状态无处安放。
2. **把关键信息放底部**:状态曾移到侧栏底部,正好撞上上面那条底部栏警告。底部的**账号条不是状态栏**:它只回答"其他机器能不能连上",并且它的动作是打开登录,不是关键操作的唯一入口——登录在本机工作区里也够用。

toolbar 里的控件遵守《Toolbars》:只放最重要的几项;图标按钮 16pt、26×24 命中区、hover 才出现底色;快捷键**不在按钮上印**,它们活在菜单栏(见下)。

## 三、菜单栏:快捷键与命令的家

《The menu bar》规定顺序为 `AppName / File / Edit / Format / View / app-specific / Window / Help`,且 *"Always show the same set of menu items… If a menu bar item isn't actionable, disable the action instead of hiding it"*。

本产品:应用菜单(`Anywhere Work`)→ 编辑 → **视图**(刷新 ⌘R、搜索机器 ⌘F、显示或隐藏侧栏 ⌘⌥S、外观、缩放、全屏)→ 窗口 → 帮助(复制诊断信息)。

- 应用菜单标题是产品名的短形式,**在菜单栏里恒常可见**——这是 macOS 上品牌最强、最稳的露出之一。
- 视图菜单的开关项标题跟随当前状态,按 HIG。

## 四、品牌:露在哪,由规范决定

《Branding》的原文最直接:

> *"Ensure branding always defers to content. Using screen space for an element that does nothing but display a brand asset can mean there's less room for the content people care about."*
> *"Resist the temptation to display your logo throughout your app… People seldom need to be reminded which app they're using."*
> *"Apply your app's accent color judiciously… use it intentionally for primary actions or status indicators."*
> *"Use your brand's unique voice and tone in all the written communication you display."*

所以本产品的品牌露出只有四处,全部是功能性的:

| 露出点 | 做法 |
| --- | --- |
| **应用图标**(第一品牌面) | 由品牌素材在打包时生成 `.icns`;Dock、Finder、切换器、通知都看它 |
| **菜单栏应用名**(恒常可见) | 应用菜单标题为 `Anywhere Work`,加粗 |
| **文案语气** | 产品名与标语来自 `tokens.json` 的 `product`,由 `scripts/dsh-netbird-brand.mjs` 生成为 `brand.js`;渲染层**不得手写** |
| **强调色** | 品牌蓝只用于主操作与状态点,不铺满界面 |

**窗口内不贴 logo**:顶部没有品牌行,侧栏也没有。同一屏出现两次 mark 只是装饰——这正是规范劝退的做法。

**关于 lockup**:不用它的图片。它的 wordmark 跟随**系统**深浅色,而本应用允许用户覆盖外观(系统浅色 + 应用深色 = 暗底暗字)。要写产品名就用应用自己的 token 以文本呈现。

## 五、图标:macOS 的规格

**第一条是边界,不是风格**:品牌素材不是外壳的创作对象。桌面图标必须**由手机端(Android 客户端)实际使用的图标图层合成**——颜色、图形、比例全部来自品牌,外壳只做平台适配(尺寸、圆角、文件格式)。这条有门禁:生成的 `app-icon.svg` 必须引用那两层素材,且不得自带任何颜色、描边或图形。

《App icons》的两条硬约束:

> *"Providing layers with pre-defined masking negatively impacts specular highlight effects and makes edges look jagged."*
> Specifications: iOS / iPadOS / macOS = **1024×1024 正方形**,系统遮罩后成圆角矩形。

所以:满幅正方形、圆角由系统遮罩、主图形居中(内容边距 72%)、打包时合成 `.icns`,菜单栏图标用 mark 渲染为**模板图**。

## 六、信息架构与布局

```text
┌ toolbar(窗口 frame,红绿灯浮在左侧)────────────────────────────┐
│ [侧栏开关]  studio-mac · Anywhere Work        ● 本机可用 / 已连接 3 台可达  ⟳ │
├────┬──────────────┬────────────────────────────────────────────┤
│ ▣  │ 搜索          │  首页(launch pad)或工作区(内嵌)             │
│ 机器│ ─ 本机        │                                            │
│ ＋ │   ● studio-mac ⑧ │   首页 → 「要打开哪台机器?」+ 主按钮       │
│ 新会话│    dsh.studio-mac…│   正在准备 → 客户端自己的安装/启动进度   │
│    │ ─ 其他机器 登录 │   等待登录 → 标题 + 一句承诺 + 按钮          │
│    │   ● tower-lab ②│   没有其他机器 → 说明 + 重试                │
│    │   ○ imac-office │   连不上   → 引擎原话 + 一个动作            │
│    │    需登录       │                                            │
│ ⓘ  │ 未登录 · 连接其他机器 / ● studio-mac · 3 台可达               │
│ ◐  │ ▸ 诊断         │                                            │
└────┴──────────────┴────────────────────────────────────────────┘
```

- **三列,和一个不属于列表的导航栏**:`rail(48px) | list(248px) | detail`。rail 是应用自己的导航,**折叠列表不会折叠它**——折的是列表,不是"我在哪"。
- **一个窗口**:列表与工作区同框(选中即内嵌,切回瞬时)。原先把工作区开成独立窗口,用户失去方位感(`H6`)。
- **常驻页必须能自己变新**:「切回瞬时」的代价是那页从不重建,它的内容只来自该机器的更新连接;连接一旦断过(睡眠、网络切换、引擎重连、宿主重启工作区),页面会永远停在被孤立的那份快照上,而同一台机器在浏览器里已经是最新。因此三处必须重载该页:页面在屏外超过 5 分钟后再打开、机器从睡眠中醒来、用户显式刷新。「新会话」是同一个动作的显式版,只是额外回到前台门。重载保留页面自己的路由,所以回来时仍在原来的会话上。判定与阈值只在 `src/view-freshness.mjs`,单测 `test/view-freshness.test.mjs`;`shell/main.mjs` 必须在三条路径上都调用它,否则冻结的列表会回来。
- **窗口有两视图,由 rail 命名**:**首页**(launch pad)与**工作区**。当前视图是 rail 上唯一常亮的标记(填充 + 品牌色字形 + 贴 rail 左缘的 2px 条),所以"我在哪"是一眼的事;诊断是开关不是视图,只报告 `aria-pressed`,不抢当前视图标记。
- **侧栏一层分组**,层级不超过两层(《Sidebars》)。分组标题:`本机`、`其他机器`。
- **「本机」按地址认,不按名字比**:机队的一行是一条 DNS 记录,记录内容是某台机器的覆盖网地址;地址属于且只属于一台机器。记录指向本机地址的那一行就是本机(`local-addresses.mjs` → `localRowsFrom`),与它叫什么无关。名字不可用作身份:一台机器每被一个客户端入网就多一个名字(本机自己的客户端、这个应用各一个),按名字比必然要么一条都对不上,要么两条都算本机——这正是「本机」掉进其他机器、以及同一台机器出现两次的来源。指向本机地址的记录无论有几条,都只留一行「本机」。
- **「其他机器」这一节始终存在**,并按四种状态给一句话:未登录(带「登录」动作)/ 正在查找 / 还没别的电脑 / 网络失败。整节消失会被读成"你只有一台电脑",而这是客户端在登录前**不可能**知道的事。
- **机器行有三种标记,互不替代**:行首圆点是**可达性**(能不能进),行尾红色徽标是**有未查看的结果**(里面完成了几个会话),`需登录` 徽标是**待认证**。三者可以同时出现在同一行;用一个盖掉另一个就是丢信息。
- **列表必须自己变新**:行上这三个答案没有一个是被推过来的(宿主只在被问到时回答,引擎死了更是什么都不答),所以窗口按心跳重读(窗口可见时 45 秒、隐藏时 5 分钟,`snapshotHeartbeatMs`),睡醒后立刻重读一次;否则一直开着的窗口会永远停在启动那一刻——完成了新工作的机器不长徽标、已经走掉的机器仍显示可达、死掉的引擎仍显示已连接。同一次读取可能被心跳、菜单刷新和点击同时触发,所以并发读取合并成一次探测(`currentSnapshot` 共享在途 Promise),不是三倍流量。引擎进程自己退出时按一次有上限的重启恢复(`recoverEngine`,10 分钟内最多 3 次),用户关掉私网或正在退出时不重启;引擎没了必须清掉会话代理,否则每个请求都发进一个死掉的 loopback 端口,界面看起来是坏掉而不是断开。一台机器的页面不因一次探测失败就丢:列表只装"探测有应答"的机器,一次超时很常见,所以先记账,持续缺席超过 10 分钟(`VIEW_PRUNE_GRACE_MS`)才销毁它的页面。启动时读通道文档可能撞上网络还没起来,所以只要还没有可拨的地址就每分钟重读一次(`shouldRetryEndpointDiscovery`),已经有地址的安装永远不会被文档改指。升级检查同样如此:开机查一次就再也不查,等于"已是最新"说的是开机那个早上(6 小时后重查,`src/update.mjs` 的 `updateCheckDue`)。窗口标题与托盘 tooltip 每次读取都跟着刷新(`syncWindowChrome`),因为它们原本只在打开机器那一刻写一次。判定在 `src/snapshot-freshness.mjs`、`src/endpoint.mjs`。
- **刷新在连接中也可用**:只有「准备本机」会把一次按下变成第二次安装序列,所以按钮的锁定集合(`REFRESH_LOCKED`)只含 `provisioning`;`connecting` 时刷新就是重读列表——那正是人遇到"卡住"时会按的那个键,把它禁掉等于把唯一的手动出路留给菜单或重启。
- **选中态**是整行填充 + 名称加粗(同代客户端的做法),不靠颜色单独表达。

## 七、首页是发射台,不是通知页

打开客户端**不自动进入任何机器**。首屏是首页:一句问句标题、一句指路,以及**一个把机器名字写出来的主按钮**(`打开 <机器> 的工作区`)。理由有三条,都是实际发生过的问题:

1. 直接进工作区会让窗口自己的结构不可见——没有可以回来的"家",没有地方说明"点击会打开哪台机器";
2. rail 上的「新会话」需要一个参照物才有意义:它把**当前选中的机器**带回它自己的首页(会话开始的那一屏);
3. `H6`(识别优于回忆)与 `H7`(灵活高效):列表行、主按钮、⌘1–⌘9 是同一件事的三个入口,而哪一个都不需要用户先猜。

首页不是第四种状态:它就是 `local` / `ready` 两种状态的**面板变体**(`data-kind="home"`),字号用显示级;`provisioning` / `login-required` / `empty` / `error` 的面板照旧——那些状态下没有机器可打开,rail 的「新会话」也就**禁用**而不是给一个会失败的按钮。首页只有一句话加一个按钮:标题提问,按钮用机器名回答,不重复第二遍。

## 八、登录是可选项,不是门槛

这一条改过两轮,以现在的为准:

1. **打开客户端不做任何登录**。客户端先准备**本机**环境,然后落到首页(见第七节);进入哪台机器由用户的点击决定。没有账号的用户拿到的是一个完整可用的产品。
2. **私网只在用户要"其他机器"时启动**,并**记住上一次的意愿**。入口有两个,都在同一个位置语义上:侧栏「其他机器」组头的**登录**、底部账号条的**连接其他机器**。上次退出时私网是连着的,这次启动就自动恢复——身份本来就在磁盘上(`config.json`),恢复不需要再登录;用户点「改用本机」就是关掉,并记住关掉,下次启动仍停在本机。保存的是**用户的选择**(`settings.json` 的 `fleetWanted`,见 `src/fleet-intent.mjs`),不是默认值:从没要过私网的机器,启动仍是本机;`--fleet` 只给开发与验收用。
3. **登录界面只有一个按钮「登录」**。登录 URL 是短时效的(引擎的回调监听只开一小段时间),把它摆在屏幕上等于摆一个随时会死的链接。所以:
   - 屏幕**不渲染任何 URL**(`#login-url` / `.url-field` 已从 DOM 删除,验收断言 `no url text in the window`);
   - 按钮在**按下的那一刻**重新签发并交给浏览器(`H9`),没有第二个"复制链接"按钮:能走到这个屏幕的机器都开着浏览器;
   - 按钮就叫**登录**。同一件事在账号条、分组头部、登录屏上都用同一个词,换三个近义词是给自己的界面加噪音。
4. **不登录也能用,所以这里不需要"拒绝"按钮**。私网只在用户点「登录」时才启动;停在登录屏不做任何操作,本机这一半照常可用(列表、工作区、徽标都在)。正在拨号的那一屏保留「改用本机」,因为那是一个**卡住**的状态,需要一个出口(`H9`)。
5. **登录期间本机不受影响**。`login-required` / `connecting` / `empty` / `error` 都只描述私网;本机行照常出现在列表里,面板文案明说"本机不受影响"。
6. **客户端必须知道自己要连哪个服务器,拿不到就问**。地址有五个来源,优先级从高到低,判定在 `src/endpoint.mjs`(单测 `test/endpoint.test.mjs`):
   1. 启动参数 `--management-url` 或环境变量 `AW_MANAGEMENT_URL`——与机队安装器读的是同一个名字;
   2. **用户自己填的地址**(存在 `settings.json` 的 `server.url`,界面上标「自建」,与手机端同一套语义);
   3. 这台电脑**已经登录过**的地址(引擎配置里的 `ManagementURL`);
   4. **安装包自带**的默认地址(打包时写入 `Resources/app/endpoint.json`);
   5. **发布通道的 `fleet.json`**——与手机端同一个文档、同一组引导地址,而且**只在前面全空时作为首次种子**:一份能被改的文档不许把已经入网的安装改到别的账号上。

   **五个来源都拿不到时,窗口不拨任何地址**:面板直接要地址(见第十节),而不是花半分钟去连一个不存在的地方。占位地址 `https://netbird.example.com:443` **不是地址**:它只是"部署没给值"时曾经的兜底,判定函数把它当作没有,任何写入用户配置的路径也都不再写它。
   地址是**用户可见的事实**:登录屏、连不上、正在接入三种面板都带一行「服务器:<host>」,诊断区有一行「服务器」,`复制诊断` 也带上它。
7. **重签失败要留在登录屏,并且给按钮把端口要回来**。登录链接是短时效的,所以"按钮按下时重新签发"。重新签发可能失败(人还在浏览器里、回调窗口已经关了),这**不是**错误态:它等价于按之前的状态——登录屏还在、按钮还在。把这种情况渲染成"连不上"会收走登录按钮,只留「重试」,而那正是"无法登录"看起来的样子。
   还有一层实测出来的原因:引擎的登录回调监听**绑定一个端口直到进程结束**,一次没走完的登录会让之后每次签发都以 `no available port found from configured redirect URLs` 失败——按钮从此按不动。所以重签失败时窗口先**重启引擎**(换一个 helper 进程,端口就回来了)再签一次;再失败才留在登录屏并保留引擎原话(`get oauth flow: ...`)。重启只花几秒,而且此时还没有身份、没有可达机器,输不掉任何东西。

状态由此分成两半(实现见 `src/panel-state.mjs`,单测 `test/panel-state.test.mjs`):

```text
local  checking | needs-install | ready | error
fleet  off | starting | connecting | login-required | ready | empty | error
```

- 本机没就绪**压过**一切(没什么可开、也没什么可登);
- 本机就绪后,`fleet = off` 是**正常终点**,渲染成 `local`(不是"降级")。

## 九、客户端只读本机状态,安装交给终端

**装什么由机队安装器负责,不由这个窗口负责**:`tools/dsh-netbird/client/install.sh` 装 NetBird 客户端、Node(需要时装私有 Node)、DSH 宿主、**我们的插件**(`dsh plugin --profile web add @dsh-cove/dsh-web-all@latest`)、Kaon Router 供应商与常驻服务。窗口(`agent/kernel.mjs`,单测 `test/kernel.test.mjs`)只做四件只读的事:

1. **运行时**:按 `command -v node` 与本机布局(nvm / Volta / fnm / asdf / Homebrew / `$DSH_HOME/node`)找 Node ≥ 22,同 major 取最新;`dsh --version` 也带着这个运行时上 PATH 问(`dsh` 是 `#!/usr/bin/env node` 脚本,Finder 启动的窗口 PATH 里没有 node)。
2. **宿主**:找 `dsh`(PATH 与同一批布局)。
3. **在跑的宿主**:3080 是否有人应答。
4. **插件**:`/web-all/remote-access/boot.js` 是否由运行中的宿主应答——这与机队审计读的是同一条契约路径。profile 里有一行只说明"加过",这一问才说明"正在服务"。

四层里缺哪一层就报哪一层(`needs-runtime` / `needs-host` / `needs-service` / `needs-plugin`),并把机队安装器命令交给系统终端去跑;窗口自己不下载、不 `npm install`、不写服务单元(`Object.keys(kernel)` 只有 `status` / `runtime` / `ensure`)。

界面把状态说清楚(面板标题随 `local.state` 变化,缺什么写什么),而不是只给一个转圈。

**名字的边界(诚实写在这里)**:登录之前客户端只知道本机主机名,写常驻服务时用它推导规范地址(`dsh.<主机名>.netbird`),这是**没有机队记录指向本机时的兜底**;连上之后本机是哪一行由**地址**决定:机队记录指向本机地址的就是本机,行上写它自己的名字。一台机器在机队里可能同时有 `host-a` 和 `laptop-b-189-193` 两个身份,它们各自的记录都指向本机地址,所以都归到同一行,不会变成两台。已经有人应答的端口一律不动,所以机队既有的服务不会被客户端改写;这也意味着**先装后登**的机器,其远程入口名以机队发布的名字为准。

## 十、状态与反馈

每个状态必须同时给出:发生了什么、为什么、下一步。

| 状态 | 标题 | 说明 | 动作 |
| --- | --- | --- | --- |
| provisioning | 正在检查本机环境 / 本机还没装好 | 缺 Node 或缺 host 时写明"这个窗口不安装",并给出终端里可运行的机队安装器命令 | 无 / 在终端运行安装器 / 重试 / 复制诊断 |
| local / ready(首页) | 要打开哪台机器? | 从左边选择一台机器;或直接打开 `<机器>` 的工作区。 | 打开 `<机器>` 的工作区 |
| local / ready(没有机器可选) | 还没有可用的机器 | 本机的服务还在准备;准备好之后它会出现在左边。 | 无 |
| connecting | 正在接入 | 正在联系服务器。 | 改用本机 |
| login-required | 登录 | 登录后,你的其他电脑会出现在这里。本机不受影响。 | 登录 |
| login-required(没有地址) | 填服务器地址 | 这台电脑还不知道去哪里登录。 | 设置服务器 / 改用本机 |
| empty | 没有看到其他机器 | 在别的电脑上登录同一个账号,它就会出现在这里。 | 重试 |
| error(私网) | 连不上 | 引擎原话(它是诊断,改写会丢线索) | 重试 / 设置服务器 |
| error(本机) | 本机服务起不来 | 本机的原因 | 重试 / 在终端运行安装器(有命令时) |

`connecting` 曾经没有动作、说明留空,而文案还断言"正在查找你的其他电脑"——那半分钟里其实在拨号。**能被卡住的状态必须给出口**:现在它说明自己在做什么,并且保留回到本机的路。
两种"连不上"是两种问题,答案不同:本机服务起不来时给的是本机的命令与重试,**不给**服务器地址(地址与本机无关);私网连不上时才给地址。

登录链接是**短时效**的,所以按钮在按下的那一刻**重新签发**链接,而不是打开屏幕上那条可能已死的链接(`H9`);重新签发失败时留在登录屏(见第八节第 7 条),引擎的原话进诊断。

## 十一、未查看的结果:每台机器一行红色计数

红点回答的是"**我不在的时候,这台机器干完了几件**"。

"不在"是**屏幕状态**,不是人的注意力:某台机器的工作区**正在前台**(`activeWorkspace`)时,用户就在里面,里面的活是他看着完成的,不是"回去查收"的对象。

- **徽标带数字**(`app.js` 渲染 `.machine-unread` 的文本,>99 显示 `99+`),不是只有一个点:数字是"几件"的唯一答案。可访问名与悬停文本同时带「N 项新结果」,所以它也不靠颜色单独传达。
- **只有 `completed` 与 `failed` 计数**;`stopped`(用户自己停的、被中断的)不是新闻,但它仍属于"已看过"的范围。
- **只有出错才配得上红色**:`summarizeFeed` 除了条数还报 `failed`,行上给出 `unreadTone`(`danger` 只在有失败时),样式表按它决定要不要上危险填充——普通完成是一个安静的数字(`--aw-text`,与背景是契约里 7:1 的那一对),不是一次告警。红色常年挂在正常完成上就变成墙纸,人也就不再当它是信号。可访问名同步带上「(含出错)」,颜色不是唯一通道。
- **计数要的是整段积压,不是一页**:读取用 `badgeUrl`(limit 取宿主的 `NOTIFY_MAX_LIMIT`,即宿主的保留上限),否则超过二十件之后数字就不再是"几件"了。
- **首次接触是基线,不是积压**:这份客户端从没读过的机器,feed 里那段是宿主的历史,而刚装好的客户端并没有"离开"过任何东西。所以第一次读只**建立**已读位置(`readDecision` 的 `known: false` 分支),不点亮任何数字;下一次读才从那里开始量。宿主换进程不算首次接触——它的已读条目还在(值为 0),编号重来意味着新记录确实是新的。
- **在里面的机器不计数,并且当场记为已读**(`readDecision(summary, { watching })`,`watching` 即该机器的工作区在前台):它自己的完成不进数字,同时已读位置推进到 feed 的 `latest`——所以**离开**那台机器才是它开始计数的时刻,而不是把你在里面这段时间的产出一次性倒到你要离开的那一行上。切换机器、回首页、工作区被状态面板取代,这三条离开路径都会补记一次(`acknowledgeWatched`,离开时重新读一次,不信上一张快照)。
- **已读位置是 feed 的 `latest`,不是这一页里最新的那条**(`ackIdOf`):"看这台机器"等于把它整个读完,按页推进会让每次查看只前进一页,留下永远清不掉的余数。
- **打开该机器即清除**,清除后**立刻重绘**列表(`publish`),`local` 与 `ready` 两种列表状态都算——只在 `ready` 时重绘,会让单机用户(最常见的形态)点进去之后数字还挂在屏幕上。
- **宿主换进程后编号会从头开始**;已读位置遇到编号回退时**从零重读**,因此新结果不会被永久隐藏。
- **结果源缺席**(未升级的机器返回 404)、超时或响应不可解析,都等同于**没有新结果**:不点亮徽标,也绝不影响该机器的可达性判定。
- 数据来自宿主 `/api/dsh-notify/feed`(`packages/dsh-web-all` 的 notify 能力,契约在 `src/core/notify/contract.ts`)。**本机也参与,而且是最要紧的一个**:单机用户没有别的机器,所以本机这一行是他唯一会看到的徽标——它的行虽然由客户端自己构造(不需要可达性探测),但**计数必须走同一条 feed 读取**(`probeLocalEntry`,与机队行同一个 `readNoticeFeed`)。少了这一步,恰好是"唯一存在的机器"永远不报结果。

## 十二、文案

**说**:用户能据此行动的事、结果、下一步、以及"这条通道只属于本应用""安装交给官方安装器、本窗口不装任何东西"这两个承诺。
**不说**(单测里有黑名单):内部术语(引擎/映射/节点/协议/覆盖网/netstack/peer)、自述式旁白。
**地址说成什么样**:`服务器：<host>` 或 `<host>（自建）`——与手机端同一套写法(全角冒号、全角括号、自己填的地址标「自建」),因为两端描述的是同一件事。`connecting` 不承诺"正在查找你的其他电脑":它在联系服务器,就写字面事实。
**一句话能说完就不写两句**,一个动作只有一个词(开私网这件事在账号条、分组头部、登录屏上都叫「登录」)。按钮只留"用户在这一屏要做的事":做不了的按钮不出现,重复别处已有的入口不出现,诊断复制在帮助菜单与侧栏折叠区里,面板上不再重复第四次。产品标语只在**第一次见面**(首启准备阶段)出现一次,之后是装饰。

## 十三、视觉与可访问性

- 诊断区只报事实、不重复:本机那一行已经带着运行时版本与托管状态,所以不再单列一行「本机版本」。
- 颜色、字号、间距、圆角、动效时长**一律取自生成 token**,界面文件里不出现字面色值。徽标的填充/文字对(`dangerFill` / `onDangerFill`)也进了 `tokens.json` 的 `contrast` 契约,明暗两套都过 AA。
- 深浅色跟随系统,用户可覆盖并跨重启记住;覆盖由菜单栏驱动。
- 字号:行标题与正文 13px,行副标题与说明 13px(muted),分组标签 13px/600;列表行高 38px;toolbar 46px。
- 密度只放在列表:分组之间留白,行与行之间不用分隔线。
- 全部交互元素可聚焦,焦点环用 `--aw-focus`;列表支持 ↑/↓ 与 ⌘1–⌘9;状态经 `aria-live` 宣告。
- 动效只用于位置与状态的连续,尊重 `prefers-reduced-motion`;每个文字/背景组合过 WCAG AA。

## 十四、验收

一次改动必须同时满足:

1. `node --test tools/anywhere-agent/test/*.test.mjs` 全绿,新增界面逻辑有对应单测(状态判定在 `test/panel-state.test.mjs`,投影与 rail/首页在 `test/view.test.mjs`,安装/常驻在 `test/kernel.test.mjs`,常驻页的重载判定在 `test/view-freshness.test.mjs`,机器列表的心跳/清理/代理判定在 `test/snapshot-freshness.test.mjs`)。
2. `node poc/shell-states.mjs` 七态 × 深浅两色全绿,并断言:**存在窗口 frame**、状态/刷新/开关在 toolbar 内、**rail 存在且有四项**、**折叠列表后 rail 仍在**、当前视图标记跟着视图走、**窗口内 logo 数 0**、**登录屏没有 URL**(既无元素也无文本)、**登录屏只有一个按钮且写着「登录」**、**登录屏写明服务器**、**每屏的动作按钮恰好是有人要做的那几个**(逐屏断言数量与文案)、**未查看计数带数字**、**每个动作按钮有真 id**(`action-undefined` 就是"点了没反应"的按钮)、以及**首页主按钮按下后工作区真的覆盖住面板**。
3. `node poc/local-first-run.mjs` 真机路径(真实原语,脚本化状态不参与):窗口落到 `本机可用`、列表只有本机一行、账号条是"未登录"、私网仍然关闭、**首屏是首页而不是工作区**、**本机徽标的数字等于客户端自己的 reader 从在跑的宿主读到的新结果数**(同一个 `badgeUrl`+`summarizeFeed`)、首页主按钮按下后工作区确实打开、**进去之后本机行的徽标消失**(前台的机器不计自己的完成)、诊断里能读到宿主已常驻。
4. `node poc/fleet-run.mjs` 多机路径,两种都跑:默认走**应用自己的覆盖网**(`--fleet` + 已存身份;首次需要人在浏览器里完成一次登录,`--await-login-seconds` 把这一步留给人),`--netbird <binary>` 走**这台机器自己的引擎**。断言:状态 `ready`、**可及机器多于一台**、每台可达机器都有行、**另一台机器能在窗格里打开**(`workspace.host` 等于那一行)。分组以**地址**为准:机队记录指向本机地址的那一行进`本机`(其余进`其他机器`,指向本机地址的其他记录不出现在这一节);验收模式(机器自己的引擎)不加入本机行,所以只有`其他机器`。
5. `node poc/fleet-sso.mjs` **应用自己链路的登录**(无窗口,同一个 supervisor):已存身份不够时它会走到 `login-required` 并**签发一条真实 hand-off**,由人在浏览器里完成(`--open` 直接打开),完成后断言 `ready` 且**可及机器多于一台**,并打印机器清单。它把身份复制到自己的 state 目录、结束时删掉,因此不碰真实 profile;管理端地址同样只在运行期经 `AW_MANAGEMENT_URL` 传入。窗口能关掉、会被人关掉,所以这一步必须没有窗口。
6. `node poc/packaged-ui.mjs` 打包产物自证:`process.resourcesPath` 指向 `Anywhere Work.app`、客户端自己把本机准备好、**rail 与首页都在这个 bundle 里**、本机行徽标与在跑宿主一致、能打开工作区。打包步骤:`bash scripts/package-mac.sh --dmg`(`.app` ad-hoc 签名并自检,Gatekeeper 拒绝是预期;`.dmg` 由 `make-dmg.sh` 生成并**重新挂载写出的映像**自检,见第十五节)。
7. 截图证据:每个状态各一张(`poc/evidence/shell-state-<state>-<scheme>.png`)、首页按下后的工作区一张(`…-workspace-<scheme>.png`)、真机首启两张(`shell-local-first-run.png` / `-workspace.png`)、多机一张(`shell-fleet-run.png`)、打包产物一张(`packaged-ui.png`)、挂载后的安装窗口一张(`installer-window.png`)。
8. 打包门禁:`pnpm dsh-netbird:brand`、`check-payload-imports`、图标由 `app-icon.svg` 生成、`codesign --verify` 通过。
9. 未查看结果:徽标出现/不出现/与 `需登录` 并存且不影响状态行(`test/view.test.mjs`),数字的含义是"完成了几个会话"(`test/notify.test.mjs`),已读位置的前进、宿主重启回退与坏响应不点亮徽标(同上)。
10. 安装包门禁:`node --test tools/anywhere-agent/test/make-dmg.test.mjs` 全绿——它挂载 `make-dmg.sh` 写出的映像,断言**快捷方式指向 `/Applications`**、**说明文件存在且中英齐全**、背景随卷同行,并拒绝把非 bundle 当 app 打包。
11. `AW_MANAGEMENT_URL=<真实端点> node poc/endpoint-run.mjs` **登录链路端到端**(真实引擎,地址经 `--management-url`/`AW_MANAGEMENT_URL` 传入,仓库里不写端点):断言**没有地址时窗口要地址、不拨号、不报错**、**填错的值就地被拒**、**填上部署的地址后到达登录屏**(签发链接的 host 等于这个地址、面板写明服务器、窗口标题带机器名、机器行有完整地址的悬停文本)、**再按一次按钮(重新签发)之后登录屏仍然在**、以及**「暂不登录」回到本机可用**。浏览器里那一步属于人,这个 run 到签发为止。
12. 地址判定另有单测(`test/endpoint.test.mjs`):占位地址不算地址、**带着占位地址的引擎配置不算已入网**(否则一台被旧版本写坏的机器永远修不回来)、五个来源的优先级、**已入网的机器不会被更新的包默认值搬走**、通道文档只作种子且解析失败不影响现状。

## 十五、版本:一个版本号,一个构建号

**一条 tag 上的每个制品都叫同一个版本**。应用的版本号 = **仓库的发布版本**(`packages/dsh-web-all/package.json`),也就是 `vX.Y.Z` 那个 tag:`desktop-release.yml` 把运行时包与这个安装包挂到同一个 release,`android-release.yml` 把手机 APK 挂在同一个 tag 上,所以"版本"只能是同一个数——三个人拿三个包对不上号,是这套东西开始时不统一的地方。

规则只有两条,都是**推导出来的,不是手写的**:

| | 版本(叫什么) | 构建号(哪一次) |
| --- | --- | --- |
| macOS app | 仓库发布版本 → `CFBundleShortVersionString` | `git rev-list --count HEAD` → `CFBundleVersion` |
| Windows 安装包 | 同一个仓库发布版本 → `ProductVersion` | 同一个 git 计数 → `VIProductVersion` 第四段 |
| Android APK | 同一个仓库发布版本 → `versionName` | 同一个 git 计数 → `versionCode` |

macOS 用 `CFBundleVersion` 判断"新的比旧的更新",Android 用 `versionCode` 判断要不要升级——所以这一列必须是同一个会动的数,而不是版本号本身。

- **不再有第二份手写版本号**:`packaging/version-contract.json` 只留**兼容性事实**(`protocol` / `netbird` / `helper` / `update`),产品版本从它里面删掉——原来那个 `shell: 0.1.0` 是开张那天写下的数,之后每次打包都不动,于是重建的 app 报着同一个版本,流水线也分辨不出用户装的到底是不是刚构建出来的那个。
- **构建号来自 git**:`package-mac.sh` 取 `git rev-list --count HEAD`,写进 `CFBundleVersion`(macOS 正是拿这个字段判断"新的比旧的更新",它以前等于版本号,所以重建的包可能被当成同一个版本),同时写进 payload 的 `package.json.build`。工作区不干净时名字带 `-dirty`,让人一眼看出这不是某个提交。
- **安装包以版本+构建号命名**:`Anywhere Work-<version>-<build>.dmg`。
- **窗口自己报出这两个数**:诊断区第一行「本窗口」显示 `<version> (构建 <build>)`,数据来自 payload 自己的 `package.json`(`appIdentity`,随快照下发)。验收就是比对运行中的窗口报的数与包里的清单(`poc/packaged-ui.mjs`)。
- **Windows 用同一对事实**:`scripts/package-windows.mjs` 取仓库版本与 git 计数,写进 NSIS 的 `VIProductVersion`(第四段就是构建号)与 Apps & 功能里的 `DisplayVersion`(`<version> (<build>)`)。Windows 判断"新的比旧的更新"读的是安装器登记的这一项,不是 app 可执行文件自己——所以同一个数必须两处一致,由 `scripts/version-doctrine.test.mjs` 断言 macOS / Windows / iOS / Android 四端都从这两个事实派生。
- **手机端同样推导**:`android/app/build.gradle` 从仓库版本读 `versionName`、从 git 计数读 `versionCode`(可用 `-PawVersionName` / `-PawVersionCode` 或 `VERSION_NAME` / `VERSION_CODE` 覆盖);`publish.sh` 用同一对事实生成通道清单,并且在 aapt2 可用时**拿 APK 自己报的版本与清单对账,不一致就拒绝发布**——清单和包说的不是一个版本,就是"已是最新"却永远收不到更新的那类事故。
- `test/version.test.mjs`(macOS 打包面)与 `scripts/version-doctrine.test.mjs`(跨端门禁:两个客户端、两个工作流、APK 通道)是防漂移门禁:版本必须等于仓库版本、契约里不许再出现 `shell`、两个客户端都必须从仓库版本与 git 取这两个数、两个工作流都必须把 tag 传下去。

## 十六、安装包:磁盘映像是一次安装,不是一个装得下 app 的文件夹

用户拿到的第一屏就是挂载后的那个窗口。此前那窗口里只有一个 `.app`:没有"装到哪去"的说明,
也没有可以拖过去的「应用程序」——双击只是从只读的安装卷里启动,于是撞上 Gatekeeper 的
「Apple 无法验证」,而窗口里没有一个字告诉他下一步做什么。

所以映像的验收标准是:**一个从没见过这个产品的人,打开窗口就知道该做什么**。它由三件事组成,
`scripts/make-dmg.sh` 是唯一负责人:

| 组成 | 做法 | 怎么被机器检查 |
| --- | --- | --- |
| **移入应用的快捷方式** | 卷根放 `Applications -> /Applications` 符号链接 | 重新挂载写出的映像,断言符号链接存在且指向 `/Applications` |
| **说明** | 卷根放 `packaging/install-notes.txt`(中英双语,含 Gatekeeper 放行步骤) | 同上,断言文件非空;同一份文件也是 GitHub Release 安装说明的唯一来源 |
| **一打开就摆好的窗口** | Finder 图标视图:两个图标定位、隐藏工具栏与状态栏、品牌 token 渲染的背景与箭头 | Finder 把设置写进卷内 `.DS_Store`;构建脚本读它确认背景真的生效 |

规则与边界:

- **背景不是装饰**:箭头指向「应用程序」,文字只说两件事——拖到哪、被拦下怎么办。颜色与字体取自
  `tokens.json`,由 `render-dmg-background.cjs` 在打包时用运行时的 Electron 渲染;几何来自
  `make-dmg.sh` 里那份唯一坐标,渲染脚本只接受它传进来的位置——两个文件不可能对图标位置各说各话。
- **背景图自检**:渲染脚本读回箭头三角形的 bounding box 与写进去的坐标比对,不符就退出非零。
  这条检查的来历是一个真实的引号错误:白条还在、箭头没了,而那张图看上去仍然"像样"。
- **Finder 摆位是尽力而为**:`.DS_Store` 只能请 Finder 代劳(`osascript`),无 GUI 或未授权的会话做不到;
  失败只警告,不影响交付——快捷方式与说明文件不依赖它。同一原因,Finder 的 `background picture`
  读取会抛 `-10000`,所以背景是否生效由 `.DS_Store` 里的别名记录来判定。
- **不要从安装卷里启动**:只读卷上启动既装不上,也更容易被拦下——说明第一条就写明这一点。
- **Gatekeeper 是现状,不是 bug**:ad-hoc 签名没有公证,首启必被拦下。说明给出两条路——
  「系统设置 → 隐私与安全性 → 仍要打开」,或 `xattr -dr com.apple.quarantine`;「右键 → 打开」
  只标注为 macOS 14 及更早的旧路,因为新系统那个弹窗里没有「打开」按钮。要彻底去掉这一步
  只能上 Developer ID 签名 + 公证(需要 Apple 开发者账号),那是另一件事。

### Windows:NSIS 每用户安装

磁盘映像那套在这里没有对应物:Windows 没有"拖到 Applications"的安装模型,发行的是一个安装器
(`scripts/package-windows.mjs` 生成 NSIS 源,CI 用 `makensis` 编译)。同一份"一打开就知道该做什么"
的标准,在 Windows 上落成下面五件事:

| 组成 | 做法 | 怎么被机器检查 |
| --- | --- | --- |
| **安装范围** | `RequestExecutionLevel user`,装到 `%LOCALAPPDATA%\Programs\Anywhere Work` | 单测断言 NSIS 源里的执行级别与安装目录;CI 静默安装后断言 app 与 `resources\bin\anywhere-tunnel.exe` 都在;**已在 Windows 11 虚拟机里实测**(`poc/winvm/`,21 项断言全过) |
| **卸载与登记** | `Uninstall.exe` + HKCU 的 Uninstall 键(DisplayName / DisplayVersion / Publisher / DisplayIcon / UninstallString / NoModify / NoRepair) | CI 静默卸载后断言 app 与登记项都没了 |
| **覆盖安装即升级** | 同一个安装器对已有安装再跑一次 | CI 第二次静默安装后断言 app 仍在 |
| **说明** | `packaging/install-notes.txt` 写进安装目录,与 macOS 用同一份文件 | NSIS 源由打包器生成,单测断言它带着说明内容 |
| **图标** | `pngToIco` 把 `icons/app-icon.svg` 渲成 16/24/32/48/64/128/256 | 单测断言 ICO 目录项、偏移与 256→0 的编码 |

- **不需要管理员**:客户端不改网关、不改系统代理,所以没有理由要提权;需要后台服务那一步由
  `client/install.ps1` 明确提示用管理员重跑,那是入网脚本的事,不是安装器的事。
- **SmartScreen 是现状,不是 bug**:未签名安装器会被拦下,对应 macOS 的 Gatekeeper。彻底去掉要买
  Authenticode 证书(组织决策,不是代码问题);在那之前放行步骤写在说明里。
- **窗口与菜单的平台差异已有运行证据、还没有干净的视觉验收**:`hiddenInset` 与红绿灯留白是 macOS 的
  形状,Windows 用默认 frame 与 File 菜单,工具栏不再左侧留白;虚拟机上 App 确实开窗并报告标题
  "Anywhere Work"(见 `poc/winvm/`),但抓图那一刻开始菜单盖在窗口上,一张干净截图仍待补。