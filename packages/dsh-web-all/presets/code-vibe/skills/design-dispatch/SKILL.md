---
name: design-dispatch
description: 把复杂设计/排障/独立评审任务派发给外部强 agent（codex+astra、claude code+opus 5.5）拿独立结论再合成；Use when a design needs a second/third independent judgement, an ADR/freeze is about to be written, or local analysis keeps converging on the same answer without new evidence.
---

# 外部强 agent 派发（Design Dispatch）

> 定位：`design-orchestrator` / `task-router` 的**执行臂**，不是新的设计方法论。
> 它只解决一件事：把一份自包含的包交给更强的 agent，拿回**可对抗的独立结论**。
> 质量来自「多份互不知情的结论互相打架」，不来自把它们串起来互相确认。

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

## 1. 三个工具

| 顺序 | 工具 | 通道 | 模型 | 何时用 |
|---|---|---|---|---|
| 1 | `subagent_astra` | ChatGPT **订阅**（原生 OAuth） | `gpt-6-astra` | **默认**。架构/选型/新结构/跨模块契约/复杂排障根因未知，一律先走这个 |
| 2 | `subagent_opus55` | kaon-router（Claude Code 侧无订阅通道） | `kaon-rp/claude-opus-5-5` | **订阅断了的第一个替补**（429/配额耗尽/认证失效），也用于需要它自己多处翻找的探查型任务 |

- **默认只跑一路**，按任务形态选（2026-11-03 实测）：
  - 单文件/结构化审阅、结论型判断 → `subagent_astra`：1 turn、32.6s、非缓存输入约 1.7 万 token；
  - 需要它自己在仓库里多处翻找的探查型任务 → `subagent_opus55`：会自己开到 9 turn / 70.8s，输入侧约 37.6 万 token。
- **两路并行不是默认值**。只有第二路带**不同的攻击切片**（不同约束集、不同反例方向）时才并行；
  同一份 packet 跑两路，实测边际新发现为 0，成本翻倍。第二路连续 N 次 unique-finding=0 就砍掉。
- 降级阶梯（自动执行，但每一次降级都要在回执里写明）：
  1. `subagent_astra` 失败（429 / 配额耗尽 / `model_not_found` / 认证失效）→ **直接换 `subagent_opus55`**；
  2. 两条都不可用 → 停止派发，改本地执行，并在结论里标注质量已降级（这是 §2 里"停下"的唯一条件）。
  Codex 侧**不接 kaon**：订阅不可用就换 claude，不做同引擎换计费。
- 模型已知边界：`gpt-6-astra-pro` 在订阅账号下不被支持（400）；`kaon/gpt-6-astra` 在 kaon 侧无路由；claude 侧只有 `kaon-rp/claude-opus-5-5` 前缀可用（`kaon/claude-opus-5-5*` 会被 CLI 400 拒）。

## 2. 装机（每台机器一次）与 preflight（每会话一次）

```sh
# 装机：装 adapter + 落探针与兜底壳 + 追加 profile 的三个工具行 + 跑 preflight
sh <preset-root>/skills/design-dispatch/scripts/install.sh

# 之后每次会话首次派发前，只跑 preflight
sh <preset-root>/skills/design-dispatch/scripts/preflight.sh          # 三条通道全查
sh <preset-root>/skills/design-dispatch/scripts/preflight.sh codex    # 只查订阅
```

- `install.sh` 幂等：重复跑不会重复加行；`--check` 只体检不改动；`--uninstall` 只摘 profile 块（不删 adapter）。
- 非默认 profile：`--profile-dir <dir>`；非默认根目录：`--root <dir>`；换模型：`--astra-model/--kaon-model/--opus-model`。
- `PREFLIGHT_ALL_OK` = 三通道都 `stopReason=end_turn`。退出码 1 = 通道不可用，2 = 机器前置缺失。
- 读取 preflight 的方式是**按通道**，不是一刀切：两路都绿 → 正常并行；只剩一路 → 单路运行并在回执标注；
  **三路全红才停下**并报告缺件。preflight 红一条就把整个方案停掉，等于把可用的通道也废了。
- 生效方式按仓库契约写，不许夸口：本机实测 profile patch 热重载后三个工具在**下一轮请求**可见；若下一轮工具表里没有它们，**按仓库 AGENTS.md 标注「需要用户重启 DSH 服务后生效」并交给用户重启**，不要声称已经可用。

## 3. Design Packet（派发内容必须自包含）

**先批处理，再派发**：实测固定开销占 98% 以上（claude 回 3 个 token 也要 48,704 输入），
所以把三个问题合成一次派发，比派三次省接近 3 倍。不要一问一派。

六个必填段，缺一段就是浪费一次强模型调用：

1. **问题陈述**：原话锚定，不改写、不提前下结论。
2. **硬约束**：不可动的边界、兼容性、时间窗、不允许碰的面。
3. **已知事实与证据**：每条带命令、读数或 `文件:行`；未验证的猜测必须显式标注"未证实"。
4. **输入面清单**：允许读的路径（默认只读）；要写就把写域写死。
5. **产出结构**：要求的小节标题与顺序，禁止自由发挥。
6. **判据与自证**：它必须逐条回答的判据；并要求它单独列 `needs-decision`（需要人拍板的点）。

禁止写进包里的：把我们的结论当既定事实、让它决定不可逆操作、要求它"同意我们"。

## 4. 并行与红队

- 两路**互不给对方结论**（fresh context 是质量来源，不是浪费）。
- 收齐后按三分法切：**共同结论**（大概率对，仍要复跑验证）、**分歧点**（真问题）、**单边独有**（待验证，不许直接采信）。
- 分歧点回派一次**反方**：明确要求"找理由推翻 X"，不是"再看看 X"。
- 红队只有一次配额：第二次还是同一个分歧 → 说明缺证据，去取读数，不要再派。

## 5. 结果处理（不许照抄）

- 外部结论只是**输入**；最终裁决由 Lead 写，并区分 **已证实 / 推断 / 未证实**。
- **复现才算证实**：每条 finding 只有在本地复现（一条命令，或 `file:line` 在该 sha 上成立）后才计入结论；
  复现不了的写进"未证实"，**不是**驳回也不是采信。
- **派发默认只读**（`permission: allow` 不等于邀请它写）。派发后 `git status --porcelain` 必须为空；
  非空说明它越界写了，按事故处理。
- 回执必带：用了哪个工具、走哪条通道（订阅 / kaon）、耗时、`usage` token、失败与降级记录，以及一行 `escalation_reason`（判据不完备 / 订阅不可用 / 需要外部视角）。
- **质量门只信确定性信号**：schema 是否合规、它引用的东西是否真的出现在上下文里、算术能不能重算。**不信它自报的置信度**，也不信行文是否自信。
- **对"被接受的结论"抽样复核**：便宜档/单路给出的、被你采纳的结论，要按比例回派一次或本机复跑。自洽的错最贵，而且门抓不到。
- **看 `escalation_reason` 的分布**：多数失败是"packet 没写清"就改 Packet，不是多派强模型；升级率失控时先怀疑门太严。

## 6. 已知限制（别当全能）

- **one-shot**：不支持续接与中途 steer；要追问就重新打包一次。
- **只回最终文本**：中间推理、工具调用过程看不到，过程质量不可审计。
- claude 侧经网关的 `total_cost_usd` 是本地价目表估算，**不可用于计费**，只认 `usage` token。
- codex 走 kaon 会多一条 `Model metadata … not found` 警告，cosmetic，不影响出答案。
- 这些 agent 写文件的能力取决于 ACP `permission`（当前 `allow`）：派发时必须在包里写清写域，不要让它们越界改仓库。