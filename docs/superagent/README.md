# 秘书式 super-agent：产品形态与架构

这套文档定义 `packages/dsh-web-all` 里飞书秘书能力的产品形态与架构：它是什么、内核保证什么、新东西从哪里长进来。

文档边界等于模块边界。一个模块一份文档；写不出独立一份文档的东西，先改模块划分，不要塞进别的文档。

## 一句话

它不是"更聪明的 bot"，是一台可托管的承诺事务机；飞书只是它的一种接入通道（原 lark-inbox 已并入 `channels/feishu`），CLI 与 Web 同样接得进来：内核只保证四件事（每条消息有人负责、每件承诺不丢、时间会推、出口唯一）；"像秘书"的全部内容（接不接、什么时候说、怎么说、记什么、能碰哪些机器、谁能让它干什么）都挂在扩展点上，改这些不动内核。

## 权威顺序

1. [需求原话](00-需求原话.md)：老板原话逐字（22 条）与硬约束。只增不改。
2. [需求基线](01-需求基线.md)：R/G 编号需求、七步验收链、事实底座、待验证与已排除。
3. [协议](02-协议.md)：跨模块对象的形状、状态机、工具与错误码。唯一契约源。
4. 其余模块文档：平级，各自只讲自己的模块。
5. 任何转述与子代理产出：最低。

原话与正文冲突时以原话为准，冲突写进需求基线末尾的待裁定清单。

## 模块与文档

| 文档 | 模块 | 一句话职责 | 读者 | 变更频率 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| [02-协议](02-协议.md) | 协议 | 定义对象、状态机、工具与错误码 | 全体实现者 | 极低 | 无 |
| [03-内核](03-内核.md) | 内核 | 认领、账本、时钟、出口；账本唯一写入者 | 内核维护者 | 极低 | 协议 |
| [04-世界模型](04-世界模型.md) | 世界模型 | 范围路径、实体注册、能力声明、授权、归属 | 平台与安全 | 低 | 协议 |
| [05-记忆](05-记忆.md) | 记忆 | 追加日志、可见域函数、抽取器 | 数据与隐私 | 中 | 协议、世界模型 |
| [06-规则](06-规则.md) | 规则 | 三层规则、注册、冲突、回放、自迭代 | 产品与策略 | 高 | 协议、世界模型 |
| [07-桌子](07-桌子.md) | 桌子 | 把账本编译成案卷，跑模型回合，保证单一在场 | 模型侧 | 中 | 协议、内核、规则、记忆、世界模型、判断 |
| [08-判断](08-判断.md) | 判断 | 快路径、六道闸、翻译、派活、异议 | 产品与判断质量 | 高 | 协议、内核、规则、记忆、世界模型、执行体 |
| [09-时机与措辞](09-时机与措辞.md) | 时机与措辞 | 议程来源、注意力、简报、模板、命令、面板 | 产品与用户 | 高 | 协议、内核、规则 |
| [10-执行体](10-执行体.md) | 执行体 | 执行体模板、尝试、预算、结案、升级、观察器 | 执行侧 | 中 | 协议、内核、世界模型 |
| [11-恢复与降级](11-恢复与降级.md) | 恢复与降级 | 对账、租约、失败隔离与降级矩阵 | 运维与值班 | 低 | 协议、内核、桌子、执行体、世界模型 |

## 架构图

### 视图一：跑在哪（部署、进程与信任边界）

```
人类入口：飞书私聊 / 飞书群 / CLI / Web / API        ← 都只是通道，不是内核
                    │
                    ▼
channels/feishu（原 lark-inbox 并入）
  入站：归一、去重、写 inbox_events
  出站：send / react / audience / history
  不并入通道的平台件：feishu 域（应用凭据、bot 身份）、notify 域（运行结束推送）
                    │ inbound（event_id 幂等）
                    ▼
superagent 服务域（web-all 内唯一服务域；cordis.patch.yml 仍一行）
  kernel 四原语：claim → ledger → clock → outlet      ← 唯一写账本
    注入四个接口：ClaimPolicy · TickSignal · OutletPolicy · SenderPort
  desk（案卷、now 投影）        judgment（快路径、六道闸、翻译、派活）
  timing（议程、注意力、模板）  executors（画像、尝试、结案、升级）
  rules / memory / world        recovery（对账、租约、降级、第二声音）
  observability（读数、命令、面板渲染）
                    │ sessionController.create / prompt / cancel / inspect
        ┌───────────┴────────────┐
        ▼                        ▼
   桌子会话（9 个桌面工具）    执行体会话（画像工具 + report）
        │                        │ turn/end + report
        └──────────┬─────────────┘
                   ▼
        回到内核：结案判定 → 议程 → 桌子 → 出口
```

### 视图二：一句话怎么变成一件承诺（数据流）

```
① 老板说一句
        │
② 通道 inbound → 内核 claim（CAS）→ 写 intake（一条事件一个 owner）
        │
③ 内核请求回合 → 桌子编译案卷（now + 桌切片 + 本批）
        │
④ 桌子回合内：judge 归位 → commit 交办（意图/判据/边界/悬念/执行体/预算）
        │
⑤ 内核一个事务：commitment(open) + attempt(pending)
        ├──► outlet.say(ack) ──► 通道.send ──► 老板（≤30 秒，只说"接了"）
        └──► 执行体 dispatch：create 会话 + prompt(queue) → attempt=running
                    │
⑥ 执行体干活：report(progress/blocked/ready) 写 journal；宿主记 tool_calls/停滞/打转/预算
                    │
⑦ turn/end 到达 → 宿主结案判定（证据 ↔ check_kind；对不上=未验证）
                    │
⑧ 终态 → 议程触发下一回合 → 桌子 say(deliver)（≤100 词 + 证据）→ 老板
                    │
⑨ 老板补一句 → 快路径/模型判 amend → journal 追加 request_id → 执行体下回合消费（没消费不结案）
                    │
⑩ 老板说停 → 即时路径 release → cancel 尝试 → 回执写"停在哪一步、改动怎么办"
```

### 视图三：交互时序（三条即时路径不排队）

```
老板        通道         内核             桌子            执行体
 │ 说一句    │            │                │               │
 │──────────►│ inbound    │                │               │
 │           │───────────►│ claim(CAS)     │               │
 │           │            │───────────────►│ 起回合 + 案卷  │
 │           │            │◄───────────────│ judge / commit│
 │           │◄───────────│ say(ack)       │               │
 │◄──────────│ 一句受理    │ dispatch ──────────────────────►│ running
 │           │            │◄───────────────────────────────│ report / 事件
 │           │            │◄───────────────────────────────│ turn/end
 │           │            │ 结案判定 → 议程 → 桌子          │
 │           │◄───────────│ say(deliver) ──┘               │
 │◄──────────│ 交付+证据   │                │               │
 │ 说停      │            │ 即时路径 release → cancel ────►│
 │◄──────────│ 终止回执    │                │               │
```

三条不走时钟的即时路径：受理 ack、停止 release、派发失败终止句。时钟只负责"到点看一眼"与超时升级。

### 视图四：状态机

```
commitment   proposed ──► open ─────► fulfilled | unverified | broken
                │           │
                │           ├───────► at_risk ──► fulfilled | unverified | broken
                │           │            │
                └───────────┴────────────┴─────► released | withdrawn | orphaned
attempt      pending ──► running ──► ended（end_reason 原值；未知当失败）
outbox       queued ──► sent / failed / suppressed / folded
```

状态机的权威定义在 [协议](02-协议.md)：`open` 可直接结案（正常交付是 `open → fulfilled`），`at_risk` 只是中间态，`proposed` 可直接 `withdrawn`。

## 依赖方向

箭头指"依赖"：上层可以调下层，下层不知道上层。组合根 `index.ts` 只做装配与钩子接线，不属于任何模块。

```
                 组合根 index.ts（装配，不含业务）
                 │
   ┌─────────────┼──────────────────────────────┐
   ▼             ▼                              ▼
桌子 ────────► 判断 ────────► 执行体          时机与措辞
 │              │               │                │
 └──┬───────────┴───────┬───────┘                │
    ▼                   ▼                        ▼
  规则 ─────────────► 记忆 ─────────────► 世界模型
    │                   │                        │
    └───────────────────┴────────┬───────────────┘
                                 ▼
                              内核
                                 │
                                 ▼
                               协议
```

图是分层示意，只画主干；精确依赖以下表为准（例如规则不依赖记忆，规则与记忆不依赖内核，它们直接依赖协议与世界模型）。

精确的边（谁调谁，写死在模块接口上）：

| 模块 | 依赖 | 被谁依赖 |
| --- | --- | --- |
| 协议 | 无 | 全部 |
| 内核 | 协议 | 桌子、判断、执行体、时机与措辞、恢复与降级 |
| 世界模型 | 协议 | 记忆、规则、桌子、判断、执行体、恢复与降级 |
| 记忆 | 协议、世界模型 | 桌子、判断 |
| 规则 | 协议、世界模型 | 桌子、判断、时机与措辞 |
| 执行体 | 协议、内核、世界模型 | 判断、恢复与降级 |
| 判断 | 协议、内核、规则、记忆、世界模型、执行体 | 桌子 |
| 桌子 | 协议、内核、规则、记忆、世界模型、判断 | 恢复与降级 |
| 时机与措辞 | 协议、内核、规则 | 组合根（注入内核的出口策略） |
| 恢复与降级 | 协议、内核、桌子、执行体、世界模型 | 命令与观测 |

无环。两条硬规则：

- 内核不依赖任何模块，也不认识"秘书""飞书""模型"；它对上层只暴露四个接口（`ClaimPolicy`、`TickSignal`、`OutletPolicy`、`SenderPort`），由组合根接线。
- 只有内核写账本。其他模块都是提案者，提案经内核校验后落账；因此任何模块崩掉都不会写坏账本。

## 扩展点

| 扩展点 | 加什么 | 落点 | 生命周期 | 一个插件坏了会怎样 |
| --- | --- | --- | --- | --- |
| 能力 capability | 能力清单：范围、能力声明、执行体模板、完成判据、预算档 | `capabilities/<name>.ts` + `capabilities/index.ts` 一行 | 启动时加载并校验；重启生效 | 加载失败只拒这一个，其余能力照常；已派出的活由执行体侧继续 |
| 行为 behavior | 快路径规则、闸规则、议程来源、模板 | `rules/`（数据）、`timing/`（来源）、`surface/`（模板） | 规则热加载；来源与模板随重启 | 规则用最后一份通过校验的快照；来源坏了只是少一种主动，不阻塞对话 |
| 记忆结构 memory | 新记忆类型的抽取器、字段、默认可见域 | `memory/types/<name>.ts` + 一行注册 | 启动时注册；抽取异步 | 该类型的抽取丢弃并记一次失败，检索与其他类型不受影响 |
| 执行体 executor | 执行体画像（provider、model、effort、工具面、预算） | `executors/profiles/<name>.ts` + 一行注册 | 启动时注册；派活时按名取 | 该画像派活失败 → 升级规则换档；不影响已跑会话 |
| 世界适配器 world adapter | 机器与仓库的发现、注册、续租来源 | `world/adapters/<name>.ts` + 一行注册 | 启动时注册，按周期跑 | 适配器只产出 proposed；坏了就停止发现，已有实体与授权不变 |
| 通道 channel | 一种人机入口：飞书私聊/群、CLI、Web、API | `channels/<name>.ts` + 一行注册 | 启动时注册；断线重连 | 通道断了只是这个入口不可用；账本与执行体不受影响 |

## 加一个能力：两个实例

### 实例一：帮我盯 CI 并汇报

新增两个文件，一处注册，内核零改动：

1. `capabilities/ci-watch.ts`：声明能力清单 `CapabilityManifest { name, scopes, capabilities, executor, checkKind, budget }`——`name: 'ci-watch'`；范围 `local/<repo>` 与 `netbird/<host>/<repo>`；需要的能力 `read`；执行体模板 `oneshot-read`；完成判据 `observation`（看哪个字段、阈值多少）；预算档 `small`；并实现 `probe(target) → Reading[]`（读 CI 状态接口）。
2. `capabilities/index.ts` 加一行注册。
3. 一条行为规则，走 config 通路：`rules/config/ci-watch.json`，带 `provenance=config`、`approved_by=owner`、`version=1`。这不是第四条通路，就是三条通路里的 config——文件只是 config 的载体。

链路：老板说"盯一下 CI"→ 判断开一件 `watch` 承诺（`target` 是仓库，`check_kind=observation`）→ 时机按 10 分钟周期调 `probe` → 有信号（红/绿变化、超时）才请求回合 → 简报一行。全程没有新增协议对象、枚举、工具，也没有改内核。

### 实例二：帮我记流水账

新增两个文件，一处注册：

1. `memory/types/ledger-entry.ts`：实现 `extract(trigger)`——从老板原话（"今天花了 320 买书"）抽出结构化条目，声明 `kind` 默认可见域（只有老板），并声明它参与哪类检索。
2. `memory/types/index.ts` 加一行注册。

如果还要"月底汇总"，那是能力不是记忆：`capabilities/monthly-ledger.ts` 声明一个只读执行体模板与完成判据，加一行注册。记忆结构只负责"记什么、谁能看"，汇总由能力层做。

## 能承载未知：两个半年后可能会加的东西

| 半年后可能会加 | 靠什么承载 | 要不要重构 |
| --- | --- | --- |
| 替老板跟外部客户做多轮排期协商 | 新行为策略（协商对话策略）+ 新能力清单（外部渠道）+ 新记忆类型（协商状态）；账本里它仍是一串 `deliver` 承诺与 `pushback` 记录 | 不要。协议已有承诺与假设；内核只多几条出口提案 |
| 预算型长期项目（多周、多个子目标） | `goal` 承诺 + `parent_id` 子承诺 + 新的规划策略；预算列已存在 | 不要。状态机与预算字段本就通用 |
| 换一个 IM（企微/飞书国际版） | 新 `SenderPort` 与新的入站归一（`inbound` 事件），世界模型加一个 realm | 不要。出口与事件是内核接口，不是飞书分支 |
| 面板 UI | `status --json` 的只读渲染层 | 不要。它不产生新状态 |

## 一个人 → 一群人

| 层 | 单人私聊 | 拉群 / 承接他人 | 变吗 |
| --- | --- | --- | --- |
| 协议 | 承诺有 creditor、on_behalf_of | 同一对象承载两个回执 | 不变 |
| 内核 | 一桌一事件一口 | 同一套认领与出口 | 不变 |
| 世界模型 | 受众=老板 | 受众快照、同事与外部人、群路径 | 加数据，不改结构 |
| 记忆 | use=say=老板 | use 与 say 分离、升公共走批量批 | 加策略，不改结构 |
| 判断 | 单主闸 | 双主三态闸 + 越界二次批 | 加规则与闸，不改流程 |
| 桌子 | 私聊桌 | 群桌、受众快照进案卷 | 加一种桌画像 |
| 时机与措辞 | 私聊额度 | 群回复的回执去向、身份前缀 | 加模板与策略 |

结论：内核与协议不变；变的是数据（受众、授权）与策略（记忆可见域、双主闸）。这就是"扩展不是重写"的机械含义。

## 代码布局

```
packages/dsh-web-all/src/host/services/superagent/
  protocol/{objects,tools,events,db}.ts      对象、工具、事件、唯一 DDL
  kernel/{claim,ledger,clock,outlet,index}.ts 四原语
  world/{paths,registry,mandate,adapters/}.ts 范围、实体、授权
  memory/{log,visibility,types/}.ts           日志、可见域、抽取器
  rules/{registry,engine,replay}.ts           规则数据、判定、回放
  desk/{dossier,turn,presence}.ts             案卷、回合、单一在场
  judgment/{route,gates,translate,dispatch,pushback}.ts
  timing/{agenda,attention,brief}.ts          议程、注意力、简报
  surface/{templates,commands,panel}.ts       模板、命令、面板
  executors/{profiles,attempts,closure,escalate,probes/}.ts
  recovery/{reconcile,lease,degrade}.ts
  channels/feishu/{inbound,send,react,audience,admin/}.ts  飞书通道（原 lark-inbox 并入）
  channels/                                    其它入口：CLI、Web、API
  capabilities/                               能力插件
  index.ts                                    组合根

scripts/superagent-check.mjs                  七步链机械检查（只读账本），归恢复与降级
```

挂载：用 `superagent` 一个服务域替换现在 `host/services/index.ts:66` 的 `lark-inbox` 挂载，服务域数量不变；`cordis.patch.yml` 保持恰好一行 `- id: web-all`（F22）。上线需要用户重启 DSH 服务后生效，本仓库任何流程不重启 3080（F23）。

## 三条阅读路径

- 判断值不值得做（老板与评审）：[需求基线](01-需求基线.md) → [内核](03-内核.md) → [桌子](07-桌子.md) → [恢复与降级](11-恢复与降级.md)。
- 要动手实现：协议 → 内核 → 世界模型 → 记忆 → 规则 → 桌子 → 判断 → 时机与措辞 → 执行体 → 恢复与降级。
- 要加一个能力：本页"加一个能力" → [世界模型](04-世界模型.md) → [执行体](10-执行体.md) → [规则](06-规则.md)。

## 文档纪律

1. 一份文档 ≤300 行；超过就说明模块没切好。
2. 引用写契约名（`Ledger.append`、`Commitment.state`），不写"见某章某节"：看不见的章节引用就是耦合。
3. 只写当前状态；被推翻的假设留在需求基线"已排除"，不写版本史。
4. 每份文档必须有：职责、边界、契约、依赖方向、扩展点、失败模式、读数。
5. 同一事实只在一个模块里写；别处只引用契约名，不重复解释。