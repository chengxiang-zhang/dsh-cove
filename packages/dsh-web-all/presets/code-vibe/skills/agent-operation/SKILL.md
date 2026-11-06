---
name: agent-operation
description: 代理使用纪律：模型路由（继承优先/同族换档）、委托判据（反割裂）、最小验证集与报告纪律；需要决定子代理档位、是否委托、或本地验证范围时加载。
---

# Agent Operation（代理使用纪律）

> 从 wish-programming v2 抽离的通用方法论块（原「模型路由」「拆分原则-委托判据」）。wish-programming 只保留许愿流程专属内容，此处为唯一住所。

## 模型路由

**默认继承，换能力靠换工具**——原则指导，不是死表。

- 默认：本地子代理（`subagent` / `subagent_fork`）**没有** `model`/`provider` 参数，天然继承本会话。拿不准就继承。
- 要换能力：两个外部委派工具按 `model` 选档 —— `subagent_codex` 省略 `model` 即 `gpt-6-astra`；`subagent_claude_code` 取 `kaon/claude-opus-5-5`（最强）/ `kaon/claude-sonnet-5-5`（均衡）/ `kaon/claude-haiku-5-5`（最快最便宜）。取值必须是 profile 为这个工具列出的 id，否则在参数校验层被拒。
- 换族（DeepSeek ↔ Codex ↔ Claude）等于**换工具**，不是传 `provider`：这两个工具都没有 `provider` 参数。
- 不要因为目录里还有别的族就随便跳；换族仅当用户点名，或任务明显依赖该族专长，并在回执里写明换了哪个工具、为什么。

| 任务倾向 | 建议 |
|---|---|
| 需求/设计/裁决/语义敏感/高风险 | 继承；需要外部强判断时 `subagent_codex` 或 `subagent_claude_code` + 强档 model |
| 机械切片 / 证据收集 / 回填（窄 I/O） | 继承；必要时 `subagent_claude_code` + `kaon/claude-haiku-5-5` |
| 开放式设计判断 | 不要丢给快档 |

## 委托判据（反割裂）

- subagent/workflow 只用于「不需要你的上下文就能执行的活」——照锁定规范机械实现、独立验收（fresh 上下文是优点）、并行可分的调研收集。
- **绝不委托**需求理解、设计决策、产品判断、方案收敛——它们靠主上下文活着，委托即割裂。
- 委托按认知边界拆，不按页面/文件拆；并行只在实现层。
- 保持委托树浅（depth-1 通常足够）；不在子代理内再委托，委派的 agent 完成任务后回报而非再委托。
- 直接执行是常态；单文件、无跨模块影响的平凡切片不需要子代理。

## 最小验证集

- 验证范围匹配改动范围：切片只跑本片门禁（lint / type-check / journey --assert）；重复跑已通过的检查是浪费。
- 全量重跑仅在全仓级变更、诊断 CI 或用户明确要求时。
- 本地钩子/检查刻意小而快；穷尽矩阵归 CI 或用户要求的全链演练。

## 报告纪律

- 只报告**实际运行**的命令与观察输出；重试/跳过/未运行不得描述为通过；pending 报 pending。
- 失败先修再交付，「不要指望换一个环境会不同」；环境差异必须用证据证明。
- 更多细节见 wish-programming「报告协议」与 `dsh-ci-test-reliability`（测试可靠性与防自欺报告条款）。
