# @dsh-cove/dsh-web-all

[English](README.md) | 中文

`@dsh-cove/dsh-web-all` 是 dsh-cove 功能家族唯一的运行时实体。它的 runtime patch 只提供一条实体行 `web-all`，独立 bundle patch 分别声明 HiOpen 模型路由与可选的 `code-vibe` Agent 预设；浏览器能力由 sidebar、conversation、settings 三个位置模块统一编排，host 能力则作为服务域运行在同一个插件生命周期内。

## 能力

- **工作区与会话工作流**：项目记忆面板、Git worktree 管理与会话隔离、workspace-model 预设。worktree 不再有独立页面。一个 worktree 就是一条 lane：输入框的分支选择器创建该分支的 worktree，并把它的目录注册为一个工作区（这是平台约束，不是口味——注册表只把 cwd 等于工作区路径的会话算作该工作区成员，而没有任何工作区认领的空白对话，输入框是禁用的），随后用平台自己的工作区导航把对话移上去。这条注册刻意短命：lane 的对话全部归档后即注销（目录、分支与绑定都保留，再选该分支一步就能重建），启动时还会清掉旧版本留下的行。会话顶部的 lane chip 既显示当前分支，也承载它余下的生命周期——提 PR、检查是否已合并、删除目录（可勾选连本地分支一起删），删除同时注销该工作区。界面上这些词一律写成「分支目录」，不出现 worktree / lane 这类实现词。
- **开发工作台**：输入区的 Git 分支 chip 与图谱对话框、右栏 Source Control 工作台，以及把 Codex 注册为 `llm-pi-ai` provider 的 Codex 桥接。
- **HiOpen 模型路由**：不含凭据的 `llm-pi-ai` 预置提供一份精选模型目录，端点自带（在 `config/deployment.local.json` 填 `llm.hiopen.baseUrl`，再跑 `node scripts/config-render.mjs`），仓库不提交任何端点与凭据，并为 DSH Agent 精选准确模型 id、上下文/输出上限、推理档位和文本/图片模态。
- **远程运维**：SSH 主机、终端、传输、隧道和集群执行，以及通过本地密码、飞书或通用 OIDC 登录并持久访问 DSH 原生 Web 界面。
- **飞书接入**：飞书 bot 长连接收件箱与 `lark_inbox_peek`、`lark_inbox_pop`、`lark_inbox_ack` 工具、连接向导，以及 **设置 → 内置插件 → 飞书** 里的配置页。
- **运行结束通知**：会话每结束一轮就记录一条结果，聚合到只读的 `GET /api/dsh-notify/feed`，由桌面端与手机端的机器列表据此标出未查看的结果，并可在运行停稳后把结果推送到飞书。配置在 **设置 → 内置插件 → 通知**。
- **浏览器自动化**：按会话隔离的 Playwright 浏览器，以 `mcp__playwright__*` 工具命名空间对外提供。
- **自动化任务运行目标**：原生自动化任务默认投递回创建它的会话；本能力让每条任务可选「每次新会话」——每次运行开一条全新会话，原对话只保留任务定义。**没有单独的设置界面**：在创建任务时说清楚（自然语言）即可，agent 用 `schedule_mode_set` 一次设好。
- **许愿式编程预设**：内置 `code-vibe` 预设及其精选 skills 与原生编码工具，作为额外会话模式显示；标准模式仍为默认。

Web profile 的运行时栈是 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + `@dsh-cove/dsh-web-all`。社区插件索引包是数据源包，不是 profile 条目。

## 安装

### 从 npm 安装

```sh
dsh plugin --profile web add @dsh-cove/dsh-web-all@latest
# 卡在 ERR_PNPM_IGNORED_BUILDS？把提示的键加进 profile 的 pnpm-workspace.yaml
# allowBuilds，然后先 remove 再 add：失败的那次已写入依赖，直接重跑只会写依赖，
# 不会登记 profile 的 bundle 行。
dsh --profile web --dump-config  # 挂载出 web-all 行才算登记成功
# 安装后重启受管的 dsh web 进程。
```

DSH Desktop 请把 `web` 替换为 `desktop`，用 `dsh --profile desktop --dump-config` 验证，然后完全退出并重新打开桌面应用。

### 从仓库安装

```sh
git clone https://github.com/chengxiang-zhang/dsh-cove.git
cd dsh-cove
pnpm install
pnpm --filter @dsh-cove/dsh-web-all build
node scripts/link-profile.mjs
dsh plugin --profile web add link:$(pwd)/packages/dsh-web-all
dsh --profile web --dump-config
```

修改 profile 后需要重启目标 DSH host；刷新页面不会重新加载 Cordis bundle。

### 卸载

```sh
dsh plugin --profile web remove @dsh-cove/dsh-web-all
```

卸载后重启目标 DSH host。

## 配置

`web-all` 行接受以下插件级选项：

| 选项 | 默认值 | 用途 |
| --- | --- | --- |
| `dshHome` | `$DSH_HOME` 或当前用户的 DSH 主目录 | 覆写接受中央值的服务域所使用的 DSH 数据根目录。 |
| `agentsHome` | `$DSH_AGENTS_HOME` 或解析后的 DSH 主目录 | 覆写用户 agents 与 skills 根目录。 |
| `noBrowserAuth` | `false` | 仅在显式设为 `true` 时跳过 BrowserAuth token 与 cookie 校验；参见[安全模型](#安全模型)。 |
| `playwright` | `{ mode: launch, … }` | 选择启动隔离浏览器，或在用户确认后连接其 Chrome/Edge 中选定的标签页。 |

Profile 覆写示例：

```yaml
- id: web-all
  config:
    noBrowserAuth: true
```

各能力域的配置聚合在同一个 `web-all` 条目的命名空间下：`remote-web-ui`、`lark-inbox`、`notify`、`dsh-ssh`、`dsh-codex-bridge`、`workspace-model`、`web-render`、`schedule-mode`。Web GUI 为飞书与通知各提供一个配置页（**设置 → 内置插件 → 飞书 / 通知**）；飞书页只负责「怎么收」，通知页负责「怎么发」与客户端读取，其余命名空间通过 profile 覆写或设置文档编辑。

内置 `hiopen` 路由通过 DSH credentials 解析 `HIOPEN_API_KEY`；密钥只应写入 `$DSH_HOME/.credentials.yaml` 的 `refs.HIOPEN_API_KEY`，不得写进 profile 或仓库。预置只暴露精选的聊天/Agent 子集，而不是照搬 `/v1/models` 的全部条目：端点同时会列出 embedding、guard、detector 和暂时不可用的路由。端点变化时可用 profile 覆写替换或扩展 `hiopen.models`。

`remote-web-ui` 命名空间默认启用 DSH 自身 origin 的集成鉴权。本地账号、飞书和通用 OIDC 会签发同一个 HttpOnly 会话，并统一覆盖 `/`、`/api` 与 `/api/remote.mux`；原生启动 token 仍可使用。移动浏览器也直接使用 `/` 下的原生 Web 界面。`publicBaseUrl` 应设置为 OAuth 回调使用的精确 HTTPS origin。`0.0.0.0:3082` 兼容监听器仍可通过 `legacyGatewayEnabled: true` 启用，但默认关闭。

通用 OIDC 使用 Authorization Code、PKCE S256、state 与 nonce 校验。请配置 `issuer`、`clientId`、`clientSecret`，以及基于稳定身份的 `allowedSubjects` 和/或 `allowedEmailDomains`。飞书使用 `appId`、`appSecret` 与 `allowedOpenIds`。外部登录不能创建首个账户，必须先引导创建本地管理员；此后空 Provider 准入列表才会允许其他账户即时绑定，因此生产部署通常应设置显式准入列表，并保留该本地应急管理员。

Playwright 服务域是 `mcp__playwright__*` 公共工具名的唯一所有者。启动本插件前必须移除全局 `mcp-playwright` 行；工具名重复会导致 Playwright 注册失败。默认 `launch` 模式按 DSH 会话隔离浏览器进程，最多并发两个，并回收空闲会话。`extension` 模式则把官方 [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) 中选定的标签页独占租给一条由人确认的 DSH 会话：在该会话右栏打开「Agent 浏览器」，点连接，在扩展中批准并分配标签页。断开后外部 Chrome 继续运行。控制面走插件共享的宿主访问围栏——loopback 请求，或请求 Host 属于部署通过 `ctx.webRuntime.trustedHosts`（`--trusted-host`）声明且携带有效 DSH 浏览器会话的 authority；任意代码工具默认隐藏，`approvalPolicy: mutations` 会在每个非只读浏览器动作前走 DSH 一次性审批。

```yaml
- id: web-all
  config:
    playwright:
      mode: extension
      browserChannel: chrome
      approvalPolicy: mutations
      allowedOrigins: ['https://example.com']
```

`allowedOrigins` 与 `blockedOrigins` 是 Playwright 导航护栏，并非完整的授权边界：重定向和页面内容仍是不可信输入。扩展模式不重复投放实时画面，因为用户已经能看到被连接的 Chrome 窗口；`liveView` 只用于启动的浏览器。

SSH 执行、交互终端、传输和隧道都在客户端认证前校验服务器身份。请在宿主用户的 `~/.ssh/known_hosts` 中预置已核验的记录（非默认端口使用 `[host]:port`），或在共享宿主围栏后的 `POST /api/dsh-ssh/hosts` 或 `PATCH /api/dsh-ssh/hosts/:alias` 中，把主机条目的 `hostKeyFingerprint` 设置为经服务器管理员独立核验的 SHA256 指纹。PATCH 时省略该字段会保留 pin，设为 `null` 则恢复 known-host 校验。未知或变化的密钥会被拒绝，不会自动信任首次连接。池内连接每次接纳新操作前也会按当前信任重新校验；移除或吊销信任会阻止新操作，但不会终止既有通道或隧道。支持主机名模式与 hashed known-host 记录，不支持 host certificate 或 `@cert-authority`。显式指纹 pin 具有优先权，但匹配的已吊销密钥仍被拒绝。当前引擎会拒绝 `proxyJump`，而不是静默直连。仅有 `ssh-keyscan` 输出不构成身份核验。

SSH 执行默认带超时：`ssh_exec` 与 `ssh_cluster` 未显式传 `timeoutMs` 时用 `dsh-ssh` 命名空间的 `execTimeoutMs`（默认 120000 毫秒，即 2 分钟），因此远端命令不返回（`tail -f`、等待输入、卡住的挂载）只会超时失败，不会让调用无限等待。超时后本域关闭该 SSH 通道，远端命令随通道一起被 sshd 清理；宽限期内通道仍未关闭（连接已挂死）则断开整条连接，脏连接不会留在复用池里。长任务请显式传更大的 `timeoutMs`：

```yaml
- id: web-all
  config:
    dsh-ssh:
      execTimeoutMs: 600000
```

`web-render` 服务域给 `web_fetch` 换上一个用真实 Chromium 渲染的抓取后端。原生 `dsh-web-fetch-http` 只做 HTTP GET，客户端渲染的页面（SPA、懒加载列表、内容靠 XHR 回填）拿到的只是空壳；本域注册 fetch provider id `browser`，等页面脚本执行完再返回**渲染后的 DOM**，HTML→markdown、GFM 表格与截断仍由 `dsh-tool-web` 负责，模型侧的工具名与 schema 不变。

`dsh-web-app` bundle 已把 `web` 行的 `fetchProvider` pin 成 `http`，而 seam 在多 provider 可用时不会自动择优（只会报 `WEB_PROVIDER_AMBIGUOUS`），因此需要在**使用该能力的 profile** 的 `cordis.patch.yml` 里显式改 pin：

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    fetchProvider: browser
```

pin 必须与 provider 的注册保持一致：provider 缺席会报 `WEB_PROVIDER_CONFIGURED_MISSING`，所以只要 `web` 服务存在本域就会注册；没有可用浏览器时注册期写一条告警，抓取以 `WEB_PROVIDER_UNAVAILABLE` 失败。回退只需删掉 profile 里的那一段。

抓取使用持久化 Chrome profile（默认 `$DSH_HOME/cache/web-render/chrome-profile`），登录一次即可长期复用登录态；同一 profile 同时只能被一个进程占用，撞上时本域降级到临时 profile 并告警。`web-render` 命名空间可调整无头、导航等待、超时、视口、提取方式与字符上限。

`web-search-anthropic` 服务域只注册一个额外的 search provider（id `anthropic-messages`），且只补一件事：**响应解析**。官方 `deepseek-official` provider 发出的请求本身是对的（Anthropic 兼容 Messages + 原生 `web_search_20250305`），但它的解析器写死了「响应必须含 `web_search_tool_result` 块」，缺席即抛 `WEB_PROVIDER_ERROR`——所以面对「只回 `server_tool_use` + `text.citations[]`」的上游（Bedrock 系路由就是这样），**改任何配置都救不回来**。本域用**同一份配置**发同样的请求，额外接受这种形状，把 citation 摘录接到结果条目上作为 snippet；对「模型只是回了一个客户端 `tool_use(web_search)`」（端点并未执行搜索）给出可操作的报错，而不是返回空结果。

**它不新增任何配置面。** 端点、模型、凭据引用、`anthropic-version` 与两个请求上限，都是每次搜索从官方 `web-search-deepseek` 条目现读的活值——就是**设置 → 插件 → 内置插件设置 → Web search** 那几项。要换任何 Anthropic 兼容 Messages 搜索 API，就改那份配置（或在 profile patch 里改该条目的 `baseURL`/`model`/`apiKeyEnv`），跟给官方 provider 改配置完全一样；插件源码里没有任何厂商端点、模型名或密钥引用。key 每次搜索按配置的凭据引用从 DSH 凭据或启动环境现取，轮换后下一次调用即生效，无需重启。注意：直接填在该条目里的字面 `apiKey` 这里用不了（设置读取对 secret 字段做脱敏），请用凭据引用。

搜索 provider 与抓取 provider 用同一种方式 pin，写在**使用该能力的 profile** 的 `cordis.patch.yml` 里：

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: anthropic-messages
    fetchProvider: browser
```

两个键必须一起写：patch 会整体替换 `config` 对象，只写 `searchProvider` 会静默丢掉 `fetchProvider` 的 pin。pin 必须与 provider 注册保持一致——provider 缺席报 `WEB_PROVIDER_CONFIGURED_MISSING`，所以只要 `web` 服务存在本域就会注册；端点或模型没配时注册期写一条告警，搜索以「去 Web search 设置里配」的明确错误失败。回退是把 `searchProvider` 改回 `deepseek-official`，配置两边通用、不用改。

## 自动化任务运行目标

DSH 原生 `@deepseek-ai/dsh-schedule` 把任务绑定在创建它的会话上，到期就把提醒投递回那条会话（`resolveAgent(sessionId)` + `followup`），不提供「每次运行新建会话」的选择。本服务域在**不修改原生插件**的前提下补上这个选择。

**它没有界面入口，也不该有**：运行目标在**创建任务时**用自然语言设定——用户说「这个任务每次新对话跑」，agent 先 `schedule_create` 再 `schedule_mode_set(mode=new)` 一次设好（`schedule_mode_list` 用于查看每条任务跑在哪）。不新增侧栏页、不加页头图标、不占原生卡片。

- **原会话**（默认）：不建任何策略，完全走原生投递，行为与未安装本能力时逐字一致。
- **每次新会话**：按原任务的计时规则，在一条**新建的运行会话**上挂一把同规则的运行副本，并撤掉原会话上的那一行；副本每次投递完成后，本域再开下一条运行会话并把副本换挂过去。原会话因此永远不再是投递目标，每次运行都落在一条全新会话里。

计时完全由原生调度器负责：副本自身按原规则推进 `scheduledAt`，到点仍由原生运行时投递，所以 cron / 每日 / 每周 / 固定间隔的语义与原生一致，Host 重启后照常生效，本域也不需要自己实现时区与时点计算。投递确认（原生回执，以及「副本时点已被推进」这一主判据）驱动轮转。目标切换与轮转先持久化操作日志，并按精确 ID 删除旧任务后再创建替代任务。恢复会继续处理已知任务关联，但原生调度器没有幂等键，因此不能保证恰好创建一次：已记录创建意图、却没有记录返回结果时，会停止并报告 `recovery-required`，而不是另建任务。人工退役不确定副本、重新创建任务前，必须核对原生任务目录与已保存日志，不能盲目重试。替换期间跨过 `at` 时点也会标为待恢复，不会静默报告完成。先删后建优先避免重复，而非保证可用性：故障可能暂停任务或错过一次投递。缺少精确身份的旧版未完成转换也需要人工恢复。同路径的多个引擎只在同一进程内协调；禁止多个 Host 进程共享该调度存储。损坏存储与非法日志会拒绝执行并保留原字节。已确认的一次性投递会先合并运行记录，不会在切换时重放；删除窗口跨过投递时点且缺少原生回执时，只能标为待恢复。

- 任务由**逻辑 id** 稳定标识（`schedule_create` 返回的那个 id）；内部轮转副本的 id 不出现在工具返回值里。
- 运行记录由 Host 保留最近 `runHistoryLimit` 条（默认 50），可通过 `/api/schedule-mode/*` 读取（仅 loopback），且读取范围限定在调用方给出的 `sessionId` 上（不带 sessionId 不返回任何行）；每次运行还会给运行会话命名 `<任务名> · #N`。
- 切回「原对话」会在原会话上重新挂一把同规则任务（周期规则的相位按原生 `create` 语义从保存时刻起算），并保留既有运行记录。
- 运行目标切换与运行记录在 `/api/schedule-mode/*` 上走共享的宿主访问围栏，且只有任务 id 不足以触达别的会话（副本 id 回退只在调用方属于同一策略时生效）；agent 工具是 `schedule_mode_list` 与 `schedule_mode_set`（`session_id` 缺省取调用方会话），因此在对话里就能直接说「这个任务改成每次新会话」。
- 运行会话先在工作区之外创建（运行开始前它在侧栏属于「未分组」），投递出第一轮后才挂回它所属的工作区：工作区里尚未产生第一轮对话的空会话会被 DSH 的「新建会话」当作草稿复用，待运行会话因此会把新对话认领成自动化运行会话。没有进行中转换时，原生目录中确认缺失的副本视为用户删除，不会补建；中断的转换只按持久化操作日志处理。
- 原生 schedule 是可选的实验 bundle。profile 没有挂载它时，工具返回 `schedule-unavailable`，其它能力不受影响；不会因为缺这个 bundle 而让 `web-all` 加载失败。

在原生「自动化任务」页里，处于「每次新会话」的任务在轮转期间显示在当前运行会话下——这是原生视图按绑定会话分组的直接结果；创建它的原会话不再显示原生时钟标记。管理这类任务请用 agent 工具（切换目标、删除），或直接在对话里说；**运行目标没有设置页面**，这是刻意的。

`schedule-mode` 命名空间：`enabled`（默认 `true`，关闭后工具与 host API 一并下线）、`nameRunSessions`（默认 `true`）、`runHistoryLimit`（默认 50）。

```yaml
- id: web-all
  config:
    schedule-mode:
      runHistoryLimit: 200
```

## 安全模型

- 暴露本地状态或高权限操作的 Host API 共用一条访问围栏：loopback 请求，或请求 Host 属于部署通过 `ctx.webRuntime.trustedHosts`（`--trusted-host`）声明的 authority 且携带有效 DSH 浏览器会话，并且始终要求同源标记。socket 本身必须保持 loopback，因此同机反向代理把规范 Host 转发到 `127.0.0.1`。该围栏不能替代有身份认证的网络边界；`noBrowserAuth: true` 会把远程分支退化为仅 Host/Origin 检查。
- 读接口同样是特权面：worktree 索引与 lane 查询、工作区模型读接口、运行结束通知源（`GET /api/dsh-notify/feed`）、飞书凭据向导都走同一条围栏。通知源只发布会话标题、结束原因与时间，不含会话正文，也没有写接口：客户端的已读位置保存在客户端自己，宿主不保留按客户端的读取状态。这里没有第二条放行路径，worktree 的变更接口只认这条围栏。`/api/pair/*` 的配对管理更严格：除 loopback socket 外还要求 Host 为 loopback，因此同机反向代理不会把令牌签发、列表与吊销暴露给远程浏览器。
- worktree 的 git 调用有期限且 fail-closed：`git fetch`、`ls-remote` 与祖先探测的期限是 15 秒，push 是 180 秒，因此网络卡死既不会长期占住某个仓库的操作锁，也不会让 lane 菜单一直停在加载态。`POST /worktree/status` 由宿主缓存提供（60 秒），插件的每次变更都会让它失效，因此打开 lane 菜单只是一次内存读取，只有显式点「检查是否已合并」（或带 name 的探测）才会重新跑远端判定。判定「已合并」有两条路：远端分支 tip 是 base 的祖先；或跟踪引用已被清理（GitHub 合并后删分支留下的状态）时，该 lane 已越过创建时的提交，且本地 tip 包含在 base 里。会话顶部的 lane chip 读的就是同一条规则，因此用户在徽标上看到的状态与放行删除的守卫不会互相矛盾：删除时勾选「同时删除本地分支」走那条先验合并的清理路径（目录、本地分支与清单记录一起删）；不勾选则是普通移除，只删目录、保留分支，误删后重新选该分支即可再建。清理只在上述合并判定成立后，才把被拒的 `git branch -d` 升级为 `-D`；删不掉分支时如实报错，而不是假装成功。活跃会话仍然阻止拆除 lane，只有一个例外——否则这条 lane 将永远无法拆除：清单里记录为该 lane 自己的那个会话，可以通过自己的 lane chip 请求拆除（拆除会像处理任何 lane 会话一样归档该对话）。lane 清单里没有记录的会话 id 不构成任何豁免。把对话绑定到它的 lane 之前，请求会先被完整校验、再产生任何副作用：会话必须在宿主上活着、分支必须是合法 ref、仓库清单里必须有这条 lane、且该对话自己的 cwd 必须正好解析到那个目录——否则请求被拒（`lane-mismatch`、`session-unknown`、`worktree-not-found`、`invalid-branch`），且会话的访问模式保持原样。绑定只是记录对话本来就在哪里跑，永远不是搬运对话的手段，也不可能把 `danger-full-access` 交给一个不在该 lane 里的对话。变更类路由都带显式仓库路径，而该路径必须解析到宿主已注册的工作区之内：请求侧做 `realpath`，用注册表自己的列表，配段感知的包含判断（因此名字只以 `repo` 开头的兄弟目录 `repo-other` 不会被当成在 `repo` 里）。这与 Git 工作台经过它自己的 workspace gate 施加的规则一致；不在任何工作区内的仓库会以 `workspace-unknown` 被拒，且在任何 git 步骤之前就拒绝。
- Codex 桥（`/api/dsh-codex-bridge/*`）有意留在该围栏之外：设备码登录、代理重启与链路校验都是本机操作，远程入口应显示该模块不可用，而不是把它暴露出去。不要把它放给远程 authority。
- 远程入口的 Host 所有权来自 `GET /web-all/remote-access/boot.js`：这是一条 parser-blocking 首页注入，由处理器按同一围栏逐请求决定。缺少该声明时 DSH 客户端把设置面留在进程内存态，设置 → 模型报 `settings are unavailable in this browser`。`GET /api/dsh-access/session` 发布无需会话的姿态读数（`authority.declared`、`session`、`owners`），供全线审计与客户端兜底探测读取。
- 明文 HTTP 远程入口不是浏览器安全上下文，因此同一服务域向每个首页注入 `crypto.randomUUID` polyfill 与基于 `execCommand` 的 `navigator.clipboard` shim（绝不覆盖真实 clipboard 对象）。`navigator.locks` 没有 shim，该入口的 Git 流跨标签共享会退化为每个标签一条流。
- `noBrowserAuth` 是显式 opt-in，默认值为 `false`。启用后只修改 BrowserAuth 的认证判定，Host/Origin 围栏仍然生效。只能在有身份认证的反向代理或等价的可信网络门禁后启用，禁止把它当作公网可达主机上的便利开关。
- 集成 WebAuth 与原生 BrowserAuth 组合，并保留 DSH 的 Host/Origin 信任围栏。本地、飞书和 OIDC 有效会话统一覆盖首页、HTTP RPC 与 `/api/remote.mux`；原生启动 token 作为应急入口继续保留。若私有 BrowserAuth 兼容接口发生变化，集成会拒绝挂载而不是放行。
- `3082` 网关是默认关闭的兼容监听器。启用时它继续使用同一账户存储；常规 NetBird 与反向代理部署直接路由到 DSH 的 `3080` origin，并需要正确配置 DSH trusted hosts。
- 账户密码按账户存为 scrypt verifier，并使用恒定时间比较。账户和会话存储默认位于 `$DSH_HOME` 下，采用原子写入与仅 owner 可读写的 `0600` 文件。账户 API 不返回密码 verifier 或密码。授权／撤销日志及 `.blocked` sidecar 都是敏感恢复状态，必须随主 image 一起备份，不能自动删除拒绝标记。持久化失败会在当前进程拒绝认证并报告失败，不代表修改已提交。如果整个存储介质拒绝所有写入，就无法留下持久拒绝证据：重启后最后一次已提交状态可能仍有效。依赖失败的撤销操作前，应先停止服务访问、恢复存储；store 与原子 rename 均不提供电源故障 fsync 保证。
- 登录会在 HttpOnly、SameSite=Lax cookie 中创建全新的 256 位会话 id；只有启用内置 TLS 时 cookie 才带 Secure。会话跨重启持久化，默认空闲期限为 7 天、绝对上限为 30 天，并会在登出、管理员操作、修改密码或角色、禁用账户或删除账户时被吊销。角色修改后，该账户必须重新登录；旧 cookie 不能保留此前的管理员角色。账户 image v2 将非空授权 revision 与账户状态原子存储；严格迁移旧 image 时，无该 revision 的 cookie 会失效。已有损坏或不支持的账户 image 必须人工恢复，不能自动 bootstrap。读取慢请求体后，管理员操作会再次检查权限。兼容网关在撤销时关闭已升级连接的双向流，并在一秒内检查过期；这不构成对原生 DSH 已升级 mux 连接即时撤销的证明。管理员会话列表包含用于吊销的有效不透明会话 id，因此必须把该表面视为凭据敏感面加以保护。
- 集成账号属于可信操作者：所有已认证用户共享该 DSH 实例的工作区、会话、设置、凭据与文件系统权限。角色用于账户/会话管理和旧网关兼容策略，并不是资源隔离或多租户 RBAC。旧网关中的 user WebSocket 可访问 `/api/remote.mux`，终端和其它 upgrade 路径仍要求 admin。
- TLS 是可选项。未配置 `serverTlsCert` 与 `serverTlsKey` 时，凭据、cookie 与流量都使用明文 HTTP，网关应只留在可信网络。`serverTlsKey` 是可读的文件系统路径而不是密钥内容，`bootstrapAdminPassword` 则是 secret schema 字段；请保护 settings source，并在创建首个账户后清空或轮换 bootstrap 凭据。首个账户会被强制为 admin，最后一个已启用管理员不能被降级、禁用或删除。
- SSH 密钥、密码和 passphrase 属于 host 侧配置。列表投影不会返回机密字段，但凭据以未加密形式写入 DSH 主目录下原子替换、仅 owner 可读写的 `0600` 文件（保存时也修复已有文件权限），远程命令输出也不会脱敏；请相应保护系统账号和文件系统。服务器密钥校验不提供远程执行隔离，也不限制 SSH 账户权限。同一主机的连接建立采用 single-flight，认证完成后再次核对当前配置与信任；卸载后拒绝待完成与新连接。损坏的主机存储拒绝读取，不会被空表覆盖。协作 writer 对完整读改写持排他锁，最多等待两秒；竞争超时报告 `SSH_HOST_STORE_BUSY`。崩溃遗留锁不会按时间或 PID 自动抢占：必须停止全部 writer、核对所有权后人工恢复。这不是抵御同用户恶意进程的 OS 安全边界。
- Playwright 工具可以使用本地 DSH 进程和浏览器会话的权限访问站点并修改外部系统。请保留唯一工具命名空间、检查目标 URL，并在敏感操作结束后关闭会话。
- 飞书凭据由宿主访问围栏后的向导路由写入 profile 设置文档。通知域默认沿用同一套应用凭据（也可在通知页单独填写 `feishuAppId` 与 `feishuAppSecret`，支持 `env:变量名`）。请把该文档视为凭据敏感数据，并保持 loopback web 服务器私有。

## 已知限制

- 所有服务域共享一个 `web-all` 生命周期，不能作为单独的 profile 条目分别启停。
- 共享宿主访问围栏判定的是「请求是否来自被承认的浏览器入口」，不是「它属于哪个账号」：围栏只暴露一个布尔值。因此数据归属于某个会话的面（Agent Browser 实时视图 `/playwright-sessions/ws/browser`、工作区内的 `git-status`、以会话 cwd 为键的 memoir 项目存储）对任何通过围栏、并且知道会话 id 或工作区路径的调用方可见；在宿主把调用方身份暴露给路由族之前，这些面无法按账号隔离。
- 设置界面刻意保持最小：只为飞书与通知提供配置页，其余能力域配置通过 profile 覆写或设置文档编辑。
- 通知只记录「这个进程启动以来」的结果，不落盘：宿主重启后已记录的结果会清空，客户端未读取的编号随之失效。客户端遇到编号回退（宿主换了一个进程）会从零重读，因此新结果不会被永久隐藏；代价是重启后第一次读取会重复报告当前持有的结果。记录的是结束事件而非完整会话，正文只出现在会话日志里。
- HiOpen 目录是保守的 Agent 可用子集。端点可用性和上游路由可能独立变化；通过模型清单但未通过聊天/工具探针的模型不会在验证前暴露。
- Playwright 依赖随包浏览器运行时和本机可用的浏览器二进制。全局 `mcp-playwright` 条目会与本包拥有的 `mcp__playwright__*` 工具冲突，必须移除。
- 默认命令超时只覆盖 `ssh_exec` 与 `ssh_cluster`：SFTP 传输（`ssh_upload`、`ssh_download`）与 Web 交互终端没有超时，会一直进行到传输完成或会话结束——它们的耗时由数据量和远端响应决定，而不是由一条命令决定。
- 「每次新会话」任务可用 agent 工具删除，也可在原生任务页删除运行会话上的那一行：两者都会让该任务停止，且不会被重建。原生页删除后策略在下一次收敛时退役（schedule_mode_list 不再报告它）；中断的轮转只有在日志能确定副作用身份时才会继续，否则明确保留为 `recovery-required`。
- 原会话被归档或停止时，本域会撤下该任务的运行副本并把它标记为已停止（原生只会清理绑定在原会话上的任务）。
- 兼容性跟随锁定的 `@deepseek-ai/*` SDK 版本与本仓库发版节奏。

## 许可证

Apache-2.0。第三方资产与保留实现继续使用仓库源包内各自的声明。
