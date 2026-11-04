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
| 预设入口 | `packages/dsh-web-all/src/preset-tools.ts` | 预设行挂载的工具入口，一行一个 provider（见 §7） |
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

字段约束：`providerSessionId` 缺失的会话不可续轮，工具返回 `session-unresumable`；`cwd` 必须是宿主可进入的目录，否则 `cwd-invalid`。

## 7. 工具契约

模型可见四个工具，其中两个沿用原生名字以保持兼容：

```
subagent_claude_code(prompt, session_id?, cwd?, title?)
subagent_codex(prompt, session_id?, cwd?, title?)
external_session_list(status?)
external_session_stop(session_id)
```

- 省略 `session_id`：新建外部会话并跑第一轮，等价原有一次性的使用方式。
- 提供 `session_id`：在该会话上跑下一轮，内部使用 CLI 会话号续接。
- 返回统一结构：`{ session_id, turn, status, result, usage, cost_usd, can_continue }`。
- 工具为同步阻塞：本轮结束才返回。这样结果直接进入对话，不依赖任何未公开的消息注入通道。
- 不做后台模式：一次调用占用当前轮，直到本轮结束。要改成后台派发，给工具加一个 `background` 参数即可，引擎与存储不动。

这四个工具由预设行挂载，不是宿主无条件注册：`@dsh-cove/dsh-web-all/preset-tools` 是 agent-plane 入口，一个预设行注册一个 provider 的委派工具，并默认同时注册 `external_session_list` 与 `external_session_stop`（多行时用 `control: false` 让控制工具只声明一次）。宿主装配挂载引擎与存储而不挂工具，因为面板与工具共用同一份数据。引擎服务缺席时这一行不注册任何工具、只发一条 warn，工具名留给原生行——工具注册是容忍式的，重名不报错，谁先注册谁拥有那个名字。

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

`auth-required` 必须由适配器识别 CLI 的 `Not logged in · Please run /login` 文本后转出，并在消息里指明「本机 `~/.claude/settings.json` 的 `env` 缺少 `ANTHROPIC_BASE_URL` 或 `ANTHROPIC_AUTH_TOKEN`」，不把原始报错透给模型。

错误码到 HTTP 状态的映射是穷尽 switch：`cwd-invalid` → 400、`session-unknown` → 404、`busy` → 429、`provider-missing` → 501、`provider-error` → 502，`auth-required`、`session-closed`、`session-unresumable`、`limit` → 409。

面板用的这组路由不等本轮结束：`/api/external-session/continue` 在轮次一开始就返回 200 与整份会话列表，本轮成败要看列表里该轮的 `status`；`/cancel` 与 `/close` 同样回整份列表。工具本身是同步阻塞的（见本节开头）。

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
- 失败不自动重试：本轮记 `failed`，会话保留，由调用方决定重试或关闭。
- 会话记录上限 100，关闭的会话先保留，由面板手动删除。
- 保留策略就是上限 100 加面板手动删除，不做按时间自动清理。改成按时间清理是 `store` 里一处策略函数的替换，记录格式与工具契约不动。

## 11. 展示与交互

三个展示面，与原生保持可辨识的一致：

1. **会话头部的子智能体下拉**：追加「外援」分组，条目为叶节点，样式复刻原生外部任务条目（标题 + 外部任务标签、不显示执行状态）。该分组使用自有计数，不并入原生「N 个子智能体」的口径。
2. **右侧面板**：列表与轮次时间线（输入摘要、结果、耗时、用量），操作包括追问、取消本轮、关闭。条目点击进入面板，这是相对原生的增强。
3. **对话流**：每次调用是一张普通工具卡片，与其它工具一致。

数据由服务域通过宿主 routes 提供给客户端，不写会话日志。

面板入口固定在右侧栏。改挂到侧栏只需要改客户端的挂载点，服务域、路由与数据不动。

## 12. 与原生插件的关系

| 对象 | 处置 |
| --- | --- |
| `tool-subagent-claude-code` / `tool-subagent-codex` 两行 | 由本能力承担，指向本包的工具入口（接线见 §13） |
| `@deepseek-ai/dsh-subagent` 服务、spawn/fork 本地子代理、Agent Team | 保留不动 |
| `~/.claude/settings.json`、Codex 原生配置 | 保留，仍是唯一凭据与模型来源 |

互斥检测：服务域加载时若发现原生外部 provider 仍注册（`ctx.subagents.list()` 含 `claude-code` 或 `codex`），拒绝挂载并给出关闭指引，不静默双跑。检测只探 provider 注册表，不扫工具目录；同名的原生工具行拦不住，工具注册本身是容忍式的（先注册者拥有那个名字），所以迁移时四个原生行要一起关掉（见 §13）。

## 13. 迁移与回滚

接线点只有预设 `code-vibe` 里的两个工具行。改接线只改 `packages/dsh-web-all/presets/code-vibe/agent.cordis.yml`，再跑 `node scripts/render-preset.mjs` 重新生成 `presets/code-vibe.patch.yml`；`node scripts/render-preset.mjs --check` 是漂移门，手改生成物会被它打红。

两行的现状：

| 行 | `name` | `config.provider` | `config.toolName` | 状态 |
| --- | --- | --- | --- | --- |
| `tool-subagent-claude-code` | `@dsh-cove/dsh-web-all/preset-tools` | `claude` | `subagent_claude_code` | 启用 |
| `tool-subagent-codex` | `@dsh-cove/dsh-web-all/preset-tools` | `codex` | `subagent_codex` | 启用 |

原生的 `@deepseek-ai/dsh-subagent-claude-code` 与 `@deepseek-ai/dsh-subagent-codex` 两个 provider 包仍装在 profile 里供对照，但不进预设组合。

活 profile（`~/.dsh/profiles/web/cordis.patch.yml`）要同时改两处，缺一处迁移就不完整。

**一、关掉四个原生行**，每行加 `disabled: true`；以下是这四行连同各自原有的 config，其余行保持原样：

```yaml
- id: subagent-claude-code
  name: '@deepseek-ai/dsh-subagent-claude-code'
  disabled: true
  config:
    permissionMode: auto

- id: subagent-codex
  name: '@deepseek-ai/dsh-subagent-codex'
  disabled: true
  config:
    model: gpt-6-astra

- insert:
    - id: tool-subagent-claude-code
      name: '@deepseek-ai/dsh-tool-subagent'
      disabled: true
      config:
        provider: claude-code
        toolName: subagent_claude_code
        backgroundMode: one-shot
        maxDepth: provider-managed

    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-tool-subagent'
      disabled: true
      config:
        provider: codex
        toolName: subagent_codex
        backgroundMode: one-shot
        maxDepth: provider-managed
```

这一步不是可选的：互斥门看到原生 provider 仍在注册就拒绝挂载，本能力完全不生效，`/api/external-session/*` 一直 404。该 profile 的 `patchReload` 是 `live`，改这几行热重载生效，不需要重启宿主。

**二、给实体行配 `claudeBin`**：

```yaml
- id: web-all
  config:
    externalSession:
      claudeBin: /Users/leo/.local/bin/claude
```

托管启动器的 PATH 逐字是 `/Users/leo/.nvm/versions/node/v22.22.0/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`，不含 `~/.local/bin`，因此在这个 PATH 下 `command -v claude` 为 not-found；`codex` 恰好在该 PATH 内（`/Users/leo/.nvm/versions/node/v22.22.0/bin/codex`），不需要 `codexBin` 覆盖。不配 `claudeBin` 的后果是每次续轮 `POST /api/external-session/continue` 返回 HTTP 501 与 `{"ok":false,"error":{"code":"provider-missing",…}}`；配上之后，同一 PATH、同一会话续轮回 HTTP 200，第 2 轮 `status` 为 `completed` 且 `result` 就是重启前那个标记，说明确实是 `claude --resume` 答出来的。透传链的静态旁证：在配了该键的 profile 上跑 `dsh --profile web --dump-config`，输出里能读到 `externalSession.claudeBin`，即 `src/index.ts` → `services/index.ts` → `config.ts` 这条链是通的。

`~/.dsh/profiles/web/node_modules/@dsh-cove/dsh-web-all` 是指向本仓 `packages/dsh-web-all` 的符号链接，重启后加载的就是本仓代码。

回滚：删掉那四个 `disabled` 与 `externalSession`，并把预设两行的 `name` 换回 `@deepseek-ai/dsh-tool-subagent`、`provider` 换回 `claude-code` / `codex`，重新生成 patch 并重启 DSH 生效。两侧数据文件不同（本能力写 `~/.dsh/dsh-external-session.json`，原生不写这个文件），回滚不迁移、不覆盖对方数据。

## 14. 验收判据

| 编号 | 判据 |
| --- | --- |
| E1 | 权限对照：同一任务分别由原生与本能力执行，两者都能写文件并运行命令，不出现「全部拒绝」 |
| E2 | 结果对照：同一真实缺陷任务，两者改动的文件与结论可比 |
| E3 | 续接：先要求「记住 42」，再以同一 `session_id` 追问「刚才让你记的数字是多少」，回答 42 |
| E4 | 冷恢复：重启 DSH 后 `external_session_list` 仍列出该会话，续轮成功 |
| E5 | 资源：取消与正常结束后 `ps` 无残留 CLI 进程；并发上限触发时返回 `busy` |
| E6 | 升级演练：安装一个新的 DSH 版本后，只有适配层需要修改（此判据决定替换方案是否成立） |

## 15. 分期

| 期 | 交付物 | 完成标准 |
| --- | --- | --- |
| P0 | 服务域骨架、存储、工具注册、互斥检测、面板空态 | 工具出现在工具目录；原生行未关时启动即报错 |
| P1 | Claude Code 适配器（一次性） | E1、E2 通过 |
| P2 | 续轮（会话号与 `--resume`） | E3、E4 通过 |
| P3 | 面板（时间线、追问、取消）与下拉分组 | 面板可独立完成 E3 全流程 |
| P4 | Codex 适配器并关闭其原生行 | Codex 复跑 E1 至 E4 |
| P5 | 收尾：上限、清理、文案、升级演练 | E5、E6 通过 |

## 16. 已知限制与风险

已知限制：

- **生效需要重启**：预设与包的组合在 DSH 启动时装配，改动预设或本能力的代码后要重启 DSH 才生效；profile 的 `cordis.patch.yml` 是例外，它是 `patchReload: live`，改行热重载。
- **每轮一个进程**：续轮复用 CLI 的会话号而不是常驻进程，每轮都有冷启动延迟，长会话的总耗时包含这段延迟。
- **成本是估值**：`cost_usd` 是 CLI 内置价表估算，不是网关账单；工具返回与面板都标注为估值。
- **宿主需要有 `claude`**：解析规则见 §9；解析不到时本轮返回 `provider-missing`。
- **同步阻塞**：工具在本轮结束才返回，长任务的对话卡片只显示运行中，实时进度只在面板可见。
- **互斥门 fail-closed**：原生外部 provider 没关时本能力完全不挂载，`/api/external-session/*` 返回 404（规则见 §12），不会与原生并存，也不会抢工具名。
  - 自查：`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/api/external-session/list` 回 `404` 说明没挂载（已挂载但调用方不在围栏内是 `403`，正常是 `200`）；宿主日志里 external-session 的装配拒绝消息会点名 `tool-subagent-claude-code` 与 `tool-subagent-codex`；`grep externalSession ~/.dsh/profiles/web/cordis.patch.yml` 为空说明就是还没迁移。
- **迁移前这两个工具名仍归原生**：引擎服务缺席时预设层入口不注册工具（机制见 §7），所以 `subagent_claude_code` 与 `subagent_codex` 在四个原生行关掉之前仍由原生实现提供。
- **`auth-required` 是 fail-closed**：CLI 的 401 与未登录一律判 `auth-required`（要人处理），不伪装成可重试的 `provider-error`。
- **codex 需要可写的宿主 home**：真实成功路径要 `~/.codex` 可写；只读 home 会在 CLI 自己的 app-server 初始化阶段先失败，那是宿主 permissions 差异，不是适配器差异。

风险：

- **版本漂移**：`session_id` 字段位置、事件形状与 CLI 参数都可能随 CLI 升级变化，适配层需要版本探测与降级路径。

口径决定写在各自的家：后台模式见 §7，保留策略见 §10，面板入口见 §11，每节都写明了改回去要动哪里。
