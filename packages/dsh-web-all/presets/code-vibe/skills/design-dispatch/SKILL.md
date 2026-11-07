---
name: design-dispatch
description: 把复杂设计/排障/独立评审任务派发给外部强 agent（subagent_codex = codex CLI + gpt-6-astra；subagent_claude_code = claude CLI + kaon/claude-opus-5-5）拿独立结论再合成；Use when a design needs a second/third independent judgement, an ADR/freeze is about to be written, or local analysis keeps converging on the same answer without new evidence.
---

# 外部强 agent 派发（Design Dispatch）

> 定位：`design-orchestrator` / `task-router` 的**执行臂**，不是新的设计方法论。
> 它只解决一件事：把一份自包含的包交给更强的 agent，拿回**可对抗的独立结论**。
> 质量来自「多份互不知情的结论互相打架」，不来自把它们串起来互相确认。

- **冷通道先探针**：`subagent_codex` / `subagent_claude_code` 中途失联时，先发一条无 packet 的 `PING`；回 = 通道热、问题在 packet；不回/超时 = 通道冷，换通道或解封，不要靠反复重写 packet 硬试。
## 0. 何时派（不命中就不派）

命中任一即派：

- L3 系统设计，或 `task-router` 判 D4=2 需要用户拍板 → 至少两份独立结论；
- 结论要写进 `adr/` 或 `freeze.md`，事后返工代价高；
- 本机模型连续两轮给出同质结论、没有新证据；
- 排障进入假设收敛期，需要外部视角破坏当前假设；
- 跨仓/跨团队的架构裁决，需要 maker≠grader 的第三方。

**不派**：设计已冻结后的执行、纯事实查询、能用一条命令取到读数的问题、以及**能用机械判据验收的小改动**。

**一致性/交叉引用/契约审计不派 S**：这类活先让一个 fresh 的本地 subagent 自查（`subagent`，同栈不同上下文），
实测它在同一份文件上找出 3 条真缺陷，而两路 S 只重合到 1 条，成本是 S 的零头。S 只用于需要**外部知识或不同训练分布**的判断。

**按爆炸半径判，不按文件数判**：单文件但动 `access-trust/`、release workflow、权限/信任围栏、数据删除路径
—— 派一次 S 复审；单文件且纯展示层 —— 不派。

## 1. 两个委派工具（外加两个控制工具）

派发面只有两个委派工具：**选哪个工具就是选 provider**，`model` 是唯一档位参数，取值必须是 profile 为这个工具列出的 id。

| 顺序 | 工具 | CLI | `model` | 何时用 |
|---|---|---|---|---|
| 1 | `subagent_codex` | codex CLI（本机原生登录） | 省略 = profile 默认 `gpt-6-astra`；`gpt-6-astra-pro` 当前账号 400 | **默认档**。架构/选型/新结构/跨模块契约/复杂排障根因未知：结构化审阅与结论型判断 |
| 2 | `subagent_claude_code` | claude CLI | `kaon/claude-opus-5-5`（最强，也是默认）/ `kaon/claude-sonnet-5-5`（均衡）/ `kaon/claude-haiku-5-5`（最快最便宜） | codex 不可用时的**替补**；需要它自己在仓库多处翻找的探查型任务；窄 I/O 用 haiku |

控制工具（查状态、等一轮、关会话）：`external_session_list(status?)` / `external_session_wait(session_id, timeout_ms?)` / `external_session_stop(session_id)`。

**派发不占住回合**：两个派发工具都有 `wait_ms`（默认 15000、上限 600000）。窗口内结束就直接拿结论；没结束的回 `status: running` 加 `progress`（`elapsed_ms` / `idle_ms` / `frames` / `chars` / `tail`）。这时**不要干等**：继续做本轮的其它切片，用 `external_session_wait` 取回，或先看 `external_session_list` 的 `running` 判断它是在跑还是静默。

- **默认只跑一路**，按任务形态选：结构化审阅与结论型判断走 `subagent_codex`；需要它自己在仓库里多处翻找的探查型任务走 `subagent_claude_code`（这类它会自己开到多轮，输入侧远大于单轮审阅）。一轮实测 3 到 32 分钟，所以派发一律先派、后收，不派完干等。
- **两路并行不是默认值**。只有第二路带**不同的攻击切片**（不同约束集、不同反例方向）时才并行；
  同一份 packet 跑两路，实测边际新发现为 0，成本翻倍。第二路连续 N 次 unique-finding=0 就砍掉。
- `status: running` 不是失败，也不是结果：按上面的协议收，别把它当没答而重派一遍（同一份 packet 重派是双倍成本）。
- `partial: true` 表示这是被取消 / 停滞 / 超时那一轮的已产出文本，不是完整答案：可以拿来决定下一步，但不能当结论引用。
- 降级阶梯（自动执行，但每一次降级都要在回执里写明）：
  1. `subagent_codex` 失败（`400` / `429` / `auth-required`）→ **直接换 `subagent_claude_code`**（`model: kaon/claude-opus-5-5`）；
  2. 两个都不可用（`provider-missing` / 反复 `auth-required`）→ 停止派发，改本地执行，并在结论里标注质量已降级（这是本 skill 里唯一允许停下的条件）；
  3. `turn-stalled` / `turn-timeout` → 按 `partial` 里已有的文本决定下一步：续同一 `session_id` 补完，还是拆小重派。
- 模型已知边界：`gpt-6-astra-pro` 当前账号不支持（400）；claude 的 opus 类模型要求 Claude Code ≥ 2.1.280（2.1.318 实测返回 `anthropic/claude-opus-5.5`，老版本同一条命令 400）；不在 profile 目录里的 id 会在参数校验层被拒，**不会静默换档**。

## 2. 没有装机步骤，只有 preflight（每会话首次派发前一次）

```sh
# 查两个 CLI、实体行与挂载状态；不产生模型调用，不花 token
sh <preset-root>/skills/design-dispatch/scripts/preflight.sh
sh <preset-root>/skills/design-dispatch/scripts/preflight.sh codex    # 只查 codex 侧
sh <preset-root>/skills/design-dispatch/scripts/preflight.sh claude   # 只查 claude 侧
```

- 这两个工具由**实体 Loader 行**注册（profile 的 `web-all` → `config.externalSession`）：不写 profile、不装 adapter。旧的 `install.sh` 与 ACP 探针已随 ACP 通道退役，不要再按老文档装机。
- preflight 退出码：0 两侧可用；1 有一侧不可用（CLI 缺失 / 未登录）；2 机器前置缺失（两个 CLI 都没有，或 profile 里没有 `externalSession` 配置）。
- 读数**按侧读**，不一刀切：两侧绿 → 正常并行；只剩一侧 → 单路运行并在回执标注；**两侧全红才停下**并报告缺件。preflight 红一条就把整个方案停掉，等于把可用的通道也废了。
- 生效方式按仓库 `docs/hmr.md` 判定，不许夸口：宿主/客户端代码构建后由一次 profile 重组热替换，保存 `cordis.patch.yml` 本身不触发；只有变更落进进程静态图或不受 Loader 管理时才需要重启。只有工具真的出现在下一轮请求的工具表里才算可用；没出现，就标注实际需要的动作（重组 / 刷新页面 / 重启）并交给用户。

## 3. Design Packet（派发内容必须自包含）

**先批处理，再派发**：实测固定开销占 98% 以上（claude 回 3 个 token 也要 48,704 输入），
所以把三个问题合成一次派发，比派三次省接近 3 倍。不要一问一派。

六个必填段，缺一段就是浪费一次强模型调用：

1. **问题陈述**：原话锚定，不改写、不提前下结论。
2. **硬约束**：不可动的边界、兼容性、时间窗、不允许碰的面。
3. **已知事实与证据**：每条带命令、读数或 `文件:行`；未验证的猜测必须显式标注"未证实"。
4. **输入面清单**：允许读的路径（默认只读）；要写就把写域写死（§5 的 `写域=` 形态）。
5. **产出结构**：要求的小节标题与顺序，禁止自由发挥。
6. **判据与自证**：它必须逐条回答的判据；**断言按 §5 的 `claims.jsonl` 格式另存一份**（否则要 Lead 手抄一遍才能评分）；
   并要求它单独列 `needs-decision`（需要人拍板的点）。

禁止写进包里的：把我们的结论当既定事实、让它决定不可逆操作、要求它"同意我们"。

## 4. 并行与红队

- 两路**互不给对方结论**（fresh context 是质量来源，不是浪费）。
- 收齐后按三分法切：**共同结论**（大概率对，仍要复跑验证）、**分歧点**（真问题）、**单边独有**（待验证，不许直接采信）。
- 分歧点回派一次**反方**：明确要求"找理由推翻 X"，不是"再看看 X"。
- 红队只有一次配额：第二次还是同一个分歧 → 说明缺证据，去取读数，不要再派。

## 5. 结果处理（不许照抄）

- 外部结论只是**输入**；最终裁决由 Lead 写，并区分 **已证实 / 推断 / 未证实**。
- **写域由 packet 声明，不由工具权限决定**：`§4 输入面` 写 `只读`（默认）或 `写域=<路径>`（直接写产物）；
  写域外任何改动按事故处理——派发后 `git status --porcelain` 对的是"域"，不是"空"。
- **断言进 `claims.jsonl`，由脚本判定**：每条 `file:line` / 命令结论写一行（格式见 `scripts/verify-claims.mjs`
  头注释，单一真源），`node scripts/verify-claims.mjs --claims <f> --report <md>` 本机复跑，只有
  `verified|unverified` 两态；**未过的一律不许进结论**，`--report` 产出"未证实"清单贴回产物。
  质量门只信这种确定性信号，不信它自报的置信度或语气。
- **写的人不当评分人**：评分 = `verify-claims.mjs` + 一次独立复跑；所以"全程只读、Lead 重抄正文"不再是
  默认——它把抄写和评分压在同一个人身上。
- 回执必带：用了哪个工具、`model` 是哪个、耗时、`usage` token、**写域内写了哪些文件**、失败与降级记录，以及一行 `escalation_reason`（判据不完备 / 委派工具不可用 / 需要外部视角）。
- **看 `escalation_reason` 的分布**：多数失败是"packet 没写清"就改 Packet，不是多派强模型；升级率失控时先怀疑门太严。

## 6. 已知限制（别当全能）

- **one-shot**：不支持续接与中途 steer；要追问就重新打包一次。
- **只回最终文本**：中间推理、工具调用过程看不到，过程质量不可审计。
- claude 侧经网关的 `total_cost_usd` 是本地价目表估算，**不可用于计费**，只认 `usage` token。
- 这些 agent 写文件的能力由 CLI 自己的设置决定（claude：`~/.claude/settings.json`；codex：本机配置）：派发时必须按 §5 在包里写清写域，不要让它们越界改仓库。