# 施工包（Spec Pack）模板

> 目的：**一个 fresh agent 只读「本包 + 接口冻结表」就能开工**，不需要读别人的包、不需要猜接口、不需要改账本。
> 五件必填；按风险另加 `optional/`（威胁模型、迁移设计、窗口材料）。

## 目录形态

```
docs/specs/<spec-id>/          # 总纲（可选，但 >5 个包时强烈建议）
  VERSION.md  contract.md  tests.md  plan.md  run.md
  INDEX.md  INTERFACES.md  INTEGRATION.md  EFFICIENCY.md
  EXECUTION-LOOP.md  BATCH-STATE.md  HANDOFF.md      # 长跑三件，见 agent-team-project-loop

docs/specs/<id>-m0-<slug>/     # 模块包，一包一模块
  VERSION.md  contract.md  tests.md  plan.md  run.md
  optional/threat-model.md  optional/migration-design.md  evidence/
```

---

## VERSION.md

```markdown
# Version · <id>

| 字段 | 值 |
|---|---|
| **ID** | `<id>` |
| **标题** | … |
| **状态** | `ready` |
| **Delivery Target** | `code-ready` |
| **Requirements Lock** | `open` |
| **产品决定依据** | `<plan>` + `<ledger>` §0 |
| **创建日期** | YYYY-MM-DD |
| **目标环境** | …（只列真实存在的环境） |

状态只用：`draft | ready | in-progress | verifying | blocked | done | archived | cancelled`。
Delivery Target 只用：`code-ready | dev-effective | production-delivered`。

## 本包的文件
| 文件 | 作用 |
|---|---|
```

## contract.md

```markdown
# Contract · <id>

## 一句话目标
<施工者拿到一个包 + 接口冻结表，就能独立完成一个模块的改造并在自己的测试上证明成立>

## 入口事实映射（硬前置）
| 入口 | actor | 业务实体/表关系 | 可信路径如何派生 | 代码调用点 | 越权反例 | 证据级 |
|---|---|---|---|---|---|---|

## 用户 Job
作为 **<施工 subagent>**，在 <接到一个包> 的情境下，我要 <只读本包就能开工并按 TDD 证明>，从而 <可并行施工且拼装不接口错配>。

## Requirements
| ID | 要求（可判定） | 越权/失败反例 |
|---|---|---|

## 复核前置（阶段 0 判定，由本包执行者当场自证）
- 本包关联账本条目：`GAP-a` `GAP-b`
- 判定：`仍存在`（证据：`<命令>` ⇒ `<读数>`）
- 旧台账/旧进度口径**不是判据**，执行者必须用自己的读数覆盖。
```

## tests.md

```markdown
# Tests · <id>

| ID | Type | 层 | Channel | 标题 |
|---|---|---|---|---|
| T-001 | success | L0 | 本地 | … |
| T-002 | failure | L0 | 本地 | 负控：注入缺陷必须变红 |

## 执行约束
- 全部可离线执行的部分不得动环境；需窗口的 case 单独标注并归 G2/G3。
- Oracle 必须可证伪：每条给出**红灯条件**。
- 结果只写进本包 `run.md`，不回写预期。

## T-001 <标题>
- 前置：…
- 命令：`<可粘贴>`
- 期望：`<读数/退出码>`
- 负控：`<注入什么> ⇒ 必须红`
```

## plan.md

```markdown
# Plan · <id>

## 方案差量
- 核心机制 / 组件影响 / 数据与 API / 权限与安全 / 可观测性

## 纵向切片（默认执行轴）
| 切片 ID | 入口（模块） | 完成定义（链 T-xxx） | 触及路径 | 依赖 | G 档 |
|---|---|---|---|---|---|

## 单向门（跨包依赖只走 INTERFACES）
| 依赖接口 | 生产方 | 本包消费点 | 版本纪律 |
|---|---|---|---|
```

## run.md

```markdown
# Run · <id>

> 唯一运行态：只追加结构化行（表行/键值），**禁叙事**。

## 执行态
- 状态：`in-progress`
- Owner / Workspace：
- 最后更新：
- 允许结束条件：`awaiting-human-acceptance | acceptance-passed | blocked | needs-authorization`

## 批次结果
| 时间 | 切片 | G 档 | 命令/退出码 | 读数 | 状态跃迁 |
|---|---|---|---|---|---|

## 未证实项
- `Unverified: …（缺环境/授权/数据）`
```

---

## 总纲 INDEX.md

```markdown
# Spec Index · <id>（总纲）

> 本文件是**施工归口**，不是第二本账。

## 1. 怎么用（subagent 派工协议）
**第 0 步（硬前置）**：拿到包后先自己判断"本包要解决的问题是否真的还存在"。
- `已解决` ⇒ 直接关包（`cancelled`），不写实现；
- `描述过期` ⇒ 先修描述再施工；
- `无法判定` ⇒ 写 `missing=`，不得凭猜开工；
- `仍存在` ⇒ 正常施工，并在 `run.md` 记录**你自己**的复核证据与复现命令。

**粒度纪律**：G0/G1 只跑单元，不重启/不 apply；G2 攒批一次进窗口；G3 单窗口串行。

## 2. 模块地图
| 模块 | 包 | 账本条目 | 写域 | 依赖 |
|---|---|---|---|---|

## 3. 包登记表（写域随包登记）
| 包 | 状态 | 账本条目 | 写域（互斥） | 依赖 |
|---|---|---|---|---|
```

## 总纲 INTERFACES.md

```markdown
# Interfaces · <id>（接口冻结表）

> **跨包唯一合法耦合面**。没条目就是越界依赖。owner 单写；subagent 只能提交变更请求。
> 版本纪律：`free`（可自由改，须同步消费方）/ `dual-write`（双写 + 对账窗口后切）/ `frozen`（改即触发单向门审批）。

| ID | 接口名 | 生产者包 | 消费者包 | 载体 | 契约要点（可判定） | 版本纪律 |
|---|---|---|---|---|---|---|
```

## 总纲 INTEGRATION.md

```markdown
# Integration · <id>（联调层级与验收矩阵）

> 联调不是新账本：每条判据指向账本条目或包内 T-xxx。**下一层未过不进上一层**。
> 每条 case 必须有负控（注入缺陷必须变红）；只做正控不算通过。

## 0. 执行粒度 ⇄ 验证方式 ⇄ 是否动环境
| 粒度 | 典型改动 | 必须的验证 | 动不动环境 | 预算 |
|---|---|---|---|---|
| G0 | … | 单元先红后绿 + 1 负控 | 不动 | 秒级 |
| G1 | … | 包内用例 + 契约门 + 生成物 diff | 不动 | 分钟级 |
| G2 | … | 批内每项先有 G0/G1 证据；批级一次 apply + 回读 | 一次、攒批 | 一次窗口 |
| G3 | … | 联调矩阵 + 基线复算 | 单窗口串行 | 计划窗口 |

## 1. L0/L1 模块内
## 2. L2 模块间（M0…Mn 用例）
## 3. L3 系统级（E2E 矩阵 + 基线）
```

---

## 包质量自检（派工前逐条打勾）

- [ ] 五件齐；`VERSION` 状态与 `INDEX` 登记一致
- [ ] `contract.md` 有「复核前置」且引用阶段 0 判定（不是旧台账结论）
- [ ] `tests.md` ≥3 条，每条有命令 + 期望 + **负控**
- [ ] `plan.md` 切片有 G 档与触及路径；跨包依赖只在 `INTERFACES`
- [ ] `run.md` 只有结构化行；允许结束条件已声明
- [ ] 写域与其它包无交集；生成物有单属主
- [ ] 本包不要求执行者读别人的包、也不要求改账本