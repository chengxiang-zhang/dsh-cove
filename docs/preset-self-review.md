# 预设自迭代（preset self-review）

许愿编程预设的改进不是靠「想一条规则」，而是靠机队上真实会话的读数。本页定义这条定时闭环：增量抽取 `code-vibe` 会话、按证据归因、改预设、过门禁，然后由用户放行发版与 rollout。

## 组成

| 部件 | 位置 | 职责 |
| --- | --- | --- |
| 抽取器 | 仓库 `scripts/wish-preset-review.mjs`（`pnpm wish-review`） | 只读地把各机器新增/变化的顶层 `code-vibe` 会话算成读数并出报告 |
| 游标 | `.harvest/wish-preset-review/state.json` | 记住已处理的 session 与 `updatedAt`，下一轮只补增量 |
| 报告 | `.harvest/wish-preset-review/<时间戳>/REPORT.md`、`sessions.json` | 人读的证据摘要与机读原始读数，均不入库 |
| 方法 | 预设技能 `preset-self-review` | 取证、归因、改预设、门禁、分发边界 |
| 触发器 | DSH 定时任务 | 每天在独立会话里跑一遍技能，没有证据就写「本轮无改动」 |

抽取器只统计顶层会话（`parentSession` 与 `origin` 为空）；子代理转录属于 worker 行为，不作为用户面向预设的证据。
远端只执行 `cat`（投放分析脚本）与 `python3`（流式解压并统计），不写、不改、不删，也不把整份转录传回本机。

## 手动运行

```sh
pnpm wish-review                 # 上次游标之后新增/变化的会话，窗口 7 天
pnpm wish-review --days 3        # 改窗口
pnpm wish-review --hosts pc-tower,zcx-t470p
pnpm wish-review --all           # 忽略游标重读窗口
pnpm wish-review --excerpt <host>:<会话文件绝对路径>
```

机器清单复用 `config/fleet-collect.local.json` 的 `machines`；某台机器离线时只记一条警告、其余照常出报告，默认仍以退出码 0 结束（加 `--strict` 才把离线算失败），长期离线的机器不会让每轮都变成失败。
报告为空是合法结果：没有任何新增会话时必须写「本轮无改动」，不得为交付编造规则。

## 读数口径

报告给出每台机器的会话数、轮次、工具调用、提问次数、含辱骂/质问的用户消息数、超十分钟的回合数、零工具回合数，以及策略层拒绝按原因计数。
这些读数只负责指出「值得打开看」的会话；是否构成预设缺陷，由 `preset-self-review` 技能按「同类失败至少两条会话」的判据裁决。

## 定时任务

定时任务由 DSH 会话调度器持有，每次以独立会话运行，提示词要求执行 `preset-self-review`：抽取 → 归因 → 改预设 → 门禁 → 汇总待放行的分发动作。
任务到期时如果服务未运行，调度器在下次启动后补一次；单次运行只处理窗口内的增量，不会重读全部历史。
需要调整时间、暂停或删除任务时，在任一 DSH 会话里让 agent 调用调度器（列出、改期、暂停均为会话级操作），不需要改仓库文件。

## 分发边界

- 抽取、归因、改预设、跑门禁：自动执行，提交到 `dev`。
- 发版（合入 `main`、打 tag、npm 发布）与机队 rollout：对外动作，必须由用户在当前会话明确放行；默认配置不含自动发版。
- 任何机器上的 DSH 服务重启都不由本闭环发起；重启窗口由用户决定。

## 与其它流程的关系

- 机器侧的预设改动仍按 [fleet-collection.md](fleet-collection.md) 回收进仓库；本闭环只处理「会话证据 → 预设」这一段。
- 预设的引用完整性门禁（签名、skill 路径、生成 patch）由 `node scripts/verify-preset-refs.mjs` 与 `node scripts/render-preset.mjs --check` 负责，二者随本闭环的每次改动一起跑。