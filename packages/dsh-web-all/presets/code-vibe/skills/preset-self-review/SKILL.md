---
name: preset-self-review
description: Use when reviewing real sessions to improve the wish-programming preset itself, including the scheduled self-iteration pass. Turns transcript evidence into persona or skill changes, then hands the release and rollout to the user. Triggers: 预设自迭代, 会话复查, 执行纪律复盘, 改进预设, 定时复查, preset self-review.
---

# Preset self-review（预设自迭代）

把一个时间窗口内的真实会话变成对预设的**一处**可复核改动；没有证据就写「本轮无改动」。
本技能只负责「取证 → 归因 → 改预设 → 过门禁」；**发版与 rollout 是对外动作，必须等用户明确放行**。

## 1. 取证（机械，不读全文）

```sh
pnpm wish-review                 # 增量：上次游标之后新增/变化的顶层 code-vibe 会话
pnpm wish-review --days 3        # 换窗口
pnpm wish-review --all           # 忽略游标，重读整个窗口
```

报告落在 `.harvest/wish-preset-review/<时间戳>/REPORT.md`（`sessions.json` 是同一批原始读数）。
游标是 `.harvest/wish-preset-review/state.json`：同一 session 的 `updatedAt` 变了才算「变化」，所以长会话每轮只补增量。
机器清单来自 `config/fleet-collect.local.json` 的 `machines`；只统计顶层会话（`parentSession`/`origin` 为空的 `code-vibe`），子代理转录不算用户面向的预设行为。

要看某条会话的原文，用报告里的取证命令：

```sh
pnpm wish-review --excerpt <host>:<session 文件绝对路径>
```

## 2. 归因（判据写在前面）

用户骂人只是信号，不是结论。按下面顺序读，**同类失败至少两条会话（或一条会话 + 一条可复现探针）才许改预设**：

| 现象（报告里的读数） | 可能的规则缺口 | 优先看 |
| --- | --- | --- |
| `asks >= 3`、ask 内容是可回滚的工程选择（打镜像、重打 tag、改锁、改 CI、合并、推送、选文件/表/版本） | 提问判据太宽，或某条规则把工程决策列成了授权点 | persona 的决策点/授权条款 |
| 先问后做：进门就问「从哪条线继续」，文档还没读 | 开工判据缺失 | persona 的「先读/先做」条款 |
| `user-rage` 且用户问「为什么停/为什么空跑」 | 「停下报告」被当成合法回合收尾 | 回合收尾条款、LOOP BUDGET |
| `long-turn`、`idle-turn`：一轮几十分钟、有轮次零工具 | 一次做一点、串行等待 | 派工/并行条款 |
| `emptyTurns` 高但 `toolCalls` 也高 | 反复试探、没有验收判据的推进 | 关键路径条款 |
| 改动写进别人的脏工作树 / 跨仓判断 | 工作区所有权没有机械约束 | 工作区/仓库边界条款 |
| 编造证据（没读就说读过、拿旧文件冒充） | 证据条款只有承诺、没有必填锚点 | 证据与回读条款 |

读原文时只摘三样：用户原话、模型当时的话、读数。**不要把报告里的摘要当原文引用**。

## 3. 改预设

- 一个缺陷对应**一句**改动；优先替换或删除旧句，避免在 persona 里继续堆规则。
- 改之前先搜冲突：同一件事在 persona、skill、文档里可能已有相反写法，改一处必须把另一处收口。
- 机械可查的约束才值得写进规则（可逆测试、允许/禁止清单、必填证据字段）；「要更努力」这类话不进预设。
- 落到 `packages/dsh-web-all/presets/code-vibe/`（persona 在 `agent.cordis.yml`，流程在对应 `skills/<name>/SKILL.md`），然后 `node scripts/render-preset.mjs` 重新生成 loader patch。

## 4. 过门禁（缺一不可）

```sh
node scripts/render-preset.mjs --check
node scripts/verify-preset-refs.mjs
pnpm test:scripts
pnpm --filter @dsh-cove/dsh-web-all test
pnpm docs:check          # 只有改了文档才需要
```

改动提交到 `dev`，提交信息写清「哪条会话证据 → 哪句话 → 期望行为」。行为改变要有可复核的判据（测试、负控或重放），否则只能写「方向性」，不能写「已验证」。

## 5. 分发（等人）

发版和 rollout 会换掉所有人的预设，属对外动作：

1. 汇总「本轮改了什么、证据在哪、需要哪个版本号」；
2. 等用户一句放行（默认不带自动发版）；
3. 放行后按仓库发版流程走 `dev → main → tag → GitHub Actions`，再 `pnpm fleet:rollout --version <v> --apply --only <机器>`；
4. 不重启任何机器上的 DSH 服务；重启窗口由用户决定。

## 6. 收尾

- 有改动：在报告末尾写一节「本轮改动」，列出证据 session、改的文件、门禁读数、待放行的分发动作。
- 无改动：写「本轮无改动」并说明看了哪些读数；**不许为交差编一条规则**。
- 每轮结束把会话窗口、改或不改、原因留在同一份报告的末尾，下一轮从游标继续。