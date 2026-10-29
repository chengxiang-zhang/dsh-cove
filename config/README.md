# 配置（模板入库，真值本机）

这个目录放两类配置，分界是"能不能公开"：

- `config/fleet.json`：客户端共享的产品默认值（管理端、Cloud 域名、更新/引导地址、登录流程偏好），**提交入库**，不含任何凭据。它是移动端、桌面端、Android/iOS 原生资源与发布脚本的唯一来源，由 `node scripts/render-fleet-config.mjs` 渲染。
- `config/deployment.example.json`：机器相关的部署模板，**提交占位符**；真实值放不提交的 `config/deployment.local.json`（已在 `.gitignore`），由 `node scripts/config-render.mjs` 渲染进构建产物。

## fleet.json（客户端单一来源）

改这里，然后运行渲染与检查：

```sh
pnpm fleet-config:render   # 写入生成文件
pnpm fleet-config:check    # 漂移检查（CI/提交前用）
```

生成的产物（不要手改）：

- `tools/netbird-client/src/generated/fleetConfig.ts`（移动端 JS）
- `tools/anywhere-agent/src/generated/fleetConfig.mjs`（桌面端默认值）
- `tools/netbird-client/android/app/src/main/res/values/fleet_cloud_config.xml`（Android 资源）
- `tools/netbird-client/ios/NetBirdPortal/Info.plist` 的 `AWManagementURL` / `AWCloudDnsDomain` 两个键

| 键 | 用途 |
| --- | --- |
| `management.mode` | `cloud` 或 `self-hosted`，声明默认部署形态 |
| `management.url` | 新装客户端默认注册的管理端地址（Cloud 为 `https://api.netbird.io:443`） |
| `management.cloudHostSuffixes` | 哪些管理端主机名算 NetBird Cloud（按后缀匹配，驱动 Cloud/自建两套命名规则） |
| `dns.cloudDomain` | Cloud 账号的 peer DNS 域名，机器入口为 `<peer>.<cloudDomain>` |
| `bootstrap.updateBaseUrl` | 公开更新通道前缀（`version.json`、`fleet.json`、APK） |
| `bootstrap.overlayUpdateBaseUrl` | 通道在覆盖网内的地址前缀（发布脚本校验用） |
| `bootstrap.mobileConfigUrls` | 手机端引导文档地址（覆盖网回落必须是裸 IP，netstack 解析不了域名） |
| `bootstrap.desktopConfigUrls` | 桌面端引导文档地址（桌面代理可解析覆盖网域名） |
| `auth.flow` | 登录流程偏好：`auto`（默认，按管理端能力自动选）/ `device` / `pkce` |

自建机队的 DSH zone 不在这里重复：它由 `tools/dsh-netbird/machines.json` 的 `domainPattern` 决定，渲染器从那里推导，`pnpm dsh-netbird:mobile-registry` 负责校验。

## deployment.example.json（机器真值模板）

- 提交：`config/deployment.example.json`（占位符，公开可见）
- 不提交：`config/deployment.local.json`（真值，已在 `.gitignore`）
- 渲染：`node scripts/config-render.mjs` 把 `config/templates/*.tmpl` 渲染成构建产物（例如 `packages/dsh-web-all/presets/hiopen.patch.yml`），产物同样不入库。

示例文件里的地址、STUN URI 与分发前缀都是占位值，不得替换成真实凭据后提交。密钥与 token 只放在 `$DSH_HOME/.credentials.yaml`、环境变量或用户级 `~/.npmrc`；凭据处理与泄露报告流程见根 [SECURITY.md](../SECURITY.md)。

读取顺序：`DSH_COVE_CONFIG` 环境变量指定的文件 → `config/deployment.local.json` → `config/deployment.example.json`。
结构化字段缺失或格式错误时直接报错，不做静默降级；未提供本地文件时使用模板值，此时 `configSource` 为 `template`，调用方可以据此决定是否允许发布。

## 字段

| 键 | 用途 |
| --- | --- |
| `llm.hiopen.baseUrl` | OpenAI 兼容的 HiOpen 路由地址，渲染进 `presets/hiopen.patch.yml` |
| `netbird.managementUrl` | 自建 NetBird 管理端地址；客户端默认值见 `config/fleet.json` 的 `management.url` |
| `netbird.stunUri` | 移动端连通性诊断使用的 STUN URI |
| `fleet.apkChannelBaseUrl` | 移动端安装包分发地址前缀 |

## 本机准备

```sh
cp config/deployment.example.json config/deployment.local.json
# 编辑 config/deployment.local.json 填入真实值
node scripts/config-render.mjs
```
