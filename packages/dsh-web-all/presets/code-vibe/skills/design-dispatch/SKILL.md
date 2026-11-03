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

**不派**：设计已冻结后的执行、单文件可回滚小修、纯事实查询、能用一条命令取到读数的问题。

## 1. 三个工具

| 工具 | 通道 | 模型 | 何时用 |
|---|---|---|---|
| `subagent_astra` | ChatGPT **订阅**（原生 OAuth） | `gpt-6-astra` | **默认**，设计/评审首选 |
| `subagent_astra_kaon` | kaon-router `/v1/responses` | `kaon/gpt-5.5` | 订阅不可用时兜底 |
| `subagent_opus55` | kaon-router（Claude Code 侧无订阅通道） | `kaon-rp/claude-opus-5-5` | 默认并行的第二路 |

- 默认组合：`subagent_astra` + `subagent_opus55` **并行两路**。
- 降级判据（自动执行，不许静默）：`subagent_astra` 返回 429 / 配额耗尽 / `model_not_found` / 认证失效 → 换 `subagent_astra_kaon`，**并在回执里写明"已降级"**。
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
- 任一失败 → **报告缺件并停下**，不要悄悄退化成单路或本地自评。
- 装完不需要重启 DSH（patch 热重载），三个工具在**下一次请求**出现在工具表里。

## 3. Design Packet（派发内容必须自包含）

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
- 外部 agent 声称的事实要进证据链，**必须由本机复跑命令**确认。
- 回执必带：用了哪个工具、走哪条通道（订阅 / kaon）、耗时、`usage` token、失败与降级记录。

## 6. 已知限制（别当全能）

- **one-shot**：不支持续接与中途 steer；要追问就重新打包一次。
- **只回最终文本**：中间推理、工具调用过程看不到，过程质量不可审计。
- claude 侧经网关的 `total_cost_usd` 是本地价目表估算，**不可用于计费**，只认 `usage` token。
- codex 走 kaon 会多一条 `Model metadata … not found` 警告，cosmetic，不影响出答案。
- 这些 agent 写文件的能力取决于 ACP `permission`（当前 `allow`）：派发时必须在包里写清写域，不要让它们越界改仓库。