# 客户端发布契约（桌面与手机，四端）

本文件写**跨工具、每端都必须成立**的事实：版本怎么来、产物是什么、装在谁手里、怎么判定"验过了"。每端的实现细节归各自的工具文档（[anywhere-agent 设计规范](../tools/anywhere-agent/DESIGN.md)、[netbird-client README](../tools/netbird-client/README.md)、[dsh-netbird](../tools/dsh-netbird/README.md)）。客户端与机群描述以自托管参考部署为例，示例地址与机器清单均为脱敏数据。

## 两条事实，一套版本

一个 `vX.Y.Z` tag 同时发布运行时包、桌面安装包与手机包，所以"版本"只能有一个答案：

| 事实 | 来源 | 谁派生 |
| --- | --- | --- |
| 版本 | `packages/dsh-web-all/package.json`（`release.yml` 与 tag 交叉校验） | macOS / iOS 的 `CFBundleShortVersionString`、Windows 安装器的 `ProductVersion`、Android 的 `versionName` |
| 构建号 | `git rev-list --count HEAD` | macOS / iOS 的 `CFBundleVersion`、Windows 的 `VIProductVersion` 第四段与 Apps & 功能里的 `DisplayVersion`、Android 的 `versionCode` |

- 不许有第二份手写版本号：`tools/anywhere-agent/packaging/version-contract.json` 只留兼容性事实（`protocol` / `netbird` / `helper` / `update`）。iOS 工程的 `MARKETING_VERSION` 是 Xcode 需要的字面量，因此由门禁钉在发布版本上。
- 升级判定读的是各平台自己的那个数：macOS 读 `CFBundleVersion`，Windows 读安装器登记的 `DisplayVersion`，Android/iOS 读包内版本号；因此构建号必须是会动的数，且必须进到产物内部，不能只写在文件名上。
- 门禁：`scripts/version-doctrine.test.mjs`（四端派生、tag 传递、产物自证）与 `test/version.test.mjs`（macOS 打包面）。

## 产物矩阵

| 端 | 代码库 | 引擎 | 产物 | 安装入口 | 信任 | 更新判定 |
| --- | --- | --- | --- | --- | --- | --- |
| macOS | `tools/anywhere-agent`（Electron） | `anywhere-tunnel` | `.dmg` | 通道 `install.sh` / 直接下载 | ad-hoc 签名 + 首次放行 | `CFBundleVersion` |
| Windows | 同一套 Electron 代码 | `anywhere-tunnel.exe` | NSIS `.exe` | 通道 `install.ps1` / 直接下载 | 未签名（SmartScreen 提示）或 Authenticode | 安装器 `DisplayVersion` |
| Android | `tools/netbird-client`（RN） | `netbird-portal.aar` | `.apk` | 落地页按钮 | 仓库内 debug keystore | `versionCode` |
| iOS | 同一套 RN 代码 + 平台原生层 | `Portal.xcframework` | 模拟器包（未分发） | 需要 Apple 分发证书；未配置签名 secrets 时只构建并验证，不上传 | Apple 分发证书 + profile（CI secrets） | `CFBundleVersion` |

- 引擎是一份源码：`tools/netbird-client/native/*.go`。桌面走二进制（`scripts/build-tunnel.sh`，可交叉编译），Android 走 gomobile 出的 AAR（提交在仓库），iOS 走同一份源码出的 xcframework（不提交，约 235 MB，由 `scripts/build-xcframework.sh` 构建，且必须带 `-tags netgo`——iOS 没有 libresolv）。
- 手机包与桌面包不共用安装入口：通道、签名与更新机制按平台分开，能合的是代码库、流水线、版本契约与发布动作。

## 一条 tag 的编排

`.github/workflows/` 中 `release.yml`、`desktop-release.yml`、`android-release.yml`、`ios-release.yml` 都由 `v*` tag 触发，各自先校验**tag 指向 main**（tag 事件不带分支信息）。约定：

- Windows 安装包由 `desktop-release.yml` 的 `windows-installer` job 产出，并在真实 Windows 上断言静默安装、覆盖安装与卸载；该 job `needs` macOS job，避免两个 job 同时 `gh release create` 撞 422。
- 桌面两端的报告由**一个** `report` job 汇总后 force-push 到 `ci-status`，手机端各自用自己的孤儿分支（`ci-status-android`、`ci-status-ios`）：两个 job 各推一次会互相删文件。
- 产物归属：`.dmg`/`.exe`/`.apk` 挂到 tag 的 Release；iOS 只在配置签名后上传 TestFlight，当前没有分发产物，`.ipa` 也不作为下载资产。
- 签名一律**外部化**：iOS 与 Windows 的签名步骤由 secrets 开关守卫（`AW_IOS_SIGNING` / `AW_WINDOWS_SIGNING`），缺凭据时跳过并在日志里说明；证书与私钥不进仓库。
- 新增或修改 workflow 后必须能过 CI 里那条 actionlint 门禁。

## 渠道

- 桌面通道由 `scripts/dsh-netbird-client-publish.mjs` 发布：`install.sh`、`install.ps1`、站点、镜像的 NetBird 归档（`TARGETS` 含 darwin/linux/windows）、`checksums.txt`、`latest.txt`、`management-url.txt`。nginx 的 `/install.ps1` 与 `/install.sh` 各只有一个 location 块。
- 手机通道由 `tools/netbird-client/scripts/publish.sh` 发布：APK + `version.json` + `fleet.json`，原子替换根目录并校验权限与可达性；它拒绝发布版本与通道广告不一致、或控制端与 dex 不一致的包。
- 落地页（桌面通道的站点）只承诺已经可得的产物：某端的接入方式还没发版时，页签上必须照实标"开发中/待发版"。

## 什么才算"验过了"

| 端 | 验收方式 |
| --- | --- |
| macOS | 重新挂载写出的 dmg，断言应用、`Applications` 符号链接、说明文件与背景（`test/make-dmg.test.mjs`） |
| Windows | 在真实 Windows 上静默安装 / 覆盖安装 / 卸载，并从注册表与目录核对结果；本地无 Windows 主机时用 [poc/winvm](../tools/anywhere-agent/poc/winvm/README.md) 的 KVM 工装跑同一套断言 |
| Android | Gradle 单测 + 模拟器冒烟 + 设备上的两条 E2E（发现链路与分组可见性） |
| iOS | 构建 Release 模拟器包并**在模拟器里真跑**（登录页渲染、桥返回编译进去的控制端地址）；页面经 overlay 打开这一步需要真机 |
| 引擎 | 每端的引擎都必须真的应答自己的协议（`{"id":1,"cmd":"version"}`），而不是只被打包进去 |

验收证据（截图、串口日志、命令输出）留在对应的 `poc/` 或 `evidence/` 目录里；本文件只写判据，不记录某一次运行的结果。