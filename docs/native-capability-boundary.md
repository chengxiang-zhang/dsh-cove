# 原生能力边界

本文件是「哪些能力归 DSH 原生、插件只准补什么、什么插件可以独占」的事实源。插件里出现原生已完整的实现即视为缺陷，因为那部分代码只会跟着上游 interface 一起腐烂，却不会跟着上游一起升级。

基线是运行中的 DSH `0.2.1-rc.5`：`dsh-base` 的 96 行与 `dsh-web-app` 的 91 行 bundle 决定实际挂载了什么，可分发包共 306 个。本仓唯一的运行时实体是 `packages/dsh-web-all`（34,489 行源码、97 个测试文件）。

## 运行基线

一台机器上可能同时存在多个 DSH 树，且它们的版本可以不同，因此「原生有什么」必须按**运行进程实际加载的那棵树**判定，不能按仓库 devDependencies 判定。

- 运行树：`~/.local/share/dsh/versions/<version>/lib/node_modules/@deepseek-ai/dsh/`，`dsh` 可执行文件是指向它的软链。
- 仓库树：`packages/dsh-web-all/node_modules` 下是编译与测试用的 cohort，可能落后于运行树。
- Node 全局树：`$(npm prefix -g)/lib/node_modules/@deepseek-ai/dsh`，如果历史安装未清理，它仍在 Node 的全局解析路径里，`require.resolve` 会优先命中它。

浏览器侧的冻结模块表由 `dsh-web-frontend` 的 dist 决定，与 npm 包是否仍单独安装无关。`shared/web-platform.ts` 的 seed 列表必须与该表逐项一致，否则新增的 platform 模块会走到未 seed 的入口。

## 归属判据

四条判据按顺序判定，命中即停。

1. **原生已挂载且契约完整：只消费，不重建。** 宿主提供的槽、服务、Remote 命名空间、设置截面已经是扩展点，插件往里注册即可，不得另起一套状态、另一份数据源或另一个视觉壳。
2. **原生有原语但缺产品面：薄壳 + 消费原语。** 插件允许存在的理由只有「原生没给入口」，实现必须是原生原语之上的一层，且不得复制原语已经负责的状态机、计时、持久化或冲突处理。
3. **原生真空且本仓是唯一实现：插件独占整域。** 属于这一类的域可以自由设计，因为没有任何上游契约需要跟随；它们的产品价值本身就是唯一的第一方价值。
4. **原生缺陷的 workaround：暂存，上游修好即删。** 这类代码必须在服务域入口注释里写明「上游修好后可删」，否则下一次升级会被当成能力保留下来。

判定动作是三条只读检查：`dsh-base/cordis.patch.yml` 与 `dsh-web-app/cordis.patch.yml` 的 insert 行说明「装了什么」；`node_modules/@deepseek-ai/*/package.json` 的 description 说明「包能做什么」；未进入这两个 bundle 的实验包（例如 `dsh-experimental-worktree`、`dsh-experimental-session-search`）不构成可用能力，不能作为「原生已有」的依据。

## 两条独立的减法

「原生有了就砍插件」实际是两件事，不能混为一谈。

**砍功能域**只在判据 3 被推翻时成立，也就是原生真的提供了同一件事并且已经挂载。插件目前的 15 个服务域里没有一处满足这个条件，所以功能域级的删除额度接近于零。

**砍实现方式**是常态，收益远大于前者：插件仍然拥有该域，但底层改用原生已有的实现，不再自己造一层。当前自查出的自造层有四类，每一类都属于判据 1 或 2 的违规：

| 自造层 | 现状 | 原生替代 |
| --- | --- | --- |
| 宿主 HTTP 路由层 | 58 个 `webServer.register` 调用点、展开 79 个端点，0 条走原生 Remote；附带 12 份重复的有界 body reader 与 13 份 `writeJson` | typert Remote + `dsh-api-gateway`，白拿方法级授权、资源粒度、访问快照与增量、codec、事件白名单、单端点免 CORS |
| 浏览器 UI 原语 | 自绘 Modal、Menu、相对时间、剪贴板、图标，与同仓已用原生原语的写法并存 | `@deepseek-ai/dsh-client-ui-primitives` 的 `Modal`、`Menu`、`relativeTime`、`writeClipboard`、`Icon*` |
| 配置 schema 协议 | 93 行手写 volatile 引用协议，理由是社区 `schemastery@3.18.0` 没有 `.volatile()` | 宿主自带的 `@deepseek-ai/schemastery`（3.18.5）已提供 `.volatile()`，且与宿主校验用的是同一个 schema 类 |
| Agent 预设 | `code-vibe.patch.yml` 34 行 insert 里有 29 行与原生 `standard` 预设同 id 同名，17 行逐字节相同 | 只保留真正改写的行（当前是 persona 与 5 行独有行），其余继承原生预设 |

判定一个域「能不能砍」看判据 3，判定一个域「该怎么写」看判据 1 和 2。前者决定功能存在与否，后者决定维护成本。

## 归原生且插件零实现

这些领域插件不得实现，也不得为了定制而复制一份。

| 能力 | 原生所有者 |
| --- | --- |
| 侧栏、会话区、右栏的布局与分屏、pin、每会话持久化、关闭处理 | `dsh-client-ui-layout`、`dsh-client-ui-sidebar-right` |
| 右栏浏览器页签（人类浏览，非 agent 控制） | `dsh-client-ui-sidebar-browser` |
| 右栏本地 shell 页签、PTY 复用、屏幕恢复 | `dsh-client-ui-sidebar-terminal`、`dsh-api-terminal-controller`、`dsh-terminal` |
| 工作区文件树、文件预览、变更集与逐文件对比、交付卡片 | `dsh-client-ui-sidebar-files`、`dsh-client-ui-sidebar-documentpreview`、`dsh-workspace-changes`、`dsh-client-ui-deliverables` |
| 插件安装、启停、重试、组合、Discover 市场、Cordis inventory | `dsh-plugin-manager`、`dsh-client-ui-plugin-manager`、`dsh-plugin-market` |
| 主题、字号与字体三角色（text/code/terminal）、token 覆盖 | `dsh-client-ui-theme` |
| 会话级模型选择与默认模型 | `dsh-client-ui-model-selection`、`dsh-agent-default-model` |
| 子代理的 provider/model/reasoning effort 选择与允许路由策略 | `dsh-tool-subagent`（`DelegationModelRequest`、`model-selection-settings`） |
| 命令面板与快捷键 | `dsh-client-ui-commands`、`dsh-client-shortcuts` |
| 会话搜索与会话标题 | `dsh-tool-session-query`、`dsh-session-title` |
| 计划模式、目标、压缩、审批、沙箱与权限预设 | `dsh-plan-mode`、`dsh-goal`、`dsh-compaction-basic`、`dsh-user-approval`、`dsh-permission-presets` |
| MCP 客户端与其资源 | `dsh-mcp-client`、`dsh-mcp-resources` |
| 会话工作目录读取与变更 | `dsh-working-directory`、`dsh-tool-working-directory` |

## 归原生且插件只做薄壳

这些域里插件拥有的是产品面，不是机制面；机制一旦被复制就是缺陷。

| 能力 | 原生原语 | 插件应残留的部分 |
| --- | --- | --- |
| 右栏自有页签 | `sidebar.right.pane.tab` 槽 + tab 类型注册表 | 只注册类型与 body，布局与 More 菜单归原生 |
| 飞书与通知的设置页 | `settings.plugins.tab` 槽 + `SettingsFormModel` | 只声明表单内容，页面壳与导航归原生 |
| 自动化任务运行目标 | `ctx.schedule` 的 `create/list/update/delete/history` | 只补「每次新运行一条新会话」的副本轮转，不得复制调度引擎 |
| 分支目录到工作区 | `ctx.workspaceRegistry` 的 `create/list/delete` | 只维护 lane 与 workspace 行的生命周期，不得自建工作区注册表 |
| 远端页面「拥有 Host」声明 | `--trusted-host` / `--public-url` 与原生 Host 归属判定 | 只补原生未覆盖的 Web 部署声明通道 |
| 运行结束事件 | `session/event`、`turn/end`、`agent/status` | 只做聚合与推送，不落会话正文的副本 |

## 插件独占

原生在这些域里没有实现，也没有等价 seam；它们可以被自由设计，且不应为了「用原生」而削掉。

| 能力 | 插件实现 | 规模 | 原生最近邻（不等价） |
| --- | --- | --- | --- |
| 分支目录（lane）生命周期：建、复用已有分支、绑定会话、chip 与菜单、建 PR、合并探测、删除与清理、工作区注册与回收 | `host/services/worktree`、`client/conversation/worktree` | 约 5,800 行 | `dsh-experimental-worktree` 只在 Agent 内部新建分支并切 cwd，无 UI、无删除、无 PR、未挂载 |
| Git 工作台：status、stage、commit、建分支、图谱、逐文件 diff、revert、cherry-pick | `host/services/git-graph`、`client/sidebar/git-workbench.tsx` | 约 2,900 行 | 306 个包中没有任何 git 面板 |
| 远端 SSH：主机库、known_hosts 与指纹钉、PTY、2FA、隧道、传输、集群执行、agent 工具 | `host/services/ssh` | 2,039 行 | `dsh-api-terminal-controller` 只有单一本机 shell profile |
| 按会话隔离的 agent 浏览器（Playwright/CDP/扩展租约、mcp__playwright__ 工具面） | `host/services/playwright-sessions` | 1,182 行 | `dsh-mcp-client` 只能挂静态 MCP，无法按会话拉起与回收 |
| 自动化任务的「每次新会话」运行目标 | `host/services/schedule-mode` | 1,562 行 | 原生把投递冻结为 `ScheduleDeliveryMode = 'host'`，投递永不离开所属会话 |
| 运行结束通知：feed、跨端徽章、飞书推送 | `host/services/notify` | 832 行 + 客户端 92 行 | 无通知包；`dsh-jobs` 只做会话内通知 |
| 飞书 bot 入站收件箱与 peek/pop/ack 工具 | `host/services/lark-inbox` | 992 行 | 无 IM 入站 seam |
| 浏览器渲染的 web_fetch provider | `host/services/web-render` | 529 行 | 原生只有 `dsh-web-fetch-http`，无 JS 渲染 |
| 只回 citation 的 search provider | `host/services/web-search-anthropic` | 637 行 | `dsh-web-search-deepseek` 在缺 `web_search_tool_result` 时直接报错，属判据 4 的暂存 workaround |
| 项目持久记忆面板与记录工具 | `host/services/memoir` | 834 行 | `dsh-agent-instructions` 只读 AGENTS.md 链，无写入口 |
| 宿主访问围栏与远端鉴权墙 | `host/services/access-trust`、`remote-access`、`remote-web-ui`、`no-browser-auth` | 4,830 行 | 原生围栏只覆盖 `/api` 与 WS upgrade，账号体系不存在 |
| code-vibe 预设（persona、分档流程、技能清单） | `presets/code-vibe.patch.yml` | 488 行 | 机制全为原生插件行，内容是唯一第一方价值 |

## 待实测的替代路径

`host/services/codex-bridge`（1,367 行）把 Codex 登录换成 OpenAI 兼容路由。原生 `dsh-llm-pi-ai` 已内置 `openai-codex` 路由与 ChatGPT OAuth 登录流程，覆盖了认证与路由两侧；本域仅剩「目录里比编译期快照更新的模型名」这一项差异。替代前必须先在一次真实调用中证明原生路由可用，未取证前不得按「原生已有」下架。

## 维护

每次 SDK cohort 升级后重跑三条只读检查，确认没有新挂载的原生能力与本表冲突，也没有把暂存的 workaround 当成能力保留：读两个 bundle 的 insert 行、读 306 个包的 description、对本表逐行复核。新增插件能力前先读本表；判据 1 或 2 命中却仍在插件里新建机制，应当在评审中驳回。