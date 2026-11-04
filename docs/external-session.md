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
| 共享类型 | `packages/dsh-web-all/src/core/external-session/` | 记录与视图类型、状态枚举、错误码 |
| 服务域 | `packages/dsh-web-all/src/host/services/external-session/` | `engine.ts`、`store.ts`、`providers/claude.ts`、`providers/codex.ts`、`tools.ts`、`routes.ts`、`config.ts` |
| 客户端 | `packages/dsh-web-all/src/client/external-session/` | 下拉分组增强与右侧面板 |

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

`auth-required` 必须由适配器识别 CLI 的 `Not logged in · Please run /login` 文本后转出，并在消息里指明「本机 `~/.claude/settings.json` 的 `env` 缺少 `ANTHROPIC_BASE_URL` 或 `ANTHROPIC_AUTH_TOKEN`」，不把原始报错透给模型。

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
- 模型、MCP、hooks 与插件继续由 CLI 原生设置决定，本能力不覆盖。

## 10. 并发、资源与回收

- 每会话 FIFO，同一时刻只跑一轮；全局并发上限默认 2，超出返回 `busy`，不静默排队。
- 取消顺序：`SIGTERM` → 3 秒宽限 → `SIGKILL` 进程组；本轮记 `aborted`，会话仍可续轮。
- 失败不自动重试：本轮记 `failed`，会话保留，由调用方决定重试或关闭。
- 会话记录上限 100，关闭的会话先保留，由面板手动删除。

## 11. 展示与交互

三个展示面，与原生保持可辨识的一致：

1. **会话头部的子智能体下拉**：追加「外援」分组，条目为叶节点，样式复刻原生外部任务条目（标题 + 外部任务标签、不显示执行状态）。该分组使用自有计数，不并入原生「N 个子智能体」的口径。
2. **右侧面板**：列表与轮次时间线（输入摘要、结果、耗时、用量），操作包括追问、取消本轮、关闭。条目点击进入面板，这是相对原生的增强。
3. **对话流**：每次调用是一张普通工具卡片，与其它工具一致。

数据由服务域通过宿主 routes 提供给客户端，不写会话日志。

## 12. 与原生插件的关系

| 对象 | 处置 |
| --- | --- |
| `tool-subagent-claude-code` / `tool-subagent-codex` 两个 profile 行（设置里的两个开关） | 关闭 |
| `@deepseek-ai/dsh-subagent` 服务、spawn/fork 本地子代理、Agent Team | 保留不动 |
| `~/.claude/settings.json`、Codex 原生配置 | 保留，仍是唯一凭据与模型来源 |

互斥检测：服务域加载时若发现原生外部 provider 仍注册（`ctx.subagents.list()` 含 `claude-code` 或 `codex`），或工具目录里仍有同名的原生工具，直接报错并给出关闭指引，不静默双跑。

## 13. 迁移与回滚

顺序：

1. 新增 `core/external-session` 与 `host/services/external-session`，含互斥检测；
2. 预设 `code-vibe.patch.yml` 与 `code-vibe/agent.cordis.yml` 中两个工具行改指向本能力的工具实现，`toolName` 不变；
3. 关闭 profile 里原生的两个外部 provider 行（先 claude）；
4. 灰度期内 Claude Code 走新路径、Codex 仍走原生，两边互不干涉；
5. Codex 适配器通过验收后再关闭其原生行。

回滚：打开原生开关并删除本能力的 profile 行即可，两侧数据不互相写入。

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

## 16. 风险与未决

风险：

- **版本漂移**：`session_id` 字段位置、事件形状与 CLI 参数都可能随 CLI 升级变化，适配层需要版本探测与降级路径。
- **成本口径**：`cost_usd` 是 CLI 内置价表估算，不是网关账单，面板与返回都会标注为估值。
- **长任务卡片不刷新**：同步工具在对话里只显示运行中，实时进度只在面板可见。

未决：

- 面板入口放在右侧栏还是侧栏。
- 是否增加后台模式（派发后不占用当前轮）。
- 会话记录的保留策略是否从「上限 100 + 手动删除」扩展为按时间自动清理。