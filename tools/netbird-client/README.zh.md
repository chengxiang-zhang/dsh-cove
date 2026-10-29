# Anywhere Work 手机客户端

[English](README.md) | 中文

Anywhere Work 是轻量 React Native App，共用同一份 Go 引擎：已交付的手机端是 Android 包（arm64-v8a；鸿蒙设备兼容 Android 时可直接使用），iOS 在 `ios/` 下有可构建的工程并由 iOS 发布流水线产出——**尚未分发**，因为那需要 Apple 分发证书与上传流程。它内嵌 NetBird userspace 网络栈，只有 App 自身的流量进入私有 NetBird 覆盖网络，不把整台设备接入通用 VPN。

本目录是 dsh-cove 仓库的一部分（tools/netbird-client），与 [tools/dsh-netbird](../dsh-netbird/README.zh.md) 配对：后者管理每台电脑的 DSH 暴露契约（`dsh.<机器名>.netbird` 入口、nginx 拓扑、`machines.json` 机器清单），本 App 提供经覆盖网络到达这些机器的移动端入口。

## 能力

- 对 NetBird 管理端登录：自建服务端返回 PKCE 授权码流程，NetBird Cloud 返回 device authorization flow（设备授权），内嵌客户端按管理端提供的方式走。身份持久化，启动时自动重连。
- 管理端可切换：机队使用自建控制端时，可在登录页或设置页填写自己的管理端地址；改地址会清掉旧注册，并对新服务器重新登录。
- 入口只有已登记机器的 DSH 服务：列表、页面打开与网页麦克风共用同一份登记清单，其他内网地址、公网地址和原始 IP 一律拒绝。
- 支持 Range/206 断点续传的页面下载。
- 内置 GeckoView 引擎渲染完整 DSH 工作区页，不依赖设备的旧系统 WebView。
- DSH 页面麦克风使用官方语音输入 `0.2.0-rc.2`；App 只提供 GeckoView 网页录音权限，不另做识别，也没有顶部语音入口。
- Android 前台服务保持后台 NetBird 连接，跨锁屏与进程重启存活。
- 从手机发起的长时间任务会回报结果：连接运行期间，前台服务轮询每台已接受机器的任务完成 feed（`/api/dsh-notify/feed`，45 秒一轮），一旦有任务完成或出错就发一条普通通知。通知渠道、通知本身与开关都与「内网连接」常驻通知分离，开关（默认开启）在设置页。
- 应用内自更新（公网 HTTPS 更新通道：下载进度、安装、启动静默检查）。
- NetBird 控制端是独立页面：登录前从登录页进入，登录后从设置页进入；一个地址输入框、一条恢复编译默认的入口，以及保存前的「测试连接」——用手机自身网络确认这个地址是不是 NetBird 管理端。
- 连接卡住时不是死胡同：登录的连接阶段有明确超时，列表页会说明卡在哪一层（引擎、管理端、代理、身份），后台持续重试，并始终提供「重试」（重建引擎）与「重新登录」。

## 目录结构

- `android/` 与 `ios/`：React Native 平台工程。
- `src/`：共享应用逻辑 — netbird 桥、服务发现、更新器、页面、WebView 注入。
- `native/`：通过 gomobile 绑定成 `android/app/libs/netbird-portal.aar` 的 Go 包；iOS 侧由 `scripts/build-xcframework.sh` 绑成 `ios/Portal.xcframework`（userspace NetBird 客户端、loopback HTTP/CONNECT 代理、SSO、探测、下载）。
- `scripts/publish.sh`：把 APK 与版本清单发布到网内更新通道（部署动作，仅在用户批准后执行）。

## 构建

Android 构建在 macOS 上进行（开发与发布共用）。要求：Node.js >= 22.11、JDK 17（JDK 21 也可构建；必须导出 `JAVA_HOME`，Gradle wrapper 自己找不到 JDK）、Android SDK（platform 37、build-tools 37.0.0、NDK 27.1.12297006；可用 Android commandline tools 的 `sdkmanager "platforms;android-37.0" "build-tools;37.0.0" "ndk;27.1.12297006" "platform-tools"` 安装）。Gradle wrapper 从腾讯镜像下载 Gradle 9.4.1（见 `android/gradle/wrapper/gradle-wrapper.properties`），无需单独安装 Gradle。用 `android/local.properties` 的 `sdk.dir=/绝对路径` 指向本机 SDK。

```bash
npm ci
npm run android   # debug assemble
./android/gradlew -p android :app:assembleDebug
```

新装对接的控制端是构建输入而不是源码字面量：把自己的地址传进去即编译入包（`build.gradle` 写入 `BuildConfig.AW_MANAGEMENT_URL`，由 `NetBirdRuntime` 读取）。仓库里的兜底值是文档占位地址，所以不传该参数构建出来的包，必须先在该 App 内设置地址才能登录；而 `scripts/publish.sh` 会拒绝往「广播了另一个地址」的更新通道发布这种 APK。

```bash
./android/gradlew -p android :app:assembleRelease \
  -PawManagementUrl=https://netbird.<你的域名>:443
```

debug APK 使用仓库内的 `android/app/debug.keystore` 签名，与更新通道签名一致，因此 debug 构建可直接覆盖安装已上线的版本，无需先卸载。`android/app/libs/netbird-portal.aar` 是构建输入；`scripts/build-aar.sh` 可在 macOS 本机从 `native/*.go` 重建它：脚本固定 NetBird `v0.78.1`（版本是从已发布 AAR 的 Go 构建信息与依赖指纹反查出来的），裁掉 Go 1.26 已删除的两条 `//go:linkname`，把接口枚举改成走 `anet` 而不是 `net.Interfaces()`（Android 11+ 不允许普通应用执行标准库所需的 netlink 调用；缺这一步 ICE 一个候选都收不到，手机上的连接只能留在中继上），再跑 gomobile。

iOS 用同一份引擎在 Mac + Xcode 上构建。框架是构建产物而不是提交物：`scripts/build-xcframework.sh` 用 gomobile 把 `native/*.go` 绑成 `ios/Portal.xcframework`（device 与 simulator 两个切片合计约 235 MB，因此不进仓库）。它必须带 `-tags netgo`——iOS 没有 libresolv，Go 的 cgo 解析器否则会链接失败。CocoaPods 来自仓库内的 `Gemfile`；[ios-release.yml](../../.github/workflows/ios-release.yml) 在 runner 上跑同样的步骤，构建模拟器 App，并从产物里读回版本做断言。

```bash
npm ci
bash scripts/build-xcframework.sh      # gomobile bind -> ios/Portal.xcframework
bundle install && bundle exec pod install --project-directory=ios
xcodebuild -workspace ios/NetBirdPortal.xcworkspace -scheme NetBirdPortal \
  -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO build
```

签名材料在仓库之外：只有 CI secrets 里存在分发证书、描述文件与 App Store Connect 密钥时，发布流水线才会签名并上传；缺失时它会在日志里如实说明。控制端地址在这里同样是构建输入——发布时用仓库变量替换 `AWManagementURL`，并从产物里读回确认——所以一个 tag 不可能放出只认文档占位地址的安装包。

本机冒烟测试（macOS）：用 Android 模拟器无头启动 `portal-test` AVD（API 35、arm64），安装 APK 并确认登录页渲染（`Anywhere Work` + 副标题 `登录后接入你自己的机器工作区` + `登录` 按钮）。注意启动组件：applicationId 是 `com.anywherework.app`，而 Activity 类仍在 `com.netbirdportal` 命名空间下。这一步只证明 App 能启动、登录页能渲染，**不覆盖真实 SSO 登录**（模拟器没有凭据）：

```bash
export ANDROID_SDK_ROOT=~/Library/Android/sdk
~/Library/Android/sdk/emulator/emulator -avd portal-test -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot
~/Library/Android/sdk/platform-tools/adb -e install -r android/app/build/outputs/apk/release/app-release.apk
~/Library/Android/sdk/platform-tools/adb -e shell am start -n com.anywherework.app/com.netbirdportal.MainActivity
```

模拟器上还有两条端到端测试，真机排障前先跑它们（都需要机队侧先签一次性 setup key，否则体现不出真实的分组差异）：

```bash
cd android && export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
# 全新 peer 的发现链路：注册 -> 管理端连上 -> network map -> 记录被接受 -> 逐服务可达
./gradlew :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.netbirdportal.NetBirdDiscoveryE2ETest \
  -Pandroid.testInstrumentationRunnerArguments.setupKey=<key，auto_groups=[ops]>
```

`NetBirdScopedVisibilityE2ETest` 同一轮里跑两个身份，断言「看到什么由分组决定」：`fleetKey`（`auto_groups=[ops]`）必须看到全部机器并接受全部 6 条 `dsh.*`；`employeeKey`（`auto_groups=[u-employee-a]`）的 `peerAddresses` 必须恰好只有它自己那台机器，且 App 只接受那一条——即使它同样收到了 6 个名字。跑员工侧前需把一台机器加入 `u-employee-a` 并把机队 zone 分发到该组（模拟器上的实测记录见 [netbird-management.zh.md](../dsh-netbird/netbird-management.zh.md)）。

`NetBirdSsoUrlTest` 只固定一件事：`Portal.loginSSO` 交给浏览器的 URL 仍指向管理端（当前是 `netbird-cli` 客户端、`redirect_uri=http://localhost:53000/`、`prompt=login`），这样以后改 IdP 不会悄悄把登录流程改道。

```bash
./gradlew :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.netbirdportal.NetBirdScopedVisibilityE2ETest \
  -Pandroid.testInstrumentationRunnerArguments.fleetKey=<key，auto_groups=[ops]> \
  -Pandroid.testInstrumentationRunnerArguments.employeeKey=<key，auto_groups=[u-employee-a]> \
  -Pandroid.testInstrumentationRunnerArguments.fleetIps=<6 台机器的 overlay IP，逗号分隔> \
  -Pandroid.testInstrumentationRunnerArguments.employeeMachineIp=<员工那台的 overlay IP>
```

## 配置

地址集中在 `src/fleetConfig.ts`：包内只留**引导地址**（公网 HTTPS `https://anywhere.example.com/fleet.json`，以及覆盖网兜底 `http://tx.vpn/fleet.json`），启动时在后台拉取 `fleet.json`；拉不到就回退到这两个引导地址。改域名因此不需要发版。

- 更新通道：公网 HTTPS `https://anywhere.example.com/`（APK、`version.json`、`fleet.json`），由网络边缘宿主（`nb-tx`；`203.0.113.10` 为文档示例地址）的 nginx 虚拟主机 `anywhere.conf` 提供，静态根 `/www/wwwroot/apk`，支持 Range/206；同一个 vhost 也回答覆盖网名字 `tx` / `tx.vpn`，所以 WiFi 与入网两条路都能下载。用 `scripts/publish.sh` 发布（它生成并上传三个文件，并校验权限与可达性）。
  - 这条通道不要挂到开发笔记本上。
- WiFi 局域网镜像（**仅为便利**，不是权威通道）：运行 `scripts/publish.sh` 的机器会把同一批暂存文件刷新到 `~/.dsh/netbird-apk/www`，由既有的 `apk.mac.conf` vhost 在该机地址上提供（`http://<该机局域网IP>:8088/AnywhereWork.apk`），同 WiFi 的手机可以本地拉这 248 MB，比走公网快。它不会变陈旧：发布时自动刷新并自检，且它分发的清单本身把更新指回公网通道。
- **连接路径完全不做 HTTP 探测**：登录只等引擎起来、管理端流连上（原生 `ensureServiceReady`，有界），再挂上回环代理；真实连通性交给服务列表页——它逐服务探测、重试、给出卡在哪一层并提供出口。必须在内嵌 DNS 栈里解析的名字不能放在登录路径上。
- **管理端可切换**：全新安装默认向 NetBird Cloud（`https://api.netbird.io:443`）注册，使用 App 不必自建控制端；自建机队在登录页或设置页填自己的 `https` 地址，只填主机和端口（规则由 `NetBirdServerAddress.kt` 单一持有），选择存原生侧（`NetBirdServerPreferences.kt`）并优先于编译默认值。保存成另一个地址会停掉连接并删除已注册的 profile，App 因此回到登录页，向新的控制端重新注册。
- Cloud 模式与自建入口遵循同一套暴露契约，只是规范 authority 换成该机器自己的 NetBird FQDN：机器在其 overlay 地址的 80 端口上以 `<machine>.netbird.cloud` 应答，DSH 以 `--trusted-host <machine>.netbird.cloud` 启动。只有满足这一点的机器才会被列出，其余 peer 会在探测后被剔除。
- `src/fleetConfig.ts` 里的 `managementUrl` 是机队文档对「通道发布的是哪个控制端」的记录，不是运行时输入：当前生效地址始终从原生存储读取。`NetBirdFleetDocumentSyncTest` 把两者钉成一致。
- 为别的控制端发布通道用 `MANAGEMENT_URL=... ZONE=... scripts/publish.sh`（两者都可覆盖，默认值属于本机队）；与之匹配的服务端事实——本 App 编译的 zone 名、登录所用的 IdP、每机暴露——见 [self-hosted.zh.md](../dsh-netbird/self-hosted.zh.md)。
- 每平台仍编译进一个地址：新装包注册用的默认管理端（Android：`BuildConfig.AW_MANAGEMENT_URL`，由 `NetBirdRuntime.kt` 读取；iOS：`ios/NetBirdPortal/Info.plist` 的 `AWManagementURL`），默认是 NetBird Cloud，部署方可传入自己的地址。自建模式的 DSH zone 名也仍编译（Android：`res/values/fleet_dsh_zones.xml`；iOS：`AWFleetDshZones`），因为两个平台的明文策略都是构建期资源；Cloud 模式不需要编译 zone，条目就是 `netbird.cloud` 下的 peer FQDN。
- 每台机器的 DSH 清单与暴露契约：[tools/dsh-netbird](../dsh-netbird/README.zh.md)。
- DSH 入口是运行时发现的，不编译进包：`Portal.listServices()` 给出网络里的 DNS 记录，`Portal.peerAddresses()` 给出本网络 peer 的 overlay 地址。自建模式下，只有「名字是机队自己 zone 里的 `dsh.<机器名>` 且目标 IP 就是这些 peer 之一」的记录才被接受；NetBird Cloud 模式下，客户端从 peer 表为每个 peer 合成一条 A 记录（即该 peer 在 `netbird.cloud` 下的 FQDN），目标属于本网络的记录会被接受，可达性探测会剔除没有 DSH 工作区的 peer；Cloud 不需要自建 custom zone。被接受的主机成为运行时信任集合，服务列表、可打开页面、麦克风授权都用它，所以加机器/改名都只改 NetBird 侧，不用发版。`pnpm dsh-netbird:mobile-registry`（已挂在 `pnpm test:scripts`）一旦发现自建编译的 zone 与 `machines.json` 不一致就失败。

## 安全模型

- 两个平台都默认拒绝明文网络：Android 的网络安全配置与 iOS 的 App Transport Security 都只允许登录回环地址与已登记的 NetBird 私有 zone 使用 `http://`（自建 zone 与 `netbird.cloud`），`pnpm dsh-netbird:mobile-registry` 把自建模式两侧的载体都钉在 `machines.json` 声明的 zone 上。
- 信任集合来自控制面，且发现之前是空的：进程冷启动时不会打开或授权任何页面。因为接受条件还要求 DNS 解析结果必须落在本网络的 peer 上，记录也没法把 App 指向 overlay 之外。
- GeckoView 只向当前 `dsh.*` 页面授予麦克风，摄像头、其他来源和跨页面请求一律拒绝。
- 官方 DSH 语音插件拥有录音、识别与草稿插入；App 不读取、保存或转发音频与转写文本。

## 已知限制

- 列表为空有两个 App 之外的原因，先查这两条：新注册的 peer 若不在任何策略里，它的 map 里一个 peer 都没有（`peerAddresses=[]`，于是什么都接受不了）；以及设备所属的分组必须覆盖它要访问的机器。分组只能通过**入网身份**的 `auto_groups`（setup key 的或 user 的）落到 peer 上，绝不能用 `All → ops` 这类宽策略——那等于让每台入网设备拿到整个机队，按用户隔离就没了。见 [netbird-management.zh.md](../dsh-netbird/netbird-management.zh.md)。
- 自建模式下 DSH 入口 zone 仍然编译在包里（`netbird`）：控制端就算连上了，如果它的 `dsh.<机器名>` 记录落在别的 zone，清单会是空的。`pnpm dsh-netbird:mobile-registry` 会在任一平台的载体与 `machines.json` 漂移时失败，所以改名不会静默弄挂某一个平台。Cloud 模式没有这个编译 zone，但只认默认的 `netbird.cloud` peer 域名：改了自定义 DNS 域名的 Cloud 账号能连上，清单会是空的，直到把该域名加进构建。更新通道与引导地址也仍然属于本机队。
- 清单还会等一个很短的稳定窗口（`CATALOGUE_SETTLE_TIMEOUT_MS`）：network map 比管理端连接晚一两秒到达，在此之前冷启动会列出 0 台，直到用户下拉刷新。
- 官方语音输入只承诺 GeckoView 主路径；系统 WebView 极端回退不提供麦克风录音。
- iOS 构建还没有分发：它能构建模拟器包并在模拟器里真实运行（登录页渲染、桥返回编译进去的控制端地址），但在发布 secrets 里放入 Apple 证书与描述文件之前，没有东西会签名或上传它。它也没有「任务跑完」的后台轮询：那个定时器属于 Android 前台服务，iOS 没有等价物，所以 App 关着时跑完的任务要等下次打开才报。iOS 也没有浏览器级代理覆盖，无法像 Android 的 GeckoView 与系统 WebView 那样把页面指向 loopback 代理；没有应用内更新路径（更新只能走 TestFlight 或 App Store，通道的 APK 清单不会在 iOS 上提供）；没有 GeckoView 容器，改用 App 自带的 `WKWebView`；也没有前台服务，引擎只在 App 存活期间运行。

## 许可证

Apache-2.0。