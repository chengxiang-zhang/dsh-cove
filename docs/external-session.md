# 外援会话：多轮外部 CLI 委派

外部 CLI（Claude Code、Codex）在 DSH 里是「一次性外援」：派一次、跑一趟、结束即失联。本文定义 dsh-cove 在插件内实现的多轮外部会话能力，作为这两个外部子智能体的替代实现。

## 1. 问题

原生 `@deepseek-ai/dsh-subagent-claude-code` 与 `@deepseek-ai/dsh-subagent-codex` 的官方口径是：

> 每次运行均新建一个 query/进程/线程和一个轮次，不支持续接、恢复、池化、进度流或产品会话持久化。

这带来三个可观测后果：

- 同一件事的后续动作必须重新派发，并且要把上一轮的上下文重新发一遍。
- 「先调研、回报、再实现」这类分段协作无法成立。
- 每轮重建上下文的 token 成本落在调用方。

根因在子代理内核而不是 provider：续接能力由 `prepareContinuable` 决定，它只服务「子级是 DSH 会话」的进程内后端；进程外后端在 manager 的 `deliverToChild` 处被直接拒绝为 `NOT_CONTINUABLE`。

## 2. 设计裁决

后文所有细节都由这三条裁决推出。

| 裁决 | 内容 | 理由 |
| --- | --- | --- |
| 替换而非并存 | 关闭原生两个外部 provider 行，由本能力统一承担一次性与多轮 | 两条路并存时模型与人都可能选错，且资源与凭据要维护两套 |
| 不碰 DSH 内核 | 不注册 subagent provider，不修改 subagent 与 continuation | 内核是上游变更最频繁的部分；provider 接口本身也无法表达「外部可继续子级」 |
| 工具名沿用 | 模型侧仍是 `subagent_claude_code` / `subagent_codex` | 预设与提示词零改动，模型无需重新学习 |

不碰内核带来的一个物理边界需要明确：插件只能向会话日志写 `plugin:` 开头的记录，`subagent/catalog` 是内核自有事件类型，因此本能力的条目**不属于原生子代理目录**，展示由客户端自有组件承担（见 §11）。

## 3. 目标与非目标

目标：

- G1 一次性委派的行为与原生一致：同样的权限模式、同样的凭据来源、同样的结果形态。
- G2 同一外部会话可续轮：后续消息携带 `session_id`，进程复用 CLI 的会话号继续。
- G3 会话状态可查：面板给出每轮的输入摘要、结果、耗时与用量；宿主重启后仍在。
- G4 取消与回收可预期：取消只终止当前轮，结束后不留残余进程。

非目标：

- N1 运行中插话（Steer）。外部 CLI 没有步骤边界，排队语义是能做到的上限。
- N2 接管外部 CLI 的上下文。历史与压缩由 CLI 自己持有，DSH 只保存轮次摘要。
- N3 原生子代理卡片与结算消息注入。那两条写在内核事件里，插件无权写。
- N4 多外部会话的并行编排。单会话 FIFO 是本期契约。

## 4. 架构

```
模型 ── subagent_claude_code / subagent_codex ──┐
                                              ▼
                    external-session 引擎（状态机 / FIFO / 并发闸 / 取消）
                      │                  │                     │
              adapters           store（JSON 原子写）      routes → 右侧面板
          claude.ts / codex.ts
                      │
              ctx.subprocess.spawn（每轮一个进程）
                      │
        claude -p --resume <id> / codex 对应入口
```

模块落点（全部为新增，不改现有服务域）：

| 层 | 路径 | 职责 |
| --- | --- | --- |
| 共享类型 | `packages/dsh-web-all/src/core/external-session/` | `types.ts` 记录与视图类型、`errors.ts` 八个错误码、`schema.ts` 存储 schema 与校验、`lifecycle.ts` 状态迁移、`adapters.ts` 适配器契约、`gateway.ts` 服务接口、`views.ts` 视图投影 |
| 工具面 | `packages/dsh-web-all/src/host/services/external-session/tools.ts` | 由本实体自己的 Loader 条目注册四个工具（见 §7） |
| 服务域 | `packages/dsh-web-all/src/host/services/external-session/` | `index.ts` 的 `register`、`engine.ts` 状态机与 FIFO、`store.ts` 的 JSON 原子写、`routes.ts` 的 `/api/external-session` 数据面、`mutex.ts` 的互斥门、`registry.ts` 把适配器接到 `ctx.subprocess`、`config.ts` 配置与默认值、`tools.ts` 四个工具的定义、`providers/` 下每个 CLI 一个适配器 |
| 客户端 | `packages/dsh-web-all/src/client/external-session/` | 右侧面板、下拉分组与宿主 routes 的客户端 |

复用的既有机制：`ctx.subprocess.spawn`（worktree 与 git-graph 已用）、JSON 原子写、host webserver routes、客户端 DOM 增强（`src/client/conversation/subagent-model-dom.ts` 是同类先例）。

**每轮一个进程而不是常驻**：不占内存、宿主重启后可按会话号恢复、终止语义干净；代价是每轮有冷启动延迟。

## 5. 生命周期

每个外部会话有四个状态：

```
        start(auto)
   ┌──────────────▶ running ──settle──▶ idle ──send(session_id)──┐
   │                  │                 │                        │
   │                  └──cancel/fail──▶ failed / idle            │
   │                                                                
   └──────────────── closed ◀── stop ──┘
```

- 一轮 = 一次子进程从启动到退出；
- 进程退出后写回该轮的终态、用量与耗时，会话回到 `idle`；
- `closed` 是终态，之后不接续轮；记录保留可查。

## 6. 数据模型与持久化

单文件 `~/.dsh/dsh-external-session.json`，原子写，条目数上限 100。

```jsonc
{
  "version": 1,
  "sessions": [{
    "id": "ext-…",                 // 调用方与面板使用的稳定 id
    "provider": "claude",          // claude | codex
    "providerSessionId": "…",      // CLI 会话号，续轮的唯一依赖
    "cwd": "/abs/path",
    "title": "修登录 bug",
    "status": "idle",              // running | idle | failed | closed
    "createdAt": "2026-11-04T12:00:00Z",
    "lastTurnAt": "2026-11-04T12:03:00Z",
    "turns": [{
      "n": 1,
      "prompt": "…",
      "status": "completed",       // completed | failed | aborted
      "startedAt": "…",
      "durationMs": 42000,
      "usage": { "input": 1234, "output": 567 },
      "costUsd": 0.03,             // CLI 自估价，不作账单
      "result": "…"
    }]
  }]
}
```

记录字段 `originSessionId` 是发起首轮的那条 DSH 会话号：它决定这个外援出现在哪个会话的下拉里，缺省表示记录早于该字段。

字段约束：`providerSessionId` 缺失的会话不可续轮，工具返回 `session-unresumable`；`cwd` 必须是宿主可进入的目录，否则 `cwd-invalid`。

## 7. 工具契约

模型可见四个工具，其中两个沿用原生名字以保持兼容：

```
subagent_claude_code(prompt, session_id?, cwd?, title?, model?, wait_ms?)
subagent_codex(prompt, session_id?, cwd?, title?, model?, wait_ms?)
external_session_wait(session_id, timeout_ms?)
external_session_list(status?, scope?)
external_session_stop(session_id)
```

- `external_session_list` 默认只列**本会话**派出去的外援（记录上的 `originSessionId` 等于当前会话）；`scope: "all"` 才列宿主机全部会话，包含其它会话发起的与来源未知的历史记录。同一条规则也约束下拉与面板：外援跟着发起它的会话走。
- 省略 `session_id`：新建外部会话并跑第一轮，等价原有一次性的使用方式。
- 提供 `session_id`：在该会话上跑下一轮，内部使用 CLI 会话号续接。
- 没有 `provider` 参数：走哪个 CLI 由调用的是哪个工具决定，provider 不由参数选。
- 返回统一结构：`{ session_id, turn, status, result, usage, cost_usd, can_continue }`。
- `wait_ms` 决定这次调用等多久：默认等 15000 毫秒，`0` 立刻返回，上限 600000。窗口内结束的轮次直接回结果；没结束的回 `status: "running"` 与 `progress`（`elapsed_ms` / `idle_ms` / `frames` / `tool_calls` / `chars` / `tail`），调用方继续做别的事，再用 `external_session_wait` 取回。一次三十多分钟的派发不再占住整个回合。
- `external_session_wait` 等一个还在跑的轮次：默认 60000 毫秒、上限 600000。窗口内结束回结果，否则回仍在跑的轮次与它的进度。`idle_ms` 是判断"卡住还是在想"的读数。
- 结果里出现 `partial: true` 表示 `result` 是被取消 / 停滞 / 超时那一轮的已产出文本，不是完整答案；`result` 永远不是空串。
- 进度粒度：claude 侧带 `--include-partial-messages`，一条回答按 `text_delta` 帧推进——实测 120 词的回答由 8 帧变为 74 帧，`chars`/`tail` 在生成过程中持续增长；codex 侧按 `item.completed` 推进（一条消息一帧）。

两个派发工具各自带一个可选的 `model`：目录由实体行的 `config.externalSession.tools` 给，不写在代码里。行上的 `config.models` 是 `[{ id, description }]`，编译成参数 schema 的 `oneOf` 分支，于是每个候选模型在选择处就带着自己的说明；行上不给 `models` 时该参数退化为自由字符串，最终由 CLI 自己的设置决定。两个工具各带各的目录，避免把 Claude 的模型 id 递给 Codex。

模型按轮记录：`model` 写进该轮的 turn 记录，续轮可以换模型，账单与回归才归得到具体模型。

每个工具还可以配一个 `default`：调用方省略 `model` 时用它；行上没配 `default` 时，省略 `model` 就是 CLI 自己配置的模型。当前这台机器的口径是 claude 默认 `kaon/claude-opus-5-5`、codex 默认 `gpt-6-astra`，工具的说明文字会把默认档直接写出来，模型不必猜。

- 取消语义：父回合的取消只作用于还在 `wait_ms` 窗口里的那一段；调用已经回 `running` 之后，子进程继续跑，直到 `external_session_stop` 或下面两条期限之一。
- 期限：一个轮次连续 600000 毫秒没有任何帧就判停滞（`turn-stalled`）并取消；单个轮次墙钟超过 2400000 毫秒判超时（`turn-timeout`）。两者都保留已产出文本，按 `partial` 返回。

这四个工具由本实体自己的 Loader 条目注册，随实体行一起装配：`web-all` 的 `config.externalSession.tools` 决定每个 provider 的开关与模型目录，控制工具只注册一次。工具不放在预设里——预设行由 `agentPresets` 在运行时装配，不属于 Loader 条目，而 HMR 只能替换「所有活着的 importer 都是 Loader 条目」的模块；工具一旦从预设平面 import，本文件的任何改动都要重启宿主才生效。工具注册仍是容忍式的：名字被占时不报错，先注册者拥有，被拒的一方发一条点名讯息。

错误码固定为一组，面向模型给出一句话就够的解释：

| 错误码 | 触发条件 |
| --- | --- |
| `provider-missing` | 宿主上找不到对应的 CLI 可执行文件 |
| `cwd-invalid` | 工作目录不存在或不可进入 |
| `session-unknown` | `session_id` 不在存储里 |
| `session-closed` | 会话已关闭 |
| `session-unresumable` | 缺少 CLI 会话号，无法续轮 |
| `busy` | 达到全局并发上限，或该会话正在跑另一轮 |
| `limit` | 会话记录数达到上限 |
| `auth-required` | CLI 报未登录 / 缺少凭据 |
| `provider-error` | CLI 起了但本轮没终帧 / 非零退出 / 事件流断裂（重试仍失败时请运营看宿主日志） |
| `store-unavailable` | 宿主无法持久化会话记录（存储目录不可写或磁盘满）；重试无用，需要运营处理宿主存储 |

`auth-required` 必须由适配器识别 CLI 的 `Not logged in · Please run /login` 文本后转出，并在消息里指明「本机 `~/.claude/settings.json` 的 `env` 缺少 `ANTHROPIC_BASE_URL` 或 `ANTHROPIC_AUTH_TOKEN`」，不把原始报错透给模型。

错误码到 HTTP 状态的映射是穷尽 switch：`cwd-invalid` → 400、`session-unknown` → 404、`busy` → 429、`provider-missing` → 501、`provider-error` → 502、`store-unavailable` → 503，`auth-required`、`session-closed`、`session-unresumable`、`limit` → 409。

记录写失败报的是 `store-unavailable`，不是 `session-unknown`：后一条会让调用方以为 id 错了、重试没用，而这里说明的是宿主存不下。

面板用的这组路由不等本轮结束：`/api/external-session/continue` 在轮次一开始就返回 200 与整份会话列表，本轮成败要看列表里该轮的 `status`；`/cancel` 与 `/close` 同样回整份列表。它不等本轮跑完，但会等本轮的记录写进存储再回 200，所以存储不可写时它在返回前就报 `store-unavailable`（503），不会先 200 再静默失败。面板与工具读的是同一份进度：工具的 `progress` 就来自这里。

## 8. 执行适配器

两个适配器共享同一套生命周期，差异只在参数与事件解析。

Claude Code：

- 启动参数：`-p`、`--output-format stream-json`、`--verbose`、`--permission-mode auto`，续轮追加 `--resume <id>`；
- 从首帧 `system/init` 与终帧 `result` 中取 `session_id`、`usage`、`total_cost_usd`；
- 失败分类：启动失败与轮中失败分开记录，内部诊断只进日志。

Codex：

- 每轮一个进程，按它自己的入口提交任务；
- 会话号从该轮的协议响应中取，取不到就把会话标记为不可续轮（`session-unresumable`），不静默降级为一次性。

适配器实现参考原生 provider 的既有处理（MIT 许可），派生材料在服务域目录内附 `THIRD_PARTY_NOTICES.md`，并在根 `NOTICE` 登记。

## 9. 权限、凭据与环境

- 权限模式固定为 `auto`，与原生在 profile 里 pin 的值一致；`dontAsk` 会拒绝一切未预授权操作，不可用于无人值守。
- 凭据来源仍只有一处：CLI 自己的原生设置（`~/.claude/settings.json`）。DSH 起子进程时使用 `scrubbedParentEnv()`，会删除名字含 `KEY`、`PASSWORD`、`SECRET`、`TOKEN` 的变量，因此适配器必须显式注入 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_AUTH_TOKEN`；读不到即返回 `auth-required`，不做猜测。
- 可执行文件解析：配置项 `claudeBin` / `codexBin` 接受绝对路径或命令名，默认 `claude` / `codex`，由宿主装配经 `deps.externalSession` 传入服务域。绝对路径会被验证存在，裸命令名在清洗后的 `PATH` 上查找；两边都找不到时本轮返回 `provider-missing`，不去猜别处的安装位置。
- 配置面只有实体行的一处：`- id: web-all` 的 `config.externalSession`，字段为 `claudeBin`、`codexBin`、`maxConcurrentTurns`、`maxSessions`、`cancelGraceMs`、`storePath`。没有环境变量旁路；唯一读到的 `DSH_HOME` 只用于定位默认存储路径。
- 模型、MCP、hooks 与插件继续由 CLI 原生设置决定，本能力不覆盖。

## 10. 并发、资源与回收

- 每会话 FIFO，同一时刻只跑一轮；全局并发上限默认 2，超出返回 `busy`，不静默排队。
- 取消顺序：`SIGTERM` → 3 秒宽限 → `SIGKILL` 进程组；本轮记 `aborted`，会话仍可续轮。
- 取消只作用于当前轮：进程组退出后会话回到 `idle`，`closed` 是 `external_session_stop` 产生的终态，之后不再接续轮。
- 取消在轮次刚启动、进程还没起来时也有效：轮次照样记 `aborted`，不留残留进程，会话仍可续轮。
- 失败不自动重试：本轮记 `failed`，会话保留，由调用方决定重试或关闭。
- 会话记录上限 100，关闭的会话先保留，由面板手动删除。
- 保留策略就是上限 100 加面板手动删除，不做按时间自动清理。改成按时间清理是 `store` 里一处策略函数的替换，记录格式与工具契约不动。

## 11. 展示与交互

两个展示面，与原生保持可辨识的一致：

1. **会话头部的子智能体下拉**：追加「外援」分组，条目为叶节点，样式复刻原生外部任务条目（标题 + 外部任务标签 + 一行状态）。该分组使用自有计数，不并入原生「N 个子智能体」的口径。
   **分组按会话绑定**：只列当前会话派出去的外援。一个外援属于哪条会话由记录上的 `originSessionId` 决定，在首轮创建时写入；之后的续轮不改它——换一条会话接着跑同一个外援，归属仍在发起它的那条会话。没有 `originSessionId` 的历史记录无法归属，只在右侧面板的「全部会话」里出现。
2. **右侧面板**：列表与轮次时间线（输入摘要、结果、耗时、用量、运行中/部分结果标记），操作包括追问、取消本轮、关闭。默认只看本会话派出的外援，勾选「全部会话」才显示其它会话与来源未知的历史记录（后者标「其它会话」/「来源未知」）。**它不在右栏的启动菜单里**：右栏那排入口是各页签注册时 `guide` 数组的展开，而外援是按会话产生的从属视图，不是常驻工具；入口是从会话头部的下拉条目点进来（`openTab` 仍按 kind 打开它）。
3. **对话流**：每次调用是一张普通工具卡片，与其它工具一致。

右栏启动菜单只保留原生工具（工作区文件、终端、Git 管理）。

数据由服务域通过宿主 routes 提供给客户端，不写会话日志。

面板入口固定在右侧栏。改挂到侧栏只需要改客户端的挂载点，服务域、路由与数据不动。

## 12. 与原生插件的关系

| 对象 | 处置 |
| --- | --- |
| `tool-subagent-claude-code` / `tool-subagent-codex` 两行 | 由本能力承担，指向本包的工具入口（接线见 §13） |
| `@deepseek-ai/dsh-subagent` 服务、spawn/fork 本地子代理、Agent Team | 保留不动 |
| ACP 两个强模型入口 `subagent_astra` / `subagent_opus55` | 退役：它们做的事已由本能力用 `model` 覆盖（codex→astra、claude→opus），provider 行与 tool 行整段移除，不留 `disabled: true` |
| `subagent_cursor` | 保留：本能力只驱动 claude 与 codex 两个 CLI，Cursor 没有对应通道 |
| `~/.claude/settings.json`、Codex 原生配置 | 保留，仍是唯一凭据与模型来源 |

互斥检测分两段，因为一段挡不住实际装配顺序。服务域加载时若发现原生外部 provider 已注册（`ctx.subagents.list()` 含 `claude-code` 或 `codex`），拒绝挂载并给出关闭指引；挂载之后再收到 `subagent/provider-added`，同一识别再跑一次并报告，不拆除已挂载的域。两段里哪一段先响由装配顺序决定：实体注入的服务更多，原生 provider 行只等 `subagents`，两种先后都出现过，所以两段都必须有。

检测只探 provider 注册表，不扫工具目录。工具名的归属由注册表本身决定：先注册者拥有该名字，后注册者被拒。被拒的行不静默退出——它报一行讯息，点名仍占着名字的行，否则目录里留着一个看着能用、实际永远走原生 provider 的委派。

## 13. 迁移与回滚

接线只有一处：实体行 `web-all` 的 `config.externalSession`。工具由该行自己注册，因此该 profile 的每个预设、每个会话都看得到，也不需要另插工具行。

不放在预设里是有代价的结论：预设行由 `agentPresets` 在运行时装配，不属于 Loader 条目；而 HMR 只能替换「所有活着的 importer 都是 Loader 条目」的模块。把工具行放进预设，等于任何一次工具代码改动都要重启宿主才生效。

**同一个 `- id:` 在一份 patch 里只能出现一次**：后出现的 `config` 对已存在条目是**整键替换**，不是深合并。把 `externalSession` 单独写成第二个 `- id: web-all`，会让该条目只剩 `externalSession`，`noBrowserAuth`、`feishu`、`lark-inbox`、`playwright` 全部丢失。实体配置必须并进已有那条 `web-all` 的 `config` 块。

```yaml
- id: web-all
  config:
    externalSession:
      claudeBin: /Users/leo/.local/bin/claude
      tools:
        claude:
          models:
            - id: kaon/claude-sonnet-5-5
              description: 均衡默认档，日常任务先选它
            - id: kaon/claude-opus-5-5
              description: 最强也最贵，用于复杂设计、排障与对抗式复核
        codex:
          models:
            - id: gpt-6-astra
              description: 当前 ChatGPT 账号下可用；terra 在 CLI 侧返回 400
```

活 profile（`~/.dsh/profiles/web/cordis.patch.yml`）要同时改两处，缺一处迁移就不完整。

**一、删掉四个原生行**（provider 两行、tool 两行，整段移除；不是加 `disabled: true`），并把这些尾巴一起清掉：

- 从 `dsh.profile.bundles` 去掉 `@deepseek-ai/dsh-subagent-claude-code` 与 `@deepseek-ai/dsh-subagent-codex`；
- 从 `dependencies` 去掉同名两项；
- 删掉 profile `node_modules/@deepseek-ai/` 下对应的两个包目录。

停用行留着只是噪音：它继续把原生工具名占在配置里，下一个读 profile 的人还得判断它是死是活。互斥门查的是 provider 注册表，所以 provider 行必须和 tool 行一起消失，只删 tool 行挡不住门。

这一步不是可选的：互斥门看到原生 provider 仍在注册就拒绝挂载，本能力完全不生效，`/api/external-session/*` 一直 404。保存 `cordis.patch.yml` 不触发重载（`dsh.profile.patchReload` 在 0.2.1-rc.5 里没有实现，全量搜索该安装包命中 0 次，也没有代码注册 `hmr.watchConfig`）。重组入口是 Plugin Manager 的写操作（`set_plugin` / `set_bundle` / 安装 / 卸载），它调用 `hmr.reconcileProfile()`。本能力把工具注册在实体自己的 Loader 条目里之后，该调用返回 `applied`；把工具挂在预设入口或另立子入口的旧结构返回 `restart-required` 与 `restartReason: unmanaged-plugin`。这条差别已实测两轮：同一 profile 连续两次 `set_bundle` 开关都回 `applied`，活工具的说明文字随之改变。

**二、给实体行配 `claudeBin`**：

```yaml
- id: web-all
  config:
    externalSession:
      claudeBin: /Users/leo/.local/bin/claude
```

托管启动器的 PATH 逐字是 `/Users/leo/.nvm/versions/node/v22.22.0/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`，不含 `~/.local/bin`，因此在这个 PATH 下 `command -v claude` 为 not-found；`codex` 恰好在该 PATH 内（`/Users/leo/.nvm/versions/node/v22.22.0/bin/codex`），不需要 `codexBin` 覆盖。不配 `claudeBin` 的后果是每次续轮 `POST /api/external-session/continue` 返回 HTTP 501 与 `{"ok":false,"error":{"code":"provider-missing",…}}`；配上之后，同一 PATH、同一会话续轮回 HTTP 200，第 2 轮 `status` 为 `completed` 且 `result` 就是重启前那个标记，说明确实是 `claude --resume` 答出来的。透传链的静态旁证：在配了该键的 profile 上跑 `dsh --profile web --dump-config`，输出里能读到 `externalSession.claudeBin`，即 `src/index.ts` → `services/index.ts` → `config.ts` 这条链是通的。

`~/.dsh/profiles/web/node_modules/@dsh-cove/dsh-web-all` 是指向本仓 `packages/dsh-web-all` 的符号链接，重启后加载的就是本仓代码。

回滚：把两个原生 bundle 与其 profile 行加回去，并去掉 `externalSession` 配置。两侧数据文件不同（本能力写 `~/.dsh/dsh-external-session.json`，原生不写这个文件），回滚不迁移、不覆盖对方数据。

## 14. 验收判据

| 编号 | 判据 |
| --- | --- |
| E1 | 权限：无人值守模式下本能力能写文件并运行命令，不出现「全部拒绝」 |
| E2 | 结果：同一真实缺陷任务，结论与改动可复核 |
| E3 | 续接：先要求「记住 42」，再以同一 `session_id` 追问「刚才让你记的数字是多少」，回答 42 |
| E4 | 冷恢复：重启 DSH 后 `external_session_list` 仍列出该会话，续轮成功 |
| E5 | 资源：取消与正常结束后 `ps` 无残留 CLI 进程；并发上限触发时返回 `busy` |
| E6 | 升级演练：安装一个新的 DSH 版本后，只有适配层需要修改（此判据决定替换方案是否成立） |

## 15. 分期

| 期 | 交付物 | 完成标准 |
| --- | --- | --- |
| P0 | 服务域骨架、存储、工具注册、互斥检测、面板空态 | 工具出现在工具目录；原生 provider 仍在注册时报错，或在其后注册时立刻报一行点名讯息 |
| P1 | Claude Code 适配器（一次性） | E1、E2 通过 |
| P2 | 续轮（会话号与 `--resume`） | E3、E4 通过 |
| P3 | 面板（时间线、追问、取消）与下拉分组 | 面板可独立完成 E3 全流程 |
| P4 | Codex 适配器并关闭其原生行 | Codex 复跑 E1 至 E4 |
| P5 | 收尾：上限、清理、文案、升级演练 | E5、E6 通过 |

## 16. 已知限制与风险

已知限制：

- **生效时机**：按 [hmr.md](hmr.md) 判定。宿主代码与客户端代码在构建后由一次 profile 重组热替换（Plugin Manager 的写操作会触发 `hmr.reconcileProfile()`；保存 `cordis.patch.yml` 本身不触发）；预设散文在下一个会话组合时生效；只有变更落进进程静态图或不受 Loader 管理时才需要重启。
- **每轮一个进程**：续轮复用 CLI 的会话号而不是常驻进程，每轮都有冷启动延迟，长会话的总耗时包含这段延迟。
- **成本是估值**：`cost_usd` 是 CLI 内置价表估算，不是网关账单；工具返回与面板都标注为估值。
- **宿主需要有 `claude`**：解析规则见 §9；解析不到时本轮返回 `provider-missing`。
- **`claude` 版本决定可选模型**：`--model` 送到 CLI 之后，模型能不能用由 CLI 版本决定。实测 `kaon/claude-opus-5-5` 在 Claude Code 2.1.177 上返回 400（要求 ≥ 2.1.280），升级到 2.1.318 后同一命令返回 `assistant.model = anthropic/claude-opus-5.5`。默认档配到一个当前 CLI 不支持的模型时，每一轮都会是 `provider-error`，而不是静默换模型。
- **派发不再阻塞整个回合**：工具最多等 `wait_ms`，之后回一个 `status: "running"` 的轮次；调用方用 `external_session_wait` 取回，或用 `external_session_list` 的 `running` 读进度。claude 的 `idle_ms` 按增量帧推进，因此"还在生成"与"已死"能分辨。
- **互斥门 fail-closed**：原生外部 provider 没关时本能力完全不挂载，`/api/external-session/*` 返回 404（规则见 §12），不会与原生并存，也不会抢工具名。
  - 自查：`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/api/external-session/list` 回 `404` 说明没挂载（已挂载但调用方不在围栏内是 `403`，正常是 `200`）；宿主日志里 external-session 的装配拒绝消息会点名 `tool-subagent-claude-code` 与 `tool-subagent-codex`；`grep externalSession ~/.dsh/profiles/web/cordis.patch.yml` 为空说明就是还没迁移。
- **工具名归实体行，不归预设**：预设行在 Loader 之外实例化插件，工具注册只由实体自己的 Loader 条目承担（机制见 §7）。实体行缺席时这两个工具直接不出现，不会被预设层接管，也不会自动回落到原生实现。
- **真机验证是交付条件，不是可选项**：改动本能力的适配器或工具面时，除单测外要跑一次真机对（`DSH_EXT_SESSION_REAL_CLI=1` + `DSH_EXT_SESSION_CLAUDE_BIN=<claude>`，`tests/external-session-claude-provider.spec.ts` 的 `live progress and partial text` 一组）。2026-11-06 正是这一组抓到了单测覆盖不到的缺陷：取消会让子进程的 `done` reject，旧代码据此走了 failed 分支，把已产出的文本丢掉。单测全绿而真机红，说明这类缺陷只能在真机上暴露。
- **`auth-required` 是 fail-closed**：CLI 的 401 与未登录一律判 `auth-required`（要人处理），不伪装成可重试的 `provider-error`。
- **codex 需要可写的宿主 home**：真实成功路径要 `~/.codex` 可写；只读 home 会在 CLI 自己的 app-server 初始化阶段先失败，那是宿主 permissions 差异，不是适配器差异。

风险：

- **版本漂移**：`session_id` 字段位置、事件形状与 CLI 参数都可能随 CLI 升级变化，适配层需要版本探测与降级路径。

口径决定写在各自的家：后台模式见 §7，保留策略见 §10，面板入口见 §11，每节都写明了改回去要动哪里。
