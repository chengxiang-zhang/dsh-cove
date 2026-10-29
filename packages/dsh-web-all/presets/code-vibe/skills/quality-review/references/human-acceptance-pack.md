# 人类验收包 / 证据卡

> 许愿式交付的**验收侧**真源。关版分叉见下方「何时出哪种包」。
> maker ≠ grader = **Codex ≠ 指挥侧**（falsify）。**人终验只留在机器看不到的地方。**

## 何时出哪种包

先读宿主 `AGENTS.md` 的 `Default UI surface` / `用户可见页面验收`，再读本 Spec 切片行的 `oracle:` 备注。

| 条件 | 产出 | 关版 |
|---|---|---|
| `surface=n/a`（或页面验收 n/a）且 P0 Oracle 均可机跑（`unit` / `machine` / `lab` 脚本）且指挥侧 falsify + `verify-deliver` 过 | **证据卡** | **机器关版** → `acceptance-passed`；默认不等待人 |
| `surface=product\|consumer`，或 Then 依赖视觉 / 文案 / 手感 / 真人 SSO | **人类验收包** | 人点验后才 `acceptance-passed` |
| 弱 Oracle、Unverified 进了 P0、单向门、要把 lab 说成生产承诺 | **人判断卡**（不是「请再跑 test.sh」） | 等人判断 |
| 人明示「验收 / 我自己看」 | 验收包或证据卡 | 等人 |

`awaiting-human-acceptance` **只留给后三行**。第一行不进这个状态。

## 证据卡（无 UI · 默认）

对人 · 产品语言，**不是操作手册**：

1. **P0 Oracle**：每条一行：命令 · exit · 关键观察
2. **指挥侧证伪**：PASS 日志路径（`COMMAND` + `EXIT_CODE: 0` + `VERDICT`）
3. **verify-deliver**：`ok · <时间>`
4. **声明**：实验室证据 ≠ 生产；上线另批 Deploy
5. **你若要推翻再说**；默认无需动作

**禁止：** 请人再执行一遍 Agent 刚 exit 0 的同一条 falsify / 单测命令。
**禁止：** 无 URL 时写「逐步操作、亲自点验」。

机器关版同回合：`run.md` → `acceptance-passed`；`make close-spec` 收口（状态+搬迁一条命令）；询问是否 Deploy（**不**自动上生产）。

## 人类验收包（有 UI / 人判断）

1. **怎么验**
   环境 / 入口 URL 或路径 / 角色或账号前提 / 代表性数据 / 逐步操作（人能照做）。

2. **验什么**
   用例清单（主路径、关键失败与权限、方案里承诺的体验点）。
   每条写清：操作 → 期望可观察结果。可在技术详情中映射 `T-xxx`，前台默认不暴露编号。

3. **AI 已做（旁证）**
   单测 / 证伪 / 走查摘要与证据路径。有 UI 时写清：**不能替代你亲自点验**。无 UI 人判断卡不要这句话。

4. **已知限制**
   未覆盖项、环境差、需真人 SSO 等。

无此包（且不属于证据卡机器关版）→ 不得请人关版。关版状态由 `journey.sh` 状态机定义。

## 话术硬门

| 禁止 | 正确 |
|------|------|
| 「可交付」但未交验收包/证据卡 | 先交包或卡 |
| 把「请打开/硬刷看是否正常」当验收包 | 包内须有具体用例与期望结果 |
| 无 UI 仍「请你自验 / 请再跑脚本」 | 证据卡 + 机器关版 |
| 有 UI 时 Agent 自嗨 Pass 即关版 | 人明示「通过 / 没问题 / 关版」后才 `acceptance-passed` |
| 验收通过后直接生产发布 | 关版后上线仍走 Deploy + P4 |

## 人反馈分流

| 人说 | Agent |
|------|--------|
| 某条不过 / 这里别扭 | 记入 Fail；非 material → Polish；material → 补方案或 Spec 再修；再给更新包 |
| 通过 / 没问题 / 关版 / 归档（有 UI / 人判断） | 写 `acceptance-passed`；`make close-spec`（禁反问）；询问是否 Deploy |
| 无 UI 机器关版后未反对 | 已是 `acceptance-passed`；只问是否 Deploy |
| 先上线 / 发布 | 仅在关版后（或人明文豁免并担责）进 Deploy |
