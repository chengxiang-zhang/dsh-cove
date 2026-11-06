# 内置插件使用说明

本文说明这台 DSH Web 里「设置 → 内置插件」列出的那些东西分别是什么、在什么地方用、怎么开关，以及哪些行不要碰。

面向人群是每天用 Web GUI 或让 agent 干活的操作者，不是插件作者；插件怎么开发见 [plugins.md](plugins.md)。

第一方能力（飞书接入、运行结束通知、Git 与 GitHub、SSH 远端、Playwright 浏览器、分支目录）的完整用法在 [packages/dsh-web-all/README.zh.md](../packages/dsh-web-all/README.zh.md)，本文不重复，只写 DSH 原生插件。

## 一句话模型

**一行插件决定「有没有这个能力」，一个 Agent 预设决定「这次会话能不能用它」。** 列表里看到停用，多数时候不是坏了，而是那类能力由预设按会话发放。

## 三个概念

### 插件行与包

插件列表里的每一个条目是一行，由 `id`（稳定标识，补丁和报错都用它）、包名（卡片上的「完整名称」）和可选的 `config` 组成。一个包可以提供多行：`@deepseek-ai/dsh-tool-subagent` 同时提供子代理的调用工具和 fork 工具，`@deepseek-ai/dsh-mcp-client` 每接入一个 MCP 服务器就是一行。

排查问题时先确认是行的问题还是包的问题：整行不见了通常是补丁没打上，整包起不来是安装或版本问题，卡片会写「加载失败」或「包元信息错误」。

### 两个平面：全局平面与 Agent 预设

**全局平面**由 profile 的 bundle（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@dsh-cove/dsh-web-all`）加上补丁层组成，一次装配、所有会话共享，界面外壳、宿主服务、存储、模型路由都在这里。

**Agent 预设**决定一条会话挂哪一套工具和提示词，预设自己带一组行，只对挂着它的会话生效。插件列表页把两者分开列：上面是会话插件（各 Agent 预设的组合），下面折起来的是全局插件。

所以卡片上写「全局已停用，由 Agent 预设按会话提供」是正常状态。典型例子是工具面的行：`tool-bash`、`tool-fs`、`tool-web`、`tool-todo`、`tool-skill`、`tool-subagent`、`plan-mode`、`compaction-basic` 在全局平面都是停用，由预设发给会话。判定依据是 Agent 预设的组合列表，不是全局那一栏。

反向也成立：全局开着的行可能在某个预设里被单独置成停用，判断依据同样是该预设的组合。

还有一个容易读错的地方：`disabled` 可以是表达式而不是布尔值。`settings`、`config-editor`、`plugin-manager`、`hmr`、`plugin-market` 的停用条件都是「启动器没有提供 profileContext」，而 `dsh web` 提供了，所以它们实际是启用的；`bash-sandbox` 的停用条件是「平台是 Windows」，在 macOS 上它实际是启用的。**判断是否生效要看插件列表页（它显示求值后的生效状态），不要看配置文件里的字面量。**

要改「会话里能用什么工具」，改的是预设组合；要改「界面和服务长什么样」，改的是全局平面。这两件事的补丁位置不同，不要混。

当前 profile 的默认预设由 `agent-preset-registry` 的 `default` 配置给出，取值是 `standard`；另外装了 `ptc`、`minimal`、`cordis` 和本仓的 `code-vibe`。

### 三种配置载体

**生成的解析结果**是 profile 目录下的 `cordis.yml`，不要手改。它的内容就是一行注释加空列表，文件里的原话是「Edit cordis.patch.yml, not this file.」；profile 每次启动都会把它重写回来，而运行时 Loader 在插件自行卸载时会把当前装配树写回去，所以磁盘上那份带几百行的 `cordis.yml` 是写回的产物，不是输入。

**权威输入**是 profile 目录下的 `cordis.patch.yml`。装配优先级从低到高是：bundle 自带的补丁、profile 的 `cordis.patch.yml`、`$DSH_HOME/cordis.patch.yml`（本机没有这一层）、命令行 `--patch` 覆盖。同一行被多层写到时，最后一次写入获胜。

**GUI 写的也是补丁层**，见[操作手册](#操作手册)。

## 查当前装了什么

### 设置 → 内置插件 → 插件列表

只读清单。上半部分是各 Agent 预设的组合，默认展开；下半部分是全局插件，默认收起；搜索会同时展开两边。

这一页由 `ui-settings-plugins`（设置里的导航与标签外壳）和 `ui-settings-plugin-inventory`（清单页）渲染，数据来自只读的 `plugin-inventory` 行；它读的是 Loader 的实际装配结果，所以显示的是求值后的生效状态，而不是配置文件里的字面量。

字段含义：「已启用」是当前生效，「已停用」是该行被停用，「条件启用」是按表达式决定（例如只在 macOS 上启用、只在 desktop profile 启用），「来自」说明这行由哪个 bundle 或预设带来，「完整名称」是 npm 包名。一行显示多个来源时，说明多个预设都带了这一行。

这一页**不改配置**：卡片没有开关，安装因 pnpm 构建脚本被拦时才有「允许这些脚本并重试」。要改配置去侧栏的插件页。

### 侧栏 → 插件

日常管理入口，分「已安装」与「发现」两个视图，另有「内置插件配置」（官方插件自己的设置页，如终端、子智能体、网页搜索、Agent 循环）与「实验性插件」加一个「更多」独立页。

「发现」是插件市场，没配置索引源时是空的，提示「还没有插件市场」。它需要你加一个索引文件的 URL 才会列出条目，不内置任何索引。

### 命令行

`dsh plugin --profile web add <包名>` 与 `remove <包名>` 是安装和卸载 profile 插件的入口，参数原样转给 pnpm，语义见[插件管理与扩展](#插件管理与扩展)。

`dsh --profile web --dump-config` 打印装配后的配置。注意它同时会重写 profile 的 `cordis.yml`；那是生成物，但没必要在运行中的机器上频繁跑。

## 按用途找能力

| 我想 | 章节 |
| --- | --- |
| 让 agent 少走弯路、上下文不被撑爆 | [对话、上下文与回合控制](#对话上下文与回合控制) |
| 用终端、看文件、预览文档、看交付 | [界面与工作区](#界面与工作区) |
| 让 agent 跑命令、改文件、查网页 | [工具面](#工具面) |
| 开子代理、开团队、跑工作流 | [子代理与编排](#子代理与编排) |
| 换模型、加模型路由、管凭据 | [设置、模型与凭据](#设置模型与凭据) |
| 装插件、停插件、接 MCP | [插件管理与扩展](#插件管理与扩展) |
| 定时任务、后台任务 | [自动化与后台任务](#自动化与后台任务) |
| 会话日志、搜索、遥测 | [会话日志、搜索与观测](#会话日志搜索与观测) |
| 插件列表里看不懂的行 | [平台骨架](#平台骨架不要动的行) 与 [附录](#附录看懂一行插件的命名与来源) |
| 改了配置不生效 | [操作手册](#操作手册) |

## 对话、上下文与回合控制

这一组决定「一轮对话怎么走、上下文怎么省、人怎么插话」。本章最容易误判的一点：部分行在全局平面是停用，但由 Agent 预设按会话挂载，标准会话里能力仍在。本章逐条标注了属于哪种情况。

### 目标

`/goal` 命令（`command-goal`，预设挂载）、输入框上方的目标栏（`ui-goal`）和 agent 侧工具（`tool-goal`，预设挂载）是同一份状态：每个会话最多一个长期目标，状态跨回合、会话恢复、分支和进程重启都保留。

- 用法：`/goal` 查看当前目标与轮次进度；`/goal <目标>` 新建并武装；`/goal edit|pause|resume|clear` 分别改、暂停、继续、清除。目标栏在会话有目标时出现，提供暂停、继续、编辑、清除按钮。
- agent 侧：`get_goal` 拿 id 与 revision，`update_goal` 带同一组 id/revision 修改，陈旧版本会被拒。新建与修改必须由人在回合里直接要求；完成和受阻也可以由自主目标轮做，受阻要连续 3 轮同样条件（`blockedAfterConsecutiveRounds`，默认 3）。
- 自动续跑（`goal-round-driver`）：目标 active、已武装、agent 空闲且有轮次余量时自动发「继续推进」，每轮消耗一次配额；配额用完记为 `round-limit` 受阻。会话恢复或分支后不会自动续跑，要显式 resume。
- 关闭：停用 `goal` 会同时失去目标栏与命令；停用 `goal-round-driver` 只是不再自动推进，需要人工催。

### 计划模式

`/plan` 进入（`plan-mode`，预设挂载），也可以 `/plan <一句话>` 带指令进入。agent 先探查和设计，再调用 `exit_plan_mode` 把方案交给你审阅：Approve 才开始实现，Keep planning 退回修改。退出还可以点输入框右侧的「计划」按钮或 `/plan off`。

- 计划文档（`ui-plan`）：提交的计划在回合结束后以文件卡出现在产物区，点开在右栏看 Markdown；待审阅的计划会自动打开一次。
- 注意：计划模式本身**不限制**工具调用，要硬性限制得另外配沙箱和审批。
- 关闭：`plan-mode` 在 minimal 预设里没有；`ui-plan` 停用后仍能用 `/plan` 进出，但没有状态按钮和预览。

### 待办清单

`tool-todo`（预设挂载）让 agent 用 `todo_write` 维护任务清单，每次提交整张清单（不是单条改），条目只有 pending / in_progress / completed 三态，跨回合与重开会话保留。

- 配置：`allowParallelInProgress` 为 true 时允许多条同时进行（本 profile 已设 true）。
- 关闭：agent 没有显式清单，长任务进度只能从对话正文里看。

### 上下文压缩

四行各管一段，`compaction-basic` 与 `command-compact` 由标准、ptc、minimal 预设挂载，`tool-result-pruner` 由标准与 ptc 挂载：

- 自动压缩（`compaction-basic`）：上下文逼近模型上限时，把最旧历史换成一条摘要、最近一段保留原文，对话从摘要继续；遇到确认的上下溢出错误会压缩后重试。关键配置 `thresholdRatio`（0.8）、`headroomTokens`（65536）、`retainRatio`（0.16）、`auto`（true）、`compactionRetries`、`maxOverflowRetries`，以及按模型路由覆盖的 `modelPolicies`。设 `auto: false` 只保留手动压缩。
- 手动压缩（`/compact`）：不必等阈值，立即压一次，结束会告诉你压掉多少条历史、省了多少 token。agent 正在回合中或有压缩在跑时不可用，期间你发的消息会排队。
- 工具结果裁剪（`tool-result-pruner`）：只在压缩被触发后生效，超预算工具结果换成「保留开头 + 裁剪标记 + 保留结尾」，完整原文仍在会话日志里。配置 `thresholdChars` 8192、`headChars` 4096、`tailChars` 1024。
- 图片降级（`image-offload`）：图片超出模型路由预算时，把较旧的图片永久换成「附件名 + 只读路径」文字占位后重试，不消耗 provider 重试预算。关掉后超预算会直接以 `IMAGE_OFFLOAD_REQUIRED` 失败。

### 技能

三层配合：`skill` 是注册表，`skill-filesystem` 负责从磁盘发现（预设挂载），`tool-skill` 给 agent 加载工具（预设挂载），`ui-skill` 提供输入框建议与卡片。

- 放技能：在项目 `.dsh/skills/<名>/SKILL.md`、项目 `.agents/skills/`、自定义目录、`~/.dsh/skills`、`~/.agents/skills` 任一处，带 YAML 头（`name` 与 `description` 必填）；根目录平铺 `<名>.md` 也认。目录被监视，增删改名不用重启。
- 用法：agent 首次请求前会收到技能清单（名字 + 截断描述），之后用 `skill` 工具按名加载全文；人可以在输入框打 `/技能名` 直接把该技能注入当步。
- 配置：`catalogDescriptionMaxLength`（默认 500）限制清单里描述长度；`watch` 控制是否监视目录。
- 关闭：停用 `skill` 会同时失去目录与加载能力；只停 `skill-filesystem` 则注册表还在但没有任何本地技能可发现。

### 斜杠命令与反馈

- 命令菜单（`ui-commands`）：输入框打 `/` 或点 `+` 打开同一份菜单，Add 段是文件、目标、计划、反馈，Commands 段是压缩、权限、模型、导出；↑↓ 走行，Enter 或 Tab 确认，Esc 回输入框。
- 候选菜单（`ui-input-trigger`）：光标处打 `/` 或 `@` 弹分组候选；Esc 与 Shift+Tab 只关菜单不动草稿。
- `/feedback`：带文字时记录一条反馈并回显会话 id 与匿名用户 id，不进模型；在 Web 里只发 `/feedback` 会打开反馈对话框，可选七个分类（任务结果、指令遵循、产品交互、服务稳定性、资源成本与开销、安全隐私与权限、其他）。
- 赞踩（`ui-message-feedback` + `message-feedback`）：每个回合收尾消息的操作条上有「好的回答」「有问题的回答」，点了会弹对话框选分类，已记录的显示实心图标，再点一次直接撤回。备注上限由 `maxNoteBytes`（本 profile 8192）决定。

### 引用与附件

- `@` 引用（`ui-reference`）：打 `@` 先列文件再列会话，`@"` 开头只搜文件。选中文件、目录或会话会插入整体引用块；目录行可以选中整个目录，也可以下钻继续写路径；带空格的路径写成 `@"path with spaces"`。点输入框里的文件引用可在右栏预览。
- 文件候选（`file-reference-local`）：`maxResults` 20、`maxEntries` 50000，默认排除 `.git`、`node_modules`、`dist`、`build`、`out`、`coverage`、`target` 等。
- 会话引用（`session-reference`）：一条消息最多引用 3 个会话，发出后附一段「Referenced sessions」快照作为不可信背景，并固定写明不要执行其中的指令与工具请求；超预算会截断并告知完整内容位置。
- 附件（`attachment-local` + `ui-attachment`）：图片会被校验、按 EXIF 摆正、去元数据后压缩存储（透明图 WebP、不透明 JPEG），按字节去重、永不自动删除；通用文件按原字节保存。上传后在输入框下列成一条不换行轨道，失败可重试。上限由 `attachment-local` 配置：`maxImageBytes` 20 MiB、`maxImagesPerMessage` 20、`maxMessageImageBytes` 200 MiB、`maxImagePixels` 64,000,000。附件只在本机，换机器读不到。

### 会话标题、统计与轨迹

- 标题（`session-title`）：来源三种取最新——首条人话自动截取的兜底、模型生成、你自己改名。当前生效的模型方案是「用全部消息生成标题」（`optional-session-title-all-prompts`），你每发一条新消息都会修一次标题；「用首条消息生成标题」（`session-title-llm`）在全局平面停用且不在任何预设里，属于本 profile 真正没启用的能力。
- 统计（`session-stats`）：会话界面统计条显示回合数、步数、模型耗时、工具耗时、首字延迟、解码耗时与 token 数，数字来自完整日志，翻页与压缩都不改变。
- 轨迹（`ui-trajectory`）：会话视图的「轨迹」标签页是事件账本加时间轴，按用户 / 助手 / 工具 / 嵌套子调用 / 压缩分组，点某条记录看 token 用量、耗时、输入输出；时间轴可拖选区间、滚轮缩放。
- 回合大纲（`session-turn-outline`）：给整个会话每个回合的目录（回合号、提示预览、已结算回答预览），可以跳到还没加载的回合，也可以按事件序号往回翻页把该回合载进来。不装它时只能在已加载的历史里翻。

### 回合运行底座

这一组不是给人点的功能，但它们决定上面所有能力能不能用。表格里的行都常开；`spill-policy` 是唯一一个靠配置项留白的。

| 行 | 做什么 | 关掉之后 |
| --- | --- | --- |
| `agent-loop` | 驱动一个回合：发模型请求、接流式回复、执行工具、把事实写进历史，再进下一步 | 没有任何 agent 能跑起来 |
| `system-prompt` | 把所有贡献按顺序拼成系统提示，决定工具排列顺序 | 人格、运行时上下文与工具说明全部消失 |
| `tools` | 工具注册、参数校验、执行与结果返回；`mode` 决定原生函数调用还是 `run_code` | 没有任何工具能被注册或调用 |
| `token-meter` | 重放会话日志算出用量与上下文压力 | 自动压缩失去依据，界面拿不到占用率 |
| `timeout-policy` | 给配了时限的工具到点发取消，模型收到 `Error: tool call timed out` | 慢工具会一直占着直到自己返回 |
| `spill-local` | 超长文本落到会话私有文件，返回路径让模型自己读；默认按天清理（30 天） | 超长结果只能内联 |
| `spill-policy` | 超预算工具结果保留首尾、中间省略并给出文件路径，`maxInlineTokens` 本 profile 为 12500 | 超长结果整段进上下文，很快吃满窗口 |
| `fs-observation-policy` | 先读后改：没读过的文件拒绝覆盖，读过又被改动时返回 `FS_STALE_VERSION` | agent 可直接覆盖任何文件，静默盖掉你刚手改的内容 |
| `session-checkpoint-policy` | 模型请求前、工具副作用前、下一步前强制落盘 | 会话仍持久化，但崩溃可能丢一个批次窗口 |
| `repeat-tool-reminder` | 同样参数第 3、5、8 次重复调用时给模型提醒（不拦不停） | agent 陷入重复循环时无提示 |

### 凭据自动打码

`ui-secret-mask` 只改显示：识别出的 key、token、密码在消息气泡、排队回显里只画前 8 位，其余是 `*`；可交互的消息末尾有眼睛按钮临时看真值，重开回到打码状态。原文、复制内容、发给模型的内容都不变。停用后截图或共享屏幕会直接泄露你粘贴的密钥。

## 界面与工作区

这一组是你在 DSH Web 里看得见的那一层。先把三件容易搞错的事说清楚：

- 设置窗口的左侧分区是五个：**通用设置、模型、内置插件、Agent 预设、账号与余额**。外观、语言、字号字体、快捷键、权限、工作步骤展示、性能与用量、网页链接打开方式、繁忙时的发送行为，都是「通用设置」里的**行**，不是独立分区。
- 「设置 → 内置插件」只有一个标签页「**插件列表**」，它是**只读**的：卡片只有状态标签（已启用、已停用、条件启用、预设中启用、启动失败），点开只是详情，没有开关。要停用某行必须改 profile 配置，见[操作手册](#操作手册)。
- 右侧面板的入口是会话头部角落的按钮；展开后先是「开始」引导页，卡片就是文件、浏览器、终端这几个页签的入口。

### 三栏外壳与左栏

`ui-layout` 提供三列外壳：拖动列边界调宽，侧栏 264～420px、收起后留 56px 控制栏，右栏首次打开占视口 45%、之后记住拖出来的宽度（上限 70%）；窗口窄于 1024px 时侧栏自动收起，打开右栏也会顺手收起手动展开的侧栏。`Mod+B` 展开/收起左栏。

`ui-sidebar` 提供左栏外壳（新建会话、折叠、底部设置入口、「全局面板」导航区与「更多」菜单），`ui-workspace` 填充里面的工作区与会话树：会话按工作区分组，「视图选项」可切分组方式（按工作区 / 按工作区树 / 单列表）、排序（手动 / 最近更新）、筛选（隐藏已归档 / 全部 / 仅归档）；搜索框按会话名搜；「展开其余 N 个会话」逐批展开；拖拽可置顶和手动排序；「添加工作区」注册新工作区。历史会话无标题显示「未命名」，当前空会话显示「新会话」。

### 右侧面板与四个页签

`ui-sidebar-right` 是停靠面板：页签条由左到右是页签胶囊、「新标签页」、分栏控件、全屏与收起控件；分栏最多两格、分隔条限制在 20%～80%，宽度不够会提示「栏宽不足，拖宽侧边栏后再分栏」；窗口窄于 768px 时打开右栏自动全屏。布局是瞬时状态，刷新后右栏默认收起。

- **文件**（`ui-sidebar-files`）：从开始页的「工作区文件」卡片或「新标签页 → 文件」进入，逐级点目录浏览会话工作区，点文件即在右栏打开；有「自动刷新」开关，空目录显示「空目录」，出错给「重新读取」。工作区外目录不会被读取。
- **文档预览**（`ui-sidebar-documentpreview` + `office-to-pdf`）：Office 文档、表格、Markdown、代码、图片、PDF、HTML、纯文本都能预览，Office 先转 PDF 所以两行要一起；表格预览带格式、合并、公式、筛选、冻结等编辑工具条。
- **终端**（`ui-sidebar-terminal`）：点「新建终端」或开始页终端卡片进入，默认打开上次选的 Shell，标题旁箭头可换 Shell；终端在会话当前工作目录里运行，页签可改名；刷新页面后原页签重连，进程还在就继续，进程没了给「新建终端」。折叠、切页签、切会话、全屏都不打断进程；关闭页签会在后台结束进程。终端字号与字体在「设置 → 通用设置」里。
- **浏览器**（`ui-sidebar-browser`）：**在本 profile 是条件启用**——它的停用条件是「profile 不叫 desktop」，所以 Web 上看不到这个页签，desktop 上才有。它是内嵌浏览器，地址栏只支持 HTTP(S)，可恢复「上次打开」，页签菜单里有「关闭沙箱限制 / 恢复沙箱限制」（会显示风险提示）。本地文件请走文档预览。

### 会话界面与输入框

`ui-conversation` 拥有消息流、输入框、消息队列和视图导航；新会话页输入框占位是「描述你想要构建的内容, / 调用指令, @ 文件或对话」。`ui-chat` 与 `ui-tool` 负责消息渲染与工具调用卡片：卡片运行时显示「正在运行命令」这类步骤文案，结束后变成「已读取文件」，文件路径可点开右栏，非零退出的前台命令会显示带红点的退出码胶囊。

输入框的几个约定：`/` 打开命令菜单，`@` 打开引用菜单；拖入文件或图片加附件（目录仅桌面端）；发送按钮在 agent 运行时变成停止；繁忙时按 Enter 走「繁忙时的发送行为」（排队发送 / 插话发送），`Cmd/Ctrl+Enter` 走另一种。

### 审批与权限

- 审批卡（`ui-approval`）：需要一次性授权时临时接管输入框位置，你选允许或拒绝。默认 fail-closed，没有答复不会放行。
- 权限模式（`ui-permission`）：当前会话的切换控件在输入框上，裸 `/permission` 打开选择器，新会话默认值在「设置 → 通用设置 → 权限」。本 profile 定义三档：「仅可查看」「工作区内修改」「完全权限」；选「完全权限」会先弹风险确认，需要勾选才能继续。另有一个带实验标记的「自动审查」，只对当前会话可选、不出现在设置里：它不用沙箱，每次调用前由同一模型审查，可能误放行并额外消耗 token。注意设置里那一行只影响**之后新建**的会话，不改当前会话，也不改你自己现在这条会话的权限。

### 后台任务与自动化任务

- 后台任务（`ui-jobs`）：只有当前会话出现过后台任务时，会话头部才显示「N 个后台任务运行中」，展开可看实时输出；停止要两次点击（首击武装，三秒内再点确认）。普通对话看不到这个入口。
- 自动化任务（`ui-schedule`）：入口在左栏「自动化任务」（打开全局页面，不激活任何会话）和会话头部右侧的时钟按钮。**页面本身没有创建表单**：点顶部「新建」会开一个新会话，由模型在那个会话里创建提醒，所以创建时说人话即可。列表可搜索，可按「全部 / 已开启 / 未运行」筛选；点进任务有「规则」和「任务运行记录」两个页签，规则里改名称、指令、运行时间，重复可选每周、周一至周五、每天、每 N 小时/分钟/秒、仅一次、自定义 cron，时区是可搜索菜单。会话头部只有在当前会话确实有活动提醒时才显示时钟按钮。

### 工作流、动态插件与交付

- 工作流运行（`ui-workflow-run`）：工作流工具发起的顶层运行显示为独立节点，可展开看阶段、再展开看成员，成员能点开对应子会话。
- 动态插件（`ui-cordis`）：`cordis_define` 一类工具调用会显示为「注册 Cordis 插件」「运行 / 更新 / 停止 / 移除」卡片，按状态给运行、停止、移除、重试、回退按钮；需要授权时有「允许」「仅允许此版本」「允许此插件的后续版本」「拒绝」。运行控制面板在左下角、设置按钮上方。
- 改动与交付（`ui-deliverables` + `workspace-changes`）：一轮回答结束后出现「已编辑 N 个文件」卡片，点「在侧边栏查看本轮改动」进入逐文件对比（可切左右对比 / 单栏对比、开自动换行、按文件选）；模型用 `present` 声明交付时出现「交付文件」卡片，点卡片在右栏预览，旁边控件可用系统应用打开或定位文件。

### 工作区、会话目录与目录选择

- 工作区（`workspace`）：工作区要先注册才能被选中，入口是左栏「添加工作区」或新会话页的工作区选择器。删除父工作区后子工作区仍保留，并归到下一个已注册的祖先下。
- 会话目录（`working-directory` 与 `tool-working-directory`）：每个会话有当前目录，刷新与恢复后保留，右栏的终端与文件页签都跟随它；当前目录消失时会尽量恢复到原始项目。agent 用 `working_directory` 工具读取或切换（`cd` 相对当前目录解析、返回绝对路径）。
- 目录选择（`directory-picker`、`directory-picker-browse`、`directory-picker-browse-surface`）：添加工作区时弹出的选择框。能看见宿主屏幕且原生后端可服务时用系统对话框，其余情形用应用内浏览：路径面包屑与可编辑路径、逐级点进、末列可用前缀过滤、「新建文件夹」选中刚建的那个、「打开」采纳选中项或当前层级、关闭即取消。本 profile 的自适应行停用，直接用应用内浏览。

文件上传（`file-upload`）是输入框加文件与拖拽的传输层，按会话隔离、可在浏览器里取消；界面里「把某个地址读成文件内容」的能力（文档预览、图片、代码块）走 `resources`。两者都没有可操作界面。

### 外观、语言与快捷键

- 外观与字号字体（`ui-theme`）在「设置 → 通用设置 → 外观」：浅色 / 深色 / 跟随系统；字号分会话内容、代码、终端三项各自可增减；字体分正文字体、代码字体、终端字体，逗号分隔，留空用默认，更细的在「更多字体设置」里。
- 语言（`locale`）在「设置 → 通用设置 → 语言」：选一种已注册语言即时切换；没有显式偏好时按系统语言自动选，匹配不到回退英文。
- 快捷键：`Mod+/` 打开速查弹窗，等价入口是「设置 → 通用设置 → 编辑快捷键」。弹窗里按操作名搜索，点行内录键、松开即保存，Esc 退出录键，Tab 切行，底部有「恢复全部默认」。录键必须带修饰键、最多两个非修饰键；浏览器或系统占用的组合可能送不到页面。Web 的存在当前站点的 `dsh.keybindings.v1`，Desktop 存在 `userData/keybindings.json`，改完 Web 刷新页面、Desktop 重启 Harness 才重读。

### 入口自定义与品牌

`entry-customization` 管三处「更多」：左栏导航入口下方的「更多」、会话视图标签之后的「更多会话视图」、右栏开始页卡片之后的「更多工具」。菜单里是「浏览更多插件」与「创建你的插件」，后者用创造模式开一个新会话并把创建请求写进草稿但不发送，你自己审阅后发。`ui-brand-official` 决定左栏显示官方标志还是鱼形标志加本地构建标签，由构建期变量 `DSH_CLIENT_BUILD_PROFILE=official` 决定，没有设置项。

### 模型与预置

- 模型设置（`ui-settings-models`）在「设置 → 模型」：按提供商一行排列，行上标「API 密钥已配置」或「API 密钥缺失」；「添加模型提供商」提供「第三方模型提供商」（内置目录里选 OpenAI、Anthropic、Kimi 等，填密钥即可）与「自定义模型 API」（连中转站或自部署服务，填地址、协议和模型）。模型行里可改上下文窗口、最大输出 token 与输入类型（文本 / 图片）。
- 模型选择（`ui-model-selection`）在输入框旁的模型位或 `/model`：上半「模型」列表、下半「推理等级」；目录超过四个模型时出现「搜索模型…」。模型或提供方被删时保留选择但不显示 ID。
- Agent 预设界面（`ui-agent-preset`）在三处：新任务页的预设选择、会话头部的预设标签（「本任务的 Agent 预设，在任务开始时确定」，开始后不能换）、「设置 → Agent 预设」。设置页分「内置」与「自定义」两组，每张卡有「查看配置」以只读 YAML 展示该预设挂的插件。

预设行（`preset-*`）与注册器（`agent-preset-registry`，`default: standard`）决定有哪些模式可选：

| 预设 | 模式 | 适合 |
| --- | --- | --- |
| `preset-standard` | 标准模式 | 大多数任务，按需用检索、编辑、终端等工具 |
| `preset-ptc` | PTC 模式 | 包含标准全部能力，适合批量调工具并做筛选、去重、统计、汇总 |
| `preset-minimal` | 极简模式 | 只用终端与图片读取，带上下文压缩，适合测基础表现 |
| `preset-cordis` | 创造模式 | 用对话定制 DSH：写插件、加功能、组合工具与提示词 |
| `preset-code-vibe` | 许愿式编程 | 按任务大小分档（T0 回答 / T1 修 / T2 改 / T3 agent loop / 调研 / 事故），本仓自加的自定义预设 |

内置预设不声明 `name`（复用内置文案），自定义预设声明了 `name` 就会被归到「自定义」组。关掉当前默认预设会导致「标准模式不可用」提示，要先改默认再关。

### 语音输入

`ui-voice-input` 是输入框工具栏里的麦克风：点麦克风、允许浏览器访问麦克风、说完点停止即转写，结果填进草稿可编辑再发；首次使用会弹安装引导，走「前往安装」进语音 Bundle 详情点「下载并准备」。浏览器麦克风需要 HTTPS 或环回地址，以及操作系统授权。

背后的三行分工：`speech-to-text` 是按名选识别器的服务（本部署 `defaultProvider` 为 `sensevoice-local`），`speech-to-text-sensevoice` 是本机 SenseVoice ONNX 识别器（首次准备会下载固定修订的模型、校验大小与 SHA-256），`api-speech-to-text` 是浏览器侧的转写接口。缓存完整时无需重新下载。

## 工具面

### 网页访问

`web` 是搜索与抓取的服务层，模型侧的 `web_search` / `web_fetch` 由 `tool-web` 提供（该工具的宿主行停用，由标准、ptc、cordis、许愿式编程四个预设挂载）。

- 怎么用：对 agent 说「搜一下 X 并给出来源链接」或「把这个 URL 的正文抓下来」。`web_search` 吃 1～4 条查询、重复只跑一次、多查询并发；`web_fetch` 吃单个 URL，HTML 转 markdown（含 GFM 表格），非 2xx 作为结果返回而不是报错。
- 后端：本 profile 把 `searchProvider` 钉成 `anthropic-messages`、`fetchProvider` 钉成 `browser`，两个 provider 都由本仓 [packages/dsh-web-all](../packages/dsh-web-all/README.zh.md) 注册（渲染式抓取与可接受仅 citation 响应的搜索）。官方的 `deepseek-official`（每次搜索等于一次模型轮次）与 `http`（只做 HTTP GET，SPA 拿不到内容）是备胎。改 pin 要两个键一起写——补丁整体替换 `config`，只写一个会静默丢掉另一个；pin 指向不存在的 provider 报 `WEB_PROVIDER_CONFIGURED_MISSING`，两个 provider 同时可用又不 pin 则报 `WEB_PROVIDER_AMBIGUOUS`。
- 设置页：「设置 → 内置插件 → 网页搜索」里可配端点、模型、密钥与每次搜索的服务端搜索次数上限；还有一个「启用新版 Web 搜索 API」开关（直连、每次搜索只发一次 HTTP、不占模型轮次），本 profile 没把它接到实际链路上。

### 沙箱与审批

这四层决定「agent 能碰什么、越界时问谁」。

- `sandbox` 是执行后端：macOS 走 Seatbelt、Linux 走 bwrap 或随包分发的 landlock-run、Windows 走 ACL 受限令牌。每次执行报告 `full` 或 `partial` 强制执行，`partial` 只能管辖子集（Windows ACL 档、旧 Landlock ABI），需要绝对边界时不能当完全隔离。
- `sandbox-policy` 是模式与工作区根的唯一归属点：`read-only` 任何位置都不可写，`workspace-write` 只能写工作区根加平台临时目录，`danger-full-access` 不限制。本 profile 默认取 `DSH_PERMISSION_MODE`，未设时 `workspace-write`。
- `bash-sandbox` / `fs-sandbox` 是消费方，macOS 上都在跑（`bash-sandbox` 的停用条件是 `process.platform === 'win32'`，别把它读成「已关闭」）。写入越界返回 `[sandbox: file access denied under <mode> mode]` 并给一次获批更宽档位的重试提示，读不受限。
- `approval` 决定怎么问：`ask` 策略暂停等一次一次性决定，`never` 策略在分发到人之前就确定性拒绝（CI 与无人值守模式），应答者缺失也算拒绝。**停掉它不等于「自动放行」**，反而让升权与敏感操作全部不可用。

想给 agent 更大权限就切权限模式（输入框旁的控件或 `/permission`），不要动这几行。

### 工具清单

工具行在宿主层基本都是停用、由预设挂载，所以「插件列表里看到 tool-bash 停用」不代表 bash 不可用。真正决定某个会话有没有某个工具的是预设组合。

| 工具 | 行 | 能做什么与怎么用 |
| --- | --- | --- |
| `bash` | `tool-bash` | 跑命令。前台结果带 `[exit code: N]`；`run_in_background` 需要 job 注册表在场；声明支持沙箱时模型可申请一次更宽档位并附理由 |
| `pwsh` | `tool-pwsh` | 只在 Windows 上出现（停用条件是 `process.platform !== 'win32'`） |
| `job_output` / `job_list` / `job_kill` | `tool-jobs` | 读、列、杀后台任务；任务自然完成会在会话内推一条通知，不必忙轮询 |
| `read` / `read_image` / `write` / `edit` | `tool-fs` | 文件读写；`read_image` 只在持久附件存储挂载时出现；先读后改由 `fs-observation-policy` 强制 |
| `glob` / `grep` | `tool-fs-search` | 文件发现与内容搜索，自带 ripgrep 二进制，不依赖系统 rg |
| `cordis_inspect_list` / `cordis_inspect_query` | `tool-cordis` | 检查运行中的 Loader entry 与 provider，只有创造模式预设挂了这一行 |

`tools` 行是这些工具的注册与执行管线，`mode` 决定模型看到「一堆独立工具」还是「只有 `run_code` 加一份 SDK」；本 profile 是 `native`，PTC 形态由 `preset-ptc` 自己切。

`shell-env` 每次 shell 调用都会注入受管的 `DSH_*` 变量（`DSH_HOME`、`DSH_SHELL`、`DSH_SESSION_ID`，带 profile 启动时还有 `DSH_PROFILE` 与 `DSH_PROFILE_DIR`），让 agent 在 shell 里能可靠定位 harness，而不是碰巧继承宿主环境。

## 子代理与编排

### 子代理

`subagent` 是委派服务的底座，两个进程内后端决定子代理怎么开始：

- **spawn**（`subagent-spawn-in-process`，工具 `subagent`）：子代理从空对话开始，继承父的工作目录、会话谱系、provider、模型与推理强度，能继续发消息、支持冷恢复，也能给子级换预设。工具调用立刻返回 `started subagent <childId>`，不阻塞父轮次。
- **fork**（`subagent-fork-in-process`，工具 `subagent_fork`）：子代理以父级**已完成**的轮次为初始内容，进行中的那一轮看不到，所以「接着刚才的分析往下做」不用重复交代上下文；这是一次性快照。

控制工具 `send_message`、`interrupt_agent`、`list_agents` 由 `tool-subagent-control`（含 `list-agents` 子行）提供：`send_message` 只返回受理、绝不返回回复；`interrupt_agent` 只停当前轮，已排队消息保留、后代继续；`list_agents` 默认只列直接子级，`descendants` 递归列。

限制在「设置 → 内置插件 → 子智能体」页：`maxDepth` 默认 1、`maxActiveSubagents` 默认 8，超额以 `ACTIVATION_LIMIT_REACHED` 拒绝（不排队，避免父等自己占的名额而死锁）。同一页还能配「子智能体可选模型」——只有开了 `modelSelectionSettings` 的委派工具才把 `provider` / `model` / `reasoning_effort` 暴露给模型；对应行是 `subagent-model-selection-settings`。

会话里的子代理导航由 `ui-subagent` 提供：在会话里列出子代理目录、进入它的可继续子会话，`@` 引用里也能选到子代理会话。

`subagent_cursor` 仍是 **one-shot**：只回最终答案，不能继续发消息、不能冷恢复、看不到中间过程。三个工具的前置条件逐个是：

| 工具 | 需要本机有什么 |
| --- | --- |
| `subagent_claude_code` | `~/.claude/settings.json` 与 Claude Code 原生登录可用；本能力固定 `--permission-mode auto` |
| `subagent_codex` | 本机原生 Codex 配置与登录；模型可当场选、默认 `gpt-6-astra`；新轮次带 `--approve-for-me`，续轮沿用该会话记录的策略 |
| `subagent_cursor` | `/Users/leo/.local/bin/cursor-agent` 存在且 `CURSOR_API_KEY` 有效；`permission: allow` 等于无人值守批准它每个权限请求（含写文件与执行 shell） |

`subagent_claude_code` 与 `subagent_codex` 由本仓 external-session 能力承担，直接起 `claude` / `codex` CLI：因此多一个可选 `session_id` 用于续同一段对话，并额外提供 `external_session_list` 与 `external_session_stop`；模型可以用调用参数 `model` 当场选，候选目录与默认档在实体行的 `config.externalSession.tools` 里配、逐个带说明，不给 `model` 时用默认档。工具由 `web-all` 这个 Loader 条目注册，所以每个预设（含许愿式编程）、每个会话都看得到；进程内的 `subagent` / `subagent_fork` 不受影响。细节与迁移见 [external-session.md](external-session.md)。

### Agent Teams

`agent-team` 服务持有 Lead 与具名 teammate 的 roster、peer 消息与共享任务板，`tool-agent-team` 提供九个模型工具（`spawn_teammate`、`send_message`、`list_agents`、`wait_agent`、`interrupt_agent`、`team_task_create`、`team_task_list`、`team_task_get`、`team_task_update`），`ui-agent-team` 提供会话页头的面板。

- 用法：对 Lead 说「创建一个叫 reviewer 的 teammate 检查 diff，再把变更摘要发给 reviewer」。只有 Lead 能 `spawn_teammate` 与 `interrupt_agent`；`fresh` 让成员不携带 Lead 对话，`fork` 让它继承 Lead 已完成轮次。
- 规则：成员名字永久占用，创建失败也保留；状态 `running` / `inactive` / `provisioning` / `failed` 里 `inactive` 只表示没有轮次在执行；任务板每次变更都是 compare-and-set，过期副本的更新会被拒；文件触及提示重叠只警告、不阻止。同一支团队共享一个工作目录。
- 限制：`maxMembers` 默认 16（本 profile 设 8）、`maxTasks` 256、`maxMessageBytes` 65536。
- 面板是只读的：任务只能由 agent 通过工具创建和修改，点成员行会打开它的普通可继续子会话。

### 工作流与 PTC

- `ptc-runtime` 执行模型写的 TypeScript，只有 `tools` 切到 `ptc` 形态（或预设设了 `tool-presentation`）时 `run_code` 才出现；默认每次调用起新 Node 进程、走与 bash 相同的沙箱策略。本 profile 是 `native`，所以关掉它没有任何感知。
- `workflow-ptc` 是 `workflow` 工具背后的引擎：把脚本跑在全新 Node 进程里，提供 `agent()`、`parallel()`、`pipeline()`、`phase()`、`log()` 五个钩子，`maxConcurrentAgents` 默认按 CPU 并行度解析。
- `workflow` 工具只在用户明确要求工作流或大规模多 agent 时才该用；一两项委派用普通子代理就够。调用要传 `meta`（`name`、`description`，可选 `whenToUse` 与 `phases`）、`script`（纯 JavaScript 脚本体）与可选 `args`；`run_in_background: true` 立刻返回 job id，取消走 `job_kill` 或列表里的停止控件。
- `ralph` 是「每轮起一个全新 agent 的迭代循环」，只接收目标与轮数，达到完成或阻塞报告即返回，且报告不做独立验证。本 profile 的组装树里没有 ralph 组，`tool-ralph` 只出现在许愿式编程预设里。

### 扩展与外部集成

- MCP 客户端（`mcp-datasage` 等）：每台服务器一行，`serverName` 唯一并成为工具前缀，工具名形如 `mcp__datasage__search_tables`。要加服务器就再加一行。`mcp-resources` 另外提供 `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource` 三个资源工具，与服务器自身的工具互不替代。
- OpenViking 记忆（`openviking-memory-runtime`）：会话开始自动召回相关记忆与技能，`viking://` 路径读写受守卫保护，工具前缀 `mcp__openviking__`。要对 agent 说「记住这件事」或「我们上次怎么定的」；停用后已写入的记忆不会被删除。
- Cordis 检查（`cordis-inspect-providers`）：只提供 Host 侧 provider，模型工具由创造模式预设的 `tool-cordis` 挂载，用于写插件或改组合时发现 provider 与查运行中的 Loader entry。

## 设置、模型与凭据

### 设置窗口与设置的分区

设置窗口由 `ui-settings-general` 提供外壳，左侧分区是五个：**通用设置、模型、内置插件、Agent 预设、账号与余额**。其余界面行都是往这五个分区里挂条目，不存在第六个分区。

- 通用设置里从上到下大致是：当前版本、显示代码工作视图、外观、语言、工作步骤展示、工作步骤收起时机、性能与用量、网页链接默认打开方式、繁忙时的发送行为、权限、编辑快捷键。其中「显示代码工作视图」是这一区唯一的独立开关。
- 「内置插件」只是一个外壳，标签页由别的插件注册：官方注册「插件列表」（只读），本仓注册「飞书」与「通知」两个配置页。

### 改设置时到底写了什么

界面上的保存链路是 `settings`（把插件声明为可在线编辑的字段投影成表单、做整份校验、带版本栅栏）→ `config-editor`（对账、持 profile 写锁、原子替换）→ 写进当前 profile 的 `cordis.patch.yml`。它会保留 YAML 注释与 `!!js` 表达式，遇到 `$DSH_HOME/cordis.patch.yml` 或 `--patch` 这类更高优先级的层覆盖时会拒绝写入而不是硬改。

因此三条边界要记住：只有插件自己声明为可在线编辑的字段能在界面上改；插入新行、写 `!!js`、改受保护的管理组件只能手改文件；界面只改当前 profile。

### 模型路由与凭据

界面上的模型设置页与模型选择器见[模型与预置](#模型与预置)，这一节只写它背后的路由与凭据。

- 路由层是 `llm` 加三个适配器：`llm-pi-ai`（本 profile 配了 `kaon-router` 一族自定义路由，密钥走 `KAON_ROUTER_API_KEY`）、`llm-deepseek`（官方 API Key 路由，本 profile 的 `baseURL` 指向 `https://datasage.flow.chat/hiopen/v1`）、`llm-deepseek-account`（登录态路由，用 `x-dsh-auth-token`，永不回退到 API Key）。给 GUI 用的适配器必须实现模型目录，否则选择器里没有模型可选。
- `llm-retry` 在「一步」的边界上重跑失败请求，策略写在每个适配器的 `retryPolicy`（默认 normal、5 次）。每次重试都是一次再次计费的调用。
- 凭据存在 `$DSH_HOME/.credentials.yaml`（`credentials` 行）。查找优先级固定：已存文件 > 启动环境变量 > 项目 `.env` > harness home 的 `.env`；新存的值立刻覆盖旧环境变量。设置页的密钥框永远显示空，只告诉你是否已配置。
- 设置 → 账号与余额（`ui-settings-account` + `deepseek-account` + `account-controller`）用系统浏览器走 PKCE 授权，退出登录会先提示可能打断正在使用该账号的任务。

## 插件管理与扩展

### 三个入口，能力不同

| 入口 | 能做什么 | 不能做什么 |
| --- | --- | --- |
| 侧栏 → 插件（`ui-plugin-manager` + `plugin-manager`） | 启停 bundle 与行、安装（先 inspect 规格）、流式看 pnpm 输出、取消、卸载、重试、批准被拦的构建脚本 | 停用管理组件自身、操作别的 profile、编辑 Agent 预设组合 |
| `dsh plugin --profile web <参数>` | 把参数原样转发给 profile 目录里的 pnpm | 没有 dsh 自己的 add/remove 动词 |
| 直接改 profile 文件 | 插行、写 `!!js`、改受保护组件、调 bundle 顺序 | 需要自己保证语法与优先级 |

`dsh plugin --profile web list` 实际执行的是 **pnpm list**，列的是 profile 依赖，不是插件清单；看清单要去侧栏插件页或「设置 → 内置插件 → 插件列表」。只有三个子命令是 dsh 自己的：`version-exemptions`、`allow-version`、`revoke-version`。

侧栏插件页的结构是：「已安装」（bundle 与行）、「内置插件配置」（官方插件的设置页，如终端、子智能体、网页搜索、Agent 循环）、「实验性插件」加一个「更多」独立页、以及「发现」市场。

`add` 成功后会把声明了 `dsh.bundle` 的新依赖追加到 `package.json` 的 `dsh.profile.bundles` **末尾**，这会改变配置优先级；不声明 bundle 的只当普通依赖并给一行 warning。

### GUI 停用与手改的等价性

GUI 的开关就是更新 profile `cordis.patch.yml` 里最后一条匹配该行 id 的覆盖里的 `disabled`，没有匹配就追加一条。差别有三点：GUI 会最小化记录（当这条覆盖只剩 `id` 和 `disabled`、而 bundle 层本来就等于目标状态时，它会把这条删掉），手改会永久留痕；GUI 不会替你写 `insert`、`config` 覆盖或 `!!js`；GUI 拒绝管理组件。

### Agent 侧的插件工具

`plugin_manager` 只在创造模式预设里默认开启，动作是 `list_plugins`、`list_bundles`、`set_plugin`、`set_bundle`、`install_bundle`、`remove_bundle`、`list_version_exemptions`、`set_version_exemption`，每次调用都需要 `danger-full-access` 或当次批准。想越过版本不兼容就用 `set_version_exemption`（要 `acceptRisk`），或命令行 `dsh plugin --profile web allow-version <包@版本> --dsh-version <精确版本> --accept-risk`，撤销用 `revoke-version`。豁免写在 profile 的 `compatibility.json`，不被依赖升级继承。

### 插件市场

「发现」页（`ui-plugin-market`）默认是空的：它需要你先加一个索引文件 URL（「添加索引源」），`plugin-market` 才会读那个索引并标注安装状态与兼容性。`setIndexes` 只接受已配置的地址，不会去抓任意 URL；默认 `indexes` 是空数组，所以不配就完全不发请求。安装最终仍走 Plugin Manager。

## 自动化与后台任务

- 自动化任务（`schedule` + `ui-schedule`）支持一次性、固定间隔、每日、每周、cron 五种墙钟提醒，到点作为后续消息投回原会话；Host 重启后任务还在，错过的重复任务只补最近一次；任务必须给非空 prompt、标题和且仅一个时间选择器，`daily` / `weekly` / `cron` 都要求显式 IANA 时区；投递要等会话确认 `session/flush` 才算成功。界面用法见[后台任务与自动化任务](#后台任务与自动化任务)。
- 后台任务（`jobs` + `ui-jobs`）是进程内的 job 注册表：长任务注册成后台 job，agent 用 `job_output` / `job_list` / `job_kill` 读写，界面在会话头部展示。并发上限 `maxConcurrentJobsPerOwner` 默认 10，输出环缓冲 `retainBytes` 默认 256 KiB。

## 会话日志、搜索与观测

- 会话上传开关（`session-log-deepseek` + `ui-settings-session-log`）在「设置 → 通用设置」里，开关直接改宿主的 `enabled`；关闭期间的事件在重新打开后会补传未确认的后缀。
- 导出（`session-log-download`）：会话头部更多操作里的「下载 Session 日志」和 `/export` 命令，把本会话、子会话与附件打成一个 zip。
- 全文搜索（`session-query-sqlite`）在本部署是**关闭**的：web bundle 把它覆盖成 `path: ':memory:'` + `openAt: never`，只保留继承的精确读取。想要跨会话全文搜索得改这一行的 `openAt`。
- 持久化与投影：`session-persistence-jsonl` 每会话一个追加式 JSONL 文件，`session-projection` 从日志派生待办、目标、统计等状态，`session-projection-cache` 按检查点加速冷会话读取（本 profile 每 200 个事件或 5 秒写一次）。日志永远是权威，缓存最多陈旧、不会超前。
- 遥测（`otel` + `session-telemetry-otel`）：默认 `FEEDBACK_ONLY`，只有你给出明确反馈后才上传该反馈之前的未上传日志；`DSH_TELEMETRY_DISABLED` 设成任何非空值（包括 `0`、`false`）会让整个进程退出上报。本地会话日志与导出不受影响。

## 平台骨架（不要动的行）

下面这些行是宿主骨架，停用它们不是「关掉一个功能」，而是拆掉会话、存储、路由或界面本身。正常情况下永远不要动。

| 行 | 是什么 | 停用后果 |
| --- | --- | --- |
| `session` | 事件溯源会话存储 | 会话不能创建，历史失去入口 |
| `session-persistence-jsonl` | 会话落盘（每会话一个 JSONL） | 重启后对话全部消失 |
| `session-projection`、`session-projection-cache` | 会话状态投影与冷读缓存 | 待办、目标、统计等界面状态失效 |
| `storage`、`storage-json`、`storage-domain` | 键值存储与域存储 | 设置、任务板、各类状态无法保存 |
| `llm`、`llm-pi-ai`、`llm-deepseek`、`llm-deepseek-account` | 模型服务与路由适配器 | 没有模型可用，或某些路由消失 |
| `credentials`、`authorization` | 凭据存储与授权流程 | 密钥解析与登录授权链断掉 |
| `typert`、`typert-loader`、`typert-gateway` | 宿主与浏览器的接口通道 | 界面所有后端调用失效 |
| `webserver`、`web-startup`、`web-runtime` | HTTP 服务与前端资源 | 页面打不开 |
| `connection`、`modules`、`client-hmr` | 浏览器侧连接与模块表 | 页面白屏或热更新失效 |
| `sandbox`、`fs-sandbox`、`subprocess`、`shell-env` | 沙箱、子进程与 shell 环境 | 工具无法执行命令，写入被拒绝 |
| `tools`、`agent-loop`、`system-prompt` | 工具注册表、回合循环、系统提示装配 | 会话完全不工作 |
| `settings`、`config-editor` | 设置表单投影与写回 | 所有设置页保存失败 |
| `plugin-manager` | 插件安装与启停 | 侧栏插件页与安装链失效（GUI 不允许停用它） |
| `api-remotes`、`remote-access`、各 `api-*` 控制器 | 界面与宿主之间的接口面 | 对应功能页报错 |
| `timer`、`jobs` | 定时器与后台任务注册 | 长任务与超时控制失效 |
| `working-directory`、`workspace` | 会话工作目录与工作区 | agent 不知道在哪干活 |

`deepseek-llm-api-extensions`、`session-log-deepseek`、`plugin-package-inventory-deepseek` 是发给官方 API 的附加请求字段，停用后对话仍可用，但会话日志上传与插件清单类诊断会退化。

## 操作手册

### 启用或停用一行

优先用侧栏插件页的开关，它写回的就是补丁层，并且会保持补丁只记录与 bundle 的差异。

要在补丁里手写，覆盖一行用 id 定位：

```yaml
- id: ui-sidebar-browser
  disabled: true
```

新增一行用 `insert`，自建 id 时不要与已有 id 重名：

```yaml
- insert:
    - id: my-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: my-server
        transport: streamable-http
        url: https://example.com/mcp
```

Agent 预设里的行在设置界面是只读的，要改预设组合得改预设文件本身，或者换一个预设。

### 改配置

三个地方各管一段，按「谁拥有这个配置」选：

- 界面行为与个人偏好（外观、语言、字号字体、快捷键、权限、工作步骤展示）走设置里的对应页面；
- 服务端行为与容量（心跳、超时、存储路径、provider 列表）走 profile 的 `cordis.patch.yml`；
- 一次性或实验性的覆盖走 `--patch` 传入的临时文件，不落盘到 profile。

两条必须记住的语义：

- **补丁替换整份 `config`，不是深合并。** 只改一个嵌套键，也要把同层其他键一起写全，否则它们会退回默认值；`searchProvider` 与 `fetchProvider` 就是同一个配置对象的两个键，改一个必须带另一个。
- **`cordis.patch.yml` 不能留空文件或只有注释**，那会让启动失败；要停用这一层就写 `[]`。

### 什么时候生效

这个 profile 由 `dsh web` 启动器拉起，启动器提供了 profileContext，因此 `hmr` 行是**启用**的。生效规则是：

- 改 `cordis.patch.yml`、`$DSH_HOME/cordis.patch.yml`，或改 `package.json` 里 `dsh.profile.bundles` 列表：HMR 串行重组后立即生效，**不需要重启**。写入有约 2 秒的写稳定窗口，保存后稍等一下再看结果。
- 改已装插件的源码或构建产物：`root` 是空列表，只监视配置不监视源码，所以需要重启。
- 只在依赖集合里加包、不动 bundles 顺序：不触发重组，新包等下一次重组或重启。

如果哪天把 `hmr` 停用了，规则就变成「手改补丁必须重启 DSH 进程」，插件管理的返回也会带 `restart-required`。

不要在会话正在跑的时候重启服务；需要重启才能生效的改动，把结论写进交付说明，由使用者自己选择时机。

### 版本不兼容的处理

DSH 在安装前会检查插件声明的 `engines.dsh` 与 peer 依赖，不满足直接拒绝，不会装上去再崩。确实需要越过时用版本豁免，把「包名@版本」映射到具体的 DSH 运行时版本，豁免写在 profile 的 `compatibility.json`，与依赖和补丁层无关，也不会被升级继承。

授予豁免要先明确风险：不兼容插件可能崩溃或丢数据。用 `plugin_manager` 工具的 `set_version_exemption`（需 `acceptRisk`），或 `dsh plugin --profile web allow-version <包@版本> --dsh-version <精确版本> --accept-risk`；撤销用 `revoke-version`，或在界面里关掉那条授权。

## 常见现象与自检

**插件列表里有一批工具行是停用的。** 正常。它们在 Agent 预设里，按会话提供，见[两个平面](#两个平面全局平面与-agent-预设)。

**某行看起来「配了」却是停用的。** 典型是 `session-title-llm`：配置值齐全，但该行停用且不在任何预设里，所以「用首条消息生成标题」这条路没有启用，实际生效的是「用全部消息生成标题」。

**卡片显示「条件启用」。** 这行由表达式控制，不满足条件时不加载，例如只在 Windows 或只在 desktop profile 生效。不是配置坏了。

**卡片显示「加载失败」或「包元信息错误」。** 包文件读不到或清单解析失败。先看是不是刚装了新版本，再看包是否真的装进 profile。

**改了补丁没反应。** 按顺序查：改的是不是 profile 目录下的 `cordis.patch.yml`（不是 `cordis.yml`）、`config` 是不是写成了完整对象、这一行有没有被更高优先级的层覆盖（`$DSH_HOME/cordis.patch.yml`、`--patch`）、以及在这个 HMR 状态下等过了写稳定窗口没有。

**发现页是空的。** 没有插件市场索引，加一个索引 URL 才有条目。

**某个设置项保存了但显示未生效。** 界面会明说被更高优先级的配置覆盖，按上面那条顺序找覆盖来源。

**日志里出现 `HMR transactions cannot be nested`。** 这是本仓插件在配置变更回调里改配置导致的，配置本身仍会落地，但属于需要修的缺陷；遇到时保留日志，不要靠反复重启掩盖。

## 附录：看懂一行插件的命名与来源

### 行 id 的前缀规律

行 id 不是包名，但前缀说明了它属于哪一类，看到陌生 id 时先按前缀归类：

| 前缀 | 含义 | 例子 |
| --- | --- | --- |
| 无前缀 | 宿主服务、工具注册表、存储、路由这类底座 | `session`、`tools`、`llm` |
| `ui-` | 浏览器侧界面部件，停用只影响显示 | `ui-sidebar-terminal`、`ui-trajectory` |
| `tool-` | 模型可调用的工具 | `tool-bash`、`tool-web`、`tool-todo` |
| `command-` | 输入框的斜杠命令 | `command-compact`、`command-goal` |
| `client-` | 浏览器基础设施，不是功能 | `connection`、`modules`、`client-hmr` |
| `api-` | 界面与宿主之间的接口面 | `api-session-controller`、`api-gateway` |
| `preset-` | Agent 预设定义 | `preset-standard`、`preset-code-vibe` |
| `subagent-` / `tool-subagent-` | 子代理后端与它的调用工具 | `subagent-codex`、`tool-subagent-codex` |
| `session-` / `storage-` / `llm-` / `sandbox-` / `web-` | 对应领域的能力行 | `session-title`、`web-search-deepseek` |

### 查一行到底是什么

三个办法，按代价从低到高：

1. 在「设置 → 内置插件 → 插件列表」里搜 id 或包名，卡片上有标题、描述、来源与生效状态。
2. 看运行树里那个包的 README：`~/.local/share/dsh/versions/<版本>/lib/node_modules/@deepseek-ai/dsh/node_modules/<包名>/README.md`，`Summary` 与 `Use this package` 两节就是说给使用者的。
3. 想知道这一行为什么被停用，看那行的 `disabled`：`true` 是人为停用，`!!js ...` 是条件启用（要按运行时求值，不能看字面量），出现在预设组合里则是按会话发放。